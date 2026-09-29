'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPanel } = require('../src/panel/view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');

test('the control panel has a Goal tab marked Beta that explains the /goal commands', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const tabs = [...html.matchAll(/id="tab-([a-z]+)"/g)].map(match => match[1]);
  assert.deepEqual(tabs, ['presets', 'models', 'usage', 'goal', 'settings']);
  assert.match(html, /data-tab="goal">Goal <span class="badge beta">Beta<\/span><\/button>/);
  const section = html.slice(html.indexOf('id="view-goal"'), html.indexOf('id="view-settings"'));
  assert.ok(section.includes('hidden>'));
  for (const command of ['/goal 要达成的目标', '>/goal<', '/goal pause', '/goal resume', '/goal clear']) {
    assert.ok(section.includes(command), command);
  }
  assert.match(section, /id="open-goal"/);
  assert.match(section, /测试版/);
  assert.match(html, /TAB_IDS = \['presets', 'models', 'usage', 'goal', 'settings'\]/);
});

test('the Goal tab button opens the goal progress view without reaching the config manager', async () => {
  let handler; const posted = [], commands = [];
  const panel = { reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', cspSource: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  const vscode = { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel },
    commands: { executeCommand: async command => { commands.push(command); } } };
  const controller = createPanelController({ vscode, context: { subscriptions: [] },
    manager: { state: () => ({}), dispatch: async () => { throw new Error('must not reach the manager'); } }, safeError: () => ({ message: 'x' }) });
  controller.open();
  await handler({ id: 'g1', type: 'goal.open' });
  assert.deepEqual(commands, ['devinFusionByok.goal']);
  assert.deepEqual(posted.filter(message => message.type === 'result'), [{ type: 'result', id: 'g1', ok: true }]);
});
