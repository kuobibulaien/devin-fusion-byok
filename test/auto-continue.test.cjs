'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createManager } = require('../src/panel/model.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/runtime/auto-continue.cjs'), 'utf8');
const NATIVE_MAIN = '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/dist/extension.js';

function fixture() {
  const registrations = [], logs = [];
  const disposable = { dispose() {} };
  const api = { registerConnection(...args) { registrations.push({ thisArg: this, args }); return disposable; } };
  const originalRegister = api.registerConnection;
  const module = { exports: {} };

  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'node:crypto') return require('node:crypto');
      assert.equal(name, 'node:module');
      return {
        createRequire(nativePath) {
          return modName => {
            assert.equal(modName, 'vscode');
            return {
              windsurfAcp: api,
              CancellationToken: { None: Symbol('CancellationToken.None') }
            };
          };
        }
      };
    }
  }, { filename: 'auto-continue.cjs' });

  function install(options) {
    return module.exports.installAutoContinue({
      nativeMainPath: NATIVE_MAIN,
      log: (event, data) => logs.push({ event, data }),
      ...options
    });
  }

  return { api, originalRegister, registrations, disposable, logs, install, matchesProviderError: module.exports.matchesProviderError };
}

function fakeScheduler() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, { fn, time: currentTime + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      currentTime += ms;
      const ready = [...timers.entries()]
        .filter(([, t]) => t.time <= currentTime)
        .sort((a, b) => a[1].time - b[1].time);
      for (const [id, t] of ready) {
        if (timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pendingCount() {
      return timers.size;
    }
  };
}

test('matchesProviderError recognizes exact suffix with and without period', () => {
  const f = fixture();
  assert.equal(f.matchesProviderError('Provider response could not be completed'), true);
  assert.equal(f.matchesProviderError('Provider response could not be completed.'), true);
  assert.equal(f.matchesProviderError('Some prefix text... Provider response could not be completed'), true);
  assert.equal(f.matchesProviderError('Some prefix text... Provider response could not be completed.\n'), true);
  assert.equal(f.matchesProviderError('Provider response could not be completed and more text'), false);
  assert.equal(f.matchesProviderError('Mentioning Provider response could not be completed in a question?'), false);
  assert.equal(f.matchesProviderError('Normal completed response.'), false);
  assert.equal(f.matchesProviderError(''), false);
  assert.equal(f.matchesProviderError(null), false);
});

test('auto continue handles v1 fail -> continue -> success with backoff and synthetic chunk', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  let enabled = true;
  const handle = f.install({
    isEnabled: () => enabled,
    scheduler
  });
  t.after(() => handle.dispose());

  const clientMessages = [];
  const serverCalls = [];
  let promptCount = 0;

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(request, token) {
      serverCalls.push(request);
      if (request.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest(request) {
      clientMessages.push(request);
    }
  };

  f.api.registerConnection(connector);

  const prompt1 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Error: Provider response could not be completed' }
      }
    }
  });

  await new Promise(r => setImmediate(r));

  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(promptCount, 1);

  scheduler.advance(1000);
  assert.equal(promptCount, 1);

  scheduler.advance(1000);
  assert.equal(promptCount, 2);

  const continueCall = serverCalls[1];
  assert.equal(continueCall.method, 'session/prompt');
  assert.equal(continueCall.params.prompt[0].type, 'text');
  assert.equal(continueCall.params.prompt[0].text, 'continue');
  assert.equal(continueCall.params.sessionId, 's1');

  const optimisticMsg = clientMessages.find(m => m.params?.update?.sessionUpdate === 'user_message_chunk');
  assert.ok(optimisticMsg);
  assert.equal(optimisticMsg.params.update.content.text, 'continue');
  assert.equal(optimisticMsg.params.update._meta['cognition.ai/isOptimistic'], true);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'All done now successfully!' }
      }
    }
  });

  const finalResult = await prompt1;
  assert.deepEqual(finalResult, { stopReason: 'end_turn' });
  assert.equal(scheduler.pendingCount(), 0);
});

test('auto continue handles v2 idle completion, duplicate idle suppression, and backoff', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  const clientMessages = [];
  const serverCalls = [];
  let promptCalls = 0;

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    get protocolVersion() { return 2; },
    sendRequest(request) {
      serverCalls.push(request);
      if (request.method === 'session/prompt') {
        promptCalls++;
        return Promise.resolve({ acknowledgment: true });
      }
      return Promise.resolve({});
    },
    forwardClientRequest(request) {
      clientMessages.push(request);
    }
  };

  f.api.registerConnection(connector);

  await connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's2', prompt: [{ type: 'text', text: 'start' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Some text... Provider response could not be completed.' }
      }
    }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's2',
      update: {
        sessionUpdate: 'state_update',
        state: 'idle'
      }
    }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's2',
      update: {
        sessionUpdate: 'state_update',
        state: 'idle'
      }
    }
  });

  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(promptCalls, 1);

  scheduler.advance(2000);
  assert.equal(promptCalls, 2);

  const synthetic = clientMessages.find(m => m.params?.update?.sessionUpdate === 'user_message');
  assert.ok(synthetic);
  assert.equal(synthetic.params.update.content[0].type, 'text');
  assert.equal(synthetic.params.update.content[0].text, 'continue');

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm2',
        content: { type: 'text', text: 'Failed again: Provider response could not be completed' }
      }
    }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's2',
      update: {
        sessionUpdate: 'state_update',
        state: 'idle'
      }
    }
  });

  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCalls, 2);
  scheduler.advance(2000);
  assert.equal(promptCalls, 3);
});

test('manual cancel cancels scheduled retry and resolves v1 turn', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(request) {
      if (request.method === 'session/prompt') {
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };

  f.api.registerConnection(connector);

  const promptPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-cancel', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-cancel',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider response could not be completed.' }
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  await connector.sendRequest({
    method: 'session/cancel',
    params: { sessionId: 's-cancel' }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const result = await promptPromise;
  assert.deepEqual(result, { stopReason: 'end_turn' });

  scheduler.advance(10000);
  assert.equal(handle.status().autoContinueCount, 0);
});

test('subsequent normal text or subagent update cancels eligibility', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(request) {
      return Promise.resolve({ stopReason: 'end_turn' });
    },
    forwardClientRequest() {}
  };

  f.api.registerConnection(connector);

  const promptPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-normal', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-normal',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider response could not be completed' }
      }
    }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-normal',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' - recovered and finished normally.' }
      }
    }
  });

  await promptPromise;
  assert.equal(scheduler.pendingCount(), 0);

  const subagentPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-sub', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-sub',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider response could not be completed' },
        _meta: { 'cognition.ai/subagent_context': { parentAgentId: 'main', runId: 'sub-1' } }
      }
    }
  });

  await subagentPromise;
  assert.equal(scheduler.pendingCount(), 0);
});

test('foreign connectors and non-local locations are ignored', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCalls = 0;
  const cloudConnector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'cloud' },
    protocolVersion: 1,
    sendRequest() {
      promptCalls++;
      return Promise.resolve({ stopReason: 'end_turn' });
    }
  };

  f.api.registerConnection(cloudConnector);
  await cloudConnector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 'cloud-s', prompt: [{ type: 'text', text: 'test' }] }
  });

  assert.equal(handle.status().connections, 0);
  assert.equal(scheduler.pendingCount(), 0);
});

test('reset and toggle off clears pending timers and active turns', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  let enabled = true;
  const handle = f.install({
    isEnabled: () => enabled,
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    get protocolVersion() { return 2; },
    sendRequest() { return Promise.resolve({}); },
    forwardClientRequest() {}
  };

  f.api.registerConnection(connector);

  await connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-reset', prompt: [{ type: 'text', text: 'run' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-reset',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Provider response could not be completed' }
      }
    }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-reset',
      update: { sessionUpdate: 'state_update', state: 'idle' }
    }
  });

  assert.equal(scheduler.pendingCount(), 1);

  handle.reset();
  assert.equal(scheduler.pendingCount(), 0);

  enabled = false;
  scheduler.advance(10000);
  assert.equal(handle.status().autoContinueCount, 0);
});

test('cancellation before first response, reset/dispose during in-flight auto, and multi-session isolation', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  let promptResolveS1;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        if (req.params?.sessionId === 's-early-cancel') {
          return Promise.resolve({ stopReason: 'cancelled' });
        }
        if (req.params?.sessionId === 'session-1') {
          return new Promise(resolve => { promptResolveS1 = resolve; });
        }
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };

  f.api.registerConnection(connector);

  const cancelledPrompt = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-early-cancel', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-early-cancel',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider response could not be completed' }
      }
    }
  });

  const res = await cancelledPrompt;
  assert.equal(res.stopReason, 'cancelled');
  assert.equal(scheduler.pendingCount(), 0);

  const promptS1 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 's1' }] }
  });
  const promptS2 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 'session-2', prompt: [{ type: 'text', text: 's2' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider response could not be completed' }
      }
    }
  });

  promptResolveS1({ stopReason: 'end_turn' });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  handle.reset();
  assert.equal(scheduler.pendingCount(), 0);
});

test('manager setAutoContinue persists setting with boolean validation and updates public state', async () => {
  let savedConfig = { enabled: true, providers: [] };
  const manager = createManager({
    read: () => savedConfig,
    write: c => { savedConfig = c; }
  });

  const s0 = manager.state();
  assert.equal(s0.autoContinueOnProviderError, false);

  await assert.rejects(manager.dispatch('setAutoContinue', { enabled: 'true' }), /自动继续/);
  await assert.rejects(manager.dispatch('setAutoContinue', { enabled: 1 }), /自动继续/);

  const s1 = await manager.dispatch('setAutoContinue', { enabled: true });
  assert.equal(s1.autoContinueOnProviderError, true);
  assert.equal(savedConfig.autoContinueOnProviderError, true);

  const s2 = await manager.dispatch('setAutoContinue', { enabled: false });
  assert.equal(s2.autoContinueOnProviderError, false);
  assert.equal(savedConfig.autoContinueOnProviderError, false);
});

test('rejected exact error triggers auto continue whereas arbitrary error or auth does not', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  let failWithExact = true;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        if (failWithExact) {
          return Promise.reject(new Error('Provider response could not be completed'));
        }
        return Promise.reject(new Error('Authentication failed / 401 Unauthorized'));
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };

  f.api.registerConnection(connector);

  const p1 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-rej-exact', prompt: [{ type: 'text', text: 'hi' }] }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  failWithExact = false;
  scheduler.advance(2000);
  assert.equal(promptCount, 2);

  await assert.rejects(p1, /Authentication failed/);
  assert.equal(scheduler.pendingCount(), 0);
});

test('v2 requires_action interleaving and state transitions clear pending retry', async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    get protocolVersion() { return 2; },
    sendRequest() { return Promise.resolve({}); },
    forwardClientRequest() {}
  };

  f.api.registerConnection(connector);

  await connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-v2-req', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-v2-req',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Provider response could not be completed' }
      }
    }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-v2-req',
      update: { sessionUpdate: 'state_update', state: 'requires_action' }
    }
  });

  assert.equal(scheduler.pendingCount(), 0);
});

test('actual session/cancel before native deferred result settles original promise without hang', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, scheduler });
  t.after(() => handle.dispose());

  let nativeResolve;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        return new Promise(resolve => { nativeResolve = resolve; });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const promptPromise = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-cancel-before', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-cancel-before',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
    }
  });

  await connector.sendRequest({
    method: 'session/cancel',
    params: { sessionId: 's-cancel-before' }
  });

  nativeResolve({ stopReason: 'cancelled' });
  const result = await promptPromise;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(scheduler.pendingCount(), 0);
});

test('auto inflight cancel, reset, dispose properly settles awaited original promise', { timeout: 1000 }, async t => {
  for (const action of ['cancel', 'reset', 'dispose']) {
    const f = fixture();
    const scheduler = fakeScheduler();
    const handle = f.install({ isEnabled: () => true, scheduler });

    let nativeResolve1;
    let nativeResolveAuto;
    let callIndex = 0;
    const connector = {
      agentId: 'devin-cli',
      bundled: true,
      location: { kind: 'local' },
      protocolVersion: 1,
      sendRequest(req) {
        if (req.method === 'session/prompt') {
          callIndex++;
          if (callIndex === 1) return new Promise(r => { nativeResolve1 = r; });
          if (callIndex === 2) return new Promise(r => { nativeResolveAuto = r; });
        }
        return Promise.resolve({});
      },
      forwardClientRequest() {}
    };
    f.api.registerConnection(connector);

    const originalPrompt = connector.sendRequest({
      method: 'session/prompt',
      params: { sessionId: 's-inflight-' + action, prompt: [{ type: 'text', text: 'hi' }] }
    });

    connector.forwardClientRequest({
      method: 'session/update',
      params: {
        sessionId: 's-inflight-' + action,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
      }
    });

    nativeResolve1({ stopReason: 'end_turn' });
    await new Promise(r => setImmediate(r));
    assert.equal(scheduler.pendingCount(), 1);

    scheduler.advance(2000);
    assert.equal(callIndex, 2);

    if (action === 'cancel') {
      await connector.sendRequest({
        method: 'session/cancel',
        params: { sessionId: 's-inflight-' + action }
      });
    } else if (action === 'reset') {
      handle.reset();
    } else if (action === 'dispose') {
      handle.dispose();
    }

    nativeResolveAuto({ stopReason: 'end_turn' });
    const finalRes = await originalPrompt;
    assert.equal(finalRes.stopReason, 'end_turn');
    assert.equal(scheduler.pendingCount(), 0);
    handle.dispose();
  }
});

test('double failures then success in v1 with exact backoff 2s then 4s and zero leftover timers', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, scheduler });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-double', prompt: [{ type: 'text', text: 'run' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-double',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(1999);
  assert.equal(promptCount, 1);
  scheduler.advance(1);
  assert.equal(promptCount, 2);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-double',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(3999);
  assert.equal(promptCount, 2);
  scheduler.advance(1);
  assert.equal(promptCount, 3);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-double',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Now successful response.' } }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
});

test('v2 rejected auto prompt is safely handled without unhandled rejection', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, scheduler });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    get protocolVersion() { return 2; },
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        if (promptCount === 1) return Promise.resolve({ acknowledgment: true });
        return Promise.reject(new Error('Network error on auto continue'));
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  await connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-v2-rej', prompt: [{ type: 'text', text: 'start' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-v2-rej',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
    }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: { sessionId: 's-v2-rej', update: { sessionUpdate: 'state_update', state: 'idle' } }
  });

  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCount, 2);
  await new Promise(r => setImmediate(r));
  assert.ok(f.logs.some(l => l.event === 'auto-continue-send-error'));
});

test('ack with non-string stopReason never retries and settles deferred', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, scheduler });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      return Promise.resolve({ stopReason: undefined });
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-ack-test', prompt: [{ type: 'text', text: 'hi' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-ack-test',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, undefined);
  assert.equal(scheduler.pendingCount(), 0);
});

test('actual thought and tool kinds reset tail so error in thought is never retried', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({ isEnabled: () => true, scheduler });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest() { return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-thought', prompt: [{ type: 'text', text: 'think' }] }
  });

  for (const kind of ['agent_thought_chunk', 'agent_thought', 'tool_call_update', 'tool_call_content_chunk']) {
    connector.forwardClientRequest({
      method: 'session/update',
      params: {
        sessionId: 's-thought',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider response could not be completed' } }
      }
    });
    connector.forwardClientRequest({
      method: 'session/update',
      params: {
        sessionId: 's-thought',
        update: { sessionUpdate: kind, content: { type: 'text', text: 'internal note' } }
      }
    });
  }

  await p;
  assert.equal(scheduler.pendingCount(), 0);
});

test('frozen connector rollback cleans up on partial attachment failure', t => {
  const f = fixture();
  const handle = f.install({ isEnabled: () => true });
  t.after(() => handle.dispose());

  const frozenConnector = Object.freeze({
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest() { return Promise.resolve({}); },
    forwardClientRequest() {}
  });

  assert.doesNotThrow(() => {
    f.api.registerConnection(frozenConnector);
  });
  assert.equal(handle.status().connections, 0);
});

test('plan tracking v1/v2: pending->pending->completed sends exactly 2 continues then stops', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-multi', prompt: [{ type: 'text', text: 'do task' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-multi',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'pending' },
          { content: 'Step 2', status: 'pending' }
        ]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(2000);
  assert.equal(promptCount, 2);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-multi',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'in_progress' }
        ]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.advance(4000);
  assert.equal(promptCount, 3);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-multi',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'completed' }
        ]
      }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  scheduler.advance(10000);
  assert.equal(promptCount, 3);
});

test('normal end_turn with zero pending plan does not continue', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-none', prompt: [{ type: 'text', text: 'hi' }] }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('plan completion while timer is pending cancels continuation and resolves v1 promise', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-cancel-timer', prompt: [{ type: 'text', text: 'run' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-cancel-timer',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Task', status: 'pending' }]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-cancel-timer',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Task', status: 'completed' }]
      }
    }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  scheduler.advance(10000);
  assert.equal(promptCount, 1);
});

test('incoming permission request disallows retry and clears pending timer', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      return Promise.resolve({ stopReason: 'end_turn' });
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-perm', prompt: [{ type: 'text', text: 'perm' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-perm',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Step', status: 'pending' }]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  connector.forwardClientRequest({
    method: 'session/request_permission',
    params: { sessionId: 's-perm' }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
});

test('transient HTTP 429 retries whereas 401 does not', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: false }),
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest() { return Promise.resolve({ stopReason: 'end_turn' }); },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p429 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-429', prompt: [{ type: 'text', text: 'hi' }] }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-429',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 429.' } }
    }
  });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  const p401 = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-401', prompt: [{ type: 'text', text: 'hi' }] }
  });
  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-401',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Provider returned HTTP 401.' } }
    }
  });
  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1); // Only s-429 pending
});

test('manager setAutoContinueUntilPlanComplete boolean validation and public state', async () => {
  let savedConfig = { enabled: true, providers: [] };
  const manager = createManager({
    read: () => savedConfig,
    write: c => { savedConfig = c; }
  });

  const s0 = manager.state();
  assert.equal(s0.autoContinueUntilPlanComplete, false);

  await assert.rejects(manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: 'true' }), /完成待办/);
  await assert.rejects(manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: 1 }), /完成待办/);

  const s1 = await manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: true });
  assert.equal(s1.autoContinueUntilPlanComplete, true);
  assert.equal(savedConfig.autoContinueUntilPlanComplete, true);

  const s2 = await manager.dispatch('setAutoContinueUntilPlanComplete', { enabled: false });
  assert.equal(s2.autoContinueUntilPlanComplete, false);
  assert.equal(savedConfig.autoContinueUntilPlanComplete, false);
});

test('integration: serveChat simulated ACP adapter end-to-end failure then success in same session', { timeout: 2000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: false }),
    scheduler
  });
  t.after(() => handle.dispose());

  const { serveChat } = require('../src/protocol/responses.cjs');
  const wire = require('../src/protocol/wire.cjs');
  const http = require('node:http');

  let attempt = 0;
  const upstream = http.createServer((req, res) => {
    attempt++;
    if (attempt === 1) {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('Too Many Requests');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.output_text.delta","delta":"Success on retry!"}\r\n\r\n');
      res.write('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\n');
      res.end();
    }
  }).listen(0, '127.0.0.1');
  await new Promise(r => upstream.once('listening', r));
  t.after(() => upstream.close());
  const upstreamPort = upstream.address().port;

  let incomingPromptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    async sendRequest(req) {
      if (req.method === 'session/prompt') {
        incomingPromptCount++;
        assert.equal(req.params?.sessionId, 's-real-integ');
        if (incomingPromptCount === 2) {
          assert.equal(req.params?.prompt?.[0]?.text, 'continue');
        }
        const chunks = [];
        const fakeRes = new http.ServerResponse({ method: 'POST', httpVersionMajor: 1, httpVersionMinor: 1 });
        fakeRes.assignSocket(new (require('node:net').Socket)());
        fakeRes.write = chunk => { chunks.push(chunk); return true; };
        fakeRes.end = chunk => { if (chunk) chunks.push(chunk); };

        await serveChat({
          request: { modelUid: 'test-model', systemPrompt: '', messages: [] },
          route: { model: 'test-model' },
          provider: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'key', apiFormat: 'responses' },
          res: fakeRes
        });

        const fullBuffer = Buffer.concat(chunks);
        const messages = [];
        for (let offset = 0; offset < fullBuffer.length;) {
          const flags = fullBuffer[offset];
          const length = fullBuffer.readUInt32BE(offset + 1);
          let data = fullBuffer.subarray(offset + 5, offset + 5 + length);
          offset += 5 + length;
          if (!(flags & 2)) messages.push(data);
        }
        let extractedText = '';
        let stopReasonVal = 2;
        for (const msg of messages) {
          const fields = wire.parseFields(msg);
          for (const fld of fields) {
            if (fld.number === 3) extractedText += fld.value.toString('utf8');
            if (fld.number === 5) {
              const numVal = Number(fld.value);
              if (numVal === 13) stopReasonVal = 13;
            }
          }
        }

        if (extractedText) {
          connector.forwardClientRequest({
            method: 'session/update',
            params: {
              sessionId: req.params?.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: extractedText } }
            }
          });
        }

        return { stopReason: stopReasonVal === 13 ? 'unknown_error' : 'end_turn' };
      }
      return {};
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-real-integ', prompt: [{ type: 'text', text: 'call model' }] }
  });

  while (scheduler.pendingCount() === 0) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(incomingPromptCount, 1);
  assert.equal(scheduler.pendingCount(), 1);

  scheduler.advance(2000);
  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(incomingPromptCount, 2);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(attempt, 2);
});

test('TRANSIENT_HTTP_RE requires end of string: recovered suffix does not retry', () => {
  const f = fixture();
  assert.equal(f.matchesProviderError('Provider returned HTTP 429.'), true);
  assert.equal(f.matchesProviderError('Provider returned HTTP 429. recovered'), false);
  assert.equal(f.matchesProviderError('Provider returned HTTP 429. and more text'), false);
});

test('malformed, oversized, and invalid plan entries remove eligibility cleanly', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-bad-plan', prompt: [{ type: 'text', text: 'start' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-bad-plan',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'test', status: 'unknown_status' }]
      }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('terminal HTTP 401 and invalid format suppress plan continuation', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  let promptCount = 0;
  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      if (req.method === 'session/prompt') {
        promptCount++;
        return Promise.resolve({ stopReason: 'end_turn' });
      }
      return Promise.resolve({});
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-plan-blocked', prompt: [{ type: 'text', text: 'start' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-blocked',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Valid pending task', status: 'pending' }]
      }
    }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-plan-blocked',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Provider returned HTTP 401.' }
      }
    }
  });

  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(promptCount, 1);
});

test('legacy ext/method _session/elicitation and finishedOutcome cancel pending timer', { timeout: 1000 }, async t => {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: false, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());

  const connector = {
    agentId: 'devin-cli',
    bundled: true,
    location: { kind: 'local' },
    protocolVersion: 1,
    sendRequest(req) {
      return Promise.resolve({ stopReason: 'end_turn' });
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);

  const p = connector.sendRequest({
    method: 'session/prompt',
    params: { sessionId: 's-ext-elicit', prompt: [{ type: 'text', text: 'run' }] }
  });

  connector.forwardClientRequest({
    method: 'session/update',
    params: {
      sessionId: 's-ext-elicit',
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: 'Pending', status: 'pending' }]
      }
    }
  });

  await new Promise(r => setImmediate(r));
  assert.equal(scheduler.pendingCount(), 1);

  connector.forwardClientRequest({
    method: 'ext/method',
    params: {
      method: '_session/elicitation',
      params: { sessionId: 's-ext-elicit' }
    }
  });

  assert.equal(scheduler.pendingCount(), 0);
  const res = await p;
  assert.equal(res.stopReason, 'end_turn');
});

function planProgressFixture(t, protocolVersion) {
  const f = fixture();
  const scheduler = fakeScheduler();
  const handle = f.install({
    isEnabled: () => true,
    getOptions: () => ({ onProviderError: true, untilPlanComplete: true }),
    scheduler
  });
  t.after(() => handle.dispose());
  const calls = [], resolvers = [];
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion,
    sendRequest(request) {
      calls.push(request);
      return protocolVersion === 2 ? Promise.resolve({ acknowledgment: true }) :
        new Promise(resolve => resolvers.push(resolve));
    },
    forwardClientRequest() {}
  };
  f.api.registerConnection(connector);
  const sessionId = 'plan-progress';
  const update = value => connector.forwardClientRequest({
    method: 'session/update', params: { sessionId, update: value }
  });
  return {
    ...f, scheduler, handle, calls,
    prompt: () => connector.sendRequest({
      method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'task' }] }
    }),
    plan(entries, planId) {
      update(planId ? { sessionUpdate: 'plan_update', plan: { type: 'items', planId, entries } } :
        { sessionUpdate: 'plan', entries });
    },
    async finish(error = false) {
      const text = error ? 'Provider response could not be completed.' : 'Task finished; waiting for user confirmation.';
      update(protocolVersion === 2 ? {
        sessionUpdate: 'agent_message', messageId: `response-${calls.length}`, content: [{ type: 'text', text }]
      } : { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      if (protocolVersion === 2) update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      else resolvers.shift()({ stopReason: 'end_turn' });
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

for (const protocolVersion of [1, 2]) {
  for (const variant of ['no-update', 'identical', 'reordered', 'new-plan-id', 'error-recovery']) {
    test(`v${protocolVersion} stops stale plan continuation after ${variant}`, { timeout: 1000 }, async t => {
      const f = planProgressFixture(t, protocolVersion);
      const pending = [
        { content: 'Reset verified', status: 'completed' },
        { content: 'Blocked; needs user confirmation', status: 'in_progress' }
      ];
      const p = f.prompt();
      f.plan(pending, variant === 'new-plan-id' ? 'old' : undefined);
      await f.finish(variant === 'error-recovery');
      assert.equal(f.scheduler.pendingCount(), 1);
      f.scheduler.advance(2000);
      assert.equal(f.calls.length, 2);
      if (variant === 'identical') f.plan(pending);
      if (variant === 'reordered') f.plan([...pending].reverse());
      if (variant === 'new-plan-id') f.plan(pending, 'new');
      await f.finish();
      assert.equal(f.scheduler.pendingCount(), 0);
      assert.equal(f.handle.status().activeSessions, 0);
      const result = await p;
      if (protocolVersion === 1) assert.equal(result.stopReason, 'end_turn');
      const stopped = f.logs.filter(log => log.event === 'auto-continue-stopped');
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].data.reason, 'plan-no-progress');
      assert.equal(stopped[0].data.attempts, 1);
      assert.deepEqual(Object.keys(stopped[0].data).sort(), ['attempts', 'reason']);
      assert.equal(JSON.stringify(f.logs).includes('Blocked'), false);
      f.scheduler.advance(60000);
      assert.equal(f.calls.length, 2);

      const next = f.prompt();
      f.plan(pending);
      await f.finish();
      assert.equal(f.scheduler.pendingCount(), 1);
      f.scheduler.advance(2000);
      assert.equal(f.calls.length, 4);
      f.plan(pending.map(entry => ({ ...entry, status: 'completed' })));
      await f.finish();
      await next;
      assert.equal(f.scheduler.pendingCount(), 0);
      assert.equal(f.handle.status().activeSessions, 0);
    });
  }

  test(`v${protocolVersion} permits semantic progress with unchanged pending count`, { timeout: 1000 }, async t => {
    const f = planProgressFixture(t, protocolVersion);
    const p = f.prompt();
    f.plan([{ content: 'Work', status: 'pending' }]);
    await f.finish();
    f.scheduler.advance(2000);
    f.plan([{ content: 'Work', status: 'in_progress' }]);
    await f.finish();
    assert.equal(f.scheduler.pendingCount(), 1);
    f.scheduler.advance(4000);
    f.plan([{ content: 'Verify work', status: 'in_progress' }]);
    await f.finish();
    assert.equal(f.scheduler.pendingCount(), 1);
    f.scheduler.advance(8000);
    f.plan([{ content: 'Verify work', status: 'completed' }]);
    await f.finish();
    await p;
    assert.equal(f.calls.length, 4);
    assert.equal(f.scheduler.pendingCount(), 0);
    assert.equal(f.handle.status().activeSessions, 0);
    assert.equal(f.logs.some(log => log.event === 'auto-continue-stopped'), false);
  });

  test(`v${protocolVersion} preserves error retries before stopping unchanged recovered plan`, { timeout: 1000 }, async t => {
    const f = planProgressFixture(t, protocolVersion);
    const p = f.prompt();
    f.plan([{ content: 'Waiting for confirmation', status: 'in_progress' }]);
    await f.finish(true);
    f.scheduler.advance(2000);
    await f.finish(true);
    assert.equal(f.scheduler.pendingCount(), 1);
    assert.equal(f.logs.some(log => log.event === 'auto-continue-stopped'), false);
    f.scheduler.advance(4000);
    await f.finish();
    assert.equal(f.scheduler.pendingCount(), 0);
    await p;
    assert.equal(f.calls.length, 3);
    assert.equal(f.handle.status().activeSessions, 0);
    assert.equal(f.logs.filter(log => log.event === 'auto-continue-stopped').length, 1);
    assert.equal(f.logs.filter(log => log.event === 'auto-continue-scheduled').every(log => log.data.reason === 'error'), true);
  });
}
