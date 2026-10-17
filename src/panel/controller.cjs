'use strict';
const crypto = require('node:crypto');
const { renderPanel } = require('./view.cjs');
const { PanelInputError } = require('./model.cjs');
function createPanelController({ vscode, context, manager, safeError, updater, restartApp, fastContext, readMonitor = async () => ({ status: 'unsupported', snapshot: null }) }) {
  let panel;
  let monitorPending = false;
  const refreshMonitor = async () => {
    if (!panel || panel.visible === false || monitorPending) return;
    const target = panel;
    monitorPending = true;
    try {
      let result;
      try { result = await readMonitor(); } catch { result = { status: 'unavailable', snapshot: null }; }
      if (panel === target) await target.webview.postMessage({ type: 'monitor-state', result });
    } finally { monitorPending = false; }
  };
  let disposed = false;
  let lastState;
  const postState = async (target, state) => {
    if (target !== panel) return false;
    const encoded = JSON.stringify(state);
    if (encoded === lastState) return true;
    lastState = encoded;
    return target.webview.postMessage({ type: 'state', state });
  };
  const publishUpdates = () => panel && updater ? panel.webview.postMessage({ type: 'update-state', state: updater.snapshot() }) : undefined;
  const publish = () => panel ? postState(panel, manager.state()) : undefined;
  const FAST_CONTEXT_ERRORS = { fast_context_root_not_allowed: '只能选择已打开的项目或在此处选择的文件夹。',
    fast_context_root_missing: '该文件夹不存在或无法访问，请重新选择。', fast_context_untrusted: '请先信任工作区，再复制 Fast Context 配置。',
    fast_context_check_required: '请先检测账号，确认代码搜索可用后再开启。', fast_context_not_enabled: '对外 MCP 还没有开启。',
    fast_context_unavailable: '当前环境无法保存开关状态。' };
  const FAST_CONTEXT_COPIED = { prompt: '提示词已复制，粘贴给其他 Harness 里的 Agent 即可。', json: '配置 JSON 已复制。' };
  async function handleFastContext(target, message) {
    const post = value => target.webview.postMessage(value);
    if (!fastContext) { await post({ type: 'fast-context-result', ok: false, text: '当前环境不支持 Fast Context 配置。' }); return; }
    const kind = Object.hasOwn(FAST_CONTEXT_COPIED, message.payload?.kind) ? message.payload.kind : 'prompt';
    let selected;
    try {
      if (message.type === 'fastContext.check') {
        const result = await fastContext.selfCheck();
        await post({ type: 'fast-context-result', check: true, ok: result.ok, text: fastContext.checkMessage(result.reason) });
      } else if (message.type === 'fastContext.enable') {
        await fastContext.setEnabled(message.payload?.enabled === true);
      } else if (message.type === 'fastContext.preview') {
        await post({ type: 'fast-context-preview', kind, root: message.payload?.root, text: fastContext.preview(kind, message.payload?.root) });
        return;
      } else if (message.type === 'fastContext.pick') selected = await fastContext.pick() || undefined;
      else if (message.type === 'fastContext.copy') {
        await fastContext.copy(kind, message.payload?.root);
        await post({ type: 'fast-context-result', ok: true, text: FAST_CONTEXT_COPIED[kind] });
      } else if (message.type !== 'fastContext.state') return;
    } catch (error) {
      const text = FAST_CONTEXT_ERRORS[error?.message] || safeError(error).message;
      if (message.type === 'fastContext.preview') { await post({ type: 'fast-context-preview', kind, root: message.payload?.root, text: '', error: text }); return; }
      await post({ type: 'fast-context-result', check: message.type === 'fastContext.check', enable: message.type === 'fastContext.enable', ok: false, text });
    }
    await post({ type: 'fast-context-state', state: fastContext.state(), selected });
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); void publish(); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.management', 'Fusion BYOK 控制面板', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    lastState = undefined;
    const current = panel;
    panel.webview.html = renderPanel({ nonce: crypto.randomBytes(24).toString('base64'), cspSource: panel.webview.cspSource });
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.id !== 'string' || message.id.length > 100 || typeof message.type !== 'string') return;
      if (message.type === 'monitor.refresh') { await refreshMonitor(); return; }
      if (message.type.startsWith('fastContext.')) { await handleFastContext(current, message); return; }
      try {
        if (message.type === 'app.restart') {
          if (typeof restartApp !== 'function') throw new PanelInputError('当前环境不支持重启 Devin。');
          const choice = await vscode.window.showWarningMessage('重启 Devin 会关闭所有窗口，并中断正在进行的对话。确定现在重启吗？', { modal: true }, '重启');
          if (choice === '重启') {
            try { await restartApp(); }
            catch { throw new PanelInputError('无法自动重启 Devin，请手动退出后重新打开。'); }
          }
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true, cancelled: choice !== '重启' });
          return;
        }
        if (message.type === 'goal.open') {
          await vscode.commands.executeCommand('devinFusionByok.goal');
          await current.webview.postMessage({ type: 'result', id: message.id, ok: true });
          return;
        }
        if (message.type.startsWith('update.') && updater) {
          if (message.type === 'update.check') await updater.check({ force: true });
          else if (message.type === 'update.install') await updater.installUpdate();
          else if (message.type === 'update.ignore') await updater.ignore();
          else if (message.type === 'update.auto' && typeof message.payload?.enabled === 'boolean') await updater.setAutoCheck(message.payload.enabled);
          else if (message.type === 'update.release') await vscode.env.openExternal(vscode.Uri.parse(updater.snapshot().releaseUrl));
          await publishUpdates();
          return;
        }
        const state = await manager.dispatch(message.type, message.payload);
        await postState(current, state);
        await current.webview.postMessage({ type: 'result', id: message.id, ok: true });
      } catch (error) {
        const text = error instanceof PanelInputError ? error.message : safeError(error).message;
        await current.webview.postMessage({ type: 'result', id: message.id, ok: false, error: text });
        try { await postState(current, manager.state()); } catch {}
      }
    });
    const timer = setInterval(() => { void refreshMonitor().catch(() => {}); }, 5000);
    timer.unref?.();
    void refreshMonitor().catch(() => {});
    const closing = panel.onDidDispose(() => { clearInterval(timer); messages.dispose(); closing.dispose(); if (panel === current) panel = undefined; });
  }
  context.subscriptions.push({ dispose() { disposed = true; panel?.dispose(); } });
  return { open, publish, publishUpdates };
}
module.exports = { createPanelController };
