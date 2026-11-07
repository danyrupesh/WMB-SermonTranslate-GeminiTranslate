/**
 * Phase 3 — Offline audit of existing paid 54-0812 pilot.
 * No generateContent, no Gemini paid generation, no DB writes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'pilot', '54-0812');
const EN_SOURCE = path.join(ROOT, 'reports', 'english_source_sermons', '54-0812');
const BIBLE_SOURCE = path.join(ROOT, '..', 'dataset', 'source_of_truth', 'bible_parallel_dataset.json');
const PROMPT_PACKAGE = path.join(ROOT, 'knowledge', 'prompt_package.json');

const USD_INR = 84;
const GST = 0.18;
const PRICING = { input: 2.0, output: 12.0 }; // $/1M standard Gemini 3.1 Pro Preview

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function estimateUsd(inTok, outTok) {
  return (inTok / 1e6) * PRICING.input + (outTok / 1e6) * PRICING.output;
}
function inrGst(usd) {
  return usd * USD_INR * (1 + GST);
}
function normalizeWs(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function hasIncompleteMarker(s) {
  return /\.\.\.\?\.\.\.|…\?…|\?\?\?|\[incomplete\]|TODO|FIXME/i.test(String(s || ''));
}
function tamilRatio(en, ta) {
  const a = Buffer.byteLength(String(en || ''), 'utf8');
  const b = Buffer.byteLength(String(ta || ''), 'utf8');
  return a ? b / a : 0;
}

function loadBibleByRef() {
  if (!fs.existsSync(BIBLE_SOURCE)) return { ok: false, byRef: new Map(), byEn: new Map() };
  const rows = readJson(BIBLE_SOURCE);
  const byRef = new Map();
  const byEn = new Map();
  for (const r of rows) {
    const ref = String(r.ref || '').trim();
    if (ref && !byRef.has(ref)) byRef.set(ref, r);
    const en = String(r.english || '').trim();
    if (en && !byEn.has(en)) byEn.set(en, r);
  }
  return { ok: true, byRef, byEn, count: rows.length };
}

function findTermHits(pack, english) {
  const hits = [];
  const hay = String(english || '').toLowerCase();
  for (const t of pack.terms || []) {
    const en = String(t.en || '').trim();
    if (en.length < 4) continue;
    if (hay.includes(en.toLowerCase())) {
      hits.push({
        english: en,
        approved_tamil: (t.ta || []).map((x) => x.ta),
        cls: t.cls,
      });
    }
  }
  for (const t of pack.doctrinal || []) {
    const en = String(t.en || '').trim();
    if (en.length < 4) continue;
    if (hay.includes(en.toLowerCase())) {
      hits.push({
        english: en,
        approved_tamil: (t.ta || []).map((x) => x.ta),
        cls: 'doctrinal',
      });
    }
  }
  return hits;
}

function tamilContainsAny(ta, approvedList) {
  const s = String(ta || '');
  return (approvedList || []).some((a) => a && s.includes(a));
}

function main() {
  const translation = readJson(path.join(OUT_DIR, 'sermon_54-0812.en-ta.json'));
  const runMeta = readJson(path.join(OUT_DIR, 'run-meta.json'));
  const preflight2b = readJson(path.join(OUT_DIR, 'preflight-report.json'));
  const bible2b = readJson(path.join(OUT_DIR, 'bible-retrieval-report.json'));
  const sourceMeta = readJson(path.join(EN_SOURCE, 'metadata.json'));
  const sourceParas = readJson(path.join(EN_SOURCE, 'paragraphs.json'));
  const pack = readJson(PROMPT_PACKAGE);
  const bibleIdx = loadBibleByRef();

  const expectedLabels = ['header', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'];
  const issues = [];
  const humanReview = [];
  const paragraphAudits = [];

  const byLabel = new Map((translation.paragraphs || []).map((p) => [String(p.label), p]));
  const sourceByLabel = new Map(sourceParas.map((p) => [String(p.paragraph_label), p]));

  // 1) Completeness
  const missingLabels = expectedLabels.filter((l) => !byLabel.has(l));
  const extraLabels = [...byLabel.keys()].filter((l) => !expectedLabels.includes(l));
  const dupCheck = {};
  for (const p of translation.paragraphs || []) {
    dupCheck[p.label] = (dupCheck[p.label] || 0) + 1;
  }
  const duplicated = Object.entries(dupCheck)
    .filter(([, n]) => n > 1)
    .map(([l, n]) => ({ label: l, count: n }));

  if (missingLabels.length) {
    issues.push({ severity: 'fail', code: 'missing_paragraphs', detail: missingLabels });
  }
  if (extraLabels.length) {
    issues.push({ severity: 'warn', code: 'extra_paragraphs', detail: extraLabels });
  }
  if (duplicated.length) {
    issues.push({ severity: 'fail', code: 'duplicated_labels', detail: duplicated });
  }
  if ((translation.paragraphs || []).length !== 17) {
    issues.push({
      severity: 'fail',
      code: 'paragraph_count',
      detail: { expected: 17, actual: (translation.paragraphs || []).length },
    });
  }

  // 2) Alignment + integrity
  for (const label of expectedLabels) {
    const tp = byLabel.get(label);
    const sp = sourceByLabel.get(label);
    const audit = {
      label,
      present: Boolean(tp),
      english_matches_source: false,
      tamil_nonempty: false,
      incomplete_marker: false,
      en_chars: 0,
      ta_chars: 0,
      ta_en_byte_ratio: 0,
      notes: [],
    };
    if (!tp) {
      audit.notes.push('missing_in_translation');
      paragraphAudits.push(audit);
      continue;
    }
    if (!sp) {
      audit.notes.push('missing_in_phase2b_source_archive');
      issues.push({ severity: 'fail', code: 'source_missing_label', detail: label });
    }
    const enT = normalizeWs(tp.english);
    const enS = normalizeWs(sp && sp.text);
    audit.english_matches_source = enT === enS;
    if (!audit.english_matches_source) {
      audit.notes.push('english_differs_from_phase2b_source');
      // Allow only unicode normalization differences
      if (enT.replace(/[…]/g, '...') !== enS.replace(/[…]/g, '...')) {
        issues.push({
          severity: 'warn',
          code: 'english_source_mismatch',
          detail: { label, translation_en_chars: enT.length, source_en_chars: enS.length },
        });
        humanReview.push({
          label,
          category: 'english_alignment',
          reason: 'English text in translation JSON differs from Phase 2B english_source_sermons archive.',
          action: 'Human compare; do not auto-rewrite.',
        });
      }
    }
    const ta = String(tp.tamil || '').trim();
    audit.tamil_nonempty = ta.length > 0;
    audit.en_chars = Buffer.byteLength(String(tp.english || ''), 'utf8');
    audit.ta_chars = Buffer.byteLength(ta, 'utf8');
    audit.ta_en_byte_ratio = Number(tamilRatio(tp.english, ta).toFixed(3));
    audit.incomplete_marker = hasIncompleteMarker(ta) || hasIncompleteMarker(tp.english);
    if (!audit.tamil_nonempty) {
      issues.push({ severity: 'fail', code: 'empty_tamil', detail: label });
      humanReview.push({
        label,
        category: 'missing_tamil',
        reason: 'Tamil text empty.',
        action: 'Requires human translation — do not regenerate in this phase.',
      });
    }
    if (audit.incomplete_marker) {
      issues.push({ severity: 'warn', code: 'incomplete_marker', detail: label });
      humanReview.push({
        label,
        category: 'incomplete_marker',
        reason: 'Contains ...?... or similar incomplete/editor gap marker preserved or introduced.',
        action: 'Human decide whether marker should remain as in English source.',
        english_snippet: String(tp.english || '').match(/.{0,40}\.\.\.\?\.\.\..{0,40}|.{0,40}…\?….{0,40}/)?.[0] || null,
        tamil_snippet: String(tp.tamil || '').match(/.{0,40}\.\.\.\?\.\.\..{0,40}|.{0,40}…\?….{0,40}/)?.[0] || null,
      });
    }
    if (audit.ta_en_byte_ratio < 0.6 && ta.length > 0) {
      humanReview.push({
        label,
        category: 'possible_compression',
        reason:
          'Tamil byte length is under 60% of English; may be compressed relative to style guide (“Tamil may be longer”).',
        action: 'Human review for omitted meaning.',
        ta_en_byte_ratio: audit.ta_en_byte_ratio,
      });
    }

    // Terminology spot-check (flag only; no rewrite)
    const termHits = findTermHits(pack, tp.english);
    const termFlags = [];
    for (const hit of termHits.slice(0, 8)) {
      if (!hit.approved_tamil.length) continue;
      if (!tamilContainsAny(ta, hit.approved_tamil)) {
        termFlags.push({
          english_term: hit.english,
          approved_tamil: hit.approved_tamil,
          cls: hit.cls,
          note: 'Approved glossary form not found as substring in Tamil paragraph (context may justify alternate).',
        });
      }
    }
    if (termFlags.length) {
      audit.terminology_flags = termFlags;
      humanReview.push({
        label,
        category: 'terminology_uncertain',
        reason: 'One or more glossary terms present in English were not detected as approved Tamil substrings.',
        terms: termFlags,
        action: 'Human doctrinal/terminology review. Do not silently rewrite.',
      });
    }

    paragraphAudits.push(audit);
  }

  // 3) Bible quotation review vs Phase 2B verified pairs (pilot had 0 injected)
  const bibleChecks = [];
  const quoteChecks = [
    {
      label: '3',
      description: 'Branham paraphrase of John 5:14 / John 8:11 (sin no more / worse thing)',
      phase2b_ref: 'John 5:14',
      look_for_approved: true,
    },
    {
      label: '13',
      description: 'Mark 16:17–18 paraphrase (signs / lay hands on sick)',
      phase2b_ref: 'Mark 16:17',
      look_for_approved: true,
    },
  ];
  for (const qc of quoteChecks) {
    const tp = byLabel.get(qc.label);
    const approved = bibleIdx.byRef.get(qc.phase2b_ref);
    const check = {
      label: qc.label,
      description: qc.description,
      phase2b_ref: qc.phase2b_ref,
      approved_tamil_present_in_paragraph: false,
      approved_tamil: approved ? approved.tamil : null,
      tamil_quote_snippet: null,
      status: 'needs_human_review',
    };
    if (tp && approved) {
      check.approved_tamil_present_in_paragraph = String(tp.tamil || '').includes(approved.tamil);
      // Capture quoted Tamil if any Tamil quotes exist
      const m = String(tp.tamil || '').match(/[“"]([^”"]{10,200})[”"]/);
      check.tamil_quote_snippet = m ? m[1] : null;
      if (!check.approved_tamil_present_in_paragraph) {
        humanReview.push({
          label: qc.label,
          category: 'bible_quotation',
          reason:
            'Phase 2B would inject verified Bible Tamil for this quotation, but the paid pilot was generated with bible_pairs_injected=0 and the approved verse Tamil is not embedded verbatim in the paragraph.',
          phase2b_ref: qc.phase2b_ref,
          approved_tamil: approved.tamil,
          actual_tamil_quote_snippet: check.tamil_quote_snippet,
          action: 'Human decide whether to adopt approved Bible Tamil or keep pilot rendering. Do not auto-rewrite.',
        });
        check.status = 'diverges_from_approved_bible_pair';
      } else {
        check.status = 'matches_approved_bible_pair';
      }
    }
    bibleChecks.push(check);
  }

  // Specific doctrinal / style flags from manual inspection patterns
  const para2 = byLabel.get('2');
  if (para2 && /multiple sclerosis/i.test(para2.tamil)) {
    humanReview.push({
      label: '2',
      category: 'loanword_parenthetical',
      reason: 'Tamil keeps English “multiple sclerosis” in parentheses after Tamil transliteration.',
      action: 'Human style preference: keep bilingual medical gloss or Tamil-only.',
      snippet: 'மல்டிபிள் ஸ்களீரோசிஸ் (multiple sclerosis)',
    });
  }
  const para16 = byLabel.get('16');
  if (para16 && /\(peptic\)|\(peptic ulcer\)/i.test(para16.tamil)) {
    humanReview.push({
      label: '16',
      category: 'loanword_parenthetical',
      reason: 'Tamil includes English medical parentheticals (peptic / peptic ulcer).',
      action: 'Human style preference.',
    });
  }
  const para4 = byLabel.get('4');
  if (para4 && hasIncompleteMarker(para4.tamil)) {
    // already flagged via incomplete_marker loop; add context
    humanReview.push({
      label: '4',
      category: 'editor_gap_preserved',
      reason: 'English source has “...?...”; Tamil preserves “...?...” — likely intentional tape/editor gap.',
      action: 'Confirm keep as-is (recommended) vs inventing missing words.',
    });
  }

  // 4) Config diff: yesterday vs Phase 2B
  const rawChunks = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^raw_chunk_\d+\.txt$/i.test(f))
    .sort();
  const usage = runMeta.usage || {};
  const promptTok = usage.promptTokenCount || 0;
  const candTok = usage.candidatesTokenCount || 0;
  const actualUsd = estimateUsd(promptTok, candTok);
  const actualInr = inrGst(actualUsd);

  const configDiff = {
    model: {
      existing_run: runMeta.model || null,
      phase2b: preflight2b.model,
      match: (runMeta.model || '') === preflight2b.model,
    },
    api_version: {
      existing_run: 'not_recorded_in_run-meta (pilot used @google/genai; later scripts default v1beta)',
      phase2b: preflight2b.api_version,
      match: null,
    },
    prompt_version: {
      existing_run: runMeta.prompt_version || 'not_recorded (pre-phase2b pilot)',
      phase2b: preflight2b.prompt_version,
      match: false,
    },
    system_prompt: {
      existing_run:
        'Not hashed in run-meta. Actual promptTokenCount=' +
        promptTok +
        ' implies a smaller prompt than Phase 2B system ' +
        preflight2b.tokens.system +
        ' (+ user).',
      phase2b_system_tokens: preflight2b.tokens.system,
      phase2b_total_input_tokens: preflight2b.tokens.total_input,
      existing_prompt_token_count: promptTok,
      note: 'Existing pilot likely used an earlier/slimmer system prompt and/or chunked requests that still sum to 18911 prompt tokens.',
    },
    bible_pairs_injected: {
      existing_run: runMeta.bible_pairs_injected,
      phase2b: bible2b.injected_pairs.length,
      phase2b_refs: bible2b.injected_pairs.map((p) => p.ref),
      match: runMeta.bible_pairs_injected === bible2b.injected_pairs.length,
    },
    request_shape: {
      existing_run: {
        raw_chunk_files: rawChunks,
        inferred: rawChunks.length
          ? 'chunked generateContent (' + rawChunks.length + ' chunk file(s) present)'
          : 'unknown',
      },
      phase2b_plan: {
        prefer_single_request: preflight2b.chunking.prefer_single_request,
        estimated_chunks: preflight2b.chunking.estimated_chunks,
      },
    },
    source_sermon_hash: {
      phase2b_archive: sourceMeta.hash,
      phase2b_preflight: preflight2b.hashes.source_sermon,
      match: sourceMeta.hash === preflight2b.hashes.source_sermon,
    },
  };

  // 5) Overall status
  const failIssues = issues.filter((i) => i.severity === 'fail');
  // Structural integrity PASS if all 17 present, aligned labels, non-empty Tamil
  const structuralPass =
    missingLabels.length === 0 &&
    duplicated.length === 0 &&
    (translation.paragraphs || []).length === 17 &&
    expectedLabels.every((l) => String(byLabel.get(l).tamil || '').trim().length > 0);

  // Config parity with Phase 2B is expected FAIL (different era) — reported separately
  const phase2bParityPass =
    configDiff.prompt_version.match === true &&
    configDiff.bible_pairs_injected.match === true &&
    configDiff.model.match === true;

  const overallStatus = structuralPass ? (humanReview.length ? 'PASS_WITH_REVIEW' : 'PASS') : 'FAIL';

  const report = {
    phase: '3',
    mode: 'existing_pilot_audit',
    generated_at: new Date().toISOString(),
    sermon_id: '54-0812',
    english_title: translation.english_title || sourceMeta.title,
    tamil_title: translation.tamil_title || '',
    generateContent_called: false,
    paid_generation_rerun: false,
    translation_files_modified: false,
    database_writes: false,
    status: overallStatus,
    structural_pass: structuralPass,
    phase2b_config_parity_pass: phase2bParityPass,
    summary: {
      expected_paragraphs: 17,
      actual_paragraphs: (translation.paragraphs || []).length,
      missing_labels: missingLabels,
      duplicated_labels: duplicated,
      incomplete_marker_labels: paragraphAudits.filter((p) => p.incomplete_marker).map((p) => p.label),
      english_source_mismatch_labels: paragraphAudits
        .filter((p) => p.present && !p.english_matches_source)
        .map((p) => p.label),
      human_review_items: humanReview.length,
      fail_issues: failIssues.length,
      warn_issues: issues.filter((i) => i.severity === 'warn').length,
    },
    existing_run: {
      model: runMeta.model,
      english_paragraphs: runMeta.english_paragraphs,
      tamil_paragraphs: runMeta.tamil_paragraphs,
      bible_pairs_injected: runMeta.bible_pairs_injected,
      ms: runMeta.ms,
      usage,
      note: runMeta.note,
      out_json: runMeta.out_json,
      out_html: runMeta.out_html,
      raw_chunk_files: rawChunks,
    },
    actual_cost_from_run_meta: {
      pricing_basis: 'gemini-3.1-pro-preview standard ($2/1M input, $12/1M output)',
      usd_inr: USD_INR,
      gst_rate: GST,
      promptTokenCount: promptTok,
      candidatesTokenCount: candTok,
      totalTokenCount: usage.totalTokenCount || null,
      estimated_usd: Number(actualUsd.toFixed(6)),
      estimated_inr_gst: Number(actualInr.toFixed(2)),
      note: 'Computed from run-meta.json usage. Not a new API call.',
    },
    phase2b_comparison: {
      preflight_generated_at: preflight2b.generated_at,
      prompt_version: preflight2b.prompt_version,
      system_tokens: preflight2b.tokens.system,
      total_input_tokens: preflight2b.tokens.total_input,
      estimated_output_with_json: preflight2b.tokens.estimated_output_with_json,
      bible_pairs: bible2b.injected_pairs.map((p) => ({
        ref: p.ref,
        match_method: p.match_method,
      })),
      prefer_single_request: preflight2b.chunking.prefer_single_request,
      single_request_cost_estimate_inr_gst: preflight2b.cost_estimate.single_request.standard_inr_gst,
      config_diff: configDiff,
    },
    bible_quotation_checks: bibleChecks,
    paragraph_audits: paragraphAudits,
    issues,
    human_review_required: humanReview,
    verdict: {
      status: overallStatus,
      structural:
        structuralPass
          ? 'All 17 paragraphs present with non-empty Tamil; labels header+1–16 intact.'
          : 'Structural defects found — see fail issues.',
      phase2b_parity:
        'Existing paid pilot does NOT match Phase 2B prompt/Bible-injection configuration. That is expected; do not regenerate in Phase 3.',
      next_step:
        'STOP. Human review listed items. No generateContent until explicit approval for a future phase.',
    },
  };

  const jsonPath = path.join(OUT_DIR, 'phase3-existing-pilot-audit.json');
  const mdPath = path.join(OUT_DIR, 'phase3-existing-pilot-audit.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '# Phase 3 — Existing Pilot Audit — 54-0812 Prayer Line',
    '',
    'Generated: ' + report.generated_at,
    '',
    '**No generateContent. No paid Gemini generation. Translation files unchanged.**',
    '',
    '## Status: `' + report.status + '`',
    '',
    '- Structural integrity: **' + (structuralPass ? 'PASS' : 'FAIL') + '**',
    '- Phase 2B config parity: **' + (phase2bParityPass ? 'PASS' : 'FAIL (expected)') + '**',
    '- Human review items: **' + humanReview.length + '**',
    '',
    '## Existing paid run',
    '- Model: `' + (runMeta.model || '') + '`',
    '- Paragraphs: EN ' + runMeta.english_paragraphs + ' / TA ' + runMeta.tamil_paragraphs,
    '- Bible pairs injected at generation: **' + runMeta.bible_pairs_injected + '**',
    '- Duration: ' + runMeta.ms + ' ms',
    '- Raw chunk files: ' + (rawChunks.join(', ') || '(none)'),
    '- Note: ' + (runMeta.note || ''),
    '',
    '## Actual usage & cost (from run-meta)',
    '| Metric | Value |',
    '| --- | ---: |',
    '| Prompt tokens | ' + promptTok + ' |',
    '| Output tokens | ' + candTok + ' |',
    '| Total tokens | ' + (usage.totalTokenCount || '—') + ' |',
    '| Est. USD (standard) | $' + report.actual_cost_from_run_meta.estimated_usd + ' |',
    '| Est. INR + GST | ₹' + report.actual_cost_from_run_meta.estimated_inr_gst + ' |',
    '',
    '## Phase 2B vs existing generation',
    '| Item | Existing paid run | Phase 2B preflight |',
    '| --- | --- | --- |',
    '| Prompt version | ' +
      (runMeta.prompt_version || 'not recorded') +
      ' | `' +
      preflight2b.prompt_version +
      '` |',
    '| System / prompt tokens | promptTokenCount **' +
      promptTok +
      '** (summed) | system **' +
      preflight2b.tokens.system +
      '**, total input **' +
      preflight2b.tokens.total_input +
      '** |',
    '| Bible pairs | **' +
      runMeta.bible_pairs_injected +
      '** | **' +
      bible2b.injected_pairs.length +
      '** (' +
      bible2b.injected_pairs.map((p) => p.ref).join(', ') +
      ') |',
    '| Request shape | chunked (`' +
      rawChunks.join('`, `') +
      '`) | prefer **one** full-sermon request |',
    '| Model | `' + (runMeta.model || '') + '` | `' + preflight2b.model + '` |',
    '| API version | not in run-meta | `' + preflight2b.api_version + '` |',
    '',
    '## Paragraph verification',
    '- Expected labels: `header`, `1`–`16` (17 total)',
    '- Missing: ' + (missingLabels.length ? missingLabels.join(', ') : 'none'),
    '- Duplicated: ' + (duplicated.length ? JSON.stringify(duplicated) : 'none'),
    '- Incomplete markers (`...?...`): ' +
      (report.summary.incomplete_marker_labels.length
        ? report.summary.incomplete_marker_labels.join(', ')
        : 'none'),
    '',
    '| Label | EN=source | TA chars | TA/EN byte ratio | Incomplete |',
    '| --- | --- | ---: | ---: | --- |',
    ...paragraphAudits.map(
      (p) =>
        '| ' +
        p.label +
        ' | ' +
        (p.english_matches_source ? 'yes' : 'NO') +
        ' | ' +
        p.ta_chars +
        ' | ' +
        p.ta_en_byte_ratio +
        ' | ' +
        (p.incomplete_marker ? 'yes' : '') +
        ' |'
    ),
    '',
    '## Bible quotation checks',
    ...bibleChecks.map(
      (b) =>
        '- Para `' +
        b.label +
        '` (' +
        b.phase2b_ref +
        '): **' +
        b.status +
        '**' +
        (b.tamil_quote_snippet ? ' — Tamil quote: “' + b.tamil_quote_snippet + '”' : '')
    ),
    '',
    '## Corrections / items requiring human review',
    humanReview.length
      ? humanReview
          .map(
            (h, i) =>
              (i + 1) +
              '. **[' +
              h.label +
              '] ' +
              h.category +
              '** — ' +
              h.reason +
              '  \n   Action: ' +
              h.action
          )
          .join('\n')
      : '_None._',
    '',
    '## Issues',
    issues.length
      ? issues.map((i) => '- `' + i.severity + '` ' + i.code + ': ' + JSON.stringify(i.detail)).join('\n')
      : '_None._',
    '',
    '## Stop',
    'Audit complete. Do **not** call generateContent. Do **not** rewrite translation files. Do **not** process other sermons.',
    '',
  ].join('\n');

  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(
    JSON.stringify(
      {
        status: report.status,
        structural_pass: structuralPass,
        phase2b_config_parity_pass: phase2bParityPass,
        human_review_items: humanReview.length,
        actual_inr_gst: report.actual_cost_from_run_meta.estimated_inr_gst,
        jsonPath,
        mdPath,
      },
      null,
      2
    )
  );
}

main();
