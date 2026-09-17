'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildCatalog, augmentCatalog, resolveAssignment, presetUid, normalizeFusionConfig } = require('../src/catalog.cjs');
const { createManager } = require('../src/panel/model.cjs');
const { fields, str, s, m } = require('../src/protocol/wire.cjs');
const ref = (model, effort = null) => ({ providerId: 'p', model, effort });
const preset = (id = 'one', name = '日常开发', lead = ref('a', 'high'), sidekick = ref('b')) => ({ id, name, lead, sidekick });
const config = () => ({ providers: [{ id: 'p', name: 'Provider', apiKey: 'SECRET', models: [{ id: 'a', efforts: ['low', 'high'] }, { id: 'b' }] }], fusionPresets: [] });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rpc = 'GetCascadeModelConfigs';

test('only explicitly saved presets generate routers; imported variants stay standalone', () => {
  const input = config();
  assert.equal(Object.keys(buildCatalog(input).fusions).length, 0);
  input.fusionPresets = [preset(), preset('two', '排查', ref('b'), ref('a', 'low'))];
  const catalog = buildCatalog(input);
  assert.equal(Object.keys(catalog.fusions).length, 2);
  assert.equal(Object.keys(catalog.routes).length, 3);
  assert.equal(catalog.models.length, 5);
  assert.equal(new Set(catalog.models.slice(0, 2).map(model => model.json.modelInfo.modelFamilyUid)).size, 2);
  assert.ok(catalog.models.slice(0, 2).every(model => model.json.modelFamilyMetadata.entries.length === 0));
  assert.ok(!JSON.stringify(catalog).includes('SECRET'));
  const uid = presetUid('one');
  input.fusionPresets[0].name = '改名';
  assert.equal(buildCatalog(input).fusions[uid].label, '改名');
  for (const entry of Object.values(catalog.fusions)) {
    assert.equal(resolveAssignment({ modelRouterUid: entry.uid }, { json: true }, catalog).assignment.modelUid, entry.leadUid);
    assert.equal(resolveAssignment({ fusionLeadRouterUid: entry.uid }, { json: true }, catalog).assignment.modelUid, entry.sidekickUid);
    const result = resolveAssignment(s(2, entry.uid), {}, catalog);
    assert.equal(str(fields(result, 1)[0].value, 2), entry.leadUid);
  }
});

test('independent exclusions and unavailable models preserve definitions without publishing stale routes', () => {
  const input = config(); input.fusionPresets = [preset(), preset('two', '逆向', ref('b'), ref('a', 'low'))];
  input.roleExclusions = { lead: [ref('a')], sidekick: [] };
  let catalog = buildCatalog(input);
  assert.deepEqual(Object.keys(catalog.fusions), [presetUid('two')]);
  assert.equal(catalog.presetStates.length, 2);
  input.roleExclusions.lead = [];
  input.providers[0].models[1].enabled = false;
  catalog = buildCatalog(input);
  assert.equal(Object.keys(catalog.fusions).length, 0);
  assert.equal(catalog.presetStates.length, 2);
  input.providers[0].models[1].enabled = true;
  assert.equal(Object.keys(buildCatalog(input).fusions).length, 2);
});

test('preset CRUD validates refs, preserves stable identity and survives manager recreation', async () => {
  let current = config();
  const manager = () => createManager({ read: () => structuredClone(current), write: next => { current = next; } });
  let state = await manager().dispatch('saveFusionPreset', { name: '日常', lead: ref('a', 'low'), sidekick: ref('b') });
  assert.equal(state.fusionCount, 1);
  const saved = state.fusionPresets[0];
  await assert.rejects(manager().dispatch('saveFusionPreset', { name: ' 日常 ', lead: ref('b'), sidekick: ref('b') }), /重复/);
  await assert.rejects(manager().dispatch('saveFusionPreset', { name: '错误', lead: ref('a', 'max'), sidekick: ref('b') }), /不可用/);
  state = await manager().dispatch('saveFusionPreset', { ...saved, name: '改名', lead: ref('a', 'high') });
  assert.equal(state.fusionPresets[0].uid, saved.uid);
  current.providers[0].enabled = false;
  state = await manager().dispatch('saveFusionPreset', { ...state.fusionPresets[0], name: '停用后改名' });
  assert.equal(state.fusionPresets[0].available, false);
  current.defaultFusionUid = saved.uid;
  await manager().dispatch('deleteFusionPreset', { id: saved.id });
  assert.deepEqual(current.fusionPresets, []);
  assert.equal(current.defaultFusionUid, undefined);
  assert.equal(current.providers[0].models.length, 2);
});

for (const snake of [false, true]) test('named JSON grouping is first and idempotent ' + snake, () => {
  const input = config(); input.fusionPresets = [preset()];
  const catalog = buildCatalog(input);
  const modelsKey = snake ? 'client_model_configs' : 'clientModelConfigs';
  const sortsKey = snake ? 'client_model_sorts' : 'clientModelSorts';
  const data = { [modelsKey]: [{ modelUid: 'native', label: 'Native', disabled: true }], [sortsKey]: [{ name: 'Order', groups: [{ groupName: 'Official', modelLabels: ['Native'] }] }] };
  const result = augmentCatalog(data, { rpc, format: { json: true }, catalog });
  assert.deepEqual(result[sortsKey][0].groups.map(group => group.groupName), ['我的 Fusion', 'Devin Fusion BYOK', 'Official']);
  assert.deepEqual(result[sortsKey][0].groups[0].modelLabels, ['日常开发']);
  assert.equal(result[modelsKey].at(-1).disabled, true);
  assert.deepEqual(augmentCatalog(result, { rpc, format: { json: true }, catalog }), result);
  const disabled = buildCatalog({ ...input, enabled: false });
  assert.deepEqual(augmentCatalog(data, { rpc, format: { json: true }, catalog: disabled }), data);
});

test('protobuf groups isolate presets ahead of imports and preserve official data', () => {
  const input = config(); input.fusionPresets = [preset()];
  const catalog = buildCatalog(input);
  const native = Buffer.concat([s(1, 'Native'), s(22, 'native')]);
  const data = Buffer.concat([m(1, native), m(2, Buffer.concat([s(1, 'Order'), m(2, Buffer.concat([s(1, 'Official'), s(2, 'Native')]))]))]);
  const result = augmentCatalog(data, { rpc, catalog });
  const groups = fields(fields(result, 2)[0].value, 2).map(field => str(field.value, 1));
  assert.deepEqual(groups, ['我的 Fusion', 'Devin Fusion BYOK', 'Official']);
  assert.deepEqual(fields(result, 1).at(-1).value, native);
  assert.deepEqual(augmentCatalog(result, { rpc, catalog }), result);
});

test('legacy default migration is exact, idempotent and does not recreate explicitly deleted presets', () => {
  const input = config(); delete input.fusionPresets;
  const catalog = buildCatalog(input);
  const lead = Object.values(catalog.routes).find(route => route.model === 'a' && route.effort === 'high');
  const side = Object.values(catalog.routes).find(route => route.model === 'b');
  input.defaultFusionUid = `fusion-${lead.uid}-sidekick-${digest(side.uid).slice(0, 16)}`;
  const next = buildCatalog(input);
  assert.equal(next.migratedFrom, input.defaultFusionUid);
  assert.equal(next.presetStates.length, 1);
  normalizeFusionConfig(input);
  assert.equal(input.defaultFusionUid, presetUid('legacy-default'));
  assert.deepEqual(normalizeFusionConfig(structuredClone(input)), input);
  input.fusionPresets = [];
  assert.equal(buildCatalog(input).presetStates.length, 0);
  const missing = { ...input, defaultFusionUid: 'fusion-dfbyok-native-unavailable' }; delete missing.fusionPresets;
  normalizeFusionConfig(missing);
  assert.equal(Object.hasOwn(missing, 'fusionPresets'), false);
});

test('installed picker keeps each named preset independently selectable and featured', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const file = '/Applications/Devin.app/Contents/Resources/app/out/vs/workbench/windsurf-chat-client/index.js';
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('function nrP('), end = source.indexOf('let nr$=', start);
  assert.ok(start >= 0 && end > start);
  const picker = vm.runInNewContext(source.slice(start, end) + ';({nrP,nrz,nrV})');
  const input = config(); input.fusionPresets = [preset(), preset('two', '排查')];
  const catalog = buildCatalog(input);
  const models = catalog.models.filter(model => model.kind === 'fusion').map(model => ({
    modelUid: model.uid, label: model.label, disabled: false, familyUid: model.json.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(model.json.modelFamilyMetadata.entries.map(entry => [entry.key, entry.value])),
  }));
  const rows = picker.nrV(picker.nrz(models), [], undefined, false);
  assert.deepEqual(Array.from(rows, row => row.model.modelUid), models.map(model => model.modelUid));
  assert.ok(rows.every(row => row.family.models.length === 1 && row.family.dimensions.length === 0));
  const groupStart = source.indexOf('function nc3('), groupEnd = source.indexOf('function nc8(', groupStart);
  assert.ok(groupStart >= 0 && groupEnd > groupStart);
  const groups = vm.runInNewContext(source.slice(groupStart, groupEnd) + ';nc3', { lP: { MODEL_ROUTER: 3 } });
  const sorted = groups([{ name: 'Recommended', groups: [{ groupName: '我的 Fusion', options: catalog.models.slice(0, 2).map(model => model.json) }] }], item => item);
  assert.equal(sorted[0].groups[0].isFeatured, true);
});

test('all native/imported role combinations use catalog-backed harnesses and team restrictions', () => {
  const fixture = require('./fixtures/real-picker-0.3.11.json');
  const natives = [...fixture.natives, ...fixture.fusions].map(item => ({ uid: item.uid, label: item.label || item.uid,
    disabled: item.disabled === 1, isModelRouter: item.router === 1, harnessUids: item.harnesses,
    fusionMetadata: (item.family || []).map(dim => ({ ...dim, controlType: dim.controlType ?? 0 })),
  }));
  const input = config();
  const candidates = buildCatalog(input, natives).presetCandidates;
  const nativeLead = candidates.lead.find(item => item.ref.nativeUid);
  const nativeSide = candidates.sidekick.find(item => item.ref.nativeUid);
  assert.ok(nativeLead && nativeSide);
  input.fusionPresets = [preset(), preset('in', 'IN', ref('a', 'high'), nativeSide.ref),
    preset('ni', 'NI', nativeLead.ref, ref('b')), preset('nn', 'NN', nativeLead.ref, nativeSide.ref)];
  const catalog = buildCatalog(input, natives);
  assert.equal(Object.keys(catalog.fusions).length, 4);
  for (const fusion of Object.values(catalog.fusions)) {
    assert.equal(resolveAssignment({ modelRouterUid: fusion.uid }, { json: true }, catalog).assignment.modelUid, fusion.leadUid);
    const side = resolveAssignment({ fusionLeadRouterUid: fusion.uid }, { json: true }, catalog).assignment;
    assert.equal(side.modelUid, fusion.sidekickUid);
    if (fusion.sidekickNative) assert.deepEqual(side.harnessUids, natives.find(item => item.uid === fusion.sidekickUid).harnessUids);
    if (fusion.leadNative) assert.deepEqual(resolveAssignment({ modelRouterUid: fusion.uid }, { json: true }, catalog).assignment.harnessUids, fusion.leadHarnessUids);
  }
  const teamRpc = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  for (const allowed of [[nativeLead.ref.nativeUid], [nativeSide.ref.nativeUid], [nativeLead.ref.nativeUid, nativeSide.ref.nativeUid]]) {
    const result = augmentCatalog({ allowedModelUids: allowed }, { rpc: teamRpc, format: { json: true }, catalog });
    assert.equal(result.allowedModelUids.includes(presetUid('nn')), allowed.includes(nativeLead.ref.nativeUid) && allowed.includes(nativeSide.ref.nativeUid));
  }
  const locked = natives.map(item => item.uid === nativeSide.ref.nativeUid ? { ...item, disabled: true } : item);
  assert.ok(!buildCatalog(input, locked).fusions[presetUid('nn')]);
});

test('ambiguous references, duplicate persisted names and invalid efforts fail closed', () => {
  for (const lead of [{ ...ref('a', 'high'), nativeUid: 'native' }, ref('a', 'max'), null]) {
    const input = config(); input.fusionPresets = [preset('bad', 'Bad', lead)];
    assert.equal(Object.keys(buildCatalog(input).fusions).length, 0);
  }
  const input = config(); input.fusionPresets = [preset(), preset('two')];
  assert.equal(Object.keys(buildCatalog(input).fusions).length, 0);
});

test('standalone unlocked native models are candidates without official Fusion rows', async () => {
  const native = { uid: 'standalone-swe', label: 'Standalone SWE', disabled: false, isModelRouter: false, harnessUids: ['swe-standalone'] };
  const input = config();
  const roles = require('../src/catalog.cjs').buildRoleLists(input, [native]);
  const leadRow = roles.lead.find(item => item.ref.nativeUid === native.uid);
  const sidekickRow = roles.sidekick.find(item => item.ref.nativeUid === native.uid);
  assert.equal(leadRow.available, true);
  assert.equal(leadRow.selected, false);
  assert.equal(sidekickRow.available, true);
  assert.equal(sidekickRow.selected, false);
  const catalog = buildCatalog(input, [native]);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid === native.uid), false);
  assert.equal(catalog.presetCandidates.sidekick.some(item => item.ref.nativeUid === native.uid), false);
  input.roleInclusions = { lead: [{ nativeUid: native.uid }], sidekick: [{ nativeUid: native.uid }] };
  const included = buildCatalog(input, [native]);
  assert.deepEqual(included.presetCandidates.lead.find(item => item.ref.nativeUid === native.uid).ref, { nativeUid: native.uid });
  assert.deepEqual(included.presetCandidates.sidekick.find(item => item.ref.nativeUid === native.uid).ref, { nativeUid: native.uid });
  input.fusionPresets = [preset('mixed', '混合', ref('a', 'high'), { nativeUid: native.uid }),
    preset('native', '原生', { nativeUid: native.uid }, { nativeUid: native.uid })];
  const mixed = buildCatalog(input, [native]);
  assert.deepEqual(mixed.fusions[presetUid('mixed')].sidekickHarnessUids, native.harnessUids);
  assert.deepEqual(mixed.fusions[presetUid('native')].leadHarnessUids, ['fusion', 'swe-standalone']);
  assert.deepEqual(resolveAssignment({ modelRouterUid: presetUid('native') }, { json: true }, mixed).assignment.harnessUids,
    ['fusion', 'swe-standalone']);
  const managerConfig = { ...input, fusionPresets: [] };
  const manager = createManager({ read: () => structuredClone(managerConfig), write: next => Object.assign(managerConfig, next), nativeModels: () => [native] });
  const state = await manager.dispatch('saveFusionPreset', { name: '再次保存', lead: { nativeUid: native.uid }, sidekick: { nativeUid: native.uid } });
  assert.equal(state.fusionPresets.some(item => item.name === '再次保存'), true);
});

test('standalone duplicate eligibility conflicts fail closed while identical records remain eligible', () => {
  const base = { uid: 'duplicate-native', label: 'Duplicate', disabled: false, isModelRouter: false, harnessUids: ['native-harness'] };
  for (const contradictory of [
    { disabled: true, isModelRouter: false, harnessUids: ['native-harness'] },
    { disabled: false, isModelRouter: true, harnessUids: ['native-harness'] },
    { disabled: false, isModelRouter: false, harnessUids: [] },
    { disabled: false, isModelRouter: false, harnessUids: ['different'] },
    { disabled: false, isModelRouter: false, harnessUids: ['   '] },
  ]) {
    for (const order of [[base, { ...base, ...contradictory }], [{ ...base, ...contradictory }, base]]) {
      const input = config();
      input.roleInclusions = { lead: [{ nativeUid: base.uid }], sidekick: [{ nativeUid: base.uid }] };
      const catalog = buildCatalog(input, order);
      assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid === base.uid), false);
      assert.equal(catalog.presetCandidates.sidekick.some(item => item.ref.nativeUid === base.uid), false);
    }
  }
  const input = config();
  input.roleInclusions = { lead: [{ nativeUid: base.uid }], sidekick: [{ nativeUid: base.uid }] };
  const candidates = buildCatalog(input, [base, { ...base }]).presetCandidates;
  assert.equal(candidates.lead.filter(item => item.ref.nativeUid === base.uid).length, 1);
  assert.equal(candidates.sidekick.filter(item => item.ref.nativeUid === base.uid).length, 1);
});

test('standalone native candidates preserve filtering and role-specific exclusions', () => {
  const valid = { uid: 'valid-native', label: 'Valid', disabled: false, isModelRouter: false, harnessUids: ['native-harness'] };
  const entries = [valid,
    { uid: 'disabled-native', label: 'Disabled', disabled: true, isModelRouter: false, harnessUids: ['h'] },
    { uid: 'router-native', label: 'Router', disabled: false, isModelRouter: true, harnessUids: ['h'] },
    { uid: 'bad-harness', label: 'Bad', disabled: false, isModelRouter: false, harnessUids: [] },
    { uid: 'fusion-router', label: 'Fusion', disabled: false, isModelRouter: false, harnessUids: ['h'] },
    { uid: 'malformed-harness', label: 'Malformed', disabled: false, isModelRouter: false, harnessUids: [''] },
  ];
  const input = config(); input.hiddenNativeModelUids = ['valid-native'];
  input.roleInclusions = { lead: [{ nativeUid: valid.uid }], sidekick: [{ nativeUid: valid.uid }] };
  let catalog = buildCatalog(input, entries);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid), false);
  input.hiddenNativeModelUids = [];
  input.roleExclusions = { lead: [{ nativeUid: valid.uid }], sidekick: [] };
  catalog = buildCatalog(input, entries);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid === valid.uid), false);
  assert.equal(catalog.presetCandidates.sidekick.some(item => item.ref.nativeUid === valid.uid), true);
  input.roleInclusions = { lead: [{ nativeUid: 'disabled-native' }, { nativeUid: 'fusion-router' }], sidekick: input.roleInclusions.sidekick };
  catalog = buildCatalog(input, entries);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid === 'disabled-native'), false);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid === 'fusion-router'), false);
});

test('manager saves all native/imported preset shapes with exact JSON and protobuf assignments', async () => {
  const native = { uid: 'standalone-swe', label: 'Standalone SWE', disabled: false, isModelRouter: false, harnessUids: ['native-harness'] };
  const managerConfig = config(); managerConfig.fusionPresets = [];
  managerConfig.roleInclusions = { lead: [{ nativeUid: native.uid }], sidekick: [{ nativeUid: native.uid }] };
  const manager = createManager({ read: () => structuredClone(managerConfig), write: next => Object.assign(managerConfig, next), nativeModels: () => [native] });
  const nativeRef = { nativeUid: native.uid };
  const pairs = [[ref('a', 'high'), nativeRef], [nativeRef, ref('b')], [nativeRef, nativeRef]];
  for (const [lead, sidekick] of pairs) await manager.dispatch('saveFusionPreset', { name: JSON.stringify([lead, sidekick]), lead, sidekick });
  const catalog = buildCatalog(managerConfig, [native]);
  for (const fusion of Object.values(catalog.fusions)) {
    const jsonLead = resolveAssignment({ modelRouterUid: fusion.uid }, { json: true }, catalog).assignment;
    const jsonSide = resolveAssignment({ modelRouterUid: fusion.uid, fusionLeadRouterUid: fusion.uid }, { json: true }, catalog).assignment;
    assert.equal(jsonLead.modelUid, fusion.leadUid); assert.equal(jsonSide.modelUid, fusion.sidekickUid);
    if (fusion.leadNative) assert.deepEqual(jsonLead.harnessUids, fusion.leadHarnessUids);
    if (fusion.sidekickNative) assert.deepEqual(jsonSide.harnessUids, fusion.sidekickHarnessUids);
    const protoLead = resolveAssignment(s(2, fusion.uid), {}, catalog);
    const protoSide = resolveAssignment(Buffer.concat([s(2, fusion.uid), s(6, fusion.uid)]), {}, catalog);
    assert.equal(str(fields(protoLead, 1)[0].value, 2), fusion.leadUid);
    assert.equal(str(fields(protoSide, 1)[0].value, 2), fusion.sidekickUid);
  }
});

test('opt-in role switches persist, stay role-specific and explicit off beats saved presets', async () => {
  const native = { uid: 'optin-native', label: 'OptIn', disabled: false, isModelRouter: false, harnessUids: ['optin-harness'] };
  const managerConfig = config(); managerConfig.fusionPresets = [];
  const manager = createManager({ read: () => structuredClone(managerConfig), write: next => Object.assign(managerConfig, next), nativeModels: () => [native] });
  await manager.dispatch('setRoleModel', { role: 'sidekick', model: { nativeUid: native.uid }, enabled: true });
  assert.deepEqual(managerConfig.roleInclusions, { lead: [], sidekick: [{ nativeUid: native.uid }] });
  let catalog = buildCatalog(managerConfig, [native]);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.nativeUid === native.uid), false);
  assert.equal(catalog.presetCandidates.sidekick.some(item => item.ref.nativeUid === native.uid), true);
  const restarted = createManager({ read: () => structuredClone(managerConfig), write: next => Object.assign(managerConfig, next), nativeModels: () => [] });
  const missing = restarted.state();
  const row = missing.roleLists.sidekick.find(item => item.ref.nativeUid === native.uid);
  assert.equal(row.selected, false);
  assert.equal(row.explicitIncluded, true);
  assert.equal(row.available, false);
  const returned = createManager({ read: () => structuredClone(managerConfig), write: next => Object.assign(managerConfig, next), nativeModels: () => [native] });
  const backRow = returned.state().roleLists.sidekick.find(item => item.ref.nativeUid === native.uid);
  assert.equal(backRow.available, true);
  assert.equal(backRow.selected, true);
  managerConfig.fusionPresets = [preset('saved', '已保存', ref('a', 'high'), { nativeUid: native.uid })];
  delete managerConfig.roleInclusions;
  assert.equal(buildCatalog(managerConfig, [native]).presetCandidates.sidekick.some(item => item.ref.nativeUid === native.uid), true);
  managerConfig.roleExclusions = { lead: [], sidekick: [{ nativeUid: native.uid }] };
  catalog = buildCatalog(managerConfig, [native]);
  assert.equal(catalog.presetCandidates.sidekick.some(item => item.ref.nativeUid === native.uid), false);
  assert.equal(catalog.fusions[presetUid('saved')], undefined);
});

test('disabled providers and models are never selected or preset candidates', () => {
  const input = config();
  input.providers[0].models[0].enabled = false;
  const roles = require('../src/catalog.cjs').buildRoleLists(input, []);
  const leadRow = roles.lead.find(item => item.ref.model === 'a');
  assert.equal(leadRow.available, false);
  assert.equal(leadRow.selected, false);
  const catalog = buildCatalog(input, []);
  assert.equal(catalog.presetCandidates.lead.some(item => item.ref.model === 'a'), false);
  assert.equal(catalog.presetCandidates.sidekick.some(item => item.ref.model === 'a'), false);
  const off = config();
  off.providers[0].enabled = false;
  const catalog2 = buildCatalog(off, []);
  assert.equal(catalog2.presetCandidates.lead.length, 0);
  assert.equal(catalog2.presetCandidates.sidekick.length, 0);
});
