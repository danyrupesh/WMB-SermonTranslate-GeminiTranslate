# Phase 3C.1 — Corrected Bible Pair Retrieval Preflight — 47-1207 Experiences

Generated: 2026-11-07T08:37:04.484Z

**Zero paid generation requests. No generateContent. countTokens only on exact chunk payloads.**

## Verdict
- Both chunks safe to execute independently: **true**
- Paragraph coverage exact (98 unique, no missing/dupes): **true**
- Estimated total likely cost (both chunks): **₹91.23**
- Estimated total HIGH-reserve cost: **₹122.02**
- Estimated total maximum-potential cost: **₹171.83**

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
- Bible pairs injected: **5** (John 5:6, John 5:7, John 5:8, John 5:12, John 11:39)
  - `John 5:6` ← "Will thou be made whole?" [fts_kjv_wording; n-gram 5: will you be made whole]
  - `John 5:7` ← "Sir, I have no one to put me in the water." [fts_phrase_prefix; n-gram 4: sir i have no]
  - `John 5:8` ← "Take up your bed and walk." [fts_kjv_wording; n-gram 6: take up your bed and walk]
  - `John 5:12` ← "Take up your bed and walk." [fts_kjv_wording; n-gram 6: take up your bed and walk]
  - `John 11:39` ← "Take ye away the stone." [fts_kjv_wording; n-gram 5: take ye away the stone]

| Item | Tokens |
| --- | ---: |
| System prompt | 25139 |
| User prompt | 15184 |
| **Total input** | **40323** |
| English source | 14698 |
| Est. visible Tamil JSON | 20535 |
| HIGH thinking reserve | 24000 |
| Safety margin | 2048 |
| **Required output budget** | **46583** |
| maxOutputTokens | 65536 |

- Safe to execute independently: **true**
- Likely cost: **₹45.57**
- HIGH-reserve cost: **₹60.97**
- Max potential: **₹85.94**
- Payload artifact: `E:\Freelance\MessageDBApp\AI_Translate\GoogleGemini\reports\pilot\47-1207\phase3_benchmark\phase3c1-chunk_1_header_1_50-payload.json`

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
- Payload artifact: `E:\Freelance\MessageDBApp\AI_Translate\GoogleGemini\reports\pilot\47-1207\phase3_benchmark\phase3c1-chunk_2_51_97-payload.json`

## Totals (both requests)
| Item | Tokens / Cost |
| --- | ---: |
| System prompt sum (repeated) | 49877 |
| User prompt sum | 30480 |
| Total input sum | 80357 |
| Est. visible Tamil JSON sum | 41197 |
| Likely INR+GST | ₹91.23 |
| HIGH-reserve INR+GST | ₹122.02 |
| Maximum-potential INR+GST | ₹171.83 |

## Assembly strategy
- chunk_1_then_chunk_2_by_original_label_order
- For each returned {label,tamil}, attach english from local source paragraphs by label. Build final document with all 98 paragraphs in original order. Write preview HTML. Do not write source_of_truth.
- Take tamil_title from chunk 1 response if present; otherwise derive from header tamil.
- No automatic retries. Separate approval required per chunk.

## Bible match corrections
- Identifiable quotation / clear verse reference only. Generic words are not citations.
- Do not fill to 5–10 pairs. Zero pairs if no reliable match.
- Tamil BSI O.V. wording taken unchanged from `bible_parallel_dataset.json`.

### Retained matches
- Chunk 1: **John 5:6** — sermon: "Will thou be made whole?" — method: `fts_kjv_wording` — n-gram(5): "will you be made whole"
- Chunk 1: **John 5:7** — sermon: "Sir, I have no one to put me in the water." — method: `fts_phrase_prefix` — n-gram(4): "sir i have no"
- Chunk 1: **John 5:8** — sermon: "Take up your bed and walk." — method: `fts_kjv_wording` — n-gram(6): "take up your bed and walk"
- Chunk 1: **John 5:12** — sermon: "Take up your bed and walk." — method: `fts_kjv_wording` — n-gram(6): "take up your bed and walk"
- Chunk 1: **John 11:39** — sermon: "Take ye away the stone." — method: `fts_kjv_wording` — n-gram(5): "take ye away the stone"

### Removed matches (Phase 3C → 3C.1)
- Chunk 1: **Exodus 29:18** for "Will thou be made whole?" — Rejected bag-of-words / generic overlap with “Will thou be made whole?” This sermon quotes John 5:6 (“Wilt thou be made whole?”), not Exodus 29:18.
- Chunk 1: **Matthew 15:28** for "Will thou be made whole?" — Rejected bag-of-words / generic overlap with “Will thou be made whole?” This sermon quotes John 5:6 (“Wilt thou be made whole?”), not Matthew 15:28.
- Chunk 1: **John 5:14** for "Will thou be made whole?" — Rejected bag-of-words / generic overlap with “Will thou be made whole?” This sermon quotes John 5:6 (“Wilt thou be made whole?”), not John 5:14.
- Chunk 1: **Mark 2:9** for "Take up your bed and walk." — Rejected former fts_and_words match: overlapping common words without a distinctive consecutive KJV phrase.
- Chunk 1: **John 5:11** for "Take up your bed and walk." — Rejected weaker duplicate of “Take up your bed and walk.” Kept the distinctive KJV command verses only; John 5:11 is a valid record but not selected as the identifiable quotation.
- Chunk 2: **Acts 8:37** for "I believe that Jesus, with all my heart, and I believe Jesus sent you here." — Rejected generic testimony wording (“I believe that Jesus…”). Not treated as a citation of Acts 8:37.
- Chunk 2: **Genesis 29:35** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of Genesis 29:35.
- Chunk 2: **Leviticus 19:24** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of Leviticus 19:24.
- Chunk 2: **1 Chronicles 16:4** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of 1 Chronicles 16:4.
- Chunk 2: **1 Chronicles 23:30** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of 1 Chronicles 23:30.
- Chunk 2: **1 Chronicles 25:3** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of 1 Chronicles 25:3.
- Chunk 2: **2 Chronicles 7:6** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of 2 Chronicles 7:6.
- Chunk 2: **2 Chronicles 20:19** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of 2 Chronicles 20:19.
- Chunk 2: **2 Chronicles 20:21** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of 2 Chronicles 20:21.
- Chunk 2: **Ezra 3:10** for "Praise the Lord …?…" — Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of Ezra 3:10.

## Confirmation
- Paid generation requests: **0**
- generateContent: **false**
- Translation performed: **false**
- GCS / cache / Batch: **false**
- DB / source-of-truth writes: **false**
- Baseline not overwritten: **true**

## Stop
Do **not** start Chunk 1 or Chunk 2 without separate explicit approval.
