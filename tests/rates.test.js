// Run with:  node tests/rates.test.js
// Interest rates that change over time (Sep 2026). A change applies from its date and never touches the
// periods before it: balances worked out between dates, the projection, the checks. Worked out by hand. Synthetic data.
const assert = require('assert');
const TM = require('../model.js');
const E = require('../engine.js');
const A = require('../analysis.js');
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;

// an old file: an account with a single rate becomes a history with one entry
const m = TM.migrate({ version: 9, accounts: [{ id: 's', type: 'savings', rate: 4 }, { id: 'c', type: 'card_0' }], snapshots: [] });
assert.deepStrictEqual(m.accounts[0].rates, [{ from: null, rate: 4 }], 'the old single rate becomes the rate before any change');
assert.ok(!('rates' in m.accounts[1]), 'debts have no rate history');

const sav = { id: 's', type: 'savings', rate: 2, rates: [{ from: null, rate: 4 }, { from: '2026-07-01', rate: 2 }] };
assert.strictEqual(TM.rateOn(sav, '2026-06-30'), 4); assert.strictEqual(TM.rateOn(sav, '2026-07-01'), 2); assert.strictEqual(TM.rateOn(sav, '2020-01-01'), 4);
assert.strictEqual(TM.rateOn(sav, '2026-07'), 2, 'a month means its first day');
// £1 from 1 Jan to 1 Jan: 181 days at 4%, then 184 days at 2%
near(TM.growthFactor(sav, '2026-01-01', '2027-01-01'), Math.pow(1.04, 181 / 365) * Math.pow(1.02, 184 / 365), 'growth across the change');
console.log('  ✓ the rate in force on any date, and growth across a change');

const household = (rates, o = {}) => TM.migrate({
  version: 9, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'sav', name: 'Saver', type: 'savings', rate: rates.at(-1).rate, rates }, ...(o.accounts || [])],
  snapshots: [{ date: '2026-01-01', balances: { sav: 10000, ...(o.balances || {}) } }], flows: [], bufferPct: 0, bundles: [], mortgage: { parts: [{ id: 'main', payment: 0 }] },
  rules: { cashFloor: 0, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M'], isaUsedTaxYear: 2025, sweepToSS: 0 }, scenarios: { s: { name: 'S', growth: true, ssReturn: 0 } },
});

// ---- balances worked out between dates ----
let d = household([{ from: null, rate: 4 }]);
const before = E.balanceOn(d, 'sav', '2026-06-30').v;
d.accounts[0].rates.push({ from: '2026-07-01', rate: 2 });
near(E.balanceOn(d, 'sav', '2026-06-30').v, before, 'adding a change from July leaves June exactly as it was');
near(E.balanceOn(d, 'sav', '2027-01-01').v, 10000 * Math.pow(1.04, 181 / 365) * Math.pow(1.02, 184 / 365), 'after it, the new rate');
d.accounts[0].rates.find(r => r.from === '2026-07-01').rate = 3;
near(E.balanceOn(d, 'sav', '2026-06-30').v, before, 'correcting the July rate still leaves June alone');
console.log('  ✓ a change from a date never alters the balances before it');

// ---- the projection: each month at the rate then in force (monthly: rate / 12) ----
d = household([{ from: null, rate: 6 }, { from: '2026-04-01', rate: 1.2 }]);
const R = E.project(d, 's', 6).rows; // Jan .. Jun 2026
const bal = i => R[i].accounts.sav;
near(bal(0), 10000 * 1.005, 'January at 6% a year (0.5% a month)');
near(bal(2), 10000 * Math.pow(1.005, 3), 'March still 6%');
near(bal(3), 10000 * Math.pow(1.005, 3) * 1.001, 'April at 1.2% a year (0.1% a month)');
// a future change entered now is picked up when it comes
console.log('  ✓ the projection uses each month’s rate, including changes still to come');

// ---- cash ISAs pooled: the pool grows at their balance-weighted rate each month ----
d = household([{ from: null, rate: 0 }], { accounts: [{ id: 'c1', type: 'cash_isa', rate: 3, rates: [{ from: null, rate: 3 }] }, { id: 'c2', type: 'cash_isa', rate: 1, rates: [{ from: null, rate: 5 }, { from: '2026-03-01', rate: 1 }] }], balances: { c1: 10000, c2: 30000 } });
const P = E.project(d, 's', 3).rows;
// Jan and Feb: (10,000 × 3% + 30,000 × 5%) / 40,000 = 4.5%; from March (10,000 × 3% + 30,000 × 1%) / 40,000 = 1.5%
near(P[1].isaCash, 40000 * Math.pow(1 + 0.045 / 12, 2), 'Jan-Feb at 4.5%');
near(P[2].isaCash, 40000 * Math.pow(1 + 0.045 / 12, 2) * (1 + 0.015 / 12), 'March at 1.5%');
console.log('  ✓ pooled cash ISAs follow each account’s dated rate');

// ---- the checks expect interest at the rates in force ----
d = household([{ from: null, rate: 4 }, { from: '2026-07-01', rate: 2 }]);
d.snapshots.push({ date: '2027-01-01', balances: { sav: Math.round(10000 * Math.pow(1.04, 181 / 365) * Math.pow(1.02, 184 / 365) * 100) / 100 } });
assert.ok(Math.abs(A.checks(d)[0].unexplained) < 0.01, 'a balance that grew exactly at the two rates is fully explained');
console.log('All rate checks pass ✓');
