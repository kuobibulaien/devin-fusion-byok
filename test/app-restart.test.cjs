'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { restartApp, relaunchScript, appBundle } = require('../src/runtime/app-restart.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');

test('the bundle is derived from the app root and rejected otherwise', () => {
  assert.equal(appBundle('/Applications/Devin.app/Contents/Resources/app'), '/Applications/Devin.app');
  assert.equal(appBundle('/opt/devin/resources/app'), '');
  assert.equal(appBundle(undefined), '');
});

test('the relaunch helper is valid shell, quotes the bundle and gives up after the wait', () => {
  const script = relaunchScript("/Applications/Dev in's.app", 90);
  execFileSync('/bin/sh', ['-n', '-c', script]);
  assert.match(script, /\[ \$i -gt 180 \] && exit 0/);
  assert.ok(script.includes("/usr/bin/open '/Applications/Dev in'\\''s.app'"));
});

test('restart spawns a detached helper before quitting', async () => {
  const calls = [];
  const vscode = { env: { appRoot: '/Applications/Devin.app/Contents/Resources/app' },
    commands: { executeCommand: async command => calls.push(['command', command]) } };
  const spawn = (file, args, options) => { calls.push(['spawn', file, options.detached]); return { unref() { calls.push(['unref']); } }; };
  assert.equal(await restartApp({ vscode, spawn, platform: 'darwin' }), '/Applications/Devin.app');
  assert.deepEqual(calls, [['spawn', '/bin/sh', true], ['unref'], ['command', 'workbench.action.quit']]);
  await assert.rejects(restartApp({ vscode, spawn, platform: 'linux' }), /restart_unsupported/);
});

function panelHarness(choice, restartApp) {
  let handler; const posted = [];
  const panel = { visible: true, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', cspSource: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  const warnings = [];
  const vscode = { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel,
    showWarningMessage: async (...args) => { warnings.push(args); return choice; } } };
  const controller = createPanelController({ vscode, context: { subscriptions: [] }, restartApp,
    manager: { state: () => ({}), dispatch: async () => { throw new Error('restart must not reach the manager'); } }, safeError: () => ({ message: 'x' }) });
  controller.open();
  return { send: message => handler(message), posted, warnings };
}

test('the panel restarts only after the modal is confirmed', async () => {
  let restarts = 0;
  const confirmed = panelHarness('重启', async () => { restarts++; });
  await confirmed.send({ id: 'a', type: 'app.restart' });
  assert.equal(restarts, 1);
  assert.equal(confirmed.warnings[0][1].modal, true);
  assert.deepEqual(confirmed.posted.find(m => m.type === 'result'), { type: 'result', id: 'a', ok: true, cancelled: false });

  const cancelled = panelHarness(undefined, async () => { restarts++; });
  await cancelled.send({ id: 'b', type: 'app.restart' });
  assert.equal(restarts, 1);
  assert.equal(cancelled.posted.find(m => m.type === 'result').cancelled, true);
});

test('restart failures are reported without leaking details', async () => {
  const failed = panelHarness('重启', async () => { throw new Error('secret detail'); });
  await failed.send({ id: 'c', type: 'app.restart' });
  const result = failed.posted.find(m => m.type === 'result');
  assert.equal(result.ok, false);
  assert.equal(result.error, '无法自动重启 Devin，请手动退出后重新打开。');
});
