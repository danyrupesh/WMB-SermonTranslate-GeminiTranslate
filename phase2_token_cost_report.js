/**
 * Phase 2 — Actual Gemini countTokens for consolidated categories + cost estimate for 600 pending.
 * Uses countTokens only (NOT generation). No GCS uploads.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenAI } = require('@google/genai');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'consolidated_reference');
const CAT = path.join(OUT, 'categories');
const PENDING_COUNT = Number(process.env.PENDING_SERMON_COUNT || 600);
const MODEL_COUNT = process.env.TOKEN_MODEL || 'gemini-3.1-flash-lite';
const USD_INR = Number(process.env.USD_INR || 84);
const GST_RATE = Number(process.env.GST_RATE || 0.18);
const TAMIL_OUT_RATIO = Number(process.env.TAMIL_OUT_RATIO || 1.35); // Tamil tokens ≈ ratio * English
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 24);
const VALIDATION_FRACTION = Number(process.env.VALIDATION_FRACTION || 0.15); // validate ~15% of output as input again

// Official Gemini Developer API pricing (ai.google.dev/gemini-api/docs/pricing) as of report generation
const PRICING = {
  'gemini-3.1-flash-lite': {
    standard: { input: 0.25, output: 1.5, cache: 0.025, cacheStoragePerMTokHour: 1.0 },
    batch: { input: 0.125, output: 0.75, cache: 0.0125, cacheStoragePerMTokHour: 0.5 },
  },
  'gemini-3.1-pro-preview': {
    standard: {
      input: 2.0,
      output: 12.0,
      cache: 0.2,
      cacheStoragePerMTokHour: 4.5,
      inputOver200k: 4.0,
      outputOver200k: 18.0,
      cacheOver200k: 0.4,
    },
    batch: {
      input: 1.0,
      output: 6.0,
      cache: 0.2,
      cacheStoragePerMTokHour: 4.5,
      inputOver200k: 2.0,
      outputOver200k: 9.0,
    },
  },
};

// Rough GCS assumptions (USD) — configurable
const GCS = {
  storagePerGbMonth: 0.02,
  classAPer10k: 0.05,
  classBPer10k: 0.004,
  assumedUploadGb: 0.5,
  assumedClassA: 50,
  assumedClassB: 200,
};

function loadApiKey() {
  const p = path.join(ROOT, 'Key.secure.txt');
  return fs.readFileSync(p, 'utf8').trim();
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

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSermonCode(name) {
  const m = String(name || '')
    .trim()
    .toUpperCase()
    .match(/^(\d{2})-(\d{2})-?(\d{2})([A-Z]?)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}${m[3]}${m[4] || ''}`;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function categoryTexts() {
  const approved = readJsonl(path.join(CAT, 'approved_sermon_paragraph_pairs', 'pairs.jsonl'));
  const bible = readJsonl(path.join(CAT, 'bible_verse_pairs', 'verses.jsonl'));
  const docIndex = readJsonl(path.join(CAT, 'document_level_sermon_references', 'index.jsonl'));
  const glossary = JSON.parse(
    fs.readFileSync(path.join(CAT, 'terminology_glossary', 'glossary.json'), 'utf8')
  );
  const phrases = JSON.parse(
    fs.readFileSync(path.join(CAT, 'phrase_glossary', 'phrase_glossary.json'), 'utf8')
  );

  const docTexts = [];
  for (const row of docIndex) {
    const f = path.join(CAT, 'document_level_sermon_references', `sermon_${row.sermon_id}.json`);
    if (!fs.existsSync(f)) continue;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    docTexts.push(`EN: ${d.english || ''}\nTA: ${d.tamil || ''}`);
  }

  const glossaryText = Array.isArray(glossary)
    ? glossary.map((g) => JSON.stringify(g)).join('\n')
    : JSON.stringify(glossary);
  const phraseText = Array.isArray(phrases)
    ? phrases.map((p) => `EN: ${p.english || ''}\nTA: ${p.tamil || ''}`).join('\n')
    : JSON.stringify(phrases);

  return {
    approved_sermon_paragraph_pairs: {
      records: approved.length,
      chunks: chunkRecords(
        approved.map((p) => `EN: ${p.english}\nTA: ${p.tamil}`),
        400000
      ),
    },
    document_level_sermon_references: {
      records: docTexts.length,
      chunks: chunkRecords(docTexts, 400000),
    },
    bible_verse_pairs: {
      records: bible.length,
      chunks: chunkRecords(
        bible.map((v) => `${v.en_title} ${v.book}:${v.chapter}:${v.verse}\nEN: ${v.english}\nTA: ${v.tamil}`),
        400000
      ),
    },
    terminology_glossary: {
      records: Array.isArray(glossary) ? glossary.length : Object.keys(glossary).length,
      chunks: chunkRecords([glossaryText], 400000),
    },
    phrase_glossary: {
      records: Array.isArray(phrases) ? phrases.length : Object.keys(phrases).length,
      chunks: chunkRecords(
        Array.isArray(phrases)
          ? phrases.map((p) => `EN: ${p.english || ''}\nTA: ${p.tamil || ''}`)
          : [phraseText],
        400000
      ),
    },
  };
}

function chunkRecords(texts, maxChars) {
  const chunks = [];
  let buf = '';
  for (const t of texts) {
    if ((buf.length + t.length + 1) > maxChars && buf) {
      chunks.push(buf);
      buf = t;
    } else {
      buf = buf ? `${buf}\n${t}` : t;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function countTokensForText(ai, text) {
  const res = await ai.models.countTokens({
    model: MODEL_COUNT,
    contents: text,
  });
  return Number(res.totalTokens || res.total_tokens || 0);
}

async function countCategory(ai, name, cat) {
  console.log(`Counting tokens: ${name} (${cat.chunks.length} chunks, ${cat.records} records)...`);
  let total = 0;
  const chunkTokens = [];
  for (let i = 0; i < cat.chunks.length; i++) {
    const tok = await countTokensForText(ai, cat.chunks[i]);
    chunkTokens.push(tok);
    total += tok;
    if ((i + 1) % 5 === 0 || i === cat.chunks.length - 1) {
      console.log(`  ${name}: chunk ${i + 1}/${cat.chunks.length} runningTotal=${total}`);
    }
  }
  return { category: name, records: cat.records, chunks: cat.chunks.length, totalTokens: total, chunkTokens };
}

async function pendingEnglishTokens(ai) {
  console.log(`Selecting ${PENDING_COUNT} pending English sermons for token counting...`);
  const approvedIds = new Set(
    fs
      .readdirSync(path.join(CAT, 'approved_sermon_paragraph_pairs', 'sermons'))
      .filter((f) => f.startsWith('sermon_'))
      .map((f) => f.replace(/^sermon_/, '').replace(/\.json$/, '').toUpperCase())
  );

  const enDb = openDb('d:/Freelancing/BRD-David/server/data/english_messages.sqlite');
  const rows = await all(enDb, 'SELECT id, name, message FROM messages');
  await closeDb(enDb);

  const pending = [];
  for (const r of rows) {
    const code = normalizeSermonCode(r.name);
    if (!code) continue;
    if (approvedIds.has(code)) continue;
    const text = stripTags(r.message);
    if (!text) continue;
    pending.push({ sermon_id: code, db_id: r.id, name: r.name, text, chars: text.length });
  }
  pending.sort((a, b) => a.sermon_id.localeCompare(b.sermon_id));
  const selected = pending.slice(0, PENDING_COUNT);
  console.log(`  Pending available=${pending.length}; selected=${selected.length}`);

  const chunks = chunkRecords(
    selected.map((s) => `SERMON ${s.sermon_id}\n${s.text}`),
    400000
  );
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const tok = await countTokensForText(ai, chunks[i]);
    total += tok;
    console.log(`  pending chunk ${i + 1}/${chunks.length} tokens=${tok} total=${total}`);
  }
  return {
    pendingAvailable: pending.length,
    selected: selected.length,
    selectedIds: selected.map((s) => s.sermon_id),
    englishInputTokens: total,
    estimatedTamilOutputTokens: Math.round(total * TAMIL_OUT_RATIO),
    avgEnglishTokensPerSermon: selected.length ? total / selected.length : 0,
  };
}

function usdToInr(usd) {
  const withGst = usd * (1 + GST_RATE);
  return { usd, inr: usd * USD_INR, inrWithGst: withGst * USD_INR };
}

function costLine(tokens, usdPerM) {
  const usd = (tokens / 1_000_000) * usdPerM;
  return { tokens, usdPerM, ...usdToInr(usd) };
}

function buildCostEstimate(tokenReport, pending) {
  const flash = PRICING['gemini-3.1-flash-lite'];
  const pro = PRICING['gemini-3.1-pro-preview'];

  // Knowledge / cache content = approved + bible + glossaries (NOT unverified db-derived by default)
  const knowledgeTokens =
    (tokenReport.categories.approved_sermon_paragraph_pairs?.totalTokens || 0) +
    (tokenReport.categories.bible_verse_pairs?.totalTokens || 0) +
    (tokenReport.categories.terminology_glossary?.totalTokens || 0) +
    (tokenReport.categories.phrase_glossary?.totalTokens || 0);

  // Practical approach: consolidated knowledge package, not full 140MB raw dump
  // Assume we cache a distilled knowledge package = min(knowledgeTokens, 200_000) for cost realism
  // AND also report full-cache scenario separately
  const distilledKnowledgeTokens = Math.min(knowledgeTokens, 180_000);
  const fullCacheTokens = knowledgeTokens;

  const scenarios = {};

  for (const [label, knowledgeTok, useCache] of [
    ['A_distilled_knowledge_cached_batch', distilledKnowledgeTokens, true],
    ['B_full_reference_cached_batch', fullCacheTokens, true],
    ['C_no_cache_batch_prompt_includes_small_glossary', Math.min(knowledgeTokens, 40_000), false],
  ]) {
    const enIn = pending.englishInputTokens;
    const taOut = pending.estimatedTamilOutputTokens;
    // Per request: cached content referenced + sermon english
    // Cache creation charged once as input; then cached input price per request
    const cacheCreate = useCache ? costLine(knowledgeTok, pro.batch.input) : costLine(0, 0);
    // Actually cache creation uses standard/cache create pricing — treat as standard input once
    const cacheCreateStd = useCache ? costLine(knowledgeTok, pro.standard.input) : costLine(0, 0);
    const cacheStorage = useCache
      ? costLine(knowledgeTok, pro.standard.cacheStoragePerMTokHour * CACHE_HOURS)
      : costLine(0, 0);

    // Translation batch: for each sermon, input = english (+ small uncached instruction ~500 tok) + cached read
    const instructionTokens = 500 * pending.selected;
    const translationInputUncached = enIn + instructionTokens + (useCache ? 0 : knowledgeTok);
    const translationCachedReads = useCache ? knowledgeTok * pending.selected : 0;

    const translationIn = costLine(translationInputUncached, pro.batch.input);
    const translationCached = costLine(translationCachedReads, pro.batch.cache);
    const translationOut = costLine(taOut, pro.batch.output);

    // Corpus analysis with Flash-Lite batch on approved+bible sample
    const analysisInTok = Math.min(knowledgeTok, 500_000);
    const analysisOutTok = Math.round(analysisInTok * 0.05);
    const analysisIn = costLine(analysisInTok, flash.batch.input);
    const analysisOut = costLine(analysisOutTok, flash.batch.output);

    // Validation Flash-Lite batch on fraction of translations
    const valInTok = Math.round((enIn + taOut) * VALIDATION_FRACTION);
    const valOutTok = Math.round(valInTok * 0.1);
    const valIn = costLine(valInTok, flash.batch.input);
    const valOut = costLine(valOutTok, flash.batch.output);

    const gcsUsd =
      GCS.assumedUploadGb * GCS.storagePerGbMonth +
      (GCS.assumedClassA / 10000) * GCS.classAPer10k +
      (GCS.assumedClassB / 10000) * GCS.classBPer10k;
    const gcs = usdToInr(gcsUsd);

    const totalUsd =
      cacheCreateStd.usd +
      cacheStorage.usd +
      translationIn.usd +
      translationCached.usd +
      translationOut.usd +
      analysisIn.usd +
      analysisOut.usd +
      valIn.usd +
      valOut.usd +
      gcsUsd;

    scenarios[label] = {
      knowledgeTokensUsed: knowledgeTok,
      useCache,
      cacheHours: CACHE_HOURS,
      pendingSermons: pending.selected,
      components: {
        cacheCreateOnce: cacheCreateStd,
        cacheStorage: cacheStorage,
        translationBatchInput: translationIn,
        translationBatchCachedInput: translationCached,
        translationBatchOutput: translationOut,
        analysisFlashLiteBatchInput: analysisIn,
        analysisFlashLiteBatchOutput: analysisOut,
        validationFlashLiteBatchInput: valIn,
        validationFlashLiteBatchOutput: valOut,
        gcs,
      },
      total: usdToInr(totalUsd),
      budget: {
        availableInr: 2500,
        ceilingInr: 2000,
        reserveInr: 500,
        withinCeiling: totalUsd * USD_INR * (1 + GST_RATE) <= 2000,
        withinAvailable: totalUsd * USD_INR * (1 + GST_RATE) <= 2500,
      },
    };
  }

  return {
    assumptions: {
      usdInr: USD_INR,
      gstRate: GST_RATE,
      tamilOutRatio: TAMIL_OUT_RATIO,
      cacheHours: CACHE_HOURS,
      validationFraction: VALIDATION_FRACTION,
      pendingSermonCount: PENDING_COUNT,
      pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing',
      models: {
        analysis_validation: 'gemini-3.1-flash-lite (Batch)',
        translation: 'gemini-3.1-pro-preview (Batch)',
        tokenCountingModel: MODEL_COUNT,
      },
      note: 'countTokens used for actual token counts. No generation requests were submitted.',
    },
    pricingUsdPerMillion: PRICING,
    knowledgeTokensTotal: knowledgeTokens,
    pending,
    scenarios,
  };
}

async function main() {
  if (!fs.existsSync(path.join(CAT, 'approved_sermon_paragraph_pairs', 'pairs.jsonl'))) {
    console.error('Run phase1_7_corpus_audit_consolidate.js first.');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey: loadApiKey() });
  const cats = categoryTexts();
  const categoryResults = {};
  let combined = 0;

  for (const [name, cat] of Object.entries(cats)) {
    const result = await countCategory(ai, name, cat);
    categoryResults[name] = result;
    combined += result.totalTokens;
  }

  const pending = await pendingEnglishTokens(ai);

  const tokenReport = {
    generatedAt: new Date().toISOString(),
    method: 'Gemini models.countTokens',
    model: MODEL_COUNT,
    generationRequests: 0,
    gcsUploads: 0,
    categories: categoryResults,
    combinedReferenceTokens: combined,
    pendingWorkload: pending,
  };

  const cost = buildCostEstimate(tokenReport, pending);

  fs.writeFileSync(path.join(ROOT, 'token-report.json'), JSON.stringify(tokenReport, null, 2));
  fs.writeFileSync(path.join(ROOT, 'cost-estimate.json'), JSON.stringify(cost, null, 2));

  const md = `# Token Report & Cost Estimate (600 pending sermons)

Generated: ${tokenReport.generatedAt}

## Method

- **Actual tokens** via Gemini \`countTokens\` (\`${MODEL_COUNT}\`).
- **0** generation requests.
- **0** GCS uploads.

## Reference corpus tokens by category

| Category | Records | Tokens |
| --- | ---: | ---: |
${Object.values(categoryResults)
  .map((c) => `| ${c.category} | ${c.records} | ${c.totalTokens.toLocaleString()} |`)
  .join('\n')}
| **Combined reference** |  | **${combined.toLocaleString()}** |

## Pending workload (${pending.selected} sermons)

| Metric | Value |
| --- | ---: |
| Pending available (excl. approved IDs) | ${pending.pendingAvailable} |
| Selected | ${pending.selected} |
| English input tokens (actual) | ${pending.englishInputTokens.toLocaleString()} |
| Estimated Tamil output tokens (×${TAMIL_OUT_RATIO}) | ${pending.estimatedTamilOutputTokens.toLocaleString()} |
| Avg English tokens / sermon | ${pending.avgEnglishTokensPerSermon.toFixed(1)} |

## Cost scenarios (INR includes ${GST_RATE * 100}% GST; USD/INR=${USD_INR})

${Object.entries(cost.scenarios)
  .map(([name, s]) => {
    const t = s.total;
    return `### ${name}
- Knowledge tokens: ${s.knowledgeTokensUsed.toLocaleString()}
- Total USD: **$${t.usd.toFixed(2)}**
- Total INR: **₹${t.inr.toFixed(0)}**
- Total INR + GST: **₹${t.inrWithGst.toFixed(0)}**
- Within ₹2,000 ceiling: **${s.budget.withinCeiling}**
- Within ₹2,500 available: **${s.budget.withinAvailable}**
`;
  })
  .join('\n')}

## Recommendation

Prefer **scenario A** (distilled knowledge package ≤180k tokens cached) unless quality review requires larger context.
Full raw reference caching (scenario B) may exceed the ₹2,000 internal ceiling depending on token totals.

Files: \`token-report.json\`, \`cost-estimate.json\`.
`;

  fs.writeFileSync(path.join(ROOT, 'cost-estimate.md'), md);
  fs.writeFileSync(path.join(ROOT, 'token-report.md'), md);

  console.log('Wrote token-report.json, cost-estimate.json, cost-estimate.md');
  console.log(`Combined reference tokens: ${combined}`);
  for (const [k, s] of Object.entries(cost.scenarios)) {
    console.log(
      `${k}: ₹${s.total.inrWithGst.toFixed(0)} (ceiling ok=${s.budget.withinCeiling})`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
