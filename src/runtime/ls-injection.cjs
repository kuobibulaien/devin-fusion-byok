'use strict';

const { createRequire } = require('node:module');
const { urlToHttpOptions } = require('node:url');

const INSTANCE = Symbol.for('devin-fusion-byok.ls-injection.v1');
const HEARTBEAT = '/exa.language_server_pb.LanguageServerService/Heartbeat';

function portNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// The official extension sends this one RPC every second, even when installed
// after its language server started. Do not inspect its headers or payload.
function heartbeatPort(args) {
  const first = args[0];
  let options;
  if (typeof first === 'string' || first instanceof URL) {
    const url = typeof first === 'string' ? new URL(first) : first;
    options = { ...urlToHttpOptions(url) };
    if (args[1] && typeof args[1] === 'object') {
      const override = args[1];
      // Deliberately copy only addressing fields, never headers or body.
      for (const key of ['protocol', 'hostname', 'host', 'port', 'path', 'method', 'socketPath']) {
        if (key in override) options[key] = override[key];
      }
    }
  } else if (first && typeof first === 'object') {
    options = first;
  } else {
    return null;
  }
  if (options.socketPath || (options.protocol ?? 'http:') !== 'http:' ||
      String(options.method ?? 'GET').toUpperCase() !== 'POST' || options.path !== HEARTBEAT) return null;
  const host = String(options.hostname ?? options.host ?? 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return null;
  return portNumber(options.port);
}

/**
 * Route the current window's renderer LS client through an owned HTTP bridge.
 * createBridge(originalPort) must return { port, close() }. The bridge remains
 * responsible for forwarding native validation headers and all unrelated RPCs.
 * No app files, auth state, settings, or process environment are changed here.
 */
async function installLsInjection({ nativeMainPath, createBridge, log = () => {} } = {}) {
  if (typeof nativeMainPath !== 'string' || typeof createBridge !== 'function') {
    throw new TypeError('nativeMainPath and createBridge are required');
  }
  // VS Code creates a separate `http` copy and API object for each extension.
  // Requiring from the native entry's path reuses its live objects without
  // executing or rewriting the native extension bundle.
  const nativeRequire = createRequire(nativeMainPath);
  const http = nativeRequire('http');
  const api = nativeRequire('vscode').windsurfLanguageServer;
  if (!api || typeof api.setPort !== 'function' || typeof http.request !== 'function') {
    throw new Error('Native language-server injection API is unavailable');
  }
  if (api[INSTANCE]) return api[INSTANCE];

  const requestDescriptor = Object.getOwnPropertyDescriptor(http, 'request');
  const setPortDescriptor = Object.getOwnPropertyDescriptor(api, 'setPort');
  const originalRequest = http.request;
  const originalSetPort = api.setPort;
  let disposed = false;
  let disposePromise;
  let generation = 0;
  let originalPort = null;
  let active = null;
  let pending = null;
  let pendingCount = 0;
  let state = 'waiting';
  let setterThis = api;
  let setterExtraArgs = [];
  const proxyPorts = new Set();
  const closed = new WeakSet();

  function report(message) {
    try { log(message); } catch (_) { /* Diagnostics cannot break native RPCs. */ }
  }

  async function close(bridge) {
    if (!bridge || typeof bridge !== 'object' || closed.has(bridge)) return;
    closed.add(bridge);
    try {
      if (typeof bridge.close === 'function') await bridge.close();
    } catch (_) {
      report('ls bridge close failed');
    } finally {
      proxyPorts.delete(portNumber(bridge.port));
    }
  }

  function observe(port) {
    if (disposed || !port || proxyPorts.has(port)) return;
    originalPort = port;
    if (active?.originalPort === port) {
      if (pending && pending.port !== port) {
        generation++;
        pending = null;
      }
      state = 'ready';
      return;
    }
    if (pending?.port === port) return;
    const attempt = { generation: ++generation, port };
    pending = attempt;
    pendingCount++;
    state = 'connecting';
    Promise.resolve().then(() => {
      if (disposed || attempt.generation !== generation) return null;
      return createBridge(port);
    }).then(async bridge => {
      if (!bridge) {
        if (!disposed && attempt.generation === generation) throw new Error('Missing LS bridge');
        return;
      }
      const bridgePort = portNumber(bridge.port);
      if (!bridgePort || bridgePort === port || typeof bridge.close !== 'function') {
        await close(bridge);
        throw new Error('Invalid LS bridge');
      }
      if (disposed || attempt.generation !== generation) {
        await close(bridge);
        return;
      }
      proxyPorts.add(bridgePort);
      const previous = active;
      active = { originalPort: port, bridge, port: bridgePort };
      try {
        Reflect.apply(originalSetPort, setterThis, [bridgePort, ...setterExtraArgs]);
      } catch (error) {
        active = previous;
        await close(bridge);
        throw error;
      }
      state = 'ready';
      report(`ls bridge ready ${port} -> ${bridgePort}`);
      await close(previous?.bridge);
    }).catch(() => {
      if (!disposed && attempt.generation === generation) {
        state = 'error';
        report(`ls bridge unavailable for ${port}`);
      }
    }).finally(() => {
      pendingCount--;
      if (pending === attempt) pending = null;
    });
  }

  function request(...args) {
    const result = Reflect.apply(originalRequest, this, args);
    try { observe(heartbeatPort(args)); } catch (_) { /* Leave malformed native calls unchanged. */ }
    return result;
  }

  function setPort(...args) {
    const port = portNumber(args[0]);
    const nativePort = port && !proxyPorts.has(port);
    const forwarded = !disposed && nativePort && active?.originalPort === port
      ? [active.port, ...args.slice(1)] : args;
    const result = Reflect.apply(originalSetPort, this, forwarded);
    if (!disposed && nativePort) {
      setterThis = this;
      setterExtraArgs = args.slice(1);
      observe(port);
    }
    return result;
  }

  function restore(target, name, wrapper, descriptor, value) {
    if (target[name] !== wrapper) return false;
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else {
      delete target[name];
      if (target[name] !== value) target[name] = value;
    }
    return true;
  }

  const handle = {
    get status() {
      return Object.freeze({ state, originalPort, proxyPort: active?.port ?? null, pending: pendingCount });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      state = 'disposed';
      generation++;
      pending = null;
      restore(http, 'request', request, requestDescriptor, originalRequest);
      restore(api, 'setPort', setPort, setPortDescriptor, originalSetPort);
      if (api[INSTANCE] === handle) delete api[INSTANCE];
      const previous = active;
      active = null;
      if (previous && originalPort) {
        // If another extension has wrapped ours, retain that wrapper and ask it
        // to restore the native port. Our disposed wrapper simply passes through.
        try { Reflect.apply(api.setPort, setterThis, [originalPort, ...setterExtraArgs]); }
        catch (_) { report('ls original port restore failed'); }
      }
      // Pending creations are invalidated immediately. Their completion closes
      // the returned bridge without publishing it, even after disposal returns.
      disposePromise = close(previous?.bridge);
      return disposePromise;
    },
  };

  try {
    http.request = request;
    api.setPort = setPort;
    Object.defineProperty(api, INSTANCE, { value: handle, configurable: true });
  } catch (error) {
    restore(http, 'request', request, requestDescriptor, originalRequest);
    restore(api, 'setPort', setPort, setPortDescriptor, originalSetPort);
    throw error;
  }
  report('ls injection waiting for native port');
  return handle;
}

module.exports = { installLsInjection };
