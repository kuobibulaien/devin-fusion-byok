'use strict';
function fastContextMarkup() {
  return `<div id="fast-context">
      <div class="section-head"><h2>Fast Context MCP</h2></div>
      <p>把 Devin 的代码检索和网页搜索作为 MCP 服务，提供给 Claude Code、Codex、Cursor 等其他 Harness 使用。复制下面的提示词发给那边的 Agent，它会照着把这个 MCP 配置好并自行验证。</p>
      <div class="list">
        <div class="setting"><div class="row-main"><span class="row-title">一键鉴权</span><span class="row-sub">读取本机 Devin 的登录，向官方服务确认代码搜索、网页搜索、网页读取三项能力是否可用。不会发送任何项目内容，也不会显示或保存你的凭证。</span></div><div class="actions"><button id="fc-check" type="button">一键鉴权</button></div></div>
        <div class="setting"><div class="row-main"><span class="row-title">能力</span><span class="row-sub" id="fc-abilities">尚未检测，点一下上面的按钮就能看到结果。</span></div><div class="actions"><button id="fc-recopy" class="quiet" type="button" hidden>重新复制提示词</button></div></div>
        <div class="setting"><div class="row-main"><span class="row-title">允许搜索的项目</span><span class="row-sub">每份配置只能搜索这一个目录，需要别的项目时换一个再复制。</span></div><div class="actions"><button id="fc-pick" class="quiet" type="button">选择其他文件夹…</button></div></div>
        <div class="setting"><select id="fc-root" aria-label="允许搜索的项目"></select></div>
        <div class="setting"><div class="row-main"><span class="row-title">一键复制提示词</span><span class="row-sub">发给其他 Harness 里的 Agent，让它自己完成配置和验证。</span></div><div class="actions"><button id="fc-copy-config" class="secondary" type="button">复制配置 JSON</button><button id="fc-copy-prompt" type="button">复制提示词</button></div></div>
      </div>
      <p id="fc-check-result" class="hint" role="status" aria-live="polite"></p>
      <p id="fc-status" class="warn mt" role="status"></p>
      <p id="fc-result" class="hint" role="status" aria-live="polite"></p>
      <h3 class="mt">配置预览</h3>
      <pre id="fc-preview" class="update-notes setting mono"></pre>
      <h3 class="mt">注意</h3>
      <ul>
        <li>使用本机 Devin 已登录的账号，会把检索问题、选中的代码片段或网页地址发送到官方服务，可能消耗账号额度。</li>
        <li>网页搜索和网页读取跟随账号的网页搜索开关；开关关闭或团队禁用时不会绕过，只会如实提示。</li>
        <li>配置里不含任何密钥；只读，不会修改项目文件。</li>
        <li>需要 Node.js 22.16 以上（推荐 24 LTS）。插件升级后入口路径会变，请重新复制。</li>
      </ul>
    </div>`;
}
function fastContextScript() {
  return `
  (() => {
    const byId = id => document.getElementById('fc-' + id);
    let snapshot = null;
    const selected = () => byId('root').value;
    const ABILITY = {
      ok: '可用：代码搜索、网页搜索、网页读取',
      web_search_disabled: '代码搜索可用；网页搜索、网页读取已被开关或团队禁用',
      fast_context_disabled: 'Fast Context 已被团队禁用，代码搜索不可用',
      unauthenticated: '未登录或登录已失效',
      credentials_unavailable: '没有读到本机 Devin 的登录',
      insecure_tls_configuration: '系统关闭了 HTTPS 证书校验',
      unavailable: '暂时连不上官方服务',
    };
    function renderCheck(check) {
      const label = byId('abilities');
      if (!check) { label.textContent = '尚未检测，点一下上面的按钮就能看到结果。'; return; }
      label.textContent = (ABILITY[check.reason] || ABILITY.unavailable) + ' · ' + new Date(check.at).toLocaleTimeString();
    }
    const send = (type, payload) => vscode.postMessage({ id: 'fc-' + Date.now(), type: 'fastContext.' + type, payload });
    function preview() {
      const root = selected();
      if (!snapshot || !root) { byId('preview').textContent = '请先打开或选择一个本地项目文件夹。'; return; }
      byId('preview').textContent = JSON.stringify({ mcpServers: { 'fusion-fast-context': { command: snapshot.node, args: [snapshot.server, '--root', root] } } }, null, 2);
    }
    function render(keep) {
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
      byId('copy-prompt').disabled = empty || !snapshot.trusted;
      byId('copy-config').disabled = empty || !snapshot.trusted;
      const warnings = [];
      if (!snapshot.trusted) warnings.push('工作区未信任，请先信任工作区再复制。');
      if (empty) warnings.push('没有可用的本地项目，请打开一个文件夹或点击“选择其他文件夹…”。');
      if (!snapshot.nodeFound) warnings.push('没有在 PATH 中找到 Node.js，配置里暂用 node，请确认其他 Harness 能找到 Node.js 22.16+。');
      byId('status').textContent = warnings.join(' ');
      preview();
    }
    byId('root').addEventListener('change', preview);
    byId('pick').addEventListener('click', () => send('pick'));
    byId('copy-prompt').addEventListener('click', () => send('copy', { kind: 'prompt', root: selected() }));
    byId('copy-config').addEventListener('click', () => send('copy', { kind: 'config', root: selected() }));
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'fast-context-result') {
        const result = byId(message.check ? 'check-result' : 'result');
        result.textContent = message.text || '';
        result.className = message.ok ? 'hint' : 'warn';
        if (message.check) byId('check').disabled = false;
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
module.exports = { fastContextMarkup, fastContextScript };
