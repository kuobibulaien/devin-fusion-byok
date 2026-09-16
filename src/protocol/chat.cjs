'use strict';

const { fields, str, num, s, v, m } = require('./wire.cjs');
const SOURCE_ROLE = { 0: 'user', 1: 'user', 2: 'assistant', 3: 'assistant', 4: 'tool', 5: 'system' };

function schema(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native tool schema');
  return parsed;
}

function protoMessage(data) {
  const source = Number(num(data, 2));
  if (!Object.hasOwn(SOURCE_ROLE, source)) throw new Error('Unsupported native message source');
  return {
    role: SOURCE_ROLE[source], source,
    messageId: str(data, 1), content: str(data, 3),
    toolCalls: fields(data, 6).map(({ value }) => ({ id: str(value, 1), name: str(value, 2), arguments: str(value, 3) })),
    toolCallId: str(data, 7), toolResultIsError: Boolean(num(data, 9)),
    images: fields(data, 10).map(({ value }) => ({ base64: str(value, 1), mimeType: str(value, 2) || 'image/png', caption: str(value, 3) })),
    thinking: str(data, 11), signature: str(data, 12),
  };
}

function camel(object, camelName, snakeName) { return object?.[camelName] ?? object?.[snakeName]; }
function jsonToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  const name = camel(choice, 'toolName', 'tool_name');
  const type = camel(choice, 'optionName', 'option_name');
  if (name === undefined && type === undefined) return choice;
  return { type: name ? 'tool' : type || '', name: name || '' };
}
function jsonMessage(message) {
  let source = message.source ?? 0;
  if (typeof source === 'string') source = { CHAT_MESSAGE_SOURCE_UNSPECIFIED: 0, CHAT_MESSAGE_SOURCE_USER: 1, CHAT_MESSAGE_SOURCE_SYSTEM: 2, CHAT_MESSAGE_SOURCE_UNKNOWN: 3, CHAT_MESSAGE_SOURCE_TOOL: 4, CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT: 5, USER: 1, SYSTEM: 2, UNKNOWN: 3, TOOL: 4, SYSTEM_PROMPT: 5 }[source];
  const role = message.role || SOURCE_ROLE[source];
  if (!role) throw new Error('Unsupported native message source');
  return {
    role, source, messageId: camel(message, 'messageId', 'message_id') || '',
    content: message.prompt ?? message.content ?? '',
    toolCalls: (camel(message, 'toolCalls', 'tool_calls') || []).map(call => ({ id: call.id || '', name: call.name || '', arguments: camel(call, 'argumentsJson', 'arguments_json') ?? call.arguments ?? '' })),
    toolCallId: camel(message, 'toolCallId', 'tool_call_id') || '',
    toolResultIsError: Boolean(camel(message, 'toolResultIsError', 'tool_result_is_error')),
    images: (message.images || []).map(image => ({ base64: camel(image, 'base64Data', 'base64_data') || image.base64 || '', mimeType: camel(image, 'mimeType', 'mime_type') || 'image/png', caption: image.caption || '' })),
    thinking: message.thinking || '', signature: message.signature || '',
  };
}

function parseChat(data) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    if (!data || typeof data !== 'object') throw new Error('Invalid native chat request');
    return {
      modelUid: camel(data, 'chatModelUid', 'chat_model_uid') ?? camel(data, 'modelUid', 'model_uid') ?? '',
      modelEnum: camel(data, 'internalChatModel', 'internal_chat_model') ?? data.model ?? 0,
      systemPrompt: data.prompt ?? camel(data, 'systemPrompt', 'system_prompt') ?? '',
      messages: (camel(data, 'chatMessagePrompts', 'chat_message_prompts') ?? data.messages ?? data.prompts ?? []).map(jsonMessage),
      tools: (data.tools || []).map(tool => ({ name: tool.name, description: tool.description || '', parameters: schema(camel(tool, 'jsonSchemaString', 'json_schema_string') ?? camel(tool, 'parametersJson', 'parameters_json') ?? camel(tool, 'inputSchema', 'input_schema') ?? tool.parameters) })),
      toolChoice: jsonToolChoice(camel(data, 'toolChoice', 'tool_choice')),
      maxTokens: camel(data, 'maxTokens', 'max_tokens'),
    };
  }
  const choice = fields(data, 12).find(field => field.wire === 2)?.value;
  return {
    modelUid: str(data, 21), modelEnum: num(data, 6), systemPrompt: str(data, 2),
    messages: fields(data, 3).map(field => protoMessage(field.value)),
    tools: fields(data, 10).map(({ value }) => ({ name: str(value, 1), description: str(value, 2), parameters: schema(str(value, 3)) })),
    toolChoice: choice ? { type: str(choice, 1), name: str(choice, 2) } : undefined,
    maxTokens: undefined,
  };
}

function prefix(id) {
  const now = Date.now();
  return [s(1, id), m(2, Buffer.concat([v(1, Math.floor(now / 1000)), v(2, now % 1000 * 1000000)]))];
}
function textChunk(id, text) { return Buffer.concat([...prefix(id), s(3, text)]); }
function thinkingChunk(id, text) { return Buffer.concat([...prefix(id), s(9, text)]); }
function toolChunk(id, tools) {
  return Buffer.concat([...prefix(id), ...tools.map(tool => m(6, Buffer.concat([s(1, tool.id), s(2, tool.name), s(3, tool.arguments ?? tool.arguments_json ?? '')])))]);
}
function stopChunk(id, reason = 2, modelUid = '') { return Buffer.concat([...prefix(id), v(5, reason), ...(modelUid ? [s(20, modelUid)] : [])]); }

module.exports = { parseChat, textChunk, thinkingChunk, toolChunk, stopChunk };
