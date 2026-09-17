'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { createLsBridge, forward, collect } = require('../src/runtime/bridge.cjs');
const { buildCatalog } = require('../src/catalog.cjs');
const wire = require('../src/protocol/wire.cjs');
const LS = '/exa.language_server_pb.LanguageServerService/';
const catalog = buildCatalog({ providers: [{ id: 'test', name: 'Test', models: [{ id: 'test-model', label: 'Test model' }] }] });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
async function request(port, pathname, { body = Buffer.alloc(0), headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers }, async response => {
      try { resolve({ status: response.statusCode, headers: response.headers, body: await collect(response) }); }
      catch (error) { reject(error); }
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('LS bridge preserves native RPC bytes, query, CSRF, streaming response and cancellation headers', async t => {
  const payload = Buffer.from([0, 1, 0xff, 4]);
  const native = await listen(async (req, res) => {
    assert.equal(req.url, LS + 'Heartbeat?native=value');
    assert.equal(req.headers['x-codeium-csrf-token'], 'test-csrf');
    assert.deepEqual(await collect(req), payload);
    res.writeHead(200, { 'content-type': 'application/connect+proto', 'x-native-header': 'retained' });
    res.write(payload.subarray(0, 2)); res.end(payload.subarray(2));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'Heartbeat?native=value', {
    body: payload, headers: { 'x-codeium-csrf-token': 'test-csrf', 'content-type': 'application/connect+proto' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-native-header'], 'retained');
  assert.deepEqual(response.body, payload);
});

test('catalog augmentation decodes gzip and publishes headers matching the plain output', async t => {
  const original = { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(JSON.stringify(original)));
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.headers['transfer-encoding'], undefined);
  assert.equal(Number(response.headers['content-length']), response.body.length);
  const json = JSON.parse(response.body);
  assert.deepEqual(json.clientModelConfigs.slice(0, catalog.models.length).map(model => model.modelUid), catalog.models.map(model => model.uid));
  assert.equal(json.clientModelConfigs.at(-1).modelUid, 'official');
  assert.equal(json.clientModelConfigs.length, 1 + catalog.models.length);
});

test('compressed Connect catalog emits uncompressed frames without stale encoding headers', async t => {
  const input = { clientModelConfigs: [] };
  const encoded = wire.encode(input, { json: true, framed: true, compressed: true });
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/connect+json', 'connect-content-encoding': 'gzip' });
    res.end(encoded);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.headers['connect-content-encoding'], undefined);
  assert.equal(response.body[0], 0);
  assert.equal(wire.decode(response.body, response.headers).data.clientModelConfigs.length, catalog.models.length);
});

test('unrecognized service names and malformed catalogs retain upstream body and encoding', async t => {
  const encoded = zlib.gzipSync('{malformed-json');
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': encoded.length });
    res.end(encoded);
  });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  for (const pathname of ['/unrelated/GetCliModelConfigs', LS + 'GetCliModelConfigs']) {
    const response = await request(bridge.port, pathname);
    assert.deepEqual(response.body, encoded);
    assert.equal(response.headers['content-encoding'], 'gzip');
  }
});

test('buffered native forwards replace chunked framing with the actual content length', async t => {
  const native = await listen(async (req, res) => {
    assert.equal(req.headers['transfer-encoding'], undefined);
    assert.equal(req.headers['content-length'], '7');
    res.end(await collect(req));
  });
  t.after(() => native.close());
  const relay = await listen(async (req, res) => {
    const body = await collect(req);
    forward(req, res, new URL('http://127.0.0.1:' + native.port + req.url), { body });
  });
  t.after(() => relay.close());
  const response = await request(relay.port, '/native', { body: Buffer.from('replay!'), headers: { 'transfer-encoding': 'chunked' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'replay!');
});

test('LS bridge rejects absolute URLs and supports native origin preflight', async t => {
  let nativeRequests = 0;
  const native = await listen((req, res) => { nativeRequests++; res.end(); });
  t.after(() => native.close());
  const bridge = await createLsBridge(native.port, { getCatalog: () => catalog });
  t.after(() => bridge.close());
  assert.equal((await request(bridge.port, 'http://example.com/')).status, 400);
  assert.equal((await request(bridge.port, '//example.com/')).status, 400);
  const response = await request(bridge.port, LS + 'GetUserStatus', { method: 'OPTIONS', headers: {
    origin: 'vscode-file://vscode-app', 'access-control-request-headers': 'content-type,x-codeium-csrf-token',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'vscode-file://vscode-app');
  assert.equal(response.headers['access-control-allow-headers'], 'content-type,x-codeium-csrf-token');
  assert.equal(nativeRequests, 0);
});

test('catalog RPCs report sanitized native models to the observer and keep hidden entries filtered', async t => {
  const hiddenCatalog = { ...catalog, hiddenNativeModelUids: ['official-hidden'] };
  const original = { clientModelConfigs: [
    { modelUid: 'official-hidden', label: 'Hidden Official', disabled: true, accountUrl: 'https://secret.invalid' },
    { modelUid: 'official-shown', label: 'Shown Official' },
  ] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const reports = [];
  const bridge = await createLsBridge(native.port, { getCatalog: () => hiddenCatalog, onNativeModels: entries => reports.push(entries) });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  const json = JSON.parse(response.body);
  assert.deepEqual(json.clientModelConfigs.map(model => model.modelUid), [...catalog.models.map(model => model.uid), 'official-shown']);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], [
    { uid: 'official-hidden', label: 'Hidden Official', disabled: true, harnessUids: [], isModelRouter: false },
    { uid: 'official-shown', label: 'Shown Official', disabled: false, harnessUids: [], isModelRouter: false },
  ]);
  assert.ok(!JSON.stringify(reports).includes('secret.invalid'));
});

test('the first catalog response already combines a newly observed eligible native Sidekick', async t => {
  const observed = [];
  const original = { clientModelConfigs: [
    { modelUid: 'swe-2-medium', label: 'SWE-2 Medium', modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } },
    { modelUid: 'swe-locked', label: 'Locked', disabled: true, modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'fusion-lead-a-sidekick-swe-2-medium', label: 'F', modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [{ key: 'Sidekick', value: { order: 1, name: 'SWE-2 Medium' } }] } },
  ] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'lead', label: 'Lead' }] }],
    fusionPresets: ['swe-2-medium', 'gpt-5-6-luna-high'].map(uid => ({ id: uid, name: uid, lead: { providerId: 'test', model: 'lead' }, sidekick: { nativeUid: uid } })) };
  let observations = 0;
  const bridge = await createLsBridge(native.port, {
    getCatalog: () => buildCatalog(config, observed),
    onNativeModels: entries => { observations++; observed.push(...entries); },
  });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(observations, 1, 'one observation callback per catalog response');
  const expected = buildCatalog(config, observed).fusions;
  const combo = Object.values(expected).find(fusion => fusion.sidekickUid === 'swe-2-medium');
  assert.ok(combo);
  assert.deepEqual(combo.sidekickHarnessUids, ['swe-1p5']);
  const uids = JSON.parse(response.body).clientModelConfigs.map(model => model.modelUid);
  assert.ok(uids.includes(combo.uid), 'the same response already carries the new combination');
  assert.equal(uids.filter(uid => uid.startsWith('fusion-dfbyok-')).length, 1, 'only the saved preset with observed native capability is emitted');
});

test('the first catalog response binds official Sidekick dimensions and unlocks paired harnesses', async t => {
  const observed = [];
  const original = { clientModelConfigs: [
    { modelUid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking',
      modelInfo: { harnessUids: ['gpt-5p6'], isModelRouter: false } },
    { modelUid: 'fusion-claude-opus-5-max-sidekick-gpt-5-6-luna-high', label: 'Fusion (Claude Opus 5 Max + GPT-5.6 Luna High)',
      modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [{ key: 'Sidekick', value: { order: 4, name: 'GPT-5.6 Luna High', controlType: 3 } }] } },
  ] };
  const native = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(original));
  });
  t.after(() => native.close());
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'lead', label: 'Lead' }] }],
    fusionPresets: ['swe-2-medium', 'gpt-5-6-luna-high'].map(uid => ({ id: uid, name: uid, lead: { providerId: 'test', model: 'lead' }, sidekick: { nativeUid: uid } })) };
  const reports = [];
  const bridge = await createLsBridge(native.port, {
    getCatalog: () => buildCatalog(config, observed),
    onNativeModels: entries => { reports.push(entries); observed.push(...entries); },
  });
  t.after(() => bridge.close());
  const response = await request(bridge.port, LS + 'GetCliModelConfigs');
  assert.equal(response.status, 200);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].find(entry => entry.uid.startsWith('fusion-'))?.sidekickDimension, { order: 4, name: 'GPT-5.6 Luna High', fastModeOrder: 0 });
  const expected = buildCatalog(config, observed).fusions;
  const combo = Object.values(expected).find(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high');
  assert.ok(combo, 'the officially paired native is eligible with its declared harness');
  assert.deepEqual(combo.sidekickHarnessUids, ['gpt-5p6']);
  const emitted = JSON.parse(response.body).clientModelConfigs.find(model => model.modelUid === combo.uid);
  assert.ok(emitted, 'the same response already carries the bound combination');
  assert.deepEqual(emitted.modelFamilyMetadata.entries, []);
  assert.equal(emitted.label, 'gpt-5-6-luna-high');
  assert.match(emitted.modelInfo.modelFamilyUid, /^dfbyok-preset-family-/);
});
