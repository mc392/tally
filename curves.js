// ================= Tally market rates (yield curves) =================
// Pure functions, no DOM, tested in node (tests/curves.test.js). See docs/YIELD_CURVES.md.
//
// The Bank of England publishes a daily sterling OIS curve: the market-implied path of SONIA, and so of
// Bank Rate. This file turns it (or a path typed in by hand) into a month-by-month interest rate for any
// account or mortgage part that has a `rateModel`:
//   variable / tracker - follows the expected Bank Rate: max(floor, spread + passThrough × Bank Rate then),
//                        `lagMonths` late. The spread is set so the first modelled month is exactly the rate
//                        entered today (calibration), so only the SHAPE of the curve moves it.
//   fixed              - the rate entered, until the fix ends; then its `rollover`: a new fix priced from the
//                        forward rate for that period plus a margin (refix), the variable model above
//                        (variable), a rate typed in (manual), or the money moves out (close).
// An item with no rateModel is left exactly as it was: its own entered rates, carried forward.
//
// Units. Curve rates are % a year, continuously compounded (as the Bank publishes them). The expected Bank
// Rate is the instantaneous forward itself: an overnight rate compounded daily is the same figure to a
// hundredth of a percent. A fixed product is priced as AER = e^(term rate) − 1, and its margin is added in
// AER terms. Every rate handed back to the engine is % a year, which the engine applies monthly as rate / 12
// like every other account.
const TallyCurves = (() => {
  const aer = cc => (Math.exp(cc / 100) - 1) * 100;          // continuous → AER, both in %
  const ccOf = a => Math.log(1 + a / 100) * 100;             // AER → continuous
  const monthlyFactor = cc => Math.exp(cc / 100 / 12);       // growth over one month at a continuous rate
  const monthKey = m => { const [y, mm] = String(m).split('-').map(Number); return y * 12 + mm - 1; };
  const keyMonth = k => `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`;
  const num = v => v != null && v !== '' && isFinite(+v);

  // ---------- a curve file → a forward-rate function ----------
  // Knots: the short end at stepMonths intervals (month 1 … 60), then the long tenors beyond it. Linear
  // between knots; flat before the first and after the last.
  function knotsOf(curve, field = 'forward') {
    const out = [];
    const se = curve.shortEnd || {}, step = +se.stepMonths || 1;
    (se[field] || []).forEach((v, i) => { if (num(v)) out.push([(i + 1) * step / 12, +v]); });
    const lg = curve.long || {}, last = out.length ? out.at(-1)[0] : 0;
    (lg.tenorsYears || []).forEach((t, i) => { const v = (lg[field] || [])[i]; if (num(v) && +t > last + 1e-9) out.push([+t, +v]); });
    return out.sort((a, b) => a[0] - b[0]);
  }
  function linear(pts) {
    return t => {
      if (!pts.length) return 0;
      if (t <= pts[0][0]) return pts[0][1];
      if (t >= pts.at(-1)[0]) return pts.at(-1)[1];
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; }
      const [t0, v0] = pts[lo], [t1, v1] = pts[hi];
      return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
    };
  }
  const compiled = new WeakMap();
  function compile(curve) {
    if (!curve || typeof curve !== 'object') return null;
    if (compiled.has(curve)) return compiled.get(curve);
    const pts = knotsOf(curve, 'forward');
    if (!pts.length) return null;
    const c = { asOf: curve.asOf, fwd: linear(pts), knots: pts.map(p => p[0]), points: pts, source: curve.source || 'Bank of England OIS curve',
      anchors: curve.anchors || {}, quoted: curve.quoted || {}, suggested: curve.suggested || null };
    compiled.set(curve, c);
    return c;
  }

  // ---------- averages of the forward curve ----------
  // Exact for anything piecewise linear or quadratic between knots (Simpson's rule on each piece), which
  // covers the curve and every scenario below.
  function integral(C, t0, t1) {
    if (t1 <= t0) return 0;
    const cuts = [t0, ...C.knots.filter(k => k > t0 && k < t1), t1];
    let s = 0;
    for (let i = 1; i < cuts.length; i++) { const a = cuts[i - 1], b = cuts[i]; s += (b - a) / 6 * (C.fwd(a) + 4 * C.fwd((a + b) / 2) + C.fwd(b)); }
    return s;
  }
  const fwd = (C, t) => C.fwd(t);
  const monthRateCC = (C, t0, t1) => (t1 > t0 ? integral(C, t0, t1) / (t1 - t0) : C.fwd(t0));
  const termRateCC = (C, t, n) => (n > 0 ? integral(C, t, t + n) / n : C.fwd(t));
  const spotCC = (C, T) => termRateCC(C, 0, T);

  // ---------- rate scenarios (section 5) ----------
  // sc.rates = {kind, ...}. `fwd` is what the projection follows; `base` is the curve the scenario starts from,
  // used for calibration, so a shift moves every modelled rate rather than being absorbed into its spread.
  const KINDS = {
    market: 'Market-implied', shift: 'Parallel shift', twist: 'Twist', flat: 'Flat at today’s rates',
    anchor: 'Long-run anchor', manual: 'Manual path', history: 'Curve as at a past date',
  };
  const DEFAULTS = { shift: 1, short: 1, long: 0, twistYears: 10, anchorYears: 3, blendYears: 3, neutral: 3 };
  const withKnots = (C, fn, extra) => ({ ...C, fwd: fn, knots: [...new Set([...C.knots, ...extra])].sort((a, b) => a - b) });
  function manualCurve(r) {
    const pts = [[0, +r.today || 0], ...(r.points || []).filter(p => num(p.months) && num(p.rate)).map(p => [+p.months / 12, +p.rate])].sort((a, b) => a[0] - b[0]);
    return { asOf: r.asOf || null, fwd: linear(pts), knots: pts.map(p => p[0]), points: pts, source: 'Your own path', anchors: { bankRate: +r.today || 0 }, quoted: {}, suggested: null };
  }
  // The rates layer for one scenario. {active:false} means "carry today's entered rates forward", exactly
  // as the engine did before this layer existed: chosen (flat), or the fallback when no curve is to hand.
  function forScenario(data, sc) {
    const r = Object.assign({ kind: 'market' }, (sc && sc.rates) || {});
    const basis = data && data.rateBasis, market = basis && compile(basis.curve);
    const off = reason => ({ active: false, kind: 'flat', label: KINDS.flat, reason, wanted: r.kind });
    if (r.kind === 'flat') return off('chosen');
    let base;
    if (r.kind === 'manual') base = manualCurve(r);
    else if (r.kind === 'history') base = compile(r.curve);
    else base = market;
    if (!base) return off('no-curve');
    const v = k => (num(r[k]) ? +r[k] : DEFAULTS[k]);
    let C = base;
    if (r.kind === 'shift') C = withKnots(base, t => base.fwd(t) + v('shift'), []);
    if (r.kind === 'twist') { const T = Math.max(0.25, v('twistYears')), a = v('short'), b = v('long'); C = withKnots(base, t => base.fwd(t) + a + (b - a) * Math.min(1, Math.max(0, t) / T), [T]); }
    if (r.kind === 'anchor') {
      const N = Math.max(0, v('anchorYears')), M = Math.max(0, v('blendYears')), z = v('neutral');
      C = withKnots(base, t => { if (t <= N) return base.fwd(t); if (M <= 0 || t >= N + M) return z; const w = (t - N) / M; return (1 - w) * base.fwd(t) + w * z; }, [N, N + M]);
    }
    const label = r.kind === 'shift' ? `Market ${v('shift') >= 0 ? '+' : '−'}${Math.abs(v('shift'))}%`
      : r.kind === 'history' ? `Curve as at ${base.asOf}` : KINDS[r.kind] || KINDS.market;
    return { active: true, kind: r.kind, label, fwd: C.fwd, knots: C.knots, base, curve: C, asOf: base.asOf, source: base.source, quoted: (market || base).quoted || {}, anchors: base.anchors || {}, market };
  }

  // Years from the curve's as-at date to a point in month k (frac 0 = its first day, 0.5 = its middle).
  function timeOf(asOf, k, frac) {
    if (!asOf) return (frac || 0) / 12; // a manual path with no date runs from the projection's start
    const kA = monthKey(asOf), day = +String(asOf).slice(8, 10) || 1;
    return (k - kA + frac) / 12 - (day - 1) / 365.25;
  }
  // The Bank Rate expected in the middle of month k. A month already past reads today's figure from the
  // scenario's own starting curve (never shifted: the past is not a scenario).
  function expectedBankRate(L, k) {
    const t = timeOf(L.asOf, k, 0.5);
    return t < 0 ? L.base.fwd(0) : L.fwd(t);
  }

  // ---------- margins for new fixes (4.4) ----------
  // Today's quoted rate for that length of fix, less today's market rate for the same length. Quoted rates come
  // from the Bank's own series, in the curve file. With none, a typical figure, flagged so the screen says so.
  const QUOTED = { mortgage: [[24, 'mortgage2yFix75'], [60, 'mortgage5yFix75']], savings: [[12, 'savingsFix1y'], [24, 'savingsFix2y']] };
  const TYPICAL = { mortgage: 1, savings: -0.5 };
  function marginFor(L, category, termMonths) {
    const opts = (QUOTED[category] || []).map(([m, key]) => [m, L.quoted && L.quoted[key]]).filter(([, q]) => q && num(q.rate));
    if (opts.length) {
      const [m, q] = opts.sort((a, b) => Math.abs(a[0] - termMonths) - Math.abs(b[0] - termMonths))[0];
      const spot = aer(spotCC(L.base, m / 12));
      return { margin: +q.rate - spot, source: 'quoted', quoted: +q.rate, quotedMonth: q.month || null, spot, months: m };
    }
    return { margin: TYPICAL[category] ?? 0, source: 'typical' };
  }

  // ---------- the rate for every month (4.2 - 4.4) ----------
  // item: {kind, category:'savings'|'mortgage', known(i) → the rate entered for month i, knownUntil (months before
  //   it are facts, not modelled), fixEndI (fixed: the month the fix ends, from the start), afterRate (today's
  //   rate after the fix, e.g. the lender's SVR), rollover, passThrough, lagMonths, floor, spread, extra (added to
  //   trackers and new fixes: the scenario's rateShift)}
  // Returns rates[i] (% a year), fixed[i] (money locked in a fix that month), closeAt, reprices [{i, …}], and
  // why[i]: the workings of each month's figure, for the explanations on screen.
  function path(item, L, k0, months) {
    const pt = num(item.passThrough) ? +item.passThrough : 1, lag = Math.max(0, Math.round(+item.lagMonths || 0));
    const floor = num(item.floor) ? +item.floor : null, extra = +item.extra || 0;
    const rates = new Array(months), fixed = new Array(months).fill(false), why = new Array(months), reprices = [];
    const bank = i => expectedBankRate(L, k0 + i - lag);
    const baseBank = i => { const t = timeOf(L.asOf, k0 + i - lag, 0.5); return L.base.fwd(Math.max(0, t)); };
    const variable = (i, spread, add = 0) => {
      const b = bank(i), raw = spread + pt * b + add, v = floor != null ? Math.max(floor, raw) : raw;
      why[i] = { kind: 'variable', bank: b, month: keyMonth(k0 + i - lag), passThrough: pt, lagMonths: lag, spread, add, floor, floored: v !== raw, rate: v };
      return v;
    };
    const out = { rates, fixed, why, reprices, closeAt: null, spread: null, after: null };
    const R = item.rollover || {};
    if (item.kind === 'variable' || item.kind === 'tracker') {
      const Lk = Math.max(0, Math.min(months, item.knownUntil || 0));
      const spread = num(item.spread) ? +item.spread : item.known(Lk) - pt * baseBank(Lk);
      out.spread = spread; out.spreadSource = num(item.spread) ? 'yours' : 'calibrated';
      const add = item.kind === 'tracker' ? extra : 0;
      for (let i = 0; i < months; i++) {
        if (i < Lk) { rates[i] = item.known(i); why[i] = { kind: 'known', rate: rates[i] }; }
        else rates[i] = variable(i, spread, add);
      }
      return out;
    }
    // fixed: facts until the fix ends, then the rollover
    const F = item.fixEndI;
    let spreadAfter = null, margin = null;
    if (R.kind === 'variable' || !R.kind) {
      if (num(R.margin)) { spreadAfter = +R.margin; out.afterSource = 'yours'; }
      else if (num(item.afterRate)) { spreadAfter = +item.afterRate - pt * baseBank(0); out.afterSource = 'after'; } // today's SVR, moving with Bank Rate
      else if (item.category === 'savings' && L.quoted && L.quoted.savingsInstant && num(L.quoted.savingsInstant.rate)) { spreadAfter = +L.quoted.savingsInstant.rate - pt * baseBank(0); out.afterSource = 'quoted'; }
      else { spreadAfter = item.known(0) - pt * baseBank(0); out.afterSource = 'today'; }
      out.after = spreadAfter;
    }
    if (R.kind === 'refix') { const m = num(R.margin) ? { margin: +R.margin, source: 'yours' } : marginFor(L, item.category, +R.termMonths || 24); margin = m; out.margin = m; }
    const term = Math.max(1, Math.round(+R.termMonths || 24));
    let current = null, nextRoll = F;
    // A fix that ended before the start rolls at the first roll date still to come (refix), or is already on its rollover.
    if (F != null && F < 0 && R.kind === 'refix') while (nextRoll < 0) nextRoll += term;
    const firstChange = R.kind === 'refix' ? nextRoll : F;
    for (let i = 0; i < months; i++) {
      if (F == null || i < firstChange) { rates[i] = item.known(i); fixed[i] = true; why[i] = { kind: 'known', rate: rates[i] }; continue; } // no end date: fixed for good, as before
      if (R.kind === 'refix') {
        if (i === nextRoll) {
          const t = Math.max(0, timeOf(L.asOf, k0 + i, 0)), fcc = termRateCC(L, t, term / 12);
          current = aer(fcc) + margin.margin + extra;
          reprices.push({ i, fwdCC: fcc, fwdAER: aer(fcc), margin: margin.margin, marginSource: margin.source, extra, termMonths: term, rate: current });
          nextRoll += term;
        }
        rates[i] = current; fixed[i] = true;
        why[i] = { kind: 'refix', ...reprices.at(-1), repriced: reprices.at(-1).i === i };
      } else if (R.kind === 'manual') { rates[i] = num(R.manualRate) ? +R.manualRate : num(item.afterRate) ? +item.afterRate : item.known(0); why[i] = { kind: 'manual', rate: rates[i] }; }
      else if (R.kind === 'close') { rates[i] = 0; if (out.closeAt == null) out.closeAt = Math.max(0, F); why[i] = { kind: 'closed', rate: 0 }; }
      else rates[i] = variable(i, spreadAfter);
      if (i === F && R.kind !== 'refix') reprices.push({ i, kind: R.kind || 'variable', rate: rates[i] });
    }
    return out;
  }

  // Sensible starting models (the one-tap "use market rates"), shown to the user and editable.
  function defaultModel(o) {
    if (o.category === 'mortgage') return o.fixEnd ? { kind: 'fixed', rollover: { kind: 'variable', termMonths: 24, margin: null, manualRate: null }, passThrough: 0.9, lagMonths: 1, floor: 0, spread: null }
      : { kind: 'tracker', passThrough: 1, lagMonths: 1, floor: 0, spread: null };
    if (o.access === 'fixed') return { kind: 'fixed', rollover: { kind: 'variable', termMonths: 12, margin: null, manualRate: null }, passThrough: 0.6, lagMonths: 2, floor: 0, spread: null };
    return { kind: 'variable', passThrough: 0.6, lagMonths: 2, floor: 0, spread: null };
  }

  // One line, in words (6.2).
  const pct = v => `${(Math.round(v * 100) / 100).toFixed(2)}%`;
  const signed = v => `${v >= 0 ? '+' : '−'} ${pct(Math.abs(v))}`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fm = m => { const [y, mm] = String(m).split('-').map(Number); return `${MON[mm - 1]} ${y}`; };
  const years = m => (m % 12 === 0 ? `${m / 12}-year` : `${m}-month`);
  function describe(model, ctx = {}) {
    if (!model) return 'Your entered rate, carried forward';
    const follow = m => `follows Bank Rate at ${Math.round((+m.passThrough || 0) * 100)}%, ${+m.lagMonths || 0}-month lag`;
    if (model.kind === 'variable') return `Variable: ${follow(model)}`;
    if (model.kind === 'tracker') return `Tracker: ${num(model.spread) ? `Bank Rate ${signed(+model.spread)}` : follow(model)}`;
    const R = model.rollover || {}, until = ctx.fixEnd ? ` until ${fm(ctx.fixEnd)}` : '';
    const head = `Fixed${num(ctx.rate) ? ' ' + pct(+ctx.rate) : ''}${until}`;
    if (R.kind === 'refix') return `${head}, then a ${years(+R.termMonths || 24)} fix at market ${num(R.margin) ? signed(+R.margin) : '+ the usual margin'}`;
    if (R.kind === 'manual') return `${head}, then ${num(R.manualRate) ? pct(+R.manualRate) : 'a rate you set'}`;
    if (R.kind === 'close') return `${head}, then paid out as cash`;
    return `${head}, then variable: ${follow(model)}`;
  }

  // ---------- the data pipeline's checks (3.3), also run by the app on what it loads ----------
  function validate(curve, prev) {
    const errors = [];
    if (!curve || typeof curve !== 'object') return { ok: false, errors: ['not a curve'] };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(curve.asOf || ''))) errors.push('no as-at date');
    const se = curve.shortEnd || {};
    const all = [['short-end forward', se.forward], ['short-end spot', se.spot], ['long forward', (curve.long || {}).forward], ['long spot', (curve.long || {}).spot]];
    for (const [name, arr] of all) {
      if (!Array.isArray(arr) || !arr.length) { errors.push(`${name}: missing`); continue; }
      if (arr.some(v => !num(v))) errors.push(`${name}: ${arr.filter(v => !num(v)).length} point(s) missing`);
      const bad = arr.filter(v => num(v) && (+v < -1 || +v > 15));
      if (bad.length) errors.push(`${name}: ${bad.length} rate(s) outside −1% to 15%`);
    }
    if (Array.isArray(se.forward) && se.forward.length < 60) errors.push(`short-end forward: ${se.forward.length} of 60 months`);
    const lg = curve.long || {};
    if (Array.isArray(lg.forward) && (!Array.isArray(lg.tenorsYears) || lg.tenorsYears.length !== lg.forward.length)) errors.push('long end: tenors and rates differ in length');
    if (prev && prev.asOf && curve.asOf && curve.asOf < prev.asOf) errors.push(`dated ${curve.asOf}, older than the last good curve (${prev.asOf})`);
    const s = curve.anchors && curve.anchors.sonia, f1 = se.forward && se.forward[0];
    if (num(s) && num(f1) && Math.abs(+f1 - +s) > 0.5) errors.push(`1-month forward ${(+f1).toFixed(2)}% is more than 0.5 points from SONIA ${(+s).toFixed(2)}%`);
    return { ok: !errors.length, errors };
  }
  // How old the curve is: amber after 10 business days, red after 30 days.
  function businessDays(from, to) {
    let n = 0; const d = new Date(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
    for (d.setUTCDate(d.getUTCDate() + 1); d.getTime() <= end; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w !== 6) n++; }
    return n;
  }
  function staleness(asOf, today) {
    if (!asOf) return { level: 'none', days: null, business: null };
    const days = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(asOf + 'T00:00:00Z')) / 864e5), business = businessDays(asOf, today);
    return { level: days > 30 ? 'red' : business > 10 ? 'amber' : 'ok', days, business };
  }

  // ---------- calibration from history (Step 5) ----------
  // How much of each Bank Rate move a savings rate passes on, and how late: for each lag 0..maxLag, a straight
  // line through retail(t) against Bank Rate(t − lag), month by month; the lag that fits best wins. A suggestion
  // only - the screen shows it and never applies it by itself.
  function estimatePassThrough(bank, retail, maxLag = 6) {
    const B = Object.fromEntries(bank.map(x => [x.month, +x.rate])), best = { r2: -Infinity };
    for (let lag = 0; lag <= maxLag; lag++) {
      const pairs = retail.map(x => [B[keyMonth(monthKey(x.month) - lag)], +x.rate]).filter(([b, r]) => num(b) && num(r));
      if (pairs.length < 6) continue;
      const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
      const sxx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0), sxy = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0), syy = pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0);
      if (!sxx || !syy) continue;
      const b = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy);
      if (r2 > best.r2 + 1e-12) Object.assign(best, { passThrough: b, lagMonths: lag, intercept: my - b * mx, r2, n });
    }
    return best.r2 === -Infinity ? null : best;
  }

  return { aer, ccOf, monthlyFactor, compile, knotsOf, integral, fwd, monthRateCC, termRateCC, spotCC, KINDS, DEFAULTS, forScenario, timeOf, expectedBankRate,
    marginFor, TYPICAL, path, defaultModel, describe, validate, staleness, businessDays, estimatePassThrough, monthKey, keyMonth };
})();

if (typeof module !== 'undefined') module.exports = TallyCurves;
