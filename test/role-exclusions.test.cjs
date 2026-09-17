'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildCatalog: buildSavedCatalog, buildRoleLists, refKey, augmentCatalog, resolveAssignment } = require('../src/catalog.cjs');
const { withPresets } = require('./fixtures/presets.cjs');
const buildCatalog = (config, natives = []) => buildSavedCatalog(withPresets(config, natives), natives);
const { createManager } = require('../src/panel/model.cjs');

const fixture = JSON.parse(fs.readFileSync('test/fixtures/real-picker-0.3.11.json', 'utf8'));

function buildObservedFromFixture() {
  const models = [];
  for (const n of fixture.natives) {
    models.push({
      uid: n.uid,
      label: n.label,
      disabled: n.disabled === 1,
      isModelRouter: n.router === 1,
      harnessUids: n.harnesses || [],
      ...(n.family ? {
        fusionMetadata: n.family.map(f => ({ key: f.key, order: f.order, name: f.name, controlType: f.controlType ?? 0 }))
      } : {}),
      maxTokens: 272000,
      maxOutputTokens: 16384,
      supportsImages: false,
    });
  }
  for (const f of fixture.fusions) {
    const sidekickDim = f.family?.find(d => d.key === 'Sidekick');
    const fastModeDim = f.family?.find(d => d.key === 'Fast Mode');
    models.push({
      uid: f.uid,
      label: f.uid,
      disabled: f.disabled === 1,
      isModelRouter: f.router === 1,
      harnessUids: f.harnesses || [],
      fusionMetadata: (f.family || []).map(dim => ({
        key: dim.key,
        order: dim.order,
        name: dim.name,
        controlType: dim.controlType ?? 0,
      })),
      sidekickDimension: sidekickDim ? {
        order: sidekickDim.order,
        name: sidekickDim.name,
        fastModeOrder: fastModeDim ? fastModeDim.order : 0,
      } : undefined,
    });
  }
  return models;
}

test('role lists default: all imported enabled and official eligible unlocked models are available & selected', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, models: [{ id: 'gpt-4o', label: 'GPT-4o', enabled: true }] }
    ],
    roleExclusions: { lead: [], sidekick: [] },
  };
  const observed = buildObservedFromFixture();
  const roles = buildRoleLists(config, observed);

  const leadImported = roles.lead.find(r => r.ref.providerId === 'p1' && r.ref.model === 'gpt-4o');
  assert.ok(leadImported);
  assert.equal(leadImported.selected, true);
  assert.equal(leadImported.available, true);
  assert.equal(leadImported.native, false);

  const leadNative = roles.lead.find(r => r.ref.nativeUid === 'claude-fable-5-1-medium');
  assert.ok(leadNative);
  assert.equal(leadNative.selected, true);
  assert.equal(leadNative.available, true);
  assert.equal(leadNative.native, true);

  const sidekickImported = roles.sidekick.find(r => r.ref.providerId === 'p1' && r.ref.model === 'gpt-4o');
  assert.ok(sidekickImported);
  assert.equal(sidekickImported.selected, true);

  const sidekickNative = roles.sidekick.find(r => r.ref.nativeUid === 'swe-2-medium');
  assert.ok(sidekickNative);
  assert.equal(sidekickNative.selected, true);
});

test('lead-only exclusion leaves sidekick available, and vice versa', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, models: [{ id: 'gpt-4o', label: 'GPT-4o', enabled: true }] }
    ],
    roleExclusions: {
      lead: [{ providerId: 'p1', model: 'gpt-4o' }],
      sidekick: [{ nativeUid: 'swe-2-medium' }],
    },
  };
  const observed = buildObservedFromFixture();
  const roles = buildRoleLists(config, observed);

  const gptLead = roles.lead.find(r => r.ref.providerId === 'p1' && r.ref.model === 'gpt-4o');
  assert.equal(gptLead.selected, false);
  assert.equal(gptLead.available, true);

  const gptSidekick = roles.sidekick.find(r => r.ref.providerId === 'p1' && r.ref.model === 'gpt-4o');
  assert.equal(gptSidekick.selected, true);

  const sweSidekick = roles.sidekick.find(r => r.ref.nativeUid === 'swe-2-medium');
  assert.equal(sweSidekick.selected, false);
  assert.equal(sweSidekick.available, true);
});

test('lead exclusion retains sidekick combinations with other leads', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, models: [
        { id: 'lead-a', label: 'Lead A', enabled: true },
        { id: 'lead-b', label: 'Lead B', enabled: true },
      ] }
    ],
    roleExclusions: {
      lead: [{ providerId: 'p1', model: 'lead-a' }],
      sidekick: [],
    },
  };
  const observed = buildObservedFromFixture();
  const catalog = buildCatalog(config, observed);

  const sidekickACombinations = Object.values(catalog.fusions).filter(f =>
    f.sidekickUid === 'dfbyok-p1-lead-a-9a99859f518e8785' ||
    catalog.routes[f.sidekickUid]?.model === 'lead-a'
  );
  assert.ok(sidekickACombinations.length > 0);
  assert.ok(sidekickACombinations.some(f => catalog.routes[f.leadUid]?.model === 'lead-b' || f.leadNative));

  const leadACombinations = Object.values(catalog.fusions).filter(f =>
    catalog.routes[f.leadUid]?.model === 'lead-a'
  );
  assert.equal(leadACombinations.length, 0);
});

test('all imported leads excluded but nativeLead selected still allows imported sidekicks', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, models: [{ id: 'm1', label: 'M1', enabled: true }] }
    ],
    roleExclusions: {
      lead: [{ providerId: 'p1', model: 'm1' }],
      sidekick: [],
    },
  };
  const observed = buildObservedFromFixture();
  const catalog = buildCatalog(config, observed);

  const nativeLeadFusion = Object.values(catalog.fusions).find(f => f.leadNative === true);
  assert.ok(nativeLeadFusion);
  assert.equal(catalog.routes[nativeLeadFusion.sidekickUid]?.model, 'm1');
});

test('empty roles generate no own fusions', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, models: [{ id: 'gpt-4o', label: 'GPT-4o', enabled: true }] }
    ],
    roleExclusions: {
      lead: [
        { providerId: 'p1', model: 'gpt-4o' },
        { nativeUid: 'claude-fable-5-1-medium' },
        { nativeUid: 'claude-fable-5-1-high' },
        { nativeUid: 'gpt-5-6-sol-high' },
      ],
      sidekick: [],
    },
  };
  const observed = buildObservedFromFixture();
  const catalog = buildCatalog(config, observed);
  assert.equal(Object.keys(catalog.fusions).length, 0);
});

test('exclusions survive temporary unavailability and restart', () => {
  const config = {
    providers: [],
    roleExclusions: {
      lead: [{ providerId: 'p-ghost', model: 'ghost-model' }],
      sidekick: [{ nativeUid: 'offline-native' }],
    },
  };
  const roles = buildRoleLists(config, []);
  const ghostLead = roles.lead.find(r => r.ref.providerId === 'p-ghost');
  assert.ok(ghostLead);
  assert.equal(ghostLead.available, false);
  assert.equal(ghostLead.disabled, true);
  assert.equal(ghostLead.selected, false);

  const ghostSide = roles.sidekick.find(r => r.ref.nativeUid === 'offline-native');
  assert.ok(ghostSide);
  assert.equal(ghostSide.available, false);
  assert.equal(ghostSide.disabled, true);
});

test('manager setRoleModel validates role, rejects malformed/mixed refs, and updates exclusions', async () => {
  let savedConfig = {
    enabled: true,
    providers: [
      { id: 'p1', name: 'P1', enabled: true, baseUrl: 'https://p1.test', apiKey: 'k', apiFormat: 'openai', models: [{ id: 'm1', label: 'M1', enabled: true }] }
    ],
    roleExclusions: { lead: [], sidekick: [] },
  };
  const observed = buildObservedFromFixture();
  const manager = createManager({
    read: () => savedConfig,
    write: c => { savedConfig = c; },
    nativeModels: () => observed,
  });

  await assert.rejects(() => manager.dispatch('setRoleModel', { role: 'invalid', model: { nativeUid: 'claude-fable-5-1-medium' }, enabled: false }), /角色类型/);
  await assert.rejects(() => manager.dispatch('setRoleModel', { role: 'lead', model: { nativeUid: 'a', providerId: 'b', model: 'c' }, enabled: false }), /模型身份/);

  await manager.dispatch('setRoleModel', { role: 'lead', model: { nativeUid: 'claude-fable-5-1-medium' }, enabled: false });
  assert.ok(savedConfig.roleExclusions.lead.some(r => r.nativeUid === 'claude-fable-5-1-medium'));

  await assert.rejects(() => manager.dispatch('setRoleModel', { role: 'lead', model: { nativeUid: 'unobserved-native' }, enabled: true }), /无法添加/);

  await manager.dispatch('setRoleModel', { role: 'lead', model: { nativeUid: 'claude-fable-5-1-medium' }, enabled: true });
  assert.ok(!savedConfig.roleExclusions.lead.some(r => r.nativeUid === 'claude-fable-5-1-medium'));
});

test('nativeLead + BYOK sidekick assignment executes exact UID and declared lead harness', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, baseUrl: 'https://p1.test', apiKey: 'k', apiFormat: 'openai', models: [{ id: 'm1', label: 'M1', enabled: true }] }
    ],
    roleExclusions: { lead: [], sidekick: [] },
  };
  const observed = buildObservedFromFixture();
  const catalog = buildCatalog(config, observed);

  const nativeLeadFusion = Object.values(catalog.fusions).find(f => f.leadNative === true);
  assert.ok(nativeLeadFusion);
  assert.equal(nativeLeadFusion.leadUid, 'claude-fable-5-1-medium');
  assert.deepEqual(nativeLeadFusion.leadHarnessUids, ['fusion', 'strawberry-pancake']);

  const leadReq = { modelRouterUid: nativeLeadFusion.uid };
  const leadResolved = resolveAssignment(leadReq, { json: true }, catalog);
  assert.ok(leadResolved);
  assert.equal(leadResolved.assignment.modelUid, 'claude-fable-5-1-medium');
  assert.deepEqual(leadResolved.assignment.harnessUids, ['fusion', 'strawberry-pancake']);

  const sideReq = { fusionLeadRouterUid: nativeLeadFusion.uid };
  const sideResolved = resolveAssignment(sideReq, { json: true }, catalog);
  assert.ok(sideResolved);
  assert.equal(sideResolved.assignment.modelUid, nativeLeadFusion.sidekickUid);
  assert.deepEqual(sideResolved.assignment.harnessUids, ['swe-1p6', 'swe-1p5']);
});

test('official catalog filters disabled official combos and combos whose lead/sidekick was excluded', () => {
  const config = {
    enabled: true,
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, baseUrl: 'https://p1.test', apiKey: 'k', apiFormat: 'openai', models: [{ id: 'm1', label: 'M1', enabled: true }] }
    ],
    roleExclusions: {
      lead: [{ nativeUid: 'claude-fable-5-1-medium' }],
      sidekick: [],
    },
  };
  const observed = buildObservedFromFixture();
  observed.push({
    uid: 'fusion-test-disabled-sidekick-swe-2-medium',
    disabled: true,
    isModelRouter: true,
    harnessUids: ['fusion'],
  });
  const catalog = buildCatalog(config, observed);
  assert.ok(catalog.hiddenFusionUids.includes('fusion-test-disabled-sidekick-swe-2-medium'));
  assert.ok(catalog.hiddenFusionUids.includes('fusion-claude-fable-5-1-medium-sidekick-swe-2-medium'));

  const jsonCatalog = {
    clientModelConfigs: [
      { modelUid: 'fusion-claude-fable-5-1-medium-sidekick-swe-2-medium', label: 'Claude Fusion' },
      { modelUid: 'claude-fable-5-1-medium', label: 'Claude Fable 5.1 Medium' },
    ],
    clientModelSorts: [],
  };
  const augmented = augmentCatalog(jsonCatalog, {
    rpc: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
    format: { json: true },
    catalog,
  });
  const uids = augmented.clientModelConfigs.map(m => m.modelUid);
  assert.ok(!uids.includes('fusion-claude-fable-5-1-medium-sidekick-swe-2-medium'));
  assert.ok(uids.includes('claude-fable-5-1-medium'));
});

test('team allowlist for nativeLead requires native.has(leadUid)', () => {
  const config = {
    providers: [
      { id: 'p1', name: 'OpenAI', enabled: true, baseUrl: 'https://p1.test', apiKey: 'k', apiFormat: 'openai', models: [{ id: 'm1', label: 'M1', enabled: true }] }
    ],
  };
  const observed = buildObservedFromFixture();
  const catalog = buildCatalog(config, observed);
  const nativeLeadFusion = Object.values(catalog.fusions).find(f => f.leadNative === true);
  assert.ok(nativeLeadFusion);

  const teamSettingsJson = { allowedModelUids: ['other-native-uid'] };
  const res1 = augmentCatalog(teamSettingsJson, {
    rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings',
    format: { json: true },
    catalog,
  });
  assert.ok(!res1.allowedModelUids.includes(nativeLeadFusion.uid));

  const teamSettingsJson2 = { allowedModelUids: [nativeLeadFusion.leadUid] };
  const res2 = augmentCatalog(teamSettingsJson2, {
    rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings',
    format: { json: true },
    catalog,
  });
  assert.ok(res2.allowedModelUids.includes(nativeLeadFusion.uid));
});

test('nativeLead and official fusion exclusion filters fast mode variants and preserves plain native', () => {
  const config = {
    enabled: true,
    providers: [],
    roleExclusions: {
      lead: [{ nativeUid: 'claude-fable-5-1-medium' }],
      sidekick: [{ nativeUid: 'gpt-5-6-sol-high' }],
    },
  };
  const observed = buildObservedFromFixture();
  const catalog = buildCatalog(config, observed);

  assert.ok(catalog.hiddenFusionUids.includes('fusion-claude-fable-5-1-medium-sidekick-swe-2-medium'));
  assert.ok(catalog.hiddenFusionUids.includes('fusion-claude-fable-5-1-medium-fast-sidekick-gpt-5-6-luna-high-priority'));
  assert.ok(catalog.hiddenFusionUids.includes('fusion-claude-fable-5-1-medium-fast-sidekick-gpt-5-6-sol-high-priority'));

  assert.ok(!catalog.hiddenFusionUids.includes('fusion-claude-fable-5-1-high-sidekick-swe-2-medium'));

  const jsonCatalog = {
    clientModelConfigs: [
      { modelUid: 'fusion-claude-fable-5-1-medium-fast-sidekick-gpt-5-6-luna-high-priority', label: 'Claude Fast' },
      { modelUid: 'claude-fable-5-1-medium', label: 'Claude Fable 5.1 Medium' },
    ],
    clientModelSorts: [],
  };
  const augmented = augmentCatalog(jsonCatalog, {
    rpc: '/exa.language_server_pb.LanguageServerService/GetCliModelConfigs',
    format: { json: true },
    catalog,
  });
  const uids = augmented.clientModelConfigs.map(m => m.modelUid);
  assert.ok(!uids.includes('fusion-claude-fable-5-1-medium-fast-sidekick-gpt-5-6-luna-high-priority'));
  assert.ok(uids.includes('claude-fable-5-1-medium'));
});
