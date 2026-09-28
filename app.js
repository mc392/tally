// ================= Tally app =================
const STORE = 'tally.v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

let data = null;
let meta = { fileName: null, dirty: false, savedAt: null, private: false };
const ui = { tab: 'home', stacks: { home: [], accounts: [], projection: [], plan: [] }, owner: 'all', scenario: null, horizon: null, anim: '' };
let fileHandle = null; // desktop browsers only: write straight back to the opened file

// ---------- formatting ----------
const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(v, o = {}) {
  if (v == null || isNaN(v)) return '–';
  const s = (o.dp ? nf2 : nf0).format(Math.abs(v));
  const sign = v < 0 ? '−' : (o.sign && v > 0 ? '+' : '');
  return `${sign}£${s}`;
}
function short(v) {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(a >= 1e7 ? 0 : 2).replace(/\.?0+$/, '')}m`;
  if (a >= 1e3) return `${sign}£${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `${sign}£${Math.round(a)}`;
}
const amt = (v, o = {}) => `<span class="amt num ${o.color && v < 0 ? 'neg' : ''} ${o.cls || ''}">${money(v, o)}</span>`;
const chg = v => `<span class="amt num ${v > 0.5 ? 'up' : v < -0.5 ? 'down' : ''}">${money(v, { sign: true })}</span>`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fDate(d) { if (!d) return '–'; const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MON[m - 1]} ${y}`; }
function fMonth(d, shortY) { const [y, m] = d.split('-').map(Number); return `${MON[m - 1]} ${shortY ? "'" + String(y).slice(2) : y}`; }
function todayISO() { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; }
function daysSince(d) { return Math.round((Date.parse(todayISO()) - Date.parse(d)) / 864e5); }
function monthEndT(d) { const [y, m] = d.split('-').map(Number); return Date.UTC(y, m, 0); }
function parseNum(s) { if (s == null) return null; const t = String(s).replace(/[£,\s]/g, '').replace('−', '-'); if (t === '' || t === '-') return null; const n = Number(t); return isNaN(n) ? null : n; }
const uid = p => `${p}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- data helpers ----------
const TYPE_LABEL = { ss_isa: 'Stocks & shares ISA', cash_isa: 'Cash ISA', savings: 'Savings', current: 'Current account', card: 'Credit card', card_0: '0% credit card', tax: 'Tax owed' };
const LIAB = new Set(['card', 'card_0', 'tax']);
const POOLS = [
  { key: 'isa', label: 'ISAs', types: ['ss_isa', 'cash_isa'], color: 'var(--c-isa)', note: 'Stocks & shares and cash ISAs. Surplus cash is swept here in the projection.' },
  { key: 'cash', label: 'Cash', types: ['current', 'card'], color: 'var(--c-cash)', note: 'Current accounts less everyday card balances. The projection holds this at your cash floor.' },
  { key: 'savings', label: 'Savings', types: ['savings'], color: 'var(--c-sav)', note: 'Non-ISA savings accounts.' },
  { key: 'debt', label: 'Other debts', types: ['card_0', 'tax'], color: 'var(--c-debt)', note: '0% cards and tax owed. Settle them with an upcoming payment in Plan.' },
];
const ICONS = {
  isa: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15l4.5-4.5 3 3L17 6"/><path d="M13 6h4v4"/></svg>',
  cash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="5" width="15" height="10" rx="2"/><circle cx="10" cy="10" r="2"/></svg>',
  savings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l6-4 6 4"/><path d="M5 9v6M10 9v6M15 9v6M3 16.5h14"/></svg>',
  debt: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M2.5 8.5h15"/></svg>',
};
const CHEV = '<svg class="chev" viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5L6.5 7l-5 5.5"/></svg>';
const BACK = '<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L2 10l8 8"/></svg>';
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const CHECK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';

const person = id => (data.people.find(p => p.id === id) || { name: id }).name;
const acc = id => data.accounts.find(a => a.id === id);
const snapsSorted = () => [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
const scenarioKey = () => ui.scenario || data.scenario || 'cautious';
const horizon = () => ui.horizon || data.horizonMonths || 18;
function poolOf(type) { return POOLS.find(p => p.types.includes(type)) || POOLS[2]; }
function poolTotal(snap, pool) { return data.accounts.filter(a => pool.types.includes(a.type)).reduce((s, a) => s + (snap?.balances[a.id] || 0), 0); }
function prevValue(id, beforeDate) {
  const s = snapsSorted().filter(x => x.date < beforeDate && x.balances[id] != null);
  return s.length ? s[s.length - 1].balances[id] : null;
}

function normalise(d) {
  d.people ||= [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }];
  d.accounts ||= []; d.snapshots ||= []; d.income ||= []; d.spending ||= []; d.events ||= [];
  d.mortgage ||= { payment: 0 };
  d.rules = Object.assign({ cashFloor: 10000, isaAllowance: 40000, isaUsed: 0, isaUsedTaxYear: new Date().getFullYear(), sweepToSS: 0 }, d.rules || {});
  d.bufferPct ??= 5;
  d.scenarios ||= {
    cautious: { name: 'Cautious', growth: false, ssReturn: 0, inflation: 0, payRise: 0 },
    base: { name: 'Base', growth: true, ssReturn: 5, inflation: 3, payRise: 2 },
    optimistic: { name: 'Optimistic', growth: true, ssReturn: 7, inflation: 2, payRise: 3 },
  };
  d.scenario ||= 'cautious'; d.horizonMonths ||= 18;
  return d;
}
function blankFile() {
  return normalise({ app: 'tally', version: 1, people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }], mortgage: { payment: 0 } });
}

// ---------- persistence (working copy on this device) ----------
function persist() { try { localStorage.setItem(STORE, JSON.stringify({ data, meta })); } catch (e) { } }
function restore() {
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && s.data) { data = normalise(s.data); Object.assign(meta, s.meta || {}); } } catch (e) { }
}
function changed(msg) { meta.dirty = true; persist(); render(); if (msg) toast(msg); }

// ---------- file storage: your file, your cloud ----------
function fileText() { data.savedAt = new Date().toISOString(); return JSON.stringify(data, null, 1); }
function suggestedName() { return meta.fileName || 'family-finances.json'; }

async function saveFile() {
  const text = fileText(), name = suggestedName();
  try {
    // 1) Desktop Chrome/Edge: write straight back into the file you opened (e.g. in your OneDrive / iCloud Drive folder)
    if (fileHandle && fileHandle.createWritable) {
      const w = await fileHandle.createWritable(); await w.write(text); await w.close(); return saved('Saved to ' + fileHandle.name);
    }
    // 2) Inside Claude: the platform's save prompt (share sheet on iPhone)
    if (window.claude && window.claude.use) {
      const dl = await Promise.race([window.claude.use('downloads'), new Promise(r => setTimeout(() => r(null), 1500))]);
      if (dl) { await dl.save({ filename: name, data: text }); return saved('Saved ' + name); }
    }
    // 3) iPhone / iPad: share sheet → "Save to Files" → iCloud Drive or OneDrive
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return saved('Shared ' + name); }
    // 4) Desktop fallback: pick a location
    if (window.showSaveFilePicker && !framed) {
      fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Tally file', accept: { 'application/json': ['.json'] } }] });
      meta.fileName = fileHandle.name; return saveFile();
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); saved('Downloaded ' + name);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'declined')) return toast('Save cancelled', true);
    toast('Could not save: ' + (e.message || e.code || 'unknown error'), true);
  }
}
function saved(msg) { meta.dirty = false; meta.savedAt = new Date().toISOString(); persist(); render(); toast(msg); }

async function openFile() {
  if (window.showOpenFilePicker && !framed) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Tally file', accept: { 'application/json': ['.json'] } }] });
      const f = await h.getFile(); fileHandle = h; return loadText(await f.text(), f.name);
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  $('#fileIn').click();
}
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return; fileHandle = null;
  loadText(await f.text(), f.name); e.target.value = '';
});
function loadText(text, name) {
  let d; try { d = JSON.parse(text); } catch (e) { return toast('That file isn’t valid JSON', true); }
  if (!d || !Array.isArray(d.accounts) || !Array.isArray(d.snapshots)) return toast('That isn’t a Tally file', true);
  if (data && meta.dirty && !confirm('You have unsaved changes. Replace them with this file?')) return;
  data = normalise(d); meta.fileName = name || meta.fileName; meta.dirty = false; meta.savedAt = d.savedAt || null;
  ui.stacks = { home: [], accounts: [], projection: [], plan: [] }; ui.tab = 'home';
  persist(); render(); toast('Opened ' + (name || 'file'));
}

// ---------- toast ----------
let toastT;
function toast(msg, warn) {
  const t = $('#toast'); t.innerHTML = (warn ? '' : CHECK) + `<span>${esc(msg)}</span>`;
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- building blocks ----------
function row(o) {
  const tag = o.act && !o.right ? 'button' : 'div';
  const attrs = o.act ? ` data-act="${o.act}" data-arg="${esc(o.arg ?? '')}"${tag === 'div' ? ' role="button" tabindex="0"' : ''}` : '';
  return `<${tag} class="row ${o.icon ? 'ic' : ''} ${tag === 'div' && o.act ? 'tap' : ''} ${o.cls || ''}"${attrs}>
    ${o.icon ? `<span class="gicon" style="background:${o.iconBg}">${o.icon}</span>` : ''}
    <div class="main"><div class="ttl">${o.title}</div>${o.sub ? `<div class="sub">${o.sub}</div>` : ''}</div>
    ${o.value != null ? `<div class="val ${o.strong ? 'strong' : ''}">${o.value}${o.vsub ? `<div class="sub">${o.vsub}</div>` : ''}</div>` : ''}
    ${o.right || ''}${o.act && o.chev !== false ? CHEV : ''}</${tag}>`;
}
const group = (rows, head, foot) => `<section class="group">${head ? `<div class="gh">${head}</div>` : ''}<div class="list">${rows}</div>${foot ? `<div class="gf">${foot}</div>` : ''}</section>`;
const seg = (opts, cur, act) => `<div class="seg" role="tablist">${opts.map(([v, l]) => `<button role="tab" aria-selected="${v === cur}" class="${v === cur ? 'on' : ''}" data-act="${act}" data-arg="${v}">${l}</button>`).join('')}</div>`;
const sw = (checked, act, arg) => `<span class="switch" onclick="event.stopPropagation()"><input type="checkbox" ${checked ? 'checked' : ''} data-chg="${act}" data-arg="${esc(arg)}" aria-label="Include"><span></span></span>`;

// ---------- charts (SVG + HTML overlay, scrubbable) ----------
const charts = {};
function chart(id, { series, height = 170, fmt = short, floor = null, markers = [] }) {
  const all = series.flatMap(s => s.pts);
  if (all.length < 2) return `<div class="note">Add at least two balance updates to see a trend.</div>`;
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
  let lo = Math.min(...all.map(p => p.v), floor ?? Infinity), hi = Math.max(...all.map(p => p.v), floor ?? -Infinity);
  const pad = (hi - lo) * .12 || Math.abs(hi) * .1 || 1; lo -= pad; hi += pad * .6;
  if (lo > 0 && lo < (hi - lo) * .5) lo = 0;
  const W = 1000, H = height;
  const X = t => (t - t0) / ((t1 - t0) || 1) * W, Y = v => H - (v - lo) / ((hi - lo) || 1) * H;
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const ticks = niceTicks(lo, hi, 3);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true">`;
  for (const v of ticks) svg += `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--sep)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  if (floor != null) svg += `<line x1="0" x2="${W}" y1="${Y(floor)}" y2="${Y(floor)}" stroke="var(--orange)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`;
  for (const s of series) {
    if (s.fill) svg += `<path d="${path(s.pts)}L${X(s.pts.at(-1).t)},${H}L${X(s.pts[0].t)},${H}Z" fill="${s.color}" opacity=".08"/>`;
    svg += `<path d="${path(s.pts)}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2.2}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" ${s.dash ? 'stroke-dasharray="5 5"' : ''}/>`;
  }
  for (const m of markers) svg += `<line x1="${X(m.t)}" x2="${X(m.t)}" y1="${H - 7}" y2="${H}" stroke="${m.v < 0 ? 'var(--red)' : 'var(--green)'}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
  svg += '</svg>';
  const yl = ticks.map(v => `<div class="yl" style="top:${(Y(v) / H * 100).toFixed(2)}%">${fmt(v)}</div>`).join('');
  const fl = floor != null ? `<div class="yl" style="top:${(Y(floor) / H * 100).toFixed(2)}%;right:auto;left:0;color:var(--orange)">floor ${fmt(floor)}</div>` : '';
  const x0 = new Date(t0), x1 = new Date(t1), xm = new Date((t0 + t1) / 2);
  const xl = d => `${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  charts[id] = { series, t0, t1, lo, hi, H, fmt };
  return `<div class="readout" id="${id}-r"></div><div class="chart" id="${id}"><div style="position:relative">${svg}${yl}${fl}<div class="cursor"></div>${series.map((s, i) => `<div class="dot" data-i="${i}" style="background:${s.color}"></div>`).join('')}</div><div class="xl"><span>${xl(x0)}</span><span>${xl(xm)}</span><span>${xl(x1)}</span></div></div>`;
}
function niceTicks(lo, hi, n) {
  const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0 || 1)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v); return out;
}
function mountChart(id) {
  const c = charts[id], el = document.getElementById(id); if (!c || !el) return;
  const r = document.getElementById(id + '-r'), box = el.firstElementChild;
  const near = (pts, t) => pts.reduce((b, p) => Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b, pts[0]);
  const show = (t, scrub) => {
    const head = new Date(t);
    const label = scrub ? `${head.getUTCDate() > 27 || head.getUTCDate() < 3 ? MON[head.getUTCMonth()] + ' ' + head.getUTCFullYear() : head.getUTCDate() + ' ' + MON[head.getUTCMonth()] + ' ' + head.getUTCFullYear()}` : (c.series[0].whenLabel || 'Latest');
    r.innerHTML = `<div class="when">${label}</div>` + c.series.map(s => { const p = near(s.pts, t); return `<span class="s"><i style="background:${s.color}"></i>${s.name} ${money(p.v)}</span>`; }).join('');
    if (!scrub) return;
    const x = (t - c.t0) / ((c.t1 - c.t0) || 1) * 100;
    box.querySelector('.cursor').style.left = x + '%';
    box.querySelectorAll('.dot').forEach(d => {
      const s = c.series[+d.dataset.i], p = near(s.pts, t);
      d.style.left = ((p.t - c.t0) / ((c.t1 - c.t0) || 1) * 100) + '%';
      d.style.top = ((1 - (p.v - c.lo) / ((c.hi - c.lo) || 1)) * c.H) + 'px';
    });
  };
  const at = e => { const b = box.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)); return c.t0 + f * (c.t1 - c.t0); };
  const move = e => { el.classList.add('scrub'); show(at(e), true); };
  const end = () => { el.classList.remove('scrub'); show(c.series[0].focusT ?? c.t1, false); };
  el.addEventListener('pointerdown', move); el.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons || e.pressure) move(e); });
  el.addEventListener('pointerup', end); el.addEventListener('pointerleave', end); el.addEventListener('pointercancel', end);
  end();
}

// ---------- views ----------
function vWelcome() {
  return { title: 'Tally', noNav: true, body: `<div class="welcome">
    <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18l5-6 4 3 7-9"/></svg></div>
    <h2>Your money, in one file you own.</h2>
    <p>Tally keeps your balances and plans in a file in your own iCloud Drive or OneDrive, not on a server. Open that file to get started.</p>
    <button class="cta" data-act="open-file">Open finance file</button>
    <button class="cta ghost" data-act="new-file">Start a new file</button>
    <button class="cta ghost" data-act="paste">Paste file contents</button>
  </div>` };
}

function vHome() {
  const snaps = snapsSorted(), last = snaps.at(-1), prev = snaps.at(-2);
  if (!last) return { title: 'Overview', large: true, right: headerRight(), body: `<div class="hero"><div class="cap">No balances yet</div></div><button class="cta" data-act="update">${PLUS}Add your first balances</button>${group(row({ title: 'Add an account', act: 'add-account', cls: 'act-row', chev: false }), 'Start here', 'Add each account once, then record balances whenever you like. Each update is kept as a dated milestone.')}` };
  const T = snapshotTotals(data, last), P = prev ? snapshotTotals(data, prev) : null;
  const pr = project(data, scenarioKey(), horizon()), end = pr.rows.at(-1);
  const days = daysSince(last.date);
  const m = data.mortgage;
  const equity = m.propertyValue && m.balance != null ? m.propertyValue - m.balance : null;
  const big = money(T.net).replace('£', '<span class="p">£</span>');

  const hist = snaps.map(s => ({ t: Date.parse(s.date), v: snapshotTotals(data, s).net }));
  const fut = [{ t: Date.parse(last.date), v: T.net }, ...pr.rows.map(r => ({ t: monthEndT(r.date), v: r.net }))];
  const ch = chart('c-home', {
    series: [
      { name: 'Actual', color: 'var(--c-net)', pts: hist, fill: true, focusT: Date.parse(last.date), whenLabel: `Actual at ${fDate(last.date)}` },
      { name: 'Projected', color: 'var(--c-isa)', pts: fut, dash: true },
    ], height: 150,
  });

  const lowest = pr.rows.reduce((b, r) => r.closing < b.closing ? r : b, pr.rows[0]);
  const nextEv = data.events.filter(e => e.on && e.date >= todayISO().slice(0, 8) + '01').sort((a, b) => a.date.localeCompare(b.date))[0];
  const bud = monthlyBudget(data);
  const sc = data.scenarios[scenarioKey()];

  return {
    title: 'Overview', large: true, right: headerRight(),
    body: `
    <div class="hero">
      <div class="cap">Net worth · ${fDate(last.date)}</div>
      <div class="big amt">${big}</div>
      ${P ? `<div class="chg">${chg(T.net - P.net)} <span>since ${fDate(prev.date)}</span></div>` : ''}
      ${equity != null ? `<div class="eq">${amt(T.net + equity)} including home equity</div>` : ''}
    </div>
    <button class="cta" data-act="update">${PLUS}Update balances</button>
    <div class="stale">${days <= 0 ? 'Updated today' : `Last updated ${days} day${days === 1 ? '' : 's'} ago`}${meta.dirty ? ' · not yet saved to your file' : ''}</div>
    <section class="card"><div class="gh">Net worth, actual and projected<b>${esc(sc.name)}</b></div>${ch}
      <div class="legend"><span><i style="background:var(--c-net)"></i>Recorded</span><span style="color:var(--c-isa)"><i class="dash"></i><span style="color:var(--label2)">Projected ${horizon()} months</span></span></div></section>
    ${group(POOLS.map(p => {
      const v = poolTotal(last, p), pv = prev ? poolTotal(prev, p) : null;
      if (!data.accounts.some(a => p.types.includes(a.type))) return '';
      return row({ icon: ICONS[p.key], iconBg: p.color, title: p.label, sub: pv != null ? `${chg(v - pv)} since last update` : '', value: amt(v, { color: true }), strong: true, act: 'push', arg: 'pool:' + p.key });
    }).join(''), 'Where it sits')}
    ${group(
      row({ title: `ISA pot by ${fMonth(end.date)}`, value: amt(end.isa), strong: true, act: 'tab', arg: 'projection' }) +
      row({ title: `Cash by ${fMonth(end.date)}`, value: amt(end.closing), act: 'tab', arg: 'projection' }) +
      row({ title: 'Lowest cash month', sub: fMonth(lowest.date), value: amt(lowest.closing, { color: true }), act: 'push', arg: 'month:' + lowest.k, cls: 'tap' }) +
      (nextEv ? row({ title: 'Next big item', sub: `${esc(nextEv.name)} · ${fMonth(nextEv.date)}`, value: amt(nextEv.amount, { color: true, sign: true }), act: 'push', arg: 'events' }) : ''),
      `Looking ahead<b>${esc(sc.name)} scenario</b>`)}
    ${group(
      row({ title: 'Coming in', value: amt(bud.income), act: 'tab', arg: 'plan' }) +
      row({ title: 'Going out', value: amt(-bud.out), act: 'tab', arg: 'plan' }) +
      row({ title: 'Monthly surplus', value: amt(bud.surplus, { color: true }), strong: true, sub: bud.income ? `${Math.round(bud.surplus / bud.income * 100)}% of take-home` : '', act: 'tab', arg: 'plan' }),
      'Each month')}
  `, after: () => mountChart('c-home'),
  };
}

function headerRight() {
  const st = meta.dirty ? `<button class="pill warn" data-act="save">Save</button>` : '';
  return `${st}<button class="iconbtn" data-act="private" aria-label="${meta.private ? 'Show amounts' : 'Hide amounts'}">${meta.private ? EYE_OFF : EYE}</button>`;
}

function vPool(key) {
  const p = POOLS.find(x => x.key === key), snaps = snapsSorted(), last = snaps.at(-1);
  const accs = data.accounts.filter(a => p.types.includes(a.type) && (a.active || last?.balances[a.id]));
  const hist = snaps.map(s => ({ t: Date.parse(s.date), v: poolTotal(s, p) }));
  const byOwner = data.people.map(pp => {
    const list = accs.filter(a => a.owner === pp.id); if (!list.length) return '';
    return group(list.map(a => accRow(a, last)).join(''), `${esc(pp.name)}<b>${amt(list.reduce((s, a) => s + (last?.balances[a.id] || 0), 0))}</b>`);
  }).join('');
  return {
    title: p.label, large: true, back: 'Overview',
    body: `<div class="hero"><div class="cap">${p.label} · ${fDate(last?.date)}</div><div class="big amt">${money(poolTotal(last, p)).replace('£', '<span class="p">£</span>')}</div></div>
    <section class="card">${chart('c-pool', { series: [{ name: p.label, color: p.color, pts: hist, fill: true }] })}</section>
    ${byOwner}<p class="note">${p.note}</p>`, after: () => mountChart('c-pool'),
  };
}

function accRow(a, snap) {
  const v = snap?.balances[a.id]; const pv = snap ? prevValue(a.id, snap.date) : null;
  return row({ title: esc(a.name) + (a.active ? '' : '<span class="tag">Closed</span>'), sub: `${TYPE_LABEL[a.type]}${a.rate ? ` · ${a.rate}%` : ''}`, value: v == null ? '–' : amt(v, { color: true }), vsub: v != null && pv != null && Math.abs(v - pv) > .5 ? chg(v - pv) : '', strong: true, act: 'push', arg: 'acct:' + a.id });
}

function vAccounts() {
  const last = snapsSorted().at(-1);
  const owners = [['all', 'All'], ...data.people.map(p => [p.id, p.name])];
  const list = data.accounts.filter(a => (ui.owner === 'all' || a.owner === ui.owner));
  const groups = Object.keys(TYPE_LABEL).map(t => {
    const l = list.filter(a => a.type === t && (a.active || (last && last.balances[a.id]))); if (!l.length) return '';
    const tot = l.reduce((s, a) => s + (last?.balances[a.id] || 0), 0);
    return group(l.map(a => accRow(a, last)).join(''), `${TYPE_LABEL[t]}${t.endsWith('isa') ? 's' : t === 'current' ? 's' : ''}<b>${amt(tot)}</b>`);
  }).join('');
  const closed = list.filter(a => !a.active && !(last && last.balances[a.id]));
  const tot = list.reduce((s, a) => s + (last?.balances[a.id] || 0), 0);
  return {
    title: 'Accounts', large: true, right: `<button class="iconbtn" data-act="add-account" aria-label="Add account">${PLUS}</button>`,
    body: `${seg(owners, ui.owner, 'owner')}
      <div class="hero" style="margin-top:0"><div class="cap">${ui.owner === 'all' ? 'Everything' : esc(person(ui.owner))} · ${fDate(last?.date)}</div><div class="big amt" style="font-size:40px">${money(tot).replace('£', '<span class="p">£</span>')}</div></div>
      ${groups || group(row({ title: 'Add your first account', act: 'add-account', cls: 'act-row', chev: false }))}
      ${closed.length ? group(closed.map(a => accRow(a, last)).join(''), 'Closed') : ''}
      ${group(row({ title: 'Balance history', sub: `${data.snapshots.length} dated updates`, act: 'push', arg: 'snaps' }) + row({ title: 'Update balances', act: 'update', cls: 'act-row', chev: false }))}`,
  };
}

function vAccount(id) {
  const a = acc(id); if (!a) return vAccounts();
  const snaps = snapsSorted().filter(s => s.balances[id] != null);
  const last = snaps.at(-1);
  const hist = snaps.map(s => ({ t: Date.parse(s.date), v: s.balances[id] }));
  const pool = poolOf(a.type);
  const first = snaps[0];
  const rows = [...snaps].reverse().map((s, i, arr) => {
    const nxt = arr[i + 1]; const d = nxt ? s.balances[id] - nxt.balances[id] : null;
    return row({ title: fDate(s.date), value: amt(s.balances[id], { color: true }), vsub: d != null ? chg(d) : '', act: 'push', arg: 'snap:' + s.date, strong: true });
  }).join('');
  return {
    title: a.name, large: true, back: 'Back',
    right: `<button class="pill" data-act="edit-account" data-arg="${a.id}" style="color:var(--accent)">Edit</button>`,
    body: `<div class="subtitle">${esc(person(a.owner))} · ${TYPE_LABEL[a.type]}${a.active ? '' : ' · closed'}</div>
      <div class="hero"><div class="cap">Balance · ${fDate(last?.date)}</div><div class="big amt">${last ? money(last.balances[id]).replace('£', '<span class="p">£</span>') : '–'}</div>
      ${first && last && first !== last ? `<div class="chg">${chg(last.balances[id] - first.balances[id])} <span>since ${fDate(first.date)}</span></div>` : ''}</div>
      ${hist.length > 1 ? `<section class="card">${chart('c-acc', { series: [{ name: a.name, color: pool.color, pts: hist, fill: true }] })}</section>` : ''}
      ${group(
        row({ title: 'Interest / expected return', value: a.rate ? `${a.rate}% a year` : 'Not set', act: 'edit-account', arg: a.id }) +
        row({ title: 'Counts towards', value: pool.label, act: 'edit-account', arg: a.id }) +
        (a.note ? row({ title: 'Note', sub: esc(a.note), act: 'edit-account', arg: a.id }) : ''), 'Details')}
      ${rows ? group(rows, 'History') : ''}`,
    after: () => hist.length > 1 && mountChart('c-acc'),
  };
}

function vSnaps() {
  const s = snapsSorted().reverse();
  return {
    title: 'Balance history', large: true, back: 'Accounts',
    body: group(s.map((x, i) => {
      const t = snapshotTotals(data, x).net, p = s[i + 1] ? snapshotTotals(data, s[i + 1]).net : null;
      return row({ title: fDate(x.date), sub: `${Object.keys(x.balances).length} accounts`, value: amt(t), vsub: p != null ? chg(t - p) : '', strong: true, act: 'push', arg: 'snap:' + x.date });
    }).join('') || row({ title: 'No updates yet' }), 'Net worth at each update', 'Each update is a dated milestone. Tap one to see or correct the balances recorded on that day.'),
  };
}

function vSnap(date) {
  const s = data.snapshots.find(x => x.date === date); if (!s) return vSnaps();
  const T = snapshotTotals(data, s);
  const rows = data.people.map(p => {
    const l = data.accounts.filter(a => a.owner === p.id && s.balances[a.id] != null); if (!l.length) return '';
    return group(l.map(a => { const pv = prevValue(a.id, date); return row({ title: esc(a.name), value: amt(s.balances[a.id], { color: true }), vsub: pv != null ? chg(s.balances[a.id] - pv) : '', strong: true, act: 'push', arg: 'acct:' + a.id }); }).join(''), esc(p.name));
  }).join('');
  return {
    title: fDate(date), large: true, back: 'History',
    body: `<div class="hero"><div class="cap">Net worth</div><div class="big amt">${money(T.net).replace('£', '<span class="p">£</span>')}</div></div>
      ${rows}${group(row({ title: 'Edit these balances', act: 'update', arg: date, cls: 'act-row', chev: false }) + row({ title: 'Delete this update', act: 'del-snap', arg: date, cls: 'act-row danger', chev: false }))}`,
  };
}

// ---------- projection ----------
function vProjection() {
  const sk = scenarioKey(), sc = data.scenarios[sk], pr = project(data, sk, horizon());
  if (!pr) return { title: 'Projection', large: true, body: `<p class="note">Record your balances first — the projection starts from your latest update.</p><button class="cta" data-act="update">${PLUS}Update balances</button>` };
  const R = pr.rows, end = R.at(-1), first = snapshotTotals(data, latestSnapshot(data));
  const tFirst = Date.parse(pr.snapDate);
  const pts = f => [{ t: tFirst, v: f === 'net' ? first.net : f === 'isa' ? first.isa : first.cash }, ...R.map(r => ({ t: monthEndT(r.date), v: f === 'net' ? r.net : f === 'isa' ? r.isa : r.closing }))];
  const markers = R.flatMap(r => r.events.map(e => ({ t: monthEndT(r.date), v: e.amount })));
  const c1 = chart('c-proj', { series: [{ name: 'Net worth', color: 'var(--c-net)', pts: pts('net') }, { name: 'ISAs', color: 'var(--c-isa)', pts: pts('isa'), fill: true }].map((x, i) => i ? x : { ...x, whenLabel: `End of ${fMonth(end.date)}` }), height: 180, markers });
  const c2 = chart('c-cash', { series: [{ name: 'Cash', color: 'var(--c-cash)', pts: pts('cash'), fill: true, whenLabel: `End of ${fMonth(end.date)}` }], height: 120, floor: +data.rules.cashFloor, markers });
  const tops = R.reduce((s, r) => s + r.topUp, 0), wds = R.reduce((s, r) => s + r.withdraw, 0), growth = R.reduce((s, r) => s + r.growth, 0);
  const lowest = R.reduce((b, r) => r.closing < b.closing ? r : b, R[0]);
  const short_ = R.filter(r => r.shortfall > 0.5);
  // tax-year summary
  const tys = {}; for (const r of R) { const t = tys[r.taxYear] ||= { in: 0, out: 0, left: 0 }; t.in += r.topUp; t.out += r.withdraw; t.left = r.freshEnd + r.replEnd; }
  const months = R.map(r => {
    const b = [];
    for (const e of r.events) b.push(`<span class="badge ${e.amount < 0 ? 'out' : 'in'}">${esc(e.name)} ${short(e.amount)}</span>`);
    if (r.topUp > 0.5) b.push(`<span class="badge isa">To ISA ${short(r.topUp)}</span>`);
    if (r.withdraw > 0.5) b.push(`<span class="badge out">From ISA ${short(r.withdraw)}</span>`);
    return `<button class="row" data-act="push" data-arg="month:${r.k}"><div class="main"><div class="ttl">${fMonth(r.date)}</div>${b.length ? `<div class="badges">${b.join('')}</div>` : ''}</div><div class="val strong">${amt(r.net)}<div class="sub">cash ${amt(r.closing)}</div></div>${CHEV}</button>`;
  }).join('');
  return {
    title: 'Projection', large: true,
    body: `${seg(Object.entries(data.scenarios).map(([k, v]) => [k, esc(v.name)]), sk, 'scenario')}
      <div class="chips">${[[18, '18 months'], [36, '3 years'], [60, '5 years'], [120, '10 years']].map(([n, l]) => `<button class="${n === horizon() ? 'on' : ''}" data-act="horizon" data-arg="${n}">${l}</button>`).join('')}</div>
      <section class="card"><div class="gh">Net worth and ISAs<b>from ${fDate(pr.snapDate)}</b></div>${c1}
        <div class="legend"><span><i style="background:var(--c-net)"></i>Net worth</span><span><i style="background:var(--c-isa)"></i>ISAs</span><span><i style="background:var(--red)"></i>Payment</span><span><i style="background:var(--green)"></i>Receipt</span></div></section>
      <section class="card"><div class="gh">Cash held<b>floor ${amt(+data.rules.cashFloor)}</b></div>${c2}</section>
      <div class="stats">
        <div><div class="k">Net worth</div><div class="v amt">${short(end.net)}</div><div class="n">${fMonth(end.date)} · ${chg(end.net - first.net)}</div></div>
        <div><div class="k">ISA pot</div><div class="v amt">${short(end.isa)}</div><div class="n">${chg(end.isa - first.isa)}</div></div>
        <div><div class="k">Moved into ISAs</div><div class="v amt">${short(tops)}</div><div class="n">${short(wds)} drawn back out</div></div>
        <div><div class="k">Lowest cash</div><div class="v amt ${lowest.closing < data.rules.cashFloor - 1 ? 'neg' : ''}">${short(lowest.closing)}</div><div class="n">${fMonth(lowest.date)}</div></div>
        ${sc.growth ? `<div><div class="k">Growth and interest</div><div class="v amt">${short(growth)}</div><div class="n">S&amp;S ${sc.ssReturn}% · cash ISA ${pr.cashIsaRate.toFixed(1)}%</div></div>` : `<div><div class="k">Growth and interest</div><div class="v">Off</div><div class="n">Excluded to stay prudent</div></div>`}
        <div><div class="k">Monthly surplus now</div><div class="v amt">${short(R[0].surplus)}</div><div class="n">${sc.payRise || sc.inflation ? `pay +${sc.payRise}% · costs +${sc.inflation}% a year` : 'held flat'}</div></div>
      </div>
      ${short_.length ? group(short_.map(r => row({ title: fMonth(r.date), sub: 'ISAs can’t cover the floor', value: amt(-r.shortfall, { color: true }), act: 'push', arg: 'month:' + r.k })).join(''), 'Shortfalls') : ''}
      ${group(Object.entries(tys).map(([y, t]) => row({ title: `${y}/${String(+y + 1).slice(2)}`, sub: `In ${short(t.in)} · out ${short(t.out)}`, value: amt(t.left), vsub: 'allowance left' })).join(''), 'ISA allowance by tax year', `Uses your ${money(data.rules.isaAllowance)} household allowance. Money taken out of a flexible ISA can be put back in the same tax year without using new allowance; the projection tracks that separately.`)}
      ${group(months, 'Month by month', 'Tap a month for the full cash waterfall and ISA workings.')}
      ${group(row({ title: `${esc(sc.name)} assumptions`, sub: sc.growth ? `S&S ${sc.ssReturn}% · inflation ${sc.inflation}% · pay ${sc.payRise}%` : 'No growth, no inflation, no pay rises', act: 'push', arg: 'scenario:' + sk }) + row({ title: 'Cash floor and ISA rules', act: 'edit-rules' }) + row({ title: 'Upcoming payments and receipts', value: String(data.events.filter(e => e.on).length), act: 'push', arg: 'events' }), 'Refine')}`,
    after: () => { mountChart('c-proj'); mountChart('c-cash'); },
  };
}

function vMonth(k) {
  const pr = project(data, scenarioKey(), Math.max(horizon(), +k - ymKeyOf(latestSnapshot(data).date) + 1));
  const r = pr.rows.find(x => x.k === +k); if (!r) return vProjection();
  const line = (t, v, o = {}) => row({ title: t, sub: o.sub, value: amt(v, { sign: o.sign, color: true }), cls: o.total ? 'total' : '' });
  const evRows = r.events.map(e => line(esc(e.name), e.amount, { sign: true, sub: 'Upcoming item' })).join('');
  const m = r.mortgageBal != null;
  return {
    title: fMonth(r.date), large: true, back: 'Projection',
    body: `<div class="subtitle">${esc(data.scenarios[scenarioKey()].name)} scenario · tax year ${r.taxYear}/${String(r.taxYear + 1).slice(2)}</div>
      <div class="wf">${group(
        line('Opening cash', r.opening) + line('Take-home pay', r.income, { sign: true }) + line('Regular spending', -r.spend, { sign: true }) + line(`Buffer (${data.bufferPct}%)`, -r.buffer, { sign: true }) + evRows + line('Cash before ISA moves', r.before, { total: true }),
        'Cash waterfall')}
      ${group(
        (r.topUp > .5 ? line('Moved into ISAs', -r.topUp, { sign: true, sub: 'Cash above your floor, up to the allowance' }) : '') +
        (r.withdraw > .5 ? line('Drawn from ISAs', r.withdraw, { sign: true, sub: 'To keep cash at your floor' }) : '') +
        (r.topUp <= .5 && r.withdraw <= .5 ? row({ title: 'No ISA movement', sub: r.before > data.rules.cashFloor ? 'No allowance left this tax year' : 'Cash is at the floor' }) : '') +
        line('Closing cash', r.closing, { total: true }), 'ISA moves')}
      ${group(
        line('New allowance at start', r.freshStart) + line('Re-deposit room at start', r.replStart, { sub: 'Flexible ISA withdrawals this tax year' }) + line('Room left at end', r.freshEnd + r.replEnd, { total: true }),
        'ISA allowance')}
      ${group(
        line('Stocks & shares ISAs', r.isaSS) + line('Cash ISAs', r.isaCash) + (r.growth ? line('Growth this month', r.growth, { sign: true }) : '') + line('Other savings and debts', r.other) + line('Net worth', r.net, { total: true }),
        'Balances at month end')}
      ${m ? group(line('Mortgage payment', -r.mortgagePay) + line('Of which interest', -r.mortgageInterest) + line('Mortgage balance', -r.mortgageBal, { total: true }), 'Mortgage') : ''}</div>`,
  };
}
function ymKeyOf(d) { const [y, m] = d.split('-').map(Number); return y * 12 + m - 1; }

function vScenario(key) {
  const s = data.scenarios[key];
  return {
    title: s.name, large: true, back: 'Back',
    body: `${group(
      row({ title: 'Include growth and interest', right: sw(s.growth, 'sc-growth', key) }) +
      row({ title: 'Stocks & shares return', value: `${s.ssReturn}% a year`, act: 'edit-scenario', arg: key }) +
      row({ title: 'Cash ISA and savings interest', value: 'Per account', act: 'tab', arg: 'accounts' }) +
      row({ title: 'Spending inflation', value: `${s.inflation}% a year`, act: 'edit-scenario', arg: key }) +
      row({ title: 'Pay rises', value: `${s.payRise}% a year`, act: 'edit-scenario', arg: key }), 'Assumptions',
      'Inflation and pay rises step up each April. Interest on cash ISAs and savings uses the rate on each account. Growth is added monthly.')}
      ${group(row({ title: 'Use as default', right: sw(data.scenario === key, 'sc-default', key) }), '', 'The default scenario is what Overview shows when you open the app.')}`,
  };
}

// ---------- plan ----------
function vPlan() {
  const b = monthlyBudget(data), m = data.mortgage, r = data.rules;
  const cats = {}; for (const l of data.spending) { const v = l.linked === 'mortgage' ? (+m.payment || 0) : (+l.annual || 0) / 12; cats[l.category || 'Other'] = (cats[l.category || 'Other'] || 0) + v; }
  const inc = data.income.map(i => row({ title: esc(i.name), sub: esc(person(i.owner)) + (i.growth ? ` · +${i.growth}% a year` : ''), value: amt(i.monthly), act: 'edit-income', arg: i.id })).join('');
  return {
    title: 'Plan', large: true, right: headerRight(),
    body: `<div class="stats">
        <div><div class="k">Coming in</div><div class="v amt">${short(b.income)}</div><div class="n">a month</div></div>
        <div><div class="k">Going out</div><div class="v amt">${short(b.out)}</div><div class="n">incl. ${data.bufferPct}% buffer</div></div>
        <div style="grid-column:span 2"><div class="k">Surplus</div><div class="v amt ${b.surplus < 0 ? 'neg' : ''}">${money(b.surplus)} a month</div>
          <div class="bar-mini"><i style="width:${Math.max(0, Math.min(100, b.surplus / (b.income || 1) * 100))}%"></i></div><div class="n">${Math.round(b.surplus / (b.income || 1) * 100)}% of take-home kept</div></div>
      </div>
      ${group(inc + row({ title: 'Add income', act: 'add-income', cls: 'act-row', chev: false }), 'Income (monthly, after tax)')}
      ${group(Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => row({ title: esc(c), value: amt(v), vsub: `${short(v * 12)} a year`, act: 'push', arg: 'spending:' + c })).join('') +
        row({ title: 'Buffer for the unexpected', value: `${data.bufferPct}%`, act: 'edit-buffer' }) + row({ title: 'Add spending', act: 'add-spend', cls: 'act-row', chev: false }), 'Spending (monthly)')}
      ${group(
        row({ title: 'Mortgage', value: amt(m.payment), vsub: m.balance != null ? `${short(m.balance)} owed` : 'balance not set', act: 'push', arg: 'mortgage' }) +
        row({ title: 'Upcoming payments and receipts', value: String(data.events.filter(e => e.on).length), act: 'push', arg: 'events' }), 'Commitments')}
      ${group(
        row({ title: 'Cash floor', value: amt(r.cashFloor), act: 'edit-rules' }) +
        row({ title: 'ISA allowance (household)', value: amt(r.isaAllowance), act: 'edit-rules' }) +
        row({ title: `Used in ${r.isaUsedTaxYear}/${String(+r.isaUsedTaxYear + 1).slice(2)}`, value: amt(r.isaUsed), act: 'edit-rules' }) +
        row({ title: 'Top-ups going to S&S ISAs', value: `${r.sweepToSS || 0}%`, act: 'edit-rules' }), 'Rules', 'Each month, cash above the floor moves into ISAs until the allowance is used. If cash would drop below the floor, the shortfall comes back out of cash ISAs first.')}
      ${group(Object.entries(data.scenarios).map(([k, s]) => row({ title: esc(s.name) + (data.scenario === k ? '<span class="tag">Default</span>' : ''), sub: s.growth ? `S&S ${s.ssReturn}% · inflation ${s.inflation}% · pay ${s.payRise}%` : 'Growth off', act: 'push', arg: 'scenario:' + k })).join(''), 'Scenarios')}
      ${group(
        row({ title: 'Names', sub: data.people.map(p => esc(p.name)).join(', '), act: 'edit-people' }) +
        row({ title: 'Finance file', sub: esc(meta.fileName || 'Not saved to a file yet'), value: meta.dirty ? '<span class="pill warn">Unsaved</span>' : meta.savedAt ? '<span class="pill ok">Saved</span>' : '', chev: false }) +
        row({ title: 'Save to file', act: 'save', cls: 'act-row', chev: false }) +
        row({ title: 'Open a different file', act: 'open-file', cls: 'act-row', chev: false }) +
        row({ title: 'Paste file contents', act: 'paste', cls: 'act-row', chev: false }),
        'Your data', saveHelp())}`,
  };
}
function saveHelp() {
  if (fileHandle) return 'Saves write straight back to the file you opened.';
  return 'On iPhone, Save opens the share sheet: choose Save to Files, then your iCloud Drive or OneDrive folder, and replace the old copy. This device also keeps a working copy between saves.';
}

function vSpending(cat) {
  const m = data.mortgage;
  const l = data.spending.filter(x => (x.category || 'Other') === cat);
  return {
    title: cat, large: true, back: 'Plan',
    body: group(l.map(x => {
      const mon = x.linked === 'mortgage' ? +m.payment || 0 : (+x.annual || 0) / 12;
      return row({ title: esc(x.name), sub: x.linked === 'mortgage' ? 'Set on the mortgage page' : x.inflates ? 'Rises with inflation' : 'Fixed', value: amt(mon), vsub: `${short(mon * 12)} a year`, act: x.linked === 'mortgage' ? 'push' : 'edit-spend', arg: x.linked === 'mortgage' ? 'mortgage' : x.id });
    }).join('') + row({ title: 'Add to ' + esc(cat), act: 'add-spend', arg: cat, cls: 'act-row', chev: false }), 'Monthly'),
  };
}

function vEvents() {
  const ev = [...data.events].sort((a, b) => a.date.localeCompare(b.date));
  const net = ev.filter(e => e.on).reduce((s, e) => s + e.amount, 0);
  return {
    title: 'Upcoming', large: true, back: 'Back', right: `<button class="iconbtn" data-act="add-event" aria-label="Add item">${PLUS}</button>`,
    body: `${group(ev.map(e => row({ title: esc(e.name), sub: fMonth(e.date) + (e.settles ? ` · clears ${esc(acc(e.settles)?.name || '')}` : ''), value: amt(e.amount, { color: true, sign: true }), act: 'edit-event', arg: e.id, right: sw(e.on, 'ev-on', e.id), chev: false })).join('') || row({ title: 'Nothing planned' }),
      `One-off items<b>net ${money(net, { sign: true })}</b>`, 'Switch items off to see the projection without them. They stay here for later.')}
      ${group(row({ title: 'Add a payment or receipt', act: 'add-event', cls: 'act-row', chev: false }))}`,
  };
}

function vMortgage() {
  const m = data.mortgage;
  const pr = project(data, scenarioKey(), horizon()), end = pr.rows.at(-1);
  const full = m.balance != null && m.rate != null;
  const eq = m.propertyValue && m.balance != null ? m.propertyValue - m.balance : null;
  const fix = m.fixEnd ? Math.max(0, ymKeyOf(m.fixEnd) - ymKeyOf(todayISO())) : null;
  const newPay = full && m.fixEnd && m.newRate != null && m.termEnd ? pr.rows.find(r => r.date >= m.fixEnd)?.mortgagePay : null;
  return {
    title: 'Mortgage', large: true, back: 'Plan', right: `<button class="pill" data-act="edit-mortgage" style="color:var(--accent)">Edit</button>`,
    body: `<div class="hero"><div class="cap">Monthly payment</div><div class="big amt">${money(m.payment, { dp: 0 }).replace('£', '<span class="p">£</span>')}</div>${eq != null ? `<div class="eq">Home equity ${amt(eq)}</div>` : ''}</div>
      ${group(
        row({ title: 'Balance owed', value: m.balance != null ? amt(m.balance) : 'Not set', act: 'edit-mortgage' }) +
        row({ title: 'Current rate', value: m.rate != null ? `${m.rate}%` : 'Not set', act: 'edit-mortgage' }) +
        row({ title: 'Fixed until', value: m.fixEnd ? fMonth(m.fixEnd) : 'Not set', vsub: fix != null ? `${fix} months away` : '', act: 'edit-mortgage' }) +
        row({ title: 'Rate after the fix', value: m.newRate != null ? `${m.newRate}%` : 'Not set', act: 'edit-mortgage' }) +
        row({ title: 'Mortgage ends', value: m.termEnd ? fMonth(m.termEnd) : 'Not set', act: 'edit-mortgage' }) +
        row({ title: 'Home value', value: m.propertyValue ? amt(m.propertyValue) : 'Not set', act: 'edit-mortgage' }), 'Details')}
      ${full ? group(
        row({ title: `Balance by ${fMonth(end.date)}`, value: amt(end.mortgageBal) }) +
        (newPay ? row({ title: 'Payment after the fix', value: amt(newPay), vsub: chg(newPay - m.payment) + ' a month' }) : ''), 'Projection') : ''}
      <p class="note">${full ? 'The projection runs the balance down month by month. If you set a rate after the fix and an end date, the payment is recalculated when the fix ends and flows into your monthly surplus.' : 'Add the balance and rate to see the balance fall over time, and a post-fix rate to model a remortgage. Until then, the payment above is used as a flat monthly cost.'}</p>`,
  };
}

// ---------- sheets ----------
function sheet({ title, body, done = 'Save', onDone, onOpen }) {
  const w = document.createElement('div'); w.className = 'sheet-wrap';
  w.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="sh"><button class="cancel">Cancel</button><div class="t">${esc(title)}</div>${done ? `<button class="done">${esc(done)}</button>` : '<span></span>'}</div><form class="sb" novalidate>${body}</form></div>`;
  document.body.appendChild(w); document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add('open')));
  const close = () => { w.classList.remove('open'); document.body.style.overflow = ''; setTimeout(() => w.remove(), 350); };
  w.addEventListener('click', e => { if (e.target === w) close(); });
  w.querySelector('.cancel').onclick = close;
  const form = w.querySelector('form');
  const submit = e => { e && e.preventDefault(); if (onDone && onDone(form, close) !== false) close(); };
  if (done) w.querySelector('.done').onclick = submit;
  form.addEventListener('submit', submit);
  form.addEventListener('click', e => { const b = e.target.closest('[data-sact]'); if (b) { e.preventDefault(); b.dataset.sact === 'close' ? close() : onDone && onDone(form, close, b.dataset.sact); } });
  onOpen && onOpen(form, close);
  return { close, form };
}

function fieldHTML(f, v) {
  const id = 'f_' + f.key;
  const lab = `<label for="${id}">${esc(f.label)}${f.hint ? `<span class="sub">${esc(f.hint)}</span>` : ''}</label>`;
  if (f.type === 'toggle') return `<div class="field">${lab}<span class="switch"><input id="${id}" name="${f.key}" type="checkbox" ${v ? 'checked' : ''}><span></span></span></div>`;
  if (f.type === 'select') return `<div class="field">${lab}<select id="${id}" name="${f.key}">${f.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v ?? '') ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select></div>`;
  if (f.type === 'date') return `<div class="field">${lab}<input id="${id}" name="${f.key}" type="date" value="${esc(v || '')}"></div>`;
  const shown = v == null || v === '' ? '' : (f.type === 'money' ? nf2.format(v).replace(/\.00$/, '') : String(v));
  const mode = f.type === 'text' ? 'text' : 'decimal';
  return `<div class="field">${lab}<input id="${id}" name="${f.key}" type="text" inputmode="${mode}" class="${f.type === 'text' ? 'wide' : 'num'}" value="${esc(shown)}" placeholder="${esc(f.ph || (f.optional ? 'Not set' : ''))}" autocomplete="off">${f.unit ? `<span class="unit">${f.unit}</span>` : ''}</div>`;
}
function readFields(form, fields) {
  const out = {};
  for (const f of fields) {
    const el = form.elements[f.key]; if (!el) continue;
    if (f.type === 'toggle') out[f.key] = el.checked;
    else if (f.type === 'text' || f.type === 'select' || f.type === 'date') out[f.key] = el.value || (f.optional ? null : '');
    else { const n = parseNum(el.value); out[f.key] = n == null ? (f.optional ? null : 0) : n; }
  }
  return out;
}
function formSheet({ title, sections, values, onSave, extra = '' }) {
  const all = sections.flatMap(s => s.fields);
  const body = sections.map(s => `<section class="group">${s.head ? `<div class="gh">${esc(s.head)}</div>` : ''}<div class="list">${s.fields.map(f => fieldHTML(f, values[f.key])).join('')}</div>${s.foot ? `<div class="gf">${esc(s.foot)}</div>` : ''}</section>`).join('') + extra;
  sheet({ title, body, onDone: (form, close, act) => {
    if (act) { onSave(null, act); close(); return; }
    const v = readFields(form, all); return onSave(v);
  } });
}
const destructive = (label, act) => `<section class="group"><div class="list"><button class="row act-row danger" data-sact="${act}"><div class="main"><div class="ttl">${esc(label)}</div></div></button></div></section>`;

function updateSheet(date) {
  const target = date ? data.snapshots.find(s => s.date === date) : null;
  const last = snapsSorted().at(-1);
  const base = target || last;
  const accs = data.accounts.filter(a => a.active || (target && target.balances[a.id] != null));
  const body = `<section class="group"><div class="list"><div class="field"><label for="u_date">Balances as at</label><input type="date" id="u_date" name="__date" value="${esc(date || todayISO())}"></div></div>
    <div class="gf">${target ? 'You’re correcting an earlier update.' : 'Start from your last figures and change what’s moved. Using an existing date replaces that update.'}</div></section>` +
    data.people.map(p => {
      const l = accs.filter(a => a.owner === p.id); if (!l.length) return '';
      return `<section class="group"><div class="gh">${esc(p.name)}</div><div class="list">${l.map(a => {
        const liab = LIAB.has(a.type), v = base?.balances[a.id];
        const shown = v == null ? '' : nf2.format(Math.abs(liab ? -v : v) === 0 ? 0 : (liab ? -v : v)).replace(/\.00$/, '');
        return `<div class="field"><label for="b_${a.id}">${esc(a.name)}<span class="sub" data-d="${a.id}">${liab ? 'Amount owed · ' : ''}last ${v == null ? '–' : money(liab ? Math.abs(v) : v)}</span></label><span class="amtin">£<input type="text" inputmode="decimal" id="b_${a.id}" name="b_${a.id}" class="bal-in num" data-liab="${liab ? 1 : 0}" data-last="${v ?? ''}" value="${esc(shown)}" placeholder="0" autocomplete="off"></span></div>`;
      }).join('')}</div></section>`;
    }).join('') + `<section class="group"><div class="list"><div class="field"><label>Net worth</label><span class="num" id="u_total" style="font-weight:600"></span></div></div></section>`;
  sheet({
    title: target ? fDate(date) : 'Update balances', body, done: 'Save',
    onOpen: form => {
      const recalc = () => {
        let tot = 0;
        form.querySelectorAll('.bal-in').forEach(i => {
          let n = parseNum(i.value); const liab = i.dataset.liab === '1'; if (n != null && liab) n = -Math.abs(n);
          if (n != null) tot += n;
          const last = i.dataset.last === '' ? null : +i.dataset.last, id = i.name.slice(2), d = form.querySelector(`[data-d="${CSS.escape(id)}"]`);
          if (d) d.innerHTML = `${liab ? 'Amount owed · ' : ''}last ${last == null ? '–' : money(liab ? Math.abs(last) : last)}${n != null && last != null && Math.abs(n - last) > .5 ? ' · <span class="delta ' + (n > last ? 'up' : 'down') + '">' + money(liab ? Math.abs(n) - Math.abs(last) : n - last, { sign: true }) + '</span>' : ''}`;
        });
        form.querySelector('#u_total').textContent = money(tot);
      };
      form.addEventListener('input', recalc); recalc();
      form.querySelectorAll('.bal-in').forEach(i => i.addEventListener('focus', () => setTimeout(() => i.select(), 0)));
    },
    onDone: form => {
      const d = form.elements.__date.value; if (!d) { toast('Choose a date', true); return false; }
      const balances = {};
      form.querySelectorAll('.bal-in').forEach(i => { let n = parseNum(i.value); if (n == null) return; if (i.dataset.liab === '1') n = -Math.abs(n); balances[i.name.slice(2)] = Math.round(n * 100) / 100; });
      if (target && d !== date) data.snapshots = data.snapshots.filter(s => s.date !== date);
      const ex = data.snapshots.find(s => s.date === d);
      if (ex) ex.balances = balances; else data.snapshots.push({ date: d, balances });
      if (target) { const st = ui.stacks[ui.tab]; if (st.at(-1) === 'snap:' + date) st[st.length - 1] = 'snap:' + d; }
      changed(`Balances saved for ${fDate(d)}`);
    },
  });
}

const ownerOpts = () => data.people.map(p => [p.id, p.name]);
function accountSheet(id) {
  const a = id ? acc(id) : { name: '', owner: data.people[0].id, type: 'current', rate: 0, active: true, note: '' };
  formSheet({
    title: id ? 'Edit account' : 'New account', values: a,
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text', ph: 'e.g. Vanguard S&S ISA' }, { key: 'owner', label: 'Belongs to', type: 'select', options: ownerOpts() }, { key: 'type', label: 'Type', type: 'select', options: Object.entries(TYPE_LABEL) }] },
    { head: 'Projection', fields: [{ key: 'rate', label: 'Interest or return', type: 'percent', unit: '%', hint: 'Cash ISAs and savings use this; S&S ISAs use the scenario return' }, { key: 'active', label: 'Open', type: 'toggle', hint: 'Closed accounts drop out of new updates' }] },
    { head: 'Notes', fields: [{ key: 'note', label: 'Note', type: 'text', optional: true, ph: 'Optional' }] }],
    extra: id ? destructive('Delete account', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') {
        if (!confirm(`Delete ${a.name}? Its balance history is removed from every update.`)) return;
        data.accounts = data.accounts.filter(x => x.id !== id); data.snapshots.forEach(s => delete s.balances[id]);
        ui.stacks[ui.tab] = ui.stacks[ui.tab].filter(r => r !== 'acct:' + id); return changed('Account deleted');
      }
      if (!v.name.trim()) { toast('Give the account a name', true); return false; }
      if (id) Object.assign(a, v); else data.accounts.push({ id: uid('a'), ...v });
      changed(id ? 'Account updated' : 'Account added');
    },
  });
}
function incomeSheet(id) {
  const x = id ? data.income.find(i => i.id === id) : { name: '', owner: data.people[0].id, monthly: 0, growth: 0 };
  formSheet({
    title: id ? 'Edit income' : 'New income', values: x,
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'owner', label: 'Whose', type: 'select', options: ownerOpts() }, { key: 'monthly', label: 'Monthly, after tax', type: 'money', unit: '' }, { key: 'growth', label: 'Extra rise each April', type: 'percent', unit: '%', hint: 'On top of the scenario pay rise' }] }],
    extra: id ? destructive('Delete income', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.income = data.income.filter(i => i.id !== id); return changed('Income removed'); }
      if (id) Object.assign(x, v); else data.income.push({ id: uid('inc'), ...v }); changed('Income saved');
    },
  });
}
function spendSheet(id, cat) {
  const x = id ? data.spending.find(s => s.id === id) : { name: '', category: cat || 'Living', annual: 0, inflates: true };
  const cats = [...new Set([...data.spending.map(s => s.category || 'Other'), 'Home', 'Bills', 'Living', 'Transport', 'Other'])];
  formSheet({
    title: id ? 'Edit spending' : 'New spending', values: { ...x, monthly: Math.round((x.annual || 0) / 12 * 100) / 100 },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'category', label: 'Category', type: 'select', options: cats.map(c => [c, c]) }] },
    { head: 'Amount — fill in either', foot: 'If you change both, the yearly figure wins.', fields: [{ key: 'monthly', label: 'Per month', type: 'money' }, { key: 'annual', label: 'Per year', type: 'money' }] },
    { fields: [{ key: 'inflates', label: 'Rises with inflation', type: 'toggle' }] }],
    extra: id ? destructive('Delete', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.spending = data.spending.filter(s => s.id !== id); return changed('Removed'); }
      const annual = Math.abs(v.annual - (x.annual || 0)) > .005 ? v.annual : v.monthly * 12;
      const rec = { name: v.name, category: v.category, annual: Math.round(annual * 100) / 100, inflates: v.inflates };
      if (id) Object.assign(x, rec); else data.spending.push({ id: uid('sp'), ...rec }); changed('Spending saved');
    },
  });
}
function eventSheet(id) {
  const x = id ? data.events.find(e => e.id === id) : { name: '', amount: -1000, date: todayISO().slice(0, 8) + '01', on: true, settles: '' };
  const debtOpts = [['', 'Nothing'], ...data.accounts.filter(a => LIAB.has(a.type)).map(a => [a.id, a.name])];
  formSheet({
    title: id ? 'Edit item' : 'New item', values: { ...x, dir: x.amount < 0 ? 'out' : 'in', abs: Math.abs(x.amount), settles: x.settles || '' },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'dir', label: 'Type', type: 'select', options: [['out', 'Payment out'], ['in', 'Money in']] }, { key: 'abs', label: 'Amount', type: 'money' }, { key: 'date', label: 'Month', type: 'date', hint: 'Counted in this month' }] },
    { foot: 'If this payment clears a debt, choose it so the debt isn’t counted twice.', fields: [{ key: 'settles', label: 'Clears a debt', type: 'select', options: debtOpts }, { key: 'on', label: 'Include in projection', type: 'toggle' }] }],
    extra: id ? destructive('Delete item', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.events = data.events.filter(e => e.id !== id); return changed('Item deleted'); }
      if (!v.date) { toast('Choose a month', true); return false; }
      const rec = { name: v.name || 'Untitled', amount: (v.dir === 'out' ? -1 : 1) * Math.abs(v.abs), date: v.date.slice(0, 8) + '01', on: v.on, settles: v.settles || undefined };
      if (id) Object.assign(x, rec); else data.events.push({ id: uid('ev'), ...rec }); changed('Item saved');
    },
  });
}
function mortgageSheet() {
  const m = data.mortgage;
  formSheet({
    title: 'Mortgage', values: m,
    sections: [{ fields: [{ key: 'payment', label: 'Monthly payment', type: 'money' }, { key: 'balance', label: 'Balance owed', type: 'money', optional: true }, { key: 'rate', label: 'Current rate', type: 'percent', unit: '%', optional: true }] },
    { head: 'Remortgage', fields: [{ key: 'fixEnd', label: 'Fixed until', type: 'date', optional: true }, { key: 'newRate', label: 'Rate after the fix', type: 'percent', unit: '%', optional: true }, { key: 'termEnd', label: 'Mortgage ends', type: 'date', optional: true }] },
    { head: 'Home', fields: [{ key: 'propertyValue', label: 'Estimated value', type: 'money', optional: true }] }],
    onSave: v => { Object.assign(m, v); changed('Mortgage saved'); },
  });
}
function rulesSheet() {
  const r = data.rules;
  formSheet({
    title: 'Rules', values: r,
    sections: [{ foot: 'The projection keeps at least this much in current accounts.', fields: [{ key: 'cashFloor', label: 'Cash floor', type: 'money' }] },
    { head: 'ISAs', foot: 'Enter the tax year by its starting year, e.g. 2026 for 2026/27.', fields: [{ key: 'isaAllowance', label: 'Household allowance', type: 'money' }, { key: 'isaUsed', label: 'Already paid in', type: 'money' }, { key: 'isaUsedTaxYear', label: 'In tax year starting', type: 'number' }, { key: 'sweepToSS', label: 'Share of top-ups to S&S', type: 'percent', unit: '%', hint: 'The rest goes to cash ISAs' }] }],
    onSave: v => { Object.assign(r, v); changed('Rules saved'); },
  });
}
function scenarioSheet(key) {
  const s = data.scenarios[key];
  formSheet({
    title: s.name, values: s,
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'growth', label: 'Include growth and interest', type: 'toggle' }, { key: 'ssReturn', label: 'S&S return', type: 'percent', unit: '%' }, { key: 'inflation', label: 'Spending inflation', type: 'percent', unit: '%' }, { key: 'payRise', label: 'Pay rises', type: 'percent', unit: '%' }] }],
    onSave: v => { Object.assign(s, v); changed('Scenario saved'); },
  });
}
function peopleSheet() {
  const vals = Object.fromEntries(data.people.map(p => [p.id, p.name]));
  formSheet({ title: 'Names', values: vals, sections: [{ fields: data.people.map(p => ({ key: p.id, label: p.id === 'J' ? 'Shared' : 'Person', type: 'text' })) }], onSave: v => { data.people.forEach(p => p.name = v[p.id] || p.name); changed('Names saved'); } });
}
function pasteSheet() {
  sheet({ title: 'Paste file', body: `<p class="note">Open your finance file in the Files app, copy everything, and paste it here.</p><textarea name="t" placeholder="{ … }"></textarea>`, done: 'Load', onDone: form => { loadText(form.elements.t.value, meta.fileName || 'family-finances.json'); } });
}

// ---------- router ----------
function currentView() {
  if (!data) return vWelcome();
  const top = ui.stacks[ui.tab].at(-1);
  if (top) {
    const [kind, arg] = [top.slice(0, top.indexOf(':') < 0 ? top.length : top.indexOf(':')), top.includes(':') ? top.slice(top.indexOf(':') + 1) : null];
    const v = ({ pool: vPool, acct: vAccount, snaps: vSnaps, snap: vSnap, month: vMonth, scenario: vScenario, spending: vSpending, events: vEvents, mortgage: vMortgage })[kind];
    if (v) return v(arg);
  }
  return ({ home: vHome, accounts: vAccounts, projection: vProjection, plan: vPlan })[ui.tab]();
}

function render(opts = {}) {
  document.body.classList.toggle('private', !!meta.private);
  const v = currentView();
  $('#tabbar').style.display = data ? '' : 'none';
  $('#nav').style.display = v.noNav ? 'none' : '';
  $('#navT').textContent = v.title || '';
  const TABN = { home: 'Overview', accounts: 'Accounts', projection: 'Projection', plan: 'Plan' };
  const backLabel = ui.stacks[ui.tab].length > 1 ? 'Back' : TABN[ui.tab];
  $('#navL').innerHTML = v.back ? `<button class="back" data-act="back">${BACK}${esc(backLabel)}</button>` : '';
  $('#navR').innerHTML = v.right || '';
  $('#main').innerHTML = `<div class="page ${ui.anim}">${v.large && !v.noNav ? `<h1 class="large">${esc(v.title)}</h1>` : ''}${v.body}</div>`;
  ui.anim = '';
  document.querySelectorAll('#tabbar button').forEach(b => { const on = b.dataset.arg === ui.tab; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  if (opts.top) window.scrollTo(0, 0);
  onScroll();
  v.after && v.after();
}
function onScroll() { $('#nav').classList.toggle('solid', window.scrollY > 38); }
window.addEventListener('scroll', onScroll, { passive: true });

const actions = {
  tab: t => { if (ui.tab === t && ui.stacks[t].length) ui.stacks[t] = []; ui.tab = t; render({ top: true }); },
  push: r => { ui.stacks[ui.tab].push(r); ui.anim = 'push-in'; render({ top: true }); },
  back: () => { ui.stacks[ui.tab].pop(); ui.anim = 'pop-in'; render({ top: true }); },
  update: d => updateSheet(d || null),
  save: saveFile, 'open-file': openFile, paste: pasteSheet,
  'new-file': () => { data = blankFile(); meta = { fileName: 'family-finances.json', dirty: true, savedAt: null, private: false }; persist(); render(); },
  private: () => { meta.private = !meta.private; persist(); render(); },
  owner: o => { ui.owner = o; render(); },
  scenario: k => { ui.scenario = k; render(); },
  horizon: n => { ui.horizon = +n; render(); },
  'add-account': () => accountSheet(null), 'edit-account': accountSheet,
  'add-income': () => incomeSheet(null), 'edit-income': incomeSheet,
  'add-spend': c => spendSheet(null, c), 'edit-spend': id => spendSheet(id),
  'add-event': () => eventSheet(null), 'edit-event': eventSheet,
  'edit-mortgage': mortgageSheet, 'edit-rules': rulesSheet, 'edit-scenario': scenarioSheet, 'edit-people': peopleSheet,
  'edit-buffer': () => formSheet({ title: 'Buffer', values: { bufferPct: data.bufferPct }, sections: [{ foot: 'Added on top of all regular spending, including the mortgage.', fields: [{ key: 'bufferPct', label: 'Buffer', type: 'percent', unit: '%' }] }], onSave: v => { data.bufferPct = v.bufferPct; changed('Buffer saved'); } }),
  'del-snap': d => { if (!confirm(`Delete the update from ${fDate(d)}?`)) return; data.snapshots = data.snapshots.filter(s => s.date !== d); ui.stacks[ui.tab].pop(); changed('Update deleted'); },
};
const changes = {
  'ev-on': (id, on) => { data.events.find(e => e.id === id).on = on; changed(); },
  'sc-growth': (k, on) => { data.scenarios[k].growth = on; changed(); },
  'sc-default': (k, on) => { if (on) { data.scenario = k; ui.scenario = k; changed(); } else render(); },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.closest('.sheet')) return;
  const f = actions[b.dataset.act]; if (f) { e.preventDefault(); f(b.dataset.arg || undefined); }
});
document.addEventListener('change', e => {
  const i = e.target.closest('[data-chg]'); if (!i || i.closest('.sheet')) return;
  changes[i.dataset.chg] && changes[i.dataset.chg](i.dataset.arg, i.checked);
});
window.addEventListener('beforeunload', e => { if (meta.dirty && !framed) { e.preventDefault(); e.returnValue = ''; } });

// ---------- start ----------
restore();
if (!framed && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if (!framed) { const l = document.createElement('link'); l.rel = 'manifest'; l.href = 'manifest.webmanifest'; document.head.appendChild(l); }
render();
