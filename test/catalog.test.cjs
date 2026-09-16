'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels } = require('../src/catalog.cjs');
const { fields, str, num, s, v, m } = require('../src/protocol/wire.cjs');

const cat = (...parts) => Buffer.concat(parts.flat());
const proto = { json: false, type: 'application/proto', framed: false };
const json = { json: true, type: 'application/json', framed: false };
const lsStatus = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const seatStatus = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
function config() {
  return {
    providers: [{ id: 'cpa', name: 'CPA', baseUrl: 'https://private.invalid/v1', apiKey: 'secret-test-value', apiFormat: 'openai',
      models: [
        { id: 'grok-4.6', label: 'Grok 4.6', efforts: ['medium', 'high'], contextWindow: 1000000, maxOutputTokens: 32768 },
        { id: 'ws-swe-2-max', label: 'SWE-2 Max', contextWindow: 200000, maxOutputTokens: 64000 },
      ] }, { id: 'other', name: 'Other', models: [{ id: 'some-model', label: 'Some Model', contextWindow: 32000, maxOutputTokens: 64000 }] }],
    sidekicks: [{ providerId: 'cpa', model: 'ws-swe-2-max' }, { nativeUid: 'swe-2-max', label: 'SWE-2 Max' }],
  };
}
const OBSERVED_SWE = { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] };
const catalog = buildCatalog(config(), [OBSERVED_SWE]);
const familyEntry = (model, key) => model.json.modelFamilyMetadata.entries.find(entry => entry.key === key).value;
const getNested = (buffer, ...path) => path.reduce((message, number) => fields(message, number)[0].value, buffer);
const configs = buffer => fields(buffer, 1).filter(field => field.wire === 2).map(field => field.value);

test('all provider models and effort variants have every CPA/native Sidekick combination', () => {
  assert.equal(Object.keys(catalog.routes).length, 4);
  assert.equal(Object.keys(catalog.fusions).length, 16);
  assert.equal(catalog.models.length, 20);
  for (const route of Object.values(catalog.routes)) {
    const combinations = Object.values(catalog.fusions).filter(fusion => fusion.leadUid === route.uid);
    assert.equal(combinations.length, 4);
    assert.deepEqual(new Set(combinations.map(fusion => fusion.sidekickNative)), new Set([false, true]));
    for (const fusion of combinations) {
      assert.match(fusion.uid, /^fusion-dfbyok-/);
      assert.match(fusion.label, /^Fusion \(.+ \+ .+\)$/);
      assert.equal(catalog.models.find(model => model.uid === fusion.uid).label, fusion.label);
    }
  }
  const serialized = JSON.stringify(catalog);
  assert.ok(!serialized.includes('secret-test-value'));
  assert.ok(!serialized.includes('private.invalid'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!catalog.routes['swe-2-max']);
});

test('stable model identities and independent Lead/Sidekick orders survive reordering and label changes', () => {
  const reordered = config();
  reordered.providers.reverse();
  reordered.providers.forEach(provider => provider.models.reverse());
  reordered.sidekicks.reverse();
  const next = buildCatalog(reordered, [OBSERVED_SWE]);
  assert.deepEqual(new Set(next.models.map(model => model.uid)), new Set(catalog.models.map(model => model.uid)));
  for (const model of catalog.models.filter(model => model.kind === 'fusion')) {
    const same = next.models.find(value => value.uid === model.uid);
    assert.deepEqual(same.json.modelFamilyMetadata, model.json.modelFamilyMetadata);
    assert.ok(familyEntry(model, 'Lead').order >= 0x10000000);
    const fusion = catalog.fusions[model.uid];
    if (fusion.sidekickNative) assert.equal(familyEntry(model, 'Sidekick').order, 3);
    else assert.ok(familyEntry(model, 'Sidekick').order >= 0x10000000);
  }
  const renamed = config();
  renamed.providers[0].name = 'Renamed';
  assert.deepEqual(new Set(buildCatalog(renamed, [OBSERVED_SWE]).models.map(model => model.uid)), new Set(catalog.models.map(model => model.uid)));
});

test('own protobuf metadata matches JSON and advertises required execution harnesses without copying prices', () => {
  for (const model of catalog.models) {
    assert.equal(str(model.raw, 22), model.uid);
    assert.equal(str(model.raw, 1), model.label);
    // Local routing is not an official BYOK entitlement or official price.
    assert.equal(num(model.raw, 13), 0);
    assert.equal(num(model.raw, 18), model.json.maxTokens);
    const info = getNested(model.raw, 23);
    assert.equal(num(info, 13), model.json.modelInfo.maxOutputTokens);
    assert.ok(num(info, 13) <= model.json.maxTokens);
    assert.equal(str(info, 17), model.uid);
    assert.deepEqual(fields(info, 20).map(field => field.value.toString()), model.json.modelInfo.harnessUids);
    assert.equal(num(info, 25), model.kind === 'fusion' ? 1 : 0);
    assert.equal(num(info, 22), model.kind === 'fusion' ? 3 : 0);
    assert.equal(fields(model.raw, 11).length, 0, 'no copied price message');
    assert.equal(fields(model.raw, 12).length, 0, 'no copied user eligibility');
    const family = getNested(model.raw, 30);
    assert.equal(str(family, 1), model.json.modelFamilyMetadata.modelFamilyLabel);
    assert.deepEqual(fields(family, 2).map(field => ({ key: str(field.value, 1), value: {
      order: num(getNested(field.value, 2), 1), name: str(getNested(field.value, 2), 2), controlType: num(getNested(field.value, 2), 3),
    } })), model.json.modelFamilyMetadata.entries);
  }
});

test('duplicate labels are disambiguated and invalid provider/Sidekick identities fail before publishing', () => {
  const input = { providers: [{ id: 'a', name: 'Same', models: [{ id: 'x', label: 'X' }] },
    { id: 'b', name: 'Same', models: [{ id: 'x', label: 'X' }] }], sidekicks: [{ nativeUid: 'swe-2-max' }] };
  const result = buildCatalog(input);
  assert.equal(new Set(result.models.filter(model => model.kind === 'model').map(model => model.label)).size, 2);
  assert.throws(() => buildCatalog({ providers: [{ id: 'a', models: [{ id: 'x' }, { id: 'x' }] }] }), /Duplicate/);
  assert.throws(() => buildCatalog({ sidekicks: [{ nativeUid: 42 }] }), /Invalid native/);
  assert.throws(() => buildCatalog({ sidekicks: [{ nativeUid: 'dfbyok-x' }] }), /Invalid native/);
  assert.deepEqual(buildCatalog({ sidekicks: [{ nativeUid: 'swe-2-medium' }] }).sidekicks, [], 'unobserved native preferences are skipped, not granted');
  assert.throws(() => buildCatalog({ sidekicks: [{ providerId: 'missing', model: 'x' }] }), /unavailable/);
  assert.throws(() => buildCatalog({ providers: [{ id: 'a', models: [{ id: 'x', efforts: ['HIGH'] }] }] }), /effort/);
});

test('explicit inference server override applies to own models and leaves native records byte-identical', () => {
  const input = config();
  input.inferenceServerUrl = 'http://127.0.0.1:39842';
  const overridden = buildCatalog(input, [OBSERVED_SWE]);
  for (const model of overridden.models) {
    assert.equal(model.json.modelInfo.inferenceServerUrl, input.inferenceServerUrl);
    assert.equal(str(getNested(model.raw, 23), 18), input.inferenceServerUrl);
  }
  for (const model of catalog.models) assert.equal(model.json.modelInfo.inferenceServerUrl, 'https://server.codeium.com');
  assert.deepEqual(Object.keys(overridden.routes), Object.keys(catalog.routes));
  const fixture = statusFixture();
  const output = augmentCatalog(fixture.body, { rpc: lsStatus, format: proto, catalog: overridden });
  assert.deepEqual(configs(getNested(output, 1, 33)).at(-1), fixture.native);
  assert.throws(() => buildCatalog({ inferenceServerUrl: 'file:///tmp/unexpected' }), /Invalid inference/);
  assert.throws(() => buildCatalog({ inferenceServerUrl: 'https://user:password@example.invalid' }), /Invalid inference/);
});

function statusFixture() {
  const native = cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), m(23, cat(s(17, 'swe-2-max'), s(18, 'https://official.invalid'), s(20, 'swe-1p6'), s(20, 'swe-1p5'))), v(101, 7));
  const sort = name => cat(s(1, name), m(2, cat(s(1, 'Official Group'), s(2, 'Official SWE'), v(90, 4))), v(91, 5));
  const list = cat(m(1, native), m(2, sort('Recommended')), m(2, sort('Alphabetical')), v(88, 6));
  const status = cat(s(1, 'opaque-user-value'), v(27, 33), m(33, list), m(98, cat(v(1, 456))));
  const body = cat(v(9, 4), m(1, status), s(99, 'response-extension'));
  return { native, list, status, body };
}

for (const rpc of [lsStatus, seatStatus]) test(`${rpc} appends namespace entries and preserves account/official fields`, () => {
  const fixture = statusFixture();
  const original = Buffer.from(fixture.body);
  const output = augmentCatalog(fixture.body, { rpc, format: proto, catalog });
  assert.deepEqual(fixture.body, original);
  const status = getNested(output, 1), list = getNested(status, 33);
  assert.deepEqual(configs(list).slice(0, catalog.models.length), catalog.models.map(model => model.raw));
  assert.deepEqual(configs(list).at(-1), fixture.native);
  assert.equal(configs(list).length, 21);
  assert.equal(str(status, 1), 'opaque-user-value');
  assert.deepEqual(fields(status, 98)[0].raw, fields(fixture.status, 98)[0].raw);
  assert.equal(num(status, 27), 33);
  assert.equal(num(list, 88), 6);
  assert.deepEqual(fields(output, 99)[0].raw, fields(fixture.body, 99)[0].raw);
  for (const sort of fields(list, 2)) {
    const groups = fields(sort.value, 2);
    assert.equal(groups.length, 2);
    assert.equal(str(groups[0].value, 1), 'Devin Fusion BYOK');
    assert.equal(fields(groups[0].value, 2).length, catalog.models.length);
    assert.equal(str(groups[1].value, 1), 'Official Group');
    assert.equal(num(groups[1].value, 90), 4);
    assert.equal(num(sort.value, 91), 5);
  }
  assert.deepEqual(augmentCatalog(output, { rpc, format: proto, catalog }), output);
});

test('GetCliModelConfigs preserves defaults, subagent model and unknown field 2 without inventing sorts', () => {
  const native = statusFixture().native;
  const input = cat(m(1, native), s(2, 'future-field-two'), m(3, native), s(4, 'swe-2-max'), v(99, 9));
  const output = augmentCatalog(input, { rpc: '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', format: proto, catalog });
  assert.equal(configs(output).length, 21);
  assert.deepEqual(configs(output).at(-1), native);
  assert.deepEqual(configs(output).slice(0, catalog.models.length), catalog.models.map(model => model.raw));
  for (const number of [2, 3, 4, 99]) assert.deepEqual(fields(output, number)[0].raw, fields(input, number)[0].raw);
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCliModelConfigs', format: proto, catalog }), output);
  const empty = augmentCatalog(Buffer.alloc(0), { rpc: 'GetCliModelConfigs', format: proto, catalog });
  assert.equal(fields(empty, 2).length, 0);
});

test('refresh replaces own old catalog entries while preserving unrelated sort groups', () => {
  const old = cat(s(1, 'Old custom model'), s(22, 'dfbyok-deleted'));
  const input = cat(m(1, old), m(2, cat(s(1, 'Custom'),
    m(2, cat(s(1, 'Devin Fusion BYOK'), s(2, 'Old custom model'))),
    m(2, cat(s(1, 'Devin Fusion BYOK'), s(2, 'Unrelated official label'))))));
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog });
  assert.equal(configs(output).length, catalog.models.length);
  const groups = fields(getNested(output, 2), 2);
  assert.equal(groups.length, 2);
  assert.equal(str(groups[0].value, 1), 'Devin Fusion BYOK');
  assert.equal(fields(groups[0].value, 2).length, catalog.models.length);
  assert.equal(str(groups[1].value, 2), 'Unrelated official label');
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: proto, catalog }), output);
});

for (const snake of [false, true]) test(`JSON ${snake ? 'snake' : 'camel'} status preserves official fields and input`, () => {
  const statusKey = snake ? 'user_status' : 'userStatus';
  const listKey = snake ? 'cascade_model_config_data' : 'cascadeModelConfigData';
  const modelsKey = snake ? 'client_model_configs' : 'clientModelConfigs';
  const sortsKey = snake ? 'client_model_sorts' : 'clientModelSorts';
  const native = { label: 'Official SWE', modelUid: 'swe-2-max', opaqueOfficialMetadata: { eligible: false } };
  const input = { responseExtra: 'unchanged', [statusKey]: { account: { quota: 17, signedIn: true },
    [listKey]: { [modelsKey]: [native], [sortsKey]: [{ name: 'Recommended', groups: [{ groupName: 'Official', modelLabels: ['Official SWE'] }], extra: 1 }], extra: 2 } } };
  const snapshot = structuredClone(input);
  const output = augmentCatalog(input, { rpc: lsStatus, format: json, catalog });
  assert.deepEqual(input, snapshot);
  assert.deepEqual(output[statusKey].account, input[statusKey].account);
  assert.equal(output.responseExtra, 'unchanged');
  const list = output[statusKey][listKey];
  assert.deepEqual(list[modelsKey].slice(0, catalog.models.length), catalog.models.map(model => model.json));
  assert.deepEqual(list[modelsKey].at(-1), native);
  assert.equal(list[modelsKey].length, 21);
  assert.equal(list[sortsKey][0].groups.length, 2);
  assert.equal(list[sortsKey][0].groups[0].groupName, 'Devin Fusion BYOK');
  assert.equal(list[sortsKey][0].extra, 1);
  assert.equal(list.extra, 2);
  assert.deepEqual(augmentCatalog(output, { rpc: lsStatus, format: json, catalog }), output);
});

test('JSON CLI only appends models and leaves official defaults and extras intact', () => {
  const input = { clientModelConfigs: [], defaultOverrideModelConfig: { modelUid: 'native-default' },
    subagentDefaultModelUid: 'swe-2-max', extra: { tokenLimit: 17 } };
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: json, catalog });
  assert.deepEqual(output.defaultOverrideModelConfig, input.defaultOverrideModelConfig);
  assert.equal(output.subagentDefaultModelUid, 'swe-2-max');
  assert.deepEqual(output.extra, input.extra);
  assert.ok(!Object.hasOwn(output, 'clientModelSorts'));
});

test('unknown RPCs, empty catalogs, missing user status and malformed responses are unchanged', () => {
  const input = statusFixture().body;
  assert.equal(augmentCatalog(input, { rpc: 'GetAccount', format: proto, catalog }), input);
  assert.equal(augmentCatalog(input, { rpc: lsStatus, format: proto, catalog: buildCatalog() }), input);
  for (const invalid of [Buffer.from([0x0a, 0xff]), cat(m(1, Buffer.alloc(0)), m(1, Buffer.alloc(0))), v(1, 1), s(2, 'unrelated')]) {
    assert.equal(augmentCatalog(invalid, { rpc: lsStatus, format: proto, catalog }), invalid);
  }
  for (const invalid of [{}, { userStatus: null }, { userStatus: { cascadeModelConfigData: { clientModelConfigs: 'invalid' } } }]) {
    assert.equal(augmentCatalog(invalid, { rpc: lsStatus, format: json, catalog }), invalid);
  }
});

test('a valid user status without catalog gains only catalog data', () => {
  const output = augmentCatalog(m(1, v(42, 9)), { rpc: lsStatus, format: proto, catalog });
  assert.equal(num(getNested(output, 1), 42), 9);
  assert.equal(configs(getNested(output, 1, 33)).length, 20);
  assert.equal(fields(getNested(output, 1, 33), 2).length, 1);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} assignments choose exact Lead and Sidekick routes`, () => {
  for (const fusion of Object.values(catalog.fusions)) {
    for (const isSidekick of [false, true]) {
      const input = format.json ? { modelRouterUid: fusion.uid, ...(isSidekick ? { fusionLeadRouterUid: fusion.uid } : {}) }
        : cat(s(2, fusion.uid), isSidekick ? s(6, fusion.uid) : Buffer.alloc(0));
      const output = resolveAssignment(input, format, catalog);
      assert.ok(output);
      const assignment = format.json ? output.assignment : getNested(output, 1);
      const assignedUid = format.json ? assignment.modelUid : str(assignment, 2);
      const harnesses = format.json ? assignment.harnessUids : fields(assignment, 3).map(field => field.value.toString());
      assert.equal(assignedUid, isSidekick ? fusion.sidekickUid : fusion.leadUid);
      assert.deepEqual(harnesses, isSidekick ? ['swe-1p6', 'swe-1p5'] : ['fusion']);
      if (isSidekick && fusion.sidekickNative) assert.equal(assignedUid, 'swe-2-max');
      else assert.ok(catalog.routes[assignedUid]);
      if (format.json) assert.ok(!Object.hasOwn(assignment, 'jwt'));
      else assert.equal(fields(assignment, 1).length, 0);
    }
  }
});

test('official, unknown and ambiguous assignments are not intercepted', () => {
  const uid = Object.keys(catalog.fusions)[0];
  for (const input of [s(2, 'fusion-gpt-official'), s(2, 'fusion-dfbyok-unknown'), s(2, 'swe-2-max'),
    cat(s(2, uid), s(2, uid)), cat(s(2, uid), v(6, 1)), Buffer.from([0x12, 0xff]),
    cat(s(2, uid), s(6, 'fusion-official'))]) assert.equal(resolveAssignment(input, proto, catalog), null);
  for (const input of [{ modelRouterUid: 'fusion-official' }, { modelRouterUid: uid, model_router_uid: 'conflict' },
    { modelRouterUid: uid, fusionLeadRouterUid: 42 }, { modelRouterUid: 42 }]) assert.equal(resolveAssignment(input, json, catalog), null);
  assert.equal(resolveAssignment({ model_router_uid: uid }, json, catalog).assignment.modelUid, catalog.fusions[uid].leadUid);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} locked official Fusion assignments fall back to the configured combination`, () => {
  const fallback = Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === false);
  const withDefault = { ...catalog, defaultFusionUid: fallback.uid };
  const locked = new Set(['fusion-official-locked']);
  for (const isSidekick of [false, true]) {
    const input = format.json
      ? { modelRouterUid: 'fusion-official-locked', ...(isSidekick ? { fusionLeadRouterUid: 'fusion-official-locked' } : {}) }
      : cat(s(2, 'fusion-official-locked'), isSidekick ? s(6, 'fusion-official-locked') : Buffer.alloc(0));
    const output = resolveAssignment(input, format, withDefault, locked);
    assert.ok(output);
    const assignment = format.json ? output.assignment : getNested(output, 1);
    const assignedUid = format.json ? assignment.modelUid : str(assignment, 2);
    const harnesses = format.json ? assignment.harnessUids : fields(assignment, 3).map(field => field.value.toString());
    assert.equal(assignedUid, isSidekick ? fallback.sidekickUid : fallback.leadUid);
    assert.deepEqual(harnesses, isSidekick ? ['swe-1p6', 'swe-1p5'] : ['fusion']);
    assert.ok(catalog.routes[assignedUid]);
    assert.equal(output.redirectedFrom, 'fusion-official-locked');
    assert.equal(format.json ? JSON.stringify(output).includes('redirectedFrom') : Object.keys(output).includes('redirectedFrom'), false);
  }
});

test('the configured default Fusion wins the locked fallback over other combinations', () => {
  const preferred = Object.values(catalog.fusions).filter(fusion => fusion.sidekickNative === false)[1];
  const output = resolveAssignment(s(2, 'fusion-official-locked'), proto, { ...catalog, defaultFusionUid: preferred.uid }, new Set(['fusion-official-locked']));
  assert.equal(str(getNested(output, 1), 2), preferred.leadUid);
  assert.equal(output.redirectedFrom, 'fusion-official-locked');
});

test('unlocked, unobserved or fallback-less official Fusion assignments still pass through natively', () => {
  const input = s(2, 'fusion-official-locked');
  assert.equal(resolveAssignment(input, proto, catalog, new Set(['fusion-other'])), null);
  assert.equal(resolveAssignment(input, proto, catalog, new Set()), null);
  assert.equal(resolveAssignment(input, proto, catalog), null);
  assert.equal(resolveAssignment(input, proto, catalog, new Set(['fusion-official-locked'])), null);
  const empty = buildCatalog({ providers: [], sidekicks: [] });
  assert.equal(resolveAssignment(input, proto, empty, new Set(['fusion-official-locked'])), null);
  const stale = { ...catalog, defaultFusionUid: 'fusion-dfbyok-removed' };
  assert.equal(resolveAssignment(input, proto, stale, new Set(['fusion-official-locked'])), null);
  const nativeDefault = { ...catalog, defaultFusionUid: Object.values(catalog.fusions).find(fusion => fusion.sidekickNative).uid };
  assert.equal(resolveAssignment(input, proto, nativeDefault, new Set(['fusion-official-locked'])), null);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} catalog augmentation reports locked official Fusion uids`, () => {
  const lockedNative = format.json
    ? { label: 'Fusion (Locked)', modelUid: 'fusion-official-locked', disabled: true }
    : cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1));
  const openNative = format.json
    ? { label: 'Fusion (Open)', modelUid: 'fusion-official-open', disabled: false }
    : cat(s(1, 'Fusion (Open)'), s(22, 'fusion-official-open'));
  const plain = format.json
    ? { label: 'Official SWE', modelUid: 'swe-2-max', disabled: true }
    : cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), v(4, 1));
  const list = format.json ? { clientModelConfigs: [lockedNative, openNative, plain] }
    : cat(m(1, lockedNative), m(1, openNative), m(1, plain));
  let report;
  const output = augmentCatalog(list, { rpc: 'GetCliModelConfigs', format, catalog,
    onFusionStatus: (locked, seen) => { report = { locked, seen }; } });
  assert.deepEqual(report, { locked: ['fusion-official-locked'], seen: ['fusion-official-locked', 'fusion-official-open'] });
  const entries = format.json ? output.clientModelConfigs : configs(output);
  const uids = entries.map(entry => format.json ? entry.modelUid : str(entry, 22));
  assert.deepEqual(uids, [...catalog.models.map(model => model.uid), 'fusion-official-locked', 'fusion-official-open', 'swe-2-max']);
  assert.equal(entries.length, 3 + catalog.models.length);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} valid third-party default Fusion becomes the first selectable entry ahead of locked native ones`, () => {
  const preferred = Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === false);
  const withDefault = { ...catalog, defaultFusionUid: preferred.uid };
  const lockedNative = format.json
    ? { label: 'Fusion (Locked)', model_uid: 'fusion-official-locked', disabled: true, disabled_reason: 'pro' }
    : cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), s(33, 'pro'));
  const openNative = format.json
    ? { label: 'Fusion (Open)', model_uid: 'fusion-official-open', disabled: false }
    : cat(s(1, 'Fusion (Open)'), s(22, 'fusion-official-open'));
  const list = format.json ? { client_model_configs: [lockedNative, openNative] }
    : cat(m(1, lockedNative), m(1, openNative));
  let report;
  const output = augmentCatalog(list, { rpc: 'GetCliModelConfigs', format, catalog: withDefault,
    onFusionStatus: (locked, seen) => { report = { locked, seen }; } });
  const entries = format.json ? output.client_model_configs : configs(output);
  const uids = entries.map(entry => format.json ? entry.modelUid ?? entry.model_uid : str(entry, 22));
  assert.deepEqual(uids, [preferred.uid, ...catalog.models.filter(model => model.uid !== preferred.uid).map(model => model.uid),
    'fusion-official-locked', 'fusion-official-open']);
  assert.equal(new Set(uids).size, uids.length);
  assert.deepEqual(entries.at(-2), lockedNative);
  assert.deepEqual(entries.at(-1), openNative);
  assert.deepEqual(report, { locked: ['fusion-official-locked'], seen: ['fusion-official-locked', 'fusion-official-open'] });
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCliModelConfigs', format, catalog: withDefault }), output);
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} absent, stale or native-sidekick defaults keep official order and never redirect`, () => {
  const candidates = [catalog,
    { ...catalog, defaultFusionUid: 'fusion-dfbyok-removed' },
    { ...catalog, defaultFusionUid: Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === true).uid },
    { ...catalog, defaultFusionUid: Object.values(catalog.fusions).find(fusion => fusion.sidekickNative === false).uid, routes: {} }];
  const lockedNative = format.json
    ? { label: 'Fusion (Locked)', modelUid: 'fusion-official-locked', disabled: true, disabledReason: 'pro' }
    : cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), s(33, 'pro'));
  const list = format.json ? { clientModelConfigs: [lockedNative] } : m(1, lockedNative);
  const request = format.json ? { modelRouterUid: 'fusion-official-locked' } : s(2, 'fusion-official-locked');
  for (const candidate of candidates) {
    const output = augmentCatalog(list, { rpc: 'GetCliModelConfigs', format, catalog: candidate });
    const entries = format.json ? output.clientModelConfigs : configs(output);
    const uids = entries.map(entry => format.json ? entry.modelUid : str(entry, 22));
    assert.deepEqual(uids, [...catalog.models.map(model => model.uid), 'fusion-official-locked']);
    assert.equal(resolveAssignment(request, format, candidate, new Set(['fusion-official-locked'])), null);
  }
});

// Integration evidence from the installed native picker. Portable test runs skip
// these checks when Devin is absent; catalog production code never imports it.
const rendererFile = '/Applications/Devin.app/Contents/Resources/app/out/vs/workbench/windsurf-chat-client/index.js';
test('installed native Fusion grouping includes every custom Lead and both available Sidekicks', { skip: !fs.existsSync(rendererFile) }, () => {
  const source = fs.readFileSync(rendererFile, 'utf8');
  const start = source.indexOf('function nrM('), end = source.indexOf('let nrG=', start);
  assert.ok(start >= 0 && end > start, 'native family picker extraction anchors');
  const renderer = vm.runInNewContext(source.slice(start, end) + ';({nrM,nrR,nrF,nrq})');
  const models = catalog.models.filter(model => model.kind === 'fusion').map(model => ({
    modelUid: model.uid, label: model.label, disabled: false, familyUid: model.json.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value])),
  }));
  const official = { modelUid: 'fusion-official', label: 'Official', disabled: false, familyUid: 'fusion', familyMetadata: {
    Lead: { order: 1, name: 'Official Lead' }, Effort: { order: 3, name: 'Medium' },
    Sidekick: { order: 1, name: 'SWE-2 Medium' }, 'Fast Mode': { order: 0, name: '' },
    'Recommended Sidekick': { order: 0, name: 'SWE-2 Medium' },
  } };
  const family = renderer.nrM([official, ...models]).families.get('fusion');
  const leadIndex = family.dimensions.findIndex(dimension => dimension.name === 'Lead');
  const sidekickIndex = family.dimensions.findIndex(dimension => dimension.name === 'Sidekick');
  const leadOrders = new Set(models.map(model => model.familyMetadata.Lead.order));
  assert.equal(family.dimensions[leadIndex].values.length, leadOrders.size + 1);
  for (const order of leadOrders) {
    assert.equal(renderer.nrF(family, official, leadIndex, order), true);
    const selected = renderer.nrq(family, official, leadIndex, order);
    assert.ok(selected.modelUid.startsWith('fusion-dfbyok-'));
    for (const sidekickOrder of new Set(models.map(model => model.familyMetadata.Sidekick.order))) {
      assert.equal(renderer.nrF(family, selected, sidekickIndex, sidekickOrder), true);
      const changed = renderer.nrq(family, selected, sidekickIndex, sidekickOrder);
      assert.equal(changed.familyMetadata.Sidekick.order, sidekickOrder);
      assert.equal(changed.familyMetadata.Lead.order, order);
    }
  }
});

test('installed ACP picker requires own UIDs in session config_options as well as the user status catalog', { skip: !fs.existsSync(rendererFile) }, () => {
  const source = fs.readFileSync(rendererFile, 'utf8');
  const start = source.indexOf('function nqD('), end = source.indexOf('nqN.displayName=', start);
  assert.ok(start >= 0 && end > start, 'native ACP option extraction anchors');
  const renderer = vm.runInNewContext(source.slice(start, end) + ';({nqj})');
  const filter = source.match(/let e=nqj\(_\.options\);return k\.filter\(t=>e\.has\(t\.modelUid\)\|\|t\.disabled\)/)?.[0];
  assert.ok(filter, 'native session/catalog intersection still matches audited code');
  const select = new Function('nqj', '_', 'k', filter);
  const models = catalog.models.map(model => ({ modelUid: model.uid, disabled: false }));
  const oldSession = { options: [{ value: 'fusion-official', name: 'Official' }] };
  assert.equal(select(renderer.nqj, oldSession, models).length, 0);
  const updatedSession = { options: [{ group: 'BYOK', options: models.map(model => ({ value: model.modelUid, name: model.modelUid })) }] };
  assert.equal(select(renderer.nqj, updatedSession, models).length, catalog.models.length);
});

test('hidden official uids are removed from proto lists while observation still reports them', () => {
  const withHidden = { ...catalog, hiddenNativeModelUids: ['fusion-official-locked', 'swe-2-max'] };
  const locked = cat(s(1, 'Fusion (Locked)'), s(22, 'fusion-official-locked'), v(4, 1), s(33, 'pro'));
  const sharedHidden = cat(s(1, 'Shared Label'), s(22, 'swe-2-max'));
  const sharedKept = cat(s(1, 'Shared Label'), s(22, 'swe-2-high'));
  const open = cat(s(1, 'Fusion (Open)'), s(22, 'fusion-official-open'));
  const sort = cat(s(1, 'Recommended'), m(2, cat(s(1, 'Official Group'), s(2, 'Fusion (Locked)'), s(2, 'Shared Label'), s(2, 'Fusion (Open)'))));
  const input = cat(m(1, locked), m(1, sharedHidden), m(1, sharedKept), m(1, open), m(2, sort));
  let nativeReport, fusionReport;
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: withHidden,
    onNativeModels: entries => { nativeReport = entries; }, onFusionStatus: (lockedUids, seen) => { fusionReport = { lockedUids, seen }; } });
  const entries = configs(output);
  assert.deepEqual(entries.map(entry => str(entry, 22)), [...catalog.models.map(model => model.uid), 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(nativeReport.map(entry => entry.uid), ['fusion-official-locked', 'swe-2-max', 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(nativeReport[0], { uid: 'fusion-official-locked', label: 'Fusion (Locked)', disabled: true, harnessUids: [], isModelRouter: false });
  assert.deepEqual(nativeReport[2], { uid: 'swe-2-high', label: 'Shared Label', disabled: false, harnessUids: [], isModelRouter: false });
  assert.deepEqual(fusionReport, { lockedUids: ['fusion-official-locked'], seen: ['fusion-official-locked', 'fusion-official-open'] });
  const groups = fields(getNested(output, 2), 2);
  assert.equal(str(groups[0].value, 1), 'Devin Fusion BYOK');
  assert.deepEqual(fields(groups[1].value, 2).map(field => field.value.toString()), ['Shared Label', 'Fusion (Open)']);
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: withHidden }), output);
});

test('hidden official uids are removed from JSON lists including snake_case aliases', () => {
  const withHidden = { ...catalog, hiddenNativeModelUids: ['fusion-official-locked', 'swe-2-max'] };
  const locked = { label: 'Fusion (Locked)', model_uid: 'fusion-official-locked', disabled: true, disabled_reason: 'pro' };
  const shared = { label: 'Shared Label', model_uid: 'swe-2-max' };
  const kept = { label: 'Shared Label', modelUid: 'swe-2-high' };
  const open = { label: 'Fusion (Open)', modelUid: 'fusion-official-open' };
  const input = { client_model_configs: [locked, shared, kept, open],
    client_model_sorts: [{ name: 'Recommended', groups: [{ group_name: 'Official', model_labels: ['Fusion (Locked)', 'Shared Label', 'Fusion (Open)'] }] }] };
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: json, catalog: withHidden, onNativeModels: entries => { report = entries; } });
  assert.deepEqual(output.client_model_configs.map(entry => entry.modelUid ?? entry.model_uid), [...catalog.models.map(model => model.uid), 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(report.map(entry => entry.uid), ['fusion-official-locked', 'swe-2-max', 'swe-2-high', 'fusion-official-open']);
  assert.deepEqual(report[0], { uid: 'fusion-official-locked', label: 'Fusion (Locked)', disabled: true, harnessUids: [], isModelRouter: false });
  const groups = output.client_model_sorts[0].groups;
  assert.equal(groups[0].groupName, 'Devin Fusion BYOK');
  assert.deepEqual(groups[1].model_labels, ['Shared Label', 'Fusion (Open)']);
  assert.deepEqual(augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: json, catalog: withHidden }), output);
});

test('hidden filtering and native observation work with an empty own catalog', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['swe-2-max'] };
  const hiddenEntry = cat(s(1, 'Official SWE'), s(22, 'swe-2-max'), v(4, 1));
  const kept = cat(s(1, 'Other'), s(22, 'official-other'));
  const sort = cat(s(1, 'Recommended'), m(2, cat(s(1, 'Official Group'), s(2, 'Official SWE'), s(2, 'Other'))));
  const input = cat(m(1, hiddenEntry), m(1, kept), m(2, sort));
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: bare, onNativeModels: entries => { report = entries; } });
  assert.deepEqual(configs(output).map(entry => str(entry, 22)), ['official-other']);
  assert.deepEqual(report, [{ uid: 'swe-2-max', label: 'Official SWE', disabled: true, harnessUids: [], isModelRouter: false },
    { uid: 'official-other', label: 'Other', disabled: false, harnessUids: [], isModelRouter: false }]);
  const groups = fields(getNested(output, 2), 2);
  assert.equal(groups.length, 1, 'no empty own group is emitted for a pure native catalog');
  assert.equal(str(groups[0].value, 1), 'Official Group');
  assert.deepEqual(fields(groups[0].value, 2).map(field => field.value.toString()), ['Other']);
  const again = augmentCatalog(output, { rpc: 'GetCascadeModelConfigs', format: proto, catalog: bare, onNativeModels: entries => { report = entries; } });
  assert.deepEqual(again, output);
  assert.deepEqual(report.map(entry => entry.uid), ['official-other'], 'a second pass observes only what the current payload still contains');
});

test('observation still reports with zero own models and no hidden list', () => {
  const native = statusFixture().native;
  let report;
  const output = augmentCatalog(cat(m(1, native)), { rpc: 'GetCliModelConfigs', format: proto,
    catalog: buildCatalog(), onNativeModels: entries => { report = entries; } });
  assert.deepEqual(configs(output).map(entry => str(entry, 22)), ['swe-2-max']);
  assert.deepEqual(report, [{ uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6', 'swe-1p5'], isModelRouter: false }]);
});

test('a hidden uid absent from upstream is never injected and a restored uid needs fresh upstream data', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['swe-not-upstream', 'swe-2-max'] };
  const native = statusFixture().native;
  const input = cat(m(1, native));
  const hidden = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare });
  assert.deepEqual(configs(hidden), [], 'hidden upstream entry is removed');
  const restored = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto,
    catalog: { ...bare, hiddenNativeModelUids: ['swe-not-upstream'] } });
  assert.deepEqual(restored, input, 'restoring the uid lets the current upstream entry through again');
  const upstreamWithoutIt = augmentCatalog(Buffer.alloc(0), { rpc: 'GetCliModelConfigs', format: proto, catalog: bare });
  assert.deepEqual(configs(upstreamWithoutIt), [], 'configured uids never appear without fresh upstream data');
});

test('ambiguous, malformed and own entries are skipped by observation but preserved in output', () => {
  const ambiguous = cat(s(22, 'uid-a'), s(22, 'uid-b'));
  const noUid = cat(s(1, 'No UID'));
  const ownEntry = cat(s(1, 'Own'), s(22, 'dfbyok-leftover'));
  const native = statusFixture().native;
  let report;
  const output = augmentCatalog(cat(m(1, ambiguous), m(1, noUid), m(1, ownEntry), m(1, native)),
    { rpc: 'GetCliModelConfigs', format: proto, catalog: buildCatalog(), onNativeModels: entries => { report = entries; } });
  assert.deepEqual(report, [{ uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6', 'swe-1p5'], isModelRouter: false }]);
  const uids = configs(output).map(entry => fields(entry, 22).map(field => field.value.toString()));
  assert.deepEqual(uids, [['uid-a', 'uid-b'], [], ['swe-2-max']], 'ambiguous and uid-less natives pass through; own leftovers are replaced');
  const jsonReport = [];
  const jsonOutput = augmentCatalog({ clientModelConfigs: [{ label: 'ambiguous', modelUid: 'a', model_uid: 'b' }, { label: 'no uid' }, { modelUid: 'ok-native', label: 'OK' }] },
    { rpc: 'GetCliModelConfigs', format: json, catalog: buildCatalog(), onNativeModels: entries => jsonReport.push(...entries) });
  assert.deepEqual(jsonReport, [{ uid: 'ok-native', label: 'OK', disabled: false, harnessUids: [], isModelRouter: false }]);
  assert.equal(jsonOutput.clientModelConfigs.length, 3);
});

test('hidden filtering inside nested user status keeps disabled metadata and account fields', () => {
  const withHidden = { ...catalog, hiddenNativeModelUids: ['swe-2-max'] };
  const fixture = statusFixture();
  let report;
  const output = augmentCatalog(fixture.body, { rpc: lsStatus, format: proto, catalog: withHidden, onNativeModels: entries => { report = entries; } });
  const status = getNested(output, 1), list = getNested(status, 33);
  assert.deepEqual(configs(list).map(entry => str(entry, 22)), catalog.models.map(model => model.uid));
  assert.equal(str(status, 1), 'opaque-user-value');
  assert.equal(num(list, 88), 6);
  assert.deepEqual(report.map(entry => entry.uid), ['swe-2-max']);
  assert.deepEqual(augmentCatalog(output, { rpc: lsStatus, format: proto, catalog: withHidden }), output);
});

test('ambiguous proto uids stay byte-identical even when a first uid is configured hidden', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['dup-uid', 'wire-uid', 'swe-2-max'] };
  const duplicate = cat(s(1, 'Dup'), s(22, 'dup-uid'), s(22, 'other-uid'));
  const wrongWire = cat(s(1, 'Wire'), s(22, 'wire-uid'), v(22, 7));
  const onlyWrongWire = cat(s(1, 'Varint'), v(22, 7));
  const hidden = statusFixture().native;
  const input = cat(m(1, duplicate), m(1, wrongWire), m(1, onlyWrongWire), m(1, hidden));
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare,
    onNativeModels: entries => { report = entries; } });
  const entries = configs(output);
  assert.equal(entries.length, 3, 'ambiguous records pass through; only the unambiguous hidden uid is removed');
  assert.deepEqual(report.map(entry => entry.uid), ['swe-2-max'], 'ambiguous records are not reported either');
  assert.ok(output.includes(Buffer.from('dup-uid')), 'the ambiguous record keeps its original bytes');
  assert.deepEqual(configs(augmentCatalog(output, { rpc: 'GetCliModelConfigs', format: proto, catalog: bare })).length, 3, 'idempotent');
});

test('JSON entries with unequal modelUid aliases are never hidden or observed', () => {
  const bare = { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: ['alias-a', 'gone'] };
  const input = { clientModelConfigs: [
    { label: 'Mismatch', modelUid: 'alias-a', model_uid: 7 },
    { label: 'Both same', modelUid: 'alias-b', model_uid: 'alias-b' },
    { label: 'Hidden', modelUid: 'gone' },
    { label: 'Kept', model_uid: 'kept' },
  ] };
  let report;
  const output = augmentCatalog(input, { rpc: 'GetCliModelConfigs', format: json, catalog: bare,
    onNativeModels: entries => { report = entries; } });
  assert.deepEqual(output.clientModelConfigs.map(entry => entry.label), ['Mismatch', 'Both same', 'Kept']);
  assert.deepEqual(report.map(entry => entry.uid), ['alias-b', 'gone', 'kept'], 'the mismatched alias entry is neither hidden nor observed');
});

for (const format of [proto, json]) test(`${format.json ? 'JSON' : 'protobuf'} collectNativeModels extracts sanitized capability metadata`, () => {
  if (format.json) {
    for (const snake of [false, true]) {
      const info = snake ? { model_info: { harness_uids: ['swe-1p5'], is_model_router: false } }
        : { modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } };
      const list = { clientModelConfigs: [{ label: 'A', modelUid: 'swe-a', disabled: false, ...info }] };
      assert.deepEqual(collectNativeModels(list, { rpc: 'GetCliModelConfigs', format: json }),
        [{ uid: 'swe-a', label: 'A', disabled: false, harnessUids: ['swe-1p5'], isModelRouter: false }]);
    }
    const nested = { userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { label: 'R', modelUid: 'swe-router', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: true } }] } } };
    assert.deepEqual(collectNativeModels(nested, { rpc: lsStatus, format: json }),
      [{ uid: 'swe-router', label: 'R', disabled: false, harnessUids: ['swe-1p6'], isModelRouter: true }]);
  } else {
    const fixture = statusFixture();
    assert.deepEqual(collectNativeModels(fixture.body, { rpc: lsStatus, format: proto }),
      [{ uid: 'swe-2-max', label: 'Official SWE', disabled: false, harnessUids: ['swe-1p6', 'swe-1p5'], isModelRouter: false }]);
    const direct = cat(m(1, cat(s(1, 'Router'), s(22, 'swe-router'), m(23, cat(s(20, 'swe-1p6'), v(25, 1))))));
    assert.deepEqual(collectNativeModels(direct, { rpc: 'GetCliModelConfigs', format: proto }),
      [{ uid: 'swe-router', label: 'Router', disabled: false, harnessUids: ['swe-1p6'], isModelRouter: true }]);
    assert.equal(collectNativeModels(cat(m(1, cat(s(1, 'Missing status'), s(22, 'swe-x')))), { rpc: lsStatus, format: proto }).length, 0,
      'a flat proto list is not a nested user status payload');
  }
  assert.deepEqual(collectNativeModels(format.json ? {} : Buffer.alloc(0), { rpc: 'GetCliModelConfigs', format }), []);
  assert.equal(collectNativeModels(statusFixture().body, { rpc: 'GetAccount', format: proto }).length, 0);
});

test('collectNativeModels fails closed on ambiguous or mistyped capability fields', () => {
  const wrap = entry => cat(m(1, entry));
  for (const entry of [
    cat(s(1, 'Dup23'), s(22, 'a'), m(23, cat(s(20, 'swe-1p6'))), m(23, cat(s(20, 'swe-1p5')))),
    cat(s(1, 'Wire23'), s(22, 'b'), v(23, 1)),
    cat(s(1, 'Wire20'), s(22, 'c'), m(23, cat(s(20, 'swe-1p6'), v(20, 1)))),
    cat(s(1, 'Dup25'), s(22, 'd'), m(23, cat(s(20, 'swe-1p6'), v(25, 1), v(25, 0)))),
    cat(s(1, 'Wire25'), s(22, 'e'), m(23, cat(s(20, 'swe-1p6'), s(25, 'x')))),
    cat(s(1, 'Junk23'), s(22, 'f'), m(23, Buffer.from([0x0a, 0xff]))),
  ]) {
    const records = collectNativeModels(wrap(entry), { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].harnessUids, records[0].isModelRouter], [[], false], 'ambiguous metadata yields no capability');
  }
  assert.equal(collectNativeModels(cat(m(1, cat(s(22, 'x'), s(22, 'y')))), { rpc: 'GetCliModelConfigs', format: proto }).length, 0);
  assert.equal(collectNativeModels(cat(m(1, cat(s(22, 'x'), v(22, 7)))), { rpc: 'GetCliModelConfigs', format: proto }).length, 0);
  for (const entry of [
    { modelUid: 'a', modelInfo: { harnessUids: ['swe-1p6'] }, model_info: { harnessUids: ['swe-1p5'] } },
    { modelUid: 'b', modelInfo: { harnessUids: 'swe-1p6' } },
    { modelUid: 'c', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: 'yes' } },
    { modelUid: 'd', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: true, is_model_router: false } },
    { modelUid: 'e', model_info: 'nope' },
    { modelUid: 'f', modelInfo: { harness_uids: ['swe-1p6', 7] } },
  ]) {
    const [record] = collectNativeModels({ clientModelConfigs: [entry] }, { rpc: 'GetCliModelConfigs', format: json });
    assert.deepEqual([record.harnessUids, record.isModelRouter], [[], false]);
  }
});

test('eligible observed native Sidekicks combine with every imported Lead using their exact harness intersection', () => {
  const input = config();
  input.sidekicks.push({ nativeUid: 'swe-ghost' });
  const natives = [
    { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5', 'other-harness'] },
    { uid: 'swe-2-medium', label: 'SWE-2 Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5', 'unrelated'] },
    { uid: 'swe-disabled', label: 'Disabled', disabled: true, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'swe-router', label: 'Router', disabled: false, isModelRouter: true, harnessUids: ['swe-1p6'] },
    { uid: 'swe-naked', label: 'Naked', disabled: false, isModelRouter: false },
    { uid: 'swe-incompatible', label: 'Incompatible', disabled: false, isModelRouter: false, harnessUids: ['other-only'] },
    { uid: 'fusion-official', label: 'Fusion', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'dfbyok-own', label: 'Own', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'swe-hidden', label: 'Hidden', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
  ];
  const result = buildCatalog({ ...input, hiddenNativeModelUids: ['swe-hidden'] }, natives);
  const nativeSidekicks = result.sidekicks.filter(item => item.native);
  assert.deepEqual(nativeSidekicks.map(item => item.uid).sort(), ['swe-2-max', 'swe-2-medium']);
  const bySidekick = uid => Object.values(result.fusions).find(fusion => fusion.sidekickUid === uid);
  assert.deepEqual(bySidekick('swe-2-max').sidekickHarnessUids, ['swe-1p6', 'swe-1p5']);
  assert.deepEqual(bySidekick('swe-2-medium').sidekickHarnessUids, ['swe-1p5']);
  for (const uid of ['swe-disabled', 'swe-router', 'swe-naked', 'swe-incompatible', 'fusion-official', 'dfbyok-own', 'swe-hidden', 'swe-ghost']) {
    assert.equal(bySidekick(uid), undefined, uid + ' must not become a Sidekick');
  }
  for (const route of Object.values(result.routes)) {
    assert.ok(Object.values(result.fusions).some(fusion => fusion.leadUid === route.uid && fusion.sidekickUid === 'swe-2-max'));
    assert.ok(Object.values(result.fusions).some(fusion => fusion.leadUid === route.uid && fusion.sidekickUid === 'swe-2-medium'));
  }
  const models = result.models.filter(model => model.kind === 'fusion');
  const orderOf = uid => familyEntry(models.find(model => model.uid === uid), 'Sidekick').order;
  assert.equal(orderOf(bySidekick('swe-2-max').uid), 3);
  const mediumOrder = orderOf(bySidekick('swe-2-medium').uid);
  assert.ok(mediumOrder !== 3 && mediumOrder >= 0x10000000);
  const orders = new Set(models.map(model => familyEntry(model, 'Sidekick').order));
  assert.equal(orders.size, new Set(Object.values(result.fusions).map(fusion => fusion.sidekickUid)).size, 'unique stable orders per Sidekick');
  const assignedMax = resolveAssignment(cat(s(2, bySidekick('swe-2-max').uid), s(6, bySidekick('swe-2-max').uid)), proto, result);
  assert.deepEqual(fields(getNested(assignedMax, 1), 3).map(field => field.value.toString()), ['swe-1p6', 'swe-1p5']);
  assert.equal(str(getNested(assignedMax, 1), 2), 'swe-2-max');
  const assignedMedium = resolveAssignment(cat(s(2, bySidekick('swe-2-medium').uid), s(6, bySidekick('swe-2-medium').uid)), proto, result);
  assert.deepEqual(fields(getNested(assignedMedium, 1), 3).map(field => field.value.toString()), ['swe-1p5']);
});

test('config alone never grants native capability and unobserved natives fail closed', () => {
  const input = config();
  const unobserved = buildCatalog(input);
  assert.equal(Object.values(unobserved.fusions).filter(fusion => fusion.sidekickNative).length, 0);
  assert.ok(!unobserved.routes['swe-2-max']);
  const partial = buildCatalog(input, [{ uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: [] }]);
  assert.equal(Object.values(partial.fusions).filter(fusion => fusion.sidekickNative).length, 0, 'metadata-less natives stay ineligible');
  const eligible = buildCatalog(input, [OBSERVED_SWE]);
  const nativeFusion = Object.values(eligible.fusions).find(fusion => fusion.sidekickNative);
  assert.ok(nativeFusion);
  const stale = { ...eligible, fusions: { [nativeFusion.uid]: { ...nativeFusion, sidekickHarnessUids: [] } } };
  assert.equal(resolveAssignment(cat(s(2, nativeFusion.uid), s(6, nativeFusion.uid)), proto, stale), null,
    'a native assignment without a recorded intersection fails closed');
});

test('team allowlists include native Sidekick combinations only when the native uid is allowed', () => {
  const teamRpc = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const nativeFusion = Object.values(catalog.fusions).find(fusion => fusion.sidekickNative);
  const providerFusion = Object.values(catalog.fusions).find(fusion => !fusion.sidekickNative);
  const leadUids = Object.keys(catalog.routes);
  const withoutNative = augmentCatalog(cat(...leadUids.map(uid => s(7, uid))), { rpc: teamRpc, format: proto, catalog });
  const uids = fields(withoutNative, 7).map(field => field.value.toString());
  assert.ok(uids.includes(providerFusion.uid));
  assert.ok(!uids.includes(nativeFusion.uid), 'swe-2-max not allowed -> its combinations stay out');
  const withNative = augmentCatalog(cat(...leadUids.map(uid => s(7, uid)), s(7, 'swe-2-max')), { rpc: teamRpc, format: proto, catalog });
  assert.ok(fields(withNative, 7).map(field => field.value.toString()).includes(nativeFusion.uid));
});

test('malformed or ambiguous disabled and router flags never produce a native Sidekick candidate', () => {
  const harness = cat(s(20, 'swe-1p6'));
  const info = inner => m(23, inner);
  for (const entry of [
    cat(s(1, 'Dup4'), s(22, 'a'), v(4, 1), v(4, 0), info(harness)),
    cat(s(1, 'Wire4'), s(22, 'b'), s(4, 'yes'), info(harness)),
    cat(s(1, 'Two4'), s(22, 'c'), v(4, 2), info(harness)),
    cat(s(1, 'Router2'), s(22, 'd'), info(cat(harness, v(25, 2)))),
  ]) {
    const [record] = collectNativeModels(cat(m(1, entry)), { rpc: 'GetCliModelConfigs', format: proto });
    assert.equal(record.disabled === false && record.isModelRouter === false, false, 'ambiguous record must not read as enabled non-router');
    assert.equal(buildCatalog(config(), [record]).sidekicks.filter(item => item.native).length, 0);
  }
  for (const disabled of ['yes', 1, null, 0, {}]) {
    const [record] = collectNativeModels({ clientModelConfigs: [{ modelUid: 'swe-json', disabled, modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } }] },
      { rpc: 'GetCliModelConfigs', format: json });
    assert.equal(record.disabled, true, JSON.stringify(disabled) + ' must fail closed as disabled');
    assert.equal(buildCatalog(config(), [record]).sidekicks.filter(item => item.native).length, 0);
  }
  for (const entry of [{ modelUid: 'swe-json', disabled: false, modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'swe-json', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } }]) {
    const [record] = collectNativeModels({ clientModelConfigs: [entry] }, { rpc: 'GetCliModelConfigs', format: json });
    assert.equal(record.disabled, false);
    assert.equal(buildCatalog(config(), [record]).sidekicks.filter(item => item.native).length, 1);
  }
});

test('ambiguous user status envelopes drop observation entirely instead of guessing', () => {
  const fixture = statusFixture();
  const list = getNested(fixture.status, 33);
  for (const body of [
    cat(m(1, fixture.status), v(1, 7)),
    cat(m(1, fixture.status), m(1, fixture.status)),
    cat(v(9, 4), m(1, cat(s(1, 'opaque-user-value'), m(33, list), v(33, 2)))),
    cat(v(9, 4), m(1, cat(s(1, 'opaque-user-value'), m(33, list), m(33, list)))),
  ]) {
    assert.deepEqual(collectNativeModels(body, { rpc: lsStatus, format: proto }), []);
  }
});
