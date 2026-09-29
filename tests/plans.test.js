// Run with:  node tests/plans.test.js
// Plans with their own paths (Sep 2026, data v12): what each plan does with a mortgage part at its fix end
// (as set, float, a new fix, a saved deal), and each plan's own version of a line (on, off, another amount,
// other months, a line only in this plan). The amortisation is written out here from the rule, not from engine.js.
// Synthetic data only.
const assert = require('assert');
const TM = require('../model.js');
const E = require('../engine.js');
const A = require('../analysis.js');
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);
const pmt = (L, ratePct, n) => { const r = ratePct / 1200; return r ? L * r / (1 - Math.pow(1 + r, -n)) : L / n; };

// £200,000 at 2% (paying £1,200) until the fix ends in June 2027, then 7% (the lender's rate) to June 2051
const household = () => TM.migrate({
  version: 11, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', type: 'current' }], snapshots: [{ date: '2026-06-01', balances: { cur: 60000 } }],
  flows: [{ id: 'pay', kind: 'income', amount: 5000 }, { id: 'mtg', kind: 'spend', amount: 0, linked: 'mortgage' },
    { id: 'gym', kind: 'spend', amount: 100, category: 'Living' }, { id: 'nursery', kind: 'spend', amount: 900, category: 'Childcare', on: false }],
  bufferPct: 0, bundles: [], remortgageOptions: [{ id: 'o5', partId: 'main', name: '5-year fix', type: 'fixed', rate: 4.2, fixMonths: 60, fee: 0, lump: 0, regular: 0, afterRate: 7 }],
  mortgage: { parts: [{ id: 'main', payment: 1200, balance: 200000, rate: 2, fixEnd: '2027-06-01', newRate: 7, termEnd: '2051-06-01' }] },
  rules: { cashFloor: 5000, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M'], isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { s: { name: 'S', growth: false, inflation: 0, rates: { kind: 'flat' } } },
});
const plan = (d, extra) => { d.scenarios.p = { ...JSON.parse(JSON.stringify(d.scenarios.s)), name: 'P', ...extra }; return E.project(d, 'p', 12 + 36).rows; };
const at = (rows, date) => rows.find(r => r.date === date);

// ---- the mortgage path ----
let d = household();
const base = E.project(d, 's', 12 + 36).rows, B = at(base, '2027-05-01').mortgageParts[0].bal; // owed at the switch
// as set: the rate after the fix, 7%, over the 288 months left
near(at(base, '2027-06-01').mortgageParts[0].pay, pmt(B, 7, 288), 'as set: onto 7% at the fix end');
// float: without a market rule it is the same thing - staying on the lender's rate
const fl = plan(household(), { mortgage: { main: { path: 'float' } } });
assert.deepStrictEqual(fl.map(r => r.mortgageParts[0]), base.map(r => r.mortgageParts[0]), 'float = the rate after the fix');
// a new 2-year fix at 4%, then back to 7%: worked out month by month
const fx = plan(household(), { mortgage: { main: { path: 'fix', rate: 4, years: 2 } } }).filter(r => r.date >= '2027-06-01');
let b = B, P = pmt(B, 4, 288);
for (let m = 0; m < 36; m++) {
  if (m === 24) P = pmt(b, 7, 288 - 24); // the fix ends: 7% over what is left of the term
  const rate = m < 24 ? 4 : 7, i = b * rate / 1200; b = b + i - Math.min(P, b + i);
  near(fx[m].mortgageParts[0].pay, P, `fix: payment in month ${m}`, 1e-6); near(fx[m].mortgageParts[0].bal, b, `fix: balance after month ${m}`, 1e-6);
}
assert.strictEqual(fx[0].mortgageParts[0].rate, 4); assert.strictEqual(fx[24].mortgageParts[0].rate, 7);
// a saved deal: the same as trying that option on its own (how Compare deals has always worked it out)
const dl = plan(household(), { mortgage: { main: { path: 'deal', option: 'o5' } } });
assert.deepStrictEqual(dl, E.projectAs(household(), 's', { option: 'o5' }, 12 + 36).rows, 'a deal in the plan = that option');
// Compare deals sets the plan's own choice aside for the part it compares
d = household(); d.scenarios.s.mortgage = { main: { path: 'fix', rate: 4, years: 2 } };
const C = E.compareOptions(d, 's', 36, '2026-06');
near(C.results[0].payment, pmt(B, 7, 288), 'Do nothing is still the rate after the fix');
console.log('  ✓ mortgage paths: as set, float, a new fix (by hand), a saved deal; Compare deals unaffected');

// ---- lines ----
d = household(); const s0 = at(E.project(d, 's', 3).rows, '2026-07-01').spend;
near(s0, 1200 + 100, 'as set: the mortgage and the gym; the nursery is switched off');
near(at(plan(household(), { lines: { gym: { on: false } } }), '2026-07-01').spend, 1200, 'this plan without the gym');
near(at(plan(household(), { lines: { gym: { amount: 40 } } }), '2026-07-01').spend, 1240, 'the gym at £40 in this plan');
const later = plan(household(), { lines: { gym: { start: '2026-09' } } });
near(at(later, '2026-08-01').spend, 1200, 'starting in September in this plan: not in August'); near(at(later, '2026-09-01').spend, 1300, 'but in September');
near(at(plan(household(), { lines: { nursery: { on: true } } }), '2026-07-01').spend, 2200, 'a line only in this plan');
near(at(E.project(household(), 's', 3).rows, '2026-07-01').spend, 1300, 'and no other plan has it');
console.log('  ✓ lines: off, another amount, other months, only in one plan');

// ---- upgrading a v11 file: the single choice becomes the part's path, with identical figures ----
d = household(); // migrate() above has already run v11 → v12 on this one with no option; do it with one
const v11 = { ...household(), version: 11 }; v11.scenarios.s.option = 'o5'; delete v11.scenarios.s.mortgage;
const before = E.projectAs(household(), 's', { option: 'o5' }, 48).rows;
const up = TM.migrate(v11);
assert.deepStrictEqual(up.scenarios.s.mortgage, { main: { path: 'deal', option: 'o5' } }); assert.strictEqual(up.scenarios.s.option, null);
assert.deepStrictEqual(E.project(up, 's', 48).rows, before, 'projects exactly as before');

// ---- the comparison charts' figures ----
d = household();
d.scenarios.fix = { ...JSON.parse(JSON.stringify(d.scenarios.s)), name: 'Fix', mortgage: { main: { path: 'fix', rate: 4, years: 2 } } };
d.scenarios.baby = { ...JSON.parse(JSON.stringify(d.scenarios.s)), name: 'Baby', lines: { nursery: { on: true } } };
const X = A.comparePlans(d, ['s', 'fix', 'baby'], 36, 24);
assert.strictEqual(X.date, '2028-06-01', 'the 25th month from June 2026');
const run = k => E.project(d, k, 36 + 12).rows.slice(0, 36);
X.plans.forEach(P => {
  const rows = run(P.k);
  near(P.s.interest[35], rows.reduce((t, r) => t + r.mortgageInterest, 0), `${P.name}: interest is a running total`);
  assert.strictEqual(P.below, rows.filter(r => r.closing < 5000 - 0.5).length, `${P.name}: months below the floor`);
  const m = X.mix[X.plans.indexOf(P)], r = rows[24];
  near(m.cash + m.cashIsa + m.ss + m.other + m.mortgage, r.net - r.mortgageBal, `${P.name}: the parts add up to net worth less the mortgage`);
});
X.why.forEach((w, i) => near(w.total, X.plans[i + 1].s.clear[24] - X.plans[0].s.clear[24], 'the parts of a difference add up to it'));
assert.ok(X.plans[1].marks.some(m => m.kind === 'mortgage' && m.date === '2027-06-01'), 'the switch is marked');
const sc = Object.fromEntries(X.score.map(m => [m.key, m]));
assert.deepStrictEqual(sc.interest.best, [false, true, false], 'fixing at 4% pays the least interest');
near(X.plans[2].s.spend[1] - X.plans[0].s.spend[1], 900, 'the nursery costs £900 a month more');
console.log('  ✓ comparison figures: running interest, months below the floor, parts adding up, the switch marked, the scorecard');
console.log('All plan checks pass ✓');
