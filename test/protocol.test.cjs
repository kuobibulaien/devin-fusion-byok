'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const zlib = require('node:zlib');
const wire = require('../src/protocol/wire.cjs');
const { parseChat } = require('../src/protocol/chat.cjs');
const { serveChat, buildRequestBody } = require('../src/protocol/responses.cjs');
const { s, v, m, str, num, fields } = wire;

function nativeMessage(source, text, extra = []) {
  return m(3, Buffer.concat([v(2, source), s(3, text), ...extra]));
}
function nativeRequest() {
  const args = '{ "prompt": "keep whitespace", "count": "01" }';
  return Buffer.concat([
    s(2, '  Original\n\nsystem instructions  '), s(21, 'local-cpa-lead'), v(6, 9901),
    nativeMessage(1, 'User message', [m(10, Buffer.concat([s(1, 'aGVsbG8='), s(2, 'image/png'), s(3, 'Image caption')]))]),
    nativeMessage(2, 'Assistant before tool', [m(6, Buffer.concat([s(1, 'call:1'), s(2, 'sidekick'), s(3, args)]))]),
    nativeMessage(4, 'Tool output', [s(7, 'call:1'), v(9, 1)]),
    nativeMessage(5, 'System message in the middle'),
    nativeMessage(1, 'User after tool'),
    ...['sidekick', 'shell_command', 'mcp__service__tool'].map(name => m(10, Buffer.concat([s(1, name), s(2, 'Original description'), s(3, '{"type":"object","properties":{"cmd":{"type":"string"}},"additionalProperties":false}')]))),
    m(12, Buffer.concat([s(1, 'tool'), s(2, 'sidekick')])),
  ]);
}

function unpack(buffer) {
  const messages = [];
  let eos = 0;
  for (let offset = 0; offset < buffer.length;) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    let data = buffer.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    if (flags & 1) data = zlib.gunzipSync(data);
    if (flags & 2) { eos++; assert.deepEqual(JSON.parse(data), {}); }
    else messages.push(data);
  }
  return { messages, eos };
}

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { instance, url: `http://127.0.0.1:${instance.address().port}` };
}

async function bridge(t, upstreamHandler, apiFormat = 'openai-responses') {
  const requests = [];
  const logs = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)), auth: req.headers.authorization });
    await upstreamHandler(req, res);
  }, t);
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route: { model: 'test-model', uid: 'local-cpa-lead', effort: 'high' }, provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'fake-provider-secret', apiFormat }, res, log: event => logs.push(event) });
  }, t);
  return { ...proxy, requests, logs, upstream };
}

function event(value) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }

test('protobuf retains unknown raw fields and uint64 without rounding', () => {
  const input = Buffer.concat([s(3, '模型'), v(911, 18446744073709551615n), m(300, Buffer.from([1, 2, 3]))]);
  const parsed = wire.parseFields(input);
  assert.equal(str(input, 3), '模型');
  assert.equal(num(input, 911), 18446744073709551615n);
  assert.deepEqual(Buffer.concat(parsed.map(field => field.raw)), input);
  assert.deepEqual(parsed.map(field => [field.number, field.wire]), [[3, 2], [911, 0], [300, 2]]);
});

test('protobuf rejects malformed lengths, tags and overflowing varints', () => {
  for (const input of [[0], [10, 4, 65], [9, 1, 2], [13, 1], [8, ...Array(10).fill(128)], [8, ...Array(9).fill(255), 2], [11]]) {
    assert.throws(() => wire.parseFields(Buffer.from(input)));
  }
});

test('Connect protobuf and JSON preserve framing and both gzip layers', () => {
  for (const json of [false, true]) for (const gzip of [false, true]) for (const compressed of [false, true]) {
    const data = json ? { unicode: '中文', value: 42 } : s(1, '中文');
    const format = { framed: true, json, gzip, compressed, type: json ? 'application/connect+json' : 'application/connect+proto' };
    const encoded = wire.encode(data, format);
    const decoded = wire.decode(encoded, { 'content-type': format.type, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    assert.deepEqual(decoded.data, data);
    assert.equal(decoded.framed, true);
    assert.equal(decoded.compressed, compressed);
    assert.deepEqual(wire.encode(decoded.data, decoded), encoded);
  }
  assert.throws(() => wire.decode(Buffer.from([0, 0, 0, 0, 10, 1]), { 'content-type': 'application/connect+proto' }));
  assert.throws(() => wire.decode(Buffer.concat([wire.frame(s(1, 'a')), wire.frame(s(1, 'b'))]), { 'content-type': 'application/connect+proto' }));
});

test('native parser preserves arbitrary tools, arguments, system bytes and message order', () => {
  const request = parseChat(nativeRequest());
  assert.equal(request.systemPrompt, '  Original\n\nsystem instructions  ');
  assert.equal(request.modelUid, 'local-cpa-lead');
  assert.equal(request.modelEnum, 9901);
  assert.deepEqual(request.tools.map(tool => tool.name), ['sidekick', 'shell_command', 'mcp__service__tool']);
  assert.equal(request.messages[1].toolCalls[0].arguments, '{ "prompt": "keep whitespace", "count": "01" }');
  assert.equal(request.messages[1].toolCalls[0].id, 'call:1');
  assert.equal(request.messages[2].toolResultIsError, true);
  assert.deepEqual(request.messages.map(message => message.role), ['user', 'assistant', 'tool', 'system', 'user']);
  assert.equal(request.tools[1].parameters.properties.cmd.type, 'string');
});

for (const snake of [false, true]) test(`native ${snake ? 'snake_case' : 'camelCase'} JSON schema matches protobuf history and tools`, () => {
  const key = (camel, underscored) => snake ? underscored : camel;
  const native = parseChat(nativeRequest());
  const data = {
    [key('chatModelUid', 'chat_model_uid')]: native.modelUid,
    [key('internalChatModel', 'internal_chat_model')]: native.modelEnum,
    prompt: native.systemPrompt,
    [key('chatMessagePrompts', 'chat_message_prompts')]: native.messages.map(message => ({
      [key('messageId', 'message_id')]: message.messageId,
      source: message.source,
      prompt: message.content,
      [key('toolCalls', 'tool_calls')]: message.toolCalls.map(call => ({ id: call.id, name: call.name, [key('argumentsJson', 'arguments_json')]: call.arguments })),
      [key('toolCallId', 'tool_call_id')]: message.toolCallId,
      [key('toolResultIsError', 'tool_result_is_error')]: message.toolResultIsError,
      images: message.images.map(image => ({ [key('base64Data', 'base64_data')]: image.base64, [key('mimeType', 'mime_type')]: image.mimeType, caption: image.caption })),
      thinking: message.thinking, signature: message.signature,
    })),
    tools: native.tools.map(tool => ({ name: tool.name, description: tool.description, [key('jsonSchemaString', 'json_schema_string')]: JSON.stringify(tool.parameters) })),
    [key('toolChoice', 'tool_choice')]: { [key('toolName', 'tool_name')]: 'sidekick' },
  };
  const parsed = parseChat(data);
  assert.deepEqual(parsed, native);
  assert.deepEqual(buildRequestBody(parsed, { model: 'chosen-model' }, { apiFormat: 'responses' }), buildRequestBody(native, { model: 'chosen-model' }, { apiFormat: 'responses' }));
  data[key('toolChoice', 'tool_choice')] = { [key('optionName', 'option_name')]: 'any' };
  assert.equal(buildRequestBody(parseChat(data), { model: 'chosen-model' }, { apiFormat: 'openai' }).tool_choice, 'required');
});

test('Responses and Chat requests preserve history, pictures and exact tool definitions', () => {
  const request = parseChat(nativeRequest());
  for (const apiFormat of ['openai-responses', 'chat-completions']) {
    const body = buildRequestBody(request, { model: 'chosen-model', effort: 'xhigh' }, { apiFormat });
    assert.equal(body.model, 'chosen-model');
    const chat = apiFormat === 'chat-completions';
    const messages = chat ? body.messages : body.input;
    assert.equal(messages[0].content, request.systemPrompt);
    assert.equal(messages[1].content[1].type, chat ? 'image_url' : 'input_image');
    assert.equal(messages.at(-2).content, 'System message in the middle');
    assert.equal(messages.at(-1).content, 'User after tool');
    assert.deepEqual(body.tools.map(tool => (tool.function || tool).name), request.tools.map(tool => tool.name));
    assert.deepEqual((body.tools[1].function || body.tools[1]).parameters, request.tools[1].parameters);
    if (chat) {
      assert.equal(messages[2].tool_calls[0].function.arguments, request.messages[1].toolCalls[0].arguments);
      assert.equal(body.tool_choice.function.name, 'sidekick');
      assert.equal(body.reasoning_effort, 'xhigh');
    } else {
      assert.equal(messages[3].type, 'function_call');
      assert.equal(messages[4].type, 'function_call_output');
      assert.equal(messages[3].arguments, request.messages[1].toolCalls[0].arguments);
      assert.equal(body.tool_choice.name, 'sidekick');
      assert.equal(body.reasoning.effort, 'xhigh');
    }
  }
});

test('openai menu format selects Chat Completions and configured output limit is retained', () => {
  const request = parseChat(nativeRequest());
  const chatBody = buildRequestBody(request, { model: 'chosen-model', maxOutputTokens: 8192 }, { apiFormat: 'openai', maxTokens: 4096 });
  assert.ok(Array.isArray(chatBody.messages));
  assert.equal(chatBody.input, undefined);
  assert.equal(chatBody.max_completion_tokens, 8192);
  const responsesBody = buildRequestBody(request, { model: 'chosen-model', maxOutputTokens: 8192 }, { apiFormat: 'responses' });
  assert.equal(responsesBody.max_output_tokens, 8192);
});

test('Responses completes parallel done-only calls and Unicode split across TCP chunks', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const values = [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '中文✓' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'sidekick' } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'mcp__service__tool' } },
      { type: 'response.function_call_arguments.done', item_id: 'item-1', arguments: '{ "prompt": "check" }' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'item-2', call_id: 'call-2', name: 'mcp__service__tool', arguments: '{"cmd":"run"}' } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ];
    const bytes = Buffer.from(values.map(event).join(''));
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  const response = await fetch(app.url);
  assert.equal(response.headers.get('content-type'), 'application/connect+proto');
  const { messages, eos } = unpack(Buffer.from(await response.arrayBuffer()));
  assert.equal(messages.map(message => str(message, 3)).join(''), '中文✓');
  const tools = messages.flatMap(message => fields(message, 6)).map(field => ({ name: str(field.value, 2), args: str(field.value, 3) }));
  assert.deepEqual(tools, [{ name: 'sidekick', args: '{ "prompt": "check" }' }, { name: 'mcp__service__tool', args: '{"cmd":"run"}' }]);
  assert.equal(num(messages.at(-1), 5), 10);
  assert.equal(str(messages.at(-1), 20), 'local-cpa-lead');
  assert.equal(eos, 1);
  assert.equal(app.requests[0].url, '/v1/responses');
  assert.equal(app.requests[0].auth, 'Bearer fake-provider-secret');
  assert.equal(JSON.stringify(app.logs).includes('fake-provider-secret'), false);
  assert.deepEqual(app.logs[0].toolNames, ['sidekick', 'mcp__service__tool']);
});

test('Responses completed output alone reconstructs text and exact tool arguments', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Only final text' }] }, { type: 'function_call', call_id: 'call-1', name: 'sidekick', arguments: '{"prompt":"done-only"}' }] } }));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Only final text');
  assert.equal(str(result.messages.flatMap(message => fields(message, 6))[0].value, 3), '{"prompt":"done-only"}');
  assert.equal(num(result.messages.at(-1), 5), 10);
});

test('Responses delta and completed output do not duplicate tool calls or text', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.output_text.delta', delta: 'A', output_index: 0, content_index: 0 },
      { type: 'response.output_text.done', text: 'AB', output_index: 0, content_index: 0 },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'sidekick' }, output_index: 1 },
      { type: 'response.function_call_arguments.delta', delta: '{"prompt":', item_id: 'item' },
      { type: 'response.function_call_arguments.delta', delta: '"task"}', output_index: 1 },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'AB' }] }, { type: 'function_call', id: 'item', call_id: 'call', name: 'sidekick', arguments: '{"prompt":"task"}' }] } },
    ].map(event).join(''));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'AB');
  assert.equal(result.messages.flatMap(message => fields(message, 6)).length, 1);
});

test('Responses parallel calls retain output index order when events arrive out of order', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c2', name: 'shell_command', arguments: '{"cmd":"second"}' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'sidekick', arguments: '{"prompt":"first"}' } },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ].map(event).join(''));
  });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.deepEqual(result.messages.flatMap(message => fields(message, 6)).map(tool => str(tool.value, 2)), ['sidekick', 'shell_command']);
});

test('explicit caller abort cancels a request before HTTP headers arrive', async t => {
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstream = await server((req, res) => { res.on('close', upstreamClosed); upstreamStarted(); }, t);
  const controller = new AbortController();
  const logs = [];
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route: { model: 'test-model', uid: 'local-test' }, provider: { baseUrl: `${upstream.url}/v1`, apiKey: 'unused', apiFormat: 'responses' }, res, signal: controller.signal, log: event => logs.push(event) });
  }, t);
  const pending = fetch(proxy.url).catch(() => null);
  await started;
  controller.abort();
  assert.equal(await pending, null);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream not aborted')), 2000); timer.unref(); })]);
  assert.equal(logs[0].event, 'chat-aborted');
});

test('Chat Completions assembles fragmented parallel native tool calls', async t => {
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { choices: [{ index: 0, delta: { reasoning_content: 'Thinking', tool_calls: [{ index: 0, id: 'c1', function: { name: 'sidekick', arguments: '{"prompt":' } }, { index: 1, id: 'c2', function: { name: 'shell_command', arguments: '{"cmd":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"echo ok"}' } }, { index: 0, function: { arguments: '"task"}' } }] }, finish_reason: 'tool_calls' }] },
    ].map(event).join('') + 'data: [DONE]\n\n');
  }, 'openai-chat-completions');
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(app.requests[0].url, '/v1/chat/completions');
  assert.equal(result.messages.map(message => str(message, 9)).join(''), 'Thinking');
  const tools = result.messages.flatMap(message => fields(message, 6));
  assert.deepEqual(tools.map(tool => [str(tool.value, 2), str(tool.value, 3)]), [['sidekick', '{"prompt":"task"}'], ['shell_command', '{"cmd":"echo ok"}']]);
  assert.equal(num(result.messages.at(-1), 5), 10);
});

test('incomplete, malformed and unterminated streams do not execute tools', async t => {
  for (const ending of ['incomplete', 'invalid-json', 'truncated']) await t.test(ending, async st => {
    const app = await bridge(st, async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'sidekick' } }));
      res.write(event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"prompt":' }));
      if (ending === 'incomplete') res.write(event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }));
      if (ending === 'invalid-json') res.write(event({ type: 'response.completed', response: { status: 'completed', output: [] } }));
      res.end();
    });
    const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
    assert.equal(result.messages.flatMap(message => fields(message, 6)).length, 0);
    assert.equal(num(result.messages.at(-1), 5), ending === 'incomplete' ? 3 : 13);
  });
});

test('upstream errors expose HTTP status without body, prompt or credentials', async t => {
  const app = await bridge(t, async (req, res) => { res.writeHead(429); res.end('fake-provider-secret secret upstream reply with user content'); });
  const result = unpack(Buffer.from(await (await fetch(app.url)).arrayBuffer()));
  assert.equal(result.messages.map(message => str(message, 3)).join(''), 'Provider returned HTTP 429.');
  assert.equal(num(result.messages.at(-1), 5), 13);
  assert.equal(JSON.stringify(app.logs).includes('secret'), false);
  assert.equal(JSON.stringify(app.logs).includes('User message'), false);
});

test('client cancellation aborts active upstream request', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  let upstreamStarted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  const app = await bridge(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event({ type: 'response.output_text.delta', delta: 'Started' }));
    res.on('close', upstreamClosed);
    upstreamStarted();
  });
  const controller = new AbortController();
  const response = await fetch(app.url, { signal: controller.signal });
  await started;
  await response.body.getReader().read();
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream not aborted')), 2000); timer.unref(); })]);
  assert.equal(app.logs.some(log => log.event === 'chat-aborted'), true);
});
