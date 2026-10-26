'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { backendEnvironment } = require('../src/runtime/backend-env.cjs');

test('editor proxy overrides inherited casing without mutating the environment or dropping bypasses', () => {
  const original = Object.freeze({ HTTPS_PROXY: 'http://old.invalid:8000', https_proxy: 'http://lower.invalid:8001',
    NO_PROXY: 'internal.example', no_proxy: 'lower.internal', KEEP: 'unchanged' });
  const env = backendEnvironment(original, 'http://127.0.0.1:7897');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897/');
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.KEEP, 'unchanged');
  assert.ok(env.NO_PROXY.includes('internal.example'));
  assert.ok(env.NO_PROXY.includes('lower.internal'));
  assert.ok(env.NO_PROXY.includes('127.0.0.1'));
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(original.HTTPS_PROXY, 'http://old.invalid:8000');
  assert.equal(backendEnvironment({}, '').NODE_USE_ENV_PROXY, undefined);
  assert.equal(backendEnvironment({}, 'not a proxy').HTTP_PROXY, undefined);
});

test('detached Node actually uses the proxy for remote requests and bypasses it for local RPCs', async t => {
  const seen = [];
  const proxy = http.createServer((req, res) => { seen.push(req.url); res.end('proxied'); });
  const local = http.createServer((_req, res) => res.end('local'));
  for (const server of [proxy, local]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const env = backendEnvironment({ PATH: process.env.PATH }, 'http://127.0.0.1:' + proxy.address().port);
  const source = `const http=require('node:http');
    const get=url=>new Promise((resolve,reject)=>http.get(url,r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(s))}).on('error',reject));
    Promise.all([get('http://models.invalid/catalog'),get('http://127.0.0.1:${local.address().port}/health')])
      .then(values=>console.log(JSON.stringify(values))).catch(()=>process.exit(1));`;
  const child = spawn(process.execPath, ['-e', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output), ['proxied', 'local']);
  assert.deepEqual(seen, ['http://models.invalid/catalog']);
});
