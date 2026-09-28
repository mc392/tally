// Run with:  node tests/calendar.test.js
// Short-to-mid-term precision (1.7): a month set by hand in the cash-flow calendar, and plan vs actual
// drift on each balance update. Expected figures worked out by hand. Synthetic data only.
const assert = require('assert');
const TM = require('../model.js');
const E = require('../engine.js');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, expected ${b}`);
const household = () => TM.migrate({
  version: 5, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', type: 'current' }, { id: 'ss', type: 'ss_isa' }], snapshots: [{ date: '2026-06-01', balances: { cur: 10000, ss: 5000 } }],
  flows: [{ id: 'pay', kind: 'income', amount: 3000 }, { id: 'food', kind: 'spend', amount: 2000, inflates: true }], bufferPct: 0, bundles: [],
  mortgage: { parts: [{ id: 'main', payment: 0 }] },
  rules: { cashFloor: 0, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M'], isaUsedTaxYear: 2026, sweepToSS: 0 }, // no floor and no allowance: nothing moves in or out of ISAs
  scenarios: { s: { name: 'S', growth: false, inflation: 10, payRise: 0 } },
});

// ---- a month set by hand ----
let d = household();
const at = (rows, date) => rows.find(r => r.date === date);
let r = E.project(d, 's', 18).rows;
near(at(r, '2027-05-01').spend, 2200, 'May 2027: 2,000 plus 10% inflation from April');
d.flows[1].overrides = { '2027-05': 2600 };
r = E.project(d, 's', 18).rows;
near(at(r, '2027-05-01').spend, 2600, 'the month set by hand is used as it is - no inflation on top');
near(at(r, '2027-04-01').spend, 2200, 'the month before is untouched'); near(at(r, '2027-06-01').spend, 2200, 'and the month after');
near(E.monthlyBudget(d, '2027-05').spend, 2600, 'the budget for that month uses it too');
d.flows[0].overrides = { '2026-12': 4500 }; r = E.project(d, 's', 18).rows;
near(at(r, '2026-12-01').income, 4500, 'an income month set by hand (e.g. a bonus in the pay)');
// in a life event, scale applies to a hand-set month as well
d.bundles.push({ id: 'b', name: 'E', start: '2027-01', on: true, scale: 0.5, contingency: 0 });
d.flows.push({ id: 'x', kind: 'spend', amount: 400, start: '2027-01', end: '2027-03', bundle: 'b', overrides: { '2027-02': 1000 } });
d = TM.migrate(d); r = E.project(d, 's', 18).rows;
near(at(r, '2027-02-01').bundleNet.b, -500, 'half of the 1,000 set by hand');
near(at(r, '2027-01-01').bundleNet.b, -200, 'half of the usual 400');
console.log('  ✓ months set by hand replace that month only, as actual figures');

// ---- plan vs actual ----
d = household();
// from 1 Jun 2026: 1,000 a month surplus. By the end of Aug 2026: cash 10,000 + 3 × 1,000 = 13,000; S&S unchanged.
d.snapshots.push({ date: '2026-09-01', balances: { cur: 13000, ss: 5000 } });
let x = E.drift(d, 's', '2026-09-01');
near(x.expected.cash, 13000, 'expected cash'); near(x.diff.net, 0, 'on plan exactly');
d.snapshots[1].balances = { cur: 12200, ss: 4700 };
x = E.drift(d, 's', '2026-09-01');
near(x.diff.cash, -800, 'cash 800 behind'); near(x.diff.isa, -300, 'ISAs 300 behind'); near(x.diff.net, -1100, 'net 1,100 behind');
assert.strictEqual(x.months, 3); assert.strictEqual(E.drift(d, 's', '2026-06-01'), null, 'the first update has nothing to compare with');
console.log('  ✓ plan vs actual on each balance update');
console.log('All calendar checks pass ✓');
