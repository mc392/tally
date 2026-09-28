// ---------- Tally projection engine (pure functions, no UI) ----------
// Works on the current data file version only (see model.js); older files are migrated before they get here.
const EM = typeof TallyModel !== 'undefined' ? TallyModel : require('./model.js');
const LIAB_TYPES = new Set(['card', 'card_0', 'tax']);
// A flow's amount in month k. A month set by hand in the cash-flow calendar (flow.overrides['YYYY-MM'])
// is the actual figure for that month, so the scenario's inflation or pay rise is NOT applied on top of it.
const monthStr = k => `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}`;
function amountAt(f, k, factor = 1) {
  const o = f.overrides && f.overrides[monthStr(k)];
  return o != null && o !== '' ? +o : (+f.amount || 0) * factor;
}
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

// ---------- remortgage options (Phase 1.4) ----------
// An option replaces a part's deal from the month its current fix ends:
//   {id, partId, name, type:'fixed'|'tracker', rate, fixMonths, fee, feeAdded, lump, regular, capPct, termMonths, afterRate}
// A tracker has no fix: its rate (+ the scenario's rateShift) applies throughout. A fixed deal moves to
// afterRate (+ rateShift) when its fix ends. lump comes off the balance at the switch; regular is a monthly
// overpayment, capped at capPct % of the balance at the start of each deal year (the lender's penalty-free
// allowance, often 10%). A fee added to the loan accrues interest with it.
// amortise() is the pure month-by-month maths; project() applies the same rules inside the household.
const capPctOf = o => (o.capPct != null && o.capPct !== '' ? +o.capPct : 10);
function amortise(o, bal, months, shift = 0) {
  let b = Math.max(0, bal - (+o.lump || 0)) + (o.feeAdded ? +o.fee || 0 : 0);
  const term = Math.max(1, Math.round(+o.termMonths || 300));
  const fixM = o.type === 'tracker' ? 0 : Math.max(0, Math.round(+o.fixMonths || 0));
  const r0 = (+o.rate || 0) + (o.type === 'tracker' ? shift : 0), r1 = (o.afterRate != null && o.afterRate !== '' ? +o.afterRate : +o.rate || 0) + shift;
  let pay = annuity(b, r0, term), interest = 0, overpaid = 0, capLeft = 0;
  const first = pay, out = [];
  for (let m = 0; m < months && b > 0.004; m++) {
    if (fixM && m === fixM) pay = annuity(b, r1, term - m);
    if (m % 12 === 0) capLeft = b * capPctOf(o) / 100;
    const rate = fixM && m >= fixM ? r1 : r0;
    const i = b * rate / 100 / 12, paid = Math.min(pay, b + i);
    b = b + i - paid;
    const over = Math.min(+o.regular || 0, capLeft, b); b -= over; capLeft -= over;
    interest += i; overpaid += over; out.push({ m, interest: i, paid, over, bal: b });
  }
  return { payment: first, interest, overpaid, balance: b, months: out, fees: +o.fee || 0, upfront: (+o.lump || 0) + (o.feeAdded ? 0 : +o.fee || 0) };
}

// ---------- balances between known dates (Sep 2026) ----------
// A balance update (snapshot) may hold any subset of accounts: each account has its OWN dated balances.
// balanceOn() works out an account's balance on any date from them:
//   observed     - a balance was entered for that date
//   interest     - savings and cash ISAs: the last balance grown at the account's rate, plus money in and out since
//   transactions - current accounts and cards with transactions: the last balance plus every transaction since
//                  (or, before the first balance, the next balance less the transactions in between)
//   straight     - anything else between two balances: a straight line
//   carried      - after the last balance, with nothing to go on (S&S ISAs, pensions, debts): held at it
// A closed account (active === false) is not carried beyond its last balance.
const INTEREST_TYPES = new Set(['savings', 'cash_isa']), TXN_TYPES = new Set(['current', 'card']);
const dayNum = d => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') / 864e5;
function observations(data, id) {
  return data.snapshots.filter(s => s.balances[id] != null && s.balances[id] !== '').map(s => ({ date: s.date, v: +s.balances[id] })).sort((a, b) => a.date.localeCompare(b.date));
}
const txnsOf = (data, id) => (data.transactions || []).filter(t => t.account === id);
function balanceOn(data, id, date) {
  const a = data.accounts.find(x => x.id === id); if (!a) return null;
  const obs = observations(data, id); if (!obs.length) return null;
  const hit = obs.find(o => o.date === date); if (hit) return { v: hit.v, how: 'observed', from: date };
  const prev = obs.filter(o => o.date < date).at(-1), next = obs.find(o => o.date > date);
  const tx = txnsOf(data, id);
  const between = (d1, d2) => tx.filter(t => t.date > d1 && t.date <= d2);
  if (!prev) {
    // before the first balance: only transactions can say what it was
    if (TXN_TYPES.has(a.type) && tx.some(t => t.date <= next.date && t.date > date)) return { v: next.v - between(date, next.date).reduce((s, t) => s + t.amount, 0), how: 'transactions', from: next.date };
    return null;
  }
  if (!next && a.active === false) return null;
  if (INTEREST_TYPES.has(a.type)) {
    const grow = (v, d1) => v * EM.growthFactor(a, d1, date); // at whatever rate was in force on each day
    const v = grow(prev.v, prev.date) + between(prev.date, date).filter(t => t.kind !== 'interest').reduce((s, t) => s + grow(t.amount, t.date), 0);
    return { v, how: 'interest', from: prev.date };
  }
  if (TXN_TYPES.has(a.type) && tx.length) return { v: prev.v + between(prev.date, date).reduce((s, t) => s + t.amount, 0), how: 'transactions', from: prev.date };
  if (next) { const f = (dayNum(date) - dayNum(prev.date)) / (dayNum(next.date) - dayNum(prev.date)); return { v: prev.v + (next.v - prev.v) * f, how: 'straight', from: prev.date }; }
  return { v: prev.v, how: 'carried', from: prev.date };
}
// Every account's balance on a date, in the snapshot shape the rest of the engine reads. `how` says,
// per account, whether it was entered or worked out.
function positionOn(data, date) {
  const balances = {}, how = {};
  for (const a of data.accounts) { const b = balanceOn(data, a.id, date); if (b) { balances[a.id] = Math.round(b.v * 100) / 100; how[a.id] = b.how; } }
  return { date, balances, how };
}
const latestDate = data => data.snapshots.reduce((m, s) => (s.date > m ? s.date : m), '');
// Where the projection starts: every account as it stands on the most recent date any balance was entered.
// With a full update on that date this is exactly that update.
function latestSnapshot(data) {
  const d = latestDate(data);
  return d ? positionOn(data, d) : null;
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
  const income = live.filter(f => f.kind === 'income').reduce((s, f) => s + amountAt(f, k), 0);
  const mPay = mortgageTotals(data).payment;
  const spend = live.filter(f => f.kind === 'spend').reduce((s, f) => s + (f.linked === 'mortgage' ? mPay : amountAt(f, k)), 0);
  const buffer = spend * (+data.bufferPct || 0) / 100;
  return { income, spend, buffer, out: spend + buffer, surplus: income - spend - buffer };
}

// opts (for the risk tools, Phase 4): ssReturns - one monthly S&S return (0.01 = 1%) per month, used
// INSTEAD of the scenario's return, whether or not growth is on; ssShock - % change to S&S in the first month.
function project(data, scenarioKey, months, opts = {}) {
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
  const cashIsaW = []; // instant cash ISAs and their opening balances: the pool's rate each month is their weighted rate then
  for (const a of accs) {
    const v = snap.balances[a.id]; if (v == null) continue;
    const g = GROUPS[a.type] || GROUPS.savings;
    if (g.pool === 'cash') cash += v;
    else if (a.type === 'ss_isa') isaSS += v;
    else if (a.type === 'cash_isa' && (a.access === 'fixed' || a.access === 'notice')) heldIsa[a.id] = v;
    else if (a.type === 'cash_isa') { isaCash += v; cashIsaW.push([a, v]); }
    else other[a.id] = v;
  }
  const matK = a => a.access === 'fixed' && a.maturity ? EM.monthKey(a.maturity) : null;
  const cashIsaRateAt = date => { const w = cashIsaW.reduce((s, [, v]) => s + v, 0); return w ? cashIsaW.reduce((s, [a, v]) => s + v * EM.rateOn(a, date), 0) / w : 3; };
  const cashIsaRate = cashIsaRateAt(snap.date);
  const ssShare = Math.min(100, Math.max(0, +r.sweepToSS || 0)) / 100;

  // Each part runs on its own: its own balance, rate, and a payment recalculated when its fix ends.
  const mk = d => d ? ymKey(ym(d).y, ym(d).m) : null;
  const parts = mortgageParts(data).map(p => ({
    id: p.id, name: p.name, bal: isSet(p.balance) ? +p.balance : null, pay: +p.payment || 0,
    rate: isSet(p.rate) ? +p.rate : null, newRate: isSet(p.newRate) ? +p.newRate : null, fixEndK: mk(p.fixEnd), termEndK: mk(p.termEnd),
  }));
  const anyBal = parts.some(p => p.bal != null);
  // The scenario's chosen remortgage option (1.6), applied to its part from the part's fix end.
  const opt = sc.option ? (data.remortgageOptions || []).find(o => o.id === sc.option) : null;
  const optPart = opt ? parts.find(p => p.id === opt.partId && p.fixEndK != null && p.bal != null) : null;
  const optK = optPart ? optPart.fixEndK : null;
  const shift = +sc.rateShift || 0;

  // Remortgage planning (Phase 1.3). F = the month the earliest part's fix ends (from the start month on).
  // Glide path: in the N months before F, top-ups go only to instant-access cash ISAs, never S&S.
  // Target: before F, S&S only gets what is left once "available to overpay" would still reach the target.
  const rm = r.remortgage || {};
  const F = parts.map(p => p.fixEndK).filter(x => x != null && x >= k0).sort((a, b) => a - b)[0] ?? null;
  const target = +rm.target > 0 ? +rm.target : 0;

  // ISA allowance is per person. Top-ups fill people in r.isaFillOrder: the first person's allowance
  // is used up before the next person's. Re-deposit room (money taken out of a flexible ISA, which can
  // go back in the same tax year without new allowance) is tracked for the household.
  const flows = EM.effectiveFlows(data, sc); // life events applied (as this scenario has them): off ones dropped, scale and contingency in
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
      else if (f.bundle && f.kind === 'spend') v = Math.max(0, amountAt(f, k, f.inflates ? infF : 1));
      else if (f.bundle && f.kind === 'income') v = Math.max(0, -amountAt(f, k, payF * Math.pow(1 + (+f.growth || 0) / 100, yearsIn)));
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

  if (opts.ssShock) isaSS *= 1 + opts.ssShock / 100; // e.g. markets −25% next month
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
    let dealCash = 0; // money out of cash for the chosen option: a lump sum and fee at the switch, then overpayments
    const mParts = parts.map(p => {
      let interest = 0, paid = p.pay, over = 0;
      if (p === optPart && k === optK) {
        const lump = Math.min(+opt.lump || 0, p.bal);
        p.bal = p.bal - lump + (opt.feeAdded ? +opt.fee || 0 : 0);
        dealCash += lump + (opt.feeAdded ? 0 : +opt.fee || 0);
        const term = opt.termMonths ? Math.round(+opt.termMonths) : (p.termEndK != null ? p.termEndK - k : 300);
        p.termEndK = k + Math.max(1, term);
        p.rate = (+opt.rate || 0) + (opt.type === 'tracker' ? shift : 0);
        p.fixEndK = opt.type === 'tracker' ? null : k + Math.max(0, Math.round(+opt.fixMonths || 0));
        p.newRate = (opt.afterRate != null && opt.afterRate !== '' ? +opt.afterRate : +opt.rate || 0) + shift;
        p.pay = annuity(p.bal, p.rate, p.termEndK - k);
        p.deal = { from: k, regular: +opt.regular || 0, capPct: capPctOf(opt), capLeft: 0 };
      }
      if (p.bal != null && p.rate != null) {
        if (p.fixEndK != null && k === p.fixEndK && p.newRate != null && p.termEndK != null) p.pay = annuity(p.bal, p.newRate, p.termEndK - k);
        const rate = p.fixEndK != null && k >= p.fixEndK && p.newRate != null ? p.newRate : p.rate;
        interest = p.bal * rate / 100 / 12;
        paid = Math.min(p.pay, p.bal + interest);
        p.bal = Math.max(0, p.bal + interest - paid);
        if (p.deal) {
          if ((k - p.deal.from) % 12 === 0) p.deal.capLeft = p.bal * (+p.deal.capPct) / 100;
          over = Math.min(p.deal.regular, p.deal.capLeft, p.bal); p.bal -= over; p.deal.capLeft -= over; dealCash += over;
        }
      }
      return { id: p.id, name: p.name, pay: paid, interest, bal: p.bal, over };
    });
    const mPay = mParts.reduce((s, p) => s + p.pay, 0), mortgageInterest = mParts.reduce((s, p) => s + p.interest, 0);
    const mBal = anyBal ? mParts.reduce((s, p) => s + (p.bal || 0), 0) : null;

    const live = flows.filter(f => EM.flowActive(f, k));
    const incomeOf = f => amountAt(f, k, payF * Math.pow(1 + (+f.growth || 0) / 100, yearsIn));
    const spendOf = f => amountAt(f, k, f.inflates ? infF : 1);
    const income = live.filter(f => f.kind === 'income').reduce((s, f) => s + incomeOf(f), 0);
    let spend = 0;
    for (const f of live) {
      if (f.kind !== 'spend') continue;
      if (f.linked === 'mortgage') spend += mPay;
      else spend += spendOf(f);
    }
    const buffer = spend * (+data.bufferPct || 0) / 100;
    const surplus = income - spend - buffer;

    const evs = live.filter(f => f.kind === 'oneoff');
    // what each life event adds or takes away this month (income − costs, one-offs included)
    const bundleNet = {};
    for (const f of live) if (f.bundle) {
      const v = f.kind === 'income' ? incomeOf(f) : f.kind === 'spend' ? -spendOf(f) : +f.amount || 0;
      bundleNet[f.bundle] = (bundleNet[f.bundle] || 0) + v;
    }
    const payments = evs.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const receipts = evs.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    for (const e of evs) if (e.settles && other[e.settles] != null) other[e.settles] = 0;

    const opening = cash;
    const before = opening + surplus + payments + receipts - dealCash;
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
    if (opts.ssReturns) { const g = isaSS * opts.ssReturns[i]; isaSS += g; growth += g; }
    if (sc.growth) {
      const gSS = opts.ssReturns ? 0 : isaSS * (sc.ssReturn || 0) / 100 / 12;
      const gC = isaCash * cashIsaRateAt(date) / 100 / 12;
      isaSS += gSS; isaCash += gC; growth += gSS + gC;
      for (const id in heldIsa) { const g = heldIsa[id] * EM.rateOn(byId[id], date) / 100 / 12; heldIsa[id] += g; growth += g; }
      for (const a of accs) if (other[a.id] != null && (a.type === 'savings' || a.type === 'pension')) {
        const g = other[a.id] * EM.rateOn(a, date) / 100 / 12; other[a.id] += g; growth += g;
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
      accounts: { ...other, ...heldIsa }, // month-end balance of each account tracked on its own (savings, pensions, debts, fixed/notice cash ISAs)
      mortgageBal: mBal, mortgagePay: mPay, mortgageInterest, mortgageParts: mParts, dealCash,
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

// ---------- plan vs actual (Phase 1.7) ----------
// For the balance update on `date`: what the projection made from the update before it expected by then,
// against what was recorded. Expected = the projected month-end before the update's month.
function drift(data, sk, date) {
  const snaps = [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const i = snaps.findIndex(x => x.date === date);
  if (i < 1) return null;
  const prev = snaps[i - 1], cur = snaps[i];
  const k1 = ymKey(ym(prev.date).y, ym(prev.date).m), k2 = ymKey(ym(cur.date).y, ym(cur.date).m);
  if (k2 <= k1) return null; // same month: nothing projected in between
  const pr = project({ ...data, snapshots: snaps.slice(0, i), transactions: (data.transactions || []).filter(t => t.date <= prev.date) }, sk, k2 - k1);
  const r = pr.rows.find(x => x.k === k2 - 1);
  const act = snapshotTotals(data, positionOn(data, cur.date));
  const exp = { cash: r.closing, isa: r.isa, other: r.other, net: r.net };
  const actual = { cash: act.cash, isa: act.isa, other: act.other, net: act.net };
  const diff = Object.fromEntries(Object.keys(exp).map(k => [k, actual[k] - exp[k]]));
  return { from: prev.date, to: cur.date, months: k2 - k1, expected: exp, actual, diff };
}

// Run the projection as scenario sk, but with some settings changed, without touching data.
function projectAs(data, sk, change, months) {
  const sc = { ...data.scenarios[sk || data.scenario], ...change };
  return project({ ...data, scenarios: { ...data.scenarios, __as: sc } }, '__as', months);
}

// ---------- compare remortgage options (Phase 1.4) ----------
// For the part whose fix ends first: each option for it, plus "do nothing" (the part's own rate after the
// fix), run through the whole household projection, measured over `windowMonths` from the switch.
function compareOptions(data, sk, windowMonths = 60, today) {
  const R = readiness(data, sk, today);
  if (R.none) return { none: R.none };
  const snap = latestSnapshot(data), k0 = ymKey(ym(snap.date).y, ym(snap.date).m);
  const F = EM.monthKey(EM.month(R.fixEnd)), months = F - k0 + windowMonths;
  const pi = mortgageParts(data).findIndex(p => p.id === R.part.id);
  const opts = [{ id: null, name: 'Do nothing', note: 'Move to the rate after your fix' }, ...(data.remortgageOptions || []).filter(o => o.partId === R.part.id)];
  const results = opts.map(o => {
    const rows = projectAs(data, sk, { option: o.id }, months).rows;
    const win = rows.filter(r => r.k >= F && r.k < F + windowMonths), last = win.at(-1), part = r => r.mortgageParts[pi];
    const interest = win.reduce((s, r) => s + part(r).interest, 0), overpaid = win.reduce((s, r) => s + part(r).over, 0);
    const fee = o.id ? +o.fee || 0 : 0, lowest = win.reduce((b, r) => (r.closing < b.closing ? r : b), win[0]);
    return {
      option: o, payment: part(win[0]).pay, interest, fee, totalCost: interest + fee, overpaid, lump: o.id ? +o.lump || 0 : 0,
      balance: part(last).bal, accessible: last.byAccess.instant + last.byAccess.notice, net: last.net, lowestCash: lowest.closing, lowestMonth: lowest.date,
    };
  });
  const before = project(data, sk, Math.max(1, F - k0)).rows.find(r => r.k === F - 1);
  const balAtSwitch = before ? before.mortgageParts[pi].bal : (+R.part.balance || 0);
  const cashIsaRate = project(data, sk, 1).cashIsaRate;
  // months left on the part's term at the switch: what an option with no term of its own runs over
  const termLeft = R.part.termEnd ? Math.max(1, EM.monthKey(EM.month(R.part.termEnd)) - F) : 300;
  return { R, part: R.part, partIndex: pi, termLeft, switchDate: R.fixEnd, windowMonths, endDate: keyToDate(F + windowMonths - 1), results, balAtSwitch, cashIsaRate };
}
// Payment and cost of one option at its rate and at ±0.5% and ±1% (pure amortisation, no household).
function rateGrid(o, bal, months = 60, termLeft = 300, shifts = [-1, -0.5, 0, 0.5, 1]) {
  return shifts.map(d => { const a = amortise({ ...o, termMonths: o.termMonths || termLeft, rate: (+o.rate || 0) + d, afterRate: (o.afterRate != null && o.afterRate !== '' ? +o.afterRate : +o.rate || 0) + d }, bal, months); return { shift: d, payment: a.payment, cost: a.interest + a.fees }; });
}
// "Available to overpay" if the switch were in month k: instant + notice − floor − the next `em` months' earmarks.
function availableSeries(rows, floor, em = 12) {
  return rows.map((r, i) => r.byAccess.instant + r.byAccess.notice - floor - rows.slice(i + 1, i + 1 + em).reduce((s, x) => s + x.earmark, 0));
}

if (typeof module !== 'undefined') module.exports = { project, snapshotTotals, latestSnapshot, balanceOn, positionOn, observations, latestDate, monthlyBudget, mortgageParts, mortgageTotals, readiness, amortise, annuity, projectAs, drift, amountAt, compareOptions, rateGrid, availableSeries, GROUPS };
