// Run with:  npm i --no-save playwright   (once)   then   node tests/browser.test.mjs
// Drives the real app in a headless browser and checks the saving rules end to end:
// live save, picking up another device's save, refusing to overwrite it, encryption, unlocking.
// The file is a fake "file on disk" held in the page, standing in for Chrome's file access,
// so this never touches a real file. Synthetic data only.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const sample = {
  app: 'tally', version: 1,
  people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', name: 'Test Current', owner: 'M', type: 'current', rate: 0, active: true }, { id: 'isa', name: 'Test ISA', owner: 'M', type: 'ss_isa', rate: 5, active: true }],
  snapshots: [{ date: '2026-09-01', balances: { cur: 4321, isa: 98765 } }],
  income: [{ name: 'Pay', owner: 'M', monthly: 3000 }], spending: [{ name: 'Rent', category: 'Home', annual: 12000, inflates: true }, { name: 'Mortgage', category: 'Home', linked: 'mortgage' }],
  bufferPct: 5, events: [],
  // the flat shape every file had before mortgage parts: must still open, as one part
  mortgage: { payment: 900, balance: 150000, rate: 4, fixEnd: '2027-06-01', newRate: 5, termEnd: '2045-01-01', propertyValue: 300000 },
};

// A fake file handle, installed before the app loads. window.__disk is "the file on disk";
// it is kept in sessionStorage so it survives a page reload, as a real file would.
function fakeFs(initial) {
  let disk = sessionStorage.getItem('disk') ?? initial;
  Object.defineProperty(window, '__disk', { get: () => disk, set: v => { disk = v; sessionStorage.setItem('disk', v); } });
  const handle = {
    kind: 'file', name: 'family-finances.json',
    getFile: async () => ({ name: 'family-finances.json', text: async () => window.__disk }),
    createWritable: async () => { let buf = ''; return { write: async t => { buf += t; }, close: async () => { window.__disk = buf; window.__writes = (window.__writes || 0) + 1; } }; },
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
  };
  window.showOpenFilePicker = async () => [handle];
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ✓ ' + m); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeFs, JSON.stringify(sample));
  await page.goto(url);
  const disk = () => page.evaluate(() => JSON.parse(window.__disk));
  const waitSaved = () => page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });

  console.log('Opening a file');
  await page.click('button[data-act="open-file"]');
  await page.waitForFunction(() => data && fileRoute === 'live');
  ok(await page.evaluate(() => data.accounts.length === 2), 'file opened from the picker');
  ok(!(await page.$('#navR [data-act="save"]')), 'no Save button while saving is automatic');

  console.log('Live save');
  await page.evaluate(() => { data.bufferPct = 7; changed(); });
  await waitSaved();
  let d = await disk();
  ok(d.bufferPct === 7, 'change written into the file without pressing Save');
  ok(d.writer && d.writer.rev === 1 && d.writer.device, 'file carries a writer mark');

  console.log('Picking up a save from another device');
  await page.evaluate(() => { const f = JSON.parse(window.__disk); f.bufferPct = 9; f.writer = { device: 'phone', label: 'iPhone', rev: 2, at: new Date().toISOString() }; window.__disk = JSON.stringify(f); });
  await page.evaluate(() => syncFromFile());
  ok(await page.evaluate(() => data.bufferPct === 9 && meta.base.device === 'phone'), 'newer file loaded when nothing here was unsaved');

  console.log('Refusing to overwrite another device');
  await page.evaluate(() => { const f = JSON.parse(window.__disk); f.bufferPct = 11; f.writer = { device: 'phone', label: 'iPhone', rev: 3, at: new Date().toISOString() }; window.__disk = JSON.stringify(f); });
  const writesBefore = await page.evaluate(() => window.__writes);
  await page.evaluate(() => { data.bufferPct = 4; changed(); });
  await page.waitForFunction(() => meta.conflict, null, { timeout: 5000 });
  ok((await disk()).bufferPct === 11 && await page.evaluate(w => window.__writes === w, writesBefore), 'the iPhone’s save was not overwritten');
  ok(!!(await page.$('#navR [data-act="resolve"]')), 'header shows "File changed"');
  await page.click('#navR [data-act="resolve"]');
  await page.waitForSelector('.sheet-wrap.open [data-sact="load"]');
  ok((await page.textContent('.sheet-wrap.open')).includes('iPhone'), 'the sheet names the device that saved');
  await page.click('.sheet-wrap.open [data-sact="load"]');
  await page.waitForFunction(() => !meta.conflict && data.bufferPct === 11);
  ok(true, '"Load the newer file" takes the iPhone’s version');
  await page.waitForTimeout(400);

  console.log('Turning encryption on');
  await page.click('#tabbar [data-arg="plan"]');
  await page.click('[data-act="encrypt"]');
  await page.waitForSelector('.sheet-wrap.open #p_p1');
  await page.fill('.sheet-wrap.open #p_p1', 'short'); await page.fill('.sheet-wrap.open #p_p2', 'short'); await page.click('.sheet-wrap.open .done');
  ok(!!(await page.$('.sheet-wrap.open #p_p1')), 'too-short passphrase refused');
  await page.fill('.sheet-wrap.open #p_p1', 'purple tractor seventeen'); await page.fill('.sheet-wrap.open #p_p2', 'purple tractor seventeen');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => meta.encrypt && !meta.dirty, null, { timeout: 15000 });
  const raw = await page.evaluate(() => window.__disk);
  d = JSON.parse(raw);
  ok(d.format === 'tally-encrypted', 'file now saved encrypted');
  ok(!raw.includes('98765') && !raw.includes('Test ISA') && !raw.includes('Rent'), 'no balances, names or spending readable in the file');
  ok(d.writer && d.writer.rev === 4, 'writer mark still readable outside the lock');
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-your-data.png'), fullPage: true });

  console.log('Reopening on this device');
  await page.reload();
  await page.waitForFunction(() => data && seal);
  await page.click('#tabbar [data-arg="plan"]');
  await page.click('[data-act="open-file"]');
  await page.waitForFunction(() => fileRoute === 'live' && meta.encrypt);
  ok(!(await page.$('.sheet-wrap.open #p_p1')), 'no passphrase asked on a device that already has the key');
  ok(await page.evaluate(() => data.bufferPct === 11), 'encrypted file opened with its figures');

  console.log('Opening on a new device');
  const page2 = await (await browser.newContext()).newPage();
  page2.on('pageerror', e => errors.push(e.message));
  await page2.addInitScript(fakeFs, raw);
  await page2.goto(url);
  await page2.click('button[data-act="open-file"]');
  await page2.waitForSelector('.sheet-wrap.open #p_p1');
  ok(true, 'passphrase asked on a device without the key');
  await page2.fill('.sheet-wrap.open #p_p1', 'purple tractor eighteen'); await page2.click('.sheet-wrap.open .done');
  await page2.waitForFunction(() => { const n = document.querySelector('.sheet-wrap.open .note'); return n && n.textContent.includes('didn’t open'); }, null, { timeout: 15000 });
  ok(true, 'wrong passphrase says so and asks again');
  await page2.fill('.sheet-wrap.open #p_p1', 'purple tractor seventeen'); await page2.click('.sheet-wrap.open .done');
  await page2.waitForFunction(() => data && data.bufferPct === 11, null, { timeout: 15000 });
  ok(true, 'right passphrase opens it');

  console.log('Mortgage parts');
  ok(await page.evaluate(() => data.mortgage.parts.length === 1 && data.mortgage.parts[0].balance === 150000 && data.mortgage.propertyValue === 300000), 'an old single mortgage opens as one part, nothing lost');
  await page.click('#tabbar [data-arg="plan"]');
  await page.click('[data-act="push"][data-arg="mortgage"]');
  ok((await page.textContent('#main')).includes('Home equity'), 'single mortgage screen shows its details');
  await page.click('[data-act="add-part"]');
  await page.waitForSelector('.sheet-wrap.open #f_payment');
  await page.fill('.sheet-wrap.open #f_name', 'Further advance');
  await page.fill('.sheet-wrap.open #f_payment', '250');
  await page.fill('.sheet-wrap.open #f_balance', '30000');
  await page.fill('.sheet-wrap.open #f_rate', '5.5');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.mortgage.parts.length === 2);
  let main = await page.textContent('#main');
  ok(main.includes('Part 1') && main.includes('Further advance') && main.includes('2 parts'), 'two parts listed, the original named Part 1');
  ok(main.includes('£1,150') && main.includes('£180,000') && main.includes('£120,000'), 'total payment £1,150, total owed £180,000, equity £120,000');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });
  const saved = JSON.parse(await page.evaluate(() => window.__disk));
  ok(saved.format === 'tally-encrypted', 'saved (still encrypted)');
  ok(await page.evaluate(() => mortgageTotals(data).payment === 1150 && Math.abs(monthlyBudget(data).spend - (1000 + 1150)) < 0.01), 'both parts count towards spending');
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-mortgage-parts.png'), fullPage: true });
  await page.click('[data-act="push"][data-arg^="mpart:"]:not([data-arg="mpart:main"])');
  ok((await page.textContent('#main')).includes('Further advance'), 'a part opens on its own screen');
  await page.click('#navR [data-act="edit-part"]');
  await page.waitForSelector('.sheet-wrap.open [data-sact="delete"]');
  page.once('dialog', d => d.accept());
  await page.click('.sheet-wrap.open [data-sact="delete"]');
  await page.waitForFunction(() => data.mortgage.parts.length === 1);
  ok((await page.textContent('#main')).includes('Home equity') && !(await page.textContent('#main')).includes('2 parts'), 'deleting a part goes back to the single mortgage');

  console.log('Data file version 2');
  ok(await page.evaluate(() => data.version === 2 && !data.income && data.flows.length === 3), 'the v1 file was upgraded: income, spending and one-offs are now flows');
  ok(await page.evaluate(() => data.accounts.find(a => a.id === 'isa').access === 'invested' && data.accounts.find(a => a.id === 'cur').access === 'instant'), 'accounts were given an access type');
  await page.click('#tabbar [data-arg="plan"]');
  await page.click('[data-act="add-spend"]');
  await page.waitForSelector('.sheet-wrap.open #f_start');
  await page.fill('.sheet-wrap.open #f_name', 'Nursery');
  await page.fill('.sheet-wrap.open #f_monthly', '800');
  await page.fill('.sheet-wrap.open #f_start', '2027-01'); await page.fill('.sheet-wrap.open #f_end', '2027-06');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.flows.some(f => f.name === 'Nursery'));
  const nursery = await page.evaluate(() => data.flows.find(f => f.name === 'Nursery'));
  ok(nursery.kind === 'spend' && nursery.amount === 800 && nursery.start === '2027-01' && nursery.end === '2027-06', 'spending with From and Until saved as a dated flow');
  // the sample's mortgage fix ends Jun 2027, which moves spending by itself, so leave the mortgage out
  const spendDiff = await page.evaluate(() => { const r = project(data, 'cautious', 36).rows, at = d => { const x = r.find(y => y.date === d); return x.spend - x.mortgagePay; }; return [at('2027-03-01') - at('2027-08-01'), at('2026-12-01') - at('2027-08-01')]; });
  ok(Math.abs(spendDiff[0] - 800) < 0.01 && Math.abs(spendDiff[1]) < 0.01, 'the projection charges it only from Jan to Jun 2027');
  await page.click('#main [data-act="edit-rules"]');
  await page.waitForSelector('.sheet-wrap.open #f_first');
  await page.selectOption('.sheet-wrap.open #f_first', 'C');
  await page.fill('.sheet-wrap.open #f_used_C', '5000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.rules.isaFillOrder[0] === 'C');
  ok(await page.evaluate(() => data.rules.isaUsedBy.C === 5000 && data.rules.isaFillOrder.join() === 'C,M'), 'ISA rules: Partner fills first, with £5,000 already paid in');
  ok((await page.textContent('#main')).includes('Partner’s fills first'), 'Plan shows whose allowance fills first');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });
  await page.evaluate(() => actions['edit-account']('cur'));
  await page.waitForSelector('.sheet-wrap.open #f_access');
  await page.selectOption('.sheet-wrap.open #f_access', 'notice'); await page.fill('.sheet-wrap.open #f_noticeDays', '35');
  await page.fill('.sheet-wrap.open #f_maturity', '2028-01'); // not a fixed account, so this must be dropped
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.accounts.find(a => a.id === 'cur').access === 'notice');
  ok(await page.evaluate(() => { const a = data.accounts.find(x => x.id === 'cur'); return a.noticeDays === 35 && !('maturity' in a) && !('flexible' in a); }), 'account access saved, with only the details that apply to it');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });
  ok(await page.evaluate(async () => { const f = JSON.parse(window.__disk); const d = await TS.unseal(f, seal); return d.version === 2 && Array.isArray(d.flows) && !('income' in d) && !('events' in d); }), 'the saved file is version 2');

  ok((await page.evaluate(() => window.__csp)).length === 0 && (await page2.evaluate(() => window.__csp)).length === 0, 'nothing blocked by the security policy');
  ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  console.log(`All ${passed} browser checks pass ✓`);
} finally { await browser.close(); server.close(); }
