/**
 * One-sermon English→Tamil translation via Gemini generateContent.
 * Phase 2B: --preflight counts tokens only (distilled prompt_package). --generate requires explicit approval.
 * No GCS, no cache, no Batch. Does not write source_of_truth or approved 419 JSON.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenAI } = require('@google/genai');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const PREFLIGHT = ARGS.includes('--preflight');
const PHASE3B_PREFLIGHT = ARGS.includes('--phase3b-preflight');
const PHASE3C_PREFLIGHT = ARGS.includes('--phase3c-preflight');
const PHASE3C1_PREFLIGHT = ARGS.includes('--phase3c1-preflight');
const PHASE3C2_PREFLIGHT = ARGS.includes('--phase3c2-preflight');
const PHASE3C3_PREFLIGHT = ARGS.includes('--phase3c3-preflight');
const PHASE3C3_GENERATE_CHUNK1 = ARGS.includes('--phase3c3-generate-chunk1');
const PHASE3C_FAMILY = PHASE3C_PREFLIGHT || PHASE3C1_PREFLIGHT || PHASE3C2_PREFLIGHT || PHASE3C3_PREFLIGHT;
const PHASE3_BENCHMARK = ARGS.includes('--phase3-benchmark');
const GENERATE =
  ARGS.includes('--generate') || PHASE3_BENCHMARK || process.env.APPROVE_GENERATE === '1';
const EXPORT_TEXT = ARGS.includes('--export-text');
const ARCHIVE_SOURCE = ARGS.includes('--archive-source');
const SERMON_ID = (process.env.SERMON_ID || '54-0812').toUpperCase();
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
/** Documented Gemini 3.1 Pro Preview maximum output tokens (thinking + candidates share this ceiling). */
const MODEL_MAX_OUTPUT_TOKENS = 65536;
const USE_PHASE3B_OUTPUT_CONFIG =
  PHASE3B_PREFLIGHT ||
  PHASE3C_FAMILY ||
  PHASE3C3_GENERATE_CHUNK1 ||
  PHASE3_BENCHMARK ||
  process.env.PHASE3B === '1';
const PROMPT_VERSION = PHASE3C3_PREFLIGHT || PHASE3C3_GENERATE_CHUNK1
  ? 'phase3c3-bible-guide-fix-1'
  : PHASE3C2_PREFLIGHT
  ? 'phase3c2-bible-match-final-1'
  : PHASE3C1_PREFLIGHT
  ? 'phase3c1-bible-match-fix-1'
  : PHASE3C_PREFLIGHT
    ? 'phase3c-two-chunk-preflight-1'
  : PHASE3B_PREFLIGHT
    ? 'phase3b-output-fix-1'
    : PHASE3_BENCHMARK
      ? 'phase3-quality-benchmark-1'
      : 'phase2b-preflight-1';
const MAX_OUTPUT_TOKENS = Number(
  process.env.MAX_OUTPUT_TOKENS || (USE_PHASE3B_OUTPUT_CONFIG ? MODEL_MAX_OUTPUT_TOKENS : 16384)
);
const THINKING_LEVEL = String(process.env.THINKING_LEVEL || (USE_PHASE3B_OUTPUT_CONFIG ? 'HIGH' : '')).toUpperCase();
const COMPACT_TAMIL_OUTPUT = USE_PHASE3B_OUTPUT_CONFIG || process.env.COMPACT_TAMIL_OUTPUT === '1';
const PARA_CHUNK = Number(process.env.PARA_CHUNK || 6);
const TAMIL_OUT_RATIO = Number(process.env.TAMIL_OUT_RATIO || 1.35);
const USD_INR = Number(process.env.USD_INR || 84);
const GST_RATE = Number(process.env.GST_RATE || 0.18);
const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW || 1048576);
/** Conservative HIGH-thinking reserve from Phase 3 observation (11056) with headroom. */
const THINKING_HIGH_RESERVE = Number(process.env.THINKING_HIGH_RESERVE || 24000);
const OUTPUT_SAFETY_MARGIN = Number(process.env.OUTPUT_SAFETY_MARGIN || 2048);

const EN_VOGR = path.join(ROOT, 'db_source', 'en_sermons_vogr.sqlite');
const BIBLE_FTS = path.join(ROOT, 'knowledge', 'bible_fts.sqlite');
const BIBLE_SOURCE = path.join(ROOT, '..', 'dataset', 'source_of_truth', 'bible_parallel_dataset.json');
const KEY_FILE = path.join(ROOT, 'Key.secure.txt');
const BASELINE_DIR = path.join(ROOT, 'reports', 'pilot', SERMON_ID);
const OUT_DIR = PHASE3_BENCHMARK || PHASE3B_PREFLIGHT || PHASE3C_FAMILY || PHASE3C3_GENERATE_CHUNK1
  ? path.join(BASELINE_DIR, 'phase3_benchmark')
  : BASELINE_DIR;
const ENG_TA_DIR = path.join(ROOT, 'reports', 'eng_tamil_output');
const TA_ONLY_DIR = path.join(ROOT, 'reports', 'tamil_output_folder');
const EN_SOURCE_DIR = path.join(ROOT, 'reports', 'english_source_sermons');
const RESPONSES_DIR = path.join(ROOT, 'reports', 'responses');
const RESPONSE_SERMON_KEY = PHASE3C3_GENERATE_CHUNK1
  ? '47-1207_PHASE3C3_CHUNK1'
  : PHASE3_BENCHMARK || PHASE3B_PREFLIGHT
    ? SERMON_ID + '_PHASE3_BENCHMARK'
    : SERMON_ID;

const KNOWLEDGE_FILES = {
  style_guide: path.join(ROOT, 'knowledge', 'translation_style_guide.md'),
  terminology: path.join(ROOT, 'knowledge', 'terminology.json'),
  biblical_names: path.join(ROOT, 'knowledge', 'biblical_names.json'),
  doctrinal_glossary: path.join(ROOT, 'knowledge', 'doctrinal_glossary.json'),
  repeated_phrases: path.join(ROOT, 'knowledge', 'repeated_phrases.json'),
  approved_examples: path.join(ROOT, 'knowledge', 'approved_examples.json'),
  prompt_package: path.join(ROOT, 'knowledge', 'prompt_package.json'),
  bible_fts: BIBLE_FTS,
};

const PRICING = {
  'gemini-3.1-pro-preview': {
    standard: { input: 2.0, output: 12.0, inputOver200k: 4.0, outputOver200k: 18.0 },
    batch: { input: 1.0, output: 6.0, inputOver200k: 2.0, outputOver200k: 9.0 },
  },
};

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}
function sha256File(p) {
  return sha256Text(fs.readFileSync(p));
}
function open(p) {
  return new sqlite3.Database(p, sqlite3.OPEN_READONLY);
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function loadKnowledgeEntries(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = (raw.entries || []).map((e) => ({
    english: e.english,
    tamil_approved_equivalents: (e.tamil_approved_equivalents || []).map((x) => ({
      tamil: x.tamil,
      count: x.count,
      source_ids: x.source_ids || [],
    })),
    source_ids: e.source_ids || [],
    occurrence_count: e.occurrence_count,
    evidence_classification: e.evidence_classification,
    confidence: e.confidence,
    auto_approved: e.auto_approved === true,
    invented: e.invented === true,
    conflict: (e.tamil_approved_equivalents || []).length > 1,
    note:
      (e.tamil_approved_equivalents || []).length > 1
        ? 'Multiple approved Tamil variants. Choose by local context. Do not invent a new form.'
        : undefined,
  }));
  return {
    file: path.relative(ROOT, filePath),
    generatedAt: raw.generatedAt,
    phase: raw.phase,
    auto_approved: raw.auto_approved === true,
    count: entries.length,
    entries,
  };
}

/** Verbose Phase 2A blob — kept only for component token comparison. Not injected into the prompt. */
function compactKnowledgeVerbose() {
  const terminology = loadKnowledgeEntries(KNOWLEDGE_FILES.terminology);
  const biblicalNames = loadKnowledgeEntries(KNOWLEDGE_FILES.biblical_names);
  const doctrinal = loadKnowledgeEntries(KNOWLEDGE_FILES.doctrinal_glossary);
  const phrases = loadKnowledgeEntries(KNOWLEDGE_FILES.repeated_phrases);
  const examplesRaw = JSON.parse(fs.readFileSync(KNOWLEDGE_FILES.approved_examples, 'utf8'));
  const examples = (examplesRaw.entries || []).map((e) => ({
    source_id: e.source_id,
    english: e.english,
    tamil: e.tamil,
    selection_tags: e.selection_tags || [],
  }));
  const verified = terminology.entries.filter(
    (e) => e.evidence_classification === 'verified_terminology_mappings'
  );
  const contextDependent = terminology.entries.filter(
    (e) => e.evidence_classification === 'context_dependent_translations'
  );
  return {
    prompt_version: PROMPT_VERSION,
    style_guide: fs.readFileSync(KNOWLEDGE_FILES.style_guide, 'utf8'),
    instructions: {
      do_not_invent_terminology: true,
      do_not_auto_approve: true,
      keep_all_conflicting_tamil_variants: true,
      never_retranslate_bible: true,
    },
    verified_terminology: { count: verified.length, entries: verified },
    context_dependent_terminology: { count: contextDependent.length, entries: contextDependent },
    biblical_names: { count: biblicalNames.count, entries: biblicalNames.entries },
    doctrinal_glossary: { count: doctrinal.count, entries: doctrinal.entries },
    repeated_phrases: { count: phrases.count, entries: phrases.entries },
    approved_examples: {
      count: examples.length,
      library_preserved_count: examplesRaw.library_preserved_count,
      entries: examples,
    },
  };
}

const OLD_BIBLE_RETRIEVAL_GUIDE =
  'Retrieve 5–10 Bible pairs per request via FTS. Never dump the Bible into the prompt.';
const NEW_BIBLE_RETRIEVAL_GUIDE =
  'Use only the verified Bible pairs explicitly supplied in this request. Do not perform additional Bible retrieval during generation. There is no minimum number of Bible pairs: zero is valid when no reliable quotation or clear reference exists. Never invent or paraphrase a Bible translation. Use supplied Tamil BSI O.V. wording unchanged.';

function applyBibleRetrievalGuideFix(text) {
  return String(text || '')
    .split(OLD_BIBLE_RETRIEVAL_GUIDE)
    .join(NEW_BIBLE_RETRIEVAL_GUIDE)
    .split('Retrieve 5-10 Bible pairs per request via FTS. Never dump the Bible into the prompt.')
    .join(NEW_BIBLE_RETRIEVAL_GUIDE);
}

function loadPromptPackage() {
  const pack = JSON.parse(fs.readFileSync(KNOWLEDGE_FILES.prompt_package, 'utf8'));
  return {
    guide: applyBibleRetrievalGuideFix(pack.guide || ''),
    terms: pack.terms || [],
    names: pack.names || [],
    doctrinal: pack.doctrinal || [],
    phrases: pack.phrases || [],
    examples: pack.examples || [],
  };
}

/** Distilled knowledge used in the live system prompt (Phase 2B). */
function compactKnowledge() {
  const pack = loadPromptPackage();
  const termCls = (pack.terms || []).reduce(
    (a, t) => {
      if (t.cls === 'context_dependent_translations') a.context += 1;
      else a.verified += 1;
      return a;
    },
    { verified: 0, context: 0 }
  );
  return {
    prompt_version: PROMPT_VERSION,
    source: 'knowledge/prompt_package.json',
    instructions: {
      do_not_invent_terminology: true,
      do_not_auto_approve: true,
      keep_all_conflicting_tamil_variants: true,
      never_retranslate_bible: true,
      use_only_supplied_verified_bible_pairs: true,
      no_minimum_bible_pairs: true,
    },
    package: pack,
    counts: {
      terms: pack.terms.length,
      verified_terminology: termCls.verified,
      context_dependent_terminology: termCls.context,
      biblical_names: pack.names.length,
      doctrinal_glossary: pack.doctrinal.length,
      repeated_phrases: pack.phrases.length,
      approved_examples: pack.examples.length,
    },
  };
}

function instructionPreamble() {
  return [
    'You are translating William Branham English sermons into Tamil for Endtime Bride.',
    'Follow the style guide and glossaries. Do not invent new doctrinal terms when a glossary form exists.',
    'When multiple Tamil equivalents are listed, keep the conflict: pick by local context only. Do not invent a third form.',
    'Never re-translate the Bible: if a sentence quotes Scripture, prefer the provided Bible Tamil pair.',
    'Preserve editor/tape markers like [Congregation says, "Amen."—Ed.] in Tamil equivalent form.',
    'Keep one Tamil paragraph per English paragraph, same order, same label.',
    'Do not compress meaning. Tamil may be longer.',
    'Return JSON only.',
  ].join('\n');
}

function bibleBlockText(bibleReport) {
  if (bibleReport.pairs.length > 0) {
    return (
      'Bible pairs to reuse (verified against bible_parallel_dataset.json; never re-translate):\n' +
      JSON.stringify(
        bibleReport.pairs.map((p) => ({
          ref: p.ref,
          english: p.english,
          tamil: p.tamil,
        }))
      )
    );
  }
  return (
    bibleReport.note ||
    'No verified Bible pairs injected. If the sermon quotes Scripture, leave the English quotation recognizable and do not invent a Bible Tamil rendering.'
  );
}

function extractBibleQueries(text) {
  const queries = [];
  const refRe =
    /\b((?:(?:1|2|3|I|II|III)\s+)?(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalm|Psalms|Proverbs|Ecclesiastes|Song of Solomon|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation))\s+(\d{1,3})(?::(\d{1,3}))?/gi;
  let m;
  while ((m = refRe.exec(text))) {
    queries.push({
      kind: 'ref',
      query: `${m[1].replace(/\s+/g, ' ').trim()} ${m[2]}${m[3] ? ':' + m[3] : ''}`,
      book: m[1].replace(/\s+/g, ' ').trim(),
      chapter: Number(m[2]),
      verse: m[3] ? Number(m[3]) : null,
    });
  }
  const quoteRe = /[“"]([^”"]{8,200})[”"]/g;
  while ((m = quoteRe.exec(text))) {
    const q = m[1].replace(/\s+/g, ' ').trim();
    if (q.split(/\s+/).length >= 3) queries.push({ kind: 'quotation', query: q });
  }
  return queries.slice(0, 20);
}

function ftsQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function normalizeQuote(s) {
  return String(s || '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[….]{2,}/g, ' ')
    .replace(/[^a-zA-Z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(s) {
  return normalizeQuote(s).toLowerCase();
}

function contentWords(s) {
  const stop = new Set([
    'the',
    'and',
    'that',
    'this',
    'with',
    'from',
    'unto',
    'shall',
    'will',
    'have',
    'hath',
    'they',
    'them',
    'their',
    'you',
    'your',
    'ye',
    'for',
    'not',
    'but',
    'are',
    'was',
    'were',
    'been',
    'into',
    'upon',
  ]);
  return bibleTokenize(s).filter((w) => w.length > 2 && !stop.has(w));
}

const GENERIC_BIBLE_PHRASES = new Set([
  'praise the lord',
  'praise ye the lord',
  'praise the lord o',
  'o praise the lord',
  'hallelujah',
  'amen',
  'i believe',
  'i believe that jesus',
  'believe on the lord',
  'believe in the lord',
  'made whole',
  'be made whole',
  'the lord jesus',
  'jesus christ',
  'lord jesus',
  'thank god',
  'god bless you',
  'have faith',
  'in jesus name',
]);

function bibleTokenize(s) {
  return normalizeForMatch(s)
    .replace(/\bwilt\b/g, 'will')
    .replace(/\bthy\b/g, 'your')
    .replace(/\bthine\b/g, 'your')
    .replace(/\bthee\b/g, 'you')
    .replace(/\bthou\b/g, 'you')
    .replace(/\byou\b/g, 'you')
    .split(/\s+/)
    .filter(Boolean);
}

function isGenericBiblePhrase(phrase) {
  const n = bibleTokenize(phrase).join(' ');
  if (!n) return true;
  if (GENERIC_BIBLE_PHRASES.has(n)) return true;
  // Exact liturgical phrases only. Do not treat a longer distinctive quotation as
  // generic merely because it contains “Lord”, “whole”, or “believe”.
  return false;
}

function longestConsecutiveNgram(query, verseEnglish) {
  const qw = bibleTokenize(query);
  const vw = bibleTokenize(verseEnglish);
  let best = { n: 0, phrase: '' };
  for (let i = 0; i < qw.length; i++) {
    for (let j = i + 3; j <= qw.length; j++) {
      const span = qw.slice(i, j);
      const needle = span.join(' ');
      if (vw.join(' ').includes(needle) && span.length > best.n) {
        best = { n: span.length, phrase: needle };
      }
    }
  }
  return best;
}

const WEAK_NGRAM_WORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'unto',
  'shall',
  'will',
  'have',
  'hath',
  'they',
  'them',
  'their',
  'you',
  'your',
  'ye',
  'for',
  'not',
  'but',
  'are',
  'was',
  'were',
  'been',
  'into',
  'upon',
  'go',
  'men',
  'man',
  'one',
  'put',
  'said',
  'say',
  'come',
  'came',
]);

function ngramIsDistinctive(phrase, n) {
  if (!phrase || n < 3) return false;
  if (isGenericBiblePhrase(phrase)) return false;
  if (n >= 5) return true;
  const toks = bibleTokenize(phrase);
  const strong = toks.filter((w) => w.length >= 3 && !WEAK_NGRAM_WORDS.has(w));
  return strong.length >= 1;
}

function quoteRelevant(verseEnglish, query) {
  if (isGenericBiblePhrase(query)) return false;
  const score = longestConsecutiveNgram(query, verseEnglish);
  if (score.n < 3) return false;
  if (!ngramIsDistinctive(score.phrase, score.n)) return false;
  return true;
}

function selectDistinctiveVerseRows(query, rows) {
  const scored = (rows || [])
    .map((r) => {
      const score = longestConsecutiveNgram(query, r.english);
      return { row: r, n: score.n, phrase: score.phrase };
    })
    .filter(
      (x) => x.n >= 3 && ngramIsDistinctive(x.phrase, x.n) && !isGenericBiblePhrase(query)
    )
    .sort((a, b) => {
      if (b.n !== a.n) return b.n - a.n;
      return String(a.row.english || '').length - String(b.row.english || '').length;
    });
  if (!scored.length) return [];
  const bestN = scored[0].n;
  // One verse per distinctive quotation: prefer the shortest KJV wording (the command
  // itself, not a later restatement such as John 5:12 after John 5:8).
  return scored.filter((x) => x.n === bestN).slice(0, 1).map((x) => x.row);
}

function kjvWordingVariants(query) {
  const base = normalizeQuote(query);
  const out = new Set([base]);
  out.add(base.replace(/\bWill thou\b/g, 'Wilt thou').replace(/\bwill thou\b/g, 'wilt thou'));
  out.add(base.replace(/\bTake up your bed\b/gi, 'Take up thy bed'));
  out.add(base.replace(/\byour bed\b/gi, 'thy bed'));
  return [...out].filter(Boolean);
}

function classifyUnmatchedQuote(query) {
  if (isGenericBiblePhrase(query)) return 'generic_phrase_not_a_citation';
  const n = normalizeForMatch(query);
  const scriptureHints = [
    'sin no more',
    'worse thing',
    'same things that i do',
    'greater works',
    'believe on me',
    'signs shall follow',
    'lay their hands',
    'go ye',
    'verily',
    'saith the lord',
    'it is written',
    'take up your bed',
    'take up thy bed',
    'be made whole',
    'take ye away the stone',
  ];
  if (scriptureHints.some((h) => n.includes(h))) return 'paraphrase_unmatched';
  const notScriptureHints = [
    'something wrong with your eye',
    'i accept him as my healer',
    'if you get the people to believe you',
    'amen',
    'praise the lord',
  ];
  if (notScriptureHints.some((h) => n.includes(h))) return 'not_scripture';
  if (n.split(/\s+/).length <= 8 && !/\b(god|lord|jesus|christ|spirit|faith|heal)\b/.test(n)) {
    return 'not_scripture';
  }
  return 'paraphrase_unmatched';
}

function sermonPassageForQuery(text, query) {
  const hay = String(text || '');
  const idx = hay.toLowerCase().indexOf(String(query || '').toLowerCase().slice(0, 40));
  if (idx < 0) return String(query || '');
  const start = Math.max(0, hay.lastIndexOf('.', idx - 1) + 1);
  const endRaw = hay.indexOf('.', idx + String(query).length);
  const end = endRaw < 0 ? Math.min(hay.length, idx + 240) : endRaw + 1;
  return hay.slice(start, end).replace(/\s+/g, ' ').trim();
}

function loadBibleSourceIndex() {
  if (!fs.existsSync(BIBLE_SOURCE)) {
    return { ok: false, error: 'Missing bible_parallel_dataset.json', byEnglish: new Map(), byNorm: new Map() };
  }
  const rows = JSON.parse(fs.readFileSync(BIBLE_SOURCE, 'utf8'));
  const byEnglish = new Map();
  const byNorm = new Map();
  for (const r of rows) {
    const key = String(r.english || '').trim();
    if (key && !byEnglish.has(key)) byEnglish.set(key, r);
    const nk = normalizeForMatch(key);
    if (nk && !byNorm.has(nk)) byNorm.set(nk, r);
  }
  return { ok: true, count: rows.length, byEnglish, byNorm };
}

function verifyAgainstSource(pair, sourceIndex) {
  const src = sourceIndex.byEnglish.get(String(pair.english || '').trim());
  if (!src) return { verified: false, reason: 'english_not_in_bible_parallel_dataset' };
  if (String(src.tamil).trim() !== String(pair.tamil).trim()) {
    return { verified: false, reason: 'tamil_mismatch_vs_bible_parallel_dataset' };
  }
  return { verified: true, reason: 'exact_en_ta_match_in_bible_parallel_dataset' };
}

async function matchQuotation(db, query) {
  const normalized = normalizeQuote(query);
  const normKey = normalizeForMatch(query);
  const allWords = normalized.split(/\s+/).filter(Boolean);
  const words = contentWords(query);
  const attempts = [];

  async function ftsPhrase(variant, method) {
    try {
      const found = await all(
        db,
        `SELECT v.ref, v.english, v.tamil, v.book_en, v.chapter, v.verse
         FROM verses_fts f
         JOIN verses v ON v.rowid = f.rowid
         WHERE verses_fts MATCH ?
         LIMIT 8`,
        [ftsQuote(variant)]
      );
      const relevant = selectDistinctiveVerseRows(query, found);
      attempts.push({ method, variant, hits: found.length, kept: relevant.length });
      return relevant;
    } catch (e) {
      attempts.push({ method, variant, error: String(e.message || e) });
      return [];
    }
  }

  // 0) Exact KJV wording variants (will/wilt, your/thy) before any looser search
  for (const variant of kjvWordingVariants(query)) {
    const relevant = await ftsPhrase(variant, 'fts_kjv_wording');
    if (relevant.length) return { rows: relevant, method: 'fts_kjv_wording', attempts };
  }

  // 1) Start-anchored phrase windows (best for Branham quoting the opening of a verse)
  for (let n = Math.min(12, allWords.length); n >= 4; n--) {
    const variant = allWords.slice(0, n).join(' ');
    const relevant = await ftsPhrase(variant, 'fts_phrase_prefix');
    if (relevant.length) return { rows: relevant, method: 'fts_phrase_prefix', attempts };
  }

  // 2) Normalized English LIKE on verses.english
  try {
    const needle = allWords.slice(0, Math.min(10, allWords.length)).join(' ');
    const likeRows = await all(
      db,
      `SELECT ref, english, tamil, book_en, chapter, verse
       FROM verses
       WHERE lower(replace(replace(english, char(8217), ''''), char(8216), ''''))
             LIKE '%' || lower(?) || '%'
       LIMIT 12`,
      [needle]
    );
    const relevant = selectDistinctiveVerseRows(query, likeRows);
    attempts.push({ method: 'normalized_english_like', hits: likeRows.length, kept: relevant.length });
    if (relevant.length) return { rows: relevant, method: 'normalized_english_like', attempts };
  } catch (e) {
    attempts.push({ method: 'normalized_english_like', error: String(e.message || e) });
  }

  // 3) Limited sliding windows (avoid burning budget on impossible long spans)
  const windows = [];
  for (let n = Math.min(8, allWords.length); n >= 4; n--) {
    for (let i = 0; i + n <= allWords.length && i < 4; i++) {
      windows.push(allWords.slice(i, i + n).join(' '));
    }
  }
  for (const variant of [...new Set(windows)]) {
    const relevant = await ftsPhrase(variant, 'fts_phrase_window');
    if (relevant.length) return { rows: relevant, method: 'fts_phrase_window', attempts };
  }

  // Bag-of-words AND matching is intentionally not used: it pulled generic verses
  // (e.g. Exodus 29:18 for “made whole”, Chronicles for “Praise the Lord”).

  attempts.push({ method: 'none', norm: normKey });
  return { rows: [], method: null, attempts };
}

async function retrieveBiblePairs(text) {
  const report = {
    ok: false,
    queries: [],
    pairs: [],
    failures: [],
    details: [],
    rejected: [],
    max: 20,
  };
  if (!fs.existsSync(BIBLE_FTS)) {
    report.failures.push({ stage: 'open', error: 'bible_fts.sqlite missing', classification: 'no_verified_pair' });
    return report;
  }
  const sourceIndex = loadBibleSourceIndex();
  if (!sourceIndex.ok) {
    report.failures.push({
      stage: 'source_verify',
      error: sourceIndex.error,
      classification: 'no_verified_pair',
    });
  }
  const queries = extractBibleQueries(text);
  if (!queries.length) {
    report.ok = true;
    report.note = 'No explicit Bible references or quotations detected in this sermon.';
    return report;
  }
  const db = open(BIBLE_FTS);
  const seen = new Set();
  try {
    for (const q of queries) {
      const qReport = {
        ...q,
        hits: 0,
        verified: 0,
        match_method: null,
        classification: null,
        error: null,
      };
      let rows = [];
      let matchMethod = null;
      try {
        if (q.kind === 'quotation' && isGenericBiblePhrase(q.query)) {
          qReport.classification = 'generic_phrase_not_a_citation';
          qReport.error = 'generic_phrase_not_a_citation';
          report.failures.push({
            query: q.query,
            kind: q.kind,
            error: 'generic_phrase_not_a_citation',
            classification: 'generic_phrase_not_a_citation',
          });
          report.rejected.push({
            query: q.query,
            classification: 'generic_phrase_not_a_citation',
            reason:
              'Common liturgical/generic phrase is not treated as a Bible citation even if similar wording exists in KJV.',
            sermon_passage: sermonPassageForQuery(text, q.query),
          });
          report.queries.push(qReport);
          report.details.push(qReport);
          continue;
        }
        if (q.kind === 'ref' && q.verse) {
          rows = await all(
            db,
            `SELECT ref, english, tamil, book_en, chapter, verse
             FROM verses
             WHERE replace(lower(book_en),' ','') LIKE replace(lower(?),' ','') || '%'
               AND chapter = ? AND verse = ?
             LIMIT 3`,
            [q.book, q.chapter, q.verse]
          );
          matchMethod = 'exact_ref';
        } else if (q.kind === 'ref') {
          rows = await all(
            db,
            `SELECT ref, english, tamil, book_en, chapter, verse
             FROM verses
             WHERE replace(lower(book_en),' ','') LIKE replace(lower(?),' ','') || '%'
               AND chapter = ?
             ORDER BY verse
             LIMIT 3`,
            [q.book, q.chapter]
          );
          matchMethod = 'chapter_ref';
        } else {
          const matched = await matchQuotation(db, q.query);
          rows = matched.rows;
          matchMethod = matched.method;
          qReport.attempts = matched.attempts;
        }
      } catch (err) {
        qReport.error = String(err.message || err);
        qReport.classification = 'no_verified_pair';
        report.failures.push({
          query: q.query,
          kind: q.kind,
          error: qReport.error,
          classification: 'no_verified_pair',
        });
        report.queries.push(qReport);
        report.details.push(qReport);
        continue;
      }
      if (q.kind === 'quotation' && rows.length) {
        const distinctive = selectDistinctiveVerseRows(q.query, rows);
        const dropped = rows.filter((r) => !distinctive.some((d) => d.ref === r.ref));
        for (const r of dropped) {
          const score = longestConsecutiveNgram(q.query, r.english);
          report.rejected.push({
            query: q.query,
            ref: r.ref,
            classification: 'weak_or_generic_overlap',
            reason:
              'Rejected: consecutive distinctive n-gram too short or generic (score=' +
              score.n +
              ', phrase=' +
              JSON.stringify(score.phrase) +
              '). Valid Bible record, not a valid match for this sermon passage.',
            sermon_passage: sermonPassageForQuery(text, q.query),
            verse_english: r.english,
          });
        }
        rows = distinctive;
        if (distinctive.length && matchMethod === 'fts_and_words') matchMethod = 'distinctive_consecutive_ngram';
      }
      qReport.hits = rows.length;
      qReport.match_method = matchMethod;
      if (!rows.length) {
        const classification = q.kind === 'quotation' ? classifyUnmatchedQuote(q.query) : 'no_verified_pair';
        qReport.classification = classification;
        report.failures.push({
          query: q.query,
          kind: q.kind,
          error: classification,
          classification,
        });
        report.queries.push(qReport);
        report.details.push(qReport);
        continue;
      }
      let injected = 0;
      for (const r of rows) {
        if (seen.has(r.ref) || report.pairs.length >= report.max) continue;
        const check = sourceIndex.ok
          ? verifyAgainstSource(r, sourceIndex)
          : { verified: false, reason: 'source_index_unavailable' };
        const detail = {
          query: q.query,
          kind: q.kind,
          match_method: matchMethod,
          ref: r.ref,
          verified: check.verified,
          reason: check.reason,
        };
        report.details.push(detail);
        if (!check.verified) {
          report.failures.push({
            query: q.query,
            ref: r.ref,
            error: check.reason,
            classification: 'no_verified_pair',
          });
          continue;
        }
        seen.add(r.ref);
        qReport.verified += 1;
        injected += 1;
        report.pairs.push({
          ref: r.ref,
          english: r.english,
          tamil: r.tamil,
          matched_query: q.query,
          match_kind: q.kind,
          match_method: matchMethod,
          consecutive_ngram: longestConsecutiveNgram(q.query, r.english),
          sermon_passage: sermonPassageForQuery(text, q.query),
          verified_against_source: true,
          tamil_from: 'bible_parallel_dataset.json (BSI O.V. wording unchanged)',
        });
      }
      qReport.classification = injected > 0 ? 'verified' : 'no_verified_pair';
      if (!injected && rows.length) {
        // candidates found but none verified / injected
        if (!report.failures.some((f) => f.query === q.query)) {
          report.failures.push({
            query: q.query,
            kind: q.kind,
            error: 'no_verified_pair',
            classification: 'no_verified_pair',
          });
        }
      }
      report.queries.push(qReport);
      if (report.pairs.length >= report.max) break;
    }
  } finally {
    await close(db);
  }
  report.ok = true;
  return report;
}

async function verifyInputs() {
  const checks = [];
  function add(name, ok, detail) {
    checks.push({ name, ok: Boolean(ok), detail });
  }

  add('english_sqlite_exists', fs.existsSync(EN_VOGR), EN_VOGR);
  let sermon = null;
  let paras = [];
  if (fs.existsSync(EN_VOGR)) {
    const db = open(EN_VOGR);
    try {
      sermon = await get(db, 'SELECT * FROM sermons WHERE upper(id)=?', [SERMON_ID]);
      add('sermon_exists', Boolean(sermon), sermon ? sermon.title : SERMON_ID + ' missing');
      if (sermon) {
        paras = await all(
          db,
          'SELECT * FROM paragraphs WHERE upper(sermon_id)=? ORDER BY id',
          [SERMON_ID]
        );
        const labels = paras.map((p) => p.paragraph_label);
        const ordered = paras.every((p, i) => i === 0 || paras[i].id >= paras[i - 1].id);
        add('paragraphs_retrieved', paras.length > 0, { count: paras.length, labels });
        add('paragraphs_ordered_by_id', ordered, { first_id: paras[0] && paras[0].id, last_id: paras.length && paras[paras.length - 1].id });
        add('paragraphs_nonempty', paras.every((p) => String(p.text || '').trim()), 'all paragraph text present');
      }
    } catch (e) {
      add('english_sqlite_readonly_open', false, String(e.message || e));
    } finally {
      await close(db);
    }
  }

  for (const [key, p] of Object.entries(KNOWLEDGE_FILES)) {
    add('knowledge_' + key, fs.existsSync(p), p);
  }

  let exampleCount = 0;
  if (fs.existsSync(KNOWLEDGE_FILES.approved_examples)) {
    const ex = JSON.parse(fs.readFileSync(KNOWLEDGE_FILES.approved_examples, 'utf8'));
    exampleCount = (ex.entries || []).length;
    add('approved_examples_exactly_36', exampleCount === 36, { count: exampleCount });
  }
  if (fs.existsSync(KNOWLEDGE_FILES.prompt_package)) {
    const pack = JSON.parse(fs.readFileSync(KNOWLEDGE_FILES.prompt_package, 'utf8'));
    add('prompt_package_examples_exactly_36', (pack.examples || []).length === 36, {
      count: (pack.examples || []).length,
      terms: (pack.terms || []).length,
      names: (pack.names || []).length,
      doctrinal: (pack.doctrinal || []).length,
      phrases: (pack.phrases || []).length,
    });
  }

  let bibleFtsCount = 0;
  let bibleSchemaOk = false;
  if (fs.existsSync(BIBLE_FTS)) {
    const bdb = open(BIBLE_FTS);
    try {
      const cols = await all(bdb, 'PRAGMA table_info(verses)');
      const names = cols.map((c) => c.name);
      bibleSchemaOk = ['id', 'english', 'tamil', 'ref', 'book_en', 'chapter', 'verse'].every((n) =>
        names.includes(n)
      );
      add('bible_fts_schema', bibleSchemaOk, names);
      const n = await get(bdb, 'SELECT COUNT(*) AS c FROM verses');
      bibleFtsCount = n.c;
      add('bible_fts_31102', bibleFtsCount === 31102, { count: bibleFtsCount });
      const sample = await all(
        bdb,
        `SELECT v.ref FROM verses_fts f JOIN verses v ON v.rowid = f.rowid
         WHERE verses_fts MATCH ? LIMIT 1`,
        [ftsQuote('In the beginning God created')]
      );
      add('bible_fts_query_valid', sample.length > 0, sample[0] ? sample[0].ref : 'no FTS hit on Genesis 1:1 quote');
    } catch (e) {
      add('bible_fts_open', false, String(e.message || e));
    } finally {
      await close(bdb);
    }
  }

  const term = JSON.parse(fs.readFileSync(KNOWLEDGE_FILES.terminology, 'utf8'));
  add('terminology_count', (term.entries || []).length > 0, { count: (term.entries || []).length });

  return { checks, sermon, paras, exampleCount, bibleFtsCount, all_ok: checks.every((c) => c.ok) };
}

function buildSystemPrompt(knowledge, bibleReport) {
  const pack = knowledge.package || loadPromptPackage();
  return [
    instructionPreamble(),
    JSON.stringify({
      prompt_version: knowledge.prompt_version || PROMPT_VERSION,
      instructions: knowledge.instructions,
      guide: pack.guide,
      terms: pack.terms,
      names: pack.names,
      doctrinal: pack.doctrinal,
      phrases: pack.phrases,
      examples: pack.examples,
    }),
    bibleBlockText(bibleReport),
  ].join('\n\n');
}

function buildUserRequest(sermon, paras) {
  return {
    sermon_id: SERMON_ID,
    english_title: sermon.title,
    date: sermon.date,
    location: sermon.location,
    paragraphs: paras.map((p) => ({
      label: p.paragraph_label,
      english: p.text,
    })),
  };
}

/** Compact response: Tamil only (English stays in the user payload / local source). */
function buildCompactResponseSchema() {
  return {
    type: 'object',
    required: ['sermon_id', 'tamil_title', 'paragraphs'],
    properties: {
      sermon_id: { type: 'string' },
      tamil_title: { type: 'string' },
      paragraphs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'tamil'],
          properties: {
            label: { type: 'string' },
            tamil: { type: 'string' },
          },
        },
      },
    },
  };
}

function buildFullResponseSchema() {
  return {
    type: 'object',
    required: ['sermon_id', 'english_title', 'tamil_title', 'paragraphs'],
    properties: {
      sermon_id: { type: 'string' },
      english_title: { type: 'string' },
      tamil_title: { type: 'string' },
      paragraphs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['label', 'english', 'tamil'],
          properties: {
            label: { type: 'string' },
            english: { type: 'string' },
            tamil: { type: 'string' },
          },
        },
      },
    },
  };
}

function buildThinkingConfig() {
  if (!THINKING_LEVEL) return undefined;
  return {
    thinkingConfig: {
      thinkingLevel: THINKING_LEVEL, // HIGH | MEDIUM | LOW | MINIMAL
      includeThoughts: false,
    },
  };
}

/**
 * Pre-generation gate: maxOutputTokens must cover thinking reserve + visible Tamil JSON + margin,
 * and must not exceed the model’s documented output limit.
 */
function assertOutputBudgetSufficient({
  maxOutputTokens,
  modelMaxOutputTokens,
  estimatedVisibleOutput,
  thinkingReserve,
  safetyMargin,
  blockGenerate,
}) {
  const check = {
    maxOutputTokens,
    model_documented_max_output: modelMaxOutputTokens,
    estimated_visible_output_tokens: estimatedVisibleOutput,
    thinking_reserve_tokens: thinkingReserve,
    safety_margin_tokens: safetyMargin,
    required_output_budget: estimatedVisibleOutput + thinkingReserve + safetyMargin,
    within_model_limit: maxOutputTokens <= modelMaxOutputTokens,
    budget_sufficient: false,
    generate_allowed: false,
    blockers: [],
  };
  if (maxOutputTokens > modelMaxOutputTokens) {
    check.blockers.push(
      'maxOutputTokens ' + maxOutputTokens + ' exceeds model documented limit ' + modelMaxOutputTokens
    );
  }
  check.budget_sufficient = check.required_output_budget <= maxOutputTokens;
  if (!check.budget_sufficient) {
    check.blockers.push(
      'required_output_budget ' +
        check.required_output_budget +
        ' exceeds configured maxOutputTokens ' +
        maxOutputTokens
    );
  }
  check.generate_allowed = check.within_model_limit && check.budget_sufficient;
  if (blockGenerate && !check.generate_allowed) {
    const err = new Error('OUTPUT_BUDGET_CHECK_FAILED: ' + check.blockers.join('; '));
    err.budget_check = check;
    throw err;
  }
  return check;
}

function mergeCompactTranslation(sourceParas, sermon, parsed) {
  const byLabel = new Map();
  for (const p of parsed.paragraphs || []) byLabel.set(String(p.label), p);
  return {
    sermon_id: SERMON_ID,
    english_title: sermon.title,
    tamil_title: parsed.tamil_title || (byLabel.get('header') && byLabel.get('header').tamil) || '',
    paragraphs: sourceParas.map((sp) => {
      const hit = byLabel.get(sp.paragraph_label);
      return {
        label: sp.paragraph_label,
        english: sp.text,
        tamil: hit ? hit.tamil : '',
      };
    }),
  };
}

function parseJson(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return JSON.parse(m[1]);
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i >= 0 && j > i) return JSON.parse(raw.slice(i, j + 1));
    throw new Error('Model did not return JSON');
  }
}

function validateTranslation(sourceParas, translated, rawPath) {
  const errors = [];
  if (!translated || typeof translated !== 'object') errors.push('not_an_object');
  const paras = (translated && translated.paragraphs) || [];
  if (!Array.isArray(paras)) errors.push('paragraphs_not_array');
  if (paras.length !== sourceParas.length) {
    errors.push(`count_mismatch expected=${sourceParas.length} got=${paras.length}`);
  }
  const labels = paras.map((p) => p && p.label);
  const expected = sourceParas.map((p) => p.paragraph_label);
  expected.forEach((lab, i) => {
    if (labels[i] !== lab) errors.push(`label_order expected[${i}]=${lab} got=${labels[i]}`);
  });
  const seen = new Set();
  for (const lab of labels) {
    if (seen.has(lab)) errors.push('duplicate_label:' + lab);
    seen.add(lab);
  }
  paras.forEach((p, i) => {
    if (!p || !String(p.english || '').trim()) errors.push('missing_english:' + (p && p.label || i));
    if (!p || !String(p.tamil || '').trim()) errors.push('empty_tamil:' + (p && p.label || i));
    const src = sourceParas[i];
    if (src && p && String(p.english).trim() !== String(src.text).trim()) {
      errors.push('english_source_mismatch:' + src.paragraph_label);
    }
  });
  return {
    ok: errors.length === 0,
    errors,
    raw_preserved: rawPath || null,
    status: errors.length === 0 ? 'passed' : 'failed',
  };
}

function safeFilePart(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function writeEnglishSourceArchive(sermon, paras) {
  const id = String(sermon.id || SERMON_ID).toUpperCase();
  const dir = path.join(EN_SOURCE_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const numbered = paras.map((p, i) => ({
    paragraph_index: i + 1,
    paragraph_number: p.paragraph_label,
    db_row_id: p.id,
    sermon_id: p.sermon_id || id,
    paragraph_label: p.paragraph_label,
    text: p.text || '',
    html: p.html || null,
  }));
  const metadata = {
    sermon_id: id,
    title: sermon.title || '',
    date: sermon.date || '',
    year: sermon.year || '',
    duration: sermon.duration || '',
    location: sermon.location || '',
    session: sermon.session || '',
    vogr_sid: sermon.vogr_sid || '',
    total_paragraphs: sermon.total_paragraphs || numbered.length,
    paragraph_count: numbered.length,
    paragraph_labels: numbered.map((p) => p.paragraph_label),
    source_db: EN_VOGR,
    source_table_sermons: 'sermons',
    source_table_paragraphs: 'paragraphs',
    raw_sermon_row: sermon,
    hash: sha256Text(
      JSON.stringify({
        id,
        title: sermon.title,
        paragraphs: numbered.map((p) => ({ label: p.paragraph_label, text: p.text })),
      })
    ),
    archived_at: new Date().toISOString(),
  };
  const txt = [
    id,
    sermon.title || '',
    ['Date:', sermon.date, 'Year:', sermon.year, 'Duration:', sermon.duration].join(' '),
    ['Location:', sermon.location, 'Session:', sermon.session, 'VOGR SID:', sermon.vogr_sid].join(' '),
    '',
  ];
  for (const p of numbered) {
    txt.push('[' + p.paragraph_index + '] label=' + p.paragraph_label);
    txt.push(p.text);
    txt.push('');
  }
  const csv = ['paragraph_index,paragraph_label,db_row_id,chars']
    .concat(
      numbered.map(
        (p) =>
          [p.paragraph_index, JSON.stringify(p.paragraph_label), p.db_row_id, Buffer.byteLength(p.text || '', 'utf8')].join(',')
      )
    )
    .join('\n');
  const paths = {
    dir,
    metadata: path.join(dir, 'metadata.json'),
    paragraphs: path.join(dir, 'paragraphs.json'),
    english_txt: path.join(dir, [id, safeFilePart(sermon.title)].filter(Boolean).join(' ') + '.txt'),
    paragraph_index_csv: path.join(dir, 'paragraph_index.csv'),
  };
  fs.writeFileSync(paths.metadata, JSON.stringify(metadata, null, 2), 'utf8');
  fs.writeFileSync(paths.paragraphs, JSON.stringify(numbered, null, 2), 'utf8');
  fs.writeFileSync(paths.english_txt, txt.join('\n'), 'utf8');
  fs.writeFileSync(paths.paragraph_index_csv, csv, 'utf8');
  return paths;
}

function jsonSafeClone(value, seen) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { type: 'Buffer', byteLength: value.length, omitted: true };
  }
  if (typeof value.toJSON === 'function') {
    try {
      return jsonSafeClone(value.toJSON(), new Set(seen));
    } catch (_) {
      /* fall through */
    }
  }
  if (Array.isArray(value)) return value.map((v) => jsonSafeClone(v, new Set(seen)));
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === 'sdkHttpResponse') {
      out.sdkHttpResponse = {
        omitted: true,
        reason: 'HTTP object omitted so Authorization headers are never written to disk',
      };
      continue;
    }
    try {
      out[key] = jsonSafeClone(value[key], new Set(seen));
    } catch (err) {
      out[key] = { serialize_error: String(err && err.message ? err.message : err) };
    }
  }
  return out;
}

function extractGeminiSafetyMetadata(response) {
  const candidates = (response && response.candidates) || [];
  const first = candidates[0] || null;
  return {
    modelVersion: response && response.modelVersion,
    responseId: response && response.responseId,
    promptFeedback: response && response.promptFeedback ? jsonSafeClone(response.promptFeedback, new Set()) : null,
    candidate_count: candidates.length,
    finishReason: first && first.finishReason,
    finishMessage: first && first.finishMessage,
    safetyRatings: first && first.safetyRatings ? jsonSafeClone(first.safetyRatings, new Set()) : null,
    citationMetadata: first && first.citationMetadata ? jsonSafeClone(first.citationMetadata, new Set()) : null,
    usageMetadata: response && response.usageMetadata ? jsonSafeClone(response.usageMetadata, new Set()) : null,
  };
}

function writeGeminiResponse({ sermonId, requestIndex, kind, labels, usage, rawText, payload, extra, fullResponse }) {
  const dir = path.join(RESPONSES_DIR, String(sermonId || SERMON_ID).toUpperCase());
  fs.mkdirSync(dir, { recursive: true });
  const stamp = String(requestIndex).padStart(2, '0');
  const base = path.join(dir, 'request-' + stamp);
  const safety = fullResponse ? extractGeminiSafetyMetadata(fullResponse) : extra && extra.safety_metadata;
  const record = {
    sermon_id: String(sermonId || SERMON_ID).toUpperCase(),
    request_index: requestIndex,
    kind: kind || 'generateContent',
    model: MODEL,
    api_version: API_VERSION,
    prompt_version: PROMPT_VERSION,
    paragraph_labels: labels || [],
    usage: usage || {},
    saved_at: new Date().toISOString(),
    extra: extra || null,
    safety_metadata: safety || null,
  };
  fs.writeFileSync(base + '.meta.json', JSON.stringify(record, null, 2), 'utf8');
  fs.writeFileSync(base + '.txt', rawText == null ? '' : String(rawText), 'utf8');
  if (payload !== undefined) {
    fs.writeFileSync(base + '.payload.json', JSON.stringify(payload, null, 2), 'utf8');
  }
  if (fullResponse) {
    fs.writeFileSync(
      base + '.full-response.json',
      JSON.stringify(jsonSafeClone(fullResponse, new Set()), null, 2),
      'utf8'
    );
  }
  return {
    dir,
    meta: base + '.meta.json',
    raw: base + '.txt',
    fullResponse: fullResponse ? base + '.full-response.json' : null,
  };
}

function archiveExistingPilotResponses(sermonId) {
  const id = String(sermonId || SERMON_ID).toUpperCase();
  const pilot = path.join(ROOT, 'reports', 'pilot', id);
  if (!fs.existsSync(pilot)) return [];
  const saved = [];
  const chunks = fs
    .readdirSync(pilot)
    .filter((f) => /^raw_chunk_\d+\.txt$/i.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  chunks.forEach((name, i) => {
    const raw = fs.readFileSync(path.join(pilot, name), 'utf8');
    saved.push(
      writeGeminiResponse({
        sermonId: id,
        requestIndex: i + 1,
        kind: 'archived_pilot_raw',
        labels: [],
        usage: {},
        rawText: raw,
        extra: { source_file: path.join(pilot, name) },
      })
    );
  });
  const combined = path.join(pilot, 'raw_model_output.txt');
  if (fs.existsSync(combined)) {
    const dir = path.join(RESPONSES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'combined-raw.txt');
    fs.copyFileSync(combined, dest);
    saved.push({ combined: dest });
  }
  return saved;
}

function writeSermonTextFiles(translated) {
  const id = translated.sermon_id || SERMON_ID;
  const enTitle = translated.english_title || '';
  const taTitle = translated.tamil_title || '';
  const paras = translated.paragraphs || [];
  const bilingual = [
    id,
    enTitle,
    taTitle,
    '',
  ];
  for (const p of paras) {
    bilingual.push('----- ' + (p.label || '') + ' -----');
    bilingual.push('ENGLISH:');
    bilingual.push(p.english || '');
    bilingual.push('');
    bilingual.push('TAMIL:');
    bilingual.push(p.tamil || '');
    bilingual.push('');
  }
  const tamilOnly = [id, taTitle, ''];
  for (const p of paras) {
    tamilOnly.push(p.tamil || '');
    tamilOnly.push('');
  }
  fs.mkdirSync(ENG_TA_DIR, { recursive: true });
  fs.mkdirSync(TA_ONLY_DIR, { recursive: true });
  const taShort = safeFilePart(
    taTitle.replace(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim().split(/\s+/).slice(0, 2).join(' ')
  );
  const biName = [id, safeFilePart(enTitle)].filter(Boolean).join(' ') + '.txt';
  const taName = [id, taShort || safeFilePart(enTitle)].filter(Boolean).join(' ') + '.txt';
  const biPath = path.join(ENG_TA_DIR, biName);
  const taPath = path.join(TA_ONLY_DIR, taName);
  fs.writeFileSync(biPath, bilingual.join('\n'), 'utf8');
  fs.writeFileSync(taPath, tamilOnly.join('\n'), 'utf8');
  return { bilingual: biPath, tamil_only: taPath };
}

function toHtml(sermon, result) {
  const rows = (result.paragraphs || [])
    .map(
      (p, i) => `<section class="p">
  <div class="lab">${p.label || i + 1}</div>
  <div class="en">${escapeHtml(p.english)}</div>
  <div class="ta">${escapeHtml(p.tamil)}</div>
</section>`
    )
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>${sermon.id} ${sermon.title} — Tamil draft</title>
<style>
body{font-family:Segoe UI,Nirmala UI,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;background:#f7f4ee;color:#222}
h1{font-size:1.4rem} .meta{color:#555;margin-bottom:1.5rem}
.p{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}
.lab{font-size:12px;color:#888;margin-bottom:8px}
.en{color:#333;margin-bottom:10px;line-height:1.45}
.ta{color:#111;line-height:1.7;font-size:1.05rem}
</style>
<h1>${escapeHtml(sermon.id)} — ${escapeHtml(sermon.title)}</h1>
<p class="meta">Draft Gemini translation for review. Not written to source_of_truth.</p>
${rows}`;
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function estimateUsd(inputTokens, outputTokens, mode) {
  const table = PRICING[MODEL] || PRICING['gemini-3.1-pro-preview'];
  const p = table[mode];
  const inRate = inputTokens > 200000 ? p.inputOver200k : p.input;
  const outRate = outputTokens > 200000 ? p.outputOver200k : p.output;
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
}
function inrWithGst(usd) {
  return usd * USD_INR * (1 + GST_RATE);
}

async function countTokens(ai, contents) {
  const r = await ai.models.countTokens({ model: MODEL, contents });
  return r.totalTokens;
}

async function countPromptComponents(ai, knowledge, bibleReport, userText) {
  const pack = knowledge.package || loadPromptPackage();
  const verbose = compactKnowledgeVerbose();
  const preamble = instructionPreamble();
  const styleGuide = fs.readFileSync(KNOWLEDGE_FILES.style_guide, 'utf8');
  const packPretty = fs.readFileSync(KNOWLEDGE_FILES.prompt_package, 'utf8');
  const packCompact = JSON.stringify(pack);
  const verboseBlob = JSON.stringify(verbose);
  const bible = bibleBlockText(bibleReport);
  const system = buildSystemPrompt(knowledge, bibleReport);
  const sections = {
    instruction_preamble: preamble,
    style_guide_standalone: styleGuide,
    prompt_package_pretty_file: packPretty,
    prompt_package_compact_json: packCompact,
    verbose_compactKnowledge_blob: verboseBlob,
    package_guide: pack.guide || '',
    package_terms: JSON.stringify(pack.terms || []),
    package_names: JSON.stringify(pack.names || []),
    package_doctrinal: JSON.stringify(pack.doctrinal || []),
    package_phrases: JSON.stringify(pack.phrases || []),
    package_examples: JSON.stringify(pack.examples || []),
    bible_block: bible,
    user_request: userText,
    system_prompt_as_sent: system,
  };
  const components = {};
  for (const [name, text] of Object.entries(sections)) {
    components[name] = {
      tokens: await countTokens(ai, text),
      chars: Buffer.byteLength(String(text), 'utf8'),
    };
  }
  const phase1Estimate = 22821;
  return {
    generated_at: new Date().toISOString(),
    model: MODEL,
    api_version: API_VERSION,
    phase1_1_shared_prompt_token_estimate: phase1Estimate,
    phase2a_system_tokens_observed: 43871,
    delta_phase2a_vs_phase1_estimate: 43871 - phase1Estimate,
    explanation:
      'Phase 2A injected verbose knowledge/*.json via JSON.stringify(compactKnowledge()), duplicating style_guide and metadata (source_ids, evidence_classification, etc.). Phase 2B injects distilled prompt_package.json instead.',
    components,
    gap_analysis: {
      verbose_minus_prompt_package_compact:
        components.verbose_compactKnowledge_blob.tokens - components.prompt_package_compact_json.tokens,
      system_minus_prompt_package_compact:
        components.system_prompt_as_sent.tokens - components.prompt_package_compact_json.tokens,
      preamble_tokens: components.instruction_preamble.tokens,
      bible_block_tokens: components.bible_block.tokens,
    },
  };
}

async function runPreflight({ sermon, paras, knowledge, bibleReport, knowledgeHash, sermonHash }) {
  if (!fs.existsSync(KEY_FILE)) throw new Error('Missing Key.secure.txt');
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });

  const system = buildSystemPrompt(knowledge, bibleReport);
  const user = buildUserRequest(sermon, paras);
  const userText =
    'Translate this complete English sermon into Tamil. Output JSON: {"sermon_id","english_title","tamil_title","paragraphs":[{"label","english","tamil"}]}.\n\n' +
    JSON.stringify(user);
  const contents = [{ role: 'user', parts: [{ text: userText }] }];

  const componentReport = await countPromptComponents(ai, knowledge, bibleReport, userText);
  const systemTokens = componentReport.components.system_prompt_as_sent.tokens;
  const userTokens = await countTokens(ai, contents);
  const combinedTokens = await countTokens(ai, [
    { role: 'user', parts: [{ text: system + '\n\n' + userText }] },
  ]);
  const englishOnlyTokens = await countTokens(
    ai,
    paras.map((p) => p.text).join('\n')
  );
  const estimatedOutput = Math.ceil(englishOnlyTokens * TAMIL_OUT_RATIO);
  const jsonOverhead = Math.ceil(englishOnlyTokens * 0.15) + 200;
  const estimatedOutputWithJson = estimatedOutput + jsonOverhead;
  const preferSingleRequest = estimatedOutputWithJson <= MAX_OUTPUT_TOKENS;
  const chunkCount = preferSingleRequest ? 1 : Math.ceil(paras.length / PARA_CHUNK);
  const maxOk = MAX_OUTPUT_TOKENS >= estimatedOutputWithJson;
  const windowOk = combinedTokens + estimatedOutputWithJson < CONTEXT_WINDOW;

  const standardUsd = estimateUsd(combinedTokens, estimatedOutputWithJson, 'standard');
  const batchUsd = estimateUsd(combinedTokens, estimatedOutputWithJson, 'batch');
  const chunkedInputEst = combinedTokens * Math.ceil(paras.length / PARA_CHUNK);
  const chunkedOutputEst = estimatedOutputWithJson;
  const chunkedStandardUsd = estimateUsd(chunkedInputEst, chunkedOutputEst, 'standard');
  const chunkedBatchUsd = estimateUsd(chunkedInputEst, chunkedOutputEst, 'batch');

  const report = {
    phase: '2B',
    mode: 'preflight',
    generated_at: new Date().toISOString(),
    sermon_id: SERMON_ID,
    english_title: sermon.title,
    model: MODEL,
    api_version: API_VERSION,
    prompt_version: PROMPT_VERSION,
    hashes: {
      source_sermon: sermonHash,
      prompt_version: sha256Text(PROMPT_VERSION + '\n' + system.slice(0, 200)),
      system_prompt: sha256Text(system),
      user_request: sha256Text(userText),
      knowledge_package: knowledgeHash,
    },
    generateContent_called: false,
    gcs: false,
    context_cache: false,
    batch_api: false,
    database_writes: false,
    tokens: {
      system: systemTokens,
      user: userTokens,
      total_input: combinedTokens,
      english_source: englishOnlyTokens,
      estimated_tamil_output: estimatedOutput,
      estimated_output_with_json: estimatedOutputWithJson,
      cached_tokens: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      context_window: CONTEXT_WINDOW,
      fits_context_window: windowOk,
      maxOutputTokens_sufficient: maxOk,
    },
    prompt_components: componentReport,
    chunking: {
      paragraph_count: paras.length,
      para_chunk: PARA_CHUNK,
      prefer_single_request: preferSingleRequest,
      estimated_chunks: chunkCount,
      note: preferSingleRequest
        ? 'Generate path (if later approved) sends the full sermon in one generateContent request.'
        : 'Output estimate exceeds maxOutputTokens; generate path falls back to PARA_CHUNK paragraphs per request.',
    },
    cost_estimate: {
      usd_inr: USD_INR,
      gst_rate: GST_RATE,
      single_request: {
        standard_usd: Number(standardUsd.toFixed(6)),
        batch_usd: Number(batchUsd.toFixed(6)),
        standard_inr_gst: Number(inrWithGst(standardUsd).toFixed(2)),
        batch_inr_gst: Number(inrWithGst(batchUsd).toFixed(2)),
      },
      chunked_path: {
        standard_usd: Number(chunkedStandardUsd.toFixed(6)),
        batch_usd: Number(chunkedBatchUsd.toFixed(6)),
        standard_inr_gst: Number(inrWithGst(chunkedStandardUsd).toFixed(2)),
        batch_inr_gst: Number(inrWithGst(chunkedBatchUsd).toFixed(2)),
      },
    },
    bible_retrieval: {
      ok: bibleReport.ok,
      injected_pairs: bibleReport.pairs.length,
      queries: bibleReport.queries,
      failures: bibleReport.failures,
      details: bibleReport.details || [],
      note: bibleReport.note || null,
    },
    knowledge: {
      source: knowledge.source || 'knowledge/prompt_package.json',
      verified_terminology: knowledge.counts.verified_terminology,
      context_dependent_terminology: knowledge.counts.context_dependent_terminology,
      biblical_names: knowledge.counts.biblical_names,
      doctrinal_glossary: knowledge.counts.doctrinal_glossary,
      repeated_phrases: knowledge.counts.repeated_phrases,
      approved_examples: knowledge.counts.approved_examples,
    },
    safety: {
      no_generateContent: true,
      no_gcs: true,
      no_cache: true,
      no_batch: true,
      no_db_writes: true,
    },
    approval_required_for: 'generateContent / --generate',
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'preflight-report.json');
  const mdPath = path.join(OUT_DIR, 'preflight-report.md');
  const componentPath = path.join(OUT_DIR, 'prompt-component-tokens.json');
  const biblePath = path.join(OUT_DIR, 'bible-retrieval-report.json');
  fs.writeFileSync(componentPath, JSON.stringify(componentReport, null, 2), 'utf8');
  fs.writeFileSync(
    biblePath,
    JSON.stringify(
      {
        sermon_id: SERMON_ID,
        generated_at: report.generated_at,
        injected_pairs: bibleReport.pairs,
        queries: bibleReport.queries,
        failures: bibleReport.failures,
        details: bibleReport.details || [],
        note: bibleReport.note || null,
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderPreflightMd(report), 'utf8');
  return { report, jsonPath, mdPath, componentPath, biblePath };
}

function renderPreflightMd(r) {
  const failBible = (r.bible_retrieval.failures || []).length;
  const c = (r.prompt_components && r.prompt_components.components) || {};
  const row = (name, label) =>
    c[name] ? '| ' + label + ' | ' + c[name].tokens + ' |' : '| ' + label + ' | — |';
  const failLines = (r.bible_retrieval.failures || [])
    .slice(0, 12)
    .map((f) => {
      const q = f.query || f.ref || '';
      const cls = f.classification || f.error;
      const ref = f.ref ? ' (ref ' + f.ref + ')' : '';
      return '- `' + q + '` — ' + cls + ref;
    })
    .join('\n');
  return [
    '# Phase 2B Preflight — ' + r.sermon_id,
    '',
    'Generated: ' + r.generated_at,
    '',
    '**No generateContent.** No GCS, cache, Batch, or database writes.',
    '',
    '## Sermon',
    '- ID: `' + r.sermon_id + '`',
    '- Title: ' + r.english_title,
    '- Model: `' + r.model + '` (' + r.api_version + ')',
    '- Prompt version: `' + r.prompt_version + '`',
    '',
    '## Hashes',
    '- Source sermon: `' + r.hashes.source_sermon + '`',
    '- System prompt: `' + r.hashes.system_prompt + '`',
    '- Knowledge package: `' + r.hashes.knowledge_package + '`',
    '',
    '## Tokens (actual countTokens)',
    '| Item | Tokens |',
    '| --- | ---: |',
    '| System prompt | ' + r.tokens.system + ' |',
    '| User request | ' + r.tokens.user + ' |',
    '| **Total input** | **' + r.tokens.total_input + '** |',
    '| English source only | ' + r.tokens.english_source + ' |',
    '| Estimated Tamil output (×' + TAMIL_OUT_RATIO + ') | ' + r.tokens.estimated_tamil_output + ' |',
    '| Estimated output + JSON | ' + r.tokens.estimated_output_with_json + ' |',
    '| maxOutputTokens | ' + r.tokens.maxOutputTokens + ' |',
    '| Context window | ' + r.tokens.context_window + ' |',
    '',
    '- Fits context window: **' + r.tokens.fits_context_window + '**',
    '- maxOutputTokens sufficient: **' + r.tokens.maxOutputTokens_sufficient + '**',
    '- Prefer single generateContent request: **' + r.chunking.prefer_single_request + '**',
    '- Cached tokens: ' + r.tokens.cached_tokens,
    '',
    '## Prompt component tokens',
    '| Component | Tokens |',
    '| --- | ---: |',
    row('instruction_preamble', 'Instruction preamble'),
    row('style_guide_standalone', 'Style guide (standalone, not double-injected)'),
    row('prompt_package_pretty_file', 'prompt_package.json (pretty file)'),
    row('prompt_package_compact_json', 'prompt_package.json (compact JSON)'),
    row('verbose_compactKnowledge_blob', 'Phase 2A verbose compactKnowledge() blob'),
    row('package_guide', 'Package guide'),
    row('package_terms', 'Package terms'),
    row('package_names', 'Package names'),
    row('package_doctrinal', 'Package doctrinal'),
    row('package_phrases', 'Package phrases'),
    row('package_examples', 'Package examples (36)'),
    row('bible_block', 'Bible block'),
    row('system_prompt_as_sent', 'System prompt as sent (2B)'),
    row('user_request', 'User request'),
    '',
    '- Phase 1.1 shared prompt estimate: ' + r.prompt_components.phase1_1_shared_prompt_token_estimate,
    '- Phase 2A system tokens observed: ' + r.prompt_components.phase2a_system_tokens_observed,
    '- Gap explanation: ' + r.prompt_components.explanation,
    '',
    '## Cost estimate (Gemini 3.1 Pro Preview)',
    'Single full-sermon request:',
    '- Standard: $' +
      r.cost_estimate.single_request.standard_usd +
      ' → ₹' +
      r.cost_estimate.single_request.standard_inr_gst +
      ' (incl. GST)',
    '- Batch: $' +
      r.cost_estimate.single_request.batch_usd +
      ' → ₹' +
      r.cost_estimate.single_request.batch_inr_gst +
      ' (incl. GST)',
    '',
    'Chunked fallback path (' +
      Math.ceil(r.chunking.paragraph_count / r.chunking.para_chunk) +
      ' × system prompt if needed, PARA_CHUNK=' +
      r.chunking.para_chunk +
      '):',
    '- Standard: $' +
      r.cost_estimate.chunked_path.standard_usd +
      ' → ₹' +
      r.cost_estimate.chunked_path.standard_inr_gst,
    '- Batch: $' +
      r.cost_estimate.chunked_path.batch_usd +
      ' → ₹' +
      r.cost_estimate.chunked_path.batch_inr_gst,
    '',
    'Batch figures are estimates only. This phase does **not** submit Batch jobs.',
    '',
    '## Knowledge (distilled prompt_package)',
    '- Source: `' + r.knowledge.source + '`',
    '- Verified terminology: ' + r.knowledge.verified_terminology,
    '- Context-dependent terminology: ' + r.knowledge.context_dependent_terminology,
    '- Biblical names: ' + r.knowledge.biblical_names,
    '- Doctrinal glossary: ' + r.knowledge.doctrinal_glossary,
    '- Repeated phrases: ' + r.knowledge.repeated_phrases,
    '- Compact examples: ' + r.knowledge.approved_examples,
    '',
    '## Bible retrieval',
    '- Injected verified pairs: ' + r.bible_retrieval.injected_pairs,
    '- Failures / misses: ' + failBible,
    r.bible_retrieval.note ? '- Note: ' + r.bible_retrieval.note : '',
    failLines,
    '',
    '## Stop',
    'Wait for explicit approval before `--generate`.',
    '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
}


function recommendParagraphChunks(paras, englishOnlyTokens, maxVisiblePerRequest) {
  const totalChars = paras.reduce((n, p) => n + String(p.text || '').length, 0) || 1;
  const fixedOverhead = 80;
  const estimates = paras.map((p) => {
    const share = String(p.text || '').length / totalChars;
    return {
      para: p,
      est: Math.ceil(englishOnlyTokens * share * TAMIL_OUT_RATIO) + 12,
    };
  });
  const totalEst = estimates.reduce((n, x) => n + x.est, 0) + fixedOverhead;
  const nChunks = Math.max(1, Math.ceil(totalEst / maxVisiblePerRequest));
  const targetPerChunk = Math.ceil(totalEst / nChunks);

  const chunks = [];
  let current = [];
  let currentEst = 0;
  for (let i = 0; i < estimates.length; i++) {
    const { para, est } = estimates[i];
    const remainingParas = estimates.length - i;
    const remainingChunks = Math.max(1, nChunks - chunks.length);
    const mustStartNew =
      current.length > 0 &&
      chunks.length < nChunks - 1 &&
      (currentEst + est + fixedOverhead > maxVisiblePerRequest ||
        (currentEst >= targetPerChunk && remainingParas >= remainingChunks));
    if (mustStartNew) {
      chunks.push({
        index: chunks.length + 1,
        paragraph_count: current.length,
        labels: current.map((x) => x.paragraph_label),
        estimated_visible_tokens: currentEst + fixedOverhead,
      });
      current = [];
      currentEst = 0;
    }
    current.push(para);
    currentEst += est;
  }
  if (current.length) {
    chunks.push({
      index: chunks.length + 1,
      paragraph_count: current.length,
      labels: current.map((x) => x.paragraph_label),
      estimated_visible_tokens: currentEst + fixedOverhead,
    });
  }
  return {
    strategy: 'paragraph_aware_balanced_pack',
    max_visible_tokens_per_request: maxVisiblePerRequest,
    target_visible_tokens_per_chunk: targetPerChunk,
    thinking_level_unchanged: THINKING_LEVEL || 'HIGH',
    knowledge_package_unchanged: true,
    estimated_chunks: chunks.length,
    chunks,
    note:
      'Recommendation only — not executed. Each chunk keeps Phase 3B quality config (HIGH thinking, full knowledge, compact Tamil JSON). Packs toward balanced chunk targets without exceeding the per-request visible budget.',
  };
}

async function runPhase3bPreflight({ sermon, paras, knowledge, bibleReport, knowledgeHash, sermonHash, verified }) {
  if (!fs.existsSync(KEY_FILE)) throw new Error('Missing Key.secure.txt');
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });

  const system = buildSystemPrompt(knowledge, bibleReport);
  const userPayload = buildUserRequest(sermon, paras);
  const userTextCompact =
    'Translate this complete English sermon into Tamil. Keep every label in order (header, then 1..N). ' +
    'Return compact JSON only: {"sermon_id","tamil_title","paragraphs":[{"label","tamil"}]}. ' +
    'Do not repeat English paragraph text in the response (English is already in the request). ' +
    'Do not summarize, omit, or add explanations. Preserve cadence, repetitions, and editor gaps like ...?... .\n\n' +
    JSON.stringify(userPayload);

  // countTokens only — not generateContent / not billed generation
  const systemTokens = await countTokens(ai, system);
  const userTokens = await countTokens(ai, [{ role: 'user', parts: [{ text: userTextCompact }] }]);
  const totalInput = await countTokens(ai, [
    { role: 'user', parts: [{ text: system + '\n\n' + userTextCompact }] },
  ]);
  const englishOnlyTokens = await countTokens(ai, paras.map((p) => p.text).join('\n'));

  // Sermon-specific visible output estimate (compact Tamil-only JSON)
  const estimatedTamil = Math.ceil(englishOnlyTokens * TAMIL_OUT_RATIO);
  const compactJsonOverhead = Math.ceil(paras.length * 12) + 80;
  const estimatedVisibleTamilJson = estimatedTamil + compactJsonOverhead;

  const phase3ConfigOrigin = {
    sermon_id: '54-0812',
    note: 'Phase 3B output config originated from 54-0812 MAX_TOKENS failure; quality settings are not reduced for larger sermons.',
    prompt: 29502,
    thinking: 11056,
    candidates_visible: 5314,
    complete_paragraphs: 8,
    max_output_was: 16384,
  };

  const thinkingReserve = THINKING_HIGH_RESERVE;
  const budget = assertOutputBudgetSufficient({
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    estimatedVisibleOutput: estimatedVisibleTamilJson,
    thinkingReserve,
    safetyMargin: OUTPUT_SAFETY_MARGIN,
    blockGenerate: false,
  });

  const fitsContextWindow = totalInput + budget.required_output_budget < CONTEXT_WINDOW;
  const canFitOneRequest = budget.generate_allowed && fitsContextWindow;

  const maxVisiblePerChunk = Math.max(
    1000,
    MAX_OUTPUT_TOKENS - thinkingReserve - OUTPUT_SAFETY_MARGIN
  );
  const chunkPlan = canFitOneRequest
    ? null
    : recommendParagraphChunks(paras, englishOnlyTokens, maxVisiblePerChunk);

  const likelyThinking = phase3ConfigOrigin.thinking;
  const expectedCostLikely = estimateUsd(totalInput, estimatedVisibleTamilJson + likelyThinking, 'standard');
  const expectedCostHighThinking = estimateUsd(
    totalInput,
    estimatedVisibleTamilJson + thinkingReserve,
    'standard'
  );
  const maxPotentialCost = estimateUsd(totalInput, MAX_OUTPUT_TOKENS, 'standard');

  // If chunking would be required, also estimate multi-request max potential (not executed)
  let chunkCostNote = null;
  if (chunkPlan) {
    const perChunkMax = estimateUsd(totalInput, MAX_OUTPUT_TOKENS, 'standard');
    // Input repeats system each chunk; approximate chunk user smaller — use full input as upper bound per chunk
    chunkCostNote = {
      estimated_chunks: chunkPlan.estimated_chunks,
      maximum_potential_if_each_chunk_hits_ceiling_inr_gst: Number(
        inrWithGst(perChunkMax * chunkPlan.estimated_chunks).toFixed(2)
      ),
      note: 'Upper bound only. Not executed. System prompt would repeat per chunk.',
    };
  }

  const report = {
    phase: '3B',
    mode: 'preflight_config_only',
    generated_at: new Date().toISOString(),
    sermon_id: SERMON_ID,
    english_title: sermon.title,
    sermon_meta: {
      date: sermon.date,
      duration: sermon.duration,
      location: sermon.location,
      total_paragraphs_db: sermon.total_paragraphs,
      paragraphs_loaded: paras.length,
    },
    model: MODEL,
    api_version: API_VERSION,
    prompt_version: PROMPT_VERSION,
    generateContent_called: false,
    paid_generation_requests: 0,
    paid_generation: false,
    countTokens_calls: 4,
    countTokens_is_generation: false,
    gcs: false,
    context_cache: false,
    batch_api: false,
    database_writes: false,
    source_of_truth_modified: false,
    knowledge_package_modified: false,
    phase3_config_origin: phase3ConfigOrigin,
    revised_configuration: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      model_documented_max_output: MODEL_MAX_OUTPUT_TOKENS,
      thinkingLevel: THINKING_LEVEL || 'HIGH',
      includeThoughts: false,
      compact_tamil_output: true,
      response_schema: 'sermon_id,tamil_title,paragraphs[{label,tamil}]',
      english_in_user_request: true,
      english_echoed_in_model_output: false,
      preserve_knowledge_package: true,
      preserve_verified_bible_pairs: true,
      quality_settings_reduced: false,
      paragraph_count: paras.length,
      paragraph_labels: paras.map((p) => p.paragraph_label),
    },
    tokens: {
      method: 'Gemini API countTokens (v1beta) — not generateContent',
      system_prompt: systemTokens,
      user_prompt: userTokens,
      total_input: totalInput,
      english_source: englishOnlyTokens,
      estimated_tamil_body: estimatedTamil,
      estimated_visible_tamil_json: estimatedVisibleTamilJson,
      thinking_reserve_high: thinkingReserve,
      safety_margin: OUTPUT_SAFETY_MARGIN,
      required_output_budget: budget.required_output_budget,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      context_window: CONTEXT_WINDOW,
      fits_context_window: fitsContextWindow,
    },
    output_budget_check: budget,
    one_request_fit: {
      can_safely_fit_complete_sermon_in_one_request: canFitOneRequest,
      within_model_output_limit: budget.within_model_limit,
      output_budget_sufficient: budget.budget_sufficient,
      fits_context_window: fitsContextWindow,
      blockers: [
        ...budget.blockers,
        ...(fitsContextWindow ? [] : ['required output + input exceeds context window']),
      ],
    },
    chunking_recommendation: chunkPlan,
    cost_estimate: {
      usd_inr: USD_INR,
      gst_rate: GST_RATE,
      pricing: 'gemini-3.1-pro-preview standard $2/1M input + $12/1M output',
      likely_usd: Number(expectedCostLikely.toFixed(6)),
      likely_inr_gst: Number(inrWithGst(expectedCostLikely).toFixed(2)),
      high_thinking_reserve_usd: Number(expectedCostHighThinking.toFixed(6)),
      high_thinking_reserve_inr_gst: Number(inrWithGst(expectedCostHighThinking).toFixed(2)),
      maximum_potential_one_request_usd: Number(maxPotentialCost.toFixed(6)),
      maximum_potential_one_request_inr_gst: Number(inrWithGst(maxPotentialCost).toFixed(2)),
      chunked_upper_bound: chunkCostNote,
      note:
        'Likely uses estimated Tamil JSON + ~11k thinking. HIGH-reserve uses ' +
        thinkingReserve +
        ' thinking tokens. Maximum potential assumes the full maxOutputTokens ceiling is billed as output for one request. Zero paid generation in this phase.',
    },
    knowledge: {
      source: knowledge.source,
      counts: knowledge.counts,
      bible_pairs_injected: bibleReport.pairs.length,
      bible_refs: (bibleReport.pairs || []).map((p) => p.ref),
    },
    hashes: {
      source_sermon: sermonHash,
      knowledge_package: knowledgeHash,
      system_prompt: sha256Text(system),
      user_prompt: sha256Text(userTextCompact),
    },
    input_verification: { all_ok: verified.all_ok, checks: verified.checks },
    confirmation: {
      zero_paid_generation_requests: true,
      generateContent_called: false,
      translation_performed: false,
      gcs_cache_batch: false,
      database_writes: false,
    },
    approval_required_for: canFitOneRequest
      ? 'generateContent / --phase3-benchmark with Phase 3B config'
      : 'explicit approval of paragraph-aware chunked generation (not executed here)',
    stop: true,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'phase3b-preflight-report.json');
  const mdPath = path.join(OUT_DIR, 'phase3b-preflight-report.md');
  const chunkMd = chunkPlan
    ? [
        '',
        '## Chunking recommendation (NOT executed)',
        '- Strategy: `' + chunkPlan.strategy + '`',
        '- Estimated chunks: **' + chunkPlan.estimated_chunks + '**',
        '- Max visible Tamil tokens / chunk: ' + chunkPlan.max_visible_tokens_per_request,
        '- Thinking level unchanged: **' + chunkPlan.thinking_level_unchanged + '**',
        '- Knowledge package unchanged: **true**',
        ...chunkPlan.chunks.map(
          (c) =>
            '- Chunk ' +
            c.index +
            ': ' +
            c.paragraph_count +
            ' paragraphs, est. visible ~' +
            c.estimated_visible_tokens +
            ' tokens, labels `' +
            c.labels[0] +
            '`…`' +
            c.labels[c.labels.length - 1] +
            '`'
        ),
        chunkCostNote
          ? '- Chunked max-potential upper bound (if each chunk hits ceiling): **₹' +
            chunkCostNote.maximum_potential_if_each_chunk_hits_ceiling_inr_gst +
            '**'
          : '',
      ]
    : ['', '## Chunking recommendation', '- Not required — complete sermon can safely fit in one request.'];

  const md = [
    '# Phase 3B Preflight — ' + SERMON_ID + ' — ' + (sermon.title || ''),
    '',
    'Generated: ' + report.generated_at,
    '',
    '**Zero paid generation requests. No generateContent. countTokens only.**',
    '',
    '## Sermon',
    '- ID: `' + SERMON_ID + '`',
    '- Title: ' + (sermon.title || ''),
    '- Date: ' + (sermon.date || '') + ' · Duration: ' + (sermon.duration || '') + ' · Location: ' + (sermon.location || ''),
    '- Paragraphs loaded: **' + paras.length + '**',
    '',
    '## Configuration (quality not reduced)',
    '- Model: `' + MODEL + '` (`' + API_VERSION + '`)',
    '- `maxOutputTokens`: **' + MAX_OUTPUT_TOKENS + '** (documented model max **' + MODEL_MAX_OUTPUT_TOKENS + '**)',
    '- `thinkingConfig.thinkingLevel`: **' + (THINKING_LEVEL || 'HIGH') + '**',
    '- Compact response: **label + tamil only**',
    '- Knowledge package + verified Bible pairs: **preserved**',
    '',
    '## Actual countTokens',
    '| Item | Tokens |',
    '| --- | ---: |',
    '| System prompt | ' + systemTokens + ' |',
    '| User prompt | ' + userTokens + ' |',
    '| **Total input** | **' + totalInput + '** |',
    '| English source only | ' + englishOnlyTokens + ' |',
    '| Est. Tamil body (×' + TAMIL_OUT_RATIO + ') | ' + estimatedTamil + ' |',
    '| Est. visible Tamil JSON | ' + estimatedVisibleTamilJson + ' |',
    '| HIGH thinking reserve | ' + thinkingReserve + ' |',
    '| Safety margin | ' + OUTPUT_SAFETY_MARGIN + ' |',
    '| **Required output budget** | **' + budget.required_output_budget + '** |',
    '| Configured maxOutputTokens | ' + MAX_OUTPUT_TOKENS + ' |',
    '',
    '## Can the complete sermon fit in one request?',
    '- **' + (canFitOneRequest ? 'YES' : 'NO') + '**',
    '- Output budget sufficient: **' + budget.budget_sufficient + '**',
    '- Fits context window: **' + fitsContextWindow + '**',
    report.one_request_fit.blockers.length
      ? '- Blockers: ' + report.one_request_fit.blockers.join('; ')
      : '- Blockers: none',
    ...chunkMd,
    '',
    '## Cost estimate (18% GST, USD→INR @ ' + USD_INR + ')',
    '- Likely (visible + ~11k thinking): **₹' + report.cost_estimate.likely_inr_gst + '** ($' + report.cost_estimate.likely_usd + ')',
    '- With HIGH thinking reserve (' + thinkingReserve + '): **₹' + report.cost_estimate.high_thinking_reserve_inr_gst + '** ($' + report.cost_estimate.high_thinking_reserve_usd + ')',
    '- **Maximum potential (one request, full ' + MAX_OUTPUT_TOKENS + ' output ceiling): ₹' + report.cost_estimate.maximum_potential_one_request_inr_gst + '** ($' + report.cost_estimate.maximum_potential_one_request_usd + ')',
    '',
    '## Bible pairs (verified only)',
    '- Count: ' + bibleReport.pairs.length,
    ...(bibleReport.pairs || []).map((p) => '- ' + p.ref),
    bibleReport.pairs.length ? '' : '- (none injected for this sermon text)',
    '',
    '## Confirmation',
    '- Paid generation requests: **0**',
    '- generateContent called: **false**',
    '- Translation performed: **false**',
    '- GCS / cache / Batch: **false**',
    '- Database / source-of-truth writes: **false**',
    '',
    '## Stop',
    'Wait for explicit approval before any generateContent.',
    '',
  ].join('\n');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  return {
    report,
    summary: {
      mode: 'phase3b-preflight',
      sermon_id: SERMON_ID,
      title: sermon.title,
      paragraphs: paras.length,
      generateContent_called: false,
      paid_generation_requests: 0,
      can_fit_one_request: canFitOneRequest,
      system_tokens: systemTokens,
      user_tokens: userTokens,
      total_input_tokens: totalInput,
      estimated_visible_tamil_json: estimatedVisibleTamilJson,
      thinking_reserve_high: thinkingReserve,
      required_output_budget: budget.required_output_budget,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      likely_inr_gst: report.cost_estimate.likely_inr_gst,
      maximum_potential_inr_gst: report.cost_estimate.maximum_potential_one_request_inr_gst,
      estimated_chunks_if_needed: chunkPlan ? chunkPlan.estimated_chunks : 1,
      jsonPath,
      mdPath,
    },
  };
}

async function runPhase3cExecutionPreflight({
  sermon,
  paras,
  knowledge,
  knowledgeHash,
  sermonHash,
  verified,
  phase = '3C',
}) {
  const artifactPrefix =
    phase === '3C3' ? 'phase3c3' : phase === '3C2' ? 'phase3c2' : phase === '3C1' ? 'phase3c1' : 'phase3c';
  const prevReportName =
    phase === '3C3'
      ? 'phase3c2-execution-preflight.json'
      : phase === '3C2'
        ? 'phase3c1-execution-preflight.json'
        : 'phase3c-execution-preflight.json';
  const prevPhase3cPath = path.join(OUT_DIR, prevReportName);
  let prevPhase3c = null;
  if ((phase === '3C1' || phase === '3C2' || phase === '3C3') && fs.existsSync(prevPhase3cPath)) {
    prevPhase3c = JSON.parse(fs.readFileSync(prevPhase3cPath, 'utf8'));
  }
  if (!fs.existsSync(KEY_FILE)) throw new Error('Missing Key.secure.txt');
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });

  const expectedLabels = paras.map((p) => p.paragraph_label);
  const byLabel = new Map(paras.map((p) => [String(p.paragraph_label), p]));

  // Approved two-chunk plan from Phase 3B
  const chunkDefs = [
    {
      chunk_index: 1,
      name: 'chunk_1_header_1_50',
      labels: ['header', ...Array.from({ length: 50 }, (_, i) => String(i + 1))],
    },
    {
      chunk_index: 2,
      name: 'chunk_2_51_97',
      labels: Array.from({ length: 47 }, (_, i) => String(i + 51)),
    },
  ];

  const coverage = {
    expected_count: expectedLabels.length,
    expected_labels: expectedLabels,
    assigned: [],
    missing_from_chunks: [],
    duplicated_across_chunks: [],
    unknown_in_chunks: [],
    every_paragraph_exactly_once: false,
  };
  const seen = new Map();
  for (const def of chunkDefs) {
    for (const lab of def.labels) {
      coverage.assigned.push(lab);
      if (!byLabel.has(lab)) coverage.unknown_in_chunks.push(lab);
      seen.set(lab, (seen.get(lab) || 0) + 1);
    }
  }
  for (const lab of expectedLabels) {
    const n = seen.get(lab) || 0;
    if (n === 0) coverage.missing_from_chunks.push(lab);
    if (n > 1) coverage.duplicated_across_chunks.push(lab);
  }
  for (const [lab, n] of seen.entries()) {
    if (n > 1 && !coverage.duplicated_across_chunks.includes(lab)) coverage.duplicated_across_chunks.push(lab);
  }
  coverage.every_paragraph_exactly_once =
    coverage.missing_from_chunks.length === 0 &&
    coverage.duplicated_across_chunks.length === 0 &&
    coverage.unknown_in_chunks.length === 0 &&
    coverage.assigned.length === expectedLabels.length;

  const compactSchema = buildCompactResponseSchema();
  const assemblyStrategy = {
    merge_order: 'chunk_1_then_chunk_2_by_original_label_order',
    output_schema_per_request: compactSchema,
    post_process:
      'For each returned {label,tamil}, attach english from local source paragraphs by label. Build final document with all 98 paragraphs in original order. Write preview HTML. Do not write source_of_truth.',
    tamil_title: 'Take tamil_title from chunk 1 response if present; otherwise derive from header tamil.',
    no_automatic_retry: true,
    separate_approval_required_per_chunk: true,
  };

  const chunkReports = [];
  let countTokenCalls = 0;

  for (const def of chunkDefs) {
    const chunkParas = def.labels.map((lab) => {
      const p = byLabel.get(lab);
      if (!p) throw new Error('Missing paragraph for planned label: ' + lab);
      return p;
    });
    const bodyText = chunkParas.map((p) => p.text).join('\n');
    const bibleReport = await retrieveBiblePairs(bodyText);
    const system = buildSystemPrompt(knowledge, bibleReport);
    const userPayload = {
      sermon_id: SERMON_ID,
      english_title: sermon.title,
      date: sermon.date,
      location: sermon.location,
      chunk: def.chunk_index,
      chunk_name: def.name,
      total_chunks: chunkDefs.length,
      paragraphs: chunkParas.map((p) => ({
        label: p.paragraph_label,
        english: p.text,
      })),
    };
    const userText =
      'Translate these sermon paragraphs into Tamil. Keep every label in the given order. ' +
      'Return compact JSON only: {"sermon_id","tamil_title","paragraphs":[{"label","tamil"}]}. ' +
      'Do not repeat English paragraph text in the response. Do not summarize, omit, or add explanations. ' +
      'Preserve cadence, repetitions, and editor gaps like ...?... .\n\n' +
      JSON.stringify(userPayload);

    const systemTokens = await countTokens(ai, system);
    countTokenCalls += 1;
    const userTokens = await countTokens(ai, [{ role: 'user', parts: [{ text: userText }] }]);
    countTokenCalls += 1;
    const totalInput = await countTokens(ai, [
      { role: 'user', parts: [{ text: system + '\n\n' + userText }] },
    ]);
    countTokenCalls += 1;
    const englishOnlyTokens = await countTokens(ai, bodyText);
    countTokenCalls += 1;

    const estimatedTamil = Math.ceil(englishOnlyTokens * TAMIL_OUT_RATIO);
    const compactJsonOverhead = Math.ceil(chunkParas.length * 12) + 80;
    const estimatedVisible = estimatedTamil + compactJsonOverhead;
    const budget = assertOutputBudgetSufficient({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
      estimatedVisibleOutput: estimatedVisible,
      thinkingReserve: THINKING_HIGH_RESERVE,
      safetyMargin: OUTPUT_SAFETY_MARGIN,
      blockGenerate: false,
    });

    const likelyUsd = estimateUsd(totalInput, estimatedVisible + 11056, 'standard');
    const highUsd = estimateUsd(totalInput, estimatedVisible + THINKING_HIGH_RESERVE, 'standard');
    const maxUsd = estimateUsd(totalInput, MAX_OUTPUT_TOKENS, 'standard');

    const requestManifest = {
      model: MODEL,
      api_version: API_VERSION,
      config: {
        systemInstruction: '(Phase 3B distilled prompt_package + chunk-relevant verified Bible pairs)',
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: compactSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false },
      },
      user_intro_preview: userText.slice(0, 240) + '…',
      payload_paragraph_count: chunkParas.length,
      payload_labels: def.labels,
    };

    // Persist exact payload for inspection (no generation)
    const payloadPath = path.join(OUT_DIR, artifactPrefix + '-' + def.name + '-payload.json');
    const systemPath = path.join(OUT_DIR, artifactPrefix + '-' + def.name + '-system.txt');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(payloadPath, JSON.stringify(userPayload, null, 2), 'utf8');
    fs.writeFileSync(systemPath, system, 'utf8');

    chunkReports.push({
      chunk_index: def.chunk_index,
      name: def.name,
      paragraph_count: chunkParas.length,
      labels: def.labels,
      first_label: def.labels[0],
      last_label: def.labels[def.labels.length - 1],
      bible_pairs: (bibleReport.pairs || []).map((p) => ({
        ref: p.ref,
        match_method: p.match_method,
        matched_query: p.matched_query,
        sermon_passage: p.sermon_passage,
        consecutive_ngram: p.consecutive_ngram,
        tamil_from: p.tamil_from,
        verified_against_source: p.verified_against_source,
      })),
      bible_pair_count: (bibleReport.pairs || []).length,
      bible_rejected_this_chunk: bibleReport.rejected || [],
      bible_failures: bibleReport.failures || [],
      tokens: {
        system_prompt: systemTokens,
        user_prompt: userTokens,
        total_input: totalInput,
        english_source: englishOnlyTokens,
        estimated_tamil_body: estimatedTamil,
        estimated_visible_tamil_json: estimatedVisible,
        thinking_reserve_high: THINKING_HIGH_RESERVE,
        safety_margin: OUTPUT_SAFETY_MARGIN,
        required_output_budget: budget.required_output_budget,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
      output_budget_check: budget,
      safe_to_execute_independently: budget.generate_allowed,
      cost_estimate: {
        likely_usd: Number(likelyUsd.toFixed(6)),
        likely_inr_gst: Number(inrWithGst(likelyUsd).toFixed(2)),
        high_reserve_usd: Number(highUsd.toFixed(6)),
        high_reserve_inr_gst: Number(inrWithGst(highUsd).toFixed(2)),
        maximum_potential_usd: Number(maxUsd.toFixed(6)),
        maximum_potential_inr_gst: Number(inrWithGst(maxUsd).toFixed(2)),
      },
      artifacts: { payloadPath, systemPath },
      request_manifest: requestManifest,
      hashes: {
        system_prompt: sha256Text(system),
        user_prompt: sha256Text(userText),
        payload: sha256Text(JSON.stringify(userPayload)),
      },
    });
  }

  const bothSafe = chunkReports.every((c) => c.safe_to_execute_independently) && coverage.every_paragraph_exactly_once;
  const sum = (keyPath) =>
    chunkReports.reduce((n, c) => {
      const parts = keyPath.split('.');
      let v = c;
      for (const p of parts) v = v[p];
      return n + (Number(v) || 0);
    }, 0);

  const totals = {
    system_prompt_tokens_sum: sum('tokens.system_prompt'),
    user_prompt_tokens_sum: sum('tokens.user_prompt'),
    total_input_tokens_sum: sum('tokens.total_input'),
    estimated_visible_tamil_json_sum: sum('tokens.estimated_visible_tamil_json'),
    note: 'System prompt is repeated once per chunk request (full knowledge each time).',
    cost: {
      usd_inr: USD_INR,
      gst_rate: GST_RATE,
      likely_inr_gst: Number(inrWithGst(sum('cost_estimate.likely_usd')).toFixed(2)),
      high_reserve_inr_gst: Number(inrWithGst(sum('cost_estimate.high_reserve_usd')).toFixed(2)),
      maximum_potential_inr_gst: Number(inrWithGst(sum('cost_estimate.maximum_potential_usd')).toFixed(2)),
      likely_usd: Number(sum('cost_estimate.likely_usd').toFixed(6)),
      high_reserve_usd: Number(sum('cost_estimate.high_reserve_usd').toFixed(6)),
      maximum_potential_usd: Number(sum('cost_estimate.maximum_potential_usd').toFixed(6)),
    },
  };

  const removedBibleMatches = [];
  if (prevPhase3c && Array.isArray(prevPhase3c.chunks)) {
    for (const prevChunk of prevPhase3c.chunks) {
      const nextChunk = chunkReports.find((c) => c.chunk_index === prevChunk.chunk_index);
      const keptRefs = new Set((nextChunk && nextChunk.bible_pairs ? nextChunk.bible_pairs : []).map((p) => p.ref));
      for (const oldPair of prevChunk.bible_pairs || []) {
        if (keptRefs.has(oldPair.ref)) continue;
        const query = oldPair.matched_query || '';
        let why = 'Valid Bible record, but not a reliable identifiable quotation or clear verse reference for this sermon passage.';
        if (oldPair.ref === 'John 5:12') {
          why =
            'The sermon quotes Jesus’ command “Take up your bed and walk,” which is John 5:8. John 5:12 is the later question (“What man is that which said unto thee, Take up thy bed, and walk?”) and is not injected as a separate Bible quotation.';
        } else if (/praise the lord/i.test(query)) {
          why =
            'Rejected generic liturgical phrase “Praise the Lord.” Shared wording is not evidence of a quotation of ' +
            oldPair.ref +
            '.';
        } else if (/will thou be made whole/i.test(query) && oldPair.ref !== 'John 5:6') {
          why =
            'Rejected bag-of-words / generic overlap with “Will thou be made whole?” This sermon quotes John 5:6 (“Wilt thou be made whole?”), not ' +
            oldPair.ref +
            '.';
        } else if (/take up your bed/i.test(query) && !/^John 5:8$|^Mark 2:9$/.test(oldPair.ref)) {
          why =
            'Rejected weaker duplicate of “Take up your bed and walk.” Kept the distinctive KJV command verses only; ' +
            oldPair.ref +
            ' is a valid record but not selected as the identifiable quotation.';
        } else if (/i believe that jesus/i.test(query)) {
          why =
            'Rejected generic testimony wording (“I believe that Jesus…”). Not treated as a citation of ' +
            oldPair.ref +
            '.';
        } else if (oldPair.match_method === 'fts_and_words') {
          why =
            'Rejected former fts_and_words match: overlapping common words without a distinctive consecutive KJV phrase.';
        }
        removedBibleMatches.push({
          chunk_index: prevChunk.chunk_index,
          chunk_name: prevChunk.name,
          ref: oldPair.ref,
          matched_query: oldPair.matched_query,
          previous_match_method: oldPair.match_method,
          reason: why,
        });
      }
    }
  }

  const guideInstructionCheck = {
    replaced_from: OLD_BIBLE_RETRIEVAL_GUIDE,
    replaced_with: NEW_BIBLE_RETRIEVAL_GUIDE,
    chunk_checks: chunkReports.map((c) => {
      const sys = fs.readFileSync(c.artifacts.systemPath, 'utf8');
      return {
        chunk: c.name,
        old_5_10_instruction_absent:
          !sys.includes(OLD_BIBLE_RETRIEVAL_GUIDE) && !sys.includes('Retrieve 5-10 Bible pairs'),
        new_supplied_pairs_instruction_present: sys.includes(NEW_BIBLE_RETRIEVAL_GUIDE),
        john_5_12_absent: !sys.includes('John 5:12'),
        bible_refs: (c.bible_pairs || []).map((p) => p.ref),
      };
    }),
    chunk1_expected_refs: ['John 5:6', 'John 5:7', 'John 5:8', 'John 11:39'],
    chunk2_expected_refs: [],
  };

  const report = {
    phase: phase === '3C3' ? '3C.3' : phase === '3C2' ? '3C.2' : phase === '3C1' ? '3C.1' : '3C',
    mode:
      phase === '3C3'
        ? 'bible_retrieval_instruction_correction_preflight'
        : phase === '3C2'
        ? 'final_bible_match_correction_preflight'
        : phase === '3C1'
          ? 'corrected_bible_pair_retrieval_preflight'
          : 'two_chunk_execution_preflight',
    generated_at: new Date().toISOString(),
    sermon_id: SERMON_ID,
    english_title: sermon.title,
    sermon_meta: {
      date: sermon.date,
      duration: sermon.duration,
      location: sermon.location,
      paragraphs_loaded: paras.length,
    },
    model: MODEL,
    api_version: API_VERSION,
    prompt_version: PROMPT_VERSION,
    generateContent_called: false,
    paid_generation_requests: 0,
    countTokens_calls: countTokenCalls,
    countTokens_is_generation: false,
    gcs: false,
    context_cache: false,
    batch_api: false,
    database_writes: false,
    source_of_truth_modified: false,
    automatic_retries: false,
    configuration: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingLevel: 'HIGH',
      includeThoughts: false,
      compact_tamil_output: true,
      preserve_knowledge_package: true,
      preserve_verified_bible_pairs_per_chunk: true,
      quality_settings_reduced: false,
      bible_matching:
        phase === '3C1' || phase === '3C2' || phase === '3C3'
          ? {
              identifiable_quotation_or_clear_reference_only: true,
              prefer_exact_kjv_and_distinctive_consecutive_ngrams: true,
              one_verse_per_quotation: true,
              prefer_spoken_command_over_later_restatement: true,
              generic_words_are_not_citations: ['whole', 'believe', 'praise the Lord', 'God', 'Jesus'],
              do_not_fill_to_5_10_pairs: true,
              zero_pairs_if_unreliable: true,
              tamil_wording: 'bible_parallel_dataset.json BSI O.V. unchanged',
            }
          : undefined,
    },
    paragraph_coverage: coverage,
    assembly_strategy: assemblyStrategy,
    chunks: chunkReports,
    totals,
    bible_match_corrections:
      phase === '3C1' || phase === '3C2' || phase === '3C3'
        ? {
            previous_report: prevPhase3cPath,
            removed_bible_matches: removedBibleMatches,
            retained_bible_matches: chunkReports.flatMap((c) =>
              (c.bible_pairs || []).map((p) => ({
                chunk_index: c.chunk_index,
                ref: p.ref,
                sermon_passage: p.sermon_passage,
                matched_query: p.matched_query,
                match_method: p.match_method,
                consecutive_ngram: p.consecutive_ngram,
              }))
            ),
          }
          : undefined,
    guide_instruction_correction: phase === '3C3' ? guideInstructionCheck : undefined,
    both_chunks_safe_to_execute_independently: bothSafe,
    execution_gate: {
      chunk_1_requires_separate_explicit_approval: true,
      chunk_2_requires_separate_explicit_approval_after_chunk_1_review: true,
      do_not_start_either_chunk_without_approval: true,
    },
    confirmation: {
      zero_paid_generation_requests: true,
      generateContent_called: false,
      translation_performed: false,
      gcs_cache_batch: false,
      database_writes: false,
      baseline_not_overwritten: true,
    },
    hashes: {
      source_sermon: sermonHash,
      knowledge_package: knowledgeHash,
    },
    input_verification: { all_ok: verified.all_ok },
    stop: true,
    approval_required_for: 'Chunk 1 generateContent only after explicit approval; then Chunk 2 after review',
  };

  const jsonPath = path.join(OUT_DIR, artifactPrefix + '-execution-preflight.json');
  const mdPath = path.join(OUT_DIR, artifactPrefix + '-execution-preflight.md');
  const mdChunks = chunkReports
    .map((c) => {
      return [
        '### Chunk ' + c.chunk_index + ' — `' + c.name + '`',
        '- Paragraphs: **' + c.paragraph_count + '** (`' + c.first_label + '` … `' + c.last_label + '`)',
        '- Bible pairs injected: **' + c.bible_pair_count + '**' +
          (c.bible_pairs.length
            ? ' (' + c.bible_pairs.map((b) => b.ref).join(', ') + ')'
            : ' (none — zero pairs when no reliable match)'),
        ...(c.bible_pairs || []).map(
          (b) =>
            '  - `' +
            b.ref +
            '` ← ' +
            JSON.stringify(b.matched_query) +
            ' [' +
            b.match_method +
            (b.consecutive_ngram && b.consecutive_ngram.phrase
              ? '; n-gram ' + b.consecutive_ngram.n + ': ' + b.consecutive_ngram.phrase
              : '') +
            ']'
        ),
        '',
        '| Item | Tokens |',
        '| --- | ---: |',
        '| System prompt | ' + c.tokens.system_prompt + ' |',
        '| User prompt | ' + c.tokens.user_prompt + ' |',
        '| **Total input** | **' + c.tokens.total_input + '** |',
        '| English source | ' + c.tokens.english_source + ' |',
        '| Est. visible Tamil JSON | ' + c.tokens.estimated_visible_tamil_json + ' |',
        '| HIGH thinking reserve | ' + c.tokens.thinking_reserve_high + ' |',
        '| Safety margin | ' + c.tokens.safety_margin + ' |',
        '| **Required output budget** | **' + c.tokens.required_output_budget + '** |',
        '| maxOutputTokens | ' + c.tokens.maxOutputTokens + ' |',
        '',
        '- Safe to execute independently: **' + c.safe_to_execute_independently + '**',
        '- Likely cost: **₹' + c.cost_estimate.likely_inr_gst + '**',
        '- HIGH-reserve cost: **₹' + c.cost_estimate.high_reserve_inr_gst + '**',
        '- Max potential: **₹' + c.cost_estimate.maximum_potential_inr_gst + '**',
        '- Payload artifact: `' + c.artifacts.payloadPath + '`',
        '',
      ].join('\n');
    })
    .join('\n');

  const md = [
    phase === '3C3'
      ? '# Phase 3C.3 — Bible Retrieval Instruction Correction Preflight — ' + SERMON_ID + ' Experiences'
      : phase === '3C2'
      ? '# Phase 3C.2 — Final Bible Match Correction Preflight — ' + SERMON_ID + ' Experiences'
      : phase === '3C1'
      ? '# Phase 3C.1 — Corrected Bible Pair Retrieval Preflight — ' + SERMON_ID + ' Experiences'
      : '# Phase 3C — Two-Chunk Execution Preflight — ' + SERMON_ID + ' Experiences',
    '',
    'Generated: ' + report.generated_at,
    '',
    '**Zero paid generation requests. No generateContent. countTokens only on exact chunk payloads.**',
    '',
    '## Verdict',
    '- Both chunks safe to execute independently: **' + bothSafe + '**',
    '- Paragraph coverage exact (98 unique, no missing/dupes): **' + coverage.every_paragraph_exactly_once + '**',
    '- Estimated total likely cost (both chunks): **₹' + totals.cost.likely_inr_gst + '**',
    '- Estimated total HIGH-reserve cost: **₹' + totals.cost.high_reserve_inr_gst + '**',
    '- Estimated total maximum-potential cost: **₹' + totals.cost.maximum_potential_inr_gst + '**',
    '',
    '## Configuration (unchanged quality)',
    '- Model: `' + MODEL + '` / `' + API_VERSION + '`',
    '- thinkingLevel: **HIGH** · includeThoughts: false',
    '- maxOutputTokens: **65536**',
    '- Compact Tamil-only JSON · full knowledge package · verified Bible pairs per chunk',
    '',
    '## Paragraph coverage',
    '- Expected paragraphs: ' + coverage.expected_count,
    '- Assigned across chunks: ' + coverage.assigned.length,
    '- Missing: ' + (coverage.missing_from_chunks.length ? coverage.missing_from_chunks.join(', ') : 'none'),
    '- Duplicated: ' + (coverage.duplicated_across_chunks.length ? coverage.duplicated_across_chunks.join(', ') : 'none'),
    '- Unknown labels: ' + (coverage.unknown_in_chunks.length ? coverage.unknown_in_chunks.join(', ') : 'none'),
    '',
    '## Chunks (exact countTokens)',
    mdChunks,
    '## Totals (both requests)',
    '| Item | Tokens / Cost |',
    '| --- | ---: |',
    '| System prompt sum (repeated) | ' + totals.system_prompt_tokens_sum + ' |',
    '| User prompt sum | ' + totals.user_prompt_tokens_sum + ' |',
    '| Total input sum | ' + totals.total_input_tokens_sum + ' |',
    '| Est. visible Tamil JSON sum | ' + totals.estimated_visible_tamil_json_sum + ' |',
    '| Likely INR+GST | ₹' + totals.cost.likely_inr_gst + ' |',
    '| HIGH-reserve INR+GST | ₹' + totals.cost.high_reserve_inr_gst + ' |',
    '| Maximum-potential INR+GST | ₹' + totals.cost.maximum_potential_inr_gst + ' |',
    '',
    '## Assembly strategy',
    '- ' + assemblyStrategy.merge_order,
    '- ' + assemblyStrategy.post_process,
    '- ' + assemblyStrategy.tamil_title,
    '- No automatic retries. Separate approval required per chunk.',
    '',
    ...(phase === '3C1' || phase === '3C2' || phase === '3C3'
      ? [
          '## Bible match corrections',
          '- Identifiable quotation / clear verse reference only. Generic words are not citations.',
          '- One verse per quotation: keep the spoken command, not a later restatement.',
          '- Do not fill to 5–10 pairs. Zero pairs if no reliable match.',
          '- Tamil BSI O.V. wording taken unchanged from `bible_parallel_dataset.json`.',
          '',
          '### Retained matches',
          ...(report.bible_match_corrections.retained_bible_matches.length
            ? report.bible_match_corrections.retained_bible_matches.map(
                (p) =>
                  '- Chunk ' +
                  p.chunk_index +
                  ': **' +
                  p.ref +
                  '** — sermon: ' +
                  JSON.stringify(p.matched_query) +
                  ' — method: `' +
                  p.match_method +
                  '`' +
                  (p.consecutive_ngram && p.consecutive_ngram.phrase
                    ? ' — n-gram(' + p.consecutive_ngram.n + '): ' + JSON.stringify(p.consecutive_ngram.phrase)
                    : '')
              )
            : ['- None (zero pairs).']),
          '',
          '### Removed matches (' +
            (phase === '3C3' ? 'Phase 3C.2 → 3C.3' : phase === '3C2' ? 'Phase 3C.1 → 3C.2' : 'Phase 3C → 3C.1') +
            ')',
          ...(removedBibleMatches.length
            ? removedBibleMatches.map(
                (p) =>
                  '- Chunk ' +
                  p.chunk_index +
                  ': **' +
                  p.ref +
                  '** for ' +
                  JSON.stringify(p.matched_query) +
                  ' — ' +
                  p.reason
              )
            : ['- None.']),
          '',
          ...(phase === '3C3'
            ? [
                '## Guide instruction correction',
                '- Removed: `' + OLD_BIBLE_RETRIEVAL_GUIDE + '`',
                '- Replaced with: `' + NEW_BIBLE_RETRIEVAL_GUIDE + '`',
                ...guideInstructionCheck.chunk_checks.map(
                  (c) =>
                    '- `' +
                    c.chunk +
                    '`: old 5–10 absent **' +
                    c.old_5_10_instruction_absent +
                    '**; new supplied-pairs instruction present **' +
                    c.new_supplied_pairs_instruction_present +
                    '**; John 5:12 absent **' +
                    c.john_5_12_absent +
                    '**; refs: ' +
                    (c.bible_refs.length ? c.bible_refs.join(', ') : '(none)')
                ),
                '',
              ]
            : []),
        ]
      : []),
    '## Confirmation',
    '- Paid generation requests: **0**',
    '- generateContent: **false**',
    '- Translation performed: **false**',
    '- GCS / cache / Batch: **false**',
    '- DB / source-of-truth writes: **false**',
    '- Baseline not overwritten: **true**',
    '',
    '## Stop',
    'Do **not** start Chunk 1 or Chunk 2 without separate explicit approval.',
    '',
  ].join('\n');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  return {
    report,
    summary: {
      mode:
        phase === '3C3'
          ? 'phase3c3-preflight'
          : phase === '3C2'
            ? 'phase3c2-preflight'
            : phase === '3C1'
              ? 'phase3c1-preflight'
              : 'phase3c-preflight',
      removed_bible_match_count: removedBibleMatches.length,
      sermon_id: SERMON_ID,
      paid_generation_requests: 0,
      generateContent_called: false,
      both_chunks_safe: bothSafe,
      coverage_exact: coverage.every_paragraph_exactly_once,
      likely_total_inr_gst: totals.cost.likely_inr_gst,
      high_reserve_total_inr_gst: totals.cost.high_reserve_inr_gst,
      maximum_potential_total_inr_gst: totals.cost.maximum_potential_inr_gst,
      jsonPath,
      mdPath,
    },
  };
}

async function runPhase3c3Chunk1Generate() {
  const sermonId = '47-1207';
  const outDir = path.join(ROOT, 'reports', 'pilot', sermonId, 'phase3_benchmark');
  const systemPath = path.join(outDir, 'phase3c3-chunk_1_header_1_50-system.txt');
  const payloadPath = path.join(outDir, 'phase3c3-chunk_1_header_1_50-payload.json');
  const preflightPath = path.join(outDir, 'phase3c3-execution-preflight.json');
  if (!fs.existsSync(systemPath) || !fs.existsSync(payloadPath) || !fs.existsSync(preflightPath)) {
    throw new Error('Missing Phase 3C.3 Chunk 1 verified artifacts');
  }
  const system = fs.readFileSync(systemPath, 'utf8');
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
  const chunkPf = (preflight.chunks || []).find((c) => c.chunk_index === 1);
  if (!chunkPf) throw new Error('Phase 3C.3 preflight is missing Chunk 1');

  const expectedLabels = ['header', ...Array.from({ length: 50 }, (_, i) => String(i + 1))];
  const payloadLabels = (payload.paragraphs || []).map((p) => String(p.label));
  const compactPayload = JSON.stringify(payload);
  const userText =
    'Translate these sermon paragraphs into Tamil. Keep every label in the given order. ' +
    'Return compact JSON only: {"sermon_id","tamil_title","paragraphs":[{"label","tamil"}]}. ' +
    'Do not repeat English paragraph text in the response. Do not summarize, omit, or add explanations. ' +
    'Preserve cadence, repetitions, and editor gaps like ...?... .\n\n' +
    compactPayload;

  const preflightHashes = (chunkPf.hashes || {});
  const liveHashes = {
    system_prompt: sha256Text(system),
    user_prompt: sha256Text(userText),
    payload: sha256Text(compactPayload),
  };
  const hashMatch =
    liveHashes.system_prompt === preflightHashes.system_prompt &&
    liveHashes.user_prompt === preflightHashes.user_prompt &&
    liveHashes.payload === preflightHashes.payload;
  if (!hashMatch) {
    throw new Error(
      'Refusing generateContent: Phase 3C.3 Chunk 1 files do not match verified preflight hashes ' +
        JSON.stringify({ expected: preflightHashes, live: liveHashes })
    );
  }

  const bibleRefs = [];
  const bibleBlock = system.match(/\[{"ref":[\s\S]*\}\]\s*$/m);
  const refsFromSystem = [...system.matchAll(/"ref":"([^"]+)"/g)].map((m) => m[1]);
  bibleRefs.push(...refsFromSystem);
  const configOk = {
    labels_exact:
      payloadLabels.length === 51 &&
      expectedLabels.every((lab, i) => payloadLabels[i] === lab) &&
      payloadLabels.length === new Set(payloadLabels).size,
    bible_refs: bibleRefs,
    bible_refs_expected: ['John 5:6', 'John 5:7', 'John 5:8', 'John 11:39'],
    john_5_12_absent: !system.includes('John 5:12'),
    old_5_10_absent: !system.includes(OLD_BIBLE_RETRIEVAL_GUIDE) && !system.includes('Retrieve 5-10 Bible pairs'),
    new_guide_present: system.includes(NEW_BIBLE_RETRIEVAL_GUIDE),
    thinkingLevel: 'HIGH',
    includeThoughts: false,
    maxOutputTokens: 65536,
  };
  if (
    !configOk.labels_exact ||
    JSON.stringify(configOk.bible_refs) !== JSON.stringify(configOk.bible_refs_expected) ||
    !configOk.john_5_12_absent ||
    !configOk.old_5_10_absent ||
    !configOk.new_guide_present
  ) {
    throw new Error('Refusing generateContent: approved Chunk 1 configuration check failed ' + JSON.stringify(configOk));
  }

  if (!fs.existsSync(KEY_FILE)) throw new Error('Missing Key.secure.txt');
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });
  const schema = buildCompactResponseSchema();
  const started = Date.now();
  let response = null;
  let generateError = null;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      config: {
        systemInstruction: system,
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false },
      },
    });
  } catch (err) {
    generateError = String(err && err.message ? err.message : err);
  }

  const text =
    (response && response.text) ||
    (response &&
      response.candidates &&
      response.candidates[0] &&
      response.candidates[0].content &&
      response.candidates[0].content.parts
      ? response.candidates[0].content.parts.map((p) => p.text || '').join('')
      : '') ||
    '';
  const usage = (response && response.usageMetadata) || {};
  const finishReason =
    (response && response.candidates && response.candidates[0] && response.candidates[0].finishReason) ||
    (generateError ? 'ERROR' : null);
  const promptTokens = Number(usage.promptTokenCount || 0);
  const candidateTokens = Number(usage.candidatesTokenCount || 0);
  const thoughtTokens = Number(usage.thoughtsTokenCount || usage.thinkingTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || promptTokens + candidateTokens + thoughtTokens);
  const billedOutput = candidateTokens + thoughtTokens;
  const usd = estimateUsd(promptTokens, billedOutput || candidateTokens, 'standard');
  const inr = inrWithGst(usd);

  const rawTxtPath = path.join(outDir, 'phase3c3-chunk1-raw.txt');
  const rawJsonPath = path.join(outDir, 'phase3c3-chunk1-raw-response.json');
  fs.writeFileSync(rawTxtPath, text, 'utf8');
  const safetyMetadata = response ? extractGeminiSafetyMetadata(response) : null;
  const rawRecord = {
    sermon_id: sermonId,
    chunk: 1,
    model: 'gemini-3.1-pro-preview',
    api_version: 'v1beta',
    prompt_version: 'phase3c3-bible-guide-fix-1',
    finishReason,
    finishMessage: safetyMetadata && safetyMetadata.finishMessage,
    promptFeedback: safetyMetadata && safetyMetadata.promptFeedback,
    safetyRatings: safetyMetadata && safetyMetadata.safetyRatings,
    modelVersion: safetyMetadata && safetyMetadata.modelVersion,
    responseId: safetyMetadata && safetyMetadata.responseId,
    usage,
    generateError,
    text,
    ms: Date.now() - started,
    full_response: response ? jsonSafeClone(response, new Set()) : null,
  };
  fs.writeFileSync(rawJsonPath, JSON.stringify(rawRecord, null, 2), 'utf8');
  writeGeminiResponse({
    sermonId: RESPONSE_SERMON_KEY,
    requestIndex: 1,
    kind: 'generateContent_phase3c3_chunk1',
    labels: expectedLabels,
    usage,
    rawText: text,
    payload,
    fullResponse: response || undefined,
    extra: {
      finishReason,
      generateError,
      chunk: 1,
      paid_generation_requests: generateError ? 0 : 1,
      safety_metadata: safetyMetadata,
    },
  });

  const truncated = finishReason === 'MAX_TOKENS';
  let parsed = null;
  let parseError = null;
  if (!generateError && text) {
    try {
      parsed = parseJson(text);
    } catch (err) {
      parseError = String(err.message || err);
    }
  }

  const returned = (parsed && Array.isArray(parsed.paragraphs) ? parsed.paragraphs : []).map((p) => ({
    label: p && p.label != null ? String(p.label) : '',
    tamil: p && p.tamil != null ? String(p.tamil) : '',
  }));
  const returnedByLabel = new Map(returned.map((p) => [p.label, p]));
  const missing = expectedLabels.filter((lab) => !returnedByLabel.has(lab));
  const extra = returned.map((p) => p.label).filter((lab) => !expectedLabels.includes(lab));
  const duplicates = returned.map((p) => p.label).filter((lab, i, arr) => arr.indexOf(lab) !== i);
  const emptyTamil = expectedLabels.filter((lab) => {
    const hit = returnedByLabel.get(lab);
    return !hit || !String(hit.tamil || '').trim();
  });
  const orderOk = returned.length === expectedLabels.length && expectedLabels.every((lab, i) => returned[i] && returned[i].label === lab);

  const sourceParas = (payload.paragraphs || []).map((p) => ({
    paragraph_label: String(p.label),
    text: p.english,
  }));
  const translated = {
    sermon_id: sermonId,
    english_title: payload.english_title || 'Experiences',
    tamil_title: (parsed && parsed.tamil_title) || '',
    chunk: 1,
    chunk_name: 'chunk_1_header_1_50',
    incomplete: Boolean(generateError || parseError || truncated || missing.length || emptyTamil.length || !orderOk),
    quality_approved: false,
    paragraphs: sourceParas.map((sp) => {
      const hit = returnedByLabel.get(sp.paragraph_label);
      return {
        label: sp.paragraph_label,
        english: sp.text,
        tamil: hit ? hit.tamil : '',
      };
    }),
  };

  const suspicious = [];
  for (const p of translated.paragraphs) {
    const ta = String(p.tamil || '');
    const en = String(p.english || '');
    if (!ta.trim()) suspicious.push({ label: p.label, reason: 'empty_tamil' });
    else if (ta.trim() === en.trim()) suspicious.push({ label: p.label, reason: 'tamil_equals_english' });
    else if (!/[\u0B80-\u0BFF]/.test(ta)) suspicious.push({ label: p.label, reason: 'no_tamil_script' });
    else if (en.length > 400 && ta.length < en.length * 0.25) {
      suspicious.push({ label: p.label, reason: 'tamil_unusually_short_vs_english' });
    }
  }

  const jsonValid = Boolean(parsed) && !parseError;
  const all51 =
    jsonValid &&
    orderOk &&
    missing.length === 0 &&
    extra.length === 0 &&
    duplicates.length === 0 &&
    emptyTamil.length === 0 &&
    !truncated;
  const status = generateError
    ? 'failed_api'
    : truncated
      ? 'truncated'
      : parseError
        ? 'incomplete_json'
        : all51
          ? 'complete_unreviewed'
          : 'incomplete_structure';

  const jsonPath = path.join(outDir, 'phase3c3-chunk1-translation.json');
  const htmlPath = path.join(outDir, 'phase3c3-chunk1-preview.html');
  fs.writeFileSync(jsonPath, JSON.stringify(translated, null, 2), 'utf8');
  fs.writeFileSync(
    htmlPath,
    toHtml(
      { id: sermonId, title: (payload.english_title || 'Experiences') + ' — Chunk 1 (header–50) draft' },
      translated
    ),
    'utf8'
  );

  const report = {
    phase: '3C.3',
    mode: 'chunk1_generateContent_once',
    generated_at: new Date().toISOString(),
    sermon_id: sermonId,
    english_title: payload.english_title || 'Experiences',
    chunk: 1,
    chunk2_executed: false,
    generateContent_called: !generateError,
    paid_generation_requests: generateError ? 0 : 1,
    automatic_retries: false,
    gcs: false,
    context_cache: false,
    batch_api: false,
    database_writes: false,
    source_of_truth_modified: false,
    baseline_not_overwritten: true,
    quality_approved: false,
    note: 'Draft for inspection. Translation quality is not approved.',
    configuration_used: {
      model: 'gemini-3.1-pro-preview',
      api_version: 'v1beta',
      prompt_version: 'phase3c3-bible-guide-fix-1',
      temperature: 0.1,
      maxOutputTokens: 65536,
      thinkingLevel: 'HIGH',
      includeThoughts: false,
      compact_tamil_output: true,
      hashes: liveHashes,
      hashes_match_preflight: true,
    },
    config_verification: configOk,
    finishReason,
    truncated,
    generateError,
    parseError,
    status,
    usage: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      thoughtsTokenCount: thoughtTokens,
      totalTokenCount: totalTokens,
      billed_output_tokens_candidates_plus_thoughts: billedOutput,
      raw: usage,
    },
    cost_estimate: {
      usd_inr: USD_INR,
      gst_rate: GST_RATE,
      billed_input_tokens: promptTokens,
      billed_output_tokens: billedOutput,
      usd: Number(usd.toFixed(6)),
      inr_gst: Number(inr.toFixed(2)),
    },
    validation: {
      json_parse_ok: jsonValid,
      expected_count: 51,
      returned_count: returned.length,
      all_51_present_exactly_once_in_order: all51,
      missing_labels: missing,
      extra_labels: extra,
      duplicate_labels: duplicates,
      empty_tamil_labels: emptyTamil,
      order_ok: orderOk,
    },
    suspicious_translation: suspicious,
    artifacts: {
      rawTxtPath,
      rawJsonPath,
      jsonPath,
      htmlPath,
      systemPath,
      payloadPath,
      responses_dir: path.join(RESPONSES_DIR, RESPONSE_SERMON_KEY),
    },
    stop: true,
    chunk2_not_authorized: true,
  };

  const jsonReportPath = path.join(outDir, 'phase3c3-chunk1-execution-report.json');
  const mdReportPath = path.join(outDir, 'phase3c3-chunk1-execution-report.md');
  const md = [
    '# Phase 3C.3 — Chunk 1 generateContent — 47-1207 Experiences',
    '',
    'Generated: ' + report.generated_at,
    '',
    '**Exactly one paid generateContent request. Chunk 2 was not executed. No retries.**',
    '',
    '## Status',
    '- Result: **' + status + '**',
    '- finishReason: **' + String(finishReason) + '**',
    '- Truncated: **' + truncated + '**',
    '- JSON parse: **' + jsonValid + '**',
    '- All 51 records present exactly once in order: **' + all51 + '**',
    '- Translation quality approved: **false** (requires review)',
    '',
    '## Tokens',
    '| Item | Count |',
    '| --- | ---: |',
    '| Input (prompt) | ' + promptTokens + ' |',
    '| Visible output (candidates) | ' + candidateTokens + ' |',
    '| Thinking | ' + thoughtTokens + ' |',
    '| Total | ' + totalTokens + ' |',
    '| Billed output (candidates + thinking) | ' + billedOutput + ' |',
    '',
    '## Cost (estimated, Standard, GST 18%)',
    '- USD: **$' + usd.toFixed(6) + '**',
    '- INR + GST: **₹' + inr.toFixed(2) + '**',
    '',
    '## Coverage',
    '- Expected labels: header + 1–50 (51)',
    '- Returned: ' + returned.length,
    '- Missing: ' + (missing.length ? missing.join(', ') : 'none'),
    '- Extra: ' + (extra.length ? extra.join(', ') : 'none'),
    '- Duplicates: ' + (duplicates.length ? duplicates.join(', ') : 'none'),
    '- Empty Tamil: ' + (emptyTamil.length ? emptyTamil.join(', ') : 'none'),
    '',
    '## Suspicious (review, not auto-fail of the run)',
    suspicious.length
      ? suspicious.map((s) => '- `' + s.label + '`: ' + s.reason).join('\n')
      : '- None flagged by heuristics.',
    '',
    '## Confirmation',
    '- Paid generation requests: **' + report.paid_generation_requests + '**',
    '- Chunk 2 executed: **false**',
    '- Automatic retries: **false**',
    '- GCS / cache / Batch: **false**',
    '- DB / source-of-truth writes: **false**',
    '- Baseline not overwritten: **true**',
    '',
    '## Artifacts',
    '- Translation JSON: `' + jsonPath + '`',
    '- Preview HTML: `' + htmlPath + '`',
    '- Raw text: `' + rawTxtPath + '`',
    '- Raw response: `' + rawJsonPath + '`',
    '',
    '## Stop',
    'No further generation. Chunk 2 requires separate explicit approval.',
    '',
    generateError ? '## API error\n\n' + generateError + '\n' : '',
    parseError ? '## JSON parse error\n\n' + parseError + '\n' : '',
  ].join('\n');
  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdReportPath, md, 'utf8');

  return {
    report,
    summary: {
      mode: 'phase3c3-generate-chunk1',
      sermon_id: sermonId,
      status,
      finishReason,
      paid_generation_requests: report.paid_generation_requests,
      chunk2_executed: false,
      all_51: all51,
      promptTokenCount: promptTokens,
      candidatesTokenCount: candidateTokens,
      thoughtsTokenCount: thoughtTokens,
      totalTokenCount: totalTokens,
      inr_gst: Number(inr.toFixed(2)),
      jsonPath,
      htmlPath,
      jsonReportPath,
      mdReportPath,
      quality_approved: false,
    },
  };
}

async function main() {
  if (PHASE3C3_GENERATE_CHUNK1) {
    if (ARGS.includes('--generate') || PHASE3_BENCHMARK || PHASE3C_FAMILY) {
      console.error('Phase 3C.3 Chunk 1 generate is exclusive. Do not combine with other flags.');
      process.exit(2);
    }
    const result = await runPhase3c3Chunk1Generate();
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }
  if (ARCHIVE_SOURCE) {
    const verified = await verifyInputs();
    if (!verified.sermon || !verified.paras.length) {
      console.error(JSON.stringify({ archive_failed: verified.checks.filter((c) => !c.ok) }, null, 2));
      process.exit(1);
    }
    const sourcePaths = writeEnglishSourceArchive(verified.sermon, verified.paras);
    const responses = archiveExistingPilotResponses(SERMON_ID);
    console.log(
      JSON.stringify(
        {
          mode: 'archive-source',
          sermon_id: SERMON_ID,
          english_source: sourcePaths,
          responses,
        },
        null,
        2
      )
    );
    return;
  }
  if (EXPORT_TEXT) {
    const existing = path.join(OUT_DIR, `sermon_${SERMON_ID}.en-ta.json`);
    if (!fs.existsSync(existing)) throw new Error('No translation JSON to export: ' + existing);
    const translated = JSON.parse(fs.readFileSync(existing, 'utf8'));
    const paths = writeSermonTextFiles(translated);
    const verified = await verifyInputs();
    const sourcePaths =
      verified.sermon && verified.paras.length
        ? writeEnglishSourceArchive(verified.sermon, verified.paras)
        : null;
    const responses = archiveExistingPilotResponses(SERMON_ID);
    console.log(JSON.stringify({ mode: 'export-text', ...paths, english_source: sourcePaths, responses }, null, 2));
    return;
  }
  if (PHASE3B_PREFLIGHT || PHASE3C_FAMILY) {
    // handled below after verifyInputs — no generateContent
  } else if (!PREFLIGHT && !GENERATE) {
    console.error(
      'Pass --preflight, --phase3b-preflight, --phase3c-preflight, --phase3c1-preflight, --phase3c2-preflight, --phase3c3-preflight, --export-text, --archive-source, --generate, or --phase3-benchmark.'
    );
    process.exit(2);
  }
  if ((GENERATE || PHASE3B_PREFLIGHT || PHASE3C_FAMILY) && PREFLIGHT) {
    console.error('Use only one mode: --preflight, --phase3b-preflight, --phase3c-preflight, --phase3c1-preflight, --phase3c2-preflight, --phase3c3-preflight, or --generate.');
    process.exit(2);
  }
  if ((PHASE3B_PREFLIGHT || PHASE3C_FAMILY) && GENERATE) {
    console.error('Phase 3B/3C/3C.1/3C.2/3C.3 preflight is configuration-only. Do not combine with --generate.');
    process.exit(2);
  }
  if (PHASE3_BENCHMARK) {
    console.log(
      JSON.stringify(
        {
          mode: 'phase3-benchmark',
          note: 'Baseline pilot files will not be overwritten. Output goes to phase3_benchmark/.',
          baseline_dir: BASELINE_DIR,
          out_dir: OUT_DIR,
          response_key: RESPONSE_SERMON_KEY,
        },
        null,
        2
      )
    );
  }

  const verified = await verifyInputs();
  if (!verified.all_ok) {
    const failed = verified.checks.filter((c) => !c.ok);
    console.error(JSON.stringify({ input_verification_failed: failed }, null, 2));
    if (!verified.sermon || !verified.paras.length) process.exit(1);
  }

  const { sermon, paras } = verified;
  const englishSourcePaths = writeEnglishSourceArchive(sermon, paras);
  const knowledge = compactKnowledge();
  if (knowledge.counts.approved_examples !== 36) {
    throw new Error('Compact approved examples must be exactly 36, got ' + knowledge.counts.approved_examples);
  }
  const bodyText = paras.map((p) => p.text).join('\n');
  const sermonHash = sha256Text(JSON.stringify({ id: SERMON_ID, title: sermon.title, paragraphs: paras.map((p) => ({ label: p.paragraph_label, text: p.text })) }));
  const knowledgeHash = sha256Text(JSON.stringify(knowledge));
  const bibleReport = await retrieveBiblePairs(bodyText);

  if (PREFLIGHT) {
    const inputReport = {
      all_ok: verified.all_ok,
      checks: verified.checks,
    };
    const { report, jsonPath, mdPath, componentPath, biblePath } = await runPreflight({
      sermon,
      paras,
      knowledge,
      bibleReport,
      knowledgeHash,
      sermonHash,
    });
    report.input_verification = inputReport;
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(mdPath, renderPreflightMd(report), 'utf8');
    console.log(
      JSON.stringify(
        {
          mode: 'preflight',
          phase: '2B',
          sermon_id: SERMON_ID,
          input_ok: verified.all_ok,
          system_tokens: report.tokens.system,
          total_input_tokens: report.tokens.total_input,
          estimated_output: report.tokens.estimated_output_with_json,
          maxOutputTokens_sufficient: report.tokens.maxOutputTokens_sufficient,
          prefer_single_request: report.chunking.prefer_single_request,
          standard_inr_gst: report.cost_estimate.single_request.standard_inr_gst,
          bible_pairs: bibleReport.pairs.length,
          bible_failures: bibleReport.failures.length,
          jsonPath,
          mdPath,
          componentPath,
          biblePath,
          english_source: englishSourcePaths,
        },
        null,
        2
      )
    );
    return;
  }

  if (PHASE3B_PREFLIGHT) {
    const result = await runPhase3bPreflight({
      sermon,
      paras,
      knowledge,
      bibleReport,
      knowledgeHash,
      sermonHash,
      verified,
    });
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }

  if (PHASE3C_FAMILY) {
    const result = await runPhase3cExecutionPreflight({
      sermon,
      paras,
      knowledge,
      knowledgeHash,
      sermonHash,
      verified,
      phase: PHASE3C3_PREFLIGHT ? '3C3' : PHASE3C2_PREFLIGHT ? '3C2' : PHASE3C1_PREFLIGHT ? '3C1' : '3C',
    });
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }

  // generate path (blocked unless --generate). Architecture preserved.
  if (!fs.existsSync(KEY_FILE)) throw new Error('Missing Key.secure.txt');
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const system = buildSystemPrompt(knowledge, bibleReport);
  const jsonSchema = COMPACT_TAMIL_OUTPUT ? buildCompactResponseSchema() : buildFullResponseSchema();

  function salvageParagraphs(raw) {
    const out = [];
    const re =
      /\{\s*"label"\s*:\s*"([^"]*)"\s*,\s*"english"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"tamil"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g;
    let m;
    while ((m = re.exec(raw || ''))) {
      out.push({
        label: m[1],
        english: JSON.parse('"' + m[2] + '"'),
        tamil: JSON.parse('"' + m[3] + '"'),
      });
    }
    return out;
  }

  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: API_VERSION } });
  const started = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const englishOnlyEst = Math.ceil(
    paras.reduce((n, p) => n + String(p.text || '').length / 4, 0) * TAMIL_OUT_RATIO +
      paras.reduce((n, p) => n + String(p.text || '').length / 4, 0) * 0.15 +
      200
  );
  // Phase 3 / 3B: always one complete request; no chunking; no auto-retry.
  // 54-0812-style generate: chunk when the full-sermon visible estimate exceeds maxOutputTokens.
  const useSingleRequest = PHASE3_BENCHMARK || USE_PHASE3B_OUTPUT_CONFIG ? true : englishOnlyEst <= MAX_OUTPUT_TOKENS;
  const thinkingReserve = !THINKING_LEVEL
    ? 0
    : THINKING_LEVEL === 'HIGH'
      ? THINKING_HIGH_RESERVE
      : Math.ceil(THINKING_HIGH_RESERVE / 2);

  function chunkVisibleEstimate(chunk) {
    const englishTok = Math.ceil(chunk.reduce((n, p) => n + String(p.text || '').length / 4, 0));
    const compactOverhead = chunk.length * 12 + 80;
    const fullOverhead = Math.ceil(englishTok * 0.15) + compactOverhead;
    return Math.ceil(englishTok * TAMIL_OUT_RATIO) + (COMPACT_TAMIL_OUTPUT ? compactOverhead : fullOverhead);
  }

  // Pre-generation output budget gate: full sermon if one request, otherwise the largest chunk.
  {
    const sampleChunk = useSingleRequest
      ? paras
      : paras.slice(0, Math.min(PARA_CHUNK, paras.length));
    assertOutputBudgetSufficient({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
      estimatedVisibleOutput: chunkVisibleEstimate(sampleChunk),
      thinkingReserve,
      safetyMargin: OUTPUT_SAFETY_MARGIN,
      blockGenerate: true,
    });
  }

  async function translateRequest(chunk, requestIndex, mode) {
    const payload =
      mode === 'full'
        ? buildUserRequest(sermon, chunk)
        : {
            sermon_id: SERMON_ID,
            english_title: sermon.title,
            date: sermon.date,
            location: sermon.location,
            chunk: requestIndex,
            total_chunks: useSingleRequest ? 1 : Math.ceil(paras.length / PARA_CHUNK),
            paragraphs: chunk.map((p) => ({
              label: p.paragraph_label,
              english: p.text,
            })),
          };
    const userIntro = COMPACT_TAMIL_OUTPUT
      ? mode === 'full'
        ? 'Translate this complete English sermon into Tamil. Keep every label in order. Return compact JSON: {"sermon_id","tamil_title","paragraphs":[{"label","tamil"}]}. Do not repeat English paragraph text in the response. Do not summarize or add explanations. Preserve cadence, repetitions, and editor gaps like ...?... .\n\n'
        : 'Translate these sermon paragraphs into Tamil. Keep every label. Return compact JSON paragraphs:[{"label","tamil"}] only. Do not repeat English.\n\n'
      : mode === 'full'
        ? 'Translate this complete English sermon into Tamil. Keep every label. Output JSON: {"sermon_id","english_title","tamil_title","paragraphs":[{"label","english","tamil"}]}.\n\n'
        : 'Translate these sermon paragraphs into Tamil. Keep every label. Output JSON with paragraphs array only for this chunk.\n\n';
    const rawPath = path.join(OUT_DIR, mode === 'full' ? 'raw_full.txt' : `raw_chunk_${requestIndex}.txt`);
    let response = null;
    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: 'user',
            parts: [{ text: userIntro + JSON.stringify(payload) }],
          },
        ],
        config: {
          systemInstruction: system,
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: jsonSchema,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...buildThinkingConfig(),
        },
      });
    } catch (err) {
      writeGeminiResponse({
        sermonId: RESPONSE_SERMON_KEY,
        requestIndex,
        kind: mode === 'full' ? 'generateContent_full' : 'generateContent',
        labels: chunk.map((p) => p.paragraph_label),
        usage: {},
        rawText: '',
        payload,
        extra: {
          phase3_benchmark: PHASE3_BENCHMARK,
          generate_error: String(err && err.message ? err.message : err),
        },
      });
      fs.writeFileSync(
        path.join(OUT_DIR, `failed_request_${requestIndex}.json`),
        JSON.stringify({ status: 'failed', error: String(err && err.message ? err.message : err) }, null, 2)
      );
      return {
        parsed: null,
        usage: {},
        rawPath,
        ok: false,
        finishReason: null,
        error: String(err && err.message ? err.message : err),
      };
    }
    const text =
      response.text ||
      (response.candidates && response.candidates[0] && response.candidates[0].content
        ? response.candidates[0].content.parts.map((p) => p.text || '').join('')
        : '');
    const finishReason =
      response.candidates && response.candidates[0] && response.candidates[0].finishReason
        ? response.candidates[0].finishReason
        : null;
    fs.writeFileSync(rawPath, text || '', 'utf8');
    writeGeminiResponse({
      sermonId: RESPONSE_SERMON_KEY,
      requestIndex,
      kind: mode === 'full' ? 'generateContent_full' : 'generateContent',
      labels: chunk.map((p) => p.paragraph_label),
      usage: response.usageMetadata || {},
      rawText: text || '',
      payload,
      fullResponse: response,
      extra: {
        phase3_benchmark: PHASE3_BENCHMARK,
        finishReason,
        safety_metadata: extractGeminiSafetyMetadata(response),
      },
    });
    if (!String(text || '').trim() || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'SAFETY') {
      fs.writeFileSync(
        path.join(OUT_DIR, `failed_request_${requestIndex}.json`),
        JSON.stringify(
          {
            status: 'failed',
            error: finishReason || 'empty_response',
            raw_path: rawPath,
            labels: chunk.map((p) => p.paragraph_label),
          },
          null,
          2
        )
      );
      return {
        parsed: null,
        usage: response.usageMetadata || {},
        rawPath,
        ok: false,
        finishReason,
        error: finishReason || 'empty_response',
      };
    }
    try {
      return {
        parsed: parseJson(text),
        usage: response.usageMetadata || {},
        rawPath,
        ok: true,
        finishReason,
      };
    } catch (err) {
      const salvaged = salvageParagraphs(text);
      fs.writeFileSync(
        path.join(OUT_DIR, `failed_request_${requestIndex}.json`),
        JSON.stringify(
          {
            status: salvaged.length ? 'partial_salvage' : 'failed',
            error: String(err.message || err),
            raw_path: rawPath,
            salvaged_count: salvaged.length,
          },
          null,
          2
        )
      );
      if (salvaged.length) {
        return {
          parsed: { paragraphs: salvaged },
          usage: response.usageMetadata || {},
          rawPath,
          ok: true,
          finishReason,
          salvaged: true,
        };
      }
      return {
        parsed: null,
        usage: response.usageMetadata || {},
        rawPath,
        ok: false,
        finishReason,
        error: String(err.message || err),
      };
    }
  }

  const byLabel = new Map();
  const usages = [];
  const rawPaths = [];
  const chunkErrors = [];
  let lastParsed = null;
  try {
    if (useSingleRequest) {
      console.log('translating full sermon in one request', paras.length, 'paragraphs', {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingLevel: THINKING_LEVEL || null,
        compact: COMPACT_TAMIL_OUTPUT,
      });
      const result = await translateRequest(paras, 1, 'full');
      lastParsed = result.parsed;
      usages.push(result.usage);
      rawPaths.push(result.rawPath);
      if (!result.ok) {
        chunkErrors.push({
          request_index: 1,
          labels: paras.map((p) => p.paragraph_label),
          finishReason: result.finishReason,
          error: result.error,
        });
      } else {
        for (const p of (result.parsed && result.parsed.paragraphs) || []) byLabel.set(p.label, p);
        if (result.parsed && result.parsed.tamil_title) {
          byLabel.set('__tamil_title__', { tamil: result.parsed.tamil_title });
        }
      }
    } else {
      const totalChunks = Math.ceil(paras.length / PARA_CHUNK);
      for (let i = 0; i < paras.length; i += PARA_CHUNK) {
        const chunk = paras.slice(i, i + PARA_CHUNK);
        const chunkIndex = Math.floor(i / PARA_CHUNK) + 1;
        console.log(
          'translating chunk',
          chunkIndex + '/' + totalChunks,
          chunk.map((p) => p.paragraph_label).join(',')
        );
        const result = await translateRequest(chunk, chunkIndex, 'chunk');
        usages.push(result.usage);
        rawPaths.push(result.rawPath);
        if (!result.ok) {
          chunkErrors.push({
            request_index: chunkIndex,
            labels: chunk.map((p) => p.paragraph_label),
            finishReason: result.finishReason,
            error: result.error,
          });
          continue;
        }
        for (const p of (result.parsed && result.parsed.paragraphs) || []) byLabel.set(p.label, p);
        if (result.parsed && result.parsed.tamil_title) {
          byLabel.set('__tamil_title__', { tamil: result.parsed.tamil_title });
        }
      }
    }

    const titleHit = byLabel.get('__tamil_title__');
    const translated = COMPACT_TAMIL_OUTPUT && lastParsed
      ? mergeCompactTranslation(paras, sermon, lastParsed)
      : {
          sermon_id: SERMON_ID,
          english_title: sermon.title,
          tamil_title:
            (titleHit && titleHit.tamil) ||
            (byLabel.get('header') && byLabel.get('header').tamil) ||
            '',
          paragraphs: paras.map((p) => {
            const hit = byLabel.get(p.paragraph_label);
            return {
              label: p.paragraph_label,
              english: p.text,
              tamil: hit ? hit.tamil : '',
            };
          }),
        };
    const validation = validateTranslation(paras, translated, rawPaths.join(';'));
    const usage = usages.reduce(
      (a, u) => ({
        promptTokenCount: (a.promptTokenCount || 0) + (u.promptTokenCount || 0),
        candidatesTokenCount: (a.candidatesTokenCount || 0) + (u.candidatesTokenCount || 0),
        totalTokenCount: (a.totalTokenCount || 0) + (u.totalTokenCount || 0),
        cachedContentTokenCount: (a.cachedContentTokenCount || 0) + (u.cachedContentTokenCount || 0),
      }),
      {}
    );
    const meta = {
      sermon_id: SERMON_ID,
      title: sermon.title,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      hashes: {
        source_sermon: sermonHash,
        knowledge_package: knowledgeHash,
        prompt_version: sha256Text(PROMPT_VERSION),
      },
      english_paragraphs: paras.length,
      tamil_paragraphs: (translated.paragraphs || []).length,
      bible_pairs_injected: bibleReport.pairs.length,
      ms: Date.now() - started,
      usage,
      estimated_usd_standard: estimateUsd(usage.promptTokenCount || 0, usage.candidatesTokenCount || 0, 'standard'),
      estimated_inr_gst: inrWithGst(
        estimateUsd(usage.promptTokenCount || 0, usage.candidatesTokenCount || 0, 'standard')
      ),
      validation,
      chunk_errors: chunkErrors,
      translated_count: (translated.paragraphs || []).filter((p) => String(p.tamil || '').trim()).length,
      note: PHASE3_BENCHMARK
        ? 'Phase 3 quality benchmark (Phase 2B prompt). Baseline pilot preserved. Not copied to source_of_truth.'
        : 'Pilot draft. Not copied to source_of_truth or approved 419.',
      phase3_benchmark: PHASE3_BENCHMARK,
      baseline_dir: PHASE3_BENCHMARK ? BASELINE_DIR : null,
    };

    if (!validation.ok) {
      fs.writeFileSync(path.join(OUT_DIR, 'translation-failed.json'), JSON.stringify(meta, null, 2), 'utf8');
    }

    const jsonPath = path.join(OUT_DIR, `sermon_${SERMON_ID}.en-ta.json`);
    const htmlPath = path.join(OUT_DIR, `sermon_${SERMON_ID}.preview.html`);
    let textPaths;
    if (PHASE3_BENCHMARK) {
      const biPath = path.join(
        OUT_DIR,
        [SERMON_ID, safeFilePart(sermon.title)].filter(Boolean).join(' ') + '.en-ta.txt'
      );
      const taPath = path.join(
        OUT_DIR,
        [SERMON_ID, safeFilePart(translated.tamil_title || sermon.title)].filter(Boolean).join(' ') + '.ta.txt'
      );
      const bilingual = [SERMON_ID, translated.english_title || '', translated.tamil_title || '', ''];
      for (const p of translated.paragraphs || []) {
        bilingual.push('----- ' + (p.label || '') + ' -----');
        bilingual.push('ENGLISH:');
        bilingual.push(p.english || '');
        bilingual.push('');
        bilingual.push('TAMIL:');
        bilingual.push(p.tamil || '');
        bilingual.push('');
      }
      const tamilOnly = [SERMON_ID, translated.tamil_title || '', ''];
      for (const p of translated.paragraphs || []) {
        tamilOnly.push(p.tamil || '');
        tamilOnly.push('');
      }
      fs.writeFileSync(biPath, bilingual.join('\n'), 'utf8');
      fs.writeFileSync(taPath, tamilOnly.join('\n'), 'utf8');
      textPaths = { bilingual: biPath, tamil_only: taPath, shared_folders_written: false };
    } else {
      textPaths = writeSermonTextFiles(translated);
    }
    const combinedRaw = (rawPaths || [])
      .map((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''))
      .join('\n\n---------- CHUNK ----------\n\n');
    const combinedPath = path.join(RESPONSES_DIR, RESPONSE_SERMON_KEY, 'combined-raw.txt');
    fs.mkdirSync(path.dirname(combinedPath), { recursive: true });
    fs.writeFileSync(combinedPath, combinedRaw, 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'raw_full.txt'), combinedRaw, 'utf8');
    fs.writeFileSync(jsonPath, JSON.stringify(translated, null, 2), 'utf8');
    fs.writeFileSync(htmlPath, toHtml(sermon, translated), 'utf8');
    fs.writeFileSync(
      path.join(OUT_DIR, 'run-meta.json'),
      JSON.stringify({ ...meta, out_json: jsonPath, out_html: htmlPath, ...textPaths }, null, 2),
      'utf8'
    );
    console.log(
      JSON.stringify(
        {
          sermon_id: SERMON_ID,
          phase3_benchmark: PHASE3_BENCHMARK,
          validation: validation.status,
          translated_count: meta.translated_count,
          chunk_errors: chunkErrors,
          jsonPath,
          htmlPath,
          bilingual_txt: textPaths.bilingual,
          tamil_only_txt: textPaths.tamil_only,
          english_source: englishSourcePaths,
          responses_dir: path.join(RESPONSES_DIR, RESPONSE_SERMON_KEY),
          baseline_untouched: PHASE3_BENCHMARK,
          usage,
        },
        null,
        2
      )
    );
  } catch (e) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'translation-failed.json'),
      JSON.stringify({ status: 'failed', error: String(e.message || e), raw_paths: rawPaths }, null, 2)
    );
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
