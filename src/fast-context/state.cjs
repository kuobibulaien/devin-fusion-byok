'use strict';
// User switch for the external MCP. Off unless the user turned it on in the panel;
// the standalone server reads it on start and before every tool call.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const FILE = 'external-mcp.json';
const EXTENSION_ID = 'local.devin-fusion-byok';

// FUSION_BYOK_STORAGE_DIR covers portable or relocated Devin installs.
function storageDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.FUSION_BYOK_STORAGE_DIR && path.isAbsolute(env.FUSION_BYOK_STORAGE_DIR)) return env.FUSION_BYOK_STORAGE_DIR;
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Devin/User/globalStorage', EXTENSION_ID);
  if (platform === 'win32') {
    if (!env.APPDATA) return undefined;
    return path.join(env.APPDATA, 'Devin/User/globalStorage', EXTENSION_ID);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Devin/User/globalStorage', EXTENSION_ID);
}

function readEnabled({ dir = storageDir() } = {}) {
  if (!dir) return false;
  try { return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')).enabled === true; } catch { return false; }
}

function writeEnabled(dir, enabled) {
  if (!path.isAbsolute(dir)) throw new Error('absolute_paths_required');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE), temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ enabled: enabled === true, at: Date.now() }) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

module.exports = { storageDir, readEnabled, writeEnabled, FILE };
