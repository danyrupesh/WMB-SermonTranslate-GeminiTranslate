# Phase 3 — Existing Pilot Audit — 54-0812 Prayer Line

Generated: 2026-11-07T08:08:45.098Z

**No generateContent. No paid Gemini generation. Translation files unchanged.**

## Status: `PASS_WITH_REVIEW`

- Structural integrity: **PASS**
- Phase 2B config parity: **FAIL (expected)**
- Human review items: **23**

## Existing paid run
- Model: `gemini-3.1-pro-preview`
- Paragraphs: EN 17 / TA 17
- Bible pairs injected at generation: **0**
- Duration: 69633 ms
- Raw chunk files: raw_chunk_1.txt, raw_chunk_2.txt
- Note: Pilot draft. Not copied to source_of_truth or approved 419.

## Actual usage & cost (from run-meta)
| Metric | Value |
| --- | ---: |
| Prompt tokens | 18911 |
| Output tokens | 5443 |
| Total tokens | 30097 |
| Est. USD (standard) | $0.103138 |
| Est. INR + GST | ₹10.22 |

## Phase 2B vs existing generation
| Item | Existing paid run | Phase 2B preflight |
| --- | --- | --- |
| Prompt version | not recorded | `phase2b-preflight-1` |
| System / prompt tokens | promptTokenCount **18911** (summed) | system **24902**, total input **29498** |
| Bible pairs | **0** | **2** (John 5:14, Mark 16:17) |
| Request shape | chunked (`raw_chunk_1.txt`, `raw_chunk_2.txt`) | prefer **one** full-sermon request |
| Model | `gemini-3.1-pro-preview` | `gemini-3.1-pro-preview` |
| API version | not in run-meta | `v1beta` |

## Paragraph verification
- Expected labels: `header`, `1`–`16` (17 total)
- Missing: none
- Duplicated: none
- Incomplete markers (`...?...`): 4, 10, 14

| Label | EN=source | TA chars | TA/EN byte ratio | Incomplete |
| --- | --- | ---: | ---: | --- |
| header | yes | 129 | 2.633 |  |
| 1 | yes | 2493 | 3.378 |  |
| 2 | yes | 3289 | 3.387 |  |
| 3 | yes | 2119 | 3.698 |  |
| 4 | yes | 6786 | 3.109 | yes |
| 5 | yes | 4208 | 3.424 |  |
| 6 | yes | 2873 | 3.573 |  |
| 7 | yes | 5313 | 3.752 |  |
| 8 | yes | 3925 | 3.486 |  |
| 9 | yes | 3937 | 3.518 |  |
| 10 | yes | 4860 | 3.29 | yes |
| 11 | yes | 2827 | 3.926 |  |
| 12 | yes | 4920 | 3.547 |  |
| 13 | yes | 2348 | 3.856 |  |
| 14 | yes | 4368 | 3.658 | yes |
| 15 | yes | 2649 | 3.551 |  |
| 16 | yes | 4468 | 3.469 |  |

## Bible quotation checks
- Para `3` (John 5:14): **needs_human_review**
- Para `13` (Mark 16:17): **needs_human_review**

## Corrections / items requiring human review
1. **[header] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
2. **[1] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
3. **[2] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
4. **[3] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
5. **[4] incomplete_marker** — Contains ...?... or similar incomplete/editor gap marker preserved or introduced.  
   Action: Human decide whether marker should remain as in English source.
6. **[4] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
7. **[5] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
8. **[6] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
9. **[7] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
10. **[8] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
11. **[9] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
12. **[10] incomplete_marker** — Contains ...?... or similar incomplete/editor gap marker preserved or introduced.  
   Action: Human decide whether marker should remain as in English source.
13. **[10] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
14. **[11] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
15. **[12] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
16. **[13] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
17. **[14] incomplete_marker** — Contains ...?... or similar incomplete/editor gap marker preserved or introduced.  
   Action: Human decide whether marker should remain as in English source.
18. **[14] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
19. **[15] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
20. **[16] terminology_uncertain** — One or more glossary terms present in English were not detected as approved Tamil substrings.  
   Action: Human doctrinal/terminology review. Do not silently rewrite.
21. **[2] loanword_parenthetical** — Tamil keeps English “multiple sclerosis” in parentheses after Tamil transliteration.  
   Action: Human style preference: keep bilingual medical gloss or Tamil-only.
22. **[16] loanword_parenthetical** — Tamil includes English medical parentheticals (peptic / peptic ulcer).  
   Action: Human style preference.
23. **[4] editor_gap_preserved** — English source has “...?...”; Tamil preserves “...?...” — likely intentional tape/editor gap.  
   Action: Confirm keep as-is (recommended) vs inventing missing words.

## Issues
- `warn` incomplete_marker: "4"
- `warn` incomplete_marker: "10"
- `warn` incomplete_marker: "14"

## Stop
Audit complete. Do **not** call generateContent. Do **not** rewrite translation files. Do **not** process other sermons.
