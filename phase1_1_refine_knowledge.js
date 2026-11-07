/**
 * Phase 1.1 – Refine and Verify Translation Knowledge Package
 * DRY-RUN. No GCS / Batch / generation / countTokens.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = __dirname;
const KNOWLEDGE = path.join(ROOT, 'knowledge');
const LIBRARY = path.join(KNOWLEDGE, 'library');
const REPORTS = path.join(ROOT, 'reports');
const SOURCE_DIR = path.join(ROOT, '..', 'dataset', 'source_of_truth');
const SERMON_PATH = path.join(SOURCE_DIR, 'parallel_dataset.json');
const BIBLE_PATH = path.join(SOURCE_DIR, 'bible_parallel_dataset.json');
const BIBLE_EN_DB = 'd:/Freelancing/BRD-David/server/data/bible_en.sqlite';
const BIBLE_TA_DB = 'd:/Freelancing/BRD-David/server/data/bible-new.sqlite';

const TOKEN_MIN = 20000;
const TOKEN_MAX = 40000;
const DRY_RUN = true;

const BIBLE_BOOKS = [
  ['genesis', 'ஆதியாகமம்'],
  ['exodus', 'யாத்திராகமம்'],
  ['leviticus', 'லேவியராகமம்'],
  ['numbers', 'எண்ணாகமம்'],
  ['deuteronomy', 'உபாகமம்'],
  ['joshua', 'யோசுவா'],
  ['judges', 'நியாயாதிபதிகள்'],
  ['ruth', 'ரூத்'],
  ['samuel', 'சாமுவேல்'],
  ['kings', 'ராஜாக்கள்'],
  ['chronicles', 'நாளாகமம்'],
  ['ezra', 'எஸ்றா'],
  ['nehemiah', 'நெகேமியா'],
  ['esther', 'எஸ்தர்'],
  ['job', 'யோபு'],
  ['psalm', 'சங்கீதம்'],
  ['psalms', 'சங்கீதங்கள்'],
  ['proverbs', 'நீதிமொழிகள்'],
  ['ecclesiastes', 'பிரசங்கி'],
  ['isaiah', 'ஏசாயா'],
  ['jeremiah', 'எரேமியா'],
  ['lamentations', 'புலம்பல்'],
  ['ezekiel', 'எசேக்கியேல்'],
  ['daniel', 'தானியேல்'],
  ['hosea', 'ஓசியா'],
  ['joel', 'யோவேல்'],
  ['amos', 'ஆமோஸ்'],
  ['obadiah', 'ஒபதியா'],
  ['jonah', 'யோனா'],
  ['micah', 'மீகா'],
  ['nahum', 'நாகூம்'],
  ['habakkuk', 'ஆபகூக்'],
  ['zephaniah', 'செப்பனியா'],
  ['haggai', 'ஆகாய்'],
  ['zechariah', 'சகரியா'],
  ['malachi', 'மல்கியா'],
  ['matthew', 'மத்தேயு'],
  ['mark', 'மாற்கு'],
  ['luke', 'லூக்கா'],
  ['john', 'யோவான்'],
  ['acts', 'அப்போஸ்தலர்'],
  ['romans', 'ரோமர்'],
  ['corinthians', 'கொரிந்தியர்'],
  ['galatians', 'கலாத்தியர்'],
  ['ephesians', 'எபேசியர்'],
  ['philippians', 'பிலிப்பியர்'],
  ['colossians', 'கொலோசெயர்'],
  ['thessalonians', 'தெசலோனிக்கேயர்'],
  ['timothy', 'தீமோத்தேயு'],
  ['titus', 'தீத்து'],
  ['philemon', 'பிலேமோன்'],
  ['hebrews', 'எபிரெயர்'],
  ['james', 'யாக்கோபு'],
  ['peter', 'பேதுரு'],
  ['jude', 'யூதா'],
  ['revelation', 'வெளிப்படுத்தின விசேஷம்'],
  ['st john', 'யோவான்'],
  ['st. john', 'யோவான்'],
];

const NAME_SEEDS = [
  'jesus', 'christ', 'jehovah', 'elohim', 'messiah', 'abraham', 'isaac', 'jacob',
  'moses', 'elijah', 'elisha', 'paul', 'peter', 'john', 'mary', 'joseph',
  'adam', 'eve', 'noah', 'david', 'solomon', 'isaiah', 'jeremiah', 'daniel',
  'branham', 'jeffersonville', 'israel', 'jerusalem', 'calvary', 'golgotha',
  'nazareth', 'bethlehem', 'egypt', 'canaan', 'zion',
];

const DOCTRINAL_SEEDS = [
  'bride', 'bridegroom', 'word', 'seal', 'seals', 'rapture', 'tabernacle', 'elect',
  'justification', 'sanctification', 'baptism', 'holy ghost', 'holy spirit',
  'pentecost', 'message', 'prophet', 'lamb', 'blood', 'atonement', 'covenant',
  'new birth', 'born again', 'serpent seed', "serpent's seed", 'capstone',
  'seven seals', 'seven thunders', 'church ages', 'pillar of fire', 'shekinah',
  'faith', 'grace', 'millennium', 'tribulation', 'antichrist',
];

function ensure(d) {
  fs.mkdirSync(d, { recursive: true });
}
function writeJson(p, o) {
  fs.writeFileSync(p, JSON.stringify(o, null, 2));
}
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.2);
}
function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function isShortTermEn(s) {
  const t = norm(s);
  const words = t.split(/\s+/);
  return t.length > 0 && t.length <= 48 && words.length <= 6;
}
function isShortTermTa(s) {
  const t = norm(s);
  return t.length > 0 && t.length <= 40;
}
function isParagraph(s) {
  const t = norm(s);
  return t.length > 90 || t.split(/\s+/).length > 16;
}

function bibleBookHit(english) {
  const low = english.toLowerCase();
  for (const [en, ta] of BIBLE_BOOKS) {
    if (new RegExp(`\\b${en.replace('.', '\\.')}\\b`, 'i').test(low)) return { en, ta };
  }
  return null;
}

function classifyEntry(english, variants) {
  const en = norm(english);
  const shortVariants = variants.filter((v) => isShortTermTa(v.tamil));
  const paraVariants = variants.filter((v) => isParagraph(v.tamil));
  const book = bibleBookHit(en);
  const enLow = en.toLowerCase();
  const isName = NAME_SEEDS.some((n) => enLow === n || enLow.includes(n));
  const isDoctrinal = DOCTRINAL_SEEDS.some((n) => enLow === n || enLow === n.replace("'s", ''));

  if (book && (shortVariants.length || /:\s*\d|\d+:\d+/.test(en))) {
    return {
      bucket: 'biblical_book_or_name_reference',
      confidence: shortVariants.length ? 'medium' : 'low',
      reason: 'English looks like a Bible book/reference; keep short Tamil book-name forms only',
    };
  }
  if (isName && shortVariants.length) {
    return {
      bucket: 'biblical_book_or_name_reference',
      confidence: shortVariants.length === 1 ? 'high' : 'medium',
      reason: 'Proper name with short Tamil equivalent(s)',
    };
  }
  if (paraVariants.length && !shortVariants.length) {
    return {
      bucket: 'ambiguous_mappings',
      confidence: 'rejected_as_term',
      reason: 'Tamil side is a full paragraph, not a terminology gloss',
    };
  }
  if (shortVariants.length > 1) {
    return {
      bucket: isDoctrinal ? 'context_dependent_translations' : 'context_dependent_translations',
      confidence: 'medium',
      reason: 'Multiple short approved Tamil forms; keep all, do not pick a winner',
    };
  }
  if (shortVariants.length === 1 && isShortTermEn(en)) {
    return {
      bucket: isDoctrinal ? 'verified_terminology_mappings' : 'verified_terminology_mappings',
      confidence: shortVariants[0].count >= 3 ? 'high' : 'medium',
      reason: 'Single short Tamil equivalent evidenced in approved pairs',
    };
  }
  if (isShortTermEn(en) && variants.some((v) => !isParagraph(v.tamil))) {
    return {
      bucket: 'phrase_level_examples',
      confidence: 'medium',
      reason: 'Short English unit with phrase-length Tamil; not a single-term gloss',
    };
  }
  return {
    bucket: 'ambiguous_mappings',
    confidence: 'low',
    reason: 'Insufficient short-form evidence to treat as terminology',
  };
}

function compactVariants(variants) {
  return variants
    .filter((v) => !isParagraph(v.tamil))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((v) => ({
      tamil: v.tamil,
      count: v.count,
      source_ids: (v.source_ids || []).slice(0, 6),
    }));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function scoreExample(ex) {
  const en = (ex.english || '').toLowerCase();
  let score = 0;
  const tags = [];
  if (DOCTRINAL_SEEDS.some((s) => en.includes(s))) {
    score += 8;
    tags.push('doctrinal');
  }
  if (bibleBookHit(en) || /\b\d+:\d+\b/.test(en) || /scripture|bible|verse/.test(en)) {
    score += 8;
    tags.push('bible_quotation');
  }
  if (/god bless|amen|is that right|you see|now, friends|hallelujah/.test(en)) {
    score += 5;
    tags.push('repeated_preaching');
  }
  if (/"|said,|i said|he said/.test(en)) {
    score += 4;
    tags.push('conversational');
  }
  if (/\blike\b|\bas a\b|story|illustration/.test(en)) {
    score += 3;
    tags.push('illustration');
  }
  if ((ex.en_len || en.length) < 90) {
    score += 2;
    tags.push('short_pattern');
  } else if ((ex.en_len || en.length) > 350) {
    score += 3;
    tags.push('long_pattern');
  } else {
    score += 2;
    tags.push('sentence_construction');
  }
  return { score, tags };
}

function selectCompactExamples(library) {
  const scored = library.map((ex) => ({ ...ex, ...scoreExample(ex) }));
  scored.sort((a, b) => b.score - a.score);
  const wanted = [
    'doctrinal',
    'bible_quotation',
    'repeated_preaching',
    'conversational',
    'illustration',
    'sentence_construction',
    'short_pattern',
    'long_pattern',
  ];
  const picked = [];
  const used = new Set();
  for (const tag of wanted) {
    const cand = scored.find((e) => e.tags.includes(tag) && !used.has(e.source_id));
    if (cand) {
      used.add(cand.source_id);
      picked.push(cand);
    }
  }
  for (const e of scored) {
    if (picked.length >= 36) break;
    if (used.has(e.source_id)) continue;
    used.add(e.source_id);
    picked.push(e);
  }
  return picked.slice(0, 36);
}

async function rebuildBibleFts(bibleRecords) {
  console.log('Rebuilding Bible FTS5 with book/chapter/verse metadata...');
  const enDb = new sqlite3.Database(BIBLE_EN_DB, sqlite3.OPEN_READONLY);
  const taDb = new sqlite3.Database(BIBLE_TA_DB, sqlite3.OPEN_READONLY);
  const enRows = await all(
    enDb,
    'SELECT Book, Chapter, Versecount, verse, title FROM bible ORDER BY Book, Chapter, Versecount'
  );
  const titles = await all(enDb, 'SELECT id, title FROM titles');
  const taTitles = await all(taDb, 'SELECT id, title FROM titles');
  await new Promise((res) => enDb.close(() => res()));
  await new Promise((res) => taDb.close(() => res()));

  const enTitle = new Map(titles.map((t) => [t.id, t.title]));
  const taTitle = new Map(taTitles.map((t) => [t.id, t.title]));

  const dbPath = path.join(KNOWLEDGE, 'bible_fts.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new sqlite3.Database(dbPath);
  await run(db, 'PRAGMA journal_mode=WAL');
  await run(
    db,
    `CREATE TABLE verses (
      id TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      book INTEGER,
      chapter INTEGER,
      verse INTEGER,
      book_en TEXT,
      book_ta TEXT,
      ref TEXT,
      english TEXT NOT NULL,
      tamil TEXT NOT NULL
    )`
  );
  await run(
    db,
    `CREATE VIRTUAL TABLE verses_fts USING fts5(
      id UNINDEXED,
      ref,
      book_en,
      english,
      tamil,
      content='verses',
      content_rowid='rowid'
    )`
  );

  const stmt = db.prepare(
    `INSERT INTO verses(id, idx, book, chapter, verse, book_en, book_ta, ref, english, tamil)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  if (enRows.length !== bibleRecords.length) {
    console.warn(
      `Warning: bible sqlite rows ${enRows.length} vs json ${bibleRecords.length}; joining by index`
    );
  }
  const n = Math.min(enRows.length, bibleRecords.length);
  await run(db, 'BEGIN');
  for (let i = 0; i < n; i++) {
    const meta = enRows[i];
    const rec = bibleRecords[i];
    const id = `bible_verse_${String(i + 1).padStart(6, '0')}`;
    const bookEn = meta.title || enTitle.get(Number(meta.Book) + 1) || '';
    const bookTa = taTitle.get(Number(meta.Book) + 1) || '';
    const ref = `${bookEn} ${meta.Chapter}:${meta.Versecount}`;
    stmt.run(
      id,
      i + 1,
      meta.Book,
      meta.Chapter,
      meta.Versecount,
      bookEn,
      bookTa,
      ref,
      norm(rec.english),
      norm(rec.tamil)
    );
  }
  await new Promise((resolve, reject) => {
    db.run('COMMIT', (err) => (err ? reject(err) : resolve()));
  });
  await new Promise((resolve, reject) => stmt.finalize((err) => (err ? reject(err) : resolve())));
  await run(
    db,
    `INSERT INTO verses_fts(rowid, id, ref, book_en, english, tamil)
     SELECT rowid, id, ref, book_en, english, tamil FROM verses`
  );
  const countRow = await all(db, 'SELECT COUNT(*) AS c FROM verses');
  await new Promise((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));
  return { dbPath, rows: countRow[0].c };
}

function retrieveDemoSql() {
  return `
-- Exact-ish quotation / partial verse:
SELECT v.id, v.ref, v.english, v.tamil
FROM verses_fts f
JOIN verses v ON v.rowid = f.rowid
WHERE verses_fts MATCH ?
LIMIT 10;

-- Book + chapter reference (e.g. John 3):
SELECT id, ref, english, tamil FROM verses
WHERE book_en LIKE 'John%' AND chapter = 3
ORDER BY verse
LIMIT 10;
`.trim();
}

async function main() {
  ensure(KNOWLEDGE);
  ensure(LIBRARY);
  ensure(REPORTS);

  const prevExamplesFile = JSON.parse(
    fs.readFileSync(path.join(KNOWLEDGE, 'approved_examples.json'), 'utf8')
  );
  const actualLibraryCount = (prevExamplesFile.entries || []).length;
  const prevPkg = JSON.parse(fs.readFileSync(path.join(REPORTS, 'knowledge-package-report.json'), 'utf8'));
  const prevTok = JSON.parse(fs.readFileSync(path.join(REPORTS, 'corpus-token-report.json'), 'utf8'));
  const prevExt = JSON.parse(
    fs.readFileSync(path.join(REPORTS, 'terminology-extraction-report.json'), 'utf8')
  );

  const discrepancy = {
    reported_in_completion_and_extraction: prevExt.approved_examples,
    actual_approved_examples_json_entries: actualLibraryCount,
    trim_log_intermediate_counts: (prevPkg.trim_log || []).map((t) => ({
      action: t.action,
      examples: t.examples,
      tokens: t.tokens,
    })),
    explanation:
      'Trim-log counts (680, 578, 778) were intermediate loop states inside trimPackage(). After the last expand to 778, a subsequent while (tokens > 180k) trimmed examples again, landing at 630 written to approved_examples.json. Reports listed 630 (final file) while trim_log kept pre-final steps. Phase 1.1 treats 630 as the actual library size.',
  };

  console.log('Loading source corpora (read-only) for classification context...');
  const sermonRecords = JSON.parse(fs.readFileSync(SERMON_PATH, 'utf8'));
  const bibleRecords = JSON.parse(fs.readFileSync(BIBLE_PATH, 'utf8'));

  const prevTerm = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE, 'terminology.json'), 'utf8'));
  const prevDoc = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE, 'doctrinal_glossary.json'), 'utf8'));
  const prevNames = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE, 'biblical_names.json'), 'utf8'));
  const prevPhrases = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE, 'repeated_phrases.json'), 'utf8'));

  const review = [];
  function reviewList(entries, origin) {
    for (const e of entries) {
      const cls = classifyEntry(e.english, e.variants || []);
      const shortVars = compactVariants(e.variants || []);
      review.push({
        origin,
        english: e.english,
        classification: cls.bucket,
        confidence: cls.confidence,
        reason: cls.reason,
        total_occurrences: e.total_occurrences || e.frequency || 0,
        variant_count: (e.variants || []).length,
        short_tamil_variants: shortVars,
        source_ids: (e.source_ids || []).slice(0, 8),
        discarded_paragraph_variants: (e.variants || []).filter((v) => isParagraph(v.tamil)).length,
      });
    }
  }
  reviewList(prevTerm.entries || [], 'terminology.json');
  reviewList(prevDoc.entries || [], 'doctrinal_glossary.json');
  reviewList(prevNames.entries || [], 'biblical_names.json');
  reviewList(prevPhrases.entries || [], 'repeated_phrases.json');

  const buckets = {
    verified_terminology_mappings: [],
    context_dependent_translations: [],
    biblical_book_or_name_references: [],
    phrase_level_examples: [],
    ambiguous_mappings: [],
  };
  for (const r of review) {
    const key =
      r.classification === 'verified_terminology_mappings'
        ? 'verified_terminology_mappings'
        : r.classification === 'context_dependent_translations'
          ? 'context_dependent_translations'
          : r.classification === 'biblical_book_or_name_reference'
            ? 'biblical_book_or_name_references'
            : r.classification === 'phrase_level_examples'
              ? 'phrase_level_examples'
              : 'ambiguous_mappings';
    buckets[key].push(r);
  }

  function toKnowledgeEntries(rows, extra = {}) {
    return rows
      .filter((r) => r.short_tamil_variants.length > 0 || extra.allowEmpty)
      .map((r) => ({
        english: r.english,
        tamil_approved_equivalents: r.short_tamil_variants,
        source_ids: r.source_ids,
        occurrence_count: r.total_occurrences,
        context: r.reason,
        confidence: r.confidence,
        evidence_classification: r.classification,
        auto_approved: false,
        invented: false,
      }));
  }

  const refinedTerminology = toKnowledgeEntries([
    ...buckets.verified_terminology_mappings,
    ...buckets.context_dependent_translations,
  ]);
  const refinedNames = toKnowledgeEntries(buckets.biblical_book_or_name_references);
  const refinedDoctrinal = toKnowledgeEntries(
    review.filter((r) => {
      const low = r.english.toLowerCase();
      return DOCTRINAL_SEEDS.some((s) => low === s || low.includes(s)) && r.short_tamil_variants.length;
    })
  );
  const refinedPhrases = toKnowledgeEntries(buckets.phrase_level_examples).concat(
    (prevPhrases.entries || [])
      .filter((e) => (e.variants || []).some((v) => !isParagraph(v.tamil) && isShortTermEn(e.english)))
      .map((e) => ({
        english: e.english,
        tamil_approved_equivalents: compactVariants(e.variants || []),
        source_ids: (e.source_ids || []).slice(0, 8),
        occurrence_count: e.frequency,
        context: 'Repeated preaching phrase with evidenced Tamil on near-exact short pairs',
        confidence: (e.variants || []).length > 1 ? 'medium' : 'medium',
        evidence_classification: 'phrase_level_examples',
        auto_approved: false,
        invented: false,
      }))
  );

  // Preserve full 630-example library
  const libraryExamples = prevExamplesFile.entries || [];
  writeJson(path.join(LIBRARY, 'approved_examples_full.json'), {
    generatedAt: new Date().toISOString(),
    preserved_from_phase1: true,
    count: libraryExamples.length,
    entries: libraryExamples,
  });

  const compactExamples = selectCompactExamples(libraryExamples).map((e) => ({
    source_id: e.source_id,
    english: e.english,
    tamil: e.tamil,
    band: e.band,
    selection_tags: e.tags,
    selection_score: e.score,
    en_len: e.en_len,
  }));

  const styleGuide = `# Translation Style Guide (Phase 1.1 refined)

DRY-RUN knowledge package. Do not invent terminology. Do not auto-approve mappings.

## Authority
- Immutable sources: \`dataset/source_of_truth/parallel_dataset.json\` (sermon style) and \`bible_parallel_dataset.json\` (Bible verses).
- Bible is complete (31,102 pairs). Never translate the Bible again.
- Use only the verified Bible pairs explicitly supplied in this request. Do not perform additional Bible retrieval during generation. There is no minimum number of Bible pairs: zero is valid when no reliable quotation or clear reference exists. Never invent or paraphrase a Bible translation. Use supplied Tamil BSI O.V. wording unchanged.

## How to use Tamil equivalents
- **verified_terminology_mappings**: single short Tamil gloss with source_ids. Still not auto-approved for every context.
- **context_dependent_translations**: multiple short approved Tamils; keep alternatives; pick by local context.
- **biblical_book_or_name_references**: book names and personal names; prefer short book-name Tamil (e.g. Hebrews → எபிரெயர்).
- **phrase_level_examples**: preaching cadence, not lexicon.
- **ambiguous_mappings**: paragraph-length Tamils discarded as glossary entries; originals remain in the sermon corpus.

## Prompt package
Shared prompt should include this style guide, refined glossaries, and **${compactExamples.length}** selected examples.
The full ${libraryExamples.length}-example library stays in \`knowledge/library/approved_examples_full.json\` (searchable locally, not in the prompt).

## Cadence
- Tamil is often longer than English; do not compress meaning.
- Preserve editor/tape markers.
- Keep English and Tamil separate in outputs.
`;

  const fts = await rebuildBibleFts(bibleRecords);

  const promptObj = {
    style_guide: styleGuide,
    terminology: refinedTerminology,
    biblical_names: refinedNames,
    doctrinal_glossary: refinedDoctrinal,
    repeated_phrases: refinedPhrases.slice(0, 80),
    approved_examples: compactExamples,
  };
  let promptText = JSON.stringify(promptObj);
  let tokens = estimateTokens(promptText + styleGuide);
  const trimNotes = [];
  while (tokens > TOKEN_MAX && promptObj.repeated_phrases.length > 20) {
    promptObj.repeated_phrases = promptObj.repeated_phrases.slice(
      0,
      Math.floor(promptObj.repeated_phrases.length * 0.85)
    );
    promptText = JSON.stringify(promptObj);
    tokens = estimateTokens(promptText + styleGuide);
    trimNotes.push({ action: 'trim_phrases_for_prompt', n: promptObj.repeated_phrases.length, tokens });
  }
  while (tokens > TOKEN_MAX && promptObj.approved_examples.length > 20) {
    promptObj.approved_examples.pop();
    promptText = JSON.stringify(promptObj);
    tokens = estimateTokens(promptText + styleGuide);
    trimNotes.push({
      action: 'trim_compact_examples',
      n: promptObj.approved_examples.length,
      tokens,
    });
  }

  const generatedAt = new Date().toISOString();
  writeJson(path.join(KNOWLEDGE, 'terminology.json'), {
    generatedAt,
    phase: '1.1',
    auto_approved: false,
    entries: refinedTerminology,
  });
  writeJson(path.join(KNOWLEDGE, 'biblical_names.json'), {
    generatedAt,
    phase: '1.1',
    auto_approved: false,
    entries: refinedNames,
  });
  writeJson(path.join(KNOWLEDGE, 'doctrinal_glossary.json'), {
    generatedAt,
    phase: '1.1',
    auto_approved: false,
    entries: refinedDoctrinal,
  });
  writeJson(path.join(KNOWLEDGE, 'repeated_phrases.json'), {
    generatedAt,
    phase: '1.1',
    auto_approved: false,
    entries: promptObj.repeated_phrases,
  });
  writeJson(path.join(KNOWLEDGE, 'approved_examples.json'), {
    generatedAt,
    phase: '1.1',
    role: 'compact_shared_prompt_examples',
    library_preserved_count: libraryExamples.length,
    library_path: 'knowledge/library/approved_examples_full.json',
    entries: promptObj.approved_examples,
  });
  fs.writeFileSync(path.join(KNOWLEDGE, 'translation_style_guide.md'), styleGuide);

  const sectionSizes = {
    terminology: estimateTokens(JSON.stringify(refinedTerminology)),
    biblical_names: estimateTokens(JSON.stringify(refinedNames)),
    doctrinal_glossary: estimateTokens(JSON.stringify(refinedDoctrinal)),
    repeated_phrases: estimateTokens(JSON.stringify(promptObj.repeated_phrases)),
    approved_examples_compact: estimateTokens(JSON.stringify(promptObj.approved_examples)),
    translation_style_guide: estimateTokens(styleGuide),
  };

  const manifest = {
    generatedAt,
    phase: '1.1',
    dry_run: DRY_RUN,
    budget: { available_inr: 2500, ceiling_inr: 2000, reserve_inr: 500, phase1_1_api_spend: 0 },
    sources: {
      sermon_parallel: path.resolve(SERMON_PATH),
      bible_parallel: path.resolve(BIBLE_PATH),
      immutable: true,
    },
    counts: {
      sermon_records: sermonRecords.length,
      bible_records: bibleRecords.length,
      terminology: refinedTerminology.length,
      biblical_names: refinedNames.length,
      doctrinal_glossary: refinedDoctrinal.length,
      repeated_phrases: promptObj.repeated_phrases.length,
      compact_examples: promptObj.approved_examples.length,
      library_examples: libraryExamples.length,
    },
    bible_fts: {
      path: path.resolve(fts.dbPath),
      rows: fts.rows,
      retrieval_policy: 'max_5_to_10_pairs',
      supports: [
        'exact_or_partial_english_quotation via FTS MATCH',
        'book + chapter filter on verses.book_en / verses.chapter',
        'ref field e.g. "John 3:16"',
      ],
      sample_sql: retrieveDemoSql(),
      never_dump_full_bible_into_prompt_or_cache: true,
    },
    shared_prompt_token_estimate: tokens,
    target_range: [TOKEN_MIN, TOKEN_MAX],
    gemini_count_tokens_command:
      'cd /d E:\\Freelance\\MessageDBApp\\AI_Translate\\GoogleGemini && set APPROVE_TOKEN_COUNT=1&& node phase1_inspect_distill.js',
    gemini_count_tokens_command_note:
      'Phase 1.1 did not call Gemini. To count the distilled prompt package later, run a dedicated countTokens script against knowledge/*.json (excluding bible_fts.sqlite and library/). Suggested: set APPROVE_TOKEN_COUNT=1&& node scripts/count_prompt_package_tokens.js (create when approved).',
  };
  writeJson(path.join(KNOWLEDGE, 'reference_manifest.json'), manifest);

  const pkgReport = {
    generatedAt,
    phase: '1.1',
    example_count_reconciliation: discrepancy,
    actual_file_counts: {
      terminology_json: refinedTerminology.length,
      biblical_names_json: refinedNames.length,
      doctrinal_glossary_json: refinedDoctrinal.length,
      repeated_phrases_json: promptObj.repeated_phrases.length,
      approved_examples_json_compact: promptObj.approved_examples.length,
      library_approved_examples_full: libraryExamples.length,
      bible_fts_rows: fts.rows,
    },
    shared_prompt_token_estimate: tokens,
    target_range: [TOKEN_MIN, TOKEN_MAX],
    within_target: tokens >= TOKEN_MIN && tokens <= TOKEN_MAX,
    section_sizes: sectionSizes,
    largest_sections: Object.entries(sectionSizes)
      .sort((a, b) => b[1] - a[1])
      .map(([name, t]) => ({ name, tokens: t })),
    trim_notes: trimNotes,
    differences_from_phase1: {
      previous_prompt_token_estimate: prevTok.package_local_estimate_tokens,
      previous_approved_examples_in_prompt: actualLibraryCount,
      now_compact_examples_in_prompt: promptObj.approved_examples.length,
      previous_terminology: (prevTerm.entries || []).length,
      now_terminology: refinedTerminology.length,
      paragraph_tamil_glosses_removed: review.filter((r) => r.discarded_paragraph_variants > 0).length,
    },
    gemini_count_tokens: {
      status: 'awaiting_manual_approval',
      command:
        'cd /d E:\\Freelance\\MessageDBApp\\AI_Translate\\GoogleGemini && set APPROVE_TOKEN_COUNT=1&& node -e "const fs=require(\'fs\');const {GoogleGenAI}=require(\'@google/genai\');(async()=>{const ai=new GoogleGenAI({apiKey:fs.readFileSync(\'Key.secure.txt\',\'utf8\').trim()});const files=[\'terminology.json\',\'biblical_names.json\',\'doctrinal_glossary.json\',\'repeated_phrases.json\',\'approved_examples.json\',\'translation_style_guide.md\'].map(f=>fs.readFileSync(\'knowledge/\'+f,\'utf8\')).join(\'\\n\');const r=await ai.models.countTokens({model:\'gemini-3.1-flash-lite\',contents:files});console.log(r.totalTokens);})();"',
    },
  };
  writeJson(path.join(REPORTS, 'knowledge-package-report.json'), pkgReport);

  const conflictReview = {
    generatedAt,
    totals: {
      reviewed: review.length,
      verified_terminology_mappings: buckets.verified_terminology_mappings.length,
      context_dependent_translations: buckets.context_dependent_translations.length,
      biblical_book_or_name_references: buckets.biblical_book_or_name_references.length,
      phrase_level_examples: buckets.phrase_level_examples.length,
      ambiguous_mappings: buckets.ambiguous_mappings.length,
    },
    resolved_as_not_terminology: buckets.ambiguous_mappings.map((r) => ({
      english: r.english,
      reason: r.reason,
      discarded_paragraph_variants: r.discarded_paragraph_variants,
      source_ids: r.source_ids,
    })),
    unresolved_context_dependent: buckets.context_dependent_translations.map((r) => ({
      english: r.english,
      short_tamil_variants: r.short_tamil_variants,
      source_ids: r.source_ids,
      note: 'Keep all variants. Human must choose by context. Not auto-approved.',
    })),
    buckets,
  };
  writeJson(path.join(REPORTS, 'terminology-conflict-review.json'), conflictReview);

  const completion = `# Phase 1.1 Completion Report

Generated: ${generatedAt}

DRY-RUN. API spend: **₹0**. Source of truth files not modified.

## Example-count discrepancy (resolved)

| Figure | Meaning |
| --- | --- |
| 630 | **Actual** entries in Phase 1 \`approved_examples.json\` (authoritative) |
| 680 / 578 / 778 | Intermediate \`trimPackage()\` loop states only |
| 778 then back to 630 | Expand-toward-min overshot 180k, then the while-loop trimmed examples again; trim_log did not record that last pass |

Phase 1.1 preserves all **${libraryExamples.length}** examples in \`knowledge/library/approved_examples_full.json\`.

## Conflict review

| Bucket | Count | Auto-approved? |
| --- | ---: | --- |
| Verified terminology mappings | ${buckets.verified_terminology_mappings.length} | no |
| Context-dependent translations | ${buckets.context_dependent_translations.length} | no |
| Biblical book/name references | ${buckets.biblical_book_or_name_references.length} | no |
| Phrase-level examples | ${buckets.phrase_level_examples.length} | no |
| Ambiguous (paragraph-as-term rejected) | ${buckets.ambiguous_mappings.length} | n/a (excluded from glossary) |

Unresolved: **${buckets.context_dependent_translations.length}** context-dependent items still have multiple short Tamil forms. All variants kept with source IDs.

## Actual generated files

| File | Count |
| --- | ---: |
| terminology.json | ${refinedTerminology.length} |
| biblical_names.json | ${refinedNames.length} |
| doctrinal_glossary.json | ${refinedDoctrinal.length} |
| repeated_phrases.json | ${promptObj.repeated_phrases.length} |
| approved_examples.json (compact prompt) | **${promptObj.approved_examples.length}** |
| library/approved_examples_full.json | **${libraryExamples.length}** |
| bible_fts.sqlite | **${fts.rows}** |

## Knowledge package size

- Shared prompt local token estimate: **${tokens.toLocaleString()}**
- Target: ${TOKEN_MIN.toLocaleString()}–${TOKEN_MAX.toLocaleString()}
- Within target: **${tokens >= TOKEN_MIN && tokens <= TOKEN_MAX}**

Largest prompt sections:
${Object.entries(sectionSizes)
  .sort((a, b) => b[1] - a[1])
  .map(([n, t]) => `- ${n}: ~${t.toLocaleString()}`)
  .join('\n')}

## Differences from Phase 1

- Prompt dropped from ~160k estimated tokens to ~${tokens.toLocaleString()} by moving the 630-example library out of the prompt.
- Paragraph-length Tamil “glosses” removed from terminology (e.g. Hebrews/Revelation full paragraphs).
- Bible FTS now stores book/chapter/verse + ref for quotation and reference retrieval (max 5–10).

## Gemini token counting (not run)

Authorize later with:

\`\`\`
cd /d E:\\Freelance\\MessageDBApp\\AI_Translate\\GoogleGemini
set APPROVE_TOKEN_COUNT=1
node -e "const fs=require('fs');const {GoogleGenAI}=require('@google/genai');(async()=>{const ai=new GoogleGenAI({apiKey:fs.readFileSync('Key.secure.txt','utf8').trim()});const files=['terminology.json','biblical_names.json','doctrinal_glossary.json','repeated_phrases.json','approved_examples.json','translation_style_guide.md'].map(f=>fs.readFileSync('knowledge/'+f,'utf8')).join('\\n');const r=await ai.models.countTokens({model:'gemini-3.1-flash-lite',contents:files});console.log(r.totalTokens);})();"
\`\`\`

## Remaining issues

1. Compact example set is heuristic-scored from the 630 library, not a human doctrinal review.
2. Context-dependent terms still need a human to mark preferred-in-context forms.
3. Local token estimate is chars/3.2 until countTokens is approved.
4. **Stop.** Do not authorize GCS, cache, Batch, or translation yet.
`;

  fs.writeFileSync(path.join(REPORTS, 'phase1.1-completion-report.md'), completion);
  console.log(completion);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
