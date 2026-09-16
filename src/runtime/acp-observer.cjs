'use strict';

const { createRequire } = require('node:module');

const INSTANCE = Symbol.for('devin-fusion-byok.acp-observer.v1');
const METHODS = new Set(['session/new', 'session/load', 'session/resume']);

function modelCounts(response, rpc) {
  const options = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const values = [];
  let modelSelectors = 0;
  for (const option of options) {
    if (option?.category !== 'model' || option.type !== 'select') continue;
    modelSelectors++;
    for (const entry of Array.isArray(option.options) ? option.options : []) {
      const entries = Array.isArray(entry?.options) ? entry.options : [entry];
      for (const value of entries) if (typeof value?.value === 'string') values.push(value.value);
    }
  }
  const unique = [...new Set(values)];
  const plainModels = unique.filter(value => value.startsWith('dfbyok-')).length;
  const fusionModels = unique.filter(value => value.startsWith('fusion-dfbyok-')).length;
  return Object.freeze({ rpc, configOptions: options.length, modelSelectors, models: values.length,
    uniqueModels: unique.length, ownModels: plainModels + fusionModels, plainModels, fusionModels });
}

function restore(target, key, wrapper, descriptor) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}

/**
 * Observe future native ACP registrations without issuing agent requests.
 * Logs only method names and model counts; never requests, response bodies,
 * session IDs, labels, model UID values, metadata, or credentials.
 */
function installAcpObserver({ nativeMainPath, log = () => {} } = {}) {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath || typeof log !== 'function') {
    throw new TypeError('nativeMainPath and a log function are required');
  }
  const api = createRequire(nativeMainPath)('vscode').windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') throw new Error('Native ACP registration API is unavailable');
  if (api[INSTANCE]) return api[INSTANCE];

  const registrationDescriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
  const originalRegister = api.registerConnection;
  const records = new Map();
  let disposed = false, responses = 0, last = null;

  function observe(response, rpc) {
    if (disposed) return;
    try {
      const counts = modelCounts(response, rpc);
      responses++;
      last = counts;
      try { log('acp-models', counts); } catch (_) { /* Diagnostics cannot affect native requests. */ }
    } catch (_) { /* Malformed diagnostics are ignored; native responses remain untouched. */ }
  }

  function wrapConnection(connection) {
    if (!connection || records.has(connection) || typeof connection.sendRequest !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(connection, 'sendRequest');
    const original = connection.sendRequest;
    function sendRequest(...args) {
      const result = Reflect.apply(original, this, args);
      try {
        // Read only the method discriminator. In particular never inspect the
        // authentication payload or any other request params.
        const rpc = args[0]?.method;
        if (!disposed && METHODS.has(rpc)) {
          if (result && typeof result.then === 'function') {
            result.then(value => { observe(value, rpc); }, () => {});
          } else observe(result, rpc);
        }
      } catch (_) { /* Preserve original return values, throws and rejections. */ }
      return result;
    }
    try {
      connection.sendRequest = sendRequest;
      if (connection.sendRequest === sendRequest) records.set(connection, { descriptor, sendRequest });
    } catch (_) { /* A frozen native connector can still register normally. */ }
  }

  function registerConnection(...args) {
    const result = Reflect.apply(originalRegister, this, args);
    if (!disposed) {
      try { wrapConnection(args[0]); } catch (_) { /* Registration is never blocked by observation. */ }
    }
    return result;
  }

  const handle = {
    get status() {
      return Object.freeze({ state: disposed ? 'disposed' : 'observing', connections: records.size, responses, last });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      restore(api, 'registerConnection', registerConnection, registrationDescriptor);
      for (const [connection, record] of records) {
        try { restore(connection, 'sendRequest', record.sendRequest, record.descriptor); } catch (_) {}
      }
      records.clear();
      if (api[INSTANCE] === handle) delete api[INSTANCE];
    },
  };
  api.registerConnection = registerConnection;
  try { Object.defineProperty(api, INSTANCE, { value: handle, configurable: true }); }
  catch (error) { restore(api, 'registerConnection', registerConnection, registrationDescriptor); throw error; }
  return handle;
}

module.exports = { installAcpObserver };
