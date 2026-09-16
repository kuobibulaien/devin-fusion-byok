'use strict';
const { modelSupportsImages } = require('../model-capabilities.cjs');

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderPanel({ nonce, cspSource }) {
  const safeNonce = escapeAttribute(nonce);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${safeNonce}'; script-src 'nonce-${safeNonce}'; img-src ${escapeAttribute(cspSource || "'none'")}; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';">
  <title>Fusion 模型管理</title>
  <style nonce="${safeNonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #1e1e1e); font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
    main { max-width: 1180px; margin: 0 auto; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -.4px; }
    h2 { font-size: 14px; font-weight: 600; }
    h3 { font-size: 13px; font-weight: 600; }
    button, input, select, textarea { font: inherit; }
    button, input, select, textarea { border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
    button { min-height: 29px; padding: 4px 11px; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    button.secondary { color: var(--vscode-button-secondaryForeground, #ddd); background: var(--vscode-button-secondaryBackground, #3a3d41); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    button.quiet { color: var(--vscode-textLink-foreground, #80bfff); background: transparent; border-color: transparent; padding: 2px 5px; min-height: 25px; }
    button.danger { color: var(--vscode-errorForeground, #f48771); background: transparent; border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
    button:disabled, input:disabled, select:disabled { opacity: .5; cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
    input:not([type="checkbox"]), select, textarea { min-height: 30px; padding: 5px 8px; color: var(--vscode-input-foreground, #ddd); background: var(--vscode-input-background, #3c3c3c); width: 100%; }
    input[type="checkbox"] { margin: 0; width: 14px; height: 14px; flex: 0 0 auto; accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background, #0e639c)); }
    input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground, #999); }
    input[readonly] { opacity: .7; }
    .page-head { display: flex; gap: 16px; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .muted, .hint { color: var(--vscode-descriptionForeground, #999); }
    .hint { font-size: 12px; }
    .page-description { margin-top: 5px; }
    .toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; white-space: nowrap; }
    .status { margin: 0 0 16px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border, #454545); border-radius: 4px; min-height: 37px; }
    .status[data-tone="error"] { color: var(--vscode-errorForeground, #f48771); border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
    .status[data-tone="success"] { color: var(--vscode-testing-iconPassed, #73c991); }
    .status[hidden], [hidden] { display: none !important; }
    .workspace { display: grid; grid-template-columns: 230px minmax(0, 1fr); align-items: start; gap: 18px; }
    .card { border: 1px solid var(--vscode-panel-border, #454545); border-radius: 6px; overflow: hidden; }
    .card-head { padding: 12px 14px; display: flex; align-items: center; gap: 8px; justify-content: space-between; border-bottom: 1px solid var(--vscode-panel-border, #454545); min-height: 54px; }
    .card-content { padding: 14px; }
    .provider-list { display: grid; gap: 4px; padding: 7px; }
    button.provider-item { display: block; text-align: left; width: 100%; padding: 9px 10px; min-width: 0; white-space: normal; color: inherit; background: transparent; border-color: transparent; }
    button.provider-item.selected { background: var(--vscode-list-inactiveSelectionBackground, #37373d); border-color: var(--vscode-focusBorder, #007fd4); }
    .provider-name { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-weight: 500; }
    .provider-name > span:first-child { overflow-wrap: anywhere; }
    .provider-state { font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground, #999); white-space: nowrap; }
    .provider-meta { margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground, #999); overflow-wrap: anywhere; }
    .empty { padding: 26px 14px; text-align: center; color: var(--vscode-descriptionForeground, #999); }
    .empty p + p, .empty button { margin-top: 8px; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
    .provider-summary { display: flex; gap: 14px; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
    .provider-summary > div:first-child { min-width: 0; }
    .endpoint { margin: 3px 0 5px; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; align-items: center; }
    .toolbar .search { flex: 1 1 180px; min-width: 110px; }
    .model-list { border: 1px solid var(--vscode-panel-border, #454545); border-radius: 4px; max-height: 420px; overflow: auto; }
    .model-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; min-height: 52px; }
    .model-row + .model-row { border-top: 1px solid var(--vscode-panel-border, #454545); }
    .model-label { display: flex; gap: 10px; align-items: center; flex: 1; min-width: 0; cursor: pointer; }
    .model-text { display: block; min-width: 0; flex: 1; }
    .model-title, .model-id { display: block; overflow-wrap: anywhere; }
    .model-id { color: var(--vscode-descriptionForeground, #999); font: 11px/1.5 var(--vscode-editor-font-family, monospace); }
    .selection-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; margin-top: 10px; }
    .selection-actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .subtle-warning { color: var(--vscode-editorWarning-foreground, #cca700); margin-bottom: 10px; font-size: 12px; }
    .fusion-card { margin-top: 18px; }
    .fusion-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; }
    .section-hint { margin: 4px 0 10px; }
    .sidekick-list { max-height: 200px; overflow: auto; margin-top: 8px; border: 1px solid var(--vscode-panel-border, #454545); border-radius: 4px; }
    .sidekick-row { display: flex; align-items: center; gap: 8px; padding: 6px 9px; cursor: pointer; }
    .sidekick-row span { min-width: 0; overflow-wrap: anywhere; }
    .sidekick-row + .sidekick-row { border-top: 1px solid var(--vscode-panel-border, #454545); }
    .space-top { margin-top: 10px; }
    .default-controls { display: flex; align-items: center; gap: 8px; }
    .default-controls select { min-width: 0; }
    .footnote { margin: 16px 0 0; }
    dialog { width: min(540px, calc(100vw - 28px)); max-height: calc(100vh - 40px); overflow: auto; margin: auto; padding: 20px; border: 1px solid var(--vscode-panel-border, #454545); border-radius: 7px; color: var(--vscode-foreground, #ddd); background: var(--vscode-editor-background, #1e1e1e); box-shadow: 0 8px 28px var(--vscode-widget-shadow, #0006); }
    dialog::backdrop { background: #0007; }
    dialog h2 { font-size: 17px; margin-bottom: 16px; }
    .field { display: block; margin-bottom: 13px; }
    .field-title { display: block; margin-bottom: 5px; font-weight: 500; }
    .field .hint { display: block; margin-top: 4px; }
    .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .dialog-error { color: var(--vscode-errorForeground, #f48771); overflow-wrap: anywhere; }
    .confirm-text { white-space: pre-line; overflow-wrap: anywhere; }
    .dialog-options { display: flex; flex-wrap: wrap; gap: 16px; }
    .import-picker { display: grid; gap: 10px; }
    .import-picker .model-list { max-height: min(320px, 40vh); }
    .import-picker .dialog-actions { margin-top: 4px; }
    @media (max-width: 700px) {
      body { padding: 16px; }
      .workspace { grid-template-columns: 1fr; gap: 14px; }
      .provider-list { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
      .fusion-grid { grid-template-columns: 1fr; gap: 22px; }
      .page-head { align-items: flex-start; }
      h1 { font-size: 20px; }
      .provider-summary { flex-wrap: wrap; }
      .model-list { max-height: 360px; }
    }
    @media (max-width: 390px) {
      body { padding: 12px; }
      .page-head { flex-wrap: wrap; gap: 10px; }
      .field-grid { grid-template-columns: 1fr; gap: 0; }
      .default-controls { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <main id="main" aria-busy="true">
    <header class="page-head">
      <div><h1>Fusion 模型管理</h1><p class="muted page-description">连接供应商、整理模型，并设置 Lead 与 Sidekick 的组合。</p></div>
      <label class="toggle"><input id="plugin-enabled" type="checkbox" disabled><span>启用插件</span></label>
    </header>
    <div id="status" class="status" role="status" aria-live="polite">正在读取配置…</div>
    <div class="workspace">
      <section class="card" aria-labelledby="provider-heading">
        <div class="card-head"><h2 id="provider-heading">供应商</h2><button id="add-provider" class="quiet" type="button" disabled>添加</button></div>
        <nav id="providers" class="provider-list" aria-label="供应商列表"></nav>
      </section>
      <section class="card" aria-labelledby="model-heading">
        <div class="card-head"><h2 id="model-heading">导入的模型</h2><span id="model-count" class="hint"></span></div>
        <div id="models" class="card-content"><div class="empty">读取后即可管理模型。</div></div>
      </section>
    </div>
    <section class="card fusion-card" aria-labelledby="fusion-heading">
      <div class="card-head"><h2 id="fusion-heading">Fusion 组合</h2><span id="fusion-count" class="hint"></span></div>
      <div id="fusion" class="card-content"></div>
    </section>
    <section class="card fusion-card" aria-labelledby="native-heading">
      <div class="card-head"><h2 id="native-heading">官方模型</h2><span id="native-count" class="hint"></span></div>
      <div id="native-models" class="card-content"></div>
    </section>
    <p class="hint footnote">保存后在新建会话中使用。现有会话继续沿用已选择的模型。</p>
  </main>
  <dialog id="editor-dialog" aria-labelledby="dialog-title"></dialog>
  <script nonce="${safeNonce}">(${panelClient.toString()})(${modelSupportsImages.toString()});</script>
</body>
</html>`;
}

function panelClient(modelSupportsImages) {
  'use strict';
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const pending = new Map();
  let serial = 0;
  let state;
  let busy = false;
  let providerId = vscode.getState()?.providerId || '';
  let modelSearch = '';
  let sidekickSearch = '';
  let nativeSearch = '';
  let modelDraft = new Map();
  let modelButtons = [];

  function element(tag, attributes, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value ?? '');
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'readOnly' || key === 'hidden') node[key] = Boolean(value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function button(text, action, secondary = true) {
    return element('button', { type: 'button', text, class: secondary ? 'secondary' : '', onclick: action });
  }

  function notice(message, tone) {
    const node = byId('status');
    node.textContent = message;
    node.dataset.tone = tone || '';
    node.hidden = !message;
  }

  function setBusy(value) {
    busy = value;
    byId('main').setAttribute('aria-busy', String(value));
    for (const node of document.querySelectorAll('main button, main input, main select')) {
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
    notice(progress);
    try {
      await action();
      notice(success || '已保存。新建会话即可使用。', 'success');
      return true;
    } catch (error) {
      notice(error.message || '操作失败，请重试。', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function currentProvider() {
    return state?.providers?.find(provider => provider.id === providerId);
  }

  function resetModelDraft() {
    modelDraft = new Map((currentProvider()?.models || []).map(model => [model.id, model.enabled !== false]));
  }

  function render(previousState) {
    if (!state) return;
    const previousProvider = previousState?.providers?.find(provider => provider.id === providerId);
    const previousDraft = modelDraft;
    if (!state.providers.some(provider => provider.id === providerId)) providerId = state.providers[0]?.id || '';
    vscode.setState({ providerId });
    resetModelDraft();
    if (previousProvider?.id === providerId) {
      const previousModels = new Map(previousProvider.models.map(model => [model.id, model]));
      for (const model of currentProvider().models) {
        const old = previousModels.get(model.id);
        if (old && previousDraft.has(model.id) && previousDraft.get(model.id) !== (old.enabled !== false) && (model.enabled !== false) === (old.enabled !== false)) {
          modelDraft.set(model.id, previousDraft.get(model.id));
        }
      }
    }
    byId('plugin-enabled').checked = state.enabled !== false;
    byId('plugin-enabled').disabled = false;
    byId('add-provider').disabled = false;
    renderProviders();
    renderModels();
    renderFusion();
    renderNative();
    if (busy) {
      for (const node of document.querySelectorAll('main button, main input, main select')) {
        node.dataset.wasDisabled = String(node.disabled);
        node.disabled = true;
      }
    }
  }

  function renderProviders() {
    const container = byId('providers');
    container.replaceChildren();
    if (!state.providers.length) {
      container.append(element('div', { class: 'empty', text: '添加一个供应商开始使用。' }));
      return;
    }
    for (const provider of state.providers) {
      let host = provider.baseUrl;
      try { host = new URL(provider.baseUrl).host; } catch { /* Display the saved value as text. */ }
      const enabledCount = provider.models.filter(model => model.enabled !== false).length;
      container.append(element('button', {
        type: 'button', class: 'provider-item' + (provider.id === providerId ? ' selected' : ''),
        'aria-current': provider.id === providerId ? 'true' : 'false',
        onclick: () => {
          if (busy || providerId === provider.id) return;
          const choose = () => {
            providerId = provider.id;
            modelSearch = '';
            vscode.setState({ providerId });
            resetModelDraft();
            renderProviders();
            renderModels();
          };
          if (hasModelChanges()) confirmDialog('放弃未保存的勾选？', '当前供应商的模型勾选尚未应用。', '放弃并切换', choose);
          else choose();
        }
      }, element('span', { class: 'provider-name' }, element('span', { text: provider.name }),
        element('span', { class: 'provider-state', text: provider.enabled === false ? '已停用' : enabledCount + ' 个启用' })),
      element('span', { class: 'provider-meta', text: host })));
    }
  }

  function hasModelChanges() {
    return (currentProvider()?.models || []).some(model => modelDraft.get(model.id) !== (model.enabled !== false));
  }

  function renderModels() {
    const container = byId('models');
    const provider = currentProvider();
    container.replaceChildren();
    byId('model-count').textContent = provider ? provider.models.length + ' 个模型' : '';
    if (!provider) {
      container.append(element('div', { class: 'empty' }, element('p', { text: '先连接供应商，再导入模型列表。' }),
        button('添加供应商', () => providerDialog(), false)));
      return;
    }
    const enabled = element('input', { type: 'checkbox', checked: provider.enabled !== false,
      onchange: event => {
        const value = event.target.checked;
        run(() => request('setProviderEnabled', { id: provider.id, enabled: value }), '正在更新供应商…').then(ok => { if (!ok) event.target.checked = !value; });
      }
    });
    container.append(element('div', { class: 'provider-summary' }, element('div', {},
      element('h3', { text: provider.name }), element('p', { class: 'endpoint', text: provider.baseUrl }),
      element('p', { class: 'hint', text: (provider.apiFormat === 'openai-responses' ? 'Responses API' : 'Chat Completions API') + ' · ' + (provider.keyConfigured ? '已配置密钥' : '未配置密钥') })),
      element('div', { class: 'actions' }, element('label', { class: 'toggle' }, enabled, '启用'),
        button('编辑', () => providerDialog(provider)), button('删除', () => deleteProvider(provider)))));
    if (provider.enabled === false) container.append(element('p', { class: 'subtle-warning', text: '此供应商已停用，其模型不会显示在新会话中。' }));
    const search = element('input', { type: 'search', class: 'search', placeholder: '搜索模型名称或 ID', 'aria-label': '搜索导入的模型',
      oninput: event => { modelSearch = event.target.value; renderModelRows(); }
    });
    search.value = modelSearch;
    container.append(element('div', { class: 'toolbar' }, search,
      button('选择模型导入', () => {
        run(async () => {
          await request('refreshModels', { providerId: provider.id });
          importDialog(provider.id);
        }, '正在获取可导入的模型…', '列表已加载，请勾选需要导入的模型。');
      }), button('手动添加', () => modelDialog(provider))));
    container.append(element('div', { id: 'model-list', class: 'model-list', 'aria-label': '模型启用列表' }));
    const apply = button('应用勾选', () => {
      const changes = provider.models.filter(model => modelDraft.get(model.id) !== (model.enabled !== false))
        .map(model => ({ id: model.id, enabled: modelDraft.get(model.id) }));
      if (changes.length) run(() => request('updateModels', { providerId: provider.id, changes }), '正在保存模型勾选…');
    }, false);
    modelButtons = [apply];
    const setVisible = value => {
      for (const model of visibleModels()) modelDraft.set(model.id, value);
      renderModelRows();
    };
    container.append(element('div', { class: 'selection-bar' }, element('div', { class: 'selection-actions' },
      button('启用当前结果', () => setVisible(true)), button('停用当前结果', () => setVisible(false))),
      element('div', { class: 'actions' }, element('span', { id: 'selection-count', class: 'hint' }), apply)));
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
    if (!models.length) container.append(element('div', { class: 'empty', text: provider.models.length ? '没有匹配的模型。' : '还没有模型。点击“选择模型导入”，或手动添加模型 ID。' }));
    for (const model of models) {
      const checkbox = element('input', { type: 'checkbox', checked: modelDraft.get(model.id),
        onchange: event => { modelDraft.set(model.id, event.target.checked); renderSelectionCount(); }
      });
      container.append(element('div', { class: 'model-row' }, element('label', { class: 'model-label' }, checkbox,
        element('span', { class: 'model-text' }, element('span', { class: 'model-title', text: model.label || model.id }),
          element('span', { class: 'model-id', text: model.id }))),
        element('button', { type: 'button', class: 'quiet', text: '编辑', 'aria-label': '编辑模型 ' + (model.label || model.id), onclick: () => modelDialog(provider, model) }),
        element('button', { type: 'button', class: 'quiet', text: '删除', 'aria-label': '删除模型 ' + (model.label || model.id), onclick: () => {
          confirmDialog('删除模型？', '将从“' + provider.name + '”移除“' + (model.label || model.id) + '”（' + model.id + '）。之后仍可重新导入。', '删除模型',
            () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] }), true);
        } })));
    }
    renderSelectionCount();
  }

  function renderSelectionCount() {
    const count = [...modelDraft.values()].filter(Boolean).length;
    const dirty = hasModelChanges();
    byId('selection-count').textContent = count + ' 个启用' + (dirty ? ' · 尚未保存' : '');
    for (const button of modelButtons) button.disabled = !dirty;
  }

  function sidekickCandidates() {
    const candidates = [];
    for (const sidekick of state.sidekicks || []) {
      if (sidekick.nativeUid) {
        candidates.push({ value: sidekick, label: '原生 · ' + (sidekick.label || sidekick.nativeUid), modelId: sidekick.nativeUid });
      } else {
        const provider = (state.providers || []).find(item => item.id === sidekick.providerId);
        const model = provider?.models.find(item => item.id === sidekick.model);
        const label = model?.label || sidekick.model;
        candidates.push({ value: sidekick, label: provider && !label.startsWith(provider.name + ' · ') ? provider.name + ' · ' + label : label, modelId: sidekick.model });
      }
    }
    return candidates;
  }

  function renderFusion() {
    const container = byId('fusion');
    container.replaceChildren();
    byId('fusion-count').textContent = (state.fusionCount || 0) + ' 个组合';
    const sidekickSection = element('div', {}, element('h3', { text: 'Sidekick 模型' }),
      element('p', { class: 'hint section-hint', text: '导入模型自动用于 Lead 和 Sidekick；符合执行条件的官方模型自动用于 Sidekick。' }));
    const search = element('input', { type: 'search', placeholder: '搜索 Sidekick', 'aria-label': '搜索 Sidekick 模型',
      oninput: event => { sidekickSearch = event.target.value; renderSidekickRows(); }
    });
    search.value = sidekickSearch;
    sidekickSection.append(search, element('div', { id: 'sidekick-list', class: 'sidekick-list', 'aria-label': 'Sidekick 模型列表' }));

    const defaultSection = element('div', {}, element('h3', { text: '默认 Fusion 组合' }),
      element('p', { class: 'hint section-hint', text: '选择新会话使用的 Lead 和 Sidekick。也可以在 Devin 原生 Fusion 菜单中切换。' }));
    const choices = state.fusionChoices || [];
    const select = element('select', { 'aria-label': '默认 Fusion 组合', disabled: !choices.length });
    select.append(element('option', { value: '', text: choices.length ? '选择一个 Fusion 组合' : '先启用 Lead 模型并保存 Sidekick' }));
    for (const choice of choices) select.append(element('option', { value: choice.uid, text: choice.label }));
    if (choices.some(choice => choice.uid === state.selectedFusionUid)) select.value = state.selectedFusionUid;
    const selectButton = button('设为默认', () => {
      if (select.value) run(() => request('selectFusion', { uid: select.value }), '正在设置默认组合…', '默认 Fusion 组合已保存，新建会话即可使用。');
    }, false);
    selectButton.disabled = !select.value || select.value === state.selectedFusionUid;
    select.addEventListener('change', () => { selectButton.disabled = !select.value || select.value === state.selectedFusionUid; });
    defaultSection.append(select, element('div', { class: 'space-top actions' }, selectButton));
    if (state.enabled === false) defaultSection.append(element('p', { class: 'subtle-warning space-top', text: '插件当前已停用。启用后，导入的模型和 Fusion 组合才会出现在新会话中。' }));
    container.append(element('div', { class: 'fusion-grid' }, sidekickSection, defaultSection));
    renderSidekickRows();
  }

  function renderSidekickRows() {
    const container = byId('sidekick-list');
    const query = sidekickSearch.trim().toLocaleLowerCase();
    const candidates = sidekickCandidates().filter(candidate => !query || (candidate.label + ' ' + (candidate.modelId || '')).toLocaleLowerCase().includes(query));
    container.replaceChildren();
    for (const candidate of candidates) {
      container.append(element('div', { class: 'sidekick-row' }, element('span', { text: candidate.label }),
        element('span', { class: 'hint', text: '自动可用' })));
    }
    if (!candidates.length) container.append(element('div', { class: 'empty', text: '等待 Devin 上报官方模型，或先导入第三方模型。' }));
  }

  function renderNative() {
    const container = byId('native-models');
    container.replaceChildren();
    const all = state.nativeModels || [];
    byId('native-count').textContent = all.length ? all.length + ' 个官方模型' : '';
    const search = element('input', { type: 'search', class: 'search', placeholder: '搜索官方模型名称或 UID', 'aria-label': '搜索官方模型',
      oninput: event => { nativeSearch = event.target.value; renderNativeRows(); }
    });
    search.value = nativeSearch;
    container.append(element('div', { class: 'toolbar' }, search));
    container.append(element('p', { class: 'hint section-hint', text: '移除只在本机模型列表中隐藏，不影响官方账号和权限；加回后等 Devin 刷新列表即可恢复。标记“可作 Sidekick”的模型会自动加入 Fusion 组合。' }));
    container.append(element('div', { id: 'native-list', class: 'model-list', 'aria-label': '官方模型列表' }));
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
      container.append(element('div', { class: 'empty', text: all.length ? '没有匹配的模型。' : '等待 Devin 刷新官方模型列表' }));
      return;
    }
    for (const model of models) {
      const action = model.hidden
        ? element('button', { type: 'button', class: 'quiet', text: '加回', 'aria-label': '加回官方模型 ' + model.uid,
            onclick: () => run(() => request('setNativeModelHidden', { uid: model.uid, hidden: false }), '正在恢复官方模型…') })
        : element('button', { type: 'button', class: 'quiet', text: '移除', 'aria-label': '移除官方模型 ' + model.uid,
            onclick: () => run(() => request('setNativeModelHidden', { uid: model.uid, hidden: true }), '正在移除官方模型…') });
      const status = model.hidden ? '已移除'
        : model.disabled ? '显示中 · 官方不可用'
        : model.eligible === true ? '显示中 · 可作 Sidekick'
        : '显示中 · 缺少支持的执行通道';
      container.append(element('div', { class: 'model-row' },
        element('span', { class: 'model-text' }, element('span', { class: 'model-title', text: model.label || model.uid }),
          element('span', { class: 'model-id', text: model.uid })),
        element('span', { class: 'hint', text: status }), action));
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

  function finishDialog(dialog, form, submitText, onSubmit, extraButton) {
    const error = element('p', { class: 'dialog-error', role: 'alert' });
    const cancel = button('取消', () => dialog.close());
    const submit = element('button', { type: 'submit', text: submitText });
    form.append(error, element('div', { class: 'dialog-actions' }, extraButton || null, cancel, submit));
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
      const controls = [...form.querySelectorAll('input, select, button')].map(node => [node, node.disabled]);
      for (const [node] of controls) node.disabled = true;
      setBusy(true);
      try {
        await onSubmit();
        dialog.close();
        notice('已保存。新建会话即可使用。', 'success');
      } catch (failure) {
        error.textContent = failure.message || '保存失败，请重试。';
      } finally {
        saving = false;
        for (const [node, disabled] of controls) node.disabled = disabled;
        setBusy(false);
      }
    });
    dialog.showModal();
  }

  function importDialog(providerId) {
    const candidates = state.importCandidates;
    if (!candidates || candidates.providerId !== providerId) throw new Error('模型列表已失效，请重新获取。');
    const { dialog, form } = openDialog('选择要导入的模型');
    form.classList.add('import-picker');
    const selected = new Set();
    const search = input('', { type: 'search', placeholder: '搜索模型名称或 ID', 'aria-label': '搜索可导入的模型' });
    const list = element('div', { class: 'model-list', 'aria-label': '可导入的模型列表' });
    const count = element('p', { class: 'hint', role: 'status' });
    let submit;
    const visible = () => {
      const query = search.value.trim().toLocaleLowerCase();
      return candidates.models.filter(model => (model.id + ' ' + model.label).toLocaleLowerCase().includes(query));
    };
    const updateCount = () => {
      count.textContent = '已选择 ' + selected.size + ' 个新模型 · 共 ' + candidates.models.length + ' 个可用模型';
      if (submit) submit.disabled = selected.size === 0;
    };
    const renderRows = () => {
      list.replaceChildren();
      for (const model of visible()) {
        const checkbox = element('input', { type: 'checkbox', checked: model.imported || selected.has(model.id), disabled: model.imported,
          onchange: event => { if (event.target.checked) selected.add(model.id); else selected.delete(model.id); updateCount(); } });
        list.append(element('label', { class: 'model-row model-label' }, checkbox,
          element('span', { class: 'model-text' }, element('span', { class: 'model-title', text: model.label }),
            element('span', { class: 'model-id', text: model.id })),
          model.imported ? element('span', { class: 'hint', text: '已导入' }) : null));
      }
      if (!list.childElementCount) list.append(element('p', { class: 'empty', text: candidates.models.length ? '没有匹配的模型。' : '供应商没有返回可用模型。' }));
      updateCount();
    };
    search.addEventListener('input', renderRows);
    form.append(element('p', { class: 'hint', text: '新模型默认不勾选；确认后仅导入所选模型。已有模型保持不变。' }), search,
      element('div', { class: 'selection-actions' }, button('全选当前结果', () => {
        for (const model of visible()) if (!model.imported) selected.add(model.id);
        renderRows();
      }), button('清空选择', () => { selected.clear(); renderRows(); })), list, count);
    finishDialog(dialog, form, '导入所选模型', () => request('importModels', { providerId, token: candidates.token, ids: [...selected] }));
    submit = form.querySelector('button[type="submit"]');
    renderRows();
  }

  function providerDialog(provider) {
    const { dialog, form } = openDialog(provider ? '编辑供应商' : '添加供应商');
    const name = input(provider?.name, { required: true, maxlength: 80, placeholder: '例如：CPA、OpenRouter' });
    const baseUrl = input(provider?.baseUrl, { type: 'url', required: true, placeholder: 'https://example.com/v1', spellcheck: 'false' });
    const apiFormat = element('select', { 'aria-label': 'API 类型' },
      element('option', { value: 'openai-responses', text: 'OpenAI Responses' }),
      element('option', { value: 'openai', text: 'OpenAI Chat Completions' }));
    apiFormat.value = provider?.apiFormat || 'openai-responses';
    const apiKey = input('', { type: 'password', autocomplete: 'new-password', placeholder: provider?.keyConfigured ? '留空保留现有密钥' : '输入 API Key', spellcheck: 'false' });
    form.append(field('名称', name), field('API 地址', baseUrl, '填写供应商的 API 基础地址，通常以 /v1 结尾。'),
      field('API 类型', apiFormat), field('API Key', apiKey, provider?.keyConfigured ? '现有密钥不会在面板中显示。仅在需要替换时填写。' : '密钥保存在此电脑的插件配置中，不会显示在模型列表里。'));
    finishDialog(dialog, form, '保存供应商', () => {
      const payload = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), apiFormat: apiFormat.value };
      if (provider) payload.id = provider.id;
      if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
      return request('saveProvider', payload);
    });
  }

  function confirmDialog(title, message, actionText, onConfirm, destructive = false) {
    const { dialog, form } = openDialog(title);
    form.append(element('p', { class: 'confirm-text', text: message }));
    finishDialog(dialog, form, actionText, async () => {
      // The dialog owns the operation state; callers should return the host request.
      const result = onConfirm();
      if (result && typeof result.then === 'function') await result;
    });
    if (destructive) form.querySelector('button[type="submit"]').classList.add('danger');
  }

  function deleteProvider(provider) {
    confirmDialog('删除供应商？', '将移除“' + provider.name + '”的配置、导入模型及相关 Fusion 组合。', '删除供应商',
      () => request('deleteProvider', { id: provider.id }), true);
  }

  function modelDialog(provider, model) {
    const { dialog, form } = openDialog(model ? '编辑模型' : '手动添加模型');
    const id = input(model?.id, { required: true, readOnly: Boolean(model), maxlength: 256, placeholder: '供应商返回的模型 ID', spellcheck: 'false' });
    const label = input(model?.label || '', { maxlength: 160, placeholder: '留空使用模型 ID' });
    const contextWindow = input(model?.contextWindow || 272000, { type: 'number', min: 1, step: 1, required: true });
    const maxOutputTokens = input(model?.maxOutputTokens || 32768, { type: 'number', min: 1, step: 1, required: true });
    form.append(field('模型 ID', id), field('显示名称', label), element('div', { class: 'field-grid' },
      field('上下文容量（tokens）', contextWindow), field('最大输出（tokens）', maxOutputTokens)));
    const enabled = element('input', { type: 'checkbox', checked: model ? modelDraft.get(model.id) : true });
    const supportsImages = element('input', { type: 'checkbox', checked: true, disabled: true });
    const efforts = input((model?.efforts || []).join(', '), { placeholder: '例如：low, medium, high', spellcheck: 'false' });
    const effortMode = element('select', { 'aria-label': '思考程度设置' },
      element('option', { value: 'auto', text: '自动预设（GPT/o 系列）' }),
      element('option', { value: 'manual', text: '手动设置档位' }),
      element('option', { value: 'none', text: '使用供应商默认（不指定程度）' }));
    effortMode.value = model?.effortMode || (model?.efforts?.length ? 'manual' : 'auto');
    efforts.disabled = effortMode.value !== 'manual';
    effortMode.addEventListener('change', () => { efforts.disabled = effortMode.value !== 'manual'; });
    form.append(element('div', { class: 'dialog-options field' }, element('label', { class: 'toggle' }, enabled, '启用此模型')));
    form.append(element('div', { class: 'dialog-options field' }, element('label', { class: 'toggle' }, supportsImages, '图片输入已启用')),
      field('思考程度设置', effortMode, 'GPT/o 系列预设 Low、Medium、High、XHigh。其他模型保持默认，也可手动调整。'),
      field('手动思考档位', efforts, '填写供应商支持的档位，以逗号分隔，例如 low, medium, high。'));
    const remove = model ? element('button', { type: 'button', class: 'danger', text: '删除模型', onclick: () => {
      dialog.close();
      confirmDialog('删除模型？', '将从“' + provider.name + '”移除“' + model.id + '”。之后仍可重新导入。', '删除模型',
        () => request('updateModels', { providerId: provider.id, changes: [], removeIds: [model.id] }), true);
    } }) : null;
    finishDialog(dialog, form, model ? '保存模型' : '添加模型', () => {
      const saved = { id: id.value.trim(), label: label.value.trim() || id.value.trim(), enabled: enabled.checked,
        contextWindow: Number(contextWindow.value), maxOutputTokens: Number(maxOutputTokens.value),
        supportsImages: supportsImages.checked, effortMode: effortMode.value,
        efforts: effortMode.value === 'auto' ? [] : [...new Set(efforts.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean))] };
      if (!model) delete saved.supportsImages;
      if (model) {
        const previousEnabled = modelDraft.get(saved.id);
        modelDraft.set(saved.id, saved.enabled);
        return request('updateModels', { providerId: provider.id, changes: [saved] }).catch(error => {
          modelDraft.set(saved.id, previousEnabled);
          throw error;
        });
      }
      return request('addModel', { providerId: provider.id, model: saved });
    }, remove);
  }

  byId('add-provider').addEventListener('click', () => providerDialog());
  byId('plugin-enabled').addEventListener('change', event => {
    const value = event.target.checked;
    run(() => request('setEnabled', { enabled: value }), value ? '正在启用插件…' : '正在停用插件…').then(ok => { if (!ok) event.target.checked = !value; });
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state' && message.state && Array.isArray(message.state.providers)) {
      const initial = !state;
      const previousState = state;
      state = message.state;
      render(previousState);
      if (initial) { byId('main').setAttribute('aria-busy', 'false'); notice(''); }
    } else if (message.type === 'result') {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timeout);
      if (message.ok) operation.resolve();
      else operation.reject(new Error(typeof message.error === 'string' ? message.error : '操作失败，请重试。'));
    }
  });
  request('ready').catch(error => notice(error.message, 'error'));
}

module.exports = { renderPanel };
