'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createContextDiagnostics({ root, version, readStatus, snapshot, pid = process.pid, intervalMs = 2000 }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('Invalid process ID');
  const directory = path.join(root, 'context-diagnostics');
  const file = path.join(directory, `${pid}.json`), temporary = file + '.tmp';
  let disposed = false;
  function refresh() {
    try {
      const status = readStatus() || {}, sessions = snapshot() || [];
      const data = { schemaVersion: 1, pluginVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown', pid,
        writtenAt: new Date().toISOString(), state: disposed ? 'disposed' : ['observing', 'disabled', 'disposed'].includes(status.state) ? status.state : 'unavailable' };
      for (const key of ['connections', 'registrations', 'sessionUpdates', 'usageUpdates', 'acceptedUsageUpdates', 'rejectedUsageUpdates']) data[key] = Number.isSafeInteger(status[key]) && status[key] >= 0 ? status[key] : null;
      data.usageRejections = {};
      for (const key of ['invalid-session-id', 'invalid-used', 'invalid-size', 'invalid-parent-id', 'invalid-run-id']) {
        const count = status.usageRejections?.[key];
        data.usageRejections[key] = Number.isSafeInteger(count) && count >= 0 ? count : null;
      }
      data.leadSessions = sessions.filter(session => session.lead).length;
      data.subagentUsages = sessions.reduce((total, session) => total + (session.subagents?.length || 0), 0);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) return false;
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(data) + '\n'); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      return true;
    } catch { return false; }
  }
  const timer = setInterval(refresh, intervalMs); timer.unref?.();
  refresh();
  return { refresh, dispose() { if (disposed) return; disposed = true; clearInterval(timer); refresh(); } };
}
module.exports = { createContextDiagnostics };
