'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createGoalController } = require('../src/runtime/goal-state.cjs');
const { installGoalContinue } = require('../src/runtime/goal-continue.cjs');
const store = require('../src/runtime/goal-store.cjs');
const reportCli = require('../src/runtime/goal-report.cjs');

const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const autoSource = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-continue.cjs'), 'utf8');
const goalSource = fs.readFileSync(path.join(__dirname, '../src/runtime/goal-continue.cjs'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function loadModule(source, filename, api) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      assert.equal(name, 'node:module');
      return { createRequire: () => () => ({ windsurfAcp: api, CancellationToken: { None: Symbol('None') } }) };
    }
  }, { filename });
  return module.exports;
}

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

function installAuto(scheduler, isSessionSuppressed, api) {
  const auto = loadModule(autoSource, 'auto-continue.cjs', api);
  return auto.installAutoContinue({
    nativeMainPath: NATIVE_MAIN, isEnabled: () => true, scheduler, isSessionSuppressed,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true })
  });
}

function integration(t, protocolVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scheduler = fakeScheduler();
  const sessions = new Map([['s1', 'idle']]);
  const api = { registerConnection() { return { dispose() {} }; } };
  const goal = loadModule(goalSource, 'goal-continue.cjs', api);
  const goalContinue = goal.installGoalContinue({ nativeMainPath: NATIVE_MAIN, isEnabled: () => true });
  const autoContinue = installAuto(scheduler, sessionId => goalContinue.hasActiveGoal(sessionId), api);
  const transport = {
    dispatch: request => goalContinue.dispatch(request),
    cancel: sessionId => goalContinue.cancel(sessionId),
    sessions: () => goalContinue.sessions(),
    sessionStatus: sessionId => goalContinue.sessionStatus(sessionId),
    setListener: listener => goalContinue.setListener(listener),
    setGoalOwned: (sessionId, owned) => goalContinue.setGoalOwned(sessionId, owned)
  };
  const controller = createGoalController({
    root, transport, owner: crypto.randomBytes(16).toString('hex'), scheduler,
    reportCliPath: path.resolve(__dirname, '../src/runtime/goal-report.cjs'), now: () => 1700000000000,
    nextRunDelayMs: 1500
  });
  t.after(() => { controller.dispose(); autoContinue.dispose(); goalContinue.dispose(); });
  const pendingPrompts = [];
  let failPrompts = false;
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion,
    sent: [], forwards: [], statuses: [],
    sendRequest(request) {
      this.sent.push(request);
      if (request.method !== 'session/prompt') return Promise.resolve({});
      if (failPrompts) return Promise.reject(new Error('Provider response could not be completed'));
      if (protocolVersion >= 2) return Promise.resolve({ acknowledgment: true });
      return new Promise(resolve => pendingPrompts.push(resolve));
    },
    forwardClientRequest(request) { this.forwards.push(request); return 'fwd'; },
    setStatus(status) { this.statuses.push(status); }
  };
  api.registerConnection(connector);
  const tokenOf = () => {
    const run = controller.snapshot().goals[0].activeRun;
    const dir = store.capabilitiesDirectory(root);
    const name = fs.readdirSync(dir).find(entry => JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')).runId === run);
    return name.replace(/\.json$/, '');
  };
  const idle = stopReason => connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle', ...(stopReason === undefined ? {} : { stopReason }) } } });
  const running = () => connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'running' } } });
  const providerError = () => connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed.' } } } });
  const finishPrompts = async () => {
    for (const resolve of pendingPrompts.splice(0)) resolve({ stopReason: 'end_turn' });
    await tick();
  };
  return {
    root, scheduler, controller, goalContinue, autoContinue, connector, sessions, api, tokenOf, idle, running, providerError, finishPrompts,
    failPrompts: value => { failPrompts = value; },
    prompts: () => connector.sent.filter(request => request.method === 'session/prompt').length,
    start: async () => {
      await connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
      idle();
      controller.start({ sessionId: 's1', objective: 'ship it', criteria: 'tests pass', maxRuns: 5 });
      await tick();
    }
  };
}

test('integration v1: kickoff, idle progress, review, human accept, with no duplicate sends', { timeout: 5000 }, async t => {
  const h = integration(t, 1);
  await h.start();
  assert.equal(h.prompts(), 1);
  const firstRun = h.controller.snapshot().goals[0].activeRun;
  assert.equal(reportCli.submit({ store: h.root, token: h.tokenOf(), status: 'progress', evidence: 'first slice' }).ok, true);
  await h.finishPrompts();
  h.idle('end_turn');
  await tick();
  assert.equal(h.scheduler.pending(), 1);
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.prompts(), 2);
  assert.equal(h.controller.snapshot().goals[0].activeRun !== firstRun, true);
  assert.equal(reportCli.submit({ store: h.root, token: h.tokenOf(), status: 'review', evidence: 'all criteria verified' }).ok, true);
  await h.finishPrompts();
  h.idle('end_turn');
  await tick();
  assert.equal(h.controller.snapshot().goals[0].status, 'review');
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.controller.accept({ id: h.controller.snapshot().goals[0].id }).status, 'completed');
  assert.equal(h.prompts(), 2);
});

test('integration v2: running then idle drives progress and review', { timeout: 5000 }, async t => {
  const h = integration(t, 2);
  await h.start();
  assert.equal(h.prompts(), 1);
  h.running();
  assert.equal(h.goalContinue.sessionStatus('s1'), 'busy');
  assert.equal(reportCli.submit({ store: h.root, token: h.tokenOf(), status: 'progress', evidence: 'v2 slice' }).ok, true);
  h.idle('end_turn');
  await tick();
  assert.equal(h.scheduler.pending(), 1);
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.prompts(), 2);
  h.running();
  assert.equal(reportCli.submit({ store: h.root, token: h.tokenOf(), status: 'review', evidence: 'v2 criteria verified' }).ok, true);
  h.idle('end_turn');
  await tick();
  assert.equal(h.controller.snapshot().goals[0].status, 'review');
  assert.equal(h.scheduler.pending(), 0);
});

test('integration: legacy continuation is suppressed while a goal owns the session', { timeout: 5000 }, async t => {
  const h = integration(t, 1);
  await h.start();
  h.providerError();
  await tick();
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.prompts(), 1);
});

test('integration: pause cancels the owned run and stops the timer', { timeout: 5000 }, async t => {
  const h = integration(t, 1);
  await h.start();
  h.controller.pause({ id: h.controller.snapshot().goals[0].id });
  await tick();
  await h.finishPrompts();
  assert.equal(h.connector.sent.some(request => request.method === 'session/cancel'), true);
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.controller.snapshot().goals[0].status, 'paused');
});

test('integration: disable suspends the goal, re-enable keeps it paused until explicit resume', { timeout: 5000 }, async t => {
  const h = integration(t, 1);
  await h.start();
  const paused = h.controller.suspend({ reason: 'disabled' });
  await tick();
  assert.equal(paused, 1);
  assert.equal(h.controller.snapshot().goals[0].status, 'paused');
  assert.equal(h.scheduler.pending(), 0);
  h.idle();
  h.sessions.set('s1', 'idle');
  const resumed = h.controller.resume({ id: h.controller.snapshot().goals[0].id });
  await tick();
  assert.equal(resumed.status, 'active');
  assert.equal(h.prompts(), 2);
  await h.finishPrompts();
});

test('integration: a rejected Goal dispatch through the wrapped connector pauses the goal without hanging', { timeout: 5000 }, async t => {
  const h = integration(t, 1);
  await h.connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  h.idle();
  h.failPrompts(true);
  h.controller.start({ sessionId: 's1', objective: 'ship it', criteria: 'tests pass', maxRuns: 5 });
  await tick();
  await tick();
  const goal = h.controller.snapshot().goals[0];
  assert.equal(goal.status, 'paused');
  assert.equal(goal.reason, 'send-failed', 'the wrapped connector rejection pauses the goal via its send-failure interrupt');
  assert.equal(goal.activeRun, null);
  assert.equal(h.scheduler.pending(), 0, 'the legacy wrapper leaves no pending timer');
  assert.equal(h.prompts(), 1, 'the wrapped connector saw exactly one Goal prompt attempt');
  h.scheduler.advance(60000);
  await tick();
  assert.equal(h.prompts(), 1, 'no retry is scheduled after a rejected Goal dispatch');
  await h.finishPrompts();
});