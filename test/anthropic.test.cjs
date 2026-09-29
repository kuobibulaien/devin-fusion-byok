'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { s, v, m, str, fields } = require('../src/protocol/wire.cjs');
const { parseChat } = require('../src/protocol/chat.cjs');
const { serveChat, buildRequestBody } = require('../src/protocol/responses.cjs');
const { modelEfforts } = require('../src/model-capabilities.cjs');

const nativeMessage = (source, text, extra = []) => m(3, Buffer.concat([v(2, source), s(3, text), ...extra]));
function nativeRequest() {
  return Buffer.concat([
    s(2, 'System prompt'), s(21, 'local-claude'), v(6, 9901),
    nativeMessage(1, 'User message', [m(10, Buffer.concat([s(1, 'aGVsbG8='), s(2, 'image/png'), s(3, 'Image caption')]))]),
    nativeMessage(2, 'Assistant before tool', [m(6, Buffer.concat([s(1, 'call_a'), s(2, 'shell_command'), s(3, '{"cmd":"ls"}')])),
      m(6, Buffer.concat([s(1, 'call_b'), s(2, 'shell_command'), s(3, '{"cmd":"pwd"}')]))]),
    nativeMessage(4, 'first result', [s(7, 'call_a')]),
    nativeMessage(4, 'second result', [s(7, 'call_b'), v(9, 1)]),
    nativeMessage(5, 'System message in the middle'),
    nativeMessage(1, 'User after tool'),
    m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run a command'), s(3, '{"type":"object","properties":{"cmd":{"type":"string"}}}')])),
    m(12, Buffer.concat([s(1, 'tool'), s(2, 'shell_command')])),
  ]);
}

function unpack(buffer) {
  const messages = [];
  for (let offset = 0; offset < buffer.length;) {
    const flags = buffer[offset], length = buffer.readUInt32BE(offset + 1);
    if (!(flags & 2)) messages.push(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  return messages;
}

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function run(t, events, route = { model: 'claude-opus-5-5', uid: 'local-claude', effort: 'high' }) {
  const requests = [], metrics = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(event);
    res.end();
  }, t);
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route, provider: { baseUrl: `${upstream}/v1`, apiKey: 'fake-anthropic-key', apiFormat: 'anthropic' }, res, onMetrics: value => metrics.push(value) });
  }, t);
  const response = await fetch(proxy);
  return { messages: unpack(Buffer.from(await response.arrayBuffer())), requests, metrics };
}

test('Anthropic request body maps system, images, tool calls, merged tool results and tool choice', () => {
  const body = buildRequestBody(parseChat(nativeRequest()), { model: 'claude-opus-5-5', effort: 'xhigh', maxOutputTokens: 131072 }, { apiFormat: 'anthropic' });
  assert.equal(body.system, 'System prompt');
  assert.equal(body.max_tokens, 128000);
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  assert.deepEqual(body.messages[1].content.slice(1), [
    { type: 'tool_use', id: 'call_a', name: 'shell_command', input: { cmd: 'ls' } },
    { type: 'tool_use', id: 'call_b', name: 'shell_command', input: { cmd: 'pwd' } }]);
  const next = body.messages[2].content;
  assert.deepEqual(next.slice(0, 2), [
    { type: 'tool_result', tool_use_id: 'call_a', content: 'first result' },
    { type: 'tool_result', tool_use_id: 'call_b', content: 'second result', is_error: true }]);
  assert.deepEqual(next.slice(2).map(block => block.text), ['System message in the middle', 'User after tool']);
  assert.deepEqual(body.tools, [{ name: 'shell_command', description: 'Run a command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }]);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.equal(body.temperature, undefined);
});

test('Anthropic stream relays text, thinking and usage with x-api-key auth', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
    sse('ping', {}),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Considering' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello ' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'world' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    sse('message_stop', {}),
  ]);
  const request = result.requests[0];
  assert.equal(request.url, '/v1/messages');
  assert.equal(request.headers['x-api-key'], 'fake-anthropic-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Hello world');
  assert.equal(result.metrics[0].status, 'success');
  assert.equal(result.metrics[0].inputTokens, 100);
  assert.equal(result.metrics[0].cachedTokens, 90);
  assert.equal(result.metrics[0].outputTokens, 7);
  assert.equal(result.metrics[0].hasReasoning, true);
});

test('Anthropic stream assembles streamed and empty tool inputs in block order', async t => {
  const result = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell_command', input: {} } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'list_files', input: {} } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
    sse('message_stop', {}),
  ]);
  const tools = result.messages.flatMap(message => fields(message, 6)).map(field => [str(field.value, 1), str(field.value, 2), str(field.value, 3)]);
  assert.deepEqual(tools, [['toolu_1', 'shell_command', '{"cmd":"ls"}'], ['toolu_2', 'list_files', '{}']]);
  assert.equal(result.metrics[0].hasTools, true);
});

test('Anthropic stream errors and truncation surface as failures', async t => {
  const failed = await run(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
  ]);
  assert.equal(failed.metrics[0].status, 'error');
  assert.equal(failed.metrics[0].code, 'upstream_stream_error');
  const truncated = await run(t, [sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: 'partial' } })]);
  assert.equal(truncated.metrics[0].code, 'upstream_stream_incomplete');
});

test('recent Claude Opus and Sonnet models get automatic effort levels, Haiku does not', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-8'])
    assert.deepEqual(modelEfforts({ id }), [null, 'low', 'medium', 'high', 'xhigh', 'max'], id);
  for (const id of ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-3-7-sonnet'])
    assert.deepEqual(modelEfforts({ id }), [null], id);
});

test('Anthropic model discovery pages with x-api-key and keeps reported limits', async t => {
  const seen = [];
  const upstream = await server((req, res) => {
    const url = new URL(req.url, 'http://local');
    seen.push({ path: url.pathname, after: url.searchParams.get('after_id'), key: req.headers['x-api-key'], auth: req.headers.authorization });
    const page = url.searchParams.get('after_id')
      ? { data: [{ id: 'claude-haiku-4-5', max_input_tokens: 200000, max_tokens: 64000 }], has_more: false, last_id: 'claude-haiku-4-5' }
      : { data: [{ id: 'claude-opus-5-5', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'claude-opus-5-5' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  }, t);
  const { discover } = require('../src/config.cjs');
  const provider = { name: 'Claude', baseUrl: `${upstream}/v1`, apiKey: 'fake-anthropic-key', apiFormat: 'anthropic', models: [] };
  assert.equal(await discover(provider), 2);
  assert.deepEqual(seen.map(item => [item.path, item.after, item.key, item.auth]),
    [['/v1/models', null, 'fake-anthropic-key', undefined], ['/v1/models', 'claude-opus-5-5', 'fake-anthropic-key', undefined]]);
  assert.deepEqual(provider.models.map(model => [model.id, model.contextWindow, model.maxOutputTokens]),
    [['claude-opus-5-5', 1000000, 128000], ['claude-haiku-4-5', 200000, 64000]]);
});
