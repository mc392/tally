// Run with:  node tests/readiness.test.js
// Remortgage readiness, lock-up and the glide path (Phase 1.1-1.3). Every expected figure is worked
// out by hand below from the rules in CLAUDE.md, not copied from the engine. Synthetic data only.
const assert = require('assert');
const TM = require('../model.js');
const { project, readiness } = require('../engine.js');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, expected ${b}`);

// Surplus 1,000 a month (4,000 in, 3,000 out, no buffer). Floor 15,000. Fix ends June 2027.
const household = (o = {}) => {
  const d = TM.migrate({
    version: 3, people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }],
    accounts: [
      { id: 'cur', type: 'current' }, { id: 'cisa', type: 'cash_isa', rate: 0 },
      { id: 'notice', type: 'savings', rate: 0, access: 'notice', noticeDays: 95 },
      { id: 'bond', type: 'savings', rate: 0, access: 'fixed', maturity: o.bondMatures || '2028-01' },
      { id: 'ss', type: 'ss_isa' }, { id: 'pen', type: 'pension', rate: 0 }, { id: 'zero', type: 'card_0' },
    ],
    snapshots: [{ date: '2026-06-01', balances: { cur: 20000, cisa: 10000, notice: 5000, bond: 8000, ss: 30000, pen: 40000, zero: -2000 } }],
    flows: [
      { id: 'pay', name: 'Pay', kind: 'income', amount: 4000 }, { id: 'live', name: 'Living', kind: 'spend', amount: 3000 },
      { id: 'kit', name: 'Kitchen', kind: 'oneoff', amount: -6000, start: '2027-09', end: '2027-09' },   // inside the 12 months after the switch
      { id: 'hol', name: 'Holiday', kind: 'oneoff', amount: -2000, start: '2028-07', end: '2028-07' },   // outside them
      ...(o.flows || []),
    ],
    bufferPct: 0, bundles: [],
    mortgage: { parts: [{ id: 'main', payment: 0, fixEnd: '2027-06-01' }] },
    rules: { cashFloor: 15000, isaPerPerson: 20000, isaUsedBy: {}, isaFillOrder: ['M', 'C'], isaUsedTaxYear: 2026, sweepToSS: o.ss ?? 0, remortgage: o.rm || {} },
    scenarios: { flat: { name: 'Flat', growth: false }, other: { name: 'Other', growth: false } },
  });
  return d;
};

// ---- 1.1 the ladder at the fix end ----
// Jun 2026: 20,000 + 1,000 = 21,000 → 6,000 into the cash ISA, cash at the 15,000 floor.
// Jul 2026 - May 2027: 1,000 a month into the cash ISA. By the end of May 2027 the cash ISA is 10,000 + 6,000 + 11 × 1,000 = 27,000.
let d = household(), R = readiness(d, 'flat', '2026-06');
assert.strictEqual(R.fixEnd, '2027-06-01'); assert.strictEqual(R.atDate, '2027-05-01'); assert.strictEqual(R.monthsAway, 12);
assert.deepStrictEqual(R.dates, { secure: '2026-12-01', decide: '2027-04-01', switch: '2027-06-01' }, 'deal 6 months before, decide 2 months before');
near(R.ladder.instant, 15000 + 27000, 'instant: current account + cash ISA');
near(R.ladder.notice, 5000, 'within weeks: the notice account');
near(R.ladder.invested, 30000, 'invested: S&S ISA');
near(R.ladder.fixed, 8000, 'the bond matures after the fix end, so it is not available');
near(R.ladder.locked, 40000, 'pension'); near(R.ladder.debts, -2000, '0% card');
near(R.accessible, 47000, 'accessible = instant + within weeks');
near(R.earmarks, 6000, 'only the kitchen falls in the 12 months from the switch');
near(R.available, 47000 - 15000 - 6000, 'available to overpay');
near(R.investedStressed, 24000, 'markets −20%');
assert.ok('flat' in R.invested && 'other' in R.invested, 'invested shown under every scenario');
assert.deepStrictEqual(R.earmarkItems.map(x => x.label), ['Kitchen']);

// The ladder reconciles to the projection's month-end balances, every month
for (const r of project(d, 'flat', 36).rows) near(Object.values(r.byAccess).reduce((s, v) => s + v, 0), r.net, `ladder = net worth in ${r.date}`);
// A fixed bond maturing BEFORE the fix end counts as instant from its maturity
near(readiness(household({ bondMatures: '2027-01' }), 'flat', '2026-06').ladder.instant, 42000 + 8000, 'matured bond is instant');
console.log('  ✓ ladder at the fix end, and it reconciles to net worth every month');

// ---- 1.1 done-when: moving a big spend across the fix end ----
const big = when => household({ flows: [{ id: 'car', name: 'Car', kind: 'oneoff', amount: -10000, start: when, end: when }] });
const early = readiness(big('2027-03'), 'flat', '2026-06'), afterFix = readiness(big('2027-08'), 'flat', '2026-06'), wayLater = readiness(big('2028-08'), 'flat', '2026-06');
near(afterFix.accessible - early.accessible, 10000, 'paid after the fix end: 10,000 more accessible at it');
near(afterFix.earmarks - early.earmarks, 10000, '... but now earmarked');
near(afterFix.available - early.available, 10000 - 10000, 'available changes by the amount less its effect on earmarks');
near(wayLater.available - early.available, 10000, 'moved beyond the earmark window: 10,000 more free');
console.log('  ✓ moving a spend across the fix end changes "available" by exactly the amount, less earmarks');

// ---- 1.2 lock-up: a 2-year bond with money needed at a fix end 12 months away ----
// Moving 12,000 from the current account into a new fixed bond maturing after the fix end: cash drops
// below the floor, so the shortfall comes back out of the cash ISA - either way 12,000 leaves "accessible".
d = household(); const before = readiness(d, 'flat', '2026-06').available;
d.accounts.push({ id: 'bond2', type: 'savings', rate: 0, access: 'fixed', maturity: '2028-06' });
d.snapshots[0].balances.cur -= 12000; d.snapshots[0].balances.bond2 = 12000;
near(before - readiness(d, 'flat', '2026-06').available, 12000, 'the bond takes 12,000 out of what is available');
console.log('  ✓ locking money up past the fix end reduces "available" by exactly that amount');

// ---- 1.3 glide path ----
// All top-ups to S&S (sweepToSS 100). Without a glide path the cash ISA stays at 10,000: accessible 15,000 + 10,000 + 5,000.
near(readiness(household({ ss: 100 }), 'flat', '2026-06').accessible, 30000, 'no glide: top-ups go to S&S');
near(readiness(household({ ss: 100, rm: { glide: true, glideMonths: 12 } }), 'flat', '2026-06').accessible, 47000, '12-month glide: every top-up held as cash ISA');
near(readiness(household({ ss: 100, rm: { glide: true, glideMonths: 3 } }), 'flat', '2026-06').accessible, 33000, '3-month glide: Mar-May top-ups (3 × 1,000) held as cash ISA');
// Target £20,000: S&S only gets what is left once available would still reach 20,000. Worked month by month:
// accessible before sweeping grows 1,000 a month from 36,000; available needs accessible ≥ 41,000; from then S&S takes the excess.
let t = readiness(household({ ss: 100, rm: { target: 20000 } }), 'flat', '2026-06');
near(t.available, 20000, 'target met exactly - no more held back than needed'); assert.strictEqual(t.met, true);
// Target £30,000 with no S&S sweeping: available is 26,000 at the fix end, 4,000 short.
// After the switch: +1,000 a month and the kitchen takes 6,000 in Sep 2027, so accessible is 48,000 in Dec 2027 (short of
// the 51,000 needed); in Jan 2028 the 8,000 bond matures and joins it: 49,000 + 8,000 = 57,000, so it clears in Jan 2028.
t = readiness(household({ rm: { target: 30000 } }), 'flat', '2026-06');
assert.strictEqual(t.met, false); near(t.shortfall, 4000, 'shortfall'); assert.strictEqual(t.clears, '2028-01-01', 'the month it clears');
console.log('  ✓ glide path and overpayment target');

// ---- earliest part's fix end wins ----
d = household(); d.mortgage.parts.push({ id: 'p2', name: 'Part 2', payment: 0, fixEnd: '2027-02-01' });
R = readiness(d, 'flat', '2026-06');
assert.strictEqual(R.fixEnd, '2027-02-01'); assert.strictEqual(R.part.id, 'p2'); assert.strictEqual(R.laterParts[0].fixEnd, '2027-06-01');
assert.strictEqual(readiness(household(), 'flat', '2027-07').none, 'fixEnd', 'no fix end still to come');
console.log('  ✓ works towards the earliest part’s fix end');
console.log('All readiness checks pass ✓');
