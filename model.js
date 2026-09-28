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
const TallyModel = (() => {
  const VERSION = 2;
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
    for (const f of d.flows) { f.start ??= null; f.end ??= null; f.bundle ??= null; f.on ??= true; f.inflates ??= false; f.growth ??= 0; }
    (d.accounts || []).forEach(defaultAccess);
    const r = d.rules ||= {};
    const who = isaPeople(d);
    r.isaPerPerson ??= ISA_PER_PERSON;
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

  return { VERSION, JOINT, ISA_PER_PERSON, ACCESS, LIABILITIES, migrate, fromV1, flowActive, monthKey, isaPeople, month };
})();

if (typeof module !== 'undefined') module.exports = TallyModel;
