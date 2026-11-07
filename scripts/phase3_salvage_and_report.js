/**
 * Offline salvage of Phase 3 paid raw response + quality comparison.
 * No generateContent / no retry.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SERMON_ID = '54-0812';
const BASE = path.join(ROOT, 'reports', 'pilot', SERMON_ID);
const BENCH = path.join(BASE, 'phase3_benchmark');
const RESP = path.join(ROOT, 'reports', 'responses', '54-0812_PHASE3_BENCHMARK');
const EN_SOURCE = path.join(ROOT, 'reports', 'english_source_sermons', SERMON_ID, 'paragraphs.json');
const BIBLE_SOURCE = path.join(ROOT, '..', 'dataset', 'source_of_truth', 'bible_parallel_dataset.json');
const EXPECTED = ['header', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'];
const USD_INR = 84;
const GST = 0.18;

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function bytes(s) {
  return Buffer.byteLength(String(s || ''), 'utf8');
}
function incomplete(s) {
  return /\.\.\.\?\.\.\.|…\?…/.test(String(s || ''));
}
function costInr(prompt, output) {
  const usd = ((prompt || 0) / 1e6) * 2 + ((output || 0) / 1e6) * 12;
  return { usd: Number(usd.toFixed(6)), inr_gst: Number((usd * USD_INR * (1 + GST)).toFixed(2)) };
}

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

function extractTitle(raw) {
  const m = String(raw || '').match(/"tamil_title"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return '';
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch (_) {
    return m[1];
  }
}

function main() {
  const rawPath = fs.existsSync(path.join(BENCH, 'raw_full.txt'))
    ? path.join(BENCH, 'raw_full.txt')
    : path.join(RESP, 'request-01.txt');
  const raw = fs.readFileSync(rawPath, 'utf8');
  const reqMeta = readJson(path.join(RESP, 'request-01.meta.json'));
  const baseline = readJson(path.join(BASE, 'sermon_54-0812.en-ta.json'));
  const baselineMeta = readJson(path.join(BASE, 'run-meta.json'));
  const sourceParas = readJson(EN_SOURCE);
  const integritySnap = readJson(path.join(BENCH, 'baseline-integrity.json'));
  const bibleRows = readJson(BIBLE_SOURCE);
  const byRef = new Map();
  for (const r of bibleRows) if (r.ref && !byRef.has(r.ref)) byRef.set(r.ref, r);

  const salvaged = salvageParagraphs(raw);
  const byLabel = new Map(salvaged.map((p) => [p.label, p]));
  const tamilTitle = extractTitle(raw);

  const translated = {
    sermon_id: SERMON_ID,
    english_title: 'Prayer Line',
    tamil_title: tamilTitle || (byLabel.get('header') && byLabel.get('header').tamil) || '',
    paragraphs: sourceParas.map((sp) => {
      const hit = byLabel.get(sp.paragraph_label);
      return {
        label: sp.paragraph_label,
        english: sp.text,
        tamil: hit ? hit.tamil : '',
        _salvaged: Boolean(hit),
      };
    }),
    _meta: {
      salvaged_from_raw: true,
      raw_parse: 'failed_json_max_tokens',
      finishReason: reqMeta.extra && reqMeta.extra.finishReason,
      salvaged_complete_paragraphs: salvaged.length,
      expected_paragraphs: 17,
    },
  };

  const jsonPath = path.join(BENCH, 'sermon_54-0812.en-ta.salvaged.json');
  fs.writeFileSync(jsonPath, JSON.stringify(translated, null, 2), 'utf8');

  const usage = reqMeta.usage || {};
  const runMeta = {
    sermon_id: SERMON_ID,
    phase3_benchmark: true,
    status: 'INCOMPLETE_MAX_TOKENS',
    model: reqMeta.model,
    api_version: reqMeta.api_version,
    prompt_version: reqMeta.prompt_version,
    finishReason: reqMeta.extra && reqMeta.extra.finishReason,
    usage,
    thoughtsTokenCount: usage.thoughtsTokenCount || null,
    estimated_usd_standard: costInr(
      usage.promptTokenCount,
      (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
    ).usd,
    estimated_inr_gst: costInr(
      usage.promptTokenCount,
      (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
    ).inr_gst,
    bible_pairs_injected: null,
    note:
      'Single generateContent finished with MAX_TOKENS. Thinking tokens consumed large share of 16384 budget. No automatic retry. Salvaged complete paragraph objects only.',
    raw_path: rawPath,
    salvaged_json: jsonPath,
    salvaged_complete_paragraphs: salvaged.length,
    baseline_dir: BASE,
  };
  fs.writeFileSync(path.join(BENCH, 'run-meta.json'), JSON.stringify(runMeta, null, 2), 'utf8');

  const baselineHashNow = {
    en_ta_json: sha256File(path.join(BASE, 'sermon_54-0812.en-ta.json')),
    preview_html: sha256File(path.join(BASE, 'sermon_54-0812.preview.html')),
    run_meta: sha256File(path.join(BASE, 'run-meta.json')),
  };

  const bMap = new Map(baseline.paragraphs.map((p) => [p.label, p]));
  const comparisons = [];
  const improvements = [];
  const weaknesses = [];
  const humanReview = [];

  for (const label of EXPECTED) {
    const b = bMap.get(label);
    const n = byLabel.get(label);
    const row = {
      label,
      baseline_present: Boolean(b && String(b.tamil || '').trim()),
      phase3_present: Boolean(n && String(n.tamil || '').trim()),
      tamil_identical: b && n ? String(b.tamil) === String(n.tamil) : false,
      baseline_ta_bytes: b ? bytes(b.tamil) : 0,
      phase3_ta_bytes: n ? bytes(n.tamil) : 0,
      baseline_incomplete: b ? incomplete(b.tamil) : false,
      phase3_incomplete: n ? incomplete(n.tamil) : false,
    };
    row.delta_ta_bytes = row.phase3_ta_bytes - row.baseline_ta_bytes;
    if (!row.phase3_present) {
      weaknesses.push({ label, issue: 'Phase 3 Tamil missing (output truncated at MAX_TOKENS)' });
      humanReview.push({
        label,
        category: 'missing_due_to_truncation',
        action: 'Do not invent. Future benchmark must prevent thinking-token starvation of maxOutputTokens.',
      });
    } else if (b && !row.tamil_identical) {
      if (row.phase3_ta_bytes > row.baseline_ta_bytes * 1.05) {
        improvements.push({
          label,
          note: 'Longer Tamil than baseline (+' + row.delta_ta_bytes + ' bytes)',
        });
      } else {
        improvements.push({ label, note: 'Tamil wording differs from baseline' });
      }
    }
    comparisons.push(row);
  }

  // Bible checks on salvaged paras only
  const bibleReview = [];
  for (const [label, ref] of [
    ['3', 'John 5:14'],
    ['13', 'Mark 16:17'],
  ]) {
    const approved = byRef.get(ref);
    const b = bMap.get(label);
    const n = byLabel.get(label);
    const item = {
      label,
      ref,
      approved_tamil: approved ? approved.tamil : null,
      baseline_contains_approved: approved && b ? String(b.tamil).includes(approved.tamil) : false,
      phase3_contains_approved: approved && n ? String(n.tamil).includes(approved.tamil) : false,
      phase3_available: Boolean(n),
      phase3_quote: n ? (String(n.tamil).match(/[“"]([^”"]{12,180})[”"]/) || [])[1] || null : null,
    };
    if (item.phase3_available && item.phase3_contains_approved && !item.baseline_contains_approved) {
      improvements.push({ label, note: 'Uses approved Bible Tamil for ' + ref });
    } else if (item.phase3_available && !item.phase3_contains_approved) {
      humanReview.push({
        label,
        category: 'bible_quotation',
        ref,
        action: 'Compare Phase 3 quote to approved BSI OV Tamil',
        approved_tamil: item.approved_tamil,
        phase3_quote: item.phase3_quote,
      });
    } else if (!item.phase3_available) {
      humanReview.push({
        label,
        category: 'bible_quotation_unavailable',
        ref,
        action: 'Paragraph truncated before completion; cannot assess Bible Tamil in this run',
      });
    }
    bibleReview.push(item);
  }

  const promptImprovements = [
    'Disable or tightly cap model thinking/reasoning tokens for translation JSON jobs, or raise maxOutputTokens enough that candidatesTokenCount can cover all 17 paragraphs after thoughts.',
    'Require the model to emit compact JSON (no pretty-print indentation) to reduce output tokens.',
    'Instruct: do not echo long English paragraphs back if schema already requires them — or allow tamil-only paragraphs with labels to cut output size (tradeoff vs validation).',
    'Explicitly preserve English editor gaps (`...?...`) unchanged in Tamil.',
    'When verified Bible pairs are injected, require exact approved Tamil inside quotation marks for those citations.',
    'For the next quality benchmark only: consider responseMimeType JSON with a schema that omits repeating english fields to fit one request under 16384 including thoughts.',
    'Do not auto-retry failed MAX_TOKENS runs without explicit approval (cost control).',
  ];

  const report = {
    phase: '3',
    mode: 'quality_benchmark_after_max_tokens',
    generated_at: new Date().toISOString(),
    sermon_id: SERMON_ID,
    generateContent_calls_this_phase: 1,
    automatic_retry: false,
    finishReason: reqMeta.extra && reqMeta.extra.finishReason,
    structural_validation_phase3: salvaged.length === 17 ? 'PASS' : 'FAIL',
    salvaged_complete_paragraphs: salvaged.length,
    expected_paragraphs: 17,
    baseline_integrity: {
      snapshot: integritySnap,
      current: baselineHashNow,
      unchanged:
        integritySnap.en_ta_json === baselineHashNow.en_ta_json &&
        integritySnap.preview_html === baselineHashNow.preview_html &&
        integritySnap.run_meta === baselineHashNow.run_meta,
    },
    runs: {
      baseline: {
        usage: baselineMeta.usage,
        bible_pairs_injected: baselineMeta.bible_pairs_injected,
        cost: costInr(
          baselineMeta.usage && baselineMeta.usage.promptTokenCount,
          baselineMeta.usage && baselineMeta.usage.candidatesTokenCount
        ),
      },
      phase3: {
        usage,
        thoughtsTokenCount: usage.thoughtsTokenCount,
        candidatesTokenCount: usage.candidatesTokenCount,
        promptTokenCount: usage.promptTokenCount,
        maxOutputTokens: 16384,
        thoughts_share_of_output_budget: usage.thoughtsTokenCount
          ? Number(((usage.thoughtsTokenCount / 16384) * 100).toFixed(1)) + '%'
          : null,
        cost_candidates_only: costInr(usage.promptTokenCount, usage.candidatesTokenCount),
        cost_if_thoughts_billed_as_output: costInr(
          usage.promptTokenCount,
          (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
        ),
        note: 'finishReason MAX_TOKENS. Cost shown both ways: candidates-only vs candidates+thoughts as output.',
      },
    },
    root_cause:
      'finishReason=MAX_TOKENS. thoughtsTokenCount=' +
      (usage.thoughtsTokenCount || 0) +
      ' plus candidatesTokenCount=' +
      (usage.candidatesTokenCount || 0) +
      ' exhausted the 16384 output budget before all 17 paragraph JSON objects were emitted.',
    paragraph_comparisons: comparisons,
    bible_quotation_review: bibleReview,
    improvements,
    remaining_weaknesses: weaknesses,
    human_review_required: humanReview,
    recommended_prompt_improvements: promptImprovements,
    files: {
      baseline_json: path.join(BASE, 'sermon_54-0812.en-ta.json'),
      phase3_raw: rawPath,
      phase3_salvaged_json: jsonPath,
      response_meta: path.join(RESP, 'request-01.meta.json'),
    },
    verdict: {
      status: 'BENCHMARK_INCOMPLETE_MAX_TOKENS',
      quality_summary:
        'One paid Phase 2B-prompt generation ran. Output truncated. Salvaged ' +
        salvaged.length +
        '/17 complete paragraph objects for partial comparison. Baseline untouched. No retry performed.',
      stop: 'STOP. No further generateContent without explicit approval. No bulk translation. No database writes.',
    },
  };

  const jsonReport = path.join(BENCH, 'phase3-quality-comparison.json');
  const mdReport = path.join(BENCH, 'phase3-quality-review.md');
  fs.writeFileSync(jsonReport, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '# Phase 3 — Tamil Quality Benchmark Review — 54-0812',
    '',
    'Generated: ' + report.generated_at,
    '',
    '## Status: `BENCHMARK_INCOMPLETE_MAX_TOKENS`',
    '',
    'One authorized `generateContent` request was executed with the Phase 2B prompt (full sermon, no chunking).',
    '',
    '- **finishReason:** `MAX_TOKENS`',
    '- **Thoughts tokens:** ' + (usage.thoughtsTokenCount || 0) + ' (~' + report.runs.phase3.thoughts_share_of_output_budget + ' of 16384 budget)',
    '- **Visible output tokens:** ' + (usage.candidatesTokenCount || 0),
    '- **Salvaged complete paragraphs:** **' + salvaged.length + ' / 17**',
    '- **Automatic retry:** no',
    '- **Baseline preserved:** **' + (report.baseline_integrity.unchanged ? 'YES' : 'NO') + '**',
    '',
    '### Root cause',
    report.root_cause,
    '',
    '## Cost & usage',
    '| Run | Prompt | Output (candidates) | Thoughts | INR + GST |',
    '| --- | ---: | ---: | ---: | ---: |',
    '| Baseline | ' +
      (baselineMeta.usage && baselineMeta.usage.promptTokenCount) +
      ' | ' +
      (baselineMeta.usage && baselineMeta.usage.candidatesTokenCount) +
      ' | — | ₹' +
      report.runs.baseline.cost.inr_gst +
      ' |',
    '| Phase 3 (candidates only) | ' +
      usage.promptTokenCount +
      ' | ' +
      usage.candidatesTokenCount +
      ' | ' +
      (usage.thoughtsTokenCount || 0) +
      ' | ₹' +
      report.runs.phase3.cost_candidates_only.inr_gst +
      ' |',
    '| Phase 3 (if thoughts=output) | ' +
      usage.promptTokenCount +
      ' | ' +
      ((usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)) +
      ' | ' +
      (usage.thoughtsTokenCount || 0) +
      ' | ₹' +
      report.runs.phase3.cost_if_thoughts_billed_as_output.inr_gst +
      ' |',
    '',
    '## Partial paragraph comparison (salvaged only)',
    '| Label | Phase3 present | Δ TA bytes | vs baseline |',
    '| --- | --- | ---: | --- |',
    ...comparisons.map(
      (c) =>
        '| ' +
        c.label +
        ' | ' +
        (c.phase3_present ? 'yes' : 'NO') +
        ' | ' +
        c.delta_ta_bytes +
        ' | ' +
        (c.phase3_present ? (c.tamil_identical ? 'same' : 'changed') : 'missing') +
        ' |'
    ),
    '',
    '## Improvements (where Phase 3 text exists)',
    improvements.length ? improvements.map((x, i) => i + 1 + '. [' + x.label + '] ' + x.note).join('\n') : '_None yet / truncated._',
    '',
    '## Remaining weaknesses',
    weaknesses.length ? weaknesses.map((x, i) => i + 1 + '. [' + x.label + '] ' + x.issue).join('\n') : '_None._',
    '',
    '## Bible quotations',
    ...bibleReview.map(
      (b) =>
        '- Para `' +
        b.label +
        '` (' +
        b.ref +
        '): available=' +
        b.phase3_available +
        ', approved_in_phase3=' +
        b.phase3_contains_approved +
        ', approved_in_baseline=' +
        b.baseline_contains_approved
    ),
    '',
    '## Human review required',
    humanReview.map((h, i) => i + 1 + '. [' + h.label + '] ' + h.category + ' — ' + h.action).join('\n'),
    '',
    '## Recommended prompt / config improvements for next benchmark',
    ...promptImprovements.map((x, i) => i + 1 + '. ' + x),
    '',
    '## Files',
    '- Baseline: `' + report.files.baseline_json + '`',
    '- Phase 3 raw: `' + report.files.phase3_raw + '`',
    '- Salvaged JSON: `' + report.files.phase3_salvaged_json + '`',
    '- Response meta: `' + report.files.response_meta + '`',
    '',
    '## Stop',
    'No further generateContent. No bulk translation. No database writes. Baseline unchanged.',
    '',
  ].join('\n');
  fs.writeFileSync(mdReport, md, 'utf8');

  console.log(
    JSON.stringify(
      {
        status: report.verdict.status,
        salvaged: salvaged.length,
        baseline_unchanged: report.baseline_integrity.unchanged,
        phase3_inr_gst_candidates_only: report.runs.phase3.cost_candidates_only.inr_gst,
        phase3_inr_gst_with_thoughts: report.runs.phase3.cost_if_thoughts_billed_as_output.inr_gst,
        jsonReport,
        mdReport,
        salvagedJson: jsonPath,
      },
      null,
      2
    )
  );
}

main();
