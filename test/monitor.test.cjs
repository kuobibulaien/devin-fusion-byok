'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMonitor, createTracker, usageOf, associate, summarize } = require('../src/runtime/monitor.cjs');
function tracker() {
  let clock = 0;
  const value = createTracker({ id: 'response-1', request: { messages: [{ messageId: 'user-1', content: 'PRIVATE' }] }, route: { model: 'test' }, provider: { id: 'p', apiKey: 'SECRET' }, now: () => clock });
  return { value, at: n => { clock = n; } };
}
test('usage separates subset counters, zero and missing; never accumulates repeated usage', () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 80 } } }, true), { inputTokens: 100, outputTokens: 0, cachedTokens: 80, reasoningTokens: null });
  assert.equal(usageOf({}, true), null);
  const t = tracker();
  t.at(100); t.value.event({ data: { choices: [{ delta: { reasoning_content: 'think' } }] } }, true);
  t.at(500); t.value.event({ data: { choices: [{ delta: { content: 'hello' } }] } }, true);
  const event = { type: 'response.completed', data: { response: { usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } } } } };
  t.at(1000); t.value.event(event, false); t.value.event(event, false);
  t.at(1000); const record = t.value.finish('success', 200);
  assert.equal(record.firstOutputMs, 100); assert.equal(record.firstTextMs, 500);
  assert.equal(record.tps, 20); assert.equal(record.outputTokens, 20);
  assert.equal(record.reasoningTokens, 10); assert.equal(record.usageComplete, true);
  assert.ok(!JSON.stringify(record).includes('SECRET')); assert.ok(!JSON.stringify(record).includes('PRIVATE'));
});
test('empty events do not count as output; tool-only and cancellation are explicit', () => {
  const t = tracker(); t.at(10); t.value.event({ data: { choices: [{ delta: { role: 'assistant', content: '' } }] } }, true);
  t.at(20); t.value.event({ type: 'response.function_call_arguments.delta', data: { delta: '{}' } }, false);
  t.at(30); const record = t.value.finish('cancelled', 200);
  assert.equal(record.firstOutputMs, 20); assert.equal(record.firstTextMs, null);
  assert.equal(record.tps, null); assert.equal(record.inputTokens, null); assert.equal(record.usageComplete, false);
});
test('exact response identity outranks shared history and ambiguity never chooses a session', () => {
  const r = tracker().value.finish('success', 200);
  const rows = [{ message_id: 'user-1', session_id: 'a' }, { message_id: 'user-1', session_id: 'b' }];
  assert.equal(associate([r], rows)[0].attribution, 'unassigned');
  assert.equal(associate([r], rows)[0].sessionId, null);
  rows.push({ message_id: 'response-1', session_id: 'b' });
  const result = associate([r], rows)[0];
  assert.equal(result.sessionId, 'b'); assert.equal(result.attribution, 'response-id');
  assert.equal(result.messageIds, undefined);
});
test('aggregate TPS is ratio of sums and unknown counts are not zeros', () => {
  const base = tracker().value.finish('success', 200);
  const summary = summarize([{ ...base, outputTokens: 10, durationMs: 1000, tps: 10 }, { ...base, outputTokens: 90, durationMs: 3000, tps: 30 }, { ...base, status: 'cancelled' }]);
  assert.deepEqual(summary.tps, { value: 30, samples: 2 });
  assert.deepEqual(summary.throughputTps, { value: 25, samples: 2 });
  assert.deepEqual(summary.outputTokens, { value: 100, reported: 2 });
  assert.deepEqual(summary.inputTokens, { value: null, reported: 0 });
  assert.equal(summary.requests, 3); assert.equal(summary.cancelled, 1);
});
test('DeepSeek cache alias, tool-bearing output, done-only text and failed samples stay honest', () => {
  assert.equal(usageOf({ usage: { prompt_cache_hit_tokens: 80 } }, true).cachedTokens, 80);
  const t = tracker();
  t.at(100); t.value.event({ type: 'response.output_text.delta', data: { delta: 'hello' } }, false);
  t.at(200); t.value.event({ type: 'response.output_item.added', data: { item: { type: 'function_call', call_id: 'tool-1', name: 'exec' } } }, false);
  t.at(1000); t.value.event({ type: 'response.completed', data: { response: { usage: { input_tokens: 20, output_tokens: 30 } } } }, false);
  const record = t.value.finish('success', 200);
  assert.equal(record.tps, null); assert.deepEqual(record.toolIds, ['tool-1']); assert.equal(record.throughputTps, 30);
  const assigned = associate([record], [{ message_id: 'tool-1', session_id: 'session-a', kind: 'tool' }])[0];
  assert.equal(assigned.sessionId, 'session-a'); assert.equal(assigned.attribution, 'tool-id');
  const ambiguous = associate([record], [{ message_id: 'tool-1', session_id: 'a', kind: 'tool' }, { message_id: 'tool-1', session_id: 'b', kind: 'tool' }])[0];
  assert.equal(ambiguous.sessionId, null); assert.equal(ambiguous.attribution, 'ambiguous');
  const doneOnly = tracker(); doneOnly.at(500);
  doneOnly.value.event({ type: 'response.completed', data: { response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { output_tokens: 5 } } } }, false);
  assert.equal(doneOnly.value.finish('success', 200).tps, null);
  assert.equal(doneOnly.value.finish('success', 200).firstTextMs, null);
  const summary = summarize([{ ...record, status: 'cancelled' }]);
  assert.equal(summary.textTtftMs.value, null); assert.equal(summary.ttftMs.samples, 0);
});

test('gateway timing includes metadata, tools and canceled usage; snapshots replace rather than merge', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-metrics-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracked = tracker();
  tracked.at(50); tracked.value.event({ type: 'done' }, true);
  tracked.at(100); tracked.value.event({ data: { choices: [{ delta: { role: 'assistant' } }] } }, true);
  tracked.at(200); tracked.value.event({ data: { choices: [{ delta: { tool_calls: [{ id: 'call-a', function: { name: 'exec', arguments: '{}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 80 } } } }, true);
  tracked.at(500); tracked.value.event({ data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } } }, true);
  tracked.at(1100);
  const monitor = createMonitor({ root, databasePath: path.join(root, 'missing.db') });
  monitor.record(tracked.value.finish('cancelled', 200));
  const snapshot = await monitor.snapshot();
  const r = snapshot.records[0];
  assert.equal(r.firstResponseMs, 100); assert.equal(r.firstOutputMs, 200);
  assert.equal(r.gatewayTps, 20); assert.equal(r.tps, null);
  assert.equal(r.usageState, 'complete'); assert.equal(r.cachedTokens, null);
  assert.equal(r.status, 'cancelled'); assert.equal(snapshot.summary.gatewayTps.value, 20);
  assert.equal(snapshot.summary.firstResponseMs.value, 100);
  monitor.record({ ...r, id: 'legacy', schemaVersion: 2 });
  monitor.record({ ...r, id: 'bad', cachedTokens: 200 });
  const next = await monitor.snapshot();
  assert.equal(next.records.find(v => v.id === 'legacy').gatewayTps, null);
  assert.equal(next.records.find(v => v.id === 'legacy').firstResponseMs, null);
  assert.equal(next.records.find(v => v.id === 'bad').usageState, 'inconsistent');
  assert.equal(next.records.find(v => v.id === 'bad').gatewayTps, null);
});

test('persists private-safe records, resolves real SQLite IDs read-only and survives restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'sessions.db');
  execFileSync('/usr/bin/sqlite3', [db, "CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT); CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); INSERT INTO message_nodes VALUES('session-a','{\"message_id\":\"response-1\"}');"]);
  const monitor = createMonitor({ root, databasePath: db });
  const record = tracker().value.finish('success', 200);
  monitor.record({ ...record, secret: 'SECRET' }); monitor.record(record);
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.records.length, 1); assert.equal(snapshot.sessions[0].sessionId, 'session-a');
  assert.equal(snapshot.records[0].attribution, 'response-id');
  assert.ok(!JSON.stringify(snapshot).includes('messageIds'));
  const file = path.join(root, 'monitor.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'));
  assert.equal((await createMonitor({ root, databasePath: db }).snapshot()).records.length, 1);
  const missing = await createMonitor({ root, databasePath: path.join(root, 'missing.db') }).snapshot();
  assert.equal(missing.sessionStatus, 'unavailable'); assert.equal(missing.records[0].sessionId, null);
});
