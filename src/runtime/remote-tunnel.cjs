'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createRequire } = require('node:module');

function locationToAuthority(location) {
  if (location?.kind === 'ssh' && typeof location.alias === 'string' && location.alias) return 'ssh-remote+' + location.alias;
  if (location?.kind === 'wsl' && typeof location.distro === 'string' && location.distro) return 'wsl+' + location.distro;
  throw new TypeError('Unsupported remote location');
}
function injectSshRemoteForwardArgs(args, port = 39842) {
  if (!Array.isArray(args) || !args.includes('-v') || !args.includes('-T') || !args.includes('-D')) return args;
  const forward = `127.0.0.1:${port}:127.0.0.1:${port}`;
  if (args.some((arg, i) => (arg === '-R' && args[i + 1] === forward) || arg === '-R' + forward)) return args;
  const result = args.slice(); result.splice(result.indexOf('-D'), 0, '-o', 'ExitOnForwardFailure=no', '-R', forward); return result;
}
// Executed by the remote Node runtime. stdout is reserved for the handshake and binary frames.
function remoteProgram(port, rootId, strict) {
  const net = require('node:net'), http = require('node:http');
  let sequence = 0, pending = Buffer.alloc(0); const sockets = new Map();
  function frame(type, id, data = Buffer.alloc(0)) {
    const header = Buffer.alloc(9); header[0] = type; header.writeUInt32BE(id, 1); header.writeUInt32BE(data.length, 5);
    process.stdout.write(Buffer.concat([header, data]));
  }
  let started = false;
  function listen() {
    if (started) return; started = true;
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      const id = ++sequence; sockets.set(id, socket); frame(1, id);
      socket.on('data', data => frame(2, id, data));
      socket.on('end', () => frame(3, id));
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(id); frame(4, id); });
    });
    let fallback = false;
    server.on('error', error => {
      if (error.code === 'EADDRINUSE' && !strict && !fallback) { fallback = true; server.listen(0, '127.0.0.1'); return; }
      process.stdout.write('ERROR:' + (error.code === 'EADDRINUSE' ? 'port_in_use' : 'listen_failed') + '\n'); process.exitCode = 1;
    });
    server.on('listening', () => process.stdout.write(`READY:${server.address().port}:stdio\n`));
    server.listen(port, '127.0.0.1');
    process.stdin.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 9) {
        const type = pending[0], id = pending.readUInt32BE(1), length = pending.readUInt32BE(5);
        if (length > 1024 * 1024) { process.exit(1); return; }
        if (pending.length < 9 + length) break;
        const body = pending.subarray(9, 9 + length); pending = pending.subarray(9 + length);
        const socket = sockets.get(id); if (!socket) continue;
        if (type === 2) socket.write(body); else if (type === 3) socket.end(); else if (type === 4) socket.destroy();
      }
    });
    process.stdin.on('end', () => { for (const socket of sockets.values()) socket.destroy(); server.close(); });
  }
  const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1200 }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(); });
    res.on('end', () => { try { const health = JSON.parse(body); if (res.statusCode === 200 && health.service === 'devin-fusion-byok' && health.rootId === rootId) { process.stdout.write(`READY:${port}:direct\n`); return; } } catch {} listen(); });
  });
  let failed = false; req.on('timeout', () => req.destroy()); req.on('error', () => { if (!failed) { failed = true; listen(); } });
}
function createRemoteTunnelManager({ workspace, vscode, root, port = 39842, isEnabled = () => true, log = () => {} }) {
  const entries = new Map(); let disposed = false;
  function frame(type, id, data = Buffer.alloc(0)) { const h = Buffer.alloc(9); h[0] = type; h.writeUInt32BE(id, 1); h.writeUInt32BE(data.length, 5); return Buffer.concat([h, data]); }
  function close(entry) {
    if (entry.closed) return; entry.closed = true;
    for (const socket of entry.sockets.values()) socket.destroy(); entry.sockets.clear();
    entry.subscription?.dispose(); entry.stderrSubscription?.dispose();
    try { entry.child?.stdin.end(); } catch {}
    if (entries.get(entry.authority) === entry) entries.delete(entry.authority);
  }
  async function start(entry) {
    const identity = JSON.parse(fs.readFileSync(path.join(root, 'runtime-control.json'), 'utf8'));
    if (typeof identity.rootId !== 'string' || !identity.rootId) throw new Error('runtime_identity_unavailable');
    const server = await workspace.getRemoteExecServer(entry.authority, { reconnection: false, quiet: true, mayPrompt: () => false });
    if (!server || disposed || !isEnabled()) throw new Error('remote_exec_unavailable');
    const script = `(${remoteProgram.toString()})(${JSON.stringify(port)},${JSON.stringify(identity.rootId)},${entry.strict});`;
    const shell = 'for n in "$(dirname "$VSCODE_CLI_EXE")"/bin/*/node "$HOME"/.devin-server/bin/*/node; do if [ -x "$n" ]; then exec "$n" -e "$1"; fi; done; exec node -e "$1"';
    const child = await server.spawn('sh', ['-c', shell, 'sh', script]); entry.child = child;
    if (disposed || !isEnabled() || entry.closed) { try { child.stdin.end(); } catch {} close(entry); throw new Error('remote_tunnel_disposed'); }
    let input = Buffer.alloc(0), ready = false;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const fail = code => { if (!settled) { settled = true; reject(new Error(code)); } close(entry); };
      const timeout = setTimeout(() => fail('remote_tunnel_timeout'), 15000); timeout.unref?.();
      const send = (type, id, data) => { if (!entry.closed) try { child.stdin.write(frame(type, id, data)); } catch { close(entry); } };
      entry.subscription = child.stdout.onDidReceiveMessage(chunk => {
        input = Buffer.concat([input, Buffer.from(chunk)]);
        if (!ready) {
          const end = input.indexOf(10); if (end < 0) { if (input.length > 1024) fail('remote_tunnel_bad_ready'); return; }
          const line = input.subarray(0, end).toString(); input = input.subarray(end + 1);
          const match = /^READY:(\d+):(direct|stdio)$/.exec(line);
          if (!match || +match[1] < 1 || +match[1] > 65535 || (entry.strict && +match[1] !== port)) { fail(line.startsWith('ERROR:') ? line.slice(6) : 'remote_tunnel_bad_ready'); return; }
          ready = true; entry.port = +match[1]; entry.mode = match[2]; clearTimeout(timeout); settled = true; resolve(entry.port);
        }
        if (entry.mode !== 'stdio') return;
        while (input.length >= 9) {
          const type = input[0], id = input.readUInt32BE(1), length = input.readUInt32BE(5);
          if (length > 1024 * 1024) { close(entry); return; }
          if (input.length < 9 + length) return;
          const body = input.subarray(9, 9 + length); input = input.subarray(9 + length);
          if (type === 1 && !entry.sockets.has(id)) {
            const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true }); entry.sockets.set(id, socket);
            socket.on('data', data => send(2, id, data)); socket.on('end', () => send(3, id)); socket.on('error', () => {});
            socket.on('close', () => { entry.sockets.delete(id); send(4, id); });
          } else { const socket = entry.sockets.get(id); if (!socket) continue; if (type === 2) socket.write(body); else if (type === 3) socket.end(); else if (type === 4) socket.destroy(); }
        }
      });
      entry.stderrSubscription = child.stderr?.onDidReceiveMessage?.(() => {});
      Promise.resolve(child.onExit).then(() => { clearTimeout(timeout); if (!settled) fail('remote_tunnel_exited'); else close(entry); }, () => { clearTimeout(timeout); fail('remote_tunnel_exited'); });
    });
  }
  function ensureTunnel(authority, { strictPort = false } = {}) {
    if (disposed || !isEnabled()) return Promise.reject(new Error('remote_tunnel_disabled'));
    if (typeof authority !== 'string' || !/^(ssh-remote|wsl)\+[^\s]+$/.test(authority)) return Promise.reject(new Error('invalid_remote_authority'));
    const existing = entries.get(authority);
    if (existing) return existing.promise.then(value => { if (strictPort && value !== port) throw new Error('port_in_use'); return value; });
    const entry = { authority, strict: strictPort, sockets: new Map(), closed: false }; entries.set(authority, entry);
    entry.promise = start(entry).catch(error => { close(entry); throw error; }); return entry.promise;
  }
  function currentAuthority() {
    const uris = [vscode.workspace?.workspaceFile, ...(vscode.workspace?.workspaceFolders || []).map(folder => folder.uri)];
    return uris.find(uri => uri?.scheme === 'vscode-remote' && uri.authority)?.authority;
  }
  return {
    ensureTunnel,
    resolveRemoteServerUrl: async location => 'http://127.0.0.1:' + await ensureTunnel(locationToAuthority(location)),
    ensureCurrentRemoteWindowTunnel() { const authority = currentAuthority(); if (!authority) return Promise.reject(new Error('remote_authority_unavailable')); return ensureTunnel(authority, { strictPort: true }); },
    status() { return [...entries.values()].map(({ authority, mode, port: remotePort }) => ({ authority, mode: mode || 'connecting', port: remotePort || null })); },
    dispose() { disposed = true; for (const entry of [...entries.values()]) close(entry); },
  };
}
function installRemoteSupport({ vscode, nativeMainPath, opensshMainPath, root, port = 39842, isEnabled = () => true, log = () => {} }) {
  const apiPath = opensshMainPath || nativeMainPath;
  if (!apiPath) throw new Error('remote_api_unavailable');
  const workspace = createRequire(apiPath)('vscode').workspace;
  const manager = createRemoteTunnelManager({ workspace, vscode, root, port, isEnabled, log });
  const restores = [];
  function wrap(obj, key, make) { const original = obj?.[key]; if (typeof original !== 'function') return; const descriptor = Object.getOwnPropertyDescriptor(obj, key), wrapper = make(original); obj[key] = wrapper; restores.push(() => { if (obj[key] === wrapper) { if (descriptor) Object.defineProperty(obj, key, descriptor); else delete obj[key]; } }); }
  if (opensshMainPath) {
    const child = createRequire(opensshMainPath)('child_process');
    wrap(child, 'spawn', original => function (command, args, options, ...rest) {
      const env = options?.env || {};
      if (isEnabled() && (env.SSH_ASKPASS || Object.keys(env).some(key => key.startsWith('WINDSURF_SSH_ASKPASS_')))) args = injectSshRemoteForwardArgs(args, port);
      return Reflect.apply(original, this, [command, args, options, ...rest]);
    });
  }
  wrap(workspace, 'registerRemoteAuthorityResolver', original => function (prefix, resolver, ...rest) {
    if (['ssh-remote', 'wsl'].includes(prefix) && typeof resolver?.resolve === 'function') {
      const proxy = Object.create(resolver), resolve = resolver.resolve;
      proxy.resolve = async function (authority, ...args) { const result = await Reflect.apply(resolve, resolver, [authority, ...args]); if (isEnabled()) void manager.ensureTunnel(authority, { strictPort: true }).catch(() => { try { log('remote-tunnel-unavailable'); } catch {} }); return result; };
      resolver = proxy;
    }
    return Reflect.apply(original, this, [prefix, resolver, ...rest]);
  });
  return { ...manager, dispose() { manager.dispose(); for (const restore of restores.reverse()) restore(); } };
}
module.exports = { locationToAuthority, injectSshRemoteForwardArgs, createRemoteTunnelManager, installRemoteSupport, remoteProgram };
