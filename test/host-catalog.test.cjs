'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { buildCatalog, collectNativeModels } = require('../src/catalog.cjs');
const wire = require('../src/protocol/wire.cjs');
const { transformStatus } = require('../src/runtime/host-catalog.cjs');
const concat = (...parts) => Buffer.concat(parts.flat());
const rpc = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
function data() {
  const config = { providers: [{ id: 'p', name: 'Provider', models: [{ id: 'model', efforts: ['low', 'high'] }] }] };
  const catalog = buildCatalog(config);
  catalog.homeConfigured = true; catalog.homeModelUids = [catalog.models[0].uid];
  const native = concat(wire.s(1, 'Official locked'), wire.v(4, 1), wire.s(22, 'official-locked'));
  const raw = concat(wire.s(3, 'account-field'), wire.v(1, 0), wire.m(33, concat(wire.m(1, native),
    wire.m(2, concat(wire.s(1, 'Recommended'), wire.m(2, concat(wire.s(1, 'Recommended'), wire.s(2, 'Official locked'))))))), wire.v(99, 42));
  return { catalog, native, raw, status: { apiKey: 'test-do-not-log', apiServerUrl: 'https://server.codeium.com',
    allowedCommandModelConfigsProtoBinaryBase64: ['keep'], userStatusProtoBinaryBase64: raw.toString('base64'), future: {} } };
}
test('host auth publication contains own models and curated groups while account fields stay byte-identical', () => {
  const { catalog, raw, status, native } = data(); let observed;
  const changed = transformStatus(status, () => { assert.equal(observed[0].uid, 'official-locked'); return catalog; }, entries => { observed = entries; });
  assert.notEqual(changed, status);
  assert.equal(changed.apiKey, status.apiKey); assert.equal(changed.future, status.future);
  assert.equal(changed.allowedCommandModelConfigsProtoBinaryBase64, status.allowedCommandModelConfigsProtoBinaryBase64);
  assert.equal(status.userStatusProtoBinaryBase64, raw.toString('base64'));
  const result = Buffer.from(changed.userStatusProtoBinaryBase64, 'base64');
  assert.deepEqual(wire.parseFields(result).filter(f => f.number !== 33).map(f => f.raw), wire.parseFields(raw).filter(f => f.number !== 33).map(f => f.raw));
  const list = wire.fields(result, 33)[0].value;
  assert.deepEqual(wire.fields(list, 1).at(-1).value, native);
  assert.equal(wire.fields(list, 1).length, catalog.models.length + 1);
  assert.equal(wire.str(wire.fields(wire.fields(list, 2)[0].value, 2)[0].value, 1), '首页模型');
  const again = transformStatus(changed, catalog);
  assert.deepEqual(again, changed, 'repeated publication is idempotent');
});
test('absent, malformed, and empty status pass through, and an unconfigured catalog makes no changes', () => {
  for (const status of [null, undefined, {}, { userStatusProtoBinaryBase64: 'broken?' }, { userStatusProtoBinaryBase64: '====' }, { userStatusProtoBinaryBase64: '' }])
    assert.equal(transformStatus(status, buildCatalog({ providers: [] })), status);
  const { status } = data();
  assert.equal(transformStatus(status, buildCatalog({ providers: [] })), status);
});
function fixture() {
  const filename = path.resolve(__dirname, '../src/runtime/host-catalog.cjs'), realRequire = createRequire(filename);
  const sent = [], logs = [], commands = [], module = { exports: {} };
  let enabled = true, catalog = data().catalog;
  const result = Promise.resolve('native-return');
  const api = { setAuthStatus(...args) { sent.push({ args, thisArg: this }); return result; } };
  const original = api.setAuthStatus;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, require: name => name === 'node:module'
    ? { createRequire: () => () => ({ windsurfAuth: api }) } : realRequire(name) });
  const install = changes => module.exports.installHostCatalog({ nativeMainPath: '/native/main.js', getCatalog: () => catalog,
    isEnabled: () => enabled, executeCommand: async command => { commands.push(command); }, log: event => logs.push(event), ...changes });
  return { api, original, install, sent, logs, commands, result, setEnabled: value => { enabled = value; }, setCatalog: value => { catalog = value; } };
}
test('native call identity, return, extra arguments, logout and disabled state are preserved', () => {
  const f = fixture(), handle = f.install(), { status } = data(), context = {};
  assert.equal(f.api.setAuthStatus.call(context, status, 'future'), f.result);
  assert.equal(f.sent[0].thisArg, context); assert.equal(f.sent[0].args[1], 'future');
  assert.notEqual(f.sent[0].args[0], status);
  f.api.setAuthStatus(null); assert.equal(f.sent.at(-1).args[0], null);
  f.setEnabled(false); f.api.setAuthStatus(status); assert.equal(f.sent.at(-1).args[0], status);
  assert.ok(!JSON.stringify(f.logs).includes('test-do-not-log'));
  handle.dispose(); assert.equal(f.api.setAuthStatus, f.original);
});
test('late activation refreshes through the official non-disruptive command and coalesces pending calls', async () => {
  const f = fixture(), handle = f.install();
  const one = handle.refresh(), two = handle.refresh(); assert.equal(one, two); await one;
  assert.deepEqual(f.commands, ['devin.refreshUserStatus']);
  await handle.refresh(); assert.equal(f.commands.length, 2);
  const scheduled = handle.refresh(); handle.dispose(); await scheduled; assert.equal(f.commands.length, 2);
});
test('transform failures do not interrupt authentication and newer wrappers survive disposal', () => {
  const f = fixture(), handle = f.install({ getCatalog() { throw new Error('secret'); } }), { status } = data();
  f.api.setAuthStatus(status); assert.equal(f.sent[0].args[0], status);
  assert.ok(!JSON.stringify(f.logs).includes('secret'));
  const wrapper = f.api.setAuthStatus, newer = (...args) => wrapper(...args); f.api.setAuthStatus = newer;
  handle.dispose(); assert.equal(f.api.setAuthStatus, newer);
  f.api.setAuthStatus(status); assert.equal(f.sent.at(-1).args[0], status);
});
test('a broken enable predicate cannot block native authentication publication', () => {
  const f = fixture(), handle = f.install({ isEnabled() { throw new Error('invalid config JSON'); } }), { status } = data();
  assert.equal(f.api.setAuthStatus(status), f.result);
  assert.equal(f.sent[0].args[0], status);
  handle.dispose();
});
test('installation is idempotent, reversible, and an older API is supported', () => {
  const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(f.api, 'setAuthStatus');
  const handle = f.install(); assert.equal(f.install(), handle); handle.dispose(); handle.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.api, 'setAuthStatus'), descriptor);
  assert.notEqual(f.install(), handle);
  const old = fixture(); delete old.api.setAuthStatus; assert.equal(old.install(), null);
});
