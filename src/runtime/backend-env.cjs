'use strict';
const { createHash } = require('node:crypto');

// The detached runtime does not inherit the native CLI's http.proxy handling.
// Enable Node's proxy support at startup, keeping local LS/backend RPCs local.
function backendEnvironment(env, proxyUrl) {
  const result = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  if (typeof proxyUrl === 'string' && proxyUrl.trim()) {
    try {
      const proxy = new URL(proxyUrl.trim());
      if (['http:', 'https:'].includes(proxy.protocol)) {
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) result[key] = proxy.href;
      }
    } catch { /* Preserve inherited proxy settings when the editor has no valid HTTP proxy. */ }
  }
  if (['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some(key => result[key])) {
    result.NODE_USE_ENV_PROXY = '1';
    const bypass = [...new Set([...[result.NO_PROXY, result.no_proxy].filter(Boolean).join(',').split(',').map(value => value.trim()).filter(Boolean),
      'localhost', '127.0.0.1', '::1', '[::1]'])].join(',');
    result.NO_PROXY = bypass;
    result.no_proxy = bypass;
  }
  return result;
}

function networkIdentity(env) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
  return createHash('sha256').update(JSON.stringify(keys.map(key => [key, env[key] || '']))).digest('hex');
}

module.exports = { backendEnvironment, networkIdentity };
