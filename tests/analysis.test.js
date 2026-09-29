// Run with:  node tests/analysis.test.js
// Phases 3 and 4: today's money, the ISA tax-year view, goals, where a change in net worth came from,
// stress tests and the range of outcomes. Expected figures worked out by hand. Synthetic data only.
const assert = require('assert');
const TM = require('../model.js');
const E = require('../engine.js');
const A = require('../analysis.js');
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);

// Surplus 1,000 a month. Floor 15,000. £20k each; Me has paid in £5,000 this tax year; Me fills first.
const household = (o = {}) => TM.migrate({
  version: 7, people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', name: 'Current', type: 'current' }, { id: 'cisa', name: 'Cash ISA', type: 'cash_isa', rate: 3 }, { id: 'ss', name: 'S&S ISA', type: 'ss_isa' },
    { id: 'pen', name: 'Pension', type: 'pension', rate: 0 }, { id: 'zero', name: '0% card', type: 'card_0' }],
  snapshots: [{ date: '2026-06-01', balances: { cur: 20000, cisa: o.cisa ?? 10000, ss: 30000, pen: 40000, zero: -2000 } }],
  flows: [{ id: 'pay', name: 'Pay', kind: 'income', amount: 4000, owner: 'M' }, { id: 'live', name: 'Living', kind: 'spend', amount: 3000 }, ...(o.flows || [])],
  bufferPct: 0, bundles: [], mortgage: { parts: [{ id: 'main', payment: 0, fixEnd: '2027-06-01', ...(o.part || {}) }] },
  rules: { cashFloor: 15000, isaPerPerson: 20000, isaUsedBy: { M: 5000, C: 0 }, isaFillOrder: ['M', 'C'], isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { flat: { name: 'Flat', growth: false, inflation: 10 }, grow: { name: 'Grow', growth: true, ssReturn: 6, inflation: 0 } },
});

// ---- 3.4 today's money ----
near(A.realValue(110, 11, 0, 10), 100, '£110 a year out at 10% inflation is £100 today');
near(A.realValue(100, 0, 0, 0), 100, 'no inflation, no change');
console.log('  ✓ today’s money');

// ---- 3.3 the ISA tax year (2026/27, seen in February 2027) ----
// Jun 2026: 21,000 − 15,000 floor = 6,000 in; Jul 2026 – Mar 2027: 9 × 1,000. 15,000 in total, all to Me (who had 15,000 left).
const Y = A.isaYear(household(), 'flat', '2027-02');
assert.strictEqual(Y.taxYear, 2026);
const me = Y.people.find(p => p.person === 'M'), partner = Y.people.find(p => p.person === 'C');
assert.deepStrictEqual([me.used, me.planned, me.left], [5000, 15000, 0], 'Me: 5,000 paid in, 15,000 planned, nothing left');
assert.deepStrictEqual([partner.used, partner.planned, partner.left], [0, 0, 20000], 'Partner: all 20,000 unused');
assert.strictEqual(Y.nudge, true, 'February, with allowance going unused: nudge');
assert.strictEqual(A.isaYear(household(), 'flat', '2026-11').nudge, false, 'not in November');
console.log('  ✓ ISA allowance per person this tax year, with the February nudge');

// ---- ISA allowance tax year by tax year (Oct 2026) ----
// 2026/27: Me paid in 5,000 before; the projection tops up 6,000 in June then 1,000 a month to March = 15,000 more,
// filling Me's 20,000. Partner's 20,000 goes unused. 2027/28: 12 × 1,000 = 12,000, all to Me: 8,000 + 20,000 unused.
const TL = A.isaTimeline(household(), 'flat', 2);
assert.deepStrictEqual(TL.years.map(y => y.label), ['2026/27', '2027/28']);
const [y1, y2] = TL.years;
assert.deepStrictEqual([y1.allowance, y1.before, y1.planned, y1.unused, y1.used], [40000, 5000, 15000, 20000, 20000], 'this year');
assert.deepStrictEqual(y1.people.map(p => [p.person, p.before, p.planned, p.unused]), [['M', 5000, 15000, 0], ['C', 0, 0, 20000]], 'per person');
assert.strictEqual(y1.partial, true, 'the projection starts in June, part way through the year');
near(y1.months[0].cumulative, 11000, 'June: 5,000 before + 6,000'); near(y1.months.at(-1).cumulative, 20000, 'March: 20,000');
near(y1.extraPerMonth, 20000 / 10, 'using the rest: 20,000 over the 10 months left');
assert.strictEqual(y1.filledBy, null, 'the household allowance is not filled');
assert.deepStrictEqual([y2.before, y2.planned, y2.unused], [0, 12000, 28000], 'next year');
near(TL.lost, 48000, 'unused over both years');
// with a bigger surplus (4,000 a month), next year fills
const richer = household({ flows: [{ id: 'bonus', name: 'Extra', kind: 'income', amount: 3000, owner: 'M' }] }); // surplus 4,000 a month
const T2 = A.isaTimeline(richer, 'flat', 2).years[1];
// 2026/27 has only 35,000 of room (Me 15,000 + Partner 20,000) against 9,000 + 9 × 4,000 = 45,000 above the floor, so
// 10,000 is still sitting in cash in April: 10,000 + 4,000 go in then, 4,000 a month after - 42,000 by November
assert.strictEqual(T2.filledBy, '2027-11-01', 'full by November 2027');
near(T2.months[0].newAllowance, 14000, 'April: the cash held back plus that month');
assert.strictEqual(T2.unused, 0);
console.log('  ✓ ISA allowance tax year by tax year: paid in, planned, unused, month by month, what it would take');

// ---- 3.2 a goal: £60,000 in the two ISAs by May 2027 ----
// Cash ISA by May 2027: 10,000 + 6,000 + 11 × 1,000 = 27,000 (the allowance resets in April); S&S stays 30,000 (no growth).
const goal = { id: 'g', name: 'Overpayment pot', target: 60000, date: '2027-05', accounts: ['cisa', 'ss'] };
let G = A.goalStatus(household(), 'flat', goal, '2026-06');
near(G.now, 40000, 'today'); near(G.atDate, 57000, 'projected at May 2027');
assert.strictEqual(G.onTrack, false); near(G.shortfall, 3000, 'short by');
near(G.extraPerMonth, 3000 / 11, 'extra a month: 3,000 over the 11 months left');
assert.strictEqual(G.reached, '2027-08-01', '27,000 + 3 × 1,000 = 30,000 in the cash ISA by Aug 2027');
G = A.goalStatus(household(), 'flat', { ...goal, target: 50000 }, '2026-06');
assert.strictEqual(G.onTrack, true); assert.strictEqual(G.extraPerMonth, 0);
console.log('  ✓ goals: projected value, on track, when it is reached, extra needed');

// ---- 3.1 where a year's change came from ----
const d = household();
d.snapshots.push({ date: '2027-06-01', balances: { cur: 15000, cisa: 27500, ss: 33000, pen: 42000, zero: -1000 }, contrib: { ss: 1000, pen: 500 } });
const X = A.attribution(d, '2026-06-01', '2027-06-01'), yrs = 365 / 365.25;
near(X.change, 116500 - 98000, 'net worth went up 18,500');
near(X.growth, (3000 - 1000) + (2000 - 500), 'growth: S&S 2,000 and pension 1,500 after what was paid in');
// interest estimate: average balance × the growth at the account's rate over the period - 365 days at 3% is exactly 3%
const i = (10000 + 27500) / 2 * 0.03; near(X.interest, i, 'cash ISA interest: average balance × 3% for the year');
near(X.debt, 1000, 'the 0% card went down by 1,000');
near(X.saved + X.growth + X.interest + X.debt, X.change, 'the four piles add up to the change exactly');
const ss = X.accounts.find(a => a.id === 'ss');
near(ss.return, 2000 / (30000 + 500), 'S&S money-weighted return (Modified Dietz)');
near(ss.annual, Math.pow(1 + 2000 / 30500, 1 / yrs) - 1, 'annualised');
console.log('  ✓ where the change came from: saved, growth, interest, debt repaid - adding up exactly');

// ---- 4.2 stress tests ----
const rich = () => household({ cisa: 30000, part: { balance: 100000, rate: 2, payment: 500, newRate: 5, termEnd: '2047-06-01' },
  flows: [{ id: 'mtg', name: 'Mortgage', kind: 'spend', linked: 'mortgage' }, { id: 'bon', name: 'Bonus', kind: 'oneoff', amount: 5000, start: '2027-03', end: '2027-03' }] });
// (surplus is now 500 a month: 4,000 − 3,000 − the 500 mortgage payment)
let S = A.stressed(rich(), 'flat', 'cost', 60, '2026-06');
near(S.base.available - S.after.available, 10000, 'a £10k cost before the fix end: 10,000 less available');
assert.strictEqual(S.after.breaches, 0, 'the cash ISA covers it - no breach of the floor');
S = A.stressed(rich(), 'flat', 'income', 60, '2026-06');
assert.strictEqual(S.detail, 'Pay');
near(S.base.available - S.after.available, 6 * 4000, 'pay stops for 6 months: 24,000 less available');
S = A.stressed(rich(), 'flat', 'markets', 60, '2026-06');
near(S.base.net - S.after.net, 30000 * 0.25, 'markets −25%: S&S loses 7,500'); near(S.after.available, S.base.available, 'nothing accessible changes');
near(S.base.invested - S.after.invested, 7500, 'S&S 7,500 lower at the fix end');
S = A.stressed(rich(), 'flat', 'bonus', 60, '2026-06');
near(S.base.available - S.after.available, 5000, 'no bonus: 5,000 less');
S = A.stressed(rich(), 'flat', 'rates', 60, '2026-06');
near(S.after.available, S.base.available, 'rates rise after the switch: nothing changes before it');
assert.ok(S.after.net < S.base.net - 1000, 'but the higher payment costs thousands over five years');
console.log('  ✓ stress tests: each one’s effect on the floor, readiness and net worth');

// ---- 4.1 a range of outcomes ----
let MC1 = A.monteCarlo(household(), 'grow', { paths: 200, vol: 15, months: 36, seed: 7 }), MC2 = A.monteCarlo(household(), 'grow', { paths: 200, vol: 15, months: 36, seed: 7 });
assert.deepStrictEqual(MC1.end, MC2.end, 'same seed, same answer');
const flatVol = A.monteCarlo(household(), 'grow', { paths: 20, vol: 0, months: 36, seed: 3 });
const det = E.project(household(), 'grow', 36).rows.at(-1).net;
near(flatVol.end.p10, det, 'no volatility: every path is the ordinary projection', 1e-6); near(flatVol.end.p90, det, 'p90 too', 1e-6);
const big = A.monteCarlo(household(), 'grow', { paths: 1000, vol: 15, months: 36, seed: 11, target: 20000, today: '2026-06' });
assert.ok(big.end.p10 < big.end.p50 && big.end.p50 < big.end.p90, 'a spread of outcomes');
assert.ok(Math.abs(big.end.p50 - det) / det < 0.01, 'the middle outcome is close to the ordinary projection');
// S&S of 30,000 with 15% a year of volatility over 3 years: the 10th-90th spread is roughly 2 × 1.28 × 15% × √3 × 30,000 ≈ 20,000
assert.ok(big.end.p90 - big.end.p10 > 15000 && big.end.p90 - big.end.p10 < 25000, `spread ${Math.round(big.end.p90 - big.end.p10)}`);
assert.ok(big.pBreach >= 0 && big.pBreach <= 1 && big.pBelowTarget !== null, 'probabilities reported');
assert.strictEqual(big.band.length, 36);
console.log('  ✓ range of outcomes: seeded, collapses to the projection with no volatility, sensible spread');
console.log('All analysis checks pass ✓');
