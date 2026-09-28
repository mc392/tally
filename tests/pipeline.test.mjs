// Run with:  node tests/pipeline.test.mjs
// The curve pipeline (scripts/): reading a workbook laid out like the Bank of England's OIS file, the statistical
// database's CSV, and the checks before anything is written. The workbook is built here from MADE-UP rates.
import assert from 'node:assert';
import { deflateRawSync, crc32 } from 'node:zlib';
import { unzip, readXlsx, curveSheet, oisCurve, iadbCsv, monthly } from '../scripts/boe.mjs';
import { assemble, publish } from '../scripts/fetch-curves.mjs';

// ---- a minimal zip writer, to build test files ----
function zip(files) {
  const parts = [], dir = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.isBuffer(text) ? text : Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name), crc = crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, data); dir.push(c, n); off += 30 + n.length + data.length;
  }
  const d = Buffer.concat(dir), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(dir.length / 2, 8); e.writeUInt16LE(dir.length / 2, 10); e.writeUInt32LE(d.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, d, e]);
}
// ---- a workbook in the Bank's layout: title rows, a header of maturities, one row per day ----
const col = j => { let s = ''; for (j++; j; j = Math.floor((j - 1) / 26)) s = String.fromCharCode(65 + (j - 1) % 26) + s; return s; };
function xlsx(sheets) {
  const strings = [], si = s => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const sheetXml = rows => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => v == null ? '' : typeof v === 'number' ? `<c r="${col(j)}${i + 1}"><v>${v}</v></c>` : `<c r="${col(j)}${i + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const names = Object.keys(sheets), files = {};
  names.forEach((n, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheets[n]); });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n.replace(/&/g, '&amp;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst>${strings.map(s => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`;
  return zip(files);
}
const serial = iso => Math.round((Date.parse(iso) - Date.UTC(1899, 11, 30)) / 864e5);
const DAYS = ['2026-09-23', '2026-09-24', '2026-09-25'];
const f = (t, d) => 3.5 + 0.1 * t + d * 0.01; // made-up: rises gently with maturity; each day a touch higher
const months = Array.from({ length: 60 }, (_, i) => i + 1), years = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25];
const sheetOf = (label, mats, toYears, blankLast) => [
  ['UK OIS curve (made-up test data)'], ['Instantaneous forward / spot, continuously compounded'], [],
  [label, ...mats], [],
  ...DAYS.map((d, di) => [serial(d), ...mats.map((m, j) => (blankLast && di === DAYS.length - 1 && j === mats.length - 1 ? null : f(toYears(m), di)))]),
];
const book = xlsx({
  info: [['Made up for tests']],
  '1. fwds, short end': sheetOf('months:', months, m => m / 12),
  '2. fwd curve': sheetOf('years:', years, y => y),
  '3. spot, short end': sheetOf('months:', months, m => m / 12),
  '4. spot curve': sheetOf('years:', years, y => y, true),
});
const outer = zip({ 'OIS daily data current month.xlsx': book, 'GLC Nominal daily data current month.xlsx': Buffer.from('not read') });

// ---------- reading ----------
const files = unzip(outer);
assert.deepStrictEqual(Object.keys(files).sort(), ['GLC Nominal daily data current month.xlsx', 'OIS daily data current month.xlsx']);
const sheets = readXlsx(files['OIS daily data current month.xlsx']);
assert.deepStrictEqual(Object.keys(sheets), ['info', '1. fwds, short end', '2. fwd curve', '3. spot, short end', '4. spot curve']);
const s1 = curveSheet(sheets['1. fwds, short end']);
assert.strictEqual(s1.unit, 'months'); assert.strictEqual(s1.maturities.length, 60); assert.deepStrictEqual(s1.days.map(d => d.date), DAYS, 'Excel date serials read as dates');
console.log('  ✓ reads the zip, the workbook inside it, and each sheet’s maturities and dated rows');

const c = oisCurve(sheets);
assert.strictEqual(c.asOf, '2026-09-25', 'the most recent date');
assert.strictEqual(c.shortEnd.forward.length, 60);
assert.ok(Math.abs(c.shortEnd.forward[11] - f(1, 2)) < 1e-12, '12-month forward on the latest day');
assert.deepStrictEqual(c.long.tenorsYears, [6, 7, 8, 9, 10, 15, 20], 'long tenors beyond 5 years; 25 years is blank on the spot sheet that day, so left out');
assert.ok(Math.abs(c.long.forward[4] - f(10, 2)) < 1e-12);
// The first real run (28 Sep 2026) read every short-end point as missing: the Bank's workbook labels them "months:" but
// stores 1.00000004, 2.00000008 … 60.0000024, not whole numbers, and they were matched exactly. They are rounded now;
// and whatever the label says, maturities that stop at 5 are years, ones running to 60 are months.
const bankMonths = months.map(m => m * 1.00000004);
for (const [label, mats] of [['months:', bankMonths], ['months:', months.map(m => m / 12)], ['years:', months.map(m => m / 12)], ['', months.map(m => m / 12)], ['Maturity (months)', months]]) {
  const S = { ...sheets, '1. fwds, short end': sheetOf(label, mats, m => (mats === months || mats === bankMonths ? Math.round(m) / 12 : m)), '3. spot, short end': sheetOf(label, mats, m => (mats === months || mats === bankMonths ? Math.round(m) / 12 : m)) };
  const v = oisCurve(S);
  assert.ok(v.shortEnd.forward.every(x => x != null) && Math.abs(v.shortEnd.forward[11] - f(1, 2)) < 1e-12, `short end headed "${label}" ${mats === bankMonths ? 'in the Bank’s not-quite-whole months' : mats === months ? 'in months' : 'in years'}`);
}
assert.ok(c.layout.length === 4 && /read as months, 60 maturities/.test(c.layout[0]), 'the layout it read is described, for the run log');
console.log('  ✓ the four OIS sheets become the curve file: 60 monthly points, then the long tenors, whether the short end is headed in months or years');

// ---------- the statistical database ----------
const csv = 'DATE,IUDBEDR,IUDSOIA\n24 Sep 2026,3.7500,3.7100\n25 Sep 2026,3.7500,3.7200\n';
const daily = iadbCsv(csv);
assert.deepStrictEqual(daily.IUDSOIA.at(-1), { date: '2026-09-25', rate: 3.72 });
const mcsv = iadbCsv('DATE,IUMBV34\n31/Jul/2026,4.50\n31/Aug/2026,4.40\n');
assert.deepStrictEqual(monthly(mcsv.IUMBV34), [{ month: '2026-07', rate: 4.5 }, { month: '2026-08', rate: 4.4 }]);
assert.throws(() => iadbCsv('<html>blocked</html>'), /not an IADB CSV/);
console.log('  ✓ reads the database CSV, in either date style, and refuses an error page');

// ---------- assembling and publishing ----------
const series = { daily: { bankRate: 'IUDBEDR', sonia: 'IUDSOIA' }, monthly: { mortgage2yFix75: 'IUMBV34', savingsInstant: null } };
const curve = assemble({ sheets, daily, monthlySeries: mcsv, series, fetchedAt: 'test' });
assert.deepStrictEqual(curve.anchors, { bankRate: 3.75, sonia: 3.72, asOf: '2026-09-25' });
assert.deepStrictEqual(curve.quoted, { mortgage2yFix75: { rate: 4.4, month: '2026-08', series: 'IUMBV34' } });
let out = publish(curve, { asOf: '2026-09-24' });
assert.ok(out.ok && out.files['rates/curve-latest.json'] === curve && out.files['rates/history/2026-09-25.json'] === curve, 'a good curve is written, and kept by date');
const bad = JSON.parse(JSON.stringify(curve)); bad.long.forward[3] = 22;
out = publish(bad, { asOf: '2026-09-24' });
assert.ok(!out.ok && !out.files && /outside/.test(out.errors.join()), 'a rate outside −1% to 15% is rejected and nothing is written, so the previous file is kept');
assert.ok(!publish(curve, { asOf: '2026-09-26' }).ok, 'an older curve than the last good one is rejected');
const far = assemble({ sheets, daily: iadbCsv('DATE,IUDBEDR,IUDSOIA\n25 Sep 2026,4.75,4.70\n'), monthlySeries: {}, series });
assert.ok(/SONIA/.test(publish(far, null).errors.join()), 'a curve far from SONIA is rejected');
console.log('  ✓ a good curve is published; a bad one is rejected and the last good file kept');
console.log('All pipeline checks pass ✓');
