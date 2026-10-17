'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { search, options, parseAnswer } = require('../src/fast-context/search.cjs');
const { createSnapshot } = require('../src/fast-context/files.cjs');
const { readKey, credentialPath } = require('../src/fast-context/auth.cjs');
const { mcpConfig, registerFastContext } = require('../src/fast-context/config-ui.cjs');
const { writeEnabled } = require('../src/fast-context/state.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fc-engine-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'auth.cjs'), 'function authenticate(token) {\n  return Boolean(token);\n}\n');
  return root;
}
const xml = '<ANSWER><file path="/codebase/auth.cjs"><range>1-3</range></file></ANSWER>';
test('multi-round search returns grounded snippets, timings and patterns', async t => {
  const root = await fixture(t); let rounds = 0, authorized = false;
  const remote = { async authorize() { authorized = true; }, async complete(messages) {
    assert.equal(authorized, true);
    if (++rounds === 1) return { name: 'restricted_exec', args: {
      command1: { type: 'rg', path: '/codebase', pattern: 'authenticate' },
      command2: { type: 'readfile', file: '/codebase/auth.cjs' },
    } };
    assert.match(messages.at(-1).content, /1:.*function authenticate/);
    return { name: 'answer', args: { answer: xml } };
  } };
  const result = await search({ query: 'find auth', include_content: true }, { root, remote });
  assert.equal(result.status, 'complete');
  assert.equal(result.rounds, 2);
  assert.equal(result.files[0].path, path.join(root, 'auth.cjs'));
  assert.match(result.files[0].ranges[0].content, /authenticate/);
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.search_patterns, ['authenticate']);
});
test('invalid arguments cannot expand the configured project or budget', () => {
  for (const input of [{}, { query: '' }, { query: 'a', project_path: '/etc' }, { query: 'a', max_turns: 6 },
    { query: 'a', max_turns: 1.5 }, { query: 'a', max_results: 0 }, { query: 'a', include_content: 'yes' }]) {
    assert.throws(() => options(input), /invalid_arguments/);
  }
});
test('unauthorized search never reads a repository', async () => {
  let opened = false;
  await assert.rejects(search({ query: 'x' }, {
    root: '/unused', remote: { authorize() { throw new Error('permission_denied'); } },
    snapshotFactory() { opened = true; },
  }), /permission_denied/);
  assert.equal(opened, false);
});
test('out-of-root paths and nonexistent or invalid ranges are discarded', async t => {
  const root = await fixture(t), snapshot = await createSnapshot(root);
  const result = await parseAnswer('<ANSWER><file path="/etc/passwd"><range>1-1</range></file><file path="/codebase/auth.cjs"><range>0-1</range><range>1-999</range><range>1-2</range></file></ANSWER>',
    snapshot, { maxResults: 10, includeContent: false });
  assert.equal(result.discarded, 3);
  assert.deepEqual(result.files[0].ranges, [{ start: 1, end: 2 }]);
});
test('changed files, duplicates and hallucinated files do not produce valid snippets', async t => {
  const root = await fixture(t), snapshot = await createSnapshot(root);
  await fs.writeFile(path.join(root, 'auth.cjs'), 'changed\n');
  const result = await parseAnswer(xml, snapshot, { maxResults: 10, includeContent: true });
  assert.equal(result.files.length, 0); assert.equal(result.discarded, 1);
});
test('empty answer is distinct from malformed model output', async t => {
  const snapshot = await createSnapshot(await fixture(t));
  const config = { maxResults: 10, includeContent: false };
  assert.deepEqual((await parseAnswer('<ANSWER></ANSWER>', snapshot, config)).files, []);
  await assert.rejects(parseAnswer('<ANSWER>arbitrary text</ANSWER>', snapshot, config), /invalid_model_response/);
  await assert.rejects(parseAnswer('error', snapshot, config), /invalid_model_response/);
});
test('model cannot exceed command or round limits', async t => {
  const root = await fixture(t);
  for (const args of [{ command9: { type: 'tree' } }, {}, { command1: { type: 'tree' } }]) {
    const remote = { async authorize() {}, async complete() { return { name: 'restricted_exec', args }; } };
    await assert.rejects(search({ query: 'x', max_turns: 1 }, { root, remote }), /invalid_model_response|search_budget_exhausted/);
  }
});
test('native eight-command batches are supported, never more than eight', async t => {
  const root = await fixture(t); let calls = 0;
  const result = await search({ query: 'auth' }, { root, remote: {
    async authorize() {},
    async complete() {
      if (++calls === 1) return { name: 'restricted_exec', args: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => ['command' + (i + 1), { type: 'readfile', file: '/codebase/auth.cjs' }])) };
      return { name: 'answer', args: { answer: xml } };
    },
  } });
  assert.equal(result.status, 'complete');
  assert.equal(result.command_errors, 0);
});
test('failed model commands mark the result partial', async t => {
  const root = await fixture(t); let round = 0;
  const remote = { async authorize() {}, async complete() {
    return ++round === 1 ? { name: 'restricted_exec', args: { command1: { type: 'exec', command: 'touch x' } } }
      : { name: 'answer', args: { answer: xml } };
  } };
  const result = await search({ query: 'x' }, { root, remote });
  assert.equal(result.status, 'partial'); assert.equal(result.command_errors, 1);
  await assert.rejects(fs.stat(path.join(root, 'x')), /ENOENT/);
});
test('authentication uses only known record, read-only, and errors redact underlying values', async t => {
  const root = await fixture(t), dbPath = path.join(root, 'state.vscdb');
  await fs.writeFile(dbPath, '');
  let closed = false;
  class Database {
    constructor(file, opts) { assert.equal(file, dbPath); assert.deepEqual(opts, { readOnly: true }); }
    prepare(query) {
      assert.equal(query, "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
      return { get: () => ({ value: JSON.stringify({ apiKey: 'fixture-key' }) }) };
    }
    close() { closed = true; }
  }
  assert.equal(readKey({ env: {}, dbPath, database: Database }), 'fixture-key');
  assert.equal(closed, true);
  assert.equal(readKey({ env: { WINDSURF_API_KEY: 'env-key' }, dbPath }), 'env-key');
  assert.throws(() => readKey({ env: {}, dbPath, database: class { constructor() { throw new Error('SECRET'); } } }), /^Error: credentials_unavailable$/);
  assert.match(credentialPath({ platform: 'darwin', home: '/home/user' }), /Devin\/User\/globalStorage\/state.vscdb$/);
});
test('MCP configuration has fixed root, package entry and no credentials', () => {
  const config = mcpConfig({ extensionPath: '/plugin', root: '/project', node: '/bin/node' });
  assert.deepEqual(config.mcpServers['fusion-fast-context'], { command: '/bin/node',
    args: ['/plugin/src/fast-context/server.cjs', '--root', '/project'] });
  assert.doesNotMatch(JSON.stringify(config), /api.?key|token|password/i);
});
test('config UI refuses untrusted workspace and does not alter harness files', async () => {
  let handler, warned = false;
  registerFastContext({ vscode: {
    commands: { registerCommand(name, fn) { handler = fn; return { dispose() {} }; } },
    workspace: { isTrusted: false }, window: { showWarningMessage() { warned = true; } },
  }, context: { subscriptions: [] } });
  await handler(); assert.equal(warned, true);
});
test('config UI generates an unsaved document only after explicit confirmation', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'fc-cmd-'));
  for (const confirmed of [true, false]) {
    let handler, document;
    const vscode = {
      commands: { registerCommand(name, fn) { handler = fn; return { dispose() {} }; } },
      workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/project' } }],
        async openTextDocument(value) { document = value; return value; } },
      window: { async showInformationMessage(text, ...args) { return args.length && confirmed ? '生成配置' : undefined; },
        async showTextDocument(value) { assert.equal(value, document); } },
    };
    const warnings = [];
    vscode.window.showWarningMessage = async text => { warnings.push(text); };
    const context = { extensionPath: '/plugin', subscriptions: [], globalStorageUri: { fsPath: storage } };
    registerFastContext({ vscode, context });
    // Off by default: nothing is generated until the user enables it in the panel.
    await fs.rm(path.join(storage, 'external-mcp.json'), { force: true });
    await handler();
    assert.equal(document, undefined);
    assert.match(warnings[0], /还没有开启/);
    writeEnabled(storage, true);
    await handler();
    if (confirmed) assert.deepEqual(JSON.parse(document.content).mcpServers['fusion-fast-context'].args,
      [path.join(storage, 'fusion-mcp.cjs'), '--root', '/project']);
    else assert.equal(document, undefined);
  }
  await fs.rm(storage, { recursive: true });
});
test('snippet truncation is explicit and returned ranges stay valid', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'long.js'), Array.from({ length: 110 }, (_, i) => `line ${i}`).join('\n'));
  const snapshot = await createSnapshot(root);
  const result = await parseAnswer('<ANSWER><file path="/codebase/long.js"><range>1-110</range></file></ANSWER>',
    snapshot, { maxResults: 10, includeContent: true });
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].ranges[0].end, 110);
  assert.equal(result.files[0].ranges[0].content_end, 100);
  assert.equal(result.files[0].ranges[0].truncated, true);
});
test('one malformed model response can be corrected without executing guessed commands', async t => {
  const root = await fixture(t); let calls = 0;
  const result = await search({ query: 'auth', max_turns: 1 }, { root, remote: {
    async authorize() {},
    async complete(messages) {
      if (++calls === 1) throw new Error('invalid_model_response');
      assert.match(messages.at(-1).content, /Nothing from that response was executed/);
      return { name: 'answer', args: { answer: xml } };
    },
  } });
  assert.equal(result.format_repairs, 1);
  assert.equal(result.rounds, 2);
  assert.equal(result.status, 'complete');
});
test('format repair is bounded and never retries permission or stream errors', async t => {
  const root = await fixture(t);
  for (const code of ['invalid_model_response', 'permission_denied', 'incomplete_stream']) {
    let calls = 0;
    await assert.rejects(search({ query: 'x' }, { root, remote: {
      async authorize() {}, async complete() { calls++; throw new Error(code); },
    } }), new RegExp(code));
    assert.equal(calls, code === 'invalid_model_response' ? 2 : 1);
  }
});
