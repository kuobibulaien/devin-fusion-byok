'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const store = require('../src/runtime/goal-store.cjs');
const report = require('../src/runtime/goal-report.cjs');

const CLI = path.resolve(__dirname, '../src/runtime/goal-report.cjs');
function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function record(overrides = {}) {
  const timestamp = 1700000000000;
  return {
    schemaVersion: 1, id: crypto.randomBytes(16).toString('hex'), sessionId: 'session-1', revision: 1,
    objective: 'do the thing', criteria: 'it is done', status: 'active', runsStarted: 0, maxRuns: 10,
    activeRun: null, reason: null, evidence: [], missingRuns: 0, lastEvidence: null, repeatCount: 0,
    createdAt: timestamp, updatedAt: timestamp, archivedAt: null, ...overrides
  };
}
function seedGoal(base, overrides = {}) {
  const value = record(overrides);
  store.writeGoal(base, value);
  return value;
}
function capabilityFor(base, goal, run, revision = goal.revision) {
  store.writeGoal(base, { ...goal, activeRun: run, revision });
  return store.issueCapability(base, { id: goal.id, revision, run, sessionId: goal.sessionId });
}

test('goal records round-trip, are stored per session, and reject malformed records', t => {
  const base = root(t);
  const value = seedGoal(base, { sessionId: 'session-a' });
  assert.equal(store.readGoal(base, 'session-a').id, value.id);
  assert.equal(store.readGoal(base, 'session-b'), null);
  const file = store.goalFile(base, 'session-a');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionId, 'session-a');
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.writeGoal(base, { ...value, revision: 0 }), /goal_record_invalid/);
  assert.throws(() => store.writeGoal(base, { ...value, status: 'nonsense' }), /goal_record_invalid/);
  assert.throws(() => store.writeGoal(base, { ...value, maxRuns: 0 }), /goal_record_invalid/);
  assert.throws(() => store.writeGoal(base, { ...value, objective: '' }), /goal_record_invalid/);
  assert.throws(() => store.writeGoal(base, { ...value, activeRun: 'bad run id!' }), /goal_record_invalid/);
  assert.throws(() => store.writeGoal(base, { ...value, capability: 'x' }), /goal_record_credential/);
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => store.readGoal(base, 'session-a'), /goal_store_corrupt/);
});

test('corrupt goals are reported, never silently treated as absent, and other goals still load', t => {
  const base = root(t);
  const good = seedGoal(base, { sessionId: 'session-good' });
  fs.writeFileSync(store.goalFile(base, 'session-corrupt'), JSON.stringify({ schemaVersion: 1, id: 'nope' }));
  const listed = store.listGoals(base);
  assert.equal(listed.goals.length, 1);
  assert.equal(listed.goals[0].id, good.id);
  assert.equal(listed.corrupt.length, 1);
  assert.equal(store.readGoalById(base, good.id).sessionId, 'session-good');
  assert.equal(store.readGoalById(base, 'f'.repeat(32)), null);
});

test('a symlinked goal subdirectory is refused instead of followed', t => {
  const base = root(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(store.goalRoot(base), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, store.goalsDirectory(base));
  assert.throws(() => store.writeGoal(base, record()), /goal_store_path_invalid/);
  assert.throws(() => store.readGoal(base, 'session-1'), /goal_store_path_invalid/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test('oversized records are refused rather than parsed', t => {
  const base = root(t);
  seedGoal(base);
  const file = store.goalFile(base, 'session-1');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  payload.objective = 'x'.repeat(store.MAX_RECORD_BYTES + 10);
  fs.writeFileSync(file, JSON.stringify(payload));
  assert.throws(() => store.readGoal(base, 'session-1'), /goal_store_record_too_large/);
});

test('ownership is exclusive, never steals a dead owner, and distinguishes same-pid controllers', t => {
  const base = root(t);
  const first = crypto.randomBytes(16).toString('hex');
  const second = crypto.randomBytes(16).toString('hex');
  assert.equal(store.acquireOwnership(base, 's1', { owner: first }).ok, true);
  assert.equal(store.acquireOwnership(base, 's1', { owner: first }).ok, true);
  const blocked = store.acquireOwnership(base, 's1', { owner: second });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'owned-by-other-controller');
  fs.writeFileSync(store.lockFile(base, 's2'), JSON.stringify({ schemaVersion: 1, pid: 999999, ownerId: first, sessionId: 's2', startedAt: 1 }));
  const stale = store.acquireOwnership(base, 's2', { owner: second, alive: () => false });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'owned-by-dead-process');
  const live = store.acquireOwnership(base, 's2', { owner: second, alive: () => true });
  assert.equal(live.ok, false);
  assert.equal(live.reason, 'owned-by-live-process');
  assert.equal(store.releaseOwnership(base, 's2', { owner: second }), false);
  assert.equal(store.releaseOwnership(base, 's1', { owner: first }), true);
  assert.equal(store.acquireOwnership(base, 's1', { owner: second }).ok, true);
  fs.writeFileSync(store.lockFile(base, 's3'), '{ broken');
  const corrupt = store.acquireOwnership(base, 's3', { owner: first });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, 'owned-by-unknown');
});

test('capability tokens are single-run, path-safe, and cleaned per run', t => {
  const base = root(t);
  const goal = seedGoal(base);
  const firstRun = crypto.randomUUID(), secondRun = crypto.randomUUID();
  const token = capabilityFor(base, goal, firstRun);
  assert.match(token, /^[a-f0-9]{64}$/);
  const file = store.capabilityFile(base, token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(store.readCapability(base, token).runId, firstRun);
  assert.equal(store.readCapability(base, '../../etc/passwd'), null);
  assert.equal(store.readCapability(base, token + '/../x'), null);
  const second = capabilityFor(base, goal, secondRun);
  assert.equal(store.readCapability(base, token), null);
  assert.equal(store.readCapability(base, second).runId, secondRun);
  assert.equal(store.removeCapabilitiesForRun(base, secondRun), 1);
  assert.equal(store.readCapability(base, second), null);
});

test('reports are atomic per run and duplicate submissions are refused', t => {
  const base = root(t);
  const goal = seedGoal(base);
  const run = crypto.randomUUID();
  const payload = { id: goal.id, revision: 1, sessionId: goal.sessionId, status: 'progress', evidence: 'ran the suite' };
  assert.equal(store.writeReport(base, run, payload), true);
  assert.equal(store.readReport(base, run).evidence, 'ran the suite');
  assert.throws(() => store.writeReport(base, run, payload), /goal_store_exists/);
  assert.throws(() => store.writeReport(base, run, { ...payload, evidence: '' }), /report_payload_invalid/);
  assert.equal(store.readReport(base, run).evidence, 'ran the suite');
});

test('report CLI accepts a valid submission and rejects malformed, traversal and duplicate input', t => {
  const base = root(t);
  const goal = seedGoal(base);
  const runId = crypto.randomUUID();
  const token = capabilityFor(base, goal, runId);
  const run = args => {
    try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })) }; }
    catch (error) { return { code: error.status, out: JSON.parse(error.stdout) }; }
  };
  const storeRoot = base;
  const good = run(['--store', storeRoot, '--capability', token, JSON.stringify({ status: 'review', evidence: 'all criteria verified' })]);
  assert.equal(good.code, 0);
  assert.equal(good.out.accepted, true);
  assert.equal(store.readReport(base, runId).status, 'review');
  const duplicate = run(['--store', storeRoot, '--capability', token, JSON.stringify({ status: 'review', evidence: 'again' })]);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.out.error, /已经提交过报告/);
  const badStatus = run(['--store', storeRoot, '--capability', token, JSON.stringify({ status: 'complete', evidence: 'x' })]);
  assert.equal(badStatus.code, 2);
  const emptyEvidence = run(['--store', storeRoot, '--capability', token, JSON.stringify({ status: 'progress', evidence: '   ' })]);
  assert.equal(emptyEvidence.code, 2);
  const extraField = run(['--store', storeRoot, '--capability', token, JSON.stringify({ status: 'progress', evidence: 'x', token: 'y' })]);
  assert.equal(extraField.code, 2);
  const traversal = run(['--store', storeRoot, '--capability', '../' + token, JSON.stringify({ status: 'progress', evidence: 'x' })]);
  assert.equal(traversal.code, 2);
  const relative = run(['--store', 'goal', '--capability', token, JSON.stringify({ status: 'progress', evidence: 'x' })]);
  assert.equal(relative.code, 2);
  const nested = run(['--store', store.goalRoot(base), '--capability', token, JSON.stringify({ status: 'progress', evidence: 'x' })]);
  assert.equal(nested.code, 1);
  const unknown = run(['--store', storeRoot, '--capability', 'a'.repeat(64), JSON.stringify({ status: 'progress', evidence: 'x' })]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out.error, /能力令牌无效/);
});

test('report CLI rejects a stale revision and a non-active goal, and exported submit re-validates', t => {
  const base = root(t);
  const goal = seedGoal(base);
  const token = capabilityFor(base, goal, crypto.randomUUID());
  const submission = report.submit({ store: base, token, status: 'progress', evidence: 'x' });
  assert.equal(submission.ok, true);
  store.writeGoal(base, { ...goal, revision: 5 });
  const stale = report.submit({ store: base, token, status: 'progress', evidence: 'x' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /修订已变化/);
  const badStatus = report.submit({ store: base, token, status: 'complete', evidence: 'x' });
  assert.equal(badStatus.ok, false);
  const badEvidence = report.submit({ store: base, token, status: 'progress', evidence: '' });
  assert.equal(badEvidence.ok, false);
  const fresh = seedGoal(base, { sessionId: 'session-2' });
  const freshRun = crypto.randomUUID();
  const freshToken = capabilityFor(base, fresh, freshRun);
  const freshSubmission = report.submit({ store: base, token: freshToken, status: 'progress', evidence: 'y' });
  assert.equal(freshSubmission.ok, true);
  store.writeGoal(base, { ...fresh, activeRun: freshRun, status: 'review' });
  const notActive = report.submit({ store: base, token: freshToken, status: 'progress', evidence: 'x' });
  assert.equal(notActive.ok, false);
  assert.match(notActive.error, /不接受报告/);
});

test('scan matches the exact filename and never hides older records beyond a cap', t => {
  const base = root(t);
  const records = [];
  for (let index = 0; index < 3; index++) records.push(seedGoal(base, { sessionId: 'session-' + index, createdAt: 1700000000000 + index }));
  fs.writeFileSync(path.join(store.goalsDirectory(base), 'f'.repeat(64) + '.json'), JSON.stringify(records[0]));
  const listed = store.listGoals(base);
  assert.deepEqual(listed.goals.map(entry => entry.id).sort(), records.map(entry => entry.id).sort());
  assert.equal(listed.corrupt.length, 1);
  assert.equal(store.readGoalById(base, records[0].id).sessionId, 'session-0');
});

test('goal admission rejects a new record past the capacity instead of dropping old ones', t => {
  const base = root(t);
  const names = [];
  for (let index = 0; index < store.MAX_GOALS; index++) names.push('session-' + index);
  for (const name of names) seedGoal(base, { sessionId: name });
  assert.equal(store.listGoals(base).goals.length, store.MAX_GOALS);
  assert.throws(() => store.writeGoal(base, record({ sessionId: 'extra' })), /goal_store_capacity/);
  assert.equal(store.listGoals(base).goals.length, store.MAX_GOALS);
  assert.ok(store.readGoal(base, names[0]), 'the oldest record is still readable, never dropped');
  assert.equal(store.readGoal(base, 'extra'), null);
});

test('archive publishes immutable history, is idempotent, and refuses a conflicting id', t => {
  const base = root(t);
  const goal = seedGoal(base, { sessionId: 'session-archive' });
  const first = store.archiveGoal(base, { ...goal, status: 'completed', archivedAt: 1 });
  assert.equal(first.published, true);
  assert.equal(store.readGoal(base, 'session-archive'), null);
  const historyFile = path.join(store.historyDirectory(base), goal.id + '.json');
  const bytes = fs.readFileSync(historyFile, 'utf8');
  const second = store.archiveGoal(base, { ...goal, status: 'completed', archivedAt: 1 });
  assert.equal(second.published, false, 'an identical re-archive is idempotent');
  assert.equal(fs.readFileSync(historyFile, 'utf8'), bytes);
  const other = record({ sessionId: 'session-archive', id: crypto.randomBytes(16).toString('hex') });
  store.writeGoal(base, other);
  assert.throws(() => store.archiveGoal(base, { ...other, id: goal.id }), /goal_record_conflict/);
  assert.ok(store.readGoal(base, 'session-archive'));
});

test('archive rejects a corrupt or foreign active record and never silently drops it', t => {
  const base = root(t);
  const goal = seedGoal(base, { sessionId: 'session-conflict' });
  const other = seedGoal(base, { sessionId: 'session-other' });
  fs.writeFileSync(store.goalFile(base, 'session-conflict'), JSON.stringify({ ...other, sessionId: 'session-conflict' }));
  assert.throws(() => store.archiveGoal(base, { ...goal, archivedAt: 1 }), /goal_record_conflict/);
  assert.ok(store.readGoal(base, 'session-conflict'));
  fs.writeFileSync(store.goalFile(base, 'session-conflict'), '{ broken');
  assert.throws(() => store.archiveGoal(base, { ...goal, archivedAt: 1 }), /goal_store_corrupt/);
});

test('archive rejects a new history entry past the capacity', t => {
  const base = root(t);
  const goal = seedGoal(base, { sessionId: 'session-cap' });
  for (let index = 0; index < store.MAX_HISTORY; index++) {
    const filler = record({ id: crypto.randomBytes(16).toString('hex'), sessionId: 'filler-' + index });
    store.archiveGoal(base, { ...filler, archivedAt: 1 });
  }
  assert.throws(() => store.archiveGoal(base, { ...goal, archivedAt: 1 }), /goal_store_capacity/);
  assert.ok(store.readGoal(base, 'session-cap'), 'the active record survives a refused archive');
});

test('goal record files never contain capability tokens and evidence stays bounded', t => {
  const base = root(t);
  const goal = seedGoal(base);
  const token = capabilityFor(base, goal, crypto.randomUUID());
  const raw = fs.readFileSync(store.goalFile(base, goal.sessionId), 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes('capability'), false);
  assert.equal(store.normalizeEvidence('x'.repeat(store.MAX_EVIDENCE_LENGTH + 1)), null);
  assert.equal(store.normalizeEvidence('  ok  '), 'ok');
  assert.equal(store.normalizeObjective('a'.repeat(store.MAX_OBJECTIVE_LENGTH + 1)), null);
  assert.equal(store.normalizeCriteria('a'.repeat(store.MAX_CRITERIA_LENGTH + 1)), null);
  assert.equal(store.normalizeMaxRuns(undefined), 10);
  assert.equal(store.normalizeMaxRuns(1), 1);
  assert.equal(store.normalizeMaxRuns(100), 100);
  assert.equal(store.normalizeMaxRuns(101), null);
  assert.equal(store.normalizeMaxRuns(1.5), null);
});