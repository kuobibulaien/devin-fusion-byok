'use strict';
const { readKey } = require('./auth.cjs');
const { authorize } = require('./web.cjs');

// One-click authorization self-check for the control panel. It reads the local
// Devin login, exchanges it for a short-lived user token and reads the account
// policy. Only success/failure codes are kept; the credential is never returned.
const CHECK_MESSAGES = {
  ok: '已连接：代码搜索、网页搜索、网页读取三项能力都可以用。',
  web_search_disabled: '账号或团队关闭了网页搜索开关，网页搜索和网页读取暂时不能用；代码搜索不受影响。',
  unauthenticated: '本机 Devin 的登录已失效，请在 Devin 里重新登录后再试一次。',
  fast_context_disabled: '账号或团队关闭了 Fast Context，代码搜索暂时不能用，请联系管理员。',
  credentials_unavailable: '没有读到本机 Devin 的登录信息，请确认已经在 Devin 里登录。',
  insecure_tls_configuration: '系统关闭了 HTTPS 证书校验，请恢复后再试，不会在关闭校验时发送任何凭证。',
  unavailable: '暂时连不上官方服务，检查一下网络后再试。',
};
const KNOWN = new Set(Object.keys(CHECK_MESSAGES));

function createSelfCheck({ loadKey = readKey, verify = options => authorize(options) } = {}) {
  let result;
  async function run() {
    try {
      await verify({ key: loadKey() });
      result = { ok: true, reason: 'ok', at: Date.now() };
    } catch (error) {
      const code = String(error?.message || '');
      result = { ok: false, reason: KNOWN.has(code) ? code : 'unavailable', at: Date.now() };
    }
    return result;
  }
  return { run, state: () => result, message: code => CHECK_MESSAGES[KNOWN.has(code) ? code : 'unavailable'] };
}

module.exports = { createSelfCheck, CHECK_MESSAGES };
