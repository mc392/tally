// FROZEN copy of engine.js as it was before data file v2 (Phase 0, Sep 2026). Do not edit.
// tests/migration.test.js runs v1 files through this and through the current engine + migrate()
// and requires identical figures. It is test code only and is never loaded by the app.
// ---------- Tally projection engine (pure functions, no UI) ----------
const GROUPS = {
  ss_isa:   { label: 'Stocks & shares ISAs', pool: 'isa',  kind: 'ss' },
  cash_isa: { label: 'Cash ISAs',            pool: 'isa',  kind: 'cash' },
  savings:  { label: 'Savings',              pool: 'other' },
  current:  { label: 'Current accounts',     pool: 'cash' },
  card:     { label: 'Credit cards',         pool: 'cash' },
  card_0:   { label: '0% credit cards',      pool: 'other' },
  tax:      { label: 'Tax owed',             pool: 'other' },
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

function monthlyBudget(data) {
  const income = data.income.reduce((s, i) => s + (+i.monthly || 0), 0);
  const spend = data.spending.reduce((s, l) => s + (l.linked === 'mortgage' ? mortgageTotals(data).payment * 12 : (+l.annual || 0)), 0) / 12;
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
  let cash = 0, isaSS = 0, isaCash = 0;
  const other = {};           // accountId -> balance (savings, 0% cards, tax)
  let cashIsaRateW = 0;
  for (const a of accs) {
    const v = snap.balances[a.id]; if (v == null) continue;
    const g = GROUPS[a.type] || GROUPS.savings;
    if (g.pool === 'cash') cash += v;
    else if (a.type === 'ss_isa') isaSS += v;
    else if (a.type === 'cash_isa') { isaCash += v; cashIsaRateW += v * (+a.rate || 0); }
    else other[a.id] = v;
  }
  const cashIsaRate = isaCash ? cashIsaRateW / isaCash : 3;
  const ssShare = Math.min(100, Math.max(0, +r.sweepToSS || 0)) / 100;

  // Each part runs on its own: its own balance, rate, and a payment recalculated when its fix ends.
  const mk = d => d ? ymKey(ym(d).y, ym(d).m) : null;
  const parts = mortgageParts(data).map(p => ({
    id: p.id, name: p.name, bal: isSet(p.balance) ? +p.balance : null, pay: +p.payment || 0,
    rate: isSet(p.rate) ? +p.rate : null, newRate: isSet(p.newRate) ? +p.newRate : null, fixEndK: mk(p.fixEnd), termEndK: mk(p.termEnd),
  }));
  const anyBal = parts.some(p => p.bal != null);

  let ty = taxYearOf(k0);
  let fresh = Math.max(0, (+r.isaAllowance || 0) - (ty === +r.isaUsedTaxYear ? (+r.isaUsed || 0) : 0));
  let repl = 0;
  const rows = [];

  for (let i = 0; i < months; i++) {
    const k = k0 + i;
    const date = keyToDate(k);
    const tyNow = taxYearOf(k);
    if (tyNow !== ty) { ty = tyNow; fresh = +r.isaAllowance || 0; repl = 0; }
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

    const income = data.income.reduce((s, x) => s + (+x.monthly || 0) * payF * Math.pow(1 + (+x.growth || 0) / 100, yearsIn), 0);
    let spend = 0;
    for (const l of data.spending) {
      if (l.linked === 'mortgage') spend += mPay;
      else spend += (+l.annual || 0) / 12 * (l.inflates ? infF : 1);
    }
    const buffer = spend * (+data.bufferPct || 0) / 100;
    const surplus = income - spend - buffer;

    const evs = data.events.filter(e => e.on && e.date && ymKey(ym(e.date).y, ym(e.date).m) === k);
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
      const fromRepl = Math.min(topUp, repl); repl -= fromRepl; fresh -= (topUp - fromRepl);
      isaCash += topUp * (1 - ssShare); isaSS += topUp * ssShare;
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
      for (const a of accs) if (other[a.id] != null && a.type === 'savings') {
        const g = other[a.id] * (+a.rate || 0) / 100 / 12; other[a.id] += g; growth += g;
      }
    }
    const otherTotal = Object.values(other).reduce((s, v) => s + v, 0);
    rows.push({
      k, date, income, spend, buffer, surplus, events: evs, payments, receipts,
      opening, before, topUp, withdraw, shortfall, closing: cash,
      freshStart, replStart, cap, freshEnd: fresh, replEnd: repl, taxYear: tyNow,
      isaSS, isaCash, isa: isaSS + isaCash, growth, other: otherTotal,
      mortgageBal: mBal, mortgagePay: mPay, mortgageInterest, mortgageParts: mParts,
      net: cash + isaSS + isaCash + otherTotal,
    });
  }
  return { start: keyToDate(k0), snapDate: snap.date, rows, cashIsaRate };
}

if (typeof module !== 'undefined') module.exports = { project, snapshotTotals, latestSnapshot, monthlyBudget, mortgageParts, mortgageTotals, GROUPS };
