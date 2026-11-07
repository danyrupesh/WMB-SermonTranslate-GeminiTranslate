# Token Report & Cost Estimate (600 pending sermons)

Generated: 2026-11-06T15:44:44.378Z

## Method

- **Actual tokens** via Gemini `countTokens` (`gemini-3.1-flash-lite`).
- **0** generation requests.
- **0** GCS uploads.

## Reference corpus tokens by category

| Category | Records | Tokens |
| --- | ---: | ---: |
| approved_sermon_paragraph_pairs | 75387 | 1,85,12,727 |
| document_level_sermon_references | 72 | 32,41,512 |
| bible_verse_pairs | 31102 | 28,01,872 |
| terminology_glossary | 122 | 1,715 |
| phrase_glossary | 38320 | 10,47,907 |
| **Combined reference** |  | **2,56,05,733** |

## Pending workload (600 sermons)

| Metric | Value |
| --- | ---: |
| Pending available (excl. approved) | 942 |
| Selected | 600 |
| English input tokens (actual) | 1,02,88,010 |
| Estimated Tamil output (×1.35) | 1,38,88,814 |
| Avg English tokens / sermon | 17146.7 |

## Critical budget finding

With Gemini 3.1 Pro Preview Batch + a 180k distilled cache (1h TTL):

| Workload | INR + GST | Within ₹2,000 ceiling |
| --- | ---: | --- |
| Pilot 5 sermons | ₹216 | true |
| Max fit under ceiling | **97 sermons** (₹1983) | true |
| Full 600 sermons | ₹11642 | false |

**₹2,500 is not enough for 600 Pro Batch translations** at measured ~17147 English tokens/sermon.

## Cost scenarios

### A_distilled_180k_cache_1h
- Sermons: 600
- Knowledge tokens: 1,80,000
- Cache hours: 1
- Total USD: **$117.46**
- Total INR + GST: **₹11642**
- Within ₹2,000 ceiling: **false**

### A2_distilled_180k_cache_24h
- Sermons: 600
- Knowledge tokens: 1,80,000
- Cache hours: 24
- Total USD: **$136.09**
- Total INR + GST: **₹13489**
- Within ₹2,000 ceiling: **false**

### B_full_ref_cache_1h
- Sermons: 600
- Knowledge tokens: 2,23,64,221
- Cache hours: 1
- Total USD: **$2923.81**
- Total INR + GST: **₹289808**
- Within ₹2,000 ceiling: **false**

### C_no_cache_small_glossary_40k
- Sermons: 600
- Knowledge tokens: 40,000
- Cache hours: 0
- Total USD: **$94.70**
- Total INR + GST: **₹9387**
- Within ₹2,000 ceiling: **false**

### D_pilot_5_distilled_1h
- Sermons: 5
- Knowledge tokens: 1,80,000
- Cache hours: 1
- Total USD: **$2.18**
- Total INR + GST: **₹216**
- Within ₹2,000 ceiling: **true**

### E_budget_fit_distilled_1h
- Sermons: 97
- Knowledge tokens: 1,80,000
- Cache hours: 1
- Total USD: **$20.00**
- Total INR + GST: **₹1983**
- Within ₹2,000 ceiling: **true**


## Recommendation

1. Do **not** cache the full ~25.6M-token reference corpus.
2. Build a distilled knowledge package (≤180k tokens) from approved pairs + glossary.
3. Run a **5-sermon pilot** first.
4. Keep context-cache TTL short (≈1 hour) — 24h Pro cache storage alone can consume most of the budget.
5. Reassess model tier / sermon count after pilot actuals.

## Related files

- `token-report.json`
- `cost-estimate.json`
- `corpus-integration-audit.md`
- `consolidated_reference/consolidated-corpus-proposal.md`
- `consolidated_reference/audit/`
