// ================= Tally data model =================
// The shape of the finance file, and how older files are upgraded to it. Pure functions, no DOM,
// tested in node (tests/migration.test.js). engine.js only ever sees the current version.
//
// Version 2 (Sep 2026):
//   flows[]  - replaces income[], spending[] and events[]. One list of money in and out, each able to
//              start and stop on a month: {id, name, kind:'income'|'spend'|'oneoff', amount, start, end,
//              category, owner, inflates, growth, bundle, on, linked?, settles?}
//              income/spend amounts are MONTHLY and positive; a oneoff is the total, signed (− = out).
//              start/end are 'YYYY-MM' or null (open-ended). A oneoff happens in its start month.
//   accounts[].access - how quickly the money can be used: instant | notice | fixed | invested | locked,
//              with noticeDays (notice) and maturity 'YYYY-MM' (fixed). Liabilities have none.
//   accounts[].flexible - cash ISAs only: money taken out can go back in the same tax year.
//   rules.isaPerPerson, rules.isaUsedBy {personId: £}, rules.isaFillOrder [personIds]
//              - replaces the household isaAllowance / isaUsed. Top-ups fill the first person's
//              allowance, then the next. The Joint person never holds an ISA.
//
// Version 3 (Sep 2026):
//   bundles[] - life events: {id, name, template, start:'YYYY-MM', on, scale, contingency, note?}.
//              Their lines are ordinary flows carrying `bundle: id`, with real dates. A bundle that is
//              off removes all its lines; `scale` multiplies every line; `contingency` (%) is added to
//              its costs. effectiveFlows() is the one place those three are applied.
//              An income line in a bundle may be NEGATIVE: that is how a drop in pay (parental leave, a
//              sabbatical) is written, so switching the event off gives the usual pay back untouched.
//
// Version 4 (Sep 2026):
//   rules.remortgage - remortgage planning settings: {leadMonths, decideMonths, earmarkMonths, warnAt,
//              glide, glideMonths, target}. See readiness() in engine.js.
//
// Version 5 (Sep 2026):
//   remortgageOptions[] - deals being weighed up for a mortgage part (see amortise() in engine.js).
//   scenarios[k].option - the option this scenario assumes is taken (null = the part's own rate after the fix).
//   scenarios[k].bundles - {bundleId: true|false} life events this scenario switches on or off; absent = as the event is set.
//   scenarios[k].rateShift - percentage points added to tracker rates and rates after a new fix, in this scenario.
//   A scenario is therefore a whole plan: assumptions + which events + which remortgage option.
//
// Version 6 (Sep 2026):
//   flows[].overrides - {'YYYY-MM': amount} months set by hand in the cash-flow calendar. The figure is that
//              month's actual amount: no inflation or pay rise is applied on top of it.
//
// Version 7 (Sep 2026):
//   transactions[] - imported from bank CSVs (see transactions.js): {id, account, date, amount (− = out), description,
//              merchant, bankCategory, category? (only when set by hand), source, batch}
//   imports[] - {id, at, account, format, count, from, to}: one per import, so an import can be undone as a whole.
//   categoryRules[] - {id, contains, category, min?, max?, account?}: first match wins.
//   categoryMap - {bankCategory: category}: what a bank's own category (Amex gives one) means in the budget.
//
// Version 8 (Sep 2026):
//   goals[] - {id, name, target, date:'YYYY-MM', accounts:[ids]} (see goalStatus in analysis.js).
//   snapshots[].contrib - {accountId: £} paid into an S&S ISA or pension since the update before, so growth
//              can be told apart from money put in.
//
// Version 9 (Sep 2026):
//   snapshots[] may hold ANY subset of accounts: each account has its own dated balances, and the engine works
//              out the rest (balanceOn in engine.js). An older build would read a one-account update as the whole
//              position and drop every other account - hence the bump.
//   transactions[].kind - for money entered by hand: 'in' | 'out' | 'interest' (interest or dividends paid in).
//   reviews - {'accountId|from|to': {status:'ok'|'checked', at, note}}: a gap in the checks marked as looked at.
//   rules.checks - {abs, pct}: a gap between two balances is material above max(abs £, pct % of the balance).
//
// Version 10 (Sep 2026):
//   accounts[].rates - [{from:'YYYY-MM-DD'|null, rate}]: the account's interest (or expected return) over time.
//              `from: null` is the rate before any dated change. A change applies from its date on and never
//              touches the periods before it. accounts[].rate is kept equal to the rate in force today, for display.
//              rateOn() and growthFactor() are the only readers.
//
// Version 11 (Sep 2026): market rates (curves.js, docs/YIELD_CURVES.md)
//   accounts[].rateModel, mortgage.parts[].rateModel - optional: {kind:'variable'|'tracker'|'fixed', passThrough,
//              lagMonths, floor, spread, rollover:{kind:'refix'|'variable'|'manual'|'close', termMonths, margin, manualRate}}.
//              With one, the projection follows the scenario's rate path; without, the item keeps its own entered
//              rates exactly as before. The current rate is still the account's `rates` (or the part's `rate`), a
//              fixed account's fix end its `maturity` (the part's `fixEnd`), and a part's rate after the fix `newRate`.
//   scenarios[k].rates - {kind:'market'|'shift'|'twist'|'flat'|'anchor'|'manual'|'history', ...its settings}.
//   rateBasis - {source, asOf, curve, previous?}: the Bank of England curve this file's projections use, kept in the
//              file so any projection can be re-run offline and "as at" the curve it was made with. Public data.
const TallyModel = (() => {
  const VERSION = 11;
  const REMORTGAGE = { leadMonths: 6, decideMonths: 2, earmarkMonths: 12, warnAt: 5000, glide: false, glideMonths: 12, target: null };
  const JOINT = 'J';
  const ISA_PER_PERSON = 20000;
  const ACCESS = { instant: 'Instant access', notice: 'Notice account', fixed: 'Fixed term', invested: 'Invested', locked: 'Locked away' };
  const LIABILITIES = new Set(['card', 'card_0', 'tax']);
  const DEFAULT_ACCESS = { current: 'instant', savings: 'instant', cash_isa: 'instant', ss_isa: 'invested', pension: 'locked' };

  const month = d => (d ? String(d).slice(0, 7) : null); // '2026-10-01' → '2026-10'
  const clone = o => JSON.parse(JSON.stringify(o));
  const isaPeople = d => {
    const ids = (d.people || []).map(p => p.id).filter(id => id !== JOINT);
    return ids.length ? ids : ['M'];
  };

  function defaultAccess(a) {
    if (LIABILITIES.has(a.type)) { delete a.access; return a; }
    if (!Array.isArray(a.rates) || !a.rates.length) a.rates = [{ from: null, rate: +a.rate || 0 }];
    if (!ACCESS[a.access]) a.access = DEFAULT_ACCESS[a.type] || 'instant';
    if (a.type === 'cash_isa' && a.flexible == null) a.flexible = true;
    return a;
  }

  // v1 → v2. Never changes the object it is given: the caller keeps the original until it saves.
  function fromV1(src) {
    const d = clone(src);
    const flows = [];
    for (const i of d.income || []) flows.push({
      id: i.id || 'inc-' + flows.length, name: i.name || 'Income', kind: 'income', amount: +i.monthly || 0,
      start: null, end: null, category: 'Income', owner: i.owner || null, inflates: false, growth: +i.growth || 0, bundle: null, on: true,
    });
    for (const s of d.spending || []) {
      const f = {
        id: s.id || 'sp-' + flows.length, name: s.name || 'Spending', kind: 'spend', amount: (+s.annual || 0) / 12,
        start: null, end: null, category: s.category || 'Other', owner: null, inflates: !!s.inflates, growth: 0, bundle: null, on: true,
      };
      if (s.linked) f.linked = s.linked;
      flows.push(f);
    }
    for (const e of d.events || []) {
      const f = {
        id: e.id || 'ev-' + flows.length, name: e.name || 'Item', kind: 'oneoff', amount: +e.amount || 0,
        start: month(e.date), end: month(e.date), category: e.amount < 0 ? 'One-off' : 'Receipt', owner: null, inflates: false, growth: 0, bundle: null, on: e.on !== false,
      };
      if (e.settles) f.settles = e.settles;
      flows.push(f);
    }
    delete d.income; delete d.spending; delete d.events;
    d.flows = flows;

    // Household ISA allowance → per person. Split so the total is exactly what it was, and put what
    // was already paid in against people in fill order - the same rule the projection now follows.
    const r = d.rules = d.rules || {};
    const who = isaPeople(d);
    const household = r.isaAllowance != null ? +r.isaAllowance : ISA_PER_PERSON * who.length;
    r.isaPerPerson = household / who.length;
    let used = +r.isaUsed || 0; r.isaUsedBy = {};
    for (const p of who) { const u = Math.min(used, r.isaPerPerson); r.isaUsedBy[p] = u; used -= u; }
    if (used > 0) r.isaUsedBy[who[who.length - 1]] += used; // over-reported: keep it, don't lose it
    r.isaFillOrder = who.slice();
    delete r.isaAllowance; delete r.isaUsed;

    d.version = 2;
    return d;
  }

  // Any version → current. Safe to run on a file that is already current (it only fills gaps).
  function migrate(src) {
    if (!src || typeof src !== 'object') return src;
    const d = (+src.version || 1) < 2 ? fromV1(src) : clone(src);
    d.flows ||= [];
    d.bundles ||= [];
    d.remortgageOptions ||= [];
    d.goals ||= [];
    d.reviews ||= {};
    d.transactions ||= []; d.imports ||= []; d.categoryRules ||= []; d.categoryMap ||= {};
    for (const k in d.scenarios || {}) { const sc = d.scenarios[k]; sc.option ??= null; sc.bundles ||= {}; sc.rateShift ??= 0; sc.rates ||= { kind: 'market' }; }
    d.rateBasis ??= null;
    for (const b of d.bundles) { b.on ??= true; b.scale ??= 1; b.contingency ??= 0; }
    for (const f of d.flows) { f.start ??= null; f.end ??= null; f.bundle ??= null; f.on ??= true; f.inflates ??= false; f.growth ??= 0; }
    (d.accounts || []).forEach(defaultAccess);
    const r = d.rules ||= {};
    const who = isaPeople(d);
    r.isaPerPerson ??= ISA_PER_PERSON;
    r.remortgage = Object.assign({}, REMORTGAGE, r.remortgage || {});
    r.checks = Object.assign({ abs: 100, pct: 1 }, r.checks || {});
    r.isaUsedBy ||= {};
    // fill order: keep the saved order, drop anyone who no longer exists, add anyone new at the end
    r.isaFillOrder = (r.isaFillOrder || []).filter(p => who.includes(p));
    for (const p of who) if (!r.isaFillOrder.includes(p)) r.isaFillOrder.push(p);
    d.version = VERSION;
    return d;
  }

  const monthKey = m => { const [y, mm] = String(m).split('-').map(Number); return y * 12 + mm - 1; };
  // Is this flow counted in the month with key k (year × 12 + month − 1)?
  function flowActive(f, k) {
    if (f.on === false) return false;
    if (f.kind === 'oneoff' && !f.start) return false; // a one-off with no month never happens
    if (f.start && k < monthKey(f.start)) return false;
    if (f.end && k > monthKey(f.end)) return false;
    return true;
  }

  // The flows the projection should use: life events that are off are dropped, and each event's
  // scale and contingency applied. Flows not in an event (or in one that no longer exists) pass through.
  // A scenario (optional) can switch an event on or off for itself; otherwise the event's own switch decides.
  const bundleOn = (b, sc) => (sc && sc.bundles && sc.bundles[b.id] != null ? !!sc.bundles[b.id] : b.on !== false);
  function effectiveFlows(d, sc) {
    const by = Object.fromEntries((d.bundles || []).map(b => [b.id, b]));
    const out = [];
    for (const f of d.flows || []) {
      const b = f.bundle && by[f.bundle];
      if (!b) { out.push(f); continue; }
      if (!bundleOn(b, sc)) continue;
      const cost = f.kind === 'spend' || (f.kind === 'oneoff' && f.amount < 0);
      const k = (+b.scale || 0) * (cost ? 1 + (+b.contingency || 0) / 100 : 1);
      if (k === 1) { out.push(f); continue; }
      const g = { ...f, amount: (+f.amount || 0) * k };
      if (f.overrides) g.overrides = Object.fromEntries(Object.entries(f.overrides).map(([m, v]) => [m, (+v || 0) * k]));
      out.push(g);
    }
    return out;
  }
  // Move a month string by n months: shiftMonth('2026-11', 3) → '2027-02'
  const shiftMonth = (m, n) => { if (!m) return m; const k = monthKey(m) + n; return `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`; };
  // Move a whole life event: its start and every line's dates, by the same number of months.
  function shiftBundle(d, id, n) {
    const b = (d.bundles || []).find(x => x.id === id); if (!b || !n) return;
    b.start = shiftMonth(b.start, n);
    for (const f of d.flows) if (f.bundle === id) { f.start = shiftMonth(f.start, n); f.end = shiftMonth(f.end, n); }
  }
  // First and last month an event touches (last is null if something in it never ends)
  function bundleSpan(d, id) {
    const fl = d.flows.filter(f => f.bundle === id);
    if (!fl.length) return null;
    const starts = fl.map(f => f.start).filter(Boolean).sort();
    const open = fl.some(f => !f.end);
    const ends = fl.map(f => f.end).filter(Boolean).sort();
    return { from: starts[0] || null, to: open ? null : ends.at(-1) };
  }

  // ---------- interest rates over time ----------
  const sortedRates = a => (Array.isArray(a.rates) && a.rates.length ? a.rates.slice().sort((x, y) => (x.from || '').localeCompare(y.from || '')) : [{ from: null, rate: +a.rate || 0 }]);
  // The rate in force on a date ('YYYY-MM-DD' or 'YYYY-MM'): the latest change on or before it.
  function rateOn(a, date) {
    const d = String(date).length === 7 ? date + '-01' : String(date);
    let r = null; for (const x of sortedRates(a)) if (!x.from || x.from <= d) r = +x.rate || 0;
    return r == null ? +sortedRates(a)[0].rate || 0 : r;
  }
  // What £1 on d1 grows to by d2, compounding daily over 365 at whatever rate was in force on each day.
  function growthFactor(a, d1, d2) {
    const dn = d => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') / 864e5;
    if (d2 <= d1) return 1;
    const cuts = sortedRates(a).map(x => x.from).filter(f => f && f > d1 && f < d2);
    const pts = [d1, ...cuts, d2]; let g = 1;
    for (let i = 1; i < pts.length; i++) g *= Math.pow(1 + rateOn(a, pts[i - 1]) / 100, (dn(pts[i]) - dn(pts[i - 1])) / 365);
    return g;
  }

  return { VERSION, REMORTGAGE, rateOn, growthFactor, bundleOn, effectiveFlows, shiftMonth, shiftBundle, bundleSpan, JOINT, ISA_PER_PERSON, ACCESS, LIABILITIES, migrate, fromV1, flowActive, monthKey, isaPeople, month };
})();

if (typeof module !== 'undefined') module.exports = TallyModel;
