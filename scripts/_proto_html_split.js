const sqlite3 = require('sqlite3').verbose();

function open(p) {
  return new sqlite3.Database(p, sqlite3.OPEN_READONLY);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
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
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function splitHtml(html) {
  const parts = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = stripTags(m[1]);
    if (text) parts.push(text);
  }
  return parts;
}

function numberParas(texts) {
  const out = [];
  let cur = null;
  let cont = 0;
  for (const t of texts) {
    const m = t.match(/^(\d+)\s*[.:)\]]\s*(.*)$/);
    if (m) {
      cur = m[1];
      cont = 0;
      out.push({ label: cur, text: (m[2] || '').trim() || t });
    } else if (cur) {
      cont += 1;
      out.push({ label: `${cur}.${cont}`, text: t, continuation: true });
    } else {
      out.push({ label: null, text: t });
    }
  }
  return out;
}

(async () => {
  const en = open('d:/Freelancing/BRD-David/server/data/english_messages.sqlite');
  const ta = open('d:/Freelancing/BRD-David/server/data/messages.sqlite');
  const enRow = (await all(en, "SELECT name,message FROM messages WHERE name LIKE '47-04-12%'"))[0];
  const taRow = (await all(ta, "SELECT name,message FROM messages WHERE name LIKE '47-04-12%'"))[0];
  const enP = numberParas(splitHtml(enRow.message));
  const taP = numberParas(splitHtml(taRow.message));
  console.log(
    JSON.stringify(
      {
        enName: enRow.name,
        taName: taRow.name,
        enCount: enP.length,
        taCount: taP.length,
        enNumbered: enP.filter((p) => p.label && !p.continuation).length,
        taNumbered: taP.filter((p) => p.label && !p.continuation).length,
        enNull: enP.filter((p) => !p.label).length,
        taNull: taP.filter((p) => !p.label).length,
        enSample: enP.slice(0, 6),
        taSample: taP.slice(0, 6),
      },
      null,
      2
    )
  );
  en.close();
  ta.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
