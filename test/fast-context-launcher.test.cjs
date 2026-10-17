'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureLauncher, FILE } = require('../src/fast-context/launcher.cjs');

function fakeExtension(dir, version, body) {
  const file = path.join(dir, `local.devin-fusion-byok-${version}`, 'src/fast-context/server.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test('launcher starts the newest installed server and survives upgrades', t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-launcher-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const extensions = path.join(base, 'extensions'), storage = path.join(base, 'storage');
  const main = tag => `module.exports = { main: argv => process.stdout.write(${JSON.stringify(tag)} + ':' + argv.join(' ')) };`;
  const env = `module.exports = { main: () => process.stdout.write(process.env.FUSION_BYOK_STORAGE_DIR) };`;
  fakeExtension(extensions, '0.3.9', main('old'));
  fakeExtension(extensions, '0.3.43', main('current'));
  fs.mkdirSync(path.join(extensions, 'local.devin-fusion-byok-0.3.99-broken'));
  const file = ensureLauncher({ storageDir: storage, extensionPath: path.join(extensions, 'local.devin-fusion-byok-0.3.43') });
  assert.equal(file, path.join(storage, FILE));
  const run = () => spawnSync(process.execPath, [file, '--root', base], { encoding: 'utf8' });
  assert.equal(run().stdout, `current:--root ${base}`);
  fakeExtension(extensions, '0.4.0', main('upgraded'));
  assert.equal(run().stdout, `upgraded:--root ${base}`);
  // Servers without `main` (0.3.42 and older) are started as a child process.
  fakeExtension(extensions, '0.10.0', "if (require.main === module) process.stdout.write('legacy:' + process.argv.slice(2).join(' '));");
  assert.equal(run().stdout, `legacy:--root ${base}`);
  fakeExtension(extensions, '0.11.0', env);
  assert.equal(run().stdout, storage);
  const before = fs.statSync(file).mtimeMs;
  ensureLauncher({ storageDir: storage, extensionPath: path.join(extensions, 'local.devin-fusion-byok-0.3.43') });
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.throws(() => ensureLauncher({ storageDir: 'relative', extensionPath: '/x' }), /absolute_paths_required/);
});
