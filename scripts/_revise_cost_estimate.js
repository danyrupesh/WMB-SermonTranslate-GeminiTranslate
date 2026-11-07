const fs = require('fs');
const tok = require('../token-report.json');

const USD_INR = 84;
const GST = 0.18;
const TAMIL = 1.35;

function usdToInr(usd) {
  return { usd, inr: usd * USD_INR, inrWithGst: usd * USD_INR * (1 + GST) };
}
function line(tokens, rate) {
  const usd = (tokens / 1e6) * rate;
  return { tokens, usdPerM: rate, ...usdToInr(usd) };
}

const cats = tok.categories;
const knowledgeFull =
  cats.approved_sermon_paragraph_pairs.totalTokens +
  cats.bible_verse_pairs.totalTokens +
  cats.terminology_glossary.totalTokens +
  cats.phrase_glossary.totalTokens;
const pending = tok.pendingWorkload;
const en = pending.englishInputTokens;
const out = Math.round(en * TAMIL);
const n = pending.selected;
const avgEn = en / n;
const avgOut = avgEn * TAMIL;

function scenario(name, knowledgeTok, cacheHours, useCache, sermonCount = n) {
  const een = avgEn * sermonCount;
  const oout = avgOut * sermonCount;
  const create = useCache ? line(knowledgeTok, 2) : line(0, 0);
  const storage = useCache ? line(knowledgeTok, 4.5 * cacheHours) : line(0, 0);
  const instr = 500 * sermonCount;
  const inTok = een + instr + (useCache ? 0 : knowledgeTok);
  const cachedReads = useCache ? knowledgeTok * sermonCount : 0;
  const trIn = line(inTok, 1);
  const trCache = line(cachedReads, 0.2);
  const trOut = line(oout, 6);
  const analysisInTok = Math.min(knowledgeTok, 500000);
  const aIn = line(analysisInTok, 0.125);
  const aOut = line(Math.round(analysisInTok * 0.05), 0.75);
  const valInTok = Math.round((een + oout) * 0.15);
  const vIn = line(valInTok, 0.125);
  const vOut = line(Math.round(valInTok * 0.1), 0.75);
  const gcs = usdToInr(0.0102);
  const totalUsd =
    create.usd +
    storage.usd +
    trIn.usd +
    trCache.usd +
    trOut.usd +
    aIn.usd +
    aOut.usd +
    vIn.usd +
    vOut.usd +
    gcs.usd;
  const total = usdToInr(totalUsd);
  return {
    name,
    pendingSermons: sermonCount,
    knowledgeTokensUsed: knowledgeTok,
    cacheHours,
    useCache,
    components: {
      cacheCreateOnce: create,
      cacheStorage: storage,
      translationBatchInput: trIn,
      translationBatchCachedInput: trCache,
      translationBatchOutput: trOut,
      analysisFlashLiteBatchInput: aIn,
      analysisFlashLiteBatchOutput: aOut,
      validationFlashLiteBatchInput: vIn,
      validationFlashLiteBatchOutput: vOut,
      gcs,
    },
    total,
    budget: {
      availableInr: 2500,
      ceilingInr: 2000,
      reserveInr: 500,
      withinCeiling: total.inrWithGst <= 2000,
      withinAvailable: total.inrWithGst <= 2500,
    },
  };
}

function costN(nn, k = 180000, hours = 1) {
  return scenario('tmp', k, hours, true, nn).total.usd;
}

const ceilingUsd = 2000 / (USD_INR * (1 + GST));
let fit = 0;
for (let i = 1; i <= 600; i++) {
  if (costN(i) <= ceilingUsd) fit = i;
  else break;
}

const scenarios = {
  A_distilled_180k_cache_1h: scenario('A_distilled_180k_cache_1h', 180000, 1, true, 600),
  A2_distilled_180k_cache_24h: scenario('A2_distilled_180k_cache_24h', 180000, 24, true, 600),
  B_full_ref_cache_1h: scenario('B_full_ref_cache_1h', knowledgeFull, 1, true, 600),
  C_no_cache_small_glossary_40k: scenario('C_no_cache_small_glossary_40k', 40000, 0, false, 600),
  D_pilot_5_distilled_1h: scenario('D_pilot_5_distilled_1h', 180000, 1, true, 5),
  E_budget_fit_distilled_1h: scenario('E_budget_fit_distilled_1h', 180000, 1, true, fit),
};

const cost = {
  assumptions: {
    usdInr: USD_INR,
    gstRate: GST,
    tamilOutRatio: TAMIL,
    pendingSermonCount: n,
    pricingSource: 'https://ai.google.dev/gemini-api/docs/pricing',
    models: {
      analysis_validation: 'gemini-3.1-flash-lite (Batch)',
      translation: 'gemini-3.1-pro-preview (Batch)',
      tokenCountingModel: tok.model,
    },
    note: 'countTokens used for actual token counts. No generation requests. Prefer 1h cache TTL for batch windows.',
  },
  pricingUsdPerMillion: {
    'gemini-3.1-flash-lite': {
      standard: { input: 0.25, output: 1.5, cache: 0.025, cacheStoragePerMTokHour: 1 },
      batch: { input: 0.125, output: 0.75, cache: 0.0125, cacheStoragePerMTokHour: 0.5 },
    },
    'gemini-3.1-pro-preview': {
      standard: {
        input: 2,
        output: 12,
        cache: 0.2,
        cacheStoragePerMTokHour: 4.5,
        inputOver200k: 4,
        outputOver200k: 18,
        cacheOver200k: 0.4,
      },
      batch: {
        input: 1,
        output: 6,
        cache: 0.2,
        cacheStoragePerMTokHour: 4.5,
        inputOver200k: 2,
        outputOver200k: 9,
      },
    },
  },
  knowledgeTokensTotal: knowledgeFull,
  pending,
  budgetFit: {
    ceilingInr: 2000,
    ceilingUsd,
    maxSermonsAtDistilled1hCache: fit,
    costAtFit: scenarios.E_budget_fit_distilled_1h.total,
    costAt600_1h: scenarios.A_distilled_180k_cache_1h.total,
    pilot5: scenarios.D_pilot_5_distilled_1h.total,
  },
  scenarios,
};

fs.writeFileSync('cost-estimate.json', JSON.stringify(cost, null, 2));

const md = `# Token Report & Cost Estimate (600 pending sermons)

Generated: ${new Date().toISOString()}

## Method

- **Actual tokens** via Gemini \`countTokens\` (\`${tok.model}\`).
- **0** generation requests.
- **0** GCS uploads.

## Reference corpus tokens by category

| Category | Records | Tokens |
| --- | ---: | ---: |
${Object.values(cats)
  .map((c) => `| ${c.category} | ${c.records} | ${c.totalTokens.toLocaleString()} |`)
  .join('\n')}
| **Combined reference** |  | **${tok.combinedReferenceTokens.toLocaleString()}** |

## Pending workload (${pending.selected} sermons)

| Metric | Value |
| --- | ---: |
| Pending available (excl. approved) | ${pending.pendingAvailable} |
| Selected | ${pending.selected} |
| English input tokens (actual) | ${en.toLocaleString()} |
| Estimated Tamil output (×${TAMIL}) | ${out.toLocaleString()} |
| Avg English tokens / sermon | ${avgEn.toFixed(1)} |

## Critical budget finding

With Gemini 3.1 Pro Preview Batch + a 180k distilled cache (1h TTL):

| Workload | INR + GST | Within ₹2,000 ceiling |
| --- | ---: | --- |
| Pilot 5 sermons | ₹${scenarios.D_pilot_5_distilled_1h.total.inrWithGst.toFixed(0)} | ${scenarios.D_pilot_5_distilled_1h.budget.withinCeiling} |
| Max fit under ceiling | **${fit} sermons** (₹${scenarios.E_budget_fit_distilled_1h.total.inrWithGst.toFixed(0)}) | true |
| Full 600 sermons | ₹${scenarios.A_distilled_180k_cache_1h.total.inrWithGst.toFixed(0)} | false |

**₹2,500 is not enough for 600 Pro Batch translations** at measured ~${avgEn.toFixed(0)} English tokens/sermon.

## Cost scenarios

${Object.entries(scenarios)
  .map(
    ([k, s]) => `### ${k}
- Sermons: ${s.pendingSermons}
- Knowledge tokens: ${s.knowledgeTokensUsed.toLocaleString()}
- Cache hours: ${s.cacheHours}
- Total USD: **$${s.total.usd.toFixed(2)}**
- Total INR + GST: **₹${s.total.inrWithGst.toFixed(0)}**
- Within ₹2,000 ceiling: **${s.budget.withinCeiling}**
`
  )
  .join('\n')}

## Recommendation

1. Do **not** cache the full ~${(tok.combinedReferenceTokens / 1e6).toFixed(1)}M-token reference corpus.
2. Build a distilled knowledge package (≤180k tokens) from approved pairs + glossary.
3. Run a **5-sermon pilot** first.
4. Keep context-cache TTL short (≈1 hour) — 24h Pro cache storage alone can consume most of the budget.
5. Reassess model tier / sermon count after pilot actuals.

## Related files

- \`token-report.json\`
- \`cost-estimate.json\`
- \`corpus-integration-audit.md\`
- \`consolidated_reference/consolidated-corpus-proposal.md\`
- \`consolidated_reference/audit/\`
`;

fs.writeFileSync('cost-estimate.md', md);
fs.writeFileSync('token-report.md', md);
console.log(
  JSON.stringify(
    {
      fit,
      pilot5InrGst: scenarios.D_pilot_5_distilled_1h.total.inrWithGst,
      A600InrGst: scenarios.A_distilled_180k_cache_1h.total.inrWithGst,
      A2_24h: scenarios.A2_distilled_180k_cache_24h.total.inrWithGst,
      knowledgeFull,
    },
    null,
    2
  )
);
