'use strict';
const { createRequire } = require('node:module');
const crypto = require('node:crypto');

const INSTANCE = Symbol.for('devin-fusion-byok.goal-continue.v1');
const ATTACHED = Symbol.for('devin-fusion-byok.goal-continue.attached');
const SESSION_LIMIT = 64;
const CONNECTOR_LIMIT = 8;
const RESET_METHODS = new Set([
  'session/cancel', 'session/load', 'session/resume', 'session/close', 'session/delete',
  'session/archive', '_cognition.ai/session/archive'
]);
const SESSION_METHODS = new Set(['session/new', 'session/load', 'session/resume']);
const INTERRUPT_METHODS = new Set([
  'session/request_permission', 'elicitation/create', '_session/elicitation', 'session/permission_request'
]);

const GOAL_COMMAND = Object.freeze({
  name: 'goal',
  description: 'Fusion BYOK：设定目标并自动持续推进，直到完成（/goal 查看，/goal pause|resume|clear 控制）',
  input: { hint: '要达成的目标，写清楚怎样算完成' }
});
const GOAL_COMMAND_RE = /^\/goal(?:\s+([\s\S]*))?$/;

function parseGoalCommand(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) return null;
  if (!prompt.every(block => block && block.type === 'text' && typeof block.text === 'string')) return null;
  const match = GOAL_COMMAND_RE.exec(prompt.map(block => block.text).join('').trim());
  if (!match) return null;
  const rest = (match[1] || '').trim();
  const word = rest.toLowerCase();
  if (!rest) return { action: 'status', text: '' };
  if (['pause', 'resume', 'clear', 'status'].includes(word)) return { action: word, text: '' };
  return { action: 'start', text: rest };
}
function withGoalCommand(message) {
  const update = message?.params?.update;
  if (message?.method !== 'session/update' || update?.sessionUpdate !== 'available_commands_update' ||
      !Array.isArray(update.availableCommands) || update.availableCommands.some(command => command?.name === GOAL_COMMAND.name)) {
    return message;
  }
  return {
    ...message,
    params: { ...message.params, update: { ...update, availableCommands: [...update.availableCommands, { ...GOAL_COMMAND, input: { ...GOAL_COMMAND.input } }] } }
  };
}

function restore(target, key, wrapper, descriptor) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}
function sessionIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : null;
}
function isEligibleConnector(connector) {
  return !!connector && connector.agentId === 'devin-cli' && connector.bundled === true &&
    connector.location?.kind === 'local' && typeof connector.sendRequest === 'function' &&
    typeof connector.forwardClientRequest === 'function';
}

function createSessionRegistry({ limit = SESSION_LIMIT } = {}) {
  const entries = new Map();
  function ensure(sessionId, allowCreate = true) {
    const clean = sessionIdentifier(sessionId);
    if (!clean) return null;
    let entry = entries.get(clean);
    if (!entry) {
      if (!allowCreate || entries.size >= limit) return null;
      entry = { sessionId: clean, status: 'unknown', connectors: new Set() };
      entries.set(clean, entry);
    }
    return entry;
  }
  return {
    adopt(sessionId, connector) {
      const clean = sessionIdentifier(sessionId);
      const entry = entries.get(clean) || ensure(clean, true);
      if (!entry || !connector) return null;
      if (entry.connectors.size >= CONNECTOR_LIMIT && !entry.connectors.has(connector)) return entry;
      entry.connectors.add(connector);
      return entry;
    },
    release(sessionId, connector) {
      const clean = sessionIdentifier(sessionId);
      const entry = clean ? entries.get(clean) : null;
      if (!entry) return null;
      entry.connectors.delete(connector);
      return entry;
    },
    remove(sessionId) {
      const clean = sessionIdentifier(sessionId);
      return clean ? entries.delete(clean) : false;
    },
    observe(sessionId, status) {
      const entry = ensure(sessionId);
      if (!entry) return null;
      if (status === 'idle' || status === 'busy' || status === 'unknown') entry.status = status;
      return entry;
    },
    updateTitle(sessionId, title) {
      const entry = ensure(sessionId, false);
      if (!entry || entry.connectors.size !== 1 || typeof title !== 'string') return;
      entry.title = title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512);
    },
    uniqueConnector(sessionId) {
      const clean = sessionIdentifier(sessionId);
      const entry = clean ? entries.get(clean) : null;
      if (!entry || entry.connectors.size !== 1) return null;
      return entry.connectors.values().next().value;
    },
    ambiguous(sessionId) {
      const clean = sessionIdentifier(sessionId);
      const entry = clean ? entries.get(clean) : null;
      return !!entry && entry.connectors.size > 1;
    },
    sessions() {
      return [...entries.values()].map(entry => ({
        sessionId: entry.sessionId,
        status: entry.connectors.size > 1 ? 'unknown' : entry.status,
        ambiguous: entry.connectors.size > 1,
        ...(entry.connectors.size === 1 && entry.title ? { title: entry.title } : {})
      }));
    },
    clear() { entries.clear(); },
    get size() { return entries.size; }
  };
}

function installGoalContinue({ nativeMainPath, isEnabled = () => false, log = () => {}, registry } = {}) {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath) throw new TypeError('nativeMainPath is required');
  const vscode = createRequire(nativeMainPath)('vscode');
  const api = vscode?.windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') throw new Error('Native ACP registration API is unavailable');
  if (api[INSTANCE]) return api[INSTANCE];

  const sessions = registry || createSessionRegistry();
  const registrationDescriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
  const originalRegister = api.registerConnection;
  const connections = new Set();
  const goalRequests = new WeakSet();
  const activeRuns = new Map();
  const runGenerations = new Map();
  const observedRunning = new Set();
  const ambiguousNotified = new Set();
  const owners = new Set();
  let listener = null;
  let commandHandler = null;
  let disposed = false;

  const report = (event, data) => { try { log(event, data); } catch {} };
  function notify(sessionId, type, detail) {
    if (typeof listener !== 'function') return;
    try { listener({ sessionId, type, ...(detail || {}) }); } catch {}
  }
  function enabled() { return !disposed && isEnabled(); }
  function nextGeneration(sessionId) {
    const next = (runGenerations.get(sessionId) || 0) + 1;
    runGenerations.set(sessionId, next);
    if (runGenerations.size > SESSION_LIMIT * 2) {
      for (const key of [...runGenerations.keys()]) {
        if (!sessions.sessions().some(entry => entry.sessionId === key)) runGenerations.delete(key);
        if (runGenerations.size <= SESSION_LIMIT) break;
      }
    }
    return next;
  }
  function clearRun(sessionId) {
    activeRuns.delete(sessionId);
    observedRunning.delete(sessionId);
    nextGeneration(sessionId);
  }

  function detach(connector) {
    const entry = connector[ATTACHED];
    if (!entry) return;
    entry.active = false;
    for (const sessionId of [...entry.sessions]) {
      const remaining = sessions.release(sessionId, connector);
      entry.sessions.delete(sessionId);
      clearRun(sessionId);
      owners.delete(sessionId);
      if (remaining && remaining.connectors.size === 0) sessions.remove(sessionId);
      notify(sessionId, 'interrupted', { reason: 'detached' });
    }
    restore(connector, 'forwardClientRequest', entry.forwardWrapper, entry.forwardDescriptor);
    restore(connector, 'sendRequest', entry.sendRequestWrapper, entry.sendRequestDescriptor);
    if (entry.setStatusWrapper) restore(connector, 'setStatus', entry.setStatusWrapper, entry.setStatusDescriptor);
    if (entry.registration) restore(entry.registration, 'dispose', entry.disposeWrapper, entry.disposeDescriptor);
    delete connector[ATTACHED];
    connections.delete(connector);
  }

  function attach(connector) {
    if (disposed || !connector || connector[ATTACHED] || !isEligibleConnector(connector)) return null;
    if (connections.size >= CONNECTOR_LIMIT) return null;

    const originalSend = connector.sendRequest, originalForward = connector.forwardClientRequest;
    const originalSetStatus = typeof connector.setStatus === 'function' ? connector.setStatus : null;
    const entry = {
      active: true, connector, sessions: new Set(),
      sendRequestDescriptor: Object.getOwnPropertyDescriptor(connector, 'sendRequest'),
      forwardDescriptor: Object.getOwnPropertyDescriptor(connector, 'forwardClientRequest'),
      setStatusDescriptor: originalSetStatus ? Object.getOwnPropertyDescriptor(connector, 'setStatus') : null
    };

    function adopt(sessionId) {
      const clean = sessionIdentifier(sessionId);
      if (!clean) return false;
      const before = sessions.adopt(clean, connector);
      if (!before || !before.connectors.has(connector)) return false;
      entry.sessions.add(clean);
      if (before.connectors.size > 1 && owners.has(clean) && !ambiguousNotified.has(clean)) {
        ambiguousNotified.add(clean);
        notify(clean, 'interrupted', { reason: 'ambiguous-session' });
      }
      return true;
    }
    function touch(sessionId, status) {
      const clean = sessionIdentifier(sessionId);
      if (clean) sessions.observe(clean, status);
    }
    function currentGeneration(sessionId) {
      return runGenerations.get(sessionId) || 0;
    }

    function rewriteGoalCommand(request, sessionId) {
      if (typeof commandHandler !== 'function' || !enabled()) return null;
      const command = parseGoalCommand(request?.params?.prompt);
      if (!command) return null;
      adopt(sessionId);
      let action = null;
      try {
        action = commandHandler({
          sessionId, action: command.action, text: command.text,
          ambiguous: sessions.ambiguous(sessionId), connected: sessions.uniqueConnector(sessionId) === connector
        });
      } catch { action = null; }
      if (!action || typeof action.prompt !== 'string' || !action.prompt) return null;
      report('goal-command', { action: command.action, run: !!action.runId });
      return {
        request: { ...request, params: { ...request.params, prompt: [{ type: 'text', text: action.prompt }] } },
        runId: typeof action.runId === 'string' && action.runId ? action.runId : null
      };
    }

    entry.sendRequestWrapper = function (...args) {
      let request = args[0];
      const method = request?.method, sessionId = sessionIdentifier(request?.params?.sessionId);
      let isGoal = goalRequests.has(request);
      if (!disposed && entry.active && sessionId && method === 'session/prompt' && !isGoal) {
        const rewritten = rewriteGoalCommand(request, sessionId);
        if (rewritten) {
          request = rewritten.request;
          args = [request, ...args.slice(1)];
          isGoal = true;
          clearRun(sessionId);
          if (rewritten.runId) activeRuns.set(sessionId, rewritten.runId);
        }
      }
      if (!disposed && entry.active && sessionId) {
        if (RESET_METHODS.has(method)) {
          clearRun(sessionId);
          touch(sessionId, 'unknown');
          notify(sessionId, 'interrupted', { reason: method });
        } else if (method === 'session/prompt') {
          if (isGoal) {
            adopt(sessionId);
            touch(sessionId, 'busy');
          } else {
            adopt(sessionId);
            clearRun(sessionId);
            touch(sessionId, 'busy');
            notify(sessionId, 'user-prompt');
          }
        }
      }
      if (isGoal) goalRequests.delete(request);
      const isV1 = !(connector.protocolVersion >= 2);
      const requestGeneration = sessionId ? currentGeneration(sessionId) : null;
      let result;
      try { result = Reflect.apply(originalSend, this, args); }
      catch (error) {
        if (method === 'session/prompt' && sessionId && currentGeneration(sessionId) === requestGeneration) {
          clearRun(sessionId);
          touch(sessionId, 'unknown');
          notify(sessionId, 'interrupted', { reason: 'send-failed' });
        }
        throw error;
      }
      const complete = value => {
        if (disposed || !entry.active) return value;
        if (SESSION_METHODS.has(method)) {
          const created = sessionIdentifier(value?.sessionId) || sessionId;
          if (created) { adopt(created); touch(created, 'idle'); }
          return value;
        }
        if (method === 'session/prompt' && sessionId && isV1) {
          if (currentGeneration(sessionId) !== requestGeneration) return value;
          const runId = activeRuns.get(sessionId);
          if (runId) {
            clearRun(sessionId);
            touch(sessionId, 'idle');
            notify(sessionId, 'idle', { runId, stopReason: typeof value?.stopReason === 'string' ? value.stopReason : null });
          } else {
            touch(sessionId, 'idle');
            if (owners.has(sessionId)) notify(sessionId, 'user-idle');
          }
        }
        return value;
      };
      const failed = error => {
        if (!disposed && entry.active && method === 'session/prompt' && sessionId &&
            currentGeneration(sessionId) === requestGeneration) {
          clearRun(sessionId);
          touch(sessionId, 'unknown');
          notify(sessionId, 'interrupted', { reason: 'send-failed' });
        }
        throw error;
      };
      if (result && typeof result.then === 'function') return result.then(complete, failed);
      return complete(result);
    };

    entry.forwardWrapper = function (...args) {
      if (!disposed && entry.active && enabled()) {
        try { args = [withGoalCommand(args[0]), ...args.slice(1)]; } catch {}
      }
      const result = Reflect.apply(originalForward, this, args);
      try { observeIncoming(args[0]); } catch {}
      return result;
    };

    function observeIncoming(request) {
      if (disposed || !entry.active) return;
      const method = request?.method;
      let params = request?.params;
      if (method === 'ext/method' && params?.method === '_session/elicitation' && params?.params) params = params.params;
      const sessionId = sessionIdentifier(params?.sessionId);
      if (!sessionId) return;
      if (INTERRUPT_METHODS.has(method) ||
          (method === 'ext/method' && request?.params?.method === '_session/elicitation')) {
        if (adopt(sessionId)) { clearRun(sessionId); touch(sessionId, 'unknown'); }
        notify(sessionId, 'interrupted', { reason: 'permission' });
        return;
      }
      if (method !== 'session/update') return;
      const update = params?.update;
      if (!update) return;
      if (update._meta?.['cognition.ai/subagent_context'] ||
          update.content?._meta?.['cognition.ai/subagent_context'] ||
          params._meta?.['cognition.ai/subagent_context']) return;
      const adopted = adopt(sessionId);
      if (sessions.ambiguous(sessionId)) return;
      const kind = update.sessionUpdate;
      if (kind === 'state_update') {
        if (update.state === 'running') {
          if (adopted) {
            if (activeRuns.has(sessionId)) observedRunning.add(sessionId);
            touch(sessionId, 'busy');
          }
          return;
        }
        if (update.state === 'requires_action' || update.state === 'refusal' || update.state === 'cancelled' ||
            update.stopReason === 'cancelled' || update.stopReason === 'refusal') {
          if (adopted) { clearRun(sessionId); touch(sessionId, 'unknown'); }
          notify(sessionId, 'interrupted', { reason: update.stopReason || update.state });
          return;
        }
        if (update.state === 'idle') {
          if (!adopted) return;
          touch(sessionId, 'idle');
          const runId = activeRuns.get(sessionId);
          if (runId && observedRunning.has(sessionId)) {
            clearRun(sessionId);
            notify(sessionId, 'idle', { runId, stopReason: update.stopReason ?? null });
          } else if (!runId && owners.has(sessionId)) {
            notify(sessionId, 'user-idle');
          }
          return;
        }
        return;
      }
      if (kind === 'session_info_update') {
        if (adopted) sessions.updateTitle(sessionId, update.title);
        const meta = { ...(params?._meta?.['cognition.ai/session'] || {}), ...(update._meta || {}) };
        const outcome = meta['cognition.ai/finishedOutcome'];
        const disabled = meta['cognition.ai/inputDisabledReason'];
        const actionReq = meta['cognition.ai/userActionRequired'];
        if (['completed', 'stopped', 'suspended', 'expired'].includes(outcome) ||
            (typeof disabled === 'string' && disabled) || (typeof actionReq === 'string' && actionReq)) {
          if (adopted) { clearRun(sessionId); touch(sessionId, 'unknown'); }
          notify(sessionId, 'interrupted', { reason: 'session-inactive' });
        }
      }
    }

    if (originalSetStatus) {
      entry.setStatusWrapper = function (status, ...rest) {
        if (['disconnected', 'disabled', 'disposed'].includes(String(status).toLowerCase())) {
          for (const sessionId of [...entry.sessions]) {
            sessions.release(sessionId, connector);
            sessions.observe(sessionId, 'unknown');
            entry.sessions.delete(sessionId);
            clearRun(sessionId);
            owners.delete(sessionId);
            notify(sessionId, 'disconnect');
          }
        }
        return Reflect.apply(originalSetStatus, this, [status, ...rest]);
      };
    }

    try {
      if (originalSetStatus) connector.setStatus = entry.setStatusWrapper;
      connector.sendRequest = entry.sendRequestWrapper;
      connector.forwardClientRequest = entry.forwardWrapper;
      connector[ATTACHED] = entry;
    } catch (error) {
      restore(connector, 'sendRequest', entry.sendRequestWrapper, entry.sendRequestDescriptor);
      restore(connector, 'forwardClientRequest', entry.forwardWrapper, entry.forwardDescriptor);
      if (originalSetStatus) restore(connector, 'setStatus', entry.setStatusWrapper, entry.setStatusDescriptor);
      delete connector[ATTACHED];
      throw error;
    }
    connections.add(connector);
    report('goal-continue-connector-attached');
    return entry;
  }

  function registerWrapper(connector, ...rest) {
    let entry;
    try { entry = attach(connector); } catch {}
    let registration;
    try { registration = Reflect.apply(originalRegister, this, [connector, ...rest]); }
    catch (error) { if (entry) detach(connector); throw error; }
    if (entry && registration && typeof registration.dispose === 'function') {
      entry.registration = registration;
      try {
        entry.disposeDescriptor = Object.getOwnPropertyDescriptor(registration, 'dispose');
        const originalDispose = registration.dispose;
        entry.disposeWrapper = function (...disposeArgs) { detach(connector); return Reflect.apply(originalDispose, this, disposeArgs); };
        registration.dispose = entry.disposeWrapper;
      } catch { detach(connector); }
    }
    return registration;
  }
  api.registerConnection = registerWrapper;

  function mirrorUserMessage(connector, sessionId, clientMessageId, runsStarted) {
    const isV2 = connector.protocolVersion >= 2;
    const label = 'Goal 自动推进（第 ' + runsStarted + ' 次运行）';
    const timestamp = new Date().toISOString();
    const message = isV2 ? {
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'user_message', messageId: clientMessageId, content: [{ type: 'text', text: label }],
          _meta: {
            'cognition.ai/clientMessageId': clientMessageId,
            'cognition.ai/isOptimistic': true,
            'cognition.ai/timestamp': timestamp
          }
        }
      }
    } : {
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk', content: { type: 'text', text: label },
          _meta: {
            'cognition.ai/clientMessageId': clientMessageId,
            'cognition.ai/isOptimistic': true,
            'cognition.ai/timestamp': timestamp
          }
        }
      }
    };
    try {
      const result = connector.forwardClientRequest(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {}
  }

  function dispatch({ sessionId, runId, revision, prompt, runsStarted }) {
    if (disposed) return { ok: false, error: 'disposed' };
    const clean = sessionIdentifier(sessionId);
    if (!clean) return { ok: false, error: 'invalid-session' };
    if (!enabled()) return { ok: false, error: 'disabled' };
    if (!owners.has(clean)) return { ok: false, error: 'not-owner' };
    if (activeRuns.has(clean)) return { ok: false, error: 'run-in-flight' };
    if (sessions.ambiguous(clean)) return { ok: false, error: 'ambiguous-session' };
    const connector = sessions.uniqueConnector(clean);
    if (!connector) return { ok: false, error: 'unknown-session' };
    const status = sessions.sessions().find(item => item.sessionId === clean)?.status;
    if (status === 'busy') return { ok: false, error: 'busy-session' };
    if (status !== 'idle') return { ok: false, error: 'unknown-status' };
    const clientMessageId = crypto.randomUUID();
    mirrorUserMessage(connector, clean, clientMessageId, Number.isSafeInteger(runsStarted) ? runsStarted : 0);
    const request = {
      method: 'session/prompt',
      params: { sessionId: clean, prompt: [{ type: 'text', text: prompt }], _meta: { 'cognition.ai/clientMessageId': clientMessageId } }
    };
    goalRequests.add(request);
    activeRuns.set(clean, runId);
    nextGeneration(clean);
    sessions.observe(clean, 'busy');
    try {
      const token = vscode?.CancellationToken?.None;
      const result = connector.sendRequest(request, token);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      goalRequests.delete(request);
      clearRun(clean);
      sessions.observe(clean, 'unknown');
      return { ok: false, error: 'send-failed' };
    }
    return { ok: true, runId };
  }
  function cancel(sessionId, expectedRunId) {
    const clean = sessionIdentifier(sessionId);
    if (!clean) return { ok: false, error: 'invalid-session' };
    const active = activeRuns.get(clean);
    if (!active) return { ok: false, error: 'no-active-run' };
    if (expectedRunId !== undefined && expectedRunId !== active) return { ok: false, error: 'run-mismatch' };
    const connector = sessions.uniqueConnector(clean);
    if (!connector) return { ok: false, error: 'unknown-session' };
    clearRun(clean);
    sessions.observe(clean, 'unknown');
    try {
      const result = connector.sendRequest({ method: 'session/cancel', params: { sessionId: clean } });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { return { ok: false, error: 'cancel-failed' }; }
    return { ok: true };
  }
  function hasActiveGoal(sessionId) {
    const clean = sessionIdentifier(sessionId);
    return !!clean && owners.has(clean);
  }

  const handle = {
    sessions: () => sessions.sessions(),
    sessionStatus: sessionId => {
      const clean = sessionIdentifier(sessionId);
      const entry = sessions.sessions().find(item => item.sessionId === clean);
      return entry ? entry.status : 'unknown';
    },
    dispatch,
    cancel,
    hasActiveGoal,
    setListener(next) { listener = typeof next === 'function' ? next : null; },
    setCommandHandler(next) { commandHandler = typeof next === 'function' ? next : null; },
    setGoalOwned(sessionId, owned) {
      const clean = sessionIdentifier(sessionId);
      if (!clean) return false;
      if (owned) owners.add(clean); else owners.delete(clean);
      return owners.has(clean);
    },
    status() {
      return { installed: !disposed, connections: connections.size, sessions: sessions.size };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      restore(api, 'registerConnection', registerWrapper, registrationDescriptor);
      for (const connector of [...connections]) detach(connector);
      sessions.clear();
      activeRuns.clear();
      runGenerations.clear();
      observedRunning.clear();
      ambiguousNotified.clear();
      owners.clear();
      commandHandler = null;
      if (api[INSTANCE] === handle) delete api[INSTANCE];
    }
  };
  Object.defineProperty(api, INSTANCE, { value: handle, configurable: true, writable: true });
  return handle;
}

module.exports = { installGoalContinue, createSessionRegistry, parseGoalCommand, withGoalCommand, GOAL_COMMAND, SESSION_LIMIT, isEligibleConnector };