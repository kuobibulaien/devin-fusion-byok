'use strict';
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function usageOf(update, timestampMs) {
  const used = tokens(update?.used), size = tokens(update?.size);
  if (used === null || size === null || size === 0) return null;
  return { used, size, timestampMs };
}
function usageRejectionReason(sessionId, update) {
  if (!id(sessionId)) return 'invalid-session-id';
  if (tokens(update?.used) === null) return 'invalid-used';
  if (tokens(update?.size) === null || update.size === 0) return 'invalid-size';
  const meta = update?._meta?.['cognition.ai/subagent_context'];
  if (meta != null && !id(meta?.parentAgentId)) return 'invalid-parent-id';
  if (meta?.runId != null && !id(meta.runId)) return 'invalid-run-id';
  return null;
}
function createContextState({ now = () => performance.now(), wallNow = () => Date.now(), limit = 100 } = {}) {
  const sessions = new Map();
  let sequence = 0;
  function session(sessionId) {
    if (!id(sessionId)) return null;
    let value = sessions.get(sessionId);
    if (!value) {
      value = { sessionId, lead: null, subagents: new Map(), turn: null, modelUid: null, revision: 0 };
      sessions.set(sessionId, value);
      if (sessions.size > limit) sessions.delete(sessions.keys().next().value);
    }
    return value;
  }
  function touch(value) {
    value.revision = ++sequence;
    sessions.delete(value.sessionId);
    sessions.set(value.sessionId, value);
  }
  function start(sessionId) {
    const value = session(sessionId);
    if (!value) return null;
    const generation = ++sequence;
    value.turn = { generation, started: now(), durationMs: null, status: 'running' };
    touch(value);
    return generation;
  }
  function finish(sessionId, generation, status = 'finished') {
    const value = sessions.get(sessionId), turn = value?.turn;
    if (!turn || turn.status !== 'running' || (generation !== undefined && generation !== turn.generation)) return;
    turn.durationMs = Math.max(0, now() - turn.started);
    turn.status = status;
    touch(value);
  }
  function observe(sessionId, update) {
    if (!id(sessionId) || !update || typeof update !== 'object') return;
    const meta = update._meta?.['cognition.ai/subagent_context'];
    const scoped = meta !== undefined && meta !== null;
    if (update.sessionUpdate === 'usage_update') {
      const usage = usageOf(update, wallNow());
      if (!usage) return;
      if (usageRejectionReason(sessionId, update)) return;
      const value = session(sessionId);
      if (scoped) {
        const key = JSON.stringify([meta.parentAgentId, meta.runId]);
        value.subagents.delete(key);
        value.subagents.set(key, { parentAgentId: meta.parentAgentId, runId: meta.runId ?? null, ...usage });
        if (value.subagents.size > 32) value.subagents.delete(value.subagents.keys().next().value);
      } else value.lead = usage;
      touch(value);
      return true;
    } else if (!scoped && update.sessionUpdate === 'state_update' &&
        ['idle', 'completed', 'cancelled', 'error', 'stopped'].includes(update.state)) {
      finish(sessionId, undefined, update.state);
    }
  }
  function selectModel(sessionId, configOptions) {
    const model = Array.isArray(configOptions) ? configOptions.find(option => option?.category === 'model' && option.type === 'select') : null;
    const modelUid = id(model?.currentValue);
    if (!modelUid) return;
    const value = session(sessionId);
    if (!value) return;
    if (value.modelUid && value.modelUid !== modelUid) {
      value.lead = null;
      value.subagents.clear();
    }
    value.modelUid = modelUid;
    touch(value);
  }
  function reset(sessionId) { sessions.delete(sessionId); }
  function snapshot() {
    return [...sessions.values()].sort((a, b) => b.revision - a.revision).map(value => ({
      sessionId: value.sessionId, modelUid: value.modelUid,
      lead: value.lead ? { ...value.lead } : null,
      subagents: [...value.subagents.values()].map(usage => ({ ...usage })),
      turn: value.turn ? { status: value.turn.status, durationMs: value.turn.status === 'running'
        ? Math.max(0, now() - value.turn.started) : value.turn.durationMs } : null,
    }));
  }
  return { start, finish, observe, selectModel, reset, snapshot, clear() { sessions.clear(); } };
}
module.exports = { createContextState, usageRejectionReason };
