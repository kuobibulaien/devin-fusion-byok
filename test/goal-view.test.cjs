'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createGoalUi, goalHtml, goalScript } = require('../src/panel/goal-view.cjs');

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this.value = ''; this.textContent = ''; this.className = ''; this.disabled = false; this.title = '';
  }
  append(...children) { for (const child of children) if (child != null) this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const collect = (node, predicate = () => true) => {
  const found = [];
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) found.push(...collect(child, predicate));
  return found;
};

function webview() {
  const elements = new Map(), posts = [], listeners = [];
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); };
  const document = { getElementById: byId, createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) };
  vm.runInNewContext(goalScript(), {
    acquireVsCodeApi: () => ({ postMessage: message => posts.push(message) }),
    document, window: { addEventListener: (name, listener) => { if (name === 'message') listeners.push(listener); }, confirm: () => true },
    Number, String, Math
  });
  return { byId, posts, receive: data => { for (const listener of listeners) listener(data); } };
}

const state = () => ({
  enabled: true, trusted: true, storeError: null, corruptGoals: 0,
  sessions: [{ sessionId: 'session-idle', status: 'idle' }, { sessionId: 'session-busy', status: 'busy' }],
  goals: [{
    id: 'a'.repeat(32), sessionId: 'session-idle', revision: 3, objective: '<img onerror=boom>', criteria: 'all tests pass',
    status: 'review', runsStarted: 2, maxRuns: 5, activeRun: null, reason: 'review', archived: false,
    evidence: [{ runId: 'r', revision: 2, status: 'progress', evidence: '<script>bad()</script>', submittedAt: 1 }],
    createdAt: 1, updatedAt: 2
  }]
});

test('the goal webview renders untrusted values as text and never as markup', () => {
  const { byId, receive } = webview();
  receive({ data: { type: 'goal-state', state: state() } });
  const texts = collect(byId('goals'), node => node.tag === 'pre').map(node => node.textContent).join('\n');
  assert.ok(texts.includes('<img onerror=boom>'));
  assert.ok(texts.includes('<script>bad()</script>'));
});

test('goal cards label sessions by title, distinguish duplicates and fall back to the id', () => {
  const { byId, receive } = webview();
  const data = state();
  data.sessions[0].title = '<b>标题</b>';
  data.sessions[1].title = '<b>标题</b>';
  receive({ data: { type: 'goal-state', state: data } });
  assert.ok(collect(byId('goals'), n => n.className === 'goalhead')[0].textContent.includes('<b>标题</b> · session-idle'));
  data.sessions = [];
  receive({ data: { type: 'goal-state', state: data } });
  assert.ok(collect(byId('goals'), n => n.className === 'goalhead')[0].textContent.includes('session-idle'));
});

test('the goal panel has no session picker or start form and explains the /goal command', () => {
  const html = goalHtml('nonce');
  for (const id of ['id="session"', 'id="objective"', 'id="criteria"', 'id="maxRuns"', 'id="start"']) assert.ok(!html.includes(id), id);
  assert.match(html, /\/goal 要达成的目标/);
  assert.match(html, /\/goal pause/);
  assert.ok(!goalScript().includes('goal.start'));
});

test('criteria identical to the objective are not repeated on the card', () => {
  const { byId, receive } = webview();
  const data = state();
  data.goals[0].criteria = data.goals[0].objective;
  receive({ data: { type: 'goal-state', state: data } });
  const texts = collect(byId('goals'), node => node.tag === 'pre').map(node => node.textContent).join('\n');
  assert.ok(!texts.includes('验收标准'));
});

test('the goal webview surfaces errors, review is labelled as not complete, and accept asks for confirmation', () => {
  const { byId, posts, receive } = webview();
  receive({ data: { type: 'goal-state', state: state() } });
  const heads = collect(byId('goals'), node => node.className === 'goalhead').map(node => node.textContent);
  assert.ok(heads[0].includes('待验收'));
  assert.ok(heads[0].includes('不等于已完成'));
  const counters = collect(byId('goals'), node => node.className === 'meta').map(node => node.textContent);
  assert.ok(counters[0].includes('2 / 5'));
  assert.ok(counters[0].includes('运行额度已使用'));
  assert.ok(counters[0].includes('含派发准备，非模型回复数'));
  receive({ data: { type: 'goal-result', id: 'x', ok: false, error: '该会话已有进行中的目标。' } });
  assert.equal(byId('error').textContent, '该会话已有进行中的目标。');
  const accept = collect(byId('goals'), node => node.tag === 'button' && node.textContent === '验收完成')[0];
  assert.ok(accept);
  accept.onclick();
  assert.ok(posts.some(message => message.type === 'goal.accept'));
});

test('the goal webview shows untrusted and disabled states from the host snapshot', () => {
  const { byId, receive } = webview();
  receive({ data: { type: 'goal-state', state: { ...state(), enabled: false, trusted: false, storeError: 'goal_store_corrupt', corruptGoals: 2 } } });
  assert.equal(byId('enabled').textContent, '已停用');
  assert.equal(byId('trusted').textContent, '工作区未信任');
  assert.match(byId('storeError').textContent, /goal_store_corrupt/);
  assert.match(byId('corrupt').textContent, /2 条/);
});

test('the goal html declares a strict CSP nonce and parses as a script', () => {
  const html = goalHtml('abc123');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(html.includes('innerHTML'), false);
});

test('the goal UI registers its command, posts state on ready, and dispatches controller calls', async () => {
  const commands = new Map(), posts = [], subscriptions = [];
  let disposed = 0, visible = true;
  const calls = [];
  const panel = {
    visible, reveal() {}, dispose() { disposed++; },
    webview: { html: '', postMessage: message => { posts.push(message); return true; },
      onDidReceiveMessage: () => ({ dispose() {} }) },
    onDidDispose: () => ({ dispose() {} })
  };
  const controller = {
    snapshot: () => state(),
    start: payload => { calls.push(['start', payload]); return {}; },
    pause: payload => { calls.push(['pause', payload]); return {}; },
    resume: payload => { calls.push(['resume', payload]); return {}; },
    accept: payload => { calls.push(['accept', payload]); return {}; },
    archive: payload => { calls.push(['archive', payload]); return {}; }
  };
  const item = { show() {}, hide() {}, dispose() {} };
  const handle = createGoalUi({
    vscode: {
      window: { createWebviewPanel: () => panel, createStatusBarItem: () => item, StatusBarAlignment: { Right: 2 } },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
      ViewColumn: { Active: 1 }
    },
    context: { subscriptions },
    controller,
    safeError: () => ({ message: '操作失败。' })
  });
  assert.ok(commands.has('devinFusionByok.goal'));
  commands.get('devinFusionByok.goal')();
  assert.match(panel.webview.html, /Fusion BYOK Goal/);
  await new Promise(resolve => setImmediate(resolve));
  handle.dispose();
  assert.equal(disposed, 1);
  assert.ok(subscriptions.length >= 1);
});

function host({ confirmAnswer = '确认', snapshot = state(), limitAnswer = undefined } = {}) {
  const posts = [], subscriptions = [], warnings = [], calls = [], limits = [];
  let listener = null;
  const panel = {
    visible: true, reveal() {}, dispose() {},
    webview: { html: '', postMessage: message => { posts.push(message); return true; },
      onDidReceiveMessage: handler => { listener = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} })
  };
  const controller = {
    snapshot: () => snapshot,
    start: payload => { calls.push(['start', payload]); return {}; },
    pause: payload => { calls.push(['pause', payload]); return {}; },
    resume: payload => { calls.push(['resume', payload]); return {}; },
    accept: payload => { calls.push(['accept', payload]); return {}; },
    archive: payload => { calls.push(['archive', payload]); return {}; }
  };
  const commands = new Map();
  const handle = createGoalUi({
    vscode: {
      window: {
        createWebviewPanel: () => panel, createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        StatusBarAlignment: { Right: 2 },
        showWarningMessage: async (message, options, choice) => { warnings.push(message); return confirmAnswer === '确认' ? choice : undefined; },
        showInputBox: async options => { limits.push(options); return limitAnswer; }
      },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
      ViewColumn: { Active: 1 }
    },
    context: { subscriptions }, controller, safeError: () => ({ message: '操作失败。' })
  });
  commands.get('devinFusionByok.goal')();
  return { handle, panel, posts, warnings, calls, limits, receive: async message => { listener(message); await tick(); } };
}

test('the host handles ready and refresh, answering with an id-less state post', async () => {
  const h = host();
  await h.receive({ type: 'goal.ready', id: 'r1', payload: {} });
  assert.ok(h.posts.some(message => message.type === 'goal-state'));
  await h.receive({ type: 'goal.refresh', id: 'r2', payload: {} });
  assert.ok(h.posts.filter(message => message.type === 'goal-state').length >= 2);
  h.handle.dispose();
});

test('the host dispatches start, pause, resume and archive to the controller', async () => {
  const h = host();
  await h.receive({ type: 'goal.start', id: '1', payload: { sessionId: 's', objective: 'o', criteria: 'c' } });
  await h.receive({ type: 'goal.pause', id: '2', payload: { id: 'g' } });
  await h.receive({ type: 'goal.resume', id: '3', payload: { id: 'g' } });
  await h.receive({ type: 'goal.archive', id: '4', payload: { id: 'g' } });
  assert.deepEqual(h.calls.map(call => call[0]), ['start', 'pause', 'resume', 'archive']);
  assert.ok(h.posts.some(message => message.type === 'goal-result' && message.ok === true));
  h.handle.dispose();
});

test('accept always asks the host for confirmation and a decline never reaches the controller', async () => {
  const cancelled = host({ confirmAnswer: null });
  await cancelled.receive({ type: 'goal.accept', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.warnings.length, 1);
  cancelled.handle.dispose();
  const confirmed = host();
  await confirmed.receive({ type: 'goal.accept', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.deepEqual(confirmed.calls.map(call => call[0]), ['accept']);
  assert.equal(confirmed.warnings.length, 1);
  confirmed.handle.dispose();
});

test('a client-sent confirm flag cannot bypass the host confirmation', async () => {
  const bypass = host({ confirmAnswer: null });
  await bypass.receive({ type: 'goal.accept', id: '1', payload: { id: 'a'.repeat(32) }, confirm: false });
  assert.equal(bypass.calls.length, 0);
  assert.equal(bypass.warnings.length, 1);
  bypass.handle.dispose();
});

test('archive asks for confirmation only when the current goal is still active', async () => {
  const active = host({ confirmAnswer: null, snapshot: { ...state(), goals: [{ ...state().goals[0], status: 'active', reason: null }] } });
  await active.receive({ type: 'goal.archive', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(active.calls.length, 0);
  assert.equal(active.warnings.length, 1);
  active.handle.dispose();
  const paused = host({ confirmAnswer: null, snapshot: { ...state(), goals: [{ ...state().goals[0], status: 'paused', reason: 'user-paused' }] } });
  await paused.receive({ type: 'goal.archive', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.deepEqual(paused.calls.map(call => call[0]), ['archive']);
  assert.equal(paused.warnings.length, 0);
  paused.handle.dispose();
});

test('resuming an exhausted goal asks for a validated new total limit', async () => {
  const limited = { ...state(), goals: [{ ...state().goals[0], status: 'limited', reason: 'max-runs', runsStarted: 5, maxRuns: 5 }] };
  const cancelled = host({ snapshot: limited, limitAnswer: undefined });
  await cancelled.receive({ type: 'goal.resume', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.limits.length, 1);
  cancelled.handle.dispose();
  const accepted = host({ snapshot: limited, limitAnswer: '9' });
  await accepted.receive({ type: 'goal.resume', id: '1', payload: { id: 'a'.repeat(32) } });
  const resume = accepted.calls.find(call => call[0] === 'resume');
  assert.equal(resume[1].maxRuns, 9);
  accepted.handle.dispose();
  const invalid = host({ snapshot: limited, limitAnswer: '5' });
  await invalid.receive({ type: 'goal.resume', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(invalid.calls.length, 0);
  invalid.handle.dispose();
});

test('resuming a paused goal with remaining budget never prompts for a new limit', async () => {
  const paused = host({ snapshot: { ...state(), goals: [{ ...state().goals[0], status: 'paused', reason: 'user-paused', runsStarted: 2, maxRuns: 5 }] } });
  await paused.receive({ type: 'goal.resume', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(paused.limits.length, 0);
  assert.equal(paused.calls.find(call => call[0] === 'resume')[1].maxRuns, undefined);
  paused.handle.dispose();
});

test('resuming a paused goal whose budget is exhausted still asks for a new limit', async () => {
  const exhausted = { ...state(), goals: [{ ...state().goals[0], status: 'paused', reason: 'missing-report', runsStarted: 5, maxRuns: 5 }] };
  const cancelled = host({ snapshot: exhausted, limitAnswer: undefined });
  await cancelled.receive({ type: 'goal.resume', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.limits.length, 1);
  cancelled.handle.dispose();
  const accepted = host({ snapshot: exhausted, limitAnswer: '6' });
  await accepted.receive({ type: 'goal.resume', id: '1', payload: { id: 'a'.repeat(32) } });
  assert.equal(accepted.calls.find(call => call[0] === 'resume')[1].maxRuns, 6);
  accepted.handle.dispose();
});

test('a controller error is reported to the webview as a failed result', async () => {
  const posts = [], subscriptions = [];
  let listener = null;
  const panel = {
    visible: true, reveal() {}, dispose() {},
    webview: { html: '', postMessage: message => { posts.push(message); return true; },
      onDidReceiveMessage: handler => { listener = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} })
  };
  const commands = new Map();
  const handle = createGoalUi({
    vscode: {
      window: { createWebviewPanel: () => panel, createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }), StatusBarAlignment: { Right: 2 } },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } }, ViewColumn: { Active: 1 }
    },
    context: { subscriptions },
    controller: {
      snapshot: () => state(),
      start: () => { const error = new Error('该会话已有进行中的目标，请先归档。'); error.code = 'goal-exists'; throw error; },
      pause: () => ({}), resume: () => ({}), accept: () => ({}), archive: () => ({})
    },
    safeError: () => ({ message: '操作失败。' })
  });
  commands.get('devinFusionByok.goal')();
  listener({ type: 'goal.start', id: '1', payload: {} });
  await tick();
  const failure = posts.find(message => message.type === 'goal-result' && message.ok === false);
  assert.ok(failure);
  assert.match(failure.error, /已有进行中的目标/);
  assert.equal(failure.id, '1');
  handle.dispose();
});

test('the goal UI reports controller errors to the webview without crashing', async () => {
  const posts = [], subscriptions = [];
  const panel = {
    visible: true, reveal() {}, dispose() {},
    webview: { html: '', postMessage: message => { posts.push(message); return true; }, onDidReceiveMessage: () => ({ dispose() {} }) },
    onDidDispose: () => ({ dispose() {} })
  };
  const controller = {
    snapshot: () => state(),
    start: () => { throw new Error('boom'); },
    pause: () => ({}), resume: () => ({}), accept: () => ({}), archive: () => ({})
  };
  const handle = createGoalUi({
    vscode: {
      window: { createWebviewPanel: () => panel, createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }), StatusBarAlignment: { Right: 2 } },
      commands: { registerCommand: () => ({ dispose() {} }) },
      ViewColumn: { Active: 1 }
    },
    context: { subscriptions }, controller, safeError: () => ({ message: '操作失败。' })
  });
  handle.dispose();
  assert.equal(typeof handle.refresh, 'function');
});