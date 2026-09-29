'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/goal-continue.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';

function fixture() {
  const logs = [];
  const api = { registerConnection() { return { dispose() {} }; } };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      assert.equal(name, 'node:module');
      return {
        createRequire: () => modName => {
          assert.equal(modName, 'vscode');
          return { windsurfAcp: api, CancellationToken: { None: Symbol('None') } };
        }
      };
    }
  }, { filename: 'goal-continue.cjs' });
  return { api, logs, install: options => module.exports.installGoalContinue({ nativeMainPath: NATIVE_MAIN, log: (e, d) => logs.push({ e, d }), ...options }) };
}
function connector(overrides = {}) {
  return {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 2,
    sent: [], forwards: [], statuses: [],
    sendRequest(request) { this.sent.push(request); return Promise.resolve({}); },
    forwardClientRequest(request) { this.forwards.push(request); return 'fwd'; },
    setStatus(status) { this.statuses.push(status); },
    ...overrides
  };
}
const ids = entries => Array.from(entries, entry => entry.sessionId).sort();
const tick = () => new Promise(resolve => setImmediate(resolve));
const idle = (sessionId, extra = {}) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'state_update', state: 'idle', ...extra } }
});
const running = sessionId => ({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'state_update', state: 'running' } } });

test('sessions are discovered from new/load/resume and from outgoing prompts', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const a = connector(), b = connector(), c = connector({ sendRequest(request) { this.sent.push(request); return Promise.resolve({ sessionId: 'resumed' }); } });
  f.api.registerConnection(a); f.api.registerConnection(b); f.api.registerConnection(c);

  await a.sendRequest({ method: 'session/new', params: { sessionId: 'created' } });
  await b.sendRequest({ method: 'session/load', params: { sessionId: 'loaded' } });
  await c.sendRequest({ method: 'session/resume', params: {} });

  assert.deepEqual(ids(handle.sessions()), ['created', 'loaded', 'resumed']);
  await a.sendRequest({ method: 'session/prompt', params: { sessionId: 'prompted' } });
  assert.ok(handle.sessions().some(s => s.sessionId === 'prompted'));
});

test('session titles follow metadata without changing readiness or accepting subagent titles', t => {
  const f = fixture(), handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const c = connector();
  f.api.registerConnection(c);
  const update = (title, extra = {}) => c.forwardClientRequest({ method: 'session/update', params: {
    sessionId: 's1', update: { sessionUpdate: 'session_info_update', title, ...extra }
  } });
  update(' 标题一 ');
  assert.equal(handle.sessions()[0].title, '标题一');
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  c.forwardClientRequest(running('s1'));
  update('标题二');
  assert.equal(handle.sessions()[0].title, '标题二');
  assert.equal(handle.sessionStatus('s1'), 'busy');
  for (const title of [undefined, null, 42]) update(title);
  update('子会话', { _meta: { 'cognition.ai/subagent_context': { id: 'child' } } });
  assert.equal(handle.sessions()[0].title, '标题二');
  update('a\nb');
  assert.equal(handle.sessions()[0].title, 'a b');
  update('x'.repeat(600));
  assert.equal(handle.sessions()[0].title.length, 512);
  update(' ');
  assert.equal(handle.sessions()[0].title, undefined);
  update('主会话');
  const other = connector();
  f.api.registerConnection(other);
  other.forwardClientRequest(idle('s1'));
  update('有歧义');
  assert.equal(handle.sessions()[0].title, undefined);
});

test('foreign connectors, cloud locations and non-bundled agents are ignored', t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const cloud = connector({ location: { kind: 'cloud' } });
  const foreign = connector({ agentId: 'other' });
  const notBundled = connector({ bundled: false });
  for (const item of [cloud, foreign, notBundled]) f.api.registerConnection(item);
  assert.equal(handle.status().connections, 0);
  assert.equal(handle.sessions().length, 0);
});

test('idle after a dispatched run consumes the run exactly once', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const events = [];
  handle.setListener(event => events.push(event));
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  assert.equal(handle.sessionStatus('s1'), 'idle');

  handle.setGoalOwned('s1', true);
  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'run-1', revision: 2, prompt: 'work', runsStarted: 1 }).ok, true);
  assert.equal(handle.sessionStatus('s1'), 'busy');
  const prompt = c.sent.at(-1);
  assert.equal(prompt.method, 'session/prompt');
  assert.equal(typeof prompt.params._meta['cognition.ai/clientMessageId'], 'string');
  assert.equal(prompt.params.prompt[0].text.includes('run-1'), false);
  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'run-2', revision: 3, prompt: 'again' }).error, 'run-in-flight');

  c.forwardClientRequest(running('s1'));
  c.forwardClientRequest(idle('s1', { stopReason: 'end_turn' }));
  c.forwardClientRequest(idle('s1', { stopReason: 'end_turn' }));
  assert.deepEqual(JSON.parse(JSON.stringify(events.filter(e => e.type === 'idle'))), [{ sessionId: 's1', type: 'idle', runId: 'run-1', stopReason: 'end_turn' }]);
});

test('a dispatch mirrors a synthetic user message without leaking the capability token', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  handle.setGoalOwned('s1', true);
  handle.dispatch({ sessionId: 's1', runId: 'run-1', revision: 2, prompt: 'secret-token-inside', runsStarted: 4 });
  const synthetic = c.forwards.find(entry => entry.params?.update?.sessionUpdate === 'user_message');
  assert.ok(synthetic);
  assert.match(synthetic.params.update.content[0].text, /Goal 自动推进（第 4 次运行）/);
  assert.equal(synthetic.params.update.content[0].text.includes('secret-token-inside'), false);
  assert.equal(typeof synthetic.params.update._meta['cognition.ai/clientMessageId'], 'string');
});

test('a stale v2 idle with no running state cannot consume a later run', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const events = [];
  handle.setListener(event => events.push(event));
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  handle.setGoalOwned('s1', true);
  handle.dispatch({ sessionId: 's1', runId: 'run-1', revision: 2, prompt: 'p', runsStarted: 1 });
  c.forwardClientRequest(idle('s1', { stopReason: 'end_turn' }));
  assert.equal(events.filter(e => e.type === 'idle').length, 0);
});

test('a caller cannot mark its own request as goal-dispatched through message metadata', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const events = [];
  handle.setListener(event => events.push(event));
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  await c.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', _meta: { 'cognition.ai/goalRun': 'forged' } } });
  c.forwardClientRequest(idle('s1', { stopReason: 'end_turn' }));
  assert.equal(events.filter(e => e.type === 'idle').length, 0);
  assert.equal(events.filter(e => e.type === 'user-prompt').length, 1);
});

test('dispatch refuses disabled, not-owner, unknown, busy and ambiguous sessions', async t => {
  const f = fixture();
  let enabled = true;
  const handle = f.install({ isEnabled: () => enabled });
  t.after(() => handle.dispose());
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));

  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'r1', revision: 2, prompt: 'p' }).error, 'not-owner');
  handle.setGoalOwned('s1', true);
  handle.setGoalOwned('nope', true);
  assert.equal(handle.dispatch({ sessionId: 'nope', runId: 'r1', revision: 2, prompt: 'p' }).error, 'unknown-session');
  c.forwardClientRequest(running('s1'));
  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'r1', revision: 2, prompt: 'p' }).error, 'busy-session');
  c.forwardClientRequest(idle('s1'));
  enabled = false;
  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'r1', revision: 2, prompt: 'p' }).error, 'disabled');
  enabled = true;
  const second = connector();
  f.api.registerConnection(second);
  second.forwardClientRequest(idle('s1'));
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'r1', revision: 2, prompt: 'p' }).error, 'ambiguous-session');
});

test('v1 prompt resolves to idle with the returned stop reason', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const events = [];
  handle.setListener(event => events.push(event));
  const c = connector({ protocolVersion: 1, sendRequest(request) { this.sent.push(request); return Promise.resolve({ stopReason: 'end_turn' }); } });
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  handle.setGoalOwned('s1', true);
  handle.dispatch({ sessionId: 's1', runId: 'run-v1', revision: 2, prompt: 'p' });
  await tick();
  assert.equal(handle.sessionStatus('s1'), 'idle');
  assert.deepEqual(JSON.parse(JSON.stringify(events.filter(e => e.type === 'idle'))), [{ sessionId: 's1', type: 'idle', runId: 'run-v1', stopReason: 'end_turn' }]);
  c.forwardClientRequest(idle('s1'));
  assert.equal(events.filter(e => e.type === 'idle').length, 1);
});

test('manual prompts mark the session busy, then v1 idle, so it stays selectable', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const c = connector({ protocolVersion: 1 });
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  assert.equal(handle.sessionStatus('s1'), 'idle');
  await c.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } });
  assert.equal(handle.sessionStatus('s1'), 'idle');
});

test('permission, requires_action, reset methods and disconnect stop usability', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const events = [];
  handle.setListener(event => events.push(event));
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  c.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'requires_action' } } });
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  c.forwardClientRequest(idle('s1'));
  assert.equal(handle.sessionStatus('s1'), 'idle');
  c.forwardClientRequest({ method: 'session/request_permission', params: { sessionId: 's1' } });
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  c.forwardClientRequest(idle('s1'));
  await c.sendRequest({ method: 'session/cancel', params: { sessionId: 's1' } });
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  c.forwardClientRequest(idle('s1'));
  assert.equal(handle.sessionStatus('s1'), 'idle');
  c.setStatus('disconnected');
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  assert.ok(events.some(e => e.type === 'disconnect' && e.sessionId === 's1'));
});

test('subagent updates are ignored and detach notifies only matching sessions', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const events = [];
  handle.setListener(event => events.push(event));
  const c = connector();
  const registration = f.api.registerConnection(c);
  c.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle', _meta: { 'cognition.ai/subagent_context': { parentAgentId: 'p', runId: 'r' } } } } });
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  registration.dispose();
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  assert.ok(events.some(e => e.type === 'interrupted' && e.sessionId === 's1' && e.reason === 'detached'));
  assert.equal(handle.status().connections, 0);
});

test('cancel marks unknown without hiding the session from the registry', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  handle.setGoalOwned('s1', true);
  assert.equal(handle.dispatch({ sessionId: 's1', runId: 'run-cancel', revision: 2, prompt: 'p' }).ok, true);
  assert.equal(handle.cancel('s1', 'wrong-run').error, 'run-mismatch');
  assert.equal(handle.cancel('s1').ok, true);
  assert.equal(handle.sessionStatus('s1'), 'unknown');
  assert.deepEqual(ids(handle.sessions()), ['s1']);
  c.forwardClientRequest(idle('s1'));
  assert.equal(handle.sessionStatus('s1'), 'idle');
});

test('cancel refuses when no goal run is active so unrelated user work is never cancelled', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  const c = connector();
  f.api.registerConnection(c);
  await c.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  c.forwardClientRequest(idle('s1'));
  assert.equal(handle.cancel('s1').error, 'no-active-run');
  assert.equal(c.sent.some(request => request.method === 'session/cancel'), false);
});

test('goal ownership mirrors the controller and clearing it re-enables legacy suppression', async t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());
  assert.equal(handle.hasActiveGoal('s1'), false);
  handle.setGoalOwned('s1', true);
  assert.equal(handle.hasActiveGoal('s1'), true);
  handle.setGoalOwned('s1', false);
  assert.equal(handle.hasActiveGoal('s1'), false);
});

test('install is idempotent per api and dispose restores the original register', t => {
  const f = fixture();
  const original = f.api.registerConnection;
  const handle = f.install({ isEnabled: () => true });
  const wrapper = f.api.registerConnection;
  assert.equal(f.install({ isEnabled: () => true }), handle);
  assert.equal(f.api.registerConnection, wrapper);
  handle.dispose();
  assert.equal(handle.status().installed, false);
  assert.notEqual(f.api.registerConnection, wrapper);
  assert.equal(f.api.registerConnection, original);
});