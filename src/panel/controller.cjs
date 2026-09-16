'use strict';
const crypto = require('node:crypto');
const { renderPanel } = require('./view.cjs');
const { PanelInputError } = require('./model.cjs');
function createPanelController({ vscode, context, manager, safeError }) {
  let panel;
  let disposed = false;
  let lastState;
  const postState = async (target, state) => {
    if (target !== panel) return false;
    const encoded = JSON.stringify(state);
    if (encoded === lastState) return true;
    lastState = encoded;
    return target.webview.postMessage({ type: 'state', state });
  };
  const publish = () => panel ? postState(panel, manager.state()) : undefined;
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
      try {
        const state = await manager.dispatch(message.type, message.payload);
        await postState(current, state);
        await current.webview.postMessage({ type: 'result', id: message.id, ok: true });
      } catch (error) {
        const text = error instanceof PanelInputError ? error.message : safeError(error).message;
        await current.webview.postMessage({ type: 'result', id: message.id, ok: false, error: text });
        try { await postState(current, manager.state()); } catch {}
      }
    });
    const closing = panel.onDidDispose(() => { messages.dispose(); closing.dispose(); if (panel === current) panel = undefined; });
  }
  context.subscriptions.push({ dispose() { disposed = true; panel?.dispose(); } });
  return { open, publish };
}
module.exports = { createPanelController };
