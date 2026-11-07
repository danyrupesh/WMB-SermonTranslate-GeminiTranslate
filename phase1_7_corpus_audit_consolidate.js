/**
 * Phase 1.7 — Audit second corpus, compare with 419 JSON, consolidate reference categories.
 * Read-only on originals. No GCS. No Gemini generation.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const ROOT = __dirname;
const DATASET = path.join(ROOT, 'dataset');
const CLEAN = path.join(ROOT, 'clean_dataset');
const SECOND = path.join(ROOT, 'second_corpus');
const OUT = path.join(ROOT, 'consolidated_reference');
const AUDIT = path.join(OUT, 'audit');
const CAT = path.join(OUT, 'categories');

const PATHS = {
  bibleEn: 'd:/Freelancing/BRD-David/server/data/bible_en.sqlite',
  bibleTa: 'd:/Freelancing/BRD-David/server/data/bible-new.sqlite',
  messagesEn: 'd:/Freelancing/BRD-David/server/data/english_messages.sqlite',
  messagesTa: 'd:/Freelancing/BRD-David/server/data/messages.sqlite',
};

const MIN_NUMBERED_PRIMARY = 5;

function ensure(d) {
  fs.mkdirSync(d, { recursive: true });
}

function openDb(p) {
  return new sqlite3.Database(p, sqlite3.OPEN_READONLY);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));
}

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
  if (!parts.length) {
    const plain = stripTags(html);
    if (plain) parts.push(plain);
  }
  return parts;
}

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
  if (t.toUpperCase() === sermonId) return true;
  return false;
}

function normExact(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normNear(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function jaccard(a, b) {
  const wa = new Set(a.split(' ').filter(Boolean));
  const wb = new Set(b.split(' ').filter(Boolean));
  if (!wa.size && !wb.size) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  const union = wa.size + wb.size - inter;
  return union ? inter / union : 0;
}

function listJsonIds(dir, prefix = 'sermon_') {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.replace(new RegExp(`^${prefix}`), '').replace(/\.json$/, ''));
}

function writeJson(p, obj) {
  ensure(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function copyFile(src, dest) {
  ensure(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

async function verifyBible(audit) {
  console.log('Verifying Bible verse pairs...');
  const enDb = openDb(PATHS.bibleEn);
  const taDb = openDb(PATHS.bibleTa);
  const enRows = await all(enDb, 'SELECT Book, Chapter, Versecount, verse, title FROM bible');
  const taRows = await all(taDb, 'SELECT Book, Chapter, Versecount, verse, title FROM bible');
  await closeDb(enDb);
  await closeDb(taDb);

  const taMap = new Map(taRows.map((r) => [`${r.Book}|${r.Chapter}|${r.Versecount}`, r]));
  const enKeys = new Set();
  let dupKeys = 0;
  for (const r of enRows) {
    const k = `${r.Book}|${r.Chapter}|${r.Versecount}`;
    if (enKeys.has(k)) dupKeys += 1;
    enKeys.add(k);
  }

  const jsonlPath = path.join(SECOND, 'bible', 'verses.jsonl');
  const lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const enMap = new Map(enRows.map((r) => [`${r.Book}|${r.Chapter}|${r.Versecount}`, r]));
  let ok = 0;
  let badRef = 0;
  let empty = 0;
  let mismatchText = 0;
  const badSamples = [];

  for (const line of lines) {
    const rec = JSON.parse(line);
    const key = `${rec.book}|${rec.chapter}|${rec.verse}`;
    const e = enMap.get(key);
    const t = taMap.get(key);
    if (!e || !t) {
      badRef += 1;
      if (badSamples.length < 20) badSamples.push({ key, reason: 'missing_db_ref' });
      continue;
    }
    if (!normExact(rec.english) || !normExact(rec.tamil)) {
      empty += 1;
      if (badSamples.length < 20) badSamples.push({ key, reason: 'empty_text' });
      continue;
    }
    if (normExact(rec.english) !== normExact(e.verse) || normExact(rec.tamil) !== normExact(t.verse)) {
      mismatchText += 1;
      if (badSamples.length < 20) {
        badSamples.push({
          key,
          reason: 'text_mismatch_vs_sqlite',
          json_en_len: rec.english.length,
          db_en_len: String(e.verse || '').length,
        });
      }
      continue;
    }
    ok += 1;
  }

  audit.bible = {
    sqliteEnglishRows: enRows.length,
    sqliteTamilRows: taRows.length,
    jsonlLines: lines.length,
    duplicateSqliteKeys: dupKeys,
    verifiedExactMatch: ok,
    badReferences: badRef,
    emptyText: empty,
    textMismatchVsSqlite: mismatchText,
    all31102Verified: ok === 31102 && lines.length === 31102 && badRef === 0 && empty === 0,
    badSamples,
  };
  console.log(`  Bible verified exact matches: ${ok}/${lines.length}`);
}

async function reanalyzeSermons(audit) {
  console.log('Re-analyzing sermon alignment / duplicates / unmatched...');
  const enDb = openDb(PATHS.messagesEn);
  const taDb = openDb(PATHS.messagesTa);
  const enRows = await all(enDb, 'SELECT id, name, message FROM messages');
  const taRows = await all(taDb, 'SELECT id, name, message FROM messages');
  await closeDb(enDb);
  await closeDb(taDb);

  const enBy = new Map();
  const taBy = new Map();
  for (const r of enRows) {
    const c = normalizeSermonCode(r.name);
    if (c && !enBy.has(c)) enBy.set(c, r);
  }
  for (const r of taRows) {
    const c = normalizeSermonCode(r.name);
    if (c && !taBy.has(c)) taBy.set(c, r);
  }

  const paired = [...enBy.keys()].filter((c) => taBy.has(c)).sort();
  const json419 = new Set(listJsonIds(DATASET).map((x) => x.toUpperCase()));
  const pairedFiles = new Set(listJsonIds(path.join(SECOND, 'sermons', 'paired')).map((x) => x.toUpperCase()));
  const docFiles = new Set(
    listJsonIds(path.join(SECOND, 'sermons', 'document-level')).map((x) => x.toUpperCase())
  );

  const seenExact = new Map(); // pairKey -> first location
  const skippedDuplicates = [];
  const unmatchedSamples = [];
  let unmatchedEn = 0;
  let unmatchedTa = 0;
  let complete = 0;
  const perSermonUnmatched = [];

  const unmatchedOutDir = path.join(CAT, '_staging_unmatched_source_paragraphs');
  ensure(unmatchedOutDir);
  const unmatchedStream = fs.createWriteStream(
    path.join(unmatchedOutDir, 'unmatched_paragraphs.jsonl'),
    { encoding: 'utf8' }
  );

  for (const code of paired) {
    const enRow = enBy.get(code);
    const taRow = taBy.get(code);
    const enLabeled = assignLabels(splitHtmlParagraphs(enRow.message)).filter(
      (p) => p.label || !isHeaderOnly(p.text, code)
    );
    const taLabeled = assignLabels(splitHtmlParagraphs(taRow.message)).filter(
      (p) => p.label || !isHeaderOnly(p.text, code)
    );
    const enMap = new Map();
    const taMap = new Map();
    for (const p of enLabeled) if (p.label && !enMap.has(p.label)) enMap.set(p.label, p);
    for (const p of taLabeled) if (p.label && !taMap.has(p.label)) taMap.set(p.label, p);

    const enPrimary = new Set([...enMap.keys()].filter((l) => !l.includes('.')));
    const taPrimary = new Set([...taMap.keys()].filter((l) => !l.includes('.')));
    const numberedPrimary = Math.min(enPrimary.size, taPrimary.size);
    const mode =
      numberedPrimary < MIN_NUMBERED_PRIMARY ? 'document-level' : 'paragraph-level';

    let sermonUnEn = 0;
    let sermonUnTa = 0;
    let sermonDup = 0;
    let sermonComplete = 0;

    if (mode === 'paragraph-level') {
      const labels = new Set([...enMap.keys(), ...taMap.keys()]);
      for (const label of labels) {
        const ep = enMap.get(label);
        const tp = taMap.get(label);
        const english = ep ? normExact(ep.text) : '';
        const tamil = tp ? normExact(tp.text) : '';

        if (!ep) {
          unmatchedTa += 1;
          sermonUnTa += 1;
          unmatchedStream.write(
            JSON.stringify({
              sermon_id: code,
              paragraph_label: label,
              side: 'tamil_only',
              english: null,
              tamil,
              provenance: {
                source: 'brd_david_messages',
                en_db_id: enRow.id,
                ta_db_id: taRow.id,
              },
              status: 'unmatched_preserved',
            }) + '\n'
          );
          continue;
        }
        if (!tp) {
          unmatchedEn += 1;
          sermonUnEn += 1;
          unmatchedStream.write(
            JSON.stringify({
              sermon_id: code,
              paragraph_label: label,
              side: 'english_only',
              english,
              tamil: null,
              provenance: {
                source: 'brd_david_messages',
                en_db_id: enRow.id,
                ta_db_id: taRow.id,
              },
              status: 'unmatched_preserved',
            }) + '\n'
          );
          continue;
        }
        if (!english || !tamil) continue;

        const pairKey = `${english}|||${tamil}`;
        if (seenExact.has(pairKey)) {
          sermonDup += 1;
          skippedDuplicates.push({
            sermon_id: code,
            paragraph_label: label,
            english,
            tamil,
            first_seen_at: seenExact.get(pairKey),
            provenance: {
              source: 'brd_david_messages',
              en_db_id: enRow.id,
              ta_db_id: taRow.id,
              en_name: enRow.name,
              ta_name: taRow.name,
            },
            status: 'duplicate_skipped_not_deleted',
          });
          continue;
        }
        seenExact.set(pairKey, { sermon_id: code, paragraph_label: label });
        sermonComplete += 1;
        complete += 1;
      }
    }

    if (sermonUnEn + sermonUnTa > 0 && unmatchedSamples.length < 30) {
      unmatchedSamples.push({
        sermon_id: code,
        mode,
        unmatched_en: sermonUnEn,
        unmatched_ta: sermonUnTa,
        en_labels: enMap.size,
        ta_labels: taMap.size,
      });
    }

    perSermonUnmatched.push({
      sermon_id: code,
      mode,
      in_json419: json419.has(code),
      in_paired_output: pairedFiles.has(code),
      in_doc_output: docFiles.has(code),
      unmatched_en: sermonUnEn,
      unmatched_ta: sermonUnTa,
      duplicates_in_build: sermonDup,
      complete_pairs: sermonComplete,
      en_primary: enPrimary.size,
      ta_primary: taPrimary.size,
    });
  }

  await new Promise((resolve) => unmatchedStream.end(resolve));

  audit.sermonReanalysis = {
    pairedCodes: paired.length,
    completePairsRecount: complete,
    unmatchedEnglishOnly: unmatchedEn,
    unmatchedTamilOnly: unmatchedTa,
    skippedDuplicatesFound: skippedDuplicates.length,
    unmatchedPreservedFile: path.relative(
      ROOT,
      path.join(unmatchedOutDir, 'unmatched_paragraphs.jsonl')
    ),
    unmatchedSamples,
  };

  writeJson(path.join(AUDIT, 'skipped-duplicate-pairs.json'), {
    count: skippedDuplicates.length,
    note: 'These pairs were skipped during second_corpus build because an identical English|||Tamil pair was already kept. Original DB rows were not deleted.',
    pairs: skippedDuplicates,
  });

  writeJson(path.join(AUDIT, 'unmatched-label-investigation.json'), {
    summary: {
      unmatchedEnglishOnly: unmatchedEn,
      unmatchedTamilOnly: unmatchedTa,
      explanation:
        'Unmatched labels occur when English and Tamil HTML have different continuation paragraph counts under the same primary number (e.g. EN has 1.4 but TA stops at 1.3). No alignments were invented. Source paragraphs are preserved in categories/_staging_unmatched_source_paragraphs/unmatched_paragraphs.jsonl.',
    },
    topSermonsByUnmatched: perSermonUnmatched
      .map((s) => ({
        ...s,
        total_unmatched: s.unmatched_en + s.unmatched_ta,
      }))
      .sort((a, b) => b.total_unmatched - a.total_unmatched)
      .slice(0, 50),
    perSermon: perSermonUnmatched,
  });

  console.log(
    `  Duplicates found: ${skippedDuplicates.length}; unmatched EN=${unmatchedEn} TA=${unmatchedTa}`
  );

  return { paired, json419, enBy, taBy };
}

function loadApprovedPairs() {
  const ids = listJsonIds(CLEAN).length ? listJsonIds(CLEAN) : listJsonIds(DATASET);
  const sourceDir = listJsonIds(CLEAN).length ? CLEAN : DATASET;
  const pairs = [];
  for (const id of ids) {
    const data = JSON.parse(fs.readFileSync(path.join(sourceDir, `sermon_${id}.json`), 'utf8'));
    for (const p of data.paragraphs || []) {
      const english = normExact(p.english);
      const tamil = normExact(p.tamil);
      if (!english || !tamil) continue;
      pairs.push({
        sermon_id: data.sermon_id || id,
        paragraph_label: p.paragraph_label ?? null,
        english,
        tamil,
        provenance: {
          source: sourceDir === CLEAN ? 'clean_dataset' : 'dataset_approved_json',
          file: `sermon_${id}.json`,
          approval_status: 'approved',
        },
      });
    }
  }
  return { sourceDir, ids, pairs };
}

function loadSecondParagraphPairs() {
  const dir = path.join(SECOND, 'sermons', 'paired');
  const ids = listJsonIds(dir);
  const pairs = [];
  for (const id of ids) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `sermon_${id}.json`), 'utf8'));
    for (const p of data.paragraphs || []) {
      pairs.push({
        sermon_id: data.sermon_id || id,
        paragraph_label: p.paragraph_label,
        english: normExact(p.english),
        tamil: normExact(p.tamil),
        provenance: {
          source: 'second_corpus_paragraph_level',
          file: `second_corpus/sermons/paired/sermon_${id}.json`,
          en_db_id: data.source?.en_db_id ?? null,
          ta_db_id: data.source?.ta_db_id ?? null,
          en_name: data.source?.en_name ?? null,
          ta_name: data.source?.ta_name ?? null,
          approval_status: 'unverified_db_derived',
        },
      });
    }
  }
  return { ids, pairs };
}

function compareCorpora(approved, second, json419, audit) {
  console.log('Comparing second corpus vs approved 419 JSON...');
  const approvedExact = new Map();
  const approvedNear = new Map();
  for (const p of approved.pairs) {
    const ek = sha1(normExact(p.english) + '|||' + normExact(p.tamil));
    const nk = sha1(normNear(p.english) + '|||' + normNear(p.tamil));
    if (!approvedExact.has(ek)) approvedExact.set(ek, p);
    if (!approvedNear.has(nk)) approvedNear.set(nk, p);
  }

  let exactDup = 0;
  let nearDup = 0;
  let novel = 0;
  const exactSamples = [];
  const nearSamples = [];
  const novelBySermon = new Map();

  const overlapSermons = second.ids.filter((id) => json419.has(id.toUpperCase()));
  const newSermons = second.ids.filter((id) => !json419.has(id.toUpperCase()));

  for (const p of second.pairs) {
    const ek = sha1(normExact(p.english) + '|||' + normExact(p.tamil));
    const nk = sha1(normNear(p.english) + '|||' + normNear(p.tamil));
    if (approvedExact.has(ek)) {
      exactDup += 1;
      if (exactSamples.length < 25) {
        exactSamples.push({
          sermon_id: p.sermon_id,
          paragraph_label: p.paragraph_label,
          matched_approved_sermon: approvedExact.get(ek).sermon_id,
        });
      }
      continue;
    }
    if (approvedNear.has(nk)) {
      nearDup += 1;
      if (nearSamples.length < 25) {
        const ap = approvedNear.get(nk);
        nearSamples.push({
          sermon_id: p.sermon_id,
          paragraph_label: p.paragraph_label,
          matched_approved_sermon: ap.sermon_id,
          jaccard_en: jaccard(normNear(p.english), normNear(ap.english)),
        });
      }
      continue;
    }
    // soft near: high jaccard against same sermon approved paras only would be expensive;
    // count as novel at corpus level
    novel += 1;
    novelBySermon.set(p.sermon_id, (novelBySermon.get(p.sermon_id) || 0) + 1);
  }

  // Sermon-id level comparison for all 407 paired codes vs 419
  const pairedAll = [
    ...new Set([
      ...listJsonIds(path.join(SECOND, 'sermons', 'paired')),
      ...listJsonIds(path.join(SECOND, 'sermons', 'document-level')),
    ]),
  ];
  const pairedOverlap419 = pairedAll.filter((id) => json419.has(id.toUpperCase()));
  const pairedNew419 = pairedAll.filter((id) => !json419.has(id.toUpperCase()));
  const jsonOnly = [...json419].filter(
    (id) => !pairedAll.map((x) => x.toUpperCase()).includes(id)
  );

  audit.comparison = {
    approvedSourceDir: path.relative(ROOT, approved.sourceDir),
    approvedSermonCount: approved.ids.length,
    approvedParagraphPairs: approved.pairs.length,
    secondParagraphSermons: second.ids.length,
    secondParagraphPairs: second.pairs.length,
    paragraphExactDuplicatesVsApproved: exactDup,
    paragraphNearDuplicatesVsApproved: nearDup,
    paragraphNovelVsApproved: novel,
    pairedSermonIdsTotal: pairedAll.length,
    pairedOverlapWith419: pairedOverlap419.length,
    pairedNewVs419: pairedNew419.length,
    json419OnlyNotInSecondPairedOrDoc: jsonOnly.length,
    exactDuplicateSamples: exactSamples,
    nearDuplicateSamples: nearSamples,
    topNovelSermons: [...novelBySermon.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([sermon_id, novel_pairs]) => ({ sermon_id, novel_pairs })),
    overlapSermonIdsSample: pairedOverlap419.slice(0, 30),
    newSermonIdsSample: pairedNew419.slice(0, 30),
  };

  writeJson(path.join(AUDIT, 'corpus-comparison.json'), audit.comparison);
  console.log(
    `  Exact dups=${exactDup} near=${nearDup} novel=${novel}; sermon overlap=${pairedOverlap419.length} new=${pairedNew419.length}`
  );
}

function buildConsolidated(approved, second, audit) {
  console.log('Building consolidated reference categories...');
  const dirs = {
    approved: path.join(CAT, 'approved_sermon_paragraph_pairs'),
    document: path.join(CAT, 'document_level_sermon_references'),
    bible: path.join(CAT, 'bible_verse_pairs'),
    terminology: path.join(CAT, 'terminology_glossary'),
    phrase: path.join(CAT, 'phrase_glossary'),
    dbDerived: path.join(CAT, '_staging_db_derived_sermon_paragraph_pairs'),
  };
  Object.values(dirs).forEach(ensure);

  // 1) Approved sermon paragraphs (only from clean/dataset — never auto-approve DB-derived)
  const approvedOut = path.join(dirs.approved, 'pairs.jsonl');
  const aStream = fs.createWriteStream(approvedOut, { encoding: 'utf8' });
  for (const p of approved.pairs) {
    aStream.write(
      JSON.stringify({
        ...p,
        category: 'approved_sermon_paragraph_pairs',
        approval_status: 'approved',
      }) + '\n'
    );
  }

  // Also copy per-sermon files for convenience (from clean_dataset)
  const approvedSermonDir = path.join(dirs.approved, 'sermons');
  ensure(approvedSermonDir);
  for (const id of approved.ids) {
    copyFile(path.join(approved.sourceDir, `sermon_${id}.json`), path.join(approvedSermonDir, `sermon_${id}.json`));
  }

  // 2) Document-level references (unverified)
  const docSrc = path.join(SECOND, 'sermons', 'document-level');
  const docIds = listJsonIds(docSrc);
  const docIndex = path.join(dirs.document, 'index.jsonl');
  const dStream = fs.createWriteStream(docIndex, { encoding: 'utf8' });
  for (const id of docIds) {
    const src = path.join(docSrc, `sermon_${id}.json`);
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    copyFile(src, path.join(dirs.document, `sermon_${id}.json`));
    dStream.write(
      JSON.stringify({
        sermon_id: data.sermon_id || id,
        mode: 'document-level',
        approval_status: 'unverified_db_derived',
        provenance: {
          source: 'second_corpus_document_level',
          file: `second_corpus/sermons/document-level/sermon_${id}.json`,
        },
        english_chars: (data.english || '').length,
        tamil_chars: (data.tamil || '').length,
        category: 'document_level_sermon_references',
      }) + '\n'
    );
  }

  // 3) Bible verses with provenance
  const bibleSrc = path.join(SECOND, 'bible', 'verses.jsonl');
  const bibleOut = path.join(dirs.bible, 'verses.jsonl');
  const bIn = fs.readFileSync(bibleSrc, 'utf8').split(/\r?\n/).filter(Boolean);
  const bStream = fs.createWriteStream(bibleOut, { encoding: 'utf8' });
  for (const line of bIn) {
    const rec = JSON.parse(line);
    bStream.write(
      JSON.stringify({
        ...rec,
        category: 'bible_verse_pairs',
        approval_status: 'verified_sqlite_join',
        provenance: {
          source: 'brd_david_bible_sqlite',
          english_db: PATHS.bibleEn,
          tamil_db: PATHS.bibleTa,
          join_key: ['Book', 'Chapter', 'Versecount'],
        },
      }) + '\n'
    );
  }

  // 4) Glossaries (copy, do not invent)
  copyFile(path.join(DATASET, 'glossary.json'), path.join(dirs.terminology, 'glossary.json'));
  copyFile(
    path.join(DATASET, 'phrase_glossary.json'),
    path.join(dirs.phrase, 'phrase_glossary.json')
  );
  const glossary = JSON.parse(fs.readFileSync(path.join(DATASET, 'glossary.json'), 'utf8'));
  const phrases = JSON.parse(fs.readFileSync(path.join(DATASET, 'phrase_glossary.json'), 'utf8'));
  writeJson(path.join(dirs.terminology, 'manifest.json'), {
    category: 'terminology_glossary',
    approval_status: 'existing_glossary_reuse',
    entry_count: Array.isArray(glossary) ? glossary.length : Object.keys(glossary).length,
    provenance: { source: 'dataset/glossary.json' },
  });
  writeJson(path.join(dirs.phrase, 'manifest.json'), {
    category: 'phrase_glossary',
    approval_status: 'existing_glossary_reuse',
    entry_count: Array.isArray(phrases) ? phrases.length : Object.keys(phrases).length,
    provenance: { source: 'dataset/phrase_glossary.json' },
  });

  // 5) Staging: DB-derived paragraph pairs (NOT approved)
  const dbOut = path.join(dirs.dbDerived, 'pairs.jsonl');
  const dbStream = fs.createWriteStream(dbOut, { encoding: 'utf8' });
  for (const p of second.pairs) {
    dbStream.write(
      JSON.stringify({
        ...p,
        category: '_staging_db_derived_sermon_paragraph_pairs',
        approval_status: 'unverified_db_derived',
      }) + '\n'
    );
  }

  // Wait for streams
  return new Promise((resolve) => {
    let pending = 4;
    const done = () => {
      pending -= 1;
      if (pending === 0) {
        const proposal = {
          generatedAt: new Date().toISOString(),
          policy: {
            originalsUntouched: true,
            unverifiedNeverAutoApproved: true,
            unmatchedNeverDiscarded: true,
            noGcs: true,
            noGeminiGeneration: true,
          },
          categories: {
            approved_sermon_paragraph_pairs: {
              path: path.relative(ROOT, dirs.approved),
              records: approved.pairs.length,
              sermons: approved.ids.length,
              approval_status: 'approved',
              note: 'From clean_dataset (derived from original 419 JSON). Only this sermon-paragraph category is approved.',
            },
            document_level_sermon_references: {
              path: path.relative(ROOT, dirs.document),
              records: docIds.length,
              approval_status: 'unverified_db_derived',
              note: 'Whole-sermon EN/TA HTML references; not paragraph-aligned; not approved for training as pairs.',
            },
            bible_verse_pairs: {
              path: path.relative(ROOT, dirs.bible),
              records: bIn.length,
              approval_status: 'verified_sqlite_join',
              note: 'Exact Book/Chapter/Verse join from BRD Bible DBs.',
            },
            terminology_glossary: {
              path: path.relative(ROOT, dirs.terminology),
              records: Array.isArray(glossary) ? glossary.length : Object.keys(glossary).length,
              approval_status: 'existing_glossary_reuse',
            },
            phrase_glossary: {
              path: path.relative(ROOT, dirs.phrase),
              records: Array.isArray(phrases) ? phrases.length : Object.keys(phrases).length,
              approval_status: 'existing_glossary_reuse',
            },
          },
          staging_not_approved: {
            db_derived_sermon_paragraph_pairs: {
              path: path.relative(ROOT, dirs.dbDerived),
              records: second.pairs.length,
              approval_status: 'unverified_db_derived',
              note: 'Available for review only. Do not treat as approved terminology/examples until manually verified.',
            },
            unmatched_source_paragraphs: {
              path: 'consolidated_reference/categories/_staging_unmatched_source_paragraphs',
              approval_status: 'unmatched_preserved',
              note: 'Preserved English-only / Tamil-only labeled paragraphs. No invented alignments.',
            },
          },
          audit_highlights: {
            bible_all_verified: audit.bible?.all31102Verified ?? null,
            skipped_duplicates: audit.sermonReanalysis?.skippedDuplicatesFound ?? null,
            unmatched_en: audit.sermonReanalysis?.unmatchedEnglishOnly ?? null,
            unmatched_ta: audit.sermonReanalysis?.unmatchedTamilOnly ?? null,
            exact_dups_vs_approved: audit.comparison?.paragraphExactDuplicatesVsApproved ?? null,
            near_dups_vs_approved: audit.comparison?.paragraphNearDuplicatesVsApproved ?? null,
          },
        };
        writeJson(path.join(OUT, 'consolidated-corpus-proposal.json'), proposal);

        const md = `# Consolidated Reference Corpus Proposal

Generated: ${proposal.generatedAt}

## Policy

- Original databases and datasets were **not** overwritten.
- DB-derived pairs are **not** auto-marked approved.
- Unmatched source paragraphs are **preserved**, not discarded.
- No GCS upload. No Gemini generation requests in this phase.

## Categories (reference)

| Category | Records | Status | Path |
| --- | ---: | --- | --- |
| Approved sermon paragraph pairs | ${proposal.categories.approved_sermon_paragraph_pairs.records} | approved | \`${proposal.categories.approved_sermon_paragraph_pairs.path}\` |
| Document-level sermon references | ${proposal.categories.document_level_sermon_references.records} | unverified_db_derived | \`${proposal.categories.document_level_sermon_references.path}\` |
| Bible verse pairs | ${proposal.categories.bible_verse_pairs.records} | verified_sqlite_join | \`${proposal.categories.bible_verse_pairs.path}\` |
| Terminology glossary | ${proposal.categories.terminology_glossary.records} | existing_glossary_reuse | \`${proposal.categories.terminology_glossary.path}\` |
| Phrase glossary | ${proposal.categories.phrase_glossary.records} | existing_glossary_reuse | \`${proposal.categories.phrase_glossary.path}\` |

## Staging (not approved)

| Staging bucket | Records | Status |
| --- | ---: | --- |
| DB-derived sermon paragraph pairs | ${proposal.staging_not_approved.db_derived_sermon_paragraph_pairs.records} | unverified_db_derived |
| Unmatched source paragraphs | (see audit file) | unmatched_preserved |

## Audit highlights

- Bible 31,102 verified: **${proposal.audit_highlights.bible_all_verified}**
- Skipped duplicate pairs audited: **${proposal.audit_highlights.skipped_duplicates}**
- Unmatched EN labels preserved: **${proposal.audit_highlights.unmatched_en}**
- Unmatched TA labels preserved: **${proposal.audit_highlights.unmatched_ta}**
- Exact paragraph duplicates vs approved 419: **${proposal.audit_highlights.exact_dups_vs_approved}**
- Near-duplicates vs approved 419: **${proposal.audit_highlights.near_dups_vs_approved}**

See \`audit/\` for detailed JSON reports.
`;
        fs.writeFileSync(path.join(OUT, 'consolidated-corpus-proposal.md'), md);
        writeJson(path.join(OUT, 'manifest.json'), {
          categories: proposal.categories,
          staging: proposal.staging_not_approved,
          audit_dir: 'consolidated_reference/audit',
        });
        console.log('  Consolidated categories written.');
        resolve(proposal);
      }
    };
    aStream.end(done);
    dStream.end(done);
    bStream.end(done);
    dbStream.end(done);
  });
}

async function main() {
  ensure(OUT);
  ensure(AUDIT);
  ensure(CAT);

  const audit = {
    generatedAt: new Date().toISOString(),
    inspectedFiles: {
      bible_jsonl: 'second_corpus/bible/verses.jsonl',
      paired_dir: 'second_corpus/sermons/paired',
      document_dir: 'second_corpus/sermons/document-level',
      quality_report: 'second-corpus-quality-report.md',
    },
  };

  // Inspect counts
  const bibleLines = fs
    .readFileSync(path.join(SECOND, 'bible', 'verses.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean).length;
  audit.inspection = {
    bibleJsonlLines: bibleLines,
    pairedSermonFiles: listJsonIds(path.join(SECOND, 'sermons', 'paired')).length,
    documentLevelFiles: listJsonIds(path.join(SECOND, 'sermons', 'document-level')).length,
    sampleBibleLine: JSON.parse(
      fs.readFileSync(path.join(SECOND, 'bible', 'verses.jsonl'), 'utf8').split(/\r?\n/)[0]
    ),
    samplePairedSermon: (() => {
      const id = listJsonIds(path.join(SECOND, 'sermons', 'paired'))[0];
      const d = JSON.parse(
        fs.readFileSync(path.join(SECOND, 'sermons', 'paired', `sermon_${id}.json`), 'utf8')
      );
      return {
        sermon_id: d.sermon_id,
        paragraph_count: (d.paragraphs || []).length,
        provenance_fields: Object.keys(d.source || {}),
        first_pair_labels: (d.paragraphs || []).slice(0, 3).map((p) => p.paragraph_label),
      };
    })(),
  };

  await verifyBible(audit);
  const { json419 } = await reanalyzeSermons(audit);
  const approved = loadApprovedPairs();
  const second = loadSecondParagraphPairs();
  compareCorpora(approved, second, json419, audit);
  await buildConsolidated(approved, second, audit);

  writeJson(path.join(AUDIT, 'full-audit-report.json'), audit);

  const auditMd = `# Second Corpus Integration Audit

Generated: ${audit.generatedAt}

## Inspection

- Bible JSONL lines: **${audit.inspection.bibleJsonlLines}**
- Paragraph-level sermon files: **${audit.inspection.pairedSermonFiles}**
- Document-level sermon files: **${audit.inspection.documentLevelFiles}**

## Bible verification

- Verified exact match vs SQLite: **${audit.bible.verifiedExactMatch}**
- All 31,102 verified: **${audit.bible.all31102Verified}**
- Bad references: ${audit.bible.badReferences}
- Text mismatches: ${audit.bible.textMismatchVsSqlite}

## Duplicate audit (33 skipped)

- Re-detected skipped duplicate pairs: **${audit.sermonReanalysis.skippedDuplicatesFound}**
- Details: \`audit/skipped-duplicate-pairs.json\`

## Unmatched labels

- English-only labels: **${audit.sermonReanalysis.unmatchedEnglishOnly}**
- Tamil-only labels: **${audit.sermonReanalysis.unmatchedTamilOnly}**
- Preserved at: \`${audit.sermonReanalysis.unmatchedPreservedFile}\`
- Investigation: \`audit/unmatched-label-investigation.json\`

## Comparison vs approved 419

- Exact paragraph duplicates: **${audit.comparison.paragraphExactDuplicatesVsApproved}**
- Near-duplicates: **${audit.comparison.paragraphNearDuplicatesVsApproved}**
- Novel paragraph pairs: **${audit.comparison.paragraphNovelVsApproved}**
- Paired sermon overlap with 419: **${audit.comparison.pairedOverlapWith419}**
- Paired sermons new vs 419: **${audit.comparison.pairedNewVs419}**

## Next

Run \`node phase2_token_cost_report.js\` for category token counts and the 600-sermon cost estimate.
`;
  fs.writeFileSync(path.join(AUDIT, 'AUDIT-REPORT.md'), auditMd);
  fs.writeFileSync(path.join(ROOT, 'corpus-integration-audit.md'), auditMd);

  console.log('Audit + consolidation complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
