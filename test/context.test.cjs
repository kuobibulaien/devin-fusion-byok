'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createContextState, usageRejectionReason } = require('../src/runtime/context-state.cjs');
const { contextDetails, contextScript, contextHtml, createContextUi } = require('../src/panel/context-view.cjs');
const update = (used = 20, size = 100, meta) => ({ sessionUpdate: 'usage_update', used, size, ...(meta ? { _meta: { 'cognition.ai/subagent_context': meta } } : {}) });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('context usage is session isolated, bounded, zero-aware and never substitutes subagent context', () => {
  const state = createContextState({ wallNow: () => 100, limit: 2 });
  state.observe('a', update(0));
  state.observe('a', update(40, 100, { parentAgentId: 'lead', runId: 'child' }));
  assert.equal(state.snapshot()[0].lead.used, 0);
  assert.equal(state.snapshot()[0].subagents[0].used, 40);
  for (const data of [update(-1), update(null), update(20, 0), update(20, NaN), update(60, 100, { parentAgentId: 'lead' })]) state.observe('a', data);
  assert.equal(state.snapshot()[0].lead.used, 0);
  state.observe('b', update(200));
  assert.equal(state.snapshot()[0].lead.used, 200);
  state.observe('c', update());
  assert.deepEqual(state.snapshot().map(x => x.sessionId), ['c', 'b']);
});
test('native subagent context accepts optional run IDs without overwriting lead or other scopes', () => {
  const state = createContextState();
  state.observe('s', update(10));
  assert.equal(state.observe('s', update(20, 100, { parentAgentId: 'a' })), true);
  state.observe('s', update(30, 100, { parentAgentId: 'b', runId: null }));
  state.observe('s', update(40, 100, { parentAgentId: 'a', runId: 'run' }));
  for (const runId of ['', 1, {}, []]) assert.equal(state.observe('s', update(99, 100, { parentAgentId: 'a', runId })), undefined);
  const session = state.snapshot()[0];
  assert.equal(session.lead.used, 10);
  assert.deepEqual(session.subagents.map(x => [x.parentAgentId, x.runId, x.used]), [['a', null, 20], ['b', null, 30], ['a', 'run', 40]]);
  assert.equal(contextDetails(session).rows.filter(row => row.key.startsWith('subagent:')).length, 3);
});
test('turn wall duration preserves generations and model changes invalidate context', () => {
  let now = 10;
  const state = createContextState({ now: () => now });
  const one = state.start('a'); now = 20;
  assert.equal(state.snapshot()[0].turn.durationMs, 10);
  const two = state.start('a'); now = 50;
  state.finish('a', one); assert.equal(state.snapshot()[0].turn.status, 'running');
  state.finish('a', two); now = 80;
  assert.equal(state.snapshot()[0].turn.durationMs, 30);
  const model = value => [{ category: 'model', type: 'select', currentValue: value }];
  state.selectModel('a', model('one')); state.observe('a', update());
  state.selectModel('a', model('two')); assert.equal(state.snapshot()[0].lead, null);
  state.reset('a'); assert.equal(state.snapshot().length, 0);
});
function fixture(protocolVersion = 1) {
  let enabled = true, response = Promise.resolve({}), forwardCalls = 0;
  const api = { registerConnection() { return { dispose() {} }; } }, original = api.registerConnection;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/runtime/context-observer.cjs'), 'utf8'), { module, exports: module.exports, require(name) {
    if (name === 'node:module') return { createRequire: () => () => ({ windsurfAcp: api }) };
    return { createContextState, usageRejectionReason };
  } });
  const connector = { agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion,
    sendRequest() { if (response instanceof Error) throw response; return response; },
    forwardClientRequest() { forwardCalls++; return 'forwarded'; }, setStatus() {} };
  const originalSend = connector.sendRequest, originalForward = connector.forwardClientRequest;
  const handle = module.exports.installContextObserver({ nativeMainPath: 'native', isEnabled: () => enabled });
  api.registerConnection(connector);
  return { api, original, connector, originalSend, originalForward, handle, setResponse(value) { response = value; }, disable() { enabled = false; }, forwards: () => forwardCalls };
}
test('observer preserves native calls/promises, ignores authentication payload, tracks v1 and disposes', async () => {
  const f = fixture(), promise = Promise.resolve({}); f.setResponse(promise);
  assert.equal(f.connector.sendRequest({ method: 'authenticate', get params() { throw Error('must not read'); } }), promise);
  assert.equal(f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } }), promise);
  await tick(); assert.equal(f.handle.snapshot()[0].turn.status, 'finished');
  assert.equal(f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: update() } }), 'forwarded');
  assert.equal(f.handle.snapshot()[0].lead.used, 20);
  f.handle.dispose(); assert.equal(f.connector.sendRequest, f.originalSend); assert.equal(f.connector.forwardClientRequest, f.originalForward); assert.equal(f.api.registerConnection, f.original);
  assert.equal(f.handle.snapshot().length, 0);
});
test('v2 acknowledgement is not completion; cancellation, failures, disable and disconnect clear safely', async () => {
  const f = fixture(2);
  f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } }); await tick();
  assert.equal(f.handle.snapshot()[0].turn.status, 'running');
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  assert.equal(f.handle.snapshot()[0].turn.status, 'idle');
  f.setResponse(new Error('native failure'));
  assert.throws(() => f.connector.sendRequest({ method: 'session/prompt', params: { sessionId: 'a' } }), /native failure/);
  assert.equal(f.handle.snapshot()[0].turn.status, 'error');
  f.connector.setStatus('disconnected'); assert.equal(f.handle.snapshot().length, 0);
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: update() } });
  f.disable(); assert.equal(f.handle.snapshot().length, 0); f.handle.dispose();
});
test('foreign connectors untouched and multiple connections with same session fail closed', () => {
  const f = fixture();
  const foreign = { ...f.connector, agentId: 'other', sendRequest() {} }, saved = foreign.sendRequest;
  f.api.registerConnection(foreign); assert.equal(foreign.sendRequest, saved);
  const second = { ...f.connector, sendRequest() {}, forwardClientRequest() {} };
  f.api.registerConnection(second);
  for (const connector of [f.connector, second]) connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'a', update: update() } });
  assert.equal(f.handle.snapshot().length, 0); f.handle.dispose();
});
test('observer diagnostics distinguish connected traffic from missing usage without payloads', () => {
  const f = fixture();
  assert.equal(f.handle.status().connections, 1);
  assert.equal(f.handle.status().usageUpdates, 0);
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 'private-id', update: update(0) } });
  assert.equal(f.handle.status().sessionUpdates, 1);
  assert.equal(f.handle.status().usageUpdates, 1);
  assert.ok(!JSON.stringify(f.handle.status()).includes('private-id'));
  assert.equal(f.handle.snapshot()[0].lead.used, 0);
  f.handle.dispose();
  assert.equal(f.handle.status().connections, 0);
  assert.equal(f.handle.status().state, 'disposed');
});
test('usage rejection reasons are fixed, isolated and preserve valid zero and optional run IDs', () => {
  const f = fixture();
  try {
    const cases = [[null, update(), 'invalid-session-id'], ['s', update(-1), 'invalid-used'], ['s', update(0, 0), 'invalid-size'], ['s', update(0, 100, { parentAgentId: '' }), 'invalid-parent-id'], ['s', update(0, 100, { parentAgentId: 'p', runId: 3 }), 'invalid-run-id']];
    for (const [sessionId, data, reason] of cases) {
      assert.equal(usageRejectionReason(sessionId, data), reason);
      f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId, update: data } });
    }
    const valid = update(0, 100, { parentAgentId: 'p' });
    assert.equal(usageRejectionReason('s', valid), null);
    f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's', update: valid } });
    const status = f.handle.status();
    assert.equal(status.acceptedUsageUpdates, 1); assert.equal(status.rejectedUsageUpdates, 5);
    assert.deepEqual(Object.values(status.usageRejections), [1, 1, 1, 1, 1]);
    status.usageRejections['invalid-used'] = 99;
    assert.equal(f.handle.status().usageRejections['invalid-used'], 1);
  } finally { f.handle.dispose(); }
});
test('empty context is a compact data grid without diagnostics', () => {
  const details = contextDetails(null);
  assert.equal(details.percent, null);
  assert.ok(details.rows.every(row => row.value === '—'));
  assert.ok(details.request.every(row => row.value === '—'));
  assert.doesNotMatch(details.lines.join('\n'), /连接|更新|不保证|未提供/);
});
test('details use exact session match, distinguish missing from zero, and clamp only the visual ring', () => {
  const session = { sessionId: 'a', lead: { used: 200, size: 100, timestampMs: 100 }, subagents: [] };
  const monitor = { sessions: [{ sessionId: 'b', records: [{ model: 'foreign', startedAt: '2026-01-01', gatewayTps: 999 }] }] };
  let result = contextDetails(session, monitor);
  assert.equal(result.percent, 100); assert.ok(result.lines.join('\n').includes('200%'));
  assert.ok(!result.lines.join('\n').includes('999')); assert.equal(result.request[0].value, '—');
  monitor.sessions[0].sessionId = 'a'; monitor.sessions[0].records[0].gatewayTps = 0;
  result = contextDetails(session, monitor);
  assert.ok(result.lines.includes('网关 TPS：0'));
  assert.ok(result.lines.includes('正文首字：—'));
});
test('context webview handles hostile strings as text and zero as real usage', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.attributes = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); if (!this.value) this.value = children[0].value; }
    replaceChildren() { this.children = []; this.value = ''; }
    getAttribute(key) { return this.attributes[key]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, fn) { this.listeners[key] = fn; }
  }
  const elements = new Map(); const get = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
  let receive;
  vm.runInNewContext(contextScript(), { acquireVsCodeApi: () => ({ postMessage() {} }), document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } } });
  const message = { data: { type: 'context', items: [{ sessionId: 'a', percent: 0, rows: [{ key: 'model', label: '模型', value: '<img onerror=boom>' }], request: [] }] } };
  receive(message);
  assert.equal(get('percent').textContent, '0.0%');
  const cell = get('context').children[0], option = get('sessions').children[0];
  assert.equal(cell.children[1].textContent, '<img onerror=boom>');
  receive(message);
  assert.equal(get('context').children[0], cell); assert.equal(get('sessions').children[0], option);
  message.data.items[0].rows[0].value = 'updated'; receive(message);
  assert.equal(get('context').children[0], cell); assert.equal(cell.children[1].textContent, 'updated');
  assert.match(contextHtml('abc'), /default-src 'none'/);
  new vm.Script(contextHtml('abc').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
});
test('context selection stays stable across updates and drives both panel and statusbar', () => {
  let open, receive, enabled = true, shows = 0, hides = 0;
  let sessions = ['a', 'b'].map((sessionId, index) => ({ sessionId, modelUid: 'm', subagents: [], lead: { used: index * 50, size: 100, timestampMs: 1 } }));
  const messages = [], item = { show() { shows++; }, hide() { hides++; }, dispose() {} };
  const panel = { visible: true, webview: { postMessage(value) { messages.push(value); }, onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; } }, onDidDispose() { return { dispose() {} }; }, dispose() {} };
  const handle = createContextUi({ vscode: { ViewColumn: { Active: 1 }, window: { createStatusBarItem: () => item, createWebviewPanel: () => panel }, commands: { registerCommand(_, fn) { open = fn; return { dispose() {} }; } } }, context: { subscriptions: [] }, snapshot: () => sessions, catalog: () => ({ models: [{ uid: 'm', label: '<model>' }] }), readMonitor: async () => null, isEnabled: () => enabled });
  try {
    open(); receive({ type: 'ready' });
    assert.equal(messages.at(-1).selectedSessionId, 'a');
    assert.deepEqual(messages.at(-1).items.map(x => x.label), ['会话 1 · <model>', '会话 2 · <model>']);
    const count = messages.length, tooltip = item.tooltip;
    let tooltipWrites = 0;
    Object.defineProperty(item, 'tooltip', { get: () => tooltip, set() { tooltipWrites++; }, configurable: true });
    handle.refresh(); handle.refresh();
    assert.equal(messages.length, count); assert.equal(tooltipWrites, 0); assert.equal(shows, 1);
    sessions[0].turn = { durationMs: 1000 }; handle.refresh();
    sessions[0].turn.durationMs = 2000; handle.refresh();
    assert.equal(tooltipWrites, 0); assert.equal(messages.at(-1).items[0].rows[2].value, '2 s');
    receive({ type: 'ready' }); assert.equal(messages.length, count + 3);
    Object.defineProperty(item, 'tooltip', { value: tooltip, writable: true, configurable: true });
    sessions.reverse(); handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'a');
    assert.match(item.text, /0%/); assert.equal(shows, 1);
    receive({ type: 'selectSession', sessionId: 'b' });
    assert.match(item.text, /50%/);
    for (const sessionId of ['unknown', {}, null]) receive({ type: 'selectSession', sessionId });
    assert.equal(messages.at(-1).selectedSessionId, 'b');
    enabled = false; handle.refresh(); handle.refresh(); assert.equal(hides, 1);
    enabled = true; handle.refresh(); assert.equal(shows, 2);
    sessions = sessions.filter(x => x.sessionId === 'a'); handle.refresh();
    assert.equal(messages.at(-1).selectedSessionId, 'a'); assert.match(item.text, /0%/);
  } finally { handle.dispose(); }
});
test('durations use seconds while tokens and TPS retain their units', () => {
  const session = { sessionId: 's', turn: { durationMs: 1234 } };
  const record = { startedAt: '2026-09-24', durationMs: 1234, firstResponseMs: 0, firstTextMs: null, firstOutputMs: 25, gatewayTps: 1234, inputTokens: 1234 };
  const monitor = { sessions: [{ sessionId: 's', records: [record] }] };
  const result = contextDetails(session, monitor);
  const values = Object.fromEntries(result.request.map(row => [row.key, row.value]));
  assert.equal(result.rows[2].value, '1.234 s');
  assert.equal(values.durationMs, '1.234 s'); assert.equal(values.firstResponseMs, '0 s');
  assert.equal(values.firstTextMs, '—'); assert.equal(values.firstOutputMs, '0.025 s');
  assert.equal(values.gatewayTps, '1,234'); assert.equal(values.inputTokens, '1,234');
  assert.equal(contextDetails({ ...session, turn: { durationMs: 9999 } }, monitor).tooltip, result.tooltip);
  monitor.sessions.push(monitor.sessions[0]);
  assert.equal(contextDetails(session, monitor).request[0].value, '—');
});
test('statusbar uses untrusted plain text, coalesces metrics reads and disposes timer', async () => {
  let reads = 0, resolve;
  const item = { show() {}, hide() {}, dispose() {} };
  const context = { subscriptions: [] };
  const handle = createContextUi({ vscode: { window: { createStatusBarItem: () => item }, commands: { registerCommand: () => ({ dispose() {} }) } }, context,
    snapshot: () => [{ sessionId: '[evil](command:evil)', subagents: [], lead: null }], catalog: () => ({}), readMonitor: () => { reads++; return new Promise(done => { resolve = done; }); } });
  handle.refresh(); await tick(); assert.equal(reads, 1);
  assert.equal(typeof item.tooltip, 'string'); assert.doesNotMatch(item.tooltip, /不保证是当前聊天|本轮耗时/);
  handle.dispose(); resolve({ snapshot: null }); await tick();
});
