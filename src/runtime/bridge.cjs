'use strict';
const http = require('node:http');
const https = require('node:https');
const wire = require('../protocol/wire.cjs');
const { augmentCatalog, collectNativeModels } = require('../catalog.cjs');
function countOwn(value, depth = 0) {
  if (depth > 7) return 0;
  if (Buffer.isBuffer(value)) {
    if (/^(?:fusion-)?dfbyok-/.test(value.toString('utf8'))) return 1;
    try { return wire.parseFields(value).filter(f => f.wire === 2).reduce((n, f) => n + countOwn(f.value, depth + 1), 0); } catch { return 0; }
  }
  if (typeof value === 'string') return /^(?:fusion-)?dfbyok-/.test(value) ? 1 : 0;
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + countOwn(v, depth + 1), 0);
  return 0;
}
const CATALOG = /^\/exa\.(?:language_server_pb\.LanguageServerService|api_server_pb\.ApiServerService|seat_management_pb\.SeatManagementService)\/(?:GetUserStatus|GetCliModelConfigs|GetCascadeModelConfigs|GetCommandModelConfigs)$|^\/exa\.seat_management_pb\.SeatManagementService\/GetCliTeamSettings$/;
function cors(request) {
  const origin = request.headers.origin;
  return origin && /^(?:vscode-file:\/\/vscode-app|vscode-webview:\/\/[^/]+|https?:\/\/(?:[a-z0-9.-]+\.)?localhost(?::\d+)?)$/.test(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {};
}
async function collect(stream, limit = 64 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of stream) { length += chunk.length; if (length > limit) throw new Error('Message too large'); chunks.push(chunk); }
  return Buffer.concat(chunks, length);
}
function forward(request, response, target, { body, getCatalog, log = () => {}, onFusionStatus, onNativeModels } = {}) {
  const headers = { ...request.headers, host: target.host };
  delete headers['proxy-connection'];
  if (body !== undefined) {
    headers['content-length'] = String(body.length);
    delete headers['transfer-encoding'];
  }
  const outbound = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, headers }, async upstream => {
    if (!CATALOG.test(target.pathname) || upstream.statusCode !== 200 || !getCatalog) {
      response.writeHead(upstream.statusCode, { ...upstream.headers, ...cors(request) }); upstream.pipe(response); return;
    }
    try {
      const original = await collect(upstream); let outgoing = original;
      const outgoingHeaders = { ...upstream.headers, ...cors(request) };
      try {
        const format = wire.decode(original, upstream.headers);
        const observed = collectNativeModels(format.data, { rpc: target.pathname, format });
        if (observed.length) try { onNativeModels?.(observed); } catch {}
        const catalog = getCatalog();
        const augmented = augmentCatalog(format.data, { rpc: target.pathname, format, catalog, onFusionStatus });
        outgoing = wire.encode(augmented, { ...format, gzip: false, compressed: false });
        delete outgoingHeaders['content-encoding']; delete outgoingHeaders['connect-content-encoding'];
        delete outgoingHeaders['transfer-encoding']; outgoingHeaders['content-length'] = String(outgoing.length);
        log('catalog', { rpc: target.pathname.split('/').pop(), models: catalog.models.length, format: format.type, changed: !original.equals(outgoing), before: original.length, after: outgoing.length, keys: format.json ? Object.keys(format.data) : undefined, beforeOwn: countOwn(format.data), afterOwn: countOwn(augmented) });
      } catch { log('catalog-error', { code: 'catalog_transform_failed' }); }
      response.writeHead(upstream.statusCode, outgoingHeaders); response.end(outgoing);
    } catch { response.destroy(); }
  });
  outbound.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on('aborted', () => outbound.destroy());
  response.on('close', () => { if (!response.writableFinished) outbound.destroy(); });
  if (body !== undefined) outbound.end(body); else request.pipe(outbound);
}
async function createLsBridge(originalPort, options) {
  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...cors(request), 'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': request.headers['access-control-request-headers'] || 'content-type,x-codeium-csrf-token,connect-protocol-version', 'access-control-max-age': '600' });
      response.end(); return;
    }
    // The renderer uses origin-form RPC paths. Never let an absolute URL turn
    // this per-window LS bridge into a proxy for another host.
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(400); response.end(); return;
    }
    forward(request, response, new URL('http://127.0.0.1:' + originalPort + request.url), options);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
module.exports = { createLsBridge, forward, collect, cors };
