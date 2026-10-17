'use strict';
const CAPABILITIES = [
  ['code', '代码搜索', 'code_search', '用一句话描述要找的东西，在选定项目里返回相关文件、行号和代码片段。'],
  ['web', '网页搜索', 'web_search', '搜索公开网页，返回标题、地址和摘要。'],
  ['read', '网页读取', 'web_read_url', '读取一个公开 https 网页的正文文字，常用来打开搜索结果。'],
];
const FORMATS = [
  ['prompt', '提示词', '推荐。发给 Claude Code、Codex、Cursor 等工具里的 Agent，它会按自己的客户端完成配置并验证。'],
  ['json', '配置 JSON', '自己手动合并到使用 mcpServers 格式的配置文件里。路径是本机安装位置，只适用于这台电脑。'],
];

function fastContextStyles() {
  return `
    .fc { max-width: 820px; }
    .fc-lead { color: var(--muted); margin-bottom: 18px; }
    .fc-caps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .fc-cap { border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; min-width: 0; }
    .fc-cap-head { display: flex; align-items: center; gap: 8px; }
    .fc-cap-name { font-weight: 600; }
    .fc-cap code { margin-left: auto; }
    .fc-cap p { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .fc-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-top: 8px; color: var(--muted); }
    .fc-state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--border); flex: none; }
    .fc-state[data-state="yes"] { color: var(--ok); }
    .fc-state[data-state="yes"]::before { background: var(--ok); }
    .fc-state[data-state="no"] { color: var(--warn); }
    .fc-state[data-state="no"]::before { background: var(--warn); }
    .fc-checkline { display: flex; align-items: center; gap: 10px; margin-top: 8px; min-height: 20px; }
    .fc-step { margin-top: 26px; }
    .fc-step.locked .fc-body { opacity: .45; pointer-events: none; }
    .fc-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 6px; }
    .fc-pill { font-size: 11px; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
    .fc-pill[data-on="true"] { color: var(--ok); border-color: var(--ok); }
    .fc-step-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .fc-num { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; font-weight: 600; color: var(--vscode-button-foreground, #fff); background: var(--accent); flex: none; }
    .fc-root { display: flex; gap: 8px; }
    .fc-root select { flex: 1; min-width: 0; }
    .fc-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 6px; padding: 2px; gap: 2px; }
    .fc-seg button { color: var(--muted); background: transparent; border-color: transparent; min-height: 26px; padding: 2px 12px; }
    .fc-seg button:hover { color: var(--vscode-foreground, #ddd); background: var(--hover); }
    .fc-seg button[aria-pressed="true"] { color: var(--vscode-foreground, #ddd); background: var(--vscode-list-inactiveSelectionBackground, #37373d); }
    .fc-format-hint { margin: 8px 0; }
    .fc-code { position: relative; border: 1px solid var(--border); border-radius: 6px; background: var(--vscode-textCodeBlock-background, #2b2b2b); }
    .fc-code pre { margin: 0; padding: 12px 14px; padding-right: 88px; max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .fc-code button { position: absolute; top: 8px; right: 8px; }
    .fc-notes { margin-top: 26px; }
    .fc-notes ul { padding-left: 20px; margin: 4px 14px 12px; }
    .fc-notes li { margin: 4px 0; color: var(--muted); }
    @media (max-width: 700px) { .fc-caps { grid-template-columns: 1fr; } .fc-root { flex-direction: column; } }`;
}

function fastContextMarkup() {
  const caps = CAPABILITIES.map(([id, name, tool, text]) => `<div class="fc-cap">
          <div class="fc-cap-head"><span class="fc-cap-name">${name}</span><code class="cmd">${tool}</code></div>
          <p>${text}</p>
          <span class="fc-state" id="fc-cap-${id}" data-state="unknown">未检测</span>
        </div>`).join('');
  const formats = FORMATS.map(([id, label], index) => `<button type="button" data-format="${id}" aria-pressed="${index === 0}">${label}</button>`).join('');
  return `<div id="fast-context" class="fc">
      <div class="section-head"><h2>对外提供 MCP</h2><span id="fc-pill" class="fc-pill" data-on="false">未开启</span></div>
      <p class="fc-lead">把 Devin 自带的代码搜索和网页搜索开放给 Claude Code、Codex、Cursor 等其他工具使用，走本机 Devin 已登录的账号，不需要任何密钥。默认关闭。</p>

      <div class="fc-step">
        <div class="fc-step-title"><span class="fc-num">1</span><h3>检测账号资格</h3><span class="spacer"></span><button id="fc-check" class="secondary" type="button">检测账号</button></div>
        <div class="fc-caps">${caps}</div>
        <div class="fc-checkline"><span id="fc-check-result" class="hint" role="status" aria-live="polite">只读取本机登录并询问官方服务，不发送项目内容，也不显示或保存凭证。</span></div>
      </div>

      <div class="fc-step locked" id="fc-step-enable">
        <div class="fc-step-title"><span class="fc-num">2</span><h3>开启对外 MCP</h3></div>
        <div class="fc-switch">
          <div class="row-main"><span class="row-title">允许其他工具调用</span><span class="row-sub" id="fc-enable-hint">先完成第 1 步，确认代码搜索可用后才能开启。</span></div>
          <input id="fc-enabled" class="switch" type="checkbox" role="switch" aria-label="开启对外 MCP" disabled>
        </div>
      </div>

      <div class="fc-step locked" id="fc-step-connect">
        <div class="fc-step-title"><span class="fc-num">3</span><h3>接入到其他工具</h3></div>
        <div class="fc-body">
          <div class="fc-root"><select id="fc-root" aria-label="允许搜索的项目"></select><button id="fc-pick" class="secondary" type="button">选择其他文件夹…</button></div>
          <p class="hint mt">代码搜索只能在选定的目录里进行，换项目时回来重新复制一次。网页搜索不受影响。</p>
          <p id="fc-status" class="warn" role="status"></p>
          <div class="fc-seg mt" role="group" aria-label="复制内容">${formats}</div>
          <p id="fc-format-hint" class="hint fc-format-hint"></p>
          <div class="fc-code"><pre id="fc-preview" class="mono" tabindex="0"></pre><button id="fc-copy" type="button">复制</button></div>
          <p id="fc-result" class="hint mt" role="status" aria-live="polite"></p>
        </div>
      </div>

      <details class="group fc-notes"><summary>使用须知</summary>
        <ul>
          <li>开关关闭时，已经接入的工具会看不到任何工具，调用也会被拒绝；随时可以在这里关掉。</li>
          <li>检索问题、选中的代码片段会发送到 Devin 官方服务，可能消耗账号额度。网页正文在本机读取，只接受公开的 https 地址。</li>
          <li>网页搜索和网页读取跟随账号或团队的网页搜索开关；开关关闭时只会如实提示，不会绕过。</li>
          <li>只读：不会修改项目文件，也不会执行网页里的脚本。</li>
          <li>复制出来的配置里是这台电脑上的安装路径，每台电脑要在自己的 Devin 里复制。插件升级后自动使用新版本，不用重新配置。需要 Node.js 22.16 以上。</li>
        </ul>
      </details>
    </div>`;
}

function fastContextScript() {
  return `
  (() => {
    const byId = id => document.getElementById('fc-' + id);
    const FORMAT_HINTS = ${JSON.stringify(Object.fromEntries(FORMATS.map(([id, , hint]) => [id, hint])))};
    let snapshot = null, format = 'prompt', previewKey = '', enableError = '';
    const selected = () => byId('root').value;
    const send = (type, payload) => vscode.postMessage({ id: 'fc-' + Date.now(), type: 'fastContext.' + type, payload });
    function setCap(id, value, yes, no) {
      const node = byId('cap-' + id);
      node.dataset.state = value === true ? 'yes' : value === false ? 'no' : 'unknown';
      node.textContent = value === true ? yes : value === false ? no : '未检测';
    }
    function renderCheck(check) {
      const caps = check?.capabilities || {};
      setCap('code', caps.code, '可用', '不可用');
      setCap('web', caps.web, '可用', '已关闭');
      setCap('read', caps.web, '可用', '已关闭');
      if (check?.at) byId('check').title = '上次检测：' + new Date(check.at).toLocaleString();
    }
    function requestPreview() {
      const root = selected();
      byId('format-hint').textContent = FORMAT_HINTS[format] || '';
      if (!snapshot?.enabled) { byId('preview').textContent = '开启对外 MCP 后，这里会显示可以复制的内容。'; byId('copy').disabled = true; return; }
      if (!root) { byId('preview').textContent = '请先打开或选择一个本地项目文件夹。'; byId('copy').disabled = true; return; }
      previewKey = format + '\\n' + root;
      send('preview', { kind: format, root });
    }
    function renderSwitch() {
      const on = Boolean(snapshot?.enabled);
      const eligible = snapshot?.check?.capabilities?.code === true;
      byId('enabled').checked = on;
      byId('enabled').disabled = !on && !eligible;
      byId('step-enable').classList.toggle('locked', !on && !eligible);
      byId('step-connect').classList.toggle('locked', !on);
      byId('pill').dataset.on = String(on);
      byId('pill').textContent = on ? '已开启' : '未开启';
      byId('enable-hint').className = enableError ? 'row-sub warn' : 'row-sub';
      byId('enable-hint').textContent = enableError || (on ? '已开启。关闭后，已接入的工具会立刻无法调用。'
        : eligible ? '账号检测通过，打开开关后其他工具才能调用。' : '先完成第 1 步，确认代码搜索可用后才能开启。');
    }
    function render(keep) {
      renderSwitch();
      const select = byId('root');
      const previous = keep || select.value;
      select.replaceChildren();
      for (const root of snapshot.roots) {
        const option = document.createElement('option');
        option.value = root.path; option.textContent = root.name + ' · ' + root.path;
        select.append(option);
      }
      if (snapshot.roots.some(root => root.path === previous)) select.value = previous;
      const empty = !snapshot.roots.length;
      byId('copy').disabled = empty || !snapshot.trusted || !snapshot.enabled;
      const warnings = [];
      if (!snapshot.trusted) warnings.push('工作区未信任，请先信任工作区再复制。');
      if (empty) warnings.push('没有可用的本地项目，请打开一个文件夹或点击“选择其他文件夹…”。');
      if (!snapshot.nodeFound) warnings.push('没有在 PATH 中找到 Node.js，配置里暂用 node，请确认其他工具能找到 Node.js 22.16+。');
      byId('status').textContent = warnings.join(' ');
      requestPreview();
    }
    for (const button of document.querySelectorAll('.fc-seg [data-format]')) {
      button.addEventListener('click', () => {
        format = button.dataset.format;
        for (const other of document.querySelectorAll('.fc-seg [data-format]')) other.setAttribute('aria-pressed', String(other === button));
        byId('result').textContent = '';
        requestPreview();
      });
    }
    byId('enabled').addEventListener('change', () => {
      const on = byId('enabled').checked;
      byId('enabled').disabled = true;
      enableError = '';
      send('enable', { enabled: on });
    });
    byId('root').addEventListener('change', requestPreview);
    byId('pick').addEventListener('click', () => send('pick'));
    byId('copy').addEventListener('click', () => send('copy', { kind: format, root: selected() }));
    byId('check').addEventListener('click', () => {
      byId('check').disabled = true;
      byId('check').textContent = '检测中…';
      byId('check-result').className = 'hint';
      byId('check-result').textContent = '正在向官方确认账号能力…';
      send('check');
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'fast-context-preview') {
        if (message.kind + '\\n' + message.root !== previewKey) return;
        byId('preview').textContent = message.error || message.text || '';
        byId('copy').disabled = Boolean(message.error) || !snapshot?.trusted || !snapshot?.enabled;
        return;
      }
      if (message?.type === 'fast-context-result') {
        if (message.enable) { enableError = message.text || ''; return; }
        const result = byId(message.check ? 'check-result' : 'result');
        result.textContent = message.text || '';
        result.className = message.ok ? 'hint' : 'warn';
        if (message.check) { byId('check').disabled = false; byId('check').textContent = '重新检测'; }
        return;
      }
      if (message?.type !== 'fast-context-state' || !message.state) return;
      snapshot = message.state;
      render(message.selected);
      renderCheck(snapshot.check);
    });
    send('state');
  })();`;
}
module.exports = { fastContextMarkup, fastContextScript, fastContextStyles };
