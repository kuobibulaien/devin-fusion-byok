'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createManager, publicState, cleanSidekicks, PanelInputError } = require('../src/panel/model.cjs');
const { buildCatalog } = require('../src/catalog.cjs');

const nativeSidekick = { nativeUid: 'swe-2-max', label: 'SWE-2 Max' };
const OBSERVED_SWE = [
  { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] },
  { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
];
const model = (id, overrides = {}) => ({ id, label: id, enabled: true, efforts: [], contextWindow: 200000, maxOutputTokens: 32768, ...overrides });
function fixture() {
  return {
    enabled: true, inferenceServerUrl: 'http://127.0.0.1:39842',
    providers: [
      { id: 'cpa', name: 'CPA', baseUrl: 'https://cpa.invalid/v1', apiFormat: 'openai-responses', apiKey: 'fixture-secret-cpa', enabled: true,
        models: [model('lead', { label: 'CPA · lead' }), model('executor', { label: 'My executor' })] },
      { id: 'other', name: 'Other', baseUrl: 'https://other.invalid/v1', apiFormat: 'openai', apiKey: 'fixture-secret-other', enabled: true,
        models: [model('other-lead')] },
    ],
    sidekicks: [{ providerId: 'cpa', model: 'executor' }, nativeSidekick],
  };
}
function memory(options = {}) {
  let config = structuredClone(options.config || fixture()), selected = '';
  const writes = [], changes = [], selections = [];
  const manager = createManager({
    read: () => structuredClone(config),
    write: next => { config = structuredClone(next); writes.push(structuredClone(next)); },
    discover: options.discover || (async () => { throw new Error('Unexpected discovery'); }),
    afterChange: async type => { changes.push(type); await options.afterChange?.(type); },
    selectFusion: async uid => { selections.push(uid); selected = uid; },
    selectedFusion: () => selected,
    nativeModels: options.nativeModels || (() => []),
  });
  return { manager, writes, changes, selections,
    read: () => structuredClone(config),
    externalChange: edit => { edit(config); },
  };
}
const providerPayload = (overrides = {}) => ({ id: 'cpa', name: 'Updated CPA', baseUrl: 'https://new.invalid/v1/responses', apiFormat: 'openai', apiKey: '', ...overrides });
function assertValidGraph(config, natives = []) {
  const catalog = buildCatalog(config, natives);
  for (const fusion of Object.values(catalog.fusions)) {
    assert.ok(catalog.routes[fusion.leadUid]);
    if (fusion.sidekickNative) assert.ok(Array.isArray(fusion.sidekickHarnessUids) && fusion.sidekickHarnessUids.length > 0);
    else assert.ok(catalog.routes[fusion.sidekickUid]);
  }
  return catalog;
}

test('public panel state exposes multiple providers and combinations without API credentials', async () => {
  const f = memory({ nativeModels: () => OBSERVED_SWE });
  const state = await f.manager.dispatch('ready');
  assert.equal(state.providers.length, 2);
  assert.equal(state.modelCount, 3);
  assert.equal(state.fusionCount, 0);
  assert.equal(state.fusionChoices.length, 0);
  assert.equal(state.presetCandidates.sidekick.length, 4);
  assert.equal(state.providers[0].keyConfigured, true);
  assert.equal(state.providers[0].baseUrl, 'https://cpa.invalid/v1');
  for (const secret of ['fixture-secret-cpa', 'fixture-secret-other', 'apiKey', 'Authorization']) assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
  const input = fixture(); input.providers[1].apiKey = '';
  assert.equal(publicState(input).providers[1].keyConfigured, false);
});

test('editing a provider preserves its models, blank existing key, and every other provider', async () => {
  const f = memory(), before = f.read();
  await f.manager.dispatch('saveProvider', providerPayload());
  const after = f.read();
  assert.deepEqual(after.providers[1], before.providers[1]);
  assert.equal(after.providers[0].id, 'cpa');
  assert.equal(after.providers[0].apiKey, 'fixture-secret-cpa');
  assert.equal(after.providers[0].baseUrl, 'https://new.invalid/v1');
  assert.equal(after.providers[0].apiFormat, 'openai');
  assert.equal(after.providers[0].models[0].label, 'Updated CPA · lead');
  assert.equal(after.providers[0].models[1].label, 'My executor');
  assert.deepEqual(after.sidekicks, before.sidekicks);
  assert.deepEqual(f.changes, ['saveProvider']);
});

test('a replacement key is stored only in private configuration and omitted keys preserve it', async () => {
  const f = memory();
  const state = await f.manager.dispatch('saveProvider', providerPayload({ apiKey: ' replacement-private-key ' }));
  assert.equal(f.read().providers[0].apiKey, 'replacement-private-key');
  assert.ok(!JSON.stringify(state).includes('replacement-private-key'));
  const next = providerPayload(); delete next.apiKey;
  await f.manager.dispatch('saveProvider', next);
  assert.equal(f.read().providers[0].apiKey, 'replacement-private-key');
});

test('adding a supplier never overwrites existing providers and accepts keyless local endpoints', async () => {
  const f = memory(), original = f.read().providers;
  await f.manager.dispatch('saveProvider', providerPayload({ id: undefined, name: 'Local', baseUrl: 'http://127.0.0.1:9123/v1/chat/completions' }));
  await f.manager.dispatch('saveProvider', providerPayload({ id: undefined, name: 'Local', baseUrl: 'https://another.invalid/v1' }));
  const next = f.read().providers;
  assert.deepEqual(next.slice(0, 2), original);
  assert.equal(next.length, 4);
  assert.notEqual(next[2].id, next[3].id);
  assert.match(next[2].id, /^provider-/);
  assert.equal(next[2].baseUrl, 'http://127.0.0.1:9123/v1');
  assert.equal(next[2].apiKey, '');
  assert.deepEqual(next[2].models, []);
});

test('manual models support independent display names, image support, limits, and effort variants', async () => {
  const f = memory();
  await f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'manual-model', label: 'Custom',
    supportsImages: true, contextWindow: 500000, maxOutputTokens: 32000, efforts: ['low', 'high', 'high'] } });
  const added = f.read().providers[1].models.find(m => m.id === 'manual-model');
  assert.deepEqual(added, model('manual-model', { label: 'Custom', source: 'manual', supportsImages: true,
    contextWindow: 500000, maxOutputTokens: 32000, efforts: ['low', 'high'] }));
  assert.equal(f.manager.state().modelCount, 5);
  await f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'manual-off', supportsImages: false } });
  assert.equal(f.read().providers[1].models.find(m => m.id === 'manual-off').supportsImages, true);
  const before = f.read();
  await assert.rejects(f.manager.dispatch('addModel', { providerId: 'other', model: { id: 'manual-model' } }), PanelInputError);
  assert.deepEqual(f.read(), before);
});

test('model metadata edits preserve stable routing IDs and do not change another provider', async () => {
  const f = memory(), before = f.read(), previousRoutes = Object.keys(buildCatalog(before).routes);
  await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'lead', label: 'New display name',
    contextWindow: 400000, maxOutputTokens: 64000, supportsImages: true }] });
  const next = f.read();
  assert.deepEqual(Object.keys(buildCatalog(next).routes), previousRoutes);
  assert.deepEqual(next.providers[1], before.providers[1]);
  assert.equal(next.providers[0].models[0].label, 'New display name');
  assert.equal(next.providers[0].models[0].apiKey, undefined);
  await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'executor', supportsImages: false }] });
  assert.equal(f.read().providers[0].models.find(m => m.id === 'executor').supportsImages, true);
});

for (const action of ['disable-model', 'remove-model', 'disable-provider', 'delete-provider']) test(`${action} removes unavailable Sidekicks and leaves a valid Fusion graph`, async () => {
  const input = fixture(); input.sidekicks = [{ providerId: 'cpa', model: 'executor' }];
  const f = memory({ config: input });
  if (action === 'disable-model') await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'executor', enabled: false }] });
  if (action === 'remove-model') await f.manager.dispatch('updateModels', { providerId: 'cpa', removeIds: ['executor'] });
  if (action === 'disable-provider') await f.manager.dispatch('setProviderEnabled', { id: 'cpa', enabled: false });
  if (action === 'delete-provider') await f.manager.dispatch('deleteProvider', { id: 'cpa' });
  const next = f.read();
  assert.deepEqual(next.sidekicks, [], 'no native fallback is injected after cleanup');
  const catalog = assertValidGraph(next);
  assert.ok(Object.values(catalog.routes).every(route => route.model !== 'executor'));
  assert.ok(Object.values(catalog.routes).some(route => route.providerId === 'other'));
  assert.ok(Object.values(catalog.fusions).every(fusion => fusion.sidekickNative || catalog.routes[fusion.sidekickUid].model !== 'executor'));
});

test('disabling then re-enabling a provider preserves its keys and configured model list', async () => {
  const f = memory(), previous = f.read().providers[0];
  await f.manager.dispatch('setProviderEnabled', { id: 'cpa', enabled: false });
  assert.equal(f.manager.state().modelCount, 1);
  await f.manager.dispatch('setProviderEnabled', { id: 'cpa', enabled: true });
  assert.equal(f.manager.state().modelCount, 3);
  assert.deepEqual(f.read().providers[0], previous);
});

test('any enabled third-party model may be a Sidekick together with an eligible observed native', async () => {
  const f = memory({ nativeModels: () => OBSERVED_SWE });
  await f.manager.dispatch('setSidekicks', { sidekicks: [{ providerId: 'other', model: 'other-lead' }, { nativeUid: 'swe-2-max', label: 'Ignored caller label' }] });
  const next = f.read();
  assert.deepEqual(next.sidekicks, [{ providerId: 'other', model: 'other-lead' }, nativeSidekick]);
  const catalog = assertValidGraph(next, OBSERVED_SWE);
  assert.equal(Object.keys(catalog.fusions).length, 0);
  assert.deepEqual(new Set(catalog.presetCandidates.sidekick.filter(item => !item.ref.nativeUid).map(item => item.ref.model)),
    new Set(['lead', 'executor', 'other-lead']));
});

test('Sidekick selection rejects missing, disabled, and unobserved native models without changing config', async () => {
  const input = fixture(); input.providers[1].models[0].enabled = false;
  const f = memory({ config: input }), before = f.read();
  for (const sidekicks of [[{ providerId: 'other', model: 'other-lead' }], [{ providerId: 'missing', model: 'x' }],
    [{ providerId: 'cpa', model: 'missing' }], [{ nativeUid: 'swe-2-medium' }], [{ nativeUid: 'swe-2-max' }], [null], 'x']) {
    await assert.rejects(f.manager.dispatch('setSidekicks', { sidekicks }), PanelInputError);
    assert.deepEqual(f.read(), before);
  }
  assert.equal(f.writes.length, 0);
  const allowed = await f.manager.dispatch('setSidekicks', { sidekicks: [] });
  assert.deepEqual(allowed.sidekicks.filter(item => item.providerId).length > 0, true, 'empty explicit lists keep automatic provider candidates');
});

test('fetching candidates never imports or removes models; confirmation adds only selected models', async () => {
  const input = fixture();
  input.providers[0].models = [model('lead', { enabled: false, label: 'Keep this label', efforts: ['high'] }),
    model('gone-import'), model('manual-only', { source: 'manual', label: 'Private deployment' })];
  input.sidekicks = [nativeSidekick];
  const f = memory({ config: input, discover: async provider => {
    assert.equal(provider.apiKey, 'fixture-secret-cpa');
    provider.models = [model('lead', { label: 'Provider label' }), model('new-import'), model('not-selected')];
  } });
  const other = f.read().providers[1];
  const initial = f.read();
  const preview = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  assert.deepEqual(f.read(), initial);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(preview.importCandidates.models.map(m => [m.id, m.imported]), [['lead', true], ['new-import', false], ['not-selected', false]]);
  assert.ok(!JSON.stringify(preview).includes('fixture-secret'));
  await f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.importCandidates.token, ids: ['new-import'] });
  const next = f.read();
  assert.deepEqual(next.providers[0].models.map(m => m.id), ['lead', 'gone-import', 'manual-only', 'new-import']);
  assert.deepEqual(next.providers[0].models[0], input.providers[0].models[0]);
  assert.deepEqual(next.providers[0].models[2], input.providers[0].models[2]);
  assert.deepEqual(next.providers[1], other);
  assert.equal(f.manager.state().importCandidates, null);
  assertValidGraph(next);
});

test('refresh applies results to fresh state while preserving concurrent model and unrelated provider edits', async () => {
  const f = memory({ discover: async provider => {
    f.externalChange(current => {
      current.providers[0].models[0].enabled = false;
      current.providers[0].models[0].label = 'Changed in another window';
      current.providers[0].models.push(model('manual-concurrent', { source: 'manual' }));
      current.providers[1].apiKey = 'new-key-in-another-window';
    });
    provider.models = [model('lead'), model('new-import')];
  } });
  await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  const preview = f.manager.state().importCandidates;
  f.externalChange(current => { current.providers[0].models.push(model('new-import', { label: 'Added concurrently', enabled: false })); });
  await f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids: ['new-import'] });
  const next = f.read();
  assert.equal(next.providers[0].models[0].enabled, false);
  assert.equal(next.providers[0].models[0].label, 'Changed in another window');
  assert.ok(next.providers[0].models.some(m => m.id === 'manual-concurrent'));
  assert.equal(next.providers[1].apiKey, 'new-key-in-another-window');
  assert.deepEqual(next.sidekicks, fixture().sidekicks);
  assert.equal(next.providers[0].models.filter(m => m.id === 'new-import').length, 1);
  assert.equal(next.providers[0].models.find(m => m.id === 'new-import').label, 'Added concurrently');
  assert.equal(next.providers[0].models.find(m => m.id === 'new-import').enabled, false);
});

for (const field of ['apiKey', 'baseUrl', 'apiFormat']) test(`refresh rejects stale results when another window changes ${field}`, async () => {
  const f = memory({ discover: async provider => {
    provider.models = [model('should-not-commit')];
    f.externalChange(current => { current.providers[0][field] = field === 'apiFormat' ? 'openai' : field === 'baseUrl' ? 'https://changed.invalid/v1' : 'replacement-secret'; });
  } });
  await assert.rejects(f.manager.dispatch('refreshModels', { providerId: 'cpa' }), PanelInputError);
  const next = f.read();
  assert.ok(!next.providers[0].models.some(m => m.id === 'should-not-commit'));
  assert.notEqual(next.providers[0][field], fixture().providers[0][field]);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
});

test('refresh cannot resurrect a provider deleted while discovery is pending', async () => {
  const f = memory({ discover: async provider => {
    provider.models = [model('should-not-commit')];
    f.externalChange(current => { current.providers = current.providers.filter(p => p.id !== 'cpa'); current.sidekicks = [nativeSidekick]; });
  } });
  await assert.rejects(f.manager.dispatch('refreshModels', { providerId: 'cpa' }), PanelInputError);
  assert.deepEqual(f.read().providers.map(p => p.id), ['other']);
  assert.equal(f.writes.length, 0);
});

test('failed or graph-invalid discovery never commits a partially refreshed configuration', async () => {
  for (const discover of [async provider => { provider.models = []; throw new Error('Fixture network failure'); },
    async provider => { provider.models = [model('duplicate'), model('duplicate')]; },
    async provider => { provider.models = [{ id: '' }]; }]) {
    const f = memory({ discover }), before = f.read();
    await assert.rejects(f.manager.dispatch('refreshModels', { providerId: 'cpa' }));
    assert.deepEqual(f.read(), before);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.changes, []);
  }
});

test('a model batch is validated as a whole before any persistent write', async () => {
  const f = memory(), before = f.read();
  await assert.rejects(f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [
    { id: 'lead', label: 'Should not persist' }, { id: 'executor', contextWindow: 1000, maxOutputTokens: 1001 },
  ] }), PanelInputError);
  assert.deepEqual(f.read(), before);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.changes, []);
});

test('Fusion selection validates a currently available combination without writing provider configuration', async () => {
  const input = fixture();
  input.fusionPresets = [{ id: 'selected', name: 'Selected', lead: { providerId: 'cpa', model: 'lead' }, sidekick: { providerId: 'cpa', model: 'executor' } }];
  const f = memory({ config: input }), uid = Object.keys(buildCatalog(f.read()).fusions)[0];
  const state = await f.manager.dispatch('selectFusion', { uid });
  assert.deepEqual(f.selections, [uid]);
  assert.equal(state.selectedFusionUid, uid);
  assert.equal(f.writes.length, 0);
  for (const invalid of ['', 'swe-2-max', '__proto__', 'constructor', 'fusion-dfbyok-missing']) {
    await assert.rejects(f.manager.dispatch('selectFusion', { uid: invalid }), PanelInputError);
  }
  await f.manager.dispatch('setEnabled', { enabled: false });
  await assert.rejects(f.manager.dispatch('selectFusion', { uid }), PanelInputError);
  assert.deepEqual(f.selections, [uid]);
});

test('a disabled or removed Lead cannot remain selectable through a stale Fusion UID', async () => {
  const input = fixture();
  input.fusionPresets = [{ id: 'selected', name: 'Selected', lead: { providerId: 'cpa', model: 'lead' }, sidekick: { providerId: 'cpa', model: 'executor' } }];
  const f = memory({ config: input }), catalog = buildCatalog(f.read());
  const uid = Object.values(catalog.fusions).find(fusion => catalog.routes[fusion.leadUid].model === 'lead').uid;
  await f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'lead', enabled: false }] });
  await assert.rejects(f.manager.dispatch('selectFusion', { uid }), PanelInputError);
  assert.deepEqual(f.selections, []);
});

test('invalid messages and fields fail safely, do not write, and do not poison subsequent queued commands', async () => {
  const f = memory(), before = f.read();
  const invalid = [
    ['unknownAction', {}], ['ready', null], ['ready', []], ['ready', 'string'],
    ['setEnabled', { enabled: 'false' }], ['setProviderEnabled', { id: 'cpa', enabled: 0 }],
    ['saveProvider', providerPayload({ name: ' ' })],
    ['saveProvider', providerPayload({ baseUrl: 'file:///tmp/not-an-api' })],
    ['saveProvider', providerPayload({ baseUrl: 'https://user:password@invalid.example/v1' })],
    ['saveProvider', providerPayload({ baseUrl: 'https://invalid.example/v1?secret=value' })],
    ['saveProvider', providerPayload({ apiFormat: 'arbitrary' })],
    ['saveProvider', providerPayload({ apiKey: 'key\r\nX-Injected: value' })],
    ['saveProvider', providerPayload({ apiKey: 17 })],
    ['updateModels', { providerId: 'cpa', changes: 'invalid' }],
    ['updateModels', { providerId: 'cpa', changes: [null] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', efforts: ['anything'] }] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', supportsImages: 'yes' }] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', maxOutputTokens: -1 }] }],
    ['updateModels', { providerId: 'cpa', changes: [{ id: 'lead', contextWindow: 1.5 }] }],
    ['addModel', { providerId: 'cpa', model: { id: '' } }],
    ['deleteProvider', { id: 'missing' }],
  ];
  for (const [type, payload] of invalid) {
    await assert.rejects(f.manager.dispatch(type, payload), PanelInputError, type);
    assert.deepEqual(f.read(), before, type);
  }
  assert.equal(f.writes.length, 0);
  await f.manager.dispatch('setEnabled', { enabled: false });
  assert.equal(f.manager.state().enabled, false);
  assert.equal(f.writes.length, 1);
});

test('manager serializes asynchronous refreshes before later edits to avoid lost updates', async () => {
  let release, started;
  const begin = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = memory({ discover: async provider => {
    started(); await gate; provider.models = [model('lead'), model('executor'), model('new-import')];
  } });
  const refresh = f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  await begin;
  const edit = f.manager.dispatch('updateModels', { providerId: 'cpa', changes: [{ id: 'lead', enabled: false }] });
  assert.equal(f.writes.length, 0);
  release(); await Promise.all([refresh, edit]);
  assert.equal(f.read().providers[0].models.find(m => m.id === 'lead').enabled, false);
  assert.equal(f.read().providers[0].models.some(m => m.id === 'new-import'), false);
  assert.deepEqual(f.changes, ['updateModels']);
  assert.equal(f.writes.length, 1);
});

test('import requires a current preview and rejects empty, duplicate, invented and cross-provider selections', async () => {
  const f = memory({ discover: async provider => { provider.models = [model('a'), model('b')]; } });
  const initial = f.read();
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: 'invented', ids: ['a'] }), PanelInputError);
  const { importCandidates: preview } = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  for (const ids of [[], ['a', 'a'], ['invented'], [null], 'a']) {
    await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids }), PanelInputError);
  }
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'other', token: preview.token, ids: ['a'] }), PanelInputError);
  assert.deepEqual(f.read(), initial);
  assert.equal(f.writes.length, 0);
  const second = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids: ['a'] }), PanelInputError);
  await f.manager.dispatch('importModels', { providerId: 'cpa', token: second.importCandidates.token, ids: ['b'] });
  assert.deepEqual(f.read().providers[0].models.map(m => m.id), ['lead', 'executor', 'b']);
});

for (const field of ['apiKey', 'baseUrl', 'apiFormat']) test(`import rejects a preview after provider ${field} changes`, async () => {
  const f = memory({ discover: async provider => { provider.models = [model('new')]; } });
  const { importCandidates: preview } = await f.manager.dispatch('refreshModels', { providerId: 'cpa' });
  f.externalChange(current => { current.providers[0][field] = field === 'apiFormat' ? 'openai' : 'changed'; });
  assert.equal(f.manager.state().importCandidates, null);
  await assert.rejects(f.manager.dispatch('importModels', { providerId: 'cpa', token: preview.token, ids: ['new'] }), PanelInputError);
  assert.equal(f.writes.length, 0);
});

test('native model hide and restore persist a validated exclusion list with observed status', async () => {
  const observed = [
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false },
    { uid: 'claude-x', label: 'Claude X', disabled: true },
  ];
  const f = memory({ nativeModels: () => observed });
  let state = await f.manager.dispatch('ready');
  assert.deepEqual(state.nativeModels, [
    { uid: 'swe-2-max', label: 'Official SWE', disabled: false, hidden: false, eligibleLead: false, eligibleSidekick: false, eligible: false },
    { uid: 'claude-x', label: 'Claude X', disabled: true, hidden: false, eligibleLead: false, eligibleSidekick: false, eligible: false },
  ]);
  state = await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  assert.deepEqual(f.read().hiddenNativeModelUids, ['swe-2-max']);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-2-max').hidden, true);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'claude-x').hidden, false);
  assert.deepEqual(f.changes, ['setNativeModelHidden']);
  state = await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: false });
  assert.deepEqual(f.read().hiddenNativeModelUids, []);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-2-max').hidden, false);
});

test('native visibility rejects unobserved, own and malformed uids and non-boolean flags without writes', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const f = memory({ nativeModels: () => observed });
  const before = f.read();
  for (const payload of [
    { uid: 'claude-x', hidden: true },
    { uid: 'dfbyok-cpa-lead-x', hidden: true },
    { uid: 'fusion-dfbyok-x', hidden: true },
    { uid: '', hidden: true },
    { uid: 42, hidden: true },
    { uid: 'x'.repeat(300), hidden: true },
    { uid: 'swe-2-max', hidden: 'yes' },
    { uid: 'swe-2-max', hidden: 1 },
    { uid: 'swe-2-max' },
  ]) {
    await assert.rejects(f.manager.dispatch('setNativeModelHidden', payload), PanelInputError, JSON.stringify(payload));
  }
  assert.deepEqual(f.read(), before);
  assert.equal(f.writes.length, 0);
});

test('previously hidden uids stay listed for restore and dedupe or drop invalid config entries', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const input = fixture();
  input.hiddenNativeModelUids = ['gone-native', 'gone-native', 42, 'dfbyok-own', '', 'gone-native-2'];
  const f = memory({ config: input, nativeModels: () => observed });
  const state = await f.manager.dispatch('ready');
  assert.deepEqual(state.nativeModels.filter(entry => entry.hidden).map(entry => entry.uid), ['gone-native', 'gone-native-2']);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'gone-native').label, 'gone-native');
  assert.ok(!state.nativeModels.some(entry => entry.uid === 'dfbyok-own'));
  const next = await f.manager.dispatch('setNativeModelHidden', { uid: 'gone-native', hidden: false });
  assert.deepEqual(f.read().hiddenNativeModelUids, ['gone-native-2']);
  assert.equal(next.nativeModels.find(entry => entry.uid === 'gone-native'), undefined);
  assert.equal(next.nativeModels.find(entry => entry.uid === 'gone-native-2').hidden, true);
});

test('hiding a native model never touches provider data', async () => {
  const observed = [{ uid: 'swe-2-max', label: 'SWE', disabled: false }];
  const f = memory({ nativeModels: () => observed });
  const before = f.read();
  await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: true });
  const next = f.read();
  assert.deepEqual(next.providers, before.providers);
  assert.deepEqual(next.sidekicks, before.sidekicks);
});

test('observed native Sidekick eligibility drives state flags, combinations and setSidekicks', async () => {
  const observed = [
    ...OBSERVED_SWE,
    { uid: 'swe-2-medium', label: 'Medium', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-medium', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 1, name: 'SWE-2 Medium' } },
    { uid: 'swe-disabled', label: 'Off', disabled: true, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'swe-router', label: 'Router', disabled: false, isModelRouter: true, harnessUids: ['swe-1p6'] },
    { uid: 'swe-naked', label: 'Naked', disabled: false },
    { uid: 'swe-other-harness', label: 'Other', disabled: false, isModelRouter: false, harnessUids: ['unknown-harness'] },
  ];
  const f = memory({ nativeModels: () => observed });
  const state = await f.manager.dispatch('ready');
  assert.deepEqual(state.nativeModels.filter(entry => entry.eligible).map(entry => entry.uid).sort(), ['swe-2-max', 'swe-2-medium', 'swe-other-harness']);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-naked').eligible, false);
  const catalog = assertValidGraph(f.read(), observed);
  assert.equal(Object.keys(catalog.fusions).length, 0);
  const created = await f.manager.dispatch('saveFusionPreset', { name: 'Medium', lead: { providerId: 'cpa', model: 'lead' }, sidekick: { nativeUid: 'swe-2-medium' } });
  assert.equal(created.fusionCount, 1);
  await f.manager.dispatch('setSidekicks', { sidekicks: [{ nativeUid: 'swe-2-medium' }] });
  assert.deepEqual(f.read().sidekicks, [{ nativeUid: 'swe-2-medium', label: 'SWE-2 Medium' }]);
  await f.manager.dispatch('setSidekicks', { sidekicks: [{ nativeUid: 'swe-other-harness' }] });
  assert.deepEqual(f.read().sidekicks, [{ nativeUid: 'swe-other-harness', label: 'Other' }]);
  for (const uid of ['swe-disabled', 'swe-router', 'swe-naked', 'swe-never-seen']) {
    await assert.rejects(f.manager.dispatch('setSidekicks', { sidekicks: [{ nativeUid: uid }] }), PanelInputError, uid);
  }
});

test('a hidden observed native is excluded from Sidekick eligibility and selection', async () => {
  const input = fixture();
  input.hiddenNativeModelUids = ['swe-2-max'];
  const f = memory({ config: input, nativeModels: () => OBSERVED_SWE });
  const state = await f.manager.dispatch('ready');
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-2-max').eligible, false);
  const catalog = buildCatalog(f.read(), OBSERVED_SWE);
  assert.equal(Object.values(catalog.fusions).filter(fusion => fusion.sidekickNative).length, 0);
  await assert.rejects(f.manager.dispatch('setSidekicks', { sidekicks: [{ nativeUid: 'swe-2-max' }] }), PanelInputError);
  await f.manager.dispatch('setNativeModelHidden', { uid: 'swe-2-max', hidden: false });
  const restored = await f.manager.dispatch('ready');
  assert.equal(restored.nativeModels.find(entry => entry.uid === 'swe-2-max').eligible, true);
});

test('cleanSidekicks drops malformed entries without throwing', () => {
  const input = fixture();
  input.sidekicks.push(null, 'swe-2-max', { providerId: 'ghost', model: 'gone' });
  cleanSidekicks(input);
  assert.ok(input.sidekicks.every(sidekick => sidekick && typeof sidekick === 'object'));
  assert.ok(!input.sidekicks.some(sidekick => sidekick.providerId === 'ghost'));
});

test('officially paired and standalone unlocked natives are offered and accepted', () => {
  const observed = [
    { uid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] },
    { uid: 'swe-odd', label: 'Odd', disabled: false, isModelRouter: false, harnessUids: ['odd-harness'] },
    { uid: 'fusion-official-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 4, name: 'GPT-5.6 Luna High' } },
  ];
  const f = memory({ nativeModels: () => observed });
  const state = publicState(fixture(), '', observed);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'gpt-5-6-luna-high').eligible, true);
  assert.equal(state.nativeModels.find(entry => entry.uid === 'swe-odd').eligible, true,
    'an unlocked standalone native is eligible for named presets');
  assert.ok(state.sidekicks.some(item => item.nativeUid === 'gpt-5-6-luna-high'));
  return f.manager.dispatch('setSidekicks', { sidekicks: [{ nativeUid: 'gpt-5-6-luna-high' }] }).then(async next => {
    assert.ok(next.sidekicks.some(item => item.nativeUid === 'gpt-5-6-luna-high'));
    await f.manager.dispatch('setSidekicks', { sidekicks: [{ nativeUid: 'swe-odd' }] });
    const disabled = observed.map(item => item.uid === 'swe-odd' ? { ...item, disabled: true } : item);
    assert.equal(publicState(fixture(), '', disabled).nativeModels.find(entry => entry.uid === 'swe-odd').eligible, false);
  });
});
