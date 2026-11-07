/**
 * Phase 1 – Inspect & Distill Approved Translation Corpora
 * DRY-RUN: no GCS, no Batch, no generation.
 * Gemini countTokens only when APPROVE_TOKEN_COUNT=1.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const ROOT = __dirname;
const SOURCE_DIR = path.join(ROOT, '..', 'dataset', 'source_of_truth');
const SERMON_PATH = path.join(SOURCE_DIR, 'parallel_dataset.json');
const BIBLE_PATH = path.join(SOURCE_DIR, 'bible_parallel_dataset.json');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const REPORTS_DIR = path.join(ROOT, 'reports');

const APPROVE_TOKEN_COUNT = process.env.APPROVE_TOKEN_COUNT === '1';
const TOKEN_TARGET_MIN = 150000;
const TOKEN_TARGET_MAX = 180000;
const DRY_RUN = true;

const DOCTRINAL_SEEDS = [
  'bride', 'bridegroom', 'word', 'seal', 'seals', 'rapture', 'tabernacle', 'elect',
  'election', 'justification', 'sanctification', 'baptism', 'holy ghost', 'holy spirit',
  ' pentecost', 'pentecost', 'message', 'prophet', 'apostle', 'evangelist', 'teacher',
  'pastor', 'lamb', 'lion', 'eagle', 'blood', 'atonement', 'covenant', 'dispensation',
  'age', 'church ages', 'seven seals', 'seven thunders', 'capstone', 'cornerstone',
  'serpent', "serpent's seed", 'original sin', 'new birth', 'born again', 'water baptism',
  'spirit baptism', 'parousia', 'shekinah', 'pillar of fire', 'cloud', 'pyramid',
  'eden', 'adam', 'eve', 'christ', 'jesus', 'jehovah', 'elohim', 'messiah',
  'israel', 'gentile', 'jew', 'zion', 'jerusalem', 'calvary', 'golgotha',
  'faith', 'grace', 'law', 'mercy', 'judgment', 'millennium', 'tribulation',
  'antichrist', 'beast', 'mark of the beast', 'book of life', 'lambs book of life',
];

const STOP = new Set(
  `a an the and or but if then than of to in on at by for from with as is are was were be been being
  this that these those it its i you he she we they me him her us them my your his our their
  not no yes do does did done have has had will would shall should can could may might must
  so just only also very much more most some any all each every other into over out up down
  about when where what which who how why because while during before after again still yet
  there here now then once upon oh well say said says come came go went get got put take
  see saw look know known think thought tell told ask asked make made let`.split(/\s+/)
);

function ensureDirs() {
  fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function padId(prefix, n) {
  return `${prefix}_${String(n).padStart(6, '0')}`;
}

function normSpace(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasReplacementChar(s) {
  return s.includes('\uFFFD');
}

function hasUnpairedSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function estimateTokens(text) {
  // Mixed EN/TA heuristic; conservative (slightly high) for budget safety
  const chars = String(text || '').length;
  return Math.ceil(chars / 3.2);
}

function inspectCorpus(records, idPrefix, expectedTotal = null) {
  const report = {
    totalRecords: records.length,
    expectedTotal,
    expectedMatch: expectedTotal == null ? null : records.length === expectedTotal,
    missingEnglish: 0,
    missingTamil: 0,
    bothEmpty: 0,
    invalidRecords: 0,
    unicodeReplacementChar: 0,
    unpairedSurrogate: 0,
    duplicateEnglishKeys: 0,
    duplicateEnglishTamilPairs: 0,
    englishCharSum: 0,
    tamilCharSum: 0,
    maxEnglishChars: 0,
    maxTamilChars: 0,
    completePairs: 0,
    invalidSamples: [],
    unicodeSamples: [],
  };

  const enCounts = new Map();
  const pairCounts = new Map();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const id = padId(idPrefix, i + 1);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      report.invalidRecords++;
      if (report.invalidSamples.length < 20) {
        report.invalidSamples.push({ id, reason: 'not_object' });
      }
      continue;
    }
    if (typeof rec.english !== 'string' || typeof rec.tamil !== 'string') {
      report.invalidRecords++;
      if (report.invalidSamples.length < 20) {
        report.invalidSamples.push({ id, reason: 'non_string_fields' });
      }
      continue;
    }

    const en = normSpace(rec.english);
    const ta = normSpace(rec.tamil);
    report.englishCharSum += en.length;
    report.tamilCharSum += ta.length;
    report.maxEnglishChars = Math.max(report.maxEnglishChars, en.length);
    report.maxTamilChars = Math.max(report.maxTamilChars, ta.length);

    if (!en && !ta) report.bothEmpty++;
    else if (!en) report.missingEnglish++;
    else if (!ta) report.missingTamil++;
    else report.completePairs++;

    if (hasReplacementChar(en) || hasReplacementChar(ta)) {
      report.unicodeReplacementChar++;
      if (report.unicodeSamples.length < 10) {
        report.unicodeSamples.push({ id, issue: 'replacement_char' });
      }
    }
    if (hasUnpairedSurrogate(en) || hasUnpairedSurrogate(ta)) {
      report.unpairedSurrogate++;
      if (report.unicodeSamples.length < 10) {
        report.unicodeSamples.push({ id, issue: 'unpaired_surrogate' });
      }
    }

    if (en) enCounts.set(en, (enCounts.get(en) || 0) + 1);
    if (en && ta) {
      const key = `${en}|||${ta}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }

  let dupEn = 0;
  for (const c of enCounts.values()) if (c > 1) dupEn += c - 1;
  let dupPair = 0;
  for (const c of pairCounts.values()) if (c > 1) dupPair += c - 1;
  report.duplicateEnglishKeys = dupEn;
  report.duplicateEnglishTamilPairs = dupPair;
  report.uniqueEnglish = enCounts.size;
  report.uniquePairs = pairCounts.size;
  report.avgEnglishChars = records.length ? report.englishCharSum / records.length : 0;
  report.avgTamilChars = records.length ? report.tamilCharSum / records.length : 0;

  return report;
}

function tokenizeEnglish(text) {
  return normSpace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractCapitalizedPhrases(english) {
  const out = [];
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\b/g;
  let m;
  while ((m = re.exec(english))) {
    const phrase = m[1].trim();
    if (phrase.length < 3) continue;
    out.push(phrase);
  }
  return out;
}

function addVariant(map, englishKey, tamil, sourceId) {
  const key = englishKey.toLowerCase();
  if (!map.has(key)) {
    map.set(key, {
      english: englishKey,
      variants: new Map(),
    });
  }
  const entry = map.get(key);
  if (!entry.variants.has(tamil)) {
    entry.variants.set(tamil, { tamil, source_ids: [], count: 0 });
  }
  const v = entry.variants.get(tamil);
  v.count += 1;
  if (v.source_ids.length < 8) v.source_ids.push(sourceId);
}

function finalizeVariantMap(map, minTotalCount = 1) {
  const rows = [];
  for (const entry of map.values()) {
    let total = 0;
    const variants = [];
    for (const v of entry.variants.values()) {
      total += v.count;
      variants.push({
        tamil: v.tamil,
        count: v.count,
        source_ids: v.source_ids,
      });
    }
    if (total < minTotalCount) continue;
    variants.sort((a, b) => b.count - a.count);
    const topVariants = variants.slice(0, 5);
    rows.push({
      english: entry.english,
      total_occurrences: total,
      conflicting: variants.length > 1,
      variant_count_total: variants.length,
      variants: topVariants,
      source_ids: [...new Set(topVariants.flatMap((v) => v.source_ids))].slice(0, 12),
    });
  }
  rows.sort((a, b) => b.total_occurrences - a.total_occurrences);
  return rows;
}

function extractKnowledge(sermonRecords, bibleRecords) {
  console.log('Extracting knowledge from sermon corpus...');

  // Exact short-pair phrase map (english whole field -> tamil)
  const exactPhraseMap = new Map();
  // Term candidates from capitalized phrases / doctrinal seeds on short pairs
  const terminologyMap = new Map();
  const doctrinalMap = new Map();
  const nameMap = new Map();
  const ngramMap = new Map(); // ngram -> {count, source_ids, tamilVariants}

  const bibleEnglishIndex = new Set();
  const bibleNameHits = new Map(); // lower english verse snippet words that look like names

  for (let i = 0; i < bibleRecords.length; i++) {
    const en = normSpace(bibleRecords[i].english);
    const ta = normSpace(bibleRecords[i].tamil);
    const id = padId('bible_verse', i + 1);
    if (!en || !ta) continue;
    bibleEnglishIndex.add(en.toLowerCase());
    for (const phrase of extractCapitalizedPhrases(en)) {
      const k = phrase.toLowerCase();
      if (!bibleNameHits.has(k)) bibleNameHits.set(k, { english: phrase, source_ids: [], count: 0 });
      const hit = bibleNameHits.get(k);
      hit.count += 1;
      if (hit.source_ids.length < 15) hit.source_ids.push(id);
    }
  }

  const seedSet = new Set(DOCTRINAL_SEEDS.map((s) => s.trim().toLowerCase()).filter(Boolean));

  // First pass: exact short pairs + counting
  for (let i = 0; i < sermonRecords.length; i++) {
    const rec = sermonRecords[i];
    if (!rec || typeof rec.english !== 'string' || typeof rec.tamil !== 'string') continue;
    const en = normSpace(rec.english);
    const ta = normSpace(rec.tamil);
    if (!en || !ta) continue;
    const id = padId('sermon_pair', i + 1);

    const enLower = en.toLowerCase();

    // Exact phrase memory for short/medium units (terminology evidence)
    if (en.length <= 220) {
      addVariant(exactPhraseMap, en, ta, id);
    }

    // Content-word unigrams/bigrams from SHORT pairs only (safe Tamil = full field)
    if (en.length <= 90) {
      const toks = tokenizeEnglish(en).filter((t) => !STOP.has(t) && t.length > 2);
      if (toks.length >= 1 && toks.length <= 8) {
        addVariant(terminologyMap, en, ta, id);
        if (toks.length <= 3) {
          addVariant(terminologyMap, toks.join(' '), ta, id);
        }
      }
    }

    // Capitalized multi-word / name-like phrases with Tamil only on near-exact short EN fields
    for (const phrase of extractCapitalizedPhrases(en)) {
      const pLower = phrase.toLowerCase();
      if (enLower === pLower) {
        addVariant(nameMap, phrase, ta, id);
      } else if (en.length <= 70 && enLower.includes(pLower) && en.split(/\s+/).length <= phrase.split(/\s+/).length + 3) {
        addVariant(nameMap, phrase, ta, id);
      }
    }

    // Doctrinal seeds: Tamil only from very short EN fields (avoid whole-paragraph false glosses)
    for (const seed of seedSet) {
      if (!enLower.includes(seed)) continue;
      const escaped = seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const wordRe = new RegExp(`\\b${escaped}\\b`, 'i');
      if (!wordRe.test(en)) continue;
      const tokCount = en.split(/\s+/).length;
      if (enLower === seed || (en.length <= 64 && tokCount <= 8)) {
        addVariant(doctrinalMap, seed, ta, id);
      }
    }

    // 3-6 word ngrams for repeated phrases
    const words = tokenizeEnglish(en);
    for (let n = 3; n <= 6; n++) {
      for (let w = 0; w + n <= words.length; w++) {
        const gramWords = words.slice(w, w + n);
        if (gramWords.filter((x) => !STOP.has(x)).length === 0) continue;
        const gram = gramWords.join(' ');
        if (gram.length < 10) continue;
        if (!ngramMap.has(gram)) ngramMap.set(gram, { count: 0, source_ids: [], exactTamil: new Map() });
        const g = ngramMap.get(gram);
        g.count += 1;
        if (g.source_ids.length < 20) g.source_ids.push(id);
        // Exact or near-exact full-field alignment => Tamil is evidenced
        if (enLower === gram || (en.length <= 140 && enLower.startsWith(gram) && en.split(/\s+/).length <= n + 2)) {
          if (!g.exactTamil.has(ta)) g.exactTamil.set(ta, { count: 0, source_ids: [] });
          const tv = g.exactTamil.get(ta);
          tv.count += 1;
          if (tv.source_ids.length < 15) tv.source_ids.push(id);
        }
      }
    }
  }

  // Terminology: exact short pairs + short-field maps
  const terminology = [];
  const seenTerm = new Set();
  for (const row of [
    ...finalizeVariantMap(terminologyMap, 2),
    ...finalizeVariantMap(exactPhraseMap, 2),
  ]) {
    if (row.english.length > 200) continue;
    const tokens = tokenizeEnglish(row.english);
    if (tokens.length === 0 || tokens.length > 20) continue;
    if (tokens.length === 1 && STOP.has(tokens[0])) continue;
    const key = row.english.toLowerCase();
    if (seenTerm.has(key)) continue;
    seenTerm.add(key);
    terminology.push({
      english: row.english,
      total_occurrences: row.total_occurrences,
      conflicting: row.conflicting,
      variants: row.variants,
      source_ids: row.source_ids,
      type: tokens.length <= 3 ? 'short_term_or_phrase' : 'short_pair_phrase',
    });
  }
  terminology.sort((a, b) => b.total_occurrences - a.total_occurrences);

  // Biblical names: sermon-evidenced only (with Bible intersection flag). Avoid empty-variant bloat.
  const biblicalNames = [];
  const nameRows = finalizeVariantMap(nameMap, 2);
  for (const row of nameRows) {
    if (!row.variants.length) continue;
    const inBible = bibleNameHits.has(row.english.toLowerCase());
    biblicalNames.push({
      english: row.english,
      found_in_bible_corpus: inBible,
      bible_source_ids: inBible ? bibleNameHits.get(row.english.toLowerCase()).source_ids : [],
      conflicting: row.conflicting,
      variants: row.variants,
      source_ids: row.source_ids,
      total_occurrences: row.total_occurrences,
    });
  }
  // Add high-frequency Bible names that also appear in sermon name map keys already handled;
  // for Bible-only frequent names, attach Tamil from Bible verses where english is short and equals/contains name as whole verse is rare — use first bible verse source only as reference id list without fake Tamil
  let bibleOnlyAdded = 0;
  for (const [k, hit] of bibleNameHits.entries()) {
    if (bibleOnlyAdded >= 200) break;
    if (hit.count < 8) continue;
    if (biblicalNames.some((b) => b.english.toLowerCase() === k)) continue;
    // Find a bible record whose english equals the name (rare) for Tamil; else skip Tamil
    let variants = [];
    for (let bi = 0; bi < bibleRecords.length && variants.length === 0; bi++) {
      const ben = normSpace(bibleRecords[bi].english);
      const bta = normSpace(bibleRecords[bi].tamil);
      if (ben.toLowerCase() === k && bta) {
        variants = [{ tamil: bta, count: 1, source_ids: [padId('bible_verse', bi + 1)] }];
      }
    }
    if (!variants.length) continue; // do not add empty-variant bloat
    biblicalNames.push({
      english: hit.english,
      found_in_bible_corpus: true,
      bible_source_ids: hit.source_ids,
      conflicting: false,
      variants,
      source_ids: hit.source_ids,
      total_occurrences: hit.count,
    });
    bibleOnlyAdded++;
  }

  const doctrinal = finalizeVariantMap(doctrinalMap, 1).map((row) => ({
    english: row.english,
    total_occurrences: row.total_occurrences,
    conflicting: row.conflicting,
    variants: row.variants,
    source_ids: row.source_ids,
  }));

  // Repeated phrases: require evidenced Tamil alignment
  const repeated = [];
  for (const [gram, g] of ngramMap.entries()) {
    if (g.count < 5) continue;
    const variants = [];
    for (const [ta, info] of g.exactTamil.entries()) {
      variants.push({ tamil: ta, count: info.count, source_ids: info.source_ids });
    }
    variants.sort((a, b) => b.count - a.count);
    if (variants.length === 0) continue;
    repeated.push({
      english: gram,
      frequency: g.count,
      conflicting: variants.length > 1,
      variants,
      source_ids: g.source_ids,
      has_exact_tamil_alignment: true,
    });
  }
  repeated.sort((a, b) => b.frequency - a.frequency);

  return {
    terminology,
    biblicalNames,
    doctrinal,
    repeated,
    exactPhraseCount: exactPhraseMap.size,
  };
}

function pickApprovedExamples(sermonRecords, maxExamples = 120) {
  const complete = [];
  for (let i = 0; i < sermonRecords.length; i++) {
    const rec = sermonRecords[i];
    if (!rec || typeof rec.english !== 'string' || typeof rec.tamil !== 'string') continue;
    const en = normSpace(rec.english);
    const ta = normSpace(rec.tamil);
    if (!en || !ta) continue;
    complete.push({
      source_id: padId('sermon_pair', i + 1),
      english: en,
      tamil: ta,
      en_len: en.length,
    });
  }
  const short = complete.filter((p) => p.en_len < 120);
  const medium = complete.filter((p) => p.en_len >= 120 && p.en_len < 400);
  const long = complete.filter((p) => p.en_len >= 400 && p.en_len < 900);

  function sample(arr, n) {
    if (arr.length <= n) return arr.slice();
    const out = [];
    const step = Math.floor(arr.length / n);
    for (let i = 0; i < n; i++) out.push(arr[Math.min(i * step, arr.length - 1)]);
    return out;
  }

  const nShort = Math.floor(maxExamples * 0.35);
  const nMed = Math.floor(maxExamples * 0.45);
  const nLong = maxExamples - nShort - nMed;
  return [
    ...sample(short, nShort).map((p) => ({ ...p, band: 'short' })),
    ...sample(medium, nMed).map((p) => ({ ...p, band: 'medium' })),
    ...sample(long, nLong).map((p) => ({ ...p, band: 'long' })),
  ];
}

function buildStyleGuide({ sermonInspect, bibleInspect, extraction, examples, packageTokens }) {
  return `# Translation Style Guide (Data-Derived)

Generated locally in Phase 1. Rules below are derived from approved corpora only. Do not invent terminology.

## Corpora

| Corpus | Records | Complete pairs |
| --- | ---: | ---: |
| Sermon parallel_dataset.json | ${sermonInspect.totalRecords} | ${sermonInspect.completePairs} |
| Bible bible_parallel_dataset.json | ${bibleInspect.totalRecords} | ${bibleInspect.completePairs} |

## Authority

- Sermon corpus is the authority for Branham preaching style and sermon terminology.
- Bible corpus is the authority for exact Bible quotations only.
- Never translate the Bible again; retrieve approved verse pairs via FTS when a sermon cites Scripture.
- Limit Bible retrieval to **5–10** relevant pairs per translation request.
- Do not substitute Bible wording for Branham's own words when the source is not a quotation.

## Observed lengths (sermon pairs)

- Avg English chars: ${sermonInspect.avgEnglishChars.toFixed(1)}
- Avg Tamil chars: ${sermonInspect.avgTamilChars.toFixed(1)}
- Max English chars: ${sermonInspect.maxEnglishChars}
- Max Tamil chars: ${sermonInspect.maxTamilChars}

## Conflicts

- Terminology entries with multiple Tamil variants must preserve **all** variants with source IDs.
- Do not arbitrarily pick one Tamil form as universally correct.

## Extraction summary

- Terminology entries: ${extraction.terminology.length}
- Biblical name entries: ${extraction.biblicalNames.length}
- Doctrinal glossary entries: ${extraction.doctrinal.length}
- Repeated phrases: ${extraction.repeated.length}
- Approved examples in package: ${examples.length}
- Knowledge package token estimate: ${packageTokens}

## Cadence / formatting observations

- Tamil sides are typically longer than English in character count (avg ratio ${(
    sermonInspect.avgTamilChars / Math.max(1, sermonInspect.avgEnglishChars)
  ).toFixed(2)}).
- Preserve blank-tape / editor markers when present in English (e.g. \`[Blank spot on tape—Ed.]\`) rather than inventing content.
- Keep English and Tamil separately in outputs; do not merge into a single undifferentiated string.

## Hard rules for downstream translation

1. Use only terminology supported by source_ids in the knowledge package.
2. If a term has conflicting Tamil variants, prefer contextual match from examples; otherwise surface alternatives for human review.
3. Retrieve Bible pairs by English quotation / reference match; never dump the full Bible into the prompt.
4. Draft-only until human approval.
`;
}

function assemblePackageText(files) {
  let text = '';
  for (const [name, content] of Object.entries(files)) {
    text += `\n\n===== ${name} =====\n`;
    text += typeof content === 'string' ? content : JSON.stringify(content);
  }
  return text;
}

function trimPackage({ terminology, biblicalNames, doctrinal, repeated, examples }, estimateFn) {
  function compactEntry(e) {
    return {
      ...e,
      variants: (e.variants || []).slice(0, 3).map((v) => ({
        tamil: v.tamil,
        count: v.count,
        source_ids: (v.source_ids || []).slice(0, 5),
      })),
      source_ids: (e.source_ids || []).slice(0, 8),
    };
  }

  let term = terminology.slice(0, 2500).map(compactEntry);
  let names = biblicalNames
    .filter((n) => n.variants && n.variants.length)
    .slice(0, 400)
    .map(compactEntry);
  let doct = doctrinal.slice(0, 80).map(compactEntry);
  let phrases = repeated
    .filter((r) => r.has_exact_tamil_alignment)
    .slice(0, 1200)
    .map(compactEntry);
  let ex = examples.slice();

  function pack() {
    return {
      terminology: term,
      biblical_names: names,
      doctrinal_glossary: doct,
      repeated_phrases: phrases,
      approved_examples: ex,
    };
  }

  let files = pack();
  let tokens = estimateFn(assemblePackageText(files));
  const trimLog = [];

  while (tokens > TOKEN_TARGET_MAX && ex.length > 40) {
    ex = ex.slice(0, Math.floor(ex.length * 0.85));
    files = pack();
    tokens = estimateFn(assemblePackageText(files));
    trimLog.push({ action: 'trim_examples', examples: ex.length, tokens });
  }
  while (tokens > TOKEN_TARGET_MAX && phrases.length > 80) {
    phrases = phrases.slice(0, Math.floor(phrases.length * 0.85));
    files = pack();
    tokens = estimateFn(assemblePackageText(files));
    trimLog.push({ action: 'trim_repeated_phrases', phrases: phrases.length, tokens });
  }
  while (tokens > TOKEN_TARGET_MAX && names.length > 80) {
    names = names.slice(0, Math.floor(names.length * 0.85));
    files = pack();
    tokens = estimateFn(assemblePackageText(files));
    trimLog.push({ action: 'trim_biblical_names', names: names.length, tokens });
  }
  while (tokens > TOKEN_TARGET_MAX && doct.length > 20) {
    doct = doct.slice(0, Math.floor(doct.length * 0.9));
    files = pack();
    tokens = estimateFn(assemblePackageText(files));
    trimLog.push({ action: 'trim_doctrinal', doctrinal: doct.length, tokens });
  }
  while (tokens > TOKEN_TARGET_MAX && term.length > 300) {
    const conflicts = term.filter((t) => t.conflicting);
    const uniques = term.filter((t) => !t.conflicting);
    const keepUnique = uniques.slice(0, Math.floor(uniques.length * 0.9));
    term = [...conflicts, ...keepUnique].sort((a, b) => b.total_occurrences - a.total_occurrences);
    files = pack();
    tokens = estimateFn(assemblePackageText(files));
    trimLog.push({ action: 'trim_terminology_non_conflicts_first', terminology: term.length, tokens });
  }

  // Fill toward minimum with more examples if still under target
  if (tokens < TOKEN_TARGET_MIN && examples.length > ex.length) {
    ex = examples.slice(0, Math.min(examples.length, ex.length + 200));
    files = pack();
    tokens = estimateFn(assemblePackageText(files));
    trimLog.push({ action: 'expand_examples_toward_min', examples: ex.length, tokens });
    while (tokens > TOKEN_TARGET_MAX && ex.length > 40) {
      ex = ex.slice(0, Math.floor(ex.length * 0.9));
      files = pack();
      tokens = estimateFn(assemblePackageText(files));
    }
  }

  return { files: pack(), tokens, trimLog };
}

function buildBibleFts(bibleRecords) {
  console.log('Building Bible FTS5 index...');
  const dbPath = path.join(KNOWLEDGE_DIR, 'bible_fts.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.serialize(() => {
      db.run('PRAGMA journal_mode=WAL');
      db.run(
        `CREATE TABLE verses (
          id TEXT PRIMARY KEY,
          english TEXT NOT NULL,
          tamil TEXT NOT NULL,
          idx INTEGER NOT NULL
        )`
      );
      db.run(`CREATE VIRTUAL TABLE verses_fts USING fts5(
        id UNINDEXED,
        english,
        tamil,
        content='verses',
        content_rowid='rowid'
      )`);

      const stmt = db.prepare('INSERT INTO verses(id, english, tamil, idx) VALUES (?,?,?,?)');
      let written = 0;
      db.run('BEGIN');
      for (let i = 0; i < bibleRecords.length; i++) {
        const en = normSpace(bibleRecords[i].english);
        const ta = normSpace(bibleRecords[i].tamil);
        if (!en || !ta) continue;
        const id = padId('bible_verse', i + 1);
        stmt.run(id, en, ta, i + 1);
        written++;
      }
      db.run('COMMIT', (err) => {
        if (err) return reject(err);
        stmt.finalize();
        db.run(
          `INSERT INTO verses_fts(rowid, id, english, tamil)
           SELECT rowid, id, english, tamil FROM verses`,
          (err2) => {
            if (err2) return reject(err2);
            db.get('SELECT COUNT(*) AS c FROM verses', (err3, row) => {
              if (err3) return reject(err3);
              db.close((err4) => {
                if (err4) return reject(err4);
                resolve({ dbPath, written, tableCount: row.c });
              });
            });
          }
        );
      });
    });
  });
}

async function maybeCountTokensGemini(packageText) {
  if (!APPROVE_TOKEN_COUNT) {
    return {
      status: 'awaiting_manual_approval',
      method: 'local_estimate',
      local_estimate_tokens: estimateTokens(packageText),
      note: 'Set APPROVE_TOKEN_COUNT=1 to run Gemini countTokens on the distilled package only.',
    };
  }
  const { GoogleGenAI } = require('@google/genai');
  const key = fs.readFileSync(path.join(ROOT, 'Key.secure.txt'), 'utf8').trim();
  const ai = new GoogleGenAI({ apiKey: key });
  // Chunk if needed
  const maxChars = 400000;
  let total = 0;
  const chunks = [];
  for (let i = 0; i < packageText.length; i += maxChars) chunks.push(packageText.slice(i, i + maxChars));
  for (const chunk of chunks) {
    const res = await ai.models.countTokens({
      model: 'gemini-3.1-flash-lite',
      contents: chunk,
    });
    total += Number(res.totalTokens || 0);
  }
  return {
    status: 'counted',
    method: 'gemini_countTokens',
    model: 'gemini-3.1-flash-lite',
    totalTokens: total,
    chunks: chunks.length,
  };
}

async function main() {
  ensureDirs();
  console.log('Phase 1 DRY_RUN =', DRY_RUN);
  console.log('Loading immutable source corpora (read-only)...');

  if (!fs.existsSync(SERMON_PATH) || !fs.existsSync(BIBLE_PATH)) {
    throw new Error('Source of truth files missing under dataset/source_of_truth');
  }

  const sermonRecords = JSON.parse(fs.readFileSync(SERMON_PATH, 'utf8'));
  const bibleRecords = JSON.parse(fs.readFileSync(BIBLE_PATH, 'utf8'));
  if (!Array.isArray(sermonRecords) || !Array.isArray(bibleRecords)) {
    throw new Error('Source corpora must be JSON arrays');
  }

  console.log(`Sermon records: ${sermonRecords.length}`);
  console.log(`Bible records: ${bibleRecords.length}`);

  const sermonInspect = inspectCorpus(sermonRecords, 'sermon_pair');
  const bibleInspect = inspectCorpus(bibleRecords, 'bible_verse', 31102);

  const integrity = {
    generatedAt: new Date().toISOString(),
    dry_run: DRY_RUN,
    sources: {
      sermon: path.resolve(SERMON_PATH),
      bible: path.resolve(BIBLE_PATH),
      immutable: true,
    },
    sermon: sermonInspect,
    bible: bibleInspect,
    bothValid:
      sermonInspect.invalidRecords === 0 &&
      bibleInspect.invalidRecords === 0 &&
      bibleInspect.expectedMatch === true,
    biblePreserved31102: bibleInspect.totalRecords === 31102 && bibleInspect.completePairs === 31102,
  };
  writeJson(path.join(REPORTS_DIR, 'corpus-integrity-report.json'), integrity);
  console.log('Wrote corpus-integrity-report.json');

  const extraction = extractKnowledge(sermonRecords, bibleRecords);
  let examples = pickApprovedExamples(sermonRecords, 800);

  const trimmed = trimPackage(
    {
      terminology: extraction.terminology,
      biblicalNames: extraction.biblicalNames,
      doctrinal: extraction.doctrinal,
      repeated: extraction.repeated,
      examples,
    },
    (text) => estimateTokens(text)
  );

  // Write knowledge files
  writeJson(path.join(KNOWLEDGE_DIR, 'terminology.json'), {
    generatedAt: new Date().toISOString(),
    rule: 'Evidence-only from parallel_dataset.json short/frequent pairs. Conflicts preserve all variants.',
    entries: trimmed.files.terminology,
  });
  writeJson(path.join(KNOWLEDGE_DIR, 'biblical_names.json'), {
    generatedAt: new Date().toISOString(),
    rule: 'Names/phrases evidenced in sermon and/or bible corpora with source_ids.',
    entries: trimmed.files.biblical_names,
  });
  writeJson(path.join(KNOWLEDGE_DIR, 'doctrinal_glossary.json'), {
    generatedAt: new Date().toISOString(),
    rule: 'Seed lemmas included only when supported by approved sermon pairs. No invented Tamil.',
    entries: trimmed.files.doctrinal_glossary,
  });
  writeJson(path.join(KNOWLEDGE_DIR, 'repeated_phrases.json'), {
    generatedAt: new Date().toISOString(),
    rule: 'Repeated English n-grams; Tamil variants only when exact full-field alignment exists.',
    entries: trimmed.files.repeated_phrases,
  });
  writeJson(path.join(KNOWLEDGE_DIR, 'approved_examples.json'), {
    generatedAt: new Date().toISOString(),
    rule: 'Stratified sample of approved sermon pairs with source_id provenance.',
    entries: trimmed.files.approved_examples,
  });

  const styleGuide = buildStyleGuide({
    sermonInspect,
    bibleInspect,
    extraction: {
      terminology: trimmed.files.terminology,
      biblicalNames: trimmed.files.biblical_names,
      doctrinal: trimmed.files.doctrinal_glossary,
      repeated: trimmed.files.repeated_phrases,
    },
    examples: trimmed.files.approved_examples,
    packageTokens: trimmed.tokens,
  });
  fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'translation_style_guide.md'), styleGuide);

  const fts = await buildBibleFts(bibleRecords);
  if (fts.tableCount !== 31102) {
    throw new Error(`Bible FTS row count ${fts.tableCount} != 31102`);
  }

  const packageText = assemblePackageText({
    'terminology.json': trimmed.files.terminology,
    'biblical_names.json': trimmed.files.biblical_names,
    'doctrinal_glossary.json': trimmed.files.doctrinal_glossary,
    'repeated_phrases.json': trimmed.files.repeated_phrases,
    'approved_examples.json': trimmed.files.approved_examples,
    'translation_style_guide.md': styleGuide,
  });
  const sectionSizes = {
    terminology: estimateTokens(JSON.stringify(trimmed.files.terminology)),
    biblical_names: estimateTokens(JSON.stringify(trimmed.files.biblical_names)),
    doctrinal_glossary: estimateTokens(JSON.stringify(trimmed.files.doctrinal_glossary)),
    repeated_phrases: estimateTokens(JSON.stringify(trimmed.files.repeated_phrases)),
    approved_examples: estimateTokens(JSON.stringify(trimmed.files.approved_examples)),
    translation_style_guide: estimateTokens(styleGuide),
  };
  const largestSections = Object.entries(sectionSizes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, tokens]) => ({ name, tokens }));

  const tokenReport = {
    generatedAt: new Date().toISOString(),
    dry_run: DRY_RUN,
    package_local_estimate_tokens: estimateTokens(packageText),
    target_min: TOKEN_TARGET_MIN,
    target_max: TOKEN_TARGET_MAX,
    within_target:
      estimateTokens(packageText) >= TOKEN_TARGET_MIN &&
      estimateTokens(packageText) <= TOKEN_TARGET_MAX,
    section_sizes: sectionSizes,
    largest_sections: largestSections,
    full_corpus_not_counted_here: {
      note: 'Full parallel_dataset / bible dump intentionally not token-counted in Phase 1 without approval.',
      prior_measured_approx: {
        sermon_clean_ref_tokens: 18512727,
        bible_tokens: 2801872,
      },
    },
    gemini: await maybeCountTokensGemini(packageText),
  };
  // prefer trimmed.tokens consistency
  tokenReport.package_local_estimate_tokens = trimmed.tokens;
  tokenReport.within_target =
    trimmed.tokens >= TOKEN_TARGET_MIN && trimmed.tokens <= TOKEN_TARGET_MAX;
  writeJson(path.join(REPORTS_DIR, 'corpus-token-report.json'), tokenReport);

  const conflictTerminology = trimmed.files.terminology.filter((t) => t.conflicting).length;
  const conflictDoctrinal = trimmed.files.doctrinal_glossary.filter((t) => t.conflicting).length;
  const conflictPhrases = trimmed.files.repeated_phrases.filter((t) => t.conflicting).length;

  const extractionReport = {
    generatedAt: new Date().toISOString(),
    sermon_records_inspected: sermonRecords.length,
    terminology_entries: trimmed.files.terminology.length,
    terminology_conflicts: conflictTerminology,
    biblical_name_entries: trimmed.files.biblical_names.length,
    doctrinal_entries: trimmed.files.doctrinal_glossary.length,
    doctrinal_conflicts: conflictDoctrinal,
    repeated_phrase_entries: trimmed.files.repeated_phrases.length,
    repeated_phrase_conflicts: conflictPhrases,
    approved_examples: trimmed.files.approved_examples.length,
    top_conflicting_terminology: trimmed.files.terminology
      .filter((t) => t.conflicting)
      .slice(0, 30)
      .map((t) => ({
        english: t.english,
        variant_count: t.variants.length,
        total_occurrences: t.total_occurrences,
        variants: t.variants.map((v) => ({ tamil: v.tamil, count: v.count })),
      })),
    trim_log: trimmed.trimLog,
  };
  writeJson(path.join(REPORTS_DIR, 'terminology-extraction-report.json'), extractionReport);

  const manifest = {
    generatedAt: new Date().toISOString(),
    dry_run: DRY_RUN,
    budget: {
      available_inr: 2500,
      ceiling_inr: 2000,
      reserve_inr: 500,
      phase1_api_spend: APPROVE_TOKEN_COUNT ? 'countTokens_only_if_approved' : 0,
    },
    sources: {
      sermon_parallel: path.resolve(SERMON_PATH),
      bible_parallel: path.resolve(BIBLE_PATH),
      immutable: true,
    },
    id_scheme: {
      sermon: 'sermon_pair_###### (1-based array index)',
      bible: 'bible_verse_###### (1-based array index, Genesis→Revelation order)',
    },
    counts: {
      sermon_records: sermonRecords.length,
      bible_records: bibleRecords.length,
      terminology: trimmed.files.terminology.length,
      biblical_names: trimmed.files.biblical_names.length,
      doctrinal_glossary: trimmed.files.doctrinal_glossary.length,
      repeated_phrases: trimmed.files.repeated_phrases.length,
      approved_examples: trimmed.files.approved_examples.length,
    },
    bible_fts: {
      path: path.resolve(fts.dbPath),
      rows: fts.tableCount,
      retrieval_policy: 'top_5_to_10_relevant_pairs_per_request',
      never_dump_full_bible_into_prompt_or_cache: true,
    },
    package_token_estimate: trimmed.tokens,
    section_sizes: sectionSizes,
  };
  writeJson(path.join(KNOWLEDGE_DIR, 'reference_manifest.json'), manifest);

  const packageReport = {
    generatedAt: new Date().toISOString(),
    final_token_estimate: trimmed.tokens,
    target_range: [TOKEN_TARGET_MIN, TOKEN_TARGET_MAX],
    within_target: trimmed.tokens >= TOKEN_TARGET_MIN && trimmed.tokens <= TOKEN_TARGET_MAX,
    largest_sections: largestSections,
    trim_log: trimmed.trimLog,
    files: [
      'knowledge/terminology.json',
      'knowledge/biblical_names.json',
      'knowledge/doctrinal_glossary.json',
      'knowledge/repeated_phrases.json',
      'knowledge/translation_style_guide.md',
      'knowledge/approved_examples.json',
      'knowledge/reference_manifest.json',
      'knowledge/bible_fts.sqlite',
    ],
    notes: [
      'Source of truth JSON files were not modified.',
      'Bible FTS preserves all 31102 pairs for retrieval; not included in prompt package token total.',
      'Gemini countTokens awaiting manual approval unless APPROVE_TOKEN_COUNT=1.',
    ],
  };
  writeJson(path.join(REPORTS_DIR, 'knowledge-package-report.json'), packageReport);

  const completion = `# Phase 1 Completion Report

Generated: ${new Date().toISOString()}

## Validity

| Check | Result |
| --- | --- |
| Both source datasets valid (no invalid records) | **${integrity.bothValid}** |
| Bible 31,102 preserved in FTS | **${fts.tableCount === 31102}** (${fts.tableCount}) |
| Sermon records inspected | **${sermonRecords.length}** |
| Sermon complete pairs | **${sermonInspect.completePairs}** |
| Bible complete pairs | **${bibleInspect.completePairs}** |

## Extraction

| Item | Count |
| --- | ---: |
| Terminology entries | ${trimmed.files.terminology.length} |
| Terminology conflicts | ${conflictTerminology} |
| Biblical name entries | ${trimmed.files.biblical_names.length} |
| Doctrinal glossary entries | ${trimmed.files.doctrinal_glossary.length} |
| Doctrinal conflicts | ${conflictDoctrinal} |
| Repeated phrases | ${trimmed.files.repeated_phrases.length} |
| Approved examples | ${trimmed.files.approved_examples.length} |

## Knowledge package size

- Local token estimate: **${trimmed.tokens.toLocaleString()}**
- Target: ${TOKEN_TARGET_MIN.toLocaleString()}–${TOKEN_TARGET_MAX.toLocaleString()}
- Within target: **${packageReport.within_target}**
- Gemini countTokens: **${tokenReport.gemini.status}**

Largest sections:
${largestSections.map((s) => `- ${s.name}: ~${s.tokens.toLocaleString()} tokens`).join('\n')}

## Integrity highlights

- Missing English (sermon): ${sermonInspect.missingEnglish}
- Missing Tamil (sermon): ${sermonInspect.missingTamil}
- Duplicate EN–TA pairs (sermon): ${sermonInspect.duplicateEnglishTamilPairs}
- Unicode replacement chars (sermon): ${sermonInspect.unicodeReplacementChar}

## Remaining issues / recommendations

1. Local token estimate is heuristic until you approve \`APPROVE_TOKEN_COUNT=1\`.
2. Single-word terminology alignment inside long paragraphs is intentionally conservative (evidence-only; no invented Tamil glosses).
3. Review top conflicting terminology in \`reports/terminology-extraction-report.json\` before Phase 2.
4. Use \`knowledge/bible_fts.sqlite\` at request time for 5–10 verse retrieval — do not cache the full Bible.
5. **Stop here.** Do not authorize paid Flash-Lite corpus analysis or Pro translation until these reports are reviewed.

## Budget reminder

- Available: ₹2,500 | Ceiling: ₹2,000 | Reserve: ₹500
- Phase 1 API spend: **${APPROVE_TOKEN_COUNT ? 'countTokens only' : '₹0'}**
`;

  fs.writeFileSync(path.join(REPORTS_DIR, 'phase1-completion-report.md'), completion);
  console.log('Phase 1 complete. Reports in reports/, knowledge in knowledge/.');
  console.log(completion);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
