'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, augmentCatalog } = require('../src/catalog.cjs');
const { modelChoices } = require('../src/model-choices.cjs');
const { publicState, createManager } = require('../src/panel/model.cjs');
const { createNativePickerStore, listValue, readList } = require('../src/runtime/native-picker.cjs');
const { buildRequestBody } = require('../src/protocol/responses.cjs');
const { available, loadFamilyPicker, loadEffortPicker } = require('./support/installed-renderer.cjs');
const config = () => ({ enabled: true, fusionPresets: [], providers: [
  { id: 'one', name: 'One', models: [{ id: 'gpt-6.1-sol', efforts: ['low', 'high', 'max'] }, { id: 'plain', effortMode: 'none' }] },
  { id: 'two', name: 'Two', models: [{ id: 'gpt-6.1-sol', efforts: ['low', 'max'] }] },
] });

test('management exposes one model per provider with separate valid effort choices', () => {
  const input = config(), catalog = buildCatalog(input), choices = modelChoices(catalog.models);
  assert.equal(Object.keys(catalog.routes).length, 6);
  assert.equal(choices.length, 3);
  assert.deepEqual(choices[0].variants.map(item => item.effort), ['low', 'high', 'max']);
  assert.equal(choices[0].label, 'One · gpt-6.1-sol');
  const state = publicState(input);
  assert.equal(state.modelCount, 3);
  for (const role of ['lead', 'sidekick']) {
    assert.equal(state.presetCandidates[role].length, 3);
    assert.deepEqual(state.presetCandidates[role][0].variants.map(item => item.ref.effort), ['low', 'high', 'max']);
    assert.equal(state.presetCandidates[role][0].label, choices[0].label);
  }
  assert.equal(state.homeDefaults.length, 3);
  assert.equal(state.homeCandidates.length, 3);
});

test('legacy effort UIDs group on the homepage while every effort stays available in the native catalog', () => {
  const input = config(), before = buildCatalog(input);
  const variants = Object.values(before.routes).filter(route => route.providerId === 'one' && route.model === 'gpt-6.1-sol');
  input.homeModels = [variants[2].uid, variants[0].uid];
  const state = publicState(input);
  assert.equal(state.homeModels.length, 1);
  assert.equal(state.homeModels[0].label, 'One · gpt-6.1-sol');
  assert.deepEqual(input.homeModels, [variants[2].uid, variants[0].uid], 'reading never rewrites saved preferences');
  const catalog = buildCatalog(input);
  const result = augmentCatalog({ clientModelConfigs: [], clientModelSorts: [{ name: 'Recommended', groups: [] }] },
    { rpc: 'GetCascadeModelConfigs', format: { json: true }, catalog });
  const labels = result.clientModelSorts[0].groups[0].modelLabels;
  assert.deepEqual(labels, variants.map(route => catalog.models.find(model => model.uid === route.uid).label));
  assert.equal(result.clientModelConfigs.length, before.models.length);
  assert.deepEqual(catalog.routes, before.routes, 'wire routes and saved effort UIDs stay compatible');
});

test('installed Devin renders one curated model and switches all efforts to the exact provider request', { skip: !available }, () => {
  const input = config(), catalog = buildCatalog(input);
  const choice = modelChoices(catalog.models)[0];
  const curated = { ...catalog, homeModelUids: [choice.variants[2].uid], homeConfigured: true };
  const result = augmentCatalog({ clientModelConfigs: [], clientModelSorts: [{ name: 'Recommended', groups: [] }] },
    { rpc: 'GetCascadeModelConfigs', format: { json: true }, catalog: curated });
  const labels = new Set(result.clientModelSorts[0].groups[0].modelLabels);
  const models = result.clientModelConfigs.filter(model => labels.has(model.label)).map(model => ({ modelUid: model.modelUid, label: model.label,
    disabled: false, familyUid: model.modelInfo.modelFamilyUid,
    familyMetadata: Object.fromEntries(model.modelFamilyMetadata.entries.map(item => [item.key, item.value])) }));
  const rows = loadFamilyPicker().rows(models);
  assert.equal(rows.length, 1);
  const row = rows[0], select = loadEffortPicker();
  assert.deepEqual(Array.from(row.family.dimensions[0].values, item => item.name), ['Low', 'High', 'Max']);
  for (const effort of ['low', 'high', 'max']) {
    const variant = models.find(model => catalog.routes[model.modelUid].effort === effort);
    const selected = select(row.family, row.model, 0, variant.familyMetadata.Effort.order);
    assert.equal(selected.modelUid, variant.modelUid);
    const body = buildRequestBody({ systemPrompt: '', messages: [] }, catalog.routes[selected.modelUid], { apiFormat: 'openai' });
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.reasoning_effort, effort);
  }
});

test('editing a saved preset keeps provider/model identity and changes only the selected effort', async () => {
  let input = config();
  const first = { providerId: 'one', model: 'gpt-6.1-sol', effort: 'high' };
  input.fusionPresets = [{ id: 'saved', name: 'Saved', lead: first, sidekick: { providerId: 'one', model: 'plain', effort: null } }];
  const manager = createManager({ read: () => structuredClone(input), write: next => { input = next; } });
  const originalUid = manager.state().fusionPresets[0].uid;
  await manager.dispatch('saveFusionPreset', { ...input.fusionPresets[0], lead: { ...first, effort: 'max' } });
  assert.deepEqual(input.fusionPresets[0].lead, { providerId: 'one', model: 'gpt-6.1-sol', effort: 'max' });
  assert.equal(manager.state().fusionPresets[0].uid, originalUid);
  const selected = Object.values(buildCatalog(input).routes).find(route => route.providerId === 'one' && route.effort === 'max');
  for (const apiFormat of ['openai', 'openai-responses']) {
    const body = buildRequestBody({ systemPrompt: '', messages: [] }, selected, { apiFormat });
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(apiFormat === 'openai' ? body.reasoning_effort : body.reasoning.effort, 'max');
  }
  await assert.rejects(manager.dispatch('saveFusionPreset', { ...input.fusionPresets[0], lead: { ...first, effort: 'ultra' } }), /不可用/);
});

test('only explicit Apply consolidates duplicate own effort pins, preserving the first variant and official pins', async () => {
  const input = config(), catalog = buildCatalog(input);
  const variants = Object.values(catalog.routes).filter(route => route.providerId === 'one' && route.model === 'gpt-6.1-sol');
  const pins = [variants[1].uid, 'swe-2-max', variants[0].uid, 'swe-2-high'];
  const data = { pinnedCascadeModelUids: [...pins], lastSelectedCascadeModelUids: [variants[0].uid, variants[1].uid] };
  const picker = createNativePickerStore({ request: async (method, params) => {
    if (method === 'GetNativeValues') return { values: Object.fromEntries(Object.entries(data).map(([key, uids]) => [key, { value: listValue(uids) }])) };
    assert.deepEqual(params.expectedPreviousValue, listValue(data[params.key]));
    data[params.key] = readList(params.value); return { currentValue: { value: listValue(data[params.key]) } };
  } });
  let writes = 0;
  const manager = createManager({ read: () => structuredClone(input), write: () => { writes++; }, nativePicker: picker });
  const state = await manager.dispatch('ready');
  assert.equal(state.nativePicker.pinned.length, 3);
  assert.deepEqual(state.nativePicker.pinned[0].uids, [variants[1].uid, variants[0].uid]);
  assert.deepEqual(data.pinnedCascadeModelUids, pins, 'a read does not write native state');
  await manager.dispatch('normalizePickerModels');
  assert.deepEqual(data.pinnedCascadeModelUids, [variants[1].uid, 'swe-2-max', 'swe-2-high']);
  assert.deepEqual(data.lastSelectedCascadeModelUids, [variants[0].uid, variants[1].uid]);
  assert.equal(writes, 0);
});
