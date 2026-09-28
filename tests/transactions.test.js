// Run with:  node tests/transactions.test.js
// Phase 2: CSV import (Lloyds, Amex, any bank by column mapping), duplicates, categories and rules,
// transfers between own accounts, budget against actual, recurring payments.
// The two sample files are MADE UP in the exact layout each bank exports. No real data.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const TX = require('../transactions.js');
const TM = require('../model.js');
const E = require('../engine.js');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, expected ${b}`);
const lloyds = fs.readFileSync(path.join(__dirname, 'fixtures/lloyds-sample.csv'), 'utf8');
const amex = fs.readFileSync(path.join(__dirname, 'fixtures/amex-sample.csv'), 'utf8');

// ---- reading the files ----
const rows = TX.parseCSV(amex);
assert.strictEqual(rows.length, 8, 'addresses that run over several lines stay inside one row');
assert.strictEqual(rows[2][7], 'FLOOR 4\nEXAMPLE HOUSE\n1 SAMPLE STREET');
assert.strictEqual(TX.detect(TX.parseCSV(lloyds)[0]), 'lloyds'); assert.strictEqual(TX.detect(rows[0]), 'amex');
const L = TX.read(lloyds, 'joint'), A = TX.read(amex, 'card');
assert.strictEqual(L.txns.length, 25); assert.strictEqual(A.txns.length, 7); assert.deepStrictEqual(L.badRows, []);
assert.deepStrictEqual([L.from, L.to], ['2026-07-01', '2026-09-28']);
const byDesc = (r, d) => r.txns.filter(t => t.description === d);
near(byDesc(L, 'PET COVER LTD')[0].amount, -40, 'Lloyds debit is money out');
near(byDesc(L, 'A PERSON')[0].amount, 3000, 'Lloyds credit is money in');
near(byDesc(L, 'TESCO STORES 5678')[0].amount, -0.25, '".25" is 25p');
near(byDesc(L, 'SHOP REFUND')[0].amount, 15, 'a refund on a card payment line');
assert.strictEqual(byDesc(L, 'INTEREST (GROSS)')[0].amount, 1.25, 'a row with no type still counts');
near(byDesc(A, 'CITY SANDWICH CO LONDON')[0].amount, -6.95, 'Amex charge (positive in the file) is money out');
near(byDesc(A, 'PAYMENT RECEIVED - THANK YOU')[0].amount, 210.35, 'Amex payment (negative in the file) is money in');
assert.strictEqual(byDesc(A, 'CITY SANDWICH CO LONDON')[0].bankCategory, 'Entertainment-Restaurants');
assert.strictEqual(byDesc(A, 'CITY SANDWICH CO LONDON')[0].merchant, 'CITY SANDWICH CO', 'town padding dropped from the merchant');
assert.strictEqual(byDesc(L, 'SQ *LOCAL BAKERY')[0].merchant, 'LOCAL BAKERY', 'card-reader prefix dropped');
assert.strictEqual(byDesc(A, 'TESCO STORE 1234 1234TE LONDON')[0].merchant, 'TESCO STORE');
console.log('  ✓ Lloyds and Amex files read, with each bank’s quirks');

// ---- the same file twice adds nothing; identical rows are both kept ----
assert.strictEqual(byDesc(L, 'SQ *LOCAL BAKERY').length, 2, 'two identical bakery payments on one day are two payments');
assert.strictEqual(byDesc(A, 'TESCO STORE 1234 1234TE LONDON').length, 2);
assert.strictEqual(new Set(L.txns.map(t => t.id)).size, 25, 'every id is different');
let f = TX.fresh(L.txns, TX.read(lloyds, 'joint').txns);
assert.deepStrictEqual([f.add.length, f.dupes], [0, 25], 'importing the same CSV twice adds nothing');
// a later export that overlaps the first: only the new rows are added
const later = lloyds.replace('Balance\n', 'Balance\n29/09/2026,DEB,\'00-00-00,12345678,CORNER CAFE,3.10,,4207.40\n');
f = TX.fresh(L.txns, TX.read(later, 'joint').txns); assert.deepStrictEqual([f.add.length, f.dupes], [1, 25], 'an overlapping export adds only the new row');
assert.notDeepStrictEqual(TX.read(lloyds, 'other').txns[0].id, L.txns[0].id, 'the same row in another account is a different transaction');
console.log('  ✓ duplicates skipped, genuine repeats kept');

// ---- any other bank: map the columns ----
const other = 'Date,Details,Money out,Money in\n2026-09-03,Gym,30.00,\n2026-09-04,Salary,,2500.00\n';
assert.strictEqual(TX.read(other, 'x').error, 'unknown', 'an unknown layout asks for its columns');
const G = TX.read(other, 'x', { map: { date: 0, description: 1, debit: 2, credit: 3 } });
assert.deepStrictEqual(G.txns.map(t => [t.date, t.amount]), [['2026-09-03', -30], ['2026-09-04', 2500]]);
const G2 = TX.read('When,What,Value\n03/09/2026,Gym,30\n', 'x', { map: { date: 0, description: 1, amount: 2, outIsNegative: false } });
near(G2.txns[0].amount, -30, 'a file that shows spending as positive');
console.log('  ✓ any bank by mapping its columns');

// ---- categories, rules, transfers ----
const d = TM.migrate({ version: 6, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }], accounts: [{ id: 'joint', type: 'current' }, { id: 'card', type: 'card' }], snapshots: [],
  flows: [{ id: 'l', name: 'Food', kind: 'spend', amount: 300, category: 'Living' }, { id: 'b', name: 'Bills', kind: 'spend', amount: 250, category: 'Bills' }, { id: 'm', name: 'Mortgage', kind: 'spend', linked: 'mortgage', category: 'Home' }],
  mortgage: { parts: [{ id: 'main', payment: 1200 }] }, rules: {}, scenarios: { s: { name: 'S', growth: false } } });
d.transactions = [...L.txns, ...A.txns];
let C = TX.categorised(d); const c = desc => C.find(t => t.description === desc);
assert.strictEqual(c('CITY SANDWICH CO LONDON').cat, 'Eating out', 'from the bank’s own category');
assert.strictEqual(c('TESCO STORES 1234').cat, 'Living', 'a common merchant');
assert.strictEqual(c('BIG BANK MORTGAGE').cat, 'Uncategorised', 'nothing known about it yet');
// paying the card from the joint account: equal, opposite, a day apart, different accounts
assert.strictEqual(c('AMERICAN EXPRESS').cat, 'Transfer'); assert.strictEqual(c('PAYMENT RECEIVED - THANK YOU').cat, 'Transfer');
assert.strictEqual(c('AMERICAN EXPRESS').pair, c('PAYMENT RECEIVED - THANK YOU').id, 'matched as one transfer');
// a rule, and a correction by hand
d.categoryRules = [{ id: 'r1', contains: 'BIG BANK', category: 'Home' }, { id: 'r2', contains: 'PET COVER', category: 'Pets' },
  { id: 'r3', contains: 'STREAMFLIX', category: 'Bills' }, { id: 'r4', contains: 'POWER CO', category: 'Bills' }]; // made-up names aren't in the common-merchant list
d.categoryMap = { 'General Purchases-Clothing Stores': 'Clothes' };
d.transactions.find(t => t.description === 'CORNER CAFE').category = 'Eating out';
C = TX.categorised(d);
assert.strictEqual(c('BIG BANK MORTGAGE').cat, 'Home', 'a rule applies to everything already imported');
assert.strictEqual(c('EXAMPLE CLOTHES LTD LONDON').cat, 'Clothes', 'your mapping of the bank’s category');
assert.strictEqual(c('CORNER CAFE').cat, 'Eating out'); assert.strictEqual(c('CORNER CAFE').by, 'hand');
assert.ok(TX.ruleMatches({ contains: 'x', min: 10, max: 20 }, { description: 'X', amount: -15 }) && !TX.ruleMatches({ contains: 'x', min: 10, max: 20 }, { description: 'X', amount: -25 }), 'amount range');
console.log('  ✓ categories: set by hand, rules, the bank’s own, common merchants; card payments are transfers');

// ---- budget against actual, September 2026 ----
const ctx = { model: TM, amountAt: E.amountAt, mortgagePayment: E.mortgageTotals(d).payment, categorised: C };
const B = TX.budgetVsActual(d, '2026-09', ctx), row = k => B.rows.find(r => r.category === k);
// Living: Tesco 56.10 (Lloyds) + 3.60 + 3.60 (Amex) = 63.30 against 300 planned
near(row('Living').actual, 63.30, 'Living actual'); near(row('Living').plan, 300, 'Living plan'); near(row('Living').variance, -236.70, 'under plan');
// Home: the mortgage payment 1,200 against the plan's mortgage line 1,200
near(row('Home').actual, 1200, 'Home actual'); near(row('Home').plan, 1200, 'Home plan');
// Bills: streaming 11.99 + council 150 + energy 90 = 251.99 against 250
near(row('Bills').actual, 251.99, 'Bills actual'); near(row('Bills').pct, 1.99 / 250 * 100, 'Bills over by 0.8%');
// Eating out: cafe 12.40 + sandwich 6.95 − 5.00 refund = 14.35, nothing planned
near(row('Eating out').actual, 14.35, 'refunds reduce spending'); assert.strictEqual(row('Eating out').plan, 0);
assert.ok(!row('Transfer') && !row('Income'), 'transfers and money in are not spending');
near(B.income, 3000 + 15 + 1.25, 'money in that month (pay, refund, interest)');
assert.deepStrictEqual(TX.months(d), ['2026-09', '2026-08', '2026-07']);
console.log('  ✓ budget against actual by category, refunds netted, transfers left out');

// ---- recurring payments ----
const R = TX.recurring(C, '2026-09-30'), rec = m => R.find(r => r.merchant === m);
assert.ok(rec('PET COVER LTD') && rec('PET COVER LTD').cadence === 'monthly', 'monthly direct debit found');
assert.ok(rec('BIG BANK MORTGAGE') && rec('COUNCIL DIRECT DEBIT'), 'others found');
near(rec('STREAMFLIX PAYMENTS').rise, 2, 'price rise flagged: 9.99 → 11.99');
assert.ok(!rec('LOCAL BAKERY'), 'two coffees on one day are not a subscription');
assert.strictEqual(rec('PET COVER LTD').isNew, true, 'three payments, all recent: new');
assert.strictEqual(TX.recurring(C, '2026-12-31').find(r => r.merchant === 'PET COVER LTD').stopped, true, 'no payment for three months: stopped');
console.log('  ✓ recurring payments, price rises, new and stopped');
// ---- recalibration: Jul-Sep 2026, worked by hand ----
// Pets: 40 a month on the PET COVER rule, nothing planned → not shown (no plan to adjust).
// Bills: Jul 150 (council) + 9.99 (streaming, rule) = 159.99; Aug 150 + 11.99 + 90 = 251.99; Sep 251.99 → average 221.3233 against 250:
//   11.5% under, and more than £20 → shown. Living: Jul 0; Aug 0.25; Sep 63.30 → 21.18 against 300 → shown.
const RC = TX.recalibrate(d, ['2026-09', '2026-08', '2026-07'], ctx);
const rc = k => RC.rows.find(r => r.category === k);
near(rc('Bills').actual, (159.99 + 251.99 + 251.99) / 3, 'Bills 3-month average'); near(rc('Bills').plan, 250, 'Bills plan');
near(rc('Living').actual, (0 + 0.25 + 63.30) / 3, 'Living 3-month average');
assert.ok(!rc('Pets'), 'no plan, nothing to recalibrate'); assert.ok(!rc('Home'), 'Home on plan: 1,200 each month');
assert.strictEqual(RC.over, false, 'overall under plan');
console.log('  ✓ recalibration from the last three months');
console.log('All transaction checks pass ✓');
