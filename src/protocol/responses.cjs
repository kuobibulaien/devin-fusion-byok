'use strict';

const { randomUUID } = require('node:crypto');
const { frame } = require('./wire.cjs');
const { textChunk, thinkingChunk, toolChunk, stopChunk } = require('./chat.cjs');
const { createTracker } = require('../runtime/monitor.cjs');
const MAX_SSE_BUFFER = 64 * 1024 * 1024;

function isChatFormat(format = '') { return /chat[-_\/]?completions|^(?:chat|openai)$/.test(format); }
function endpoint(provider) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
  const chat = isChatFormat(provider.apiFormat);
  url.pathname = url.pathname.replace(/\/(responses|chat\/completions)\/?$/, '').replace(/\/$/, '') + (chat ? '/chat/completions' : '/responses');
  url.search = '';
  url.hash = '';
  return { url, chat };
}

function contentOf(message, chat) {
  if (!message.images?.length) return message.content;
  const parts = [];
  if (message.content !== '') parts.push(chat ? { type: 'text', text: message.content } : { type: 'input_text', text: message.content });
  for (const image of message.images) {
    const url = `data:${image.mimeType};base64,${image.base64}`;
    parts.push(chat ? { type: 'image_url', image_url: { url } } : { type: 'input_image', image_url: url });
    if (image.caption) parts.push(chat ? { type: 'text', text: image.caption } : { type: 'input_text', text: image.caption });
  }
  return parts;
}

function buildRequestBody(request, route, provider) {
  const chat = isChatFormat(provider.apiFormat);
  const messages = [];
  if (request.systemPrompt !== '') messages.push({ role: chat ? 'system' : 'developer', content: request.systemPrompt });
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push(chat ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content } : { type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    const content = contentOf(message, chat);
    if (chat) {
      const item = { role: message.role, content };
      if (message.toolCalls?.length) item.tool_calls = message.toolCalls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }));
      messages.push(item);
    } else {
      // A native message stores text before its repeated tool calls. Preserve
      // that sequence and keep every system message at its original position.
      if (content !== '' || !message.toolCalls?.length) messages.push({ role: message.role === 'system' ? 'developer' : message.role, content });
      for (const tool of message.toolCalls || []) messages.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments });
    }
  }
  const body = { model: route.model, [chat ? 'messages' : 'input']: messages, stream: true };
  if (chat) body.stream_options = { include_usage: true };
  const maxTokens = request.maxTokens ?? route.maxOutputTokens ?? route.maxTokens ?? provider.maxOutputTokens ?? provider.maxTokens;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) body[chat ? 'max_completion_tokens' : 'max_output_tokens'] = maxTokens;
  if (route.effort) {
    if (chat) body.reasoning_effort = route.effort;
    else body.reasoning = { effort: route.effort, ...(route.effort === 'none' ? {} : { summary: 'auto' }) };
  }
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => chat ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } } : { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters });
    const choice = request.toolChoice;
    if (choice?.name) body.tool_choice = chat ? { type: 'function', function: { name: choice.name } } : { type: 'function', name: choice.name };
    else if (choice) {
      const type = typeof choice === 'string' ? choice : choice.type;
      if (['auto', 'none', 'required', 'any'].includes(type)) body.tool_choice = type === 'any' ? 'required' : type;
    }
  }
  return body;
}

function parseEvent(raw) {
  let event = '';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const joined = data.join('\n');
  if (joined.trim() === '[DONE]') return { type: 'done' };
  let value;
  try {
    value = JSON.parse(joined);
  } catch {
    const err = new Error('Invalid SSE event JSON');
    err.code = 'upstream_invalid_json';
    throw err;
  }
  return { type: value.type || event, data: value };
}

async function* events(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER) {
      const err = new Error('SSE frame too large');
      err.code = 'upstream_content_type';
      throw err;
    }
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parseEvent(buffer); if (event) yield event; }
}

function processor(id, uid, chat, emit) {
  const calls = new Map();
  const itemIndexes = new Map();
  const texts = new Map();
  let terminal = false;
  let reason = 2;
  let finished = false;
  const getCall = (index, itemId) => {
    const key = index ?? itemIndexes.get(itemId) ?? itemId;
    if (key === undefined) {
      const err = new Error('Tool call has no index');
      err.code = 'upstream_invalid_tool';
      throw err;
    }
    if (itemId) itemIndexes.set(itemId, key);
    if (!calls.has(key)) calls.set(key, { id: '', name: '', arguments: '', complete: undefined });
    return calls.get(key);
  };
  const text = async (key, value, complete = false, thinking = false) => {
    if (typeof value !== 'string') return;
    const previous = texts.get(key) || '';
    if (complete && !value.startsWith(previous)) {
      const err = new Error('Inconsistent completed text');
      err.code = 'upstream_invalid_json';
      throw err;
    }
    const delta = complete ? value.slice(previous.length) : value;
    texts.set(key, complete ? value : previous + value);
    if (delta) await emit(thinking ? thinkingChunk(id, delta) : textChunk(id, delta));
  };
  const item = async (value, index, done) => {
    if (value.type === 'function_call') {
      const call = getCall(index, value.id);
      if (value.call_id || value.id) call.id = value.call_id || value.id;
      if (value.name) call.name = value.name;
      if (typeof value.arguments === 'string' && (done || value.arguments)) {
        if (done) call.complete = value.arguments;
        else call.arguments = value.arguments;
      }
    } else if (done && value.type === 'message') {
      for (const [contentIndex, part] of (value.content || []).entries()) {
        if (part.type === 'output_text') await text(`${index}:${contentIndex}`, part.text, true);
      }
    }
  };
  return {
    get terminal() { return terminal; },
    async event(event) {
      if (finished) return;
      const data = event.data;
      if (event.type === 'done') {
        if (!terminal && chat) terminal = true;
        return;
      }
      if (!data || data.error) {
        const err = new Error('Upstream stream error');
        err.code = 'upstream_stream_error';
        throw err;
      }
      if (chat) {
        for (const choice of data.choices || []) {
          if ((choice.index ?? 0) !== 0) continue;
          const delta = choice.delta || choice.message || {};
          if (delta.content) await text('chat', delta.content);
          if (delta.reasoning_content || delta.reasoning) await text('reasoning', delta.reasoning_content || delta.reasoning, false, true);
          for (const tool of delta.tool_calls || []) {
            const call = getCall(tool.index ?? 0);
            if (tool.id) call.id += tool.id;
            if (tool.function?.name) call.name += tool.function.name;
            if (typeof tool.function?.arguments === 'string') call.arguments += tool.function.arguments;
          }
          if (choice.finish_reason) {
            terminal = true;
            reason = choice.finish_reason === 'length' ? 3 : choice.finish_reason === 'content_filter' ? 11 : 2;
          }
        }
        return;
      }
      switch (event.type) {
        case 'response.output_item.added': await item(data.item, data.output_index, false); break;
        case 'response.output_item.done': await item(data.item, data.output_index, true); break;
        case 'response.function_call_arguments.delta': getCall(data.output_index, data.item_id).arguments += data.delta || ''; break;
        case 'response.function_call_arguments.done': getCall(data.output_index, data.item_id).complete = data.arguments; break;
        case 'response.output_text.delta': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.delta); break;
        case 'response.output_text.done': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.text, true); break;
        case 'response.reasoning.delta':
        case 'response.reasoning_summary_text.delta': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.delta, false, true); break;
        case 'response.completed':
          if (data.response?.status && data.response.status !== 'completed') {
            const err = new Error('Unexpected completion status');
            err.code = 'upstream_stream_error';
            throw err;
          }
          for (const [index, value] of (data.response?.output || []).entries()) await item(value, index, true);
          terminal = true;
          break;
        case 'response.incomplete': terminal = true; reason = 3; break;
        case 'response.failed':
        case 'error': {
          const err = new Error('Upstream response failed');
          err.code = 'upstream_stream_error';
          throw err;
        }
      }
    },
    async finish() {
      if (finished) return [];
      if (!terminal) {
        const err = new Error('Upstream stream ended without completion');
        err.code = 'upstream_stream_incomplete';
        throw err;
      }
      const tools = [];
      const orderedCalls = [...calls.entries()].sort(([left], [right]) => typeof left === 'number' && typeof right === 'number' ? left - right : 0);
      if (reason === 2) for (const [, call] of orderedCalls) {
        const args = call.complete ?? call.arguments;
        if (!call.name || !call.id || typeof args !== 'string') {
          const err = new Error('Incomplete tool call');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        try {
          JSON.parse(args); // Validate once, then forward the original JSON bytes.
        } catch {
          const err = new Error('Invalid tool call JSON');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        tools.push({ id: call.id, name: call.name, arguments: args });
      }
      if (tools.length) await emit(toolChunk(id, tools));
      await emit(stopChunk(id, tools.length ? 10 : reason, uid));
      finished = true;
      return tools.map(tool => tool.name);
    },
  };
}

async function serveChat({ request, route, provider, res, signal, log = () => {}, timeouts = {}, onMetrics = () => {} }) {
  const id = randomUUID();
  const metrics = createTracker({ id, request, route, provider });
  let outcome = 'error', outcomeCode = null;
  const upstreamController = new AbortController();
  const abort = () => upstreamController.abort();
  const close = () => { if (!res.writableEnded) upstreamController.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  res.on('close', close);
  if (signal?.aborted) upstreamController.abort();
  const write = async chunk => {
    if (signal?.aborted || res.destroyed || res.writableEnded) throw new Error('Client closed');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
    if (!res.write(frame(chunk))) await new Promise((resolve, reject) => {
      const clean = () => { res.off('drain', drained); res.off('close', closed); signal?.removeEventListener('abort', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('Client closed')); };
      res.once('drain', drained); res.once('close', closed); signal?.addEventListener('abort', closed, { once: true });
    });
  };
  let status = 0;
  let classifiedCode = 'upstream_network';
  const record = event => { try { log(event); } catch { /* Diagnostics cannot fail a model request. */ } };

  const firstResponseLimit = Number.isSafeInteger(timeouts?.firstResponseMs) && timeouts.firstResponseMs > 0
    ? Math.min(timeouts.firstResponseMs, 2147483647) : 120000;
  const idleLimit = Number.isSafeInteger(timeouts?.idleMs) && timeouts.idleMs > 0
    ? Math.min(timeouts.idleMs, 2147483647) : 120000;

  let activeTimer = null;
  const clearTimer = () => { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } };
  const armTimer = (ms, code) => {
    clearTimer();
    activeTimer = setTimeout(() => {
      classifiedCode = code;
      upstreamController.abort();
    }, ms);
  };

  try {
    const { url, chat } = endpoint(provider);
    const body = buildRequestBody(request, route, provider);

    armTimer(firstResponseLimit, 'upstream_timeout');
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: upstreamController.signal
    });
    clearTimer();

    status = upstream.status;
    if (!upstream.ok) {
      classifiedCode = 'upstream_http';
      await upstream.body?.cancel();
      throw new Error('Upstream HTTP error');
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.body || !contentType.toLowerCase().includes('text/event-stream')) {
      classifiedCode = 'upstream_content_type';
      await upstream.body?.cancel();
      throw new Error('Upstream did not return SSE');
    }

    async function* rawChunksWithTimeout(bodyStream) {
      const reader = bodyStream.getReader();
      try {
        while (true) {
          armTimer(idleLimit, 'upstream_timeout');
          let res;
          try {
            res = await reader.read();
          } catch (err) {
            if (classifiedCode !== 'upstream_timeout') classifiedCode = 'upstream_stream_error';
            throw err;
          } finally {
            clearTimer();
          }
          if (res.done) break;
          yield res.value;
        }
      } finally {
        reader.releaseLock();
      }
    }

    const stream = processor(id, route.uid || request.modelUid, chat, write);
    try {
      for await (const event of events(rawChunksWithTimeout(upstream.body))) {
        metrics.event(event, chat);
        await stream.event(event);
        if (event.type === 'done' || (!chat && stream.terminal)) break;
      }
    } catch (err) {
      if (classifiedCode !== 'upstream_timeout') {
        const allowedCodes = new Set([
          'upstream_timeout', 'upstream_http', 'upstream_content_type',
          'upstream_stream_error', 'upstream_stream_incomplete',
          'upstream_invalid_tool', 'upstream_invalid_json', 'upstream_network'
        ]);
        classifiedCode = allowedCodes.has(err?.code) ? err.code : 'upstream_stream_error';
      }
      throw err;
    }

    let toolNames;
    try {
      toolNames = await stream.finish();
    } catch (err) {
      classifiedCode = err?.code === 'upstream_invalid_tool' ? 'upstream_invalid_tool' : 'upstream_stream_incomplete';
      throw err;
    }

    res.end(frame(Buffer.from('{}'), 2));
    outcome = 'success';
    record({ event: 'chat-complete', model: route.model, status, toolNames, requestId: id });
    return { status, toolNames, requestId: id };
  } catch (err) {
    clearTimer();
    const isClientCancel = signal?.aborted || res.destroyed || res.writableEnded;
    if (isClientCancel) {
      outcome = 'cancelled';
      outcomeCode = 'client_cancelled';
      record({ event: 'chat-aborted', model: route.model, status });
      if (!res.destroyed && !res.writableEnded) res.destroy();
      return { status, aborted: true };
    }

    let errorText = 'Provider response could not be completed.';
    if (classifiedCode === 'upstream_http' && status >= 400) {
      errorText = `Provider returned HTTP ${status}.`;
    } else if (classifiedCode === 'upstream_content_type' || classifiedCode === 'upstream_invalid_json' || classifiedCode === 'upstream_invalid_tool') {
      errorText = 'Provider response format is invalid.';
    }

    try {
      await write(textChunk(id, errorText));
      await write(stopChunk(id, 13, route.uid || request.modelUid));
      res.end(frame(Buffer.from('{}'), 2));
    } catch {
      if (!res.destroyed && !res.writableEnded) res.destroy();
    }
    outcomeCode = classifiedCode;
    record({ event: 'chat-error', model: route.model, status, code: classifiedCode, requestId: id });
    return { status, error: true, code: classifiedCode, requestId: id };
  } finally {
    try { onMetrics(metrics.finish(outcome, status, outcomeCode)); } catch {}
    clearTimer();
    upstreamController.abort();
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

module.exports = { serveChat, buildRequestBody, parseEvent };
