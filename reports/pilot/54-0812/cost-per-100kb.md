# Cost per 100 KB English source

Based on Phase 2A preflight for `54-0812` (Gemini 3.1 Pro Preview). **No generateContent in this note.**

Assumptions: $1 = ₹84, GST 18%, Tamil output ≈ 1.35× English tokens, JSON overhead included. 100 KB = 102,400 bytes of English sermon text.

`54-0812` English body = 17,645 bytes (~17.2 KB). About **5.8 sermons** of this size make 100 KB.

## One 100 KB sermon (knowledge prompt paid once)

| API | USD | INR incl. GST |
| --- | ---: | ---: |
| Standard | $0.62 | **₹61** |
| Batch (estimate only) | $0.31 | **₹30** |

This is the fair rate if you send a long sermon (or pack ~100 KB) in **one** request.

## 100 KB as many short sermons like 54-0812

Each short sermon reloads the ~44k-token knowledge prompt, so cost is higher.

| Path | INR incl. GST per 100 KB English |
| --- | ---: |
| Standard, one request per sermon | **₹103** |
| Standard, 3 chunks per sermon (current generate path) | **₹214** |
| Batch, one request per sermon | **₹51** |

## How to read this

- Knowledge/system prompt is most of the input (~43,871 tokens). It does **not** grow with sermon size.
- Extra English costs about **₹0.53 per extra 100 KB** of source plus Tamil output (~₹47 of the ₹61 is output).
- Chunking repeats the knowledge prompt (3× for this short sermon) and roughly **doubles** cost. Prefer one request per sermon when `maxOutputTokens` is enough.
- Batch is **not** enabled. Figures are estimates only.
