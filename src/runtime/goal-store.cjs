'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GOAL_DIR = 'goal';
const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_EVIDENCE_LENGTH = 4000;
const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_CRITERIA_LENGTH = 8000;
const MAX_REASON_LENGTH = 500;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVIDENCE_ENTRIES = 200;
const MAX_RUNS = 100;
const DEFAULT_MAX_RUNS = 10;
const MAX_GOALS = 100;
const MAX_HISTORY = 100;
const REPORT_STATUSES = ['progress', 'waiting', 'blocked', 'review'];
const GOAL_STATUSES = ['active', 'retrying', 'paused', 'waiting', 'blocked', 'limited', 'review', 'completed'];
const TOKEN_RE = /^[a-f0-9]{64}$/;
const GOAL_ID_RE = /^[a-f0-9]{32}$/;
const RUN_ID_RE = /^[a-f0-9][a-f0-9-]{7,63}$/;
const OWNER_ID_RE = /^[a-f0-9]{32}$/;
const HASH_NAME_RE = /^[a-f0-9]{64}\.json$/;
const GOAL_NAME_RE = /^[a-f0-9]{32}\.json$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const READ_FLAGS = fs.constants.O_RDONLY | NOFOLLOW;

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function goalId(value) { return typeof value === 'string' && GOAL_ID_RE.test(value) ? value : null; }
function runId(value) { return typeof value === 'string' && RUN_ID_RE.test(value) ? value : null; }
function ownerId(value) { return typeof value === 'string' && OWNER_ID_RE.test(value) ? value : null; }
function capabilityToken(value) { return typeof value === 'string' && TOKEN_RE.test(value) ? value : null; }
function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId), 'utf8').digest('hex');
}
function goalRoot(root) { return path.join(root, GOAL_DIR); }
function goalsDirectory(root) { return path.join(goalRoot(root), 'goals'); }
function capabilitiesDirectory(root) { return path.join(goalRoot(root), 'capabilities'); }
function reportsDirectory(root) { return path.join(goalRoot(root), 'reports'); }
function locksDirectory(root) { return path.join(goalRoot(root), 'locks'); }
function historyDirectory(root) { return path.join(goalRoot(root), 'history'); }
function goalFile(root, sessionId) { return path.join(goalsDirectory(root), sessionKey(sessionId) + '.json'); }
function capabilityFile(root, token) { return path.join(capabilitiesDirectory(root), token + '.json'); }
function reportFile(root, run) { return path.join(reportsDirectory(root), run + '.json'); }
function lockFile(root, sessionId) { return path.join(locksDirectory(root), sessionKey(sessionId) + '.lock'); }

function chain(root, name) {
  const segments = name ? [GOAL_DIR, name] : [GOAL_DIR];
  let current = root;
  return segments.map(segment => (current = path.join(current, segment)));
}
function isRealDirectory(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw new Error('goal_store_unreadable'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('goal_store_path_invalid');
  return true;
}
function safeDirectory(root, name) {
  isRealDirectory(root);
  for (const directory of chain(root, name)) {
    if (!isRealDirectory(directory)) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw new Error('goal_store_unwritable'); }
      isRealDirectory(directory);
    }
  }
  const target = chain(root, name).pop();
  try { fs.chmodSync(target, 0o700); } catch {}
  return target;
}
function safeReadDirectory(root, name) {
  isRealDirectory(root);
  for (const directory of chain(root, name)) if (!isRealDirectory(directory)) return null;
  return chain(root, name).pop();
}
function readJsonFile(file, maximumBytes = MAX_RECORD_BYTES) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('goal_store_unreadable'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('goal_store_path_invalid');
  if (stat.size > maximumBytes) throw new Error('goal_store_record_too_large');
  let source;
  try { source = fs.readFileSync(file, { encoding: 'utf8', flag: READ_FLAGS }); }
  catch { throw new Error('goal_store_unreadable'); }
  try { return JSON.parse(source); }
  catch { throw new Error('goal_store_corrupt'); }
}
function writeAtomic(file, value) {
  const temporary = path.join(path.dirname(file), '.tmp-' + crypto.randomBytes(16).toString('hex'));
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    let existing;
    try { existing = fs.lstatSync(file); } catch {}
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('goal_store_path_invalid');
    fs.renameSync(temporary, file);
    return true;
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function publishExclusive(file, value) {
  const temporary = path.join(path.dirname(file), '.tmp-' + crypto.randomBytes(16).toString('hex'));
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error?.code === 'EEXIST') { const conflict = new Error('goal_store_exists'); conflict.code = 'EEXIST'; throw conflict; }
      throw error;
    }
    return true;
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function removeFile(file) { try { fs.unlinkSync(file); return true; } catch { return false; } }
function listDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return fs.readdirSync(directory);
  } catch { return []; }
}
function plainText(value, maximum) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}
function normalizeEvidence(value) { return plainText(value, MAX_EVIDENCE_LENGTH); }
function normalizeObjective(value) { return plainText(value, MAX_OBJECTIVE_LENGTH); }
function normalizeCriteria(value) { return plainText(value, MAX_CRITERIA_LENGTH); }
function normalizeReason(value) {
  if (value === null || value === undefined) return null;
  return plainText(value, MAX_REASON_LENGTH);
}
function normalizeMaxRuns(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_RUNS;
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RUNS ? value : null;
}
function normalizeRetryPolicy(value) {
  if (value === undefined) return { enabled: false, intervalMinutes: 5, maxHours: 24 };
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') return null;
  const { enabled, intervalMinutes, maxHours } = value;
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440 ||
      !Number.isSafeInteger(maxHours) || maxHours < 1 || maxHours > 168) return null;
  return { enabled, intervalMinutes, maxHours };
}
function isReportStatus(value) { return REPORT_STATUSES.includes(value); }
function isGoalStatus(value) { return GOAL_STATUSES.includes(value); }

function validEvidenceEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (!runId(entry.runId) || !isReportStatus(entry.status)) return false;
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) return false;
  if (!Number.isFinite(entry.submittedAt)) return false;
  return normalizeEvidence(entry.evidence) !== null;
}
function validGoalRecord(record, expectedSession) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.schemaVersion !== SCHEMA_VERSION) return false;
  if (!goalId(record.id) || identifier(record.sessionId) !== expectedSession) return false;
  if (!isGoalStatus(record.status) || !normalizeRetryPolicy(record.retryPolicy)) return false;
  if (record.retryWindow != null) {
    const w = record.retryWindow;
    if (!record.retryPolicy?.enabled || !w || typeof w !== 'object' || Array.isArray(w) ||
        ![w.startedAt, w.deadlineAt, w.nextAt].every(value => Number.isSafeInteger(value) && value >= 0) ||
        w.deadlineAt !== w.startedAt + record.retryPolicy.maxHours * 3600000 ||
        w.nextAt < w.startedAt || w.nextAt > w.deadlineAt ||
        !Number.isSafeInteger(w.attempts) || w.attempts < 0) return false;
  }
  if (record.status === 'retrying' && !record.retryWindow) return false;
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) return false;
  if (!Number.isSafeInteger(record.runsStarted) || record.runsStarted < 0) return false;
  if (!Number.isSafeInteger(record.maxRuns) || record.maxRuns < 1 || record.maxRuns > MAX_RUNS) return false;
  if (!Number.isSafeInteger(record.missingRuns) || record.missingRuns < 0) return false;
  if (!Number.isSafeInteger(record.repeatCount) || record.repeatCount < 0) return false;
  if (record.lastEvidence !== null && normalizeEvidence(record.lastEvidence) === null) return false;
  if (normalizeObjective(record.objective) === null || normalizeCriteria(record.criteria) === null) return false;
  if (record.reason !== null && normalizeReason(record.reason) === null) return false;
  if (record.activeRun !== null && !runId(record.activeRun)) return false;
  if (!Array.isArray(record.evidence) || record.evidence.length > MAX_EVIDENCE_ENTRIES) return false;
  if (!record.evidence.every(validEvidenceEntry)) return false;
  for (const key of ['createdAt', 'updatedAt']) if (!Number.isFinite(record[key])) return false;
  if (record.archivedAt !== null && !Number.isFinite(record.archivedAt)) return false;
  return true;
}
const CREDENTIAL_KEY_RE = /token|secret|capabilit|password|apikey|credential|authorization/i;
function assertNoCredentialKeys(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_RE.test(key)) throw new Error('goal_record_credential');
    assertNoCredentialKeys(child, depth + 1);
  }
}

function readGoal(root, sessionId) {
  const key = identifier(sessionId);
  if (!key) return null;
  if (safeReadDirectory(root, 'goals') === null) return null;
  const record = readJsonFile(goalFile(root, key));
  if (record === null) return null;
  if (!validGoalRecord(record, key)) throw new Error('goal_store_corrupt');
  return record;
}
function scanDirectory(root, name, kind) {
  const directory = safeReadDirectory(root, name);
  if (directory === null) return { goals: [], corrupt: [] };
  const goals = [], corrupt = [];
  for (const entry of listDirectory(directory)) {
    if (kind === 'goals' && !HASH_NAME_RE.test(entry)) continue;
    if (kind === 'history' && !GOAL_NAME_RE.test(entry)) continue;
    let record;
    try { record = readJsonFile(path.join(directory, entry)); }
    catch { corrupt.push(entry); continue; }
    if (record === null) continue;
    const expected = kind === 'goals' ? sessionKey(record.sessionId) + '.json' : record.id + '.json';
    if (!validGoalRecord(record, record.sessionId) || expected !== entry) { corrupt.push(entry); continue; }
    goals.push(record);
  }
  return { goals: goals.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), corrupt };
}
function scanGoals(root) { return scanDirectory(root, 'goals', 'goals'); }
function scanHistory(root) { return scanDirectory(root, 'history', 'history'); }
function listGoals(root) {
  const active = scanGoals(root), history = scanHistory(root);
  return { goals: active.goals, history: history.goals, corrupt: [...active.corrupt, ...history.corrupt] };
}
function readGoalById(root, id) {
  const clean = goalId(id);
  if (!clean) return null;
  return scanGoals(root).goals.find(record => record.id === clean) ||
    scanHistory(root).goals.find(record => record.id === clean) || null;
}
function requireCapacity(root, name, maximum) {
  const directory = safeReadDirectory(root, name);
  if (directory === null) return;
  const count = listDirectory(directory).filter(entry => HASH_NAME_RE.test(entry) || GOAL_NAME_RE.test(entry)).length;
  if (count >= maximum) throw new Error('goal_store_capacity');
}
function writeGoal(root, record) {
  if (!record || !identifier(record.sessionId)) throw new Error('goal_record_invalid');
  if (!validGoalRecord(record, record.sessionId)) throw new Error('goal_record_invalid');
  assertNoCredentialKeys(record);
  const target = goalFile(root, record.sessionId);
  safeDirectory(root, 'goals');
  let existing = false;
  try { existing = fs.lstatSync(target).isFile(); } catch {}
  if (!existing) requireCapacity(root, 'goals', MAX_GOALS);
  writeAtomic(target, record);
  return record;
}
function archiveGoal(root, record) {
  if (!validGoalRecord(record, record.sessionId)) throw new Error('goal_record_invalid');
  assertNoCredentialKeys(record);
  safeDirectory(root, 'history');
  const target = path.join(historyDirectory(root), record.id + '.json');
  let active = null;
  if (safeReadDirectory(root, 'goals') !== null) {
    active = readJsonFile(goalFile(root, record.sessionId));
    if (active && (!validGoalRecord(active, record.sessionId) || active.id !== record.id)) throw new Error('goal_record_conflict');
  }
  let alreadyStored = false;
  try { alreadyStored = fs.lstatSync(target).isFile(); } catch {}
  if (!alreadyStored) requireCapacity(root, 'history', MAX_HISTORY);
  let published = false;
  try { publishExclusive(target, record); published = true; }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readJsonFile(target);
    if (!existing || existing.id !== record.id || existing.sessionId !== record.sessionId) throw new Error('goal_record_conflict');
  }
  if (active && !removeFile(goalFile(root, record.sessionId))) throw new Error('goal_record_conflict');
  return { record, published };
}

function capabilitiesOfGoal(root, id) {
  const clean = goalId(id);
  if (!clean) return [];
  const directory = safeReadDirectory(root, 'capabilities');
  if (directory === null) return [];
  const matches = [];
  for (const name of listDirectory(directory)) {
    if (!TOKEN_RE.test(name.replace(/\.json$/, '')) || !HASH_NAME_RE.test(name)) continue;
    let record;
    try { record = readJsonFile(path.join(directory, name), 64 * 1024); } catch { continue; }
    if (record?.id === clean) matches.push({ name, record });
  }
  return matches;
}
function removeCapabilitiesExcept(root, { id, run }) {
  const cleanGoal = goalId(id), cleanRun = runId(run);
  if (!cleanGoal) return 0;
  let removed = 0;
  for (const { name, record } of capabilitiesOfGoal(root, cleanGoal)) {
    if (record.runId === cleanRun) continue;
    if (removeFile(path.join(capabilitiesDirectory(root), name))) removed++;
  }
  return removed;
}
function removeCapabilitiesForGoal(root, id) {
  let removed = 0;
  for (const { name } of capabilitiesOfGoal(root, id)) {
    if (removeFile(path.join(capabilitiesDirectory(root), name))) removed++;
  }
  return removed;
}
function removeCapabilitiesForRun(root, run) {
  const cleanRun = runId(run);
  if (!cleanRun) return 0;
  const directory = safeReadDirectory(root, 'capabilities');
  if (directory === null) return 0;
  let removed = 0;
  for (const name of listDirectory(directory)) {
    if (!HASH_NAME_RE.test(name)) continue;
    let record;
    try { record = readJsonFile(path.join(directory, name), 64 * 1024); } catch { continue; }
    if (record?.runId === cleanRun && removeFile(path.join(directory, name))) removed++;
  }
  return removed;
}
function issueCapability(root, { id, revision, run, sessionId }) {
  const cleanGoal = goalId(id), cleanRun = runId(run), cleanSession = identifier(sessionId);
  if (!cleanGoal || !cleanRun || !cleanSession || !Number.isSafeInteger(revision) || revision < 1) throw new Error('capability_input_invalid');
  safeDirectory(root, 'capabilities');
  removeCapabilitiesExcept(root, { id: cleanGoal, run: cleanRun });
  const token = crypto.randomBytes(32).toString('hex');
  publishExclusive(capabilityFile(root, token), {
    schemaVersion: SCHEMA_VERSION, id: cleanGoal, revision, runId: cleanRun, sessionId: cleanSession,
    issuedAt: Date.now()
  });
  return token;
}
function readCapability(root, token) {
  const clean = capabilityToken(token);
  if (!clean) return null;
  if (safeReadDirectory(root, 'capabilities') === null) return null;
  const record = readJsonFile(capabilityFile(root, clean), 64 * 1024);
  if (record === null) return null;
  if (record.schemaVersion !== SCHEMA_VERSION || !goalId(record.id) || !runId(record.runId) ||
      !identifier(record.sessionId) || !Number.isSafeInteger(record.revision) || record.revision < 1) return null;
  return { ...record, token: clean };
}
function removeCapability(root, token) {
  const clean = capabilityToken(token);
  return clean ? removeFile(capabilityFile(root, clean)) : false;
}
function writeReport(root, run, payload) {
  const clean = runId(run);
  if (!clean) throw new Error('report_run_invalid');
  if (!goalId(payload?.id) || !identifier(payload?.sessionId) || !isReportStatus(payload?.status) ||
      !Number.isSafeInteger(payload?.revision) || payload.revision < 1 || normalizeEvidence(payload?.evidence) === null) {
    throw new Error('report_payload_invalid');
  }
  safeDirectory(root, 'reports');
  publishExclusive(reportFile(root, clean), {
    schemaVersion: SCHEMA_VERSION, runId: clean, id: payload.id, revision: payload.revision,
    sessionId: payload.sessionId, status: payload.status, evidence: payload.evidence, submittedAt: Date.now()
  });
  return true;
}
function readReport(root, run) {
  const clean = runId(run);
  if (!clean) return null;
  if (safeReadDirectory(root, 'reports') === null) return null;
  const record = readJsonFile(reportFile(root, clean), 64 * 1024);
  if (record === null) return null;
  if (record.schemaVersion !== SCHEMA_VERSION || record.runId !== clean || !goalId(record.id) ||
      !identifier(record.sessionId) || !isReportStatus(record.status) || normalizeEvidence(record.evidence) === null) return null;
  return record;
}
function removeReport(root, run) {
  const clean = runId(run);
  return clean ? removeFile(reportFile(root, clean)) : false;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
function readOwnership(root, sessionId) {
  const clean = identifier(sessionId);
  if (!clean) return null;
  if (safeReadDirectory(root, 'locks') === null) return null;
  let record;
  try { record = readJsonFile(lockFile(root, clean), 64 * 1024); }
  catch { return { corrupt: true, pid: null, ownerId: null }; }
  if (record === null) return null;
  if (!ownerId(record.ownerId) || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.sessionId !== clean) {
    return { corrupt: true, pid: null, ownerId: null };
  }
  return record;
}
function acquireOwnership(root, sessionId, { owner, now = Date.now, alive = isProcessAlive } = {}) {
  const clean = identifier(sessionId), cleanOwner = ownerId(owner);
  if (!clean) throw new Error('session_invalid');
  if (!cleanOwner) throw new Error('owner_invalid');
  safeDirectory(root, 'locks');
  const file = lockFile(root, clean);
  const existing = readOwnership(root, clean);
  if (existing) {
    if (existing.ownerId === cleanOwner) return { ok: true, owner: existing };
    if (existing.corrupt) return { ok: false, reason: 'owned-by-unknown', owner: null };
    if (existing.pid === process.pid) return { ok: false, reason: 'owned-by-other-controller', owner: existing };
    return { ok: false, reason: alive(existing.pid) ? 'owned-by-live-process' : 'owned-by-dead-process', owner: existing };
  }
  const record = { schemaVersion: SCHEMA_VERSION, pid: process.pid, ownerId: cleanOwner, sessionId: clean, startedAt: now() };
  try { publishExclusive(file, record); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return { ok: false, reason: 'owned-by-live-process', owner: readOwnership(root, clean) };
  }
  return { ok: true, owner: record };
}
function releaseOwnership(root, sessionId, { owner } = {}) {
  const clean = identifier(sessionId), cleanOwner = ownerId(owner);
  if (!clean || !cleanOwner) return false;
  const existing = readOwnership(root, clean);
  if (!existing || existing.corrupt || existing.ownerId !== cleanOwner) return false;
  return removeFile(lockFile(root, clean));
}

module.exports = {
  GOAL_DIR, SCHEMA_VERSION, MAX_RECORD_BYTES, MAX_EVIDENCE_LENGTH, MAX_OBJECTIVE_LENGTH, MAX_CRITERIA_LENGTH,
  MAX_REASON_LENGTH, MAX_EVIDENCE_ENTRIES, MAX_RUNS, DEFAULT_MAX_RUNS, REPORT_STATUSES, GOAL_STATUSES,
  identifier, goalId, runId, ownerId, capabilityToken, sessionKey, goalRoot, goalsDirectory, capabilitiesDirectory,
  reportsDirectory, locksDirectory, historyDirectory, goalFile, capabilityFile, reportFile, lockFile, safeDirectory,
  safeReadDirectory, readJsonFile, writeAtomic, publishExclusive, removeFile, listDirectory, normalizeEvidence,
  normalizeObjective, normalizeCriteria, normalizeReason, normalizeMaxRuns, normalizeRetryPolicy, isReportStatus, isGoalStatus,
  validGoalRecord, readGoal, scanGoals, scanHistory, listGoals, readGoalById, writeGoal, archiveGoal,
  issueCapability, readCapability, removeCapability, removeCapabilitiesExcept, removeCapabilitiesForGoal,
  removeCapabilitiesForRun, writeReport, readReport, removeReport, isProcessAlive, readOwnership, acquireOwnership,
  releaseOwnership, MAX_GOALS, MAX_HISTORY
};