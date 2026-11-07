# Phase 3B Preflight — 47-1207 — Experiences

Generated: 2026-11-07T08:24:07.056Z

**Zero paid generation requests. No generateContent. countTokens only.**

## Sermon
- ID: `47-1207`
- Title: Experiences
- Date: 1947-12-07 · Duration: 137 min · Location: Phoenix AZ
- Paragraphs loaded: **98**

## Configuration (quality not reduced)
- Model: `gemini-3.1-pro-preview` (`v1beta`)
- `maxOutputTokens`: **65536** (documented model max **65536**)
- `thinkingConfig.thinkingLevel`: **HIGH**
- Compact response: **label + tamil only**
- Knowledge package + verified Bible pairs: **preserved**

## Actual countTokens
| Item | Tokens |
| --- | ---: |
| System prompt | 25490 |
| User prompt | 30331 |
| **Total input** | **55821** |
| English source only | 29526 |
| Est. Tamil body (×1.35) | 39861 |
| Est. visible Tamil JSON | 41117 |
| HIGH thinking reserve | 24000 |
| Safety margin | 2048 |
| **Required output budget** | **67165** |
| Configured maxOutputTokens | 65536 |

## Can the complete sermon fit in one request?
- **NO**
- Output budget sufficient: **false**
- Fits context window: **true**
- Blockers: required_output_budget 67165 exceeds configured maxOutputTokens 65536

## Chunking recommendation (NOT executed)
- Strategy: `paragraph_aware_balanced_pack`
- Estimated chunks: **2**
- Max visible Tamil tokens / chunk: 39488
- Thinking level unchanged: **HIGH**
- Knowledge package unchanged: **true**
- Chunk 1: 51 paragraphs, est. visible ~20975 tokens, labels `header`…`50`
- Chunk 2: 47 paragraphs, est. visible ~20266 tokens, labels `51`…`97`
- Chunked max-potential upper bound (if each chunk hits ceiling): **₹178.03**

## Cost estimate (18% GST, USD→INR @ 84)
- Likely (visible + ~11k thinking): **₹73.12** ($0.737718)
- With HIGH thinking reserve (24000): **₹88.52** ($0.893046)
- **Maximum potential (one request, full 65536 output ceiling): ₹89.02** ($0.898074)

## Bible pairs (verified only)
- Count: 9
- Exodus 29:18
- Matthew 15:28
- John 5:6
- John 5:14
- Mark 2:9
- John 5:8
- John 5:11
- John 5:12
- John 11:39


## Confirmation
- Paid generation requests: **0**
- generateContent called: **false**
- Translation performed: **false**
- GCS / cache / Batch: **false**
- Database / source-of-truth writes: **false**

## Stop
Wait for explicit approval before any generateContent.
