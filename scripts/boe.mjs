// Reading the Bank of England's published files, with nothing but Node itself (no packages to install).
// Pure: bytes and text in, plain objects out. The network and file writing live in fetch-curves.mjs.
// Tested in tests/pipeline.test.mjs against a made-up workbook in the Bank's layout.
import { inflateRawSync } from 'node:zlib';

// ---------- zip (the Bank's download is a zip of .xlsx files, and each .xlsx is itself a zip) ----------
export function unzip(buf) {
  const b = Buffer.from(buf), out = {};
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const n = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let e = 0; e < n; e++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28), raw = b.subarray(start, start + size);
    if (!name.endsWith('/')) out[name] = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

// ---------- xlsx → {sheetName: rows of cell values} ----------
const ent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const colNum = ref => { let n = 0; for (const c of ref.replace(/\d+/g, '')) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };
export function readXlsx(buf) {
  const z = unzip(buf), txt = k => (z[k] ? z[k].toString('utf8') : '');
  const shared = [...txt('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => ent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rels = Object.fromEntries([...txt('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(m => [(m[0].match(/Id="([^"]+)"/) || [])[1], (m[0].match(/Target="([^"]+)"/) || [])[1]]));
  const sheets = {};
  for (const m of txt('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = ent((m[0].match(/name="([^"]*)"/) || [])[1] || ''), rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    const target = (rels[rid] || '').replace(/^\/?(xl\/)?/, '');
    const xml = txt('xl/' + target), rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] || '', ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1], t = (attrs.match(/t="(\w+)"/) || [])[1];
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (t === 's') val = shared[+v] ?? null;
        else if (t === 'inlineStr') val = ent([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
        else if (t === 'str') val = v != null ? ent(v) : null;
        else if (t === 'b') val = v === '1';
        else if (v != null && v !== '') val = Number(v);
        cells[ref ? colNum(ref) : cells.length] = val;
      }
      rows.push(cells);
    }
    sheets[name] = rows;
  }
  return sheets;
}

// ---------- one curve sheet → maturities and the latest day's rates ----------
// The Bank's sheets have a few title rows, then a header row of maturities ("months:" 1, 2, … 60 on the short-end
// sheets, "years:" 0.5, 1, … on the others), then one row per business day: the date in column A (an Excel date
// serial), a rate under each maturity, blank where the curve does not reach.
const excelDate = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5).toISOString().slice(0, 10);
const isNum = v => typeof v === 'number' && isFinite(v);
function toISO(v) {
  if (isNum(v) && v > 20000 && v < 80000) return excelDate(v);
  if (typeof v === 'string') { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/) || null; if (m) return m[0]; const d = Date.parse(v + ' UTC'); if (!isNaN(d)) return new Date(d).toISOString().slice(0, 10); }
  return null;
}
export function curveSheet(rows) {
  let h = -1;
  for (let i = 0; i < rows.length && h < 0; i++) {
    const r = rows[i] || [], nums = r.slice(1).filter(isNum);
    if (toISO(r[0])) continue;
    if (nums.length >= 5 && nums.every((v, j) => !j || v > nums[j - 1])) h = i;
  }
  if (h < 0) throw new Error('no row of maturities found');
  const head = rows[h], cols = [];
  head.forEach((v, j) => { if (j > 0 && isNum(v)) cols.push([j, v]); });
  const days = [];
  for (const r of rows.slice(h + 1)) {
    const date = r && toISO(r[0]); if (!date) continue;
    const vals = cols.map(([j]) => (isNum(r[j]) ? r[j] : null));
    if (vals.some(v => v != null)) days.push({ date, vals });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const unit = String(head[0] || '').toLowerCase().includes('month') ? 'months' : 'years';
  return { unit, maturities: cols.map(c => c[1]), days };
}
// The rates for one date, by maturity in months (short end) or years (long).
function onDate(sheet, date) { const d = sheet.days.find(x => x.date === date); return d ? d.vals : null; }

const findSheet = (sheets, re) => { const k = Object.keys(sheets).find(n => re.test(n)); return k ? sheets[k] : null; };
// The four OIS sheets → the curve file's shape, for the most recent date on the short-end forward sheet.
export function oisCurve(sheets) {
  const fS = findSheet(sheets, /fwd.*short|forward.*short/i), sS = findSheet(sheets, /spot.*short/i);
  const fL = findSheet(sheets, /fwd curve|forward curve/i), sL = findSheet(sheets, /spot curve/i);
  if (!fS || !sS || !fL || !sL) throw new Error(`OIS workbook sheets not found (have: ${Object.keys(sheets).join(', ')})`);
  const [FS, SS, FL, SL] = [fS, sS, fL, sL].map(curveSheet);
  const asOf = FS.days.at(-1)?.date; if (!asOf) throw new Error('no dated rows on the short-end sheet');
  const short = (S) => {
    const vals = onDate(S, asOf) || [], months = S.unit === 'months' ? S.maturities : S.maturities.map(y => Math.round(y * 12));
    return Array.from({ length: 60 }, (_, i) => { const j = months.indexOf(i + 1); return j >= 0 ? vals[j] ?? null : null; });
  };
  const longOf = (S) => {
    const vals = onDate(S, asOf) || [], out = [];
    S.maturities.forEach((y, j) => { const t = S.unit === 'months' ? y / 12 : y; if (t > 5 + 1e-9 && vals[j] != null) out.push([t, vals[j]]); });
    return out;
  };
  const lf = longOf(FL), ls = longOf(SL), tenors = lf.map(x => x[0]).filter(t => ls.some(y => y[0] === t));
  return {
    asOf, shortEnd: { stepMonths: 1, forward: short(FS), spot: short(SS) },
    long: { tenorsYears: tenors, forward: tenors.map(t => lf.find(x => x[0] === t)[1]), spot: tenors.map(t => ls.find(x => x[0] === t)[1]) },
  };
}

// ---------- the Bank's statistical database (IADB) CSV ----------
// "DATE,IUDBEDR,IUDSOIA" then rows like "25 Sep 2026,4.0000,3.9700". Dates may also be "25/Sep/2026".
const MONS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function iadbCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = lines[0].split(',').map(s => s.trim().replace(/"/g, ''));
  if (!/^date$/i.test(head[0])) throw new Error('not an IADB CSV (no DATE column)');
  const out = Object.fromEntries(head.slice(1).map(c => [c, []]));
  for (const l of lines.slice(1)) {
    const c = l.split(',').map(s => s.trim().replace(/"/g, ''));
    const m = c[0].match(/^(\d{1,2})[ /-]([A-Za-z]{3})[ /-](\d{4})$/); if (!m) continue;
    const date = `${m[3]}-${String(MONS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    head.slice(1).forEach((code, j) => { const v = parseFloat(c[j + 1]); if (isFinite(v)) out[code].push({ date, rate: v }); });
  }
  for (const k in out) out[k].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
// Month by month: the last figure in each month.
export function monthly(series) {
  const by = {}; for (const x of series) by[x.date.slice(0, 7)] = x.rate;
  return Object.entries(by).sort().map(([month, rate]) => ({ month, rate }));
}
