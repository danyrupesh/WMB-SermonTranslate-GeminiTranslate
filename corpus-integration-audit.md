# Second Corpus Integration Audit

Generated: 2026-11-06T15:38:08.083Z

## Inspection

- Bible JSONL lines: **31102**
- Paragraph-level sermon files: **335**
- Document-level sermon files: **72**

## Bible verification

- Verified exact match vs SQLite: **31102**
- All 31,102 verified: **true**
- Bad references: 0
- Text mismatches: 0

## Duplicate audit (33 skipped)

- Re-detected skipped duplicate pairs: **33**
- Details: `audit/skipped-duplicate-pairs.json`

## Unmatched labels

- English-only labels: **35659**
- Tamil-only labels: **39794**
- Preserved at: `consolidated_reference\categories\_staging_unmatched_source_paragraphs\unmatched_paragraphs.jsonl`
- Investigation: `audit/unmatched-label-investigation.json`

## Comparison vs approved 419

- Exact paragraph duplicates: **7**
- Near-duplicates: **81**
- Novel paragraph pairs: **47198**
- Paired sermon overlap with 419: **261**
- Paired sermons new vs 419: **146**

## Next

Run `node phase2_token_cost_report.js` for category token counts and the 600-sermon cost estimate.
