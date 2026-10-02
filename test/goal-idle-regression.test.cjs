'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createGoalController } = require('../src/runtime/goal-state.cjs');
const store = require('../src/runtime/goal-store.cjs');
const reportCli = require('../src/runtime/goal-report.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Only the native ACP boundary is mocked: transport, controller and report
// capability validation below use the actual runtime implementations.
function fixture(t, protocolVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-idle-regression-'));
  const api = { registerConnection() { return { dispose() {} }; } };
  const module = { exports: {} };
  const source = fs.readFileSync(process.env.GOAL_CONTINUE_TEST_SOURCE || path.resolve(__dirname, '../src/runtime/goal-continue.cjs'), 'utf8');
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (name === 'node:crypto') return require(name);
      assert.equal(name, 'node:module');
      return { createRequire: () => () => ({ windsurfAcp: api }) };
    }
  }, { filename: 'goal-continue.cjs' });
  const transport = module.exports.installGoalContinue({ nativeMainPath: '/isolated/native.js', isEnabled: () => true });
  const timers = new Map();
  let timerId = 0;
  const scheduler = {
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const controller = createGoalController({ root, transport, scheduler, reportCliPath: path.resolve(__dirname, '../src/runtime/goal-report.cjs') });
  const pending = [];
  const connector = {
    agentId: 'devin-cli', bundled: true, location: { kind: 'local' }, protocolVersion, sent: [], forwards: [], forwardError: false,
    sendRequest(request) {
      this.sent.push(request);
      if (request.method !== 'session/prompt' || protocolVersion >= 2) return Promise.resolve({});
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    forwardClientRequest(request) {
      if (this.forwardError) throw new Error('local reply failed');
      this.forwards.push(request);
    }
  };
  api.registerConnection(connector);
  t.after(() => { controller.dispose(); transport.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const goal = () => controller.snapshot().goals[0];
  const state = (state, stopReason = 'end_turn') => connector.forwardClientRequest({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'state_update', state, stopReason } } });
  const send = text => connector.sendRequest({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text }] } });
  const finish = async (index = pending.length - 1) => {
    if (protocolVersion === 1) pending[index].resolve({ stopReason: 'end_turn' });
    else { state('running'); state('idle'); }
    await tick();
  };
  const submit = status => {
    const run = goal().activeRun;
    const dir = store.capabilitiesDirectory(root);
    const file = fs.readdirSync(dir).find(file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).runId === run);
    const result = reportCli.submit({ store: root, token: file.replace(/\.json$/, ''), status, evidence: 'isolated regression evidence' });
    assert.equal(result.ok, true);
  };
  return { root, transport, controller, connector, pending, timers, goal, state, send, finish, submit,
    async flushTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await tick(); },
    prompts: () => connector.sent.filter(request => request.method === 'session/prompt').length
  };
}

for (const protocol of [1, 2]) {
  for (const status of ['waiting', 'blocked']) {
    test(`v${protocol}: ${status} requires a new ordinary user turn, never repeated idle or /goal status`, async t => {
      const h = fixture(t, protocol);
      const start = h.send('/goal finish the task');
      h.submit(status);
      await h.finish();
      await start;
      assert.equal(h.goal().status, status);
      for (let i = 0; i < 3; i++) h.state('idle');
      await h.flushTimers();
      assert.equal(h.goal().status, status);
      assert.equal(h.prompts(), 1);
      const query = h.send('/goal status');
      await h.finish();
      await query;
      h.state('idle');
      await h.flushTimers();
      assert.equal(h.goal().status, status);
      assert.equal(h.prompts(), 2);
      const answer = h.send('Here is the requested answer; proceed.');
      if (protocol === 2) {
        await answer;
        assert.equal(h.goal().status, status, 'v2 acknowledgement does not complete user turn');
        h.state('idle');
        assert.equal(h.goal().status, status, 'stale idle before user running cannot complete its turn');
      }
      await h.finish();
      await answer;
      assert.equal(h.goal().status, 'active');
      assert.equal(h.timers.size, 1);
      h.state('idle'); h.state('idle');
      assert.equal(h.timers.size, 1, 'completion is consumed once');
      await h.flushTimers();
      assert.equal(h.prompts(), 4, 'one automatic continuation follows the answer');
      assert.equal(h.goal().runsStarted, 2);
    });
  }

  test(`v${protocol}: command reply cannot finish an existing Goal and pause still sends cancellation`, async t => {
    const h = fixture(t, protocol);
    const start = h.send('/goal finish the task');
    // The request remains live while the command-only reply completes.
    if (protocol === 2) { await start; h.state('running'); }
    const run = h.goal().activeRun;
    h.submit('progress');
    let queryResolved = false;
    const query = h.send('/goal status').then(response => { queryResolved = true; return response; });
    await tick();
    if (protocol === 2) assert.equal(Object.keys(await query).length, 0, 'v2 local response is non-terminal');
    else assert.equal(queryResolved, false, 'v1 status waits for the existing native result');
    assert.equal(h.prompts(), 1, 'active status is displayed locally without a second model turn');
    const reply = h.connector.forwards.at(-1).params.update;
    assert.equal(reply.sessionUpdate, protocol === 2 ? 'agent_message' : 'agent_message_chunk');
    const content = protocol === 2 ? reply.content[0] : reply.content;
    assert.match(content.text, /目标：finish the task/);
    assert.equal(typeof reply.messageId, 'string');
    assert.equal(reply._meta['cognition.ai/streaming'], false);
    assert.equal(h.goal().activeRun, run);
    assert.equal(store.readGoalById(h.root, h.goal().id).missingRuns, 0);
    assert.equal(h.goal().evidence.length, 0);
    assert.equal(h.timers.size, 0);
    const pause = h.send('/goal pause');
    assert.equal(h.connector.sent.filter(request => request.method === 'session/cancel').length, 1);
    assert.equal(h.goal().status, 'paused');
    await h.finish();
    await pause;
    if (protocol === 1) { await h.finish(0); await start; assert.equal((await query).stopReason, 'end_turn'); }
    h.state('idle');
    assert.equal(h.goal().status, 'paused');
    assert.equal(h.timers.size, 0);
  });
}

for (const protocol of [1, 2]) {
  test(`v${protocol}: original Goal result still applies its report after a local command reply`, async t => {
    const h = fixture(t, protocol);
    const start = h.send('/goal finish the task');
    if (protocol === 2) { await start; h.state('running'); }
    const query = h.send('/goal status');
    // Resume on an already active Goal returns a command-only error locally too.
    const resume = h.send('/goal resume');
    assert.equal(h.prompts(), 1);
    h.submit('waiting');
    await h.finish(0); await start; await query; await resume;
    assert.equal(h.goal().status, 'waiting');
    assert.equal(h.goal().evidence.length, 1);
    h.state('idle');
    assert.equal(h.goal().status, 'waiting');
    assert.equal(h.timers.size, 0);
  });
}

test('v1: local command reply failure retains cancellation for the original Goal', async t => {
  const h = fixture(t, 1);
  const start = h.send('/goal finish the task');
  const run = h.goal().activeRun;
  h.connector.forwardError = true;
  assert.throws(() => h.send('/goal status'), /local reply failed/);
  h.connector.forwardError = false;
  assert.equal(h.goal().activeRun, run);
  assert.equal(h.transport.cancel('s1', run).ok, true);
  assert.equal(h.connector.sent.filter(request => request.method === 'session/cancel').length, 1);
  await h.finish(0); await start;
});

for (const protocol of [1, 2]) {
  for (const stopReason of ['cancelled', 'refusal', 'max_tokens', 'unknown', null]) {
    test(`v${protocol}: ordinary turn with ${stopReason} cannot resume a waiting Goal`, async t => {
      const h = fixture(t, protocol);
      const start = h.send('/goal finish the task');
      h.submit('waiting');
      await h.finish(); await start;
      const answer = h.send('answer');
      if (protocol === 1) h.pending.at(-1).resolve(stopReason === null ? {} : { stopReason });
      else { h.state('running'); h.state('idle', stopReason); }
      await answer; await tick();
      assert.equal(h.goal().status, 'waiting');
      assert.equal(h.timers.size, 0);
      h.state('idle');
      assert.equal(h.goal().status, 'waiting', 'consumed rejected completion cannot be retried as success');
    });
  }
}

// Installed native parser is an additional local check, not a CI dependency.
const nativeAcpPath = '/Applications/Devin.app/Contents/Resources/app/node_modules/@exa/windsurf-acp/index.cjs';
test('installed ACP distinguishes non-terminal v2 local acknowledgement from the real v1 result', { skip: !fs.existsSync(nativeAcpPath) }, () => {
  const native = require(nativeAcpPath);
  const request = { method: 'session/prompt', params: { sessionId: 's1' } };
  assert.equal(native.isTurnCompletingPromptResponse(request, {}), false);
  assert.equal(native.isTurnCompletingPromptResponse(request, { stopReason: 'end_turn' }), true);
});

for (const protocol of [1, 2]) {
  test(`v${protocol}: status during an ordinary answer preserves that live user turn`, async t => {
    const h = fixture(t, protocol);
    const start = h.send('/goal finish the task');
    h.submit('waiting');
    await h.finish(); await start;
    const answer = h.send('the requested answer');
    const query = h.send('/goal status');
    await tick();
    assert.equal(h.prompts(), 2, 'status does not send another model prompt');
    assert.equal(h.goal().status, 'waiting');
    await h.finish(1); await answer; await query;
    assert.equal(h.goal().status, 'active');
    assert.equal(h.timers.size, 1);
  });
}
