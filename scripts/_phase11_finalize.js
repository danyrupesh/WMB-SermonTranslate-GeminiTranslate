const fs = require('fs');

function est(t) {
  return Math.ceil(String(t || '').length / 3.2);
}

const DOCTRINAL = [
  'bride',
  'word',
  'seal',
  'rapture',
  'baptism',
  'holy ghost',
  'faith',
  'elect',
  'message',
  'prophet',
];

function bibleHit(en) {
  return /\b(genesis|exodus|matthew|mark|luke|john|acts|romans|hebrews|revelation|isaiah)\b/i.test(
    en
  ) || /\b\d+:\d+\b/.test(en);
}

function score(ex) {
  const en = (ex.english || '').toLowerCase();
  let s = 0;
  const tags = [];
  if (DOCTRINAL.some((x) => en.includes(x))) {
    s += 8;
    tags.push('doctrinal');
  }
  if (bibleHit(en) || /scripture|bible|verse/.test(en)) {
    s += 8;
    tags.push('bible_quotation');
  }
  if (/god bless|amen|is that right|you see|hallelujah/.test(en)) {
    s += 5;
    tags.push('repeated_preaching');
  }
  if (/"|said,|i said|he said/.test(en)) {
    s += 4;
    tags.push('conversational');
  }
  if (/\blike\b|as a |story/.test(en)) {
    s += 3;
    tags.push('illustration');
  }
  const n = ex.en_len || en.length;
  if (n < 90) {
    s += 2;
    tags.push('short_pattern');
  } else if (n > 350) {
    s += 3;
    tags.push('long_pattern');
  } else {
    s += 2;
    tags.push('sentence_construction');
  }
  return { score: s, tags };
}

const lib = JSON.parse(
  fs.readFileSync('knowledge/library/approved_examples_full.json', 'utf8')
).entries;
const scored = lib.map((e) => ({ ...e, ...score(e) })).sort((a, b) => b.score - a.score);
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
  const c = scored.find((e) => e.tags.includes(tag) && !used.has(e.source_id));
  if (c) {
    used.add(c.source_id);
    picked.push(c);
  }
}
for (const e of scored) {
  if (picked.length >= 36) break;
  if (used.has(e.source_id)) continue;
  used.add(e.source_id);
  picked.push(e);
}

const pack = JSON.parse(fs.readFileSync('knowledge/prompt_package.json', 'utf8'));
pack.examples = picked.slice(0, 36).map((e) => ({
  id: e.source_id,
  tags: e.tags,
  en: e.english,
  ta: e.tamil,
  score: e.score,
}));
fs.writeFileSync('knowledge/prompt_package.json', JSON.stringify(pack, null, 2));

const exFile = JSON.parse(fs.readFileSync('knowledge/approved_examples.json', 'utf8'));
exFile.entries = pack.examples.map((e) => ({
  source_id: e.id,
  english: e.en,
  tamil: e.ta,
  selection_tags: e.tags,
  selection_score: e.score,
}));
exFile.entries_count = exFile.entries.length;
exFile.selection = 'scored_not_random';
fs.writeFileSync('knowledge/approved_examples.json', JSON.stringify(exFile, null, 2));

const compactTok = est(JSON.stringify(pack));
const prettyTok = est(fs.readFileSync('knowledge/prompt_package.json', 'utf8'));

const man = JSON.parse(fs.readFileSync('knowledge/reference_manifest.json', 'utf8'));
man.counts.compact_examples = pack.examples.length;
man.shared_prompt_token_estimate = compactTok;
man.shared_prompt_pretty_file_tokens = prettyTok;
man.within_target = compactTok >= 20000 && compactTok <= 40000;
fs.writeFileSync('knowledge/reference_manifest.json', JSON.stringify(man, null, 2));

const pkg = JSON.parse(fs.readFileSync('reports/knowledge-package-report.json', 'utf8'));
pkg.actual_file_counts.approved_examples_json_compact = pack.examples.length;
pkg.shared_prompt_token_estimate = compactTok;
pkg.shared_prompt_pretty_file_tokens = prettyTok;
pkg.within_target = compactTok >= 20000 && compactTok <= 40000;
fs.writeFileSync('reports/knowledge-package-report.json', JSON.stringify(pkg, null, 2));

const completion = fs.readFileSync('reports/phase1.1-completion-report.md', 'utf8');
const updated = completion
  .replace(/\*\*20\*\*/g, `**${pack.examples.length}**`)
  .replace(/\| approved_examples\.json \(compact prompt\) \| \*\*\d+\*\* \|/, `| approved_examples.json (compact prompt) | **${pack.examples.length}** |`)
  .replace(/Shared prompt local token estimate: \*\*[^*]+\*\*/, `Shared prompt local token estimate: **${compactTok.toLocaleString()}**`)
  .replace(/Within target: \*\*[^*]+\*\*/, `Within target: **${compactTok >= 20000 && compactTok <= 40000}**`);
fs.writeFileSync('reports/phase1.1-completion-report.md', updated);

console.log({
  compactTok,
  prettyTok,
  examples: pack.examples.length,
  within: compactTok >= 20000 && compactTok <= 40000,
  tagCoverage: [...new Set(pack.examples.flatMap((e) => e.tags))],
});
