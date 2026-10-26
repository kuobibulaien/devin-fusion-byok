'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativePickerStore, extensionPort, listValue, readList } = require('../src/runtime/native-picker.cjs');
function fixture() {
  const data = { pinnedCascadeModelUids: ['swe-2-max', 'swe-2-high', 'swe-2-medium', 'custom'], lastSelectedCascadeModelUids: ['custom'] };
  const calls = [], notices = [];
  let conflict = false;
  const store = createNativePickerStore({ onChange: () => notices.push(store.snapshot()), request: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'GetNativeValues') return { values: Object.fromEntries(params.keys.map(key => [key, { value: listValue(data[key]) }])) };
    assert.equal(method, 'SetNativeValue');
    assert.ok(['pinnedCascadeModelUids', 'lastSelectedCascadeModelUids'].includes(params.key));
    if (conflict) { data[params.key] = ['concurrent']; conflict = false; return { concurrencyConflict: true }; }
    assert.deepEqual(params.expectedPreviousValue, listValue(data[params.key]));
    data[params.key] = readList(params.value);
    // Connect JSON omits a false concurrencyConflict scalar.
    return { currentValue: { value: listValue(data[params.key]) } };
  } });
  return { data, calls, notices, store, conflict() { conflict = true; } };
}
test('native lists include disabled pins, can remove them and preserve unrelated recent history', async () => {
  const f = fixture(); await f.store.refresh();
  const revision = f.store.snapshot().revision;
  assert.equal(f.store.snapshot().pinned.length, 4);
  await f.store.setList('pinned', ['custom'], revision);
  assert.deepEqual(f.data.pinnedCascadeModelUids, ['custom']);
  assert.deepEqual(f.data.lastSelectedCascadeModelUids, ['custom']);
  assert.equal(f.store.snapshot().needsReload, true);
  assert.deepEqual(f.calls.find(call => call.method === 'SetNativeValue').params.target, { state: {} });
});
test('external native edits are reread and stale panel writes never overwrite them', async () => {
  const f = fixture(); await f.store.refresh(); const old = f.store.snapshot().revision;
  f.data.pinnedCascadeModelUids = ['new-user-pin'];
  await assert.rejects(f.store.setList('pinned', [], old), error => error.code === 'picker_conflict');
  assert.deepEqual(f.store.snapshot().pinned, ['new-user-pin']);
  assert.equal(f.calls.filter(call => call.method === 'SetNativeValue').length, 0);
});
test('native compare-and-swap conflict preserves the concurrent update and refreshes panel state', async () => {
  const f = fixture(); await f.store.refresh(); f.conflict();
  await assert.rejects(f.store.setList('pinned', [], f.store.snapshot().revision), error => error.code === 'picker_conflict');
  assert.deepEqual(f.store.snapshot().pinned, ['concurrent']);
});
test('a pre-write poll cannot overwrite or invalidate a successfully saved list', async () => {
  let persisted = ['old'], gets = 0, finishWrite, finishPoll;
  const response = pins => ({ values: { pinnedCascadeModelUids: { value: listValue(pins) }, lastSelectedCascadeModelUids: { value: listValue([]) } } });
  const store = createNativePickerStore({ request: async method => {
    if (method === 'GetNativeValues') {
      if (++gets === 3) return new Promise(resolve => { const old = [...persisted]; finishPoll = () => resolve(response(old)); });
      return response(persisted);
    }
    return new Promise(resolve => { finishWrite = () => { persisted = ['new']; resolve({ currentValue: { value: listValue(persisted) } }); }; });
  } });
  await store.refresh();
  const saving = store.setList('pinned', ['new'], store.snapshot().revision);
  while (!finishWrite) await new Promise(resolve => setImmediate(resolve));
  const polling = store.refresh();
  while (!finishPoll) await new Promise(resolve => setImmediate(resolve));
  finishWrite(); await new Promise(resolve => setImmediate(resolve)); finishPoll();
  await Promise.all([saving, polling]);
  assert.deepEqual(store.snapshot().pinned, ['new']);
  assert.deepEqual(persisted, ['new']);
  assert.equal(gets, 4, 'verification performs a fresh read after the old poll finishes');
});
test('empty native lists are saved as empty, and malformed or cross-key writes are rejected', async () => {
  const f = fixture(); await f.store.refresh();
  await f.store.setList('pinned', [], f.store.snapshot().revision);
  assert.deepEqual(f.store.snapshot().pinned, []);
  assert.deepEqual(readList({ listValue: {} }), []);
  for (const [kind, uids] of [['unknown', []], ['pinned', ['a', 'a']], ['pinned', ['']], ['recent', ['a', 'b', 'c', 'd']]]) {
    await assert.rejects(f.store.setList(kind, uids, f.store.snapshot().revision), error => error.code === 'picker_invalid_list');
  }
});
test('extension server discovery accepts only one owned language-server child and only its port argument', () => {
  const main = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
  const child = { spawnfile: '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm',
    spawnargs: ['language_server_macos_arm', '--extension_server_port', '12345'] };
  assert.equal(extensionPort([child], main), 12345);
  assert.equal(extensionPort([{ ...child, spawnfile: '/tmp/language_server_fake' }], main), null);
  assert.equal(extensionPort([child, { ...child, spawnargs: ['--extension_server_port', '12346'] }], main), null);
  assert.equal(extensionPort([{ ...child, spawnargs: ['--extension_server_port', '99999'] }], main), null);
});
