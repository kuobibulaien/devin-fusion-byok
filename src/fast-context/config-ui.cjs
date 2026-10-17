'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setupPrompt, NAME } = require('./setup-prompt.cjs');
const { createSelfCheck } = require('./self-check.cjs');
function mcpConfig({ extensionPath, root, node = 'node' }) {
  if (!path.isAbsolute(extensionPath) || !path.isAbsolute(root)) throw new Error('absolute_paths_required');
  return { mcpServers: { 'fusion-fast-context': {
    command: node, args: [path.join(extensionPath, 'src/fast-context/server.cjs'), '--root', root],
  } } };
}
function resolveNode(env = process.env, platform = process.platform) {
  const binary = platform === 'win32' ? 'node.exe' : 'node';
  return String(env.PATH || '').split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir, binary)).find(file => path.isAbsolute(file) && fs.existsSync(file)) || 'node';
}
function isDirectory(value) {
  try { return path.isAbsolute(value) && fs.statSync(value).isDirectory(); } catch { return false; }
}
// Panel host for the Fast Context tab. Roots are limited to open local folders plus folders the user picked here.
function createFastContextHost({ vscode, context, resolve = resolveNode, check = createSelfCheck() }) {
  const picked = [];
  function roots() {
    const open = (vscode.workspace?.workspaceFolders || []).filter(folder => folder.uri?.scheme === 'file')
      .map(folder => ({ name: folder.name || path.basename(folder.uri.fsPath), path: folder.uri.fsPath, source: 'workspace' }));
    const extra = picked.filter(value => !open.some(root => root.path === value))
      .map(value => ({ name: path.basename(value) || value, path: value, source: 'picked' }));
    return [...open, ...extra];
  }
  function state() {
    const node = resolve();
    return { trusted: vscode.workspace?.isTrusted !== false, roots: roots(), node, nodeFound: path.isAbsolute(node),
      server: path.join(context.extensionPath, 'src/fast-context/server.cjs'), check: check.state() };
  }
  function build(root) {
    if (typeof root !== 'string' || !roots().some(item => item.path === root)) throw new Error('fast_context_root_not_allowed');
    if (!isDirectory(root)) throw new Error('fast_context_root_missing');
    return mcpConfig({ extensionPath: context.extensionPath, root, node: resolve() });
  }
  async function copy(kind, root) {
    if (vscode.workspace?.isTrusted === false) throw new Error('fast_context_untrusted');
    const config = build(root);
    const text = kind === 'prompt' ? setupPrompt(config.mcpServers[NAME]) : JSON.stringify(config, null, 2);
    await vscode.env.clipboard.writeText(text);
    return text.length;
  }
  async function pick() {
    const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: '允许 Fast Context 搜索此文件夹' });
    const folder = chosen?.[0];
    if (!folder || folder.scheme !== 'file' || !isDirectory(folder.fsPath)) return null;
    if (!picked.includes(folder.fsPath)) picked.push(folder.fsPath);
    if (picked.length > 10) picked.shift();
    return folder.fsPath;
  }
  return { state, copy, pick, build, selfCheck: check.run, checkMessage: check.message };
}
function registerFastContext({ vscode, context }) {
  const command = vscode.commands.registerCommand('devinFusionByok.fastContextMcp', async () => {
    if (vscode.workspace.isTrusted === false) {
      vscode.window.showWarningMessage('请先信任工作区，再生成 Fast Context 配置。'); return;
    }
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (!folders.length) { vscode.window.showWarningMessage('请先打开一个本地项目文件夹。'); return; }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择允许 Fast Context 搜索的项目' });
    if (!folder || folder.uri.scheme !== 'file') return;
    const confirm = await vscode.window.showInformationMessage(
      'Fast Context 使用现有 Devin 账号，会把问题和选中的代码片段发送到官方服务，可能消耗账号额度。配置只允许搜索所选项目，不含密钥。',
      { modal: true }, '生成配置');
    if (confirm !== '生成配置') return;
    const config = mcpConfig({ extensionPath: context.extensionPath, root: folder.uri.fsPath, node: resolveNode() });
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(config, null, 2) });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    vscode.window.showInformationMessage('把 fusion-fast-context 项合并到其他 Harness 的 MCP 配置。需要 Node.js 22.16+（推荐 24 LTS）；插件升级后请重新生成入口路径。');
  });
  context.subscriptions.push(command);
}
module.exports = { mcpConfig, registerFastContext, resolveNode, createFastContextHost };
