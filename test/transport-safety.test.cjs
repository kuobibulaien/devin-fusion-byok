'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { serveChat } = require('../src/protocol/responses.cjs');
const { discover } = require('../src/config.cjs');
const { forward, collect } = require('../src/runtime/bridge.cjs');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const secret = 'isolated-fixture-key';
const prompt = 'isolated-private-prompt';
const request = { modelUid: 'fixture', systemPrompt: 'fixture system', messages: [{ role: 'user', content: prompt }] };
const redirectStatuses = [301, 302, 303, 307, 308];

for (const apiFormat of ['anthropic', 'responses', 'chat']) {
  for (const status of redirectStatuses) {
    test(`${apiFormat} inference rejects HTTP ${status} without sending credentials or prompt to another origin`, async t => {
      const targetRequests = [], sourceRequests = [], results = [];
      const target = await listen(t, async (req, res) => {
        targetRequests.push({ headers: req.headers, body: (await collect(req)).toString() });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      });
      const source = await listen(t, async (req, res) => {
        sourceRequests.push({ headers: req.headers, body: (await collect(req)).toString() });
        res.writeHead(status, { location: `${target}/redirect-target` }); res.end();
      });
      const relay = await listen(t, (req, res) => {
        serveChat({ request, route: { model: 'fixture', uid: 'fixture' },
          provider: { baseUrl: source, apiKey: secret, apiFormat }, res,
          onMetrics: value => results.push(value) });
      });
      const response = await fetch(relay, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      assert.equal(sourceRequests.length, 1);
      assert.equal(sourceRequests[0].headers[apiFormat === 'anthropic' ? 'x-api-key' : 'authorization'],
        apiFormat === 'anthropic' ? secret : `Bearer ${secret}`);
      assert.ok(sourceRequests[0].body.includes(prompt));
      assert.deepEqual(targetRequests, []);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'error');
    });
  }
}

for (const apiFormat of ['anthropic', 'responses']) {
  for (const status of redirectStatuses) {
    test(`${apiFormat} discovery rejects HTTP ${status} without leaking credentials`, async t => {
      const targetRequests = [], sourceRequests = [];
      const target = await listen(t, async (req, res) => {
        targetRequests.push({ headers: req.headers, body: (await collect(req)).toString() });
        res.end(JSON.stringify({ data: [{ id: 'redirected-model' }] }));
      });
      const source = await listen(t, (req, res) => {
        sourceRequests.push(req.headers);
        res.writeHead(status, { location: `${target}/models` }); res.end();
      });
      const models = [{ id: 'original-model' }];
      const provider = { name: 'fixture', baseUrl: source, apiKey: secret, apiFormat, models };
      await assert.rejects(discover(provider));
      assert.equal(sourceRequests.length, 1);
      assert.equal(sourceRequests[0][apiFormat === 'anthropic' ? 'x-api-key' : 'authorization'],
        apiFormat === 'anthropic' ? secret : `Bearer ${secret}`);
      assert.deepEqual(targetRequests, []);
      assert.equal(provider.models, models);
    });
  }
}

test('forward closes a partially streamed response when upstream disconnects', async t => {
  const upstream = await listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100' });
    res.write('partial');
    setTimeout(() => res.destroy(), 30);
  });
  const relay = await listen(t, (req, res) => forward(req, res, new URL(upstream + req.url)));
  const response = await fetch(relay, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer(), error => {
    assert.notEqual(error.name, 'TimeoutError', 'downstream must close before the deadline');
    return true;
  });
});

test('forward returns 502 if upstream disconnects before sending headers', async t => {
  const upstream = await listen(t, (req, res) => res.destroy());
  const relay = await listen(t, (req, res) => forward(req, res, new URL(upstream + req.url)));
  const response = await fetch(relay, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '');
});

test('forward closes a truncated catalog without returning a partial catalog', async t => {
  const upstream = await listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{');
    setTimeout(() => res.destroy(), 30);
  });
  const relay = await listen(t, (req, res) => forward(req, res, new URL(upstream + req.url),
    { getCatalog: () => ({ models: [] }) }));
  const response = await fetch(`${relay}/exa.language_server_pb.LanguageServerService/GetCliModelConfigs`,
    { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '');
});

test('forward preserves the complete normal stream, headers and status', async t => {
  const upstream = await listen(t, (req, res) => {
    res.writeHead(201, { 'content-type': 'application/octet-stream', 'x-fixture': 'retained' });
    res.write('first');
    setTimeout(() => res.end('second'), 30);
  });
  const relay = await listen(t, (req, res) => forward(req, res, new URL(upstream + req.url)));
  const response = await fetch(relay, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-fixture'), 'retained');
  assert.equal(await response.text(), 'firstsecond');
});
