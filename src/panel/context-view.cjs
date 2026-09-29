'use strict';
const crypto = require('node:crypto');
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
const seconds = value => typeof value === 'number' && Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' s' : '—';
function contextDetails(session, monitor, catalog) {
  const usage = value => value ? `${number(value.used)} / ${number(value.size)} token · ${number(value.used / value.size * 100)}%` : '—';
  const label = uid => catalog?.models?.find(model => model.uid === uid)?.label || uid || '—';
  const fusion = catalog?.fusions?.[session?.modelUid];
  const rows = [{ key: 'model', label: '模型', value: label(session?.modelUid) }, { key: 'context', label: '主上下文', value: usage(session?.lead) },
    { key: 'turn', label: '本轮耗时 · 含等待', value: seconds(session?.turn?.durationMs) }];
  if (fusion) rows.push({ key: 'lead', label: '配置主模型', value: label(fusion.leadUid) }, { key: 'sidekick', label: '配置副模型', value: label(fusion.sidekickUid) });
  for (const subagent of session?.subagents || []) rows.push({ key: 'subagent:' + JSON.stringify([subagent.parentAgentId, subagent.runId]), label: '子代理', value: usage(subagent), title: `${subagent.parentAgentId} / ${subagent.runId ?? '—'}` });
  const matching = session ? monitor?.sessions?.filter(item => item.sessionId === session.sessionId) || [] : [];
  const records = matching.length === 1 ? matching[0].records || [] : [];
  const latest = records.reduce((best, record) => Number.isFinite(Date.parse(record.startedAt)) && (!best || Date.parse(record.startedAt) > Date.parse(best.startedAt)) ? record : best, null);
  const state = { success: '成功', error: '失败', cancelled: '已取消' };
  const request = [{ key: 'request', label: '最近请求', value: latest ? `${latest.model || '—'} · ${state[latest.status] || latest.status || '—'}` : '—' }];
  for (const [key, label] of [['durationMs', '请求耗时'], ['firstResponseMs', '首响应'], ['firstTextMs', '正文首字'], ['firstOutputMs', '首输出'], ['gatewayTps', '网关 TPS'], ['tps', '正文 TPS'], ['inputTokens', '输入 token'], ['outputTokens', '输出 token'], ['cachedTokens', '缓存 token'], ['reasoningTokens', '推理 token']]) request.push({ key, label, value: key.endsWith('Ms') ? seconds(latest?.[key]) : number(latest?.[key]) });
  const lines = [...rows, ...request].map(row => `${row.label}：${row.value}`);
  const tooltip = [rows[0], rows[1], ...request.slice(0, 7)].map(row => `${row.label}：${row.value}`).join('\n');
  return { percent: session?.lead ? Math.max(0, Math.min(100, session.lead.used / session.lead.size * 100)) : null, rows, request, lines, tooltip };
}
function contextHtml(nonce) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;margin:0;max-width:960px}*{box-sizing:border-box}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}select{min-width:0;max-width:65%;padding:6px 8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground)}.usage{display:flex;align-items:center;gap:10px;white-space:nowrap}svg{width:32px;height:32px;transform:rotate(-90deg);color:var(--vscode-progressBar-background)}circle{fill:none;stroke:currentColor;stroke-width:3}.track{opacity:.18}#percent{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;background:var(--vscode-panel-border);border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden;margin-bottom:16px}.metric{padding:14px;background:var(--vscode-editor-background);min-width:0}.label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:7px}.value{font-size:16px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;line-height:1.4}select:focus-visible{outline:1px solid var(--vscode-focusBorder)}
</style></head><body><div class="toolbar"><div class="usage"><svg viewBox="0 0 40 40" aria-label="上下文占用"><circle class="track" cx="20" cy="20" r="16"/><circle id="fill" cx="20" cy="20" r="16" stroke-dasharray="100.531" stroke-dashoffset="100.531"/></svg><span id="percent">—</span></div><select id="sessions" aria-label="选择上下文会话"></select></div><div id="context" class="grid"></div><div id="request" class="grid"></div><script nonce="${nonce}">${contextScript()}</script></body></html>`;
}
function contextScript() {
  return `const vscode=acquireVsCodeApi();let items=[],sessionKeys='';const selector=document.getElementById('sessions');const grids=new Map();
function text(node,value){if(node.textContent!==value)node.textContent=value;}
function grid(id,rows){const root=document.getElementById(id);let cells=grids.get(id);const keys=JSON.stringify(rows.map(row=>row.key));if(!cells||cells.keys!==keys){root.replaceChildren();cells={keys,nodes:[]};for(const row of rows){const cell=document.createElement('div'),label=document.createElement('div'),value=document.createElement('div');cell.className='metric';label.className='label';value.className='value';cell.append(label,value);root.append(cell);cells.nodes.push({cell,label,value});}grids.set(id,cells);}rows.forEach((row,i)=>{const nodes=cells.nodes[i];text(nodes.label,row.label);text(nodes.value,row.value);if(nodes.cell.title!==(row.title||''))nodes.cell.title=row.title||'';});}
function render(){const item=items.find(x=>x.sessionId===selector.value);const percent=item?.percent;text(document.getElementById('percent'),percent==null?'—':percent.toFixed(1)+'%');const fill=document.getElementById('fill'),offset=String(100.531*(1-(percent??0)/100));if(fill.getAttribute('stroke-dashoffset')!==offset)fill.setAttribute('stroke-dashoffset',offset);grid('context',item?.rows||[]);grid('request',item?.request||[]);}
selector.addEventListener('change',()=>{render();vscode.postMessage({type:'selectSession',sessionId:selector.value});});window.addEventListener('message',event=>{if(event.data?.type!=='context')return;const previous=selector.value;items=event.data.items;const keys=JSON.stringify(items.map(x=>x.sessionId).sort());if(keys!==sessionKeys){sessionKeys=keys;selector.replaceChildren();for(const item of items){const option=document.createElement('option');option.value=item.sessionId;option.title=item.sessionId;selector.append(option);}if(items.some(x=>x.sessionId===previous))selector.value=previous;}for(const option of selector.children){const item=items.find(x=>x.sessionId===option.value);text(option,item?.label||'暂无会话');}if(items.some(x=>x.sessionId===event.data.selectedSessionId))selector.value=event.data.selectedSessionId;render();});vscode.postMessage({type:'ready'});`;
}
function createContextUi({ vscode, context, snapshot, readMonitor, catalog, isEnabled = () => true }) {
  let panel, disposed = false, pending = null, monitor = null, lastRead = -Infinity, shown = false, lastPayload = null, selectedSessionId = null, nextSessionLabel = 0;
  const sessionLabels = new Map();
  const item = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 19);
  if (item) item.command = 'devinFusionByok.contextDetails';
  function post(values, force) {
    if (!panel || panel.visible === false) return;
    const message = { type: 'context', items: values, selectedSessionId };
    const payload = JSON.stringify(message);
    if (force || payload !== lastPayload) { lastPayload = payload; panel.webview.postMessage(message); }
  }
  function refresh(force = false) {
    if (disposed) return;
    if (!isEnabled()) { monitor = null; selectedSessionId = null; sessionLabels.clear(); nextSessionLabel = 0; if (shown) { item?.hide(); shown = false; } post([], force); return; }
    const sessions = snapshot(), currentCatalog = catalog();
    for (const id of sessionLabels.keys()) if (!sessions.some(session => session.sessionId === id)) sessionLabels.delete(id);
    const values = sessions.map(session => {
      if (!sessionLabels.has(session.sessionId)) sessionLabels.set(session.sessionId, ++nextSessionLabel);
      const details = contextDetails(session, monitor, currentCatalog);
      return { sessionId: session.sessionId, label: `会话 ${sessionLabels.get(session.sessionId)} · ${details.rows[0].value}`, ...details };
    });
    if (!values.some(value => value.sessionId === selectedSessionId)) selectedSessionId = values[0]?.sessionId ?? null;
    const latest = values.find(value => value.sessionId === selectedSessionId) || contextDetails(null);
    if (!values.length) values.push({ sessionId: '', ...latest });
    if (item) {
      const text = '$(circle-outline) 上下文' + (latest.percent === null ? ' —' : ' ' + latest.percent.toFixed(0) + '%');
      if (item.text !== text) item.text = text;
      if (item.tooltip !== latest.tooltip) item.tooltip = latest.tooltip;
      if (!shown) { item.show(); shown = true; }
    }
    post(values, force);
    if (!pending && Date.now() - lastRead >= 5000) {
      lastRead = Date.now();
      pending = Promise.resolve().then(readMonitor).then(result => { if (!disposed && isEnabled()) monitor = result?.snapshot || null; }, () => { monitor = null; }).finally(() => { pending = null; });
    }
  }
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); refresh(true); return; }
    panel = vscode.window.createWebviewPanel('devinFusionByok.context', 'Fusion 上下文与性能', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    lastPayload = null;
    const current = panel;
    current.webview.html = contextHtml(crypto.randomBytes(24).toString('hex'));
    const listener = current.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') refresh(true);
      if (message?.type === 'selectSession' && isEnabled() && snapshot().some(session => session.sessionId === message.sessionId)) { selectedSessionId = message.sessionId; refresh(); }
    });
    const visibility = current.onDidChangeViewState?.(() => { if (current.visible) refresh(true); });
    const closing = current.onDidDispose(() => { listener.dispose(); visibility?.dispose(); closing.dispose(); if (panel === current) { panel = null; lastPayload = null; } });
  }
  const command = vscode.commands.registerCommand('devinFusionByok.contextDetails', open);
  const timer = setInterval(() => { try { refresh(); } catch {} }, 1000); timer.unref?.();
  const handle = { dispose() { disposed = true; clearInterval(timer); command.dispose(); item?.dispose(); panel?.dispose(); }, refresh };
  context.subscriptions.push(handle); refresh(); return handle;
}
module.exports = { contextDetails, contextHtml, contextScript, createContextUi };
