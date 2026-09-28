// ---------- Tally projection engine (pure functions, no UI) ----------
// Works on the current data file version only (see model.js); older files are migrated before they get here.
const EM = typeof TallyModel !== 'undefined' ? TallyModel : require('./model.js');
const LIAB_TYPES = new Set(['card', 'card_0', 'tax']);
const GROUPS = {
  ss_isa:   { label: 'Stocks & shares ISAs', pool: 'isa',  kind: 'ss' },
  cash_isa: { label: 'Cash ISAs',            pool: 'isa',  kind: 'cash' },
  savings:  { label: 'Savings',              pool: 'other' },
  current:  { label: 'Current accounts',     pool: 'cash' },
  card:     { label: 'Credit cards',         pool: 'cash' },
  card_0:   { label: '0% credit cards',      pool: 'other' },
  tax:      { label: 'Tax owed',             pool: 'other' },
  pension:  { label: 'Pensions',             pool: 'other' },
};

function ym(dateStr) { const [y, m] = dateStr.split('-').map(Number); return { y, m }; }
function ymKey(y, m) { return y * 12 + (m - 1); }
function keyToDate(k) { const y = Math.floor(k / 12), m = (k % 12) + 1; return `${y}-${String(m).padStart(2, '0')}-01`; }
function taxYearOf(k) { const y = Math.floor(k / 12), m = (k % 12) + 1; return m >= 4 ? y : y - 1; }
function annuity(bal, ratePct, n) {
  if (n <= 0) return bal;
  const r = ratePct / 100 / 12;
  return r === 0 ? bal / n : bal * r / (1 - Math.pow(1 + r, -n));
}

// A mortgage can be split into parts (UK "sub-accounts"), each with its own balance, rate, fix and term.
// Files written before parts existed hold one flat mortgage; that reads as a single part.
function mortgageParts(data) {
  const m = data.mortgage || {};
  if (Array.isArray(m.parts)) return m.parts;
  return [{ id: 'main', payment: m.payment, balance: m.balance, rate: m.rate, fixEnd: m.fixEnd, newRate: m.newRate, termEnd: m.termEnd }];
}
const isSet = v => v != null && v !== '';
function mortgageTotals(data) {
  const parts = mortgageParts(data);
  const withBal = parts.filter(p => isSet(p.balance));
  return {
    parts,
    payment: parts.reduce((s, p) => s + (+p.payment || 0), 0),
    balance: withBal.length ? withBal.reduce((s, p) => s + +p.balance, 0) : null, // null = no balance entered anywhere
    allBalances: withBal.length === parts.length,
  };
}

function latestSnapshot(data) {
  const s = [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  return s[s.length - 1] || null;
}

function snapshotTotals(data, snap) {
  const t = { cash: 0, isa: 0, isaSS: 0, isaCash: 0, other: 0, net: 0, byType: {}, byOwner: {} };
  if (!snap) return t;
  for (const a of data.accounts) {
    const v = snap.balances[a.id];
    if (v == null) continue;
    const g = GROUPS[a.type] || GROUPS.savings;
    t[g.pool] += v;
    if (a.type === 'ss_isa') t.isaSS += v;
    if (a.type === 'cash_isa') t.isaCash += v;
    t.byType[a.type] = (t.byType[a.type] || 0) + v;
    t.byOwner[a.owner] = (t.byOwner[a.owner] || 0) + v;
    t.net += v;
  }
  return t;
}

// The regular budget in one month ('YYYY-MM', default this month): flows that are running then.
// One-offs are left out - they are not part of what a normal month looks like.
function monthlyBudget(data, when) {
  const k = EM.monthKey(when || new Date().toISOString().slice(0, 7));
  const live = EM.effectiveFlows(data).filter(f => f.kind !== 'oneoff' && EM.flowActive(f, k));
  const income = live.filter(f => f.kind === 'income').reduce((s, f) => s + (+f.amount || 0), 0);
  const mPay = mortgageTotals(data).payment;
  const spend = live.filter(f => f.kind === 'spend').reduce((s, f) => s + (f.linked === 'mortgage' ? mPay : +f.amount || 0), 0);
  const buffer = spend * (+data.bufferPct || 0) / 100;
  return { income, spend, buffer, out: spend + buffer, surplus: income - spend - buffer };
}

function project(data, scenarioKey, months) {
  const sc = data.scenarios[scenarioKey || data.scenario];
  const snap = latestSnapshot(data);
  if (!snap) return null;
  const start = ym(snap.date);
  const k0 = ymKey(start.y, start.m);
  const r = data.rules;
  const accs = data.accounts;

  // opening positions
  let cash = 0, isaSS = 0, isaCash = 0; // isaCash = cash ISAs you can dip into (instant access)
  const other = {};           // accountId -> balance (savings, pensions, 0% cards, tax)
  const heldIsa = {};         // cash ISAs on a fixed term or notice: not drawn on, grow at their own rate
  const byId = Object.fromEntries(accs.map(a => [a.id, a]));
  let cashIsaRateW = 0;
  for (const a of accs) {
    const v = snap.balances[a.id]; if (v == null) continue;
    const g = GROUPS[a.type] || GROUPS.savings;
    if (g.pool === 'cash') cash += v;
    else if (a.type === 'ss_isa') isaSS += v;
    else if (a.type === 'cash_isa' && (a.access === 'fixed' || a.access === 'notice')) heldIsa[a.id] = v;
    else if (a.type === 'cash_isa') { isaCash += v; cashIsaRateW += v * (+a.rate || 0); }
    else other[a.id] = v;
  }
  const matK = a => a.access === 'fixed' && a.maturity ? EM.monthKey(a.maturity) : null;
  const cashIsaRate = isaCash ? cashIsaRateW / isaCash : 3;
  const ssShare = Math.min(100, Math.max(0, +r.sweepToSS || 0)) / 100;

  // Each part runs on its own: its own balance, rate, and a payment recalculated when its fix ends.
  const mk = d => d ? ymKey(ym(d).y, ym(d).m) : null;
  const parts = mortgageParts(data).map(p => ({
    id: p.id, name: p.name, bal: isSet(p.balance) ? +p.balance : null, pay: +p.payment || 0,
    rate: isSet(p.rate) ? +p.rate : null, newRate: isSet(p.newRate) ? +p.newRate : null, fixEndK: mk(p.fixEnd), termEndK: mk(p.termEnd),
  }));
  const anyBal = parts.some(p => p.bal != null);

  // Remortgage planning (Phase 1.3). F = the month the earliest part's fix ends (from the start month on).
  // Glide path: in the N months before F, top-ups go only to instant-access cash ISAs, never S&S.
  // Target: before F, S&S only gets what is left once "available to overpay" would still reach the target.
  const rm = r.remortgage || {};
  const F = parts.map(p => p.fixEndK).filter(x => x != null && x >= k0).sort((a, b) => a - b)[0] ?? null;
  const target = +rm.target > 0 ? +rm.target : 0;

  // ISA allowance is per person. Top-ups fill people in r.isaFillOrder: the first person's allowance
  // is used up before the next person's. Re-deposit room (money taken out of a flexible ISA, which can
  // go back in the same tax year without new allowance) is tracked for the household.
  const flows = EM.effectiveFlows(data); // life events applied: off ones dropped, scale and contingency in
  let ty = taxYearOf(k0);
  const who = r.isaFillOrder && r.isaFillOrder.length ? r.isaFillOrder : ['M'];
  const per = +r.isaPerPerson || 0;
  const freshBy = {};
  for (const p of who) freshBy[p] = Math.max(0, per - (ty === +r.isaUsedTaxYear ? (+(r.isaUsedBy || {})[p] || 0) : 0));
  const freshTotal = () => who.reduce((s, p) => s + freshBy[p], 0);
  const useFresh = amt => { for (const p of who) { const u = Math.min(amt, freshBy[p]); freshBy[p] -= u; amt -= u; } };
  let fresh = freshTotal();
  let repl = 0;
  const rows = [];
  // Scenario factors in month k: pay rises and inflation step each April.
  const fac = k => { const yearsIn = taxYearOf(k) - taxYearOf(k0); return { yearsIn, payF: Math.pow(1 + (sc.payRise || 0) / 100, yearsIn), infF: Math.pow(1 + (sc.inflation || 0) / 100, yearsIn) }; };
  // Earmarked in month k: money that will have to go out - one-off payments, and a life event's costs
  // and drops in pay. Returned as positive amounts, by label (the event's name, or the one-off's).
  const earmarkOf = k => {
    const { yearsIn, payF, infF } = fac(k), by = {};
    const bname = id => ((data.bundles || []).find(b => b.id === id) || {}).name || 'Life event';
    for (const f of flows) {
      if (!EM.flowActive(f, k)) continue;
      let v = 0;
      if (f.kind === 'oneoff' && f.amount < 0) v = -f.amount;
      else if (f.bundle && f.kind === 'spend' && f.amount > 0) v = f.amount * (f.inflates ? infF : 1);
      else if (f.bundle && f.kind === 'income' && f.amount < 0) v = -f.amount * payF * Math.pow(1 + (+f.growth || 0) / 100, yearsIn);
      if (v) { const l = f.bundle ? bname(f.bundle) : f.name; by[l] = (by[l] || 0) + v; }
    }
    return by;
  };
  const sumBy = o => Object.values(o).reduce((s, v) => s + v, 0);
  const earmarkMonths = +rm.earmarkMonths || 12;
  let earmarkF = 0;
  if (F != null && target) for (let k = F; k < F + earmarkMonths; k++) earmarkF += sumBy(earmarkOf(k));
  // What could be used within weeks right now: cash, instant cash ISAs, instant or notice savings,
  // notice cash ISAs, and anything fixed that has matured.
  const accessibleNow = (k, cashNow) => {
    let t = cashNow + isaCash;
    for (const id in other) { const a = byId[id]; if (LIAB_TYPES.has(a.type)) continue; const m = matK(a); if (a.access === 'instant' || a.access === 'notice' || (m != null && m <= k)) t += other[id]; }
    for (const id in heldIsa) if (byId[id].access === 'notice') t += heldIsa[id];
    return t;
  };

  for (let i = 0; i < months; i++) {
    const k = k0 + i;
    const date = keyToDate(k);
    // a fixed-term cash ISA that matures this month becomes ordinary instant-access cash ISA money
    for (const id in heldIsa) { const m = matK(byId[id]); if (m != null && m <= k) { isaCash += heldIsa[id]; delete heldIsa[id]; } }
    const tyNow = taxYearOf(k);
    if (tyNow !== ty) { ty = tyNow; for (const p of who) freshBy[p] = per; fresh = freshTotal(); repl = 0; }
    const yearsIn = tyNow - taxYearOf(k0);             // annual steps each April
    const payF = Math.pow(1 + (sc.payRise || 0) / 100, yearsIn);
    const infF = Math.pow(1 + (sc.inflation || 0) / 100, yearsIn);

    // mortgage: a part with a balance and rate runs down month by month; one without is a flat payment.
    // A part that is paid off stops costing anything, so its payment leaves the spending too.
    const mParts = parts.map(p => {
      let interest = 0, paid = p.pay;
      if (p.bal != null && p.rate != null) {
        if (p.fixEndK != null && k === p.fixEndK && p.newRate != null && p.termEndK != null) p.pay = annuity(p.bal, p.newRate, p.termEndK - k);
        const rate = p.fixEndK != null && k >= p.fixEndK && p.newRate != null ? p.newRate : p.rate;
        interest = p.bal * rate / 100 / 12;
        paid = Math.min(p.pay, p.bal + interest);
        p.bal = Math.max(0, p.bal + interest - paid);
      }
      return { id: p.id, name: p.name, pay: paid, interest, bal: p.bal };
    });
    const mPay = mParts.reduce((s, p) => s + p.pay, 0), mortgageInterest = mParts.reduce((s, p) => s + p.interest, 0);
    const mBal = anyBal ? mParts.reduce((s, p) => s + (p.bal || 0), 0) : null;

    const live = flows.filter(f => EM.flowActive(f, k));
    const income = live.filter(f => f.kind === 'income').reduce((s, f) => s + (+f.amount || 0) * payF * Math.pow(1 + (+f.growth || 0) / 100, yearsIn), 0);
    let spend = 0;
    for (const f of live) {
      if (f.kind !== 'spend') continue;
      if (f.linked === 'mortgage') spend += mPay;
      else spend += (+f.amount || 0) * (f.inflates ? infF : 1);
    }
    const buffer = spend * (+data.bufferPct || 0) / 100;
    const surplus = income - spend - buffer;

    const evs = live.filter(f => f.kind === 'oneoff');
    // what each life event adds or takes away this month (income − costs, one-offs included)
    const bundleNet = {};
    for (const f of live) if (f.bundle) {
      const v = f.kind === 'income' ? (+f.amount || 0) * payF * Math.pow(1 + (+f.growth || 0) / 100, yearsIn)
        : f.kind === 'spend' ? -(+f.amount || 0) * (f.inflates ? infF : 1) : +f.amount || 0;
      bundleNet[f.bundle] = (bundleNet[f.bundle] || 0) + v;
    }
    const payments = evs.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const receipts = evs.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    for (const e of evs) if (e.settles && other[e.settles] != null) other[e.settles] = 0;

    const opening = cash;
    const before = opening + surplus + payments + receipts;
    const freshStart = fresh, replStart = repl, cap = fresh + repl;
    let topUp = 0, withdraw = 0, shortfall = 0;
    const floor = +r.cashFloor || 0;
    if (before > floor) {
      topUp = Math.min(before - floor, cap);
      const fromRepl = Math.min(topUp, repl); repl -= fromRepl; useFresh(topUp - fromRepl); fresh = freshTotal();
      let toSS = topUp * ssShare;
      if (F != null && k < F) {
        if (rm.glide && k >= F - (+rm.glideMonths || 12)) toSS = 0;
        else if (target) toSS = Math.min(toSS, Math.max(0, accessibleNow(k, before) - floor - earmarkF - target));
      }
      isaCash += topUp - toSS; isaSS += toSS;
    } else if (before < floor) {
      const need = floor - before;
      withdraw = Math.min(need, isaCash + isaSS);
      shortfall = need - withdraw;
      const fromCash = Math.min(withdraw, isaCash); isaCash -= fromCash; isaSS -= (withdraw - fromCash);
      repl += withdraw;
    }
    cash = before - topUp + withdraw;

    let growth = 0;
    if (sc.growth) {
      const gSS = isaSS * (sc.ssReturn || 0) / 100 / 12;
      const gC = isaCash * cashIsaRate / 100 / 12;
      isaSS += gSS; isaCash += gC; growth = gSS + gC;
      for (const id in heldIsa) { const g = heldIsa[id] * (+byId[id].rate || 0) / 100 / 12; heldIsa[id] += g; growth += g; }
      for (const a of accs) if (other[a.id] != null && (a.type === 'savings' || a.type === 'pension')) {
        const g = other[a.id] * (+a.rate || 0) / 100 / 12; other[a.id] += g; growth += g;
      }
    }
    const otherTotal = Object.values(other).reduce((s, v) => s + v, 0);
    const heldTotal = Object.values(heldIsa).reduce((s, v) => s + v, 0);
    // Every pound at month end, by how quickly it could be used. Adds up to net worth.
    const byAccess = { instant: cash + isaCash, notice: 0, invested: isaSS, fixed: 0, locked: 0, debts: 0 };
    const place = (a, v) => { if (LIAB_TYPES.has(a.type)) { byAccess.debts += v; return; } const m = matK(a); const c = m != null && m <= k ? 'instant' : (a.access || 'instant'); byAccess[c] = (byAccess[c] || 0) + v; };
    for (const id in other) place(byId[id], other[id]);
    for (const id in heldIsa) place(byId[id], heldIsa[id]);
    const earmarkBy = earmarkOf(k);
    rows.push({
      k, date, income, spend, buffer, surplus, events: evs, bundleNet, payments, receipts,
      opening, before, topUp, withdraw, shortfall, closing: cash,
      freshStart, replStart, cap, freshEnd: fresh, freshBy: { ...freshBy }, replEnd: repl, taxYear: tyNow,
      isaSS, isaCash: isaCash + heldTotal, isaCashFlex: isaCash, isa: isaSS + isaCash + heldTotal, growth, other: otherTotal,
      byAccess, earmark: sumBy(earmarkBy), earmarkBy,
      mortgageBal: mBal, mortgagePay: mPay, mortgageInterest, mortgageParts: mParts,
      net: cash + isaSS + isaCash + heldTotal + otherTotal,
    });
  }
  return { start: keyToDate(k0), snapDate: snap.date, rows, cashIsaRate, fixEndK: F };
}

// ---------- remortgage readiness (Phase 1.1) ----------
// Works towards the EARLIEST fix end among the mortgage parts that is still to come (decided with Matt).
// "At the fix end" means balances at the end of the month before the switch. Available to overpay =
// what can be used within weeks (instant + notice) − the cash floor − what is earmarked in the
// `earmarkMonths` (12) months from the switch: one-off payments and life-event costs and pay drops.
function readiness(data, scenarioKey, today) {
  const rm = data.rules.remortgage || {};
  const snap = latestSnapshot(data);
  if (!snap) return { none: 'balances' };
  const k0 = ymKey(ym(snap.date).y, ym(snap.date).m);
  const now = today ? EM.monthKey(today) : k0;
  const parts = mortgageParts(data).map((p, i) => ({ p, i, F: p.fixEnd ? EM.monthKey(EM.month(p.fixEnd)) : null }))
    .filter(x => x.F != null && x.F >= Math.max(now, k0)).sort((a, b) => a.F - b.F);
  if (!parts.length) return { none: 'fixEnd' };
  const { p: part, i: partIndex, F } = parts[0];
  const em = +rm.earmarkMonths || 12, lead = rm.leadMonths ?? 6, decide = rm.decideMonths ?? 2;
  const pr = project(data, scenarioKey, Math.max(1, F - k0 + em));
  const atK = Math.max(k0, F - 1);
  const row = pr.rows.find(r => r.k === atK);
  const win = pr.rows.filter(r => r.k >= F && r.k < F + em);
  const earmarks = win.reduce((s, r) => s + r.earmark, 0);
  const items = {};
  for (const r of win) for (const [l, v] of Object.entries(r.earmarkBy)) { const it = items[l] ||= { label: l, amount: 0, first: r.date }; it.amount += v; }
  const floor = +data.rules.cashFloor || 0;
  const accessible = row.byAccess.instant + row.byAccess.notice;
  const available = accessible - floor - earmarks;
  const invested = {};
  for (const key of Object.keys(data.scenarios)) { const rr = project(data, key, atK - k0 + 1).rows.find(r => r.k === atK); invested[key] = rr ? rr.byAccess.invested : null; }
  const target = +rm.target > 0 ? +rm.target : null;
  let clears = null;
  if (target != null && available < target) {
    const later = project(data, scenarioKey, Math.max(atK - k0 + 1, 120)).rows.find(r => r.k > atK && r.byAccess.instant + r.byAccess.notice - floor - earmarks >= target);
    clears = later ? later.date : null;
  }
  return {
    part, partIndex, fixEnd: keyToDate(F), monthsAway: F - Math.max(now, k0), atDate: keyToDate(atK),
    dates: { secure: keyToDate(F - lead), decide: keyToDate(F - decide), switch: keyToDate(F) },
    ladder: row.byAccess, accessible, floor, earmarks, earmarkItems: Object.values(items).sort((a, b) => b.amount - a.amount), earmarkMonths: em,
    available, invested, investedStressed: row.byAccess.invested * 0.8, target, met: target == null ? null : available >= target, shortfall: target != null ? Math.max(0, target - available) : 0, clears,
    laterParts: parts.slice(1).map(x => ({ part: x.p, index: x.i, fixEnd: keyToDate(x.F) })),
  };
}

if (typeof module !== 'undefined') module.exports = { project, snapshotTotals, latestSnapshot, monthlyBudget, mortgageParts, mortgageTotals, readiness, GROUPS };
