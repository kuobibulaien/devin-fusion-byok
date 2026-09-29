'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPanel } = require('../src/panel/view.cjs');
const { monitorScript } = require('../src/panel/monitor-view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
test('monitor browser script compiles, uses text nodes, and preserves zero versus missing', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} } });
  const record = { id: 'id', startedAt: 'now', model: '<img onerror=alert(1)>', status: 'success', inputTokens: 0, outputTokens: null, usageComplete: false, attribution: 'unassigned' };
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary: { requests: 1, success: 1, error: 0, cancelled: 0 }, records: [record], sessions: [], sessionStatus: 'ready' } } } });
  const cells = byId('monitor-requests').children[0].children;
  assert.equal(cells[1].textContent, '<img onerror=alert(1)>');
  assert.equal(cells[6].textContent, '0'); assert.equal(cells[7].textContent, '—');
  assert.equal(cells[4].textContent, '—'); assert.equal(cells[5].textContent, '—');
  Object.assign(record, { firstResponseMs: 1234, firstOutputMs: 0, firstTextMs: 25, durationMs: 4567, gatewayTps: 1234 });
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary: { requests: 1, firstResponseMs: { value: 1234 }, ttftMs: { value: 0 }, textTtftMs: { value: 25 } }, records: [record], sessions: [], sessionStatus: 'ready' } } } });
  const secondsCells = byId('monitor-requests').children[0].children;
  assert.equal(secondsCells[4].textContent, '1.234'); assert.equal(secondsCells[10].textContent, '0');
  assert.equal(secondsCells[11].textContent, '0.025'); assert.equal(secondsCells[14].textContent, '4.567');
  assert.equal(secondsCells[5].textContent, '1,234');
  const tiles = new Map(byId('monitor-summary').children.map(tile => [tile.children[1].textContent, tile.children[0].textContent]));
  assert.equal(tiles.get('平均首响应 s'), '1.234');
  assert.equal(tiles.has('平均首输出 s'), false, 'secondary metrics stay hidden until the detail toggle is on');
  byId('monitor-detail').checked = true; byId('usage-monitor').classList = { toggle() {} };
  byId('monitor-detail').listeners.change();
  const detailed = new Map(byId('monitor-summary').children.map(tile => [tile.children[1].textContent, tile.children[0].textContent]));
  assert.equal(detailed.get('平均首输出 s'), '0'); assert.equal(detailed.get('平均正文首字 s'), '0.025');
  assert.equal(byId('monitor-status').hidden, true);
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.match(html, /id="usage-monitor"/); assert.match(html, /connect-src 'none'/);
  new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
});
test('usage monitor renders once inside the usage tab', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const monitor = html.indexOf('id="usage-monitor"');
  assert.equal(html.indexOf('id="usage-monitor"', monitor + 1), -1, 'usage monitor markup appears once');
  assert.ok(monitor > html.indexOf('id="view-usage"'), 'usage monitor sits in the usage tab');
  assert.ok(monitor < html.indexOf('id="view-settings"'), 'usage monitor stays out of the settings tab');
});
test('panel refresh is isolated, concurrent reads are coalesced and disposal suppresses posts', async () => {
  const posts = []; let onMessage, onClose, finish, reads = 0;
  const disposable = { dispose() {} };
  const panel = { visible: true, webview: { cspSource: 'test:', postMessage: async data => { posts.push(data); }, onDidReceiveMessage(fn) { onMessage = fn; return disposable; } }, onDidDispose(fn) { onClose = fn; return disposable; }, reveal() {}, dispose() { onClose(); } };
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } }, context: { subscriptions: [] }, manager: { state: () => ({}), dispatch() { throw new Error('must not dispatch monitor'); } }, safeError: () => ({ message: 'error' }), readMonitor: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  controller.open();
  await onMessage({ id: 'refresh', type: 'monitor.refresh' });
  assert.equal(reads, 1);
  onClose(); finish({ status: 'ready', snapshot: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.length, 0);
});
