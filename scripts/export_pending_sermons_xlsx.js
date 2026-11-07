const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const APPROVED_DIR = path.join(ROOT, 'dataset');
const EN_VOGR = path.join(ROOT, 'db_source', 'en_sermons_vogr.sqlite');
const TA_VOGR = path.join(ROOT, 'db_source', 'ta_sermons_vogr.sqlite');
const EN_MSG = 'd:/Freelancing/BRD-David/server/data/english_messages.sqlite';
const TA_MSG = 'd:/Freelancing/BRD-David/server/data/messages.sqlite';
const TA_TEXT_DIR = path.join(ROOT, '..', 'tamil_message_text_files_473');
const TA_ETBM_DIR = path.join(ROOT, '..', 'tamil_message_etbm_files_103');
const LIVE_TA_VOGR = 'e:/Live/api.endtimebride/data/ta_sermons_vogr.sqlite';
const LIVE_CDN_TA = 'e:/Live/api.endtimebride/cdn/sermons/tam/sermons_ta.db';
const VOG_JSON = path.join(ROOT, 'db_source', 'vog_all_sermons_api_response.json');
const OUT = path.join(ROOT, 'reports', 'pending_tamil_translations.xlsx');
const OUT_FALLBACKS = [
  path.join(ROOT, 'reports', 'pending_tamil_translations_v2.xlsx'),
  path.join(ROOT, 'reports', 'pending_tamil_translations_v3.xlsx'),
];
const SKIP_IDS = new Set(
  Array.from({ length: 11 }, (_, i) => `CAB-${String(i).padStart(2, '0')}`)
);

function open(p) {
  return new sqlite3.Database(p, sqlite3.OPEN_READONLY);
}
function all(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}
function normalizeCode(name) {
  if (!name) return null;
  const m = String(name)
    .trim()
    .toUpperCase()
    .match(/^(\d{2})-(\d{2})-?(\d{2})([A-Z]?)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}${m[3]}${m[4] || ''}`;
}
function titleFromName(name) {
  if (!name) return '';
  return String(name)
    .replace(/^\d{2}-\d{2}-?\d{2}[A-Za-z]?\s*/, '')
    .trim();
}

function dateCore(id) {
  const m = String(id).toUpperCase().match(/^(\d{2}-\d{4})([A-Z]?)$/);
  return m ? m[1] : null;
}
function parseSermonId(id) {
  const m = String(id || '')
    .toUpperCase()
    .match(/^(\d{2})-(\d{2})(\d{2})([A-Z]?)$/);
  if (!m) return null;
  return { yy: m[1], mm: m[2], dd: m[3], s: m[4] || '', raw: `${m[1]}-${m[2]}${m[3]}${m[4] || ''}` };
}
function isPlaceholderDate(part) {
  return part === '00' || part === '01';
}
function isUnknownDateVariant(a, b) {
  if (!a || !b || a.yy !== b.yy) return false;
  if (a.mm === b.mm && a.dd !== b.dd && isPlaceholderDate(a.dd) && isPlaceholderDate(b.dd)) return true;
  const aNewYearUnknown = a.mm === '00' && a.dd === '00';
  const bNewYearUnknown = b.mm === '00' && b.dd === '00';
  const aJan1 = a.mm === '01' && a.dd === '01';
  const bJan1 = b.mm === '01' && b.dd === '01';
  return (aNewYearUnknown && bJan1) || (bNewYearUnknown && aJan1);
}
function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function idsFromTamilDir(dir) {
  const map = new Map();
  const unmatched = [];
  if (!fs.existsSync(dir)) {
    throw new Error(`Tamil folder missing: ${dir}`);
  }
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.txt')) continue;
    const id = normalizeCode(file);
    if (!id) {
      unmatched.push(file);
      continue;
    }
    if (!map.has(id)) map.set(id, { file, tamilTitle: titleFromName(path.parse(file).name) });
  }
  return { map, unmatched, count: map.size };
}

async function main() {
  const approvedIds = new Set(
    fs
      .readdirSync(APPROVED_DIR)
      .filter((f) => f.startsWith('sermon_') && f.endsWith('.json'))
      .map((f) => f.replace(/^sermon_/, '').replace(/\.json$/, '').toUpperCase())
  );

  const text473 = idsFromTamilDir(TA_TEXT_DIR);
  const etbm103 = idsFromTamilDir(TA_ETBM_DIR);
  const vogSermons = JSON.parse(fs.readFileSync(VOG_JSON, 'utf8')).Result.Sermons;
  const vogById = new Map();
  for (const s of vogSermons) {
    vogById.set(String(s.p).toUpperCase(), s);
  }

  const enDb = open(EN_VOGR);
  const taDb = open(TA_VOGR);
  const enMsg = open(EN_MSG);
  const taMsg = open(TA_MSG);
  const liveTaDb = open(LIVE_TA_VOGR);
  const cdnTaDb = open(LIVE_CDN_TA);

  const enSermons = await all(
    enDb,
    'SELECT id, title, date, year, duration, location, session, vogr_sid, total_paragraphs FROM sermons'
  );
  const enParas = await all(enDb, 'SELECT sermon_id, COUNT(*) AS c FROM paragraphs GROUP BY sermon_id');
  const taSermons = await all(
    taDb,
    'SELECT id, title, series, DATE as date, YEAR as year, duration, location, SESSION as session, vogr_sid, total_paragraphs FROM tamil_sermons'
  );
  const taParas = await all(
    taDb,
    'SELECT sermon_id, COUNT(*) AS c FROM tamil_paragraphs GROUP BY sermon_id'
  );
  const enMsgRows = await all(enMsg, 'SELECT id, name, length(message) AS chars, is_hidden FROM messages');
  const taMsgRows = await all(taMsg, 'SELECT id, name, length(message) AS chars, is_hidden FROM messages');
  const liveTaSermons = await all(liveTaDb, 'SELECT id, title, total_paragraphs FROM tamil_sermons');
  const cdnTaSermons = await all(cdnTaDb, 'SELECT id, title, total_paragraphs, etbm FROM sermons');

  await close(enDb);
  await close(taDb);
  await close(enMsg);
  await close(taMsg);
  await close(liveTaDb);
  await close(cdnTaDb);

  const enParaMap = new Map(enParas.map((r) => [String(r.sermon_id).toUpperCase(), r.c]));
  const taParaMap = new Map(taParas.map((r) => [String(r.sermon_id).toUpperCase(), r.c]));
  const taVogr = new Map();
  for (const r of taSermons) {
    const id = String(r.id).toUpperCase();
    taVogr.set(id, r);
  }
  function mapToVogId(id, title) {
    const uid = String(id || '').toUpperCase();
    if (vogById.has(uid)) return uid;
    const nt = normTitle(title);
    const parsed = parseSermonId(uid);
    if (!parsed || !nt) return null;
    const hits = [];
    for (const s of vogSermons) {
      const otherId = String(s.p).toUpperCase();
      const other = parseSermonId(otherId);
      if (!other || normTitle(s.t) !== nt) continue;
      const sameDay = parsed.yy === other.yy && parsed.mm === other.mm && parsed.dd === other.dd;
      if (sameDay || isUnknownDateVariant(parsed, other)) hits.push(otherId);
    }
    const unique = [...new Set(hits)];
    return unique.length === 1 ? unique[0] : null;
  }

  const enMsgMap = new Map();
  const droppedNonVog = [];
  const remappedDuplicates = [];
  for (const r of enMsgRows) {
    const rawId = normalizeCode(r.name);
    if (!rawId) continue;
    const title = titleFromName(r.name);
    const mapped = mapToVogId(rawId, title);
    if (mapped) {
      if (rawId !== mapped) {
        remappedDuplicates.push({
          incorrect_id: rawId,
          correct_vog_id: mapped,
          english_name: r.name,
        });
      }
      if (!enMsgMap.has(mapped)) enMsgMap.set(mapped, { ...r, mapped_from: rawId });
    } else if (!vogById.has(rawId)) {
      droppedNonVog.push({
        raw_id: rawId,
        english_name: r.name,
        reason: 'not a Voice of God sermon ID (unsuffixed/duplicate catalog code)',
      });
    }
  }
  const taMsgMap = new Map();
  for (const r of taMsgRows) {
    const id = normalizeCode(r.name);
    if (id && !taMsgMap.has(id)) taMsgMap.set(id, r);
  }
  const liveTaMap = new Map();
  for (const r of liveTaSermons) liveTaMap.set(String(r.id).toUpperCase(), r);
  const cdnTaMap = new Map();
  for (const r of cdnTaSermons) cdnTaMap.set(String(r.id).toUpperCase(), r);

  const enById = new Map();
  const enByCore = new Map();
  for (const r of enSermons) {
    const id = String(r.id).toUpperCase();
    enById.set(id, r);
    const core = dateCore(id);
    if (!core) continue;
    if (!enByCore.has(core)) enByCore.set(core, []);
    enByCore.get(core).push(r);
  }

  function canonicalId(id, title) {
    return mapToVogId(id, title) || id;
  }

  function relatedIds(id, title) {
    const ids = new Set([id, canonicalId(id, title)]);
    const nt = normTitle(title);
    const parsed = parseSermonId(id);
    if (!parsed || !nt) return ids;
    for (const s of vogSermons) {
      const otherId = String(s.p).toUpperCase();
      const other = parseSermonId(otherId);
      if (!other) continue;
      if (normTitle(s.t) !== nt) continue;
      const sameDay = parsed.yy === other.yy && parsed.mm === other.mm && parsed.dd === other.dd;
      if (sameDay || isUnknownDateVariant(parsed, other)) ids.add(otherId);
    }
    return ids;
  }

  function firstMapHit(map, ids) {
    for (const key of ids) {
      if (map.has(key)) return { id: key, row: map.get(key) };
    }
    return { id: '', row: null };
  }

  const allIds = new Set(vogById.keys());

  const rows = [];
  for (const id of [...allIds].sort()) {
    const vog = vogById.get(id) || {};
    const en = enById.get(id) || {};
    const enM = enMsgMap.get(id);
    const englishTitle = vog.t || en.title || titleFromName(enM && enM.name) || '';
    const aliases = relatedIds(id, englishTitle);
    const canon = canonicalId(id, englishTitle);
    const taVHit = firstMapHit(taVogr, aliases);
    const taMHit = firstMapHit(taMsgMap, aliases);
    const taTxtHit = firstMapHit(text473.map, aliases);
    const taEtbmHit = firstMapHit(etbm103.map, aliases);
    const liveTaHit = firstMapHit(liveTaMap, aliases);
    const cdnTaHit = firstMapHit(cdnTaMap, aliases);
    const taV = taVHit.row;
    const taM = taMHit.row;
    const taTxt = taTxtHit.row;
    const taEtbm = taEtbmHit.row;
    const liveTa = liveTaHit.row;
    const cdnTa = cdnTaHit.row;
    const matchedTamilId =
      cdnTaHit.id || liveTaHit.id || taVHit.id || taMHit.id || taTxtHit.id || taEtbmHit.id || '';
    const approved = [...aliases].some((alias) => approvedIds.has(alias));
    const tamilTitle =
      (taV && taV.title) ||
      titleFromName(taM && taM.name) ||
      (taTxt && taTxt.tamilTitle) ||
      (taEtbm && taEtbm.tamilTitle) ||
      (liveTa && liveTa.title) ||
      (cdnTa && cdnTa.title) ||
      '';
    const hasTamilFile = Boolean(taTxt || taEtbm);
    const hasTamilDb = Boolean(taV || taM || liveTa || cdnTa);
    const skipListed = SKIP_IDS.has(id) || SKIP_IDS.has(canon);
    let status = 'pending_translate';
    if (approved) status = 'already_approved_bilingual';
    else if (skipListed) status = 'skip_listed_id';
    else if (hasTamilDb || hasTamilFile) status = 'has_tamil_elsewhere_not_in_approved_419';

    rows.push({
      sermon_id: id,
      canonical_sermon_id: canon,
      matched_tamil_id: matchedTamilId,
      english_title: englishTitle,
      tamil_title: tamilTitle,
      date: en.date || (taV && taV.date) || '',
      year: en.year || (taV && taV.year) || '',
      location: en.location || (taV && taV.location) || '',
      session: en.session || (taV && taV.session) || '',
      duration: en.duration || '',
      vogr_sid: en.vogr_sid || (taV && taV.vogr_sid) || '',
      english_paragraphs: en.total_paragraphs || enParaMap.get(id) || '',
      tamil_paragraphs_db: (taV && taV.total_paragraphs) || taParaMap.get(id) || '',
      in_approved_419: approved ? 'yes' : 'no',
      in_vog_source_of_truth: vogById.has(id) ? 'yes' : 'no',
      vog_index: vog.i || '',
      in_english_vogr: en.id ? 'yes' : 'no',
      in_tamil_vogr: taV ? 'yes' : 'no',
      in_english_messages: enM ? 'yes' : 'no',
      in_tamil_messages: taM ? 'yes' : 'no',
      in_tamil_text_files_473: taTxt ? 'yes' : 'no',
      in_tamil_etbm_files_103: taEtbm ? 'yes' : 'no',
      in_live_tamil_vogr: liveTa ? 'yes' : 'no',
      in_sermons_ta_cdn: cdnTa ? 'yes' : 'no',
      tamil_text_file: (taTxt && taTxt.file) || '',
      tamil_etbm_file: (taEtbm && taEtbm.file) || '',
      english_html_chars: enM ? enM.chars : '',
      tamil_html_chars: taM ? taM.chars : '',
      translation_status: status,
      suggested_batch: status === 'pending_translate' ? 'production_candidate' : 'skip',
    });
  }

  const pending = rows.filter((r) => r.translation_status === 'pending_translate');
  const review = rows.filter((r) => r.translation_status === 'has_tamil_elsewhere_not_in_approved_419');
  const listedSkip = rows.filter((r) => r.translation_status === 'skip_listed_id');
  const approved = rows.filter((r) => r.translation_status === 'already_approved_bilingual');

  function withSno(list) {
    return list.map((r, i) => {
      const { sermon_id, english_title, tamil_title, ...rest } = r;
      return {
        s_no: i + 1,
        sermon_id,
        english_sermon_name: english_title,
        tamil_sermon_name: tamil_title || '',
        ...rest,
      };
    });
  }

  const summary = [
    { metric: 'English sermons (Voice of God source of truth)', value: rows.length },
    { metric: 'Dropped non-VOG duplicate IDs from messages.sqlite', value: droppedNonVog.length },
    { metric: 'Remapped unsuffixed duplicates to VOG IDs (50-0813→50-0813A)', value: remappedDuplicates.length },
    { metric: 'Already approved bilingual (419 JSON)', value: approved.length },
    { metric: 'Pending English-only (to translate)', value: pending.length },
    { metric: 'Has Tamil (incl. live ta_sermons_vogr + sermons_ta.db) — SKIP', value: review.length },
    { metric: 'Skipped listed IDs (CAB-00..CAB-10)', value: listedSkip.length },
    { metric: 'Live tamil_sermons count', value: liveTaMap.size },
    { metric: 'CDN sermons_ta.db count', value: cdnTaMap.size },
    { metric: 'Pending also in sermons_ta.db (should be 0)', value: pending.filter((r) => r.in_sermons_ta_cdn === 'yes').length },
    { metric: '64-0726 still pending (should be 0)', value: pending.filter((r) => r.sermon_id === '64-0726' || r.canonical_sermon_id === '64-0726E').length },
    { metric: '47-1101 Fellowship still pending (should be 0)', value: pending.filter((r) => r.sermon_id === '47-1101').length },
    { metric: 'Tamil text files 473 unique sermon IDs', value: text473.count },
    { metric: 'Tamil ETBM files 103 unique sermon IDs', value: etbm103.count },
    { metric: 'Unmatched filenames text_473 (not sermon-id)', value: text473.unmatched.length },
    { metric: 'Unmatched filenames etbm_103 (not sermon-id)', value: etbm103.unmatched.length },
    { metric: 'Pending also present in text_473 (should be 0)', value: pending.filter((r) => r.in_tamil_text_files_473 === 'yes').length },
    { metric: 'Pending also present in etbm_103 (should be 0)', value: pending.filter((r) => r.in_tamil_etbm_files_103 === 'yes').length },
    { metric: 'Pending also present in messages.sqlite (should be 0)', value: pending.filter((r) => r.in_tamil_messages === 'yes').length },
    { metric: 'Pilot recommendation', value: pending.slice(0, 5).map((r) => r.sermon_id).join(', ') },
    { metric: 'Budget note', value: '₹2,000 ceiling ~90–100 sermons; start with 1 sermon test then 5-sermon pilot' },
    { metric: 'Generated', value: new Date().toISOString() },
  ];

  const wb = XLSX.utils.book_new();
  const pendingSheet = withSno(pending);
  const headerNote = XLSX.utils.aoa_to_sheet([
    ['Pending Tamil translations — English is source. Do not overwrite source_of_truth.'],
    ['Status pending_translate = no approved bilingual JSON and no Tamil in local/live DBs, folders, or sermons_ta.db.'],
    ['English IDs come only from vog_all_sermons_api_response.json (field p). Unsuffixed duplicates such as 50-0813 / 64-0321 are dropped; 50-0813A / 64-0321B are kept.'],
    ['Session letters (A/E/M) and unknown-date 00 vs first-day 01 alias only when English titles match. CAB-00..CAB-10 skipped.'],
    [],
  ]);
  const pendingWs = XLSX.utils.json_to_sheet(pendingSheet);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, pendingWs, 'Pending_to_translate');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(withSno(review)), 'Has_Tamil_review');
  if (listedSkip.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(withSno(listedSkip)), 'Skipped_listed_ids');
  }
  if (droppedNonVog.length) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(droppedNonVog.sort((a, b) => a.raw_id.localeCompare(b.raw_id))),
      'Dropped_non_VOG_ids'
    );
  }
  if (remappedDuplicates.length) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        remappedDuplicates.sort((a, b) => a.incorrect_id.localeCompare(b.incorrect_id))
      ),
      'Remapped_to_VOG_id'
    );
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(withSno(approved)), 'Already_approved_419');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(withSno(rows.sort((a,b)=>a.sermon_id.localeCompare(b.sermon_id)))), 'All_English_sermons');

  const folderOnly = [];
  for (const [id, meta] of text473.map) {
    if (!allIds.has(id)) folderOnly.push({ source: 'tamil_message_text_files_473', sermon_id: id, file: meta.file, tamil_sermon_name: meta.tamilTitle, in_english_catalog: 'no' });
  }
  for (const [id, meta] of etbm103.map) {
    if (!allIds.has(id)) folderOnly.push({ source: 'tamil_message_etbm_files_103', sermon_id: id, file: meta.file, tamil_sermon_name: meta.tamilTitle, in_english_catalog: 'no' });
  }
  if (folderOnly.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(folderOnly.sort((a, b) => a.sermon_id.localeCompare(b.sermon_id))), 'Tamil_files_no_English');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const outCandidates = [OUT, ...OUT_FALLBACKS];
  let written = null;
  let lastErr = null;
  for (const p of outCandidates) {
    try {
      XLSX.writeFile(wb, p);
      written = p;
      break;
    } catch (e) {
      lastErr = e;
      if (!e || e.code !== 'EBUSY') throw e;
    }
  }
  if (!written) throw lastErr;
  console.log(JSON.stringify({
    out: written,
    pending: pending.length,
    review: review.length,
    listedSkip: listedSkip.length,
    approved: approved.length,
    total: rows.length,
    cdn: cdnTaMap.size,
    vog: vogById.size,
    droppedNonVog: droppedNonVog.length,
    remappedDuplicates: remappedDuplicates.length,
    firstPending: pending.slice(0, 8).map((r) => r.sermon_id + ' ' + r.english_title),
    text473: text473.count,
    etbm103: etbm103.count,
    unmatched473: text473.unmatched,
    unmatchedEtbm: etbm103.unmatched,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
