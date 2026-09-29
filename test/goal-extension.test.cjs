'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const filename = path.resolve(__dirname, '../src/extension.cjs');
const realRequire = createRequire(filename);
const actualBackend = require('../src/runtime/backend.cjs');
const goalSource = fs.readFileSync(path.join(__dirname, '../src/runtime/goal-continue.cjs'), 'utf8');
const autoSource = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-continue.cjs'), 'utf8');
const NATIVE_MAIN = '/native/main.js';
const next = () => new Promise(resolve => setImmediate(resolve));

function loadWithStubbedVscode(source, name, api, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise, Array, Object, Error, Symbol,
    require(request) {
      if (request === 'node:crypto') return require('node:crypto');
      if (request === 'node:module') return { createRequire: () => () => ({ windsurfAcp: api, CancellationToken: { None: Symbol('None') } }) };
      if (request === './goal-store.cjs') return realRequire('../src/runtime/goal-store.cjs');
      if (request === './goal-prompts.cjs') return realRequire('../src/runtime/goal-prompts.cjs');
      if (Object.hasOwn(extra, request)) return extra[request];
      return realRequire(request);
    }
  }, { filename: name });
  return module.exports;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-goal-ext-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'User/globalStorage/local.devin-fusion-byok'), extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(extensionPath);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true, providers: [{ id: 'cpa', name: 'CPA', models: [] }] }));
  const globals = { agentEnv: { 'devin-cli': {} }, agentPreferences: { 'devin-cli': { model: 'native-max' } } };
  const state = new Map(), commands = new Map(), logs = [], notices = [], watchers = [], preferenceListeners = [], subscriptions = [];
  const panels = [], posts = [];
  const api = { registerConnection() { return { dispose() {} }; } };
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion: 1,
    sent: [], forwards: [],
    sendRequest(request) { this.sent.push(request); return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest(request) { this.forwards.push(request); return 'fwd'; },
    setStatus() {}
  };
  const settings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged settings must not be read'); },
    update: async (key, value) => { globals[key] = value; }
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => settings, isTrusted: true,
      onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() {} }; } },
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    window: {
      createOutputChannel: () => ({ appendLine: value => logs.push(value), show() {}, dispose() {} }),
      showInformationMessage: text => notices.push(text), showErrorMessage: text => notices.push(text),
      showQuickPick: async choices => choices[0],
      showWarningMessage: async (message, options, choice) => choice,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      StatusBarAlignment: { Right: 2 },
      createWebviewPanel: (viewType, title) => {
        const panel = {
          viewType, title, visible: true, webview: {
            html: '', cspSource: 'test:', postMessage: message => { posts.push({ viewType, message }); return true; },
            onDidReceiveMessage: handler => { panel.handler = handler; return { dispose() {} }; }
          },
          reveal() {}, dispose() { panel.disposed = true; },
          onDidDispose: handler => { panel.disposeHandler = handler; return { dispose() {} }; }
        };
        panels.push(panel);
        return panel;
      }
    },
    ViewColumn: { Active: 1 },
    CancellationToken: { None: Symbol('None') }
  };
  const identity = { service: 'devin-fusion-byok', version: '0.2.0', sourceId: 'expected', rootId: 'root' };
  const overrides = {
    vscode,
    'node:fs': { ...fs, watchFile: (_file, _options, callback) => watchers.push(callback), unwatchFile: () => {} },
    'node:child_process': { spawn: () => { const child = new EventEmitter(); child.unref = () => {}; return child; } },
    './config.cjs': { readConfig: file => JSON.parse(fs.readFileSync(file, 'utf8')),
      writeConfig: (file, value) => fs.writeFileSync(file, JSON.stringify(value)), importLegacy: () => ({}),
      discover: async () => 0, updateSidekicks() {} },
    './catalog.cjs': { normalizeFusionConfig: config => config,
      buildCatalog: config => ({ models: [], fusions: {}, presetStates: [], presetCandidates: { lead: [], sidekick: [] } }) },
    './runtime/native-models.cjs': { readNativeModels: async () => ({ status: 'empty', models: [] }) },
    './runtime/backend.cjs': { runtimeIdentity: () => identity, controlFile: actualBackend.controlFile, PORT: 39842, MANAGEMENT_PROTOCOL: 1 },
    './runtime/bridge.cjs': { createLsBridge: async () => ({ port: 4567, close() {} }) },
    './runtime/ls-injection.cjs': { installLsInjection: async options => { await options.createBridge(1234); return { status: {}, dispose: async () => {} }; } },
    './runtime/goal-continue.cjs': loadWithStubbedVscode(goalSource, 'goal-continue.cjs', api),
    './runtime/auto-continue.cjs': loadWithStubbedVscode(autoSource, 'auto-continue.cjs', api),
    './panel/model.cjs': { ...realRequire('./panel/model.cjs'), createManager: options => realRequire('./panel/model.cjs').createManager(options) }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, AbortController, AbortSignal, setInterval, clearInterval,
    setTimeout: (fn, _ms) => setTimeout(fn, 0), clearTimeout,
    fetch: async () => new Response(JSON.stringify({ ...identity, draining: false })),
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)
  }, { filename });
  const context = { globalStorageUri: { fsPath: root }, extensionPath, subscriptions,
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) } };
  t.after(async () => { await module.exports.deactivate(); subscriptions.forEach(value => value.dispose?.()); });
  return {
    ...module.exports, context, root, configFile, globals, state, commands, logs, notices, watchers, panels, posts, api, connector,
    subscriptions, vscode,
    setTrusted: value => { vscode.workspace.isTrusted = value; },
    settle: async (ticks = 30) => { for (let index = 0; index < ticks; index++) await next(); },
    goalPanel: () => panels.find(panel => panel.viewType === 'devinFusionByok.goal'),
    send: async message => { const panel = panels.find(item => item.viewType === 'devinFusionByok.goal'); panel.handler(message); await next(); await next(); },
    receive: async message => { const panel = panels.find(item => item.viewType === 'devinFusionByok.goal'); panel.handler(message); await next(); await next(); }
  };
}

test('activation installs the goal command, status bar entry and both ACP wrappers without duplication', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  assert.ok(f.commands.has('devinFusionByok.goal'));
  f.api.registerConnection(f.connector);
  const wrapped = f.connector.sendRequest;
  f.api.registerConnection(f.connector);
  assert.equal(f.connector.sendRequest, wrapped, 'a duplicate registration never stacks a second wrapper');
  await f.deactivate();
});

test('the goal panel posts state on ready and dispatches start through the real controller', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  f.api.registerConnection(f.connector);
  await f.connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  await f.commands.get('devinFusionByok.goal')();
  await f.settle();
  assert.ok(f.goalPanel());
  await f.receive({ type: 'goal.ready', id: 'r1', payload: {} });
  const snapshot = f.posts.filter(entry => entry.message.type === 'goal-state').at(-1).message.state;
  assert.equal(snapshot.enabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.sessions)), [{ sessionId: 's1', status: 'idle' }]);
  await f.receive({ type: 'goal.start', id: 'r2', payload: { sessionId: 's1', objective: 'ship it', criteria: 'tests pass', maxRuns: 3 } });
  const started = f.posts.filter(entry => entry.message.type === 'goal-state').at(-1).message.state;
  assert.equal(started.goals.length, 1);
  assert.equal(started.goals[0].runsStarted, 1);
  const goalPrompt = f.connector.sent.find(request => request.method === 'session/prompt');
  assert.ok(goalPrompt);
  assert.match(goalPrompt.params.prompt[0].text, /goal-report\.cjs/);
  await f.deactivate();
});

test('an invalid start reports an error to the webview and creates no goal', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  f.api.registerConnection(f.connector);
  await f.connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  await f.commands.get('devinFusionByok.goal')();
  await f.settle();
  await f.receive({ type: 'goal.start', id: 'x', payload: { sessionId: 's1', objective: '', criteria: 'c' } });
  const failure = f.posts.map(entry => entry.message).find(message => message.type === 'goal-result' && message.ok === false);
  assert.ok(failure);
  assert.match(failure.error, /目标描述/);
  assert.equal(f.connector.sent.filter(request => request.method === 'session/prompt').length, 0);
  await f.deactivate();
});

test('disabling suspends an active goal and invalidates its run without sending a prompt', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  f.api.registerConnection(f.connector);
  await f.connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  await f.commands.get('devinFusionByok.goal')();
  await f.settle();
  await f.receive({ type: 'goal.start', id: 'a', payload: { sessionId: 's1', objective: 'o', criteria: 'c' } });
  await f.commands.get('devinFusionByok.disable')();
  await f.settle();
  const goalStore = realRequire('../src/runtime/goal-store.cjs');
  const record = goalStore.readGoal(f.root, 's1');
  assert.equal(record.status, 'paused');
  assert.equal(record.activeRun, null);
  assert.equal(record.reason, 'disabled');
  assert.ok(goalStore.readOwnership(f.root, 's1'), 'suspension keeps the lock so the same window can resume later');
  assert.equal(f.connector.sent.filter(request => request.method === 'session/prompt').length, 1);
  await f.deactivate();
});

test('deactivation disposes the goal UI and releases goal ownership', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  f.api.registerConnection(f.connector);
  await f.connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  await f.commands.get('devinFusionByok.goal')();
  await f.settle();
  await f.receive({ type: 'goal.start', id: 'a', payload: { sessionId: 's1', objective: 'o', criteria: 'c' } });
  await f.deactivate();
  await f.settle();
  const goalStore = realRequire('../src/runtime/goal-store.cjs');
  assert.equal(goalStore.readOwnership(f.root, 's1'), null);
  const record = goalStore.readGoal(f.root, 's1');
  assert.equal(record.status, 'paused');
  assert.equal(record.activeRun, null);
});

test('an untrusted workspace refuses to start a goal, reports the error, and dispatches nothing', async t => {
  const f = fixture(t);
  f.setTrusted(false);
  assert.equal(f.vscode.workspace.isTrusted, false);
  await f.activate(f.context);
  await f.settle();
  f.api.registerConnection(f.connector);
  await f.connector.sendRequest({ method: 'session/new', params: { sessionId: 's1' } });
  f.connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state: 'idle' } } });
  await f.commands.get('devinFusionByok.goal')();
  await f.settle();
  await f.receive({ type: 'goal.start', id: 'a', payload: { sessionId: 's1', objective: 'o', criteria: 'c' } });
  const messages = f.posts.map(entry => entry.message);
  const failure = messages.find(message => message.type === 'goal-result' && message.ok === false);
  assert.ok(failure, 'the untrusted refusal reaches the webview as a failed result');
  assert.match(failure.error, /未受信任/);
  const snapshot = messages.filter(message => message.type === 'goal-state').at(-1).state;
  assert.equal(snapshot.trusted, false);
  assert.equal(snapshot.goals.length, 0, 'no goal is created while untrusted');
  assert.equal(f.connector.sent.filter(request => request.method === 'session/prompt').length, 0, 'no prompt is sent while untrusted');
  const goalStore = realRequire('../src/runtime/goal-store.cjs');
  assert.equal(goalStore.readGoal(f.root, 's1'), null);
  await f.deactivate();
});