'use strict';
// Opt-in live acceptance. Sends only this synthetic fixture to the official API.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { createHash } = require('node:crypto');
async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fusion-fast-context-smoke-')));
  let child;
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/auth.cjs'), [
      "'use strict';",
      'function authenticate(token) {',
      "  return token === 'fixture-only-token';",
      '}',
      'module.exports = { authenticate };', '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'src/routes.cjs'), [
      "'use strict';",
      "const { authenticate } = require('./auth.cjs');",
      'function handleRequest(request) {',
      '  return authenticate(request.token) ? 200 : 401;',
      '}',
      'module.exports = { handleRequest };', '',
    ].join('\n'));
    const entry = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../src/fast-context/server.cjs');
    child = spawn(process.execPath, [entry, '--root', root],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    child.stderr.resume();
    const pending = new Map();
    let id = 0;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, timer } = pending.get(message.id);
        clearTimeout(timer); pending.delete(message.id); resolve(message);
      }
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('acceptance_timeout')); }, 125000);
      pending.set(requestId, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    const init = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await call('tools/list', {});
    const started = Date.now();
    const response = await call('tools/call', { name: 'code_search',
      arguments: { query: 'Find where request tokens are authenticated and how failed authentication becomes an HTTP 401. Include the implementation and its caller.', max_turns: 2 } });
    const result = response.result?.structuredContent;
    let verified = !response.error && !response.result?.isError && result?.files?.some(file => file.path === path.join(root, 'src/auth.cjs')) &&
      result?.files?.some(file => file.path === path.join(root, 'src/routes.cjs'));
    if (verified) {
      for (const file of result.files) {
        if (![path.join(root, 'src/auth.cjs'), path.join(root, 'src/routes.cjs')].includes(file.path)) { verified = false; break; }
        const data = await fs.readFile(file.path), lines = data.toString('utf8').trimEnd().split('\n');
        if (createHash('sha256').update(data).digest('hex') !== file.sha256) verified = false;
        for (const range of file.ranges) {
          const expected = lines.slice(range.start - 1, range.end).map((line, i) => `${range.start + i}: ${line}`).join('\n');
          if (range.start < 1 || range.end > lines.length || range.end < range.start || range.content !== expected) verified = false;
        }
      }
    }
    console.log(JSON.stringify({ initialized: Boolean(init.result), tools: tools.result?.tools.map(tool => tool.name),
      verified: Boolean(verified), duration_ms: Date.now() - started, response }, null, 2));
    if (!verified) process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null) {
      const exit = once(child, 'exit');
      child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exit; clearTimeout(kill);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
if (process.env.FUSION_FAST_CONTEXT_LIVE !== '1') {
  console.error('Set FUSION_FAST_CONTEXT_LIVE=1 to run the live, potentially billable, synthetic-fixture test.');
  process.exitCode = 1;
} else main().catch(() => { console.error('acceptance_failed'); process.exitCode = 1; });
