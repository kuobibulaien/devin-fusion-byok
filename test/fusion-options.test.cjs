'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { modelEfforts } = require('../src/model-capabilities.cjs');
const { buildCatalog, resolveAssignment } = require('../src/catalog.cjs');
const { buildRequestBody } = require('../src/protocol/responses.cjs');
const { createManager } = require('../src/panel/model.cjs');
const rendererFile = '/Applications/Devin.app/Contents/Resources/app/out/vs/workbench/windsurf-chat-client/index.js';
const config = () => ({ providers: [{ id: 'load', name: 'load', apiFormat: 'openai-responses', models:
  ['gpt-6-astra', 'swe-2-high', 'swe-2-max', 'swe-2-medium'].map(id => ({ id, efforts: [] })) }],
  sidekicks: [{ providerId: 'load', model: 'swe-2-max' }, { nativeUid: 'swe-2-max' }] });
const OBSERVED_SWE = { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] };

test('legacy empty effort lists gain GPT presets while retaining provider-default routing UIDs', () => {
  const catalog = buildCatalog(config());
  const gpt = Object.values(catalog.routes).filter(route => route.model === 'gpt-6-astra');
  assert.deepEqual(gpt.map(route => route.effort), [null, 'low', 'medium', 'high', 'xhigh']);
  const digest = crypto.createHash('sha256').update(JSON.stringify(['load', 'gpt-6-astra', null])).digest('hex').slice(0, 16);
  assert.equal(gpt[0].uid, 'dfbyok-load-gpt-6-astra-' + digest);
  assert.deepEqual(modelEfforts({ id: 'swe-2-max', efforts: [] }), [null]);
  assert.deepEqual(modelEfforts({ id: 'relay/gpt-6-astra-high', efforts: [] }), [null]);
  assert.deepEqual(modelEfforts({ id: 'custom-model', efforts: [] }), [null]);
  assert.deepEqual(modelEfforts({ id: 'gpt-6-astra', efforts: [], effortMode: 'none' }), [null]);
  assert.deepEqual(modelEfforts({ id: 'custom-model', efforts: ['none', 'medium', 'max'], effortMode: 'manual' }), ['none', 'medium', 'max']);
});

test('every enabled import is a Sidekick without a second configuration step', () => {
  const input = config();
  input.providers.push({ id: 'other', name: 'Other', models: [{ id: 'extra' }, { id: 'disabled', enabled: false }] });
  const catalog = buildCatalog(input, [OBSERVED_SWE]);
  assert.deepEqual(new Set(catalog.sidekicks.filter(s => !s.native).map(s => s.providerId + '/' + s.model)),
    new Set(['load/gpt-6-astra', 'load/swe-2-high', 'load/swe-2-max', 'load/swe-2-medium', 'other/extra']));
  for (const route of Object.values(catalog.routes)) {
    const pairs = Object.values(catalog.fusions).filter(f => f.leadUid === route.uid);
    assert.equal(pairs.length, 6);
    assert.equal(new Set(pairs.map(f => f.sidekickUid)).size, 6);
  }
  assert.equal(input.sidekicks.length, 2, 'catalog generation does not rewrite user settings');
});

test('selected native Fusion effort resolves to the actual Responses and Chat API parameter', () => {
  const catalog = buildCatalog(config());
  const request = { systemPrompt: '', messages: [{ role: 'user', content: 'Hello' }] };
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const pair = Object.values(catalog.fusions).find(f => catalog.routes[f.leadUid].model === 'gpt-6-astra' && catalog.routes[f.leadUid].effort === effort &&
      !f.sidekickNative && catalog.routes[f.sidekickUid].model === 'swe-2-high');
    assert.ok(pair);
    const lead = resolveAssignment({ modelRouterUid: pair.uid }, { json: true }, catalog).assignment.modelUid;
    assert.equal(buildRequestBody(request, catalog.routes[lead], { apiFormat: 'openai-responses' }).reasoning.effort, effort);
    assert.equal(buildRequestBody(request, catalog.routes[lead], { apiFormat: 'openai' }).reasoning_effort, effort);
    const sidekick = resolveAssignment({ modelRouterUid: pair.uid, fusionLeadRouterUid: pair.uid }, { json: true }, catalog).assignment.modelUid;
    assert.equal(catalog.routes[sidekick].model, 'swe-2-high');
  }
  assert.equal(buildRequestBody(request, { model: 'custom', effort: 'none' }, { apiFormat: 'openai' }).reasoning_effort, 'none');
  assert.deepEqual(buildRequestBody(request, { model: 'custom', effort: 'none' }, { apiFormat: 'openai-responses' }).reasoning, { effort: 'none' });
  assert.equal(buildRequestBody(request, { model: 'custom', effort: null }, { apiFormat: 'openai' }).reasoning_effort, undefined);
});

test('actual installed Fusion picker enables every GPT effort and imported Sidekick', { skip: !fs.existsSync(rendererFile) }, () => {
  const source = fs.readFileSync(rendererFile, 'utf8');
  const start = source.indexOf('function nrM('), end = source.indexOf('let nrG=', start);
  assert.ok(start >= 0 && end > start);
  const native = vm.runInNewContext(source.slice(start, end) + ';({nrM,nrF,nrq})');
  const catalog = buildCatalog(config(), [OBSERVED_SWE]);
  const models = catalog.models.filter(m => m.kind === 'fusion').map(m => ({ modelUid: m.uid, disabled: false, familyUid: 'fusion',
    familyMetadata: Object.fromEntries(m.json.modelFamilyMetadata.entries.map(e => [e.key, e.value])) }));
  const family = native.nrM(models).families.get('fusion');
  const effortIndex = family.dimensions.findIndex(d => d.name === 'Effort');
  const sidekickIndex = family.dimensions.findIndex(d => d.name === 'Sidekick');
  const initial = models.find(m => catalog.routes[catalog.fusions[m.modelUid].leadUid].model === 'gpt-6-astra');
  for (const dimension of family.dimensions[effortIndex].values) {
    assert.equal(native.nrF(family, initial, effortIndex, dimension.order), true, dimension.name);
    const selected = native.nrq(family, initial, effortIndex, dimension.order);
    assert.equal(selected.familyMetadata.Effort.name, dimension.name);
    for (const sidekick of family.dimensions[sidekickIndex].values) {
      assert.equal(native.nrF(family, selected, sidekickIndex, sidekick.order), true, sidekick.name);
      const changed = native.nrq(family, selected, sidekickIndex, sidekick.order);
      assert.equal(changed.familyMetadata.Sidekick.name, sidekick.name);
      assert.equal(changed.familyMetadata.Effort.name, dimension.name);
    }
  }
});

test('selective import immediately exposes the new model in both roles and effort settings are editable', async () => {
  let current = { providers: [{ id: 'load', name: 'load', models: [] }], sidekicks: [{ nativeUid: 'swe-2-max' }] };
  const manager = createManager({ read: () => structuredClone(current), write: c => { current = c; },
    discover: async p => { p.models = [{ id: 'gpt-6-astra', efforts: [] }] }, nativeModels: () => [OBSERVED_SWE] });
  const preview = await manager.dispatch('refreshModels', { providerId: 'load' });
  assert.equal(preview.fusionCount, 0);
  const imported = await manager.dispatch('importModels', { providerId: 'load', token: preview.importCandidates.token, ids: ['gpt-6-astra'] });
  assert.equal(imported.fusionCount, 10);
  assert.ok(imported.sidekicks.some(s => s.providerId === 'load' && s.model === 'gpt-6-astra'));
  const custom = await manager.dispatch('updateModels', { providerId: 'load', changes: [{ id: 'gpt-6-astra', effortMode: 'manual', efforts: ['low', 'high'] }] });
  assert.equal(custom.fusionCount, 4);
  const providerDefault = await manager.dispatch('updateModels', { providerId: 'load', changes: [{ id: 'gpt-6-astra', effortMode: 'none' }] });
  assert.equal(providerDefault.fusionCount, 2);
});
