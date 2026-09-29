// Run with:  node tests/balances.test.js
// Balances between known dates, per account (Sep 2026): interest for savings, transactions for current
// accounts and cards, a straight line otherwise; a one-account update; the checks that flag a move nothing
// explains; the Lloyds running balance. Expected figures worked out by hand from the rules. Synthetic data only.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const TM = require('../model.js');
const E = require('../engine.js');
const A = require('../analysis.js');
const TX = require('../transactions.js');
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;

const household = () => TM.migrate({
  version: 8, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', name: 'Current', type: 'current' }, { id: 'sav', name: 'Saver', type: 'savings', rate: 4 }, { id: 'ss', name: 'S&S ISA', type: 'ss_isa' },
    { id: 'old', name: 'Old saver', type: 'savings', rate: 1, active: false }],
  snapshots: [
    { date: '2026-01-01', balances: { cur: 1000, sav: 10000, ss: 20000, old: 500 } },
    { date: '2026-07-01', balances: { ss: 23000 } },                                   // one account on its own
  ],
  transactions: [
    { id: 't0', account: 'cur', date: '2025-12-20', amount: -100, description: 'SHOP' },
    { id: 't1', account: 'cur', date: '2026-02-10', amount: -200, description: 'SHOP' },
    { id: 't2', account: 'cur', date: '2026-03-15', amount: 1500, description: 'PAY' },
    { id: 't3', account: 'cur', date: '2026-06-30', amount: -300, description: 'SHOP' },
    { id: 'm1', account: 'sav', date: '2026-04-01', amount: 1000, description: 'Paid in', kind: 'in', source: 'manual' },
    { id: 'm2', account: 'ss', date: '2026-05-01', amount: 1000, description: 'Contribution', kind: 'in', source: 'manual' },
  ],
  flows: [], bufferPct: 0, bundles: [], mortgage: { parts: [{ id: 'main', payment: 0 }] },
  rules: { cashFloor: 0, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M'], isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { s: { name: 'S', growth: false } },
});

// ---- working out a balance on any date ----
let d = household();
let b = E.balanceOn(d, 'sav', '2027-01-01');
// 10,000 for a whole year at 4% = 10,400; the 1,000 paid in on 1 Apr grows for the 275 days to 1 Jan 2027
near(b.v, 10400 + 1000 * Math.pow(1.04, days('2026-04-01', '2027-01-01') / 365), 'savings: grown at its rate, with what was paid in'); assert.strictEqual(b.how, 'interest');
b = E.balanceOn(d, 'cur', '2026-07-01');
near(b.v, 1000 - 200 + 1500 - 300, 'current account: last balance plus every transaction since'); assert.strictEqual(b.how, 'transactions');
b = E.balanceOn(d, 'cur', '2025-12-01');
near(b.v, 1000 + 100, 'before the first balance: the next balance less the transactions in between');
b = E.balanceOn(d, 'ss', '2026-04-01');
near(b.v, 20000 + 3000 * days('2026-01-01', '2026-04-01') / days('2026-01-01', '2026-07-01'), 'S&S between two balances: a straight line'); assert.strictEqual(b.how, 'straight');
b = E.balanceOn(d, 'ss', '2026-09-01'); near(b.v, 23000, 'after the last balance: held'); assert.strictEqual(b.how, 'carried');
assert.strictEqual(E.balanceOn(d, 'old', '2026-07-01'), null, 'a closed account is not carried forward');
assert.strictEqual(E.balanceOn(d, 'ss', '2026-07-01').how, 'observed');
console.log('  ✓ balances between known dates: interest, transactions, straight line, held, closed');

// ---- a one-account update: the projection still starts from everything ----
const pos = E.latestSnapshot(d);
assert.strictEqual(pos.date, '2026-07-01', 'starts from the latest date anything was entered');
near(pos.balances.cur, 2000, 'current account worked out from transactions');
near(pos.balances.sav, 10000 * Math.pow(1.04, days('2026-01-01', '2026-07-01') / 365) + 1000 * Math.pow(1.04, days('2026-04-01', '2026-07-01') / 365), 'saver rolled forward at its rate', 0.006);
assert.strictEqual(pos.balances.ss, 23000); assert.ok(!('old' in pos.balances));
const r0 = E.project(d, 's', 1).rows[0];
near(r0.isaSS, 23000, 'the projection starts from the S&S balance entered on its own');
near(r0.net, pos.balances.cur + pos.balances.sav + 23000, 'and from every other account as worked out', 0.01);
// a full update on the latest date gives exactly that update, as before
d.snapshots.push({ date: '2026-08-01', balances: { cur: 50, sav: 60, ss: 70 } });
assert.deepStrictEqual(E.latestSnapshot(d).balances, { cur: 50, sav: 60, ss: 70 });
console.log('  ✓ a balance for one account on its own; the projection starts from all of them');

// ---- history charts: an account counts only from its first entered balance ----
// a card whose statement goes back before the first balance entered for it can be worked out backwards
d = household(); d.accounts.push({ id: 'late', name: 'Late card', type: 'card', owner: 'M', active: true }); d = TM.migrate(d);
d.snapshots.push({ date: '2026-05-01', balances: { late: -5000 } });
d.transactions.push({ id: 'l1', account: 'late', date: '2026-04-01', amount: -250, description: 'SHOP' });
assert.ok(E.positionOn(d, '2026-03-01').balances.late != null, 'worked out backwards when asked for the plain position');
assert.ok(!('late' in E.positionOn(d, '2026-03-01', { entered: true }).balances), 'left out of the history before its first balance');
near(E.positionOn(d, '2026-05-01', { entered: true }).balances.late, -5000, 'and counted from that date');
assert.deepStrictEqual(E.positionOn(d, '2026-07-01', { entered: true }).balances, E.positionOn(d, '2026-07-01').balances, 'once every account has started, the two agree');
console.log('  ✓ history leaves an account out before its first balance');

// ---- the checks ----
d = household();
d.snapshots.push({ date: '2026-10-01', balances: { cur: 2500, sav: 11500 } });
let C = A.checks(d), c = id => C.find(x => x.account === id && x.to === '2026-10-01');
// current: 1,000 → 2,500 is +1,500; the transactions between explain +1,000 (−200 +1,500 −300): 500 unexplained
near(c('cur').explained, 1000, 'current: explained by transactions'); near(c('cur').unexplained, 500, 'current: 500 unexplained');
assert.strictEqual(c('cur').material, true); assert.strictEqual(c('cur').open, true);
// saver: 10,000 grown for 273 days at 4%, plus 1,000 grown for 183 days, against 11,500
const expected = 10000 * Math.pow(1.04, 273 / 365) + 1000 * Math.pow(1.04, 183 / 365);
near(c('sav').unexplained, 11500 - expected, 'saver: the gap after interest and what was paid in');
assert.strictEqual(c('sav').material, 11500 - expected > Math.max(100, 0.01 * 11500), 'material above £100 or 1% of the balance');
// S&S: 20,000 → 23,000 with 1,000 paid in: 2,000 of market movement, a money-weighted 2,000 / 20,500
const s = C.find(x => x.account === 'ss');
near(s.paidIn, 1000, 'contribution entered by hand'); near(s.market, 2000, 'market movement'); near(s.return, 2000 / 20500, 'return to cross-check');
assert.strictEqual(s.kind, 'return'); assert.strictEqual(s.open, true);
d.reviews[s.key] = { status: 'checked', at: '2026-10-02' };
assert.strictEqual(A.checks(d).find(x => x.key === s.key).open, false, 'cross-checked: no longer open');
// a small gap is not material
d.snapshots.find(x => x.date === '2026-10-01').balances.cur = 2050;
assert.strictEqual(A.checks(d).find(x => x.account === 'cur' && x.to === '2026-10-01').material, false, '£50 off is not worth asking about');
console.log('  ✓ checks: unexplained moves flagged, material only above the threshold; returns to cross-check');

// ---- the Lloyds running balance ----
const L = TX.read(fs.readFileSync(path.join(__dirname, 'fixtures/lloyds-sample.csv'), 'utf8'), 'cur');
assert.deepStrictEqual(L.balances.closing, { date: '2026-09-28', balance: 4210.5 }, 'closing: the newest row’s balance');
// the oldest row is 01/07/2026, £150 out, leaving −284.28: before it the account held −134.28
assert.deepStrictEqual(L.balances.opening, { date: '2026-06-30', balance: -134.28 }, 'opening: the day before the oldest row');
d = household(); d.transactions = L.txns; d.snapshots = [{ date: L.balances.opening.date, balances: { cur: L.balances.opening.balance } }, { date: L.balances.closing.date, balances: { cur: L.balances.closing.balance } }];
C = A.checks(d);
near(C[0].unexplained, 0, 'a statement with its own balances reconciles exactly', 0.005);
near(E.balanceOn(d, 'cur', '2026-08-28').v, 2973.49, 'any date in between: the statement’s own balance that day', 0.005);
console.log('  ✓ the Lloyds running balance gives opening and closing balances that reconcile exactly');

// ---- where the change came from, with money recorded ----
d = household(); d.snapshots.push({ date: '2026-10-01', balances: { cur: 2000, sav: 11500, ss: 24000 } });
const X = A.attribution(d, '2026-01-01', '2026-10-01');
near(X.accounts.find(x => x.id === 'sav').interest, 1500 - 1000, 'saver: with money in recorded, interest is what is left of the change');
near(X.accounts.find(x => x.id === 'ss').growth, 4000 - 1000, 'S&S: growth after the recorded contribution');
near(X.saved + X.growth + X.interest + X.debt, X.change, 'still adds up exactly');
console.log('All balance checks pass ✓');
