'use strict';
// GetDevstralStream interoperability adapted from SammySnake-d/fast-context-mcp
// (MIT, 39d2560d241a1aac167f6bbbc4660edcf231dc59). See THIRD_PARTY_NOTICES.md.
const { gzipSync, gunzipSync } = require('node:zlib');
const { s, v, m, frame, parseFields, num } = require('../protocol/wire.cjs');
const ORIGIN = 'https://server.self-serve.windsurf.com';
const API = '/exa.api_server_pb.ApiServerService/';
const MAX_RESPONSE = 2 * 1024 * 1024;
const ERROR_CODES = new Set(['unauthenticated', 'permission_denied', 'resource_exhausted', 'unavailable', 'deadline_exceeded']);
function metadata(key, jwt = '') {
  return Buffer.concat([s(1, 'windsurf'), s(2, '1.48.2'), s(3, key), s(4, 'en'),
    s(7, '1.9544.35'), s(12, 'windsurf'), s(21, jwt), m(30, Buffer.from([0, 1]))]);
}
function requestBody(key, jwt, messages, tools) {
  return Buffer.concat([m(1, metadata(key, jwt)), ...messages.map(message => m(2, Buffer.concat([
    v(2, message.role), s(3, message.content || ''),
    ...(message.call ? [m(6, Buffer.concat([s(1, message.call.id), s(2, message.call.name), s(3, JSON.stringify(message.call.args))]))] : []),
    ...(message.ref ? [s(7, message.ref)] : []),
  ]))), s(3, JSON.stringify(tools))]);
}
function parseStream(buffer) {
  let offset = 0, ended = false, size = 0, text = '';
  while (offset < buffer.length) {
    if (ended || offset + 5 > buffer.length) throw new Error('invalid_stream');
    const flags = buffer[offset], length = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (flags & ~3 || length > MAX_RESPONSE || offset + length > buffer.length) throw new Error('invalid_stream');
    let payload = buffer.subarray(offset, offset + length); offset += length;
    if (flags & 1) payload = gunzipSync(payload, { maxOutputLength: MAX_RESPONSE });
    size += payload.length;
    if (size > MAX_RESPONSE) throw new Error('response_too_large');
    if (flags & 2) {
      const trailer = JSON.parse(payload.toString('utf8'));
      if (trailer.error) throw new Error(ERROR_CODES.has(trailer.error.code) ? trailer.error.code : 'upstream_error');
      ended = true;
    } else {
      // The service emits protobuf string fragments. Parse every fragment and
      // the terminal trailer: an earlier answer never masks a later RPC error.
      const fields = parseFields(payload);
      text += fields.filter(field => field.wire === 2).map(field => field.value.toString('utf8')).join('');
    }
  }
  if (!ended) throw new Error('incomplete_stream');
  return text;
}
function parseCall(text) {
  // Current service emits both name[ARGS]{...} and name{...}.
  const marker = /\[TOOL_CALLS\](restricted_exec|answer)(?:\[ARGS\])?\s*(?=\{)/.exec(text);
  if (!marker) {
    const answer = text.match(/<ANSWER>[\s\S]*<\/ANSWER>\s*(?:<\/s>)?\s*$/);
    if (answer && !text.includes('[TOOL_CALLS]')) return { name: 'answer', args: { answer: answer[0].replace(/<\/s>\s*$/, '').trim() } };
    throw new Error('invalid_model_response');
  }
  const raw = text.slice(marker.index + marker[0].length).trim();
  if (raw[0] !== '{') throw new Error('invalid_model_response');
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      if (!/^(?:\s|<\/s>)*$/.test(raw.slice(i + 1))) throw new Error('invalid_model_response');
      try { return { name: marker[1], args: JSON.parse(raw.slice(0, i + 1)) }; }
      catch { throw new Error('invalid_model_response'); }
    }
  }
  throw new Error('invalid_model_response');
}
// Single transport policy for every official call: fixed HTTPS origin, no
// redirects, TLS never disabled, bounded responses, caller-cancellable.
async function post(route, body, { signal, request = fetch, streaming = false } = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('insecure_tls_configuration');
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await request(ORIGIN + route, {
    method: 'POST', redirect: 'error', signal: combined,
    headers: { 'content-type': streaming ? 'application/connect+proto' : 'application/proto',
      'connect-protocol-version': '1', 'user-agent': 'connect-go/1.18.1 (go1.25.5)',
      ...(streaming ? { 'connect-content-encoding': 'gzip', 'connect-accept-encoding': 'gzip', 'connect-timeout-ms': '30000' } : {}) },
    body: streaming ? frame(gzipSync(body), 1) : body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'permission_denied' :
      response.status === 429 ? 'resource_exhausted' : 'upstream_http_' + response.status);
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE) throw new Error('response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function createRemote({ key, signal, request = fetch }) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('insecure_tls_configuration');
  let jwt;
  return {
    async authorize() {
      const response = await post('/exa.auth_pb.AuthService/GetUserJwt', m(1, metadata(key)), { signal, request });
      jwt = parseFields(response).filter(field => field.wire === 2).map(field => field.value.toString('utf8'))
        .find(value => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value));
      if (!jwt) throw new Error('unauthenticated');
      // Fail closed on account-policy lookup failures. Do not bypass team bans.
      const settings = await post('/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings', m(1, metadata(key, jwt)), { signal, request });
      if (num(settings, 3)) throw new Error('fast_context_disabled');
      await post(API + 'CheckUserMessageRateLimit', Buffer.concat([m(1, metadata(key, jwt)), s(3, 'MODEL_SWE_1_6_FAST')]), { signal, request });
    },
    async complete(messages, tools) {
      if (!jwt) throw new Error('unauthenticated');
      const body = requestBody(key, jwt, messages, tools);
      if (body.length > 1024 * 1024) throw new Error('request_too_large');
      return parseCall(parseStream(await post(API + 'GetDevstralStream', body, { signal, request, streaming: true })));
    },
  };
}
module.exports = { metadata, requestBody, parseStream, parseCall, createRemote, post, ORIGIN, MAX_RESPONSE };
