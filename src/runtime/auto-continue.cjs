'use strict';

const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');

const INSTANCE = Symbol.for('devin-fusion-byok.auto-continue.v1');
const ATTACHED = Symbol.for('devin-fusion-byok.auto-continue.attached');
const TARGET_ERROR = 'Provider response could not be completed';
const TRANSIENT_HTTP_RE = /Provider returned HTTP (?:408|429|500|502|503|504)\.$/;
const TERMINAL_BLOCKER_RE = /(?:Provider returned HTTP (?:4\d\d|5\d\d)\.|Provider response format is invalid\.)$/;

function matchesProviderError(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(TARGET_ERROR) || trimmed.endsWith(TARGET_ERROR + '.')) return true;
  return TRANSIENT_HTTP_RE.test(trimmed);
}

function matchesTerminalBlocker(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimEnd();
  if (TRANSIENT_HTTP_RE.test(trimmed)) return false;
  return TERMINAL_BLOCKER_RE.test(trimmed);
}

const RESET_METHODS = new Set([
  'session/cancel',
  'session/load',
  'session/resume',
  'session/close',
  'session/delete',
  'session/archive',
  '_cognition.ai/session/archive'
]);

function restore(target, key, wrapper, descriptor) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}

function installAutoContinue({ nativeMainPath, isEnabled = () => false, getOptions = () => ({ onProviderError: true, untilPlanComplete: false }), log = () => {}, scheduler } = {}) {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath) {
    throw new TypeError('nativeMainPath is required');
  }
  const nativeRequire = createRequire(nativeMainPath);
  const vscode = nativeRequire('vscode');
  const api = vscode?.windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') {
    throw new Error('Native ACP registration API is unavailable');
  }
  if (api[INSTANCE]) return api[INSTANCE];

  const scheduleTimer = scheduler?.setTimeout || setTimeout;
  const clearTimer = scheduler?.clearTimeout || clearTimeout;

  const registrationDescriptor = Object.getOwnPropertyDescriptor(api, 'registerConnection');
  const originalRegister = api.registerConnection;
  const connections = new Map();
  const autoAttempts = new WeakMap();
  let disposed = false;
  let autoContinueCount = 0;

  function report(event, data) {
    try { log(event, data); } catch {}
  }

  function detach(connector) {
    const entry = connections.get(connector);
    if (!entry) return;
    entry.active = false;
    for (const timer of entry.timers.values()) clearTimer(timer);
    entry.timers.clear();
    for (const turn of entry.sessions.values()) {
      turn.retryDisallowed = true;
      if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
        turn.deferred.settled = true;
        if (turn.lastResult?.isReject) turn.deferred.reject(turn.lastResult.value);
        else turn.deferred.resolve(turn.lastResult.value);
      }
    }
    entry.sessions.clear();
    restore(connector, 'sendRequest', entry.sendRequestWrapper, entry.sendRequestDescriptor);
    restore(connector, 'forwardClientRequest', entry.forwardWrapper, entry.forwardDescriptor);
    if (entry.setStatusWrapper) {
      restore(connector, 'setStatus', entry.setStatusWrapper, entry.setStatusDescriptor);
    }
    if (entry.registration) restore(entry.registration, 'dispose', entry.disposeWrapper, entry.disposeDescriptor);
    delete connector[ATTACHED];
    connections.delete(connector);
  }

  function attach(connector) {
    if (disposed || !connector || connector[ATTACHED] || connector.agentId !== 'devin-cli' ||
        connector.bundled !== true || connector.location?.kind !== 'local' ||
        typeof connector.sendRequest !== 'function' || typeof connector.forwardClientRequest !== 'function') {
      return null;
    }

    const originalSend = connector.sendRequest;
    const originalForward = connector.forwardClientRequest;
    const originalSetStatus = typeof connector.setStatus === 'function' ? connector.setStatus : null;

    const sendRequestDescriptor = Object.getOwnPropertyDescriptor(connector, 'sendRequest');
    const forwardDescriptor = Object.getOwnPropertyDescriptor(connector, 'forwardClientRequest');
    const setStatusDescriptor = originalSetStatus ? Object.getOwnPropertyDescriptor(connector, 'setStatus') : null;

    const entry = {
      active: true,
      connector,
      timers: new Map(),
      sessions: new Map(),
      turnGeneration: 0,
      sendRequestDescriptor,
      forwardDescriptor,
      setStatusDescriptor
    };

    function cancelSessionTimer(sessionId) {
      const timer = entry.timers.get(sessionId);
      if (timer) {
        clearTimer(timer);
        entry.timers.delete(sessionId);
      }
    }

    function checkHasPendingPlan(turn) {
      if (!turn?.plans || turn.plans.size === 0) return false;
      for (const plan of turn.plans.values()) {
        if (!plan || plan.invalid) continue;
        if (plan.pendingCount > 0) return true;
      }
      return false;
    }

    function scheduleAuto(sessionId, turn, reason = 'error') {
      cancelSessionTimer(sessionId);
      turn.scheduledReason = reason;
      const attempts = turn.attempts || 0;
      const safePow = Math.min(attempts, 10);
      const delay = Math.min(2000 * Math.pow(2, safePow), 30000);
      const generation = turn.generation;
      report('auto-continue-scheduled', { attempts, delay, reason });

      const timer = scheduleTimer(() => {
        entry.timers.delete(sessionId);
        if (disposed || !entry.active || !isEnabled()) return;
        const currentTurn = entry.sessions.get(sessionId);
        if (!currentTurn || currentTurn.generation !== generation || currentTurn.retryDisallowed) return;
        executeAuto(sessionId, attempts, currentTurn);
      }, delay);

      entry.timers.set(sessionId, timer);
    }

    function executeAuto(sessionId, attempts, activeTurn) {
      const clientMessageId = randomUUID();
      const timestamp = new Date().toISOString();
      const isV2 = (connector.protocolVersion >= 2) || !!activeTurn.isV2;

      const synthetic = isV2 ? {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message',
            messageId: clientMessageId,
            content: [{ type: 'text', text: 'continue' }],
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
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'continue' },
            _meta: {
              'cognition.ai/clientMessageId': clientMessageId,
              'cognition.ai/isOptimistic': true,
              'cognition.ai/timestamp': timestamp
            }
          }
        }
      };

      try {
        const ret = originalForward.call(connector, synthetic);
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch {}

      const promptRequest = {
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'continue' }],
          _meta: {
            'cognition.ai/clientMessageId': clientMessageId
          }
        }
      };
      autoAttempts.set(promptRequest, attempts + 1);
      autoContinueCount++;
      report('auto-continue-fired', { attempts: attempts + 1 });

      let token;
      try { token = vscode?.CancellationToken?.None; } catch {}

      try {
        Promise.resolve(entry.sendRequestWrapper.call(connector, promptRequest, token)).catch(() => report('auto-continue-send-error'));
      } catch (err) {
        report('auto-continue-send-error');
        if (activeTurn.deferred && !activeTurn.deferred.settled) {
          activeTurn.deferred.settled = true;
          activeTurn.deferred.reject(err);
        }
      }
    }

    function handlePromptPromise(promise, turn, sessionId, capturedGen) {
      Promise.resolve(promise).then(
        res => {
          if (disposed || !entry.active) {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
            return;
          }

          const currentTurn = entry.sessions.get(sessionId);
          if (turn.retryDisallowed || !currentTurn || currentTurn !== turn) {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
            return;
          }

          if (res?.stopReason === 'cancelled' || res?.stopReason === 'refusal') {
            turn.consumed = true;
            turn.retryDisallowed = true;
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
            entry.sessions.delete(sessionId);
            return;
          }

          if (typeof res?.stopReason !== 'string') {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
            return;
          }

          if (turn.generation !== capturedGen) return;
          turn.consumed = true;
          const options = getOptions() || {};

          const shouldRetryError = !turn.retryDisallowed && isEnabled() && options.onProviderError !== false && matchesProviderError(turn.tail);
          const hasPendingPlan = checkHasPendingPlan(turn);
          const isBlocked = matchesTerminalBlocker(turn.tail);
          const shouldRetryPlan = !turn.retryDisallowed && !isBlocked && isEnabled() && options.untilPlanComplete === true &&
            hasPendingPlan && (res.stopReason === 'end_turn' || res.stopReason === 'max_tokens');

          if (shouldRetryError) {
            turn.lastResult = { value: res, isReject: false };
            scheduleAuto(sessionId, turn, 'error');
          } else if (shouldRetryPlan) {
            turn.lastResult = { value: res, isReject: false };
            scheduleAuto(sessionId, turn, 'plan');
          } else {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.resolve(res);
            }
            entry.sessions.delete(sessionId);
          }
        },
        err => {
          if (disposed || !entry.active) {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.reject(err);
            }
            return;
          }

          const currentTurn = entry.sessions.get(sessionId);
          if (turn.retryDisallowed || !currentTurn || currentTurn !== turn) {
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.reject(err);
            }
            return;
          }

          if (turn.generation !== capturedGen) return;
          turn.consumed = true;
          const msg = typeof err?.message === 'string' ? err.message : (typeof err === 'string' ? err : '');
          const isExactMsg = (msg === TARGET_ERROR || msg === TARGET_ERROR + '.');
          const options = getOptions() || {};

          if (isEnabled() && options.onProviderError !== false && isExactMsg) {
            turn.lastResult = { value: err, isReject: true };
            scheduleAuto(sessionId, turn, 'error');
          } else {
            turn.retryDisallowed = true;
            if (turn.deferred && !turn.deferred.settled) {
              turn.deferred.settled = true;
              turn.deferred.reject(err);
            }
            entry.sessions.delete(sessionId);
          }
        }
      );
    }

    function validatePlanEntries(entries) {
      if (!Array.isArray(entries) || entries.length > 1000) return null;
      let pending = 0;
      for (const e of entries) {
        if (!e || typeof e !== 'object' || typeof e.content !== 'string') return null;
        const status = e.status;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' && status !== 'cancelled') {
          return null;
        }
        if (status === 'pending' || status === 'in_progress') pending++;
      }
      return pending;
    }

    function processPlanUpdate(turn, update, sessionId) {
      if (!turn || !update) return;
      if (!turn.plans) turn.plans = new Map();

      if (update.sessionUpdate === 'plan') {
        const pending = validatePlanEntries(update.entries);
        if (pending === null) {
          turn.plans.set('__default__', { invalid: true, pendingCount: 0 });
        } else {
          turn.plans.set('__default__', { invalid: false, pendingCount: pending });
        }
      } else if (update.sessionUpdate === 'plan_update') {
        const plan = update.plan;
        const planId = plan?.planId;
        if (typeof planId !== 'string' || !planId || planId.length > 256) {
          turn.plans.clear();
        } else {
          if (turn.plans.size >= 100 && !turn.plans.has(planId)) {
            turn.plans.clear();
          } else if (plan?.type !== 'items') {
            turn.plans.set(planId, { invalid: true, pendingCount: 0 });
          } else {
            const pending = validatePlanEntries(plan.entries);
            if (pending === null) {
              turn.plans.set(planId, { invalid: true, pendingCount: 0 });
            } else {
              turn.plans.set(planId, { invalid: false, pendingCount: pending });
            }
          }
        }
      } else if (update.sessionUpdate === 'plan_removed') {
        const planId = update.planId;
        if (typeof planId === 'string' && planId && planId.length <= 256) {
          turn.plans.delete(planId);
        } else {
          turn.plans.clear();
        }
      }

      if (turn.scheduledReason === 'plan' && !checkHasPendingPlan(turn)) {
        cancelSessionTimer(sessionId);
        turn.scheduledReason = null;
        if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
          turn.deferred.settled = true;
          if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
          else turn.deferred.resolve(turn.lastResult.value);
        }
        entry.sessions.delete(sessionId);
      }
    }

    function observeIncoming(request) {
      if (disposed || !entry.active) return;
      const method = request?.method;
      let params = request?.params;
      if (method === 'ext/method' && params?.method === '_session/elicitation' && params?.params) {
        params = params.params;
      }
      const sessionId = params?.sessionId;
      if (!sessionId) return;

      if (method === 'session/request_permission' || method === 'elicitation/create' ||
          method === '_session/elicitation' || method === 'session/permission_request' ||
          (method === 'ext/method' && request?.params?.method === '_session/elicitation')) {
        const turn = entry.sessions.get(sessionId);
        if (turn) {
          cancelSessionTimer(sessionId);
          turn.retryDisallowed = true;
          if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
            turn.deferred.settled = true;
            if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
            else turn.deferred.resolve(turn.lastResult.value);
          }
          entry.sessions.delete(sessionId);
        }
        return;
      }

      if (method !== 'session/update') return;
      const update = params?.update;
      if (!update) return;

      if (update._meta?.['cognition.ai/subagent_context'] ||
          update.content?._meta?.['cognition.ai/subagent_context'] ||
          params._meta?.['cognition.ai/subagent_context']) {
        return;
      }

      const turn = entry.sessions.get(sessionId);
      if (!turn) return;

      const kind = update.sessionUpdate;
      if (kind === 'plan' || kind === 'plan_update' || kind === 'plan_removed') {
        processPlanUpdate(turn, update, sessionId);
        return;
      }

      if (kind === 'state_update') {
        turn.isV2 = true;
        const state = update.state;
        if (state === 'running') {
          cancelSessionTimer(sessionId);
        } else if (state === 'requires_action' || state === 'refusal' || state === 'cancelled' ||
                   update.stopReason === 'cancelled' || update.stopReason === 'refusal') {
          cancelSessionTimer(sessionId);
          turn.retryDisallowed = true;
          turn.consumed = true;
          turn.tail = '';
          entry.sessions.delete(sessionId);
          return;
        } else if (state === 'idle') {
          if (!turn.consumed) {
            turn.consumed = true;
            const options = getOptions() || {};
            const isError = matchesProviderError(turn.tail);
            const isBlocked = matchesTerminalBlocker(turn.tail);
            const shouldRetryError = !turn.retryDisallowed && isEnabled() && options.onProviderError !== false && isError;
            const hasPendingPlan = checkHasPendingPlan(turn);
            const allowedPlanReason = update.stopReason === 'end_turn' || update.stopReason === 'max_tokens';
            const shouldRetryPlan = !turn.retryDisallowed && !isBlocked && isEnabled() && options.untilPlanComplete === true && hasPendingPlan && allowedPlanReason;

            if (shouldRetryError) {
              scheduleAuto(sessionId, turn, 'error');
            } else if (shouldRetryPlan) {
              scheduleAuto(sessionId, turn, 'plan');
            } else {
              entry.sessions.delete(sessionId);
            }
          }
          return;
        }
      }

      if (kind === 'session_info_update') {
        const meta = { ...(params?._meta?.['cognition.ai/session'] || {}), ...(update._meta || {}) };
        const outcome = meta['cognition.ai/finishedOutcome'];
        const disabled = meta['cognition.ai/inputDisabledReason'];
        const actionReq = meta['cognition.ai/userActionRequired'];
        if (['completed', 'stopped', 'suspended', 'expired'].includes(outcome) ||
            (typeof disabled === 'string' && disabled) ||
            (typeof actionReq === 'string' && actionReq)) {
          cancelSessionTimer(sessionId);
          turn.retryDisallowed = true;
          if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
            turn.deferred.settled = true;
            if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
            else turn.deferred.resolve(turn.lastResult.value);
          }
          entry.sessions.delete(sessionId);
          return;
        }
      }

      if (turn.consumed) return;

      if (kind === 'agent_message_chunk') {
        if (update.messageId) {
          turn.isV2 = true;
          if (turn.messageId !== update.messageId) {
            turn.messageId = update.messageId;
            turn.tail = '';
          }
        }
        const content = update.content;
        if (content?.type === 'text' && typeof content.text === 'string') {
          turn.tail = (turn.tail + content.text).slice(-4096);
        } else {
          turn.tail = '';
        }
      } else if (kind === 'agent_message') {
        turn.isV2 = true;
        if (update.messageId && turn.messageId !== update.messageId) {
          turn.messageId = update.messageId;
          turn.tail = '';
        }
        if (update._meta?.['cognition.ai/abort'] || update.stopReason === 'cancelled') {
          turn.tail = '';
          turn.retryDisallowed = true;
          return;
        }
        if (Array.isArray(update.content)) {
          let text = '';
          let lastWasNonText = false;
          for (const b of update.content) {
            if (b?._meta?.['cognition.ai/subagent_context']) continue;
            if (b?.type === 'text' && typeof b.text === 'string') {
              text += b.text;
              lastWasNonText = false;
            } else {
              lastWasNonText = true;
            }
          }
          turn.tail = lastWasNonText ? '' : text.slice(-4096);
        }
      } else if (kind === 'user_message_chunk' || kind === 'user_message' ||
                 kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_call_content_chunk' ||
                 kind === 'agent_thought_chunk' || kind === 'agent_thought') {
        turn.tail = '';
      }
    }

    entry.sendRequestWrapper = function (...args) {
      const request = args[0];
      const method = request?.method;
      const sessionId = request?.params?.sessionId;

      if (!disposed && entry.active && sessionId && RESET_METHODS.has(method)) {
        cancelSessionTimer(sessionId);
        const existingTurn = entry.sessions.get(sessionId);
        if (existingTurn) {
          existingTurn.retryDisallowed = true;
          if (existingTurn.deferred && !existingTurn.deferred.settled && existingTurn.lastResult) {
            existingTurn.deferred.settled = true;
            if (existingTurn.lastResult?.isReject) existingTurn.deferred.reject(existingTurn.lastResult.value);
            else if (existingTurn.lastResult) existingTurn.deferred.resolve(existingTurn.lastResult.value);
          }
        }
        entry.sessions.delete(sessionId);
      }

      const enabled = isEnabled();
      const isAuto = autoAttempts.has(request);
      const isV2 = connector.protocolVersion >= 2;

      let manualTurn;
      if (!disposed && entry.active && sessionId && method === 'session/prompt') {
        if (!isAuto) {
          cancelSessionTimer(sessionId);
          const previousTurn = entry.sessions.get(sessionId);
          if (previousTurn) {
            previousTurn.retryDisallowed = true;
            if (previousTurn.deferred && !previousTurn.deferred.settled && previousTurn.lastResult) {
              previousTurn.deferred.settled = true;
              if (previousTurn.lastResult.isReject) previousTurn.deferred.reject(previousTurn.lastResult.value);
              else previousTurn.deferred.resolve(previousTurn.lastResult.value);
            }
          }
          if (enabled) {
            manualTurn = {
              generation: ++entry.turnGeneration,
              attempts: 0,
              tail: '',
              messageId: null,
              isV2,
              consumed: false,
              retryDisallowed: false,
              lastResult: null,
              deferred: null,
              plans: new Map(),
              scheduledReason: null
            };
            entry.sessions.set(sessionId, manualTurn);
          } else {
            entry.sessions.delete(sessionId);
          }
        } else {
          const currentTurn = entry.sessions.get(sessionId);
          if (currentTurn) {
            currentTurn.generation = ++entry.turnGeneration;
            currentTurn.attempts = autoAttempts.get(request) || (currentTurn.attempts + 1);
            currentTurn.tail = '';
            currentTurn.messageId = null;
            currentTurn.consumed = false;
            currentTurn.lastResult = null;
            currentTurn.scheduledReason = null;
          }
        }
      }

      const activeTurn = sessionId && method === 'session/prompt' ? entry.sessions.get(sessionId) : null;
      const currentGen = activeTurn?.generation;
      let originalPromise;
      try {
        originalPromise = Reflect.apply(originalSend, this, args);
      } catch (err) {
        if (activeTurn) {
          if (activeTurn.deferred && !activeTurn.deferred.settled) {
            activeTurn.deferred.settled = true;
            activeTurn.deferred.reject(err);
          }
          entry.sessions.delete(sessionId);
        }
        throw err;
      }

      if (!enabled || !activeTurn || isV2) {
        if (isV2 && activeTurn && originalPromise && typeof originalPromise.catch === 'function') {
          originalPromise.catch(() => {
            if (entry.sessions.get(sessionId) === activeTurn && activeTurn.generation === currentGen) {
              entry.sessions.delete(sessionId);
            }
          });
        }
        return originalPromise;
      }

      if (isAuto) {
        handlePromptPromise(originalPromise, activeTurn, sessionId, currentGen);
        return originalPromise;
      }

      let resolveDeferred, rejectDeferred;
      const chainedPromise = new Promise((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
      });
      activeTurn.deferred = { resolve: resolveDeferred, reject: rejectDeferred, settled: false };

      handlePromptPromise(originalPromise, activeTurn, sessionId, currentGen);

      return chainedPromise;
    };

    entry.forwardWrapper = function (...args) {
      try { observeIncoming(args[0]); } catch {}
      return Reflect.apply(originalForward, this, args);
    };

    if (originalSetStatus) {
      entry.setStatusWrapper = function (status, ...rest) {
        if (['disconnected', 'disabled', 'disposed'].includes(String(status).toLowerCase())) {
          cancelSessionTimer();
          for (const timer of entry.timers.values()) clearTimer(timer);
          entry.timers.clear();
          for (const turn of entry.sessions.values()) {
            turn.retryDisallowed = true;
            if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
              turn.deferred.settled = true;
              if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
              else turn.deferred.resolve(turn.lastResult.value);
            }
          }
          entry.sessions.clear();
        }
        return Reflect.apply(originalSetStatus, this, [status, ...rest]);
      };
    }

    try {
      if (originalSetStatus) connector.setStatus = entry.setStatusWrapper;
      connector.sendRequest = entry.sendRequestWrapper;
      connector.forwardClientRequest = entry.forwardWrapper;
      connector[ATTACHED] = true;
    } catch (e) {
      restore(connector, 'sendRequest', entry.sendRequestWrapper, sendRequestDescriptor);
      restore(connector, 'forwardClientRequest', entry.forwardWrapper, forwardDescriptor);
      if (originalSetStatus) restore(connector, 'setStatus', entry.setStatusWrapper, setStatusDescriptor);
      delete connector[ATTACHED];
      throw e;
    }

    connections.set(connector, entry);
    report('auto-continue-connector-attached');
    return entry;
  }

  function registerWrapper(connector, ...rest) {
    let entry;
    try {
      entry = attach(connector);
    } catch {}
    let registration;
    try {
      registration = Reflect.apply(originalRegister, this, [connector, ...rest]);
    } catch (err) {
      if (entry) detach(connector);
      throw err;
    }
    if (entry && registration && typeof registration.dispose === 'function') {
      entry.registration = registration;
      try {
        entry.disposeDescriptor = Object.getOwnPropertyDescriptor(registration, 'dispose');
        const originalDispose = registration.dispose;
        entry.disposeWrapper = function (...disposeArgs) {
          detach(connector);
          return Reflect.apply(originalDispose, this, disposeArgs);
        };
        registration.dispose = entry.disposeWrapper;
      } catch { detach(connector); }
    }
    return registration;
  }

  api.registerConnection = registerWrapper;

  const handle = {
    status() {
      return {
        installed: !disposed,
        connections: connections.size,
        activeSessions: [...connections.values()].reduce((sum, c) => sum + c.sessions.size, 0),
        pendingTimers: [...connections.values()].reduce((sum, c) => sum + c.timers.size, 0),
        autoContinueCount
      };
    },
    reset() {
      for (const entry of connections.values()) {
        for (const timer of entry.timers.values()) clearTimer(timer);
        entry.timers.clear();
        for (const turn of entry.sessions.values()) {
          turn.retryDisallowed = true;
          if (turn.deferred && !turn.deferred.settled && turn.lastResult) {
            turn.deferred.settled = true;
            if (turn.lastResult.isReject) turn.deferred.reject(turn.lastResult.value);
            else turn.deferred.resolve(turn.lastResult.value);
          }
        }
        entry.sessions.clear();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handle.reset();
      restore(api, 'registerConnection', registerWrapper, registrationDescriptor);
      for (const connector of [...connections.keys()]) detach(connector);
      delete api[INSTANCE];
    }
  };

  api[INSTANCE] = handle;
  return handle;
}

module.exports = {
  installAutoContinue,
  matchesProviderError
};
