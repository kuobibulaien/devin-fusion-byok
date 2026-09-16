'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readReceipt, remember, saveReceipt, restoreObject, RECEIPT, POINTERS } = require('../src/lifecycle/owned-settings.cjs');
const { parse, restoreJsonc } = require('../src/lifecycle/jsonc-edit.cjs');
const { uninstall, restoreFile } = require('../src/lifecycle/uninstall.cjs');
const envPath = ['devin.acp.agentEnv', 'devin-cli', 'WINDSURF_API_SERVER_URL'];
const modelPath = ['devin.acp.agentPreferences', 'devin-cli', 'model'];
const managed = 'http://127.0.0.1:39842';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-restore-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'User/globalStorage/local.devin-fusion-byok');
  const extensionPath = path.join(directory, 'extensions/local.devin-fusion-byok-0.2.0');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(extensionPath, { recursive: true });
  const receipt = readReceipt(root, extensionPath);
  return { root, extensionPath, receipt, settings: receipt.settingsFile };
}
test('owned originals survive multiple windows and own Fusion changes, while native user choices survive restore', t => {
  const f = fixture(t);
  remember(f.receipt, envPath, { exists: true, value: 'https://original.example' }, managed);
  remember(f.receipt, modelPath, { exists: true, value: 'swe-2-max' }, 'fusion-dfbyok-first');
  saveReceipt(f.receipt);
  const again = readReceipt(f.root, f.extensionPath);
  remember(again, envPath, { exists: true, value: managed }, managed);
  remember(again, modelPath, { exists: true, value: 'fusion-dfbyok-native-sidekick' }, 'fusion-dfbyok-final');
  assert.equal(again.changes[1].original.value, 'swe-2-max');
  const input = { 'devin.acp.agentEnv': { 'devin-cli': { WINDSURF_API_SERVER_URL: managed, KEEP: 'keep' } },
    'devin.acp.agentPreferences': { 'devin-cli': { model: 'fusion-dfbyok-other', effort: 'high' } } };
  const restored = restoreObject(input, again.changes);
  assert.equal(restored.count, 2);
  assert.equal(restored.value['devin.acp.agentEnv']['devin-cli'].WINDSURF_API_SERVER_URL, 'https://original.example');
  assert.equal(restored.value['devin.acp.agentEnv']['devin-cli'].KEEP, 'keep');
  assert.equal(restored.value['devin.acp.agentPreferences']['devin-cli'].model, 'swe-2-max');
  input['devin.acp.agentPreferences']['devin-cli'].model = 'gpt-native';
  input['devin.acp.agentEnv']['devin-cli'].WINDSURF_API_SERVER_URL = 'https://user-edited.example';
  assert.equal(restoreObject(input, again.changes).count, 0);
  assert.equal(fs.statSync(path.join(f.root, RECEIPT)).mode & 0o777, 0o600);
});
test('a deliberate re-enable captures a user-edited original rather than an obsolete prior backup', t => {
  const f = fixture(t);
  remember(f.receipt, envPath, { exists: true, value: 'first' }, managed);
  remember(f.receipt, envPath, { exists: true, value: 'later-user-choice' }, managed);
  assert.equal(f.receipt.changes[0].original.value, 'later-user-choice');
});
test('JSONC restoration preserves unrelated bytes, comments and strings containing comment markers', () => {
  const source = `\ufeff{\n // before\n "devin.acp.agentEnv": {"devin-cli": {"WINDSURF_API_SERVER_URL": "${managed}", /* keep comment */ "KEEP":"a//b/*c*/",},},\n "devin.acp.agentPreferences": {"devin-cli": {"model":"fusion-dfbyok-current","effort":"high",}},\n "other": [1, true, null,], // retained\n}\n`;
  const changes = [{ path: envPath, managed, original: { exists: false } },
    { path: modelPath, managed: 'fusion-dfbyok-previous', original: { exists: true, value: 'native-max' } }];
  const result = restoreJsonc(source, changes);
  assert.equal(result.count, 2);
  assert.ok(result.text.includes('/* keep comment */ "KEEP":"a//b/*c*/"'));
  assert.ok(result.text.includes('"other": [1, true, null,], // retained'));
  assert.equal(parse(result.text).value['devin.acp.agentPreferences']['devin-cli'].model, 'native-max');
  assert.ok(!Object.hasOwn(parse(result.text).value['devin.acp.agentEnv']['devin-cli'], 'WINDSURF_API_SERVER_URL'));
});
test('JSONC parser refuses duplicate keys, missing separators, unterminated comments and invalid JSON values', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":01}', '{"a":1 "b":2}', '{/*', '{"a":undefined}', '{"a":"bad\nstring"}', '{"a":NaN}', '[]']) {
    assert.throws(() => parse(text));
  }
});
test('JSONC removal handles adjacent properties, last properties and all properties', () => {
  for (const names of [['HTTP_PROXY'], ['NO_PROXY'], ['HTTP_PROXY', 'HTTPS_PROXY'], ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']]) {
    const result = restoreJsonc('{"devin.acp.agentEnv":{"devin-cli":{"HTTP_PROXY":"x","HTTPS_PROXY":"x","NO_PROXY":"x"}}}',
      names.map(name => ({ path: ['devin.acp.agentEnv', 'devin-cli', name], managed: 'x', original: { exists: false } })));
    const actual = parse(result.text).value['devin.acp.agentEnv']['devin-cli'];
    assert.deepEqual(Object.keys(actual), ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].filter(name => !names.includes(name)));
  }
});
test('uninstall restores matching owned settings and retains an exact private backup', t => {
  const f = fixture(t);
  remember(f.receipt, envPath, { exists: false }, managed); saveReceipt(f.receipt);
  const original = `{// comment\n"devin.acp.agentEnv":{"devin-cli":{"WINDSURF_API_SERVER_URL":"${managed}","KEEP":"retained"}},"editor.fontSize":16}`;
  fs.writeFileSync(f.settings, original);
  assert.deepEqual(uninstall({ extensionPath: f.extensionPath }), { restored: 1, failed: 0 });
  assert.equal(fs.readFileSync(f.settings + '.fusion-byok-before-uninstall', 'utf8'), original);
  assert.equal(fs.statSync(f.settings + '.fusion-byok-before-uninstall').mode & 0o777, 0o600);
  assert.equal(parse(fs.readFileSync(f.settings, 'utf8')).value['devin.acp.agentEnv']['devin-cli'].KEEP, 'retained');
  assert.deepEqual(uninstall({ extensionPath: f.extensionPath }), { restored: 0, failed: 0 });
});
test('unsafe JSONC is unchanged, with secret-free logs and an external recovery receipt', t => {
  const f = fixture(t), logs = [];
  remember(f.receipt, envPath, { exists: true, value: 'private-original-value' }, managed); saveReceipt(f.receipt);
  const original = '{"private":"hidden-value",broken'; fs.writeFileSync(f.settings, original);
  assert.deepEqual(uninstall({ extensionPath: f.extensionPath, log: (...args) => logs.push(args) }), { restored: 0, failed: 1 });
  assert.equal(fs.readFileSync(f.settings, 'utf8'), original);
  assert.ok(!JSON.stringify(logs).includes('private-original-value'));
  assert.ok(!JSON.stringify(logs).includes('hidden-value'));
  assert.equal(fs.statSync(f.settings + '.fusion-byok-restore-pending.json').mode & 0o777, 0o600);
});
test('old package uninstall cannot revert a newer installation receipt', t => {
  const f = fixture(t); remember(f.receipt, envPath, { exists: false }, managed); saveReceipt(f.receipt);
  f.receipt.extensionPath += '-new'; fs.writeFileSync(path.join(f.root, RECEIPT), JSON.stringify(f.receipt));
  fs.writeFileSync(f.settings, `{"devin.acp.agentEnv":{"devin-cli":{"WINDSURF_API_SERVER_URL":"${managed}"}}}`);
  assert.deepEqual(uninstall({ extensionPath: f.extensionPath }), { restored: 0, failed: 0 });
  assert.ok(fs.readFileSync(f.settings, 'utf8').includes(managed));
});
test('settings changed during restoration are never overwritten', t => {
  const f = fixture(t); remember(f.receipt, envPath, { exists: false }, managed);
  fs.writeFileSync(f.settings, `{"devin.acp.agentEnv":{"devin-cli":{"WINDSURF_API_SERVER_URL":"${managed}"}}}`);
  const newer = '{"editor.fontSize":42}';
  assert.throws(() => restoreFile(f.receipt, { beforeCommit: () => fs.writeFileSync(f.settings, newer) }));
  assert.equal(fs.readFileSync(f.settings, 'utf8'), newer);
});
test('the uninstall hook is shipped inside the existing VSIX source directory', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['vscode:uninstall'], 'node src/lifecycle/uninstall.cjs');
  assert.ok(fs.existsSync(path.join(__dirname, '..', pkg.scripts['vscode:uninstall'].slice(5))));
});
