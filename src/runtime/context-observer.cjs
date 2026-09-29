'use strict';
const { createRequire } = require('node:module');
const { createContextState, usageRejectionReason } = require('./context-state.cjs');
const KEY = Symbol.for('devin-fusion-byok.context-observer.v1');
function installContextObserver({ nativeMainPath, isEnabled = () => true }) {
  const api = createRequire(nativeMainPath)('vscode').windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') throw new Error('ACP unavailable');
  if (api[KEY]) return api[KEY];
  const original = api.registerConnection, descriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
  const connections = new Map();
  let disposed = false, registrations = 0, sessionUpdates = 0, usageUpdates = 0, acceptedUsageUpdates = 0, rejectedUsageUpdates = 0;
  const usageRejections = { 'invalid-session-id': 0, 'invalid-used': 0, 'invalid-size': 0, 'invalid-parent-id': 0, 'invalid-run-id': 0 };
  const status = () => ({ state: disposed ? 'disposed' : isEnabled() ? 'observing' : 'disabled', connections: connections.size, registrations, sessionUpdates, usageUpdates, acceptedUsageUpdates, rejectedUsageUpdates, usageRejections: { ...usageRejections } });
  function restore(object, key, wrapper, previous) {
    if (object[key] !== wrapper) return;
    if (previous) Object.defineProperty(object, key, previous); else delete object[key];
  }
  function enabled() { return !disposed && isEnabled(); }
  function attach(connector) {
    if (connections.size >= 32 || connections.has(connector) || connector?.agentId !== 'devin-cli' || connector.bundled !== true || connector.location?.kind !== 'local' ||
        typeof connector.sendRequest !== 'function' || typeof connector.forwardClientRequest !== 'function') return;
    const state = createContextState(), saved = [];
    const entry = { state, active: true, saved };
    function wrap(key, factory) {
      const previous = Object.getOwnPropertyDescriptor(connector, key), fn = connector[key];
      const wrapper = factory(fn);
      saved.push({ key, previous, wrapper });
      connector[key] = wrapper;
      if (connector[key] !== wrapper) throw new Error('ACP wrapper unavailable');
    }
    function safe(fn) { try { if (entry.active && enabled()) fn(); else state.clear(); } catch {} }
    function detach() {
      entry.active = false; state.clear();
      for (const value of saved.reverse()) restore(connector, value.key, value.wrapper, value.previous);
      connections.delete(connector);
    }
    try {
      wrap('sendRequest', fn => function (...args) {
        let method, sessionId, generation;
        safe(() => {
          method = args[0]?.method;
          if (!['session/prompt', 'session/new', 'session/load', 'session/resume', 'session/cancel', 'session/close', 'session/delete', 'session/archive', 'session/set_config_option'].includes(method)) return;
          sessionId = args[0]?.params?.sessionId;
          if (method === 'session/prompt') generation = state.start(sessionId);
          if (['session/load', 'session/resume', 'session/close', 'session/delete', 'session/archive'].includes(method)) state.reset(sessionId);
        });
        let result;
        try { result = Reflect.apply(fn, this, args); }
        catch (error) { safe(() => { if (method === 'session/prompt') state.finish(sessionId, generation, 'error'); }); throw error; }
        const success = value => safe(() => {
          if (method === 'session/prompt' && !(connector.protocolVersion >= 2)) state.finish(sessionId, generation);
          if (method === 'session/cancel') state.finish(sessionId, undefined, 'cancelled');
          if (['session/new', 'session/load', 'session/resume', 'session/set_config_option'].includes(method)) state.selectModel(value?.sessionId || sessionId, value?.configOptions);
        });
        const failure = () => safe(() => { if (method === 'session/prompt') state.finish(sessionId, generation, 'error'); });
        if (result && typeof result.then === 'function') result.then(success, failure); else success(result);
        return result;
      });
      wrap('forwardClientRequest', fn => function (...args) {
        const result = Reflect.apply(fn, this, args);
        safe(() => {
          if (args[0]?.method !== 'session/update') return;
          const { sessionId, update } = args[0].params || {};
          sessionUpdates++;
          if (update?.sessionUpdate === 'usage_update') usageUpdates++;
          const accepted = state.observe(sessionId, update);
          if (update?.sessionUpdate === 'usage_update') {
            if (accepted) acceptedUsageUpdates++;
            else {
              rejectedUsageUpdates++;
              const reason = usageRejectionReason(sessionId, update);
              if (Object.hasOwn(usageRejections, reason)) usageRejections[reason]++;
            }
          }
          if (update?.sessionUpdate === 'config_option_update') state.selectModel(sessionId, update.configOptions);
        });
        return result;
      });
      if (typeof connector.setStatus === 'function') wrap('setStatus', fn => function (status, ...rest) {
        const result = Reflect.apply(fn, this, [status, ...rest]);
        if (['disconnected', 'disabled', 'disposed'].includes(status)) detach();
        return result;
      });
      connections.set(connector, { ...entry, detach });
    } catch { detach(); }
  }
  function register(...args) {
    const result = Reflect.apply(original, this, args);
    if (!disposed) { registrations++; try { attach(args[0]); } catch {} }
    return result;
  }
  const handle = {
    status,
    snapshot() {
      if (!enabled()) { for (const entry of connections.values()) entry.state.clear(); return []; }
      const all = [...connections.values()].flatMap(entry => entry.state.snapshot());
      const counts = new Map();
      for (const session of all) counts.set(session.sessionId, (counts.get(session.sessionId) || 0) + 1);
      return all.filter(session => counts.get(session.sessionId) === 1).sort((a, b) => (b.lead?.timestampMs || 0) - (a.lead?.timestampMs || 0));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      restore(api, 'registerConnection', register, descriptor);
      for (const entry of [...connections.values()]) entry.detach();
      if (api[KEY] === handle) delete api[KEY];
    },
  };
  api.registerConnection = register;
  Object.defineProperty(api, KEY, { value: handle, configurable: true });
  return handle;
}
module.exports = { installContextObserver };
