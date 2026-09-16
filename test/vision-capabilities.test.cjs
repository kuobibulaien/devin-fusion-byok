'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelSupportsImages } = require('../src/model-capabilities.cjs');
const { buildCatalog, resolveAssignment } = require('../src/catalog.cjs');
const { publicState } = require('../src/panel/model.cjs');
const { parseChat } = require('../src/protocol/chat.cjs');
const { buildRequestBody } = require('../src/protocol/responses.cjs');
const { fields, num } = require('../src/protocol/wire.cjs');

test('all imported models always advertise image support, including stored overrides', () => {
  for (const id of ['gpt-6-astra', 'cpa/gpt-6-astra', 'gpt-5.6-sol', 'gpt-4o', 'gpt-4.1', 'swe-2-high', 'swe-2-max', 'swe-2-medium', 'ws-swe-2-max']) {
    assert.equal(modelSupportsImages({ id }), true, id);
    assert.equal(modelSupportsImages({ id, supportsImages: false }), true, id);
  }
  assert.equal(modelSupportsImages({ id: 'unknown-deployment' }), true);
  assert.equal(modelSupportsImages({ id: 'unknown-deployment', supportsImages: false }), true);
  assert.equal(modelSupportsImages({ id: 'unknown-deployment', supportsImages: true }), true);
});

test('plain models and every Fusion variant advertise images in both native protobuf and JSON', () => {
  const config = { providers: [{ id: 'load', models: [{ id: 'gpt-6-astra', efforts: [] }, { id: 'swe-2-high', efforts: [] }] }], sidekicks: [{ nativeUid: 'swe-2-max' }] };
  const catalog = buildCatalog(config, [{ uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6', 'swe-1p5'] }]);
  for (const model of catalog.models) {
    assert.equal(model.json.supportsImages, true);
    assert.equal(model.json.modelInfo.modelFeatures.supportsImages, true);
    assert.equal(num(model.raw, 5), 1);
    const info = fields(model.raw, 23)[0].value;
    assert.equal(num(fields(info, 6)[0].value, 11), 1);
  }
  assert.ok(publicState(config).providers[0].models.every(m => m.supportsImages));
  config.providers[0].models[0].supportsImages = false;
  const disabled = buildCatalog(config);
  for (const model of disabled.models.filter(m => m.kind === 'fusion' && disabled.routes[disabled.fusions[m.uid].leadUid].model === 'gpt-6-astra')) {
    assert.equal(model.json.supportsImages, true);
  }
  for (const model of disabled.models.filter(m => m.kind === 'model' && disabled.routes[m.uid].model === 'gpt-6-astra')) {
    assert.equal(model.json.supportsImages, true);
    assert.equal(num(model.raw, 5), 1);
  }
  assert.equal(publicState(config).providers[0].models[0].supportsImages, true);
  assert.equal(config.providers[0].models[0].supportsImages, false);
});

test('native JSON image blocks survive both Fusion assignments and both provider protocols', () => {
  const image = { base64Data: Buffer.from('image-fixture-bytes').toString('base64'), mimeType: 'image/png', caption: '' };
  const catalog = buildCatalog({ providers: [{ id: 'load', models: [{ id: 'gpt-6-astra' }, { id: 'swe-2-high' }] }], sidekicks: [] });
  const fusion = Object.values(catalog.fusions).find(f => catalog.routes[f.leadUid].model === 'gpt-6-astra' && catalog.routes[f.leadUid].effort === 'medium' && catalog.routes[f.sidekickUid].model === 'swe-2-high');
  for (const sidekick of [false, true]) {
    const uid = resolveAssignment({ modelRouterUid: fusion.uid, ...(sidekick ? { fusionLeadRouterUid: fusion.uid } : {}) }, { json: true }, catalog).assignment.modelUid;
    const request = parseChat({ modelUid: uid, messages: [{ role: 'user', content: 'Read the image', images: [image] }] });
    for (const apiFormat of ['openai-responses', 'openai']) {
      const body = buildRequestBody(request, catalog.routes[uid], { apiFormat });
      const messages = body.input || body.messages;
      const block = messages.find(m => m.role === 'user').content.find(c => /image/.test(c.type));
      assert.equal(apiFormat === 'openai' ? block.image_url.url : block.image_url, 'data:image/png;base64,' + image.base64Data);
      assert.equal(body.model, sidekick ? 'swe-2-high' : 'gpt-6-astra');
    }
  }
});
