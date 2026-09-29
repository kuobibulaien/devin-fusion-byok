'use strict';
const path = require('node:path');

const WAIT_SECONDS = 90;

// Resolve `/Applications/Devin.app` from `<bundle>/Contents/Resources/app`.
function appBundle(appRoot) {
  if (typeof appRoot !== 'string' || !appRoot) return '';
  const bundle = path.resolve(appRoot, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : '';
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// A detached helper waits for the main executable to exit, then reopens the
// bundle. If the quit is cancelled it gives up instead of relaunching later.
function relaunchScript(bundle, waitSeconds = WAIT_SECONDS) {
  const main = quote(`^${bundle}/Contents/MacOS/`);
  return `i=0; while /usr/bin/pgrep -f ${main} >/dev/null 2>&1; do i=$((i+1)); [ $i -gt ${waitSeconds * 2} ] && exit 0; sleep 0.5; done; sleep 1; /usr/bin/open ${quote(bundle)}`;
}

async function restartApp({ vscode, spawn, platform = process.platform, appRoot = vscode?.env?.appRoot } = {}) {
  if (platform !== 'darwin') throw new Error('restart_unsupported');
  const bundle = appBundle(appRoot);
  if (!bundle) throw new Error('restart_unsupported');
  const child = spawn('/bin/sh', ['-c', relaunchScript(bundle)], { detached: true, stdio: 'ignore' });
  child.unref?.();
  await vscode.commands.executeCommand('workbench.action.quit');
  return bundle;
}

module.exports = { restartApp, relaunchScript, appBundle };
