'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { runtimeIdentity, controlFile } = require('../src/runtime/backend.cjs');
const filename = path.resolve(__dirname, '../src/extension.cjs');
const realRequire = createRequire(filename);
const moduleUnderTest = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: moduleUnderTest, exports: moduleUnderTest.exports, process,
  AbortController, AbortSignal, setTimeout, clearTimeout,
  require: name => name === 'vscode' ? {} : realRequire(name),
}, { filename });
const { ensureBackend, safeError } = moduleUnderTest.exports;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-manager-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = { ...runtimeIdentity(root, true), instanceId: 'new-instance', managementProtocol: 1, activeRequests: 0, draining: false };
  const old = { ...expected, version: '0.0.1', sourceId: 'a'.repeat(64), instanceId: 'old-instance' };
  const token = 'b'.repeat(64), logs = [], spawns = [], waits = [];
  fs.writeFileSync(controlFile(root), JSON.stringify({ ...old, token }), { mode: 0o600 });
  return { root, expected, old, token, logs, spawns, waits,
    options: { root, extensionPath: path.resolve(__dirname, '..'), log: (...args) => logs.push(args) },
    spawn(...args) { spawns.push(args); const child = new EventEmitter(); child.unref = () => {}; return child; },
    sleep: async ms => { waits.push(ms); },
  };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('app updates reuse an identical user-installed runtime without spawn or shutdown', async t => {
  const f = fixture(t);
  let calls = 0;
  const health = await ensureBackend(f.options, { fetch: async url => { calls++; assert.ok(url.endsWith('/health')); return json(f.expected); }, spawn: f.spawn, sleep: f.sleep });
  assert.equal(health.sourceId, f.expected.sourceId);
  assert.equal(calls, 1);
  assert.deepEqual(f.spawns, []);
});

test('upgrades wait for active work, authenticate graceful shutdown, then verify the new runtime', async t => {
  const f = fixture(t);
  let healthCalls = 0, shutdowns = 0;
  const fetch = async (url, options) => {
    if (url.endsWith('/_runtime/shutdown')) {
      shutdowns++;
      assert.equal(healthCalls, 2);
      assert.equal(options.headers.authorization, 'Bearer ' + f.token);
      return json({ stopping: true });
    }
    healthCalls++;
    if (healthCalls === 1) return json({ ...f.old, activeRequests: 2 });
    if (healthCalls === 2) return json(f.old);
    if (healthCalls === 3) throw new Error('Connection refused');
    return json(f.expected);
  };
  const health = await ensureBackend(f.options, { fetch, spawn: f.spawn, sleep: f.sleep });
  assert.equal(health.instanceId, 'new-instance');
  assert.equal(shutdowns, 1);
  assert.equal(f.spawns.length, 1);
  assert.ok(f.waits.includes(1000));
  assert.ok(!JSON.stringify(f.logs).includes(f.token));
});

test('a busy shutdown race keeps serving and retries after completion', async t => {
  const f = fixture(t);
  let shutdowns = 0;
  const health = await ensureBackend(f.options, {
    fetch: async url => {
      if (url.endsWith('/_runtime/shutdown')) return new Response('{}', { status: ++shutdowns === 1 ? 409 : 200 });
      return json(shutdowns < 2 ? f.old : f.expected);
    }, spawn: f.spawn, sleep: f.sleep,
  });
  assert.equal(shutdowns, 2);
  assert.equal(health.instanceId, 'new-instance');
  assert.deepEqual(f.spawns, []);
});

test('another window completing the update prevents an unnecessary duplicate launch', async t => {
  const f = fixture(t);
  let stopped = false;
  await ensureBackend(f.options, {
    fetch: async url => {
      if (url.endsWith('/_runtime/shutdown')) { stopped = true; throw new Error('Connection closed'); }
      return json(stopped ? f.expected : f.old);
    }, spawn: f.spawn, sleep: f.sleep,
  });
  assert.deepEqual(f.spawns, []);
});

test('foreign roots, unsupported old daemons and newer installed versions are never terminated', async t => {
  for (const [change, code] of [
    [{ rootId: 'foreign' }, 'different_storage'],
    [{ rootId: undefined, managementProtocol: undefined }, 'legacy_runtime'],
    [{ version: '999.0.0' }, 'newer_runtime'],
  ]) {
    const f = fixture(t);
    await assert.rejects(ensureBackend(f.options, {
      fetch: async url => { assert.ok(url.endsWith('/health')); return json({ ...f.old, ...change }); },
      spawn: f.spawn, sleep: f.sleep,
    }), error => error.code === code);
    assert.deepEqual(f.spawns, []);
  }
});

test('a control-file instance mismatch cannot send a shutdown token to another runtime', async t => {
  const f = fixture(t);
  fs.writeFileSync(controlFile(f.root), JSON.stringify({ ...f.old, instanceId: 'different-instance', token: f.token }));
  await assert.rejects(ensureBackend(f.options, {
    fetch: async url => { assert.ok(url.endsWith('/health')); return json(f.old); }, spawn: f.spawn, sleep: f.sleep,
  }), error => error.code === 'control_unavailable');
  assert.deepEqual(f.spawns, []);
});

test('unloading a window cancels its pending upgrade without affecting the running daemon', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  await assert.rejects(ensureBackend({ ...f.options, signal: controller.signal }, {
    fetch: async url => { assert.ok(url.endsWith('/health')); return json({ ...f.old, activeRequests: 1 }); },
    spawn: f.spawn, sleep: async () => { controller.abort(); },
  }), error => error.code === 'cancelled');
  assert.deepEqual(f.spawns, []);
});

test('error reporting redacts arbitrary provider messages but retains fixed HTTP status notices', () => {
  const message = 'Unexpected token secret-api-key-from-provider-response';
  assert.equal(safeError({ message }).code, 'operation_failed');
  assert.ok(!JSON.stringify(safeError({ message })).includes('secret-api-key'));
  assert.equal(safeError({ message: '获取模型失败：HTTP 429' }).message, '获取模型失败：HTTP 429');
  assert.equal(safeError({ message: '获取模型失败：HTTP 429 secret-api-key' }).code, 'operation_failed');
});

test('a busy compatible runtime notifies once and finishes the upgrade after release', async t => {
  const f = fixture(t);
  let busy = true, stopped = false, gone = false;
  const seen = [];
  const pending = ensureBackend({ ...f.options, onCompatibleRuntime: health => seen.push({ version: health.version, instanceId: health.instanceId }) }, {
    fetch: async url => {
      if (url.endsWith('/_runtime/shutdown')) { stopped = true; return json({ stopping: true }); }
      if (busy) return json({ ...f.old, activeRequests: 3 });
      if (!stopped) return json(f.old);
      if (!gone) { gone = true; throw new Error('Connection refused'); }
      return json(f.expected);
    }, spawn: f.spawn, sleep: async ms => { f.waits.push(ms); await new Promise(resolve => setImmediate(resolve)); },
  });
  for (let index = 0; index < 10 && !seen.length; index++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [{ version: '0.0.1', instanceId: 'old-instance' }], 'compatible callback fires once with health');
  assert.deepEqual(f.spawns, []);
  assert.equal(stopped, false, 'busy runtime is not interrupted');
  busy = false;
  const health = await pending;
  assert.equal(health.instanceId, 'new-instance');
  assert.equal(stopped, true);
  assert.equal(f.spawns.length, 1);
  assert.equal(seen.length, 1);
});

test('incompatible and identical runtimes never invoke the compatible callback', async t => {
  for (const [change, code] of [
    [{ rootId: 'foreign' }, 'different_storage'],
    [{ rootId: undefined, managementProtocol: undefined }, 'legacy_runtime'],
    [{ version: '999.0.0' }, 'newer_runtime'],
  ]) {
    const f = fixture(t);
    let notified = 0;
    await assert.rejects(ensureBackend({ ...f.options, onCompatibleRuntime: () => { notified++; } }, {
      fetch: async () => json({ ...f.old, ...change }), spawn: f.spawn, sleep: f.sleep,
    }), error => error.code === code);
    assert.equal(notified, 0);
    assert.deepEqual(f.spawns, []);
  }
  const f = fixture(t);
  let notified = 0;
  await ensureBackend({ ...f.options, onCompatibleRuntime: () => { notified++; } }, {
    fetch: async () => json(f.expected), spawn: f.spawn, sleep: f.sleep,
  });
  assert.equal(notified, 0, 'an identical runtime resolves without the pending callback');
});

test('unloading during a busy wait still aborts the upgrade after the compatible callback fired', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  let notified = 0, shutdowns = 0;
  await assert.rejects(ensureBackend({ ...f.options, signal: controller.signal, onCompatibleRuntime: () => { notified++; } }, {
    fetch: async url => {
      if (url.endsWith('/_runtime/shutdown')) { shutdowns++; return json({ stopping: true }); }
      return json({ ...f.old, activeRequests: 6 });
    },
    spawn: f.spawn, sleep: async () => { controller.abort(); },
  }), error => error.code === 'cancelled');
  assert.equal(notified, 1);
  assert.equal(shutdowns, 0);
  assert.deepEqual(f.spawns, []);
});

test('simultaneous windows reusing an identical runtime never spawn duplicate daemons', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([
    ensureBackend(f.options, { fetch: async () => json(f.expected), spawn: f.spawn, sleep: f.sleep }),
    ensureBackend(f.options, { fetch: async () => json(f.expected), spawn: f.spawn, sleep: f.sleep }),
  ]);
  assert.equal(a.instanceId, 'new-instance');
  assert.equal(b.instanceId, 'new-instance');
  assert.deepEqual(f.spawns, []);
});
