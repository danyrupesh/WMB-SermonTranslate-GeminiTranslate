/**
 * Phase 3 — Compare baseline paid pilot vs Phase 3 benchmark translation.
 * Offline only. No generateContent.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SERMON_ID = '54-0812';
const BASE = path.join(ROOT, 'reports', 'pilot', SERMON_ID);
const BENCH = path.join(BASE, 'phase3_benchmark');
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
function loadBible() {
  const rows = readJson(BIBLE_SOURCE);
  const byRef = new Map();
  for (const r of rows) if (r.ref && !byRef.has(r.ref)) byRef.set(r.ref, r);
  return byRef;
}

function paragraphMap(doc) {
  return new Map((doc.paragraphs || []).map((p) => [String(p.label), p]));
}

function main() {
  const baselinePath = path.join(BASE, 'sermon_54-0812.en-ta.json');
  const benchPath = path.join(BENCH, 'sermon_54-0812.en-ta.json');
  const baselineMeta = readJson(path.join(BASE, 'run-meta.json'));
  const benchMeta = readJson(path.join(BENCH, 'run-meta.json'));
  const baseline = readJson(baselinePath);
  const bench = readJson(benchPath);
  const bible = loadBible();
  const john514 = bible.get('John 5:14');
  const mark1617 = bible.get('Mark 16:17');
  const baselineHashBefore = fs.existsSync(path.join(BENCH, 'baseline-integrity.json'))
    ? readJson(path.join(BENCH, 'baseline-integrity.json'))
    : null;

  const baselineHashNow = {
    en_ta_json: sha256File(baselinePath),
    preview_html: sha256File(path.join(BASE, 'sermon_54-0812.preview.html')),
    run_meta: sha256File(path.join(BASE, 'run-meta.json')),
  };

  const bMap = paragraphMap(baseline);
  const nMap = paragraphMap(bench);
  const comparisons = [];
  const improvements = [];
  const weaknesses = [];
  const humanReview = [];

  for (const label of EXPECTED) {
    const b = bMap.get(label);
    const n = nMap.get(label);
    const row = {
      label,
      baseline_present: Boolean(b && String(b.tamil || '').trim()),
      phase3_present: Boolean(n && String(n.tamil || '').trim()),
      english_identical: b && n ? String(b.english) === String(n.english) : false,
      tamil_identical: b && n ? String(b.tamil) === String(n.tamil) : false,
      baseline_ta_bytes: b ? bytes(b.tamil) : 0,
      phase3_ta_bytes: n ? bytes(n.tamil) : 0,
      baseline_incomplete: b ? incomplete(b.tamil) : false,
      phase3_incomplete: n ? incomplete(n.tamil) : false,
      delta_ta_bytes: 0,
      notes: [],
    };
    row.delta_ta_bytes = row.phase3_ta_bytes - row.baseline_ta_bytes;
    if (!row.baseline_present) row.notes.push('baseline_missing_tamil');
    if (!row.phase3_present) {
      row.notes.push('phase3_missing_tamil');
      weaknesses.push({ label, issue: 'Phase 3 Tamil missing' });
    }
    if (b && n && !row.tamil_identical) {
      if (row.phase3_ta_bytes > row.baseline_ta_bytes * 1.05) {
        improvements.push({
          label,
          note: 'Phase 3 Tamil longer (+' + row.delta_ta_bytes + ' bytes) — possible fuller cadence retention',
        });
      } else if (row.phase3_ta_bytes < row.baseline_ta_bytes * 0.9) {
        weaknesses.push({
          label,
          issue: 'Phase 3 Tamil shorter than baseline (−' + Math.abs(row.delta_ta_bytes) + ' bytes); check compression',
        });
        humanReview.push({ label, category: 'possible_compression', action: 'Compare meaning coverage' });
      } else {
        improvements.push({ label, note: 'Tamil wording changed vs baseline (similar length)' });
      }
    }
    if (row.baseline_incomplete && !row.phase3_incomplete) {
      weaknesses.push({
        label,
        issue: 'Baseline preserved ...?... gap; Phase 3 may have filled or altered the editor gap — verify against English',
      });
      humanReview.push({ label, category: 'editor_gap', action: 'Ensure ...?... not invented away incorrectly' });
    }
    comparisons.push(row);
  }

  // Bible checks
  const bibleReview = [];
  function checkBible(label, ref, approved) {
    const b = bMap.get(label);
    const n = nMap.get(label);
    const item = {
      label,
      ref,
      approved_tamil: approved ? approved.tamil : null,
      baseline_contains_approved: approved && b ? String(b.tamil).includes(approved.tamil) : false,
      phase3_contains_approved: approved && n ? String(n.tamil).includes(approved.tamil) : false,
      baseline_quote: (String((b && b.tamil) || '').match(/[“"]([^”"]{12,180})[”"]/) || [])[1] || null,
      phase3_quote: (String((n && n.tamil) || '').match(/[“"]([^”"]{12,180})[”"]/) || [])[1] || null,
    };
    if (item.phase3_contains_approved && !item.baseline_contains_approved) {
      improvements.push({
        label,
        note: 'Phase 3 embeds approved Bible Tamil for ' + ref + ' (baseline did not)',
      });
    } else if (!item.phase3_contains_approved) {
      humanReview.push({
        label,
        category: 'bible_quotation',
        ref,
        action: 'Human check whether Phase 3 paraphrase is acceptable vs approved BSI OV Tamil',
        approved_tamil: item.approved_tamil,
        phase3_quote: item.phase3_quote,
      });
    }
    bibleReview.push(item);
  }
  checkBible('3', 'John 5:14', john514);
  checkBible('13', 'Mark 16:17', mark1617);

  // Loanword / style
  for (const [label, re, note] of [
    ['2', /multiple sclerosis/i, 'English medical parenthetical'],
    ['16', /\(peptic/i, 'English peptic parenthetical'],
  ]) {
    const bHas = re.test(String((bMap.get(label) || {}).tamil || ''));
    const nHas = re.test(String((nMap.get(label) || {}).tamil || ''));
    if (bHas && !nHas) improvements.push({ label, note: 'Removed English loanword parenthetical: ' + note });
    if (!bHas && nHas) weaknesses.push({ label, issue: 'Introduced English loanword parenthetical: ' + note });
    if (nHas) humanReview.push({ label, category: 'loanword_style', action: 'Style preference for ' + note });
  }

  const structuralOk =
    EXPECTED.every((l) => nMap.has(l) && String(nMap.get(l).tamil || '').trim()) &&
    (bench.paragraphs || []).length === 17;

  const costBaseline = {
    prompt: baselineMeta.usage && baselineMeta.usage.promptTokenCount,
    output: baselineMeta.usage && baselineMeta.usage.candidatesTokenCount,
  };
  const costBench = {
    prompt: benchMeta.usage && benchMeta.usage.promptTokenCount,
    output: benchMeta.usage && benchMeta.usage.candidatesTokenCount,
  };
  function costInr(prompt, output) {
    const usd = ((prompt || 0) / 1e6) * 2 + ((output || 0) / 1e6) * 12;
    return { usd: Number(usd.toFixed(6)), inr_gst: Number((usd * USD_INR * (1 + GST)).toFixed(2)) };
  }

  const promptImprovements = [
    'Explicitly require preserving English editor/tape gaps (`...?...`) verbatim in Tamil without inventing missing speech.',
    'Add a rule: when a verified Bible pair is injected, the quoted Tamil must use that exact approved Tamil (or a clearly marked Branham parenthetical outside the quote).',
    'Discourage English medical parentheticals unless no established Tamil clinical form exists in the glossary.',
    'Ask the model to keep Branham repetitions (a—a, You—you) as natural Tamil hesitation patterns rather than smoothing them away.',
    'For multi-verse paraphrases (e.g. Mark 16:17–18), inject both verified verses when both halves are present in the quotation.',
    'Require tamil_title to be a short title only (not full header place/date dump), matching preaching catalog style.',
  ];

  const report = {
    phase: '3',
    mode: 'quality_benchmark_comparison',
    generated_at: new Date().toISOString(),
    sermon_id: SERMON_ID,
    generateContent_called_in_this_script: false,
    structural_validation_phase3: structuralOk ? 'PASS' : 'FAIL',
    baseline_integrity: {
      snapshot: baselineHashBefore,
      current: baselineHashNow,
      unchanged:
        baselineHashBefore &&
        baselineHashBefore.en_ta_json === baselineHashNow.en_ta_json &&
        baselineHashBefore.preview_html === baselineHashNow.preview_html &&
        baselineHashBefore.run_meta === baselineHashNow.run_meta,
    },
    titles: {
      baseline_tamil_title: baseline.tamil_title,
      phase3_tamil_title: bench.tamil_title,
    },
    runs: {
      baseline: {
        model: baselineMeta.model,
        bible_pairs_injected: baselineMeta.bible_pairs_injected,
        usage: baselineMeta.usage,
        cost: costInr(costBaseline.prompt, costBaseline.output),
        note: baselineMeta.note,
      },
      phase3: {
        model: benchMeta.model,
        prompt_version: benchMeta.prompt_version,
        bible_pairs_injected: benchMeta.bible_pairs_injected,
        usage: benchMeta.usage,
        cost: costInr(costBench.prompt, costBench.output),
        ms: benchMeta.ms,
        note: benchMeta.note,
      },
    },
    paragraph_comparisons: comparisons,
    bible_quotation_review: bibleReview,
    improvements,
    remaining_weaknesses: weaknesses,
    human_review_required: humanReview,
    recommended_prompt_improvements: promptImprovements,
    verdict: {
      status: structuralOk ? 'BENCHMARK_COMPLETE' : 'BENCHMARK_STRUCTURAL_FAIL',
      quality_summary:
        'Phase 3 used the Phase 2B distilled prompt + verified Bible pairs in one full-sermon request. Compare improvements/weaknesses lists; do not auto-promote to source_of_truth.',
      stop: 'No bulk translation. No database writes. No further generateContent in this phase.',
    },
  };

  const jsonPath = path.join(BENCH, 'phase3-quality-comparison.json');
  const mdPath = path.join(BENCH, 'phase3-quality-review.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '# Phase 3 — Tamil Quality Benchmark Review — 54-0812',
    '',
    'Generated: ' + report.generated_at,
    '',
    '**Baseline preserved.** New translation is under `phase3_benchmark/` only.',
    '',
    '## Status: `' + report.verdict.status + '`',
    '- Phase 3 structural (17 paragraphs): **' + (structuralOk ? 'PASS' : 'FAIL') + '**',
    '- Baseline files unchanged: **' +
      (report.baseline_integrity.unchanged === true
        ? 'YES'
        : report.baseline_integrity.unchanged === false
          ? 'NO'
          : 'snapshot missing / checked via hashes below') +
      '**',
    '',
    '## Cost & usage',
    '| Run | Prompt tokens | Output tokens | INR + GST |',
    '| --- | ---: | ---: | ---: |',
    '| Baseline (paid yesterday) | ' +
      costBaseline.prompt +
      ' | ' +
      costBaseline.output +
      ' | ₹' +
      report.runs.baseline.cost.inr_gst +
      ' |',
    '| Phase 3 benchmark (this run) | ' +
      costBench.prompt +
      ' | ' +
      costBench.output +
      ' | ₹' +
      report.runs.phase3.cost.inr_gst +
      ' |',
    '',
    '- Phase 3 prompt version: `' + (benchMeta.prompt_version || '') + '`',
    '- Phase 3 Bible pairs injected: **' + benchMeta.bible_pairs_injected + '**',
    '- Baseline Bible pairs injected: **' + baselineMeta.bible_pairs_injected + '**',
    '',
    '## Titles',
    '- Baseline TA title: ' + baseline.tamil_title,
    '- Phase 3 TA title: ' + bench.tamil_title,
    '',
    '## Paragraph comparison',
    '| Label | TA changed | Δ bytes | Incomplete B→3 |',
    '| --- | --- | ---: | --- |',
    ...comparisons.map(
      (c) =>
        '| ' +
        c.label +
        ' | ' +
        (c.tamil_identical ? 'same' : 'changed') +
        ' | ' +
        c.delta_ta_bytes +
        ' | ' +
        (c.baseline_incomplete ? 'Y' : 'n') +
        '→' +
        (c.phase3_incomplete ? 'Y' : 'n') +
        ' |'
    ),
    '',
    '## Improvements vs baseline',
    improvements.length ? improvements.map((x, i) => i + 1 + '. [' + x.label + '] ' + x.note).join('\n') : '_None noted._',
    '',
    '## Remaining weaknesses',
    weaknesses.length ? weaknesses.map((x, i) => i + 1 + '. [' + x.label + '] ' + x.issue).join('\n') : '_None noted._',
    '',
    '## Bible quotations',
    ...bibleReview.map(
      (b) =>
        '- Para `' +
        b.label +
        '` (' +
        b.ref +
        '): baseline approved=' +
        b.baseline_contains_approved +
        ', phase3 approved=' +
        b.phase3_contains_approved +
        (b.phase3_quote ? ' — Phase 3 quote: “' + b.phase3_quote + '”' : '')
    ),
    '',
    '## Human review required',
    humanReview.length
      ? humanReview
          .map((h, i) => i + 1 + '. [' + h.label + '] ' + h.category + ' — ' + h.action)
          .join('\n')
      : '_None._',
    '',
    '## Recommended prompt improvements (next benchmark)',
    ...promptImprovements.map((x, i) => i + 1 + '. ' + x),
    '',
    '## Stop',
    'One Phase 3 generation completed. No bulk translation. No database writes.',
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(JSON.stringify({ structuralOk, jsonPath, mdPath, improvements: improvements.length, weaknesses: weaknesses.length }, null, 2));
}

main();
