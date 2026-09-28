// Fetches the Bank of England's latest sterling OIS curve and writes it where the app can load it:
//   rates/curve-latest.json        - the curve the app offers
//   rates/history/YYYY-MM-DD.json  - one per date, so a projection can be re-run "as at" an earlier curve
//   rates/history/index.json       - the list of those dates
// Run by .github/workflows/rates.yml each weekday; can also be run by hand:
//   node scripts/fetch-curves.mjs                   (downloads)
//   node scripts/fetch-curves.mjs --zip file.zip    (reads a zip already downloaded from the yield curves page)
// A curve that fails the checks (curves.js validate) is NOT written: the last good one stays, and the script exits
// with an error so the workflow run shows red. Market data is public; nothing personal ever passes through here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { unzip, readXlsx, oisCurve, iadbCsv, monthly } from './boe.mjs';

const require = createRequire(import.meta.url);
const TC = require('../curves.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP_URL = process.env.BOE_ZIP_URL || 'https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/latest-yield-curve-data.zip';
const IADB = 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; tally-rates/1.0; +https://github.com/mc392/tally)' };

// Everything fetched → the curve file. Pure, so the tests can run it on made-up inputs.
export function assemble({ sheets, daily = {}, monthlySeries = {}, series, fetchedAt }) {
  const c = oisCurve(sheets);
  const upTo = (arr = []) => arr.filter(x => x.date <= c.asOf).at(-1) || null;
  const br = upTo(daily[series.daily.bankRate]), so = upTo(daily[series.daily.sonia]);
  const quoted = {};
  for (const [key, code] of Object.entries(series.monthly)) {
    const m = code && monthlySeries[code] ? monthly(monthlySeries[code]) : [];
    if (m.length) quoted[key] = { rate: m.at(-1).rate, month: m.at(-1).month, series: code };
  }
  let suggested = null;
  const inst = series.monthly.savingsInstant, bank = daily[series.daily.bankRate];
  if (inst && monthlySeries[inst] && bank && bank.length) {
    const est = TC.estimatePassThrough(monthly(bank), monthly(monthlySeries[inst]));
    if (est) suggested = { passThrough: Math.round(est.passThrough * 100) / 100, lagMonths: est.lagMonths, r2: Math.round(est.r2 * 100) / 100, months: est.n, series: inst };
  }
  return {
    source: 'Bank of England OIS (nominal) curve', attribution: 'Source: Bank of England', asOf: c.asOf, compounding: 'continuous',
    shortEnd: c.shortEnd, long: c.long,
    anchors: { bankRate: br ? br.rate : null, sonia: so ? so.rate : null, asOf: (so || br || {}).date || null },
    quoted, suggested, fetchedAt: fetchedAt || new Date().toISOString(),
  };
}
// The last good curve, the new one → what to write, or why not.
export function publish(curve, prev) {
  const v = TC.validate(curve, prev);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, files: { 'rates/curve-latest.json': curve, [`rates/history/${curve.asOf}.json`]: curve } };
}

const ddMonYYYY = d => { const x = new Date(d); return `${String(x.getUTCDate()).padStart(2, '0')}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][x.getUTCMonth()]}/${x.getUTCFullYear()}`; };
async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r;
}
async function iadb(codes, fromDays) {
  if (!codes.length) return {};
  const q = new URLSearchParams({ 'csv.x': 'yes', Datefrom: ddMonYYYY(Date.now() - fromDays * 864e5), Dateto: 'now', SeriesCodes: codes.join(','), CSVF: 'TN', UsingCodes: 'Y', VPD: 'Y', VFD: 'N' });
  return iadbCsv(await (await get(`${IADB}?${q}`)).text());
}

async function main() {
  const series = JSON.parse(readFileSync(join(ROOT, 'scripts/rates-series.json'), 'utf8'));
  const zipArg = process.argv.indexOf('--zip');
  const zip = zipArg > 0 ? readFileSync(process.argv[zipArg + 1]) : Buffer.from(await (await get(ZIP_URL)).arrayBuffer());
  const files = unzip(zip), name = Object.keys(files).find(n => /ois/i.test(n) && /\.xlsx$/i.test(n));
  if (!name) throw new Error(`no OIS workbook in the zip (found: ${Object.keys(files).join(', ')})`);
  const sheets = readXlsx(files[name]);
  // The statistical database is a nice-to-have: without it the curve still publishes, margins fall back to typical ones.
  const warn = [];
  let daily = {}, monthlySeries = {};
  try { daily = await iadb(Object.values(series.daily).filter(Boolean), 400); } catch (e) { warn.push('daily series: ' + e.message); }
  const mcodes = Object.values(series.monthly).filter(Boolean);
  try { monthlySeries = await iadb(mcodes, series.monthly.savingsInstant ? 3650 : 400); } catch (e) { warn.push('monthly series: ' + e.message); }
  const curve = assemble({ sheets, daily, monthlySeries, series });
  const latestPath = join(ROOT, 'rates/curve-latest.json');
  const prev = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, 'utf8')) : null;
  const out = publish(curve, prev);
  for (const w of warn) console.warn('warning:', w);
  if (!out.ok) { console.error(`Curve dated ${curve.asOf} rejected; keeping ${prev ? prev.asOf : 'nothing'}:\n - ` + out.errors.join('\n - ')); process.exit(1); }
  for (const [p, body] of Object.entries(out.files)) { mkdirSync(dirname(join(ROOT, p)), { recursive: true }); writeFileSync(join(ROOT, p), JSON.stringify(body, null, 1) + '\n'); }
  const idxPath = join(ROOT, 'rates/history/index.json');
  const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : { dates: [] };
  idx.dates = [...new Set([...idx.dates, curve.asOf])].sort();
  writeFileSync(idxPath, JSON.stringify(idx, null, 1) + '\n');
  console.log(`Curve as at ${curve.asOf} written (Bank Rate ${curve.anchors.bankRate ?? '?'}%, SONIA ${curve.anchors.sonia ?? '?'}%, ${Object.keys(curve.quoted).length} quoted rate(s)).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message || e); process.exit(1); });
