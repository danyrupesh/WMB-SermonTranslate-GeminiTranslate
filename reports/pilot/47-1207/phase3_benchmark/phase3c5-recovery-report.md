# Phase 3C.5 — Free recovery and alternative-model assessment

Sermon: **47-1207 Experiences**  
Coverage: **header + paragraphs 1–97** (98 original records; two chunks: header+1–50 and 51–97).  
Paid generation this phase: **0**. Chunk 2: **not executed**. Source / knowledge / Bible dataset: **unchanged**. Safety settings: **not weakened**.

## 1. Why safety metadata was not saved

The 3C.3 Chunk 1 saver in `scripts/translate_one_sermon.js` built a **hand-picked subset** of the SDK object:

- `finishReason` from `candidates[0].finishReason`
- `usageMetadata`
- `response.text`

It did **not** copy:

- `promptFeedback` (blockReason, safetyRatings)
- `candidates[0].safetyRatings`
- `candidates[0].finishMessage`
- `modelVersion`
- `responseId`
- the full `GenerateContentResponse`

`writeGeminiResponse()` only wrote `meta.json` + raw text + payload. There was no `full-response.json` path.

That is a **logger design gap**, not proof those fields were empty. The SDK (`@google/genai` 3.0.0) exposes all of them. `blockReasonMessage` is documented as **unsupported on Gemini API** (Vertex-only).

## 2. Logging improvement (prepared, unused)

Code now has:

- `jsonSafeClone()` — serializes the SDK class instance; omits `sdkHttpResponse` so Authorization headers are never written
- `extractGeminiSafetyMetadata()` — promptFeedback, finishReason, finishMessage, safetyRatings, citationMetadata, modelVersion, responseId, usage
- `writeGeminiResponse(..., { fullResponse })` — writes `request-NN.full-response.json` plus `safety_metadata` on `request-NN.meta.json`
- Phase 3C.3 Chunk 1 saver and the generic `translateRequest()` path both pass `fullResponse`

**No generateContent was run** to exercise this. The next approved paid call will persist the complete metadata.

## 3. Failure recap (from 3C.4)

- Provider-side `PROHIBITED_CONTENT` on Gemini 3.1 Pro Preview Chunk 1
- Input billed 40322; output 0; empty Tamil
- Non-configurable Google filter (not `SAFETY` / `safetySettings`)
- Exact trigger passage **unknown**
- Blind retry of the same 3C.3 request is **not** justified

## 4. Token basis for cost (full sermon, two chunks)

From verified Phase 3C.3 `countTokens` (not regenerated):

| Item | Tokens |
| --- | ---: |
| Chunk 1 input | 40322 |
| Chunk 2 input | 40098 |
| **Total input (system repeated)** | **80420** |
| Estimated visible Tamil JSON (both chunks) | 41197 |
| Likely thinking (2 × 11056, from 54-0812 observation) | 22112 |
| HIGH thinking reserve (2 × 24000) | 48000 |

FX used in this repo: **USD 1 = ₹84**, **GST 18%**.  
Tokenizer for non-Gemini models will differ; treat those costs as **order-of-magnitude** using the Gemini token counts.

Output limits: each chunk’s estimated visible JSON is ~20.5k tokens. A model with **max output &lt; ~25k** cannot hold HIGH thinking + Tamil JSON in one chunk.

## 5. Alternative model comparison

Sources (documented list prices, retrieved 2026-11-07):

- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Anthropic Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)

All figures are **Standard**, no Batch/cache, **header+1–97 in two chunks**, same knowledge package size assumed.

### Cost (input / visible output / likely total / HIGH-reserve total)

Likely total for thinking models = input + (visible 41197 + thinking 22112) billed as output.  
Non-thinking models = input + visible only (HIGH column same as likely).

| Model | Context / max out | EN→TA / theology (qualitative) | Input ₹ | Visible out ₹ | **Likely total ₹** | HIGH-reserve ₹ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| **gemini-3.1-pro-preview** (failed) | 1M / 65536 | Strong, but this sermon blocked | 15.94 | 49.00 | **91.24** | 122.04 |
| **gemini-2.5-pro** | 1M / 65536-class | Strong; **same Google prohibited-content filter** | 9.96 | 40.83 | **72.72** | 98.38 |
| **gemini-2.5-flash** | 1M | Weaker long Tamil/theology | 2.39 | 10.21 | **18.08** | 24.49 |
| **gemini-3-flash-preview** | 1M | Faster/cheaper Gemini 3; **same filter family** | 3.99 | 12.25 | **22.81** | 30.51 |
| **claude-sonnet-5.5** | 200k / large | Strong instruction-following; Tamil unproven vs 54-0812 | 15.94 | 40.83 | **56.78** | 56.78* |
| **claude-opus-5.5** | 200k / large | Highest Claude fidelity; expensive | 31.88 | 81.67 | **113.55** | 113.55* |
| **gpt-5** | 400k in / 128k out | Capable; Tamil/KJV-style unproven | 9.96 | 40.83 | **72.72** | 98.38 |
| **gpt-4.1** | 1M / **32768** | Two chunks required; 32k ceiling is tight if thinking were added; model is deprecated | 15.94 | 32.67 | **48.61** | 48.61 |

\*Claude likely totals assume **no** extra extended-thinking tokens. If extended thinking is enabled, output cost rises (thinking is billed as output).

USD (likely total): 3.1 Pro $0.921 · 2.5 Pro $0.734 · 2.5 Flash $0.182 · 3 Flash $0.230 · Sonnet 5.5 $0.573 · Opus 5.5 $1.146 · GPT-5 $0.734 · GPT-4.1 $0.490.

### Fit notes

- **All listed models** can hold one 40k-token chunk in context.
- **gpt-4.1** max output 32768: visible ~20535 per chunk **fits**; adding large reasoning would not.
- **Google Translate / generic MT**: not compared as a primary option — no glossary, no KJV/BSI pair injection, poor sermon cadence.
- **Batch API** (50% on some Gemini/Claude SKUs) is out of scope (user forbade Batch).

## 6. Recommended next step

**Do not retry Gemini 3.1 Pro Preview on the same Chunk 1 payload.**

**Recommended recovery (needs your explicit approval before any paid call):**

1. Keep the logging fix (already in code; free).
2. Keep the **two-chunk, 98-record** plan (header+1–50, then 51–97).
3. **First paid experiment:** Claude **Sonnet 5.5**, Chunk 1 only, same English paragraphs, same distilled knowledge + the four verified Bible pairs, **no** safety-threshold weakening, **no** source rewrite.
4. Only if Sonnet 5.5 also refuses: consider Opus 5.5 or GPT-5 as a second provider — still Chunk 1 only.

**Why Sonnet 5.5 rather than Gemini 2.5 Pro:** 3C.4 showed a **non-configurable Google** `PROHIBITED_CONTENT` stop. 2.5 Pro is cheaper (~₹73 likely) and would reuse the current SDK, but it **very likely shares the same hard filter**. Switching providers is the only strategy that can succeed without editing the sermon.

### Risks

- Anthropic (and OpenAI) have **their own** child-safety and prohibited-content filters. ¶19 / ¶23–24 / ¶35–36 could still block.
- Tamil + Branham cadence + BSI O.V. reuse is **unproven** on Claude/GPT; 54-0812 Gemini output is not a baseline for them.
- Token counts will not match Gemini `countTokens`; actual INR may move ±20%.
- New client code is required (Claude Messages / OpenAI Responses). That is implementation work, not done here.
- If the first Sonnet call is blocked, you still spend input (order of **₹8–16** for Chunk 1 input-only, analogous to the ₹7.99 Gemini miss).

**Not recommended:** Gemini Flash (quality), Opus-first (cost), GPT-4.1 (deprecated, 32k cap), lowering `safetySettings`, rewriting paragraphs.

## Confirmation

- generateContent: **false**
- Paid requests: **0**
- Sermon text / knowledge / Bible dataset: **unmodified**
- Safety protections: **not weakened**
- Stop: wait for explicit approval before any paid call or Chunk 2.
