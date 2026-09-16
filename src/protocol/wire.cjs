'use strict';

// Protobuf / Connect field layout independently adapted from the MIT-licensed
// jornlin/devin-byok-plus protocol implementation. No generated client patches.
const zlib = require('node:zlib');
const MAX_BODY = 64 * 1024 * 1024;

function varint(value) {
  let rest = BigInt(value);
  if (rest < 0n || rest > 0xffffffffffffffffn) throw new RangeError('Invalid uint64');
  const bytes = [];
  do { bytes.push(Number(rest & 127n) | (rest > 127n ? 128 : 0)); rest >>= 7n; } while (rest);
  return Buffer.from(bytes);
}

function readVarint(buffer, offset) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset + i >= buffer.length) throw new Error('Truncated protobuf varint');
    const byte = buffer[offset + i];
    if (i === 9 && byte > 1) throw new Error('Oversized protobuf varint');
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return { value, next: offset + i + 1 };
  }
  throw new Error('Oversized protobuf varint');
}

function parseFields(input) {
  const buffer = Buffer.from(input);
  const result = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (!number || number > 0x1fffffff) throw new Error('Invalid protobuf field number');
    let value;
    if (wire === 0) {
      const decoded = readVarint(buffer, offset);
      offset = decoded.next;
      value = decoded.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decoded.value) : decoded.value;
    } else if (wire === 1 || wire === 5 || wire === 2) {
      let length = wire === 1 ? 8 : 4;
      if (wire === 2) {
        const decoded = readVarint(buffer, offset);
        offset = decoded.next;
        if (decoded.value > BigInt(buffer.length - offset)) throw new Error('Truncated protobuf bytes');
        length = Number(decoded.value);
      }
      if (offset + length > buffer.length) throw new Error('Truncated protobuf fixed field');
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else {
      throw new Error('Unsupported protobuf wire type');
    }
    result.push({ number, wire, value, raw: buffer.subarray(start, offset) });
  }
  return result;
}

function fields(buffer, number) { return parseFields(buffer).filter(field => field.number === number); }
function str(buffer, number) { return fields(buffer, number).find(field => field.wire === 2)?.value.toString('utf8') || ''; }
function num(buffer, number) { return fields(buffer, number).find(field => field.wire === 0)?.value ?? 0; }
function key(number, wire) {
  if (!Number.isInteger(number) || number < 1 || number > 0x1fffffff) throw new Error('Invalid protobuf field number');
  return varint(BigInt(number) * 8n + BigInt(wire));
}
function s(number, value) { return m(number, Buffer.from(String(value), 'utf8')); }
function v(number, value) { return Buffer.concat([key(number, 0), varint(value)]); }
function m(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([key(number, 2), varint(bytes.length), bytes]);
}
function frame(data, flags = 0) {
  const buffer = Buffer.from(data);
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(buffer.length, 1);
  return Buffer.concat([header, buffer]);
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || '';
  return String(Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1] || '');
}
function ungzip(buffer) { return zlib.gunzipSync(buffer, { maxOutputLength: MAX_BODY }); }

function decode(body, headers = {}) {
  let buffer = Buffer.from(body);
  if (buffer.length > MAX_BODY) throw new Error('Protocol body too large');
  const type = header(headers, 'content-type').split(';')[0].trim().toLowerCase() || 'application/proto';
  const gzip = header(headers, 'content-encoding').toLowerCase() === 'gzip';
  if (gzip) buffer = ungzip(buffer);
  const framed = type.startsWith('application/connect+') || type.startsWith('application/grpc');
  const json = type.includes('json');
  let compressed = false;
  if (framed) {
    const messages = [];
    let offset = 0;
    while (offset < buffer.length) {
      if (offset + 5 > buffer.length) throw new Error('Truncated Connect frame');
      const flags = buffer[offset];
      const length = buffer.readUInt32BE(offset + 1);
      offset += 5;
      if (flags & ~3 || offset + length > buffer.length) throw new Error('Invalid Connect frame');
      let message = buffer.subarray(offset, offset + length);
      offset += length;
      if (flags & 1) { message = ungzip(message); compressed = true; }
      if (!(flags & 2)) messages.push(message);
    }
    if (messages.length !== 1) throw new Error('Expected one Connect request message');
    buffer = messages[0];
  }
  return { data: json ? JSON.parse(buffer.toString('utf8')) : buffer, framed, json, type, gzip, compressed };
}

function encode(data, format = {}) {
  let buffer = format.json ? Buffer.from(JSON.stringify(data)) : Buffer.from(data);
  if (format.framed) {
    buffer = Buffer.concat([
      frame(format.compressed ? zlib.gzipSync(buffer) : buffer, format.compressed ? 1 : 0),
      frame(Buffer.from('{}'), 2),
    ]);
  }
  return format.gzip ? zlib.gzipSync(buffer) : buffer;
}

module.exports = { parseFields, fields, str, num, s, v, m, decode, encode, frame };
