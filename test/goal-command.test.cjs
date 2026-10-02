'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createGoalController } = require('../src/runtime/goal-state.cjs');
const store = require('../src/runtime/goal-store.cjs');
const reportCli = require('../src/runtime/goal-report.cjs');
const { parseGoalCommand, withGoalCommand } = require('../src/runtime/goal-continue.cjs');

const REPORT_CLI = path.resolve(__dirname, '../src/runtime/goal-report.cjs');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = value => [{ type: 'text', text: value }];

// ---- transport ----

function transportFixture() {
  const api = { registerConnection() { return { dispose() {} }; } };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/runtime/goal-continue.cjs'), 'utf8');
  vm.runInNewContext(source, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      return { createRequire: () => () => ({ windsurfAcp: api, CancellationToken: { None: Symbol('None') } }) };
    }
  }, { filename: 'goal-continue.cjs' });
  const handle = module.exports.installGoalContinue({ nativeMainPath: NATIVE_MAIN, isEnabled: () => true });
  const c = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 2, sent: [], forwards: [],
    sendRequest(request) { this.sent.push(request); return Promise.resolve({}); },
    forwardClientRequest(request) { this.forwards.push(request); return 'fwd'; },
    setStatus() {}
  };
  api.registerConnection(c);
  return { handle, c };
}
const update = (sessionId, body) => ({ method: 'session/update', params: { sessionId, update: body } });

test('parseGoalCommand recognises /goal forms and ignores other prompts', () => {
  assert.deepEqual(parseGoalCommand(text('/goal')), { action: 'status', text: '' });
  assert.deepEqual(parseGoalCommand(text('  /goal  ')), { action: 'status', text: '' });
  assert.deepEqual(parseGoalCommand(text('/goal pause')), { action: 'pause', text: '' });
  assert.deepEqual(parseGoalCommand(text('/goal RESUME')), { action: 'resume', text: '' });
  assert.deepEqual(parseGoalCommand(text('/goal clear')), { action: 'clear', text: '' });
  assert.deepEqual(parseGoalCommand(text('/goal 让 test/auth 全部通过\n并保持 lint 干净')), { action: 'start', text: '让 test/auth 全部通过\n并保持 lint 干净' });
  assert.deepEqual(parseGoalCommand([{ type: 'text', text: '/goal ' }, { type: 'text', text: 'fix it' }]), { action: 'start', text: 'fix it' });
  assert.equal(parseGoalCommand(text('/goals list')), null);
  assert.equal(parseGoalCommand(text('please /goal this')), null);
  assert.equal(parseGoalCommand([{ type: 'text', text: '/goal x' }, { type: 'image', data: '' }]), null);
  assert.equal(parseGoalCommand(undefined), null);
});

test('the goal command is appended to the native command list once', () => {
  const message = update('s1', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'skills', description: 'd' }] });
  const next = withGoalCommand(message);
  assert.deepEqual(next.params.update.availableCommands.map(c => c.name), ['skills', 'goal']);
  assert.equal(message.params.update.availableCommands.length, 1, 'original message is not mutated');
  assert.equal(withGoalCommand(next), next);
  const other = update('s1', { sessionUpdate: 'agent_message_chunk' });
  assert.equal(withGoalCommand(other), other);
});

test('forwarded command lists include /goal', () => {
  const { handle, c } = transportFixture();
  try {
    c.forwardClientRequest(update('s1', { sessionUpdate: 'available_commands_update', availableCommands: [] }));
    assert.deepEqual(JSON.parse(JSON.stringify(c.forwards[0].params.update.availableCommands.map(x => x.name))), ['goal']);
  } finally { handle.dispose(); }
});

test('a /goal prompt is rewritten into the goal run and tracked without a manual-prompt interrupt', async () => {
  const { handle, c } = transportFixture();
  try {
    const events = [], calls = [];
    handle.setListener(event => events.push(event));
    handle.setCommandHandler(call => { calls.push(call); handle.setGoalOwned(call.sessionId, true); return { prompt: 'GOAL PROMPT', runId: 'run-1' }; });
    await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
    await c.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: text('/goal ship it'), _meta: { keep: 1 } } });
    assert.deepEqual(calls.map(x => [x.sessionId, x.action, x.text, x.ambiguous, x.connected]), [['s1', 'start', 'ship it', false, true]]);
    const sent = c.sent.at(-1);
    assert.deepEqual(JSON.parse(JSON.stringify(sent.params)), { sessionId: 's1', prompt: text('GOAL PROMPT'), _meta: { keep: 1 } });
    assert.equal(events.some(e => e.type === 'user-prompt'), false);
    c.forwardClientRequest(update('s1', { sessionUpdate: 'state_update', state: 'running' }));
    c.forwardClientRequest(update('s1', { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }));
    assert.deepEqual([...events.filter(e => e.type === 'idle').map(e => e.runId)], ['run-1']);
  } finally { handle.dispose(); }
});

test('ordinary prompts and unhandled commands pass through untouched', async () => {
  const { handle, c } = transportFixture();
  try {
    const events = [];
    handle.setListener(event => events.push(event));
    handle.setCommandHandler(() => null);
    const plain = { method: 'session/prompt', params: { sessionId: 's1', prompt: text('hello') } };
    await c.sendRequest(plain);
    assert.equal(c.sent.at(-1), plain);
    const command = { method: 'session/prompt', params: { sessionId: 's1', prompt: text('/goal x') } };
    await c.sendRequest(command);
    assert.equal(c.sent.at(-1), command);
    assert.equal(events.filter(e => e.type === 'user-prompt').length, 2);
  } finally { handle.dispose(); }
});

test('a user turn ending on a goal-owned session reports user-idle', async () => {
  const { handle, c } = transportFixture();
  try {
    const events = [];
    handle.setListener(event => events.push(event));
    await c.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: text('answer') } });
    handle.setGoalOwned('s1', true);
    c.forwardClientRequest(update('s1', { sessionUpdate: 'state_update', state: 'running' }));
    c.forwardClientRequest(update('s1', { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }));
    c.forwardClientRequest(update('s2', { sessionUpdate: 'state_update', state: 'idle' }));
    assert.deepEqual([...events.filter(e => e.type === 'user-idle').map(e => e.sessionId)], ['s1']);
  } finally { handle.dispose(); }
});

// ---- controller ----

function fakeScheduler() {
  let current = 0, nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) { const id = nextId++; timers.set(id, { fn, at: current + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers.entries()].filter(([, t]) => t.at <= current)) {
        if (timers.has(id)) { timers.delete(id); timer.fn(); }
      }
    }
  };
}
function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scheduler = fakeScheduler();
  const listeners = [], dispatched = [], owned = new Map(), sessions = new Map();
  let handler = null;
  const transport = {
    dispatch(request) { dispatched.push(request); return { ok: true, runId: request.runId }; },
    cancel() { return { ok: true }; },
    sessions: () => [...sessions.entries()].map(([sessionId, status]) => ({ sessionId, status })),
    sessionStatus: sessionId => sessions.get(sessionId) || 'unknown',
    setListener(listener) { listeners.push(listener); },
    setCommandHandler(next) { handler = next; },
    setGoalOwned(sessionId, value) { owned.set(sessionId, value); }
  };
  const controller = createGoalController({
    root, transport, owner: crypto.randomBytes(16).toString('hex'), scheduler, reportCliPath: REPORT_CLI,
    nextRunDelayMs: 1500, now: () => 1700000000000
  });
  t.after(() => controller.dispose());
  const command = (action, value = '', sessionId = 's1') => handler({ sessionId, action, text: value, ambiguous: false, connected: true });
  const goal = () => controller.snapshot().goals[0];
  const tokenFor = run => {
    const dir = store.capabilitiesDirectory(root);
    const name = fs.readdirSync(dir).find(entry => JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')).runId === run);
    return name.replace(/\.json$/, '');
  };
  return {
    root, scheduler, controller, dispatched, owned, sessions, command, goal,
    emit: event => { for (const listener of listeners) listener(event); },
    finishRun: (status, evidence = 'did things') => {
      const run = goal().activeRun;
      const result = reportCli.submit({ store: root, token: tokenFor(run), status, evidence });
      assert.equal(result.ok, true, JSON.stringify(result));
      for (const listener of listeners) listener({ type: 'idle', sessionId: 's1', runId: run, stopReason: 'end_turn' });
    }
  };
}

test('the controller registers itself as the command handler', t => {
  const h = harness(t);
  assert.equal(typeof h.command, 'function');
  assert.match(h.command('status').prompt, /当前没有目标/);
});

test('/goal <text> starts a goal on the current session without any session picking or idle check', t => {
  const h = harness(t);
  const action = h.command('start', '让测试全部通过');
  assert.equal(typeof action.runId, 'string');
  assert.match(action.prompt, /Fusion BYOK Goal mode is active/);
  assert.match(action.prompt, /让测试全部通过/);
  assert.match(action.prompt, /"complete"/);
  assert.equal(action.prompt.includes('acceptanceCriteria'), false);
  assert.equal(h.dispatched.length, 0, 'the user prompt itself carries the first run');
  const goal = h.goal();
  assert.equal(goal.sessionId, 's1');
  assert.equal(goal.status, 'active');
  assert.equal(goal.activeRun, action.runId);
  assert.equal(goal.runsStarted, 1);
  assert.equal(goal.maxRuns, store.DEFAULT_MAX_RUNS);
  assert.equal(h.owned.get('s1'), true);
});

test('a progress report continues automatically and a complete report ends and archives the goal', t => {
  const h = harness(t);
  h.command('start', 'ship it');
  h.sessions.set('s1', 'idle');
  h.finishRun('progress', 'step one done');
  h.scheduler.advance(1500);
  return tick().then(() => {
    assert.equal(h.dispatched.length, 1);
    assert.equal(h.goal().runsStarted, 2);
    h.finishRun('complete', 'all tests pass: 12/12');
    assert.equal(h.controller.snapshot().goals.length, 0);
    const history = h.controller.snapshot().history;
    assert.equal(history[0].status, 'completed');
    assert.equal(history[0].reason, 'achieved');
    assert.equal(h.owned.get('s1'), false);
    assert.match(h.command('status').prompt, /上一个目标：ship it（已完成）/);
  });
});

test('/goal status, pause, resume and clear manage the current goal', t => {
  const h = harness(t);
  h.command('start', 'ship it');
  assert.match(h.command('status').prompt, /目标：ship it[\s\S]*进行中[\s\S]*1 \/ 10/);
  const paused = h.command('pause');
  assert.equal(paused.runId, undefined);
  assert.match(paused.prompt, /已暂停/);
  assert.equal(h.goal().status, 'paused');
  const resumed = h.command('resume');
  assert.equal(typeof resumed.runId, 'string');
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().runsStarted, 2);
  assert.match(h.command('clear').prompt, /目标已清除：ship it/);
  assert.equal(h.controller.snapshot().goals.length, 0);
  assert.match(h.command('pause').prompt, /当前没有目标/);
  assert.match(h.command('resume').prompt, /当前没有目标/);
});

test('a new /goal replaces the existing goal on the same session', t => {
  const h = harness(t);
  h.command('start', 'first');
  const second = h.command('start', 'second');
  assert.equal(typeof second.runId, 'string');
  const snapshot = h.controller.snapshot();
  assert.deepEqual(snapshot.goals.map(g => g.objective), ['second']);
  assert.deepEqual(snapshot.history.map(g => g.objective), ['first']);
});

test('resume after the run limit grants another default batch of runs', t => {
  const h = harness(t);
  h.command('start', 'long task');
  const record = store.readGoalById(h.root, h.goal().id);
  store.writeGoal(h.root, { ...record, status: 'limited', reason: 'max-runs', activeRun: null, runsStarted: 10 });
  const resumed = h.command('resume');
  assert.equal(typeof resumed.runId, 'string');
  assert.equal(h.goal().maxRuns, 20);
  assert.equal(h.goal().runsStarted, 11);
});

test('a manual prompt pauses the goal and the goal resumes by itself once that turn ends', async t => {
  const h = harness(t);
  h.command('start', 'ship it');
  h.sessions.set('s1', 'idle');
  h.finishRun('progress', 'step one');
  h.emit({ type: 'user-prompt', sessionId: 's1' });
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().reason, 'manual-prompt');
  h.emit({ type: 'user-idle', sessionId: 's1' });
  assert.equal(h.goal().status, 'active');
  h.scheduler.advance(1500);
  await tick();
  assert.equal(h.dispatched.length, 1);
});

test('a waiting goal resumes after the user answers, but a user pause does not', async t => {
  const h = harness(t);
  h.command('start', 'ship it');
  h.sessions.set('s1', 'idle');
  h.finishRun('waiting', 'need the API key name');
  assert.equal(h.goal().status, 'waiting');
  h.emit({ type: 'user-idle', sessionId: 's1' });
  assert.equal(h.goal().status, 'active');
  h.command('pause');
  h.emit({ type: 'user-idle', sessionId: 's1' });
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().reason, 'user-paused');
});

test('command errors are answered as text instead of breaking the prompt', t => {
  const h = harness(t);
  const reply = h.command('start', '   ');
  assert.equal(reply.runId, undefined);
  assert.match(reply.prompt, /\/goal 没有执行/);
  const ambiguous = h.controller.handleCommand({ sessionId: 's1', action: 'start', text: 'x', ambiguous: true, connected: false });
  assert.match(ambiguous.prompt, /多个窗口/);
  assert.equal(h.controller.snapshot().goals.length, 0);
});
