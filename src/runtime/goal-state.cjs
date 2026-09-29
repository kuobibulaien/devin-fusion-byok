'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { goalPrompt } = require('./goal-prompts.cjs');
const store = require('./goal-store.cjs');

const NEXT_RUN_DELAY_MS = 1500;
const MISSING_REPORT_LIMIT = 2;
const REPEAT_EVIDENCE_LIMIT = 3;
const CONTINUE_STOP_REASON = 'end_turn';
const SESSION_STATUSES = ['idle', 'busy', 'unknown'];

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function sessionStatus(value) { return SESSION_STATUSES.includes(value) ? value : 'unknown'; }
function goalError(code, message) { const error = new Error(message); error.code = code; return error; }

function reportCommandFor({ execPath, reportCliPath, storeRoot, token }) {
  const example = JSON.stringify({ status: 'progress', evidence: '在这里写本次实际运行的证据' });
  return 'ELECTRON_RUN_AS_NODE=1 ' + shellQuote(execPath) + ' ' + shellQuote(reportCliPath) +
    ' --store ' + shellQuote(storeRoot) + ' --capability ' + shellQuote(token) + ' ' + shellQuote(example);
}

function createGoalController({
  root, transport, isEnabled = () => true, isTrusted = () => true,
  reportCliPath, execPath = process.execPath,
  scheduler = {}, now = Date.now, owner = crypto.randomBytes(16).toString('hex'),
  log = () => {}, nextRunDelayMs = NEXT_RUN_DELAY_MS
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('root must be an absolute path');
  if (!transport || typeof transport.dispatch !== 'function' || typeof transport.cancel !== 'function') {
    throw new TypeError('transport is required');
  }
  const cleanOwner = store.ownerId(owner);
  if (!cleanOwner) throw new TypeError('owner must be a 32-character hex id');
  const setTimer = scheduler.setTimeout || setTimeout;
  const clearTimer = scheduler.clearTimeout || clearTimeout;
  const report = (event, data) => { try { log(event, data); } catch {} };

  const timers = new Map();
  const inFlight = new Set();
  const generation = new Map();
  const mirrored = new Set();
  let disposed = false;
  let storeError = null;

  function mirror(sessionId, owned) {
    if (owned) mirrored.add(sessionId); else mirrored.delete(sessionId);
    try { transport.setGoalOwned?.(sessionId, owned); } catch {}
  }
  function bumpGeneration(id) {
    const next = (generation.get(id) || 0) + 1;
    generation.set(id, next);
    return next;
  }
  function cancelTimer(id) {
    const timer = timers.get(id);
    if (timer !== undefined) { clearTimer(timer); timers.delete(id); }
  }
  function readById(id) {
    try { return store.readGoalById(root, id); }
    catch (error) { storeError = error.message; return null; }
  }
  function persist(record) {
    try {
      store.writeGoal(root, { ...record, updatedAt: now() });
      storeError = null;
      return true;
    } catch (error) {
      storeError = error.message;
      report('goal-store-write-failed', { code: error.message });
      return false;
    }
  }
  function invalidateRun(record) {
    if (!record?.activeRun) return;
    store.removeCapabilitiesForRun(root, record.activeRun);
    store.removeReport(root, record.activeRun);
    record.activeRun = null;
  }
  function scan() {
    try { return store.listGoals(root); }
    catch (error) { storeError = error.message; return { goals: [], history: [], corrupt: [] }; }
  }
  function ownershipOf(sessionId) {
    try { return store.readOwnership(root, sessionId); }
    catch (error) { storeError = error.message; return { corrupt: true, ownerId: null }; }
  }
  function isLocalOwner(sessionId) {
    const ownership = ownershipOf(sessionId);
    return !!ownership && !ownership.corrupt && ownership.ownerId === cleanOwner;
  }
  function ownedRecords() {
    const records = [];
    for (const record of scan().goals) {
      if (record.archivedAt !== null) continue;
      if (!isLocalOwner(record.sessionId)) continue;
      records.push(record);
    }
    return records;
  }
  function ownsSession(sessionId) {
    const clean = store.identifier(sessionId);
    if (!clean) return false;
    try {
      const listed = store.listGoals(root);
      if (listed.corrupt.length) return true;
      return listed.goals.some(record => record.sessionId === clean && record.archivedAt === null);
    } catch { return true; }
  }
  function statusOfSession(sessionId) {
    try { return sessionStatus(transport.sessionStatus ? transport.sessionStatus(sessionId) : 'unknown'); }
    catch { return 'unknown'; }
  }
  function requireOwnership(record) {
    const ownership = ownershipOf(record.sessionId);
    if (!ownership || ownership.corrupt || ownership.ownerId !== cleanOwner) {
      throw goalError('not-owner', '该目标属于另一个窗口或进程，本窗口不操作。');
    }
  }
  function acquire(clean) {
    let acquired;
    try { acquired = store.acquireOwnership(root, clean, { owner: cleanOwner, now }); }
    catch (error) { storeError = error.message; throw goalError('ownership-unreadable', '无法确认该会话的归属，已拒绝操作。'); }
    if (!acquired.ok) throw goalError(acquired.reason, '该会话正被另一个窗口或进程占用，本窗口不接管。');
    return acquired;
  }

  function pauseGoal(record, reason) {
    cancelTimer(record.id);
    inFlight.delete(record.id);
    bumpGeneration(record.id);
    invalidateRun(record);
    record.status = 'paused';
    record.retryWindow = null;
    record.reason = store.normalizeReason(reason) ?? 'paused';
    if (!persist(record)) throw goalError('store-write-failed', '目标状态写入失败。');
    return record;
  }
  function releaseLocalRun(record) {
    cancelTimer(record.id);
    inFlight.delete(record.id);
    bumpGeneration(record.id);
  }
  function stopOwnedRun(record, running) {
    if (!running) return;
    try { Promise.resolve(transport.cancel(record.sessionId)).catch(() => {}); } catch {}
  }

  function dispatch(record) {
    if (disposed) return record;
    if (!isEnabled() || !isTrusted()) return pauseGoal(record, 'disabled');
    if (record.status !== 'active') return record;
    if (!isLocalOwner(record.sessionId)) {
      releaseLocalRun(record);
      return record;
    }
    if (record.runsStarted >= record.maxRuns) {
      record.status = 'limited';
      record.reason = 'max-runs';
      invalidateRun(record);
      persist(record);
      return readById(record.id) || record;
    }
    const session = statusOfSession(record.sessionId);
    if (session !== 'idle') return pauseGoal(record, session === 'busy' ? 'session-busy' : 'session-unavailable');

    const runId = crypto.randomUUID();
    const next = {
      ...record, revision: record.revision + 1, activeRun: runId,
      runsStarted: record.runsStarted + 1, reason: null
    };
    if (!persist(next)) return pauseGoal({ ...record, activeRun: null, revision: record.revision }, 'store-write-failed');

    let token;
    try { token = store.issueCapability(root, { id: next.id, revision: next.revision, run: runId, sessionId: next.sessionId }); }
    catch (error) {
      storeError = error.message;
      return pauseGoal(next, 'capability-failed');
    }
    const prompt = goalPrompt({ goal: next, reportCommand: reportCommandFor({ execPath, reportCliPath, storeRoot: root, token }) });
    const captured = bumpGeneration(next.id);
    inFlight.add(next.id);
    report('goal-run-dispatched', { runsStarted: next.runsStarted, revision: next.revision });
    Promise.resolve()
      .then(() => {
        if (disposed || generation.get(next.id) !== captured) return null;
        const current = readById(next.id);
        if (!current || current.status !== 'active' || current.activeRun !== runId || current.revision !== next.revision) return null;
        if (!isLocalOwner(current.sessionId)) { releaseLocalRun(current); return null; }
        if (!isEnabled() || !isTrusted()) return pauseGoal(current, 'disabled');
        if (statusOfSession(current.sessionId) !== 'idle') {
          return pauseGoal(current, statusOfSession(current.sessionId) === 'busy' ? 'session-busy' : 'session-unavailable');
        }
        return transport.dispatch({ sessionId: next.sessionId, runId, revision: next.revision, prompt, runsStarted: next.runsStarted });
      })
      .then(result => {
        if (!result || disposed || generation.get(next.id) !== captured) return;
        if (result.ok === false) {
          inFlight.delete(next.id);
          const current = readById(next.id);
          if (current && current.activeRun === runId) pauseGoal(current, 'dispatch-failed');
        }
      })
      .catch(() => {
        if (disposed || generation.get(next.id) !== captured) return;
        inFlight.delete(next.id);
        const current = readById(next.id);
        if (current && current.activeRun === runId) pauseGoal(current, 'dispatch-failed');
      });
    return next;
  }

  function scheduleNext(record) {
    cancelTimer(record.id);
    const capturedRevision = record.revision, captured = generation.get(record.id);
    const timer = setTimer(() => {
      timers.delete(record.id);
      if (disposed || generation.get(record.id) !== captured) return;
      const current = readById(record.id);
      if (!current || current.status !== 'active' || current.revision !== capturedRevision) return;
      if (!isLocalOwner(current.sessionId)) { releaseLocalRun(current); return; }
      if (!isEnabled() || !isTrusted()) { try { pauseGoal(current, 'disabled'); } catch {} return; }
      if (statusOfSession(current.sessionId) !== 'idle') { try { pauseGoal(current, 'session-not-idle'); } catch {} return; }
      try { dispatch(current); } catch {}
    }, nextRunDelayMs);
    timers.set(record.id, timer);
  }

  function applyReport(record, runId) {
    let submitted = null;
    try { submitted = store.readReport(root, runId); }
    catch (error) { storeError = error.message; }
    const valid = submitted && submitted.id === record.id && submitted.revision === record.revision &&
      submitted.sessionId === record.sessionId;
    if (!valid) {
      record.missingRuns += 1;
      invalidateRun(record);
      if (record.missingRuns >= MISSING_REPORT_LIMIT) {
        record.status = 'paused';
        record.reason = 'missing-report';
        persist(record);
        return record;
      }
      if (!persist(record)) return record;
      scheduleNext(record);
      return record;
    }
    record.evidence = [...record.evidence, {
      runId, revision: submitted.revision, status: submitted.status,
      evidence: submitted.evidence, submittedAt: submitted.submittedAt
    }].slice(-store.MAX_EVIDENCE_ENTRIES);
    record.missingRuns = 0;
    invalidateRun(record);
    if (submitted.status === 'review') { record.status = 'review'; record.reason = 'review'; persist(record); return record; }
    if (submitted.status === 'waiting' || submitted.status === 'blocked') {
      record.status = submitted.status; record.reason = submitted.status; persist(record); return record;
    }
    record.repeatCount = record.lastEvidence === submitted.evidence ? record.repeatCount + 1 : 1;
    record.lastEvidence = submitted.evidence;
    if (record.repeatCount >= REPEAT_EVIDENCE_LIMIT) {
      record.status = 'paused'; record.reason = 'no-progress'; persist(record); return record;
    }
    if (record.runsStarted >= record.maxRuns) {
      record.status = 'limited'; record.reason = 'max-runs'; persist(record); return record;
    }
    if (!persist(record)) return record;
    scheduleNext(record);
    return record;
  }

  function scheduleRetry(record) {
    if (!record.retryPolicy?.enabled) return pauseGoal(record, 'provider-error');
    cancelTimer(record.id);
    invalidateRun(record);
    const timestamp = now();
    const window = record.retryWindow || { startedAt: timestamp, deadlineAt: timestamp + record.retryPolicy.maxHours * 3600000, attempts: 0 };
    if (timestamp >= window.deadlineAt) return pauseGoal(record, 'retry-expired');
    if (record.runsStarted >= record.maxRuns) {
      record.status = 'limited'; record.reason = 'max-runs'; record.retryWindow = null; persist(record); return record;
    }
    record.status = 'retrying';
    record.reason = 'provider-error';
    record.retryWindow = { ...window, nextAt: Math.min(timestamp + record.retryPolicy.intervalMinutes * 60000, window.deadlineAt) };
    const captured = bumpGeneration(record.id), revision = record.revision;
    if (!persist(record)) return pauseGoal(record, 'store-write-failed');
    timers.set(record.id, setTimer(() => {
      timers.delete(record.id);
      if (disposed || generation.get(record.id) !== captured) return;
      const current = readById(record.id);
      if (!current || current.status !== 'retrying' || current.revision !== revision) return;
      try {
        if (!isLocalOwner(current.sessionId)) { releaseLocalRun(current); return; }
        if (!isEnabled() || !isTrusted()) return pauseGoal(current, 'disabled');
        if (now() >= current.retryWindow.deadlineAt) return pauseGoal(current, 'retry-expired');
        if (statusOfSession(current.sessionId) !== 'idle') return pauseGoal(current, 'session-not-idle');
        current.status = 'active';
        current.retryWindow.attempts++;
        dispatch(current);
      } catch { try { pauseGoal(current, 'retry-failed'); } catch {} }
    }, record.retryWindow.nextAt - timestamp));
    return record;
  }

  function handleRunEnd(sessionId, runId, stopReason) {
    const record = ownedRecords().find(goal => goal.sessionId === sessionId && goal.activeRun === runId);
    if (!record || record.status !== 'active') return;
    inFlight.delete(record.id);
    if (stopReason === 'provider-error') {
      let submitted;
      try { submitted = store.readReport(root, runId); } catch { return pauseGoal(record, 'store-write-failed'); }
      if (!submitted || submitted.id !== record.id || submitted.sessionId !== record.sessionId || submitted.revision !== record.revision) {
        scheduleRetry(record);
        return;
      }
    } else if (stopReason !== CONTINUE_STOP_REASON) {
      pauseGoal(record, typeof stopReason === 'string' && stopReason ? stopReason : 'run-ended-unknown');
      return;
    }
    record.retryWindow = null;
    applyReport(record, runId);
  }
  function handleStop(sessionId, reason) {
    const record = ownedRecords().find(goal => goal.sessionId === sessionId && goal.archivedAt === null);
    if (!record || !['active', 'retrying'].includes(record.status)) return;
    cancelTimer(record.id);
    inFlight.delete(record.id);
    bumpGeneration(record.id);
    invalidateRun(record);
    pauseGoal(record, reason || 'interrupted');
  }
  function onEvent(event) {
    if (disposed || !event || typeof event.type !== 'string') return;
    try {
      if (event.type === 'idle') handleRunEnd(event.sessionId, event.runId, event.stopReason);
      else if (event.type === 'interrupted') handleStop(event.sessionId, event.reason);
      else if (event.type === 'user-prompt') handleStop(event.sessionId, 'manual-prompt');
      else if (event.type === 'disconnect') handleStop(event.sessionId, 'disconnected');
    } catch (error) { storeError = error.message; }
  }

  function restore() {
    for (const record of scan().goals) {
      if (record.archivedAt !== null) continue;
      if (!isLocalOwner(record.sessionId)) continue;
      if (record.activeRun === null && !['active', 'retrying'].includes(record.status)) continue;
      try { pauseGoal(record, 'reloaded'); } catch {}
    }
  }
  function requireBoundary() {
    if (disposed) throw goalError('disposed', '目标控制器已停用。');
    if (!isEnabled()) throw goalError('disabled', '请先启用 Fusion BYOK。');
    if (!isTrusted()) throw goalError('untrusted', '当前工作区未受信任，不能启动或恢复目标。');
  }
  function goalOf(id) {
    const clean = store.goalId(id);
    if (!clean) throw goalError('invalid-id', '目标标识无效。');
    const record = readById(clean);
    if (!record) throw goalError('missing-goal', '该目标已不存在。');
    return record;
  }
  function goalOfOwned(id) {
    const record = goalOf(id);
    requireOwnership(record);
    return record;
  }
  function reclaim(record) {
    const ownership = ownershipOf(record.sessionId);
    if (ownership && (ownership.corrupt || ownership.ownerId !== cleanOwner)) {
      throw goalError('not-owner', '该目标属于另一个窗口或进程，本窗口不操作。');
    }
    if (ownership) return record;
    const acquired = acquire(record.sessionId);
    report('goal-ownership-reclaimed', { stale: acquired.stale === true });
    return readById(record.id) || record;
  }
  function startable(clean) {
    let listed;
    try { listed = store.listGoals(root); }
    catch (error) { storeError = error.message; throw goalError('store-unreadable', '目标状态存储不可读，已拒绝启动。'); }
    if (listed.corrupt.some(name => name === store.sessionKey(clean) + '.json')) {
      throw goalError('store-corrupt', '该会话已有无法解析的目标记录，请先人工处理，本窗口不会覆盖。');
    }
    if (listed.goals.some(record => record.sessionId === clean && record.archivedAt === null)) {
      throw goalError('goal-exists', '该会话已有进行中的目标，请先归档。');
    }
  }

  const handle = {
    ownsSession,
    sessionStatus: statusOfSession,
    snapshot() {
      const listed = scan();
      if (listed.corrupt.length) storeError = 'goal_store_corrupt';
      let sessions = [];
      try { sessions = (transport.sessions ? transport.sessions() : []).map(entry => ({ sessionId: entry.sessionId, status: sessionStatus(entry.status), ...(typeof entry.title === 'string' && entry.title ? { title: entry.title } : {}) })); }
      catch { sessions = []; }
      const view = record => {
        const ownership = ownershipOf(record.sessionId);
        const foreign = !!ownership && !ownership.corrupt && ownership.ownerId !== cleanOwner;
        const locked = !!ownership && (ownership.corrupt || foreign);
        return {
          id: record.id, sessionId: record.sessionId, revision: record.revision, objective: record.objective,
          criteria: record.criteria, status: record.status, runsStarted: record.runsStarted, maxRuns: record.maxRuns,
          activeRun: record.activeRun, reason: record.reason, archived: record.archivedAt !== null, locked,
          retryPolicy: store.normalizeRetryPolicy(record.retryPolicy), retryWindow: record.retryWindow ? { ...record.retryWindow } : null,
          evidence: record.evidence.map(entry => ({ ...entry })), createdAt: record.createdAt, updatedAt: record.updatedAt
        };
      };
      return {
        enabled: isEnabled(), trusted: isTrusted(), storeError, corruptGoals: listed.corrupt.length,
        sessions, pendingTimers: timers.size, inFlight: [...inFlight],
        goals: listed.goals.map(view), history: listed.history.map(view)
      };
    },
    start({ sessionId, objective, criteria, maxRuns, retryPolicy } = {}) {
      requireBoundary();
      const retry = store.normalizeRetryPolicy(retryPolicy);
      if (!retry) throw goalError('invalid-retry-policy', '重试间隔须为 1-1440 整数分钟，时限须为 1-168 整数小时。');
      const clean = store.identifier(sessionId);
      if (!clean) throw goalError('invalid-session', '请选择有效会话。');
      const objectiveText = store.normalizeObjective(objective);
      if (!objectiveText) throw goalError('invalid-objective', '目标描述必须是 1 到 ' + store.MAX_OBJECTIVE_LENGTH + ' 字符的文本。');
      const criteriaText = store.normalizeCriteria(criteria);
      if (!criteriaText) throw goalError('invalid-criteria', '验收标准必须是 1 到 ' + store.MAX_CRITERIA_LENGTH + ' 字符的文本。');
      const runs = store.normalizeMaxRuns(maxRuns);
      if (runs === null) throw goalError('invalid-max-runs', '运行上限必须是 1 到 ' + store.MAX_RUNS + ' 的整数。');
      if (statusOfSession(clean) !== 'idle') throw goalError('session-unavailable', '只能对已观察为空闲的会话启动目标。');
      startable(clean);
      acquire(clean);
      startable(clean);
      const timestamp = now();
      const record = {
        schemaVersion: store.SCHEMA_VERSION, id: crypto.randomBytes(16).toString('hex'), sessionId: clean,
        revision: 1, objective: objectiveText, criteria: criteriaText, status: 'active', runsStarted: 0,
        maxRuns: runs, activeRun: null, reason: null, evidence: [], missingRuns: 0,
        retryPolicy: retry, retryWindow: null,
        lastEvidence: null, repeatCount: 0, createdAt: timestamp, updatedAt: timestamp, archivedAt: null
      };
      try { store.writeGoal(root, { ...record, updatedAt: timestamp }); }
      catch (error) {
        storeError = error.message;
        store.releaseOwnership(root, clean, { owner: cleanOwner });
        throw goalError('store-write-failed', '目标状态写入失败，未发送任何内容。');
      }
      mirror(clean, true);
      return dispatch(readById(record.id) || record);
    },
    pause({ id } = {}) {
      const found = goalOf(id);
      if (found.archivedAt !== null) throw goalError('archived', '已归档的目标不能暂停。');
      if (found.status === 'completed') throw goalError('completed', '已完成的目标不能暂停。');
      const record = goalOfOwned(id);
      const running = inFlight.has(record.id);
      cancelTimer(record.id);
      inFlight.delete(record.id);
      bumpGeneration(record.id);
      invalidateRun(record);
      record.status = 'paused';
      record.retryWindow = null;
      record.reason = 'user-paused';
      try {
        if (!persist(record)) throw goalError('store-write-failed', '目标状态写入失败。');
      } finally {
        stopOwnedRun(record, running);
      }
      return readById(record.id) || record;
    },
    resume({ id, maxRuns } = {}) {
      requireBoundary();
      const record = goalOf(id);
      if (record.archivedAt !== null) throw goalError('archived', '已归档的目标不能恢复。');
      if (record.status === 'completed') throw goalError('completed', '已完成的目标不能恢复。');
      if (record.status === 'active') throw goalError('already-active', '该目标已在运行。');
      let runs = record.maxRuns;
      if (maxRuns !== undefined && maxRuns !== null) {
        const requested = store.normalizeMaxRuns(maxRuns);
        if (requested === null) throw goalError('invalid-max-runs', '运行上限必须是 1 到 ' + store.MAX_RUNS + ' 的整数。');
        if (requested <= record.runsStarted) throw goalError('invalid-max-runs', '新的运行上限必须大于已派发的 ' + record.runsStarted + ' 次。');
        runs = requested;
      }
      if (runs <= record.runsStarted) throw goalError('exhausted', '已达运行上限，请先提高运行上限再恢复。');
      if (statusOfSession(record.sessionId) !== 'idle') throw goalError('session-unavailable', '只能对已观察为空闲的会话恢复目标。');
      const acquired = acquire(record.sessionId);
      const current = readById(record.id) || record;
      current.status = 'active';
      current.reason = null;
      current.repeatCount = 0;
      current.missingRuns = 0;
      current.maxRuns = runs;
      if (!persist(current)) throw goalError('store-write-failed', '目标状态写入失败，未发送任何内容。');
      mirror(current.sessionId, true);
      report('goal-resumed', { stale: acquired.stale === true });
      return dispatch(readById(current.id) || current);
    },
    suspend({ reason = 'suspended' } = {}) {
      let paused = 0;
      for (const record of ownedRecords()) {
        const running = inFlight.has(record.id);
        cancelTimer(record.id);
        inFlight.delete(record.id);
        bumpGeneration(record.id);
        invalidateRun(record);
        if (record.status === 'active') { record.status = 'paused'; record.reason = store.normalizeReason(reason) ?? 'suspended'; }
        if (persist(record)) paused++;
        stopOwnedRun(record, running);
      }
      return paused;
    },
    accept({ id } = {}) {
      const found = goalOf(id);
      if (found.status !== 'review') throw goalError('not-review', '只有待验收状态的目标可以接受。');
      const record = reclaim(found);
      if (record.status !== 'review') throw goalError('not-review', '只有待验收状态的目标可以接受。');
      if (!record.evidence.length) throw goalError('no-evidence', '没有证据的目标不能验收。');
      record.status = 'completed';
      record.reason = 'accepted';
      invalidateRun(record);
      if (!persist(record)) throw goalError('store-write-failed', '目标状态写入失败。');
      return readById(record.id) || record;
    },
    archive({ id } = {}) {
      const found = goalOf(id);
      if (found.archivedAt !== null) throw goalError('archived', '该目标已经归档。');
      const record = reclaim(found);
      if (record.archivedAt !== null) throw goalError('archived', '该目标已经归档。');
      const running = inFlight.has(record.id);
      cancelTimer(record.id);
      inFlight.delete(record.id);
      bumpGeneration(record.id);
      invalidateRun(record);
      if (record.status === 'active') record.status = 'paused';
      const archivedAt = now();
      try {
        store.archiveGoal(root, { ...record, archivedAt, updatedAt: archivedAt });
      } catch (error) {
        storeError = error.message;
        throw goalError('store-write-failed', '归档记录写入失败。');
      } finally {
        stopOwnedRun(record, running);
      }
      record.archivedAt = archivedAt;
      mirror(record.sessionId, false);
      store.releaseOwnership(root, record.sessionId, { owner: cleanOwner });
      return { ...record, archived: true };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...timers.keys()]) cancelTimer(id);
      inFlight.clear();
      for (const record of ownedRecords()) {
        if (record.status !== 'active' && record.activeRun === null) continue;
        try { pauseGoal(record, 'disposed'); } catch {}
      }
      for (const sessionId of [...mirrored]) mirror(sessionId, false);
      for (const record of ownedRecords()) store.releaseOwnership(root, record.sessionId, { owner: cleanOwner });
    }
  };

  restore();
  for (const record of ownedRecords()) if (record.archivedAt === null) mirror(record.sessionId, true);
  try { transport.setListener?.(onEvent); } catch {}
  return handle;
}

module.exports = {
  createGoalController, reportCommandFor, shellQuote, NEXT_RUN_DELAY_MS, MISSING_REPORT_LIMIT,
  REPEAT_EVIDENCE_LIMIT, CONTINUE_STOP_REASON
};