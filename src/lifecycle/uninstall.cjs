'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RECEIPT, POINTERS, permitted, atomicJson } = require('./owned-settings.cjs');
const { restoreJsonc } = require('./jsonc-edit.cjs');

function restoreFile(receipt, { beforeCommit } = {}) {
  const settingsFile = receipt.settingsFile;
  const stat = fs.lstatSync(settingsFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings path is not a regular file');
  const source = fs.readFileSync(settingsFile, 'utf8');
  const restored = restoreJsonc(source, receipt.changes);
  if (!restored.count) return 0;
  const backup = settingsFile + '.fusion-byok-before-uninstall';
  try { fs.writeFileSync(backup, source, { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const temporary = settingsFile + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, restored.text, { mode: stat.mode & 0o600, flag: 'wx' });
    beforeCommit?.();
    if (fs.readFileSync(settingsFile, 'utf8') !== source) throw new Error('Settings changed during restoration');
    fs.renameSync(temporary, settingsFile);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return restored.count;
}

function uninstall({ extensionPath = path.resolve(__dirname, '../..'), log = () => {} } = {}) {
  let roots;
  try { roots = JSON.parse(fs.readFileSync(path.join(extensionPath, POINTERS), 'utf8')).roots; } catch { return { restored: 0, failed: 0 }; }
  let restored = 0, failed = 0;
  for (const root of Array.isArray(roots) ? [...new Set(roots)] : []) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(root, RECEIPT), 'utf8')); } catch { continue; }
    // An old package's delayed uninstall cannot undo a newer active install.
    if (receipt.version !== 1 || receipt.extensionPath !== path.resolve(extensionPath) || receipt.root !== root ||
        receipt.settingsFile !== path.join(path.dirname(path.dirname(root)), 'settings.json') ||
        !Array.isArray(receipt.changes) || !receipt.changes.every(change => permitted(change.path) &&
          typeof change.managed === 'string' && change.original && typeof change.original.exists === 'boolean')) continue;
    try { restored += restoreFile(receipt); }
    catch {
      failed++;
      // The host removes globalStorage after this hook. Keep the exact restore
      // receipt outside it when safe restoration was not possible.
      try { atomicJson(receipt.settingsFile + '.fusion-byok-restore-pending.json', receipt); } catch {}
      log('settings-restore-pending');
    }
  }
  log('settings-restored', { count: restored, failed });
  return { restored, failed };
}
if (require.main === module) uninstall({ log: (event, data = {}) => console.log(JSON.stringify({ event, ...data })) });
module.exports = { uninstall, restoreFile };
