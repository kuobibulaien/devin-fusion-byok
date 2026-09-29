'use strict';
// Columns marked "extra" stay in the DOM but are hidden until "显示全部指标" is checked.
const COLUMNS = [['开始时间'], ['模型／档位'], ['状态'], ['用量', true], ['首响应 s'], ['输出 TPS'], ['输入'], ['输出'], ['缓存命中', true], ['推理', true],
  ['首输出 s', true], ['正文首字 s', true], ['正文 TPS', true], ['请求吞吐 TPS', true], ['总耗时 s'], ['会话关联', true]];
function monitorMarkup() {
  const head = COLUMNS.map(([label, extra]) => `<th${extra ? ' class="extra"' : ''}>${label}</th>`).join('');
  return `<div id="usage-monitor"><div class="monitor-controls"><select id="monitor-session" aria-label="选择会话"><option value="all">全部会话</option></select><button id="monitor-refresh" class="secondary" type="button">刷新</button><span class="spacer"></span><label class="toggle hint"><input id="monitor-detail" type="checkbox">显示全部指标</label></div><p id="monitor-status" class="warn mb" role="status">正在读取…</p><div id="monitor-summary" class="tiles"></div><div class="monitor-table-wrap"><table class="monitor-table"><thead><tr>${head}</tr></thead><tbody id="monitor-requests"></tbody></table></div></div>`;
}
function monitorScript() {
  return `
  (() => {
    let snapshot = null;
    const root = document.getElementById('usage-monitor');
    const selector = document.getElementById('monitor-session');
    const status = document.getElementById('monitor-status');
    const summary = document.getElementById('monitor-summary');
    const rows = document.getElementById('monitor-requests');
    const detail = document.getElementById('monitor-detail');
    const EXTRA = ${JSON.stringify(COLUMNS.map(([, extra]) => !!extra))};
    const format = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    const metricFormat = (key, value) => key.endsWith('Ms') && typeof value === 'number' && Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : format(value);
    const attribution = value => ({ 'response-id': '输出 ID 确认', 'tool-id': '本次工具 ID 确认', ambiguous: '存在歧义', unassigned: '未归属' }[value] || '未知');
    const stateName = value => ({ success: '成功', error: '失败', cancelled: '已取消' }[value] || '未知');
    const usageName = value => ({ complete: '完整', partial: '不完整', missing: '未上报', inconsistent: '数据异常' }[value] || '—');
    // [key, label, shown without detail]
    const METRICS = [['firstResponseMs','平均首响应 s',true],['gatewayTps','输出 TPS（网关）',true],['inputTokens','输入 token',true],['outputTokens','输出 token',true],['cachedTokens','缓存命中 token',true],['reasoningTokens','推理 token',false],['ttftMs','平均首输出 s',false],['textTtftMs','平均正文首字 s',false],['tps','正文 TPS（不含工具）',false],['throughputTps','请求吞吐（含等待）',false]];
    const FIELDS = ['firstResponseMs','gatewayTps','inputTokens','outputTokens','cachedTokens','reasoningTokens','firstOutputMs','firstTextMs','tps','throughputTps','durationMs'];
    function tile(value, label, title) {
      const node = document.createElement('div'); node.className = 'tile'; if (title) node.title = title;
      const v = document.createElement('span'); v.className = 'tile-value'; v.textContent = value;
      const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
      node.append(v); node.append(l); return node;
    }
    function render() {
      summary.replaceChildren(); rows.replaceChildren();
      if (!snapshot) return;
      const selected = selector.value === 'all' ? snapshot : snapshot.sessions.find(s => (s.sessionId || '__unassigned__') === selector.value);
      if (!selected) return;
      const s = selected.summary;
      summary.append(tile(format(s.requests), '请求' + (s.error ? ' · 失败 ' + s.error : '') + (s.cancelled ? ' · 取消 ' + s.cancelled : ''), '成功 ' + s.success + ' · 失败 ' + s.error + ' · 取消 ' + s.cancelled));
      for (const [key, label, basic] of METRICS) {
        if (!basic && !detail.checked) continue;
        const metric = s[key];
        summary.append(tile(metricFormat(key, metric?.value), label, '基于 ' + (metric?.reported ?? metric?.samples ?? 0) + '/' + s.requests + ' 次请求'));
      }
      for (const r of selected.records) {
        const row = document.createElement('tr');
        const values = [r.startedAt, r.model + (r.effort ? ' / ' + r.effort : ''), stateName(r.status), usageName(r.usageState), ...FIELDS.map(k => metricFormat(k, r[k])), attribution(r.attribution)];
        values.forEach((value, index) => { const cell = document.createElement('td'); if (EXTRA[index]) cell.className = 'extra'; cell.textContent = value; row.append(cell); });
        row.title = '请求 ID：' + r.id + (r.code ? ' · ' + r.code : ''); rows.append(row);
      }
      if (!selected.records.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = EXTRA.length; cell.className = 'hint'; cell.textContent = '还没有请求记录。'; row.append(cell); rows.append(row); }
    }
    selector.addEventListener('change', render);
    detail.addEventListener('change', () => { root.classList.toggle('detailed', detail.checked); render(); });
    document.getElementById('monitor-refresh').addEventListener('click', () => vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' }));
    window.addEventListener('message', event => {
      if (event.data?.type !== 'monitor-state') return;
      const result = event.data.result;
      snapshot = result?.snapshot || null;
      status.textContent = !snapshot ? (result?.status === 'unsupported' ? '用量统计未启用。' : '用量统计暂不可用。') : snapshot.storageError ? '统计存储异常。' : snapshot.sessionStatus !== 'ready' ? '会话归属待确认。' : '';
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
