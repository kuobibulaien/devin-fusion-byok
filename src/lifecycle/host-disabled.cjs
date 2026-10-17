'use strict';
// Detects that the user disabled this extension in the host's extension manager.
// An extension activated on "*" can only be disabled by restarting the extension
// host, so deactivate() cannot tell a disable from a reload on its own. The host
// records the disabled list in its global state database within ~100 ms of the
// click, before the restart; reading it lets deactivate restore owned settings
// only on a real disable. Any read failure answers false (keep settings).
const path = require('node:path');
const fs = require('node:fs');
const EXTENSION_ID = 'local.devin-fusion-byok';
const KEY = 'extensionsIdentifiers/disabled';

// `storageRoot` is this extension's globalStorage folder; the database sits beside it.
function isHostDisabled({ storageRoot, id = EXTENSION_ID, database } = {}) {
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) return false;
  const file = path.join(path.dirname(storageRoot), 'state.vscdb');
  if (!fs.existsSync(file)) return false;
  let db;
  try {
    const DatabaseSync = database || require('node:sqlite').DatabaseSync;
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KEY);
    const list = JSON.parse(row?.value || '[]');
    const wanted = id.toLowerCase();
    return Array.isArray(list) && list.some(entry => typeof entry?.id === 'string' && entry.id.toLowerCase() === wanted);
  } catch { return false; }
  finally { try { db?.close(); } catch {} }
}

module.exports = { isHostDisabled, EXTENSION_ID, KEY };
