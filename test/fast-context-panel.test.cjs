'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderPanel } = require('../src/panel/view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
const { createFastContextHost, mcpConfig } = require('../src/fast-context/config-ui.cjs');
const { setupPrompt } = require('../src/fast-context/setup-prompt.cjs');
const { readEnabled, writeEnabled, storageDir } = require('../src/fast-context/state.cjs');

const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-panel-')));

test('the control panel tab is named for everything it offers, not just code search', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.match(html, /data-tab="fastcontext"[^>]*>对外提供 MCP<\/button>/);
  assert.doesNotMatch(html, />Fast Context<\/button>/);
  assert.match(html, /<h2>对外提供 MCP<\/h2>/);
  const section = html.slice(html.indexOf('id="view-fastcontext"'), html.indexOf('id="view-settings"'));
  for (const id of ['fc-check', 'fc-check-result', 'fc-cap-code', 'fc-cap-web', 'fc-cap-read', 'fc-enabled', 'fc-root', 'fc-pick', 'fc-copy', 'fc-preview'])
    assert.ok(section.includes(`id="${id}"`), id);
  for (const tool of ['code_search', 'web_search', 'web_read_url']) assert.ok(section.includes(tool), tool);
  assert.deepEqual([...section.matchAll(/data-format="(\w+)"/g)].map(match => match[1]), ['prompt', 'json']);
  // Off by default: the switch starts unchecked and disabled, step 3 starts locked.
  assert.match(section, /<input id="fc-enabled" class="switch" type="checkbox" role="switch" aria-label="开启对外 MCP" disabled>/);
  assert.match(section, /class="fc-step locked" id="fc-step-connect"/);
  assert.match(html, /'fastContext\.' \+ type/);
  // Every button in the tab is wired: the account check used to have no listener.
  assert.match(html, /byId\('enabled'\)\.addEventListener\('change'/);
  for (const id of ['check', 'pick', 'copy']) assert.match(html, new RegExp(`byId\\('${id}'\\)\\.addEventListener\\('click'`), id);
  assert.match(html, /send\('check'\)/);
  assert.match(html, /send\('preview', \{ kind: format, root \}\)/);
});

test('the account check button runs the self check and renders each capability', async () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const script = html.slice(html.lastIndexOf('<script'), html.lastIndexOf('</script>'));
  const listeners = {}, nodes = {}, posted = [], windowListeners = [];
  const node = id => nodes[id] ||= { id, dataset: {}, textContent: '', disabled: false, checked: false, value: '', title: '', className: '',
    classList: { values: new Set(), toggle(name, on) { on ? this.values.add(name) : this.values.delete(name); } },
    addEventListener: (type, fn) => { listeners[id + ':' + type] = fn; }, replaceChildren() { this.children = []; }, append(child) { (this.children ||= []).push(child); },
    setAttribute(name, value) { this[name] = value; } };
  const context = { document: { getElementById: node, querySelectorAll: () => [], createElement: () => ({}) },
    window: { addEventListener: (type, fn) => windowListeners.push(fn) }, vscode: { postMessage: message => posted.push(message) } };
  const body = script.slice(script.indexOf('(() => {\n    const byId'), script.lastIndexOf('})();') + 5);
  new Function('document', 'window', 'vscode', body)(context.document, context.window, context.vscode);
  listeners['fc-check:click']();
  assert.equal(posted.at(-1).type, 'fastContext.check');
  assert.equal(nodes['fc-check'].disabled, true);
  const deliver = data => windowListeners.forEach(fn => fn({ data }));
  deliver({ type: 'fast-context-result', check: true, ok: false, text: '网页搜索已关闭' });
  assert.equal(nodes['fc-check'].disabled, false);
  assert.equal(nodes['fc-check-result'].className, 'warn');
  deliver({ type: 'fast-context-state', state: { roots: [], trusted: true, nodeFound: true, check: { capabilities: { code: true, web: false }, at: 1 } } });
  assert.equal(nodes['fc-cap-code'].dataset.state, 'yes');
  assert.equal(nodes['fc-cap-web'].dataset.state, 'no');
  assert.equal(nodes['fc-cap-read'].textContent, '已关闭');
  // Eligible but not yet on: the switch unlocks, step 3 stays locked, nothing can be copied.
  assert.equal(nodes['fc-enabled'].disabled, false);
  assert.equal(nodes['fc-step-connect'].classList.values.has('locked'), true);
  assert.equal(nodes['fc-copy'].disabled, true);
  nodes['fc-enabled'].checked = true;
  nodes['fc-root'].value = '/a';
  listeners['fc-enabled:change']();
  assert.deepEqual(posted.at(-1).payload, { enabled: true });
  deliver({ type: 'fast-context-state', state: { enabled: true, roots: [{ name: 'a', path: '/a' }], trusted: true, nodeFound: true, check: { capabilities: { code: true, web: false } } } });
  assert.equal(nodes['fc-step-connect'].classList.values.has('locked'), false);
  assert.equal(nodes['fc-pill'].textContent, '已开启');
  assert.deepEqual(posted.at(-1).payload, { kind: 'prompt', root: '/a' });
  // Without a passing check the switch stays locked.
  deliver({ type: 'fast-context-state', state: { enabled: false, roots: [], trusted: true, nodeFound: true } });
  assert.equal(nodes['fc-enabled'].disabled, true);
  deliver({ type: 'fast-context-result', enable: true, ok: false, text: '请先检测账号' });
  deliver({ type: 'fast-context-state', state: { enabled: false, roots: [], trusted: true, nodeFound: true } });
  assert.equal(nodes['fc-enable-hint'].textContent, '请先检测账号');
});

test('setup prompt carries exact config, harness recipes and verification without secrets', () => {
  const config = mcpConfig({ extensionPath: "/ext/it's", root: '/项目/app', node: '/usr/bin/node' }).mcpServers['fusion-fast-context'];
  const prompt = setupPrompt({ ...config, platform: 'darwin' });
  assert.ok(prompt.includes(JSON.stringify(config.args)));
  assert.ok(prompt.includes(`claude mcp add fusion-fast-context --scope user -- '/usr/bin/node' '/ext/it'\\''s/src/fast-context/server.cjs' '--root' '/项目/app'`));
  assert.ok(prompt.includes('[mcp_servers.fusion-fast-context]'));
  for (const text of ['fast_context_status', 'code_search', 'web_search', 'web_read_url', '不要整文件覆盖', '用户级', '22.16']) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /fast_context_search/);
  assert.doesNotMatch(prompt, /WINDSURF_API_KEY|apiKey/);
  assert.throws(() => setupPrompt({ command: 'node', args: ['x'] }), /invalid_config/);
});

test('host copies prompt or config only for allowed, existing roots', async () => {
  const root = tempDir(), other = tempDir(), copied = [];
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ name: 'app', uri: { scheme: 'file', fsPath: root } }] },
    env: { clipboard: { writeText: async text => { copied.push(text); } } },
    window: { showOpenDialog: async () => [{ scheme: 'file', fsPath: other }] } };
  const stateDir = tempDir();
  let check;
  const checker = { state: () => check, run: async () => check, message: () => '' };
  const host = createFastContextHost({ vscode, context: { extensionPath: '/ext' }, resolve: () => '/bin/node', entry: () => undefined, stateDir, check: checker });
  assert.deepEqual(host.state().roots.map(item => item.path), [root]);
  assert.equal(host.state().enabled, false);
  await assert.rejects(host.copy('prompt', root), /fast_context_not_enabled/);
  await assert.rejects(host.setEnabled(true), /fast_context_check_required/);
  check = { capabilities: { code: false, web: null } };
  await assert.rejects(host.setEnabled(true), /fast_context_check_required/);
  check = { capabilities: { code: true, web: false } };
  assert.equal(await host.setEnabled(true), true);
  assert.equal(readEnabled({ dir: stateDir }), true);
  await host.copy('prompt', root);
  assert.match(copied[0], /fusion-fast-context/);
  await host.copy('json', root);
  assert.deepEqual(JSON.parse(copied[1]).mcpServers['fusion-fast-context'].args, ['/ext/src/fast-context/server.cjs', '--root', root]);
  for (const kind of ['claude', 'codex', 'evil']) assert.throws(() => host.preview(kind, root), /invalid_kind/);
  await assert.rejects(host.copy('prompt', other), /fast_context_root_not_allowed/);
  assert.equal(await host.pick(), other);
  await host.copy('prompt', other);
  assert.equal(copied.length, 3);
  const stable = createFastContextHost({ vscode, context: { extensionPath: '/ext' }, resolve: () => '/bin/node', entry: () => '/store/fusion-mcp.cjs', stateDir });
  assert.equal(stable.build(root).mcpServers['fusion-fast-context'].args[0], '/store/fusion-mcp.cjs');
  assert.equal(stable.state().stable, true);
  fs.rmSync(other, { recursive: true });
  await assert.rejects(host.copy('prompt', other), /fast_context_root_missing/);
  vscode.workspace.isTrusted = false;
  await assert.rejects(host.copy('prompt', root), /fast_context_untrusted/);
  vscode.workspace.isTrusted = true;
  assert.equal(await host.setEnabled(false), false);
  await assert.rejects(host.copy('prompt', root), /fast_context_not_enabled/);
  fs.rmSync(root, { recursive: true });
  fs.rmSync(stateDir, { recursive: true });
});

test('panel controller routes Fast Context messages without touching the config manager', async () => {
  let handler; const posted = [], calls = [];
  const panel = { reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', cspSource: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  const fastContext = { state: () => ({ roots: [], trusted: true }), pick: async () => '/picked',
    selfCheck: async () => ({ ok: false, reason: 'web_search_disabled' }), checkMessage: reason => 'msg:' + reason, preview: (kind, root) => kind + ':' + root,
    setEnabled: async on => { calls.push(['enable', on]); if (on) throw new Error('fast_context_check_required'); return false; },
    copy: async (kind, root) => { calls.push([kind, root]); if (root === '/bad') throw new Error('fast_context_root_not_allowed'); } };
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] }, fastContext, safeError: () => ({ message: 'x' }),
    manager: { state: () => ({}), dispatch: async () => { throw new Error('must not reach the manager'); } } });
  controller.open();
  await handler({ id: 'a', type: 'fastContext.copy', payload: { kind: 'prompt', root: '/ok' } });
  await handler({ id: 'b', type: 'fastContext.copy', payload: { kind: 'evil', root: '/bad' } });
  await handler({ id: 'd', type: 'fastContext.check' });
  await handler({ id: 'e', type: 'fastContext.preview', payload: { kind: 'json', root: '/ok' } });
  await handler({ id: 'h', type: 'fastContext.preview', payload: { kind: 'codex', root: '/ok' } });
  assert.deepEqual(posted.filter(message => message.type === 'fast-context-preview').map(message => message.text), ['json:/ok', 'prompt:/ok']);
  await handler({ id: 'f', type: 'fastContext.enable', payload: { enabled: true } });
  await handler({ id: 'g', type: 'fastContext.enable', payload: { enabled: 'yes' } });
  await handler({ id: 'c', type: 'fastContext.pick' });
  assert.deepEqual(calls, [['prompt', '/ok'], ['prompt', '/bad'], ['enable', true], ['enable', false]]);
  const enableError = posted.find(message => message.type === 'fast-context-result' && message.enable);
  assert.match(enableError.text, /先检测账号/);
  const results = posted.filter(message => message.type === 'fast-context-result');
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].text, /只能选择/);
  assert.deepEqual(results[2], { type: 'fast-context-result', check: true, ok: false, text: 'msg:web_search_disabled' });
  assert.equal(posted.filter(message => message.type === 'fast-context-state').at(-1).selected, '/picked');
});

test('the external MCP switch is off unless written on, and lives in Devin global storage', () => {
  const dir = tempDir();
  assert.equal(readEnabled({ dir }), false);
  writeEnabled(dir, true);
  assert.equal(readEnabled({ dir }), true);
  writeEnabled(dir, 'yes');
  assert.equal(readEnabled({ dir }), false);
  fs.writeFileSync(path.join(dir, 'external-mcp.json'), 'not json');
  assert.equal(readEnabled({ dir }), false);
  assert.equal(storageDir({ platform: 'darwin', home: '/h' }), '/h/Library/Application Support/Devin/User/globalStorage/local.devin-fusion-byok');
  // undefined selects the real user's default storage, which may be enabled.
  assert.equal(readEnabled({ dir: '' }), false);
  fs.rmSync(dir, { recursive: true });
});
