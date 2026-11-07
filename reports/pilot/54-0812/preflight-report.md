# Phase 2B Preflight — 54-0812

Generated: 2026-11-07T08:00:17.654Z

**No generateContent.** No GCS, cache, Batch, or database writes.

## Sermon
- ID: `54-0812`
- Title: Prayer Line
- Model: `gemini-3.1-pro-preview` (v1beta)
- Prompt version: `phase2b-preflight-1`

## Hashes
- Source sermon: `31b7a9115e94fdc7bfcfe1e7e7d46a089f30af1b8cd0fdf3147eee26abf4ecb2`
- System prompt: `f5e326daf12fe7331c8d40913655c676030eea8faaa1b9111317c96c26b7fd9e`
- Knowledge package: `1665a24de3bdc568a1854a3be72d79a36ce833f77d8572834eede16f75f8e12a`

## Tokens (actual countTokens)
| Item | Tokens |
| --- | ---: |
| System prompt | 24902 |
| User request | 4596 |
| **Total input** | **29498** |
| English source only | 4405 |
| Estimated Tamil output (×1.35) | 5947 |
| Estimated output + JSON | 6808 |
| maxOutputTokens | 16384 |
| Context window | 1048576 |

- Fits context window: **true**
- maxOutputTokens sufficient: **true**
- Prefer single generateContent request: **true**
- Cached tokens: 0

## Prompt component tokens
| Component | Tokens |
| --- | ---: |
| Instruction preamble | 137 |
| Style guide (standalone, not double-injected) | 352 |
| prompt_package.json (pretty file) | 37540 |
| prompt_package.json (compact JSON) | 24513 |
| Phase 2A verbose compactKnowledge() blob | 43591 |
| Package guide | 352 |
| Package terms | 8669 |
| Package names | 3897 |
| Package doctrinal | 2148 |
| Package phrases | 1704 |
| Package examples (36) | 7728 |
| Bible block | 195 |
| System prompt as sent (2B) | 24902 |
| User request | 4596 |

- Phase 1.1 shared prompt estimate: 22821
- Phase 2A system tokens observed: 43871
- Gap explanation: Phase 2A injected verbose knowledge/*.json via JSON.stringify(compactKnowledge()), duplicating style_guide and metadata (source_ids, evidence_classification, etc.). Phase 2B injects distilled prompt_package.json instead.

## Cost estimate (Gemini 3.1 Pro Preview)
Single full-sermon request:
- Standard: $0.140692 → ₹13.95 (incl. GST)
- Batch: $0.070346 → ₹6.97 (incl. GST)

Chunked fallback path (3 × system prompt if needed, PARA_CHUNK=6):
- Standard: $0.258684 → ₹25.64
- Batch: $0.129342 → ₹12.82

Batch figures are estimates only. This phase does **not** submit Batch jobs.

## Knowledge (distilled prompt_package)
- Source: `knowledge/prompt_package.json`
- Verified terminology: 93
- Context-dependent terminology: 27
- Biblical names: 50
- Doctrinal glossary: 27
- Repeated phrases: 19
- Compact examples: 36

## Bible retrieval
- Injected verified pairs: 2
- Failures / misses: 4

- `The same things that I do,` — paraphrase_unmatched
- `If you get the people to believe you…` — not_scripture
- `Something’s wrong with your eye.` — not_scripture
- `I accept Him as my Healer.` — not_scripture

## Stop
Wait for explicit approval before `--generate`.
