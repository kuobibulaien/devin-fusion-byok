'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContextDiagnostics } = require('../src/runtime/context-diagnostics.cjs');
test('diagnostics are private, isolated, bounded snapshots without session payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-diagnostics-'));
  const options = { root, version: '0.3.26', readStatus: () => ({ state: 'observing', connections: 1, usageUpdates: 2, usageRejections: { 'invalid-used': 1, 'invalid-size': -1, 'never-persist': 123 }, secret: 'never-persist' }), snapshot: () => [{ sessionId: 'never-persist', lead: { used: 123 }, subagents: [{}] }], intervalMs: 60000 };
  const first = createContextDiagnostics({ ...options, pid: 123 });
  const second = createContextDiagnostics({ ...options, pid: 456 });
  try {
    const file = path.join(root, 'context-diagnostics', '123.json');
    const raw = fs.readFileSync(file, 'utf8'), data = JSON.parse(raw);
    assert.equal(data.connections, 1); assert.equal(data.leadSessions, 1); assert.equal(data.subagentUsages, 1);
    assert.equal(data.sessionUpdates, null); assert.ok(!raw.includes('never-persist')); assert.ok(!raw.includes('"used":'));
    assert.deepEqual(data.usageRejections, { 'invalid-session-id': null, 'invalid-used': 1, 'invalid-size': null, 'invalid-parent-id': null, 'invalid-run-id': null });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    first.refresh(); assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
    first.dispose(); assert.equal(JSON.parse(fs.readFileSync(file)).state, 'disposed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file), '456.json'))).state, 'observing');
  } finally { first.dispose(); second.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('diagnostic read failures never escape into the extension', () => {
  const handle = createContextDiagnostics({ root: '/unused', version: 'bad', readStatus() { throw Error('private'); }, snapshot: () => [], intervalMs: 60000 });
  assert.equal(handle.refresh(), false); handle.dispose();
});
