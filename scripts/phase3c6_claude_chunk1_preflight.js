/**
 * Phase 3C.6 — Claude Sonnet 5.5 Chunk 1 preflight only.
 *
 * Copies approved 3C.3 Chunk 1 source + knowledge (system/payload) without
 * rewriting English or Bible pairs. Counts tokens via POST /v1/messages/count_tokens
 * (documented free). Does NOT call messages.create. Does NOT call Gemini.
 *
 * Usage: node scripts/phase3c6_claude_chunk1_preflight.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const claude = require('./providers/claude_messages');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'pilot', '47-1207', 'phase3_benchmark');
const SRC_SYSTEM = path.join(OUT_DIR, 'phase3c3-chunk_1_header_1_50-system.txt');
const SRC_PAYLOAD = path.join(OUT_DIR, 'phase3c3-chunk_1_header_1_50-payload.json');
const DST_SYSTEM = path.join(OUT_DIR, 'phase3c6-claude-chunk1-system.txt');
const DST_PAYLOAD = path.join(OUT_DIR, 'phase3c6-claude-chunk1-payload.json');

const MODEL_ID = claude.MODEL_ID;
const USD_INR = 84;
const GST_RATE = 0.18;
const TAMIL_OUT_RATIO = 1.35;
const THINKING_RESERVE = 24000;
const THINKING_HIGH_ASSUMPTION = 48000;
const OUTPUT_SAFETY_MARGIN = 2048;
const INPUT_USD_PER_MTOK = 2;
const OUTPUT_USD_PER_MTOK = 10;
const EXPECTED_LABELS = ['header'].concat(Array.from({ length: 50 }, (_, i) => String(i + 1)));
const REQUIRED_BIBLE = ['John 5:6', 'John 5:7', 'John 5:8', 'John 11:39'];
const USER_INTRO =
  'Translate these sermon paragraphs into Tamil. Keep every label in the given order. ' +
  'Return compact JSON only: {"sermon_id","tamil_title","paragraphs":[{"label","tamil"}]}. ' +
  'Do not repeat English paragraph text in the response. Do not summarize, omit, or add explanations. ' +
  'Preserve cadence, repetitions, and editor gaps like ...?... .\n\n';

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function usdCost(tokens, perMtok) {
  return (tokens / 1e6) * perMtok;
}

function inrGst(usd) {
  return usd * USD_INR * (1 + GST_RATE);
}

function round6(n) {
  return Number(n.toFixed(6));
}

function round2(n) {
  return Number(n.toFixed(2));
}

function extractBibleRefs(systemText) {
  const m = systemText.match(/Bible pairs to reuse[\s\S]*$/);
  if (!m) return [];
  const jsonStart = m[0].indexOf('[');
  if (jsonStart < 0) return [];
  try {
    const arr = JSON.parse(m[0].slice(jsonStart).trim());
    return Array.isArray(arr) ? arr.map((p) => p.ref) : [];
  } catch (_) {
    return [];
  }
}

async function countSafe(client, label, params) {
  try {
    const started = Date.now();
    const result = await claude.countTokens(client, params);
    return {
      ok: true,
      label,
      input_tokens: result.input_tokens,
      raw: claude.jsonSafeClone(result, new Set()),
      latency_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      label,
      error: String(err && err.message ? err.message : err),
      status: err && err.status,
    };
  }
}

async function main() {
  if (!fs.existsSync(SRC_SYSTEM) || !fs.existsSync(SRC_PAYLOAD)) {
    throw new Error('Missing Phase 3C.3 Chunk 1 system/payload; refuse to invent a new prompt');
  }

  fs.copyFileSync(SRC_SYSTEM, DST_SYSTEM);
  fs.copyFileSync(SRC_PAYLOAD, DST_PAYLOAD);

  const system = fs.readFileSync(DST_SYSTEM, 'utf8');
  const payloadRaw = fs.readFileSync(DST_PAYLOAD, 'utf8');
  const payload = JSON.parse(payloadRaw);
  const userText = USER_INTRO + JSON.stringify(payload);
  const paragraphs = payload.paragraphs || [];
  const labels = paragraphs.map((p) => String(p.label));
  const englishBody = paragraphs.map((p) => p.english).join('\n');

  const missing = EXPECTED_LABELS.filter((l) => !labels.includes(l));
  const unknown = labels.filter((l) => !EXPECTED_LABELS.includes(l));
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
  const duplicate = [...counts.entries()].filter(([, n]) => n > 1).map(([l]) => l);
  const coverageOk =
    missing.length === 0 &&
    unknown.length === 0 &&
    duplicate.length === 0 &&
    labels.length === EXPECTED_LABELS.length;

  const bibleRefs = extractBibleRefs(system);
  const bibleOk =
    bibleRefs.length === REQUIRED_BIBLE.length && REQUIRED_BIBLE.every((r) => bibleRefs.includes(r));

  const hashes = {
    system_prompt: sha256Text(system),
    payload_file: sha256Text(payloadRaw),
    payload_json_stringify: sha256Text(JSON.stringify(payload)),
    user_prompt: sha256Text(userText),
    source_3c3_system: sha256Text(fs.readFileSync(SRC_SYSTEM, 'utf8')),
    source_3c3_payload: sha256Text(fs.readFileSync(SRC_PAYLOAD, 'utf8')),
  };
  hashes.system_matches_3c3 = hashes.system_prompt === hashes.source_3c3_system;
  hashes.payload_matches_3c3 = hashes.payload_file === hashes.source_3c3_payload;

  const countParams = claude.buildCountParams({
    model: MODEL_ID,
    system,
    userText,
    thinking: { type: 'adaptive' },
    effort: 'high',
  });
  const plannedMaxTokens = claude.MODEL_MAX_OUTPUT_TOKENS;
  const createParamsPreview = claude.buildCreateParams({
    model: MODEL_ID,
    system,
    userText,
    maxTokens: plannedMaxTokens,
    thinking: { type: 'adaptive' },
    effort: 'high',
  });

  const client = claude.createClient();
  let modelInfo = null;
  try {
    const mi = await client.models.retrieve(MODEL_ID);
    modelInfo = claude.jsonSafeClone(mi, new Set());
  } catch (err) {
    modelInfo = { error: String(err && err.message ? err.message : err), status: err && err.status };
  }

  const fullCount = await countSafe(client, 'full_chunk1_request', countParams);
  const systemCount = await countSafe(client, 'system_only', {
    model: MODEL_ID,
    system,
    messages: [{ role: 'user', content: 'ok' }],
  });
  const userCount = await countSafe(client, 'user_only', {
    model: MODEL_ID,
    messages: [{ role: 'user', content: userText }],
  });
  const englishCount = await countSafe(client, 'english_paragraphs_only', {
    model: MODEL_ID,
    messages: [{ role: 'user', content: englishBody }],
  });

  const inputTokens = fullCount.ok ? fullCount.input_tokens : null;
  const englishTokens = englishCount.ok ? englishCount.input_tokens : null;
  const estimatedTamilBody = englishTokens != null ? Math.ceil(englishTokens * TAMIL_OUT_RATIO) : null;
  const compactJsonOverhead = Math.ceil(paragraphs.length * 12) + 80;
  const estimatedVisible = estimatedTamilBody != null ? estimatedTamilBody + compactJsonOverhead : null;
  const requiredLikely =
    estimatedVisible != null ? estimatedVisible + THINKING_RESERVE + OUTPUT_SAFETY_MARGIN : null;
  const requiredHighThinking =
    estimatedVisible != null ? estimatedVisible + THINKING_HIGH_ASSUMPTION + OUTPUT_SAFETY_MARGIN : null;

  const outputBudget = {
    context_window: claude.CONTEXT_WINDOW,
    model_max_output_tokens: claude.MODEL_MAX_OUTPUT_TOKENS,
    planned_max_tokens: plannedMaxTokens,
    estimated_visible_tamil_json: estimatedVisible,
    thinking_reserve_adaptive_high: THINKING_RESERVE,
    thinking_high_assumption: THINKING_HIGH_ASSUMPTION,
    safety_margin: OUTPUT_SAFETY_MARGIN,
    required_output_budget_likely: requiredLikely,
    required_output_budget_high_thinking: requiredHighThinking,
    fits_likely: requiredLikely == null ? null : requiredLikely <= plannedMaxTokens,
    fits_high_thinking: requiredHighThinking == null ? null : requiredHighThinking <= plannedMaxTokens,
    budget_verified: requiredLikely != null,
    json_schema: 'output_config.format.type=json_schema additionalProperties=false',
    temperature_omitted: true,
    temperature_omitted_reason: 'claude-sonnet-5-5 returns 400 if temperature/top_p/top_k are set',
  };

  function costBlock(input, output) {
    const inUsd = usdCost(input || 0, INPUT_USD_PER_MTOK);
    const outUsd = usdCost(output || 0, OUTPUT_USD_PER_MTOK);
    const usd = inUsd + outUsd;
    return {
      input_tokens: input,
      output_tokens: output,
      input_usd: round6(inUsd),
      output_usd: round6(outUsd),
      total_usd: round6(usd),
      total_inr_incl_gst: round2(inrGst(usd)),
    };
  }

  const costs = {
    pricing_source: 'https://platform.claude.com/docs/en/about-claude/pricing retrieved 2026-11-07',
    model: MODEL_ID,
    input_usd_per_mtok: INPUT_USD_PER_MTOK,
    output_usd_per_mtok: OUTPUT_USD_PER_MTOK,
    usd_inr: USD_INR,
    usd_inr_note: 'estimate only',
    gst_rate: GST_RATE,
    cache_not_used: true,
    batch_not_used: true,
    thinking_billed_as: 'output tokens (usage.output_tokens includes thinking; output_tokens_details.thinking_tokens)',
    expected_visible_only: estimatedVisible == null ? null : costBlock(inputTokens, estimatedVisible),
    expected_visible_plus_thinking_reserve:
      estimatedVisible == null ? null : costBlock(inputTokens, estimatedVisible + THINKING_RESERVE),
    expected_visible_plus_high_thinking:
      estimatedVisible == null ? null : costBlock(inputTokens, estimatedVisible + THINKING_HIGH_ASSUMPTION),
    conservative_maximum_at_planned_max_tokens: costBlock(inputTokens || 0, plannedMaxTokens),
    conservative_maximum_note:
      inputTokens == null
        ? 'Input tokens unknown; conservative maximum uses 0 input + full max_tokens output. Real input cost will be additional once count_tokens succeeds.'
        : null,
  };

  const blockers = [];
  if (!fullCount.ok) {
    blockers.push('Official count_tokens failed for the complete Chunk 1 request: ' + fullCount.error);
    if (String(fullCount.error || '').includes('credit balance')) {
      blockers.push(
        'Anthropic account credit balance is too low. count_tokens (documented free) and messages.create are both rejected until credits are added. A paid Chunk 1 call cannot succeed in this state.'
      );
    }
  }
  if (!hashes.system_matches_3c3) blockers.push('Copied system.txt does not match Phase 3C.3 hash');
  if (!hashes.payload_matches_3c3) blockers.push('Copied payload.json does not match Phase 3C.3 hash');
  if (!coverageOk) blockers.push('Chunk 1 labels are not exactly header + 1–50 once each');
  if (!bibleOk) blockers.push('System prompt Bible pairs are not exactly the four verified Chunk 1 refs');
  if (estimatedVisible == null) {
    blockers.push(
      'Expected Tamil output tokens are unverified because official count_tokens did not return English/input counts.'
    );
  } else if (!outputBudget.fits_likely) {
    blockers.push('Likely output budget exceeds planned max_tokens');
  }
  if (modelInfo && modelInfo.error) {
    blockers.push('Models API retrieve failed for ' + MODEL_ID + ': ' + modelInfo.error);
  }
  if (!process.env.ANTHROPIC_API_KEY) blockers.push('ANTHROPIC_API_KEY is not set');

  const integrationReady =
    fullCount.ok &&
    coverageOk &&
    bibleOk &&
    hashes.system_matches_3c3 &&
    hashes.payload_matches_3c3 &&
    outputBudget.fits_likely &&
    !(modelInfo && modelInfo.error);

  const technicallySafeToAttempt =
    integrationReady && outputBudget.fits_high_thinking && blockers.length === 0;

  const report = {
    phase: '3C.6',
    sermon_id: '47-1207',
    title: 'Experiences',
    mode: 'preflight_only',
    paid_generation: false,
    messages_create_called: false,
    gemini_called: false,
    chunk_2_executed: false,
    model: {
      requested_id: MODEL_ID,
      verified_from: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      models_api: modelInfo,
      context_window: claude.CONTEXT_WINDOW,
      max_output_tokens_sync: claude.MODEL_MAX_OUTPUT_TOKENS,
      thinking: 'adaptive (default on); effort high; thinking.type disabled is not accepted on this model',
    },
    source_preservation: {
      system_copied_from: SRC_SYSTEM,
      payload_copied_from: SRC_PAYLOAD,
      english_unchanged: hashes.payload_matches_3c3,
      knowledge_unchanged: hashes.system_matches_3c3,
      bible_refs: bibleRefs,
      bible_exactly_four_required: bibleOk,
      gemini_baselines_untouched: true,
      source_of_truth_untouched: true,
    },
    coverage: {
      expected_count: EXPECTED_LABELS.length,
      actual_count: labels.length,
      missing,
      duplicate,
      unknown,
      every_record_exactly_once: coverageOk,
    },
    hashes,
    token_counts: {
      method: 'client.messages.countTokens (POST /v1/messages/count_tokens)',
      documented_free: true,
      source: 'https://platform.claude.com/docs/en/build-with-claude/token-counting',
      gemini_chunk1_input_not_reused: 40322,
      full_request: fullCount,
      system_only: systemCount,
      user_only: userCount,
      english_paragraphs_only: englishCount,
    },
    output_estimates: {
      tamil_out_ratio: TAMIL_OUT_RATIO,
      tamil_ratio_note:
        'English tokens counted with Claude tokenizer, then ×1.35 for Tamil body plus JSON overhead. Not a Gemini token reuse.',
      estimated_tamil_body: estimatedTamilBody,
      compact_json_overhead: compactJsonOverhead,
      estimated_visible_tamil_json: estimatedVisible,
      thinking_not_returned_by_count_tokens: true,
    },
    output_budget: outputBudget,
    cost_estimate: costs,
    request_preview: {
      model: MODEL_ID,
      max_tokens: plannedMaxTokens,
      thinking: createParamsPreview.thinking,
      output_config: createParamsPreview.output_config,
      temperature: null,
      cache: false,
      batch: false,
      user_intro: USER_INTRO.trim(),
      system_chars: system.length,
      user_chars: userText.length,
    },
    logging_design: {
      persist_complete_provider_response: true,
      omit_secrets: true,
      fields: [
        'id (request id)',
        'model',
        'stop_reason',
        'usage.input_tokens',
        'usage.output_tokens',
        'usage.cache_creation_input_tokens',
        'usage.cache_read_input_tokens',
        'usage.output_tokens_details.thinking_tokens',
        'latency_ms',
        'estimated cost',
        'json validation / classifyResponse kinds: empty_response, refusal, incomplete_json, output_truncation, complete_json',
      ],
      not_called_this_phase: true,
    },
    implementation: {
      adapter: 'scripts/providers/claude_messages.js',
      sdk: '@anthropic-ai/sdk',
      api_key_source: 'process.env.ANTHROPIC_API_KEY',
      gemini_adapter_modified: false,
    },
    gaps_and_assumptions: [
      'count_tokens returns input tokens only; Tamil JSON output tokens are estimated (English Claude tokens × 1.35 + JSON overhead).',
      'Adaptive thinking volume is unknown until a paid call; 24,000 is a Gemini-era HIGH observation used as a reserve, 48,000 is a more conservative assumption. Both are billed as output if used.',
      'count_tokens is documented as an estimate; billed input on messages.create can differ slightly.',
      'USD/INR = 84 is an estimate.',
      'Claude has not yet been asked to translate this sermon; PROHIBITED_CONTENT on Gemini does not prove Claude will accept the same English.',
      'createMessage is implemented but was not invoked.',
      'Official docs say token counting is free; this account received HTTP 400 invalid_request_error that the credit balance is too low. No Gemini token count is substituted.',
    ],
    blockers,
    answers: {
      claude_integration_ready: integrationReady,
      verified_model_id: MODEL_ID,
      actual_chunk1_input_tokens: inputTokens,
      expected_output_tokens_visible: estimatedVisible,
      expected_output_tokens_with_thinking_reserve:
        estimatedVisible != null ? estimatedVisible + THINKING_RESERVE : null,
      maximum_expected_cost_inr_incl_gst: costs.conservative_maximum_at_planned_max_tokens.total_inr_incl_gst,
      output_budget_sufficient:
        outputBudget.fits_likely === true && outputBudget.fits_high_thinking === true,
      fifty_one_records_exactly_once: coverageOk,
      remaining_technical_blockers: blockers,
      single_paid_chunk1_technically_safe_to_attempt: technicallySafeToAttempt,
      approval: 'STOP. Do not call messages.create until a separate explicit human approval.',
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'phase3c6-claude-preflight-report.json'), JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '# Phase 3C.6 — Claude Sonnet 5.5 Chunk 1 preflight',
    '',
    'Sermon: **47-1207 – Experiences**',
    'Scope: **header + paragraphs 1–50** (51 records). Chunk 2: **not executed**.',
    'Paid generation this phase: **none**. `messages.create` was **not** called. Gemini was **not** called.',
    '',
    '## 1. Claude integration ready?',
    '',
    integrationReady ? '**Yes** — adapter, key presence, model ID, token count, coverage, and output budget checks passed.' : '**No** — see blockers below.',
    '',
    '| Item | Value |',
    '| --- | --- |',
    '| Verified model ID | `' + MODEL_ID + '` |',
    '| Docs | [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) |',
    '| Context window | ' + claude.CONTEXT_WINDOW.toLocaleString() + ' |',
    '| Max output (sync Messages) | ' + claude.MODEL_MAX_OUTPUT_TOKENS.toLocaleString() + ' |',
    '| Thinking | Adaptive, effort `high` (model default) |',
    '| JSON | `output_config.format` json_schema, `additionalProperties: false` |',
    '| Temperature | omitted (setting it returns 400 on this model) |',
    '| SDK | `@anthropic-ai/sdk` |',
    '| API key | `ANTHROPIC_API_KEY` environment variable (not printed, not saved) |',
    '| Gemini adapter | unchanged |',
    '',
    '## 2. Source preservation',
    '',
    '- Copied `phase3c3-chunk_1_header_1_50-system.txt` → `phase3c6-claude-chunk1-system.txt`',
    '- Copied `phase3c3-chunk_1_header_1_50-payload.json` → `phase3c6-claude-chunk1-payload.json`',
    '- System SHA-256 matches 3C.3: **' + hashes.system_matches_3c3 + '** (`' + hashes.system_prompt + '`)',
    '- Payload SHA-256 matches 3C.3: **' + hashes.payload_matches_3c3 + '** (`' + hashes.payload_file + '`)',
    '- User prompt SHA-256: `' + hashes.user_prompt + '`',
    '- Bible pairs (unchanged, no new retrieval): `' + bibleRefs.join('`, `') + '`',
    '- Original parallel dataset, Bible dataset, knowledge package, Gemini baselines: **not modified**',
    '',
    '## 3. Coverage (51 records)',
    '',
    '| Check | Result |',
    '| --- | --- |',
    '| Actual labels | ' + labels.length + ' |',
    '| Missing | ' + (missing.length ? missing.join(', ') : 'none') + ' |',
    '| Duplicate | ' + (duplicate.length ? duplicate.join(', ') : 'none') + ' |',
    '| Unknown | ' + (unknown.length ? unknown.join(', ') : 'none') + ' |',
    '| Every record exactly once | **' + coverageOk + '** |',
    '',
    '## 4. Actual Claude token counts',
    '',
    'Method: official `messages.countTokens` (documented **free**, subject to RPM). Gemini 40,322 is **not** reused as a Claude count.',
    '',
    '| Request | Input tokens | Status |',
    '| --- | ---: | --- |',
    '| **Complete Chunk 1** (system + knowledge + Bible + user JSON + schema + adaptive thinking config) | **' +
      (fullCount.ok ? fullCount.input_tokens : 'FAILED') +
      '** | ' +
      (fullCount.ok ? 'ok, ' + fullCount.latency_ms + ' ms' : fullCount.error) +
      ' |',
    '| System only | ' + (systemCount.ok ? systemCount.input_tokens : systemCount.error) + ' | |',
    '| User only | ' + (userCount.ok ? userCount.input_tokens : userCount.error) + ' | |',
    '| English paragraphs only | ' + (englishCount.ok ? englishCount.input_tokens : englishCount.error) + ' | |',
    '',
    '## 5. Expected output and budget',
    '',
    '| Item | Tokens |',
    '| --- | ---: |',
    '| Expected Tamil JSON (visible) | ' + estimatedVisible + ' |',
    '| Adaptive-thinking reserve (assumption) | ' + THINKING_RESERVE + ' |',
    '| Higher thinking assumption | ' + THINKING_HIGH_ASSUMPTION + ' |',
    '| Safety margin | ' + OUTPUT_SAFETY_MARGIN + ' |',
    '| Required likely | ' + requiredLikely + ' |',
    '| Required high-thinking | ' + requiredHighThinking + ' |',
    '| Planned `max_tokens` | ' + plannedMaxTokens + ' |',
    '| Model max output | ' + claude.MODEL_MAX_OUTPUT_TOKENS + ' |',
    '| Likely budget sufficient | **' + String(outputBudget.fits_likely) + '** |',
    '| High-thinking budget sufficient | **' + String(outputBudget.fits_high_thinking) + '** |',
    '',
    'Visible output is estimated from **Claude** English-paragraph tokens × 1.35 plus JSON overhead. `count_tokens` does not return output or thinking tokens. Adaptive thinking is unbounded except by `max_tokens`; thinking is billed as output.',
    '',
    '## 6. Cost (USD 1 = ₹' + USD_INR + ' **estimate**, GST ' + GST_RATE * 100 + '%)',
    '',
    'Official Standard pricing for `' +
      MODEL_ID +
      '`: **$2 / MTok input**, **$10 / MTok output**. No Batch, no prompt cache.',
    '',
    '| Scenario | Input | Output billed | USD | INR incl. GST |',
    '| --- | ---: | ---: | ---: | ---: |',
    '| Visible JSON only | ' +
      (inputTokens == null ? 'n/a' : inputTokens) +
      ' | ' +
      (estimatedVisible == null ? 'n/a' : estimatedVisible) +
      ' | ' +
      (costs.expected_visible_only ? '$' + costs.expected_visible_only.total_usd : 'n/a') +
      ' | ' +
      (costs.expected_visible_only ? '₹' + costs.expected_visible_only.total_inr_incl_gst : 'n/a') +
      ' |',
    '| Visible + 24k thinking reserve | ' +
      (inputTokens == null ? 'n/a' : inputTokens) +
      ' | ' +
      (estimatedVisible == null ? 'n/a' : estimatedVisible + THINKING_RESERVE) +
      ' | ' +
      (costs.expected_visible_plus_thinking_reserve
        ? '$' + costs.expected_visible_plus_thinking_reserve.total_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_thinking_reserve
        ? '₹' + costs.expected_visible_plus_thinking_reserve.total_inr_incl_gst
        : 'n/a') +
      ' |',
    '| Visible + 48k thinking | ' +
      (inputTokens == null ? 'n/a' : inputTokens) +
      ' | ' +
      (estimatedVisible == null ? 'n/a' : estimatedVisible + THINKING_HIGH_ASSUMPTION) +
      ' | ' +
      (costs.expected_visible_plus_high_thinking
        ? '$' + costs.expected_visible_plus_high_thinking.total_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_high_thinking
        ? '₹' + costs.expected_visible_plus_high_thinking.total_inr_incl_gst
        : 'n/a') +
      ' |',
    '| **Conservative maximum** (`max_tokens` = ' +
      plannedMaxTokens +
      ') | ' +
      inputTokens +
      ' | ' +
      plannedMaxTokens +
      ' | $' +
      costs.conservative_maximum_at_planned_max_tokens.total_usd +
      ' | **₹' +
      costs.conservative_maximum_at_planned_max_tokens.total_inr_incl_gst +
      '** |',
    '',
    'The conservative maximum is the ceiling if the model fills the entire output window (thinking + JSON). A typical translation run should land nearer the visible+reserve rows.',
    '',
    '## 7. Logging (prepared, unused)',
    '',
    '`scripts/providers/claude_messages.js` can persist a full Messages object via `jsonSafeClone` (omits Authorization / x-api-key / apiKey). Classification distinguishes empty response, refusal (`stop_reason=refusal`), incomplete JSON, and truncation (`max_tokens`). Not exercised this phase.',
    '',
    '## 8. Gaps / unverified assumptions',
    '',
    report.gaps_and_assumptions.map((g) => '- ' + g).join('\n'),
    '',
    '## 9. Blockers',
    '',
    blockers.length ? blockers.map((b) => '- ' + b).join('\n') : 'None identified.',
    '',
    '## 10. Final answers',
    '',
    '1. Claude integration ready: **' + integrationReady + '**',
    '2. Exact verified model identifier: **`' + MODEL_ID + '`**',
    '3. Actual Chunk 1 input token count: **' + inputTokens + '**',
    '4. Expected output token count (visible Tamil JSON): **' +
      (estimatedVisible == null ? 'unavailable' : estimatedVisible) +
      '**; with 24k thinking reserve: **' +
      (estimatedVisible == null ? 'unavailable' : estimatedVisible + THINKING_RESERVE) +
      '**',
    '5. Maximum expected cost including GST: **₹' + costs.conservative_maximum_at_planned_max_tokens.total_inr_incl_gst + '** (if 128,000 output tokens are consumed)',
    '6. Output budget sufficient: **' +
      (outputBudget.fits_likely === true && outputBudget.fits_high_thinking === true) +
      '** (unverified if token count failed)',
    '7. All 51 records covered exactly once: **' + coverageOk + '**',
    '8. Remaining technical blockers: **' + (blockers.length ? blockers.join('; ') : 'none') + '**',
    '9. Single paid Chunk 1 experiment technically safe to attempt: **' + technicallySafeToAttempt + '**',
    '',
    '**STOP.** Wait for a separate explicit approval before any paid `messages.create` call.',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(OUT_DIR, 'phase3c6-claude-preflight-report.md'), md, 'utf8');

  const costMd = [
    '# Phase 3C.6 — Claude Sonnet 5.5 Chunk 1 cost estimate',
    '',
    'Model: `' + MODEL_ID + '`  ',
    'Pricing source: https://platform.claude.com/docs/en/about-claude/pricing (retrieved 2026-11-07)  ',
    'FX: **USD 1 = ₹' + USD_INR + ' (estimate)**  ·  GST **' + GST_RATE * 100 + '%**  ',
    'Token method: official `count_tokens` on the complete Chunk 1 request. Gemini 40,322 is not reused.',
    '',
    '| Rate | USD / MTok |',
    '| --- | ---: |',
    '| Input | $' + INPUT_USD_PER_MTOK + ' |',
    '| Output (includes thinking) | $' + OUTPUT_USD_PER_MTOK + ' |',
    '| Cache / Batch | not used |',
    '',
    '| Quantity | Tokens |',
    '| --- | ---: |',
    '| Actual input | ' + (inputTokens == null ? 'unavailable (count_tokens rejected: no credits)' : inputTokens) + ' |',
    '| Expected visible Tamil JSON | ' + (estimatedVisible == null ? 'unavailable' : estimatedVisible) + ' |',
    '| Thinking reserve (assumption) | ' + THINKING_RESERVE + ' |',
    '| High thinking assumption | ' + THINKING_HIGH_ASSUMPTION + ' |',
    '| Planned max_tokens (conservative ceiling) | ' + plannedMaxTokens + ' |',
    '',
    '| Scenario | Input USD | Output USD | Total USD | INR incl. GST |',
    '| --- | ---: | ---: | ---: | ---: |',
    '| Visible only | ' +
      (costs.expected_visible_only ? '$' + costs.expected_visible_only.input_usd : 'n/a') +
      ' | ' +
      (costs.expected_visible_only ? '$' + costs.expected_visible_only.output_usd : 'n/a') +
      ' | ' +
      (costs.expected_visible_only ? '$' + costs.expected_visible_only.total_usd : 'n/a') +
      ' | ' +
      (costs.expected_visible_only ? '₹' + costs.expected_visible_only.total_inr_incl_gst : 'n/a') +
      ' |',
    '| Visible + 24k thinking | ' +
      (costs.expected_visible_plus_thinking_reserve
        ? '$' + costs.expected_visible_plus_thinking_reserve.input_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_thinking_reserve
        ? '$' + costs.expected_visible_plus_thinking_reserve.output_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_thinking_reserve
        ? '$' + costs.expected_visible_plus_thinking_reserve.total_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_thinking_reserve
        ? '₹' + costs.expected_visible_plus_thinking_reserve.total_inr_incl_gst
        : 'n/a') +
      ' |',
    '| Visible + 48k thinking | ' +
      (costs.expected_visible_plus_high_thinking
        ? '$' + costs.expected_visible_plus_high_thinking.input_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_high_thinking
        ? '$' + costs.expected_visible_plus_high_thinking.output_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_high_thinking
        ? '$' + costs.expected_visible_plus_high_thinking.total_usd
        : 'n/a') +
      ' | ' +
      (costs.expected_visible_plus_high_thinking
        ? '₹' + costs.expected_visible_plus_high_thinking.total_inr_incl_gst
        : 'n/a') +
      ' |',
    '| **Conservative maximum** | $' +
      costs.conservative_maximum_at_planned_max_tokens.input_usd +
      ' | $' +
      costs.conservative_maximum_at_planned_max_tokens.output_usd +
      ' | $' +
      costs.conservative_maximum_at_planned_max_tokens.total_usd +
      ' | **₹' +
      costs.conservative_maximum_at_planned_max_tokens.total_inr_incl_gst +
      '** |',
    '',
    'No paid generation was performed. This file is an estimate only.',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(OUT_DIR, 'phase3c6-claude-cost-estimate.md'), costMd, 'utf8');

  process.stdout.write(
    JSON.stringify(
      {
        integration_ready: integrationReady,
        model: MODEL_ID,
        input_tokens: inputTokens,
        expected_visible: estimatedVisible,
        max_inr_gst: costs.conservative_maximum_at_planned_max_tokens.total_inr_incl_gst,
        coverage_ok: coverageOk,
        blockers,
        technically_safe: technicallySafeToAttempt,
        messages_create_called: false,
      },
      null,
      2
    ) + '\n'
  );
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
