'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, releaseInfo, allowedUrl, createUpdater, requestBytes, verifyPackage } = require('../src/update.cjs');
const release = version => ({ tag_name: 'v' + version, assets: [{ name: `devin-fusion-byok-${version}.vsix`, size: 10, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `https://github.com/kuobibulaien/devin-fusion-byok/releases/download/v${version}/devin-fusion-byok-${version}.vsix` }] });
function setup(extra = {}) {
  const data = new Map(); let calls = 0;
  const updater = createUpdater({ currentVersion: '0.3.33', globalState: { get: (k, d) => data.has(k) ? data.get(k) : d, update: async (k, v) => data.set(k, v) }, request: async () => { calls++; return Buffer.from(JSON.stringify(release('0.3.34'))); }, ...extra });
  return { updater, data, calls: () => calls };
}
test('stable versions compare numerically and reject invalid versions', () => {
  assert.equal(compareVersions('0.3.9', '0.3.33'), -1);
  assert.equal(compareVersions('0.3.33', '0.3.33'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  for (const v of ['1.0.0-beta', '01.0.0', 'x', '99999999999999999999.0.0']) assert.throws(() => compareVersions(v, '1.0.0'));
});
test('release accepts exact trusted artifact only', () => {
  assert.equal(releaseInfo(release('0.3.34')).installable, true);
  for (const flags of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.0.0-beta' }]) assert.throws(() => releaseInfo({ ...release('0.3.34'), ...flags }));
  const noDigest = release('0.3.34'); delete noDigest.assets[0].digest;
  assert.equal(releaseInfo(noDigest).installable, false);
  const wrong = release('0.3.34'); wrong.assets[0].browser_download_url = 'https://evil.example/a.vsix';
  assert.equal(releaseInfo(wrong).installable, false);
  assert.equal(releaseInfo({ ...release('0.3.34'), assets: [] }).installable, false);
});
test('redirect policy rejects untrusted schemes credentials hosts and ports', () => {
  for (const url of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://user:pass@github.com/a', 'https://github.com:8443/a']) assert.throws(() => allowedUrl(url));
  assert.equal(allowedUrl('https://release-assets.githubusercontent.com/a').hostname, 'release-assets.githubusercontent.com');
});
test('checks coalesce throttle persist and manual checks bypass', async () => {
  const { updater, calls } = setup();
  await Promise.all([updater.check(), updater.check()]); assert.equal(calls(), 1);
  assert.equal(updater.snapshot().phase, 'available');
  await updater.check(); assert.equal(calls(), 1);
  await updater.check({ force: true }); assert.equal(calls(), 2);
  await updater.ignore(); assert.equal(updater.snapshot().ignored, true);
  await updater.setAutoCheck(false); assert.equal(updater.snapshot().autoCheck, false);
  updater.dispose(); await updater.check({ force: true }); assert.equal(calls(), 2);
});
test('lower and equal versions never offer installation', async () => {
  for (const [version, phase] of [['0.3.23', 'ahead'], ['0.3.33', 'current']]) {
    const { updater } = setup({ request: async () => Buffer.from(JSON.stringify(release(version))) });
    await updater.check(); assert.equal(updater.snapshot().phase, phase); assert.equal(updater.snapshot().canInstall, false); updater.dispose();
  }
});
test('network failure is not latest and does not leak error details', async () => {
  const { updater } = setup({ request: async () => { throw Error('secret signed url'); } });
  await updater.check(); assert.equal(updater.snapshot().phase, 'error'); assert.doesNotMatch(JSON.stringify(updater.snapshot()), /secret/); updater.dispose();
});
test('cancelled confirmation never downloads or installs', async () => {
  let installs = 0; const { updater, calls } = setup({ confirm: async () => false, install: async () => installs++ });
  await updater.check(); await updater.installUpdate(); assert.equal(calls(), 1); assert.equal(installs, 0); updater.dispose();
});
test('transport enforces HTTP status byte limits redirect restrictions and timeout', async () => {
  const url = 'https://api.github.com/a';
  for (const response of [new Response('bad', { status: 429 }), new Response('12345'), new Response('', { status: 302, headers: { location: 'https://evil.test/x' } })]) {
    await assert.rejects(requestBytes(url, { limit: 4, fetchImpl: async () => response }));
  }
  await assert.rejects(requestBytes(url, { limit: 10, timeout: 10, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('timeout')))) }));
  assert.equal((await requestBytes(url, { limit: 10, fetchImpl: async () => new Response('ok') })).toString(), 'ok');
});
test('both package manifests must match trusted identity', async () => {
  const pkg = { name: 'devin-fusion-byok', publisher: 'local', version: '1.0.0' };
  const run = xml => async (_, args) => ({ stdout: args[2].endsWith('.json') ? JSON.stringify(pkg) : xml });
  await verifyPackage('file', '1.0.0', run('<Identity Id="devin-fusion-byok" Publisher="local" Version="1.0.0"/>'));
  for (const xml of ['<Identity Id="other" Publisher="local" Version="1.0.0"/>', '<!DOCTYPE x><Identity/>', '<Identity/><Identity/>']) await assert.rejects(verifyPackage('file', '1.0.0', run(xml)));
  await assert.rejects(verifyPackage('file', '1.0.1', run('<Identity/>')));
});
test('install validates hash size and package, supports retry, preserves file until installer exits', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
  try {
    const bytes = Buffer.from('test artifact'); const info = release('0.3.34');
    info.assets[0].size = bytes.length; info.assets[0].digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
    let wrong = true, fail = true, installs = 0, verified = 0;
    const { updater } = setup({ storagePath: root, confirm: async () => true,
      request: async url => url.includes('/latest') ? Buffer.from(JSON.stringify(info)) : wrong ? Buffer.from('bad') : bytes,
      verify: async () => { verified++; }, install: async ({ path: file }) => { installs++; assert.equal(fs.existsSync(file), true); if (fail) throw Error('private'); }
    });
    await updater.check(); await updater.installUpdate(); assert.equal(installs, 0); assert.equal(verified, 0);
    wrong = false; await updater.installUpdate(); assert.equal(installs, 1); assert.equal(updater.snapshot().phase, 'available');
    fail = false; await Promise.all([updater.installUpdate(), updater.installUpdate()]); assert.equal(installs, 2); assert.equal(updater.snapshot().phase, 'installed');
    assert.deepEqual(fs.readdirSync(root), []); updater.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('disposed pending checks cannot publish or notify, preferences suppress automatic work', async () => {
  let resolve, notified = 0;
  const { updater } = setup({ request: () => new Promise(r => { resolve = r; }), notify: () => notified++ });
  const pending = updater.check(); updater.dispose(); resolve(Buffer.from(JSON.stringify(release('0.3.34')))); await pending;
  assert.equal(notified, 0); assert.equal(updater.snapshot().latestVersion, null);
  const other = setup(); await other.updater.setAutoCheck(false); await other.updater.check(); assert.equal(other.calls(), 0);
  await other.updater.check({ force: true }); assert.equal(other.calls(), 1); other.updater.dispose();
});
test('controller routes updates separately from model settings and only opens trusted snapshot URL', async () => {
  const { createPanelController } = require('../src/panel/controller.cjs');
  const posts = [], actions = []; let receive, close;
  const disposable = { dispose() {} };
  const panel = { webview: { postMessage: async m => posts.push(m), onDidReceiveMessage: fn => { receive = fn; return disposable; } }, onDidDispose: fn => { close = fn; return disposable; }, dispose: () => close() };
  const state = { releaseUrl: 'https://github.com/kuobibulaien/devin-fusion-byok/releases' };
  const updater = { snapshot: () => state, check: async o => actions.push(['check', o.force]), installUpdate: async () => actions.push(['install']), ignore: async () => actions.push(['ignore']), setAutoCheck: async enabled => actions.push(['auto', enabled]) };
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel }, Uri: { parse: x => x }, env: { openExternal: async url => actions.push(['url', url]) } }, context: { subscriptions: [] }, manager: { dispatch() { throw Error('must not touch model settings'); } }, safeError: () => ({ message: 'error' }), updater });
  controller.open();
  for (const type of ['state','check','install','ignore','auto','release']) await receive({ id: type, type: 'update.' + type, payload: { enabled: false, url: 'https://evil.test' } });
  assert.deepEqual(actions, [['check', true], ['install'], ['ignore'], ['auto', false], ['url', state.releaseUrl]]);
  assert.equal(posts.filter(p => p.type === 'update-state').length, 6); panel.dispose();
});
test('update view is plain text and does not expose release payload as HTML', () => {
  const { updateMarkup, updateScript } = require('../src/panel/update-view.cjs');
  assert.match(updateMarkup(), /update-install/); assert.match(updateScript(), /textContent/); assert.doesNotMatch(updateScript(), /innerHTML/);
  assert.doesNotThrow(() => new Function('vscode', updateScript()));
});
