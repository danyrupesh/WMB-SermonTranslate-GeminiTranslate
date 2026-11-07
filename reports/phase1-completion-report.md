# Phase 1 Completion Report

Generated: 2026-11-06T16:47:47.418Z

## Validity

| Check | Result |
| --- | --- |
| Both source datasets valid (no invalid records) | **true** |
| Bible 31,102 preserved in FTS | **true** (31102) |
| Sermon records inspected | **75474** |
| Sermon complete pairs | **75474** |
| Bible complete pairs | **31102** |

## Extraction

| Item | Count |
| --- | ---: |
| Terminology entries | 99 |
| Terminology conflicts | 69 |
| Biblical name entries | 48 |
| Doctrinal glossary entries | 22 |
| Doctrinal conflicts | 13 |
| Repeated phrases | 101 |
| Approved examples | 630 |

## Knowledge package size

- Local token estimate: **1,60,510**
- Target: 1,50,000–1,80,000
- Within target: **true**
- Gemini countTokens: **awaiting_manual_approval**

Largest sections:
- approved_examples: ~1,12,999 tokens
- terminology: ~18,447 tokens
- repeated_phrases: ~13,533 tokens
- biblical_names: ~12,553 tokens
- doctrinal_glossary: ~2,933 tokens
- translation_style_guide: ~639 tokens

## Integrity highlights

- Missing English (sermon): 0
- Missing Tamil (sermon): 0
- Duplicate EN–TA pairs (sermon): 82
- Unicode replacement chars (sermon): 0

## Remaining issues / recommendations

1. Local token estimate is heuristic until you approve `APPROVE_TOKEN_COUNT=1`.
2. Single-word terminology alignment inside long paragraphs is intentionally conservative (evidence-only; no invented Tamil glosses).
3. Review top conflicting terminology in `reports/terminology-extraction-report.json` before Phase 2.
4. Use `knowledge/bible_fts.sqlite` at request time for 5–10 verse retrieval — do not cache the full Bible.
5. **Stop here.** Do not authorize paid Flash-Lite corpus analysis or Pro translation until these reports are reviewed.

## Budget reminder

- Available: ₹2,500 | Ceiling: ₹2,000 | Reserve: ₹500
- Phase 1 API spend: **₹0**
