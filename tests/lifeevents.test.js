// Run with:  node tests/lifeevents.test.js
// Life events (Phase 1.5). The roadmap's "done when": shifting a bundle by 6 months shifts every line
// by 6 months; switching it off gives a projection identical to one without it; the baby template's
// income dip and childcare start land in the right months. Expected figures worked out by hand. Synthetic data.
const assert = require('assert');
const TM = require('../model.js');
const TT = require('../templates.js');
const { project } = require('../engine.js');

let n = 0; const uid = p => `${p}-${++n}`;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, expected ${b}`);
const household = () => TM.migrate({
  version: 2, people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', type: 'current' }], snapshots: [{ date: '2027-01-01', balances: { cur: 50000 } }],
  flows: [
    { id: 'pm', name: 'Pay', kind: 'income', amount: 3000, owner: 'M' }, { id: 'pc', name: 'Pay', kind: 'income', amount: 2500, owner: 'C' },
    { id: 'rent', name: 'Living', kind: 'spend', amount: 2000, inflates: true },
  ],
  bufferPct: 0, mortgage: { parts: [{ id: 'main', payment: 0 }] },
  rules: { cashFloor: 0, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M', 'C'], isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { flat: { growth: false, inflation: 0, payRise: 0 } },
});
const baby = (d, start) => {
  const t = TT.T.baby, ctx = TT.makeContext(d, start);
  const { bundle, flows } = TT.applyTemplate('baby', t.defaults(ctx), start, d, uid);
  d.bundles.push(bundle); d.flows.push(...flows); return bundle;
};
const rows = (d, m = 72) => project(d, 'flat', m).rows;
const at = (r, date) => r.find(x => x.date === date);
const strip = r => r.map(({ bundleNet, events, ...x }) => x);

// ---- the baby template, due March 2027 ----
let d = household(); const b = baby(d, '2027-03');
const lines = d.flows.filter(f => f.bundle === b.id);
assert.ok(lines.every(f => f.bundle === b.id && f.id), 'every line is tagged with the event');
const leaveM = lines.find(f => f.name === 'Parental leave – Me'), leaveC = lines.find(f => f.name === 'Parental leave – Partner');
// Me: 9 months at 800 instead of 3,000 → −2,200 a month, Mar 2027 to Nov 2027. Partner: 1 month at 1,500 instead of 2,500.
assert.deepStrictEqual([leaveM.amount, leaveM.start, leaveM.end], [-2200, '2027-03', '2027-11']);
assert.deepStrictEqual([leaveC.amount, leaveC.start, leaveC.end], [-1000, '2027-03', '2027-03']);
let r = rows(d);
near(at(r, '2027-02-01').income, 5500, 'before the birth: usual pay');
near(at(r, '2027-03-01').income, 5500 - 2200 - 1000 + 100, 'birth month: both on leave, Child Benefit starts');
near(at(r, '2027-11-01').income, 5500 - 2200 + 100, 'last month of leave');
near(at(r, '2027-12-01').income, 5500 + 100, 'back to usual pay');
// Childcare: 30 hours × £9 × 52 / 12 = £1,170 a month, from 12 months after birth (Mar 2028) to 60 (Feb 2032)
const care = lines.find(f => f.name === 'Childcare');
assert.deepStrictEqual([care.start, care.end], ['2028-03', '2032-02']); near(care.amount, 1170, 'childcare per month');
near(at(r, '2028-03-01').spend - at(r, '2028-02-01').spend, 1170 + (250 - 250), 'childcare starts Mar 2028');
// Kit two months before, nursery room three months before
assert.strictEqual(lines.find(f => f.name === 'Pram, cot and kit').start, '2027-01');
assert.strictEqual(lines.find(f => f.name === 'Nursery room').start, '2026-12');
console.log('  ✓ baby: leave, Child Benefit and childcare land in the right months');

// ---- the event's own net figure reconciles to the projection ----
const without = household(); const rw = rows(without); r = rows(d);
const total = r.reduce((s, x) => s + (x.bundleNet[b.id] || 0), 0);
near(r.at(-1).net - rw.at(-1).net, total, 'net worth difference = the sum of the event’s monthly figures');
console.log('  ✓ the event’s monthly figures add up to exactly what it does to net worth');

// ---- switched off = never there ----
b.on = false;
assert.deepStrictEqual(strip(rows(d)), strip(rw), 'off gives the identical projection');
b.on = true;
console.log('  ✓ switching the event off gives an identical projection to one without it');

// ---- shifting by 6 months ----
const before = d.flows.filter(f => f.bundle === b.id).map(f => ({ ...f }));
TM.shiftBundle(d, b.id, 6);
assert.strictEqual(b.start, '2027-09');
d.flows.filter(f => f.bundle === b.id).forEach((f, i) => {
  assert.strictEqual(f.start, TM.shiftMonth(before[i].start, 6), `${f.name} start`);
  assert.strictEqual(f.end, before[i].end ? TM.shiftMonth(before[i].end, 6) : null, `${f.name} end`);
});
// and that is the same as having created it six months later
const later = household(); baby(later, '2027-09');
assert.deepStrictEqual(strip(rows(d)), strip(rows(later)), 'shifted = created six months later');
assert.strictEqual(TM.shiftMonth('2026-11', 3), '2027-02'); assert.strictEqual(TM.shiftMonth('2027-02', -3), '2026-11');
console.log('  ✓ shifting moves every line by the same months');

// ---- scale and contingency ----
d = household(); const b2 = baby(d, '2027-03'); const base = rows(d);
b2.scale = 0.5; let s = rows(d);
base.forEach((x, i) => near(s[i].bundleNet[b2.id] || 0, (x.bundleNet[b2.id] || 0) * 0.5, `scaled month ${i}`));
b2.scale = 1; b2.contingency = 10; s = rows(d);
near(at(s, '2028-03-01').spend - at(base, '2028-03-01').spend, (1170 + 250) * 0.1, 'contingency adds 10% to the event’s costs');
near(at(s, '2027-03-01').income, at(base, '2027-03-01').income, 'contingency never touches income');
console.log('  ✓ scale and contingency');

// ---- the other templates build sensible lines ----
const hh = household();
for (const t of TT.list()) {
  const def = TT.T[t.key].defaults(TT.makeContext(hh, '2027-06'));
  const { bundle, flows } = TT.applyTemplate(t.key, def, '2027-06', hh, uid);
  assert.ok(bundle.name && bundle.start === '2027-06', t.key);
  for (const f of flows) {
    assert.ok(['income', 'spend', 'oneoff'].includes(f.kind) && Number.isFinite(f.amount) && /^\d{4}-\d{2}$/.test(f.start), `${t.key}: ${f.name}`);
    if (f.kind === 'oneoff') assert.strictEqual(f.end, f.start);
  }
}
const reno = TT.applyTemplate('renovation', { total: 20000, months: 4, contingency: 15 }, '2027-06', hh, uid);
assert.strictEqual(reno.bundle.contingency, 15); assert.deepStrictEqual([reno.flows[0].amount, reno.flows[0].start, reno.flows[0].end], [5000, '2027-06', '2027-09']);
const car = TT.applyTemplate('car', { price: 12000, financeMonthly: 0, financeMonths: 0, running: 150, replaceYears: 4, cycles: 2 }, '2027-06', hh, uid);
assert.deepStrictEqual(car.flows.filter(f => f.kind === 'oneoff').map(f => f.start), ['2027-06', '2031-06', '2035-06'], 'replaced every 4 years');
const trip = TT.applyTemplate('trip', { cost: 15000, deposit: 3000, depositMonths: 9 }, '2027-06', hh, uid);
assert.deepStrictEqual(trip.flows.map(f => [f.amount, f.start]), [[-3000, '2026-09'], [-12000, '2027-06']]);
const career = TT.applyTemplate('career', { who: 'C', months: 6, payDuring: 0, fees: 4000 }, '2027-06', hh, uid);
assert.deepStrictEqual(career.flows.map(f => [f.amount, f.start, f.end]), [[-2500, '2027-06', '2027-11'], [-4000, '2027-06', '2027-06']]);
console.log('  ✓ every template builds valid dated lines');
console.log('All life-event checks pass ✓');
