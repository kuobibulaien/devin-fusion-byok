'use strict';
const { modelSupportsImages } = require('../model-capabilities.cjs');
const { normalizeBaseUrlPath } = require('./base-url.cjs');
const { monitorMarkup, monitorScript } = require('./monitor-view.cjs');
const { updateMarkup, updateScript } = require('./update-view.cjs');

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const TABS = [['presets', '预设'], ['models', '模型'], ['usage', '用量'], ['settings', '设置']];

function renderPanel({ nonce, cspSource }) {
  const safeNonce = escapeAttribute(nonce);
  const tabs = TABS.map(([id, label], index) => `<button id="tab-${id}" class="tab" type="button" role="tab" aria-controls="view-${id}" aria-selected="${index === 0}" data-tab="${id}">${label}</button>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}'; img-src ${escapeAttribute(cspSource || "'none'")}; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';">
  <title>Fusion BYOK</title>
  <style nonce="${safeNonce}">
    :root { color-scheme: light dark; --border: var(--vscode-panel-border, #454545); --muted: var(--vscode-descriptionForeground, #999); --accent: var(--vscode-button-background, #0e639c); --hover: var(--vscode-list-hoverBackground, #2a2d2e); --warn: var(--vscode-editorWarning-foreground, #cca700); --error: var(--vscode-errorForeground, #f48771); --ok: var(--vscode-testing-iconPassed, #73c991); --bg: var(--vscode-editor-background, #1e1e1e); }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0 24px 72px; color: var(--vscode-foreground, #ddd); background: var(--bg); font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
    main { max-width: 960px; margin: 0 auto; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 16px; font-weight: 600; }
    h2 { font-size: 14px; font-weight: 600; }
    h3 { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    button, input, select { font: inherit; }
    button, input, select { border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
    button { min-height: 28px; padding: 3px 12px; color: var(--vscode-button-foreground, #fff); background: var(--accent); cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    button.secondary { color: var(--vscode-button-secondaryForeground, #ddd); background: var(--vscode-button-secondaryBackground, #3a3d41); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    button.quiet { color: var(--vscode-textLink-foreground, #80bfff); background: transparent; border-color: transparent; padding: 2px 6px; }
    button.quiet:hover { background: var(--hover); }
    button.danger { color: var(--error); background: transparent; border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
    button:disabled, input:disabled, select:disabled { opacity: .5; cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    input:not([type="checkbox"]), select { min-height: 30px; padding: 4px 8px; color: var(--vscode-input-foreground, #ddd); background: var(--vscode-input-background, #3c3c3c); width: 100%; }
    input::placeholder { color: var(--vscode-input-placeholderForeground, #999); }
    input[readonly] { opacity: .7; }
    input[type="checkbox"] { margin: 0; width: 14px; height: 14px; flex: none; accent-color: var(--accent); }
    input.switch[type="checkbox"] { appearance: none; -webkit-appearance: none; width: 32px; height: 18px; border-radius: 9px; position: relative; cursor: pointer; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--border); }
    input.switch[type="checkbox"]::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-foreground, #ddd); transition: left .12s ease; }
    input.switch[type="checkbox"]:checked { background: var(--accent); border-color: var(--accent); }
    input.switch[type="checkbox"]:checked::after { left: 16px; background: var(--vscode-button-foreground, #fff); }
    [hidden] { display: none !important; }
    .muted, .hint { color: var(--muted); }
    .hint { font-size: 12px; }
    .warn { display: block; color: var(--warn); font-size: 12px; }
    .mb { margin-bottom: 10px; }
    .mt { margin-top: 12px; }
    .spacer { flex: 1; }
    .topbar { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--border); margin: 0 -24px 20px; padding: 14px 24px 0; }
    .topbar-row .actions { gap: 14px; }
    .topbar-row { max-width: 960px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .tabs { max-width: 960px; margin: 10px auto 0; display: flex; gap: 4px; }
    .tab { background: transparent; color: var(--muted); border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 12px 8px; min-height: 0; }
    .tab:hover { background: transparent; color: var(--vscode-foreground, #ddd); }
    .tab[aria-selected="true"] { color: var(--vscode-foreground, #ddd); border-bottom-color: var(--accent); }
    .toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; }
    .banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; margin-bottom: 16px; border: 1px solid var(--warn); border-radius: 6px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; min-height: 28px; }
    .list { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; min-height: 48px; }
    .row.compact { min-height: 0; padding: 6px 14px; }
    label.row { cursor: pointer; }
    .row + .row, .row + details, details > .row { border-top: 1px solid var(--border); }
    .row-main { flex: 1; min-width: 0; }
    .row-title { display: block; overflow-wrap: anywhere; }
    .row-sub { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    button.link-title { display: block; padding: 0; min-height: 0; border: 0; background: transparent; color: inherit; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    button.link-title:hover { background: transparent; text-decoration: underline; }
    .badge { font-size: 11px; padding: 1px 8px; border-radius: 9px; background: var(--accent); color: var(--vscode-button-foreground, #fff); white-space: nowrap; }
    .preset.current { box-shadow: inset 3px 0 0 var(--accent); }
    .plus { color: var(--muted); margin: 0 6px; }
    .empty { padding: 32px 16px; text-align: center; color: var(--muted); }
    .empty button { margin-top: 12px; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; align-items: center; }
    .toolbar input[type="search"] { flex: 1 1 200px; width: auto; }
    .models-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; align-items: start; }
    .provider-nav { display: grid; gap: 2px; }
    button.provider-item { display: block; text-align: left; width: 100%; padding: 8px 10px; white-space: normal; color: inherit; background: transparent; border-color: transparent; }
    button.provider-item:hover { background: var(--hover); }
    button.provider-item.selected { background: var(--vscode-list-inactiveSelectionBackground, #37373d); }
    .provider-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; min-height: 28px; }
    .scroll { max-height: 440px; overflow: auto; }
    details.fold > summary { cursor: pointer; padding: 8px 14px; color: var(--muted); list-style: none; }
    details.fold > summary::-webkit-details-marker { display: none; }
    details.fold > summary::before { content: '▸ '; }
    details.fold[open] > summary::before { content: '▾ '; }
    details.group { border: 1px solid var(--border); border-radius: 6px; margin-top: 12px; }
    details.group > summary { cursor: pointer; padding: 12px 14px; font-weight: 600; list-style: none; display: flex; justify-content: space-between; gap: 12px; }
    details.group > summary::-webkit-details-marker { display: none; }
    details.group > summary::after { content: '▸'; color: var(--muted); font-weight: 400; }
    details.group[open] > summary::after { content: '▾'; }
    details.group > summary .hint { font-weight: 400; margin-left: auto; }
    .group-body { padding: 0 14px 14px; }
    .role-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; }
    .setting + .setting { border-top: 1px solid var(--border); }
    .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20; max-width: min(560px, calc(100vw - 32px)); display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--vscode-editorWidget-background, #252526); box-shadow: 0 4px 16px var(--vscode-widget-shadow, #0006); }
    .toast[data-tone="error"] { border-color: var(--vscode-inputValidation-errorBorder, #be1100); color: var(--error); }
    .toast[data-tone="success"] { color: var(--ok); }
    .monitor-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
    .monitor-controls select { width: auto; max-width: 320px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-bottom: 16px; }
    .tile { padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; min-width: 0; }
    .tile-value { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
    .tile-label { display: block; font-size: 11px; color: var(--muted); }
    .monitor-table-wrap { overflow: auto; max-height: 480px; border: 1px solid var(--border); border-radius: 6px; }
    .monitor-table { border-collapse: collapse; white-space: nowrap; width: 100%; font-variant-numeric: tabular-nums; }
    .monitor-table td, .monitor-table th { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; }
    .monitor-table th { position: sticky; top: 0; background: var(--bg); font-weight: 500; color: var(--muted); }
    #usage-monitor:not(.detailed) .extra { display: none; }
    .update-notes { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 8px 0 0; }
    dialog { width: min(500px, calc(100vw - 28px)); max-height: calc(100vh - 40px); overflow: auto; margin: auto; padding: 20px; border: 1px solid var(--border); border-radius: 8px; color: var(--vscode-foreground, #ddd); background: var(--bg); box-shadow: 0 8px 28px var(--vscode-widget-shadow, #0006); }
    dialog::backdrop { background: #0007; }
    dialog h2 { font-size: 16px; margin-bottom: 16px; }
    .field { display: block; margin-bottom: 12px; }
    .field-title { display: block; margin-bottom: 4px; }
    .field .hint { display: block; margin-top: 4px; }
    .url-preview { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); }
    .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    dialog details.fold > summary { padding: 4px 0; margin-bottom: 8px; }
    .dialog-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
    .dialog-error { color: var(--error); overflow-wrap: anywhere; }
    .confirm-text { white-space: pre-line; overflow-wrap: anywhere; }
    .import-picker .scroll { max-height: min(320px, 40vh); }
    @media (max-width: 700px) {
      body { padding: 0 16px 72px; }
      .topbar { margin: 0 -16px 16px; padding: 12px 16px 0; }
      .models-layout, .role-grid { grid-template-columns: 1fr; }
      .provider-nav { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
      .field-grid { grid-template-columns: 1fr; gap: 0; }
    }
  </style>
</head>
<body>
  <main id="main" aria-busy="true">
    <header class="topbar">
      <div class="topbar-row"><h1>Fusion BYOK</h1><div class="actions"><button id="restart-devin" class="secondary" type="button" title="插件改动或模型列表没有自动更新时使用。会关闭所有窗口并中断正在进行的对话。">重启 Devin</button><label class="toggle"><span class="muted">启用</span><input id="plugin-enabled" class="switch" type="checkbox" role="switch" aria-label="启用插件" disabled></label></div></div>
      <nav class="tabs" role="tablist" aria-label="面板分区">${tabs}</nav>
    </header>
    <div id="disabled-banner" class="banner" hidden><span>插件已停用，导入的模型和预设不会出现在新对话里。</span><button id="enable-now" type="button">启用</button></div>
    <section id="view-presets" role="tabpanel" aria-labelledby="tab-presets"><div id="fusion"><div class="empty">正在读取配置…</div></div></section>
    <section id="view-models" role="tabpanel" aria-labelledby="tab-models" hidden>
      <div class="models-layout">
        <div><div class="section-head"><h2>供应商</h2><button id="add-provider" class="quiet" type="button" disabled>添加</button></div><nav id="providers" class="provider-nav" aria-label="供应商列表"></nav></div>
        <div id="models"></div>
      </div>
    </section>
    <section id="view-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>${monitorMarkup()}</section>
    <section id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
      <div id="settings-general"></div>
      <details id="role-group" class="group"><summary>预设可选模型<span id="role-count" class="hint"></span></summary><div class="group-body"><p class="hint mb">新建预设时，下拉框只列出这里打开的模型。</p><div class="role-grid"><div id="role-lead"></div><div id="role-sidekick"></div></div></div></details>
      <details id="native-group" class="group"><summary>官方模型显示<span id="native-count" class="hint"></span></summary><div class="group-body" id="native-models"></div></details>
      ${updateMarkup()}
    </section>
  </main>
  <div id="status" class="toast" role="status" aria-live="polite" hidden></div>
  <dialog id="editor-dialog" aria-labelledby="dialog-title"></dialog>
  <script nonce="${safeNonce}">const vscode = acquireVsCodeApi(); (${panelClient.toString()})(${modelSupportsImages.toString()}, vscode, ${normalizeBaseUrlPath.toString()}); ${monitorScript()} ${updateScript()}</script>
</body>
</html>`;
}

function panelClient(modelSupportsImages, vscode, normalizeBaseUrlPath) {
  'use strict';
  const byId = id => document.getElementById(id);
  const pending = new Map();
  const saved = vscode.getState() || {};
  const TAB_IDS = ['presets', 'models', 'usage', 'settings'];
  let serial = 0;
  let state;
  let busy = false;
  let providerId = saved.providerId || '';
  let tab = saved.tab || 'presets';
  let modelSearch = '';
  let nativeSearch = '';
  let toastTimer;
  const roleSearch = { lead: '', sidekick: '' };
  const roleMoreOpen = { lead: false, sidekick: false };

  function element(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value ?? '');
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'readOnly' || key === 'hidden' || key === 'open') node[key] = Boolean(value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function button(text, action, variant = 'secondary') {
    return element('button', { type: 'button', text, class: variant, onclick: action });
  }

  // A switch saves immediately and flips back when the host rejects the change.
  function switchInput(checked, label, save, disabled = false) {
    return element('input', { type: 'checkbox', role: 'switch', class: 'switch', checked, disabled, 'aria-label': label,
      onchange: event => {
        const value = event.target.checked;
        Promise.resolve(save(value)).then(ok => { if (ok === false) event.target.checked = !value; });
      } });
  }

  function remember() { vscode.setState({ providerId, tab }); }

  function notice(message, tone) {
    const node = byId('status');
    clearTimeout(toastTimer);
    node.replaceChildren();
    node.dataset.tone = tone || '';
    node.hidden = !message;
    if (!message) return;
    node.append(element('span', { text: message }));
    if (tone === 'error') node.append(element('button', { type: 'button', class: 'quiet', text: '×', 'aria-label': '关闭提示', onclick: () => notice('') }));
    if (tone === 'success') toastTimer = setTimeout(() => notice(''), 2500);
  }

  const controls = () => document.querySelectorAll('main button:not(.tab), main input, main select');

  function setBusy(value) {
    busy = value;
    byId('main').setAttribute('aria-busy', String(value));
    for (const node of controls()) {
      if (value) {
        node.dataset.wasDisabled = String(node.disabled);
        node.disabled = true;
      } else if (node.dataset.wasDisabled != null) {
        node.disabled = node.dataset.wasDisabled === 'true';
        delete node.dataset.wasDisabled;
      }
    }
  }

  function request(type, payload = {}) {
    const id = 'panel-' + Date.now() + '-' + (++serial);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('操作等待超时，请稍后重试。'));
      }, 90000);
      pending.set(id, { resolve, reject, timeout });
      vscode.postMessage({ id, type, payload });
    });
  }

  async function run(action, progress, success) {
    if (busy) return false;
    setBusy(true);
    notice(progress || '正在保存…');
    try {
      await action();
      notice(success || '已保存，新对话中生效。', 'success');
      return true;
    } catch (error) {
      notice(error.message || '操作失败，请重试。', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const off = () => state?.enabled === false;
  const currentProvider = () => state?.providers?.find(provider => provider.id === providerId);
  const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

  function showTab(next) {
    tab = TAB_IDS.includes(next) ? next : 'presets';
    remember();
    for (const node of document.querySelectorAll('.tab')) node.setAttribute('aria-selected', String(node.dataset.tab === tab));
    for (const id of TAB_IDS) byId('view-' + id).hidden = id !== tab;
    if (tab === 'usage') vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' });
  }

  function render() {
    if (!state) return;
    if (!state.providers.some(provider => provider.id === providerId)) providerId = state.providers[0]?.id || '';
    remember();
    byId('plugin-enabled').checked = !off();
    byId('plugin-enabled').disabled = false;
    byId('add-provider').disabled = false;
    byId('disabled-banner').hidden = !off();
    renderFusion();
    renderProviders();
    renderModels();
    renderGeneral();
    renderRoles();
    renderNative();
    if (busy) {
      for (const node of controls()) {
        node.dataset.wasDisabled = String(node.disabled);
        node.disabled = true;
      }
    }
  }

  function renderFusion() {
    const container = byId('fusion');
    container.replaceChildren();
    const presets = state.fusionPresets || [];
    const create = button('新建预设', () => presetDialog(), '');
    create.disabled = off();
    container.append(element('div', { class: 'section-head' }, element('h2', { text: '我的预设' }), presets.length ? create : null));
    if (state.migrationPending) container.append(element('p', { class: 'warn mb', text: '原默认组合暂时无法还原，请稍后刷新或新建预设。' }));
    if (!presets.length) {
      const hasModels = state.providers.some(provider => provider.models.length) || (state.nativeModels || []).length > 0;
      container.append(element('div', { class: 'list' }, element('div', { class: 'empty' },
        element('p', { text: hasModels ? '还没有预设。选一个 Lead 和一个 Sidekick，起个名字就好。' : '先添加供应商并导入模型，再来创建预设。' }),
        hasModels ? create : button('添加供应商', () => { showTab('models'); providerDialog(); }, ''))));
      return;
    }
    const list = element('div', { class: 'list' });
    for (const preset of presets) {
      const current = preset.uid === state.selectedFusionUid;
      const describe = (role, label) => label || preset[role]?.nativeUid || [preset[role]?.model, preset[role]?.effort].filter(Boolean).join(' · ') || '—';
      let action = null;
      if (current) action = element('span', { class: 'badge', text: '默认' });
      else if (preset.available) {
        action = button('设为默认', () => run(() => request('selectFusion', { uid: preset.uid }), '正在切换…', '已设为新对话的默认模型。'));
        action.disabled = off();
      }
      list.append(element('div', { class: 'row preset' + (current ? ' current' : '') },
        element('div', { class: 'row-main' },
          element('button', { type: 'button', class: 'link-title', text: preset.name, 'aria-label': '编辑预设 ' + preset.name, onclick: () => presetDialog(preset) }),
          element('span', { class: 'row-sub' }, describe('lead', preset.leadLabel), element('span', { class: 'plus', text: '+' }), describe('sidekick', preset.sidekickLabel)),
          preset.available ? null : element('span', { class: 'warn', text: preset.reason || '当前不可用' })),
        element('div', { class: 'actions' }, action, button('编辑', () => presetDialog(preset), 'quiet'))));
    }
    container.append(list);
  }

  function renderProviders() {
    const container = byId('providers');
    container.replaceChildren();
    if (!state.providers.length) {
      container.append(element('p', { class: 'hint', text: '还没有供应商。' }));
      return;
    }
    for (const provider of state.providers) {
      const on = provider.models.filter(model => model.enabled !== false).length;
      container.append(element('button', {
        type: 'button', class: 'provider-item' + (provider.id === providerId ? ' selected' : ''),
        'aria-current': provider.id === providerId ? 'true' : 'false',
        onclick: () => {
          if (busy || providerId === provider.id) return;
          providerId = provider.id;
          modelSearch = '';
          remember();
          renderProviders();
          renderModels();
        }
      }, element('span', { class: 'row-title', text: provider.name }),
      element('span', { class: 'row-sub', text: provider.enabled === false ? '已停用' : on + ' 个模型' })));
    }
  }

  function renderModels() {
    const container = byId('models');
    const provider = currentProvider();
    container.replaceChildren();
    if (!provider) {
      container.append(element('div', { class: 'list' }, element('div', { class: 'empty' },
        element('p', { text: '添加一个 OpenAI 或 Anthropic 兼容的 API，就能在 Devin 里用它的模型。' }),
        button('添加供应商', () => providerDialog(), ''))));
      return;
    }
    const format = { 'openai-responses': 'Responses', anthropic: 'Anthropic Messages' }[provider.apiFormat] || 'Chat Completions';
    container.append(element('div', { class: 'provider-head' },
      element('div', { class: 'row-main' }, element('h2', { text: provider.name }),
        element('span', { class: 'row-sub', text: hostOf(provider.baseUrl) + ' · ' + format + (provider.keyConfigured ? '' : ' · 未填密钥') })),
      element('div', { class: 'actions' },
        switchInput(provider.enabled !== false, '启用供应商 ' + provider.name,
          value => run(() => request('setProviderEnabled', { id: provider.id, enabled: value }))),
        button('编辑', () => providerDialog(provider), 'quiet'))));
    if (provider.enabled === false) container.append(element('p', { class: 'warn mb', text: '已停用，这里的模型不会出现在新对话里。' }));
    const search = element('input', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索导入的模型',
      oninput: event => { modelSearch = event.target.value; renderModelRows(); } });
    search.value = modelSearch;
    const importButton = button('导入模型', () => run(async () => {
      await request('refreshModels', { providerId: provider.id });
      importDialog(provider.id);
    }, '正在获取模型列表…', '请勾选要导入的模型。'), '');
    container.append(element('div', { class: 'toolbar' }, provider.models.length ? search : element('span', { class: 'spacer' }),
      importButton, button('手动添加', () => modelDialog(provider))));
    container.append(element('div', { id: 'model-list', class: 'list scroll', 'aria-label': '模型列表' }));
    renderModelRows();
  }

  function visibleModels() {
    const query = modelSearch.trim().toLocaleLowerCase();
    return (currentProvider()?.models || []).filter(model => !query || (model.id + ' ' + (model.label || '')).toLocaleLowerCase().includes(query));
  }

  function renderModelRows() {
    const container = byId('model-list');
    if (!container) return;
    const provider = currentProvider();
    container.replaceChildren();
    const models = visibleModels();
    if (!models.length) {
      container.append(element('div', { class: 'empty', text: provider.models.length ? '没有匹配的模型。' : '还没有模型，点「导入模型」从供应商获取。' }));
      return;
    }
    if (models.length > 1) {
      const bulk = value => {
        const changes = models.filter(model => (model.enabled !== false) !== value).map(model => ({ id: model.id, enabled: value }));
        if (changes.length) run(() => request('updateModels', { providerId: provider.id, changes }));
      };
      container.append(element('div', { class: 'row compact' },
        element('span', { class: 'row-main hint', text: models.filter(model => model.enabled !== false).length + ' / ' + models.length + ' 已启用' }),
        button('全部启用', () => bulk(true), 'quiet'), button('全部停用', () => bulk(false), 'quiet')));
    }
    for (const model of models) {
      const name = model.label || model.id;
      container.append(element('div', { class: 'row' },
        element('div', { class: 'row-main' },
          element('button', { type: 'button', class: 'link-title', text: name, 'aria-label': '编辑模型 ' + name, onclick: () => modelDialog(provider, model) }),
          name !== model.id ? element('span', { class: 'row-sub mono', text: model.id }) : null),
        switchInput(model.enabled !== false, '启用模型 ' + name,
          value => run(() => request('updateModels', { providerId: provider.id, changes: [{ id: model.id, enabled: value }] })))));
    }
  }

  function renderGeneral() {
    const container = byId('settings-general');
    container.replaceChildren();
    const setting = (title, sub, control) => element('div', { class: 'setting' },
      element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: title }), sub ? element('span', { class: 'row-sub', text: sub }) : null), control);
    const status = state.autoContinueStatus === 'attached' ? null
      : state.autoContinueStatus === 'waiting' ? '还没连上会话：重新加载窗口并新建对话后生效。'
      : '自动继续当前不可用，请查看插件输出日志。';
    container.append(element('div', { class: 'section-head' }, element('h2', { text: '自动继续' })),
      element('div', { class: 'list' },
        setting('服务商出错时自动重试', '临时错误打断回复时自动发送 continue。按量计费的服务商可能多扣费。',
          switchInput(state.autoContinueOnProviderError === true, '服务商出错时自动重试',
            value => run(() => request('setAutoContinue', { enabled: value })), off())),
        setting('待办没做完时自动继续', '会话里还有未完成的 Plan 时自动推进，随时可以手动停止。',
          switchInput(state.autoContinueUntilPlanComplete === true, '待办没做完时自动继续',
            value => run(() => request('setAutoContinueUntilPlanComplete', { enabled: value })), off()))),
      element('p', { class: 'warn mt', text: status || '', hidden: !status }));
  }

  function renderRoles() {
    const lists = state.roleLists || {};
    const on = role => (lists[role] || []).filter(item => item.selected).length;
    byId('role-count').textContent = 'Lead ' + on('lead') + ' · Sidekick ' + on('sidekick');
    for (const role of ['lead', 'sidekick']) {
      const container = byId('role-' + role);
      const name = role === 'lead' ? 'Lead' : 'Sidekick';
      container.replaceChildren();
      const search = element('input', { type: 'search', placeholder: '搜索', 'aria-label': '搜索 ' + name + ' 模型',
        oninput: event => { roleSearch[role] = event.target.value; renderRoleRows(role); } });
      search.value = roleSearch[role];
      container.append(element('h3', { text: name }), element('div', { class: 'toolbar' }, search),
        element('div', { id: role + '-role-list', class: 'list scroll', 'aria-label': name + ' 模型列表' }));
      renderRoleRows(role);
    }
  }

  function renderRoleRows(role) {
    const container = byId(role + '-role-list');
    if (!container) return;
    const name = role === 'lead' ? 'Lead' : 'Sidekick';
    const query = roleSearch[role].trim().toLocaleLowerCase();
    const list = state.roleLists?.[role] || [];
    const rows = list.filter(item => !query || item.label.toLocaleLowerCase().includes(query));
    container.replaceChildren();
    const row = item => element('div', { class: 'row' },
      element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: item.label }),
        item.native ? element('span', { class: 'row-sub', text: '官方' }) : null),
      item.available ? switchInput(item.selected === true, '在 ' + name + ' 中启用 ' + item.label,
        value => run(() => request('setRoleModel', { role, model: item.ref, enabled: value })), off())
        : element('span', { class: 'hint', text: item.reason || '不可用' }));
    const main = query ? rows : rows.filter(item => !item.native || item.defaultSelected || item.selected || item.explicitIncluded);
    const extra = query ? [] : rows.filter(item => item.native && !item.defaultSelected && !item.selected && !item.explicitIncluded);
    for (const item of main) container.append(row(item));
    if (extra.length) {
      const details = element('details', { class: 'fold', open: roleMoreOpen[role] }, element('summary', { text: '更多官方模型（' + extra.length + '）' }));
      details.addEventListener('toggle', () => { roleMoreOpen[role] = details.open; });
      for (const item of extra) details.append(row(item));
      container.append(details);
    }
    if (!rows.length) container.append(element('div', { class: 'empty', text: list.length ? '没有匹配的模型。' : '暂无可选模型。' }));
  }

  function renderNative() {
    const container = byId('native-models');
    container.replaceChildren();
    const all = state.nativeModels || [];
    byId('native-count').textContent = all.length ? all.filter(model => !model.hidden).length + ' / ' + all.length + ' 显示中' : '';
    const search = element('input', { type: 'search', placeholder: '搜索官方模型', 'aria-label': '搜索官方模型',
      oninput: event => { nativeSearch = event.target.value; renderNativeRows(); } });
    search.value = nativeSearch;
    container.append(element('p', { class: 'hint mb', text: '关掉的模型只在本机列表里隐藏，不影响账号。' }),
      element('div', { class: 'toolbar' }, search, button('刷新', () => run(() => request('refreshNativeModels'), '正在同步官方模型…', '已同步。'))),
      element('div', { id: 'native-list', class: 'list scroll', 'aria-label': '官方模型列表' }));
    renderNativeRows();
  }

  function renderNativeRows() {
    const container = byId('native-list');
    if (!container) return;
    container.replaceChildren();
    const all = state.nativeModels || [];
    const query = nativeSearch.trim().toLocaleLowerCase();
    const models = all.filter(model => !query || (model.uid + ' ' + (model.label || '')).toLocaleLowerCase().includes(query));
    if (!models.length) {
      container.append(element('div', { class: 'empty', text: all.length ? '没有匹配的模型。' : ({ loading: '正在同步官方模型…', unsupported: '当前后台版本暂不支持同步。', unavailable: '无法连接本地后台，请点刷新重试。', empty: '还没收到官方模型，打开一次 Devin 的模型选择器后再刷新。' }[state.nativeCatalogStatus] || '还没收到官方模型，请点刷新重试。') }));
      return;
    }
    for (const model of models) {
      const note = model.disabled ? '官方暂不可用' : model.eligible === true ? '' : '不能用于预设';
      container.append(element('div', { class: 'row' },
        element('div', { class: 'row-main' }, element('span', { class: 'row-title', text: model.label || model.uid }),
          element('span', { class: 'row-sub mono', text: model.uid + (note ? ' · ' + note : '') })),
        switchInput(model.hidden !== true, '在列表中显示官方模型 ' + model.uid,
          show => run(() => request('setNativeModelHidden', { uid: model.uid, hidden: !show })), off())));
    }
  }

  function openDialog(title) {
    const dialog = byId('editor-dialog');
    if (dialog.open) dialog.close();
    dialog.replaceChildren(element('h2', { id: 'dialog-title', text: title }));
    const form = element('form', { autocomplete: 'off' });
    dialog.append(form);
    return { dialog, form };
  }

  function field(label, control, hint) {
    return element('label', { class: 'field' }, element('span', { class: 'field-title', text: label }), control,
      hint ? element('span', { class: 'hint', text: hint }) : null);
  }

  function input(value, attributes = {}) {
    const node = element('input', { type: 'text', ...attributes });
    node.value = value == null ? '' : String(value);
    return node;
  }

  function finishDialog(dialog, form, submitText, onSubmit, extraButton, successText) {
    const error = element('p', { class: 'dialog-error', role: 'alert' });
    const cancel = button('取消', () => dialog.close());
    const submit = element('button', { type: 'submit', text: submitText });
    form.append(error, element('div', { class: 'dialog-actions' }, extraButton || null, element('span', { class: 'spacer' }), cancel, submit));
    let saving = false;
    const preventCancelWhileSaving = event => { if (saving) event.preventDefault(); };
    dialog.addEventListener('cancel', preventCancelWhileSaving);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('cancel', preventCancelWhileSaving);
      for (const node of form.querySelectorAll('input[type="password"]')) node.value = '';
    }, { once: true });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || busy || !form.reportValidity()) return;
      saving = true;
      error.textContent = '';
      const locked = [...form.querySelectorAll('input, select, button')].map(node => [node, node.disabled]);
      for (const [node] of locked) node.disabled = true;
      setBusy(true);
      try {
        await onSubmit();
        dialog.close();
        notice(successText || '已保存，新对话中生效。', 'success');
      } catch (failure) {
        error.textContent = failure.message || '保存失败，请重试。';
      } finally {
        saving = false;
        for (const [node, disabled] of locked) node.disabled = disabled;
        setBusy(false);
      }
    });
    dialog.showModal();
    return submit;
  }

  function confirmDialog(title, message, onConfirm) {
    const { dialog, form } = openDialog(title);
    form.append(element('p', { class: 'confirm-text', text: message }));
    finishDialog(dialog, form, '删除', onConfirm, null, '已删除。').classList.add('danger');
  }

  // Deleting lives inside each editor so list rows stay uncluttered.
  function deleteButton(dialog, title, message, onConfirm) {
    return element('button', { type: 'button', class: 'danger', text: '删除', onclick: () => { dialog.close(); confirmDialog(title, message, onConfirm); } });
  }

  function importDialog(providerId) {
    const candidates = state.importCandidates;
    if (!candidates || candidates.providerId !== providerId) throw new Error('模型列表已失效，请重新获取。');
    const { dialog, form } = openDialog('导入模型');
    form.classList.add('import-picker');
    const selected = new Set();
    const search = input('', { type: 'search', placeholder: '搜索模型', 'aria-label': '搜索可导入的模型' });
    const list = element('div', { class: 'list scroll', 'aria-label': '可导入的模型列表' });
    const count = element('span', { class: 'hint', role: 'status' });
    let submit;
    const visible = () => {
      const query = search.value.trim().toLocaleLowerCase();
      return candidates.models.filter(model => (model.id + ' ' + model.label).toLocaleLowerCase().includes(query));
    };
    const updateCount = () => {
      count.textContent = '已选 ' + selected.size + ' / 共 ' + candidates.models.length;
      if (submit) submit.disabled = selected.size === 0;
    };
    const renderRows = () => {
      list.replaceChildren();
      for (const model of visible()) {
        const checkbox = element('input', { type: 'checkbox', checked: model.imported || selected.has(model.id), disabled: model.imported,
          onchange: event => { if (event.target.checked) selected.add(model.id); else selected.delete(model.id); updateCount(); } });
        list.append(element('label', { class: 'row' }, checkbox,
          element('span', { class: 'row-main' }, element('span', { class: 'row-title', text: model.label }),
            model.label !== model.id ? element('span', { class: 'row-sub mono', text: model.id }) : null),
          model.imported ? element('span', { class: 'hint', text: '已导入' }) : null));
      }
      if (!list.childElementCount) list.append(element('p', { class: 'empty', text: candidates.models.length ? '没有匹配的模型。' : '供应商没有返回模型。' }));
      updateCount();
    };
    search.addEventListener('input', renderRows);
    form.append(element('div', { class: 'toolbar' }, search),
      element('div', { class: 'toolbar' }, button('全选', () => {
        for (const model of visible()) if (!model.imported) selected.add(model.id);
        renderRows();
      }, 'quiet'), button('清空', () => { selected.clear(); renderRows(); }, 'quiet'), element('span', { class: 'spacer' }), count), list);
    submit = finishDialog(dialog, form, '导入', () => request('importModels', { providerId, token: candidates.token, ids: [...selected] }), null, '已导入。');
    renderRows();
  }

  function presetDialog(preset) {
    const { dialog, form } = openDialog(preset ? '编辑预设' : '新建预设');
    const name = input(preset?.name || '', { required: true, maxlength: 80, placeholder: '例如：日常开发' });
    form.append(field('名称', name));
    const selections = {};
    const key = ref => JSON.stringify([ref?.nativeUid || '', ref?.providerId || '', ref?.model || '', ref?.effort ?? null]);
    let missing = false;
    for (const role of ['lead', 'sidekick']) {
      const candidates = [...(state.presetCandidates?.[role] || [])];
      if (!candidates.length) missing = true;
      if (preset?.[role] && !candidates.some(item => key(item.ref) === key(preset[role]))) candidates.push({ ref: preset[role], label: '当前不可用：' + (preset[role].nativeUid || preset[role].model), unavailable: true });
      const title = role === 'lead' ? 'Lead 模型' : 'Sidekick 模型';
      const select = element('select', { required: true, 'aria-label': title });
      select.append(element('option', { value: '', text: '请选择' }));
      candidates.forEach((item, index) => select.append(element('option', { value: String(index), text: (item.ref.nativeUid ? '官方 · ' : '') + item.label, disabled: item.unavailable === true })));
      if (preset?.[role]) select.value = String(candidates.findIndex(item => key(item.ref) === key(preset[role])));
      form.append(field(title, select));
      selections[role] = () => select.value === '' ? null : candidates[Number(select.value)]?.ref;
    }
    if (missing) form.append(element('p', { class: 'hint', text: '下拉框是空的？先在「模型」里导入并启用模型。' }));
    const remove = preset ? deleteButton(dialog, '删除预设？', '只删除“' + preset.name + '”，不影响模型。',
      () => request('deleteFusionPreset', { id: preset.id })) : null;
    finishDialog(dialog, form, '保存', () => request('saveFusionPreset', {
      ...(preset ? { id: preset.id } : {}), name: name.value, lead: selections.lead(), sidekick: selections.sidekick(),
    }), remove);
  }

  function providerDialog(provider) {
    const { dialog, form } = openDialog(provider ? '编辑供应商' : '添加供应商');
    const name = input(provider?.name, { required: true, maxlength: 80, placeholder: '例如：OpenRouter' });
    const baseUrl = input(provider?.baseUrl, { type: 'url', required: true, placeholder: 'https://example.com/v1', spellcheck: 'false' });
    const apiFormat = element('select', { 'aria-label': 'API 类型' },
      element('option', { value: 'openai-responses', text: 'OpenAI Responses' }),
      element('option', { value: 'openai', text: 'OpenAI Chat Completions' }),
      element('option', { value: 'anthropic', text: 'Anthropic Messages' }));
    apiFormat.value = provider?.apiFormat || 'openai-responses';
    const apiKey = input('', { type: 'password', autocomplete: 'new-password', placeholder: provider?.keyConfigured ? '留空则不修改' : '', spellcheck: 'false' });
    const urlField = field('API 地址', baseUrl, '只填域名时会自动补上 /v1；地址里已写了 /v1（或 /v4、/v1beta 等版本号）就按原样使用。');
    const urlPreview = element('span', { class: 'hint url-preview' });
    urlField.append(urlPreview);
    const refreshPreview = () => {
      let url;
      try { url = new URL(baseUrl.value.trim()); } catch { url = null; }
      urlPreview.replaceChildren();
      if (!url || !['http:', 'https:'].includes(url.protocol)) return;
      const base = url.origin + normalizeBaseUrlPath(url.pathname);
      const path = { openai: '/chat/completions', anthropic: '/messages' }[apiFormat.value] || '/responses';
      urlPreview.append('实际请求：' + base + path, element('br'), '获取模型：' + base + '/models');
    };
    baseUrl.addEventListener('input', refreshPreview);
    apiFormat.addEventListener('change', refreshPreview);
    refreshPreview();
    form.append(field('名称', name), urlField, field('API 类型', apiFormat), field('API Key', apiKey));
    const remove = provider ? deleteButton(dialog, '删除供应商？', '会一并移除“' + provider.name + '”导入的模型和用到它的预设。',
      () => request('deleteProvider', { id: provider.id })) : null;
    finishDialog(dialog, form, '保存', () => {
      const payload = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), apiFormat: apiFormat.value };
      if (provider) payload.id = provider.id;
      if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
      return request('saveProvider', payload);
    }, remove);
  }

  function modelDialog(provider, model) {
    const { dialog, form } = openDialog(model ? '编辑模型' : '手动添加模型');
    const id = input(model?.id, { required: true, readOnly: Boolean(model), maxlength: 256, placeholder: '供应商的模型 ID', spellcheck: 'false' });
    const label = input(model?.label || '', { maxlength: 160, placeholder: '留空使用模型 ID' });
    const contextWindow = input(model?.contextWindow || 272000, { type: 'number', min: 1, step: 1, required: true });
    const maxOutputTokens = input(model?.maxOutputTokens || 131072, { type: 'number', min: 1, step: 1, required: true });
    const efforts = input((model?.efforts || []).join(', '), { placeholder: 'low, medium, high', spellcheck: 'false' });
    const effortMode = element('select', { 'aria-label': '思考档位' },
      element('option', { value: 'auto', text: '自动' }),
      element('option', { value: 'manual', text: '手动填写' }),
      element('option', { value: 'none', text: '不指定' }));
    effortMode.value = model?.effortMode || (model?.efforts?.length ? 'manual' : 'auto');
    const manual = field('档位列表', efforts, '用逗号分隔。');
    manual.hidden = effortMode.value !== 'manual';
    effortMode.addEventListener('change', () => { manual.hidden = effortMode.value !== 'manual'; });
    form.append(field('模型 ID', id), field('显示名称', label),
      element('details', { class: 'fold', open: effortMode.value === 'manual' }, element('summary', { text: '高级' }),
        element('div', { class: 'field-grid' }, field('上下文（tokens）', contextWindow), field('最大输出（tokens）', maxOutputTokens)),
        field('思考档位', effortMode, '自动：GPT/o 系列与较新的 Claude Opus/Sonnet 提供 Low、Medium、High、XHigh、Max，能否生效取决于供应商。'), manual));
    const remove = model ? deleteButton(dialog, '删除模型？', '从“' + provider.name + '”移除“' + (model.label || model.id) + '”，之后可以重新导入。',
      () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] })) : null;
    finishDialog(dialog, form, model ? '保存' : '添加', () => {
      const saved = { id: id.value.trim(), label: label.value.trim() || id.value.trim(),
        contextWindow: Number(contextWindow.value), maxOutputTokens: Number(maxOutputTokens.value), effortMode: effortMode.value,
        efforts: effortMode.value === 'auto' ? [] : [...new Set(efforts.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))] };
      if (model) return request('updateModels', { providerId: provider.id, changes: [{ ...saved, supportsImages: true }] });
      return request('addModel', { providerId: provider.id, model: { ...saved, enabled: true } });
    }, remove);
  }

  for (const node of document.querySelectorAll('.tab')) node.addEventListener('click', () => showTab(node.dataset.tab));
  byId('add-provider').addEventListener('click', () => providerDialog());
  const setEnabled = value => run(() => request('setEnabled', { enabled: value }), value ? '正在启用…' : '正在停用…', value ? '已启用。' : '已停用。');
  byId('plugin-enabled').addEventListener('change', event => {
    const value = event.target.checked;
    setEnabled(value).then(ok => { if (!ok) event.target.checked = !value; });
  });
  byId('enable-now').addEventListener('click', () => setEnabled(true));
  byId('restart-devin').addEventListener('click', async () => {
    if (busy) return;
    try {
      const result = await request('app.restart');
      if (!result?.cancelled) notice('正在重启 Devin…', 'success');
    } catch (error) { notice(error.message || '重启失败，请手动退出后重新打开 Devin。', 'error'); }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state' && message.state && Array.isArray(message.state.providers)) {
      const initial = !state;
      state = message.state;
      render();
      if (initial) byId('main').setAttribute('aria-busy', 'false');
    } else if (message.type === 'result') {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timeout);
      if (message.ok) operation.resolve({ cancelled: message.cancelled === true });
      else operation.reject(new Error(typeof message.error === 'string' ? message.error : '操作失败，请重试。'));
    }
  });
  showTab(tab);
  request('ready').catch(error => notice(error.message, 'error'));
}

module.exports = { renderPanel };
