'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGoalController } = require('../src/runtime/goal-state.cjs');
const store = require('../src/runtime/goal-store.cjs');
const reportCli = require('../src/runtime/goal-report.cjs');

const REPORT_CLI = path.resolve(__dirname, '../src/runtime/goal-report.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeScheduler() {
  let current = 0, nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) { const id = nextId++; timers.set(id, { fn, at: current + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers.entries()].filter(([, t]) => t.at <= current).sort((a, b) => a[1].at - b[1].at)) {
        if (timers.has(id)) { timers.delete(id); timer.fn(); }
      }
    },
    pending() { return timers.size; }
  };
}

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scheduler = fakeScheduler();
  const listeners = [], dispatched = [], cancelled = [], logs = [];
  const sessions = new Map();
  let enabled = true, trusted = true;
  const transport = {
    dispatch(request) { dispatched.push(request); return { ok: true, runId: request.runId }; },
    cancel(sessionId) { cancelled.push(sessionId); return { ok: true }; },
    sessions: () => [...sessions.entries()].map(([sessionId, status]) => ({ sessionId, status })),
    sessionStatus: sessionId => sessions.get(sessionId) || 'unknown',
    setListener(listener) { listeners.push(listener); },
    setGoalOwned(sessionId, owned) { if (owned && !sessions.has(sessionId)) sessions.set(sessionId, 'idle'); }
  };
  const controller = createGoalController({
    root, transport, owner: crypto.randomBytes(16).toString('hex'), scheduler, reportCliPath: REPORT_CLI,
    isEnabled: () => enabled, isTrusted: () => trusted, log: (event, data) => logs.push({ event, data }),
    nextRunDelayMs: 1500, now: () => 1700000000000, ...options
  });
  t.after(() => controller.dispose());
  return {
    root, scheduler, controller, logs, dispatched, cancelled, sessions,
    emit: event => { for (const listener of listeners) listener(event); },
    setEnabled: value => { enabled = value; },
    setTrusted: value => { trusted = value; },
    report: (token, payload) => reportCli.submit({ store: root, token, ...payload }),
    tokenOf: () => {
      const run = controller.snapshot().goals[0].activeRun;
      const dir = store.capabilitiesDirectory(root);
      const name = fs.readdirSync(dir).find(entry => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')).runId === run; } catch { return false; }
      });
      return name.replace(/\.json$/, '');
    },
    goal: () => controller.snapshot().goals[0]
  };
}

async function started(t, options = {}) {
  const h = harness(t, options);
  h.sessions.set('session-1', 'idle');
  h.controller.start({ sessionId: 'session-1', objective: 'finish the feature', criteria: 'tests pass', maxRuns: options.maxRuns });
  await tick();
  return h;
}
const activeRun = h => h.goal().activeRun;

test('snapshot forwards session titles without changing session identifiers', t => {
  const h = harness(t, { transport: { dispatch() {}, cancel() {}, sessions: () => [{ sessionId: 's1', status: 'idle', title: '当前标题' }] } });
  assert.deepEqual(h.controller.snapshot().sessions, [{ sessionId: 's1', status: 'idle', title: '当前标题' }]);
});

test('kickoff dispatches once with the goal prompt and a fresh report token', async t => {
  const h = await started(t);
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.dispatched[0].sessionId, 'session-1');
  assert.equal(h.dispatched[0].revision, 2);
  assert.match(h.dispatched[0].prompt, /Fusion BYOK Goal mode is active/);
  assert.match(h.dispatched[0].prompt, /goal-report\.cjs/);
  assert.match(h.dispatched[0].prompt, /--store '/);
  assert.equal(h.goal().runsStarted, 1);
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().revision, 2);
  assert.match(h.tokenOf(), /^[a-f0-9]{64}$/);
});

test('progress report schedules the next run only after idle and rechecks revision', async t => {
  const h = await started(t);
  const run = activeRun(h);
  assert.equal(h.report(h.tokenOf(), { status: 'progress', evidence: 'first slice done' }).ok, true);
  h.emit({ sessionId: 'session-1', type: 'idle', runId: run, stopReason: 'end_turn' });
  assert.equal(h.scheduler.pending(), 1);
  assert.equal(h.dispatched.length, 1);
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.goal().runsStarted, 2);
  assert.equal(h.goal().revision, 3);
});

test('review stops the loop and only human acceptance completes the goal', async t => {
  const h = await started(t);
  const run = activeRun(h);
  h.report(h.tokenOf(), { status: 'review', evidence: 'criteria verified by running the suite' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: run, stopReason: 'end_turn' });
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.goal().status, 'review');
  assert.equal(h.goal().evidence.length, 1);
  const completed = h.controller.accept({ id: h.goal().id });
  assert.equal(completed.status, 'completed');
  assert.equal(h.scheduler.pending(), 0);
});

test('accept refuses a goal that is not in review, and pause refuses terminal states', async t => {
  const h = await started(t);
  assert.throws(() => h.controller.accept({ id: h.goal().id }), /待验收/);
  const id = h.goal().id;
  h.controller.pause({ id });
  assert.throws(() => h.controller.accept({ id }), /待验收/);
  h.controller.archive({ id });
  assert.throws(() => h.controller.pause({ id }), /已归档/);
  assert.throws(() => h.controller.accept({ id }), /待验收/);
});

test('a completed goal can still be archived, which frees the session for a new goal', async t => {
  const h = await started(t);
  const id = h.goal().id;
  h.report(h.tokenOf(), { status: 'review', evidence: 'criteria verified' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: h.goal().activeRun, stopReason: 'end_turn' });
  assert.equal(h.controller.accept({ id }).status, 'completed');
  const archived = h.controller.archive({ id });
  assert.equal(archived.archived, true);
  assert.equal(h.controller.snapshot().goals.length, 0);
  assert.equal(h.controller.snapshot().history.length, 1);
  h.sessions.set('session-1', 'idle');
  const fresh = h.controller.start({ sessionId: 'session-1', objective: 'second', criteria: 'again' });
  assert.equal(fresh.sessionId, 'session-1');
  assert.equal(h.controller.snapshot().goals.length, 1);
  assert.equal(h.controller.snapshot().history.length, 1);
});

test('re-archiving an old history goal is rejected and never touches the current record', async t => {
  const h = await started(t);
  const oldId = h.goal().id;
  h.controller.archive({ id: oldId });
  h.sessions.set('session-1', 'idle');
  const fresh = h.controller.start({ sessionId: 'session-1', objective: 'second', criteria: 'again' });
  const before = fs.readFileSync(store.goalFile(h.root, 'session-1'), 'utf8');
  assert.throws(() => h.controller.archive({ id: oldId }), /已经归档/);
  assert.equal(fs.readFileSync(store.goalFile(h.root, 'session-1'), 'utf8'), before);
  assert.equal(h.controller.snapshot().history.length, 1);
  assert.equal(h.controller.snapshot().history[0].id, oldId);
  assert.equal(h.controller.snapshot().goals[0].id, fresh.id);
});

test('archiving an active goal still cancels its owned run even when the archive write fails', async t => {
  const h = await started(t);
  const id = h.goal().id;
  const original = store.archiveGoal;
  store.archiveGoal = () => { throw new Error('goal_store_unwritable'); };
  try {
    assert.throws(() => h.controller.archive({ id }), /归档记录写入失败/);
  } finally { store.archiveGoal = original; }
  assert.deepEqual([...h.cancelled], ['session-1']);
  assert.equal(h.scheduler.pending(), 0);
  const onDisk = JSON.parse(fs.readFileSync(store.goalFile(h.root, 'session-1'), 'utf8'));
  assert.equal(onDisk.archivedAt, null, 'a failed archive leaves the record recoverable, not marked archived');
  assert.equal(h.controller.snapshot().goals.length, 1);
});

test('pause cancels the owned run even when the state write fails', async t => {
  const h = await started(t);
  const original = store.writeGoal;
  store.writeGoal = () => { throw new Error('goal_store_unwritable'); };
  try {
    assert.throws(() => h.controller.pause({ id: h.goal().id }), /写入失败/);
  } finally { store.writeGoal = original; }
  assert.deepEqual([...h.cancelled], ['session-1']);
});

test('pause of a goal with no owned running task never sends session/cancel', async t => {
  const h = await started(t);
  h.report(h.tokenOf(), { status: 'progress', evidence: 'slice' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: h.goal().activeRun, stopReason: 'end_turn' });
  const id = h.goal().id;
  h.controller.pause({ id });
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.cancelled.length, 0);
});

test('waiting and blocked reports stop the loop without completing', async t => {
  for (const status of ['waiting', 'blocked']) {
    const h = await started(t);
    const run = activeRun(h);
    h.report(h.tokenOf(), { status, evidence: 'need the user to provide credentials' });
    h.emit({ sessionId: 'session-1', type: 'idle', runId: run, stopReason: 'end_turn' });
    assert.equal(h.scheduler.pending(), 0);
    assert.equal(h.goal().status, status);
  }
});

test('a report from a stale run or revision is rejected', async t => {
  const h = await started(t);
  const token = h.tokenOf();
  const run = activeRun(h);
  h.emit({ sessionId: 'session-1', type: 'idle', runId: run, stopReason: 'end_turn' });
  assert.equal(h.report(token, { status: 'progress', evidence: 'late' }).ok, false);
});

test('two runs without any report pause the goal as missing-report, not success', async t => {
  const h = await started(t);
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: 'end_turn' });
  assert.equal(h.scheduler.pending(), 1);
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.dispatched.length, 2);
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: 'end_turn' });
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().reason, 'missing-report');
  assert.equal(h.scheduler.pending(), 0);
});

test('repeated identical evidence pauses after three progress reports', async t => {
  const h = await started(t, { maxRuns: 20 });
  for (let index = 0; index < 3; index++) {
    const run = activeRun(h);
    h.report(h.tokenOf(), { status: 'progress', evidence: 'still working on the same thing' });
    h.emit({ sessionId: 'session-1', type: 'idle', runId: run, stopReason: 'end_turn' });
    if (index < 2) { h.scheduler.advance(1500); await tick(); }
  }
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().reason, 'no-progress');
  assert.equal(h.goal().runsStarted, 3);
});

test('maxRuns counts dispatched prompts exactly, including the kickoff', async t => {
  const h = await started(t, { maxRuns: 2 });
  assert.equal(h.goal().runsStarted, 1);
  h.report(h.tokenOf(), { status: 'progress', evidence: 'one' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: 'end_turn' });
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.goal().runsStarted, 2);
  h.report(h.tokenOf(), { status: 'progress', evidence: 'two' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: 'end_turn' });
  assert.equal(h.goal().status, 'limited');
  assert.equal(h.goal().runsStarted, 2);
  assert.equal(h.scheduler.pending(), 0);
});

test('a cancelled or refused run pauses instead of looping', async t => {
  for (const stopReason of ['cancelled', 'refusal']) {
    const h = await started(t);
    h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason });
    assert.equal(h.goal().status, 'paused');
    assert.equal(h.goal().reason, stopReason);
  }
});

test('an unknown stop reason does not auto-continue', async t => {
  const h = await started(t);
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: null });
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.scheduler.pending(), 0);
});

test('pause cancels the timer, invalidates the run and its capability', async t => {
  const h = await started(t);
  h.controller.pause({ id: h.goal().id });
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().activeRun, null);
  assert.equal(fs.readdirSync(store.capabilitiesDirectory(h.root)).length, 0);
});

test('pause during an in-flight owned run sends session/cancel', async t => {
  const h = await started(t);
  h.controller.pause({ id: h.goal().id });
  assert.deepEqual([...h.cancelled], ['session-1']);
});

test('resume re-dispatches only from a known idle session', async t => {
  const h = await started(t);
  const id = h.goal().id;
  h.controller.pause({ id });
  h.sessions.set('session-1', 'busy');
  assert.throws(() => h.controller.resume({ id }), /空闲/);
  h.sessions.set('session-1', 'idle');
  const resumed = h.controller.resume({ id });
  assert.equal(resumed.status, 'active');
  await tick();
  assert.equal(h.dispatched.length, 2);
});

test('start requires a known idle session and refuses a second live goal', t => {
  const h = harness(t);
  assert.throws(() => h.controller.start({ sessionId: 'unknown', objective: 'o', criteria: 'c' }), /空闲/);
  h.sessions.set('session-1', 'idle');
  h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' });
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o2', criteria: 'c2' }), /已有进行中的目标/);
});

test('start validates objective, criteria and maxRuns bounds', t => {
  const h = harness(t);
  h.sessions.set('session-1', 'idle');
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: '', criteria: 'c' }), /目标描述/);
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: '  ' }), /验收标准/);
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c', maxRuns: 0 }), /运行上限/);
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c', maxRuns: 101 }), /运行上限/);
  assert.equal(h.controller.snapshot().goals.length, 0);
});

test('start and resume require enabled and trusted state', async t => {
  const h = harness(t);
  h.sessions.set('session-1', 'idle');
  h.setTrusted(false);
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' }), /未受信任/);
  h.setTrusted(true);
  h.setEnabled(false);
  assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' }), /先启用/);
  h.setEnabled(true);
  const goal = h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' });
  await tick();
  h.controller.pause({ id: goal.id });
  h.setEnabled(false);
  assert.throws(() => h.controller.resume({ id: goal.id }), /先启用/);
});

test('a manual user prompt invalidates the run and pauses the goal', async t => {
  const h = await started(t);
  h.emit({ sessionId: 'session-1', type: 'user-prompt' });
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().reason, 'manual-prompt');
  assert.equal(h.goal().activeRun, null);
  assert.equal(h.scheduler.pending(), 0);
});

test('permission and session-inactive interruptions pause the goal', async t => {
  for (const reason of ['permission', 'session-inactive']) {
    const h = await started(t);
    h.emit({ sessionId: 'session-1', type: 'interrupted', reason });
    assert.equal(h.goal().status, 'paused');
    assert.equal(h.scheduler.pending(), 0);
  }
});

test('disconnect pauses the goal for the affected session only', async t => {
  const h = harness(t);
  h.sessions.set('session-1', 'idle');
  h.sessions.set('session-2', 'idle');
  const one = h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' });
  const two = h.controller.start({ sessionId: 'session-2', objective: 'o', criteria: 'c' });
  await tick();
  h.emit({ sessionId: 'session-1', type: 'disconnect' });
  const goals = h.controller.snapshot().goals;
  assert.equal(goals.find(goal => goal.id === one.id).status, 'paused');
  assert.equal(goals.find(goal => goal.id === two.id).status, 'active');
});

test('an old run result cannot change a newer revision', async t => {
  const h = await started(t, { maxRuns: 20 });
  const firstRun = activeRun(h);
  h.report(h.tokenOf(), { status: 'progress', evidence: 'one' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: firstRun, stopReason: 'end_turn' });
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.goal().revision, 3);
  h.emit({ sessionId: 'session-1', type: 'idle', runId: firstRun, stopReason: 'end_turn' });
  assert.equal(h.goal().revision, 3);
  assert.equal(h.dispatched.length, 2);
});

test('an immediate pause after start prevents the deferred dispatch', async t => {
  const h = harness(t);
  h.sessions.set('session-1', 'idle');
  h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' });
  h.controller.pause({ id: h.controller.snapshot().goals[0].id });
  await tick();
  assert.equal(h.dispatched.length, 0);
});

test('reload restores paused state, keeps the record and never auto-resumes', async t => {
  const h = await started(t);
  const goal = h.goal();
  h.controller.dispose();
  const listeners = [];
  const second = createGoalController({
    root: h.root, owner: crypto.randomBytes(16).toString('hex'), scheduler: fakeScheduler(),
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: () => ({ ok: true }), cancel: () => ({ ok: true }), sessions: () => [],
      sessionStatus: () => 'idle', setListener: listener => listeners.push(listener), setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => second.dispose());
  const restored = second.snapshot().goals.find(item => item.id === goal.id);
  assert.equal(restored.status, 'paused');
  assert.equal(restored.archived, false);
  assert.equal(restored.activeRun, null);
  assert.equal(second.snapshot().pendingTimers, 0);
});

test('reload pauses a goal left active by a crashed controller', async t => {
  const h = await started(t);
  const goal = h.goal();
  h.controller.dispose();
  const owner = crypto.randomBytes(16).toString('hex');
  const record = JSON.parse(fs.readFileSync(store.goalFile(h.root, 'session-1'), 'utf8'));
  fs.writeFileSync(store.goalFile(h.root, 'session-1'), JSON.stringify({ ...record, status: 'active', reason: null, activeRun: crypto.randomUUID() }));
  fs.writeFileSync(store.lockFile(h.root, 'session-1'), JSON.stringify({ schemaVersion: 1, pid: 999999, ownerId: owner, sessionId: 'session-1', startedAt: 1 }));
  const second = createGoalController({
    root: h.root, owner, scheduler: fakeScheduler(),
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: () => ({ ok: true }), cancel: () => ({ ok: true }), sessions: () => [],
      sessionStatus: () => 'idle', setListener: () => {}, setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => second.dispose());
  const restored = second.snapshot().goals.find(item => item.id === goal.id);
  assert.equal(restored.status, 'paused');
  assert.equal(restored.reason, 'reloaded');
  assert.equal(restored.activeRun, null);
});

test('a goal whose lock is held by a live foreign controller is never mutated or reclaimed', async t => {
  const h = await started(t);
  const goal = h.goal();
  const foreignOwner = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(store.lockFile(h.root, 'session-1'), JSON.stringify({ schemaVersion: 1, pid: process.pid, ownerId: foreignOwner, sessionId: 'session-1', startedAt: 1 }));
  h.controller.dispose();
  const other = createGoalController({
    root: h.root, owner: crypto.randomBytes(16).toString('hex'), scheduler: fakeScheduler(),
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: () => ({ ok: true }), cancel: () => ({ ok: true }), sessions: () => [],
      sessionStatus: () => 'idle', setListener: () => {}, setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => other.dispose());
  const before = JSON.stringify(other.snapshot().goals.find(item => item.id === goal.id));
  assert.throws(() => other.pause({ id: goal.id }), /另一个窗口/);
  assert.throws(() => other.archive({ id: goal.id }), /另一个窗口/);
  assert.equal(JSON.stringify(other.snapshot().goals.find(item => item.id === goal.id)), before);
  assert.equal(store.readOwnership(h.root, 'session-1').ownerId, foreignOwner);
});

test('a lock-free review goal can be explicitly reclaimed by a human action after restart', async t => {
  const h = await started(t);
  const goal = h.goal();
  h.report(h.tokenOf(), { status: 'review', evidence: 'criteria verified' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: goal.activeRun, stopReason: 'end_turn' });
  h.controller.dispose();
  const second = createGoalController({
    root: h.root, owner: crypto.randomBytes(16).toString('hex'), scheduler: fakeScheduler(),
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: () => ({ ok: true }), cancel: () => ({ ok: true }), sessions: () => [],
      sessionStatus: () => 'idle', setListener: () => {}, setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => second.dispose());
  assert.equal(second.snapshot().goals.find(item => item.id === goal.id).locked, false);
  assert.equal(second.accept({ id: goal.id }).status, 'completed');
});

test('a lock-free paused goal can be reclaimed on resume after restart', async t => {
  const h = await started(t);
  const goal = h.goal();
  h.controller.pause({ id: goal.id });
  h.controller.dispose();
  const sessions = [{ sessionId: 'session-1', status: 'idle' }];
  const dispatched = [];
  const second = createGoalController({
    root: h.root, owner: crypto.randomBytes(16).toString('hex'), scheduler: fakeScheduler(),
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: request => { dispatched.push(request); return { ok: true, runId: request.runId }; },
      cancel: () => ({ ok: true }), sessions: () => sessions, sessionStatus: () => 'idle',
      setListener: () => {}, setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => second.dispose());
  second.resume({ id: goal.id });
  await tick();
  assert.equal(dispatched.length, 1);
  assert.equal(second.snapshot().goals.find(item => item.id === goal.id).status, 'active');
});

test('resume requires a higher explicit limit once the run budget is exhausted', async t => {
  const h = await started(t, { maxRuns: 1 });
  const goal = h.goal();
  h.report(h.tokenOf(), { status: 'progress', evidence: 'only run' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: goal.activeRun, stopReason: 'end_turn' });
  assert.equal(h.goal().status, 'limited');
  assert.throws(() => h.controller.resume({ id: goal.id }), /运行上限/);
  assert.throws(() => h.controller.resume({ id: goal.id, maxRuns: 1 }), /必须大于/);
  const resumed = h.controller.resume({ id: goal.id, maxRuns: 4 });
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.maxRuns, 4);
  await tick();
  assert.equal(h.dispatched.length, 2);
});

test('a second controller cannot take a session whose lock belongs to another controller', async t => {
  const h = await started(t);
  const foreignOwner = crypto.randomBytes(16).toString('hex');
  store.removeFile(store.goalFile(h.root, 'session-1'));
  fs.writeFileSync(store.lockFile(h.root, 'session-1'), JSON.stringify({ schemaVersion: 1, pid: process.pid, ownerId: foreignOwner, sessionId: 'session-1', startedAt: 1 }));
  const second = createGoalController({
    root: h.root, owner: crypto.randomBytes(16).toString('hex'), scheduler: fakeScheduler(),
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: () => ({ ok: true }), cancel: () => ({ ok: true }), sessions: () => [{ sessionId: 'session-1', status: 'idle' }],
      sessionStatus: () => 'idle', setListener: () => {}, setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => second.dispose());
  assert.throws(() => second.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' }), /占用/);
});

test('archive keeps immutable history, frees the active slot and releases ownership', async t => {
  const h = await started(t);
  const archived = h.controller.archive({ id: h.goal().id });
  assert.equal(archived.archived, true);
  assert.equal(fs.existsSync(store.goalFile(h.root, 'session-1')), false);
  const history = h.controller.snapshot().history;
  assert.equal(history.length, 1);
  assert.equal(history[0].archived, true);
  assert.equal(store.readOwnership(h.root, 'session-1'), null);
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.controller.ownsSession('session-1'), false);
  assert.equal(h.controller.snapshot().goals.length, 0);
});

test('an archived session can start a fresh goal while history is preserved', async t => {
  const h = await started(t);
  h.controller.archive({ id: h.goal().id });
  h.sessions.set('session-1', 'idle');
  const fresh = h.controller.start({ sessionId: 'session-1', objective: 'second objective', criteria: 'done again' });
  assert.equal(fresh.sessionId, 'session-1');
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.goals.length, 1);
  assert.equal(snapshot.history.length, 1);
  assert.notEqual(snapshot.goals[0].id, snapshot.history[0].id);
});

test('archiving an active goal cancels its in-flight run', async t => {
  const h = await started(t);
  h.controller.archive({ id: h.goal().id });
  assert.deepEqual([...h.cancelled], ['session-1']);
});

test('dispose pauses this controller own active goals and releases their locks', async t => {
  const h = await started(t);
  const goal = h.goal();
  h.controller.dispose();
  const record = JSON.parse(fs.readFileSync(store.goalFile(h.root, 'session-1'), 'utf8'));
  assert.equal(record.status, 'paused');
  assert.equal(record.activeRun, null);
  assert.equal(store.readOwnership(h.root, 'session-1'), null);
  assert.equal(h.controller.snapshot().goals.find(item => item.id === goal.id).status, 'paused');
});

test('a failed state write fails closed: no dispatch and no capability', t => {
  const h = harness(t);
  h.sessions.set('session-1', 'idle');
  const original = store.writeGoal;
  store.writeGoal = () => { throw new Error('goal_store_unwritable'); };
  try {
    assert.throws(() => h.controller.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' }), /写入失败/);
  } finally { store.writeGoal = original; }
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.controller.snapshot().goals.length, 0);
  assert.equal(store.readOwnership(h.root, 'session-1'), null);
});

test('a dispatch refusal pauses the goal instead of looping', async t => {
  const h = harness(t);
  h.sessions.set('session-1', 'idle');
  const failing = createGoalController({
    root: h.root, owner: crypto.randomBytes(16).toString('hex'), scheduler: h.scheduler,
    reportCliPath: REPORT_CLI, now: () => 1700000000000,
    transport: {
      dispatch: () => ({ ok: false, error: 'send-failed' }), cancel: () => ({ ok: true }),
      sessions: () => [{ sessionId: 'session-1', status: 'idle' }], sessionStatus: () => 'idle',
      setListener: () => {}, setGoalOwned: () => {}
    },
    isEnabled: () => true, isTrusted: () => true
  });
  t.after(() => failing.dispose());
  failing.start({ sessionId: 'session-1', objective: 'o', criteria: 'c' });
  await tick();
  assert.equal(failing.snapshot().goals[0].status, 'paused');
  assert.equal(failing.snapshot().goals[0].reason, 'dispatch-failed');
});

test('disabling during a pending next-run timer pauses instead of dispatching', async t => {
  const h = await started(t);
  h.report(h.tokenOf(), { status: 'progress', evidence: 'slice' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: 'end_turn' });
  h.setEnabled(false);
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.goal().status, 'paused');
});

test('a session that is no longer idle when the timer fires pauses the goal', async t => {
  const h = await started(t);
  h.report(h.tokenOf(), { status: 'progress', evidence: 'slice' });
  h.emit({ sessionId: 'session-1', type: 'idle', runId: activeRun(h), stopReason: 'end_turn' });
  h.sessions.set('session-1', 'busy');
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.goal().status, 'paused');
});

test('snapshot never exposes capability tokens or credential fields', async t => {
  const h = await started(t);
  assert.equal(JSON.stringify(h.controller.snapshot()).includes('capability'), false);
  assert.equal(fs.readFileSync(store.goalFile(h.root, 'session-1'), 'utf8').includes(h.tokenOf()), false);
});

test('report command quotes paths safely and carries no other goal secret', async t => {
  const h = await started(t);
  const prompt = h.dispatched[0].prompt;
  assert.match(prompt, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(prompt, /--capability '[a-f0-9]{64}'/);
  assert.match(prompt, /'{"status":"progress","evidence":"[^"]*"}'/);
});