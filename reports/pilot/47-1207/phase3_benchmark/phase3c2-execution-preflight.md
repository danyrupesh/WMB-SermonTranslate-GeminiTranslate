# Phase 3C.2 — Final Bible Match Correction Preflight — 47-1207 Experiences

Generated: 2026-11-07T09:48:54.308Z

**Zero paid generation requests. No generateContent. countTokens only on exact chunk payloads.**

## Verdict
- Both chunks safe to execute independently: **true**
- Paragraph coverage exact (98 unique, no missing/dupes): **true**
- Estimated total likely cost (both chunks): **₹91.22**
- Estimated total HIGH-reserve cost: **₹122.01**
- Estimated total maximum-potential cost: **₹171.82**

## Configuration (unchanged quality)
- Model: `gemini-3.1-pro-preview` / `v1beta`
- thinkingLevel: **HIGH** · includeThoughts: false
- maxOutputTokens: **65536**
- Compact Tamil-only JSON · full knowledge package · verified Bible pairs per chunk

## Paragraph coverage
- Expected paragraphs: 98
- Assigned across chunks: 98
- Missing: none
- Duplicated: none
- Unknown labels: none

## Chunks (exact countTokens)
### Chunk 1 — `chunk_1_header_1_50`
- Paragraphs: **51** (`header` … `50`)
- Bible pairs injected: **4** (John 5:6, John 5:7, John 5:8, John 11:39)
  - `John 5:6` ← "Will thou be made whole?" [fts_kjv_wording; n-gram 5: will you be made whole]
  - `John 5:7` ← "Sir, I have no one to put me in the water." [fts_phrase_prefix; n-gram 4: sir i have no]
  - `John 5:8` ← "Take up your bed and walk." [fts_kjv_wording; n-gram 6: take up your bed and walk]
  - `John 11:39` ← "Take ye away the stone." [fts_kjv_wording; n-gram 5: take ye away the stone]

| Item | Tokens |
| --- | ---: |
| System prompt | 25074 |
| User prompt | 15184 |
| **Total input** | **40258** |
| English source | 14698 |
| Est. visible Tamil JSON | 20535 |
| HIGH thinking reserve | 24000 |
| Safety margin | 2048 |
| **Required output budget** | **46583** |
| maxOutputTokens | 65536 |

- Safe to execute independently: **true**
- Likely cost: **₹45.56**
- HIGH-reserve cost: **₹60.95**
- Max potential: **₹85.93**
- Payload artifact: `E:\Freelance\MessageDBApp\AI_Translate\GoogleGemini\reports\pilot\47-1207\phase3_benchmark\phase3c2-chunk_1_header_1_50-payload.json`

### Chunk 2 — `chunk_2_51_97`
- Paragraphs: **47** (`51` … `97`)
- Bible pairs injected: **0** (none — zero pairs when no reliable match)

| Item | Tokens |
| --- | ---: |
| System prompt | 24738 |
| User prompt | 15296 |
| **Total input** | **40034** |
| English source | 14828 |
| Est. visible Tamil JSON | 20662 |
| HIGH thinking reserve | 24000 |
| Safety margin | 2048 |
| **Required output budget** | **46710** |
| maxOutputTokens | 65536 |

- Safe to execute independently: **true**
- Likely cost: **₹45.66**
- HIGH-reserve cost: **₹61.06**
- Max potential: **₹85.89**
- Payload artifact: `E:\Freelance\MessageDBApp\AI_Translate\GoogleGemini\reports\pilot\47-1207\phase3_benchmark\phase3c2-chunk_2_51_97-payload.json`

## Totals (both requests)
| Item | Tokens / Cost |
| --- | ---: |
| System prompt sum (repeated) | 49812 |
| User prompt sum | 30480 |
| Total input sum | 80292 |
| Est. visible Tamil JSON sum | 41197 |
| Likely INR+GST | ₹91.22 |
| HIGH-reserve INR+GST | ₹122.01 |
| Maximum-potential INR+GST | ₹171.82 |

## Assembly strategy
- chunk_1_then_chunk_2_by_original_label_order
- For each returned {label,tamil}, attach english from local source paragraphs by label. Build final document with all 98 paragraphs in original order. Write preview HTML. Do not write source_of_truth.
- Take tamil_title from chunk 1 response if present; otherwise derive from header tamil.
- No automatic retries. Separate approval required per chunk.

## Bible match corrections
- Identifiable quotation / clear verse reference only. Generic words are not citations.
- One verse per quotation: keep the spoken command, not a later restatement.
- Do not fill to 5–10 pairs. Zero pairs if no reliable match.
- Tamil BSI O.V. wording taken unchanged from `bible_parallel_dataset.json`.

### Retained matches
- Chunk 1: **John 5:6** — sermon: "Will thou be made whole?" — method: `fts_kjv_wording` — n-gram(5): "will you be made whole"
- Chunk 1: **John 5:7** — sermon: "Sir, I have no one to put me in the water." — method: `fts_phrase_prefix` — n-gram(4): "sir i have no"
- Chunk 1: **John 5:8** — sermon: "Take up your bed and walk." — method: `fts_kjv_wording` — n-gram(6): "take up your bed and walk"
- Chunk 1: **John 11:39** — sermon: "Take ye away the stone." — method: `fts_kjv_wording` — n-gram(5): "take ye away the stone"

### Removed matches (Phase 3C.1 → 3C.2)
- Chunk 1: **John 5:12** for "Take up your bed and walk." — The sermon quotes Jesus’ command “Take up your bed and walk,” which is John 5:8. John 5:12 is the later question (“What man is that which said unto thee, Take up thy bed, and walk?”) and is not injected as a separate Bible quotation.

## Confirmation
- Paid generation requests: **0**
- generateContent: **false**
- Translation performed: **false**
- GCS / cache / Batch: **false**
- DB / source-of-truth writes: **false**
- Baseline not overwritten: **true**

## Stop
Do **not** start Chunk 1 or Chunk 2 without separate explicit approval.
