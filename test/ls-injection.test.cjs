'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const url = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/ls-injection.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';
const HEARTBEAT = '/exa.language_server_pb.LanguageServerService/Heartbeat';
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests = [];
  const setters = [];
  const paths = [];
  const logs = [];
  const closed = [];
  const created = [];
  const requestResult = { native: 'request' };
  const setterResult = { native: 'setter' };
  const http = {
    request(...args) { requests.push({ thisArg: this, args }); return requestResult; },
  };
  const childSetter = () => 'native-child';
  const api = {
    setPort(...args) { setters.push({ thisArg: this, args }); return setterResult; },
    setChildLanguageServerInfo: childSetter,
  };
  const request = http.request;
  const setPort = api.setPort;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    URL,
    require(name) {
      if (name === 'node:url') return url;
      assert.equal(name, 'node:module');
      return { createRequire(nativePath) {
        paths.push(nativePath);
        return name => {
          if (name === 'http') return http;
          if (name === 'vscode') return { windsurfLanguageServer: api };
          throw new Error(`Unexpected native module: ${name}`);
        };
      } };
    },
  }, { filename: 'ls-injection.cjs' });
  function bridge(port) { return { port, close() { closed.push(port); } }; }
  function createBridge(port) { created.push(port); return bridge(port + 10000); }
  function beat(port, host = '127.0.0.1') {
    return http.request(`http://${host}:${port}${HEARTBEAT}`, { method: 'POST' });
  }
  function install(options = {}) {
    return module.exports.installLsInjection({ nativeMainPath: NATIVE_MAIN, createBridge,
      log: message => logs.push(message), ...options });
  }
  return { http, api, requests, setters, paths, logs, closed, created, requestResult, setterResult,
    request, setPort, bridge, createBridge, beat, install, childSetter };
}

test('late activation learns the running native LS from Heartbeat and preserves its call', async () => {
  const f = fixture();
  const handle = await f.install();
  const callback = () => {};
  const context = {};
  const address = `http://127.0.0.1:4567${HEARTBEAT}`;
  const options = { method: 'POST', headers: { 'x-codeium-csrf-token': 'private-csrf' } };
  assert.equal(f.http.request.call(context, address, options, callback), f.requestResult);
  assert.equal(f.requests[0].thisArg, context);
  assert.equal(f.requests[0].args[1], options);
  assert.equal(f.requests[0].args[2], callback);
  await tick();
  assert.deepEqual(f.created, [4567]);
  assert.deepEqual(f.setters[0].args, [14567]);
  assert.equal(handle.status.state, 'ready');
  assert.equal(handle.status.originalPort, 4567);
  assert.equal(handle.status.proxyPort, 14567);
  assert.deepEqual(f.paths, [NATIVE_MAIN]);
  assert.equal(f.api.setChildLanguageServerInfo, f.childSetter);
  assert.ok(f.logs.every(line => !line.includes('private-csrf')));
  await handle.dispose();
});

test('early activation wraps setPort without changing return value, this, or extra arguments', async () => {
  const f = fixture();
  const handle = await f.install();
  const context = {};
  const extra = { futureArgument: true };
  assert.equal(f.api.setPort.call(context, 4567, extra), f.setterResult);
  assert.deepEqual(f.setters[0].args, [4567, extra]);
  await tick();
  assert.equal(f.setters[1].thisArg, context);
  assert.equal(f.setters[1].args[1], extra);
  assert.equal(f.setters[1].args[0], 14567);
  assert.equal(f.api.setPort.call(context, 4567, extra), f.setterResult);
  assert.equal(f.setters.at(-1).args[0], 14567);
  assert.deepEqual(f.created, [4567]);
  await handle.dispose();
  assert.equal(f.setters.at(-1).args[0], 4567);
  assert.equal(f.setters.at(-1).thisArg, context);
});

test('address discovery rejects non-heartbeat, non-loopback, non-HTTP, socket, and wrong-method calls', async () => {
  const f = fixture();
  const handle = await f.install();
  const requests = [
    ['http://server.codeium.com:4567' + HEARTBEAT, { method: 'POST' }],
    ['http://127.0.0.1.evil.test:4567' + HEARTBEAT, { method: 'POST' }],
    ['http://a.localhost:4567' + HEARTBEAT, { method: 'POST' }],
    ['https://127.0.0.1:4567' + HEARTBEAT, { method: 'POST' }],
    ['http://127.0.0.1:4567' + HEARTBEAT + '?x=1', { method: 'POST' }],
    ['http://127.0.0.1:4567/other/Heartbeat', { method: 'POST' }],
    ['http://127.0.0.1:4567' + HEARTBEAT, { method: 'GET' }],
    [{ hostname: 'localhost', port: 4567, path: HEARTBEAT, method: 'POST', socketPath: '/tmp/test.sock' }],
    [{ hostname: 'localhost', port: '4567bad', path: HEARTBEAT, method: 'POST' }],
    [{ hostname: 'localhost', port: 65536, path: HEARTBEAT, method: 'POST' }],
  ];
  for (const args of requests) assert.equal(f.http.request(...args), f.requestResult);
  await tick();
  assert.equal(f.requests.length, requests.length);
  assert.deepEqual(f.created, []);
  await handle.dispose();
});

test('accepts Node URL and options overloads without reading headers or payload', async () => {
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    const f = fixture();
    const handle = await f.install();
    const addressHost = host === '::1' ? '[::1]' : host;
    const options = { method: 'POST' };
    Object.defineProperty(options, 'headers', { get() { throw new Error('Must not read headers'); } });
    Object.defineProperty(options, 'body', { get() { throw new Error('Must not read body'); } });
    f.http.request(new URL(`http://${addressHost}:4567${HEARTBEAT}`), options);
    await tick();
    assert.deepEqual(f.created, [4567]);
    await handle.dispose();
  }
  const f = fixture();
  const handle = await f.install();
  f.http.request({ host: 'localhost', port: '4567', path: HEARTBEAT, method: 'POST' });
  await tick();
  assert.deepEqual(f.created, [4567]);
  await handle.dispose();
});

test('native request exceptions are preserved and cannot start a bridge', async () => {
  const f = fixture();
  const failure = new Error('native failure');
  f.http.request = () => { throw failure; };
  const handle = await f.install();
  assert.throws(() => f.beat(4567), error => error === failure);
  await tick();
  assert.deepEqual(f.created, []);
  await handle.dispose();
});

test('same native object installs once and discovery does not create duplicate bridges', async () => {
  const f = fixture();
  const pending = deferred();
  let count = 0;
  const handle = await f.install({ createBridge() { count++; return pending.promise; } });
  assert.equal(await f.install(), handle);
  f.beat(4567);
  f.beat(4567);
  f.api.setPort(4567);
  await tick();
  assert.equal(count, 1);
  pending.resolve(f.bridge(14567));
  await tick();
  f.beat(4567);
  f.beat(14567);
  f.api.setPort(14567);
  await tick();
  assert.equal(count, 1);
  await handle.dispose();
});

test('LS restart swaps the bridge and closes its predecessor', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await tick();
  f.api.setPort(5678);
  await tick();
  assert.deepEqual(f.created, [4567, 5678]);
  assert.deepEqual(f.closed, [14567]);
  assert.equal(handle.status.originalPort, 5678);
  assert.equal(handle.status.proxyPort, 15678);
  await handle.dispose();
  assert.deepEqual(f.closed, [14567, 15678]);
  assert.equal(f.setters.at(-1).args[0], 5678);
});

test('superseded pending creations close without publishing their port', async () => {
  const f = fixture();
  const first = deferred();
  const second = deferred();
  const handle = await f.install({ createBridge: port => port === 4567 ? first.promise : second.promise });
  f.beat(4567);
  await tick();
  f.beat(5678);
  await tick();
  second.resolve(f.bridge(15678));
  await tick();
  first.resolve(f.bridge(14567));
  await tick();
  assert.deepEqual(f.setters.map(call => call.args[0]), [15678]);
  assert.deepEqual(f.closed, [14567]);
  assert.equal(handle.status.originalPort, 5678);
  await handle.dispose();
});

test('returning to active LS invalidates a different pending replacement', async () => {
  const f = fixture();
  const other = deferred();
  const handle = await f.install({ createBridge: port => port === 4567 ? f.bridge(14567) : other.promise });
  f.beat(4567);
  await tick();
  f.beat(5678);
  await tick();
  f.beat(4567);
  other.resolve(f.bridge(15678));
  await tick();
  assert.equal(handle.status.proxyPort, 14567);
  assert.deepEqual(f.closed, [15678]);
  assert.ok(!f.setters.some(call => call.args[0] === 15678));
  await handle.dispose();
});

test('dispose cancels creation before it starts and cleans up late completions', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await handle.dispose();
  await tick();
  assert.deepEqual(f.created, []);
  assert.equal(handle.status.state, 'disposed');

  const late = fixture();
  const pending = deferred();
  const lateHandle = await late.install({ createBridge: () => pending.promise });
  late.beat(4567);
  await tick();
  await lateHandle.dispose();
  pending.resolve(late.bridge(14567));
  await tick();
  assert.deepEqual(late.closed, [14567]);
  assert.deepEqual(late.setters, []);
  assert.equal(lateHandle.status.pending, 0);
});

test('dispose restores descriptors and native port, then permits a fresh installation', async () => {
  const f = fixture();
  const httpDescriptor = Object.getOwnPropertyDescriptor(f.http, 'request');
  const apiDescriptor = Object.getOwnPropertyDescriptor(f.api, 'setPort');
  const handle = await f.install();
  f.beat(4567);
  await tick();
  const disposal = handle.dispose();
  assert.equal(handle.dispose(), disposal);
  await disposal;
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.http, 'request'), httpDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.api, 'setPort'), apiDescriptor);
  assert.equal(f.setters.at(-1).args[0], 4567);
  assert.deepEqual(f.closed, [14567]);
  const next = await f.install();
  assert.notEqual(next, handle);
  await next.dispose();
});

test('dispose never overwrites another extension\'s newer hooks', async () => {
  const f = fixture();
  const handle = await f.install();
  f.beat(4567);
  await tick();
  const ourRequest = f.http.request;
  const ourSetter = f.api.setPort;
  const newerRequest = function (...args) { return ourRequest.apply(this, args); };
  const newerSetter = function (...args) { return ourSetter.apply(this, args); };
  f.http.request = newerRequest;
  f.api.setPort = newerSetter;
  await handle.dispose();
  assert.equal(f.http.request, newerRequest);
  assert.equal(f.api.setPort, newerSetter);
  assert.equal(f.setters.at(-1).args[0], 4567);
  assert.deepEqual(f.closed, [14567]);
  f.beat(4567);
  assert.equal(f.api.setPort(4567), f.setterResult);
  await tick();
  assert.deepEqual(f.created, [4567]);
});

test('creation failure is contained, safely logged, and retried on the next heartbeat', async () => {
  const f = fixture();
  let count = 0;
  const handle = await f.install({ createBridge: () => {
    if (!count++) throw new Error('secret-should-never-appear');
    return f.bridge(14567);
  } });
  f.beat(4567);
  await tick();
  assert.equal(handle.status.state, 'error');
  assert.ok(f.logs.every(line => !line.includes('secret-should-never-appear')));
  f.beat(4567);
  await tick();
  assert.equal(handle.status.state, 'ready');
  assert.equal(count, 2);
  await handle.dispose();
});

test('invalid bridge ports are closed without redirecting the native LS', async () => {
  for (const port of [0, 65536, 4567, 'not-a-port']) {
    const f = fixture();
    const handle = await f.install({ createBridge: () => f.bridge(port) });
    f.beat(4567);
    await tick();
    assert.deepEqual(f.closed, [port]);
    assert.deepEqual(f.setters, []);
    assert.equal(handle.status.state, 'error');
    await handle.dispose();
  }
});

test('unavailable or frozen native API fails without leaving a request hook installed', async () => {
  const f = fixture();
  Object.defineProperty(f.api, 'setPort', { value: f.setPort, writable: false });
  await assert.rejects(f.install(), /read only|Cannot assign/i);
  assert.equal(f.http.request, f.request);
  assert.equal(f.api.setPort, f.setPort);
});
