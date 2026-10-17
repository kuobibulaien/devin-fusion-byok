'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { startServer, safeError, parseArgs } = require('../src/fast-context/server.cjs');
function harness(t, runSearch) {
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  output.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) messages.push(JSON.parse(line)); });
  const server = startServer({ root: '/fixture', input, output, runSearch });
  t.after(() => { server.close(); input.destroy(); output.destroy(); });
  const send = (method, params, id) => input.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) + '\n');
  send('initialize', { protocolVersion: '2025-11-25' }, 1);
  return { input, messages, send };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('MCP handshake, list, status, validation and safe errors', async t => {
  const h = harness(t, async () => { throw new Error('SECRET api key'); });
  h.send('tools/list', {}, 2);
  h.send('tools/call', { name: 'fast_context_status' }, 3);
  h.send('tools/call', { name: 'fast_context_search', arguments: { query: 'x', root: '/etc' } }, 4);
  h.send('tools/call', { name: 'fast_context_search', arguments: { query: 'x' } }, 5);
  await settle();
  assert.deepEqual(h.messages.find(m => m.id === 2).result.tools.map(tool => tool.name),
    ['fast_context_search', 'web_search', 'web_read_url', 'fast_context_status']);
  assert.equal(h.messages.find(m => m.id === 3).result.structuredContent.authentication, 'not_checked');
  assert.equal(h.messages.find(m => m.id === 4).error.code, -32602);
  assert.equal(h.messages.find(m => m.id === 5).result.isError, true);
  assert.doesNotMatch(JSON.stringify(h.messages), /SECRET/);
});
test('MCP handles concurrency, matching cancellation and progress', async t => {
  let cancelled = false;
  const h = harness(t, (_, { signal, onProgress }) => new Promise((resolve, reject) => {
    onProgress(1, 4);
    signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true });
  }));
  h.send('tools/call', { name: 'fast_context_search', arguments: { query: 'x' }, _meta: { progressToken: 'p' } }, 2);
  h.send('tools/call', { name: 'fast_context_search', arguments: { query: 'y' } }, 3);
  h.send('notifications/cancelled', { requestId: 99 });
  assert.equal(cancelled, false);
  h.send('notifications/cancelled', { requestId: 2 });
  await settle();
  assert.equal(cancelled, true);
  assert.match(h.messages.find(m => m.id === 3).result.content[0].text, /search_busy/);
  assert.equal(h.messages.find(m => m.id === 2).result.content[0].text, 'cancelled_or_timeout');
  assert.ok(h.messages.some(m => m.method === 'notifications/progress'));
});
test('stdin EOF aborts work and does not emit a late response', async t => {
  let cancelled = false;
  const h = harness(t, (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); });
  }));
  h.send('tools/call', { name: 'fast_context_search', arguments: { query: 'x' } }, 2);
  h.input.end(); await settle();
  assert.equal(cancelled, true);
  assert.equal(h.messages.some(m => m.id === 2), false);
});
test('bad JSON, arrays and oversized requests get protocol errors', async t => {
  const h = harness(t);
  h.input.write('bad\n[]\n');
  h.input.write('x'.repeat(129 * 1024));
  await settle();
  assert.deepEqual(h.messages.slice(1).map(m => m.error.code), [-32700, -32600, -32600]);
  assert.equal(h.input.destroyed, true);
});
test('error mapper never reflects upstream details', () => {
  assert.equal(safeError(new Error('Bearer SECRET')), 'fast_context_failed');
  assert.equal(safeError(new Error('permission_denied')), 'permission_denied');
});
test('CLI requires explicit absolute existing root', () => {
  for (const args of [[], ['--root', '.'], ['--root', '/does-not-exist'], ['--root', '/tmp', '--root', '/tmp'], ['--anything', 'x']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('packaged stdio entry handshakes in a separate process, stdout contains JSON only', async () => {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/fast-context/server.cjs'), '--root', __dirname],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => {
    stdout += data;
    if (stdout.includes('"id":2')) child.stdin.end();
  });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 5000);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, stderr);
  const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[0].result.protocolVersion, '2025-03-26');
  assert.equal(messages[1].result.tools.length, 4);
});
