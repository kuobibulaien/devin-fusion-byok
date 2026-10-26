'use strict';
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { heartbeatPort } = require('./ls-injection.cjs');
const PREFIX = '/exa.extension_server_pb.ExtensionServerService/';
const KEYS = { pinned: 'pinnedCascadeModelUids', recent: 'lastSelectedCascadeModelUids' };
const failure = code => Object.assign(new Error(code), { code });
function listValue(uids) { return { listValue: { values: uids.map(stringValue => ({ stringValue })) } }; }
function readList(value) {
  if (!value || !Object.keys(value).length) return [];
  const items = value.listValue && typeof value.listValue === 'object' ? value.listValue.values || [] : undefined;
  if (!Array.isArray(items) || items.some(item => typeof item?.stringValue !== 'string')) throw failure('picker_invalid_response');
  return items.map(item => item.stringValue);
}
function validUids(uids) {
  return Array.isArray(uids) && uids.length <= 500 && uids.every(uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 256 && !/[\u0000-\u001f]/.test(uid)) && new Set(uids).size === uids.length;
}
function createNativePickerStore({ request, onChange = () => {} }) {
  let state = { status: 'waiting', pinned: [], recent: [], revision: '', needsReload: false };
  let entries = {}, pending, disposed = false, readGeneration = 0;
  function publish(next) {
    if (disposed || JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    try { onChange(); } catch { /* UI notifications cannot affect native state. */ }
  }
  const snapshot = () => ({ ...state, pinned: [...state.pinned], recent: [...state.recent] });
  async function refresh() {
    if (disposed) return snapshot();
    if (pending) return pending;
    const generation = ++readGeneration;
    pending = (async () => {
      try {
        const response = await request('GetNativeValues', { target: { state: {} }, keys: Object.values(KEYS) });
        if (disposed || generation !== readGeneration) return snapshot();
        if (!response?.values || typeof response.values !== 'object') throw failure('picker_invalid_response');
        const pinned = readList(response.values[KEYS.pinned]?.value), recent = readList(response.values[KEYS.recent]?.value);
        entries = response.values;
        const revision = createHash('sha256').update(JSON.stringify([pinned, recent])).digest('hex');
        publish({ status: 'ready', pinned, recent, revision, needsReload: state.needsReload });
      } catch (error) {
        if (disposed || generation !== readGeneration) return snapshot();
        publish({ ...state, status: error?.code === 'picker_waiting' ? 'waiting' : 'unavailable' });
      }
      return snapshot();
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return {
    snapshot, refresh,
    async setList(kind, uids, revision) {
      if (!Object.hasOwn(KEYS, kind) || !validUids(uids) || kind === 'recent' && uids.length > 3) throw failure('picker_invalid_list');
      await refresh();
      if (state.status !== 'ready') throw failure('picker_unavailable');
      if (revision !== state.revision) throw failure('picker_conflict');
      const key = KEYS[kind], expectedPreviousValue = entries[key]?.value || {};
      const result = await request('SetNativeValue', { target: { state: {} }, key, value: listValue(uids), expectedPreviousValue });
      if (result?.concurrencyConflict === true) {
        readGeneration++;
        if (pending) await pending;
        await refresh(); throw failure('picker_conflict');
      }
      if (!result?.currentValue?.value) throw failure('picker_invalid_response');
      // A poll already in flight may contain the pre-write value. Invalidate it
      // and drain it before verifying with a request issued after the write.
      readGeneration++;
      publish({ ...state, needsReload: true });
      if (pending) await pending;
      await refresh();
      if (state.status !== 'ready' || JSON.stringify(state[kind]) !== JSON.stringify(uids)) throw failure('picker_write_unverified');
      return snapshot();
    },
    markReloadNeeded() { publish({ ...state, needsReload: true }); },
    dispose() { disposed = true; },
  };
}

function extensionPort(handles, nativeMainPath) {
  const bin = path.resolve(path.dirname(nativeMainPath), '../bin') + path.sep;
  const ports = new Set();
  for (const child of handles) {
    if (typeof child?.spawnfile !== 'string' || !path.resolve(child.spawnfile).startsWith(bin) ||
        !/^language_server_/.test(path.basename(child.spawnfile)) || !Array.isArray(child.spawnargs)) continue;
    const index = child.spawnargs.indexOf('--extension_server_port');
    const value = child.spawnargs[index + 1];
    if (index < 0 || !/^\d+$/.test(value || '')) continue;
    const port = Number(value);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return ports.size === 1 ? [...ports][0] : null;
}

function installNativePicker({ nativeMainPath, onChange, isEnabled = () => true, intervalMs = 1500 }) {
  const nativeRequire = createRequire(nativeMainPath);
  const nativeHttp = nativeRequire('http'), api = nativeRequire('vscode').windsurfLanguageServer;
  let csrfToken, disposed = false;
  const connections = new Set();
  const requestDescriptor = Object.getOwnPropertyDescriptor(nativeHttp, 'request'), originalRequest = nativeHttp.request;
  const csrfDescriptor = api && Object.getOwnPropertyDescriptor(api, 'setCsrfToken'), originalCsrf = api?.setCsrfToken;
  const acceptToken = value => { if (typeof value === 'string' && /^[a-f\d-]{36}$/i.test(value)) csrfToken = value; };
  function request(...args) {
    const result = Reflect.apply(originalRequest, this, args);
    // Only the official local heartbeat's CSRF token is observed, in memory.
    // Provider headers, request bodies and process environments are never read.
    try { if (!disposed && heartbeatPort(args)) acceptToken(result.getHeader('x-codeium-csrf-token')); } catch {}
    return result;
  }
  function setCsrfToken(...args) {
    const result = Reflect.apply(originalCsrf, this, args);
    if (!disposed) acceptToken(args[0]);
    return result;
  }
  const store = createNativePickerStore({ onChange, request: (method, payload) => new Promise((resolve, reject) => {
    const port = extensionPort(process._getActiveHandles(), nativeMainPath);
    if (disposed || !isEnabled() || !port || !csrfToken) { reject(failure('picker_waiting')); return; }
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request({ hostname: '127.0.0.1', port, path: PREFIX + method, method: 'POST',
      agent: new http.Agent({ proxyEnv: {}, keepAlive: false }),
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'connect-protocol-version': '1', 'x-codeium-csrf-token': csrfToken } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) req.destroy(failure('picker_invalid_response')); else chunks.push(chunk); });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(failure('picker_unavailable')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(failure('picker_invalid_response')); }
      });
      response.on('error', () => reject(failure('picker_unavailable')));
    });
    connections.add(req);
    req.on('close', () => connections.delete(req));
    req.on('error', () => reject(failure('picker_unavailable')));
    req.setTimeout(2000, () => req.destroy(failure('picker_unavailable')));
    req.end(body);
  }) });
  try { nativeHttp.request = request; if (typeof originalCsrf === 'function') api.setCsrfToken = setCsrfToken; }
  catch (error) { store.dispose(); if (nativeHttp.request === request) Object.defineProperty(nativeHttp, 'request', requestDescriptor); throw error; }
  const timer = setInterval(() => { void store.refresh(); }, intervalMs); timer.unref?.();
  void store.refresh();
  const restore = (target, key, wrapper, descriptor) => {
    if (target?.[key] !== wrapper) return;
    if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
  };
  return { ...store, dispose() {
    disposed = true; csrfToken = undefined; clearInterval(timer); store.dispose();
    restore(nativeHttp, 'request', request, requestDescriptor); restore(api, 'setCsrfToken', setCsrfToken, csrfDescriptor);
    for (const req of connections) req.destroy(); connections.clear();
  } };
}
module.exports = { createNativePickerStore, installNativePicker, extensionPort, readList, listValue };
