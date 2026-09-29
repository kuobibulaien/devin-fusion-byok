'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPickerRefresh, signatureOf } = require('../src/runtime/picker-refresh.cjs');

function harness({ models = [{ uid: 'a', label: 'A' }], fail = [] } = {}) {
  let clock = 1000, current = models;
  const timers = [], commands = [], logs = [];
  const refresh = createPickerRefresh({
    readModels: () => current,
    executeCommand: async command => { commands.push(command); if (fail.includes(command)) throw new Error('missing'); },
    log: (event, data) => logs.push({ event, ...data }),
    now: () => clock,
    schedule: (fn, ms) => { const timer = { fn, at: clock + ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  return {
    refresh, commands, logs, timers,
    set(next) { current = next; },
    advance(ms) { clock += ms; },
    async fire() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) { clock = Math.max(clock, timer.at); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('signature ignores order and tracks uid and label', () => {
  assert.equal(signatureOf([{ uid: 'b', label: 'B' }, { uid: 'a', label: 'A' }]), signatureOf([{ uid: 'a', label: 'A' }, { uid: 'b', label: 'B' }]));
  assert.notEqual(signatureOf([{ uid: 'a', label: 'A' }]), signatureOf([{ uid: 'a', label: 'Renamed' }]));
});

test('unchanged model lists never start a conversation', async () => {
  const h = harness();
  h.refresh.prime();
  assert.equal(h.refresh.changed(), false);
  await h.fire();
  assert.deepEqual(h.commands, []);
});

test('a new preset starts one debounced conversation', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'a', label: 'A' }, { uid: 'fusion-dfbyok-preset-x', label: 'ds' }]);
  assert.equal(h.refresh.changed(), true);
  assert.equal(h.timers[0].at - 1000, 1500);
  await h.fire();
  assert.deepEqual(h.commands, ['devin.newConversation']);
});

test('rapid edits collapse into a single refresh', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'b', label: 'B' }]); h.refresh.changed();
  h.set([{ uid: 'c', label: 'C' }]); h.refresh.changed();
  await h.fire();
  assert.deepEqual(h.commands, ['devin.newConversation']);
});

test('a second refresh waits until the CLI model cache is stale', async () => {
  const h = harness();
  h.refresh.prime();
  h.set([{ uid: 'b', label: 'B' }]); h.refresh.changed();
  await h.fire();
  const firstRun = 2500;
  h.advance(10000);
  h.set([{ uid: 'c', label: 'C' }]); h.refresh.changed();
  assert.equal(h.timers[0].at, firstRun + 65000);
  await h.fire();
  assert.equal(h.commands.length, 2);
});

test('falls back to the legacy command and reports when none exist', async () => {
  const fallback = harness({ fail: ['devin.newConversation'] });
  fallback.refresh.prime(); fallback.set([]); fallback.refresh.changed(); await fallback.fire();
  assert.deepEqual(fallback.commands, ['devin.newConversation', 'windsurf.triggerCascade']);
  const missing = harness({ fail: ['devin.newConversation', 'windsurf.triggerCascade'] });
  missing.refresh.prime(); missing.set([]); missing.refresh.changed(); await missing.fire();
  assert.equal(missing.logs.at(-1).event, 'picker-refresh-unavailable');
});

test('dispose cancels a pending refresh', async () => {
  const h = harness();
  h.refresh.prime(); h.set([]); h.refresh.changed();
  h.refresh.dispose();
  await h.fire();
  assert.deepEqual(h.commands, []);
  assert.equal(h.refresh.changed(), false);
});
