// Run with:  node tests/mortgage.test.js
// Checks a mortgage split into parts. Expected figures are worked out from the rule here,
// not copied from what the engine returned. Synthetic data only.
const assert = require('assert');
const { project, monthlyBudget, mortgageTotals, mortgageParts } = require('../engine.js');
const { migrate } = require('../model.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: got ${a}, expected ${b}`);
const practice = mortgage => migrate({
  accounts: [{ id: 'c', type: 'current' }], snapshots: [{ date: '2026-06-01', balances: { c: 50000 } }],
  income: [{ monthly: 6000 }], spending: [{ annual: 12000 }, { name: 'Mortgage', linked: 'mortgage' }], bufferPct: 0, events: [],
  rules: { cashFloor: 10000, isaAllowance: 0, isaUsed: 0, isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { s: { growth: false } }, mortgage,
});
const A = { id: 'a', name: 'Main', payment: 1000, balance: 120000, rate: 6 };
const B = { id: 'b', name: 'Further advance', payment: 300, balance: 20000, rate: 3, fixEnd: '2026-09-01', newRate: 5, termEnd: '2036-09-01' };

// A file from before parts existed reads as one part
const legacy = mortgageParts({ mortgage: { payment: 900, balance: 1000, rate: 2 } });
assert.strictEqual(legacy.length, 1); assert.strictEqual(legacy[0].payment, 900);

// Totals add up the parts; a part without a balance does not make the total zero
let t = mortgageTotals({ mortgage: { parts: [A, B, { id: 'c', payment: 50 }] } });
assert.strictEqual(t.payment, 1350, 'payments add up');
assert.strictEqual(t.balance, 140000, 'balances add up'); assert.strictEqual(t.allBalances, false);
assert.strictEqual(mortgageTotals({ mortgage: { parts: [{ id: 'x', payment: 5 }] } }).balance, null, 'no balance anywhere = not set');

// Month 1, worked by hand. A: interest 120000 × 6%/12 = 600, balance 120000 + 600 − 1000 = 119600.
// B: interest 20000 × 3%/12 = 50, balance 20000 + 50 − 300 = 19750.
const both = project(practice({ parts: [A, B] }), 's', 24).rows;
const r0 = both[0];
near(r0.mortgageParts[0].interest, 600, 'A interest'); near(r0.mortgageParts[0].bal, 119600, 'A balance');
near(r0.mortgageParts[1].interest, 50, 'B interest'); near(r0.mortgageParts[1].bal, 19750, 'B balance');
near(r0.mortgagePay, 1300, 'total payment'); near(r0.mortgageInterest, 650, 'total interest'); near(r0.mortgageBal, 139350, 'total balance');
near(r0.spend, 1000 + 1300, 'spending = other spending + both payments');

// The parts are independent: running both together equals each run on its own
const aOnly = project(practice({ parts: [A] }), 's', 24).rows, bOnly = project(practice({ parts: [B] }), 's', 24).rows;
both.forEach((r, i) => near(r.mortgageBal, aOnly[i].mortgageBal + bOnly[i].mortgageBal, `balances add up in month ${i}`));

// B's fix ends Sep 2026 (month index 3). Its payment is recalculated as a repayment mortgage over the
// months left to its end date, at the new rate; A's payment is untouched.
const k = d => { const [y, m] = d.split('-').map(Number); return y * 12 + m - 1; }; // month number
const balBefore = both[2].mortgageParts[1].bal, n = k('2036-09-01') - k('2026-09-01'), i5 = 0.05 / 12;
const expected = balBefore * i5 / (1 - Math.pow(1 + i5, -n));
near(both[3].mortgageParts[1].pay, expected, 'B payment after its fix');
near(both[3].mortgageParts[1].interest, balBefore * i5, 'B charged the new rate from its fix end');
near(both[3].mortgageParts[0].pay, 1000, 'A unchanged by B’s fix');

// A small part that is paid off stops costing anything. 0% so the months are easy: 1000 at 600 a month
// is 600, then 400, then nothing - and the spending falls with it.
const small = { id: 's', payment: 600, balance: 1000, rate: 0 };
const pay = project(practice({ parts: [A, small] }), 's', 4).rows;
near(pay[0].mortgageParts[1].pay, 600, 'first month'); near(pay[1].mortgageParts[1].pay, 400, 'final part-payment');
near(pay[2].mortgageParts[1].pay, 0, 'paid off'); near(pay[2].mortgageParts[1].bal, 0, 'nothing owed');
near(pay[1].spend - pay[2].spend, 400, 'spending drops once it is paid off');

// A part with no balance is a flat monthly cost
const flat = project(practice({ parts: [{ id: 'f', payment: 750 }] }), 's', 3).rows;
near(flat[2].mortgagePay, 750, 'flat payment'); assert.strictEqual(flat[2].mortgageBal, null, 'no balance to report');

// The Plan budget counts every part
near(monthlyBudget(practice({ parts: [A, B] })).spend, 1000 + 1300, 'budget includes both parts');
console.log('All mortgage checks pass ✓');
