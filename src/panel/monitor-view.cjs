'use strict';
function monitorMarkup() {
  return `<details id="usage-monitor" class="card fusion-card" open><summary class="card-head">用量与性能</summary><div class="card-content"><div class="toolbar space-top"><select id="monitor-session" aria-label="选择监控会话"><option value="all">全部会话</option></select><button id="monitor-refresh" type="button">刷新统计</button></div><p id="monitor-status" class="hint" role="status">正在读取监控…</p><div id="monitor-summary" class="space-top"></div><div class="monitor-table-wrap space-top"><table class="monitor-table"><thead><tr><th>开始时间</th><th>模型／档位</th><th>状态</th><th>用量</th><th>首响应 s</th><th>输出 TPS（网关）</th><th>输入</th><th>输出</th><th>缓存命中</th><th>推理</th><th>首输出 s</th><th>正文首字 s</th><th>正文 TPS</th><th>请求吞吐 TPS</th><th>总耗时 s</th><th>会话关联</th></tr></thead><tbody id="monitor-requests"></tbody></table></div></div></details>`;
}
function monitorScript() {
  return `
  (() => {
    let snapshot = null;
    const selector = document.getElementById('monitor-session');
    const status = document.getElementById('monitor-status');
    const summary = document.getElementById('monitor-summary');
    const rows = document.getElementById('monitor-requests');
    const format = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    const metricFormat = (key, value) => key.endsWith('Ms') && typeof value === 'number' && Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : format(value);
    const attribution = value => ({ 'response-id': '输出 ID 确认', 'tool-id': '本次工具 ID 确认', ambiguous: '存在歧义', unassigned: '未归属' }[value] || '未知');
    const stateName = value => ({ success: '成功', error: '失败', cancelled: '已取消' }[value] || '未知');
    const usageName = value => ({ complete: '完整', partial: '不完整', missing: '未上报', inconsistent: '数据异常（缓存或推理超过总数）' }[value] || '—');
    const METRICS = [['firstResponseMs','平均首响应 s'],['gatewayTps','网关输出 TPS（含推理与工具）'],['inputTokens','输入 token'],['outputTokens','输出 token'],['cachedTokens','缓存命中 token'],['reasoningTokens','推理 token'],['ttftMs','平均首输出 s'],['textTtftMs','平均正文首字 s'],['tps','最近有效正文 TPS（不含工具调用）'],['throughputTps','请求吞吐（含等待）']];
    const FIELDS = ['firstResponseMs','gatewayTps','inputTokens','outputTokens','cachedTokens','reasoningTokens','firstOutputMs','firstTextMs','tps','throughputTps','durationMs'];
    function render() {
      summary.replaceChildren(); rows.replaceChildren();
      if (!snapshot) return;
      const selected = selector.value === 'all' ? snapshot : snapshot.sessions.find(s => (s.sessionId || '__unassigned__') === selector.value);
      if (!selected) return;
      const s = selected.summary;
      const count = document.createElement('p');
      count.textContent = '请求 ' + s.requests + ' · 成功 ' + s.success + ' · 失败 ' + s.error + ' · 取消 ' + s.cancelled;
      summary.append(count);
      for (const [key, label] of METRICS) {
        const metric = s[key]; const item = document.createElement('span');
        item.className = 'monitor-metric';
        item.textContent = label + '：' + metricFormat(key, metric?.value) + '（' + (metric?.reported ?? metric?.samples ?? 0) + '/' + s.requests + ' 次）';
        summary.append(item);
      }
      for (const r of selected.records) {
        const row = document.createElement('tr');
        const values = [r.startedAt, r.model + (r.effort ? ' / ' + r.effort : ''), stateName(r.status), usageName(r.usageState), ...FIELDS.map(k => metricFormat(k, r[k])), attribution(r.attribution)];
        for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        row.title = '请求 ID：' + r.id + (r.code ? ' · ' + r.code : ''); rows.append(row);
      }
    }
    selector.addEventListener('change', render);
    document.getElementById('monitor-refresh').addEventListener('click', () => vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' }));
    window.addEventListener('message', event => {
      if (event.data?.type !== 'monitor-state') return;
      const result = event.data.result;
      snapshot = result?.snapshot || null;
      status.textContent = !snapshot ? (result?.status === 'unsupported' ? '监控未启用' : '监控不可用') : snapshot.storageError ? '存储异常' : snapshot.sessionStatus !== 'ready' ? '会话归属待确认' : '';
      status.hidden = !status.textContent;
      const previous = selector.value; selector.replaceChildren();
      const all = document.createElement('option'); all.value = 'all'; all.textContent = '全部会话'; selector.append(all);
      for (const session of snapshot?.sessions || []) { const option = document.createElement('option'); option.value = session.sessionId || '__unassigned__'; option.textContent = session.sessionId ? session.sessionId + ' · ' + attribution(session.attribution) : '未归属／有歧义'; selector.append(option); }
      if ([...selector.options].some(o => o.value === previous)) selector.value = previous;
      render();
    });
  })();`;
}
module.exports = { monitorMarkup, monitorScript };
