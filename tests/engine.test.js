// Run with:  node tests/engine.test.js
// Checks the projection engine against the spreadsheet's rules, on a small made-up household.
// Every expected figure below was worked out by hand from the rules in CLAUDE.md, month by month,
// not copied from what the engine returned. No real data lives in this repository.
const assert = require('assert');
const { project, monthlyBudget } = require('../engine.js');

const fixture = {
  accounts: [
    { id: 'cur', owner: 'M', type: 'current', rate: 0 },
    { id: 'cisa', owner: 'M', type: 'cash_isa', rate: 3 },
    { id: 'ssisa', owner: 'M', type: 'ss_isa', rate: 5 },
  ],
  snapshots: [{ date: '2026-05-10', balances: { cur: 20000, cisa: 30000, ssisa: 50000 } }],
  income: [{ monthly: 4000 }],
  spending: [{ annual: 24000, inflates: false }],
  bufferPct: 5,
  events: [{ amount: -8000, date: '2026-10-01', on: true }, { amount: -99999, date: '2026-12-01', on: false }],
  mortgage: { payment: 0 },
  rules: { cashFloor: 15000, isaAllowance: 20000, isaUsed: 5000, isaUsedTaxYear: 2026, sweepToSS: 50 },
  scenario: 'flat',
  scenarios: { flat: { growth: false, ssReturn: 0, inflation: 0, payRise: 0 } },
};

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: got ${a.toFixed(2)}, expected ${b}`);

// Surplus: 4,000 pay − 2,000 spending − 5% buffer (100) = 1,900 a month.
near(monthlyBudget(fixture).surplus, 1900, 'monthly surplus');

const rows = project(fixture, 'flat', 12).rows; // May 2026 → Apr 2027
const at = d => rows.find(r => r.date === d);

// May: 20,000 + 1,900 = 21,900, above the 15,000 floor. Allowance left: 20,000 − 5,000 used = 15,000.
// So 6,900 moves into ISAs, half to each (sweepToSS 50%), leaving cash at the floor.
near(at('2026-05-01').topUp, 6900, 'May top-up');
near(at('2026-05-01').closing, 15000, 'May cash at floor');
near(at('2026-05-01').freshEnd, 8100, 'May allowance left');

// Jun–Sep: 1,900 a month goes in. After Sep: 15,000 − 6,900 − 4 × 1,900 = 500 allowance left.
near(at('2026-09-01').freshEnd, 500, 'Sep allowance left');

// Oct: an 8,000 payment. 15,000 + 1,900 − 8,000 = 8,900, which is 6,100 under the floor.
// It comes out of the cash ISA first, and becomes re-deposit room for the rest of the tax year.
near(at('2026-10-01').withdraw, 6100, 'Oct ISA withdrawal');
near(at('2026-10-01').replEnd, 6100, 'Oct re-deposit room');
near(at('2026-10-01').isaCash, 30000 + 6900 / 2 + 4 * 950 - 6100, 'Oct cash ISA');

// A payment that is switched off is ignored (the 99,999 in Dec).
near(at('2026-12-01').payments, 0, 'switched-off payment ignored');

// Nov–Jan refill the re-deposit room first: 6,100 − 3 × 1,900 = 400 left.
// Feb: room is 400 re-deposit + 500 allowance = 900, so only 900 goes in and cash rises above the floor.
near(at('2027-01-01').replEnd, 400, 'Jan re-deposit room');
near(at('2027-02-01').topUp, 900, 'Feb top-up capped by room left');
near(at('2027-02-01').closing, 16000, 'Feb cash');

// Mar: no room at all, so cash just grows: 16,000 + 1,900.
near(at('2027-03-01').topUp, 0, 'Mar no room'); near(at('2027-03-01').closing, 17900, 'Mar cash');

// Apr: a new tax year resets the allowance to 20,000. 17,900 + 1,900 = 19,800 → 4,800 goes in.
const apr = at('2027-04-01');
near(apr.topUp, 4800, 'Apr top-up after allowance reset'); near(apr.freshEnd, 15200, 'Apr allowance left');

// Totals: 25,900 went in over the year and 6,100 came out, split evenly between the two ISAs.
near(apr.isaCash, 30000 + 25900 / 2 - 6100, 'cash ISA after a year');
near(apr.isaSS, 50000 + 25900 / 2, 'S&S ISA after a year');
// Net worth: 100,000 + 12 × 1,900 surplus − 8,000 payment. Nothing is created or lost on the way.
near(apr.net, 100000 + 12 * 1900 - 8000, 'net worth after a year');

console.log('All projection checks follow the spreadsheet’s rules ✓');
