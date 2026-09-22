'use strict';
const fs = require('node:fs');
const { runtimeIdentity, controlFile, PORT } = require('./backend.cjs');
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_HEALTH_BYTES = 4 * 1024 * 1024;
const COUNT_FIELDS = ['requests', 'success', 'error', 'cancelled'];
const METRIC_KEYS = ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'ttftMs', 'textTtftMs', 'tps', 'throughputTps', 'firstResponseMs', 'gatewayTps'];
const METRIC_FIELDS = ['value', 'reported', 'samples'];
const RECORD_FIELDS = ['schemaVersion', 'id', 'startedAt', 'model', 'providerId', 'effort', 'status', 'code', 'httpStatus',
  'inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens', 'firstOutputMs', 'firstTextMs', 'firstResponseMs',
  'durationMs', 'outputSpanMs', 'tps', 'decodeMs', 'visibleTokens', 'hasTools', 'hasReasoning',
  'throughputTps', 'gatewayTps', 'usageState', 'usageComplete', 'sessionId', 'attribution', 'role'];
async function readMonitor({ root, port = PORT, signal, request = fetch }) {
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
  const base = 'http://127.0.0.1:' + port;
  const read = async (url, headers, maximum) => {
    const response = await request(url, { signal: timeout, headers, redirect: 'error' });
    if (!response.ok) throw new Error('monitor_unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) throw new Error('monitor_snapshot_too_large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const health = await read(base + '/health', undefined, MAX_HEALTH_BYTES);
  const expected = runtimeIdentity(root);
  if (health.service !== expected.service || health.rootId !== expected.rootId || !health.instanceId) throw new Error('monitor_identity');
  if (health.monitorProtocol !== 1) return { status: 'unsupported', snapshot: null };
  const control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
  if (control.rootId !== health.rootId || control.instanceId !== health.instanceId || control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) throw new Error('monitor_identity');
  const data = await read(base + '/_runtime/monitor', { authorization: 'Bearer ' + control.token }, MAX_SNAPSHOT_BYTES);
  if (data.instanceId !== health.instanceId) throw new Error('monitor_identity');
  if (!data.snapshot) return { status: 'unavailable', snapshot: null };
  return { status: 'ready', snapshot: publicSnapshot(data.snapshot) };
}
function metricOf(metric) {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return null;
  const copy = {};
  for (const field of METRIC_FIELDS) if (metric[field] !== undefined) copy[field] = metric[field];
  return copy;
}
function summaryOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = {};
  for (const field of COUNT_FIELDS) if (value[field] !== undefined) summary[field] = value[field];
  for (const field of METRIC_KEYS) if (value[field] !== undefined) summary[field] = metricOf(value[field]);
  return summary;
}
function recordOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = {};
  for (const field of RECORD_FIELDS) if (entry[field] !== undefined) record[field] = entry[field];
  return record;
}
function sessionOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const summary = summaryOf(entry.summary);
  if (!summary || !Array.isArray(entry.records)) return null;
  return { sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
    attribution: typeof entry.attribution === 'string' ? entry.attribution : 'unassigned',
    summary, records: entry.records.map(recordOf).filter(Boolean) };
}
function publicSnapshot(snapshot) {
  const summary = summaryOf(snapshot.summary);
  if (snapshot.version !== 1 || typeof snapshot.status !== 'string' || !summary || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.sessions)) {
    throw new Error('monitor_invalid');
  }
  return { version: 1, status: snapshot.status, storageError: snapshot.storageError === true,
    sessionStatus: snapshot.sessionStatus === 'ready' ? 'ready' : 'unavailable',
    records: snapshot.records.map(recordOf).filter(Boolean), summary,
    sessions: snapshot.sessions.map(sessionOf).filter(Boolean) };
}
module.exports = { readMonitor, MAX_SNAPSHOT_BYTES, publicSnapshot };
