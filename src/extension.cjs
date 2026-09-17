'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { importLegacy, readConfig, writeConfig } = require('./config.cjs');
const { buildCatalog, normalizeFusionConfig } = require('./catalog.cjs');
const { createManager } = require('./panel/model.cjs');
const { installLsInjection } = require('./runtime/ls-injection.cjs');
const { createLsBridge } = require('./runtime/bridge.cjs');
const { runtimeIdentity, controlFile, PORT, MANAGEMENT_PROTOCOL } = require('./runtime/backend.cjs');
const { readReceipt, remember, saveReceipt, valueAt, restoreObject, permitted } = require('./lifecycle/owned-settings.cjs');
const { readNativeModels } = require('./runtime/native-models.cjs');
const { installAutoContinue } = require('./runtime/auto-continue.cjs');
let stopNativeSync;
let stopAutoContinue;
let resetAutoContinue;
let connection;
let runtimeWaitAbort;
let activationGeneration = 0;
let reconcileHalted = true;
let activationDisposed = true;
function globalSetting(settings, key) {
  return typeof settings.inspect === 'function' ? settings.inspect(key)?.globalValue || {} : settings.get(key, {});
}
const RUNTIME_ERRORS = {
  port_in_use: '本地连接端口已被其他程序占用。',
  different_storage: '该端口属于另一套插件配置，未更改它的连接服务。',
  legacy_runtime: '旧版连接服务不支持安全升级，请关闭旧版服务后重试。',
  newer_runtime: '另一窗口已加载更新版插件，请重新加载当前窗口。',
  control_unavailable: '无法验证本地连接服务的归属，请重新加载窗口后重试。',
  startup_failed: '本地连接服务启动失败，请查看状态日志。',
  cancelled: '操作已取消。',
};
class RuntimeError extends Error {
  constructor(code) { super(RUNTIME_ERRORS[code]); this.code = code; }
}
function safeError(error) {
  if (error instanceof RuntimeError) return { code: error.code, message: RUNTIME_ERRORS[error.code] };
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^获取模型失败：HTTP [1-5]\d{2}$/.test(message)) return { code: 'provider_http_error', message };
  if (['API 地址必须以 http:// 或 https:// 开头', 'API 未返回模型列表', '未找到 Devin 原生扩展'].includes(message)) return { code: 'configuration_error', message };
  return { code: 'operation_failed', message: '操作失败，请检查接口配置和连接状态。' };
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new RuntimeError('cancelled')); return; }
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new RuntimeError('cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function compareVersion(left, right) {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
async function ensureBackend({ root, extensionPath, signal, log = () => {}, port = PORT, onCompatibleRuntime }, dependencies = {}) {
  const request = dependencies.fetch || fetch;
  const spawnRuntime = dependencies.spawn || spawn;
  const wait = dependencies.sleep || pause;
  const base = 'http://127.0.0.1:' + port;
  let started = false, startupPolls = 0, warnedBusy = false, controlFailures = 0, compatibleNotified = false;
  const timeout = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  for (;;) {
    if (signal?.aborted) throw new RuntimeError('cancelled');
    // Re-read source hashes so windows running the same package version converge
    // on the files currently installed, even after a same-version reinstall.
    const expected = runtimeIdentity(root, true);
    let response;
    try { response = await request(base + '/health', { signal: timeout(1000) }); } catch {}
    if (signal?.aborted) throw new RuntimeError('cancelled');
    if (!response) {
      if (!started) {
        let failed = false;
        try {
          const child = spawnRuntime(process.execPath, [path.join(extensionPath, 'src/runtime/backend.cjs'), root], {
            detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          });
          child.once('error', () => { failed = true; }); child.unref();
        } catch { throw new RuntimeError('startup_failed'); }
        started = true;
        await wait(100, signal);
        if (failed) throw new RuntimeError('startup_failed');
        continue;
      }
      if (++startupPolls >= 50) throw new RuntimeError('startup_failed');
      await wait(100, signal); continue;
    }
    let health;
    try { if (!response.ok) throw new Error(); health = await response.json(); }
    catch { throw new RuntimeError('port_in_use'); }
    if (health?.service !== expected.service) throw new RuntimeError('port_in_use');
    if (health.rootId && health.rootId !== expected.rootId) throw new RuntimeError('different_storage');
    if (compareVersion(health.version, expected.version) > 0) throw new RuntimeError('newer_runtime');
    if (health.version === expected.version && health.sourceId === expected.sourceId && health.rootId === expected.rootId && !health.draining) return health;
    if (health.managementProtocol !== MANAGEMENT_PROTOCOL || !health.instanceId || !health.rootId ||
        !Number.isSafeInteger(health.activeRequests) || health.activeRequests < 0) throw new RuntimeError('legacy_runtime');
    if (!compatibleNotified && !health.draining && !signal?.aborted &&
        (health.version !== expected.version || health.sourceId !== expected.sourceId)) {
      compatibleNotified = true;
      try { onCompatibleRuntime?.(health); } catch {}
    }
    if (health.activeRequests > 0 || health.draining) {
      if (!warnedBusy) { log('runtime-update-waiting', { activeRequests: health.activeRequests }); warnedBusy = true; }
      await wait(health.draining ? 100 : 1000, signal); continue;
    }
    let control;
    try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch {}
    if (!control || control.instanceId !== health.instanceId || control.rootId !== health.rootId ||
        control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) {
      if (++controlFailures > 3) throw new RuntimeError('control_unavailable');
      await wait(100, signal); continue;
    }
    controlFailures = 0;
    try {
      const stopped = await request(base + '/_runtime/shutdown', { method: 'POST',
        headers: { authorization: 'Bearer ' + control.token }, signal: timeout(2000) });
      if (stopped.status === 403) throw new RuntimeError('control_unavailable');
      if (![200, 409, 503].includes(stopped.status)) throw new RuntimeError('legacy_runtime');
      await stopped.body?.cancel();
    } catch (error) { if (error instanceof RuntimeError) throw error; }
    // A second window may have stopped the old process or started the replacement
    // concurrently. Recheck identity before attempting to launch anything.
    started = false; startupPolls = 0;
    await wait(100, signal);
  }
}

async function activate(context) {
  activationDisposed = false;
  const output = vscode.window.createOutputChannel('Devin Fusion BYOK');
  context.subscriptions.push(output);
  const log = (event, data) => output.appendLine(JSON.stringify({ time: new Date().toISOString(), event, ...(data || {}) }));
  const root = context.globalStorageUri.fsPath, configFile = path.join(root, 'config.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(configFile)) writeConfig(configFile, importLegacy());
  const config = () => readConfig(configFile);
  let autoContinue;
  try {
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (native?.extensionPath && native.packageJSON?.main) {
      const nativeMainPath = path.resolve(native.extensionPath, native.packageJSON.main);
      autoContinue = installAutoContinue({
        nativeMainPath,
        isEnabled: () => config().enabled !== false && (config().autoContinueOnProviderError === true || config().autoContinueUntilPlanComplete === true),
        getOptions: () => ({
          onProviderError: config().autoContinueOnProviderError === true,
          untilPlanComplete: config().autoContinueUntilPlanComplete === true
        }),
        log
      });
    } else {
      log('auto-continue-unavailable');
    }
  } catch {
    log('auto-continue-unavailable');
  }
  stopAutoContinue = () => { autoContinue?.dispose(); autoContinue = undefined; };
  resetAutoContinue = () => { autoContinue?.reset(); };
  const catalog = () => { const current = config(); return buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...nativeModels.values()]); };
  let management, manager;
  const nativeModels = new Map(), localNativeModels = new Map();
  let nativeCatalogStatus = 'loading', syncPending, syncAbort, syncTimer;
  const refreshNativeModels = () => {
    if (activationDisposed || config().enabled === false) return Promise.resolve();
    if (syncPending) return syncPending;
    const generation = activationGeneration;
    const abort = new AbortController(); syncAbort = abort;
    syncPending = (async () => {
      let result;
      try { result = await readNativeModels({ root, signal: abort.signal }); }
      catch { result = { status: 'unavailable', models: [] }; }
      if (abort.signal.aborted || generation !== activationGeneration || activationDisposed || config().enabled === false) return;
      nativeCatalogStatus = result.status;
      nativeModels.clear();
      for (const entry of localNativeModels.values()) nativeModels.set(entry.uid, entry);
      for (const entry of result.models) nativeModels.set(entry.uid, entry);
      try { await management?.publish(); } catch {}
    })().finally(() => { if (syncAbort === abort) { syncAbort = undefined; syncPending = undefined; } });
    return syncPending;
  };
  const startNativeSync = () => {
    stopNativeSync?.();
    stopNativeSync = () => { clearInterval(syncTimer); syncAbort?.abort(); syncAbort = undefined; syncPending = undefined; };
    syncTimer = setInterval(() => { void refreshNativeModels(); }, 3000); syncTimer.unref?.();
    void refreshNativeModels();
  };
  const observeNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
      const dimension = entry.sidekickDimension;
      const next = { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : '', disabled: entry.disabled === true,
        isModelRouter: entry.isModelRouter === true,
        harnessUids: Array.isArray(entry.harnessUids) ? entry.harnessUids.filter(value => typeof value === 'string') : [],
        ...(dimension && typeof dimension === 'object'
          ? { sidekickDimension: { order: dimension.order, name: dimension.name, fastModeOrder: dimension.fastModeOrder } } : {}),
        ...(Array.isArray(entry.fusionMetadata) ? { fusionMetadata: entry.fusionMetadata } : {}),
        ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
        ...(entry.supportsImages ? { supportsImages: true } : {}) };
      const previous = nativeModels.get(next.uid);
      if (!previous || previous.label !== next.label || previous.disabled !== next.disabled ||
        previous.isModelRouter !== next.isModelRouter || JSON.stringify(previous.harnessUids) !== JSON.stringify(next.harnessUids) ||
        JSON.stringify(previous.sidekickDimension) !== JSON.stringify(next.sidekickDimension) ||
        JSON.stringify(previous.fusionMetadata) !== JSON.stringify(next.fusionMetadata) ||
        previous.maxTokens !== next.maxTokens || previous.maxOutputTokens !== next.maxOutputTokens ||
        previous.supportsImages !== next.supportsImages) {
        localNativeModels.set(next.uid, next); nativeModels.set(next.uid, next); changed = true;
      }
    }
    if (changed && !activationDisposed) try { void management?.publish()?.catch(() => {}); } catch {}
  };
  let enableQueue = Promise.resolve();
  const ensureEnabled = () => {
    const operation = enableQueue.then(() => {
      if (activationDisposed || config().enabled === false || connection) return;
      return enable();
    });
    enableQueue = operation.catch(() => {});
    return operation;
  };
  async function enable() {
    const generation = ++activationGeneration;
    runtimeWaitAbort?.abort();
    const waiting = new AbortController(); runtimeWaitAbort = waiting;
    let compatible;
    const compatibleReady = new Promise(resolve => { compatible = resolve; });
    const upgrade = ensureBackend({ root, extensionPath: context.extensionPath, signal: waiting.signal, log,
      onCompatibleRuntime: health => {
        if (waiting.signal.aborted) return;
        log('runtime-update-pending', { version: health.version });
        compatible(health);
      } });
    void upgrade.finally(() => { if (runtimeWaitAbort === waiting) runtimeWaitAbort = undefined; })
      .catch(error => { const code = safeError(error).code; if (code !== 'cancelled') log('runtime-upgrade-error', { code }); });
    await Promise.race([upgrade, compatibleReady]);
    if (generation !== activationGeneration || config().enabled === false) return;
    reconcileHalted = false;
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const existing = globalSetting(settings, 'agentEnv');
    const previous = { ...(existing['devin-cli'] || {}) };
    const desired = { WINDSURF_API_SERVER_URL: 'http://127.0.0.1:' + PORT };
    const saved = { ...context.globalState.get('savedEnv', {}) }, managed = context.globalState.get('managedEnv', {});
    const receipt = readReceipt(root, context.extensionPath);
    // Migrate this extension's experimental proxy settings without changing any
    // values the user subsequently edited.
    for (const [key, value] of Object.entries(managed)) if (!(key in desired) && previous[key] === value) {
      if (saved[key] == null) delete previous[key]; else previous[key] = saved[key];
    }
    for (const key of Object.keys(desired)) if (!(key in saved)) saved[key] = previous[key] ?? null;
    for (const [key, value] of Object.entries(desired)) {
      const current = valueAt({ 'devin.acp.agentEnv': existing }, ['devin.acp.agentEnv', 'devin-cli', key]);
      const legacy = managed[key] === current.value && Object.hasOwn(saved, key)
        ? saved[key] == null ? { exists: false } : { exists: true, value: saved[key] } : undefined;
      remember(receipt, ['devin.acp.agentEnv', 'devin-cli', key], current, value, legacy);
    }
    // Commit recovery information before changing the user's settings.
    saveReceipt(receipt);
    await context.globalState.update('savedEnv', saved);
    await context.globalState.update('managedEnv', desired);
    const current = config();
    if (current.inferenceServerUrl !== desired.WINDSURF_API_SERVER_URL) { current.inferenceServerUrl = desired.WINDSURF_API_SERVER_URL; writeConfig(configFile, current); }
    if (Object.keys(managed).some(k => !(k in desired)) || Object.entries(desired).some(([k, v]) => previous[k] !== v)) await settings.update('agentEnv', { ...existing, 'devin-cli': { ...previous, ...desired } }, vscode.ConfigurationTarget.Global);
    if (generation !== activationGeneration || config().enabled === false) return;
    await reconcilePreference();
    if (generation !== activationGeneration || config().enabled === false) return;
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (!native) throw new Error('未找到 Devin 原生扩展');
    const injected = await installLsInjection({ nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main),
      createBridge: port => createLsBridge(port, { getCatalog: catalog, log, onNativeModels: observeNativeModels }), log });
    if (generation !== activationGeneration || config().enabled === false || activationDisposed) {
      try { await injected.dispose(); } catch {}
      return;
    }
    connection = injected;
    startNativeSync();
    log('activated', { nativeVersion: native.packageJSON.version, storage: root });
  }
  const run = fn => async () => { try { await fn(); } catch (error) {
    const safe = safeError(error);
    if (safe.code === 'cancelled') return;
    log('error', { code: safe.code }); vscode.window.showErrorMessage('Fusion BYOK：' + safe.message);
  } };
  const refresh = async () => {
    management.open();
    vscode.window.showInformationMessage('请选择供应商，点击“选择模型导入”，勾选后确认导入。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.refreshModels', run(refresh)));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.configure', run(async () => management.open())));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.openPanel', run(async () => management.open())));
  const saveFusionChoice = async uid => {
    const settings = vscode.workspace.getConfiguration('devin.acp'); const preferences = globalSetting(settings, 'agentPreferences');
    const receipt = readReceipt(root, context.extensionPath), keys = ['devin.acp.agentPreferences', 'devin-cli', 'model'];
    remember(receipt, keys, valueAt({ 'devin.acp.agentPreferences': preferences }, keys), uid);
    saveReceipt(receipt);
    await settings.update('agentPreferences', { ...preferences, 'devin-cli': { ...(preferences['devin-cli'] || {}), model: uid } }, vscode.ConfigurationTarget.Global);
    const current = normalizeFusionConfig(config(), [...nativeModels.values()]);
    if (/^fusion-dfbyok-/.test(uid)) { current.defaultFusionUid = uid; writeConfig(configFile, current); }
    await management?.publish();
  };
  const rememberedFusion = () => {
    const currentCatalog = catalog(), uid = currentCatalog.defaultFusionUid || config().defaultFusionUid;
    return typeof uid === 'string' && Object.hasOwn(currentCatalog.fusions, uid) ? uid : '';
  };
  let reconcileQueue = Promise.resolve();
  const reconcilePreference = () => {
    const operation = reconcileQueue.then(async () => {
      if (reconcileHalted || config().enabled === false) return;
      const current = globalSetting(vscode.workspace.getConfiguration('devin.acp'), 'agentPreferences')['devin-cli']?.model;
      const migration = catalog();
      if (migration.migratedFrom === current && migration.defaultFusionUid) {
        await saveFusionChoice(migration.defaultFusionUid);
        return;
      }
      if (typeof current === 'string' && /^fusion-dfbyok-/.test(current)) {
        if (!Object.hasOwn(catalog().fusions, current)) return;
        if (rememberedFusion() !== current) {
          const next = config();
          next.defaultFusionUid = current;
          writeConfig(configFile, next);
        }
        return;
      }
      if (typeof current === 'string' && current && !current.startsWith('fusion-')) return;
      const remembered = rememberedFusion();
      if (remembered) await saveFusionChoice(remembered);
    }).catch(() => log('preference-reconcile-error'));
    reconcileQueue = operation;
    return operation;
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.selectFusion', run(async () => {
    const choices = Object.entries(catalog().fusions).map(([uid, item]) => ({ label: item.label || uid, uid }));
    if (!choices.length) { management?.open(); vscode.window.showInformationMessage('请先在控制面板新建并命名 Fusion 预设。'); return; }
    const choice = await vscode.window.showQuickPick(choices, { title: '选择 Fusion 预设', matchOnDescription: true }); if (!choice) return;
    await saveFusionChoice(choice.uid);
    vscode.window.showInformationMessage('Fusion 模型已保存，请新建 Devin Local 会话。');
  })));
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.status', () => { log('status', { runtime: connection?.status, models: config().providers.map(p => ({ name: p.name, models: p.models.length })) }); output.show(true); }));
  const disable = async () => {
    const current = config(); current.enabled = false; writeConfig(configFile, current);
    await teardown();
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const snapshot = { 'devin.acp.agentEnv': globalSetting(settings, 'agentEnv'), 'devin.acp.agentPreferences': globalSetting(settings, 'agentPreferences') };
    const receipt = readReceipt(root, context.extensionPath);
    const managed = context.globalState.get('managedEnv', {}), saved = context.globalState.get('savedEnv', {});
    // Older releases kept the backup in globalState only. Migrate only values
    // with an actual saved original; an unknown original is never guessed.
    for (const [key, value] of Object.entries(managed)) {
      const keys = ['devin.acp.agentEnv', 'devin-cli', key];
      if (permitted(keys) && Object.hasOwn(saved, key) && !receipt.changes.some(change => JSON.stringify(change.path) === JSON.stringify(keys))) {
        remember(receipt, keys, valueAt(snapshot, keys), value, saved[key] == null ? { exists: false } : { exists: true, value: saved[key] });
      }
    }
    saveReceipt(receipt);
    const restored = restoreObject(snapshot, receipt.changes);
    for (const key of ['agentEnv', 'agentPreferences']) if (JSON.stringify(snapshot['devin.acp.' + key]) !== JSON.stringify(restored.value['devin.acp.' + key])) {
      await settings.update(key, restored.value['devin.acp.' + key], vscode.ConfigurationTarget.Global);
    }
    receipt.changes = []; saveReceipt(receipt);
    await context.globalState.update('savedEnv', undefined);
    await context.globalState.update('managedEnv', undefined);
    vscode.window.showInformationMessage('Fusion BYOK 已停用，原生连接已恢复。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('devinFusionByok.disable', run(disable)));
  const reconcileSelection = async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const preferences = globalSetting(settings, 'agentPreferences'), current = preferences['devin-cli']?.model;
    if (!/^(?:fusion-)?dfbyok-/.test(current || '') || catalog().models.some(model => model.uid === current)) return;
    const receipt = readReceipt(root, context.extensionPath);
    const changes = receipt.changes.filter(change => change.path[0] === 'devin.acp.agentPreferences');
    const restored = restoreObject({ 'devin.acp.agentPreferences': preferences }, changes).value['devin.acp.agentPreferences'];
    if (/^(?:fusion-)?dfbyok-/.test(restored['devin-cli']?.model || '')) delete restored['devin-cli'].model;
    await settings.update('agentPreferences', restored, vscode.ConfigurationTarget.Global);
  };
  const statusBar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 20);
  if (statusBar) {
    statusBar.text = 'Fusion BYOK'; statusBar.tooltip = '管理供应商、模型列表与 Fusion 组合';
    statusBar.command = 'devinFusionByok.openPanel'; statusBar.show(); context.subscriptions.push(statusBar);
  }
  manager = createManager({ read: config, write: current => writeConfig(configFile, current),
    nativeModels: () => [...nativeModels.values()], refreshNativeModels, nativeCatalogStatus: () => nativeCatalogStatus,
    autoContinueStatus: () => autoContinue ? (autoContinue.status().connections > 0 ? 'attached' : 'waiting') : 'unavailable',
    selectedFusion: () => {
      const current = globalSetting(vscode.workspace.getConfiguration('devin.acp'), 'agentPreferences')['devin-cli']?.model;
      if (typeof current === 'string' && current.startsWith('fusion-')) return current;
      return rememberedFusion() || current || '';
    },
    selectFusion: saveFusionChoice,
    afterChange: async type => {
      if (type === 'setEnabled' && config().enabled === false) await disable();
      else if (type === 'setAutoContinue' || type === 'setAutoContinueUntilPlanComplete') resetAutoContinue?.();
      else if (config().enabled !== false) { await ensureEnabled(); await reconcileSelection(); }
    } });
  management = require('./panel/controller.cjs').createPanelController({ vscode, context, manager, safeError });
  let lastAutoError = config().autoContinueOnProviderError === true;
  let lastAutoPlan = config().autoContinueUntilPlanComplete === true;
  const onConfigChanged = () => {
    try {
      const currentConfig = config();
      const currentAutoError = currentConfig.autoContinueOnProviderError === true;
      const currentAutoPlan = currentConfig.autoContinueUntilPlanComplete === true;
      if (currentAutoError !== lastAutoError || currentAutoPlan !== lastAutoPlan) {
        lastAutoError = currentAutoError;
        lastAutoPlan = currentAutoPlan;
        resetAutoContinue?.();
      }
      if (currentConfig.enabled === false) void teardown().catch(() => log('disable-cleanup-error'));
      else {
        void ensureEnabled().catch(error => { const safe = safeError(error); if (safe.code !== 'cancelled') log('error', { code: safe.code }); });
        void reconcilePreference();
      }
      void management.publish()?.catch(() => {});
    }
    catch { log('configuration-read-error'); }
  };
  fs.watchFile(configFile, { interval: 500, persistent: false }, onConfigChanged);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(configFile, onConfigChanged) });
  const preferenceSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
    if (typeof event?.affectsConfiguration === 'function' && !event.affectsConfiguration('devin.acp.agentPreferences')) return;
    return reconcilePreference();
  });
  if (preferenceSubscription) context.subscriptions.push(preferenceSubscription);
  if (config().enabled !== false) await run(ensureEnabled)();
  return { status: () => connection?.status, autoContinue: () => autoContinue?.status() };
}
async function teardown() { resetAutoContinue?.(); stopNativeSync?.(); stopNativeSync = undefined; activationGeneration++; runtimeWaitAbort?.abort(); reconcileHalted = true; if (connection) { const current = connection; connection = undefined; await current.dispose(); } }
async function deactivate() { activationDisposed = true; stopAutoContinue?.(); stopAutoContinue = undefined; await teardown(); }
module.exports = { activate, deactivate, ensureBackend, safeError };
