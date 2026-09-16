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
const { RECEIPT } = require('../src/lifecycle/owned-settings.cjs');
const next = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, initial = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-extension-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'User/globalStorage/local.devin-fusion-byok'), extensionPath = path.join(directory, 'extension');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(extensionPath);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true, providers: [{ id: 'cpa', name: 'CPA', models: [] }], ...initial.config }));
  const globals = { agentEnv: { 'devin-cli': { KEEP: 'user-value' } }, agentPreferences: { 'devin-cli': { model: 'native-max', effort: 'high' } }, ...initial.globals };
  const state = new Map(Object.entries(initial.state || {})), commands = new Map(), logs = [], notices = [], watchers = [], preferenceListeners = [];
  const updates = [], bridges = [];
  let disposed = 0, installed = 0, managerOptions;
  const settings = {
    inspect: key => ({ globalValue: globals[key] }),
    get: () => { throw new Error('Merged workspace settings must not be copied into global settings'); },
    update: async (key, value) => { assert.ok(fs.existsSync(path.join(root, RECEIPT))); globals[key] = value; updates.push(key); },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => settings,
      onDidChangeConfiguration: fn => { preferenceListeners.push(fn); return { dispose() {} }; } },
    extensions: { getExtension: () => ({ extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    window: {
      createOutputChannel: () => ({ appendLine: value => logs.push(value), show() {}, dispose() {} }),
      showInformationMessage: text => notices.push(text), showErrorMessage: text => notices.push(text),
      showQuickPick: async choices => choices[0],
    },
  };
  const identity = { service: 'devin-fusion-byok', version: '0.2.0', sourceId: 'expected', rootId: 'root' };
  const spawns = [];
  let fetchImpl = async () => new Response(JSON.stringify({ ...identity, draining: false }));
  let injectionGate = null;
  const overrides = {
    vscode,
    'node:fs': { ...fs, watchFile: (_file, _options, callback) => watchers.push(callback), unwatchFile: () => {} },
    'node:child_process': { spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      const child = new EventEmitter(); child.unref = () => {};
      return child;
    } },
    './config.cjs': {
      readConfig: file => JSON.parse(fs.readFileSync(file, 'utf8')),
      writeConfig: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
      importLegacy: () => ({}), discover: async () => 2, updateSidekicks() {},
    },
    './catalog.cjs': { buildCatalog: config => ({ models: config.providers?.length ? ['own'] : [],
      fusions: config.providers?.length ? { 'fusion-dfbyok-selected': { label: 'CPA Fusion' }, 'fusion-dfbyok-another': { label: 'CPA Fusion Alt' } } : {} }) },
    './runtime/backend.cjs': { runtimeIdentity: () => identity, controlFile: actualBackend.controlFile, PORT: 39842, MANAGEMENT_PROTOCOL: 1 },
    './runtime/bridge.cjs': { createLsBridge: async (_port, options) => { bridges.push(options); return { port: 4567, close() {} }; } },
    './runtime/ls-injection.cjs': { installLsInjection: async options => {
      installed++; await options.createBridge(1234);
      if (injectionGate) { const gate = injectionGate; injectionGate = null; await gate; }
      return { status: { state: 'ready' }, dispose: async () => { disposed++; } };
    } },
    './panel/model.cjs': { ...realRequire('./panel/model.cjs'), createManager: options => {
      managerOptions = options;
      return realRequire('./panel/model.cjs').createManager(options);
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process,
    AbortController, AbortSignal, setTimeout: (fn, _ms) => setTimeout(fn, 0), clearTimeout,
    fetch: (...args) => fetchImpl(...args),
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
  }, { filename });
  const context = { globalStorageUri: { fsPath: root }, extensionPath, subscriptions: [],
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) } };
  t.after(async () => { await module.exports.deactivate(); context.subscriptions.forEach(value => value.dispose()); });
  return { ...module.exports, context, root, configFile, globals, state, commands, logs, notices, watchers, updates, bridges,
    preferenceListeners, managerOptions: () => managerOptions, spawns,
    setFetch: impl => { fetchImpl = impl; },
    gateInjection: () => { let release; injectionGate = new Promise(resolve => { release = resolve; }); return release; },
    firePreference: (key = 'devin.acp.agentPreferences') => Promise.all(preferenceListeners.map(fn => fn({ affectsConfiguration: name => name === key }))),
    settle: async (ticks = 20) => { for (let index = 0; index < ticks; index++) await next(); },
    counts: () => ({ installed, disposed }) };
}
test('normal window unload restores its LS hook without reverting shared CLI environment', async t => {
  const f = fixture(t); await f.activate(f.context);
  assert.equal(f.counts().installed, 1);
  await f.deactivate();
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39842');
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.ok(!f.logs.some(line => line.includes('error')));
});
test('explicit disable restores owned env and any own Fusion selection, preserving native preference fields', async t => {
  const f = fixture(t); await f.activate(f.context);
  await f.commands.get('devinFusionByok.selectFusion')();
  f.globals.agentPreferences['devin-cli'].model = 'fusion-dfbyok-native-sidekick';
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.counts().disposed, 1);
  assert.ok(!Object.hasOwn(f.globals.agentEnv['devin-cli'], 'WINDSURF_API_SERVER_URL'));
  assert.equal(f.globals.agentEnv['devin-cli'].KEEP, 'user-value');
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  assert.equal(f.state.has('savedEnv'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT))).changes.length, 0);
});
test('disable preserves subsequent user choices for native model and server URL', async t => {
  const f = fixture(t); await f.activate(f.context); await f.commands.get('devinFusionByok.selectFusion')();
  f.globals.agentPreferences['devin-cli'].model = 'gpt-native-chosen';
  f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL = 'https://user.example';
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'gpt-native-chosen');
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'https://user.example');
});
test('another window disabling stops catalog injection immediately and releases the hook on file notification', async t => {
  const f = fixture(t); await f.activate(f.context);
  assert.equal(f.bridges[0].getCatalog().models.length, 1);
  const config = JSON.parse(fs.readFileSync(f.configFile)); config.enabled = false; fs.writeFileSync(f.configFile, JSON.stringify(config));
  assert.equal(f.bridges[0].getCatalog().models.length, 0);
  f.watchers[0](); await next();
  assert.equal(f.counts().disposed, 1);
});
test('refreshing models while disabled does not re-enable routing', async t => {
  const f = fixture(t, { config: { enabled: false } }); await f.activate(f.context);
  await f.commands.get('devinFusionByok.refreshModels')();
  assert.equal(f.counts().installed, 0);
  assert.deepEqual(f.updates, []);
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).enabled, false);
});
test('legacy env originals migrate without mutating frozen configuration values', async t => {
  const nativeEnv = Object.freeze({ WINDSURF_API_SERVER_URL: 'http://127.0.0.1:39842', HTTPS_PROXY: 'http://legacy-proxy', KEEP: 'keep' });
  const f = fixture(t, { globals: { agentEnv: Object.freeze({ 'devin-cli': nativeEnv }) },
    state: { managedEnv: { WINDSURF_API_SERVER_URL: 'http://127.0.0.1:39842', HTTPS_PROXY: 'http://legacy-proxy' },
      savedEnv: { WINDSURF_API_SERVER_URL: 'https://before-plugin.example', HTTPS_PROXY: null } } });
  await f.activate(f.context);
  assert.equal(f.globals.agentEnv['devin-cli'].HTTPS_PROXY, undefined);
  await f.commands.get('devinFusionByok.disable')();
  assert.equal(f.globals.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'https://before-plugin.example');
  assert.equal(nativeEnv.HTTPS_PROXY, 'http://legacy-proxy');
});
test('an official Fusion reset at startup restores the remembered own combination', async t => {
  const f = fixture(t, { config: { defaultFusionUid: 'fusion-dfbyok-selected' },
    globals: { agentPreferences: { 'devin-cli': { model: 'fusion-official-claude', effort: 'high' } } } });
  await f.activate(f.context);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
  assert.equal(f.globals.agentPreferences['devin-cli'].effort, 'high');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, RECEIPT), 'utf8'));
  assert.equal(receipt.changes.find(change => change.path[0] === 'devin.acp.agentPreferences').managed, 'fusion-dfbyok-selected');
});
test('a mid-session official reset re-selects the remembered combination without a write loop', async t => {
  const f = fixture(t, { config: { defaultFusionUid: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official-claude';
  await f.firePreference();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
  const writes = f.updates.length;
  await f.firePreference();
  await f.settle();
  assert.equal(f.updates.length, writes);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
});
test('plain native and plain own model selections are never overwritten', async t => {
  const f = fixture(t, { config: { defaultFusionUid: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  for (const plain of ['native-max', 'dfbyok-plain-model', 'swe-2-max']) {
    f.globals.agentPreferences['devin-cli'].model = plain;
    const writes = f.updates.length;
    await f.firePreference();
    await f.settle();
    assert.equal(f.globals.agentPreferences['devin-cli'].model, plain);
    assert.equal(f.updates.length, writes);
  }
});
test('a stale or absent remembered combination never replaces an official or missing selection', async t => {
  for (const config of [{ defaultFusionUid: 'fusion-dfbyok-removed' }, { providers: [], defaultFusionUid: 'fusion-dfbyok-selected' }, {}]) {
    const f = fixture(t, { config, globals: { agentPreferences: { 'devin-cli': { model: 'fusion-official' } } } });
    await f.activate(f.context);
    await f.firePreference();
    await f.settle();
    assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official');
  }
});
test('a saved own Fusion selection survives an official reset across reload', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.commands.get('devinFusionByok.selectFusion')();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).defaultFusionUid, 'fusion-dfbyok-selected');
  await f.deactivate();
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official-claude';
  await f.activate(f.context);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
});
test('a remembered combination saved by another window applies on the config notification', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const current = JSON.parse(fs.readFileSync(f.configFile));
  current.defaultFusionUid = 'fusion-dfbyok-selected';
  fs.writeFileSync(f.configFile, JSON.stringify(current));
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official';
  f.watchers[0]();
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
});
test('preference reconciliation stays inert while disabled and after unload', async t => {
  const f = fixture(t, { config: { enabled: false, defaultFusionUid: 'fusion-dfbyok-selected' },
    globals: { agentPreferences: { 'devin-cli': { model: 'fusion-official' } } } });
  await f.activate(f.context);
  await f.firePreference();
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-official');
  const enabled = fixture(t, { config: { defaultFusionUid: 'fusion-dfbyok-selected' } });
  await enabled.activate(enabled.context);
  await enabled.deactivate();
  enabled.globals.agentPreferences['devin-cli'].model = 'fusion-official';
  const writes = enabled.updates.length;
  await enabled.firePreference();
  await enabled.settle();
  assert.equal(enabled.globals.agentPreferences['devin-cli'].model, 'fusion-official');
  assert.equal(enabled.updates.length, writes);
});
test('a native preference event with a valid own Fusion records it as the remembered default', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  const writes = () => f.updates.filter(key => key === 'agentPreferences').length;
  f.globals.agentPreferences['devin-cli'].model = 'fusion-dfbyok-selected';
  await f.firePreference();
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).defaultFusionUid, 'fusion-dfbyok-selected');
  assert.equal(writes(), 0);
  f.globals.agentPreferences['devin-cli'].model = 'fusion-dfbyok-another';
  await f.firePreference();
  assert.equal(JSON.parse(fs.readFileSync(f.configFile)).defaultFusionUid, 'fusion-dfbyok-another');
  delete f.globals.agentPreferences['devin-cli'].model;
  await f.firePreference();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-another');
  await f.firePreference('devin.acp.agentEnv');
  await f.settle();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-another');
});
test('re-enabling from the panel re-arms reconciliation after a disable', async t => {
  const f = fixture(t, { config: { defaultFusionUid: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  const { write, afterChange } = f.managerOptions();
  write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: false });
  await afterChange('setEnabled');
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'native-max');
  write({ ...JSON.parse(fs.readFileSync(f.configFile)), enabled: true });
  await afterChange('setEnabled');
  assert.equal(f.counts().installed, 2);
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official-claude';
  await f.firePreference();
  assert.equal(f.globals.agentPreferences['devin-cli'].model, 'fusion-dfbyok-selected');
});
test('the panel reports the remembered combination while the current selection is a plain model', async t => {
  const f = fixture(t, { config: { defaultFusionUid: 'fusion-dfbyok-selected' } });
  await f.activate(f.context);
  assert.equal(f.managerOptions().selectedFusion(), 'fusion-dfbyok-selected');
  f.globals.agentPreferences['devin-cli'].model = 'fusion-official';
  assert.equal(f.managerOptions().selectedFusion(), 'fusion-official');
  f.globals.agentPreferences['devin-cli'].model = 'dfbyok-plain';
  assert.equal(f.managerOptions().selectedFusion(), 'fusion-dfbyok-selected');
});

const oldRuntimeHealth = idle => ({ service: 'devin-fusion-byok', version: '0.1.0', sourceId: 'old', rootId: 'root',
  instanceId: 'old-1', managementProtocol: 1, activeRequests: idle ? 0 : 4, draining: false });
const newRuntimeHealth = { service: 'devin-fusion-byok', version: '0.2.0', sourceId: 'expected', rootId: 'root',
  instanceId: 'new-1', managementProtocol: 1, activeRequests: 0, draining: false };
test('a busy older runtime lets activation finish and upgrades in the background once it idles', async t => {
  const f = fixture(t);
  fs.writeFileSync(actualBackend.controlFile(f.root), JSON.stringify({ ...oldRuntimeHealth(true), token: 'b'.repeat(64) }), { mode: 0o600 });
  let busy = true, shutdowns = 0, gone = false;
  f.setFetch(async url => {
    if (url.endsWith('/_runtime/shutdown')) { shutdowns++; return new Response('{"stopping":true}'); }
    if (busy) return new Response(JSON.stringify(oldRuntimeHealth(false)));
    if (shutdowns === 0) return new Response(JSON.stringify(oldRuntimeHealth(true)));
    if (!gone) { gone = true; throw new Error('Connection refused'); }
    return new Response(JSON.stringify(newRuntimeHealth));
  });
  await f.activate(f.context);
  assert.equal(f.counts().installed, 1, 'activation finishes the hook while the old runtime is busy');
  assert.equal(f.logs.filter(line => line.includes('runtime-update-pending')).length, 1);
  assert.ok(f.logs.some(line => line.includes('runtime-update-pending') && line.includes('0.1.0')));
  assert.equal(f.spawns.length, 0);
  assert.equal(shutdowns, 0);
  busy = false;
  await f.settle(80);
  assert.equal(shutdowns, 1);
  assert.equal(f.spawns.length, 1);
  assert.ok(!f.logs.some(line => line.includes('runtime-upgrade-error')));
});
test('unloading while the old runtime stays busy aborts the background upgrade', async t => {
  const f = fixture(t);
  let shutdowns = 0;
  f.setFetch(async url => {
    if (url.endsWith('/_runtime/shutdown')) { shutdowns++; return new Response('{"stopping":true}'); }
    return new Response(JSON.stringify(oldRuntimeHealth(false)));
  });
  await f.activate(f.context);
  assert.equal(f.counts().installed, 1);
  await f.deactivate();
  await f.settle(30);
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.spawns.length, 0);
  assert.equal(shutdowns, 0);
  assert.ok(!f.logs.some(line => line.includes('runtime-upgrade-error')));
});
test('a runtime owned by another storage root fails activation before any hook installs', async t => {
  const f = fixture(t);
  f.setFetch(async () => new Response(JSON.stringify({ ...oldRuntimeHealth(true), rootId: 'other-root' })));
  await f.activate(f.context);
  assert.equal(f.counts().installed, 0);
  assert.equal(f.spawns.length, 0);
  assert.ok(f.logs.some(line => line.includes('different_storage')));
});
test('a cold-start failure still gates activation and installs no hook', async t => {
  const f = fixture(t);
  f.setFetch(async () => { throw new Error('Connection refused'); });
  await f.activate(f.context);
  assert.equal(f.counts().installed, 0);
  assert.equal(f.spawns.length, 1);
  assert.ok(f.logs.some(line => line.includes('startup_failed')));
});
test('another window re-enabling after a shared disable reinstalls the hook exactly once', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  assert.equal(f.counts().installed, 1);
  const current = JSON.parse(fs.readFileSync(f.configFile));
  fs.writeFileSync(f.configFile, JSON.stringify({ ...current, enabled: false }));
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().disposed, 1);
  fs.writeFileSync(f.configFile, JSON.stringify({ ...current, enabled: true }));
  f.watchers[0](); f.watchers[0](); f.watchers[0]();
  await f.settle(40);
  assert.equal(f.counts().installed, 2);
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().installed, 2);
  assert.equal(f.spawns.length, 0);
});
test('a config notification after unload never resurrects the hook', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.deactivate();
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().installed, 1);
  assert.equal(f.counts().disposed, 1);
});
test('native model observations from the bridge reach the panel and hide persists to shared config', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  f.bridges[0].onNativeModels([{ uid: 'swe-2-max', label: 'Official SWE', disabled: false },
    { uid: 'claude-x', label: 'Claude X', disabled: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.managerOptions().nativeModels())), [
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false, isModelRouter: false, harnessUids: [] },
    { uid: 'claude-x', label: 'Claude X', disabled: true, isModelRouter: false, harnessUids: [] }]);
  const manager = realRequire('./panel/model.cjs').createManager(f.managerOptions());
  const state = await manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configFile)).hiddenNativeModelUids, ['swe-2-max']);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-2-max').hidden, true);
});

test('unloading while LS injection is deferred disposes the late connection instead of resurrecting it', async t => {
  const f = fixture(t);
  const release = f.gateInjection();
  const activation = f.activate(f.context);
  await f.settle(40);
  assert.equal(f.counts().installed, 1, 'injection started but has not resolved');
  assert.equal(f.counts().disposed, 0);
  await f.deactivate();
  release();
  await activation;
  await f.settle(10);
  assert.equal(f.counts().disposed, 1, 'the deferred connection is disposed, never assigned');
  f.watchers[0]();
  await f.settle();
  assert.equal(f.counts().installed, 1, 'no resurrection after unload');
});
