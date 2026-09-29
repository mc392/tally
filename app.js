// ================= Tally app =================
const STORE = 'tally.v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

let data = null;
// base = writer mark of the file version this device last read or wrote (see storage.js)
let meta = { fileName: null, dirty: false, savedAt: null, private: true, encrypt: false, base: null, conflict: false };
const ui = { tab: 'home', stacks: { home: [], accounts: [], projection: [], plan: [] }, owner: 'all', scenario: null, horizon: null, anim: '' };

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
const TYPE_LABEL = { ss_isa: 'Stocks & shares ISA', cash_isa: 'Cash ISA', savings: 'Savings', current: 'Current account', pension: 'Pension', card: 'Credit card', card_0: '0% credit card', tax: 'Tax owed' };
const TM = TallyModel;
const thisMonth = () => todayISO().slice(0, 7);
const flowsOf = kind => data.flows.filter(f => f.kind === kind && !f.bundle); // life-event lines live on their event's page
const bundleById = id => data.bundles.find(b => b.id === id);
const bundleLines = id => data.flows.filter(f => f.bundle === id);
// shaded bands for the projection charts: each event that is on, from its first month to its last
function bundleBands(t0, t1) {
  return data.bundles.filter(b => b.on).map(b => { const sp = TM.bundleSpan(data, b.id); return sp && sp.from ? { name: b.name, from: Date.parse(sp.from + '-01'), to: sp.to ? monthEndT(sp.to + '-01') : t1 } : null; }).filter(Boolean);
}
const flowById = id => data.flows.find(f => f.id === id);
// "from Sep 2027", "until Mar 2028", "Sep 2027 – Mar 2028" - blank when it runs all the time
function flowWhen(f) {
  if (f.kind === 'oneoff') return f.start ? fMonth(f.start) : 'No month set';
  if (f.start && f.end) return `${fMonth(f.start, true)} – ${fMonth(f.end, true)}`;
  if (f.start) return `from ${fMonth(f.start)}`;
  if (f.end) return `until ${fMonth(f.end)}`;
  return '';
}
const flowLiveNow = f => TM.flowActive(f, TM.monthKey(thisMonth()));
const LIAB = new Set(['card', 'card_0', 'tax']);
const POOLS = [
  { key: 'isa', label: 'ISAs', types: ['ss_isa', 'cash_isa'], color: 'var(--c-isa)', note: 'Stocks & shares and cash ISAs. Surplus cash is swept here in the projection.' },
  { key: 'cash', label: 'Cash', types: ['current', 'card'], color: 'var(--c-cash)', note: 'Current accounts less everyday card balances. The projection holds this at your cash floor.' },
  { key: 'savings', label: 'Savings', types: ['savings', 'pension'], color: 'var(--c-sav)', note: 'Non-ISA savings accounts.' },
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
// Two accounts can share a name ("Easy Saver" each): say whose it is whenever the name alone is ambiguous.
const sameName = a => data.accounts.some(x => x !== a && x.name.trim().toLowerCase() === a.name.trim().toLowerCase());
const accLabel = a => (a ? (sameName(a) ? `${a.name} (${person(a.owner)})` : a.name) : 'Unknown account');
// In a list of choices, always the full picture: name, whose, what kind
const accOption = a => [a.id, `${a.name} · ${person(a.owner)} · ${TYPE_LABEL[a.type]}`];
const snapsSorted = () => [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
// Balances are per account: an update can hold one account or all of them, and the rest is worked out
// (balanceOn / positionOn in engine.js). HOW says how a figure was arrived at, in words.
const HOW = { observed: '', interest: 'worked out from its interest rate', transactions: 'worked out from transactions', straight: 'estimated between two balances', carried: 'last balance entered' };
const HOW_SHORT = { observed: '', interest: 'est. at its rate', transactions: 'from transactions', straight: 'estimated', carried: 'last entered' };
// Month-end points from the first balance you entered to the latest, plus every update date, each a full worked-out
// position. A date that only a statement import recorded (source:'import') does not start the history: before your first
// own update, net worth would be one account on its own. Everything imported only is the exception - it starts there.
const firstSubmitted = () => { const s = snapsSorted(); return (s.find(x => x.source !== 'import') || s[0])?.date; };
function historyDates(f = firstSubmitted()) {
  const ds = [...new Set(data.snapshots.map(x => x.date))].filter(d => d >= f).sort(); if (!ds.length) return [];
  const out = new Set(ds), [y0, m0] = ds[0].split('-').map(Number), last = ds.at(-1);
  for (let k = y0 * 12 + m0; ; k++) { const d = new Date(Date.UTC(Math.floor(k / 12), k % 12, 0)).toISOString().slice(0, 10); if (d > last) break; if (d > ds[0]) out.add(d); }
  return [...out].sort();
}
const openChecks = () => TallyAnalysis.checks(data).filter(c => c.open);
const scenarioKey = () => ui.scenario || data.scenario || 'cautious';
const horizon = () => ui.horizon || data.horizonMonths || 18;
function poolOf(type) { return POOLS.find(p => p.types.includes(type)) || POOLS[2]; }
function poolTotal(snap, pool) { return data.accounts.filter(a => pool.types.includes(a.type)).reduce((s, a) => s + (snap?.balances[a.id] || 0), 0); }
function prevValue(id, beforeDate) {
  const s = snapsSorted().filter(x => x.date < beforeDate && x.balances[id] != null);
  return s.length ? s[s.length - 1].balances[id] : null;
}

const PART_KEYS = ['payment', 'balance', 'rate', 'fixEnd', 'newRate', 'termEnd'];
const partName = (p, i) => p.name || (data.mortgage.parts.length > 1 ? `Part ${i + 1}` : 'Mortgage');
function normalise(d) {
  d = TM.migrate(d); // older files are upgraded here; the file itself only changes when it is next saved
  d.people ||= [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }];
  d.accounts ||= []; d.snapshots ||= []; d.flows ||= [];
  d.mortgage ||= { payment: 0 };
  if (!Array.isArray(d.mortgage.parts)) {
    // Before parts existed the mortgage was one flat record; it becomes the first (and only) part.
    const o = d.mortgage, part = { id: 'main', name: '' };
    for (const k of PART_KEYS) if (o[k] != null && o[k] !== '') part[k] = o[k];
    part.payment ||= 0;
    d.mortgage = { parts: [part] }; if (o.propertyValue != null) d.mortgage.propertyValue = o.propertyValue;
  }
  if (!d.mortgage.parts.length) d.mortgage.parts.push({ id: uid('mp'), name: '', payment: 0 });
  d.rules = Object.assign({ cashFloor: 10000, isaUsedTaxYear: new Date().getFullYear(), sweepToSS: 0 }, d.rules || {});
  d.bufferPct ??= 5;
  d.scenarios ||= {
    cautious: { name: 'Cautious', growth: false, ssReturn: 0, inflation: 0, payRise: 0, rates: { kind: 'market' } },
    base: { name: 'Base', growth: true, ssReturn: 5, inflation: 3, payRise: 2, rates: { kind: 'market' } },
    optimistic: { name: 'Optimistic', growth: true, ssReturn: 7, inflation: 2, payRise: 3, rates: { kind: 'market' } },
  };
  d.scenario ||= 'cautious'; d.horizonMonths ||= 18;
  return d;
}
function blankFile() {
  return normalise({ app: 'tally', version: TM.VERSION, flows: [], people: [{ id: 'M', name: 'Me' }, { id: 'C', name: 'Partner' }, { id: 'J', name: 'Joint' }], mortgage: { parts: [{ id: 'main', name: '', payment: 0 }] } });
}

// ---------- persistence (working copy on this device) ----------
// The working copy is kept unencrypted in this browser's storage, protected by the device's own
// lock. Encryption protects the FILE, which is the copy that leaves the device (iCloud, OneDrive).
function persist() { try { localStorage.setItem(STORE, JSON.stringify({ data, meta })); } catch (e) { } }
function restore() {
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && s.data) { data = normalise(s.data); Object.assign(meta, s.meta || {}); } } catch (e) { }
}
let edits = 0; // counts changes, so a change made while a save is being written isn't marked saved
function changed(msg) { edits++; meta.dirty = true; persist(); checkLeak(); render(); if (msg) toast(msg); autoSaveSoon(); }
// ---------- lock-up and leakage warnings (Phase 1.2) ----------
// After every change, "available to overpay" at the next fix end is worked out again and compared with
// the figure before the change. A drop bigger than the threshold (default £5,000) raises a warning.
let lastAvail = null;
function readyNow() { try { const R = readiness(data, data.scenario || 'cautious', thisMonth()); return R.none ? null : R; } catch (e) { return null; } }
function readyBaseline() { const R = data && readyNow(); lastAvail = R ? R.available : null; }
function checkLeak() {
  const R = readyNow(), now = R ? R.available : null;
  const warnAt = +(data.rules.remortgage || {}).warnAt || 5000;
  if (lastAvail != null && now != null && lastAvail - now > warnAt) ui.leak = { before: lastAvail, after: now, fixEnd: R.fixEnd };
  lastAvail = now;
}
const leakChip = () => ui.leak ? `<div class="warnchip" role="alert"><div><b>Less free at your remortgage</b><br>That change cuts what’s available to overpay in ${fMonth(ui.leak.fixEnd)} from ${money(ui.leak.before)} to ${money(ui.leak.after)} (${money(ui.leak.after - ui.leak.before, { sign: true })}).</div><button data-act="leak-ok" aria-label="Dismiss">OK</button></div>` : '';

// ---------- file storage: your file, your cloud (routes live in storage.js) ----------
const TS = TallyStorage;
const DEVICE = TS.device();
let seal = null;        // key for the encrypted file, if there is one (kept in IndexedDB)
let fileRoute = 'manual'; // 'live' = can write back without asking · 'reconnect' = needs one tap · 'manual'
async function refreshRoute() { const r = await TS.route(); if (r !== fileRoute) { fileRoute = r; render(); } return r; }
function suggestedName() { return meta.fileName || 'family-finances.json'; }
const whenStr = iso => { if (!iso) return 'an unknown time'; const d = new Date(iso); return `${fDate(iso.slice(0, 10))} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// What the file holds: the data, plus the writer mark; sealed if encryption is on.
async function fileText(fileWriter) {
  const writer = TS.nextWriter(fileWriter, meta.base, DEVICE);
  const body = Object.assign({}, data, { savedAt: writer.at });
  delete body.writer;
  const out = meta.encrypt && seal ? await TS.seal(body, seal, writer) : Object.assign(body, { writer });
  return { text: JSON.stringify(out, null, 1), writer };
}
function parseFile(text) { try { return JSON.parse(text); } catch (e) { return null; } }

let autoT = null, saving = false;
function autoSaveSoon() {
  if (fileRoute !== 'live' || meta.conflict) return;
  clearTimeout(autoT); autoT = setTimeout(() => saveFile({ auto: true }), 1200);
}

async function saveFile(o = {}) {
  if (saving) return; saving = true;
  try { await saveFileInner(o); } finally { saving = false; }
}
async function saveFileInner({ auto = false, force = false } = {}) {
  if (meta.encrypt && !seal) {
    if (auto) return;
    return toast('Set your passphrase again under Plan › Your data before saving', true);
  }
  try {
    let r = await refreshRoute();
    if (r === 'reconnect' && !auto) { await TS.permission(true); r = await refreshRoute(); }
    if (r === 'live') {
      // Read before writing: if another device saved since this one last looked, stop and ask.
      const cur = parseFile((await TS.readHandle()).text);
      const fw = cur && cur.writer;
      if (!force && TS.isConflict(fw, meta.base)) { meta.conflict = true; persist(); render(); return auto ? null : conflictSheet(fw); }
      const n = edits, { text, writer } = await fileText(fw);
      await TS.writeHandle(text);
      meta.base = writer; meta.conflict = false;
      return saved(auto ? null : 'Saved to ' + TS.handle.name, n);
    }
    if (auto || r === 'reconnect') return;
    // Manual routes. There is no way to read the file back first, so there is no conflict check here.
    const n = edits, { text, writer } = await fileText(null), name = suggestedName();
    const done = msg => { meta.base = writer; saved(msg, n); };
    // Inside Claude: the platform's save prompt (share sheet on iPhone)
    if (window.claude && window.claude.use) {
      const dl = await Promise.race([window.claude.use('downloads'), new Promise(r => setTimeout(() => r(null), 1500))]);
      if (dl) { await dl.save({ filename: name, data: text }); return done('Saved ' + name); }
    }
    // iPhone / iPad: share sheet → "Save to Files" → iCloud Drive or OneDrive
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return done('Shared ' + name); }
    // Computer: pick a location once; from then on saves go straight back to it
    if (window.showSaveFilePicker && !framed) {
      await TS.setHandle(await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Tally file', accept: { 'application/json': ['.json'] } }] }));
      meta.fileName = TS.handle.name; meta.base = null; await refreshRoute(); return saveFileInner({ force: true });
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); done('Downloaded ' + name);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'declined')) return toast('Save cancelled', true);
    toast('Could not save: ' + (e.message || e.code || 'unknown error'), true);
  }
}
function saved(msg, n = edits) {
  meta.dirty = edits !== n; meta.savedAt = new Date().toISOString(); persist(); render(); if (msg) toast(msg);
  if (meta.dirty) autoSaveSoon();
}

function conflictSheet(fw) {
  const who = `${esc(fw.label || 'another device')} on ${esc(whenStr(fw.at))}`;
  sheet({ title: 'File changed elsewhere', done: null, body: `
    <p class="note">Your finance file was saved from ${who}, after this device last opened it. Saving now would replace those changes.</p>
    <section class="group"><div class="list">
      <button class="row act-row" data-sact="load"><div class="main"><div class="ttl">Load the newer file</div><div class="sub">Changes made here since your last save are discarded</div></div></button>
      <button class="row act-row danger" data-sact="overwrite"><div class="main"><div class="ttl">Keep this version and overwrite</div><div class="sub">The changes from ${who} are lost</div></div></button>
    </div></section>`,
    onDone: async (form, close, act) => {
      close();
      if (act === 'load') { const f = await TS.readHandle(); meta.dirty = false; await loadText(f.text, f.name); }
      if (act === 'overwrite') saveFile({ force: true });
    } });
}

// Loads whatever the other device last saved, if nothing here is waiting to be saved.
// Runs on start and whenever the app comes back to the front.
async function syncFromFile() {
  if (await refreshRoute() !== 'live') return;
  try {
    const f = await TS.readHandle(), cur = parseFile(f.text);
    if (!cur || !TS.isConflict(cur.writer, meta.base)) return;
    if (meta.dirty) { meta.conflict = true; persist(); render(); return; }
    await loadText(f.text, f.name, { quiet: true });
  } catch (e) { }
}

async function openFile() {
  if (window.showOpenFilePicker && !framed) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Tally file', accept: { 'application/json': ['.json'] } }] });
      const f = await h.getFile();
      if (!(await loadText(await f.text(), f.name))) return;
      await TS.setHandle(h); await refreshRoute(); return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  $('#fileIn').click();
}
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (await loadText(await f.text(), f.name)) { await TS.setHandle(null); await refreshRoute(); }
  e.target.value = '';
});

// Returns true if the file was loaded. quiet: a background refresh, so no questions and no prompts.
async function loadText(text, name, { quiet = false } = {}) {
  let d = parseFile(text);
  if (!d) { if (!quiet) toast('That file isn’t valid JSON', true); return false; }
  let s = null;
  if (TS.isEncrypted(d)) {
    const env = d;
    if (TS.sealFits(env, seal)) { try { d = await TS.unseal(env, seal); s = seal; } catch (e) { } }
    if (!s) {
      if (quiet) return false;
      let note = 'This file is encrypted. Enter the passphrase it was saved with.';
      for (;;) {
        const pass = await askPassphrase({ title: 'Unlock file', note, done: 'Unlock' });
        if (pass == null) return false;
        toast('Unlocking…');
        try { const k = await TS.sealFor(pass, env); d = await TS.unseal(env, k); s = k; break; }
        catch (e) { note = 'That passphrase didn’t open the file. Check it and try again.'; }
      }
    }
    d.writer = env.writer;
  }
  if (!d || !Array.isArray(d.accounts) || !Array.isArray(d.snapshots)) { if (!quiet) toast('That isn’t a Tally file', true); return false; }
  // A file saved by a newer Tally has things this version would silently drop - and then save that loss back.
  if (+d.version > TM.VERSION) { if (!quiet) toast('This file was saved by a newer version of Tally. Close and reopen the app to update it, then try again.', true); return false; }
  if (!quiet && data && meta.dirty && !confirm('You have unsaved changes. Replace them with this file?')) return false;
  const writer = d.writer || null; delete d.writer;
  data = normalise(d); meta.fileName = name || meta.fileName; meta.dirty = false; meta.conflict = false;
  meta.savedAt = d.savedAt || null; meta.base = writer; meta.encrypt = !!s;
  if (s) { seal = s; await TS.kvSet('seal', s); }
  ui.stacks = { home: [], accounts: [], projection: [], plan: [] }; ui.tab = 'home';
  ui.leak = null; readyBaseline();
  persist(); render();
  toast(quiet ? `Loaded the latest from ${writer && writer.label || 'your file'}` : 'Opened ' + (name || 'file'));
  return true;
}

// ---------- encryption settings ----------
function askPassphrase({ title, note, done = 'Save', confirm: twice = false }) {
  return new Promise(resolve => {
    let settled = false; const end = v => { if (!settled) { settled = true; resolve(v); } };
    const field = (n, label, ac) => `<div class="field"><label for="p_${n}">${label}</label><input id="p_${n}" name="${n}" type="password" class="wide" autocomplete="${ac}" autocapitalize="off" spellcheck="false"></div>`;
    const { form } = sheet({ title, done, body: `<p class="note">${note}</p><section class="group"><div class="list">${field('p1', 'Passphrase', twice ? 'new-password' : 'current-password')}${twice ? field('p2', 'Again', 'new-password') : ''}</div>${twice ? '<div class="gf">At least 10 characters. A few unrelated words is easier to remember than a jumble.</div>' : ''}</section>`,
      onOpen: (f, close) => {
        const w = f.closest('.sheet-wrap');
        w.querySelector('.cancel').addEventListener('click', () => end(null));
        w.addEventListener('click', e => { if (e.target === w) end(null); });
        setTimeout(() => f.elements.p1.focus(), 350);
      },
      onDone: f => {
        const p = f.elements.p1.value;
        if (twice) {
          if (p.length < 10) { toast('Use at least 10 characters', true); return false; }
          if (p !== f.elements.p2.value) { toast('The two passphrases don’t match', true); return false; }
        } else if (!p) return false;
        end(p);
      } });
    return form;
  });
}
async function encryptSheet() {
  const pass = await askPassphrase({ title: meta.encrypt ? 'Change passphrase' : 'Encrypt your file', done: 'Encrypt', confirm: true,
    note: 'Your finance file will be locked with this passphrase before it is saved, so iCloud, OneDrive or anyone who gets the file sees only scrambled data. <b>If you forget it, the file cannot be opened. There is no reset.</b> Keep it in your password manager.' });
  if (pass == null) return;
  toast('Setting up…');
  seal = await TS.deriveSeal(pass); await TS.kvSet('seal', seal);
  meta.encrypt = true; changed(fileRoute === 'live' ? 'Encryption on' : 'Encryption on. Save to update your file');
}
function decryptSheet() {
  if (!confirm('Save your finance file unencrypted from now on? Anyone who can open the file will be able to read it.')) return;
  meta.encrypt = false; changed('Encryption off');
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
const sw = (checked, act, arg) => `<span class="switch"><input type="checkbox" ${checked ? 'checked' : ''} data-chg="${act}" data-arg="${esc(arg)}" aria-label="Include"><span></span></span>`;

// ---------- charts (SVG + HTML overlay, scrubbable) ----------
const charts = {};
function chart(id, { series, height = 170, fmt = short, vfmt = money, floor = null, markers = [], bands = [], lines = [] }) {
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
  // life events: a shaded band across the months each one covers
  for (const b of bands) { const a = Math.max(0, X(b.from)), z = Math.min(W, X(b.to)); if (z > a) svg += `<rect x="${a}" y="0" width="${z - a}" height="${H}" fill="var(--accent)" opacity=".07"><title>${esc(b.name)}</title></rect>`; }
  for (const v of ticks) svg += `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--sep)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  if (floor != null) svg += `<line x1="0" x2="${W}" y1="${Y(floor)}" y2="${Y(floor)}" stroke="var(--orange)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`;
  for (const s of series) {
    if (s.fill) svg += `<path d="${path(s.pts)}L${X(s.pts.at(-1).t)},${H}L${X(s.pts[0].t)},${H}Z" fill="${s.color}" opacity=".08"/>`;
    svg += `<path d="${path(s.pts)}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2.2}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" ${s.dash ? 'stroke-dasharray="5 5"' : ''}/>`;
  }
  for (const l of lines) { const x = X(l.t); if (x >= 0 && x <= W) svg += `<line x1="${x}" x2="${x}" y1="0" y2="${H}" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"><title>${esc(l.name)}</title></line>`; }
  for (const m of markers) svg += `<line x1="${X(m.t)}" x2="${X(m.t)}" y1="${H - 7}" y2="${H}" stroke="${m.v < 0 ? 'var(--red)' : 'var(--green)'}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
  svg += '</svg>';
  const yl = ticks.map(v => `<div class="yl" style="top:${(Y(v) / H * 100).toFixed(2)}%">${fmt(v)}</div>`).join('');
  const fl = floor != null ? `<div class="yl" style="top:${(Y(floor) / H * 100).toFixed(2)}%;right:auto;left:0;color:var(--orange)">floor ${fmt(floor)}</div>` : '';
  const x0 = new Date(t0), x1 = new Date(t1), xm = new Date((t0 + t1) / 2);
  const xl = d => `${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  charts[id] = { series, t0, t1, lo, hi, H, fmt, vfmt };
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
    r.innerHTML = `<div class="when">${label}</div>` + c.series.map(s => { const p = near(s.pts, t); return `<span class="s"><i style="background:${s.color}"></i>${s.name} ${c.vfmt(p.v)}</span>`; }).join('');
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
  const snaps = snapsSorted(), last = latestSnapshot(data), prevD = [...new Set(snaps.map(x => x.date))].sort().at(-2), prev = prevD ? positionOn(data, prevD) : null;
  if (!last) return { title: 'Overview', large: true, right: headerRight(), body: `<div class="hero"><div class="cap">No balances yet</div></div><button class="cta" data-act="update">${PLUS}Add your first balances</button>${group(row({ title: 'Add an account', act: 'add-account', cls: 'act-row', chev: false }), 'Start here', 'Add each account once, then record balances whenever you like. Each update is kept as a dated milestone.')}` };
  const T = snapshotTotals(data, last), P = prev ? snapshotTotals(data, prev) : null;
  const pr = project(data, scenarioKey(), horizon()), end = pr.rows.at(-1);
  const days = daysSince(last.date);
  const m = data.mortgage, mt = mortgageTotals(data);
  const equity = m.propertyValue && mt.balance != null ? m.propertyValue - mt.balance : null;
  const big = money(T.net).replace('£', '<span class="p">£</span>');

  const hist = historyDates().map(d => ({ t: Date.parse(d), v: snapshotTotals(data, positionOn(data, d, { entered: true })).net }));
  const nChecks = openChecks().length;
  const fut = [{ t: Date.parse(last.date), v: T.net }, ...pr.rows.map(r => ({ t: monthEndT(r.date), v: r.net }))];
  const ch = chart('c-home', {
    series: [
      { name: 'Actual', color: 'var(--c-net)', pts: hist, fill: true, focusT: Date.parse(last.date), whenLabel: `Actual at ${fDate(last.date)}` },
      { name: 'Projected', color: 'var(--c-isa)', pts: fut, dash: true },
    ], height: 150,
  });

  const lowest = pr.rows.reduce((b, r) => r.closing < b.closing ? r : b, pr.rows[0]);
  const nextEv = TM.effectiveFlows(data).filter(e => e.kind === 'oneoff' && e.on && e.start && e.start >= thisMonth()).sort((a, b) => a.start.localeCompare(b.start))[0];
  const bud = monthlyBudget(data, thisMonth());
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
      (nextEv ? row({ title: 'Next big item', sub: `${esc(nextEv.name)} · ${fMonth(nextEv.start)}`, value: amt(nextEv.amount, { color: true, sign: true }), act: 'push', arg: 'events' }) : ''),
      `Looking ahead<b>${esc(sc.name)} scenario</b>`)}
    ${data.transactions.length ? group(actualsLine(), 'Actual spending') : ''}
    ${isaNudge()}
    ${nChecks ? group(row({ title: `${nChecks} balance move${nChecks === 1 ? '' : 's'} to look at`, sub: 'Changes your transactions or interest don’t explain, and returns to cross-check', value: '<span class="pill warn">Check</span>', act: 'push', arg: 'checks' })) : ''}
    ${group(
      row({ title: 'Coming in', value: amt(bud.income), act: 'tab', arg: 'plan' }) +
      row({ title: 'Going out', value: amt(-bud.out), act: 'tab', arg: 'plan' }) +
      row({ title: 'Monthly surplus', value: amt(bud.surplus, { color: true }), strong: true, sub: bud.income ? `${Math.round(bud.surplus / bud.income * 100)}% of take-home` : '', act: 'tab', arg: 'plan' }),
      'Each month')}
  `, after: () => mountChart('c-home'),
  };
}

function headerRight() {
  const st = meta.conflict ? `<button class="pill warn" data-act="resolve">File changed</button>`
    : fileRoute === 'reconnect' ? `<button class="pill warn" data-act="reconnect">Reconnect</button>`
    : meta.dirty && fileRoute !== 'live' ? `<button class="pill warn" data-act="save">Save</button>` : '';
  return `${st}<button class="iconbtn" data-act="private" aria-label="${meta.private ? 'Show amounts' : 'Hide amounts'}">${meta.private ? EYE_OFF : EYE}</button>`;
}

function vPool(key) {
  const p = POOLS.find(x => x.key === key), last = latestSnapshot(data);
  const accs = data.accounts.filter(a => p.types.includes(a.type) && (a.active || last?.balances[a.id]));
  const hist = historyDates().map(d => ({ t: Date.parse(d), v: poolTotal(positionOn(data, d, { entered: true }), p) }));
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
  const v = snap?.balances[a.id]; const pv = snap ? prevValue(a.id, snap.date) : null, how = snap?.how?.[a.id];
  return row({ title: esc(accLabel(a)) + (a.active ? '' : '<span class="tag">Closed</span>'), sub: `${TYPE_LABEL[a.type]}${!LIAB.has(a.type) && rateOn(a, todayISO()) ? ` · ${rateOn(a, todayISO())}%` : ''}${how && HOW_SHORT[how] ? ` · ${HOW_SHORT[how]}` : ''}`, value: v == null ? '–' : amt(v, { color: true }), vsub: v != null && pv != null && Math.abs(v - pv) > .5 ? chg(v - pv) : '', strong: true, act: 'push', arg: 'acct:' + a.id });
}

function vAccounts() {
  const last = latestSnapshot(data), nChecks = data.snapshots.length ? openChecks().length : 0;
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
      ${group((nChecks ? row({ title: `${nChecks} to look at`, sub: 'Moves nothing explains, and returns to cross-check', value: '<span class="pill warn">Check</span>', act: 'push', arg: 'checks' }) : row({ title: 'Checks', sub: 'Every move between balances explained', value: '<span class="pill ok">All clear</span>', act: 'push', arg: 'checks' })) +
        row({ title: 'Balance history', sub: `${data.snapshots.length} dated updates`, act: 'push', arg: 'snaps' }) + row({ title: 'Update balances', act: 'update', cls: 'act-row', chev: false }), '', 'Tap an account to add a balance for it on its own, or to record money in or out. Savings are worked out from their interest rate in between.')}`,
  };
}

function vAccount(id) {
  const a = acc(id); if (!a) return vAccounts();
  const obs = observations(data, id), lastObs = obs.at(-1), liab = LIAB.has(a.type);
  const today = balanceOn(data, id, todayISO());
  const pool = poolOf(a.type);
  // month by month from the first balance to today, worked out the same way as everything else
  const pts = obs.length ? [...new Set([...obs.map(o => o.date), ...historyDates(obs[0]?.date), todayISO()])].filter(d => d >= obs[0].date && d <= todayISO()).sort()
    .map(d => { const b = balanceOn(data, id, d); return b ? { t: Date.parse(d), v: b.v } : null; }).filter(Boolean) : [];
  const rows = [...obs].reverse().map((o, i, arr) => {
    const nxt = arr[i + 1]; const d = nxt ? o.v - nxt.v : null;
    return row({ title: fDate(o.date), value: amt(o.v, { color: true }), vsub: d != null ? chg(d) : '', act: 'edit-bal', arg: id + '|' + o.date, strong: true });
  }).join('');
  const manual = (data.transactions || []).filter(t => t.account === id && t.source === 'manual').sort((x, y) => y.date.localeCompare(x.date));
  const imported = (data.transactions || []).filter(t => t.account === id && t.source !== 'manual').length;
  const cks = TallyAnalysis.checks(data).filter(c => c.account === id);
  return {
    title: a.name, large: true, back: 'Back',
    right: `<button class="pill" data-act="edit-account" data-arg="${a.id}" style="color:var(--accent)">Edit</button>`,
    body: `<div class="subtitle">${esc(person(a.owner))} · ${TYPE_LABEL[a.type]}${a.active ? '' : ' · closed'}</div>
      <div class="hero"><div class="cap">${today && today.how !== 'observed' ? 'Today, ' + HOW[today.how] : 'Balance today'}</div><div class="big amt">${today ? money(today.v).replace('£', '<span class="p">£</span>') : '–'}</div>
      ${lastObs ? `<div class="chg"><span>Last entered ${money(lastObs.v)} on ${fDate(lastObs.date)}</span></div>` : ''}</div>
      ${pts.length > 1 ? `<section class="card">${chart('c-acc', { series: [{ name: a.name, color: pool.color, pts, fill: true }] })}</section>` : ''}
      ${group(row({ title: 'Add a balance for this account', sub: 'On its own - no need to update the others', act: 'add-bal', arg: id, cls: 'act-row', chev: false }) +
        (liab ? '' : row({ title: 'Record money in or out', sub: a.type === 'ss_isa' || a.type === 'pension' ? 'Contributions, withdrawals, dividends' : 'Deposits, withdrawals, interest paid', act: 'add-mtx', arg: id, cls: 'act-row', chev: false })))}
      ${liab ? '' : ratesGroup(a)}
      ${a.type === 'savings' || a.type === 'cash_isa' ? rateModelGroup('acct:' + a.id) : ''}
      ${cks.length ? group(cks.map(checkRow).join(''), 'Between balances', 'Each gap between two balances entered, and whether what happened in between explains it.') : ''}
      ${manual.length ? group(manual.map(t => row({ title: esc(t.description), sub: fDate(t.date), value: amt(t.amount, { sign: true, color: true, dp: true }), act: 'edit-mtx', arg: t.id })).join(''), 'Money in and out, entered by hand') : ''}
      ${group(
        row({ title: 'Counts towards', value: pool.label, act: 'edit-account', arg: a.id }) +
        (imported ? row({ title: 'Imported transactions', value: String(imported), act: 'push', arg: 'txns:acct=' + id }) : '') +
        (a.note ? row({ title: 'Note', sub: esc(a.note), act: 'edit-account', arg: a.id }) : ''), 'Details',
        TXN_EXPLAIN[a.type] || '')}
      ${rows ? group(rows, 'Balances entered', 'Tap one to change or remove it.') : ''}`,
    after: () => pts.length > 1 && mountChart('c-acc'),
  };
}
// ---------- interest rates over time ----------
// accounts[].rates: [{from: date|null, rate}]. A change applies from its date; the periods before keep theirs.
const rateOn = (a, d) => TM.rateOn(a, d);
const rateText = (a, d1, d2) => { if (!a) return '0%'; const r1 = rateOn(a, d1), changes = (a.rates || []).filter(r => r.from && r.from > d1 && r.from <= d2); return changes.length ? `${[r1, ...changes.map(r => r.rate)].join('% then ')}%` : `${r1}%`; };
function ratesGroup(a) {
  const t = todayISO(), all = a.rates && a.rates.length ? a.rates : [{ from: null, rate: +a.rate || 0 }];
  const list = all.slice().sort((x, y) => (y.from || '').localeCompare(x.from || '')); // newest first
  const current = list.find(r => !r.from || r.from <= t), invest = a.type === 'ss_isa';
  const title = r => (r.from ? `From ${fDate(r.from)}` : list.length > 1 ? 'Before any change' : 'Since the account was added');
  const sub = r => (r.from && r.from > t ? 'Still to come' : r === current ? 'In force now' : '');
  return group(list.map(r => row({ title: title(r), sub: sub(r), value: `${r.rate}%`, act: 'edit-rate', arg: a.id + '|' + (r.from || '') })).join('') +
    row({ title: 'Change the rate from a date', sub: 'A new rate, or a bonus ending - past or still to come', act: 'add-rate', arg: a.id, cls: 'act-row', chev: false }),
    invest ? 'Expected return' : 'Interest rate', invest ? 'S&S ISAs use the scenario’s return in the projection; this rate is only a note.' : 'Each rate applies from its date until the next one. Past balances, the checks and the projection all use the rate in force at the time, so changing one period never moves another.');
}
function rateSheet(accountId, from) {
  const a = acc(accountId); a.rates ||= [{ from: null, rate: +a.rate || 0 }];
  const r = from != null ? a.rates.find(x => (x.from || '') === from) : null, base = r && !r.from;
  formSheet({
    title: r ? 'Interest rate' : 'Change the rate', values: { from: r ? r.from : todayISO(), rate: r ? r.rate : rateOn(a, todayISO()) },
    sections: [{ foot: base ? 'The rate before any dated change.' : 'Applies from this date until the next change. Months before it keep their own rate.', fields: [...(base ? [] : [{ key: 'from', label: 'From', type: 'date' }]), { key: 'rate', label: 'Rate', type: 'percent', unit: '% a year' }] }],
    extra: r && !base ? destructive('Remove this change', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') a.rates = a.rates.filter(x => x !== r);
      else {
        if (!base && !v.from) { toast('Choose the date it applies from', true); return false; }
        if (r) { if (!base && v.from !== r.from && a.rates.some(x => x !== r && x.from === v.from)) { toast('There is already a rate from that date', true); return false; } r.rate = v.rate; if (!base) r.from = v.from; }
        else { const same = a.rates.find(x => x.from === v.from); if (same) same.rate = v.rate; else a.rates.push({ from: v.from, rate: v.rate }); }
      }
      a.rate = rateOn(a, todayISO()); // the figure shown elsewhere is always the rate in force today
      changed(act === 'delete' ? 'Rate change removed' : `${v.rate}% ${base ? 'before any change' : 'from ' + fDate(v.from)}`);
    },
  });
}
const TXN_EXPLAIN = {
  savings: 'Between the balances you enter, this account is worked out from its interest rate plus any money in or out you record - so you only need to enter a balance now and then.',
  cash_isa: 'Between the balances you enter, this account is worked out from its interest rate plus any money in or out you record - so you only need to enter a balance now and then.',
  current: 'Between balances this account is worked out from its imported transactions; with none, a straight line.',
  card: 'Between balances this account is worked out from its imported transactions; with none, a straight line.',
  ss_isa: 'Between balances this is a straight line; after the last one it is held until you enter another. Record contributions so growth can be told apart from money paid in.',
  pension: 'Between balances this is a straight line; after the last one it is held until you enter another. Record contributions so growth can be told apart from money paid in.',
};
function checkRow(c) {
  const when = `${fDate(c.from)} → ${fDate(c.to)}`;
  if (c.kind === 'return') return row({ title: c.return != null ? `Return ${(c.return * 100).toFixed(1)}%${c.annual != null && (Date.parse(c.to) - Date.parse(c.from)) > 60 * 864e5 ? ` (${(c.annual * 100).toFixed(1)}% a year)` : ''}` : 'Market movement', sub: `${when} · ${money(c.market, { sign: true })} after ${money(c.paidIn)} paid in`,
    value: c.review ? '<span class="pill ok">Cross-checked</span>' : c.material ? '<span class="pill warn">Cross-check</span>' : '<span class="pill">Small</span>', act: 'review', arg: c.key });
  return row({ title: c.material ? `${money(Math.abs(c.unexplained))} ${c.unexplained > 0 ? 'more' : 'less'} than explained` : 'Explained', sub: `${when} · change ${money(c.change, { sign: true })}, ${c.interest != null ? `interest ${money(c.interest)} and ` : ''}${c.count} recorded`,
    value: c.review ? '<span class="pill ok">Looked at</span>' : c.material ? '<span class="pill warn">Look</span>' : '<span class="pill ok">OK</span>', act: 'review', arg: c.key });
}
function vChecks() {
  const all = TallyAnalysis.checks(data), open = all.filter(c => c.open), done = all.filter(c => c.material && !c.open);
  return {
    title: 'Checks', large: true, back: 'Back',
    body: `<p class="note">For each account, every gap between two balances you entered: does what happened in between - transactions, interest at its rate, money recorded in or out - explain the change? Gaps of more than ${money(data.rules.checks.abs)} or ${data.rules.checks.pct}% of the balance are listed. S&amp;S ISAs and pensions show their return for you to cross-check.</p>` +
      (open.length ? group(open.map(c => row({ ...rowOf(c) })).join(''), 'To look at') : group(row({ title: 'Nothing to look at', value: '<span class="pill ok">All clear</span>' }))) +
      (done.length ? group(done.map(c => row({ ...rowOf(c) })).join(''), 'Looked at') : '') +
      group(row({ title: 'When to ask', value: `over ${money(data.rules.checks.abs)} or ${data.rules.checks.pct}%`, act: 'edit-checks' })),
  };
}
const rowOf = c => ({ title: esc(accName(c.account)), sub: `${fDate(c.from)} → ${fDate(c.to)} · ${c.kind === 'return' ? `return ${c.return != null ? (c.return * 100).toFixed(1) + '%' : '–'} to cross-check` : `${money(Math.abs(c.unexplained))} ${c.unexplained > 0 ? 'more' : 'less'} than explained`}`, value: c.review ? '<span class="pill ok">Done</span>' : '<span class="pill warn">Look</span>', act: 'review', arg: c.key });
function reviewSheet(key) {
  const c = TallyAnalysis.checks(data).find(x => x.key === key); if (!c) return;
  const rv = data.reviews[key];
  if (c.kind === 'return') {
    formSheet({
      title: accName(c.account), values: { checked: !!rv, note: rv?.note || '' },
      sections: [{ head: `${fDate(c.from)} → ${fDate(c.to)}`, foot: `${money(c.v1)} → ${money(c.v2)}: a change of ${money(c.change, { sign: true })}, of which ${money(c.paidIn)} was paid in, leaving ${money(c.market, { sign: true })} of market movement - a money-weighted return of ${c.return != null ? (c.return * 100).toFixed(2) + '%' : '–'}${c.annual != null ? ` (${(c.annual * 100).toFixed(1)}% a year)` : ''}. Compare it with the provider’s own statement or app. If it is out, a contribution or withdrawal is probably missing.`,
        fields: [{ key: 'checked', label: 'I’ve cross-checked this return', type: 'toggle' }, { key: 'note', label: 'Note', type: 'text', optional: true, ph: 'e.g. matches the provider statement' }] }],
      extra: `<section class="group"><div class="list"><button class="row act-row" data-sact="mtx"><div class="main"><div class="ttl">Record a missing contribution or withdrawal</div></div></button></div></section>`,
      onSave: (v, act) => {
        if (act === 'mtx') { setTimeout(() => moneySheet(c.account, null, { date: c.to }), 360); return; }
        if (v.checked) data.reviews[key] = { status: 'checked', at: todayISO(), note: v.note || '' }; else delete data.reviews[key];
        changed(v.checked ? 'Marked as cross-checked' : 'Unmarked');
      },
    });
    return;
  }
  formSheet({
    title: accName(c.account), values: { ok: !!rv, note: rv?.note || '' },
    sections: [{ head: `${fDate(c.from)} → ${fDate(c.to)}`, foot: `${money(c.v1)} → ${money(c.v2)}: a change of ${money(c.change, { sign: true })}. Explained: ${money(c.explained, { sign: true })}${c.interest != null ? ` (interest ${money(c.interest)} at ${rateText(acc(c.account), c.from, c.to)}, and ${money(c.recorded, { sign: true })} recorded in or out)` : ` from ${c.count} transaction${c.count === 1 ? '' : 's'}`}. That leaves ${money(c.unexplained, { sign: true })} nothing explains - usually a missing import or a payment not recorded.`,
      fields: [{ key: 'ok', label: 'I’ve looked at this - it’s fine', type: 'toggle' }, { key: 'note', label: 'Note', type: 'text', optional: true, ph: 'e.g. cash deposit' }] }],
    extra: `<section class="group"><div class="list">${TXN_TYPES_UI.has(c.type) ? '<button class="row act-row" data-sact="import"><div class="main"><div class="ttl">Import the missing statement</div></div></button>' : ''}<button class="row act-row" data-sact="mtx"><div class="main"><div class="ttl">Record the missing ${money(Math.abs(c.unexplained))} ${c.unexplained > 0 ? 'in' : 'out'}</div></div></button></div></section>`,
    onSave: (v, act) => {
      if (act === 'import') { setTimeout(() => $('#csvIn').click(), 360); return; }
      if (act === 'mtx') { setTimeout(() => moneySheet(c.account, null, { date: c.to, amount: c.unexplained }), 360); return; }
      if (v.ok) data.reviews[key] = { status: 'ok', at: todayISO(), note: v.note || '' }; else delete data.reviews[key];
      changed(v.ok ? 'Marked as looked at' : 'Unmarked');
    },
  });
}
const TXN_TYPES_UI = new Set(['current', 'card']);
// A balance for one account on one date: added to that date's update, or a new update holding just it.
function balanceSheet(id, date) {
  const a = acc(id), liab = LIAB.has(a.type), cur = date ? data.snapshots.find(s => s.date === date)?.balances[id] : null;
  const est = balanceOn(data, id, todayISO());
  formSheet({
    title: a.name, values: { date: date || todayISO(), bal: cur != null ? Math.abs(cur) : null },
    sections: [{ foot: est && !date ? `Tally works it out as about ${money(liab ? Math.abs(est.v) : est.v)} today (${HOW[est.how] || 'entered'}).` : '', fields: [{ key: 'date', label: 'Balance on', type: 'date' }, { key: 'bal', label: liab ? 'Amount owed' : 'Balance', type: 'money' }] }],
    extra: date ? destructive('Remove this balance', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { const sn = data.snapshots.find(s => s.date === date); delete sn.balances[id]; if (!Object.keys(sn.balances).length) data.snapshots = data.snapshots.filter(s => s !== sn); return changed('Balance removed'); }
      if (!v.date) { toast('Choose a date', true); return false; }
      if (date && v.date !== date) { const old = data.snapshots.find(s => s.date === date); delete old.balances[id]; if (!Object.keys(old.balances).length) data.snapshots = data.snapshots.filter(s => s !== old); }
      const val = Math.round((liab ? -Math.abs(v.bal) : v.bal) * 100) / 100;
      const sn = data.snapshots.find(s => s.date === v.date);
      if (sn) { sn.balances[id] = val; delete sn.source; } else data.snapshots.push({ date: v.date, balances: { [id]: val } });
      changed(`${a.name}: ${money(val)} on ${fDate(v.date)}`);
    },
  });
}
// Money in or out of an account, entered by hand - easier than a statement for an account that rarely moves.
function moneySheet(accountId, txId, preset = {}) {
  const t = txId ? data.transactions.find(x => x.id === txId) : null, a = acc(t ? t.account : accountId);
  const invest = a.type === 'ss_isa' || a.type === 'pension';
  const kinds = [['in', invest ? 'Contribution (paid in)' : 'Paid in'], ['out', invest ? 'Withdrawal or distribution taken out' : 'Taken out'], ['interest', invest ? 'Dividend or interest kept in the account' : 'Interest paid in']];
  const amt0 = t ? Math.abs(t.amount) : preset.amount != null ? Math.abs(Math.round(preset.amount * 100) / 100) : null;
  formSheet({
    title: t ? 'Money in or out' : a.name, values: { date: t ? t.date : preset.date || todayISO(), kind: t ? t.kind || (t.amount < 0 ? 'out' : 'in') : preset.amount < 0 ? 'out' : 'in', amount: amt0, note: t ? t.description : '' },
    sections: [{ foot: invest ? 'Dividends kept in the account count as growth, not money you put in.' : 'Interest you record replaces the interest Tally would otherwise estimate for that period.', fields: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'kind', label: 'What', type: 'select', options: kinds }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'note', label: 'Note', type: 'text', optional: true, ph: 'e.g. from the joint account' }] }],
    extra: t ? destructive('Delete', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.transactions = data.transactions.filter(x => x.id !== txId); return changed('Deleted'); }
      if (!v.date || !(v.amount > 0)) { toast('Enter a date and an amount', true); return false; }
      const label = kinds.find(k => k[0] === v.kind)[1];
      const rec = { account: a.id, date: v.date, amount: (v.kind === 'out' ? -1 : 1) * Math.abs(v.amount), description: v.note || label, merchant: (v.note || label).toUpperCase().slice(0, 40), kind: v.kind, source: 'manual', category: v.kind === 'interest' ? 'Income' : 'Transfer', bankCategory: null };
      if (t) Object.assign(t, rec); else data.transactions.push({ id: uid('m'), ...rec });
      changed(t ? 'Saved' : `${money(rec.amount, { sign: true })} recorded`);
    },
  });
}

function vSnaps() {
  const s = snapsSorted().reverse();
  return {
    title: 'Balance history', large: true, back: 'Accounts',
    body: group(s.map((x, i) => {
      const t = snapshotTotals(data, positionOn(data, x.date, { entered: true })).net, p = s[i + 1] ? snapshotTotals(data, positionOn(data, s[i + 1].date, { entered: true })).net : null;
      const dr = drift(data, data.scenario || 'cautious', x.date);
      const n = Object.keys(x.balances).length;
      return row({ title: fDate(x.date), sub: `${n} account${n === 1 ? '' : 's'} entered` + (dr ? ` · ${driftWords(dr.diff.net)}` : ''), value: amt(t), vsub: p != null ? chg(t - p) : '', strong: true, act: 'push', arg: 'snap:' + x.date });
    }).join('') || row({ title: 'No updates yet' }), 'Net worth at each update', 'Net worth counts every account that had a balance by then: the ones entered that day, and the rest worked out. An account only counts from its first balance. Tap one to see or correct it.'),
  };
}

// "£3.2k behind plan" / "£800 ahead of plan" / "on plan"
const driftWords = v => Math.abs(v) < 50 ? 'on plan' : `${short(Math.abs(v))} ${v < 0 ? 'behind' : 'ahead of'} plan`;
function driftGroup(dr) {
  if (!dr) return '';
  const parts = [['Cash', dr.diff.cash, 'spending or income differed from plan'], ['ISAs', dr.diff.isa, 'markets, or a different amount paid in'], ['Savings, pensions and debts', dr.diff.other, '']].filter(x => Math.abs(x[1]) >= 50);
  const why = parts.map(([l, v]) => `${l} ${money(v, { sign: true })}`).join(', ');
  return group(
    row({ title: 'Expected by now', sub: `Projected from ${fDate(dr.from)}`, value: amt(dr.expected.net) }) +
    parts.map(([l, v, hint]) => row({ title: l, sub: hint, value: amt(v, { sign: true, color: true }) })).join('') +
    row({ title: Math.abs(dr.diff.net) < 50 ? 'On plan' : dr.diff.net < 0 ? 'Behind plan' : 'Ahead of plan', value: amt(dr.diff.net, { sign: true, color: true }), cls: 'total' }),
    'Against plan', `${driftWords(dr.diff.net).replace(/^./, c => c.toUpperCase())}${why ? ': ' + why : ''}. Worked out in the ${esc(data.scenarios[data.scenario || 'cautious'].name)} scenario from the update before this one.`);
}
function vSnap(date) {
  const s = data.snapshots.find(x => x.date === date); if (!s) return vSnaps();
  const P = positionOn(data, date), T = snapshotTotals(data, P), dr = drift(data, data.scenario || 'cautious', date);
  const worked = data.accounts.filter(a => s.balances[a.id] == null && P.balances[a.id] != null);
  const rows = data.people.map(p => {
    const l = data.accounts.filter(a => a.owner === p.id && s.balances[a.id] != null); if (!l.length) return '';
    return group(l.map(a => { const pv = prevValue(a.id, date); return row({ title: esc(a.name), value: amt(s.balances[a.id], { color: true }), vsub: pv != null ? chg(s.balances[a.id] - pv) : '', strong: true, act: 'push', arg: 'acct:' + a.id }); }).join(''), esc(p.name));
  }).join('');
  return {
    title: fDate(date), large: true, back: 'History',
    body: `<div class="hero"><div class="cap">Net worth</div><div class="big amt">${money(T.net).replace('£', '<span class="p">£</span>')}</div></div>
      ${attributionGroup(date)}${driftGroup(dr)}${rows}${worked.length ? group(worked.map(a => row({ title: esc(accLabel(a)), sub: HOW[P.how[a.id]], value: amt(P.balances[a.id], { color: true }), act: 'push', arg: 'acct:' + a.id })).join(''), 'Worked out, not entered', 'Included in net worth that day.') : ''}${group(row({ title: 'Edit these balances', act: 'update', arg: date, cls: 'act-row', chev: false }) + row({ title: 'Delete this update', act: 'del-snap', arg: date, cls: 'act-row danger', chev: false }))}`,
  };
}

// ---------- projection ----------
function vProjection() {
  const sk = scenarioKey(), sc = data.scenarios[sk], pr = project(data, sk, horizon());
  if (!pr) return { title: 'Projection', large: true, body: `<p class="note">Record your balances first — the projection starts from your latest update.</p><button class="cta" data-act="update">${PLUS}Update balances</button>` };
  const R = pr.rows, end = R.at(-1), first = snapshotTotals(data, latestSnapshot(data));
  const tFirst = Date.parse(pr.snapDate);
  // Today's money (3.4): every projected figure deflated by the scenario's inflation
  const k0 = R[0].k, rv = (v, r) => ui.real ? TA.realValue(v, r.k, k0, sc.inflation) : v;
  const pts = f => [{ t: tFirst, v: f === 'net' ? first.net : f === 'isa' ? first.isa : first.cash }, ...R.map(r => ({ t: monthEndT(r.date), v: rv(f === 'net' ? r.net : f === 'isa' ? r.isa : r.closing, r) }))];
  const goalLines = data.goals.map(g => ({ t: monthEndT(g.date + '-01'), name: `${g.name}: ${money(g.target)}` }));
  const markers = R.flatMap(r => r.events.map(e => ({ t: monthEndT(r.date), v: e.amount })));
  const bands = bundleBands(tFirst, monthEndT(end.date));
  const c1 = chart('c-proj', { series: [{ name: 'Net worth', color: 'var(--c-net)', pts: pts('net') }, { name: 'ISAs', color: 'var(--c-isa)', pts: pts('isa'), fill: true }].map((x, i) => i ? x : { ...x, whenLabel: `End of ${fMonth(end.date)}` }), height: 180, markers, bands, lines: goalLines });
  const c2 = chart('c-cash', { series: [{ name: 'Cash', color: 'var(--c-cash)', pts: pts('cash'), fill: true, whenLabel: `End of ${fMonth(end.date)}` }], height: 120, floor: +data.rules.cashFloor, markers, bands });
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
      <div class="chips">${[[18, '18 months'], [36, '3 years'], [60, '5 years'], [120, '10 years']].map(([n, l]) => `<button class="${n === horizon() ? 'on' : ''}" data-act="horizon" data-arg="${n}">${l}</button>`).join('')}<button class="${ui.real ? 'on' : ''}" data-act="real" aria-pressed="${!!ui.real}">Today’s money</button></div>
      ${ui.real ? `<p class="note">Shown in today’s money: each figure is reduced by ${sc.inflation}% a year of inflation, so a pound later buys what it would today.</p>` : ''}
      <section class="card"><div class="gh">Net worth and ISAs<b>from ${fDate(pr.snapDate)}</b></div>${c1}
        <div class="legend"><span><i style="background:var(--c-net)"></i>Net worth</span><span><i style="background:var(--c-isa)"></i>ISAs</span><span><i style="background:var(--red)"></i>Payment</span><span><i style="background:var(--green)"></i>Receipt</span>${bands.length ? '<span><i style="background:var(--accent);opacity:.3"></i>Life events</span>' : ''}</div></section>
      <section class="card"><div class="gh">Cash held<b>floor ${amt(+data.rules.cashFloor)}</b></div>${c2}</section>
      <div class="stats">
        <div><div class="k">Net worth</div><div class="v amt">${short(rv(end.net, end))}</div><div class="n">${fMonth(end.date)} · ${chg(end.net - first.net)}</div></div>
        <div><div class="k">ISA pot</div><div class="v amt">${short(rv(end.isa, end))}</div><div class="n">${chg(end.isa - first.isa)}</div></div>
        <div><div class="k">Moved into ISAs</div><div class="v amt">${short(tops)}</div><div class="n">${short(wds)} drawn back out</div></div>
        <div><div class="k">Lowest cash</div><div class="v amt ${lowest.closing < data.rules.cashFloor - 1 ? 'neg' : ''}">${short(lowest.closing)}</div><div class="n">${fMonth(lowest.date)}</div></div>
        ${sc.growth ? `<div><div class="k">Growth and interest</div><div class="v amt">${short(growth)}</div><div class="n">S&amp;S ${sc.ssReturn}% · cash ISA ${pr.cashIsaRate.toFixed(1)}%</div></div>` : `<div><div class="k">Growth and interest</div><div class="v">Off</div><div class="n">Excluded to stay prudent</div></div>`}
        <div><div class="k">Monthly surplus now</div><div class="v amt">${short(R[0].surplus)}</div><div class="n">${sc.payRise || sc.inflation ? `pay +${sc.payRise}% · costs +${sc.inflation}% a year` : 'held flat'}</div></div>
      </div>
      ${short_.length ? group(short_.map(r => row({ title: fMonth(r.date), sub: 'ISAs can’t cover the floor', value: amt(-r.shortfall, { color: true }), act: 'push', arg: 'month:' + r.k })).join(''), 'Shortfalls') : ''}
      ${group(Object.entries(tys).map(([y, t]) => row({ title: `${y}/${String(+y + 1).slice(2)}`, sub: `In ${short(t.in)} · out ${short(t.out)}`, value: amt(t.left), vsub: 'allowance left' })).join(''), 'ISA allowance by tax year', `Uses ${money(data.rules.isaPerPerson)} each for ${esc(data.rules.isaFillOrder.map(person).join(' and '))}, filling ${esc(person(data.rules.isaFillOrder[0]))}’s first. Money taken out of a flexible ISA can be put back in the same tax year without using new allowance; the projection tracks that separately.`)}
      ${pr.rateLayer.modelled ? `<p class="note">Interest rates: ${layerText(pr.rateLayer)}${pr.rateLayer.active && pr.rateLayer.kind !== 'manual' ? '. Market-implied, not a forecast' : ''}.</p>` : ''}
      ${group(months, 'Month by month', 'Tap a month for the full cash waterfall and ISA workings.')}
      ${group(row({ title: `${esc(sc.name)} assumptions`, sub: sc.growth ? `S&S ${sc.ssReturn}% · inflation ${sc.inflation}% · pay ${sc.payRise}%` : 'No growth, no inflation, no pay rises', act: 'push', arg: 'scenario:' + sk }) + row({ title: 'Compare plans', sub: 'Two or three scenarios side by side', act: 'push', arg: 'plans' }) + row({ title: 'Range of outcomes and stress tests', sub: 'What markets, rates or a lost income could do', act: 'push', arg: 'risk' }) + row({ title: 'Interest rates', sub: layerText(pr.rateLayer), act: 'push', arg: 'rates' }) + row({ title: 'ISA allowance this tax year', sub: 'Per person, with what’s planned by 5 April', act: 'push', arg: 'isayear' }) + row({ title: 'Cash floor and ISA rules', act: 'edit-rules' }) + row({ title: 'Upcoming payments and receipts', value: String(flowsOf('oneoff').filter(e => e.on).length), act: 'push', arg: 'events' }), 'Refine')}`,
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
        line('Opening cash', r.opening) + line('Take-home pay', r.income, { sign: true }) + line('Regular spending', -r.spend, { sign: true }) + line(`Buffer (${data.bufferPct}%)`, -r.buffer, { sign: true }) + evRows + (r.dealCash > 0.5 ? line('Remortgage: lump sum, fee and overpayments', -r.dealCash, { sign: true }) : '') + line('Cash before ISA moves', r.before, { total: true }),
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
      ${Object.keys(r.bundleNet).length ? group(Object.entries(r.bundleNet).map(([id, v]) => { const b = bundleById(id); return b ? row({ title: esc(b.name), sub: 'Life event, this month', value: amt(v, { sign: true, color: true }), act: 'push', arg: 'bundle:' + id }) : ''; }).join(''), 'Life events', 'Already included in the figures above.') : ''}
      ${m ? group((r.mortgageParts.length > 1 ? r.mortgageParts.map((p, i) => line(esc(p.name || `Part ${i + 1}`), -p.pay, { sub: p.bal != null ? `${short(p.bal)} left` : 'Flat payment' })).join('') : '') +
        line('Mortgage payment', -r.mortgagePay) + line('Of which interest', -r.mortgageInterest) + line('Mortgage balance', -r.mortgageBal, { total: true }), 'Mortgage') : ''}
      ${monthRatesGroup(r)}</div>`,
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
      row({ title: 'Interest rates', sub: layerText(layerOf(key)), value: esc(TC.KINDS[(s.rates || {}).kind || 'market']), act: 'open-rates', arg: key }) +
      row({ title: 'Spending inflation', value: `${s.inflation}% a year`, act: 'edit-scenario', arg: key }) +
      row({ title: 'Pay rises', value: `${s.payRise}% a year`, act: 'edit-scenario', arg: key }), 'Assumptions',
      'Inflation and pay rises step up each April. Interest on cash ISAs and savings uses the rate on each account, or the market path for accounts put on market rates. Growth is added monthly.')}
      ${group(
        row({ title: 'Remortgage option', value: esc(optName(s.option)), act: 'edit-scplan', arg: key }) +
        row({ title: 'Rates after a new fix, and trackers', value: `${(+s.rateShift || 0) > 0 ? '+' : ''}${+s.rateShift || 0}%`, act: 'edit-scplan', arg: key }) +
        (data.bundles.length ? row({ title: 'Life events', sub: data.bundles.map(b => `${esc(b.name)} ${TM.bundleOn(b, s) ? 'on' : 'off'}`).join(' · '), act: 'edit-scplan', arg: key }) : ''),
        'The plan', 'A scenario is a whole plan: these assumptions, which life events happen, and which remortgage deal you take. Compare plans side by side from Projection.')}
      ${group(row({ title: 'Use as default', right: sw(data.scenario === key, 'sc-default', key) }), '', 'The default scenario is what Overview shows when you open the app.')}`,
  };
}
const optName = id => { const o = id && data.remortgageOptions.find(x => x.id === id); return o ? o.name : 'None: the rate after your fix'; };
function scenarioPlanSheet(key) {
  const s = data.scenarios[key];
  const vals = { option: s.option || '', rateShift: +s.rateShift || 0 };
  for (const b of data.bundles) vals['b_' + b.id] = s.bundles[b.id] == null ? '' : s.bundles[b.id] ? 'on' : 'off';
  formSheet({
    title: s.name, values: vals,
    sections: [
      { head: 'Remortgage', foot: 'The rate change is added to tracker rates and to the rate after any new fix ends, e.g. +1% to see higher rates.', fields: [
        { key: 'option', label: 'Deal taken', type: 'select', options: [['', 'None: the rate after your fix'], ...data.remortgageOptions.map(o => [o.id, o.name])] },
        { key: 'rateShift', label: 'Rate change', type: 'percent', unit: '%' }] },
      ...(data.bundles.length ? [{ head: 'Life events', foot: '“As set” follows the switch on the event itself.', fields: data.bundles.map(b => ({ key: 'b_' + b.id, label: b.name, type: 'select', options: [['', `As set (${b.on ? 'on' : 'off'})`], ['on', 'On in this plan'], ['off', 'Off in this plan']] })) }] : [])],
    onSave: v => {
      s.option = v.option || null; s.rateShift = v.rateShift || 0;
      for (const b of data.bundles) { const x = v['b_' + b.id]; if (x) s.bundles[b.id] = x === 'on'; else delete s.bundles[b.id]; }
      changed('Plan saved');
    },
  });
}

// ---------- plan ----------
function vPlan() {
  const b = monthlyBudget(data, thisMonth()), mt = mortgageTotals(data), r = data.rules;
  // Category totals are what is running this month; a line that starts later still makes its category appear.
  const cats = {}; for (const l of flowsOf('spend')) { const v = !flowLiveNow(l) ? 0 : l.linked === 'mortgage' ? mt.payment : (+l.amount || 0); cats[l.category || 'Other'] = (cats[l.category || 'Other'] || 0) + v; }
  const inc = flowsOf('income').map(i => row({ title: esc(i.name), sub: [esc(person(i.owner)), i.growth ? `+${i.growth}% a year` : '', flowWhen(i)].filter(Boolean).join(' · '), value: amt(i.amount), cls: flowLiveNow(i) ? '' : 'dim', act: 'edit-income', arg: i.id })).join('');
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
      ${goalsGroup()}
      ${statementsGroup()}
      ${group(data.bundles.map(bundleRow).join('') + row({ title: 'Add a life event', act: 'add-bundle', cls: 'act-row', chev: false }), 'Life events', data.bundles.length ? 'Each event is a set of dated lines you can switch on or off, move or scale as one.' : 'A baby, a move, a renovation, a car, a big trip or time off work, as a set of dated costs and income changes you can switch on and off.')}
      ${group(
        row({ title: 'Mortgage', sub: mt.parts.length > 1 ? `${mt.parts.length} parts` : '', value: amt(mt.payment), vsub: mt.balance != null ? `${short(mt.balance)} owed` : 'balance not set', act: 'push', arg: 'mortgage' }) +
        row({ title: 'Upcoming payments and receipts', value: String(flowsOf('oneoff').filter(e => e.on).length), act: 'push', arg: 'events' }) +
        row({ title: 'Cash-flow calendar', sub: 'The next 24 months, each one editable', act: 'push', arg: 'calendar' }), 'Commitments')}
      ${group(
        row({ title: 'Cash floor', value: amt(r.cashFloor), act: 'edit-rules' }) +
        row({ title: 'ISA allowance', value: `${amt(r.isaPerPerson)} each`, vsub: `${esc(person(r.isaFillOrder[0]))}’s fills first`, act: 'edit-rules' }) +
        row({ title: `Used in ${r.isaUsedTaxYear}/${String(+r.isaUsedTaxYear + 1).slice(2)}`, sub: r.isaFillOrder.map(p => `${esc(person(p))} ${short(+r.isaUsedBy[p] || 0)}`).join(' · '), value: amt(r.isaFillOrder.reduce((t, p) => t + (+r.isaUsedBy[p] || 0), 0)), act: 'edit-rules' }) +
        row({ title: 'Top-ups going to S&S ISAs', value: `${r.sweepToSS || 0}%`, act: 'edit-rules' }), 'Rules', 'Each month, cash above the floor moves into ISAs until the allowances are used, one person’s first. If cash would drop below the floor, the shortfall comes back out of cash ISAs first.')}
      ${group(Object.entries(data.scenarios).map(([k, s]) => row({ title: esc(s.name) + (data.scenario === k ? '<span class="tag">Default</span>' : ''), sub: s.growth ? `S&S ${s.ssReturn}% · inflation ${s.inflation}% · pay ${s.payRise}%` : 'Growth off', act: 'push', arg: 'scenario:' + k })).join(''), 'Scenarios')}
      ${group(
        row({ title: 'Names', sub: data.people.map(p => esc(p.name)).join(', '), act: 'edit-people' }) +
        row({ title: 'Finance file', sub: esc(meta.fileName || 'Not saved to a file yet'), value: meta.conflict ? '<span class="pill warn">Changed elsewhere</span>' : meta.dirty ? '<span class="pill warn">Unsaved</span>' : meta.savedAt ? '<span class="pill ok">Saved</span>' : '', chev: false }) +
        row({ title: 'Encryption', sub: meta.encrypt ? 'Locked with your passphrase' : 'Off: anyone with the file can read it', value: meta.encrypt ? '<span class="pill ok">On</span>' : '<span class="pill">Off</span>', act: 'encrypt' }) +
        (meta.encrypt ? row({ title: 'Turn encryption off', act: 'decrypt', cls: 'act-row', chev: false }) : '') +
        (fileRoute === 'reconnect' ? row({ title: 'Reconnect to your file', act: 'reconnect', cls: 'act-row', chev: false }) : '') +
        (fileRoute === 'live' ? '' : row({ title: 'Save to file', act: 'save', cls: 'act-row', chev: false })) +
        row({ title: 'Monthly reminder to update balances', sub: 'Adds a repeating reminder to your calendar', act: 'reminder', cls: 'act-row', chev: false }) +
        row({ title: 'Open a different file', act: 'open-file', cls: 'act-row', chev: false }) +
        row({ title: 'Paste file contents', act: 'paste', cls: 'act-row', chev: false }),
        'Your data', saveHelp())}`,
  };
}
function saveHelp() {
  if (fileRoute === 'live') return `Changes save straight into ${esc(TS.handle.name)} as you make them. The file notes which device saved it last, so this device won’t overwrite changes made on another one.`;
  if (fileRoute === 'reconnect') return 'Your browser asks once per visit before Tally can write to your file again. Tap Reconnect to carry on saving automatically.';
  return 'On a computer in Chrome or Edge, open your file from your iCloud Drive or OneDrive folder and changes save into it automatically. On iPhone, Save opens the share sheet: choose Save to Files, then your iCloud Drive or OneDrive folder, and replace the old copy. This device also keeps a working copy between saves.';
}

function vSpending(cat) {
  const mPay = mortgageTotals(data).payment;
  const l = flowsOf('spend').filter(x => (x.category || 'Other') === cat);
  return {
    title: cat, large: true, back: 'Plan',
    body: group(l.map(x => {
      const mon = x.linked === 'mortgage' ? mPay : (+x.amount || 0);
      return row({ title: esc(x.name), cls: flowLiveNow(x) ? '' : 'dim', sub: x.linked === 'mortgage' ? 'Set on the mortgage page' : [x.inflates ? 'Rises with inflation' : 'Fixed', flowWhen(x)].filter(Boolean).join(' · '), value: amt(mon), vsub: `${short(mon * 12)} a year`, act: x.linked === 'mortgage' ? 'push' : 'edit-spend', arg: x.linked === 'mortgage' ? 'mortgage' : x.id });
    }).join('') + row({ title: 'Add to ' + esc(cat), act: 'add-spend', arg: cat, cls: 'act-row', chev: false }), 'Monthly'),
  };
}

function vEvents() {
  const ev = flowsOf('oneoff').sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const net = ev.filter(e => e.on).reduce((s, e) => s + e.amount, 0);
  return {
    title: 'Upcoming', large: true, back: 'Back', right: `<button class="iconbtn" data-act="add-event" aria-label="Add item">${PLUS}</button>`,
    body: `${group(ev.map(e => row({ title: esc(e.name), sub: flowWhen(e) + (e.settles ? ` · clears ${esc(acc(e.settles)?.name || '')}` : ''), value: amt(e.amount, { color: true, sign: true }), act: 'edit-event', arg: e.id, right: sw(e.on, 'ev-on', e.id), chev: false })).join('') || row({ title: 'Nothing planned' }),
      `One-off items<b>net ${money(net, { sign: true })}</b>`, 'Switch items off to see the projection without them. They stay here for later.')}
      ${group(row({ title: 'Add a payment or receipt', act: 'add-event', cls: 'act-row', chev: false }))}`,
  };
}

// ---------- statements: transactions, budget vs actual, recurring (Phase 2) ----------
const TXL = TallyTx;
const txCtx = () => ({ model: TM, amountAt, mortgagePayment: mortgageTotals(data).payment, categorised: TXL.categorised(data) });
const DEFAULT_CATS = ['Living', 'Bills', 'Home', 'Transport', 'Eating out', 'Shopping', 'Health', 'Pets', 'Holidays', 'Other'];
function catOptions(extra) {
  const planned = flowsOf('spend').map(f => f.category).concat(data.flows.filter(f => f.bundle).map(f => f.category));
  const used = data.categoryRules.map(r => r.category).concat(data.transactions.map(t => t.category), Object.values(data.categoryMap));
  const list = [...new Set([...planned, ...used, ...DEFAULT_CATS, ...(extra ? [extra] : [])].filter(c => c && !TXL.SPECIAL[c] && c !== 'Uncategorised'))].sort();
  return [...list.map(c => [c, c]), ['Income', 'Income (money in)'], ['Transfer', 'Transfer between your accounts'], ['Ignore', 'Leave out'], ['__new', 'New category…']];
}
const accName = id => accLabel(acc(id));
const monthName = m => fMonth(m + '-01');

// Overview's one line: the latest month with transactions, against plan
function actualsLine() {
  if (!data.transactions.length) return '';
  const m = TXL.months(data)[0], B = TXL.budgetVsActual(data, m, txCtx());
  return row({ title: `${monthName(m)}: ${Math.abs(B.variance) < 5 ? 'on plan' : `${short(Math.abs(B.variance))} ${B.variance > 0 ? 'over' : 'under'} plan`}`, sub: `Spent ${short(B.actual)} against ${short(B.plan)} planned`, act: 'push', arg: 'actuals' });
}
function statementsGroup() {
  const n = data.transactions.length, un = n ? TXL.categorised(data).filter(t => t.cat === 'Uncategorised').length : 0;
  return group(
    (n ? row({ title: 'Spending insights', sub: 'Trends by month, category, shop and account', act: 'push', arg: 'insights' }) + row({ title: 'Budget vs actual', sub: `${n} transactions from ${data.imports.length} import${data.imports.length === 1 ? '' : 's'}`, act: 'push', arg: 'actuals' }) +
      (un ? row({ title: `Sort out ${un} uncategorised`, sub: 'Grouped by shop, one tap each', value: '<span class="pill warn">To do</span>', act: 'push', arg: 'uncat' }) : '') +
      row({ title: 'Recurring payments', act: 'push', arg: 'recurring' }) + row({ title: 'All transactions', act: 'push', arg: 'txns' }) : '') +
    row({ title: 'Import a bank statement (CSV)', act: 'csv-import', cls: 'act-row', chev: false }) +
    (data.imports.length ? row({ title: 'Imports', value: String(data.imports.length), act: 'push', arg: 'imports' }) : ''),
    'Spending, from your statements', n ? '' : 'Download a CSV from your bank’s website and import it here to see what you actually spend against the plan. Lloyds and American Express are recognised; for any other bank you choose which column is which.');
}

// ---- importing ----
$('#csvIn').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) csvLoaded(await f.text(), f.name); });
function csvLoaded(text, name, map) {
  const guess = TXL.read(text, '_', map ? { map } : {});
  if (guess.error === 'empty') return toast('That file is empty', true);
  if (guess.error === 'unknown') return csvMapSheet(text, name, guess.header);
  if (!guess.txns.length) return toast('No transactions found in that file', true);
  const fmt = guess.format && TXL.FORMATS[guess.format];
  const opts = data.accounts.filter(a => a.active !== false).map(accOption);
  if (!opts.length) return toast('Add the account under Accounts first', true);
  const want = fmt && fmt.kind === 'card' ? ['card', 'card_0'] : ['current'];
  const suggest = (data.accounts.find(a => want.includes(a.type)) || data.accounts[0]).id;
  formSheet({
    title: 'Import statement', values: { account: suggest, bals: true },
    sections: [{ head: `${esc(guess.formatName)} · ${guess.txns.length} transactions`, foot: `${fDate(guess.from)} to ${fDate(guess.to)}.${guess.badRows.length ? ` ${guess.badRows.length} rows could not be read and will be skipped.` : ''} Anything already imported is skipped.`, fields: [{ key: 'account', label: 'Which account is this?', type: 'select', options: opts, stack: true }] },
      ...(guess.balances ? [{ foot: `The statement shows ${money(guess.balances.opening.balance)} before ${fDate(guess.from)} and ${money(guess.balances.closing.balance)} on ${fDate(guess.balances.closing.date)}. Recording them means this account needs no separate balance update for the period, and its checks reconcile exactly.`, fields: [{ key: 'bals', label: 'Record the statement’s balances', type: 'toggle' }] }] : [])],
    extra: meta.encrypt ? '' : '<p class="note"><b>Worth turning on encryption first</b> (Plan › Your data). Transactions show where you shop and when, which is more sensitive than balances, and they are saved in your finance file.</p>',
    onSave: v => {
      const r = TXL.read(text, v.account, map ? { map } : {}), f = TXL.fresh(data.transactions, r.txns);
      const batch = uid('imp');
      data.transactions.push(...f.add.map(t => ({ ...t, batch })));
      data.imports.push({ id: batch, at: new Date().toISOString(), account: v.account, format: r.format || 'csv', count: f.add.length, dupes: f.dupes, from: r.from, to: r.to });
      if (r.balances && v.bals) for (const b of [r.balances.opening, r.balances.closing]) {
        const sn = data.snapshots.find(x => x.date === b.date);
        if (sn) sn.balances[v.account] = b.balance; else data.snapshots.push({ date: b.date, balances: { [v.account]: b.balance }, source: 'import' });
      }
      changed(f.add.length ? `Imported ${f.add.length}${f.dupes ? `, skipped ${f.dupes} already there` : ''}` : `Nothing new: all ${f.dupes} were already imported`);
      actions.push(TXL.categorised(data).some(t => t.cat === 'Uncategorised') ? 'uncat' : 'actuals');
    },
  });
}
function csvMapSheet(text, name, header) {
  const cols = [['', '—'], ...header.map((h, i) => [String(i), h || `Column ${i + 1}`])];
  const find = re => { const i = header.findIndex(h => re.test(h)); return i < 0 ? '' : String(i); };
  formSheet({
    title: 'Which column is which?', values: { date: find(/date/i), description: find(/desc|detail|narrative|payee|merchant|name/i), amount: find(/^amount$|value/i), debit: find(/debit|paid out|money out|withdraw/i), credit: find(/credit|paid in|money in|deposit/i), sign: 'neg' },
    sections: [{ head: esc(name), foot: 'Fill in either Amount, or both Money out and Money in.', fields: [
      { key: 'date', label: 'Date', type: 'select', options: cols }, { key: 'description', label: 'Description', type: 'select', options: cols },
      { key: 'amount', label: 'Amount', type: 'select', options: cols }, { key: 'sign', label: 'In the Amount column, spending is', type: 'select', options: [['neg', 'Negative (−)'], ['pos', 'Positive']] },
      { key: 'debit', label: 'Money out', type: 'select', options: cols }, { key: 'credit', label: 'Money in', type: 'select', options: cols }] }],
    onSave: v => {
      const n = x => (x === '' || x == null ? null : +x);
      if (n(v.date) == null || n(v.description) == null || (n(v.amount) == null && n(v.debit) == null && n(v.credit) == null)) { toast('Choose the date, description and amount columns', true); return false; }
      setTimeout(() => csvLoaded(text, name, { date: n(v.date), description: n(v.description), amount: n(v.amount), debit: n(v.debit), credit: n(v.credit), outIsNegative: v.sign === 'neg' }), 360);
    },
  });
}
function vImports() {
  return {
    title: 'Imports', large: true, back: 'Plan',
    body: group([...data.imports].reverse().map(i => row({ title: `${esc(accName(i.account))}`, sub: `${fDate(i.at.slice(0, 10))} · ${i.count} added${i.dupes ? `, ${i.dupes} skipped` : ''} · ${i.from ? fDate(i.from) + ' to ' + fDate(i.to) : ''}`, act: 'undo-import', arg: i.id, value: '<span class="pill">Remove</span>', chev: false })).join('') || row({ title: 'Nothing imported yet' }), 'Each import', 'Removing an import takes out exactly the transactions it added.'),
  };
}

// ---- categorising ----
function catSheet(t) {
  const all = TXL.categorised(data), me = all.find(x => x.id === t.id), same = all.filter(x => x.merchant === me.merchant && x.account === me.account);
  formSheet({
    title: me.merchant || 'Transaction', values: { cat: me.cat === 'Uncategorised' ? '' : me.cat, newCat: '', all: same.length > 1 },
    sections: [{ head: `${fDate(me.date)} · ${esc(accName(me.account))} · ${money(me.amount, { sign: true, dp: true })}`, foot: esc(me.description) + (me.bankCategory ? ` · bank category: ${esc(me.bankCategory)}` : ''), fields: [
      { key: 'cat', label: 'Category', type: 'select', options: [['', 'Choose…'], ...catOptions()] }, { key: 'newCat', label: 'Or a new one', type: 'text', optional: true, ph: 'Only if you chose “New category”' },
      ...(same.length > 1 ? [{ key: 'all', label: `All ${same.length} from ${me.merchant}`, type: 'toggle', hint: 'Makes a rule, so future imports are sorted too' }] : [])] }],
    extra: me.by === 'hand' ? destructive('Go back to the automatic category', 'auto') : '',
    onSave: (v, act) => {
      const raw = data.transactions.find(x => x.id === t.id);
      if (act === 'auto') { delete raw.category; return changed('Back to automatic'); }
      const cat = v.cat === '__new' ? (v.newCat || '').trim() : v.cat;
      if (!cat) { toast('Choose a category', true); return false; }
      if (v.all && same.length > 1) {
        data.categoryRules = data.categoryRules.filter(r => !(r.contains === me.merchant && !r.min && !r.max));
        data.categoryRules.unshift({ id: uid('rule'), contains: me.merchant, category: cat, account: me.account });
        delete raw.category;
        changed(`${same.length} set to ${cat}`);
      } else { raw.category = cat; changed(`Set to ${cat}`); }
    },
  });
}
function vUncat() {
  const un = TXL.categorised(data).filter(t => t.cat === 'Uncategorised');
  const g = {}; for (const t of un) { const k = t.account + '|' + t.merchant; (g[k] ||= { m: t.merchant, account: t.account, n: 0, total: 0, id: t.id }); g[k].n++; g[k].total += t.amount; }
  const list = Object.values(g).sort((a, b) => b.n - a.n || a.total - b.total);
  return {
    title: 'Uncategorised', large: true, back: 'Plan',
    body: list.length ? `<p class="note">${un.length} transactions from ${list.length} places. Choosing a category for one sorts every transaction from that place, now and in future imports.</p>` +
      group(list.map(x => row({ title: esc(x.m), sub: `${x.n} transaction${x.n === 1 ? '' : 's'} · ${esc(accName(x.account))}`, value: amt(x.total, { sign: true, color: true }), act: 'cat-tx', arg: x.id })).join(''))
      : '<p class="note">Everything has a category.</p>',
  };
}
function vTxns(arg) {
  const [f, v] = arg ? arg.split('=') : [];
  const [cat, range] = f === 'cat' ? v.split('@') : [null, null];
  let l = TXL.categorised(data);
  if (cat) l = l.filter(t => t.cat === cat && (!range || inRange(t.date, range)));
  if (f === 'acct') l = l.filter(t => t.account === v);
  // from spending insights: a window of months, one account, a group and maybe a group inside it
  let q = null;
  if (f === 'ins') {
    q = JSON.parse(decodeURIComponent(v));
    const K = TXL.insightKey, inQ = t => { const m = t.date.slice(0, 7); return m >= q.from && m <= q.to; };
    l = l.filter(t => inQ(t) && (!q.account || t.account === q.account) && TXL.insightValue(t, q.measure) != null && (!q.by || K(t, q.by) === q.key) && (!q.by2 || K(t, q.by2) === q.key2));
  }
  l.sort((a, b) => b.date.localeCompare(a.date));
  const shown = l.slice(0, 300);
  return {
    title: cat || (f === 'acct' ? accName(v) : q ? [q.key, q.key2].filter(Boolean).map((k, i) => ((i ? q.by2 : q.by) === 'account' ? accName(k) : k)).join(' · ') || 'Transactions' : 'Transactions'), large: true, back: 'Back',
    body: `${q ? `<div class="subtitle">${esc(q.from === q.to ? monthName(q.from) : `${fMonth(q.from + '-01', true)} – ${fMonth(q.to + '-01', true)}`)}${q.account ? ' · ' + esc(accName(q.account)) : ''} · ${l.length} transactions · ${money(l.reduce((s, t) => s + t.amount, 0), { sign: true })}</div>` : ''}${cat ? `<div class="subtitle">${esc(rangeLabel(range))} · ${l.length} transactions · ${money(-l.reduce((s, t) => s + t.amount, 0))}</div>` : ''}` +
      group(shown.map(t => row({ title: esc(t.merchant || t.description), sub: `${fDate(t.date)} · ${esc(accName(t.account))}${t.pair ? ' · matched transfer' : ''}`, value: `${amt(t.amount, { sign: true, color: true, dp: true })}<div class="sub"><span class="catchip ${t.cat === 'Uncategorised' ? 'x' : ''}">${esc(t.cat)}</span></div>`, act: 'cat-tx', arg: t.id })).join('') || row({ title: 'None' }),
        '', l.length > 300 ? `Showing the latest 300 of ${l.length}.` : 'Tap one to change its category.'),
  };
}

// ---- budget vs actual (2.3) ----
// range: a month 'YYYY-MM', 'ytd' (this tax year so far) or '12m' (the last 12 months with transactions)
function rangeMonths(range) {
  const ms = TXL.months(data);
  if (!range || /^\d{4}-\d{2}$/.test(range)) return [range || ms[0]];
  if (range === '12m') return ms.slice(0, 12);
  const now = thisMonth(), [y, m] = now.split('-').map(Number), tyStart = `${m >= 4 ? y : y - 1}-04`;
  return ms.filter(x => x >= tyStart && x <= now);
}
const inRange = (date, range) => rangeMonths(range).includes(date.slice(0, 7));
const rangeLabel = r => !r || /^\d{4}-\d{2}$/.test(r) ? monthName(r || TXL.months(data)[0]) : r === '12m' ? 'Last 12 months' : 'This tax year so far';
function vActuals() {
  if (!data.transactions.length) return { title: 'Budget vs actual', large: true, back: 'Plan', body: '<p class="note">Import a bank statement first.</p>' };
  const ms = TXL.months(data), range = ui.actRange || ms[0], ctx = txCtx(), list = rangeMonths(range);
  const per = list.map(m => TXL.budgetVsActual(data, m, ctx)), agg = {};
  for (const B of per) for (const r of B.rows) { const a = agg[r.category] ||= { category: r.category, plan: 0, actual: 0, count: 0 }; a.plan += r.plan; a.actual += r.actual; a.count += r.count; }
  const rows = Object.values(agg).map(r => ({ ...r, variance: r.actual - r.plan })).sort((a, b) => b.actual - a.actual);
  const P = rows.reduce((s, r) => s + r.plan, 0), A = rows.reduce((s, r) => s + r.actual, 0);
  const accs = [...new Set(data.transactions.map(t => t.account))].map(accName);
  const bar = r => { const top = Math.max(r.plan, r.actual, 1); return `<div class="bar2"><i class="${r.actual > r.plan ? 'over' : ''}" style="width:${Math.min(100, r.actual / top * 100)}%"></i>${r.plan ? `<b style="left:${Math.min(99, r.plan / top * 100)}%"></b>` : ''}</div>`; };
  return {
    title: 'Budget vs actual', large: true, back: 'Plan',
    body: `<div class="chips">${ms.slice(0, 6).map(m => `<button class="${m === range ? 'on' : ''}" data-act="act-range" data-arg="${m}">${fMonth(m + '-01', true)}</button>`).join('')}<button class="${range === 'ytd' ? 'on' : ''}" data-act="act-range" data-arg="ytd">Tax year</button><button class="${range === '12m' ? 'on' : ''}" data-act="act-range" data-arg="12m">12 months</button></div>
      <div class="hero"><div class="cap">${esc(rangeLabel(range))}</div><div class="big amt ${A > P ? 'neg' : ''}">${money(A - P, { sign: true }).replace('£', '<span class="p">£</span>')}</div><div class="eq">${A > P ? 'over' : 'under'} plan · spent ${short(A)} of ${short(P)}</div></div>
      ${group(rows.map(r => row({ title: esc(r.category) + bar(r), sub: `${r.count} transactions${r.plan ? ` · plan ${short(r.plan)}` : ' · not in the plan'}`, value: amt(r.actual), vsub: r.plan ? `<span class="${r.variance > 0 ? 'neg' : ''}">${money(r.variance, { sign: true })}${r.plan ? ` (${Math.round(r.variance / r.plan * 100)}%)` : ''}</span>` : '', act: 'push', arg: `txns:cat=${r.category}@${range}` })).join(''),
        'By category', `Bar: spent; mark: plan. From ${esc(accs.join(', '))}. Transfers between your accounts and money in are left out.`)}
      ${recalGroup()}
      ${group(row({ title: 'What the bank’s categories mean', sub: 'e.g. American Express “Groceries” → Living', act: 'bank-cats' }) + row({ title: 'Your rules', value: String(data.categoryRules.length), act: 'push', arg: 'rules' }))}
      <p class="note">Only accounts you have imported are counted. If you pay for things from an account you haven’t imported, those months will look under plan.</p>`,
  };
}
// ---- spending insights (Sep 2026) ----
// Money out, money in, or both, over a window of whole months; by category, shop or account; one account or all.
// The month still running is drawn faded and never counted. All the arithmetic is TallyTx.insights (tested in node).
const INS_MEASURE = [['spend', 'Spending'], ['income', 'Money in'], ['net', 'In and out']];
const INS_PERIOD = [['3m', '3 months'], ['6m', '6 months'], ['12m', '12 months'], ['ty', 'Tax year'], ['all', 'All']];
const INS_BY = [['category', 'Category'], ['merchant', 'Shop'], ['account', 'Account']];
const INS_NEXT = { category: 'merchant', merchant: 'category', account: 'category' }; // what a drill-in is split by
const addMonth = (m, k) => { const [y, mo] = m.split('-').map(Number), n = y * 12 + mo - 1 + k; return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`; };
const monthsFrom = (a, b) => { const out = []; for (let m = a; m <= b; m = addMonth(m, 1)) out.push(m); return out; };
const insState = () => (ui.ins ||= { measure: 'spend', period: '6m', by: 'category', account: '', all: false });
// The window: whole months ending with the newest whole month that has transactions, plus this month if it has any.
function insWindow(period) {
  const ms = TXL.months(data), have = new Set(ms), now = thisMonth(), end = ms.find(m => m < now);
  const partial = have.has(now) ? now : null;
  if (!end) return { months: partial ? [partial] : [], full: [], prevMonths: [], partial, gaps: 0 };
  const oldest = ms.at(-1), len = { '3m': 3, '6m': 6, '12m': 12 }[period];
  let start = len ? addMonth(end, 1 - len) : period === 'ty' ? (+end.slice(5) >= 4 ? end.slice(0, 4) : String(+end.slice(0, 4) - 1)) + '-04' : oldest;
  if (start < oldest) start = oldest;
  const full = monthsFrom(start, end), n = full.length;
  const prev = period === 'all' ? [] : monthsFrom(addMonth(start, -n), addMonth(start, -1));
  return { months: partial ? [...full, partial] : full, full, prevMonths: prev.every(m => have.has(m)) ? prev : [], partial, gaps: full.filter(m => !have.has(m)).length };
}
const insKeyLabel = (by, k) => (by === 'account' ? accName(k) : k);
const pctTxt = (a, b) => (b ? ` (${a >= 0 ? '+' : '−'}${Math.round(Math.abs(a / b) * 100)}%)` : '');
function insBars(id, I, measure) {
  const two = measure === 'net', vals = s => (two ? [s.income, s.spend] : [s.v]);
  const top = Math.max(1, ...I.series.flatMap(s => vals(s).map(v => Math.max(0, v))), two ? 0 : I.avg);
  const ticks = niceTicks(0, top * 1.08, 3).filter(v => v > 0), H = 150, y = v => (Math.max(0, v) / (top * 1.08)) * 100;
  const colors = two ? ['var(--green)', 'var(--accent)'] : [measure === 'income' ? 'var(--green)' : 'var(--accent)'];
  const step = I.series.length > 12 ? Math.ceil(I.series.length / 8) : 1;
  const cols = I.series.map((s, i) => `<button class="bcol${s.partial ? ' part' : ''}" data-i="${i}" aria-label="${esc(fMonth(s.month + '-01'))}: ${two ? `in ${money(s.income)}, out ${money(s.spend)}` : money(s.v)}${s.partial ? ' so far' : ''}">${vals(s).map((v, k) => `<i style="height:${y(v).toFixed(2)}%;background:${colors[k]}"></i>`).join('')}<span class="bx">${i % step ? '' : MON[+s.month.slice(5) - 1]}</span></button>`).join('');
  charts[id] = { bars: I.series, two, measure, avg: I.avg };
  return `<div class="readout" id="${id}-r"></div><div class="chart bars" id="${id}"><div class="bplot" style="height:${H}px">${ticks.map(v => `<div class="bgrid" style="bottom:${y(v)}%"><span>${short(v)}</span></div>`).join('')}${!two && I.avg > 0 ? `<div class="bavg" style="bottom:${y(I.avg)}%"></div>` : ''}<div class="bcols">${cols}</div></div></div>` +
    `<div class="legend">${two ? `<span><i class="sq" style="background:var(--green)"></i>Money in</span><span><i class="sq" style="background:var(--accent)"></i>Money out</span>` : `<span><i class="dash"></i>Average of the whole months</span>`}${I.series.some(s => s.partial) ? `<span><i class="sq" style="background:${colors[0]};opacity:.4"></i>This month so far</span>` : ''}</div>`;
}
function mountBars(id, open) {
  const c = charts[id], el = document.getElementById(id), r = document.getElementById(id + '-r'); if (!c || !el) return;
  let shownI; // redraw only when the month shown changes, or a button under the pointer is replaced mid-click
  const say = i => {
    if (i === shownI) return; shownI = i;
    el.querySelectorAll('.bcol').forEach(b => b.classList.toggle('on', i != null && +b.dataset.i === i));
    if (i == null) { r.innerHTML = `<div class="when">${c.two ? 'Average a month' : 'Tap a month'}</div>` + (c.two ? `<span class="s">${money(c.bars.filter(s => !s.partial).reduce((a, s) => a + s.income - s.spend, 0) / Math.max(1, c.bars.filter(s => !s.partial).length), { sign: true })} kept</span>` : `<span class="s">Average ${money(c.avg)} a month</span>`); return; }
    const s = c.bars[i], net = s.income - s.spend;
    r.innerHTML = `<div class="when">${fMonth(s.month + '-01')}${s.partial ? ' so far' : ''}</div>` + (c.two ? `<span class="s"><i style="background:var(--green)"></i>In ${money(s.income)}</span><span class="s"><i style="background:var(--accent)"></i>Out ${money(s.spend)}</span><span class="s">${net >= 0 ? 'Kept' : 'Short'} ${money(Math.abs(net))}</span>` : `<span class="s">${money(s.v)}</span>${s.partial || !c.avg ? '' : `<span class="s sub">${money(s.v - c.avg, { sign: true })} against average</span>`}`) +
      `<button class="linkbtn" data-act="push" data-arg="${esc(open(s.month))}">${s.count} transaction${s.count === 1 ? '' : 's'} ›</button>`;
  };
  // a tap picks a month (and a second tap on it lets go); with a mouse and nothing picked, hovering previews
  let sel = null;
  el.querySelectorAll('.bcol').forEach(b => {
    b.addEventListener('click', () => { const i = +b.dataset.i; sel = sel === i ? null : i; shownI = undefined; say(sel); });
    b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && sel == null) say(+b.dataset.i); }); // once a month is picked, hover leaves it alone so its link can be reached
  });
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') say(sel); });
  say(null);
}
const insTxnsArg = q => 'txns:ins=' + encodeURIComponent(JSON.stringify(q));
function vInsights(focusArg) {
  if (!data.transactions.length) return { title: 'Spending insights', large: true, back: 'Plan', body: '<p class="note">Import a bank statement first.</p>' };
  const st = insState(), measure = st.measure, W = insWindow(st.period), ctx = txCtx();
  const focus = focusArg ? { by: focusArg.slice(0, focusArg.indexOf('=')), key: focusArg.slice(focusArg.indexOf('=') + 1) } : null;
  const by = focus ? INS_NEXT[focus.by] : st.by;
  const I = TXL.insights(ctx.categorised, { months: W.months, prevMonths: W.prevMonths, measure, by, account: st.account || null, focus, partial: W.partial });
  const from = W.full[0], to = W.full.at(-1), noun = { spend: 'Spent', income: 'Money in', net: I.total < 0 ? 'Spent more than came in' : 'Kept' }[measure];
  const txq = extra => insTxnsArg({ measure, account: st.account || null, from, to, ...(focus ? { by: focus.by, key: focus.key } : {}), ...extra });
  const accs = [...new Set(data.transactions.map(t => t.account))].filter(acc);
  const chips = (list, cur, act) => `<div class="chips">${list.map(([v, l]) => `<button class="${v === cur ? 'on' : ''}" data-act="${act}" data-arg="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
  const good = v => (measure === 'spend' ? v <= 0 : v >= 0); // up is bad for spending, good for money in
  const chg = (v, base) => (v == null ? '' : `<span class="${Math.abs(v) < 0.5 ? '' : good(v) ? 'pos' : 'neg'}">${money(v, { sign: true })}${pctTxt(v, base)}</span>`);
  const want = { '3m': 3, '6m': 6, '12m': 12 }[st.period], nFull = W.full.length;
  // say what the figures really cover: "last 6 months" over two months of statements would overstate it
  const periodWord = want && nFull < want ? `the ${nFull} whole month${nFull === 1 ? '' : 's'} there are` : { '3m': 'last 3 months', '6m': 'last 6 months', '12m': 'last 12 months', ty: 'this tax year', all: 'all your statements' }[st.period];
  const title = focus ? insKeyLabel(focus.by, focus.key) : 'Spending insights';
  if (!W.full.length) return { title, large: true, back: 'Back', body: `${seg(INS_MEASURE, measure, 'ins-measure')}<p class="note">There is no whole month of transactions yet. Come back once a month has finished.</p>` };

  const shown = st.all ? I.rows : I.rows.slice(0, 10);
  const drillArg = r => (focus ? txq({ by2: by, key2: r.key }) : 'insights:' + by + '=' + r.key);
  const spark = r => { if (r.byMonth.length < 3) return ''; const top = Math.max(1, ...r.byMonth.map(Math.abs)); return `<span class="spark" aria-hidden="true" style="width:${Math.min(12, r.byMonth.length) * 4}px">${r.byMonth.slice(-12).map(v => `<i style="height:${Math.max(6, Math.abs(v) / top * 100)}%"></i>`).join('')}</span>`; };
  const breakdown = shown.map(r => row({
    title: `${esc(insKeyLabel(by, r.key))}<div class="bar2"><i style="width:${(r.share * 100).toFixed(1)}%${measure !== 'spend' && r.total > 0 ? ';background:var(--green)' : ''}"></i></div>`,
    sub: `${short(Math.abs(r.avg))} a month · ${r.count} · ${Math.round(r.share * 100)}%`,
    value: `${spark(r)}${amt(measure === 'net' ? r.total : Math.abs(r.total), { color: measure === 'net', sign: measure === 'net' })}`, vsub: r.change != null ? chg(r.change, r.prev) : '',
    act: 'push', arg: drillArg(r),
  })).join('') + (I.rows.length > 10 ? row({ title: st.all ? 'Show the top 10' : `Show all ${I.rows.length}`, act: 'ins-all', cls: 'act-row', chev: false }) : '');
  const mv = I.movers && (I.movers.up.length || I.movers.down.length) && measure !== 'net' ? group([...I.movers.up, ...I.movers.down].map(x => row({
    title: `${esc(insKeyLabel(by, x.key))} ${x.delta > 0 ? '↑' : '↓'}`, sub: `${short(x.before)} → ${short(x.after)} a month`,
    value: `<span class="${good(x.delta) ? 'pos' : 'neg'}">${money(x.delta, { sign: true })}</span>`, vsub: 'a month', act: 'push', arg: drillArg(x) })).join(''),
    'What’s changing', 'The last three whole months against the three before. Only moves of at least £20 a month, and a tenth, are shown.') : '';
  const big = I.biggest.length ? group(I.biggest.map(t => row({ title: esc(t.merchant || t.description), sub: `${fDate(t.date)} · ${esc(t.cat)} · ${esc(accName(t.account))}`, value: amt(t.amount, { sign: true, color: true, dp: true }), act: 'cat-tx', arg: t.id })).join(''), 'Largest') : '';

  return {
    title, large: true, back: focus ? 'Back' : 'Plan',
    body: `${focus ? '' : seg(INS_MEASURE, measure, 'ins-measure')}
      ${chips(INS_PERIOD, st.period, 'ins-period')}
      ${accs.length > 1 ? chips([['', 'All accounts'], ...accs.map(id => [id, accName(id)])], st.account, 'ins-acct') : ''}
      <div class="hero"><div class="cap">${esc(noun)}, ${esc(periodWord)}${focus ? '' : st.account ? ' · ' + esc(accName(st.account)) : ''}</div>
        <div class="big amt${measure === 'net' && I.total < 0 ? ' neg' : ''}">${money(measure === 'net' ? I.total : Math.abs(I.total)).replace('£', '<span class="p">£</span>')}</div>
        ${measure === 'net' ? `<div class="eq">In ${money(I.series.filter(x => !x.partial).reduce((a, x) => a + x.income, 0))} · out ${money(I.series.filter(x => !x.partial).reduce((a, x) => a + x.spend, 0))}</div>` : ''}
        <div class="eq">${short(Math.abs(I.avg))} a month · ${I.count} transaction${I.count === 1 ? '' : 's'}${I.change != null ? ` · ${chg(I.change, I.prev)} on the ${W.full.length} month${W.full.length === 1 ? '' : 's'} before` : ''}</div></div>
      <section class="card"><div class="gh">Month by month<b>${esc(fMonth(from + '-01', true))} – ${esc(fMonth(to + '-01', true))}</b></div>${insBars('c-ins', I, measure)}</section>
      ${focus ? '' : seg(INS_BY, by, 'ins-by')}
      ${breakdown ? group(breakdown, `By ${INS_BY.find(x => x[0] === by)[1].toLowerCase()}${focus ? '' : ''}`, focus ? 'Tap one to see its transactions.' : 'Tap one to look inside it. The small bars are its last months; the figure under the total is against the period before.') : '<p class="note">Nothing in this period.</p>'}
      ${mv}${big}
      ${group(row({ title: `All ${I.count} transactions`, act: 'push', arg: txq({}) }))}
      <p class="note">${measure === 'spend' ? 'Spending is money out less refunds. Transfers between your own accounts, money in and anything marked “leave out” are not counted. ' : ''}Only imported accounts are included${W.gaps ? `; ${W.gaps} month${W.gaps === 1 ? '' : 's'} in this period ha${W.gaps === 1 ? 's' : 've'} no transactions at all` : ''}.</p>`,
    after: () => mountBars('c-ins', m => txq({ from: m, to: m })),
  };
}
// Recalibration (1.7): the last three complete months of actual spending against plan, by category.
// Complete = not the current month. Suggests a change where a category is more than 10% away from plan.
function recalibration() {
  const ms = TXL.months(data).filter(m => m < thisMonth()).slice(0, 3);
  if (ms.length < 3) return null;
  return TXL.recalibrate(data, ms, txCtx());
}
function recalGroup() {
  const R = recalibration(); if (!R) return '';
  const lines = R.rows.map(r => row({ title: `${esc(r.category)}: ${short(r.actual)} a month`, sub: `Planned ${short(r.plan)}. Tap to update the plan to the 3-month average.`, value: amt(r.actual - r.plan, { sign: true, color: true }), act: 'recal', arg: r.category + '|' + r.actual.toFixed(2) })).join('');
  return (R.over ? `<div class="warnchip" role="status"><div><b>Spending is running over plan</b><br>The last three months averaged ${money(R.actual)} a month against ${money(R.plan)} planned (${Math.round((R.actual / R.plan - 1) * 100)}% over).</div></div>` : '') +
    (lines ? group(lines, `Against plan<b>${fMonth(R.months[2] + '-01', true)} – ${fMonth(R.months[0] + '-01', true)}</b>`, 'Averages of the last three complete months. Only categories more than 10% away from plan are shown.') : '');
}
function recalApply(arg) {
  const [cat, avg] = [arg.slice(0, arg.lastIndexOf('|')), +arg.slice(arg.lastIndexOf('|') + 1)];
  const l = flowsOf('spend').filter(f => (f.category || 'Other') === cat && !f.linked && flowLiveNow(f));
  if (l.length !== 1) { toast(l.length ? `${cat} has ${l.length} plan lines: change them on its page` : `${cat} has no plan line to change`, true); return actions.push('spending:' + cat); }
  if (!confirm(`Change “${l[0].name}” from ${money(l[0].amount)} to ${money(avg)} a month?`)) return;
  l[0].amount = Math.round(avg * 100) / 100; changed(`${l[0].name} updated`);
}
function bankCatSheet() {
  const seen = [...new Set(data.transactions.map(t => t.bankCategory).filter(Boolean))].sort();
  if (!seen.length) return toast('None of your imports came with bank categories', true);
  const vals = {}; for (const c of seen) vals['c_' + seen.indexOf(c)] = data.categoryMap[c] || '';
  formSheet({
    title: 'Bank categories', values: vals,
    sections: [{ foot: 'Blank keeps Tally’s guess. A rule or a category you set by hand still wins.', fields: seen.map((c, i) => ({ key: 'c_' + i, label: c, type: 'select', options: [['', 'Tally’s guess'], ...catOptions().filter(o => o[0] !== '__new')] })) }],
    onSave: v => { seen.forEach((c, i) => { if (v['c_' + i]) data.categoryMap[c] = v['c_' + i]; else delete data.categoryMap[c]; }); changed('Saved'); },
  });
}
function vRules() {
  return {
    title: 'Rules', large: true, back: 'Back',
    body: group(data.categoryRules.map(r => row({ title: `“${esc(r.contains)}” → ${esc(r.category)}`, sub: [r.account ? esc(accName(r.account)) : 'Any account', r.min != null ? `from £${r.min}` : '', r.max != null ? `up to £${r.max}` : ''].filter(Boolean).join(' · '), act: 'edit-rule', arg: r.id })).join('') || row({ title: 'No rules yet' }),
      'First match wins', 'A rule is made when you set a category for everything from one place. Rules apply to transactions already imported, too.') + group(row({ title: 'Add a rule', act: 'edit-rule', cls: 'act-row', chev: false })),
  };
}
function ruleSheet(id) {
  const r = id ? data.categoryRules.find(x => x.id === id) : { contains: '', category: '', min: null, max: null, account: '' };
  formSheet({
    title: id ? 'Rule' : 'New rule', values: { ...r, account: r.account || '' },
    sections: [{ fields: [{ key: 'contains', label: 'Description contains', type: 'text' }, { key: 'category', label: 'Category', type: 'select', options: catOptions(r.category).filter(o => o[0] !== '__new') },
      { key: 'min', label: 'Amount from', type: 'money', optional: true }, { key: 'max', label: 'Amount up to', type: 'money', optional: true },
      { key: 'account', label: 'Account', type: 'select', options: [['', 'Any account'], ...data.accounts.map(accOption)], stack: true }] }],
    extra: id ? destructive('Delete rule', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.categoryRules = data.categoryRules.filter(x => x.id !== id); return changed('Rule deleted'); }
      if (!v.contains.trim()) { toast('Enter some text to match', true); return false; }
      const rec = { contains: v.contains.trim().toUpperCase(), category: v.category, min: v.min, max: v.max, account: v.account || null };
      if (id) Object.assign(r, rec); else data.categoryRules.push({ id: uid('rule'), ...rec });
      changed('Rule saved');
    },
  });
}

// ---- recurring (2.4) ----
function vRecurring() {
  const R = TXL.recurring(TXL.categorised(data), todayISO());
  const flag = r => [r.isNew ? '<span class="pill">New</span>' : '', r.rise ? `<span class="pill warn">Up ${money(r.rise, { dp: true })}</span>` : '', r.stopped ? '<span class="pill">Stopped?</span>' : ''].join(' ');
  const live = R.filter(r => !r.stopped), gone = R.filter(r => r.stopped);
  const list = l => l.map(r => row({ title: esc(r.merchant), sub: `${r.cadence} · ${esc(r.category)} · last ${fDate(r.last)}${r.stopped ? '' : ` · next about ${fDate(r.next)}`}${r.rise ? ` · up since ${fDate(r.riseSince)}` : ''}`, value: `${money(r.amount, { dp: true })}${flag(r) ? `<div class="sub">${flag(r)}</div>` : ''}`, vsub: r.cadence === 'monthly' ? '' : `${short(r.perMonth)} a month`, act: 'push', arg: `txns:cat=${r.category}@12m` })).join('');
  return {
    title: 'Recurring payments', large: true, back: 'Plan',
    body: R.length ? `<div class="hero"><div class="cap">Regular payments</div><div class="big amt">${money(live.reduce((s, r) => s + r.perMonth, 0)).replace('£', '<span class="p">£</span>')}</div><div class="eq">a month, from ${live.length} payments</div></div>
      ${group(list(live), 'Still going', 'Found from payments to the same place at a steady rhythm and a similar amount. New, price rises and ones that seem to have stopped are flagged.')}
      ${gone.length ? group(list(gone), 'Seem to have stopped', 'No payment for well over its usual gap.') : ''}` : '<p class="note">None found yet. Import a few months of statements.</p>',
  };
}

const TA = TallyAnalysis;

// ---------- ISA tax year (3.3) ----------
function vIsaYear() {
  const Y = TA.isaYear(data, scenarioKey(), thisMonth());
  if (!Y) return { title: 'ISA allowance', large: true, back: 'Projection', body: '<p class="note">Add your balances first.</p>' };
  const ty = `${Y.taxYear}/${String(Y.taxYear + 1).slice(2)}`;
  return {
    title: `ISAs ${ty}`, large: true, back: 'Projection',
    body: Y.people.map(p => group(
      row({ title: 'Allowance', value: amt(p.allowance) }) + row({ title: 'Paid in so far', sub: 'As entered under Plan › Rules', value: amt(p.used), act: 'edit-rules' }) +
      row({ title: 'Planned by 5 April', sub: 'Top-ups the projection makes', value: amt(p.planned) }) + row({ title: 'Left unused', value: amt(p.left), cls: 'total' }), esc(person(p.person)))).join('') +
      group(row({ title: 'Re-deposit room at the end of March', sub: 'Money taken out of a flexible ISA this year that can go back in without using allowance', value: amt(Y.redeposit) })) +
      `<p class="note">Allowance fills ${esc(person(data.rules.isaFillOrder[0]))}’s first. Unused allowance does not carry over into the next tax year.</p>`,
  };
}
function isaNudge() {
  const Y = data.snapshots.length && TA.isaYear(data, data.scenario || 'cautious', thisMonth());
  if (!Y || !Y.nudge) return '';
  const left = Y.people.filter(p => p.left > 0.5);
  return `<div class="warnchip" role="status"><div><b>ISA allowance going unused</b><br>${left.map(p => `${esc(person(p.person))} ${money(p.left)}`).join(', ')} left before 5 April on current plans. Unused allowance is lost.</div><button data-act="push" data-arg="isayear">See</button></div>`;
}

// ---------- goals (3.2) ----------
function goalsGroup() {
  const sk = scenarioKey();
  return group(data.goals.map(g => { const st = TA.goalStatus(data, sk, g, thisMonth()); return row({ title: esc(g.name), sub: st ? `${money(g.target)} by ${fMonth(g.date + '-01')} · ${st.onTrack ? 'on track' : `${short(st.shortfall)} short${st.reached ? `, reached ${fMonth(st.reached)}` : ''}`}` : '', value: st ? `<span class="pill ${st.onTrack ? 'ok' : 'warn'}">${st.onTrack ? 'On track' : 'Behind'}</span>` : '', act: 'push', arg: 'goal:' + g.id }); }).join('') +
    row({ title: 'Add a goal', act: 'edit-goal', cls: 'act-row', chev: false }), 'Goals', data.goals.length ? '' : 'A target amount by a date, from the accounts you choose, e.g. an overpayment pot by the fix end.');
}
function vGoal(id) {
  const g = data.goals.find(x => x.id === id); if (!g) { ui.stacks[ui.tab].pop(); return currentView(); }
  const st = TA.goalStatus(data, scenarioKey(), g, thisMonth());
  return {
    title: g.name, large: true, back: 'Plan', right: `<button class="pill" data-act="edit-goal" data-arg="${esc(id)}" style="color:var(--accent)">Edit</button>`,
    body: `<div class="hero"><div class="cap">${money(g.target)} by ${fMonth(g.date + '-01')}</div><div class="big amt">${Math.round(st.progress * 100)}<span class="p">%</span></div><div class="eq">${money(st.now)} there today</div></div>
      ${group(row({ title: `Projected by ${fMonth(g.date + '-01')}`, value: amt(st.atDate) }) +
        row({ title: st.onTrack ? 'On track' : 'Short by', value: st.onTrack ? '<span class="pill ok">On track</span>' : amt(-st.shortfall, { color: true }) }) +
        (st.onTrack ? '' : row({ title: 'Extra to save each month', sub: 'On top of what the plan already puts in, to get there on time', value: amt(st.extraPerMonth) })) +
        row({ title: 'Reached', value: st.reached ? fMonth(st.reached) : 'Not within 10 years' }), esc(data.scenarios[scenarioKey()].name) + ' scenario')}
      ${group(g.accounts.map(aid => row({ title: esc(accName(aid)), value: amt(+(latestSnapshot(data)?.balances[aid] || 0)) })).join(''), 'Counts towards it')}
      <p class="note">Accounts the projection pools together (cash, instant cash ISAs, S&amp;S ISAs) take their share of the pool by today’s balances.</p>`,
  };
}
function goalSheet(id) {
  const g = id ? data.goals.find(x => x.id === id) : { name: '', target: null, date: TM.shiftMonth(thisMonth(), 12), accounts: [] };
  const vals = { name: g.name, target: g.target, date: g.date };
  const eligible = data.accounts.filter(a => !TM.LIABILITIES.has(a.type) && a.active !== false);
  eligible.forEach(a => { vals['a_' + a.id] = g.accounts.includes(a.id); });
  formSheet({
    title: id ? g.name : 'New goal', values: vals,
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text', ph: 'e.g. Overpayment pot' }, { key: 'target', label: 'Target', type: 'money' }, { key: 'date', label: 'By', type: 'month' }] },
      { head: 'Which accounts count', fields: eligible.map(a => ({ key: 'a_' + a.id, label: accLabel(a), hint: `${person(a.owner)} · ${TYPE_LABEL[a.type]}`, type: 'toggle' })) }],
    extra: id ? destructive('Delete goal', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.goals = data.goals.filter(x => x.id !== id); if (ui.stacks[ui.tab].at(-1) === 'goal:' + id) ui.stacks[ui.tab].pop(); return changed('Goal deleted'); }
      const accounts = eligible.filter(a => v['a_' + a.id]).map(a => a.id);
      if (!(v.target > 0) || !v.date || !accounts.length) { toast('Set a target, a month and at least one account', true); return false; }
      const rec = { name: v.name || 'Goal', target: v.target, date: v.date, accounts };
      if (id) Object.assign(g, rec); else data.goals.push({ id: uid('goal'), ...rec });
      changed('Goal saved');
    },
  });
}

// ---------- where the change came from (3.1) ----------
function attributionGroup(date) {
  const prev = snapsSorted().filter(s => s.date < date).at(-1); if (!prev) return '';
  const X = TA.attribution(data, prev.date, date); if (!X) return '';
  const inv = X.accounts.filter(a => a.return != null);
  return group(
    row({ title: 'Money put in', sub: 'Saved into accounts, less anything used to pay off debt', value: amt(X.saved, { sign: true, color: true }) }) +
    row({ title: 'Investment growth', sub: 'S&S ISAs and pensions, after what you paid in', value: amt(X.growth, { sign: true, color: true }) }) +
    row({ title: 'Interest', sub: 'Estimated from each account’s rate', value: amt(X.interest, { sign: true, color: true }) }) +
    row({ title: 'Debt paid off', sub: '0% cards and tax owed', value: amt(X.debt, { sign: true, color: true }) }) +
    row({ title: 'Change in net worth', value: amt(X.change, { sign: true, color: true }), cls: 'total' }),
    `Where the change came from<b>since ${fDate(prev.date)}</b>`, inv.length ? inv.map(a => `${esc(accName(a.id))}: ${(a.return * 100).toFixed(1)}%${X.days > 60 ? ` (${(a.annual * 100).toFixed(1)}% a year)` : ''}${a.paidIn ? ` after ${money(a.paidIn)} paid in` : ''}`).join(' · ') + '. Returns are money-weighted: what you paid in counts from halfway through.' : 'Enter what you paid into S&S ISAs and pensions when you update balances, to separate growth from money put in.');
}

// ---------- range of outcomes and stress tests (Phase 4) ----------
let mcWorker = null, mcSeq = 0;
function runMC(opts, done) {
  const id = ++mcSeq, payload = { id, data: JSON.parse(JSON.stringify(data)), sk: scenarioKey(), opts };
  if (!framed && window.Worker) {
    try {
      mcWorker ||= new Worker('mc-worker.js');
      mcWorker.onmessage = e => { if (e.data.id === mcSeq) done(e.data.error ? null : e.data.result, e.data.error); };
      return mcWorker.postMessage(payload);
    } catch (e) { }
  }
  setTimeout(() => { try { done(TA.monteCarlo(payload.data, payload.sk, { ...opts, paths: Math.min(opts.paths, 500) })); } catch (e) { done(null, e.message); } }, 30);
}
function vRisk() {
  const sk = scenarioKey(), sc = data.scenarios[sk], H = Math.max(horizon(), 36), vol = ui.mcVol || 15;
  if (!latestSnapshot(data)) return { title: 'Range of outcomes', large: true, back: 'Projection', body: '<p class="note">Add your balances first.</p>' };
  const R = readyNow(), target = data.rules.remortgage.target;
  const key = `${edits}|${sk}|${H}|${vol}`;
  if (!ui.mc || ui.mc.key !== key) {
    ui.mc = { key, running: true };
    runMC({ paths: 2000, vol, months: H, seed: 1, target, today: thisMonth() }, (res, err) => { if (ui.mc && ui.mc.key === key) { ui.mc = { key, res, err }; if (ui.stacks[ui.tab].at(-1) === 'risk') render(); } });
  }
  const M = ui.mc.res;
  let fan = '<p class="note">Working out 2,000 possible futures…</p>';
  if (M) {
    const pts = f => M.band.map((b, i) => ({ t: monthEndT(M.dates[i]), v: b[f] }));
    fan = chart('c-fan', { series: [{ name: 'Best 10%', color: 'var(--c-isa)', pts: pts('p90'), dash: true }, { name: 'Middle', color: 'var(--c-net)', pts: pts('p50') }, { name: 'Worst 10%', color: 'var(--red)', pts: pts('p10'), dash: true }], height: 160 });
  } else if (ui.mc.err) fan = `<p class="note">Couldn’t run the simulation: ${esc(ui.mc.err)}</p>`;
  const stressRows = Object.keys(TA.STRESSES).map(k => {
    const S = TA.stressed(data, sk, k, H, thisMonth());
    const d = S.after.available != null && S.base.available != null ? S.after.available - S.base.available : null;
    return row({ title: esc(S.name), sub: [S.blurb ? esc(S.blurb) : '', S.detail ? esc(S.detail) : '', S.after.breaches ? `<span class="neg">cash below the floor in ${S.after.breaches} month${S.after.breaches === 1 ? '' : 's'}</span>` : 'cash floor holds', S.after.invested != null && S.base.invested - S.after.invested > 50 ? `S&amp;S ${short(S.base.invested - S.after.invested)} lower at the fix end${k === 'markets' ? '' : ' (sold to keep cash at the floor)'}` : '', `lowest cash ${short(S.after.lowest)}`].filter(Boolean).join(' · '),
      value: d != null ? amt(d, { sign: true, color: true }) : amt(S.after.net - S.base.net, { sign: true, color: true }), vsub: d != null ? 'free at fix end' : `net worth in ${H / 12} years` });
  }).join('');
  return {
    title: 'Range of outcomes', large: true, back: 'Projection',
    body: `<div class="chips">${[10, 15, 20].map(v => `<button class="${v === vol ? 'on' : ''}" data-act="mc-vol" data-arg="${v}">${v}% volatility</button>`).join('')}</div>
      <section class="card"><div class="gh">Net worth, 2,000 possible futures<b>${esc(sc.name)}</b></div>${fan}</section>
      ${M ? group(
        row({ title: `Net worth in ${H / 12} years`, sub: `Worst 10% ${short(M.end.p10)} · best 10% ${short(M.end.p90)}`, value: amt(M.end.p50), vsub: 'middle' }) +
        row({ title: 'Chance cash drops below your floor', sub: 'In any month, because ISAs run out', value: `${Math.round(M.pBreach * 100)}%` }) +
        (M.available ? row({ title: 'Free to overpay at the fix end', sub: `Worst 10% ${short(M.available.p10)} · best 10% ${short(M.available.p90)}`, value: amt(M.available.p50), vsub: 'middle' }) : '') +
        (M.pBelowTarget != null ? row({ title: `Chance of missing your ${short(M.target)} target`, value: `${Math.round(M.pBelowTarget * 100)}%` }) : ''),
        'What the range says', `S&S returns drawn at random each month around ${sc.growth ? sc.ssReturn : 0}% a year, with ${vol}% a year of ups and downs. Cash and savings rates are held at their rates. It shows spread, not a forecast.`) : ''}
      ${group(stressRows, 'Stress tests', R ? 'Each one on top of the plan as it stands. The figure is the change in what’s free to overpay at your next fix end.' : 'Each one on top of the plan as it stands.')}`,
    after: () => M && mountChart('c-fan'),
  };
}

// ---------- balance reminders (5.5) ----------
// A calendar file with a monthly reminder on the 1st - no server, no account. Opening it adds it to Calendar.
function reminderICS() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 2 > 12 ? 1 : d.getMonth() + 2, yy = m === 1 ? y + 1 : y;
  const day = `${yy}${String(m).padStart(2, '0')}01`, stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tally//Balance reminder//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:tally-balance-reminder-${stamp}@tally`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`, 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
    'SUMMARY:Update balances in Tally', 'DESCRIPTION:Open Tally and add this month’s balances.', 'BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', 'DESCRIPTION:Update balances in Tally', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
function downloadReminder() {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([reminderICS()], { type: 'text/calendar' })); a.download = 'tally-balance-reminder.ics'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Open the file to add the reminder to your calendar');
}

// ---------- cash-flow calendar (Phase 1.7) ----------
// The next 24 months, each one editable: a month's figure for any income or cost can be set by hand
// (stored as flow.overrides['YYYY-MM'], used as-is with no inflation), and one-offs dropped into it.
function vCalendar() {
  const sk = scenarioKey(), pr = project(data, sk, Math.max(24, ymKeyOf(todayISO()) - ymKeyOf(latestSnapshot(data).date) + 24));
  if (!pr) return { title: 'Cash-flow calendar', large: true, back: 'Plan', body: '<p class="note">Add your balances first.</p>' };
  const rows = pr.rows.filter(r => r.date.slice(0, 7) >= thisMonth()).slice(0, 24);
  const edited = m => data.flows.some(f => f.overrides && f.overrides[m] != null);
  return {
    title: 'Cash-flow calendar', large: true, back: 'Plan',
    body: `<p class="note">Tap a month to change what comes in or goes out in that month only, or to drop a one-off into it.</p>
      ${group(rows.map(r => {
        const m = r.date.slice(0, 7), b = [];
        for (const e of r.events) b.push(`<span class="badge ${e.amount < 0 ? 'out' : 'in'}">${esc(e.name)} ${short(e.amount)}</span>`);
        if (edited(m)) b.push('<span class="badge isa">Set by hand</span>');
        const net = r.income - r.spend - r.buffer + r.payments + r.receipts - r.dealCash;
        return `<button class="row" data-act="cal-month" data-arg="${m}"><div class="main"><div class="ttl">${fMonth(r.date)}</div><div class="sub">in ${short(r.income + r.receipts)} · out ${short(r.spend + r.buffer - r.payments + r.dealCash)}</div>${b.length ? `<div class="badges">${b.join('')}</div>` : ''}</div><div class="val strong">${amt(net, { sign: true, color: true })}<div class="sub">cash ${amt(r.closing)}</div></div>${CHEV}</button>`;
      }).join(''), `Month by month<b>${esc(data.scenarios[sk].name)}</b>`, 'Net is money in less money out that month, before anything moves into or out of ISAs.')}`,
  };
}
function calendarMonthSheet(m) {
  const k = TM.monthKey(m);
  const regular = data.flows.filter(f => f.kind !== 'oneoff' && !f.linked && TM.flowActive(f, k) && (!f.bundle || TM.bundleOn(bundleById(f.bundle) || {}, null)));
  const oneoffs = data.flows.filter(f => f.kind === 'oneoff' && f.start === m);
  const vals = {};
  regular.forEach(f => { vals['f_' + f.id] = f.overrides && f.overrides[m] != null ? +f.overrides[m] : +f.amount || 0; });
  oneoffs.forEach(f => { vals['o_' + f.id] = f.amount; });
  const label = f => f.bundle ? `${f.name} (${bundleById(f.bundle)?.name || 'event'})` : f.name;
  formSheet({
    title: fMonth(m + '-01'), values: vals,
    sections: [
      ...(regular.filter(f => f.kind === 'income').length ? [{ head: 'Coming in this month', fields: regular.filter(f => f.kind === 'income').map(f => ({ key: 'f_' + f.id, label: label(f), type: 'money', hint: f.overrides && f.overrides[m] != null ? `Set by hand · usually ${money(f.amount)}` : '' })) }] : []),
      ...(regular.filter(f => f.kind === 'spend').length ? [{ head: 'Going out this month', foot: 'A figure you change here is used exactly for this month, with no inflation added. Put it back to the usual amount to undo it.', fields: regular.filter(f => f.kind === 'spend').map(f => ({ key: 'f_' + f.id, label: label(f), type: 'money', hint: f.overrides && f.overrides[m] != null ? `Set by hand · usually ${money(f.amount)}` : '' })) }] : []),
      ...(oneoffs.length ? [{ head: 'One-offs this month', foot: 'Minus for money out.', fields: oneoffs.map(f => ({ key: 'o_' + f.id, label: label(f), type: 'money' })) }] : [])],
    extra: `<section class="group"><div class="list"><button class="row act-row" data-sact="add-oneoff"><div class="main"><div class="ttl">Add a one-off in ${fMonth(m + '-01')}</div></div></button></div></section>`,
    onSave: (v, act) => {
      if (act === 'add-oneoff') { setTimeout(() => eventSheet(null, null, m), 360); return; }
      for (const f of regular) {
        const x = v['f_' + f.id]; if (x == null) continue;
        if (Math.abs(x - (+f.amount || 0)) > 0.005) (f.overrides ||= {})[m] = x;
        else if (f.overrides) { delete f.overrides[m]; if (!Object.keys(f.overrides).length) delete f.overrides; }
      }
      for (const f of oneoffs) if (v['o_' + f.id] != null) f.amount = v['o_' + f.id];
      changed(`${fMonth(m + '-01')} saved`);
    },
  });
}

// ---------- remortgage readiness (Phase 1.1, 1.3) ----------
function vReady() {
  const sk = scenarioKey(), R = readiness(data, sk, thisMonth());
  const back = { title: 'Remortgage readiness', large: true, back: 'Mortgage', right: `<button class="pill" data-act="edit-remortgage" style="color:var(--accent)">Settings</button>` };
  if (R.none) return { ...back, body: `<p class="note">${R.none === 'balances' ? 'Add your balances first.' : 'Set a “Fixed until” date on your mortgage (or one of its parts) to plan for the remortgage.'}</p>` };
  const pn = esc(partName(R.part, R.partIndex)), away = m => m <= 0 ? 'now' : m === 1 ? 'next month' : `in ${m} months`;
  const mAway = d => ymKeyOf(d) - ymKeyOf(todayISO());
  const L = R.ladder, sc = data.scenarios;
  const invRange = Object.entries(R.invested).map(([k, v]) => `${esc(sc[k].name)} ${short(v)}`).join(' · ');
  const top = R.earmarkItems.slice(0, 2).map(x => esc(x.label));
  const whose = pn === 'Mortgage' ? 'your' : pn + '’s', many = R.earmarkItems.length > 1;
  const verdict = (R.available >= 0
    ? `On current plans you’ll have <b>${short(R.available)}</b> free to overpay when ${whose} fix ends in ${fMonth(R.fixEnd)}.`
    : `On current plans you’d be <b>${short(-R.available)} short</b> of your cash floor and what’s already spoken for when ${whose} fix ends in ${fMonth(R.fixEnd)}, so there is nothing free to overpay.`) +
    (R.earmarks > 0.5 ? ` ${top.join(' and ')}${R.earmarkItems.length > 2 ? ' and others' : ''} ${many ? 'take' : 'takes'} ${short(R.earmarks)} in the ${R.earmarkMonths} months after the switch, which is kept aside for ${many ? 'them' : 'it'}.` : '');
  const tgt = R.target == null ? row({ title: 'Overpayment target', value: 'Not set', act: 'edit-remortgage' })
    : row({ title: 'Overpayment target', value: amt(R.target), act: 'edit-remortgage' }) + (R.met
      ? row({ title: 'On track', sub: `${short(R.available - R.target)} to spare`, value: '<span class="pill ok">Met</span>' })
      : row({ title: `${short(R.shortfall)} short at the fix end`, sub: R.clears ? `Reaches the target in ${fMonth(R.clears)}` : 'Not reached within 10 years on current plans', value: '<span class="pill warn">Short</span>' }));
  const rm = data.rules.remortgage;
  return {
    ...back,
    body: `<div class="hero"><div class="cap">${pn === 'Mortgage' ? 'Fix ends' : pn + ' fix ends'} ${fMonth(R.fixEnd)}</div><div class="big">${R.monthsAway}<span class="p"> months</span></div><div class="eq">Available to overpay ${amt(R.available)}</div></div>
      <p class="note">${verdict}</p>
      ${group(
        row({ title: 'A new deal can usually be secured', value: fMonth(R.dates.secure), vsub: away(mAway(R.dates.secure)) }) +
        row({ title: 'Decide by', value: fMonth(R.dates.decide), vsub: away(mAway(R.dates.decide)) }) +
        row({ title: 'Switch', value: fMonth(R.dates.switch), vsub: away(mAway(R.dates.switch)) }), 'Key dates', `Lenders typically let you secure a deal ${rm.leadMonths} months ahead. Change these under Settings.`)}
      ${group(
        row({ title: 'Instant', sub: 'Current accounts, instant savings, flexible cash ISAs', value: amt(L.instant) }) +
        row({ title: 'Within weeks', sub: 'Notice accounts', value: amt(L.notice) }) +
        row({ title: 'Sellable, at market value', sub: `${invRange} · markets −20%: ${short(R.investedStressed)}`, value: amt(L.invested) }) +
        row({ title: 'Not available', sub: 'Fixed-term accounts maturing later, and pensions', value: amt(L.fixed + L.locked) }) +
        (Math.abs(L.debts) > 0.5 ? row({ title: 'Other debts', sub: '0% cards and tax owed', value: amt(L.debts, { color: true }) }) : ''),
        `Where your money will be<b>end of ${fMonth(R.atDate)}</b>`, 'S&S ISAs can be sold, but what they fetch moves with markets, so they are not counted as available.')}
      ${group(
        row({ title: 'Instant and within weeks', value: amt(R.accessible) }) +
        row({ title: 'Less your cash floor', value: amt(-R.floor, { color: true }) }) +
        row({ title: `Less earmarked, ${R.earmarkMonths} months from the switch`, value: amt(-R.earmarks, { color: true }) }) +
        row({ title: 'Available to overpay', value: amt(R.available, { color: true }), cls: 'total' }), 'Available to overpay')}
      ${R.earmarkItems.length ? group(R.earmarkItems.map(x => row({ title: esc(x.label), sub: `from ${fMonth(x.first)}`, value: amt(-x.amount, { color: true }) })).join(''), 'Earmarked', 'One-off payments, and the costs and pay drops of life events, in the months after the switch.') : ''}
      ${group(data.remortgageOptions.filter(o => o.partId === R.part.id).map(o => row({ title: esc(o.name), sub: optSummary(o), act: 'edit-option', arg: o.id })).join('') +
        row({ title: 'Add a deal to compare', act: 'add-option', cls: 'act-row', chev: false }) +
        row({ title: 'Compare deals', sub: 'Side by side, with overpay-or-keep-cash and rate sensitivity', act: 'push', arg: 'compare' }), 'Deals you’re weighing up')}
      ${group(tgt + row({ title: 'Glide path', sub: rm.glide ? `For ${rm.glideMonths} months before the fix end, new savings are held as cash ISA, not S&S` : 'Off: top-ups follow your usual S&S split', value: rm.glide ? '<span class="pill ok">On</span>' : '<span class="pill">Off</span>', act: 'edit-remortgage' }), 'Getting ready')}
      ${R.laterParts.length ? `<p class="note">After this: ${R.laterParts.map(x => `${esc(partName(x.part, x.index))}’s fix ends ${fMonth(x.fixEnd)}`).join('; ')}. Its readiness appears here once this one has passed.</p>` : ''}
      <p class="note">Worked out in the ${esc(sc[sk].name)} scenario. Figures are projections, not advice.</p>`,
  };
}
const optSummary = o => [o.type === 'tracker' ? `Tracker ${o.rate}%` : `${o.rate}% fixed ${o.fixMonths >= 12 && o.fixMonths % 12 === 0 ? o.fixMonths / 12 + ' years' : o.fixMonths + ' months'}`, +o.fee ? `£${nf0.format(o.fee)} fee${o.feeAdded ? ' added' : ''}` : 'no fee', +o.lump ? `£${nf0.format(o.lump)} lump sum` : '', +o.regular ? `£${nf0.format(o.regular)} a month extra` : ''].filter(Boolean).join(' · ');
function optionSheet(id, preset) {
  const R = readyNow(); if (!R) return toast('Set a fix end date on your mortgage first', true);
  const o = id ? data.remortgageOptions.find(x => x.id === id) : { name: '', type: 'fixed', rate: null, fixMonths: 60, afterRate: R.part.newRate ?? null, fee: 999, feeAdded: false, lump: 0, regular: 0, capPct: 10, termMonths: null, ...(preset || {}) };
  formSheet({
    title: id ? o.name : 'New deal', values: o,
    sections: [
      { head: `For ${partName(R.part, R.partIndex)} from ${fMonth(R.fixEnd)}`, fields: [{ key: 'name', label: 'Name', type: 'text', ph: 'e.g. 5-year fix, Lender A' }, { key: 'type', label: 'Type', type: 'select', options: [['fixed', 'Fixed rate'], ['tracker', 'Tracker']] },
        { key: 'rate', label: 'Rate', type: 'percent', unit: '%' }, { key: 'fixMonths', label: 'Fixed for', type: 'number', unit: 'months', hint: 'Fixed deals only, e.g. 60 for 5 years' },
        { key: 'afterRate', label: 'Rate after the fix', type: 'percent', unit: '%', optional: true, hint: 'Usually the lender’s standard variable rate' }] },
      { head: 'Costs', fields: [{ key: 'fee', label: 'Arrangement fee', type: 'money' }, { key: 'feeAdded', label: 'Add the fee to the loan', type: 'toggle', hint: 'Then it accrues interest; otherwise it is paid from cash' }] },
      { head: 'Overpaying', foot: 'Most lenders let you overpay up to 10% of the balance a year without a charge; extra monthly payments are capped at your allowance.', fields: [{ key: 'lump', label: 'Lump sum at the switch', type: 'money' }, { key: 'regular', label: 'Extra each month', type: 'money' }, { key: 'capPct', label: 'Penalty-free allowance', type: 'percent', unit: '% a year' }] },
      { head: 'Term', fields: [{ key: 'termMonths', label: 'Months left', type: 'number', optional: true, ph: 'Keep end date', hint: 'Fewer months pays it off sooner, with a higher payment' }] }],
    extra: id ? destructive('Delete this deal', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.remortgageOptions = data.remortgageOptions.filter(x => x.id !== id); for (const k in data.scenarios) if (data.scenarios[k].option === id) data.scenarios[k].option = null; return changed('Deal deleted'); }
      if (!(v.rate > 0)) { toast('Enter the rate', true); return false; }
      if (id) Object.assign(o, v); else data.remortgageOptions.push({ id: uid('opt'), partId: R.part.id, ...v, name: v.name || `Deal ${data.remortgageOptions.length + 1}` });
      changed('Deal saved');
    },
  });
}
function vCompare() {
  const W = ui.cmpWin || 60, sk = scenarioKey(), C = compareOptions(data, sk, W, thisMonth());
  const head = { title: 'Compare deals', large: true, back: 'Readiness' };
  if (C.none) return { ...head, body: '<p class="note">Set a fix end date on your mortgage first.</p>' };
  const res = C.results, n = res.length;
  const best = (f, low = true) => { const v = res.map(f); const b = low ? Math.min(...v) : Math.max(...v); return v.map(x => Math.abs(x - b) < 0.5); };
  const line = (label, f, o = {}) => { const hi = o.best ? best(f, o.low !== false) : []; return `<tr><th>${label}</th>${res.map((r, i) => `<td class="${hi[i] && n > 1 ? 'best' : ''}">${o.fmt ? o.fmt(r) : money(f(r))}</td>`).join('')}</tr>`; };
  const tbl = `<div class="cmpwrap"><table class="cmp"><thead><tr><th></th>${res.map(r => `<th>${esc(r.option.name)}</th>`).join('')}</tr></thead><tbody>
    ${line('Monthly payment', r => r.payment, { best: true })}
    ${line('Total interest', r => r.interest, { best: true })}
    ${line('Fees', r => r.fee)}
    ${line('Total cost', r => r.totalCost, { best: true })}
    ${line('Mortgage left', r => r.balance, { best: true })}
    ${line('Accessible cash', r => r.accessible, { best: true, low: false })}
    ${line('Net worth', r => r.net, { best: true, low: false })}
    ${line('Lowest cash', r => r.lowestCash, { best: true, low: false, fmt: r => `${money(r.lowestCash)}<div class="sub">${fMonth(r.lowestMonth, true)}</div>` })}
  </tbody></table></div>`;
  const cisa = C.cashRateWin != null ? C.cashRateWin : C.cashIsaRate;
  const opts = res.filter(r => r.option.id);
  const keep = opts.map(r => {
    const rate = +r.option.rate, save = 10 * rate, earn = 10 * cisa, d = save - earn;
    return row({ title: esc(r.option.name), sub: `Overpaying £1,000 saves about £${Math.round(save)} a year in interest at ${rate}%; kept in a cash ISA at ${cisa.toFixed(1)}% (its average over these ${W / 12} years on this plan’s rates) it earns about £${Math.round(earn)}.`, value: Math.abs(d) < 1 ? 'About even' : d > 0 ? 'Overpay' : 'Keep cash', vsub: Math.abs(d) < 1 ? '' : `by £${Math.round(Math.abs(d))} a year` });
  }).join('');
  const grids = opts.map(r => { const g = rateGrid(r.option, C.balAtSwitch, 60, C.termLeft); return `<div class="gh">${esc(r.option.name)}</div><div class="cmpwrap"><table class="cmp"><thead><tr><th>Rate</th>${g.map(x => `<th>${(+r.option.rate + x.shift).toFixed(2)}%</th>`).join('')}</tr></thead><tbody>
      <tr><th>Payment</th>${g.map(x => `<td class="${x.shift === 0 ? 'best' : ''}">${money(x.payment)}</td>`).join('')}</tr>
      <tr><th>5-year cost</th>${g.map(x => `<td class="${x.shift === 0 ? 'best' : ''}">${short(x.cost)}</td>`).join('')}</tr></tbody></table></div>`; }).join('');
  return {
    ...head,
    body: `<div class="subtitle">${esc(partName(C.part, C.partIndex))} · switch ${fMonth(C.switchDate)} · ${short(C.balAtSwitch)} owed then</div>
      <div class="chips">${[[24, '2 years'], [36, '3 years'], [60, '5 years']].map(([m, l]) => `<button class="${m === W ? 'on' : ''}" data-act="cmp-win" data-arg="${m}">${l}</button>`).join('')}</div>
      <section class="card"><div class="gh">Over ${W / 12} years from the switch<b>to ${fMonth(C.endDate)}</b></div>${tbl}</section>
      ${opts.length ? '' : '<p class="note">Add the deals you are considering on the readiness page to compare them with doing nothing.</p>'}
      ${C.market.length ? group(C.market.map(q => row({ title: `${q.months / 12}-year fix`, sub: `Market ${pctf(q.fwdAER)} ${signedPct(q.margin)} margin${q.marginSource === 'typical' ? ' (typical)' : ''} · tap to add as a deal`, value: pctf(q.rate), act: 'add-option-market', arg: q.months })).join(''), `Market-implied at ${fMonth(C.switchDate)}`, `What a new fix is likely to cost when you switch, from the ${esc(C.market[0].label.toLowerCase())} curve${C.market[0].asOf ? ` as at ${fDate(C.market[0].asOf)}` : ''}. Not an offer: a real one beats it.`) : ''}
      ${keep ? group(keep, 'Overpay or keep the cash?', 'Mortgage interest saved and cash ISA interest are both tax-free, so the rates compare directly. Money used to overpay can’t be taken back out, so keeping it has value of its own.') : ''}
      ${grids ? `<section class="card">${grids}<p class="note" style="margin:10px 0 0">Payment when the deal starts, and interest plus fees over five years, at the rate and ±0.5% and ±1%.</p></section>` : ''}
      <p class="note">Worked out in the ${esc(data.scenarios[sk].name)} scenario, through the whole household projection. Highlighted figures are the best in each row. Projections, not advice.</p>`,
  };
}

// ---------- compare plans (1.6) ----------
const SC_COLORS = ['var(--c-net)', 'var(--c-isa)', 'var(--c-cash)'];
function vPlans() {
  const keys = (ui.cmpSc || Object.keys(data.scenarios)).filter(k => data.scenarios[k]).slice(0, 3);
  const H = Math.max(horizon(), 60), floor = +data.rules.cashFloor || 0, em = +data.rules.remortgage.earmarkMonths || 12;
  const runs = keys.map(k => { const pr = project(data, k, H + em); return { k, sc: data.scenarios[k], rows: pr.rows.slice(0, H), av: availableSeries(pr.rows, floor, em).slice(0, H) }; });
  if (!runs.length || !runs[0].rows.length) return { title: 'Compare plans', large: true, back: 'Projection', body: '<p class="note">Add your balances first.</p>' };
  const T = r => monthEndT(r.date);
  const ser = f => runs.map((u, i) => ({ name: u.sc.name, color: SC_COLORS[i], pts: u.rows.map((r, j) => ({ t: T(r), v: f(r, j, u) })) }));
  const c1 = chart('c-pl-net', { series: ser(r => r.net), height: 150 });
  const c2 = chart('c-pl-cash', { series: ser(r => r.closing), height: 120, floor });
  const c3 = chart('c-pl-av', { series: ser((r, j, u) => u.av[j]), height: 120 });
  const R = readyNow(), F = R ? ymKeyOf(R.fixEnd) : null, k0 = runs[0].rows[0].k;
  const dates = [...(F != null ? [['At the fix end', F - 1]] : []), ['In 1 year', k0 + 11], ['In 3 years', k0 + 35]].filter(([, k]) => k - k0 < H);
  const cell = (u, k, f) => { const j = u.rows.findIndex(r => r.k === k); return j < 0 ? null : f(u.rows[j], j, u); };
  const metrics = [['Net worth', r => r.net], ['Cash', r => r.closing], ['Available to overpay', (r, j, u) => u.av[j]], ['Mortgage left', r => r.mortgageBal ?? 0]];
  const table = dates.map(([label, k]) => `<tr class="sec"><th colspan="${runs.length + 1}">${label} · ${fMonth(runs[0].rows.find(r => r.k === k)?.date || runs[0].rows[0].date)}</th></tr>` + metrics.map(([m, f]) => {
    const vals = runs.map(u => cell(u, k, f));
    return `<tr><th>${m}</th>${vals.map((v, i) => `<td>${v == null ? '–' : money(v)}${i && v != null && vals[0] != null ? `<div class="sub">${money(v - vals[0], { sign: true })}</div>` : ''}</td>`).join('')}</tr>`;
  }).join('')).join('');
  return {
    title: 'Compare plans', large: true, back: 'Projection',
    body: `<div class="chips">${Object.entries(data.scenarios).map(([k, v]) => `<button class="${keys.includes(k) ? 'on' : ''}" data-act="cmp-sc" data-arg="${k}">${esc(v.name)}</button>`).join('')}</div>
      <section class="card"><div class="gh">Net worth</div>${c1}<div class="legend">${runs.map((u, i) => `<span><i style="background:${SC_COLORS[i]}"></i>${esc(u.sc.name)}</span>`).join('')}</div></section>
      <section class="card"><div class="gh">Cash held<b>floor ${amt(floor)}</b></div>${c2}</section>
      <section class="card"><div class="gh">Available to overpay<b>if you switched that month</b></div>${c3}</section>
      <section class="card"><div class="gh">Key dates<b>differences against ${esc(runs[0].sc.name)}</b></div><div class="cmpwrap"><table class="cmp"><thead><tr><th></th>${runs.map(u => `<th>${esc(u.sc.name)}</th>`).join('')}</tr></thead><tbody>${table}</tbody></table></div></section>
      ${group(runs.map(u => row({ title: esc(u.sc.name), sub: [u.sc.growth ? `S&S ${u.sc.ssReturn}% · inflation ${u.sc.inflation}%` : 'No growth', `deal: ${esc(optName(u.sc.option))}`, data.bundles.length ? `events: ${data.bundles.filter(b => TM.bundleOn(b, u.sc)).map(b => esc(b.name)).join(', ') || 'none'}` : ''].filter(Boolean).join(' · '), act: 'push', arg: 'scenario:' + u.k })).join(''), 'What each plan assumes', 'Tap a plan to change its assumptions, life events or remortgage deal. Pick up to three above.')}`,
    after: () => { mountChart('c-pl-net'); mountChart('c-pl-cash'); mountChart('c-pl-av'); },
  };
}

function remortgageSheet() {
  const rm = data.rules.remortgage;
  formSheet({
    title: 'Remortgage settings', values: { ...rm },
    sections: [
      { head: 'Dates', fields: [{ key: 'leadMonths', label: 'Deal can be secured', type: 'number', unit: 'months before', hint: 'Often 3 to 6' }, { key: 'decideMonths', label: 'Decide', type: 'number', unit: 'months before' }] },
      { head: 'What counts as spoken for', foot: 'Payments and life-event costs in this many months from the switch are taken off what’s available to overpay.', fields: [{ key: 'earmarkMonths', label: 'Earmark', type: 'number', unit: 'months' }] },
      { head: 'Getting ready', foot: 'A target makes the projection hold back from S&S ISAs, keeping new savings as cash ISA until you would have that much free at the fix end. The glide path does the same for a fixed number of months regardless.', fields: [
        { key: 'target', label: 'Overpayment target', type: 'money', optional: true, ph: 'None' },
        { key: 'glide', label: 'Glide path', type: 'toggle' }, { key: 'glideMonths', label: 'For', type: 'number', unit: 'months before' }] },
      { head: 'Warnings', fields: [{ key: 'warnAt', label: 'Warn when a change cuts it by more than', type: 'money' }] }],
    onSave: v => {
      Object.assign(rm, { leadMonths: Math.max(0, Math.round(v.leadMonths)), decideMonths: Math.max(0, Math.round(v.decideMonths)), earmarkMonths: Math.max(1, Math.round(v.earmarkMonths) || 12),
        target: v.target > 0 ? v.target : null, glide: v.glide, glideMonths: Math.max(1, Math.round(v.glideMonths) || 12), warnAt: Math.max(0, v.warnAt) });
      changed('Settings saved');
    },
  });
}

// ---------- life events ----------
// How much an event adds (+) or takes away (−) over the projection horizon, in the default scenario.
function bundleImpact(id) {
  const pr = project(data, scenarioKey(), horizon());
  return pr ? pr.rows.reduce((s, r) => s + (r.bundleNet[id] || 0), 0) : 0;
}
function bundleWhen(b) { const sp = TM.bundleSpan(data, b.id); if (!sp || !sp.from) return 'No lines yet'; return sp.to ? `${fMonth(sp.from, true)} – ${fMonth(sp.to, true)}` : `from ${fMonth(sp.from)}`; }
function bundleRow(b) {
  return row({ title: esc(b.name), sub: bundleWhen(b), value: b.on ? amt(bundleImpact(b.id), { sign: true, color: true }) : '<span class="pill">Off</span>', act: 'push', arg: 'bundle:' + b.id, right: sw(b.on, 'b-on', b.id), chev: false });
}
function vBundle(id) {
  const b = bundleById(id); if (!b) { ui.stacks[ui.tab].pop(); return currentView(); }
  const lines = bundleLines(id), H = horizon();
  const impact = bundleImpact(id);
  const kinds = [['income', 'Income changes', 'edit-income'], ['spend', 'Monthly costs', 'edit-spend'], ['oneoff', 'One-off items', 'edit-event']];
  const lineRow = (f, act) => row({ title: esc(f.name), sub: [flowWhen(f), f.note ? esc(f.note) : ''].filter(Boolean).join(' · '), value: amt(f.kind === 'spend' ? -f.amount : f.amount, { sign: true, color: true }), vsub: f.kind === 'oneoff' ? '' : 'a month', act, arg: f.id });
  return {
    title: b.name, large: true, back: 'Plan', right: `<button class="pill" data-act="edit-bundle" data-arg="${esc(id)}" style="color:var(--accent)">Edit</button>`,
    body: `<div class="hero"><div class="cap">${b.on ? `Effect over ${H >= 24 ? H / 12 + ' years' : H + ' months'}` : 'Switched off'}</div><div class="big amt ${impact < 0 ? 'neg' : ''}">${money(b.on ? impact : 0, { sign: true }).replace('£', '<span class="p">£</span>')}</div><div class="eq">${esc(bundleWhen(b))}</div></div>
      ${group(
        row({ title: 'Included in the projection', right: sw(b.on, 'b-on', id), chev: false }) +
        row({ title: 'Starts', value: b.start ? fMonth(b.start) : 'Not set', vsub: 'moving it moves every line', act: 'edit-bundle', arg: id }) +
        row({ title: 'Scale', value: `${Math.round((+b.scale || 0) * 100)}%`, vsub: 'every amount', act: 'edit-bundle', arg: id }) +
        row({ title: 'Contingency', value: `${+b.contingency || 0}%`, vsub: 'added to costs', act: 'edit-bundle', arg: id }), 'Settings')}
      ${kinds.map(([k, h, act]) => { const l = lines.filter(f => f.kind === k); return l.length ? group(l.map(f => lineRow(f, act)).join(''), h, k === 'income' ? 'A minus figure is a drop from usual pay during the period.' : '') : ''; }).join('')}
      ${group(row({ title: 'Add an income change', act: 'add-income', arg: 'b:' + id, cls: 'act-row', chev: false }) + row({ title: 'Add a monthly cost', act: 'add-spend', arg: 'b:' + id, cls: 'act-row', chev: false }) + row({ title: 'Add a one-off item', act: 'add-event', arg: 'b:' + id, cls: 'act-row', chev: false }))}
      <p class="note">Every amount came from a template as a placeholder: check each one against your own situation. None of it is advice.</p>`,
  };
}
function bundleSheet(id) {
  const b = bundleById(id);
  formSheet({
    title: b.name, values: { name: b.name, start: b.start, scale: Math.round((+b.scale || 0) * 100), contingency: +b.contingency || 0 },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'start', label: 'Starts', type: 'month', hint: 'Every line moves with it' }] },
    { foot: 'Scale changes every amount in the event, e.g. 120% if costs turn out a fifth higher. Contingency is added to its costs only.', fields: [{ key: 'scale', label: 'Scale', type: 'percent', unit: '%' }, { key: 'contingency', label: 'Contingency', type: 'percent', unit: '%' }] }],
    extra: destructive('Delete this event', 'delete'),
    onSave: (v, act) => {
      if (act === 'delete') {
        if (!confirm(`Delete ${b.name} and all ${bundleLines(id).length} of its lines?`)) return;
        data.flows = data.flows.filter(f => f.bundle !== id); data.bundles = data.bundles.filter(x => x.id !== id);
        if (ui.stacks[ui.tab].at(-1) === 'bundle:' + id) ui.stacks[ui.tab].pop();
        return changed('Event deleted');
      }
      if (v.start && b.start && v.start !== b.start) TM.shiftBundle(data, id, TM.monthKey(v.start) - TM.monthKey(b.start));
      else if (v.start && !b.start) b.start = v.start;
      b.name = v.name || b.name; b.scale = Math.max(0, (+v.scale || 0) / 100); b.contingency = +v.contingency || 0;
      changed('Event saved');
    },
  });
}
// Add from a template: pick one → answer its questions → review every line → save.
function templatePicker() {
  sheet({ title: 'Add a life event', done: null, body: `<section class="group"><div class="list">${TallyTemplates.list().map(t => `<button class="row act-row" data-sact="${t.key}"><div class="main"><div class="ttl">${esc(t.name)}</div><div class="sub">${esc(t.blurb)}</div></div>${CHEV}</button>`).join('')}</div></section>
    <p class="note">Every amount is a placeholder for you to change, and you review each line before anything is saved.</p>`,
    onDone: (form, close, key) => { close(); setTimeout(() => templateAsk(key), 360); } });
}
function templateAsk(key) {
  const t = TallyTemplates.T[key], start = TM.shiftMonth(thisMonth(), 6), ctx = TallyTemplates.makeContext(data, start);
  const secs = t.fields(ctx);
  formSheet({
    title: t.name, values: { name: t.name, start, ...t.defaults(ctx) },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'start', label: t.startLabel, type: 'month' }] }, ...secs],
    onSave: v => {
      if (!v.start) { toast('Choose a month', true); return false; }
      const built = TallyTemplates.applyTemplate(key, v, v.start, data, uid);
      built.bundle.name = v.name || t.name;
      setTimeout(() => templateReview(built), 360);
    },
  });
}
function templateReview({ bundle, flows }) {
  if (!flows.length) { data.bundles.push(bundle); changed('Event added'); return actions.push('bundle:' + bundle.id); }
  const vals = {}; flows.forEach((f, i) => { vals['a' + i] = f.kind === 'spend' ? f.amount : f.amount; vals['on' + i] = true; });
  const kindWord = { income: 'income change a month', spend: 'cost a month', oneoff: 'one-off' };
  formSheet({
    title: 'Check each line', values: vals,
    sections: [{ head: bundle.name, foot: 'Change any amount, or switch a line off to leave it out. Income changes can be negative: a drop from usual pay. Nothing is saved until you tap Save.', fields: flows.flatMap((f, i) => [
      { key: 'on' + i, label: f.name, type: 'toggle', hint: `${flowWhen(f)} · ${kindWord[f.kind]}${f.note ? ' · ' + f.note : ''}` },
      { key: 'a' + i, label: f.kind === 'spend' ? 'Cost a month' : f.kind === 'income' ? 'Change a month' : 'Amount (minus = out)', type: 'money' }]) }],
    onSave: v => {
      const keep = flows.filter((f, i) => { f.amount = v['a' + i]; return v['on' + i]; });
      data.bundles.push(bundle); data.flows.push(...keep);
      changed(`${bundle.name} added`); actions.push('bundle:' + bundle.id);
    },
  });
}

// The mortgage can have parts (sub-accounts), each with its own rate, fix and term.
// With one part the screen shows its details directly, as before; with more it lists them.
function partDetails(p, i) {
  const fix = p.fixEnd ? Math.max(0, ymKeyOf(p.fixEnd) - ymKeyOf(todayISO())) : null;
  const e = { act: 'edit-part', arg: p.id };
  return row({ title: 'Monthly payment', value: amt(+p.payment || 0), ...e }) +
    row({ title: 'Balance owed', value: p.balance != null ? amt(p.balance) : 'Not set', ...e }) +
    row({ title: 'Current rate', value: p.rate != null ? `${p.rate}%` : 'Not set', ...e }) +
    row({ title: 'Fixed until', value: p.fixEnd ? fMonth(p.fixEnd) : 'Not set', vsub: fix != null ? `${fix} months away` : '', ...e }) +
    row({ title: 'Rate after the fix', value: p.newRate != null ? `${p.newRate}%` : 'Not set', ...e }) +
    row({ title: 'Ends', value: p.termEnd ? fMonth(p.termEnd) : 'Not set', ...e });
}
// What the projection says about one part: its balance at the end, and its payment once the fix ends.
function partOutlook(pr, p) {
  const end = pr.rows.at(-1).mortgageParts.find(x => x.id === p.id);
  const full = p.balance != null && p.rate != null;
  const after = full && p.fixEnd && p.newRate != null && p.termEnd ? pr.rows.find(r => r.date >= p.fixEnd)?.mortgageParts.find(x => x.id === p.id)?.pay : null;
  return { full, endBal: end ? end.bal : null, after };
}
function vMortgage() {
  const m = data.mortgage, mt = mortgageTotals(data), parts = m.parts, one = parts.length === 1;
  const pr = project(data, scenarioKey(), horizon()), end = pr.rows.at(-1);
  const eq = m.propertyValue && mt.balance != null ? m.propertyValue - mt.balance : null;
  const home = row({ title: 'Home value', value: m.propertyValue ? amt(m.propertyValue) : 'Not set', act: 'edit-home' });
  const addPart = row({ title: 'Add a part', act: 'add-part', cls: 'act-row', chev: false });
  let body, outlook = '';
  const Rn = readyNow();
  const readyGroup = Rn ? group(row({ title: 'Remortgage readiness', sub: `${esc(partName(Rn.part, Rn.partIndex))} · fix ends ${fMonth(Rn.fixEnd)}`, value: amt(Rn.available), vsub: 'free to overpay', act: 'push', arg: 'ready' })) : '';
  if (one) {
    const o = partOutlook(pr, parts[0]);
    body = group(partDetails(parts[0], 0) + home, 'Details') +
      group(addPart, null, 'If your mortgage is split into parts with their own rate or end date, for example after borrowing more, add each one so they run down separately.');
    if (o.full) outlook = row({ title: `Balance by ${fMonth(end.date)}`, value: amt(end.mortgageBal) }) +
      (o.after ? row({ title: 'Payment after the fix', value: amt(o.after), vsub: chg(o.after - (+parts[0].payment || 0)) + ' a month' }) : '');
  } else {
    body = group(parts.map((p, i) => row({
      title: esc(partName(p, i)), value: amt(+p.payment || 0),
      sub: [p.balance != null ? `${short(p.balance)} owed` : 'Flat payment', p.rate != null ? `${p.rate}%` : '', p.fixEnd ? `fixed to ${fMonth(p.fixEnd, true)}` : ''].filter(Boolean).join(' · '),
      act: 'push', arg: 'mpart:' + p.id,
    })).join('') + addPart, 'Parts') +
      group(row({ title: 'Total owed', value: mt.balance != null ? amt(mt.balance) : 'Not set', vsub: mt.balance != null && !mt.allBalances ? 'some parts have no balance' : '' }) + home, 'Totals');
    if (end.mortgageBal != null) outlook = row({ title: `Balance by ${fMonth(end.date)}`, value: amt(end.mortgageBal) }) +
      parts.map((p, i) => { const o = partOutlook(pr, p); return o.after ? row({ title: `${esc(partName(p, i))} after its fix`, sub: fMonth(p.fixEnd), value: amt(o.after), vsub: chg(o.after - (+p.payment || 0)) + ' a month' }) : ''; }).join('');
  }
  const anyFull = parts.some(p => p.balance != null && p.rate != null);
  return {
    title: 'Mortgage', large: true, back: 'Plan', right: one ? `<button class="pill" data-act="edit-part" data-arg="${esc(parts[0].id)}" style="color:var(--accent)">Edit</button>` : '',
    body: `<div class="hero"><div class="cap">Monthly payment${one ? '' : `, ${parts.length} parts`}</div><div class="big amt">${money(mt.payment, { dp: 0 }).replace('£', '<span class="p">£</span>')}</div>${eq != null ? `<div class="eq">Home equity ${amt(eq)}</div>` : ''}</div>
      ${readyGroup}${body}${outlook ? group(outlook, 'Projection') : ''}${one && parts[0].rate != null && parts[0].rate !== '' ? rateModelGroup('part:' + parts[0].id) : ''}
      <p class="note">${anyFull ? `The projection runs ${one ? 'the balance' : 'each part'} down month by month. If you set a rate after the fix and an end date, the payment is recalculated when the fix ends and flows into your monthly surplus.${one ? '' : ' A part that is paid off stops costing anything.'}` : `Add the balance and rate to see the balance fall over time, and a post-fix rate to model a remortgage. Until then, the payment${one ? '' : 's'} above ${one ? 'is' : 'are'} used as a flat monthly cost.`}</p>`,
  };
}
function vMortgagePart(id) {
  const parts = data.mortgage.parts, i = parts.findIndex(p => p.id === id), p = parts[i];
  if (!p) { ui.stacks[ui.tab].pop(); return currentView(); }
  const pr = project(data, scenarioKey(), horizon()), o = partOutlook(pr, p), end = pr.rows.at(-1);
  return {
    title: partName(p, i), large: true, back: 'Mortgage', right: `<button class="pill" data-act="edit-part" data-arg="${esc(p.id)}" style="color:var(--accent)">Edit</button>`,
    body: `<div class="hero"><div class="cap">Monthly payment</div><div class="big amt">${money(+p.payment || 0, { dp: 0 }).replace('£', '<span class="p">£</span>')}</div></div>
      ${group(partDetails(p, i), 'Details')}
      ${p.rate != null && p.rate !== '' ? rateModelGroup('part:' + p.id) : ''}
      ${o.full ? group(row({ title: `Balance by ${fMonth(end.date)}`, value: amt(o.endBal) }) + (o.after ? row({ title: 'Payment after the fix', value: amt(o.after), vsub: chg(o.after - (+p.payment || 0)) + ' a month' }) : ''), 'Projection') : ''}`,
  };
}

// ---------- market rates (yield curves: curves.js, docs/YIELD_CURVES.md) ----------
// The curve is prepared each weekday by .github/workflows/rates.yml and served from this site (rates/). The file in
// use is kept inside the finance file (data.rateBasis), so figures only move when you choose a newer curve.
const TC = TallyCurves;
const market = { latest: null, state: 'loading', dates: null };
const CURVE_COPY = 'tally.curve';
async function loadCurve() {
  let c = null;
  try { const r = await fetch('rates/curve-latest.json', { cache: 'no-cache' }); if (r.ok) c = await r.json(); } catch (e) { }
  if (!(c && TC.validate(c).ok)) { try { c = JSON.parse(localStorage.getItem(CURVE_COPY) || 'null'); } catch (e) { c = null; } }
  if (c && TC.validate(c).ok) { market.latest = c; market.state = 'ok'; try { localStorage.setItem(CURVE_COPY, JSON.stringify(c)); } catch (e) { } }
  else market.state = 'none';
  if (data) render();
}
const newerCurve = () => (market.latest && (!data.rateBasis || market.latest.asOf > data.rateBasis.asOf) ? market.latest : null);
const slim = c => ({ asOf: c.asOf, shortEnd: { stepMonths: c.shortEnd.stepMonths, forward: c.shortEnd.forward }, long: { tenorsYears: c.long.tenorsYears, forward: c.long.forward } });
function useCurve(c) {
  const old = data.rateBasis;
  data.rateBasis = { source: c.source, asOf: c.asOf, curve: c, previous: old && old.curve ? { asOf: old.asOf, curve: slim(old.curve) } : (old && old.previous) || null };
  changed(`Using the curve as at ${fDate(c.asOf)}`);
}
const pctf = v => (v == null || isNaN(v) ? '–' : `${(Math.round(v * 100) / 100).toFixed(2)}%`);
const signedPct = v => `${v >= 0 ? '+' : '−'}${pctf(Math.abs(v))}`;
const layerOf = sk => TC.forScenario(data, data.scenarios[sk]);
// "Market-implied · curve as at 25 Sep 2026", or why rates are being held flat
function layerText(L) {
  if (L.active) return `${esc(L.label)}${L.asOf ? ` · curve as at ${fDate(L.asOf)}` : ''}`;
  if (L.reason === 'no-curve') return L.wanted === 'history' ? 'Held flat: that earlier curve could not be read' : 'Held flat: no market curve yet';
  return 'Flat: each account at its own entered rate';
}
function stalePill(asOf) {
  const st = TC.staleness(asOf, todayISO());
  return st.level === 'red' ? '<span class="pill bad">Out of date</span>' : st.level === 'amber' ? '<span class="pill warn">May be out of date</span>' : '<span class="pill ok">Current</span>';
}
// Every account and mortgage part that earns or charges interest, with its rate rule
function rateItems() {
  const out = [];
  for (const a of data.accounts) if ((a.type === 'savings' || a.type === 'cash_isa') && a.active !== false)
    out.push({ key: 'acct:' + a.id, name: accLabel(a), model: a.rateModel || null, ctx: { rate: TM.rateOn(a, todayISO()), fixEnd: a.access === 'fixed' ? a.maturity : null }, item: a, part: false });
  data.mortgage.parts.forEach((p, i) => { if (p.rate != null && p.rate !== '') out.push({ key: 'part:' + p.id, name: partName(p, i), model: p.rateModel || null, ctx: { rate: +p.rate, fixEnd: p.fixEnd || null }, item: p, part: true }); });
  return out;
}
const rateItem = key => rateItems().find(x => x.key === key);
const starterModel = x => TC.defaultModel({ category: x.part ? 'mortgage' : 'savings', fixEnd: x.ctx.fixEnd, access: x.item.access });

function vMarket() {
  const sk = scenarioKey(), sc = data.scenarios[sk], L = layerOf(sk), basis = data.rateBasis, nw = newerCurve();
  const mk = basis && TC.compile(basis.curve), prev = basis && basis.previous && TC.compile(basis.previous.curve);
  const from = (L.active && L.asOf) || (basis && basis.asOf) || todayISO(), T0 = Date.parse(from), YR = 365.25 * 864e5;
  const grid = fn => Array.from({ length: 121 }, (_, i) => ({ t: T0 + i / 12 * YR, v: fn(i / 12) }));
  const series = [];
  if (mk) series.push({ name: 'Market', color: 'var(--c-net)', pts: grid(t => mk.fwd(t)), fill: true });
  if (L.active && (L.kind !== 'market' || !mk)) series.push({ name: esc(L.label), color: 'var(--c-isa)', pts: grid(t => L.fwd(t)) });
  if (prev) series.push({ name: `As at ${fDate(basis.previous.asOf)}`, color: 'var(--c-cash)', dash: true, pts: grid(t => prev.fwd(t + (T0 - Date.parse(basis.previous.asOf)) / YR)) });
  const br = mk ? mk.anchors.bankRate : L.active ? L.anchors.bankRate : null;
  if (br != null && series.length) series.push({ name: 'Bank Rate today', color: 'var(--orange)', w: 1.4, dash: true, pts: [{ t: T0, v: +br }, { t: T0 + 10 * YR, v: +br }] });
  if (series.length) series[0].whenLabel = 'In 10 years';
  const ch = series.length ? chart('c-rates', { series, height: 160, fmt: v => `${v.toFixed(1)}%`, vfmt: pctf }) : '';
  const items = rateItems(), unset = items.filter(x => !x.model);
  const curveRows = (basis ? row({ title: 'Curve in use', sub: esc(basis.source || 'Bank of England OIS curve'), value: fDate(basis.asOf), vsub: stalePill(basis.asOf) }) : '') +
    (nw ? row({ title: basis ? `Use the newer curve, as at ${fDate(nw.asOf)}` : `Use the Bank of England curve as at ${fDate(nw.asOf)}`, sub: basis ? 'Your projection moves to today’s market expectations; the old one is kept to compare' : 'Accounts on market rates follow it from then on', act: 'curve-use', cls: 'act-row', chev: false }) : '') +
    (!basis && !nw ? row({ title: 'No market curve yet', sub: market.state === 'loading' ? 'Looking for one…' : 'It is published here each weekday once the site’s rates job has run. Until then, a manual path works.' }) : '');
  const st = basis ? TC.staleness(basis.asOf, todayISO()) : null;
  const margins = L.active ? [['mortgage', 24, 'Mortgage, 2-year fix'], ['mortgage', 60, 'Mortgage, 5-year fix'], ['savings', 12, 'Savings bond, 1 year'], ['savings', 24, 'Savings bond, 2 years']].map(([cat, m, label]) => {
    const g = TC.marginFor(L, cat, m);
    return row({ title: label, sub: g.source === 'quoted' ? `${g.months !== m ? `From the ${g.months / 12}-year quote: ` : ''}quoted ${pctf(g.quoted)}${g.quotedMonth ? ` (${fMonth(g.quotedMonth)})` : ''} less market ${pctf(g.spot)}` : 'A typical figure: no quoted rate published here yet', value: signedPct(g.margin) });
  }).join('') : '';
  const sug = mk && mk.suggested;
  return {
    title: 'Interest rates', large: true, back: 'Back',
    body: `${seg(Object.entries(data.scenarios).map(([k, v]) => [k, esc(v.name)]), sk, 'scenario')}
      ${series.length ? `<section class="card"><div class="gh">Expected Bank Rate<b>next 10 years</b></div>${ch}<div class="legend">${series.map(x => `<span><i style="background:${x.color}"></i>${x.name}</span>`).join('')}</div></section>` : ''}
      ${st && st.level === 'red' ? `<p class="note">This curve is more than a month old. Use a newer one when it appears, or a manual path meanwhile.</p>` : ''}
      ${curveRows ? group(curveRows, 'Market curve') : ''}
      ${group(row({ title: `Rates in ${esc(sc.name)}`, sub: layerText(L), value: esc(TC.KINDS[(sc.rates || {}).kind || 'market']), act: 'edit-rates', arg: sk }), 'This plan', 'Each scenario can take the market’s path as it is, move it, or use one of your own. Compare them from Projection › Compare plans.')}
      ${items.length ? group(items.map(x => row({ title: esc(x.name), sub: esc(TC.describe(x.model, x.ctx)), value: x.model ? '<span class="pill ok">Market</span>' : '<span class="pill">As entered</span>', act: 'edit-ratemodel', arg: x.key })).join('') +
        (unset.length ? row({ title: 'Put them all on market rates', sub: 'Sensible starting settings for each; change any of them after', act: 'rates-all', cls: 'act-row', chev: false }) : ''),
        'Accounts and mortgage', 'An account on market rates follows the curve from the rate you entered today; one “as entered” keeps its own rates, exactly as before. Tap one to choose.') : ''}
      ${margins ? group(margins, 'Margins for new fixes', 'When a fix ends and rolls into a new one, it is priced at the market rate for that period then, plus this margin - unless you set your own on the account.') : ''}
      ${sug ? group(row({ title: `Banks passed on about ${Math.round(sug.passThrough * 100)}% of Bank Rate moves`, sub: `${sug.lagMonths} month${sug.lagMonths === 1 ? '' : 's'} later on average, over ${sug.months} months of the Bank’s instant-access savings figures (fit ${sug.r2}). A suggestion only: each account keeps its own setting.` }), 'From history') : ''}
      <p class="note">Market-implied rates are not a forecast. They include a premium for lending for longer, and they move every day. Savings rates usually pass on only part of each Bank Rate move, and later; margins and pass-through are assumptions worth revisiting. Tax on interest outside ISAs is not included.</p>
      <p class="note">Source: Bank of England yield curves and statistical database.</p>`,
    after: () => series.length && mountChart('c-rates'),
  };
}

// On an account's or a mortgage part's own page (6.2): its rule in words, and its path with each repricing marked
function rateModelGroup(key) {
  const x = rateItem(key); if (!x) return '';
  const sk = scenarioKey(), L = layerOf(sk);
  let ch = '';
  if (x.model && L.active && latestSnapshot(data)) {
    const pr = project(data, sk, 120), P = (x.part ? pr.partPaths : pr.paths)[x.item.id];
    if (P) {
      const pts = pr.rows.map((r, i) => ({ t: monthEndT(r.date), v: P.rates[i] }));
      const markers = P.reprices.map(rp => ({ t: monthEndT(pr.rows[rp.i].date), v: 1 }));
      ch = `<div style="padding:8px 16px 0">${chart('c-ratepath', { series: [{ name: 'Rate', color: 'var(--c-isa)', pts, whenLabel: 'In 10 years' }], height: 110, fmt: v => `${v.toFixed(1)}%`, vfmt: pctf, markers })}</div>`;
    }
  }
  const rows = row({ title: esc(TC.describe(x.model, x.ctx)), sub: x.model ? layerText(L) : 'Tap to have it follow the market curve instead', act: 'edit-ratemodel', arg: key }) +
    (x.model ? '' : row({ title: 'Use market rates', sub: esc(TC.describe(starterModel(x), x.ctx)), act: 'rate-market', arg: key, cls: 'act-row', chev: false }));
  return `<section class="group"><div class="gh">In the projection</div><div class="list">${rows}</div>${ch}<div class="gf">${x.model ? 'Green marks are the months it reprices. Market-implied, not a forecast.' : 'At the moment the projection carries its entered rate forward.'} <a href="#" data-act="push" data-arg="rates">Interest rates</a></div></section>`;
}
function rateModelSheet(key) {
  const x = rateItem(key); if (!x) return;
  const fixEnd = x.ctx.fixEnd, m = x.model || starterModel(x), R = m.rollover || { kind: 'variable', termMonths: x.part ? 24 : 12 };
  const vals = { kind: x.model ? m.kind : '', passThrough: Math.round((+m.passThrough || 0) * 100), lagMonths: +m.lagMonths || 0, floor: m.floor, spread: m.spread, rkind: R.kind || 'variable', termMonths: R.termMonths, margin: R.margin, manualRate: R.manualRate };
  const kinds = [['', 'As entered, carried forward'], ['variable', 'Variable: follows Bank Rate'], ['tracker', 'Tracker: Bank Rate plus a margin'], ...(fixEnd ? [['fixed', `Fixed until ${fMonth(fixEnd)}, then…`]] : m.kind === 'fixed' ? [['fixed', 'Fixed (no end date set)']] : [])];
  formSheet({
    title: 'How the rate moves', values: vals,
    sections: [
      { head: x.name, foot: fixEnd ? '' : x.part ? 'Set a “Fixed until” date on this part to model what happens when a fix ends.' : 'For a fixed-term account, set its access to Fixed term with a maturity date to model what happens when it ends.', fields: [{ key: 'kind', label: 'Rate', type: 'select', stack: true, options: kinds }] },
      { head: 'Following Bank Rate', foot: 'Pass-through is the share of each Bank Rate move passed on, and lag how many months later. Leave the margin blank and it is set so the rate starts at the one you entered.', fields: [
        { key: 'passThrough', label: 'Pass-through', type: 'percent', unit: '%' }, { key: 'lagMonths', label: 'Lag', type: 'number', unit: 'months' },
        { key: 'floor', label: 'Never below', type: 'percent', unit: '%', optional: true }, { key: 'spread', label: 'Margin over Bank Rate', type: 'percent', unit: '%', optional: true, ph: 'Worked out' }] },
      ...(fixEnd ? [{ head: `When the fix ends, ${fMonth(fixEnd)}`, foot: x.part ? 'The lender’s variable rate starts from your “Rate after the fix” and moves with Bank Rate. A new fix is priced at the market rate for that period, plus the margin; blank uses today’s quoted rates less today’s market rate.' : 'Easy access starts from today’s quoted instant-access rate if there is one. A new fix is priced at the market rate for that period, plus the margin (blank: worked out from quoted rates).', fields: [
        { key: 'rkind', label: 'Then', type: 'select', stack: true, options: [['variable', x.part ? 'The lender’s variable rate' : 'Easy access, following Bank Rate'], ['refix', 'A new fix at market rates'], ['manual', 'A rate I set'], ...(x.part ? [] : [['close', 'Paid out as cash']])] },
        { key: 'termMonths', label: 'New fix for', type: 'number', unit: 'months' }, { key: 'margin', label: 'Margin', type: 'percent', unit: '%', optional: true, ph: 'Worked out' },
        { key: 'manualRate', label: 'Rate I set', type: 'percent', unit: '%', optional: true }] }] : [])],
    onSave: v => {
      if (!v.kind) { delete x.item.rateModel; return changed('Back to its entered rate'); }
      if (!(v.passThrough >= 0 && v.passThrough <= 150)) { toast('Pass-through between 0% and 150%', true); return false; }
      if (v.kind === 'fixed' && v.rkind === 'manual' && v.manualRate == null) { toast('Enter the rate for after the fix', true); return false; }
      const nm = { kind: v.kind, passThrough: v.passThrough / 100, lagMonths: Math.max(0, Math.round(v.lagMonths || 0)), floor: v.floor, spread: v.spread };
      if (v.kind === 'fixed') nm.rollover = { kind: v.rkind, termMonths: Math.max(1, Math.round(v.termMonths || 24)), margin: v.margin, manualRate: v.manualRate };
      x.item.rateModel = nm;
      changed(market.state === 'ok' || data.rateBasis ? 'Rate settings saved' : 'Saved. It follows the market once a curve is in use');
    },
  });
}
function allOnMarket() {
  const todo = rateItems().filter(x => !x.model);
  if (!todo.length) return;
  for (const x of todo) x.item.rateModel = starterModel(x);
  changed(`${todo.length} on market rates`);
}
// Choosing a scenario's rates: which kind, then its settings
function rateScenarioSheet(sk) {
  const s = data.scenarios[sk], cur = (s.rates || {}).kind || 'market';
  const opt = (k, sub) => `<button class="row act-row" data-sact="${k}"><div class="main"><div class="ttl" style="color:var(--label)">${esc(TC.KINDS[k])}</div><div class="sub">${sub}</div></div>${k === cur ? `<span class="val" style="color:var(--accent)">${CHECK}</span>` : ''}</button>`;
  sheet({ title: `Rates in ${s.name}`, done: null, body: `<section class="group"><div class="list">${[
    opt('market', 'The Bank of England curve as published: what markets expect today'),
    opt('shift', 'The market curve moved up or down by a set amount'),
    opt('twist', 'Short-term and long-term rates moved by different amounts'),
    opt('anchor', 'The market for a few years, then a gradual move to a rate you choose'),
    opt('manual', 'Your own Bank Rate path: a few points, joined up. Works without a curve'),
    opt('history', 'An earlier curve, to see the plan as it looked at a past review'),
    opt('flat', 'Ignore market expectations: every account at its own entered rate, as before')].join('')}</div>
    <div class="gf">Market-implied paths are not forecasts. Only accounts on market rates are affected.</div></section>`,
    onDone: (form, close, act) => { close(); setTimeout(() => rateKindSheet(sk, act), 50); } });
}
function rateKindSheet(sk, kind) {
  const s = data.scenarios[sk], old = s.rates && s.rates.kind === kind ? s.rates : {}, D = TC.DEFAULTS;
  const save = (r, msg) => { s.rates = { kind, ...r }; changed(msg || `${s.name}: ${TC.KINDS[kind]}`); };
  if (kind === 'market' || kind === 'flat') return save({});
  if (kind === 'history') return historySheet(sk);
  const br = data.rateBasis && data.rateBasis.curve.anchors ? data.rateBasis.curve.anchors.bankRate : null;
  const pts = Object.fromEntries((old.points || []).map(p => ['p' + p.months, p.rate]));
  const F = {
    shift: [{ key: 'shift', label: 'Move by', type: 'percent', unit: 'points', hint: 'e.g. 1 for one point higher, −1 lower' }],
    twist: [{ key: 'short', label: 'Short end', type: 'percent', unit: 'points' }, { key: 'long', label: 'Long end', type: 'percent', unit: 'points' }, { key: 'twistYears', label: 'Long end from', type: 'number', unit: 'years' }],
    anchor: [{ key: 'anchorYears', label: 'Market for', type: 'number', unit: 'years' }, { key: 'blendYears', label: 'Then move over', type: 'number', unit: 'years' }, { key: 'neutral', label: 'To Bank Rate of', type: 'percent', unit: '%' }],
    manual: [{ key: 'today', label: 'Bank Rate today', type: 'percent', unit: '%' }, ...[[6, 'In 6 months'], [12, 'In 1 year'], [24, 'In 2 years'], [60, 'In 5 years']].map(([m, l]) => ({ key: 'p' + m, label: l, type: 'percent', unit: '%', optional: true }))],
  }[kind];
  const vals = kind === 'manual' ? { today: old.today ?? br, ...pts } : Object.fromEntries(F.map(f => [f.key, old[f.key] ?? D[f.key]]));
  const foot = { shift: 'Every point on the market curve, from today on, moves by this much.', twist: 'Moves the start of the curve by one amount and the long end by another, in a straight line between.', anchor: 'Long-dated market rates carry a premium for lending longer. This uses the market for the first years, then moves steadily to a “neutral” rate you choose.', manual: 'Straight lines between the points you enter; flat after the last one. Leave any blank.' }[kind];
  formSheet({ title: TC.KINDS[kind], values: vals, sections: [{ foot, fields: F }], onSave: v => {
    if (kind === 'manual') {
      if (v.today == null) { toast('Enter today’s Bank Rate', true); return false; }
      return save({ today: v.today, points: [6, 12, 24, 60].filter(m => v['p' + m] != null).map(m => ({ months: m, rate: v['p' + m] })) });
    }
    save(v);
  } });
}
async function historySheet(sk) {
  let dates = market.dates;
  if (!dates) { try { const r = await fetch('rates/history/index.json', { cache: 'no-cache' }); dates = market.dates = r.ok ? ((await r.json()).dates || []) : []; } catch (e) { dates = []; } }
  const list = dates.slice().reverse().slice(0, 60);
  if (!list.length) return toast('No earlier curves are available yet', true);
  sheet({ title: 'Curve as at', done: null, body: group(list.map(d => `<button class="row act-row" data-sact="${d}"><div class="main"><div class="ttl" style="color:var(--label)">${fDate(d)}</div></div></button>`).join(''), '', 'Published curves, newest first.'),
    onDone: async (form, close, d) => {
      close();
      try {
        const r = await fetch(`rates/history/${d}.json`); const c = r.ok ? await r.json() : null;
        if (!c || !TC.validate(c).ok) return toast('That curve could not be read', true);
        data.scenarios[sk].rates = { kind: 'history', asOf: c.asOf, curve: slim(c) };
        changed(`${data.scenarios[sk].name}: curve as at ${fDate(c.asOf)}`);
      } catch (e) { toast('Could not fetch that curve', true); }
    } });
}
// The workings behind one month's rate (6.4)
function whyText(w) {
  if (!w) return 'The rate entered for this account, carried forward.';
  if (w.kind === 'known') return 'The rate you entered for this month.';
  if (w.kind === 'manual') return 'The rate you set for after the fix.';
  if (w.kind === 'closed') return 'Paid out as cash when its fix ended.';
  if (w.kind === 'refix') return `${w.termMonths}-month fix: market ${pctf(w.fwdAER)} ${signedPct(w.margin).replace('+', '+ ').replace('−', '− ')} margin${w.extra ? ` ${signedPct(w.extra)} rate change` : ''}`;
  return `Bank Rate ${pctf(w.bank)} × ${Math.round(w.passThrough * 100)}% ${signedPct(w.spread + (w.add || 0))}${w.floored ? ', held at its floor' : ''}`;
}
function whySheet(arg) {
  const [ref, k] = arg.split('|'), sk = scenarioKey(), k0 = ymKeyOf(latestSnapshot(data).date);
  const pr = project(data, sk, +k - k0 + 1), r = pr.rows.find(x => x.k === +k);
  const isPart = ref.startsWith('p:'), id = ref.slice(2);
  const w = isPart ? (r.mortgageParts.find(p => p.id === id) || {}).why : (r.market[id] || {}).why;
  const name = isPart ? partName(data.mortgage.parts.find(p => p.id === id), data.mortgage.parts.findIndex(p => p.id === id)) : accLabel(acc(id));
  const L = pr.rateLayer, line = (t, v, sub) => row({ title: t, sub, value: v });
  let rows = '';
  if (w && w.kind === 'variable') rows = line(`Bank Rate expected in ${fMonth(w.month + '-01')}`, pctf(w.bank), w.lagMonths ? `${w.lagMonths} month${w.lagMonths === 1 ? '' : 's'} back: the lag` : 'This month: no lag') +
    line(`× pass-through ${Math.round(w.passThrough * 100)}%`, pctf(w.passThrough * w.bank)) + line('+ margin over Bank Rate', signedPct(w.spread), 'Set so the rate started at the one you entered, unless you set it') +
    (w.add ? line('+ rate change in this plan', signedPct(w.add)) : '') + (w.floored ? line('Held at its floor', pctf(w.floor)) : '') + row({ title: 'Rate this month', value: pctf(w.rate), cls: 'total' });
  else if (w && w.kind === 'refix') rows = line(`Market rate for a ${w.termMonths}-month fix from ${fMonth(keyToDateStr(k0 + w.i))}`, pctf(w.fwdAER), `${pctf(w.fwdCC)} continuously compounded, as the Bank publishes it`) +
    line('+ margin', signedPct(w.margin), w.marginSource === 'quoted' ? 'Today’s quoted rate for that length of fix, less today’s market rate' : w.marginSource === 'yours' ? 'Your own figure' : 'A typical figure: no quoted rate yet') +
    (w.extra ? line('+ rate change in this plan', signedPct(w.extra)) : '') + row({ title: `Fixed rate from ${fMonth(keyToDateStr(k0 + w.i))}`, value: pctf(w.rate), cls: 'total' });
  else rows = row({ title: whyText(w), value: pctf(w ? w.rate : null) });
  sheet({ title: name, done: null, body: `<p class="note">${fMonth(r.date)} · ${layerText(L)}</p>${group(rows, 'How this rate was worked out')}<p class="note">Market-implied, not a forecast.</p>` });
}
const keyToDateStr = k => `${Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, '0')}-01`;
// The month detail (6.3): each account's rate that month, the interest, and any repricing
function monthRatesGroup(r) {
  const out = [], sc = data.scenarios[scenarioKey()];
  for (const a of data.accounts) {
    if (r.rates[a.id] == null || !(a.type === 'savings' || a.type === 'cash_isa') || r.interest[a.id] == null) continue;
    const mk = r.market[a.id];
    out.push(row({ title: esc(accLabel(a)), sub: (mk && mk.repriced ? '<span class="badge isa">Repriced</span> ' : '') + esc(mk ? whyText(mk.why) : 'Its entered rate'), value: pctf(r.rates[a.id]), vsub: money(r.interest[a.id], { sign: true }), act: mk ? 'why' : null, arg: `a:${a.id}|${r.k}` }));
  }
  if (r.interest.cashIsaPool != null && r.isaCashFlex > 0.5) out.push(row({ title: 'Instant cash ISAs', sub: 'Pooled: their balance-weighted rate', value: pctf(r.cashIsaRate), vsub: money(r.interest.cashIsaPool, { sign: true }) }));
  r.mortgageParts.forEach((p, i) => { if (p.rate == null) return; out.push(row({ title: esc(partName(data.mortgage.parts[i] || p, i)) + (r.mortgageParts.length > 1 ? '' : ' interest'), sub: (p.repriced ? '<span class="badge out">Repriced</span> ' : '') + esc(p.why ? whyText(p.why) : 'Its entered rate'), value: pctf(p.rate), vsub: money(-p.interest, { sign: true }), act: p.why ? 'why' : null, arg: `p:${p.id}|${r.k}` })); });
  return out.length ? group(out.join(''), 'Interest rates', `${sc.growth ? '' : 'Growth and interest are off in this scenario, so savings earn nothing here. '}${layerText(layerOf(scenarioKey()))}. Tap a market rate for its workings.`) : '';
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
  if (f.type === 'select') return `<div class="field${f.stack ? ' stack' : ''}">${lab}<select id="${id}" name="${f.key}">${f.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v ?? '') ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select></div>`;
  if (f.type === 'date') return `<div class="field">${lab}<input id="${id}" name="${f.key}" type="date" value="${esc(v || '')}"></div>`;
  if (f.type === 'month') return `<div class="field">${lab}<input id="${id}" name="${f.key}" type="month" value="${esc(v ? String(v).slice(0, 7) : '')}" placeholder="YYYY-MM"></div>`;
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
    else if (f.type === 'month') out[f.key] = /^\d{4}-\d{2}/.test(el.value) ? el.value.slice(0, 7) : null;
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
  const last = latestSnapshot(data);
  const base = target || last;
  // Savings and cash ISAs can be left blank: they are then worked out from their interest rate
  const est = (id, d) => { const b = balanceOn(data, id, d || todayISO()); return b ? b.v : null; };
  const accs = data.accounts.filter(a => a.active || (target && target.balances[a.id] != null));
  const body = `<section class="group"><div class="list"><div class="field"><label for="u_date">Balances as at</label><input type="date" id="u_date" name="__date" value="${esc(date || todayISO())}"></div></div>
    <div class="gf">${target ? 'You’re correcting an earlier update.' : 'Start from your last figures and change what’s moved. Using an existing date replaces that update.'} Untick an account to leave it out - nothing is recorded for it on this date, and it carries on being worked out from its own balances.</div></section>` +
    data.people.map(p => {
      const l = accs.filter(a => a.owner === p.id); if (!l.length) return '';
      return `<section class="group"><div class="gh">${esc(p.name)}</div><div class="list">${l.map(a => {
        const liab = LIAB.has(a.type), v = base?.balances[a.id], auto = !target && (a.type === 'savings' || a.type === 'cash_isa');
        const shown = v == null || auto ? '' : nf2.format(Math.abs(liab ? -v : v) === 0 ? 0 : (liab ? -v : v)).replace(/\.00$/, '');
        const e = est(a.id, date), on = !target || v != null || auto; // correcting: an account not in that update starts left out
        const tip = `Include ${esc(a.name)} in this update`;
        const inv = (a.type === 'ss_isa' || a.type === 'pension') && (target ? snapsSorted().some(s => s.date < target.date) : !!last);
        const cv = target && target.contrib && target.contrib[a.id] != null ? String(target.contrib[a.id]) : '';
        return `<div class="field${on ? '' : ' out'}" data-row="${a.id}"><span class="tick"><input type="checkbox" class="inc" data-for="${a.id}" aria-label="${tip}" title="${tip}"${on ? ' checked' : ''}><span></span></span><label for="b_${a.id}">${esc(a.name)}<span class="sub" data-d="${a.id}">${liab ? 'Amount owed · ' : ''}last ${v == null ? '–' : money(liab ? Math.abs(v) : v)}</span></label><span class="amtin">£<input type="text" inputmode="decimal" id="b_${a.id}" name="b_${a.id}" class="bal-in num" data-liab="${liab ? 1 : 0}" data-last="${v ?? ''}" data-est="${e ?? ''}" value="${esc(shown)}" placeholder="${auto && e != null ? 'about ' + nf0.format(e) : '0'}" autocomplete="off"${on ? '' : ' disabled'}></span></div>` + (auto ? `<div class="gf" style="margin:-4px 0 6px">Leave blank to let Tally work it out at ${rateOn(a, date || todayISO())}%</div>` : '') +
          (inv ? `<div class="field"><label for="c_${a.id}">Paid in since last update<span class="sub">So growth isn’t mistaken for money you put in</span></label><span class="amtin">£<input type="text" inputmode="decimal" id="c_${a.id}" name="c_${a.id}" class="contrib-in num" value="${esc(cv)}" placeholder="0" autocomplete="off"${on ? '' : ' disabled'}></span></div>` : '');
      }).join('')}</div></section>`;
    }).join('') + `<section class="group"><div class="list"><div class="field"><label>Net worth</label><span class="num" id="u_total" style="font-weight:600"></span></div></div></section>`;
  sheet({
    title: target ? fDate(date) : 'Update balances', body, done: 'Save',
    onOpen: form => {
      const recalc = () => {
        let tot = 0;
        form.querySelectorAll('.bal-in').forEach(i => {
          let n = i.disabled ? null : parseNum(i.value); const liab = i.dataset.liab === '1'; if (n != null && liab) n = -Math.abs(n);
          if (n != null) tot += n; else if (i.dataset.est !== '') tot += +i.dataset.est;
          const last = i.dataset.last === '' ? null : +i.dataset.last, id = i.name.slice(2), d = form.querySelector(`[data-d="${CSS.escape(id)}"]`);
          if (d) d.innerHTML = `${liab ? 'Amount owed · ' : ''}last ${last == null ? '–' : money(liab ? Math.abs(last) : last)}${n != null && last != null && Math.abs(n - last) > .5 ? ' · <span class="delta ' + (n > last ? 'up' : 'down') + '">' + money(liab ? Math.abs(n) - Math.abs(last) : n - last, { sign: true }) + '</span>' : ''}`;
        });
        form.querySelector('#u_total').textContent = money(tot);
      };
      form.addEventListener('input', recalc); recalc();
      // what a blank or left-out account is worked out at follows the date chosen
      form.elements.__date.addEventListener('change', () => {
        const d = form.elements.__date.value; if (!d) return;
        form.querySelectorAll('.bal-in').forEach(i => { const e = est(i.name.slice(2), d); i.dataset.est = e ?? ''; if (i.placeholder.startsWith('about') && e != null) i.placeholder = 'about ' + nf0.format(e); });
        recalc();
      });
      form.querySelectorAll('.inc').forEach(c => c.addEventListener('change', () => {
        const id = c.dataset.for, row = form.querySelector(`[data-row="${CSS.escape(id)}"]`), inp = form.querySelector(`#b_${CSS.escape(id)}`), ci = form.querySelector(`#c_${CSS.escape(id)}`);
        row.classList.toggle('out', !c.checked); inp.disabled = !c.checked; if (ci) ci.disabled = !c.checked;
        if (c.checked && !inp.value) inp.focus();
        recalc();
      }));
      form.querySelectorAll('.bal-in').forEach(i => i.addEventListener('focus', () => setTimeout(() => i.select(), 0)));
    },
    onDone: form => {
      const d = form.elements.__date.value; if (!d) { toast('Choose a date', true); return false; }
      const balances = {};
      form.querySelectorAll('.bal-in').forEach(i => { if (i.disabled) return; let n = parseNum(i.value); if (n == null) return; if (i.dataset.liab === '1') n = -Math.abs(n); balances[i.name.slice(2)] = Math.round(n * 100) / 100; });
      if (!Object.keys(balances).length) { toast('Nothing to save - every account is left out or blank', true); return false; }
      if (target && d !== date) data.snapshots = data.snapshots.filter(s => s.date !== date);
      const ex = data.snapshots.find(s => s.date === d);
      const contrib = {};
      form.querySelectorAll('.contrib-in').forEach(i => { if (i.disabled) return; const n = parseNum(i.value); if (n) contrib[i.name.slice(2)] = Math.round(n * 100) / 100; });
      // a left-out account keeps whatever is already recorded on that date (unless this is that update being corrected)
      if (ex && ex !== target) form.querySelectorAll('.bal-in:disabled').forEach(i => { const id = i.name.slice(2); if (ex.balances[id] != null) balances[id] = ex.balances[id]; });
      const snap = ex || { date: d }; snap.balances = balances; delete snap.source;
      if (Object.keys(contrib).length) snap.contrib = contrib; else delete snap.contrib;
      if (!ex) data.snapshots.push(snap);
      if (target) { const st = ui.stacks[ui.tab]; if (st.at(-1) === 'snap:' + date) st[st.length - 1] = 'snap:' + d; }
      changed(`Balances saved for ${fDate(d)}`);
    },
  });
}

const ownerOpts = () => data.people.map(p => [p.id, p.name]);
const ACCESS_OPTS = Object.entries(TM.ACCESS);
function accountSheet(id) {
  const a = id ? acc(id) : { name: '', owner: data.people[0].id, type: 'current', rate: 0, active: true, note: '', access: 'instant' };
  formSheet({
    title: id ? 'Edit account' : 'New account', values: { ...a, access: a.access || 'instant', flexible: a.flexible !== false },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text', ph: 'e.g. Vanguard S&S ISA' }, { key: 'owner', label: 'Belongs to', type: 'select', options: ownerOpts() }, { key: 'type', label: 'Type', type: 'select', options: Object.entries(TYPE_LABEL) }] },
    { head: 'Projection', foot: id ? `Interest rate: ${rateOn(a, todayISO())}% now. Rates are kept by date - change it under Interest rates on the account’s page, so earlier months keep the rate they had.` : 'Cash ISAs, savings and pensions use the rate; S&S ISAs use the scenario return. If it changes later, add the new rate from its date on the account’s page.',
      fields: [...(id ? [] : [{ key: 'rate', label: 'Interest or return', type: 'percent', unit: '%' }]), { key: 'active', label: 'Open', type: 'toggle', hint: 'Closed accounts drop out of new updates' }] },
    { head: 'How quickly you can use it', foot: 'Used to show what is genuinely available at a given date, such as your remortgage. Not needed for cards or tax owed.', fields: [
      { key: 'access', label: 'Access', type: 'select', options: ACCESS_OPTS },
      { key: 'noticeDays', label: 'Notice needed', type: 'number', unit: 'days', optional: true, hint: 'Notice accounts only' },
      { key: 'maturity', label: 'Matures', type: 'month', optional: true, hint: 'Fixed-term accounts only' },
      { key: 'flexible', label: 'Flexible ISA', type: 'toggle', hint: 'Cash ISAs only: money taken out can go back in the same tax year' }] },
    { head: 'Notes', fields: [{ key: 'note', label: 'Note', type: 'text', optional: true, ph: 'Optional' }] }],
    extra: id ? destructive('Delete account', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') {
        if (!confirm(`Delete ${a.name}? Its balance history is removed from every update.`)) return;
        data.accounts = data.accounts.filter(x => x.id !== id); data.snapshots.forEach(s => delete s.balances[id]);
        ui.stacks[ui.tab] = ui.stacks[ui.tab].filter(r => r !== 'acct:' + id); return changed('Account deleted');
      }
      if (!v.name.trim()) { toast('Give the account a name', true); return false; }
      // keep only the access details that apply to this kind of account
      if (TM.LIABILITIES.has(v.type)) { v.access = v.noticeDays = v.maturity = null; }
      if (v.access !== 'notice') v.noticeDays = null;
      if (v.access !== 'fixed') v.maturity = null;
      if (v.type !== 'cash_isa') v.flexible = null;
      const rec = id ? Object.assign(a, v) : { id: uid('a'), ...v };
      for (const k of ['noticeDays', 'maturity', 'access', 'flexible']) if (rec[k] == null) delete rec[k];
      if (!id) data.accounts.push(TM.migrate({ accounts: [rec], version: TM.VERSION }).accounts[0]);
      changed(id ? 'Account updated' : 'Account added');
    },
  });
}
// Income, spending and one-offs are all "flows". Income and spending are monthly and can start and stop on a month.
const whenFields = [{ key: 'start', label: 'From', type: 'month', optional: true, hint: 'Leave blank if it’s already running' }, { key: 'end', label: 'Until', type: 'month', optional: true, hint: 'Leave blank if it carries on' }];
function checkWhen(v) { if (v.start && v.end && v.end < v.start) { toast('“Until” is before “From”', true); return false; } return true; }
const bundleArg = arg => (arg && String(arg).startsWith('b:') ? bundleById(String(arg).slice(2)) : null);
function incomeSheet(id, inBundle) {
  const x = id ? flowById(id) : { name: '', owner: data.people[0].id, amount: 0, growth: 0, start: inBundle ? inBundle.start : null, end: null };
  formSheet({
    title: id ? 'Edit income' : 'New income', values: x,
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'owner', label: 'Whose', type: 'select', options: ownerOpts() }, { key: 'amount', label: 'Monthly, after tax', type: 'money', unit: '' }, { key: 'growth', label: 'Extra rise each April', type: 'percent', unit: '%', hint: 'On top of the scenario pay rise' }] },
    { head: 'When', foot: 'For example, reduced pay during parental leave: add it as its own income with dates, and end the usual pay the month before.', fields: whenFields }],
    extra: id ? destructive('Delete income', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.flows = data.flows.filter(f => f.id !== id); return changed('Income removed'); }
      if (!checkWhen(v)) return false;
      if (id) Object.assign(x, v); else data.flows.push({ id: uid('inc'), kind: 'income', category: 'Income', inflates: false, bundle: inBundle ? inBundle.id : null, on: true, ...v }); changed('Income saved');
    },
  });
}
function spendSheet(id, cat, inBundle) {
  const x = id ? flowById(id) : { name: '', category: cat || (inBundle ? inBundle.name : 'Living'), amount: 0, inflates: true, start: inBundle ? inBundle.start : null, end: null };
  const cats = [...new Set([...flowsOf('spend').map(s => s.category || 'Other'), ...(x.category ? [x.category] : []), 'Home', 'Bills', 'Living', 'Transport', 'Other'])];
  const monthly = Math.round((+x.amount || 0) * 100) / 100, annual = Math.round((+x.amount || 0) * 12 * 100) / 100;
  formSheet({
    title: id ? 'Edit spending' : 'New spending', values: { ...x, monthly, annual },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'category', label: 'Category', type: 'select', options: cats.map(c => [c, c]) }] },
    { head: 'Amount — fill in either', foot: 'If you change both, the yearly figure wins.', fields: [{ key: 'monthly', label: 'Per month', type: 'money' }, { key: 'annual', label: 'Per year', type: 'money' }] },
    { fields: [{ key: 'inflates', label: 'Rises with inflation', type: 'toggle' }] },
    { head: 'When', foot: 'For costs that start or stop, such as nursery fees from one month to another.', fields: whenFields }],
    extra: id ? destructive('Delete', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.flows = data.flows.filter(f => f.id !== id); return changed('Removed'); }
      if (!checkWhen(v)) return false;
      // keep the exact stored figure unless one of the two boxes was actually changed
      const amount = Math.abs(v.annual - annual) > .005 ? v.annual / 12 : Math.abs(v.monthly - monthly) > .005 ? v.monthly : (+x.amount || 0);
      const rec = { name: v.name, category: v.category, amount, inflates: v.inflates, start: v.start, end: v.end };
      if (id) Object.assign(x, rec); else data.flows.push({ id: uid('sp'), kind: 'spend', owner: null, growth: 0, bundle: inBundle ? inBundle.id : null, on: true, ...rec }); changed('Spending saved');
    },
  });
}
function eventSheet(id, inBundle, inMonth) {
  const x = id ? flowById(id) : { name: '', amount: -1000, start: inMonth || (inBundle ? inBundle.start : thisMonth()), on: true, settles: '' };
  const debtOpts = [['', 'Nothing'], ...data.accounts.filter(a => LIAB.has(a.type)).map(accOption)];
  formSheet({
    title: id ? 'Edit item' : 'New item', values: { ...x, dir: x.amount < 0 ? 'out' : 'in', abs: Math.abs(x.amount), settles: x.settles || '' },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'dir', label: 'Type', type: 'select', options: [['out', 'Payment out'], ['in', 'Money in']] }, { key: 'abs', label: 'Amount', type: 'money' }, { key: 'start', label: 'Month', type: 'month', hint: 'Counted in this month' }] },
    { foot: 'If this payment clears a debt, choose it so the debt isn’t counted twice.', fields: [{ key: 'settles', label: 'Clears a debt', type: 'select', options: debtOpts }, { key: 'on', label: 'Include in projection', type: 'toggle' }] }],
    extra: id ? destructive('Delete item', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') { data.flows = data.flows.filter(f => f.id !== id); return changed('Item deleted'); }
      if (!v.start) { toast('Choose a month', true); return false; }
      const amount = (v.dir === 'out' ? -1 : 1) * Math.abs(v.abs);
      const rec = { name: v.name || 'Untitled', amount, start: v.start, end: v.start, on: v.on, category: amount < 0 ? 'One-off' : 'Receipt' };
      if (v.settles) rec.settles = v.settles; else if (x.settles) delete x.settles;
      if (id) Object.assign(x, rec); else data.flows.push({ id: uid('ev'), kind: 'oneoff', owner: null, inflates: false, growth: 0, bundle: inBundle ? inBundle.id : null, ...rec }); changed('Item saved');
    },
  });
}
function partSheet(id) {
  const parts = data.mortgage.parts, p = id ? parts.find(x => x.id === id) : null;
  const multi = parts.length > 1 || !p;
  formSheet({
    title: p ? (multi ? partName(p, parts.indexOf(p)) : 'Mortgage') : 'New part', values: p || { name: `Part ${parts.length + 1}`, payment: null },
    sections: [{ fields: [...(multi ? [{ key: 'name', label: 'Name', type: 'text', ph: 'e.g. Further advance' }] : []), { key: 'payment', label: 'Monthly payment', type: 'money' }, { key: 'balance', label: 'Balance owed', type: 'money', optional: true }, { key: 'rate', label: 'Current rate', type: 'percent', unit: '%', optional: true }] },
    { head: 'Remortgage', fields: [{ key: 'fixEnd', label: 'Fixed until', type: 'date', optional: true }, { key: 'newRate', label: 'Rate after the fix', type: 'percent', unit: '%', optional: true }, { key: 'termEnd', label: 'Ends', type: 'date', optional: true }] }],
    extra: p && parts.length > 1 ? destructive('Delete this part', 'delete') : '',
    onSave: (v, act) => {
      if (act === 'delete') {
        if (!confirm(`Delete ${partName(p, parts.indexOf(p))}? Its payment comes out of your spending.`)) return;
        data.mortgage.parts = parts.filter(x => x !== p);
        if (ui.stacks[ui.tab].at(-1) === 'mpart:' + p.id) ui.stacks[ui.tab].pop();
        return changed('Part deleted');
      }
      if (p) { Object.assign(p, v); return changed('Mortgage saved'); }
      if (parts.length === 1 && !parts[0].name) parts[0].name = 'Part 1'; // the original part needs a name once there are two
      parts.push({ id: uid('mp'), ...v }); changed('Part added');
    },
  });
}
function homeSheet() {
  formSheet({ title: 'Home', values: data.mortgage, sections: [{ foot: 'Used to show your home equity: value less everything owed on the mortgage.', fields: [{ key: 'propertyValue', label: 'Estimated value', type: 'money', optional: true }] }], onSave: v => { data.mortgage.propertyValue = v.propertyValue; changed('Home value saved'); } });
}
function rulesSheet() {
  const r = data.rules, who = r.isaFillOrder;
  const values = { ...r, first: who[0] };
  for (const p of who) values['used_' + p] = +r.isaUsedBy[p] || 0;
  formSheet({
    title: 'Rules', values,
    sections: [{ foot: 'The projection keeps at least this much in current accounts.', fields: [{ key: 'cashFloor', label: 'Cash floor', type: 'money' }] },
    { head: 'ISAs', foot: `Top-ups fill the first person’s allowance, then the next person’s. Enter the tax year by its starting year, e.g. 2026 for 2026/27.`, fields: [
      { key: 'isaPerPerson', label: 'Allowance each', type: 'money' },
      ...(who.length > 1 ? [{ key: 'first', label: 'Fill first', type: 'select', options: who.map(p => [p, person(p)]) }] : []),
      ...who.map(p => ({ key: 'used_' + p, label: `${person(p)} has paid in`, type: 'money' })),
      { key: 'isaUsedTaxYear', label: 'In tax year starting', type: 'number' },
      { key: 'sweepToSS', label: 'Share of top-ups to S&S', type: 'percent', unit: '%', hint: 'The rest goes to cash ISAs' }] }],
    onSave: v => {
      r.cashFloor = v.cashFloor; r.isaPerPerson = v.isaPerPerson; r.isaUsedTaxYear = v.isaUsedTaxYear; r.sweepToSS = v.sweepToSS;
      for (const p of who) r.isaUsedBy[p] = v['used_' + p];
      if (v.first) r.isaFillOrder = [v.first, ...who.filter(p => p !== v.first)];
      changed('Rules saved');
    },
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
    const v = ({ pool: vPool, acct: vAccount, snaps: vSnaps, snap: vSnap, month: vMonth, scenario: vScenario, spending: vSpending, events: vEvents, mortgage: vMortgage, mpart: vMortgagePart, bundle: vBundle, ready: vReady, compare: vCompare, plans: vPlans, calendar: vCalendar, actuals: vActuals, insights: vInsights, txns: vTxns, uncat: vUncat, recurring: vRecurring, rules: vRules, imports: vImports, isayear: vIsaYear, goal: vGoal, risk: vRisk, checks: vChecks, rates: vMarket })[kind];
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
  $('#main').innerHTML = `<div class="page ${ui.anim}">${v.large && !v.noNav ? `<h1 class="large">${esc(v.title)}</h1>` : ''}${data ? leakChip() : ''}${v.body}</div>`;
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
  'new-file': async () => { data = blankFile(); meta = { fileName: 'family-finances.json', dirty: true, savedAt: null, private: true, encrypt: false, base: null, conflict: false }; await TS.setHandle(null); await refreshRoute(); persist(); render(); },
  encrypt: encryptSheet, decrypt: decryptSheet,
  reconnect: async () => { await TS.permission(true); if (await refreshRoute() !== 'live') return toast('Tally still can’t write to the file', true); await syncFromFile(); if (meta.dirty && !meta.conflict) saveFile(); else toast('Reconnected to ' + TS.handle.name); },
  resolve: async () => { if (await refreshRoute() !== 'live') return toast('Reconnect to your file first', true); const cur = parseFile((await TS.readHandle()).text); if (cur && TS.isConflict(cur.writer, meta.base)) conflictSheet(cur.writer); else { meta.conflict = false; persist(); saveFile(); } },
  private: () => { meta.private = !meta.private; persist(); render(); },
  owner: o => { ui.owner = o; render(); },
  scenario: k => { ui.scenario = k; render(); },
  horizon: n => { ui.horizon = +n; render(); },
  'add-account': () => accountSheet(null), 'edit-account': accountSheet,
  'add-income': a => incomeSheet(null, bundleArg(a)), 'edit-income': id => incomeSheet(id),
  'add-spend': c => bundleArg(c) ? spendSheet(null, null, bundleArg(c)) : spendSheet(null, c), 'edit-spend': id => spendSheet(id),
  'add-event': a => eventSheet(null, bundleArg(a)), 'edit-event': id => eventSheet(id),
  'add-bundle': templatePicker, 'edit-bundle': bundleSheet,
  'edit-remortgage': remortgageSheet, 'add-option': () => optionSheet(null), 'edit-option': optionSheet, 'edit-scplan': scenarioPlanSheet,
  'cmp-win': m => { ui.cmpWin = +m; render(); }, 'cal-month': calendarMonthSheet,
  'csv-import': () => $('#csvIn').click(), 'act-range': r => { ui.actRange = r; render(); },
  'ins-measure': v => { insState().measure = v; render(); }, 'ins-period': v => { insState().period = v; render(); }, 'ins-by': v => { insState().by = v; insState().all = false; render(); },
  'ins-acct': v => { insState().account = v; render(); }, 'ins-all': () => { insState().all = !insState().all; render(); }, 'bank-cats': bankCatSheet,
  'cat-tx': id => catSheet({ id }), recal: recalApply,
  real: () => { ui.real = !ui.real; render(); },
  'add-bal': id => balanceSheet(id, null), 'edit-bal': arg => { const [id, d] = arg.split('|'); balanceSheet(id, d); },
  'add-mtx': id => moneySheet(id, null),
  'add-rate': id => rateSheet(id, null), 'edit-rate': arg => { const i = arg.indexOf('|'); rateSheet(arg.slice(0, i), arg.slice(i + 1)); }, 'edit-mtx': id => moneySheet(null, id), review: reviewSheet,
  'edit-checks': () => formSheet({ title: 'When to ask', values: data.rules.checks, sections: [{ foot: 'A gap between two balances is listed when nothing explains more than this much of it: the larger of the two.', fields: [{ key: 'abs', label: 'More than', type: 'money' }, { key: 'pct', label: 'Or more than', type: 'percent', unit: '% of the balance' }] }], onSave: v => { data.rules.checks = { abs: Math.max(0, v.abs), pct: Math.max(0, v.pct) }; changed('Saved'); } }), 'edit-goal': id => goalSheet(id || null), 'mc-vol': v => { ui.mcVol = +v; render(); }, reminder: downloadReminder, 'edit-rule': id => ruleSheet(id || null),
  'undo-import': id => { const i = data.imports.find(x => x.id === id); if (!i || !confirm(`Remove the ${i.count} transactions this import added?`)) return; data.transactions = data.transactions.filter(t => t.batch !== id); data.imports = data.imports.filter(x => x.id !== id); changed('Import removed'); },
  'cmp-sc': k => { const cur = (ui.cmpSc || Object.keys(data.scenarios)).filter(x => data.scenarios[x]); ui.cmpSc = cur.includes(k) ? (cur.length > 1 ? cur.filter(x => x !== k) : cur) : [...cur, k].slice(-3); render(); }, 'leak-ok': () => { ui.leak = null; render(); },
  'curve-use': () => { const c = newerCurve(); if (c) useCurve(c); }, 'edit-rates': rateScenarioSheet, 'edit-ratemodel': rateModelSheet, 'rates-all': allOnMarket, why: whySheet,
  'rate-market': key => { const x = rateItem(key); if (!x) return; x.item.rateModel = starterModel(x); changed(data.rateBasis ? 'On market rates' : 'On market rates once a curve is in use'); },
  'open-rates': k => { if (k) ui.scenario = k; actions.push('rates'); },
  'add-option-market': m => { const C = compareOptions(data, scenarioKey(), 60, thisMonth()), q = C.market && C.market.find(x => x.months === +m); if (q) optionSheet(null, { name: `Market ${q.months / 12}-year fix`, rate: Math.round(q.rate * 100) / 100, fixMonths: q.months }); },
  'edit-part': partSheet, 'add-part': () => partSheet(null), 'edit-home': homeSheet, 'edit-rules': rulesSheet, 'edit-scenario': scenarioSheet, 'edit-people': peopleSheet,
  'edit-buffer': () => formSheet({ title: 'Buffer', values: { bufferPct: data.bufferPct }, sections: [{ foot: 'Added on top of all regular spending, including the mortgage.', fields: [{ key: 'bufferPct', label: 'Buffer', type: 'percent', unit: '%' }] }], onSave: v => { data.bufferPct = v.bufferPct; changed('Buffer saved'); } }),
  'del-snap': d => { if (!confirm(`Delete the update from ${fDate(d)}?`)) return; data.snapshots = data.snapshots.filter(s => s.date !== d); ui.stacks[ui.tab].pop(); changed('Update deleted'); },
};
const changes = {
  'ev-on': (id, on) => { flowById(id).on = on; changed(); },
  'b-on': (id, on) => { bundleById(id).on = on; changed(on ? 'Event included' : 'Event left out'); },
  'sc-growth': (k, on) => { data.scenarios[k].growth = on; changed(); },
  'sc-default': (k, on) => { if (on) { data.scenario = k; ui.scenario = k; changed(); } else render(); },
};
document.addEventListener('click', e => {
  if (e.target.closest('.switch')) return; // a switch inside a tappable row shouldn't also open the row
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
// Figures start hidden every time the app is opened, whatever they were when it was last closed: the eye in the
// header shows them for this visit. Opening it on a train should never put balances on the screen.
meta.private = true;
readyBaseline();
loadCurve();
if (!framed && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
if (!framed) { const l = document.createElement('link'); l.rel = 'manifest'; l.href = 'manifest.webmanifest'; document.head.appendChild(l); }
render();
// Pick up the file connection and passphrase key this device kept, then fetch anything newer.
(async () => {
  seal = await TS.kvGet('seal');
  if (!framed && window.showOpenFilePicker) await TS.restoreHandle();
  await refreshRoute(); await syncFromFile();
  if (meta.dirty && !meta.conflict) autoSaveSoon();
})();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncFromFile(); });
