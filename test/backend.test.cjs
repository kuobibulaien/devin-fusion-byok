'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const actualBackend = require('../src/runtime/backend.cjs');
const { collect } = require('../src/runtime/bridge.cjs');
const { buildCatalog, augmentCatalog } = require('../src/catalog.cjs');
const wire = require('../src/protocol/wire.cjs');
const http = require('node:http');
const API = '/exa.api_server_pb.ApiServerService/';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-test-'));
  const config = { providers: [{ id: 'test', name: 'Test', models: [{ id: 'model', label: 'Model' }] }], sidekicks: [{ nativeUid: 'swe-2-max', label: 'SWE-2 Max' }],
    fusionPresets: ['swe-2-max', 'gpt-5-6-luna-high', 'swe-odd'].map(uid => ({ id: uid, name: uid, lead: { providerId: 'test', model: 'model', effort: null }, sidekick: { nativeUid: uid } })) };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const forwarded = [], chats = [], logs = [];
  const held = new Map();
  let hold = false;
  let natives = null;
  const filename = path.resolve(__dirname, '../src/runtime/backend.cjs');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === './bridge.cjs') return {
        collect,
        async forward(req, res, target, options) {
          const body = options.body ?? await collect(req);
          forwarded.push({ target: target.href, body });
          if (natives && /ModelConfigs|GetUserStatus/.test(req.url)) options.onNativeModels?.(natives);
          if (hold) held.set(req.url, res);
          else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('official'); }
        },
      };
      if (name === '../protocol/responses.cjs') return { serveChat: async ({ route, res }) => { chats.push(route); res.end('custom'); } };
      return realRequire(name);
    },
  }, { filename });
  const backend = await module.exports.startBackend({ root, port: 0, log: (...event) => logs.push(event) });
  const base = 'http://127.0.0.1:' + backend.port;
  t.after(async () => {
    for (const res of held.values()) res.end();
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const health = () => fetch(base + '/health').then(r => r.json());
  const control = () => JSON.parse(fs.readFileSync(actualBackend.controlFile(root), 'utf8'));
  const shutdown = (token = control().token) => fetch(base + '/_runtime/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
  return { root, config, backend, base, health, control, shutdown, forwarded, chats, logs, held,
    setHold: value => { hold = value; }, setNatives: value => { natives = value; } };
}

test('runtime health exposes ownership and source identity without exposing its private control token', async t => {
  const f = await fixture(t);
  const health = await f.health();
  const control = f.control();
  assert.equal(health.service, 'devin-fusion-byok');
  assert.equal(health.rootId, actualBackend.runtimeIdentity(f.root).rootId);
  assert.match(health.sourceId, /^[a-f0-9]{64}$/);
  assert.equal(health.managementProtocol, 1);
  assert.equal(health.activeRequests, 0);
  assert.equal(health.instanceId, control.instanceId);
  assert.match(control.token, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(health).includes(control.token));
  assert.ok(!JSON.stringify(f.logs).includes(control.token));
  assert.equal(fs.statSync(actualBackend.controlFile(f.root)).mode & 0o777, 0o600);
  assert.equal((await f.shutdown('wrong-token')).status, 403);
  assert.equal((await f.health()).draining, false);
});

test('safe shutdown refuses active RPCs and stops only after the complete response', async t => {
  const f = await fixture(t);
  f.setHold(true);
  const rpc = '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings';
  const inflight = fetch(f.base + rpc, { method: 'POST', body: 'native' });
  while (!f.held.has(rpc)) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.health()).activeRequests, 1);
  assert.equal((await f.shutdown()).status, 409);
  assert.equal((await f.health()).draining, false);
  f.held.get(rpc).end('completed'); f.held.delete(rpc);
  assert.equal(await (await inflight).text(), 'completed');
  assert.equal((await f.health()).activeRequests, 0);
  assert.equal((await f.shutdown()).status, 200);
  await f.backend.stopped;
  assert.equal(fs.existsSync(actualBackend.controlFile(f.root)), false);
});

test('public-origin control calls cannot stop the daemon even with a valid token', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/_runtime/shutdown', { method: 'POST', headers: {
    origin: 'https://example.com', authorization: 'Bearer ' + f.control().token,
  } });
  assert.equal(response.status, 403);
  assert.equal((await f.health()).draining, false);
});

test('a second startup on the same port cannot overwrite the running runtime control file', async t => {
  const f = await fixture(t);
  const previous = fs.readFileSync(actualBackend.controlFile(f.root), 'utf8');
  await assert.rejects(actualBackend.startBackend({ root: f.root, port: f.backend.port }), { code: 'EADDRINUSE' });
  assert.equal(fs.readFileSync(actualBackend.controlFile(f.root), 'utf8'), previous);
});

test('native model requests, unknown model IDs and wrong RPC services never select a custom provider', async t => {
  const f = await fixture(t);
  for (const [rpc, modelUid] of [[API + 'GetChatMessage?keep=1', 'swe-2-max'], [API + 'GetChatMessage', '__proto__'], ['/exa.other_pb.OtherService/GetChatMessage', Object.keys(buildCatalog(f.config).routes)[0]]]) {
    const body = JSON.stringify({ modelUid, messages: [] });
    const response = await fetch(f.base + rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(await response.text(), 'official');
    assert.equal(f.forwarded.at(-1).body.toString(), body);
    assert.equal(f.forwarded.at(-1).target, 'https://server.codeium.com' + rpc);
  }
  assert.deepEqual(f.chats, []);
});

test('disabled configuration forwards even an otherwise valid custom model to the native backend', async t => {
  const f = await fixture(t);
  const modelUid = Object.keys(buildCatalog(f.config).routes)[0];
  f.config.enabled = false;
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify(f.config));
  const response = await fetch(f.base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelUid }) });
  assert.equal(await response.text(), 'official');
  assert.deepEqual(f.chats, []);
});

test('known custom model requests use their exact provider route', async t => {
  const f = await fixture(t);
  const modelUid = Object.keys(buildCatalog(f.config).routes)[0];
  const response = await fetch(f.base + API + 'GetChatMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelUid }) });
  assert.equal(await response.text(), 'custom');
  assert.equal(f.chats.length, 1);
  assert.equal(f.chats[0].uid, modelUid);
  assert.deepEqual(f.forwarded, []);
});

test('an own plain model is listed, allowed and callable standalone against a third-party endpoint', async t => {
  const calls = [];
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"standalone-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const provider = http.createServer(async (req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse((await collect(req)).toString()) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-backend-standalone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { providers: [{ id: 'third', name: 'Third', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    apiFormat: 'openai', apiKey: 'fixture-provider-key', models: [{ id: 'standalone-model', label: 'Standalone' }] }],
    sidekicks: [{ providerId: 'third', model: 'standalone-model' }] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const backend = await actualBackend.startBackend({ root, port: 0 });
  t.after(() => backend.close());
  const catalog = buildCatalog(config);
  const own = Object.keys(catalog.routes)[0];
  assert.match(own, /^dfbyok-/);
  const proto = { json: false, type: 'application/proto', framed: false };
  const allowed = augmentCatalog(wire.s(7, 'native-gpt'), { rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings', format: proto, catalog });
  const uids = wire.parseFields(allowed).filter(field => field.number === 7).map(field => field.value.toString());
  assert.equal(uids[0], 'native-gpt');
  assert.ok(uids.includes(own));
  assert.equal(Object.keys(catalog.fusions).length, 0);
  const lockedNative = Buffer.concat([wire.s(1, 'Fusion (Locked)'), wire.s(22, 'fusion-official-locked'), wire.v(4, 1)]);
  const listed = augmentCatalog(wire.m(1, lockedNative), { rpc: API + 'GetCliModelConfigs', format: proto, catalog });
  const entries = wire.parseFields(listed).filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  assert.equal(wire.str(entries[0], 22), own);
  assert.equal(wire.str(entries.at(-1), 22), 'fusion-official-locked');
  assert.equal(wire.num(entries.at(-1), 4), 1);
  const response = await fetch('http://127.0.0.1:' + backend.port + API + 'GetChatMessage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelUid: own, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('standalone-ok'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].body.model, 'standalone-model');
  assert.equal(calls[0].authorization, 'Bearer fixture-provider-key');
});

test('a catalog observation enables AssignModel with the native Sidekick exact harness intersection', async t => {
  const f = await fixture(t);
  const observed = [
    { uid: 'swe-2-max', label: 'SWE-2 Max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p5', 'other-harness'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
  ];
  const fusion = Object.values(buildCatalog(f.config, observed).fusions).find(fusion => fusion.sidekickUid === 'swe-2-max');
  assert.ok(fusion, 'fixture config saves swe-2-max as a native Sidekick preference');
  const before = JSON.stringify({ modelRouterUid: fusion.uid, fusionLeadRouterUid: fusion.uid });
  const cold = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: before });
  assert.equal(await cold.text(), 'official', 'before any catalog observation the combination fails closed');
  f.setNatives(observed);
  const catalogResponse = await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'native' });
  assert.equal(await catalogResponse.text(), 'official');
  const resolved = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: before });
  const data = JSON.parse(await resolved.text());
  assert.equal(data.assignment.modelUid, 'swe-2-max');
  assert.deepEqual(data.assignment.harnessUids, ['swe-1p5', 'other-harness']);
});

test('a saved native Sidekick preference alone never grants capability without observation', async t => {
  const f = await fixture(t);
  const fusionUid = Object.values(buildCatalog(f.config, [
    { uid: 'swe-2-max', disabled: false, isModelRouter: false, harnessUids: ['swe-1p6'] },
    { uid: 'fusion-lead-a-sidekick-swe-2-max', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'], sidekickDimension: { order: 3, name: 'SWE-2 Max' } },
  ]).fusions)
    .find(fusion => fusion.sidekickUid === 'swe-2-max').uid;
  const response = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRouterUid: fusionUid, fusionLeadRouterUid: fusionUid }) });
  assert.equal(await response.text(), 'official');
  assert.equal(f.forwarded.at(-1).target, 'https://server.codeium.com' + API + 'AssignModel');
});

test('an officially paired native Sidekick assigns its declared harness, an unpaired one stays closed', async t => {
  const f = await fixture(t);
  const observed = [
    { uid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking', disabled: false, isModelRouter: false, harnessUids: ['gpt-5p6'] },
    { uid: 'swe-odd', label: 'Odd', disabled: false, isModelRouter: false, harnessUids: ['odd-harness'] },
    { uid: 'fusion-official-sidekick-gpt-5-6-luna-high', label: 'F', disabled: false, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 4, name: 'GPT-5.6 Luna High' } },
    { uid: 'fusion-official-sidekick-swe-odd', label: 'F', disabled: true, isModelRouter: true, harnessUids: ['fusion'],
      sidekickDimension: { order: 9, name: 'Odd' } },
  ];
  const built = buildCatalog(f.config, observed);
  const luna = Object.values(built.fusions).find(fusion => fusion.sidekickUid === 'gpt-5-6-luna-high');
  assert.ok(luna, 'enabled official pairing makes the unfamiliar-harness native eligible');
  assert.equal(Object.values(built.fusions).find(fusion => fusion.sidekickUid === 'swe-odd'), undefined,
    'a disabled pairing leaves an unfamiliar-harness native ineligible');
  f.setNatives(observed);
  await fetch(f.base + API + 'GetCliModelConfigs', { method: 'POST', body: 'native' });
  const resolved = await fetch(f.base + API + 'AssignModel', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelRouterUid: luna.uid, fusionLeadRouterUid: luna.uid }) });
  const data = JSON.parse(await resolved.text());
  assert.equal(data.assignment.modelUid, 'gpt-5-6-luna-high');
  assert.deepEqual(data.assignment.harnessUids, ['gpt-5p6'], 'the declared official harness is forwarded exactly');
});
