'use strict';

const { createRequire } = require('node:module');
const INSTANCE = Symbol.for('devin-fusion-byok.acp-injection.v1');

function localServer(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw new TypeError('ACP injection requires a loopback HTTP server URL');
  }
  return url.origin;
}

function officialServer(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://server.codeium.com' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function restore(target, key, wrapper, descriptor) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}

/**
 * Keep the bundled local connector and handshake intact, changing only the
 * official API-server address in its authenticate metadata. Existing connectors
 * are not publicly enumerable; install before registration or reload ACP once.
 */
async function installAcpInjection({ nativeMainPath, apiServerUrl, log = () => {} } = {}) {
  const destination = localServer(apiServerUrl);
  const nativeRequire = createRequire(nativeMainPath);
  const api = nativeRequire('vscode').windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') throw new Error('Native ACP registration API is unavailable');
  if (api[INSTANCE]) {
    if (api[INSTANCE].status.apiServerUrl !== destination) throw new Error('ACP injection already has a different destination');
    return api[INSTANCE];
  }
  const originalRegister = api.registerConnection;
  const registerDescriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
  const connections = new Map();
  let disposed = false;
  let rewritten = 0;
  function report(event) { try { log(event); } catch { /* Diagnostics are optional. */ } }
  function detach(connector) {
    const entry = connections.get(connector);
    if (!entry) return;
    entry.active = false;
    restore(connector, 'sendHandshakeRequest', entry.handshake, entry.handshakeDescriptor);
    if (entry.registration) restore(entry.registration, 'dispose', entry.dispose, entry.disposeDescriptor);
    connections.delete(connector);
  }
  function attach(connector) {
    if (disposed || !connector || connector.agentId !== 'devin-cli' || connector.bundled !== true ||
        connector.location?.kind !== 'local' || typeof connector.sendHandshakeRequest !== 'function') return null;
    if (connections.has(connector)) return connections.get(connector);
    const originalHandshake = connector.sendHandshakeRequest;
    const entry = { active: true, handshakeDescriptor: Object.getOwnPropertyDescriptor(connector, 'sendHandshakeRequest') };
    entry.handshake = function (...args) {
      const request = args[0];
      if (!disposed && entry.active && request?.method === 'authenticate' && request.params?.methodId === 'windsurf-api-key' &&
          officialServer(request.params?._meta?.api_server_url)) {
        // Preserve credential fields and any future metadata by shallow copy;
        // their values are never interpreted, stringified, or logged here.
        const changed = { ...request, params: { ...request.params,
          _meta: { ...request.params._meta, api_server_url: destination } } };
        rewritten++;
        report('acp authentication server redirected');
        return Reflect.apply(originalHandshake, this, [changed, ...args.slice(1)]);
      }
      return Reflect.apply(originalHandshake, this, args);
    };
    connector.sendHandshakeRequest = entry.handshake;
    connections.set(connector, entry);
    report('acp local connector attached');
    return entry;
  }
  function registerConnection(...args) {
    const connector = args[0];
    let entry;
    try { entry = attach(connector); }
    catch { report('acp injection unavailable for connector'); }
    let registration;
    try { registration = Reflect.apply(originalRegister, this, args); }
    catch (error) { if (entry) detach(connector); throw error; }
    if (entry && registration && typeof registration.dispose === 'function' && !entry.registration) {
      const originalDispose = registration.dispose;
      entry.registration = registration;
      entry.disposeDescriptor = Object.getOwnPropertyDescriptor(registration, 'dispose');
      entry.dispose = function (...args) {
        detach(connector);
        return Reflect.apply(originalDispose, this, args);
      };
      try { registration.dispose = entry.dispose; }
      catch { entry.registration = null; }
    }
    return registration;
  }
  const handle = {
    get status() { return Object.freeze({ state: disposed ? 'disposed' : connections.size ? 'attached' : 'waiting',
      connections: connections.size, rewritten, apiServerUrl: destination }); },
    dispose() {
      if (disposed) return;
      disposed = true;
      restore(api, 'registerConnection', registerConnection, registerDescriptor);
      for (const connector of connections.keys()) detach(connector);
      if (api[INSTANCE] === handle) delete api[INSTANCE];
    },
  };
  try {
    api.registerConnection = registerConnection;
    Object.defineProperty(api, INSTANCE, { value: handle, configurable: true });
  } catch (error) {
    restore(api, 'registerConnection', registerConnection, registerDescriptor);
    throw error;
  }
  report('acp injection waiting for registration');
  return handle;
}

module.exports = { installAcpInjection };
