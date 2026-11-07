/**
 * Phase 1.6 — Second Pure Corpus from BRD-David databases.
 * Read-only on all source SQLite files. No GCS / Gemini API calls.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = __dirname;
const OUT_ROOT = path.join(ROOT, 'second_corpus');
const BIBLE_OUT = path.join(OUT_ROOT, 'bible');
const SERMONS_PAIRED = path.join(OUT_ROOT, 'sermons', 'paired');
const SERMONS_DOC = path.join(OUT_ROOT, 'sermons', 'document-level');
const SERMONS_DIR = path.join(OUT_ROOT, 'sermons');

const PATHS = {
  bibleEn: 'd:/Freelancing/BRD-David/server/data/bible_en.sqlite',
  bibleTa: 'd:/Freelancing/BRD-David/server/data/bible-new.sqlite',
  messagesEn: 'd:/Freelancing/BRD-David/server/data/english_messages.sqlite',
  messagesTa: 'd:/Freelancing/BRD-David/server/data/messages.sqlite',
  existingJsonDir: path.join(ROOT, 'dataset'),
};

/** Minimum primary numbered paragraphs required for paragraph-level alignment. */
const MIN_NUMBERED_PRIMARY = 5;

function ensureDirs() {
  for (const d of [OUT_ROOT, BIBLE_OUT, SERMONS_PAIRED, SERMONS_DOC, SERMONS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function openDb(dbPath) {
  return new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Normalize sermon codes: 47-04-12 / 47-0412 / 60-06-11E / 60-0611E -> YY-MMDD[S] */
function normalizeSermonCode(name) {
  if (!name) return null;
  const m = String(name)
    .trim()
    .toUpperCase()
    .match(/^(\d{2})-(\d{2})-?(\d{2})([A-Z]?)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}${m[3]}${m[4] || ''}`;
}

function decodeEntities(html) {
  return html
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function splitHtmlParagraphs(html) {
  if (!html) return [];
  const parts = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[1]);
    if (text) parts.push(text);
  }
  // Fallback if no <p> tags
  if (parts.length === 0) {
    const plain = stripTags(html);
    if (plain) parts.push(plain);
  }
  return parts;
}

/**
 * Assign paragraph labels.
 * Numbered blocks: "1. text" -> label "1"
 * Continuations after N: "1.1", "1.2", ...
 * Header-only (title / code) before first number stay label null and are skipped later.
 */
function assignLabels(texts) {
  const out = [];
  let cur = null;
  let cont = 0;
  for (const t of texts) {
    const m = t.match(/^(\d+)\s*[.:)\]]\s*(.*)$/);
    if (m) {
      cur = m[1];
      cont = 0;
      const body = (m[2] || '').trim();
      out.push({ label: cur, text: body || t, continuation: false });
    } else if (cur) {
      cont += 1;
      out.push({ label: `${cur}.${cont}`, text: t, continuation: true });
    } else {
      out.push({ label: null, text: t, continuation: false });
    }
  }
  return out;
}

function isHeaderOnly(text, sermonId) {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 80 && /^[\d\-A-Za-z]+$/.test(t.replace(/\s/g, ''))) return true;
  const code = normalizeSermonCode(t);
  if (code && code === sermonId) return true;
  // Bare sermon id like 47-0412
  if (t.toUpperCase() === sermonId) return true;
  return false;
}

function mapByLabel(paras) {
  const map = new Map();
  for (const p of paras) {
    if (!p.label) continue;
    if (!map.has(p.label)) map.set(p.label, p);
  }
  return map;
}

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

async function buildBibleCorpus(report) {
  console.log('Building Bible verse pairs...');
  const enDb = openDb(PATHS.bibleEn);
  const taDb = openDb(PATHS.bibleTa);

  const enRows = await all(
    enDb,
    'SELECT Book, Chapter, Versecount, verse, title FROM bible ORDER BY Book, Chapter, Versecount'
  );
  const taRows = await all(
    taDb,
    'SELECT Book, Chapter, Versecount, verse, title FROM bible ORDER BY Book, Chapter, Versecount'
  );
  const enTitles = await all(enDb, 'SELECT id, title FROM titles');
  const taTitles = await all(taDb, 'SELECT id, title FROM titles');

  const taMap = new Map();
  for (const r of taRows) {
    taMap.set(`${r.Book}|${r.Chapter}|${r.Versecount}`, r);
  }

  const enTitleById = new Map(enTitles.map((t) => [t.id, t.title]));
  const taTitleById = new Map(taTitles.map((t) => [t.id, t.title]));

  const outPath = path.join(BIBLE_OUT, 'verses.jsonl');
  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });

  let written = 0;
  let emptyEn = 0;
  let emptyTa = 0;
  let missingTa = 0;
  const failedSamples = [];

  for (const e of enRows) {
    const key = `${e.Book}|${e.Chapter}|${e.Versecount}`;
    const t = taMap.get(key);
    const english = (e.verse || '').trim();
    const tamil = t ? (t.verse || '').trim() : '';

    if (!t) {
      missingTa += 1;
      if (failedSamples.length < 20) failedSamples.push({ key, reason: 'missingTamilRow' });
      continue;
    }
    if (!english) {
      emptyEn += 1;
      if (failedSamples.length < 20) failedSamples.push({ key, reason: 'emptyEnglish' });
      continue;
    }
    if (!tamil) {
      emptyTa += 1;
      if (failedSamples.length < 20) failedSamples.push({ key, reason: 'emptyTamil' });
      continue;
    }

    // bible.Book is 0-based; titles.id is 1-based
    const titleId = Number(e.Book) + 1;
    const rec = {
      book: e.Book,
      chapter: e.Chapter,
      verse: e.Versecount,
      english,
      tamil,
      en_title: e.title || enTitleById.get(titleId) || null,
      ta_title: t.title || taTitleById.get(titleId) || null,
    };
    stream.write(JSON.stringify(rec) + '\n');
    written += 1;
  }

  await new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });

  report.bible = {
    englishRows: enRows.length,
    tamilRows: taRows.length,
    expected: 31102,
    writtenComplete: written,
    emptyEnglish: emptyEn,
    emptyTamil: emptyTa,
    missingTamilJoin: missingTa,
    failedSamples,
    outputFile: path.relative(ROOT, outPath),
    outputBytes: fs.statSync(outPath).size,
  };

  await closeDb(enDb);
  await closeDb(taDb);
  console.log(`  Bible complete pairs written: ${written}`);
}

async function loadMessages(dbPath) {
  const db = openDb(dbPath);
  const rows = await all(db, 'SELECT id, name, message, is_hidden FROM messages');
  await closeDb(db);
  return rows;
}

function existingJsonIds() {
  if (!fs.existsSync(PATHS.existingJsonDir)) return new Set();
  return new Set(
    fs
      .readdirSync(PATHS.existingJsonDir)
      .filter((f) => f.startsWith('sermon_') && f.endsWith('.json'))
      .map((f) => f.replace(/^sermon_/, '').replace(/\.json$/, '').toUpperCase())
  );
}

async function buildSermonCorpus(report) {
  console.log('Loading English and Tamil messages...');
  const enRows = await loadMessages(PATHS.messagesEn);
  const taRows = await loadMessages(PATHS.messagesTa);

  const enByCode = new Map();
  const taByCode = new Map();
  const enNoCode = [];
  const taNoCode = [];

  for (const r of enRows) {
    const code = normalizeSermonCode(r.name);
    if (!code) {
      enNoCode.push({ id: r.id, name: r.name });
      continue;
    }
    if (!enByCode.has(code)) enByCode.set(code, r);
  }
  for (const r of taRows) {
    const code = normalizeSermonCode(r.name);
    if (!code) {
      taNoCode.push({ id: r.id, name: r.name });
      continue;
    }
    if (!taByCode.has(code)) taByCode.set(code, r);
  }

  const pairedCodes = [];
  const unpairedEn = [];
  const unpairedTa = [];

  for (const [code, row] of enByCode) {
    if (taByCode.has(code)) pairedCodes.push(code);
    else unpairedEn.push({ sermon_id: code, db_id: row.id, name: row.name });
  }
  for (const [code, row] of taByCode) {
    if (!enByCode.has(code)) {
      unpairedTa.push({ sermon_id: code, db_id: row.id, name: row.name });
    }
  }
  pairedCodes.sort();

  fs.writeFileSync(
    path.join(SERMONS_DIR, 'unpaired-en.json'),
    JSON.stringify(unpairedEn, null, 2)
  );
  fs.writeFileSync(
    path.join(SERMONS_DIR, 'unpaired-ta.json'),
    JSON.stringify(unpairedTa, null, 2)
  );

  const jsonIds = existingJsonIds();
  let overlapJson = 0;
  let newVsJson = 0;
  for (const c of pairedCodes) {
    if (jsonIds.has(c)) overlapJson += 1;
    else newVsJson += 1;
  }

  const seenPairs = new Set();
  const perSermon = [];
  let totalComplete = 0;
  let totalIncomplete = 0;
  let totalUnmatchedEn = 0;
  let totalUnmatchedTa = 0;
  let totalDuplicates = 0;
  let documentLevelCount = 0;
  let paragraphLevelCount = 0;

  console.log(`Aligning ${pairedCodes.length} paired sermons...`);

  for (let i = 0; i < pairedCodes.length; i++) {
    const code = pairedCodes[i];
    if (i % 50 === 0) console.log(`  ${i} / ${pairedCodes.length}`);

    const enRow = enByCode.get(code);
    const taRow = taByCode.get(code);

    const enRaw = assignLabels(splitHtmlParagraphs(enRow.message));
    const taRaw = assignLabels(splitHtmlParagraphs(taRow.message));

    // Drop null-label headers (title / code lines)
    const enParas = enRaw.filter((p) => p.label || !isHeaderOnly(p.text, code));
    const taParas = taRaw.filter((p) => p.label || !isHeaderOnly(p.text, code));

    // Keep only labeled paragraphs for alignment maps
    const enLabeled = enParas.filter((p) => p.label);
    const taLabeled = taParas.filter((p) => p.label);

    const enPrimary = new Set(enLabeled.filter((p) => !p.continuation).map((p) => p.label));
    const taPrimary = new Set(taLabeled.filter((p) => !p.continuation).map((p) => p.label));
    const numberedPrimary = Math.min(enPrimary.size, taPrimary.size);

    const sermonStat = {
      sermon_id: code,
      en_name: enRow.name,
      ta_name: taRow.name,
      in_existing_json: jsonIds.has(code),
      en_paragraphs: enLabeled.length,
      ta_paragraphs: taLabeled.length,
      en_primary_numbers: enPrimary.size,
      ta_primary_numbers: taPrimary.size,
      mode: null,
      complete: 0,
      incomplete: 0,
      unmatched_en: 0,
      unmatched_ta: 0,
      duplicates: 0,
    };

    if (numberedPrimary < MIN_NUMBERED_PRIMARY) {
      // Document-level fallback — do not invent paragraph alignments
      documentLevelCount += 1;
      sermonStat.mode = 'document-level';
      const enText = stripTags(enRow.message);
      const taText = stripTags(taRow.message);
      const doc = {
        sermon_id: code,
        mode: 'document-level',
        reason: `numbered_primary_below_${MIN_NUMBERED_PRIMARY}`,
        en_primary_numbers: enPrimary.size,
        ta_primary_numbers: taPrimary.size,
        english: enText,
        tamil: taText,
      };
      fs.writeFileSync(
        path.join(SERMONS_DOC, `sermon_${code}.json`),
        JSON.stringify(doc, null, 2)
      );
      perSermon.push(sermonStat);
      continue;
    }

    paragraphLevelCount += 1;
    sermonStat.mode = 'paragraph-level';

    const enMap = mapByLabel(enLabeled);
    const taMap = mapByLabel(taLabeled);
    const allLabels = new Set([...enMap.keys(), ...taMap.keys()]);
    const completeParas = [];
    const dropped = [];

    for (const label of [...allLabels].sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) return da - db;
      }
      return 0;
    })) {
      const ep = enMap.get(label);
      const tp = taMap.get(label);
      const english = ep ? (ep.text || '').trim() : '';
      const tamil = tp ? (tp.text || '').trim() : '';

      if (!ep) {
        sermonStat.unmatched_ta += 1;
        totalUnmatchedTa += 1;
        dropped.push({ label, type: 'unmatched', side: 'tamil_only', tamil });
        continue;
      }
      if (!tp) {
        sermonStat.unmatched_en += 1;
        totalUnmatchedEn += 1;
        dropped.push({ label, type: 'unmatched', side: 'english_only', english });
        continue;
      }
      if (!english || !tamil) {
        sermonStat.incomplete += 1;
        totalIncomplete += 1;
        dropped.push({
          label,
          type: 'incomplete',
          missing: !english ? 'english' : 'tamil',
          english,
          tamil,
        });
        continue;
      }

      const pairKey = `${english}|||${tamil}`;
      if (seenPairs.has(pairKey)) {
        sermonStat.duplicates += 1;
        totalDuplicates += 1;
        dropped.push({ label, type: 'duplicate', english, tamil });
        continue;
      }
      seenPairs.add(pairKey);

      completeParas.push({
        paragraph_label: label,
        english,
        tamil,
      });
      sermonStat.complete += 1;
      totalComplete += 1;
    }

    const out = {
      sermon_id: code,
      mode: 'paragraph-level',
      source: {
        en_db_id: enRow.id,
        ta_db_id: taRow.id,
        en_name: enRow.name,
        ta_name: taRow.name,
      },
      paragraphs: completeParas,
      dropped_summary: {
        incomplete: sermonStat.incomplete,
        unmatched_en: sermonStat.unmatched_en,
        unmatched_ta: sermonStat.unmatched_ta,
        duplicates: sermonStat.duplicates,
      },
    };
    fs.writeFileSync(
      path.join(SERMONS_PAIRED, `sermon_${code}.json`),
      JSON.stringify(out, null, 2)
    );

    // Keep dropped details only in aggregate report samples to avoid huge files
    sermonStat.dropped_sample = dropped.slice(0, 5);
    perSermon.push(sermonStat);
  }

  report.sermons = {
    englishTotal: enRows.length,
    tamilTotal: taRows.length,
    enWithCode: enByCode.size,
    taWithCode: taByCode.size,
    enNoCode: enNoCode.length,
    taNoCode: taNoCode.length,
    paired: pairedCodes.length,
    unpairedEnglish: unpairedEn.length,
    unpairedTamil: unpairedTa.length,
    overlapExistingJson419: overlapJson,
    newVsExistingJson419: newVsJson,
    paragraphLevelSermons: paragraphLevelCount,
    documentLevelSermons: documentLevelCount,
    totals: {
      completePairs: totalComplete,
      incomplete: totalIncomplete,
      unmatchedEnglishOnly: totalUnmatchedEn,
      unmatchedTamilOnly: totalUnmatchedTa,
      duplicates: totalDuplicates,
    },
    perSermon,
  };

  console.log(
    `  Paired=${pairedCodes.length} paragraph-level=${paragraphLevelCount} document-level=${documentLevelCount} completePairs=${totalComplete}`
  );
}

function writeReports(report) {
  report.generatedAt = new Date().toISOString();
  report.constraints = {
    originalDbsReadOnly: true,
    noGcs: true,
    noGeminiApi: true,
    englishIsSource: true,
  };
  report.outputSizes = {
    second_corpus_bytes: dirSizeBytes(OUT_ROOT),
    bible_bytes: dirSizeBytes(BIBLE_OUT),
    sermons_paired_bytes: dirSizeBytes(SERMONS_PAIRED),
    sermons_document_level_bytes: dirSizeBytes(SERMONS_DOC),
  };

  const jsonPath = path.join(ROOT, 'second-corpus-quality-report.json');
  // Store a slim JSON (without full perSermon dump of every field if huge) — keep perSermon
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const b = report.bible;
  const s = report.sermons;
  const md = `# Second Corpus Quality Report

Generated: ${report.generatedAt}

## Bible

| Metric | Count |
| --- | ---: |
| English rows | ${b.englishRows} |
| Tamil rows | ${b.tamilRows} |
| Expected join | ${b.expected} |
| Complete pairs written | ${b.writtenComplete} |
| Empty English | ${b.emptyEnglish} |
| Empty Tamil | ${b.emptyTamil} |
| Missing Tamil join | ${b.missingTamilJoin} |
| Output file | \`${b.outputFile}\` |
| Output size (bytes) | ${b.outputBytes} |

## Sermons

| Metric | Count |
| --- | ---: |
| English messages | ${s.englishTotal} |
| Tamil messages | ${s.tamilTotal} |
| Paired by sermon code | ${s.paired} |
| Unpaired English | ${s.unpairedEnglish} |
| Unpaired Tamil | ${s.unpairedTamil} |
| Also in existing 419 JSON | ${s.overlapExistingJson419} |
| New vs 419 JSON | ${s.newVsExistingJson419} |
| Paragraph-level sermons | ${s.paragraphLevelSermons} |
| Document-level fallback | ${s.documentLevelSermons} |
| Complete paragraph pairs | ${s.totals.completePairs} |
| Incomplete pairs | ${s.totals.incomplete} |
| Unmatched English-only labels | ${s.totals.unmatchedEnglishOnly} |
| Unmatched Tamil-only labels | ${s.totals.unmatchedTamilOnly} |
| Duplicate pairs skipped | ${s.totals.duplicates} |

## Output sizes

| Path | Bytes |
| --- | ---: |
| second_corpus/ | ${report.outputSizes.second_corpus_bytes} |
| bible/ | ${report.outputSizes.bible_bytes} |
| sermons/paired/ | ${report.outputSizes.sermons_paired_bytes} |
| sermons/document-level/ | ${report.outputSizes.sermons_document_level_bytes} |

## Notes

- Original BRD-David SQLite databases were not modified.
- Existing \`dataset/\` and \`clean_dataset/\` were not modified.
- Sermons with fewer than ${MIN_NUMBERED_PRIMARY} shared primary numbered paragraphs were stored as document-level pairs only (no invented alignments).
- English is the source language; Tamil is the target.
`;

  fs.writeFileSync(path.join(ROOT, 'second-corpus-quality-report.md'), md);
  console.log('Wrote second-corpus-quality-report.json and .md');
}

async function main() {
  ensureDirs();
  const report = {};
  await buildBibleCorpus(report);
  await buildSermonCorpus(report);
  writeReports(report);
  console.log('Second pure corpus preparation complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
