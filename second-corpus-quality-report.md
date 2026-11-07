# Second Corpus Quality Report

Generated: 2026-11-06T15:31:11.676Z

## Bible

| Metric | Count |
| --- | ---: |
| English rows | 31102 |
| Tamil rows | 31102 |
| Expected join | 31102 |
| Complete pairs written | 31102 |
| Empty English | 0 |
| Empty Tamil | 0 |
| Missing Tamil join | 0 |
| Output file | `second_corpus\bible\verses.jsonl` |
| Output size (bytes) | 20263664 |

## Sermons

| Metric | Count |
| --- | ---: |
| English messages | 1217 |
| Tamil messages | 645 |
| Paired by sermon code | 407 |
| Unpaired English | 613 |
| Unpaired Tamil | 238 |
| Also in existing 419 JSON | 261 |
| New vs 419 JSON | 146 |
| Paragraph-level sermons | 335 |
| Document-level fallback | 72 |
| Complete paragraph pairs | 47286 |
| Incomplete pairs | 0 |
| Unmatched English-only labels | 35659 |
| Unmatched Tamil-only labels | 39794 |
| Duplicate pairs skipped | 33 |

## Output sizes

| Path | Bytes |
| --- | ---: |
| second_corpus/ | 121356895 |
| bible/ | 20263664 |
| sermons/paired/ | 76149258 |
| sermons/document-level/ | 24843365 |

## Notes

- Original BRD-David SQLite databases were not modified.
- Existing `dataset/` and `clean_dataset/` were not modified.
- Sermons with fewer than 5 shared primary numbered paragraphs were stored as document-level pairs only (no invented alignments).
- English is the source language; Tamil is the target.
