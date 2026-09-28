// Run with:  node tests/curves.test.js
// Market rates from yield curves (docs/YIELD_CURVES.md): the plan's "done when" list, section 8.
// Every curve here is MADE UP (flat, or a hump), never a real Bank of England figure; households are synthetic.
const assert = require('assert');
const TM = require('../model.js');
const E = require('../engine.js');
const C = require('../curves.js');
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);

// A curve in the shape the data pipeline writes: forwards month 1..60, long tenors beyond.
const LONG = [6, 7, 8, 9, 10, 15, 20, 25];
function curveFrom(f, asOf = '2026-01-01', extra = {}) {
  const fwds = Array.from({ length: 60 }, (_, i) => f((i + 1) / 12));
  return { source: 'test', asOf, compounding: 'continuous', shortEnd: { stepMonths: 1, forward: fwds, spot: fwds.slice() }, long: { tenorsYears: LONG, forward: LONG.map(f), spot: LONG.map(f) }, anchors: { bankRate: f(0), sonia: f(1 / 12) }, quoted: {}, ...extra };
}
const flat4 = curveFrom(() => 4);
// rises from 4% to 5% over 12 months, falls to 3% by month 36, then stays there
const hump = curveFrom(t => { const m = t * 12; return m <= 12 ? 4 + m / 12 : m <= 36 ? 5 - 2 * (m - 12) / 24 : 3; });
const layer = (curve, rates = { kind: 'market' }) => C.forScenario({ rateBasis: { curve } }, { rates });
const K0 = C.monthKey('2026-01');

// ---------- Maths ----------
{
  const L = layer(flat4);
  for (const t of [0, 0.01, 0.5, 3, 5, 7.3, 30]) near(C.fwd(L, t), 4, `flat curve forward at ${t}`);
  near(C.monthRateCC(L, 0.2, 0.2 + 1 / 12), 4, 'a month’s average');
  near(C.termRateCC(L, 1.5, 2), 4, 'a 2-year term from 18 months');
  near(C.spotCC(L, 10), 4, '10-year spot');
  near(C.aer(4), 4.0810774192388, 'AER of 4% continuous is about 4.081%', 1e-9);
  near(C.monthlyFactor(4), Math.exp(0.04 / 12), 'monthly factor e^(0.04/12)');
  near(C.ccOf(C.aer(4)), 4, 'AER back to continuous');
  // averaging a straight line exactly: from month 1 (4 1/12 %) to month 12 (5%) the hump averages the two ends
  near(C.termRateCC(layer(hump), 1 / 12, 11 / 12), (4 + 1 / 12 + 5) / 2, 'the average of a straight line is its midpoint');
  console.log('  ✓ a flat 4% curve gives 4% from every function, AER 4.081%, monthly factor e^(0.04/12)');
}
const variablePath = (L, o, months = 48, k0 = K0) => C.path({ kind: 'variable', category: 'savings', known: () => o.rate, knownUntil: 0, ...o }, L, k0, months);
{
  const L = layer(hump);
  const A = variablePath(L, { rate: 2.5, passThrough: 1, lagMonths: 0 }).rates;
  const B = variablePath(L, { rate: 2.5, passThrough: 0.5, lagMonths: 3 }).rates;
  // A follows the curve exactly, month by month (the middle of month i is (i + 0.5) / 12 years out)
  for (let i = 0; i < 48; i++) near(A[i] - A[0], C.fwd(L, (i + 0.5) / 12) - C.fwd(L, 0.5 / 12), `pass-through 1, lag 0, month ${i}`);
  const peak = A.indexOf(Math.max(...A));
  assert.ok(peak >= 10 && peak <= 12 && A[40] < A[0], `rises then falls (peak month ${peak})`);
  // B is the same shape at half the size, exactly three months later
  for (let i = 3; i < 48; i++) near(B[i] - B[3], 0.5 * (A[i - 3] - A[0]), `pass-through 0.5, lag 3, month ${i}`);
  for (let i = 0; i < 3; i++) near(B[i], 2.5, `lag 3: month ${i} still reads today’s Bank Rate`);
  console.log('  ✓ a hump-shaped curve: pass-through 1 follows it; 0.5 with a 3-month lag is half the size, 3 months late');
}
{
  const L = layer(hump);
  for (const o of [{ rate: 1.2, passThrough: 0.6, lagMonths: 2 }, { rate: 5.1, passThrough: 1, lagMonths: 0 }, { rate: 3, passThrough: 0.25, lagMonths: 6 }, { rate: 0.1, passThrough: 0.9, lagMonths: 1, floor: 0 }])
    near(variablePath(L, o).rates[0], o.rate, `month 0 of pass-through ${o.passThrough}, lag ${o.lagMonths}`);
  // a floor holds the rate up when the curve falls far enough
  const P = variablePath(layer(curveFrom(t => Math.max(0, 4 - t * 2))), { rate: 0.5, passThrough: 1, lagMonths: 0, floor: 0.25 }).rates;
  assert.ok(P.at(-1) === 0.25 && P[0] === 0.5, 'the floor');
  console.log('  ✓ calibration: month 0 is the entered rate for every variable account');
}

// ---------- Fixed products ----------
const fixedPath = (L, o, months = 72) => C.path({ kind: 'fixed', category: o.category || 'savings', known: () => o.rate, fixEndI: o.fixEndI, afterRate: o.afterRate, rollover: o.rollover, passThrough: o.passThrough ?? 0.6, lagMonths: o.lagMonths ?? 2, extra: o.extra }, L, K0, months);
{
  const L = layer(hump);
  const P = fixedPath(L, { rate: 4.2, fixEndI: 14, rollover: { kind: 'refix', termMonths: 24, margin: 0.35 } });
  for (let i = 0; i < 14; i++) assert.strictEqual(P.rates[i], 4.2, `held at 4.20% in month ${i}`);
  // month 14 starts 14/12 years out; the new rate is the 2-year forward from then, as AER, plus the margin
  const want = C.aer(C.termRateCC(L, 14 / 12, 2)) + 0.35;
  near(P.rates[14], want, 'first month after the fix: forward for the new fix + margin');
  for (let i = 14; i < 38; i++) near(P.rates[i], want, `constant for 24 months (month ${i})`);
  near(P.rates[38], C.aer(C.termRateCC(L, 38 / 12, 2)) + 0.35, 'then reprices again');
  assert.deepStrictEqual(P.reprices.map(r => r.i), [14, 38, 62], 'each repricing is logged');
  assert.ok(P.fixed.slice(0, 72).every(Boolean), 'money rolled into a new fix stays locked up');
  // margin left blank: today's quoted 2-year rate less today's 2-year market rate
  const Lq = layer(curveFrom(() => 4, '2026-01-01', { quoted: { mortgage2yFix75: { rate: 4.9, month: '2025-12' } } }));
  const Q = fixedPath(Lq, { category: 'mortgage', rate: 2, fixEndI: 3, rollover: { kind: 'refix', termMonths: 24, margin: null } });
  near(Q.margin.margin, 4.9 - C.aer(4), 'calibrated margin = quoted − market');
  near(Q.rates[3], 4.9, 'on a flat curve the new fix is today’s quoted rate');
  assert.strictEqual(fixedPath(layer(flat4), { category: 'mortgage', rate: 2, fixEndI: 3, rollover: { kind: 'refix', termMonths: 24 } }).margin.source, 'typical', 'no quoted rate: a typical margin, flagged');
  console.log('  ✓ a fix holds until it ends, then reprices at the forward rate for the new fix plus the margin, for its term');
}
// the household engine: payments recalculate at each repricing, and the balance amortises correctly
function household(o = {}) {
  return TM.migrate({
    version: 10, people: [{ id: 'M', name: 'Me' }, { id: 'J', name: 'Joint' }],
    accounts: [{ id: 'cur', name: 'Current', type: 'current' }, ...(o.accounts || [])],
    snapshots: [{ date: '2026-01-01', balances: { cur: 5000, ...(o.balances || {}) } }],
    flows: [{ id: 'm', name: 'Mortgage', kind: 'spend', amount: 0, linked: 'mortgage' }], bufferPct: 0, bundles: [],
    mortgage: { parts: o.parts || [{ id: 'main', payment: 0 }] },
    rules: { cashFloor: 0, isaPerPerson: 0, isaUsedBy: {}, isaFillOrder: ['M'], isaUsedTaxYear: 2025, sweepToSS: 0 },
    scenarios: { s: { name: 'S', growth: true, ssReturn: 0, rates: o.rates || { kind: 'market' } } }, rateBasis: o.curve === null ? null : { source: 'test', asOf: '2026-01-01', curve: o.curve || hump },
  });
}
{
  const part = { id: 'main', payment: 1000, balance: 150000, rate: 2, fixEnd: '2026-07', newRate: 7, termEnd: '2046-01', rateModel: { kind: 'fixed', rollover: { kind: 'refix', termMonths: 24, margin: 0.5 }, passThrough: 0.9, lagMonths: 1 } };
  const d = household({ parts: [part] });
  const pr = E.project(d, 's', 60), L = layer(hump);
  // an independent month-by-month amortisation of the same rule
  let bal = 150000, pay = 1000, rate = 2;
  for (let i = 0; i < 60; i++) {
    const k = K0 + i;
    if (i === 6 || i === 30 || i === 54) { rate = C.aer(C.termRateCC(L, i / 12, 2)) + 0.5; pay = E.annuity(bal, rate, C.monthKey('2046-01') - k); }
    const int = bal * rate / 100 / 12; bal = bal + int - pay;
    const got = pr.rows[i].mortgageParts[0];
    near(got.rate, rate, `rate in month ${i}`, 1e-9); near(got.pay, pay, `payment in month ${i}`, 1e-6); near(got.bal, bal, `balance in month ${i}`, 1e-6);
    assert.strictEqual(got.repriced, i === 6 || i === 30 || i === 54, `repriced flag in month ${i}`);
  }
  // an SVR (variable rollover) is calibrated to the rate after the fix entered today, then moves with Bank Rate
  d.mortgage.parts[0].rateModel = { kind: 'fixed', rollover: { kind: 'variable' }, passThrough: 0.9, lagMonths: 1 };
  const S = E.project(d, 's', 24).rows.map(r => r.mortgageParts[0].rate);
  for (let i = 0; i < 6; i++) assert.strictEqual(S[i], 2, `fixed until the fix ends (month ${i})`);
  near(S[6] - 7, 0.9 * (C.expectedBankRate(L, K0 + 5) - C.fwd(L, 0)), 'the variable rollover switches at the fix end, from today’s SVR');
  console.log('  ✓ mortgage payments recalculate at each repricing; the balance matches an independent amortisation');
}

// ---------- Rollover choices ----------
{
  const L = layer(hump);
  const V = fixedPath(L, { rate: 4.5, fixEndI: 9, afterRate: 1.5, rollover: { kind: 'variable' }, passThrough: 0.6, lagMonths: 2 });
  for (let i = 0; i < 9; i++) assert.strictEqual(V.rates[i], 4.5);
  assert.strictEqual(V.why[8].kind, 'known'); assert.strictEqual(V.why[9].kind, 'variable', 'switches models in the maturity month');
  near(V.rates[9], 1.5 + 0.6 * (C.expectedBankRate(L, K0 + 7) - C.fwd(L, 0)), 'at the rate after, moved by Bank Rate since today');
  assert.ok(!V.fixed[9] && V.fixed[8], 'the money is free from the maturity month');
  const M = fixedPath(L, { rate: 4.5, fixEndI: 9, rollover: { kind: 'manual', manualRate: 3.3 } });
  assert.ok(M.rates[8] === 4.5 && M.rates[9] === 3.3 && M.rates[50] === 3.3, 'manual: the rate you set');
  // close: a fixed savings account is paid into cash in its maturity month
  const d = household({ accounts: [{ id: 'bond', name: 'Bond', type: 'savings', access: 'fixed', maturity: '2026-06', rate: 5, rateModel: { kind: 'fixed', rollover: { kind: 'close' } } }], balances: { bond: 20000 } });
  const R = E.project(d, 's', 8).rows;
  near(R[4].accounts.bond, 20000 * Math.pow(1 + 0.05 / 12, 5), 'May: still in the bond, at 5%');
  assert.strictEqual(R[5].closed, R[4].accounts.bond, 'June: the whole balance is paid out');
  assert.strictEqual(R[5].accounts.bond, 0); near(R[5].closing, R[4].closing + R[4].accounts.bond, 'and lands in cash');
  near(R[5].net, R[4].net, 'net worth unchanged by the move');
  console.log('  ✓ rollover: variable switches in the right month, manual uses your rate, close pays the balance into cash');
}

// ---------- Scenarios ----------
{
  const L = layer(hump), U = layer(hump, { kind: 'shift', shift: 1 });
  for (const o of [{ rate: 2.5, passThrough: 0.6, lagMonths: 2 }, { rate: 4, passThrough: 1, lagMonths: 0 }]) {
    const a = variablePath(L, o).rates, b = variablePath(U, o).rates;
    for (let i = o.lagMonths; i < 48; i++) near(b[i] - a[i], o.passThrough, `+1% shift, pass-through ${o.passThrough}, month ${i}`);
  }
  const f = { rate: 4.2, fixEndI: 5, rollover: { kind: 'refix', termMonths: 24, margin: 0.35 } };
  const a = fixedPath(L, f).reprices, b = fixedPath(U, f).reprices;
  a.forEach((r, j) => { near(b[j].fwdCC - r.fwdCC, 1, 'a repriced fix’s forward rate is exactly 1 point higher'); near(b[j].rate - r.rate, C.aer(r.fwdCC + 1) - C.aer(r.fwdCC), 'and its AER moves with it'); });
  // twist: short end +1, long end 0 over 10 years
  const T = layer(hump, { kind: 'twist', short: 1, long: 0, twistYears: 10 });
  near(C.fwd(T, 0) - C.fwd(L, 0), 1, 'twist: short end'); near(C.fwd(T, 5) - C.fwd(L, 5), 0.5, 'twist: halfway'); near(C.fwd(T, 12) - C.fwd(L, 12), 0, 'twist: long end');
  // long-run anchor: market for 3 years, blended over the next 3 to 2.5%, then 2.5%
  const A = layer(curveFrom(t => 4 + t / 10), { kind: 'anchor', anchorYears: 3, blendYears: 3, neutral: 2.5 }), base = t => 4 + t / 10;
  near(C.fwd(A, 2), base(2), 'anchor: the market before year 3');
  for (const w of [0, 0.25, 0.5, 0.75, 1]) near(C.fwd(A, 3 + 3 * w), (1 - w) * base(3 + 3 * w) + w * 2.5, `anchor: blended ${w * 100}% of the way`);
  near(C.fwd(A, 9), 2.5, 'anchor: the neutral rate after year 6');
  // manual path: points by hand, straight lines between, flat after the last
  const Mp = C.forScenario({}, { rates: { kind: 'manual', today: 4, points: [{ months: 12, rate: 3 }, { months: 36, rate: 3.5 }] } });
  assert.ok(Mp.active, 'a manual path needs no curve');
  near(C.fwd(Mp, 0.5), 3.5, 'manual: halfway to the 1-year point'); near(C.fwd(Mp, 2), 3.25, 'manual: between points'); near(C.fwd(Mp, 8), 3.5, 'manual: flat after the last');
  console.log('  ✓ +1% shifts variable rates by pass-through × 1% and repriced fixes by 1%; twist, anchor and manual paths');
}
{
  // "Flat at today's rate" is the old engine exactly: a household with models everywhere, projected flat, equals the
  // same household with every model removed.
  const o = {
    accounts: [
      { id: 'sav', name: 'Saver', type: 'savings', rate: 3, rates: [{ from: null, rate: 3 }, { from: '2026-09-01', rate: 2 }], rateModel: { kind: 'variable', passThrough: 0.6, lagMonths: 2 } },
      { id: 'bond', name: 'Bond', type: 'savings', access: 'fixed', maturity: '2027-03', rate: 5, rateModel: { kind: 'fixed', rollover: { kind: 'refix', termMonths: 12 } } },
      { id: 'cisa', name: 'Cash ISA', type: 'cash_isa', rate: 4, rateModel: { kind: 'variable', passThrough: 0.5, lagMonths: 1 } },
      { id: 'fisa', name: 'Fixed ISA', type: 'cash_isa', access: 'fixed', maturity: '2026-10', rate: 4.5, rateModel: { kind: 'fixed', rollover: { kind: 'variable' } } }],
    balances: { sav: 10000, bond: 15000, cisa: 20000, fisa: 8000 },
    parts: [{ id: 'main', payment: 900, balance: 120000, rate: 2.1, fixEnd: '2027-06', newRate: 6.5, termEnd: '2045-01', rateModel: { kind: 'fixed', rollover: { kind: 'refix', termMonths: 60 } } },
      { id: 'p2', payment: 200, balance: 30000, rate: 5, termEnd: '2040-01', rateModel: { kind: 'tracker', passThrough: 1, lagMonths: 0 } }],
  };
  const strip = d => { d.accounts.forEach(a => delete a.rateModel); d.mortgage.parts.forEach(p => delete p.rateModel); return d; };
  const plain = E.project(strip(household(o)), 's', 120);
  const flat = E.project(household({ ...o, rates: { kind: 'flat' } }), 's', 120);
  const noCurve = E.project(household({ ...o, curve: null }), 's', 120);
  assert.deepStrictEqual(flat.rows, plain.rows, 'flat reproduces the old projection exactly');
  assert.deepStrictEqual(noCurve.rows, plain.rows, 'no curve: the same');
  assert.ok(!flat.rateLayer.active && flat.rateLayer.reason === 'chosen');
  assert.ok(!noCurve.rateLayer.active && noCurve.rateLayer.reason === 'no-curve', 'no curve falls back to flat, and says so');
  // and on market rates they do move
  const mkt = E.project(household(o), 's', 120);
  assert.ok(mkt.rateLayer.active && mkt.rateLayer.modelled === 6 && mkt.rows.at(-1).net !== plain.rows.at(-1).net, 'market rates change the projection');
  // a dated change still to come is a fact: the model takes over from it
  near(mkt.rows[7].rates.sav, 3, 'August: 3% as entered'); near(mkt.rows[8].rates.sav, 2, 'September: the 2% already announced');
  assert.strictEqual(mkt.rows[8].market.sav.why.kind, 'variable', 'modelled from then on');
  // the fixed ISA joins the instant pool when it matures onto a variable rate; the refixed bond stays locked up
  assert.ok(mkt.rows[8].byAccess.fixed > 15000 && mkt.rows[9].isaCashFlex + mkt.rows[9].withdraw > mkt.rows[8].isaCashFlex + 8000, 'fixed ISA released in October (after that month’s draw to cover the floor)');
  assert.ok(mkt.rows[20].byAccess.fixed > 15000, 'the bond rolled into a new fix: still fixed after March 2027');
  assert.ok(plain.rows[20].byAccess.fixed === 0, 'without a model it matures into instant access, as before');
  // access keeps its old rules whatever the model: fixed with no end date stays fixed; a "variable" model on a fixed-term
  // account does not release it before its maturity
  const acc2 = (m, maturity) => household({ accounts: [{ id: 'b', name: 'B', type: 'cash_isa', access: 'fixed', maturity, rate: 4, rateModel: m }], balances: { b: 10000 } });
  const P1 = E.project(acc2({ kind: 'fixed', rollover: { kind: 'variable' } }, null), 's', 24).rows;
  assert.ok(P1.every(r => r.byAccess.fixed > 10000 && r.isaCashFlex === 0), 'fixed with no maturity: locked throughout, as before');
  const P2 = E.project(acc2({ kind: 'variable', passThrough: 0.6, lagMonths: 2 }, '2026-06'), 's', 8).rows;
  assert.ok(P2[4].byAccess.fixed > 10000 && P2[5].byAccess.fixed === 0, 'a variable model on a fixed-term account: released in its maturity month, as before');
  console.log('  ✓ flat at today’s rates reproduces the old projection exactly; no curve falls back to it; access rules unchanged');
}

// ---------- Pipeline ----------
{
  assert.ok(C.validate(hump).ok, 'a good curve passes');
  const bad = JSON.parse(JSON.stringify(hump)); bad.shortEnd.forward[20] = 16;
  const v = C.validate(bad, hump); assert.ok(!v.ok && /outside/.test(v.errors.join()), 'a rate above 15% is rejected');
  const neg = JSON.parse(JSON.stringify(hump)); neg.long.spot[2] = -1.5; assert.ok(!C.validate(neg).ok, 'below −1% too');
  const old = { ...hump, asOf: '2025-12-31' }; assert.ok(/older/.test(C.validate(old, hump).errors.join()), 'an older date is rejected');
  const gap = JSON.parse(JSON.stringify(hump)); gap.shortEnd.forward[5] = null; assert.ok(/missing/.test(C.validate(gap).errors.join()), 'missing points are rejected');
  const off = JSON.parse(JSON.stringify(hump)); off.anchors.sonia = 3.2; assert.ok(/SONIA/.test(C.validate(off).errors.join()), '1-month forward far from SONIA is rejected');
  // the app shows how old the curve is: amber after 10 business days, red after 30 days
  assert.strictEqual(C.staleness('2026-09-25', '2026-09-28').level, 'ok'); // Fri → Mon: 1 business day
  assert.strictEqual(C.staleness('2026-09-25', '2026-09-28').business, 1);
  assert.strictEqual(C.staleness('2026-09-11', '2026-09-25').level, 'ok'); // 10 business days
  assert.strictEqual(C.staleness('2026-09-10', '2026-09-25').level, 'amber'); // 11
  assert.strictEqual(C.staleness('2026-08-25', '2026-09-25').level, 'red'); // 31 days
  console.log('  ✓ validation rejects bad curves; the age badge turns amber after 10 business days and red after 30 days');
}

// ---------- Calibration from history (Step 5) ----------
{
  const months = Array.from({ length: 36 }, (_, i) => C.keyMonth(C.monthKey('2023-01') + i));
  const bank = months.map((m, i) => ({ month: m, rate: 3 + 2 * Math.sin(i / 5) }));
  const B = Object.fromEntries(bank.map(x => [x.month, x.rate]));
  const retail = months.slice(2).map(m => ({ month: m, rate: 0.4 + 0.6 * B[C.keyMonth(C.monthKey(m) - 2)] }));
  const est = C.estimatePassThrough(bank, retail);
  near(est.passThrough, 0.6, 'pass-through recovered', 1e-9); assert.strictEqual(est.lagMonths, 2, 'lag recovered'); near(est.r2, 1, 'perfect fit', 1e-9);
  console.log('  ✓ pass-through and lag estimated from history');
}

// ---------- In words ----------
assert.strictEqual(C.describe({ kind: 'fixed', rollover: { kind: 'refix', termMonths: 24, margin: 0.35 } }, { rate: 4.2, fixEnd: '2027-03' }), 'Fixed 4.20% until Mar 2027, then a 2-year fix at market + 0.35%');
assert.strictEqual(C.describe({ kind: 'variable', passThrough: 0.6, lagMonths: 2 }), 'Variable: follows Bank Rate at 60%, 2-month lag');
assert.strictEqual(C.describe(null), 'Your entered rate, carried forward');
console.log('All curve checks pass ✓');
