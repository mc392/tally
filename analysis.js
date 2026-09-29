// ================= Tally analysis (Phases 3 and 4) =================
// Pure: no DOM. Built on engine.js and model.js. Tested in node (tests/analysis.test.js).
//   realValue       - today's money (3.4)
//   isaYear         - ISA allowance per person this tax year (3.3)
//   goalStatus      - is a goal on track (3.2)
//   attribution     - where a change in net worth came from, and returns (3.1)
//   stressed        - one-tap shocks (4.2)
//   monteCarlo      - a range of outcomes (4.1), seeded so it can be tested and repeated
//   comparePlans    - plans run side by side, and every figure the comparison charts draw (Sep 2026)
const TallyAnalysis = (() => {
  const E = typeof project !== 'undefined' ? { project, latestSnapshot, snapshotTotals, readiness, mortgageParts, positionOn, observations, balanceOn, availableSeries, partType } : require('./engine.js');
  const M = typeof TallyModel !== 'undefined' ? TallyModel : require('./model.js');
  const LIAB = new Set(['card_0', 'tax']); // everyday credit cards sit with cash, as in the projection
  const INVEST = new Set(['ss_isa', 'pension']);
  const snapK = d => M.monthKey(d.slice(0, 7));
  const keyDate = k => `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}-01`;

  // ---------- 3.4 real terms ----------
  // A projected month-end figure in today's money: deflated by the scenario's inflation, compounded
  // monthly from the start of the projection (month k0) to the end of month k.
  const realValue = (v, k, k0, inflationPct) => v / Math.pow(1 + (+inflationPct || 0) / 100, (k - k0 + 1) / 12);

  // ---------- 3.3 ISA allowance this tax year ----------
  // For each person: the allowance, what is recorded as paid in, what the projection plans to pay in by
  // 5 April, and what would be left unused. Re-deposit room (flexible ISA withdrawals that can go back in)
  // is shown separately. `nudge` is true in February and March when allowance would go unused.
  function isaYear(data, sk, today) {
    const [y, m] = today.split('-').map(Number), ty = m >= 4 ? y : y - 1;
    const r = data.rules, per = +r.isaPerPerson || 0, who = r.isaFillOrder || [];
    const snap = E.latestSnapshot(data); if (!snap) return null;
    const k0 = snapK(snap.date), endK = M.monthKey(`${ty + 1}-03`);
    const rows = endK >= k0 ? E.project(data, sk, endK - k0 + 1).rows : [];
    const last = rows.find(x => x.k === endK);
    const people = who.map(p => {
      const used = +r.isaUsedTaxYear === ty ? +(r.isaUsedBy || {})[p] || 0 : 0;
      const left = last ? last.freshBy[p] : Math.max(0, per - used);
      return { person: p, allowance: per, used, planned: Math.max(0, per - used - left), left };
    });
    return { taxYear: ty, people, redeposit: last ? last.replEnd : 0, nudge: (m === 2 || m === 3) && people.some(x => x.left > 0.5), months: rows.length };
  }

  // ---------- 3.2 goals ----------
  // A goal: {id, name, target, date:'YYYY-MM', accounts:[ids]}. Its projected value at a month: accounts
  // the projection tracks on their own are read directly; accounts in a pool (cash, instant cash ISAs,
  // S&S ISAs) take their share of the pool, by today's balances.
  function goalValueAt(data, row, snap, goal) {
    const T = E.snapshotTotals(data, snap), bal = id => +snap.balances[id] || 0;
    const pools = { cash: ['current', 'card'], ss: ['ss_isa'], cisa: ['cash_isa'] };
    const pooled = (a, key, projected) => {
      const members = data.accounts.filter(x => pools[key].includes(x.type) && !(x.id in row.accounts));
      const tot = members.reduce((s, x) => s + bal(x.id), 0);
      return tot ? projected * bal(a.id) / tot : projected / (members.length || 1);
    };
    let v = 0;
    for (const id of goal.accounts || []) {
      const a = data.accounts.find(x => x.id === id); if (!a) continue;
      if (id in row.accounts) v += row.accounts[id];
      else if (pools.cash.includes(a.type)) v += pooled(a, 'cash', row.closing);
      else if (a.type === 'ss_isa') v += pooled(a, 'ss', row.isaSS);
      else if (a.type === 'cash_isa') v += pooled(a, 'cisa', row.isaCashFlex);
    }
    return v;
  }
  function goalStatus(data, sk, goal, today) {
    const snap = E.latestSnapshot(data); if (!snap) return null;
    const k0 = snapK(snap.date), gk = M.monthKey(goal.date), months = Math.max(gk - k0 + 1, 120);
    const rows = E.project(data, sk, months).rows;
    const now = (goal.accounts || []).reduce((s, id) => s + (+snap.balances[id] || 0), 0);
    const atRow = rows.find(r => r.k === gk) || rows.at(-1);
    const atDate = gk < k0 ? now : goalValueAt(data, atRow, snap, goal);
    const reached = rows.find(r => goalValueAt(data, r, snap, goal) >= goal.target);
    const monthsLeft = Math.max(1, gk - (today ? M.monthKey(today) : k0));
    const onTrack = atDate >= goal.target;
    return { goal, now, atDate, onTrack, reached: reached ? reached.date : null, shortfall: Math.max(0, goal.target - atDate),
      extraPerMonth: onTrack ? 0 : (goal.target - atDate) / monthsLeft, progress: goal.target ? Math.min(1, now / goal.target) : 0 };
  }

  // ---------- 3.1 where the change came from ----------
  // Between two balance updates. Every account's change is put in one of four piles, which add up to the
  // change in net worth exactly:
  //   growth    - S&S ISAs and pensions: change less what was paid in (entered on the update, snapshots[].contrib)
  //   interest  - savings and cash ISAs: average balance × the account's rate × the time between
  //   debt      - 0% cards and tax owed: what they went down by
  //   saved     - everything else: money put in (or taken out) - current accounts, cards, and the rest of
  //               savings after interest. Paying off a debt from cash shows here as negative, with the same
  //               amount under debt, so it nets to nothing - which is what it does to net worth.
  // A money-weighted return per investment account (Modified Dietz: contributions assumed mid-period), annualised.
  function attribution(data, date1, date2) {
    if (!data.snapshots.some(s => s.date === date1) || !data.snapshots.some(s => s.date === date2)) return null;
    // every account as it stood on each date - entered or worked out - so an update of one account still compares like with like
    const s1 = E.positionOn(data, date1), s2 = { ...E.positionOn(data, date2), contrib: (data.snapshots.find(s => s.date === date2) || {}).contrib };
    const flows = id => (data.transactions || []).filter(t => t.account === id && t.date > date1 && t.date <= date2);
    const recorded = id => flows(id).filter(t => t.kind !== 'interest').reduce((s, t) => s + t.amount, 0);
    const days = (Date.parse(date2) - Date.parse(date1)) / 864e5, years = days / 365.25;
    const out = { from: date1, to: date2, days, saved: 0, growth: 0, interest: 0, debt: 0, accounts: [] };
    for (const a of data.accounts) {
      const v1 = s1.balances[a.id], v2 = s2.balances[a.id];
      if (v1 == null && v2 == null) continue;
      const b1 = +v1 || 0, b2 = +v2 || 0, d = b2 - b1, row = { id: a.id, name: a.name, type: a.type, change: d };
      if (INVEST.has(a.type)) {
        // paid in: anything recorded as money in or out (not dividends, which are growth), plus the older per-update figure
        const C = (+((s2.contrib || {})[a.id]) || 0) + recorded(a.id);
        row.paidIn = C; row.growth = d - C; out.growth += d - C; out.saved += C;
        const base = b1 + 0.5 * C;
        if (base > 0 && years > 0) { row.return = (d - C) / base; row.annual = Math.pow(1 + row.return, 1 / years) - 1; }
      } else if (a.type === 'savings' || a.type === 'cash_isa') {
        // with money in or out recorded, interest is what is left of the change; without, it is estimated from the rate
        const f = flows(a.id), i = f.length ? d - recorded(a.id) : (b1 + b2) / 2 * (M.growthFactor(a, date1, date2) - 1);
        row.interest = i; out.interest += i; out.saved += d - i;
      } else if (LIAB.has(a.type)) { row.debt = d; out.debt += d; }
      else out.saved += d;
      out.accounts.push(row);
    }
    out.change = E.snapshotTotals(data, s2).net - E.snapshotTotals(data, s1).net;
    return out;
  }

  // ---------- 4.2 stress tests ----------
  const clone = o => JSON.parse(JSON.stringify(o));
  const next = (k, n) => keyDate(k + n).slice(0, 7);
  const STRESSES = {
    markets: { name: 'Markets fall 25% next month', build: (d) => ({ data: d, opts: { ssShock: -25 } }) },
    bonus: { name: 'No bonus', blurb: 'One-off money in, and any income called “bonus”, doesn’t arrive',
      build: d => { d.flows = d.flows.filter(f => !(f.kind === 'oneoff' && f.amount > 0) && !(f.kind === 'income' && /bonus/i.test(f.name))); return { data: d }; } },
    rates: { name: 'Rates +2% at the remortgage', blurb: 'Every rate after a fix, and every deal, 2 points higher',
      build: (d, sk) => { for (const p of d.mortgage.parts) if (p.newRate != null && p.newRate !== '') p.newRate = +p.newRate + 2; d.scenarios[sk].rateShift = (+d.scenarios[sk].rateShift || 0) + 2; return { data: d }; } },
    income: { name: 'The biggest income stops for 6 months', blurb: 'From next month',
      build: (d, sk, k0) => {
        const live = d.flows.filter(f => f.kind === 'income' && !f.bundle && M.flowActive(f, k0 + 1)).sort((a, b) => b.amount - a.amount)[0];
        if (live) { live.overrides ||= {}; for (let n = 1; n <= 6; n++) live.overrides[next(k0, n)] = 0; }
        return { data: d, detail: live ? live.name : null };
      } },
    cost: { name: 'A £10,000 unexpected cost next month',
      build: (d, sk, k0, amount = 10000) => { d.flows.push({ id: 'stress-cost', name: 'Unexpected cost', kind: 'oneoff', amount: -Math.abs(amount), start: next(k0, 1), end: next(k0, 1), on: true, bundle: null }); return { data: d }; } },
  };
  // A stress test against the plan as it stands: cash-floor breaches, the lowest cash month, and what's
  // available to overpay at the next fix end, before and after.
  function stressed(data, sk, kind, months = 60, today) {
    const snap = E.latestSnapshot(data); if (!snap) return null;
    const k0 = snapK(snap.date), s = STRESSES[kind];
    const run = (d, opts) => {
      const rows = E.project(d, sk, months, opts).rows, floor = +d.rules.cashFloor || 0;
      const breaches = rows.filter(r => r.shortfall > 0.5).length, low = rows.reduce((b, r) => r.closing < b.closing ? r : b, rows[0]);
      const R = E.readiness(d, sk, today);
      return { breaches, lowest: low.closing, lowestMonth: low.date, net: rows.at(-1).net, available: R.none ? null : R.available, invested: R.none ? null : R.ladder.invested, rows };
    };
    const base = run(data);
    const built = s.build(clone(data), sk, k0);
    const after = built.opts && built.opts.ssShock ? runShock(built.data, sk, months, built.opts, today) : run(built.data, built.opts);
    return { kind, name: s.name, blurb: s.blurb || '', detail: built.detail || null, base, after };
  }
  // readiness() runs its own projection, so a market shock is applied by scaling the S&S balance in the
  // update itself - the same thing as the shock in month one.
  function runShock(d, sk, months, opts, today) {
    const snap = E.latestSnapshot(d), dd = clone(d);
    const s = dd.snapshots.find(x => x.date === snap.date);
    for (const a of dd.accounts) if (a.type === 'ss_isa' && s.balances[a.id] != null) s.balances[a.id] *= 1 + opts.ssShock / 100;
    const rows = E.project(dd, sk, months).rows, low = rows.reduce((b, r) => r.closing < b.closing ? r : b, rows[0]);
    const R = E.readiness(dd, sk, today);
    return { breaches: rows.filter(r => r.shortfall > 0.5).length, lowest: low.closing, lowestMonth: low.date, net: rows.at(-1).net, available: R.none ? null : R.available, invested: R.none ? null : R.ladder.invested, rows };
  }

  // ---------- 4.1 a range of outcomes ----------
  // `paths` simulated futures, each with its own monthly S&S returns drawn from a normal distribution with
  // the scenario's mean (ssReturn a year when growth is on, otherwise 0) and `vol` % a year of volatility.
  // Seeded (mulberry32 + Box-Muller) so the same inputs always give the same answer.
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function normals(rand) { let spare = null; return () => { if (spare != null) { const s = spare; spare = null; return s; } let u = 0, v = 0; while (u === 0) u = rand(); v = rand(); const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); }; }
  const pct = (sorted, p) => { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  function monteCarlo(data, sk, { paths = 2000, vol = 15, months = 60, seed = 1, target = null, today } = {}) {
    const sc = data.scenarios[sk], mean = (sc.growth ? +sc.ssReturn || 0 : 0) / 100 / 12, sd = (+vol || 0) / 100 / Math.sqrt(12);
    const draw = normals(rng(seed)), floor = +data.rules.cashFloor || 0;
    const R = E.readiness(data, sk, today), atK = R.none ? null : M.monthKey(R.atDate.slice(0, 7));
    const nets = Array.from({ length: months }, () => []), avail = [];
    let breach = 0, belowTarget = 0;
    for (let p = 0; p < paths; p++) {
      const ret = Array.from({ length: months }, () => Math.max(-0.99, mean + sd * draw()));
      const rows = E.project(data, sk, months, { ssReturns: ret }).rows;
      rows.forEach((r, i) => nets[i].push(r.net));
      if (rows.some(r => r.shortfall > 0.5)) breach++;
      if (atK != null) {
        const r = rows.find(x => x.k === atK);
        if (r) { const a = r.byAccess.instant + r.byAccess.notice - floor - R.earmarks; avail.push(a); if (target != null && a < target) belowTarget++; }
      }
    }
    const band = nets.map(v => { const s = v.slice().sort((a, b) => a - b); return { p10: pct(s, 0.1), p50: pct(s, 0.5), p90: pct(s, 0.9) }; });
    const endS = nets.at(-1).slice().sort((a, b) => a - b), avS = avail.slice().sort((a, b) => a - b);
    const base = E.project(data, sk, months).rows;
    return { paths, vol, months, band, dates: base.map(r => r.date), pBreach: breach / paths, pBelowTarget: target != null && avail.length ? belowTarget / paths : null,
      end: { p10: pct(endS, 0.1), p50: pct(endS, 0.5), p90: pct(endS, 0.9) }, available: avS.length ? { p10: pct(avS, 0.1), p50: pct(avS, 0.5), p90: pct(avS, 0.9) } : null, target };
  }

  // ---------- checks: is every move between two balances explained? ----------
  // For each account, each gap between two balances entered for it:
  //   current accounts and cards with transactions - the change should equal the transactions in between
  //   savings and cash ISAs - the first balance grown at the rate, plus money in and out, should give the second
  //   S&S ISAs and pensions - the change less money paid in is the market's doing: an implied return to cross-check
  // A gap is material above max(rules.checks.abs, rules.checks.pct % of the balance). Marking one as looked at is
  // stored in data.reviews, keyed by the account and both dates, so a new balance in between asks again.
  const TXN = new Set(['current', 'card']), INT = new Set(['savings', 'cash_isa']);
  function checks(data) {
    const ck = (data.rules && data.rules.checks) || { abs: 100, pct: 1 }, out = [];
    const dn = d => Date.parse(d + 'T00:00:00Z') / 864e5;
    for (const a of data.accounts) {
      const obs = E.observations(data, a.id), tx = (data.transactions || []).filter(t => t.account === a.id);
      for (let i = 1; i < obs.length; i++) {
        const o1 = obs[i - 1], o2 = obs[i], change = o2.v - o1.v, inGap = tx.filter(t => t.date > o1.date && t.date <= o2.date);
        const key = `${a.id}|${o1.date}|${o2.date}`, review = (data.reviews || {})[key] || null;
        const limit = Math.max(+ck.abs || 0, (+ck.pct || 0) / 100 * Math.max(Math.abs(o1.v), Math.abs(o2.v)));
        const item = { key, account: a.id, name: a.name, type: a.type, from: o1.date, to: o2.date, v1: o1.v, v2: o2.v, change, review, limit };
        if (TXN.has(a.type)) {
          if (!tx.length) continue; // an account never imported is not being tracked by transaction
          const explained = inGap.reduce((s, t) => s + t.amount, 0);
          Object.assign(item, { kind: 'missing', explained, unexplained: change - explained, count: inGap.length });
        } else if (INT.has(a.type)) {
          const grow = (v, d) => v * M.growthFactor(a, d, o2.date); // at the rate in force on each day
          const moved = inGap.filter(t => t.kind !== 'interest'), expectedEnd = grow(o1.v, o1.date) + moved.reduce((s, t) => s + grow(t.amount, t.date), 0);
          const interest = expectedEnd - o1.v - moved.reduce((s, t) => s + t.amount, 0);
          Object.assign(item, { kind: 'missing', explained: expectedEnd - o1.v, interest, recorded: moved.reduce((s, t) => s + t.amount, 0), unexplained: o2.v - expectedEnd, count: moved.length });
        } else if (a.type === 'ss_isa' || a.type === 'pension') {
          const snap = data.snapshots.find(s => s.date === o2.date), C = (+((snap && snap.contrib) || {})[a.id] || 0) + inGap.filter(t => t.kind !== 'interest').reduce((s, t) => s + t.amount, 0);
          const market = change - C, base = o1.v + 0.5 * C, yrs = (dn(o2.date) - dn(o1.date)) / 365.25;
          const ret = base > 0 ? market / base : null;
          Object.assign(item, { kind: 'return', paidIn: C, market, return: ret, annual: ret != null && yrs > 0 ? Math.pow(1 + ret, 1 / yrs) - 1 : null, unexplained: market });
        } else continue;
        item.material = Math.abs(item.unexplained) > limit;
        item.open = item.material && !review;
        out.push(item);
      }
    }
    return out.sort((x, y) => y.to.localeCompare(x.to));
  }

  // ---------- ISA allowance over time (Oct 2026) ----------
  // Tax year by tax year (a tax year is named by the year it starts, 6 April): each person's allowance, what was
  // paid in before the projection starts (the Rules figure - this tax year only), what the projection tops up, and
  // what goes unused. Allowance cannot be carried forward, so "unused" is lost for good. Re-deposit room (money taken
  // out of a flexible ISA going back in) is not new allowance and is not counted as using it.
  const tyOfK = k => { const y = Math.floor(k / 12), m = k % 12 + 1; return m >= 4 ? y : y - 1; };
  function isaTimeline(data, sk, years = 5) {
    const r = data.rules || {}, per = +r.isaPerPerson || 0, who = r.isaFillOrder || [];
    const snap = E.latestSnapshot(data); if (!snap || !who.length) return null;
    const k0 = snapK(snap.date), ty0 = tyOfK(k0), endK = M.monthKey(`${ty0 + years}-03`);
    const rows = E.project(data, sk, endK - k0 + 1).rows;
    const out = [];
    for (let ty = ty0; ty < ty0 + years; ty++) {
      const yr = rows.filter(x => x.taxYear === ty); if (!yr.length) continue;
      const last = yr.at(-1), first = ty === ty0;
      const people = who.map(p => {
        const before = first && +r.isaUsedTaxYear === ty ? Math.min(per, +(r.isaUsedBy || {})[p] || 0) : 0;
        const start = per - before, left = Math.max(0, last.freshBy[p] ?? start);
        return { person: p, allowance: per, before, planned: Math.max(0, start - left), unused: left };
      });
      const allowance = per * who.length, before = people.reduce((s, x) => s + x.before, 0);
      let cum = before;
      const months = yr.map(x => { const inNew = Math.max(0, x.freshStart - x.freshEnd); cum += inNew; return { date: x.date, k: x.k, topUp: x.topUp, newAllowance: inNew, cumulative: cum, withdraw: x.withdraw }; });
      const planned = people.reduce((s, x) => s + x.planned, 0), unused = people.reduce((s, x) => s + x.unused, 0);
      const full = months.find(m => m.cumulative >= allowance - 0.5);
      // what would use it all: the unused amount spread over the months the projection has left in the year
      out.push({ taxYear: ty, label: `${ty}/${String(ty + 1).slice(2)}`, partial: first && k0 % 12 + 1 !== 4, allowance, before, planned, unused, used: before + planned,
        people, months, filledBy: full ? full.date : null, extraPerMonth: unused > 0.5 ? unused / months.length : 0 });
    }
    const pot = rows.map(x => ({ date: x.date, isa: x.isa, ss: x.isaSS, cash: x.isaCash }));
    return { years: out, pot, per, who, lost: out.reduce((s, y) => s + y.unused, 0), start: snap.date };
  }

  // ---------- the mortgage to the end of its term (Oct 2026) ----------
  // The household projection run to the last part's term end (capped at 40 years): the balance month by month, and
  // each calendar year's interest and repayment of what is owed (principal), so you can see the balance being paid
  // down, not just the payment going out. Interest-only parts flag the balance due at their term end.
  function mortgageSchedule(data, sk, maxMonths = 480) {
    const snap = E.latestSnapshot(data); if (!snap) return null;
    const parts = E.mortgageParts(data), k0 = snapK(snap.date);
    const ends = parts.map(p => (p.termEnd ? M.monthKey(M.month(p.termEnd)) : null)).filter(x => x != null);
    const months = Math.max(12, Math.min(maxMonths, ends.length ? Math.max(...ends) - k0 + 1 : 300));
    const rows = E.project(data, sk, months).rows;
    if (!rows.length || rows[0].mortgageBal == null) return { none: true };
    const years = {}; let totalInterest = 0, totalPrincipal = 0; const due = [];
    for (const x of rows) {
      const y = x.date.slice(0, 4), Y = years[y] ||= { year: +y, interest: 0, principal: 0, paid: 0, balance: 0, months: 0 };
      Y.interest += x.mortgageInterest; Y.principal += x.mortgagePrincipal || 0; Y.paid += x.mortgagePay; Y.balance = x.mortgageBal; Y.months++;
      totalInterest += x.mortgageInterest; totalPrincipal += x.mortgagePrincipal || 0;
      for (const p of x.mortgageParts) if (p.due) due.push({ date: x.date, part: p.id, name: p.name, amount: p.due });
    }
    const off = rows.find(x => x.mortgageBal < 0.5), n12 = rows.slice(0, 12);
    return {
      rows: rows.map(x => ({ date: x.date, k: x.k, bal: x.mortgageBal, pay: x.mortgagePay, interest: x.mortgageInterest, principal: x.mortgagePrincipal || 0, parts: x.mortgageParts.map(p => ({ id: p.id, bal: p.bal })) })),
      years: Object.values(years), start: rows[0].mortgageBal + (rows[0].mortgagePrincipal || 0), totalInterest, totalPrincipal,
      paidOff: off ? off.date : null, due, next12: { interest: n12.reduce((s, x) => s + x.mortgageInterest, 0), principal: n12.reduce((s, x) => s + (x.mortgagePrincipal || 0), 0) },
    };
  }

  // ---------- comparing plans (Sep 2026) ----------
  // Each plan run on its own over `months`, and the figures the comparison charts draw, so the screen only draws.
  // at: the row index the "at a date" charts read. All money is month-end; interest is a running total from the start.
  function comparePlans(data, keys, months, at = null) {
    const r = data.rules || {}, floor = +r.cashFloor || 0, em = +((r.remortgage || {}).earmarkMonths) || 12, home = +((data.mortgage || {}).propertyValue) || 0;
    const plans = keys.map(k => {
      const sc = data.scenarios[k], pr = E.project(data, k, months + em), rows = pr.rows.slice(0, months);
      const av = E.availableSeries(pr.rows, floor, em).slice(0, months), k0 = rows.length ? rows[0].k : 0;
      let int = 0, below = 0, low = { v: Infinity, date: null };
      const s = { head: [], thin: [], net: [], cash: [], isa: [], ss: [], cashIsa: [], other: [], mortgage: [], pay: [], interest: [], left: [], spend: [], income: [], real: [], clear: [], avail: av };
      for (const x of rows) {
        const mb = x.mortgageBal || 0; int += x.mortgageInterest || 0;
        s.net.push(x.net); s.cash.push(x.closing); s.isa.push(x.isa); s.ss.push(x.isaSS); s.cashIsa.push(x.isaCash); s.other.push(x.other);
        s.mortgage.push(mb); s.pay.push(x.mortgagePay || 0); s.interest.push(int); s.left.push(x.surplus); s.spend.push(x.spend); s.income.push(x.income);
        s.real.push(realValue(x.net, x.k, k0, sc.inflation)); s.clear.push(x.net - mb + home);
        // headroom: money you could reach within days (cash and instant-access cash ISAs) above the floor; thin when it
        // is under three months of that month's spending. The projection holds cash at the floor, so cash alone says nothing.
        s.head.push(x.closing + (x.isaCashFlex || 0) - floor); s.thin.push(3 * (x.spend || 0));
        if (x.closing < floor - 0.5) below++;
        if (x.closing < low.v) low = { v: x.closing, date: x.date };
      }
      // the moments worth marking: one-offs, and each month a mortgage payment changes by more than £1
      const marks = [];
      rows.forEach((x, i) => {
        for (const e of x.events || []) marks.push({ i, date: x.date, kind: 'oneoff', name: e.name, amount: +e.amount || 0 });
        if (i && Math.abs((x.mortgagePay || 0) - (rows[i - 1].mortgagePay || 0)) > 1) marks.push({ i, date: x.date, kind: 'mortgage', name: 'Mortgage payment changes', amount: (x.mortgagePay || 0) - (rows[i - 1].mortgagePay || 0) });
      });
      // ISA allowance over the same span: tax year by tax year, and a running total of allowance used against the
      // allowance there was, month by month (both from isaTimeline, so the two screens can never disagree)
      const isa = isaTimeline(data, k, Math.max(1, Math.ceil((months + 3) / 12)));
      const isaUsed = [], isaAvail = []; if (isa) {
        let doneUsed = 0, doneAvail = 0; const at = {};
        for (const y of isa.years) { for (const m of y.months) at[m.date] = [doneUsed + m.cumulative, doneAvail + y.allowance]; doneUsed += y.used; doneAvail += y.allowance; }
        let last = [0, 0]; for (const x of rows) { last = at[x.date] || last; isaUsed.push(last[0]); isaAvail.push(last[1]); }
      }
      s.isaUsed = isaUsed; s.isaAvail = isaAvail;
      return { k, name: sc.name, rows, s, below, low, marks, fixEndK: pr.fixEndK, isa };
    });
    const n = plans[0] ? plans[0].rows.length : 0, j = at == null ? n - 1 : Math.min(n - 1, Math.max(0, at));
    // at a date: what each plan holds, and each part of the difference from the first plan
    const mix = plans.map(P => ({ cash: P.s.cash[j], cashIsa: P.s.cashIsa[j], ss: P.s.ss[j], other: P.s.other[j], mortgage: -P.s.mortgage[j] }));
    const why = plans.slice(1).map((P, i) => { const a = mix[0], b = mix[i + 1]; const d = {}; for (const c in a) d[c] = b[c] - a[c]; d.total = Object.values(d).reduce((x, y) => x + y, 0); return d; });
    // the scorecard: one figure per plan per question, and which way is better
    const F = plans[0] && plans[0].fixEndK != null ? plans[0].rows.findIndex(x => x.k === plans[0].fixEndK - 1) : -1;
    const score = [
      { key: 'net', label: 'Net worth', better: 'high', vals: plans.map(P => P.s.net[j]) },
      { key: 'clear', label: home ? 'Net worth with your home' : 'Net worth less the mortgage', better: 'high', vals: plans.map(P => P.s.clear[j]) },
      { key: 'low', label: 'Lowest cash', better: 'high', vals: plans.map(P => P.low.v) },
      { key: 'below', label: 'Months below the cash floor', better: 'low', vals: plans.map(P => P.below), count: true },
      { key: 'interest', label: 'Mortgage interest paid', better: 'low', vals: plans.map(P => P.s.interest[j]) },
      { key: 'isaLost', label: 'ISA allowance lost', better: 'low', whole: true, vals: plans.map(P => (P.isa ? P.isa.lost : 0)) },
      ...(F >= 0 ? [{ key: 'avail', label: 'Free to overpay at the fix end', better: 'high', vals: plans.map(P => P.s.avail[F]) }] : []),
    ].map(m => { const best = m.better === 'high' ? Math.max(...m.vals) : Math.min(...m.vals), tie = m.vals.every(v => Math.abs(v - best) < 0.5); return { ...m, tie, best: m.vals.map(v => !tie && Math.abs(v - best) < 0.5) }; });
    return { plans, n, at: j, date: n ? plans[0].rows[j].date : null, floor, mix, why, score };
  }

  return { isaTimeline, mortgageSchedule, comparePlans, checks, realValue, isaYear, goalStatus, goalValueAt, attribution, STRESSES, stressed, monteCarlo, rng, normals };
})();

if (typeof module !== 'undefined') module.exports = TallyAnalysis;
