/**
 * Isolated Anthropic Messages adapter.
 * Reads ANTHROPIC_API_KEY from the process environment only.
 * Never logs, prints, or writes the key or Authorization / x-api-key headers.
 *
 * Paid generation: createMessage() is exported but MUST NOT be called unless
 * the caller has a separate explicit human approval. This module does not
 * auto-retry and does not invoke createMessage on load.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL_ID = 'claude-sonnet-5-5';
const CONTEXT_WINDOW = 1000000;
const MODEL_MAX_OUTPUT_TOKENS = 128000;

function getApiKeyFromEnv() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !String(key).trim()) {
    throw new Error('ANTHROPIC_API_KEY is not set in the environment');
  }
  return String(key).trim();
}

function createClient() {
  return new Anthropic({ apiKey: getApiKeyFromEnv() });
}

function jsonSafeClone(value, seen) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { type: 'Buffer', byteLength: value.length, omitted: true };
  }
  if (typeof value.toJSON === 'function') {
    try {
      return jsonSafeClone(value.toJSON(), new Set(seen));
    } catch (_) {
      /* fall through */
    }
  }
  if (Array.isArray(value)) return value.map((v) => jsonSafeClone(v, new Set(seen)));
  const out = {};
  const secretKeys = new Set([
    'authorization',
    'Authorization',
    'x-api-key',
    'api_key',
    'apiKey',
    'api-key',
    'ANTHROPIC_API_KEY',
  ]);
  for (const key of Object.keys(value)) {
    const lower = String(key).toLowerCase();
    if (secretKeys.has(key) || lower === 'authorization' || lower === 'x-api-key' || lower === 'apikey') {
      out[key] = '[omitted]';
      continue;
    }
    if (key === 'headers' || key === '_headers' || key === 'request_headers') {
      out[key] = { omitted: true, reason: 'headers omitted so API keys are never written to disk' };
      continue;
    }
    try {
      out[key] = jsonSafeClone(value[key], new Set(seen));
    } catch (err) {
      out[key] = { serialize_error: String(err && err.message ? err.message : err) };
    }
  }
  return out;
}

function compactTamilJsonSchema() {
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sermon_id', 'tamil_title', 'paragraphs'],
      properties: {
        sermon_id: { type: 'string' },
        tamil_title: { type: 'string' },
        paragraphs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'tamil'],
            properties: {
              label: { type: 'string' },
              tamil: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

function buildCountParams({ model, system, userText, thinking, effort }) {
  return {
    model: model || MODEL_ID,
    system,
    messages: [{ role: 'user', content: userText }],
    thinking: thinking || { type: 'adaptive' },
    output_config: {
      effort: effort || 'high',
      format: compactTamilJsonSchema(),
    },
  };
}

function buildCreateParams({ model, system, userText, maxTokens, thinking, effort }) {
  return {
    ...buildCountParams({ model, system, userText, thinking, effort }),
    max_tokens: maxTokens,
  };
}

async function countTokens(client, params) {
  return client.messages.countTokens(params);
}

/**
 * Paid Messages create. Do not call without explicit human approval.
 * No automatic retry.
 */
async function createMessage(client, params) {
  return client.messages.create(params);
}

function extractUsage(message) {
  const usage = (message && message.usage) || {};
  const details = usage.output_tokens_details || {};
  return {
    input_tokens: usage.input_tokens != null ? usage.input_tokens : null,
    output_tokens: usage.output_tokens != null ? usage.output_tokens : null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens != null ? usage.cache_creation_input_tokens : 0,
    cache_read_input_tokens: usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : 0,
    thinking_tokens: details.thinking_tokens != null ? details.thinking_tokens : null,
  };
}

function extractText(message) {
  const blocks = (message && message.content) || [];
  const texts = [];
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  return texts.join('');
}

function classifyResponse(message, parsedJson, expectedLabels) {
  const stop = message && message.stop_reason;
  const text = extractText(message);
  const emptyContent = !text.trim();
  const isRefusal = stop === 'refusal';
  const truncated = stop === 'max_tokens';
  const incompleteJson = !parsedJson.ok;
  let structure = { ok: false, reason: 'not_validated' };
  if (parsedJson.ok) {
    structure = validateTamilStructure(parsedJson.value, expectedLabels);
  }
  let kind = 'unknown';
  if (isRefusal) kind = 'refusal';
  else if (emptyContent && !truncated) kind = 'empty_response';
  else if (truncated) kind = 'output_truncation';
  else if (incompleteJson) kind = 'incomplete_json';
  else if (!structure.ok) kind = 'invalid_structure';
  else if (stop === 'end_turn' || stop === 'stop_sequence') kind = 'complete_json';
  else kind = 'other_stop:' + String(stop);
  return {
    kind,
    stop_reason: stop || null,
    empty_content: emptyContent,
    is_refusal: isRefusal,
    is_truncation: truncated,
    incomplete_json: incompleteJson,
    json_parse: parsedJson,
    structure,
  };
}

function tryParseJson(text) {
  if (!text || !String(text).trim()) return { ok: false, reason: 'empty_text', value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err), value: null };
  }
}

function validateTamilStructure(obj, expectedLabels) {
  const missing = [];
  const duplicate = [];
  const unknown = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, reason: 'not_object', missing: expectedLabels.slice(), duplicate, unknown };
  }
  const paras = Array.isArray(obj.paragraphs) ? obj.paragraphs : [];
  const seen = new Map();
  for (const p of paras) {
    const lab = p && p.label != null ? String(p.label) : '';
    seen.set(lab, (seen.get(lab) || 0) + 1);
  }
  for (const lab of expectedLabels) {
    const n = seen.get(lab) || 0;
    if (n === 0) missing.push(lab);
    if (n > 1) duplicate.push(lab);
  }
  for (const [lab, n] of seen.entries()) {
    if (!expectedLabels.includes(lab)) unknown.push(lab);
    else if (n > 1 && !duplicate.includes(lab)) duplicate.push(lab);
  }
  return {
    ok: missing.length === 0 && duplicate.length === 0 && unknown.length === 0 && paras.length === expectedLabels.length,
    sermon_id: obj.sermon_id || null,
    tamil_title_present: typeof obj.tamil_title === 'string' && obj.tamil_title.length > 0,
    paragraph_count: paras.length,
    expected_count: expectedLabels.length,
    missing,
    duplicate,
    unknown,
  };
}

function summarizeForLog(message, extra) {
  const usage = extractUsage(message);
  return {
    id: message && message.id,
    type: message && message.type,
    model: message && message.model,
    role: message && message.role,
    stop_reason: message && message.stop_reason,
    stop_sequence: message && message.stop_sequence,
    usage,
    content_block_types: ((message && message.content) || []).map((b) => b && b.type),
    safe_response: jsonSafeClone(message, new Set()),
    extra: extra || null,
  };
}

module.exports = {
  MODEL_ID,
  CONTEXT_WINDOW,
  MODEL_MAX_OUTPUT_TOKENS,
  createClient,
  jsonSafeClone,
  compactTamilJsonSchema,
  buildCountParams,
  buildCreateParams,
  countTokens,
  createMessage,
  extractUsage,
  extractText,
  classifyResponse,
  tryParseJson,
  validateTamilStructure,
  summarizeForLog,
};
