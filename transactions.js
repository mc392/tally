// ================= Tally transactions (Phase 2) =================
// Pure: no DOM. Reading bank CSV exports, recognising the bank, turning rows into transactions,
// skipping ones already imported, categorising, finding transfers between your own accounts,
// budget against actual, and spotting recurring payments. Tested in node (tests/transactions.test.js).
//
// A transaction: {id, account, date:'YYYY-MM-DD', amount, description, merchant, bankCategory, category?, source}
//   amount is from the ACCOUNT's point of view: negative = money out, positive = money in.
//   `category` is only stored when set by hand; otherwise categoryOf() works it out every time, so a new
//   rule applies to everything already imported.
const TallyTx = (() => {
  // ---------- CSV (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes) ----------
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    const s = String(text).replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim() !== ''));
  }

  const money = v => { const t = String(v ?? '').replace(/[£,\s]/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  const ukDate = v => { const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
  const isoDate = v => { const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
  const anyDate = v => ukDate(v) || isoDate(v);
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  // A readable merchant from a raw description: drop card-processor prefixes, store numbers and the town
  // Amex pads onto the end, so "TESCO STORE 6032 6032TE LONDON" and "TESCO STORES 4629" group together.
  function merchantOf(desc) {
    let t = clean(desc).toUpperCase()
      .replace(/^(SQ \*|SQ\*|ZETTLE_\*|SUMUP \*|IZ \*|PAYPAL \*|NYX\*|RP\*|3CPAYMENT\*|CRV\*|UBER\s+\*)/, '')
      .replace(/\s{2,}.*$/, '')                // Amex: "NAME<spaces>TOWN"
      .replace(/\b\d[\dA-Z]*\b/g, ' ')         // store numbers and codes
      .replace(/[^A-Z&' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const w = t.split(' ').filter(Boolean);
    return (w.slice(0, 3).join(' ') || clean(desc).toUpperCase()).trim();
  }

  // ---------- known formats ----------
  // Each: the header it is recognised by, and how one row becomes a transaction (before id and account).
  const FORMATS = {
    lloyds: {
      name: 'Lloyds', kind: 'current',
      header: ['Transaction Date', 'Transaction Type', 'Sort Code', 'Account Number', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Balance'],
      row: (r, h) => {
        const debit = money(r[h['Debit Amount']]), credit = money(r[h['Credit Amount']]);
        return {
          date: ukDate(r[h['Transaction Date']]), amount: (credit || 0) - (debit || 0), description: clean(r[h['Transaction Description']]), raw: r[h['Transaction Description']],
          type: clean(r[h['Transaction Type']]), bankCategory: null, balance: money(r[h.Balance]),
          // the running balance makes each row unique, even two identical payments on the same day
          key: [r[h['Transaction Date']], debit, credit, clean(r[h['Transaction Description']]), r[h['Balance']]].join('|'),
        };
      },
    },
    amex: {
      name: 'American Express', kind: 'card',
      header: ['Date', 'Description', 'Card Member', 'Account #', 'Amount'],
      row: (r, h) => {
        const a = money(r[h.Amount]);
        const ref = clean(r[h.Reference]).replace(/^'|'$/g, '');
        return {
          // Amex shows a charge as positive and a payment or refund as negative - the card's view, reversed
          date: ukDate(r[h.Date]), amount: a == null ? null : -a, description: clean(r[h.Description]),
          // Amex puts the town on the end of the description, sometimes after one space: take it off using its own Town/City column
          raw: (() => { const d = String(r[h.Description] ?? ''), town = clean(r[h['Town/City']]); return town && d.toUpperCase().trimEnd().endsWith(' ' + town.toUpperCase()) ? d.trimEnd().slice(0, -town.length) : d; })(),
          bankCategory: clean(r[h.Category]) || null, detail: clean(r[h['Extended Details']]) || null,
          key: ref ? 'ref|' + ref : [r[h.Date], a, clean(r[h.Description])].join('|'),
        };
      },
    },
  };
  function detect(header) {
    const H = header.map(x => clean(x));
    for (const [id, f] of Object.entries(FORMATS)) if (f.header.every(c => H.includes(c))) return id;
    return null;
  }
  const index = header => Object.fromEntries(header.map((c, i) => [clean(c), i]));

  // Any other bank: the reader says which column is which. map = {date, description, amount} or
  // {date, description, debit, credit}; `outIsNegative` false if the file shows spending as positive.
  function genericRow(map) {
    return (r, h) => {
      const debit = map.debit != null ? money(r[map.debit]) : null, credit = map.credit != null ? money(r[map.credit]) : null;
      let amount = map.amount != null ? money(r[map.amount]) : (credit || 0) - (debit || 0);
      if (map.amount != null && amount != null && map.outIsNegative === false) amount = -amount;
      return { date: anyDate(r[map.date]), amount, description: clean(r[map.description]), raw: r[map.description], bankCategory: map.category != null ? clean(r[map.category]) || null : null,
        key: [r[map.date], r[map.amount] ?? '', debit ?? '', credit ?? '', clean(r[map.description])].join('|') };
    };
  }

  // FNV-1a, 52 bits: a short stable id from a string
  function hash(s) { let h1 = 0x811c9dc5, h2 = 0x1000193; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; } return (h2 & 0xfffff).toString(36) + h1.toString(36); }

  // Rows → transactions for one Tally account. Rows that are identical in every column (two coffees at
  // the same price, same day, no balance column) are told apart by their order in the file, so importing
  // the same file again gives the same ids and adds nothing.
  function read(text, accountId, opts = {}) {
    const rows = parseCSV(text);
    if (!rows.length) return { error: 'empty' };
    const header = rows[0], fmt = opts.format || detect(header);
    if (!fmt && !opts.map) return { error: 'unknown', header };
    const h = index(header), conv = fmt && FORMATS[fmt] ? FORMATS[fmt].row : genericRow(opts.map);
    const seen = {}, out = [], bad = [], withBal = [];
    rows.slice(1).forEach((r, i) => {
      const t = conv(r, h);
      if (!t.date || t.amount == null || !Number.isFinite(t.amount)) { bad.push(i + 2); return; }
      const base = accountId + '|' + t.key, n = (seen[base] = (seen[base] || 0) + 1);
      // merchant comes from the RAW description: Amex pads the town after a run of spaces, which clean() removes
      const tx = { id: 't' + hash(base + '#' + n), account: accountId, date: t.date, amount: Math.round(t.amount * 100) / 100,
        description: t.description, merchant: merchantOf(t.raw ?? t.description), bankCategory: t.bankCategory || null, source: fmt || 'csv' };
      if (t.type) tx.type = t.type;
      if (t.detail) tx.detail = t.detail;
      out.push(tx);
      if (t.balance != null) withBal.push({ date: t.date, amount: tx.amount, balance: t.balance });
    });
    const dates = out.map(t => t.date).sort();
    // Statements with a running balance (Lloyds) say exactly what the account held: after the newest row, and
    // before the oldest one (its balance less its own amount) - dated the day before, so that day's rows count after it.
    let balances = null;
    if (withBal.length) {
      const newestFirst = withBal[0].date >= withBal.at(-1).date, newest = newestFirst ? withBal[0] : withBal.at(-1), oldest = newestFirst ? withBal.at(-1) : withBal[0];
      const before = new Date(Date.parse(oldest.date + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
      balances = { opening: { date: before, balance: Math.round((oldest.balance - oldest.amount) * 100) / 100 }, closing: { date: newest.date, balance: newest.balance } };
    }
    return { format: fmt, formatName: fmt ? FORMATS[fmt].name : 'Your columns', header, txns: out, badRows: bad, from: dates[0] || null, to: dates.at(-1) || null, balances };
  }
  // Which of these are new?
  function fresh(existing, incoming) {
    const have = new Set((existing || []).map(t => t.id));
    const add = incoming.filter(t => !have.has(t.id));
    return { add, dupes: incoming.length - add.length };
  }

  // ---------- categories ----------
  // What a category means to the budget: spending lines use the Plan's categories; these are special.
  const SPECIAL = { Income: 'Money in', Transfer: 'Between your own accounts', Ignore: 'Leave out' };
  // Starting guesses from a bank's own category (Amex gives one on every row). Editable in the app.
  const BANK_GUESS = [[/groceries/i, 'Living'], [/restaurant|bars|caf|entertainment|takeaway/i, 'Eating out'], [/travel|transport|fuel|parking/i, 'Transport'],
    [/clothing|retail|department|general purchases/i, 'Shopping'], [/pharmac|health|medical|dental/i, 'Health'], [/utilit|telecom|phone|internet/i, 'Bills']];
  // A few merchants almost every UK household has, as a fallback before anything is set up. Rules beat these.
  const KEYWORDS = [[/^TFL|TRAINLINE|UBER TRIP|PARKING|MOTOR FUEL|SHELL|BP /, 'Transport'], [/TESCO|SAINSBURY|WAITROSE|ASDA|MORRISONS|ALDI|LIDL|CO-OP|OCADO|M&S FOOD/, 'Living'],
    [/NETFLIX|SPOTIFY|DISNEY|VIRGIN MEDIA|BT GROUP|SKY |TV LICENCE|OCTOPUS|BRITISH GAS|EDF|THAMES WATER|COUNCIL|DIRECT DEBIT/, 'Bills'],
    [/DELIVEROO|JUST EAT|UBER EATS|PRET|GREGGS|STARBUCKS|COSTA|NANDO/, 'Eating out'], [/PAYMENT RECEIVED|DIRECT DEBIT PAYMENT - THANK YOU/, 'Transfer']];

  function ruleMatches(rule, t) {
    const hay = (t.description + ' ' + (t.detail || '')).toUpperCase();
    if (rule.contains && !hay.includes(String(rule.contains).toUpperCase())) return false;
    const a = Math.abs(t.amount);
    if (rule.min != null && a < +rule.min) return false;
    if (rule.max != null && a > +rule.max) return false;
    if (rule.account && rule.account !== t.account) return false;
    return !!rule.contains || rule.min != null || rule.max != null;
  }
  // Set by hand > your rules (first match wins) > the bank's category, via your mapping or a guess >
  // common merchants > money in is Income > Uncategorised.
  function categoryOf(t, d, how) {
    const why = r => (how ? (how.by = r) : null);
    if (t.category) { why('hand'); return t.category; }
    for (const r of d.categoryRules || []) if (ruleMatches(r, t)) { why('rule'); return r.category; }
    if (t.bankCategory) {
      const m = (d.categoryMap || {})[t.bankCategory]; if (m) { why('map'); return m; }
      const g = BANK_GUESS.find(([re]) => re.test(t.bankCategory)); if (g) { why('guess'); return g[1]; }
    }
    const k = KEYWORDS.find(([re]) => re.test(t.description.toUpperCase())); if (k) { why('keyword'); return k[1]; }
    if (t.amount > 0) { why('in'); return 'Income'; }
    why('none'); return 'Uncategorised';
  }

  // ---------- transfers between your own accounts (2.5) ----------
  // Equal and opposite amounts in two different accounts within `days` of each other - paying the card
  // from the current account, moving money into savings. Each transaction is used in one pair at most,
  // closest dates first. Returns a Map id → id of the other half.
  function transferPairs(txns, days = 5) {
    const dayN = d => Date.parse(d + 'T00:00:00Z') / 864e5;
    const outs = txns.filter(t => t.amount < 0), ins = txns.filter(t => t.amount > 0);
    const byAmt = {}; for (const t of ins) (byAmt[t.amount.toFixed(2)] ||= []).push(t);
    const cands = [];
    for (const o of outs) for (const i of byAmt[(-o.amount).toFixed(2)] || []) {
      if (i.account === o.account) continue;
      const gap = Math.abs(dayN(i.date) - dayN(o.date)); if (gap <= days) cands.push([gap, o, i]);
    }
    cands.sort((a, b) => a[0] - b[0] || a[1].id.localeCompare(b[1].id));
    const pair = new Map();
    for (const [, o, i] of cands) if (!pair.has(o.id) && !pair.has(i.id)) { pair.set(o.id, i.id); pair.set(i.id, o.id); }
    return pair;
  }

  // Every transaction with its category worked out, transfers included. The one place the rest reads.
  function categorised(d) {
    const tx = d.transactions || [], pairs = transferPairs(tx);
    return tx.map(t => {
      const how = {}; let c = categoryOf(t, d, how);
      if (pairs.has(t.id) && how.by !== 'hand' && how.by !== 'rule') { c = 'Transfer'; how.by = 'pair'; }
      return { ...t, cat: c, by: how.by, pair: pairs.get(t.id) || null };
    });
  }

  // ---------- budget against actual (2.3) ----------
  // For one month ('YYYY-MM'): the plan for each spending category (regular lines running that month, the
  // mortgage at its payment, one-offs planned for that month) against what was actually spent in it.
  // Spent = money out less refunds, in that category; transfers, income and "leave out" are not spending.
  function budgetVsActual(d, month, ctx) {
    const { monthKey, flowActive, effectiveFlows } = ctx.model, k = monthKey(month);
    const plan = {}, actual = {}, count = {};
    for (const f of effectiveFlows(d)) {
      if (!flowActive(f, k)) continue;
      if (f.kind === 'spend') { const v = f.linked === 'mortgage' ? ctx.mortgagePayment : ctx.amountAt(f, k); plan[f.category || 'Other'] = (plan[f.category || 'Other'] || 0) + v; }
      if (f.kind === 'oneoff' && f.amount < 0) plan[f.category || 'One-off'] = (plan[f.category || 'One-off'] || 0) - f.amount;
    }
    const txs = (ctx.categorised || categorised(d)).filter(t => t.date.slice(0, 7) === month);
    for (const t of txs) { if (SPECIAL[t.cat]) continue; actual[t.cat] = (actual[t.cat] || 0) - t.amount; count[t.cat] = (count[t.cat] || 0) + 1; }
    const cats = [...new Set([...Object.keys(plan), ...Object.keys(actual)])];
    const rows = cats.map(c => { const p = plan[c] || 0, a = actual[c] || 0; return { category: c, plan: p, actual: a, variance: a - p, pct: p ? (a - p) / p * 100 : null, count: count[c] || 0 }; })
      .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    const P = rows.reduce((s, r) => s + r.plan, 0), A = rows.reduce((s, r) => s + r.actual, 0);
    return { month, rows, plan: P, actual: A, variance: A - P, txns: txs.length, income: txs.filter(t => t.cat === 'Income').reduce((s, t) => s + t.amount, 0) };
  }
  // Recalibration (1.7): average plan and actual per category over these months (normally the last three
  // complete ones). `over` when total spending runs more than 10% above plan; `rows` are the categories more
  // than 10% (and at least £20) away from plan, furthest first.
  function recalibrate(d, ms, ctx) {
    const agg = {}, n = ms.length;
    for (const m of ms) for (const r of budgetVsActual(d, m, ctx).rows) { const a = agg[r.category] ||= { category: r.category, plan: 0, actual: 0 }; a.plan += r.plan / n; a.actual += r.actual / n; }
    const all = Object.values(agg), P = all.reduce((s, r) => s + r.plan, 0), A = all.reduce((s, r) => s + r.actual, 0);
    const rows = all.filter(r => r.plan > 0 && Math.abs(r.actual - r.plan) > r.plan * 0.1 && Math.abs(r.actual - r.plan) >= 20).sort((a, b) => Math.abs(b.actual - b.plan) - Math.abs(a.actual - a.plan));
    return { months: ms, plan: P, actual: A, over: P > 0 && A > P * 1.1, rows };
  }
  // Months with any transactions, newest first
  const months = d => [...new Set((d.transactions || []).map(t => t.date.slice(0, 7)))].sort().reverse();

  // ---------- recurring payments (2.4) ----------
  // Money out to the same merchant at a steady rhythm and a similar amount. Needs three payments
  // (two for yearly). Flags: new (three payments or fewer, all within the last few cycles), price rise (latest up more than 2%
  // on the one before), stopped (overdue by half a cycle and more).
  function recurring(cat, today) {
    const dayN = d => Date.parse(d + 'T00:00:00Z') / 864e5, now = dayN(today);
    const groups = {};
    for (const t of cat) if (t.amount < 0 && t.cat !== 'Transfer' && t.cat !== 'Ignore') (groups[t.account + '|' + t.merchant] ||= []).push(t);
    const out = [];
    for (const list of Object.values(groups)) {
      const l = list.sort((a, b) => a.date.localeCompare(b.date));
      if (l.length < 2) continue;
      const gaps = l.slice(1).map((t, i) => dayN(t.date) - dayN(l[i].date)).filter(g => g > 0);
      if (!gaps.length) continue;
      const med = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      const cadence = med >= 5 && med <= 9 ? 'weekly' : med >= 12 && med <= 17 ? 'fortnightly' : med >= 25 && med <= 35 ? 'monthly' : med >= 80 && med <= 100 ? 'quarterly' : med >= 350 && med <= 380 ? 'yearly' : null;
      if (!cadence || l.length < (cadence === 'yearly' ? 2 : 3)) continue;
      const steady = gaps.filter(g => Math.abs(g - med) <= Math.max(4, med * 0.25)).length >= Math.ceil(gaps.length * 0.7);
      const amts = l.map(t => -t.amount), last = amts.at(-1), typical = amts.slice().sort((a, b) => a - b)[Math.floor(amts.length / 2)];
      const similar = amts.filter(a => Math.abs(a - typical) <= Math.max(2, typical * 0.2)).length >= Math.ceil(amts.length * 0.7);
      if (!steady || !similar) continue;
      const lastDay = dayN(l.at(-1).date);
      // a price rise: the last time the amount changed, within the last few payments, it went up by more than 2%
      let j = amts.length - 2; while (j >= 0 && Math.abs(amts[j] - last) <= last * 0.02) j--;
      const rose = j >= 0 && j >= amts.length - 4 && last > amts[j] * 1.02;
      out.push({
        merchant: l[0].merchant, account: l[0].account, cadence, every: med, count: l.length, amount: last, typical, perMonth: typical * 30.44 / med,
        first: l[0].date, last: l.at(-1).date, next: new Date((lastDay + med) * 864e5).toISOString().slice(0, 10),
        isNew: l.length <= 3 && dayN(l[0].date) >= now - 3.5 * med, rise: rose ? last - amts[j] : 0, riseSince: rose ? l[j + 1].date : null, stopped: now - lastDay > med * 1.5, category: l.at(-1).cat,
      });
    }
    return out.sort((a, b) => b.perMonth - a.perMonth);
  }

  // ---------- analytics (Sep 2026) ----------
  // Money out (spending less refunds, in every category but the special ones), money in (Income) or both ('net':
  // in positive, out negative), month by month over a window of whole months, split by category, merchant or account.
  // `partial` is a month still running: it is drawn, never totalled, averaged or compared. `prevMonths` is the window
  // just before, of the same length, for "against the period before" - pass it only when every month in it has data.
  const keyOf = (t, by) => (by === 'merchant' ? t.merchant || t.description || '?' : by === 'account' ? t.account : t.cat);
  const valueOf = (t, measure) => {
    if (measure === 'income') return t.cat === 'Income' ? t.amount : null;
    if (measure === 'net') return t.cat === 'Income' || !SPECIAL[t.cat] ? t.amount : null;
    return SPECIAL[t.cat] ? null : -t.amount;
  };
  function insights(list, { months, prevMonths = [], measure = 'spend', by = 'category', account = null, focus = null, partial = null }) {
    const full = months.filter(m => m !== partial), n = full.length, idx = Object.fromEntries(full.map((m, i) => [m, i]));
    const inP = new Set(prevMonths), groups = {}, inWindow = [];
    const series = months.map(m => ({ month: m, spend: 0, income: 0, v: 0, count: 0, partial: m === partial }));
    const at = Object.fromEntries(months.map((m, i) => [m, series[i]]));
    const g = k => (groups[k] ||= { key: k, total: 0, prev: 0, count: 0, byMonth: full.map(() => 0) });
    let prevTotal = 0;
    for (const t of list) {
      if (account && t.account !== account) continue;
      if (focus && keyOf(t, focus.by) !== focus.key) continue;
      const m = t.date.slice(0, 7), v = valueOf(t, measure);
      if (inP.has(m) && v != null) { prevTotal += v; g(keyOf(t, by)).prev += v; }
      const s = at[m]; if (!s) continue;
      if (t.cat === 'Income') s.income += t.amount; else if (!SPECIAL[t.cat]) s.spend -= t.amount;
      if (v == null) continue;
      s.v += v; s.count++;
      if (m === partial) continue;
      const G = g(keyOf(t, by)); G.total += v; G.count++; G.byMonth[idx[m]] += v; inWindow.push({ ...t, value: v });
    }
    const total = full.reduce((a, m) => a + at[m].v, 0), cmp = prevMonths.length === n && n > 0;
    const sum = Object.values(groups).reduce((a, x) => a + Math.abs(x.total), 0);
    const rows = Object.values(groups).filter(x => x.count || x.prev).map(x => ({ ...x, avg: n ? x.total / n : 0, share: sum ? Math.abs(x.total) / sum : 0, change: cmp ? x.total - x.prev : null }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    // what is changing: the average of the last three whole months against the three before, where the move is
    // at least £20 a month and a tenth of what it was
    let movers = null;
    if (n >= 6) {
      const avg = (arr, a, b) => arr.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
      movers = rows.map(r => { const before = avg(r.byMonth, n - 6, n - 3), after = avg(r.byMonth, n - 3, n); return { key: r.key, before, after, delta: after - before }; })
        .filter(x => Math.abs(x.delta) >= Math.max(20, Math.abs(x.before) * 0.1)).sort((a, b) => b.delta - a.delta);
      movers = { up: movers.filter(x => x.delta > 0).slice(0, 3), down: movers.filter(x => x.delta < 0).reverse().slice(0, 3) };
    }
    const biggest = inWindow.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 5);
    const count = rows.reduce((a, r) => a + r.count, 0);
    return { months, full, series, total, avg: n ? total / n : 0, count, perTxn: count ? total / count : 0, prev: cmp ? prevTotal : null, change: cmp ? total - prevTotal : null, rows, movers, biggest };
  }

  return { insights, insightKey: keyOf, insightValue: valueOf, parseCSV, detect, read, fresh, FORMATS, merchantOf, categoryOf, ruleMatches, transferPairs, categorised, budgetVsActual, recalibrate, months, recurring, SPECIAL, hash };
})();

if (typeof module !== 'undefined') module.exports = TallyTx;
