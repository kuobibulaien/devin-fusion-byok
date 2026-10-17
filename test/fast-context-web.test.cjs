'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { s, m, v } = require('../src/protocol/wire.cjs');
const { startServer, safeError } = require('../src/fast-context/server.cjs');
const { createWebClient, authorize, readResults, searchOptions, readOptions, fetchPage, htmlToText, isPrivateAddress, LIMITS } = require('../src/fast-context/web.cjs');
const { createSelfCheck, CHECK_MESSAGES } = require('../src/fast-context/self-check.cjs');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const KEY = 'devin-session-token$preview';
const settle = () => new Promise(resolve => setImmediate(resolve));

// Fake official server: JWT exchange, team policy and the search RPC.
function fakeServer({ webSearch = true, disabled = false, results = [], status = 200 } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (status !== 200) return new Response('denied', { status });
    // Real response: protobuf message whose string fields carry the short-lived JWT.
    if (url.endsWith('/GetUserJwt')) return new Response(m(1, Buffer.from(TOKEN)));
    if (url.endsWith('/GetCliTeamSettings')) {
      return new Response(Buffer.concat([...(disabled ? [v(3, 1)] : []), ...(webSearch ? [v(4, 1)] : [])]));
    }
    if (url.endsWith('/GetWebSearchResults')) return new Response(Buffer.concat(results.map(item => m(1, item))));
    return new Response('not found', { status: 404 });
  };
  return { request, calls };
}
const item = ({ id = 'r1', url = 'https://example.com/a', title = 'Example A', text = 'snippet' } = {}) =>
  Buffer.concat([s(1, id), s(3, url), s(4, title), s(7, text)]);

test('web search asks the official origin only, without redirects or TLS opting out', async () => {
  const server = fakeServer({ results: [item()] });
  const client = createWebClient({ key: KEY, request: server.request });
  const result = await client.search({ query: 'node lts', limit: 3 });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.results, [{ url: 'https://example.com/a', title: 'Example A', text: 'snippet' }]);
  const search = server.calls.at(-1);
  assert.equal(search.url, 'https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetWebSearchResults');
  assert.equal(search.options.redirect, 'error');
  assert.equal(search.options.headers['content-type'], 'application/proto');
  assert.ok(search.options.signal);
});

test('web search honours the account switch and team ban without bypassing them', async () => {
  const off = createWebClient({ key: KEY, request: fakeServer({ webSearch: false }).request });
  await assert.rejects(off.search({ query: 'x' }), /web_search_disabled/);
  await assert.rejects(off.read({ url: 'https://example.com' }), /web_search_disabled/);
  const blocked = createWebClient({ key: KEY, request: fakeServer({ webSearch: false }).request, pageRequest: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(blocked.read({ url: 'https://example.com' }), /web_search_disabled/);
  const banned = createWebClient({ key: KEY, request: fakeServer({ disabled: true }).request });
  await assert.rejects(banned.search({ query: 'x' }), /fast_context_disabled/);
  const denied = createWebClient({ key: KEY, request: fakeServer({ status: 403 }).request });
  await assert.rejects(denied.read({ url: 'https://example.com' }), /permission_denied/);
});

test('policy lookup is cached per client and fails closed on missing token', async () => {
  const server = fakeServer({ results: [item()] });
  const client = createWebClient({ key: KEY, request: server.request });
  await client.search({ query: 'a' });
  await client.search({ query: 'b' });
  assert.equal(server.calls.filter(call => call.url.endsWith('/GetUserJwt')).length, 1);
  const empty = async () => new Response(m(1, Buffer.from('not-a-jwt')));
  await assert.rejects(authorize({ key: KEY, request: empty }), /unauthenticated/);
});

const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = location => new Response(null, { status: 302, headers: { location } });

test('page reading fetches locally after the policy check, drops fragments and refuses non-https URLs', async () => {
  const pages = [];
  const server = fakeServer();
  const client = createWebClient({ key: KEY, request: server.request,
    pageRequest: async (url, options) => { pages.push({ url, options }); return new Response('Hello\nworld', { headers: { 'content-type': 'text/plain' } }); } });
  const result = await client.read({ url: 'https://example.com/doc#section' });
  assert.equal(result.text, 'Hello\nworld');
  assert.equal(result.url, 'https://example.com/doc');
  assert.equal(pages[0].url, 'https://example.com/doc');
  assert.equal(pages[0].options.redirect, 'manual');
  assert.ok(!server.calls.some(call => call.url.includes('Redirect')));
  for (const bad of ['http://example.com', 'https://u:p@example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
    await assert.rejects(client.read({ url: bad }), /invalid_arguments/);
  }
});

test('page reading follows https redirects locally and extracts readable text', async () => {
  const pages = [];
  const pageRequest = async url => {
    pages.push(url);
    if (url === 'https://docs.example.com/start') return redirect('/final');
    return html('<html><head><title>x</title><style>p{}</style></head><body><h1>Docs</h1><p>A &amp; B</p><script>evil()</script></body></html>');
  };
  const client = createWebClient({ key: KEY, request: fakeServer().request, pageRequest });
  const result = await client.read({ url: 'https://docs.example.com/start' });
  assert.deepEqual(pages, ['https://docs.example.com/start', 'https://docs.example.com/final']);
  assert.equal(result.final_url, 'https://docs.example.com/final');
  assert.equal(result.text, 'Docs\nA & B');
  assert.doesNotMatch(result.text, /evil/);
});

test('page reading refuses http hops, private hosts, redirect loops and non-text bodies', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  await assert.rejects(fetchPage('https://a.example/', { request: async () => redirect('http://a.example/') }), /invalid_arguments/);
  await assert.rejects(fetchPage('https://a.example/', { request: async () => redirect('https://127.0.0.1/admin') }), /blocked_address/);
  for (const host of ['localhost', '10.0.0.1', '192.168.1.1', '[::1]', 'printer.local', 'intranet']) {
    await assert.rejects(fetchPage(`https://${host}/`, { request: never }), /blocked_address/, host);
  }
  let hops = 0;
  await assert.rejects(fetchPage('https://a.example/', { request: async () => { hops++; return redirect('/again'); } }), /too_many_redirects/);
  assert.equal(hops, 6);
  await assert.rejects(fetchPage('https://a.example/', { request: async () => new Response('binary', { headers: { 'content-type': 'image/png' } }) }), /unsupported_content_type/);
  await assert.rejects(fetchPage('https://a.example/', { request: async () => new Response('x', { status: 429 }) }), /resource_exhausted/);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(htmlToText('<div>a</div><ul><li>b</li></ul>'), 'a\n- b');
  for (const code of ['blocked_address', 'too_many_redirects', 'unsupported_content_type']) assert.equal(safeError(new Error(code)), code);
});

test('argument validation stays strict for both tools', () => {
  assert.deepEqual(searchOptions({ query: '  hi ' }), { query: 'hi', limit: 5, domain: '' });
  for (const bad of [null, {}, { query: '' }, { query: 'x'.repeat(LIMITS.query + 1) }, { query: 'x', limit: 0 },
    { query: 'x', limit: 21 }, { query: 'x', domain: 'a b' }, { query: 'x', extra: 1 }]) {
    assert.throws(() => searchOptions(bad), /invalid_arguments/);
  }
  for (const bad of [null, {}, { url: 1 }, { url: 'https://a', extra: 1 }]) assert.throws(() => readOptions(bad), /invalid_arguments/);
  assert.equal(readResults(Buffer.concat([m(1, item()), m(1, item({ url: 'ftp://x' }))])).length, 1);
  // The transport passes its own cancellation signal; it must not be rejected as input.
  assert.deepEqual(searchOptions({ query: 'x', signal: undefined }).query, 'x');
  assert.deepEqual(readOptions({ url: 'https://a', signal: undefined }).url, 'https://a/');
});

test('MCP exposes the three capabilities and never leaks upstream text', async t => {
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  output.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) messages.push(JSON.parse(line)); });
  let webCalls = 0;
  const server = startServer({ root: '/fixture', input, output, runSearch: async () => ({}), isEnabled: () => true,
    createWeb: () => ({
      search: async args => { webCalls++; if (args.query === 'boom') throw new Error('SECRET api key'); return { results: [{ title: 't' }] }; },
      read: async args => ({ url: args.url, text: 'page' }),
    }) });
  t.after(() => { server.close(); input.destroy(); output.destroy(); });
  const send = (method, params, id) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  send('initialize', { protocolVersion: '2025-11-25' }, 1);
  send('tools/list', {}, 2);
  send('tools/call', { name: 'web_search', arguments: { query: 'node lts' } }, 3);
  send('tools/call', { name: 'web_read_url', arguments: { url: 'https://example.com' } }, 4);
  send('tools/call', { name: 'web_search', arguments: { query: 'boom' } }, 5);
  send('tools/call', { name: 'web_search', arguments: { query: 'x', root: '/etc' } }, 6);
  send('tools/call', { name: 'web_read_url', arguments: { url: 'not a url' } }, 7);
  send('tools/call', { name: 'fast_context_status' }, 8);
  send('tools/call', { name: 'constructor', arguments: {} }, 9);
  await settle();
  const tools = messages.find(m => m.id === 2).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['code_search', 'web_search', 'web_read_url', 'fast_context_status']);
  assert.equal(messages.find(m => m.id === 9).error.code, -32602);
  assert.equal(messages.find(m => m.id === 3).result.structuredContent.results[0].title, 't');
  assert.equal(messages.find(m => m.id === 4).result.structuredContent.text, 'page', JSON.stringify(messages.find(m => m.id === 4)));
  assert.ok(messages.some(m => m.id === 8).valueOf());
  assert.deepEqual(messages.find(m => m.id === 8).result.structuredContent.capabilities, ['code_search', 'web_search', 'web_read']);
  assert.equal(messages.find(m => m.id === 6).error.code, -32602);
  assert.equal(messages.find(m => m.id === 7).error.code, -32602);
  assert.equal(messages.find(m => m.id === 5).result.isError, true);
  assert.equal(messages.find(m => m.id === 5).result.content[0].text, 'fast_context_failed');
  assert.equal(webCalls, 2);
  assert.doesNotMatch(JSON.stringify(messages), /SECRET/);
});

test('self check reports the kindest matching message, never the credential', async () => {
  const ok = createSelfCheck({ loadKey: () => KEY, verify: async () => ({ codeSearch: true, webSearch: true }) });
  assert.deepEqual(await ok.run().then(value => [value.ok, value.reason, value.capabilities]), [true, 'ok', { code: true, web: true }]);
  // The account answering with the switch off is reported per capability, not as success.
  const switchedOff = createSelfCheck({ loadKey: () => KEY, verify: async () => ({ codeSearch: true, webSearch: false }) });
  assert.deepEqual(await switchedOff.run().then(value => [value.ok, value.reason, value.capabilities]), [false, 'web_search_disabled', { code: true, web: false }]);
  const banned = createSelfCheck({ loadKey: () => KEY, verify: async () => { throw new Error('fast_context_disabled'); } });
  assert.deepEqual((await banned.run()).capabilities, { code: false, web: null });
  assert.match(ok.message(ok.state().reason), /三项能力/);
  const off = createSelfCheck({ loadKey: () => KEY, verify: async () => { throw new Error('web_search_disabled'); } });
  await off.run();
  assert.equal(off.state().ok, false);
  assert.match(off.message(off.state().reason), /网页搜索/);
  const missing = createSelfCheck({ loadKey: () => { throw new Error('credentials_unavailable'); } });
  await missing.run();
  assert.equal(missing.state().reason, 'credentials_unavailable');
  const odd = createSelfCheck({ loadKey: () => KEY, verify: async () => { throw new Error('Bearer SECRET'); } });
  await odd.run();
  assert.equal(odd.state().reason, 'unavailable');
  assert.equal(Object.keys(CHECK_MESSAGES).length, Object.keys(CHECK_MESSAGES).filter(key => CHECK_MESSAGES[key] && !CHECK_MESSAGES[key].includes('SECRET')).length);
  assert.doesNotMatch(JSON.stringify(odd.state()), /SECRET/);
});

test('web_search_disabled is an allowed error code', () => {
  assert.equal(safeError(new Error('web_search_disabled')), 'web_search_disabled');
});
