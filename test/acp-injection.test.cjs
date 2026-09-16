'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/runtime/acp-injection.cjs'), 'utf8');
const NATIVE = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const LOCAL = 'http://127.0.0.1:39842';
function fixture() {
  const logs = [], registrations = [], requests = [], disposals = [], paths = [];
  const returnValue = Promise.resolve('native-result');
  const api = { registerConnection(...args) {
    registrations.push({ thisArg: this, args });
    return { dispose(...args) { disposals.push({ thisArg: this, args }); return 'disposed'; } };
  } };
  const originalRegister = api.registerConnection;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL,
    require(name) {
      assert.equal(name, 'node:module');
      return { createRequire(file) { paths.push(file); return name => {
        assert.equal(name, 'vscode'); return { windsurfAcp: api };
      }; } };
    },
  }, { filename: 'acp-injection.cjs' });
  function connector(changes = {}) {
    return { agentId: 'devin-cli', bundled: true, location: { kind: 'local' },
      sendHandshakeRequest(...args) { requests.push({ thisArg: this, args }); return returnValue; }, ...changes };
  }
  const install = changes => module.exports.installAcpInjection({ nativeMainPath: NATIVE, apiServerUrl: LOCAL, log: event => logs.push(event), ...changes });
  return { api, logs, registrations, requests, disposals, paths, returnValue, originalRegister, connector, install };
}
function auth(url = 'https://server.codeium.com') {
  return { id: 7, method: 'authenticate', params: { methodId: 'windsurf-api-key', _meta: { api_key: 'test-secret-do-not-log', api_server_url: url, future: { keep: true } } } };
}

test('registration attaches before authentication and redirects only the metadata URL', async () => {
  const f = fixture(), handle = await f.install(), connection = f.connector();
  const context = {};
  const registration = f.api.registerConnection.call(context, connection, 'extra');
  assert.equal(f.registrations[0].thisArg, context);
  assert.equal(f.registrations[0].args[0], connection);
  assert.equal(f.registrations[0].args[1], 'extra');
  assert.equal(typeof registration.dispose, 'function');
  const input = auth(), token = {}, secondContext = {};
  assert.equal(connection.sendHandshakeRequest.call(secondContext, input, token, 'future'), f.returnValue);
  const changed = f.requests[0].args[0];
  assert.notEqual(changed, input);
  assert.notEqual(changed.params, input.params);
  assert.notEqual(changed.params._meta, input.params._meta);
  assert.equal(changed.params._meta.api_server_url, LOCAL);
  assert.equal(changed.params._meta.api_key, input.params._meta.api_key);
  assert.equal(changed.params._meta.future, input.params._meta.future);
  assert.equal(input.params._meta.api_server_url, 'https://server.codeium.com');
  assert.equal(f.requests[0].thisArg, secondContext);
  assert.equal(f.requests[0].args[1], token);
  assert.equal(f.requests[0].args[2], 'future');
  assert.equal(handle.status.rewritten, 1);
  assert.ok(!JSON.stringify(f.logs).includes('test-secret'));
  assert.deepEqual(f.paths, [NATIVE]);
  handle.dispose();
});

test('other handshake messages, authentication methods and enterprise servers are untouched', async () => {
  const f = fixture(), handle = await f.install(), connection = f.connector();
  f.api.registerConnection(connection);
  const messages = [
    { method: 'initialize', params: { protocolVersion: 2 } },
    { method: 'session/new', params: { cwd: '/workspace' } },
    { method: 'authenticate', params: { methodId: 'other', _meta: auth().params._meta } },
    { method: 'authenticate', params: { methodId: 'windsurf-api-key' } },
    ...['https://server-beta.codeium.com', 'https://company.example.com', 'http://server.codeium.com',
      'https://server.codeium.com.evil.test', 'https://server.codeium.com/other',
      'https://server.codeium.com?redirect=other', 'https://user:pass@server.codeium.com', LOCAL].map(auth),
  ];
  for (const message of messages) {
    assert.equal(connection.sendHandshakeRequest(message), f.returnValue);
    assert.equal(f.requests.at(-1).args[0], message);
  }
  assert.equal(handle.status.rewritten, 0);
  handle.dispose();
});

test('cloud, remote and nonbundled connectors retain their original methods', async () => {
  const f = fixture(), handle = await f.install();
  for (const change of [{ agentId: 'devin-cloud' }, { bundled: false }, { location: { kind: 'ssh' } }, { agentId: 'custom' }]) {
    const connection = f.connector(change), original = connection.sendHandshakeRequest;
    f.api.registerConnection(connection);
    assert.equal(connection.sendHandshakeRequest, original);
  }
  assert.equal(handle.status.connections, 0);
  handle.dispose();
});

test('native errors and return identity remain unchanged', async () => {
  const f = fixture(), handle = await f.install();
  const failure = new Error('native-failure');
  const connection = f.connector({ sendHandshakeRequest() { throw failure; } });
  f.api.registerConnection(connection);
  assert.throws(() => connection.sendHandshakeRequest(auth()), error => error === failure);
  handle.dispose();
});

test('native connection disposal restores its method and releases the captured connector', async () => {
  const f = fixture(), handle = await f.install(), connection = f.connector();
  const original = connection.sendHandshakeRequest;
  const registration = f.api.registerConnection(connection);
  const context = {};
  assert.equal(registration.dispose.call(context, 'extra'), 'disposed');
  assert.equal(f.disposals[0].thisArg, context);
  assert.equal(f.disposals[0].args[0], 'extra');
  assert.equal(connection.sendHandshakeRequest, original);
  assert.equal(handle.status.connections, 0);
  handle.dispose();
});

test('installation is idempotent and unloading restores native descriptors', async () => {
  const f = fixture(), handle = await f.install(), connection = f.connector();
  assert.equal(await f.install(), handle);
  const descriptor = Object.getOwnPropertyDescriptor(connection, 'sendHandshakeRequest');
  f.api.registerConnection(connection);
  f.api.registerConnection(connection);
  assert.equal(handle.status.connections, 1);
  handle.dispose(); handle.dispose();
  assert.equal(f.api.registerConnection, f.originalRegister);
  assert.deepEqual(Object.getOwnPropertyDescriptor(connection, 'sendHandshakeRequest'), descriptor);
  assert.equal(handle.status.state, 'disposed');
  const fresh = await f.install(); assert.notEqual(fresh, handle); fresh.dispose();
});

test('prototype methods are restored without leaving an own-property shadow', async () => {
  const f = fixture(), handle = await f.install();
  const prototype = { sendHandshakeRequest() { return 'native'; } };
  const connection = Object.assign(Object.create(prototype), { agentId: 'devin-cli', bundled: true, location: { kind: 'local' } });
  f.api.registerConnection(connection);
  assert.equal(Object.hasOwn(connection, 'sendHandshakeRequest'), true);
  handle.dispose();
  assert.equal(Object.hasOwn(connection, 'sendHandshakeRequest'), false);
  assert.equal(connection.sendHandshakeRequest, prototype.sendHandshakeRequest);
});

test('newer wrappers installed by others survive unloading and stop rewriting auth metadata', async () => {
  const f = fixture(), handle = await f.install(), connection = f.connector();
  f.api.registerConnection(connection);
  const ours = connection.sendHandshakeRequest;
  const newer = function (...args) { return ours.apply(this, args); };
  connection.sendHandshakeRequest = newer;
  handle.dispose();
  assert.equal(connection.sendHandshakeRequest, newer);
  const input = auth(); connection.sendHandshakeRequest(input);
  assert.equal(f.requests.at(-1).args[0], input);
});

test('untrusted destination URLs and conflicting installations are rejected', async () => {
  const f = fixture();
  for (const destination of ['https://127.0.0.1:39842', 'http://example.com:39842', 'http://127.0.0.1:39842/path', 'http://127.0.0.1', 'http://user:secret@localhost:39842']) {
    await assert.rejects(f.install({ apiServerUrl: destination }), /loopback/);
  }
  const handle = await f.install();
  await assert.rejects(f.install({ apiServerUrl: 'http://127.0.0.1:39843' }), /different destination/);
  handle.dispose();
});
