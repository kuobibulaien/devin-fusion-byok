'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPanel } = require('../src/panel/view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');

test('the control panel has a Goal tab with an off-by-default switch that explains the /goal commands', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const tabs = [...html.matchAll(/id="tab-([a-z]+)"/g)].map(match => match[1]);
  assert.deepEqual(tabs, ['presets', 'models', 'usage', 'goal', 'fastcontext', 'settings']);
  assert.match(html, /data-tab="goal">目标<\/button>/);
  assert.doesNotMatch(html, /Beta|测试版/);
  const section = html.slice(html.indexOf('id="view-goal"'), html.indexOf('id="view-fastcontext"'));
  assert.ok(section.includes('hidden>'));
  for (const command of ['/goal 要达成的目标', '>/goal<', '/goal pause', '/goal resume', '/goal clear']) {
    assert.ok(section.includes(command), command);
  }
  assert.match(section, /id="open-goal"/);
  assert.match(section, /<input id="goal-enabled" class="switch" type="checkbox" role="switch" aria-label="开启目标模式" disabled>/);
  assert.match(html, /request\('setGoalEnabled', \{ enabled: value \}\)/);
  assert.match(html, /TAB_IDS = \['presets', 'models', 'usage', 'goal', 'fastcontext', 'settings'\]/);
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

test('manager stores the goal switch as a strict boolean, off by default', async () => {
  const { createManager } = require('../src/panel/model.cjs');
  let saved = { enabled: true, providers: [] };
  const manager = createManager({ read: () => saved, write: value => { saved = value; } });
  assert.equal(manager.state().goalEnabled, false);
  await assert.rejects(manager.dispatch('setGoalEnabled', { enabled: 'true' }), /目标模式/);
  assert.equal((await manager.dispatch('setGoalEnabled', { enabled: true })).goalEnabled, true);
  assert.equal(saved.goalEnabled, true);
  assert.equal((await manager.dispatch('setGoalEnabled', { enabled: false })).goalEnabled, false);
});
