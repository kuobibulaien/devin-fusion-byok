'use strict';
function updateMarkup() {
  return `<section class="card fusion-card"><div class="card-head"><h2>插件更新</h2><label><input id="update-auto" type="checkbox"> 自动检查（每 6 小时）</label></div><div class="card-content"><p id="update-status" role="status">尚未检查</p><pre id="update-notes" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><div class="actions"><button id="update-check" type="button">检查更新</button><button id="update-install" type="button" disabled>下载并安装</button><button id="update-ignore" type="button" disabled>忽略此版本</button><button id="update-release" type="button">打开发布页面</button></div><p class="hint">安装前会请求确认，不会自动重载当前窗口。启动时检查一次，网络失败不影响现有功能。</p></div></section>`;
}
function updateScript() {
  return `(() => {
    const byId = id => document.getElementById('update-' + id);
    const send = (action, payload) => vscode.postMessage({ id: 'update-' + action, type: 'update.' + action, payload });
    for (const action of ['check','install','ignore','release']) byId(action).addEventListener('click', () => send(action));
    byId('auto').addEventListener('change', () => send('auto', { enabled: byId('auto').checked }));
    window.addEventListener('message', event => {
      if (event.data?.type !== 'update-state') return;
      const s = event.data.state;
      const labels = { idle:'尚未检查', checking:'正在检查', error:'检查失败', available:'有新版本', ahead:'本地版本高于最新正式版', current:'已是最新正式版', installing:'等待确认或正在安装', installed:'安装命令已成功完成，请在方便时新建窗口或主动重载' };
      byId('status').textContent = '当前 ' + s.currentVersion + (s.latestVersion ? ' · 最新正式版 ' + s.latestVersion : '') + ' · ' + (labels[s.phase] || '') + (s.ignored ? '（已忽略提醒）' : '') + (s.error ? ' · ' + s.error : '');
      byId('notes').textContent = s.notes + (s.phase === 'available' && !s.canInstall ? '\\n暂不支持直接安装或安装包缺少安全校验信息，请打开发布页面。' : '');
      byId('auto').checked = s.autoCheck;
      byId('install').disabled = !s.canInstall;
      byId('ignore').disabled = s.phase !== 'available';
      byId('check').disabled = ['checking','installing','installed'].includes(s.phase);
    });
    send('state');
  })();`;
}
module.exports = { updateMarkup, updateScript };
