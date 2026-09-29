'use strict';

// Anthropic Messages API support. Requests are translated from the neutral
// Devin request shape; streamed events are adapted into Chat Completions-style
// chunks so the shared processor and monitor handle them unchanged.
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_OUTPUT_TOKENS = 128000;
const DEFAULT_OUTPUT_TOKENS = 64000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function isAnthropicFormat(format = '') { return format === 'anthropic'; }

function anthropicHeaders(apiKey) {
  return { 'anthropic-version': ANTHROPIC_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) };
}

function textBlocks(message) {
  const blocks = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const image of message.images || []) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } });
    if (image.caption) blocks.push({ type: 'text', text: image.caption });
  }
  return blocks;
}

function toolInput(args) {
  try {
    const value = JSON.parse(args || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function buildAnthropicBody(request, route, provider) {
  const system = request.systemPrompt ? [request.systemPrompt] : [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    // Merge adjacent turns so parallel tool results share one user message.
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content || '', ...(message.toolResultIsError ? { is_error: true } : {}) }]);
    } else if (message.role === 'system') {
      // Leading system messages join the system prompt; later ones keep their position as user text.
      if (!messages.length) { if (message.content) system.push(message.content); }
      else push('user', message.content ? [{ type: 'text', text: message.content }] : []);
    } else if (message.role === 'assistant') {
      push('assistant', [...textBlocks(message),
        ...(message.toolCalls || []).map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: toolInput(tool.arguments) }))]);
    } else {
      push('user', textBlocks(message));
    }
  }
  const requested = request.maxTokens ?? route.maxOutputTokens ?? route.maxTokens ?? provider.maxOutputTokens ?? provider.maxTokens;
  const maxTokens = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_OUTPUT_TOKENS) : DEFAULT_OUTPUT_TOKENS;
  const body = { model: route.model, max_tokens: maxTokens, messages, stream: true };
  if (system.length) body.system = system.join('\n\n');
  const effort = route.effort === 'minimal' ? 'low' : route.effort;
  if (EFFORTS.has(effort)) body.output_config = { effort };
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => ({ name: tool.name, description: tool.description,
      input_schema: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} } }));
    // Current Claude models reject forced tool_choice (any/tool), so forced choices degrade to auto.
    const choice = request.toolChoice;
    const type = typeof choice === 'string' ? choice : choice?.type;
    if (type === 'none') body.tool_choice = { type: 'none' };
    else if (choice) body.tool_choice = { type: 'auto' };
  }
  return body;
}

const FINISH = { max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'content_filter' };

function createAnthropicAdapter() {
  const blocks = new Map();
  const usage = { input: null, cacheRead: 0, cacheCreate: 0, output: null };
  const readUsage = value => {
    if (!value || typeof value !== 'object') return;
    if (Number.isSafeInteger(value.input_tokens)) usage.input = value.input_tokens;
    if (Number.isSafeInteger(value.cache_read_input_tokens)) usage.cacheRead = value.cache_read_input_tokens;
    if (Number.isSafeInteger(value.cache_creation_input_tokens)) usage.cacheCreate = value.cache_creation_input_tokens;
    if (Number.isSafeInteger(value.output_tokens)) usage.output = value.output_tokens;
  };
  const chunk = (type, delta, extra = {}) => ({ type, data: { choices: [{ index: 0, delta, ...extra }] } });
  const toolDelta = (type, index, call) => chunk(type, { tool_calls: [{ index, ...call }] });
  return function adapt(event) {
    const data = event.data;
    if (event.type === 'done' || event.type === 'message_stop') return [{ type: 'done' }];
    if (!data || event.type === 'ping') return [];
    switch (event.type) {
      case 'message_start':
        readUsage(data.message?.usage);
        return [{ type: event.type, data: { choices: [] } }];
      case 'content_block_start': {
        const block = data.content_block || {};
        const index = data.index ?? 0;
        if (block.type === 'text') return block.text ? [chunk(event.type, { content: block.text })] : [];
        if (block.type === 'thinking') return block.thinking ? [chunk(event.type, { reasoning_content: block.thinking })] : [];
        if (block.type !== 'tool_use') return [];
        const input = block.input && typeof block.input === 'object' && Object.keys(block.input).length ? JSON.stringify(block.input) : '';
        blocks.set(index, { streamed: false, input });
        return [toolDelta(event.type, index, { id: block.id, function: { name: block.name, arguments: '' } })];
      }
      case 'content_block_delta': {
        const delta = data.delta || {};
        const index = data.index ?? 0;
        if (delta.type === 'text_delta' && delta.text) return [chunk(event.type, { content: delta.text })];
        if (delta.type === 'thinking_delta' && delta.thinking) return [chunk(event.type, { reasoning_content: delta.thinking })];
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && blocks.has(index)) {
          if (delta.partial_json) blocks.get(index).streamed = true;
          return delta.partial_json ? [toolDelta(event.type, index, { function: { arguments: delta.partial_json } })] : [];
        }
        return [];
      }
      case 'content_block_stop': {
        const index = data.index ?? 0;
        const tool = blocks.get(index);
        // A tool call without argument deltas still needs valid JSON arguments.
        if (!tool || tool.streamed) return [];
        tool.streamed = true;
        return [toolDelta(event.type, index, { function: { arguments: tool.input || '{}' } })];
      }
      case 'message_delta': {
        readUsage(data.usage);
        const reason = data.delta?.stop_reason;
        const result = chunk(event.type, {}, reason ? { finish_reason: FINISH[reason] || 'stop' } : {});
        if (usage.input !== null && usage.output !== null) {
          result.data.usage = { prompt_tokens: usage.input + usage.cacheRead + usage.cacheCreate, completion_tokens: usage.output,
            prompt_tokens_details: { cached_tokens: usage.cacheRead } };
        }
        return [result];
      }
      case 'error': return [{ type: 'error', data: { error: data.error || true } }];
      default: return [];
    }
  };
}

module.exports = { ANTHROPIC_VERSION, isAnthropicFormat, anthropicHeaders, buildAnthropicBody, createAnthropicAdapter };
