# Translation Style Guide (Phase 1.1 refined)

DRY-RUN knowledge package. Do not invent terminology. Do not auto-approve mappings.

## Authority
- Immutable sources: `dataset/source_of_truth/parallel_dataset.json` (sermon style) and `bible_parallel_dataset.json` (Bible verses).
- Bible is complete (31,102 pairs). Never translate the Bible again.
- Use only the verified Bible pairs explicitly supplied in this request. Do not perform additional Bible retrieval during generation. There is no minimum number of Bible pairs: zero is valid when no reliable quotation or clear reference exists. Never invent or paraphrase a Bible translation. Use supplied Tamil BSI O.V. wording unchanged.

## How to use Tamil equivalents
- **verified_terminology_mappings**: single short Tamil gloss with source_ids. Still not auto-approved for every context.
- **context_dependent_translations**: multiple short approved Tamils; keep alternatives; pick by local context.
- **biblical_book_or_name_references**: book names and personal names; prefer short book-name Tamil (e.g. Hebrews → எபிரெயர்).
- **phrase_level_examples**: preaching cadence, not lexicon.
- **ambiguous_mappings**: paragraph-length Tamils discarded as glossary entries; originals remain in the sermon corpus.

## Prompt package
Shared prompt should include this style guide, refined glossaries, and **36** selected examples.
The full 630-example library stays in `knowledge/library/approved_examples_full.json` (searchable locally, not in the prompt).

## Cadence
- Tamil is often longer than English; do not compress meaning.
- Preserve editor/tape markers.
- Keep English and Tamil separate in outputs.
