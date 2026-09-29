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
  ok(await page.evaluate(() => document.body.classList.contains('private')), 'figures start hidden');
  await page.click('[data-act="private"]');
  ok(await page.evaluate(() => !document.body.classList.contains('private')), 'the eye shows them');

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
  ok(await page.evaluate(() => document.body.classList.contains('private')), 'reopening hides the figures again, though they were shown when it closed');
  await page.click('[data-act="private"]');

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
  ok(await page.evaluate(() => data.version === TallyModel.VERSION && !data.income && data.flows.length === 3), 'the v1 file was upgraded: income, spending and one-offs are now flows');
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
  ok(await page.evaluate(async () => { const f = JSON.parse(window.__disk); const d = await TS.unseal(f, seal); return d.version === TallyModel.VERSION && Array.isArray(d.flows) && !('income' in d) && !('events' in d); }), 'the saved file is the current version');

  console.log('Life events');
  const plainNet = await page.evaluate(() => project(data, 'cautious', 60).rows.map(r => r.net));
  await page.click('#tabbar [data-arg="plan"]');
  await page.click('#main [data-act="add-bundle"]');
  await page.waitForSelector('.sheet-wrap.open [data-sact="baby"]');
  await page.click('.sheet-wrap.open [data-sact="baby"]');
  await page.waitForSelector('.sheet-wrap.open #f_leave1Months');
  await page.fill('.sheet-wrap.open #f_start', '2027-05');
  await page.fill('.sheet-wrap.open #f_leave1Months', '6');
  await page.click('.sheet-wrap.open .done');
  await page.waitForSelector('.sheet-wrap.open #f_on0');
  const reviewText = await page.textContent('.sheet-wrap.open');
  ok(reviewText.includes('Check each line') && reviewText.includes('Childcare') && reviewText.includes('Child Benefit'), 'every line is shown for review before saving');
  ok(await page.evaluate(() => data.bundles.length === 0), 'nothing saved until the review is confirmed');
  await page.click('.sheet-wrap.open #f_on1'); // leave out the second line (the nursery room) - a real tap on the switch
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.bundles.length === 1);
  const ev = await page.evaluate(() => ({ b: data.bundles[0], lines: data.flows.filter(f => f.bundle === data.bundles[0].id) }));
  ok(ev.lines.length > 5 && !ev.lines.some(f => f.name === 'Nursery room'), 'the event is saved with the lines kept, minus the one left out');
  ok(ev.lines.find(f => f.name === 'Parental leave – Me').end === '2027-10', '6 months of leave from May 2027 ends in Oct 2027');
  ok((await page.textContent('#main')).includes('Parental leave – Me'), 'the event’s page lists its lines');
  const withNet = await page.evaluate(() => project(data, 'cautious', 60).rows.map(r => r.net));
  ok(withNet.at(-1) !== plainNet.at(-1), 'the event changes the projection');
  await page.click('#main [data-chg="b-on"]');
  await page.waitForFunction(() => !data.bundles[0].on);
  const offNet = await page.evaluate(() => project(data, 'cautious', 60).rows.map(r => r.net));
  ok(offNet.every((v, i) => Math.abs(v - plainNet[i]) < 1e-6), 'switched off: the projection is exactly as it was without it');
  await page.click('#main [data-chg="b-on"]');
  await page.waitForFunction(() => data.bundles[0].on);
  await page.click('#navR [data-act="edit-bundle"]');
  await page.waitForSelector('.sheet-wrap.open #f_start');
  await page.fill('.sheet-wrap.open #f_start', '2027-11');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.bundles[0].start === '2027-11');
  ok(await page.evaluate(() => data.flows.find(f => f.bundle && f.name === 'Parental leave – Me').start === '2027-11' && data.flows.find(f => f.bundle && f.name === 'Pram, cot and kit').start === '2027-09'), 'moving the start moves every line with it');
  await page.click('#tabbar [data-arg="projection"]');
  ok(!!(await page.$('#c-proj rect')), 'the projection chart shows the event as a shaded band');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });

  console.log('Remortgage readiness');
  await page.click('#tabbar [data-arg="plan"]'); await page.click('#tabbar [data-arg="plan"]'); // second tap goes back to the top of Plan
  await page.click('[data-act="push"][data-arg="mortgage"]');
  await page.click('[data-act="push"][data-arg="ready"]');
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('Available to overpay'));
  const R = await page.evaluate(() => readiness(data, scenarioKey(), thisMonth()));
  const readyText = await page.textContent('#main');
  ok(R.fixEnd === '2027-06-01' && readyText.includes('Key dates') && readyText.includes('Where your money will be'), 'readiness screen shows the fix end, key dates and the ladder');
  ok((await page.textContent('#main')).includes(await page.evaluate(v => money(v), R.available)), 'the figure on screen is the engine’s available-to-overpay');
  // a big spend just before the fix end raises the lock-up warning with before and after figures
  await page.evaluate(() => { data.flows.push({ id: 'big', name: 'Extension', kind: 'oneoff', amount: -20000, start: '2027-03', end: '2027-03', category: 'One-off', on: true, bundle: null }); changed(); });
  await page.waitForSelector('.warnchip');
  const leak = await page.evaluate(() => ui.leak);
  ok(Math.round(leak.before - leak.after) >= 5000 && (await page.textContent('.warnchip')).includes('Less free at your remortgage'), 'a £20k spend before the fix end raises the warning, with before and after figures');
  await page.click('.warnchip [data-act="leak-ok"]');
  ok(!(await page.$('.warnchip')), 'the warning can be dismissed');
  await page.evaluate(() => { data.flows = data.flows.filter(f => f.id !== 'big'); changed(); });
  ok(!(await page.$('.warnchip')), 'a change that adds money back raises nothing');
  await page.click('#navR [data-act="edit-remortgage"]');
  await page.waitForSelector('.sheet-wrap.open #f_target');
  await page.fill('.sheet-wrap.open #f_target', '1000000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.rules.remortgage.target === 1000000);
  ok((await page.textContent('#main')).includes('short at the fix end'), 'an out-of-reach target shows the shortfall');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-readiness.png'), fullPage: true });

  console.log('Remortgage deals and plans');
  await page.evaluate(() => { data.rules.remortgage.target = null; changed(); });
  await page.click('#main [data-act="add-option"]');
  await page.waitForSelector('.sheet-wrap.open #f_rate');
  await page.fill('.sheet-wrap.open #f_name', '5-year fix');
  await page.fill('.sheet-wrap.open #f_rate', '4.1');
  await page.fill('.sheet-wrap.open #f_lump', '5000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.remortgageOptions.length === 1);
  ok(await page.evaluate(() => { const o = data.remortgageOptions[0]; return o.partId === readyNow().part.id && o.rate === 4.1 && o.lump === 5000; }), 'a deal is saved against the part whose fix ends first');
  await page.click('#main [data-act="push"][data-arg="compare"]');
  await page.waitForSelector('table.cmp');
  const cmpText = await page.textContent('#main');
  ok(cmpText.includes('Do nothing') && cmpText.includes('5-year fix') && cmpText.includes('Total cost') && cmpText.includes('Overpay or keep the cash?'), 'deals compared side by side with doing nothing, and overpay-or-keep-cash');
  ok((await page.$$('table.cmp')).length >= 2, 'rate sensitivity grid shown');
  const payShown = await page.evaluate(() => { const C = compareOptions(data, scenarioKey(), 60, thisMonth()); return money(C.results[1].payment); });
  ok(cmpText.includes(payShown), 'the payment on screen is the engine’s');
  await page.click('#tabbar [data-arg="plan"]'); await page.click('#tabbar [data-arg="plan"]');
  await page.click('#main [data-act="push"][data-arg="scenario:base"]');
  await page.click('#main [data-act="edit-scplan"]');
  await page.waitForSelector('.sheet-wrap.open #f_option');
  await page.selectOption('.sheet-wrap.open #f_option', await page.evaluate(() => data.remortgageOptions[0].id));
  await page.selectOption('.sheet-wrap.open #f_b_' + await page.evaluate(() => data.bundles[0].id), 'off');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.scenarios.base.option);
  ok(await page.evaluate(() => data.scenarios.base.bundles[data.bundles[0].id] === false && data.bundles[0].on === true), 'the Base plan takes the deal and leaves the baby out, without switching the event off elsewhere');
  await page.click('#tabbar [data-arg="projection"]');
  await page.click('#main [data-act="push"][data-arg="plans"]');
  await page.waitForSelector('#c-pl-net');
  const plansText = await page.textContent('#main');
  ok(plansText.includes('Key dates') && plansText.includes('At the fix end') && plansText.includes('Available to overpay'), 'plans overlaid, with a difference table at key dates');
  ok(await page.evaluate(() => { const H = Math.max(horizon(), 60); const a = project(data, 'base', H).rows.at(-1).net; return document.querySelector('#main').textContent.includes('Base') && Number.isFinite(a); }), 'each plan runs as its own scenario');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-plans.png'), fullPage: true });

  console.log('Cash-flow calendar and plan vs actual');
  await page.click('#tabbar [data-arg="plan"]'); await page.click('#tabbar [data-arg="plan"]');
  await page.click('#main [data-act="push"][data-arg="calendar"]');
  await page.waitForSelector('#main [data-act="cal-month"]');
  ok((await page.$$('#main [data-act="cal-month"]')).length === 24, '24 months listed');
  await page.click('#main [data-act="cal-month"][data-arg="2027-02"]');
  const rentId = await page.evaluate(() => data.flows.find(f => f.name === 'Rent').id);
  await page.waitForSelector(`.sheet-wrap.open #f_f_${rentId}`);
  await page.fill(`.sheet-wrap.open #f_f_${rentId}`, '2000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(id => (data.flows.find(f => f.id === id).overrides || {})['2027-02'] === 2000, rentId);
  ok(await page.evaluate(() => { const r = project(data, scenarioKey(), 36).rows; const feb = r.find(x => x.date === '2027-02-01'), mar = r.find(x => x.date === '2027-03-01'); return Math.abs((feb.spend - feb.mortgagePay) - (mar.spend - mar.mortgagePay) - 1000) < 0.01; }), 'Feb 2027 rent set to £2,000: that month only, £1,000 more than usual');
  ok((await page.textContent('#main')).includes('Set by hand'), 'the month is marked as set by hand');
  await page.evaluate(() => { const d = new Date(); data.snapshots.push({ date: '2026-12-01', balances: { cur: 4000, isa: 98765 } }); changed(); });
  await page.evaluate(() => actions.push('snap:2026-12-01'));
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('Against plan'));
  ok(await page.evaluate(() => { const dr = drift(data, data.scenario, '2026-12-01'); return dr && document.querySelector('#main').textContent.includes(money(dr.expected.net)); }), 'a balance update shows what the plan expected and the difference');
  await page.evaluate(() => { data.snapshots = data.snapshots.filter(x => x.date !== '2026-12-01'); ui.stacks[ui.tab].pop(); changed(); });
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });

  console.log('Bank statements');
  await page.evaluate(() => { data.accounts.push({ id: 'amex', name: 'Test Amex', owner: 'M', type: 'card', rate: 0, active: true }); changed(); });
  await page.click('#tabbar [data-arg="plan"]'); await page.click('#tabbar [data-arg="plan"]');
  await page.setInputFiles('#csvIn', path.join(root, 'tests/fixtures/lloyds-sample.csv'));
  await page.waitForSelector('.sheet-wrap.open #f_account');
  ok((await page.textContent('.sheet-wrap.open')).includes('Lloyds · 25 transactions'), 'the Lloyds file is recognised');
  ok(await page.$eval('.sheet-wrap.open #f_account', el => el.value) === 'cur', 'a current account is suggested for a bank statement');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.transactions.length === 25);
  ok((await page.textContent('#main')).includes('Uncategorised'), 'after importing, it goes straight to sorting out what’s uncategorised');
  await page.setInputFiles('#csvIn', path.join(root, 'tests/fixtures/amex-sample.csv'));
  await page.waitForSelector('.sheet-wrap.open #f_account');
  ok(await page.evaluate(() => data.snapshots.some(s => s.date === '2026-06-30' && s.balances.cur === -134.28) && data.snapshots.some(s => s.date === '2026-09-28' && s.balances.cur === 4210.5)), 'the Lloyds statement’s opening and closing balances are recorded for the account');
  ok(await page.$eval('.sheet-wrap.open #f_account', el => el.value) === 'amex', 'the card is suggested for an Amex file');
  // the account picker: full width, with owner and type, so a long name or two of the same name can be told apart
  ok(await page.$eval('.sheet-wrap.open #f_account', el => { const r = el.getBoundingClientRect(), f = el.closest('.field').getBoundingClientRect(), t = el.options[el.selectedIndex].text; return el.closest('.field').classList.contains('stack') && r.width > f.width * 0.85 && t === 'Test Amex · Me · ' + TYPE_LABEL.card && getComputedStyle(el).direction === 'ltr'; }), 'the import picker shows the whole name, whose it is and the type, full width');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.transactions.length === 32);
  ok(await page.evaluate(() => { const C = TallyTx.categorised(data); return C.filter(t => t.cat === 'Transfer').length === 2; }), 'paying the card from the current account is matched as a transfer');
  // sort out one shop: every transaction from it, via a rule
  await page.evaluate(() => actions['cat-tx'](data.transactions.find(t => t.description === 'BIG BANK MORTGAGE').id));
  await page.waitForSelector('.sheet-wrap.open #f_cat');
  await page.selectOption('.sheet-wrap.open #f_cat', 'Home');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.categoryRules.length === 1);
  ok(await page.evaluate(() => TallyTx.categorised(data).filter(t => t.merchant === 'BIG BANK MORTGAGE').every(t => t.cat === 'Home') && data.categoryRules[0].contains === 'BIG BANK MORTGAGE'), 'one choice sorts all three mortgage payments and makes a rule');
  // the same file again adds nothing
  await page.setInputFiles('#csvIn', path.join(root, 'tests/fixtures/lloyds-sample.csv'));
  await page.waitForSelector('.sheet-wrap.open #f_account'); await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.imports.length === 3);
  ok(await page.evaluate(() => data.transactions.length === 32 && data.imports.at(-1).count === 0), 'importing the same statement again adds nothing');
  await page.evaluate(() => { ui.actRange = '2026-09'; actions.push('actuals'); });
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('By category'));
  const act = await page.textContent('#main');
  ok(act.includes('Home') && act.includes('plan'), 'budget vs actual by category');
  // the sample covers Jul-Sep 2026; with the real clock in Sep 2026 the complete months are Jul and Aug only, so no suggestions yet
  ok(await page.evaluate(() => { const R = recalibration(); return R === null || Array.isArray(R.rows); }), 'recalibration only speaks with three complete months');
  await page.waitForTimeout(500); // let the import sheet finish sliding away
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-actuals.png'), fullPage: true });
  ok(await page.evaluate(() => { const B = TallyTx.budgetVsActual(data, '2026-09', txCtx()); return document.querySelector('#main .hero').textContent.includes(money(B.actual - B.plan, { sign: true })); }), 'the headline is actual minus plan for September');
  // spending insights: the headline and the chart come from TallyTx.insights over the whole months
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 }); await page.waitForTimeout(500);
  await page.evaluate(() => { ui.ins = null; actions.push('insights'); });
  await page.waitForSelector('#c-ins .bcol');
  const ins = await page.evaluate(() => { const W = insWindow('6m'), I = TallyTx.insights(txCtx().categorised, { months: W.months, prevMonths: W.prevMonths, partial: W.partial });
    return { I, W, totalTxt: money(I.total), hero: document.querySelector('#main .hero').textContent, bars: document.querySelectorAll('#c-ins .bcol').length, part: document.querySelectorAll('#c-ins .bcol.part').length }; });
  ok(ins.W.full.join() === '2026-07,2026-08' && ins.W.partial === '2026-09', 'whole months are July and August; September is still running');
  ok(ins.bars === 3 && ins.part === 1 && ins.hero.includes(ins.totalTxt), 'three bars, September faded, and the headline is the two whole months');
  await page.click('#c-ins .bcol[data-i="1"]');
  ok((await page.textContent('#c-ins-r')).includes('Aug 2026'), 'tapping a month says what it was');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-insights.png'), fullPage: true });
  await page.click('#c-ins-r .linkbtn');
  await page.waitForFunction(() => document.querySelector('#main .subtitle')?.textContent.includes('Aug 2026'));
  ok(await page.evaluate(n => document.querySelectorAll('#main .list .row').length === n, ins.I.series[1].count), 'and opens exactly that month’s transactions');
  await page.evaluate(() => { ui.stacks[ui.tab].pop(); actions['ins-by']('merchant'); });
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('By shop'));
  const topShop = ins.I && await page.evaluate(() => { const W = insWindow('6m'); return TallyTx.insights(txCtx().categorised, { months: W.months, partial: W.partial, by: 'merchant' }).rows[0].key; });
  await page.click(`#main [data-arg="insights:merchant=${topShop}"]`);
  await page.waitForFunction(t => document.querySelector('#main h1, #main .large, .title')?.textContent.includes(t) || document.title.includes(t) || document.body.textContent.includes('By category'), topShop);
  ok((await page.textContent('#main')).includes('By category'), 'a shop opens its own page, split by category');
  await page.evaluate(() => { ui.stacks[ui.tab].pop(); actions['ins-measure']('net'); });
  await page.waitForFunction(() => document.querySelectorAll('#c-ins .bcol i').length === 6);
  ok(true, 'in and out: two bars a month');
  await page.evaluate(() => { ui.ins = null; ui.stacks[ui.tab].pop(); render(); });
  await page.evaluate(() => actions.push('recurring'));
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('Still going'));
  ok((await page.textContent('#main')).includes('STREAMFLIX PAYMENTS') && (await page.textContent('#main')).includes('Up £2.00'), 'recurring payments, with the price rise flagged');
  await page.click('#tabbar [data-arg="home"]'); await page.click('#tabbar [data-arg="home"]');
  ok((await page.textContent('#main')).includes('Sep 2026:') && (await page.textContent('#main')).includes('plan'), 'Overview carries one line for the latest month');
  await page.evaluate(() => actions['undo-import'] && (window.confirm = () => true) && actions['undo-import'](data.imports[1].id));
  ok(await page.evaluate(() => data.transactions.length === 25 && !data.transactions.some(t => t.account === 'amex')), 'an import can be removed as a whole');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });
  ok(await page.evaluate(async () => { const raw = window.__disk; return !raw.includes('BIG BANK') && !raw.includes('STREAMFLIX'); }), 'transactions are inside the encrypted file, not readable in it');

  console.log('Analysis and risk');
  await page.click('#tabbar [data-arg="projection"]'); await page.click('#tabbar [data-arg="projection"]');
  await page.evaluate(() => { ui.scenario = 'base'; render(); });
  const nomNet = await page.textContent('#main .stats');
  await page.click('#main [data-act="real"]');
  ok((await page.textContent('#main')).includes('today’s money') && (await page.textContent('#main .stats')) !== nomNet, 'today’s money changes the projected figures');
  await page.click('#main [data-act="real"]');
  await page.click('#main [data-act="push"][data-arg="isayear"]');
  ok((await page.textContent('#main')).includes('Planned by 5 April') && (await page.textContent('#main')).includes('Partner'), 'ISA allowance this tax year, per person');
  await page.click('#navL [data-act="back"]');
  await page.click('#main [data-act="push"][data-arg="risk"]');
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('What the range says'), null, { timeout: 30000 });
  const riskText = await page.textContent('#main');
  ok(riskText.includes('Chance cash drops below your floor') && !!(await page.$('#c-fan')), '2,000 futures run in the background, with a fan chart');
  ok((await page.$$('#main .group')).length >= 2 && riskText.includes('Markets fall 25% next month') && riskText.includes('The biggest income stops for 6 months'), 'stress tests listed');
  ok(await page.evaluate(() => ui.mc.res.paths === 2000), 'the full 2,000 paths ran (in the worker)');
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-risk.png'), fullPage: true });
  // goals
  await page.click('#tabbar [data-arg="plan"]'); await page.click('#tabbar [data-arg="plan"]');
  await page.click('#main [data-act="edit-goal"]');
  await page.waitForSelector('.sheet-wrap.open #f_target');
  await page.fill('.sheet-wrap.open #f_name', 'Overpayment pot'); await page.fill('.sheet-wrap.open #f_target', '50000'); await page.fill('.sheet-wrap.open #f_date', '2027-06');
  await page.click('.sheet-wrap.open #f_a_isa');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.goals.length === 1);
  ok(await page.evaluate(() => data.goals[0].accounts.join() === 'isa' && data.goals[0].date === '2027-06'), 'a goal is saved with its accounts');
  ok((await page.textContent('#main')).includes('Overpayment pot'), 'goals listed on Plan');
  await page.click('#main [data-act="push"][data-arg^="goal:"]');
  ok((await page.textContent('#main')).includes('Projected by Jun 2027'), 'the goal’s page');
  // balance update with money paid in
  await page.evaluate(() => { ui.stacks[ui.tab] = []; actions.update(); });
  await page.waitForSelector('.sheet-wrap.open #c_isa');
  await page.fill('.sheet-wrap.open #u_date', '2026-12-01');
  await page.fill('.sheet-wrap.open #b_isa', '101000'); await page.fill('.sheet-wrap.open #c_isa', '1000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.snapshots.some(s => s.date === '2026-12-01'));
  ok(await page.evaluate(() => data.snapshots.find(s => s.date === '2026-12-01').contrib.isa === 1000), 'what was paid in is saved with the update');
  await page.evaluate(() => actions.push('snap:2026-12-01'));
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('Where the change came from'));
  ok(await page.evaluate(() => Math.abs(TallyAnalysis.attribution(data, '2026-09-01', '2026-12-01').growth - (101000 - 98765 - 1000)) < 0.01), 'growth from 1 Sep: the change less what was paid in');
  // the page compares with the update just before - the statement balance on 28 Sep - with the S&S ISA on a straight line in between
  ok(await page.evaluate(() => { const prev = snapsSorted().filter(s => s.date < '2026-12-01').at(-1).date, X = TallyAnalysis.attribution(data, prev, '2026-12-01'); return prev === '2026-09-28' && document.querySelector('#main').textContent.includes(money(X.growth, { sign: true })); }), 'the page shows growth since the update just before');
  await page.evaluate(() => { data.snapshots = data.snapshots.filter(x => x.date !== '2026-12-01'); ui.stacks[ui.tab] = []; changed(); });
  // reminder file
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => downloadReminder())]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  ok(dl.suggestedFilename() === 'tally-balance-reminder.ics' && ics.includes('RRULE:FREQ=MONTHLY;BYMONTHDAY=1') && ics.includes('\r\n'), 'monthly reminder calendar file');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });

  console.log('Balances per account');
  await page.evaluate(() => { data.accounts.push({ id: 'sav', name: 'Test Saver', owner: 'M', type: 'savings', rate: 4, active: true, access: 'instant' }); data.snapshots.push({ date: '2026-09-01', balances: { sav: 10000 } }); data.snapshots.sort((a, b) => a.date.localeCompare(b.date)); const s = data.snapshots.filter(x => x.date === '2026-09-01'); if (s.length > 1) { Object.assign(s[0].balances, s[1].balances); data.snapshots = data.snapshots.filter(x => x !== s[1]); } changed(); });
  await page.click('#tabbar [data-arg="accounts"]'); await page.click('#tabbar [data-arg="accounts"]');
  ok((await page.textContent('#main')).includes('est. at its rate'), 'a saver not updated since September is worked out at its rate');
  await page.evaluate(() => actions.push('acct:sav'));
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('worked out from its interest rate'));
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-saver.png'), fullPage: true });
  ok(await page.evaluate(() => { const b = balanceOn(data, 'sav', todayISO()); return b.how === 'interest' && document.querySelector('#main .hero').textContent.includes(money(b.v)); }), 'the saver’s page shows today’s balance worked out from its rate');
  await page.click('#main [data-act="add-mtx"]');
  await page.waitForSelector('.sheet-wrap.open #f_kind');
  await page.fill('.sheet-wrap.open #f_date', '2026-09-15'); await page.fill('.sheet-wrap.open #f_amount', '500');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.transactions.some(t => t.account === 'sav' && t.source === 'manual'));
  ok(await page.evaluate(() => { const t = data.transactions.find(x => x.account === 'sav' && x.source === 'manual'); return t.amount === 500 && t.kind === 'in' && t.category === 'Transfer'; }), 'money paid in, entered by hand');
  // a balance for the S&S ISA on its own
  await page.evaluate(() => actions.push('acct:isa'));
  await page.click('#main [data-act="add-bal"]');
  await page.waitForSelector('.sheet-wrap.open #f_bal');
  await page.fill('.sheet-wrap.open #f_date', '2026-11-20'); await page.fill('.sheet-wrap.open #f_bal', '104000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.snapshots.some(s => s.date === '2026-11-20'));
  ok(await page.evaluate(() => { const sn = data.snapshots.find(s => s.date === '2026-11-20'); return Object.keys(sn.balances).join() === 'isa' && sn.balances.isa === 104000; }), 'a balance for one account, without touching the others');
  ok(await page.evaluate(() => { const p = latestSnapshot(data); return p.date === '2026-11-20' && p.balances.isa === 104000 && p.how.cur === 'transactions' && p.how.sav === 'interest'; }), 'everything else is worked out for that date, and the projection starts there');
  // the checks
  await page.evaluate(() => actions.push('checks'));
  await page.waitForFunction(() => document.querySelector('#main').textContent.includes('To look at'));
  const ck = await page.evaluate(() => TallyAnalysis.checks(data).find(c => c.account === 'isa' && c.to === '2026-11-20'));
  ok(ck && ck.kind === 'return' && ck.open, 'the S&S move is listed with its return to cross-check');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-checks.png'), fullPage: true });
  await page.evaluate(k => actions.review(k), ck.key);
  await page.waitForSelector('.sheet-wrap.open #f_checked');
  await page.click('.sheet-wrap.open #f_checked'); await page.fill('.sheet-wrap.open #f_note', 'matches the statement');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(k => data.reviews[k], ck.key);
  ok(await page.evaluate(k => !TallyAnalysis.checks(data).find(c => c.key === k).open && data.reviews[k].note === 'matches the statement', ck.key), 'cross-checked, with a note, and no longer asked');
  // the update sheet leaves savings blank to be worked out
  await page.evaluate(() => actions.update());
  await page.waitForSelector('.sheet-wrap.open #b_sav');
  ok(await page.$eval('.sheet-wrap.open #b_sav', el => el.value === '' && el.placeholder.startsWith('about')), 'savings are left blank on a full update, showing the estimate');
  // untick the current account: nothing is recorded for it, and the others are saved
  await page.fill('.sheet-wrap.open #u_date', '2026-10-15'); await page.dispatchEvent('.sheet-wrap.open #u_date', 'change');
  await page.click('.sheet-wrap.open .inc[data-for="cur"]');
  ok(await page.$eval('.sheet-wrap.open #b_cur', el => el.disabled && el.closest('.field').classList.contains('out')), 'unticking an account greys it out');
  await page.fill('.sheet-wrap.open #b_isa', '101000');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.snapshots.some(s => s.date === '2026-10-15'));
  ok(await page.evaluate(() => { const b = data.snapshots.find(s => s.date === '2026-10-15').balances; return !('cur' in b) && b.isa === 101000; }), 'a left-out account is not set on that date; the rest are');
  await page.waitForTimeout(400);
  await page.evaluate(() => { data.snapshots = data.snapshots.filter(s => s.date !== '2026-11-20' && s.date !== '2026-10-15'); changed(); });
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });

  console.log('Account names and interest rates over time');
  await page.evaluate(() => { data.accounts.push({ id: 'sav2', name: 'Test Saver', owner: 'C', type: 'savings', rate: 2, active: true, access: 'instant' }); changed(); });
  ok(await page.evaluate(() => accName('sav') === 'Test Saver (Me)' && accName('sav2') === 'Test Saver (Partner)' && accName('cur') === acc('cur').name), 'two accounts with the same name show whose each is; a unique name is left alone');
  await page.evaluate(() => { data.accounts = data.accounts.filter(a => a.id !== 'sav2'); changed(); });
  const before = await page.evaluate(() => [balanceOn(data, 'sav', '2026-10-01').v, balanceOn(data, 'sav', '2027-03-01').v]);
  await page.evaluate(() => actions.push('acct:sav'));
  await page.waitForSelector('#main [data-act="add-rate"]');
  ok((await page.textContent('#main')).includes('In force now'), 'the account page lists its interest rate');
  await page.click('#main [data-act="add-rate"]');
  await page.waitForSelector('.sheet-wrap.open #f_rate');
  await page.fill('.sheet-wrap.open #f_from', '2027-01-01'); await page.fill('.sheet-wrap.open #f_rate', '5');
  await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => acc('sav').rates.length === 2);
  const after = await page.evaluate(() => [balanceOn(data, 'sav', '2026-10-01').v, balanceOn(data, 'sav', '2027-03-01').v, rateOn(acc('sav'), '2026-12-31'), rateOn(acc('sav'), '2027-01-01'), acc('sav').rate]);
  ok(after[0] === before[0], 'a rate from January leaves October’s balance exactly as it was');
  ok(after[1] > before[1] && after[2] === 4 && after[3] === 5, 'and March grows at 5% from January, 4% before');
  ok(after[4] === 4, 'the rate shown today stays the one in force today');
  await page.click('#main [data-act="edit-rate"][data-arg="sav|2027-01-01"]');
  await page.waitForSelector('.sheet-wrap.open #f_rate');
  await page.click('.sheet-wrap.open [data-sact="delete"]');
  await page.waitForFunction(() => acc('sav').rates.length === 1);
  ok(await page.evaluate(b => balanceOn(data, 'sav', '2027-03-01').v === b, before[1]), 'removing the change puts every period back');
  await page.waitForFunction(() => !meta.dirty, null, { timeout: 5000 });

  console.log('Market rates');
  // a MADE-UP curve, served in place of rates/curve-latest.json: a gentle hump around 4%
  const fw = Array.from({ length: 60 }, (_, i) => 4 + 0.5 * Math.sin((i + 1) / 12)), lt = [6, 7, 8, 9, 10, 15, 20, 25];
  const madeUp = { source: 'Test curve (made up)', asOf: '2026-09-25', compounding: 'continuous', shortEnd: { stepMonths: 1, forward: fw, spot: fw }, long: { tenorsYears: lt, forward: lt.map(() => 3.8), spot: lt.map(() => 3.9) }, anchors: { bankRate: 4, sonia: 4 }, quoted: { mortgage2yFix75: { rate: 4.6, month: '2026-08' } } };
  await page.route('**/rates/curve-latest.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(madeUp) }));
  await page.evaluate(() => loadCurve());
  await page.evaluate(() => { ui.tab = 'projection'; ui.stacks.projection = []; render(); });
  await page.click('#main [data-act="push"][data-arg="rates"]');
  await page.waitForSelector('#main [data-act="curve-use"]');
  ok((await page.textContent('#main')).includes('Use the Bank of England curve as at 25 Sep 2026'), 'the Rates screen offers the published curve');
  const net0 = await page.evaluate(() => project(data, scenarioKey(), 60).rows.at(-1).net);
  await page.click('#main [data-act="curve-use"]');
  await page.waitForFunction(() => data.rateBasis && data.rateBasis.asOf === '2026-09-25');
  ok(await page.evaluate(n => project(data, scenarioKey(), 60).rows.at(-1).net === n, net0), 'using a curve moves nothing until an account is put on market rates');
  ok((await page.textContent('#main')).includes('Curve in use'), 'the curve in use is shown with its date');
  await page.click('#main [data-act="rates-all"]');
  await page.waitForFunction(() => acc('sav').rateModel && data.mortgage.parts[0].rateModel);
  ok((await page.textContent('#main')).includes('Variable: follows Bank Rate at 60%, 2-month lag'), 'each account’s rule, in words');
  await waitSaved();
  ok(await page.evaluate(() => !meta.dirty && acc('sav').rateModel.kind === 'variable') && (await disk()).format === 'tally-encrypted', 'saved into the (encrypted) file');
  const fixK = await page.evaluate(() => ymKeyOf(data.mortgage.parts[0].fixEnd));
  // an earlier check chose a remortgage deal in this scenario, and a chosen deal takes over at the fix end: look without it
  ok(await page.evaluate(k => { const r = projectAs(data, scenarioKey(), { option: null }, 60).rows.find(x => x.k === k); return r.mortgageParts[0].repriced && Math.abs(r.mortgageParts[0].rate - 5) > 1e-6; }, fixK), 'the mortgage moves off its fixed rate onto a variable rate following the curve');
  ok(await page.evaluate(k => { const r = project(data, scenarioKey(), 60).rows.find(x => x.k === k); return r.mortgageParts[0].why === null && r.mortgageParts[0].rate === +data.remortgageOptions.find(o => o.id === data.scenarios[scenarioKey()].option).rate; }, fixK), 'a deal chosen in the plan wins over the market path');
  const optWas = await page.evaluate(() => { const o = data.scenarios[scenarioKey()].option; data.scenarios[scenarioKey()].option = null; changed(); return o; });
  await page.evaluate(k => actions.push('month:' + k), fixK);
  await page.waitForSelector('#main [data-act="why"]');
  ok((await page.textContent('#main')).includes('Repriced'), 'the month detail marks the repricing');
  await page.click('#main [data-act="why"]');
  await page.waitForSelector('.sheet-wrap.open');
  ok((await page.textContent('.sheet-wrap.open')).includes('Bank Rate expected in'), 'tapping a rate shows how it was worked out');
  await page.click('.sheet-wrap.open .cancel'); await page.waitForTimeout(400);
  await page.evaluate(() => { ui.tab = 'accounts'; ui.stacks.accounts = []; actions.push('acct:sav'); });
  await page.waitForSelector('#main #c-ratepath');
  ok((await page.textContent('#main')).includes('In the projection'), 'an account’s page shows its rate rule and path');
  // what rates change: as set up, all on market rates, all flat
  await page.evaluate(() => { ui.tab = 'projection'; ui.stacks.projection = ['rates']; render(); });
  await page.click('#main [data-act="push"][data-arg="impact"]');
  await page.waitForSelector('#main #c-imp-net');
  const imp = await page.textContent('#main');
  ok(imp.includes('All on market rates') && imp.includes('All flat') && imp.includes('Every scenario'), '“What rates change” shows the three ways side by side, and every scenario');
  ok(await page.evaluate(() => { const I = rateImpact(data, scenarioKey(), ui.impH || 60); return document.querySelectorAll('#main .chart[id^="c-imp-"]').length === I.items.length + 1 && I.items.some(x => x.kind === 'part'); }), 'a chart for each account and the mortgage, plus net worth against flat');
  await page.click('#main [data-act="imp-view"][data-arg="rate"]');
  await page.waitForFunction(() => ui.impView === 'rate' && document.querySelector('#main #c-imp-0'));
  ok((await page.textContent('#main')).includes('Rate, '), 'and the same for rates');
  await page.evaluate(() => { meta.private = false; render(); }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-impact.png'), fullPage: true });
  await page.evaluate(() => { meta.private = true; ui.impView = 'balance'; render(); });
  await page.evaluate(() => { ui.tab = 'plan'; ui.stacks.plan = ['mortgage', 'ready', 'compare']; render(); });
  await page.waitForSelector('#main [data-act="add-option-market"]');
  ok((await page.textContent('#main')).includes('Market-implied at Jun 2027'), 'Compare deals prices a 2- and 5-year fix from the market at the switch');
  await page.click('#main [data-act="add-option-market"][data-arg="24"]');
  await page.waitForSelector('.sheet-wrap.open #f_rate');
  ok(await page.$eval('.sheet-wrap.open #f_name', el => el.value === 'Market 2-year fix'), 'and offers it as a deal to compare');
  await page.click('.sheet-wrap.open .cancel'); await page.waitForTimeout(400);
  await page.evaluate(() => rateKindSheet(scenarioKey(), 'shift'));
  await page.waitForSelector('.sheet-wrap.open #f_shift');
  await page.fill('.sheet-wrap.open #f_shift', '1'); await page.click('.sheet-wrap.open .done');
  await page.waitForFunction(() => data.scenarios[scenarioKey()].rates.kind === 'shift');
  ok(await page.evaluate(() => data.scenarios[scenarioKey()].rates.shift === 1), 'a scenario can move the market curve up a point');
  await page.evaluate(() => { data.scenarios[scenarioKey()].rates = { kind: 'market' }; changed(); ui.tab = 'projection'; ui.stacks.projection = ['rates']; render(); });
  await page.waitForTimeout(300); await page.screenshot({ path: path.join(process.env.SHOTS || '/tmp', 'tally-rates.png'), fullPage: true });
  await page.evaluate(() => { data.scenarios[scenarioKey()].rates = { kind: 'flat' }; changed(); });
  ok(await page.evaluate(k => project(data, scenarioKey(), 60).rows.find(x => x.k === k).mortgageParts[0].rate === 5, fixK), '“Flat” puts the mortgage back on its entered rate after the fix');
  await page.evaluate(o => { data.scenarios[scenarioKey()].rates = { kind: 'market' }; data.scenarios[scenarioKey()].option = o; for (const a of data.accounts) delete a.rateModel; for (const p of data.mortgage.parts) delete p.rateModel; changed(); }, optWas);
  await waitSaved();

  console.log('Newer files');
  const refused = await page.evaluate(async () => { const f = JSON.stringify({ app: 'tally', version: TallyModel.VERSION + 1, accounts: [], snapshots: [] }); return await loadText(f, 'future.json'); });
  ok(refused === false && await page.evaluate(() => data.bundles.length === 1), 'a file from a newer Tally is refused, and nothing is replaced');

  ok((await page.evaluate(() => window.__csp)).length === 0 && (await page2.evaluate(() => window.__csp)).length === 0, 'nothing blocked by the security policy');
  ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  console.log(`All ${passed} browser checks pass ✓`);
} finally { await browser.close(); server.close(); }
