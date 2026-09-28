// Run with:  node tests/migration.test.js
// Data file v2 (Phase 0). A v1 file must open, migrate, and project IDENTICAL numbers to the engine
// as it was before v2 (frozen in tests/fixtures/engine-v1.js). Then the new abilities: flows that
// start and stop, per-person ISA allowances filled one person first, account access. Synthetic data.
const assert = require('assert');
const OLD = require('./fixtures/engine-v1.js');
const { project, monthlyBudget } = require('../engine.js');
const TM = require('../model.js');

const near = (a, b, msg) => assert.ok(typeof b === 'number' && b !== null ? Math.abs(a - b) < 1e-6 : a === b, `${msg}: got ${a}, expected ${b}`);

// ---------- a v1 household that exercises everything v1 could do ----------
const v1 = () => ({
  app: 'tally', version: 1,
  people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }],
  accounts: [
    { id: 'cur', owner: 'J', type: 'current', rate: 0 }, { id: 'card', owner: 'M', type: 'card', rate: 0 },
    { id: 'cisa', owner: 'M', type: 'cash_isa', rate: 3.5 }, { id: 'ssisa', owner: 'C', type: 'ss_isa', rate: 0 },
    { id: 'sav', owner: 'C', type: 'savings', rate: 4 }, { id: 'zero', owner: 'M', type: 'card_0', rate: 0 },
  ],
  snapshots: [{ date: '2026-02-14', balances: { cur: 18000, card: -900, cisa: 22000, ssisa: 41000, sav: 7000, zero: -3000 } }],
  income: [{ id: 'i1', name: 'Pay A', owner: 'M', monthly: 3100, growth: 1 }, { id: 'i2', name: 'Pay B', owner: 'C', monthly: 2400, growth: 0 }],
  spending: [
    { id: 's1', name: 'Food', category: 'Living', annual: 9000, inflates: true },
    { id: 's2', name: 'Insurance', category: 'Bills', annual: 1234.56, inflates: false },
    { id: 's3', name: 'Mortgage', category: 'Home', linked: 'mortgage' },
  ],
  bufferPct: 7,
  events: [
    { id: 'e1', name: 'Holiday', amount: -4500, date: '2026-07-01', on: true },
    { id: 'e2', name: 'Clear 0% card', amount: -3000, date: '2026-09-01', on: true, settles: 'zero' },
    { id: 'e3', name: 'Bonus', amount: 6000, date: '2027-03-01', on: true },
    { id: 'e4', name: 'Maybe car', amount: -15000, date: '2026-11-01', on: false },
  ],
  mortgage: { parts: [{ id: 'main', payment: 1100, balance: 190000, rate: 4.2, fixEnd: '2027-05-01', newRate: 5, termEnd: '2049-01-01' }], propertyValue: 320000 },
  rules: { cashFloor: 12000, isaAllowance: 40000, isaUsed: 26000, isaUsedTaxYear: 2025, sweepToSS: 40 },
  scenarios: {
    cautious: { name: 'Cautious', growth: false, ssReturn: 0, inflation: 0, payRise: 0 },
    base: { name: 'Base', growth: true, ssReturn: 5, inflation: 3, payRise: 2 },
  },
  scenario: 'cautious', horizonMonths: 18,
});

// ---------- 1. identical projections ----------
let figures = 0;
for (const sc of ['cautious', 'base']) {
  for (const variant of [v1(), Object.assign(v1(), { rules: { cashFloor: 30000, isaAllowance: 20000, isaUsed: 0, isaUsedTaxYear: 2026, sweepToSS: 0 } })]) {
    const a = OLD.project(variant, sc, 120).rows, b = project(TM.migrate(variant), sc, 120).rows;
    assert.strictEqual(a.length, b.length);
    a.forEach((r, i) => {
      for (const k of Object.keys(r)) {
        if (k === 'events' || k === 'mortgageParts') continue;
        near(b[i][k], r[k], `${sc} month ${i} ${k}`); figures++;
      }
      assert.deepStrictEqual(b[i].events.map(e => e.amount), r.events.map(e => e.amount), `${sc} month ${i} one-offs`);
    });
    near(monthlyBudget(TM.migrate(variant)).surplus, OLD.monthlyBudget(variant).surplus, 'budget surplus');
  }
}
console.log(`  ✓ a v1 file projects identically after migrating (${figures} figures, 10 years, 2 scenarios)`);

// ---------- 2. the migration itself ----------
const orig = v1(), before = JSON.stringify(orig), m = TM.migrate(orig);
assert.strictEqual(JSON.stringify(orig), before, 'the original is never changed');
assert.strictEqual(m.version, 2);
assert.ok(!('income' in m) && !('spending' in m) && !('events' in m), 'old lists removed');
assert.strictEqual(m.flows.filter(f => f.kind === 'income').length, 2);
assert.strictEqual(m.flows.find(f => f.id === 's2').amount, 1234.56 / 12, 'yearly spending becomes monthly');
assert.strictEqual(m.flows.find(f => f.id === 's3').linked, 'mortgage');
const car = m.flows.find(f => f.id === 'e4');
assert.deepStrictEqual([car.kind, car.amount, car.start, car.end, car.on], ['oneoff', -15000, '2026-11', '2026-11', false]);
assert.strictEqual(m.flows.find(f => f.id === 'e2').settles, 'zero');
// ISA: 40k household for two people = 20k each; 26k already used goes against Me first, then Partner
assert.strictEqual(m.rules.isaPerPerson, 20000);
assert.deepStrictEqual(m.rules.isaUsedBy, { M: 20000, C: 6000 });
assert.deepStrictEqual(m.rules.isaFillOrder, ['M', 'C'], 'Joint never holds an ISA');
assert.ok(!('isaAllowance' in m.rules) && !('isaUsed' in m.rules));
// access defaults
const acc = id => m.accounts.find(a => a.id === id);
assert.strictEqual(acc('cur').access, 'instant'); assert.strictEqual(acc('ssisa').access, 'invested');
assert.strictEqual(acc('cisa').access, 'instant'); assert.strictEqual(acc('cisa').flexible, true);
assert.strictEqual(acc('card').access, undefined, 'liabilities have no access');
// opening a v2 file needs no migration: running it again changes nothing
assert.deepStrictEqual(TM.migrate(m), m, 'migrate is a no-op on v2');
console.log('  ✓ migration converts every v1 field and leaves the original untouched');

// ---------- 3. flows that start and stop ----------
const base = () => TM.migrate({
  people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', type: 'current' }], snapshots: [{ date: '2026-05-01', balances: { cur: 100000 } }],
  income: [], spending: [], events: [], bufferPct: 0, mortgage: { payment: 0 },
  rules: { cashFloor: 0, isaAllowance: 0, isaUsed: 0, isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { s: { growth: false } }, version: 1,
});
let d = base();
d.flows.push({ id: 'n', name: 'Nursery', kind: 'spend', amount: 1000, start: '2026-08', end: '2026-10', on: true });
d.flows.push({ id: 'p', name: 'Pay', kind: 'income', amount: 3000, start: null, end: '2026-06', on: true });
let r = project(d, 's', 8).rows; // May .. Dec 2026
assert.deepStrictEqual(r.map(x => x.spend), [0, 0, 0, 1000, 1000, 1000, 0, 0], 'spend runs Aug to Oct inclusive');
assert.deepStrictEqual(r.map(x => x.income), [3000, 3000, 0, 0, 0, 0, 0, 0], 'income stops after Jun');
near(r.at(-1).closing, 100000 + 2 * 3000 - 3 * 1000, 'cash reflects exactly those months');
assert.strictEqual(monthlyBudget(d, '2026-09').spend, 1000); assert.strictEqual(monthlyBudget(d, '2026-11').spend, 0);
d.flows[0].on = false; r = project(d, 's', 8).rows;
assert.ok(r.every(x => x.spend === 0), 'a flow switched off never counts');
console.log('  ✓ flows start and stop on their months');

// ---------- 4. per-person ISA, filled one person first ----------
d = base();
Object.assign(d.rules, { cashFloor: 10000, isaPerPerson: 20000, isaUsedBy: { M: 15000, C: 0 }, isaFillOrder: ['M', 'C'], isaUsedTaxYear: 2026 });
d.snapshots[0].balances.cur = 40000; // 30,000 above the floor in the first month
r = project(d, 's', 13).rows; // May 2026 .. May 2027
// room: Me 5,000 left + Partner 20,000 = 25,000. 30,000 above floor → 25,000 goes in, Me filled first.
near(r[0].topUp, 25000, 'top-up capped at both allowances');
assert.deepStrictEqual(r[0].freshBy, { M: 0, C: 0 }, 'Me used up first, then Partner');
d.snapshots[0].balances.cur = 14000; r = project(d, 's', 13).rows;
near(r[0].topUp, 4000, 'small top-up');
assert.deepStrictEqual(r[0].freshBy, { M: 1000, C: 20000 }, 'all of it went to Me, Partner untouched');
d.rules.isaFillOrder = ['C', 'M']; r = project(d, 's', 13).rows;
assert.deepStrictEqual(r[0].freshBy, { C: 16000, M: 5000 }, 'order reversed: Partner first');
// April resets everyone to their full allowance
const apr = r.find(x => x.date === '2027-04-01');
near(apr.freshStart, 40000, 'new tax year: 20,000 each');
console.log('  ✓ ISA allowance is per person and fills in the chosen order');

// ---------- 5. pensions grow at their own rate and count in net worth ----------
d = base(); d.accounts.push({ id: 'pen', type: 'pension', rate: 6 }); d = TM.migrate(d);
d.snapshots[0].balances.pen = 50000; d.scenarios.s.growth = true;
assert.strictEqual(d.accounts.find(a => a.id === 'pen').access, 'locked');
r = project(d, 's', 1).rows;
near(r[0].other, 50000 * 1.005, 'pension grows 6% a year, monthly');
console.log('  ✓ pensions: locked, growing, counted');
console.log('All migration checks pass ✓');
