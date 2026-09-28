// Run with:  node tests/options.test.js
// Remortgage option comparison (1.4) and whole-plan scenarios (1.6). The roadmap's done-when:
//   each option's payment matches a standard repayment (annuity) calculation to the penny;
//   overpayments reduce the balance and interest exactly as a month-by-month amortisation would;
//   fees added to the loan accrue interest; every compared figure matches running that scenario on its own.
// The amortisation below is written out independently of engine.js. Synthetic data only.
const assert = require('assert');
const TM = require('../model.js');
const E = require('../engine.js');
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);

// ---- an independent month-by-month amortisation, straight from the rule ----
const pmt = (L, ratePct, n) => { const r = ratePct / 1200; return r ? L * r / (1 - Math.pow(1 + r, -n)) : L / n; };
function byHand(L, ratePct, n, months, regular = 0, capPct = 10) {
  let b = L, interest = 0, cap = 0; const P = pmt(L, ratePct, n);
  for (let m = 0; m < months; m++) {
    if (m % 12 === 0) cap = b * capPct / 100;           // allowance: capPct of the balance at the start of each year
    const i = b * ratePct / 1200; b = b + i - Math.min(P, b + i); interest += i;
    const o = Math.min(regular, cap, b); b -= o; cap -= o;
  }
  return { P, b, interest };
}

// 1. payment to the penny: £200,000 over 25 years at 4.5% = £1,111.66 a month (the standard formula)
const o1 = { type: 'fixed', rate: 4.5, fixMonths: 60, termMonths: 300, fee: 0, lump: 0, regular: 0 };
const a1 = E.amortise(o1, 200000, 60);
assert.strictEqual(a1.payment.toFixed(2), pmt(200000, 4.5, 300).toFixed(2)); assert.strictEqual(a1.payment.toFixed(2), '1111.66');
near(a1.balance, byHand(200000, 4.5, 300, 60).b, 'balance after 5 years');
near(a1.interest, byHand(200000, 4.5, 300, 60).interest, 'interest over 5 years');
console.log('  ✓ payment matches the annuity formula to the penny');

// 2. overpayments: £500 a month, within a 10% a year allowance, and one that hits the cap
let a = E.amortise({ ...o1, regular: 500 }, 200000, 60), h = byHand(200000, 4.5, 300, 60, 500);
near(a.balance, h.b, 'balance with £500 a month overpaid'); near(a.interest, h.interest, 'interest with overpayments');
assert.ok(a.interest < a1.interest && a.balance < a1.balance - 30000, 'overpaying cuts interest and balance');
a = E.amortise({ ...o1, regular: 5000, capPct: 10 }, 200000, 24); h = byHand(200000, 4.5, 300, 24, 5000, 10);
near(a.balance, h.b, 'capped overpayments');
near(E.amortise({ ...o1, regular: 5000 }, 200000, 12).overpaid, 20000, 'year 1 overpayment capped at 10% of £200,000');
console.log('  ✓ overpayments reduce balance and interest exactly as a month-by-month amortisation, within the cap');

// 3. a fee added to the loan accrues interest; paid upfront it does not
const add = E.amortise({ ...o1, fee: 1000, feeAdded: true }, 200000, 60), up = E.amortise({ ...o1, fee: 1000, feeAdded: false }, 200000, 60);
near(add.interest - up.interest, byHand(1000, 4.5, 300, 60).interest, 'the extra interest is exactly the interest on £1,000 borrowed');
near(add.payment, pmt(201000, 4.5, 300), 'payment on £201,000'); near(up.upfront, 1000, 'paid upfront from cash'); near(add.upfront, 0, 'nothing upfront when added');
// lump sum at the switch comes off the loan
near(E.amortise({ ...o1, lump: 20000 }, 200000, 1).payment, pmt(180000, 4.5, 300), 'lump sum reduces the loan');
// fixed then a rate after the fix: payment recalculated over what is left of the term
const fx = E.amortise({ ...o1, fixMonths: 24, afterRate: 6 }, 200000, 36);
const b24 = byHand(200000, 4.5, 300, 24).b; near(fx.months[24].paid, pmt(b24, 6, 276), 'new payment when the fix ends');
console.log('  ✓ fees added accrue interest; lump sums; payment reset at the end of the fix');

// ---- inside the household ----
const household = () => TM.migrate({
  version: 4, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }],
  accounts: [{ id: 'cur', type: 'current' }], snapshots: [{ date: '2026-06-01', balances: { cur: 60000 } }],
  flows: [{ id: 'pay', kind: 'income', amount: 5000 }, { id: 'mtg', kind: 'spend', amount: 0, linked: 'mortgage' }], bufferPct: 0, bundles: [],
  mortgage: { parts: [{ id: 'main', payment: 1200, balance: 200000, rate: 2, fixEnd: '2027-06-01', newRate: 7, termEnd: '2051-06-01' }] },
  rules: { cashFloor: 5000, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M'], isaUsedTaxYear: 2026, sweepToSS: 0 },
  scenarios: { s: { name: 'S', growth: false } },
});
let d = household();
d.remortgageOptions.push({ id: 'o5', partId: 'main', name: '5-year fix', type: 'fixed', rate: 4.2, fixMonths: 60, fee: 999, feeAdded: true, lump: 10000, regular: 300, capPct: 10, afterRate: 7 });
d.remortgageOptions.push({ id: 'o2', partId: 'main', name: '2-year fix', type: 'fixed', rate: 4.6, fixMonths: 24, fee: 0, lump: 0, regular: 0, afterRate: 7 });
// the household projection applies exactly the same rules as amortise(), month by month
const plain = E.project(d, 's', 12).rows.find(r => r.date === '2027-05-01'), balSwitch = plain.mortgageParts[0].bal;
const withOpt = E.projectAs(d, 's', { option: 'o5' }, 12 + 60).rows.filter(r => r.date >= '2027-06-01');
const am = E.amortise({ ...d.remortgageOptions[0], termMonths: 288 }, balSwitch, 60);
withOpt.forEach((r, m) => near(r.mortgageParts[0].bal, am.months[m].bal, `household balance month ${m}`));
near(withOpt[0].dealCash, 10000 + 300, 'switch month: lump sum and first overpayment leave cash (fee added to loan)');
near(withOpt[0].mortgageParts[0].pay, pmt(balSwitch - 10000 + 999, 4.2, 288), 'new payment on what is left of the term');
console.log('  ✓ the household projection runs the option with the same maths, and the lump sum leaves cash');

// ---- the comparison: each figure matches that scenario run on its own ----
const C = E.compareOptions(d, 's', 60, '2026-06');
assert.deepStrictEqual(C.results.map(x => x.option.name), ['Do nothing', '5-year fix', '2-year fix']);
for (const x of C.results) {
  const rows = E.projectAs(d, 's', { option: x.option.id }, 12 + 60).rows.filter(r => r.date >= '2027-06-01');
  near(x.net, rows.at(-1).net, `${x.option.name} net worth`); near(x.balance, rows.at(-1).mortgageParts[0].bal, `${x.option.name} balance`);
  near(x.interest, rows.reduce((s, r) => s + r.mortgageParts[0].interest, 0), `${x.option.name} interest`);
}
const nothing = C.results[0]; near(nothing.payment, pmt(balSwitch, 7, 288), 'do nothing: reverts to 7% over the rest of the term');
assert.ok(C.results[1].totalCost < nothing.totalCost, 'a 4.2% deal costs less than the 7% reversion');
near(C.balAtSwitch, balSwitch, 'balance at the switch');
// rate sensitivity grid: payment and 5-year cost at ±0.5% and ±1%
assert.strictEqual(C.termLeft, 288, 'Jun 2027 to Jun 2051');
const g = E.rateGrid(d.remortgageOptions[1], balSwitch, 60, C.termLeft);
assert.deepStrictEqual(g.map(x => x.shift), [-1, -0.5, 0, 0.5, 1]);
g.forEach(x => near(x.payment, pmt(balSwitch, 4.6 + x.shift, 288), `payment at ${x.shift}, over the 288 months left`));
near(g[2].payment, C.results[2].payment, 'the grid at the assumed rate = the household projection’s payment');
assert.ok(g[0].cost < g[2].cost && g[2].cost < g[4].cost, 'cost rises with the rate');
console.log('  ✓ comparison figures match each option run on its own; rate sensitivity grid');

// ---- 1.6 a scenario is a whole plan: assumptions + events + option ----
d.bundles.push({ id: 'b1', name: 'Baby', start: '2027-01', on: true, scale: 1, contingency: 0 });
d.flows.push({ id: 'n', kind: 'spend', amount: 800, start: '2027-01', end: null, bundle: 'b1' });
d.scenarios.a = { name: 'Plan A', growth: false, option: 'o5', bundles: { b1: true }, rateShift: 0 };
d.scenarios.b = { name: 'Plan B', growth: false, option: 'o2', bundles: { b1: false }, rateShift: 1 };
d = TM.migrate(d);
const A = E.project(d, 'a', 72).rows, B = E.project(d, 'b', 72).rows;
near(A.find(r => r.date === '2027-03-01').spend - B.find(r => r.date === '2027-03-01').spend, 800, 'Plan B leaves the baby out');
near(B.find(r => r.date === '2027-06-01').mortgageParts[0].interest, B.find(r => r.date === '2027-05-01').mortgageParts[0].bal * 4.6 / 1200, 'Plan B: the 2-year fix at 4.6% (the rate shift only applies after it)');
near(E.projectAs(d, 'a', {}, 72).rows.at(-1).net, A.at(-1).net, 'projectAs with no change = the scenario itself');
const av = E.availableSeries(A, 5000);
near(av[0], A[0].byAccess.instant + A[0].byAccess.notice - 5000 - A.slice(1, 13).reduce((s, r) => s + r.earmark, 0), 'available series');
console.log('  ✓ scenarios carry their own events, option and rate shift');
console.log('All option checks pass ✓');
