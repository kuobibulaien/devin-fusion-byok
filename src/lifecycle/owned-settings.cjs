'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const RECEIPT = 'settings-restore.json';
const POINTERS = '.fusion-byok-storage.json';
const ENV_KEYS = new Set(['WINDSURF_API_SERVER_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
function valueAt(object, keys) {
  for (let index = 0; index < keys.length; index++) {
    if (!object || typeof object !== 'object' || !own(object, keys[index])) return { exists: false };
    object = object[keys[index]];
  }
  return { exists: true, value: object };
}
function permitted(keys) {
  return Array.isArray(keys) && keys.length === 3 && keys[1] === 'devin-cli' &&
    (keys[0] === 'devin.acp.agentEnv' && ENV_KEYS.has(keys[2]) || keys[0] === 'devin.acp.agentPreferences' && keys[2] === 'model');
}
function matchesManaged(change, value) {
  if (value === change.managed) return true;
  const ownModel = value => typeof value === 'string' && /^(?:fusion-)?dfbyok-[a-z0-9-]+$/.test(value);
  return change.path[0] === 'devin.acp.agentPreferences' && change.path[2] === 'model' && ownModel(change.managed) && ownModel(value);
}
function newReceipt(root, extensionPath) {
  return { version: 1, extensionPath: path.resolve(extensionPath), root: path.resolve(root),
    settingsFile: path.join(path.dirname(path.dirname(root)), 'settings.json'), changes: [] };
}
function readReceipt(root, extensionPath) {
  const empty = newReceipt(root, extensionPath);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, RECEIPT), 'utf8'));
    if (data.version === 1 && data.root === empty.root && data.settingsFile === empty.settingsFile && Array.isArray(data.changes)) {
      return { ...data, extensionPath: empty.extensionPath, changes: data.changes.filter(change => permitted(change.path) &&
        change.original && typeof change.original.exists === 'boolean' && typeof change.managed === 'string') };
    }
  } catch {}
  return empty;
}
function remember(receipt, keys, current, managed, legacyOriginal) {
  if (!permitted(keys) || typeof managed !== 'string') throw new Error('Invalid owned setting');
  const entry = receipt.changes.find(change => JSON.stringify(change.path) === JSON.stringify(keys));
  const sameOwner = entry && current.exists && matchesManaged(entry, current.value);
  const original = sameOwner ? entry.original : legacyOriginal || current;
  const changed = { path: keys, original, managed };
  if (entry) receipt.changes[receipt.changes.indexOf(entry)] = changed;
  else receipt.changes.push(changed);
}
function atomicJson(file, value) {
  const temporary = file + '.' + crypto.randomUUID();
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function saveReceipt(receipt) {
  atomicJson(path.join(receipt.root, RECEIPT), receipt);
  const pointersFile = path.join(receipt.extensionPath, POINTERS);
  let roots = [];
  try { roots = JSON.parse(fs.readFileSync(pointersFile, 'utf8')).roots || []; } catch {}
  atomicJson(pointersFile, { roots: [...new Set([...roots.filter(root => typeof root === 'string' && path.isAbsolute(root)), receipt.root])] });
}
function restoreObject(object, changes) {
  const restored = JSON.parse(JSON.stringify(object || {}));
  let count = 0;
  for (const change of changes) {
    if (!permitted(change.path)) continue;
    const current = valueAt(restored, change.path);
    if (!current.exists || !matchesManaged(change, current.value)) continue;
    let parent = restored;
    for (const key of change.path.slice(0, -1)) parent = parent[key];
    if (change.original.exists) parent[change.path.at(-1)] = change.original.value;
    else delete parent[change.path.at(-1)];
    count++;
  }
  return { value: restored, count };
}
module.exports = { RECEIPT, POINTERS, valueAt, permitted, matchesManaged, readReceipt, remember, saveReceipt, restoreObject, atomicJson };
