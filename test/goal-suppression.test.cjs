'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-continue.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const TIMEOUT = { timeout: 2000 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const api = { registerConnection() { return { dispose() {} }; } };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      assert.equal(name, 'node:module');
      return { createRequire: () => modName => { assert.equal(modName, 'vscode'); return { windsurfAcp: api, CancellationToken: { None: Symbol('None') } }; } };
    }
  }, { filename: 'auto-continue.cjs' });
  return { api, install: options => module.exports.installAutoContinue({ nativeMainPath: NATIVE_MAIN, ...options }) };
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

function harness(suppressed) {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true }),
    isSessionSuppressed: sessionId => suppressed.get(sessionId) === true,
    scheduler
  });
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1, calls: [],
    sendRequest(request) { this.calls.push(request); return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  return { scheduler, handle, connector, prompts: () => connector.calls.filter(call => call.method === 'session/prompt').length };
}

const providerError = sessionId => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed.' } } }
});
const plan = sessionId => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending' }] } }
});

test('a goal-owned session never receives a provider-error continuation', TIMEOUT, async t => {
  const h = harness(new Map([['s1', true]]));
  t.after(() => h.handle.dispose());
  h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } });
  h.connector.forwardClientRequest(providerError('s1'));
  await tick();
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.prompts(), 1);
});

test('a goal-owned session never receives a plan continuation', TIMEOUT, async t => {
  const h = harness(new Map([['s1', true]]));
  t.after(() => h.handle.dispose());
  h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } });
  h.connector.forwardClientRequest(plan('s1'));
  await tick();
  assert.equal(h.scheduler.pending(), 0);
  assert.equal(h.prompts(), 1);
});

test('a suppressed prompt returns the original promise unchanged', TIMEOUT, async t => {
  const h = harness(new Map([['s1', true]]));
  t.after(() => h.handle.dispose());
  const original = Promise.resolve({ stopReason: 'end_turn' });
  h.connector.sendRequest = function () { return original; };
  const result = h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
  assert.equal(result, original);
  assert.equal(h.scheduler.pending(), 0);
});

test('leaving the suppressed state does not resurrect a cancelled timer', TIMEOUT, async t => {
  const suppressed = new Map([['s1', true]]);
  const h = harness(suppressed);
  t.after(() => h.handle.dispose());
  h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } });
  h.connector.forwardClientRequest(providerError('s1'));
  await tick();
  suppressed.set('s1', false);
  h.scheduler.advance(60000);
  assert.equal(h.prompts(), 1);
});

test('a throwing suppression checker fails closed and never continues', TIMEOUT, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true }),
    isSessionSuppressed: () => { throw new Error('store unreadable'); },
    scheduler
  });
  t.after(() => handle.dispose());
  const calls = [];
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sendRequest(request) { calls.push(request); return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
  connector.forwardClientRequest(providerError('s1'));
  await tick();
  assert.equal(scheduler.pending(), 0);
  assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1);
});

test('cancelSession clears a pending legacy continuation for exactly one session', TIMEOUT, async t => {
  const h = harness(new Map());
  t.after(() => h.handle.dispose());
  h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a', prompt: [] } });
  h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'b', prompt: [] } });
  h.connector.forwardClientRequest(providerError('a'));
  h.connector.forwardClientRequest(providerError('b'));
  await tick();
  assert.equal(h.scheduler.pending(), 2);
  assert.equal(h.handle.cancelSession('a'), true);
  assert.equal(h.scheduler.pending(), 1);
  assert.equal(h.handle.cancelSession('missing'), false);
  h.handle.reset();
  assert.equal(h.scheduler.pending(), 0);
});

test('unsuppressed sessions keep the existing legacy continuation behaviour', TIMEOUT, async t => {
  const h = harness(new Map());
  t.after(() => h.handle.dispose());
  h.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
  h.connector.forwardClientRequest(providerError('s1'));
  await tick();
  assert.equal(h.scheduler.pending(), 1);
  h.scheduler.advance(2000);
  assert.equal(h.prompts(), 2);
  h.handle.reset();
  assert.equal(h.scheduler.pending(), 0);
});