'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { locationToAuthority, injectSshRemoteForwardArgs, createRemoteTunnelManager } = require('../src/runtime/remote-tunnel.cjs');
function adapter(command, args) {
  const proc = spawn(command, args, { env: { ...process.env, VSCODE_CLI_EXE: '/nonexistent/windsurf-cli-test' } });
  function stream(source) { return { onDidReceiveMessage(fn) { source.on('data', fn); return { dispose: () => source.off('data', fn) }; } }; }
  return { stdin: proc.stdin, stdout: stream(proc.stdout), stderr: stream(proc.stderr), onExit: new Promise(resolve => proc.once('exit', (status, signal) => resolve({ status, signal }))) };
}
function setup(t, listener) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-tunnel-'));
  fs.writeFileSync(path.join(root, 'runtime-control.json'), JSON.stringify({ rootId: 'root-test' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new Promise(resolve => listener.listen(0, '127.0.0.1', () => {
    const workspace = { getRemoteExecServer: async () => ({ spawn: async (cmd, args) => adapter(cmd, args) }) };
    const manager = createRemoteTunnelManager({ root, workspace, port: listener.address().port, vscode: { workspace: { workspaceFolders: [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+host' } }] } } });
    t.after(() => { manager.dispose(); listener.close(); }); resolve(manager);
  }));
}
function get(port, pathname = '/') { return new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: pathname }, res => { let text = ''; res.on('data', data => { text += data; }); res.on('end', () => resolve(text)); }).on('error', reject); }); }

test('authorities and ssh arguments are precise and idempotent', () => {
  assert.equal(locationToAuthority({ kind: 'ssh', alias: 'box' }), 'ssh-remote+box');
  assert.equal(locationToAuthority({ kind: 'wsl', distro: 'Debian' }), 'wsl+Debian');
  assert.throws(() => locationToAuthority({ kind: 'cloud' }));
  const args = ['-v', '-T', '-D', '1234', 'host']; const result = injectSshRemoteForwardArgs(args);
  assert.deepEqual(result, ['-v', '-T', '-o', 'ExitOnForwardFailure=no', '-R', '127.0.0.1:39842:127.0.0.1:39842', '-D', '1234', 'host']);
  assert.deepEqual(injectSshRemoteForwardArgs(result), result); assert.deepEqual(args, ['-v', '-T', '-D', '1234', 'host']);
});
test('stdio tunnel multiplexes real requests and strict mode refuses occupied port', async t => {
  const server = http.createServer((req, res) => { if (req.url === '/health') { res.end('{}'); return; } res.end(req.url); });
  const manager = await setup(t, server);
  await assert.rejects(manager.ensureCurrentRemoteWindowTunnel(), /port_in_use/);
  const [one, two] = await Promise.all([manager.ensureTunnel('ssh-remote+host'), manager.ensureTunnel('ssh-remote+host')]);
  assert.equal(one, two); assert.notEqual(one, server.address().port);
  assert.deepEqual(await Promise.all([get(one, '/first'), get(one, '/second')]), ['/first', '/second']);
  assert.equal(manager.status()[0].mode, 'stdio');
});
test('direct mode requires matching service and root', async t => {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ service: 'devin-fusion-byok', rootId: 'root-test' })));
  const manager = await setup(t, server);
  assert.equal(await manager.ensureCurrentRemoteWindowTunnel(), server.address().port);
  assert.equal(manager.status()[0].mode, 'direct');
});

test('SSH spawn and resolver wrappers are scoped, reversible and do not wait for tunnel setup', async () => {
  const vm = require('node:vm'), module = { exports: {} }, calls = [], registrations = [];
  const child = { spawn(...args) { calls.push(args); return 'spawned'; } };
  const workspace = { registerRemoteAuthorityResolver(prefix, resolver) { registrations.push({ prefix, resolver }); return 'registered'; },
    getRemoteExecServer() { throw new Error('not ready'); } };
  const source = fs.readFileSync(require.resolve('../src/runtime/remote-tunnel.cjs'), 'utf8');
  vm.runInNewContext(source, { module, Buffer, URL, setTimeout, clearTimeout, process,
    require(name) { if (name === 'node:module') return { createRequire: () => key => key === 'vscode' ? { workspace } : child }; return require(name); } });
  const originalSpawn = child.spawn, originalRegister = workspace.registerRemoteAuthorityResolver;
  const handle = module.exports.installRemoteSupport({ vscode: { workspace: {} }, opensshMainPath: '/ssh/main.js', root: '/missing' });
  const args = ['-v', '-T', '-D', '1234'];
  child.spawn('ssh', args, { env: {} }); assert.equal(calls[0][1], args);
  child.spawn('ssh', args, { env: { SSH_ASKPASS: '/askpass' } }); assert.ok(calls[1][1].includes('-R'));
  const resolver = { async resolve() { return 'resolved'; } };
  assert.equal(workspace.registerRemoteAuthorityResolver('ssh-remote', resolver), 'registered');
  assert.equal(await registrations[0].resolver.resolve('ssh-remote+host'), 'resolved');
  handle.dispose(); assert.equal(child.spawn, originalSpawn); assert.equal(workspace.registerRemoteAuthorityResolver, originalRegister);
});
