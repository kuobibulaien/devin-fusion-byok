'use strict';

const { createRequire } = require('node:module');
const { augmentCatalog, collectNativeModels } = require('../catalog.cjs');
const { m, fields } = require('../protocol/wire.cjs');
const INSTANCE = Symbol.for('devin-fusion-byok.host-catalog.v1');
const STATUS_RPC = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const REFRESH_COMMAND = 'devin.refreshUserStatus';

// Recent Devin builds publish the renderer catalog through host auth instead
// of the renderer's LS client. Only change the model data in UserStatus; all
// authentication fields, account permissions, and other status fields survive.
function transformStatus(status, catalog, onNativeModels, stripOwn = false) {
  const encoded = status?.userStatusProtoBinaryBase64;
  if (typeof encoded !== 'string' || !encoded || encoded.length > 6 * 1024 * 1024 ||
      encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) return status;
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded) return status;
  const envelope = m(1, raw), format = { json: false };
  const observed = collectNativeModels(envelope, { rpc: STATUS_RPC, format });
  if (observed.length) onNativeModels?.(observed);
  const result = augmentCatalog(envelope, { rpc: STATUS_RPC, format,
    catalog: typeof catalog === 'function' ? catalog() : catalog, ...(stripOwn ? { onNativeModels: () => {} } : {}) });
  const next = fields(result, 1)[0]?.value;
  return !next || next.equals(raw) ? status : { ...status, userStatusProtoBinaryBase64: next.toString('base64') };
}

function installHostCatalog({ nativeMainPath, vscode, stateDbPath, database, getCatalog, isEnabled = () => true, onNativeModels,
  setIntervalFn, clearIntervalFn,
  executeCommand, log = () => {} } = {}) {
  const api = nativeMainPath ? createRequire(nativeMainPath)('vscode').windsurfAuth : vscode?.windsurfAuth;
  // Older hosts continue using the LS bridge.
  if (typeof api?.setAuthStatus !== 'function') return null;
  if (api[INSTANCE]) return api[INSTANCE];
  if (!nativeMainPath) {
    setIntervalFn ||= setInterval; clearIntervalFn ||= clearInterval;
    let disposed = false, pending;
    const handle = {
      refresh() {
        if (disposed) return Promise.resolve();
        if (!pending) pending = Promise.resolve().then(async () => {
          if (disposed) return;
          let db;
          try {
            const DatabaseSync = database || require('node:sqlite').DatabaseSync;
            db = new DatabaseSync(stateDbPath, { readOnly: true });
            const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").get();
            const status = JSON.parse(row?.value || '{}');
            if (typeof status.apiKey !== 'string' || !status.apiKey || status.apiKey.length > 8192 || disposed) return;
            const enabled = isEnabled();
            const catalog = enabled ? getCatalog : { models: [], hiddenNativeModelUids: [], hiddenFusionUids: [], homeModelUids: [] };
            const transformed = transformStatus(status, catalog, enabled ? onNativeModels : undefined, !enabled);
            if (!disposed && transformed !== status) await api.setAuthStatus(transformed);
          } catch { try { log('host catalog refresh unavailable'); } catch {} }
          finally { db?.close(); }
        }).finally(() => { pending = undefined; });
        return pending;
      },
      dispose() { disposed = true; clearIntervalFn(timer); },
    };
    const timer = setIntervalFn(() => { void handle.refresh(); }, 3000);
    timer.unref?.();
    return handle;
  }
  const descriptor = Object.getOwnPropertyDescriptor(api, 'setAuthStatus');
  const original = api.setAuthStatus;
  let disposed = false, pending;
  const report = event => { try { log(event); } catch {} };
  function setAuthStatus(...args) {
    let status = args[0];
    if (!disposed && status) {
      try {
        const next = isEnabled() ? transformStatus(status, getCatalog, onNativeModels) : status;
        if (next !== status) report('host catalog updated');
        status = next;
      } catch { report('host catalog transform failed'); }
    }
    return Reflect.apply(original, this, [status, ...args.slice(1)]);
  }
  const handle = {
    refresh() {
      if (disposed || typeof executeCommand !== 'function') return Promise.resolve();
      if (!pending) pending = Promise.resolve().then(() => {
        if (!disposed) return executeCommand(REFRESH_COMMAND);
      }).catch(() => { report('host catalog refresh unavailable'); }).finally(() => { pending = undefined; });
      return pending;
    },
    dispose() {
      disposed = true;
      if (api.setAuthStatus === setAuthStatus) {
        if (descriptor) Object.defineProperty(api, 'setAuthStatus', descriptor);
        else delete api.setAuthStatus;
      }
      if (api[INSTANCE] === handle) delete api[INSTANCE];
    },
  };
  try {
    api.setAuthStatus = setAuthStatus;
    Object.defineProperty(api, INSTANCE, { value: handle, configurable: true });
  } catch (error) { handle.dispose(); throw error; }
  report('host catalog attached');
  return handle;
}

module.exports = { installHostCatalog, transformStatus, REFRESH_COMMAND };
