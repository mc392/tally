// ================= Tally app =================
const STORE = 'tally.v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

let data = null;
// base = writer mark of the file version this device last read or wrote (see storage.js)
let meta = { fileName: null, dirty: false, savedAt: null, private: false, encrypt: false, base: null, conflict: false };
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
const snapsSorted = () => [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
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
    cautious: { name: 'Cautious', growth: false, ssReturn: 0, inflation: 0, payRise: 0 },
    base: { name: 'Base', growth: true, ssReturn: 5, inflation: 3, payRise: 2 },
    optimistic: { name: 'Optimistic', growth: true, ssReturn: 7, inflation: 2, payRise: 3 },
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
function chart(id, { series, height = 170, fmt = short, floor = null, markers = [], bands = [] }) {
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
  const m = data.mortgage, mt = mortgageTotals(data);
  const equity = m.propertyValue && mt.balance != null ? m.propertyValue - mt.balance : null;
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
  const bands = bundleBands(tFirst, monthEndT(end.date));
  const c1 = chart('c-proj', { series: [{ name: 'Net worth', color: 'var(--c-net)', pts: pts('net') }, { name: 'ISAs', color: 'var(--c-isa)', pts: pts('isa'), fill: true }].map((x, i) => i ? x : { ...x, whenLabel: `End of ${fMonth(end.date)}` }), height: 180, markers, bands });
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
      <div class="chips">${[[18, '18 months'], [36, '3 years'], [60, '5 years'], [120, '10 years']].map(([n, l]) => `<button class="${n === horizon() ? 'on' : ''}" data-act="horizon" data-arg="${n}">${l}</button>`).join('')}</div>
      <section class="card"><div class="gh">Net worth and ISAs<b>from ${fDate(pr.snapDate)}</b></div>${c1}
        <div class="legend"><span><i style="background:var(--c-net)"></i>Net worth</span><span><i style="background:var(--c-isa)"></i>ISAs</span><span><i style="background:var(--red)"></i>Payment</span><span><i style="background:var(--green)"></i>Receipt</span>${bands.length ? '<span><i style="background:var(--accent);opacity:.3"></i>Life events</span>' : ''}</div></section>
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
      ${group(Object.entries(tys).map(([y, t]) => row({ title: `${y}/${String(+y + 1).slice(2)}`, sub: `In ${short(t.in)} · out ${short(t.out)}`, value: amt(t.left), vsub: 'allowance left' })).join(''), 'ISA allowance by tax year', `Uses ${money(data.rules.isaPerPerson)} each for ${esc(data.rules.isaFillOrder.map(person).join(' and '))}, filling ${esc(person(data.rules.isaFillOrder[0]))}’s first. Money taken out of a flexible ISA can be put back in the same tax year without using new allowance; the projection tracks that separately.`)}
      ${group(months, 'Month by month', 'Tap a month for the full cash waterfall and ISA workings.')}
      ${group(row({ title: `${esc(sc.name)} assumptions`, sub: sc.growth ? `S&S ${sc.ssReturn}% · inflation ${sc.inflation}% · pay ${sc.payRise}%` : 'No growth, no inflation, no pay rises', act: 'push', arg: 'scenario:' + sk }) + row({ title: 'Cash floor and ISA rules', act: 'edit-rules' }) + row({ title: 'Upcoming payments and receipts', value: String(flowsOf('oneoff').filter(e => e.on).length), act: 'push', arg: 'events' }), 'Refine')}`,
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
      ${Object.keys(r.bundleNet).length ? group(Object.entries(r.bundleNet).map(([id, v]) => { const b = bundleById(id); return b ? row({ title: esc(b.name), sub: 'Life event, this month', value: amt(v, { sign: true, color: true }), act: 'push', arg: 'bundle:' + id }) : ''; }).join(''), 'Life events', 'Already included in the figures above.') : ''}
      ${m ? group((r.mortgageParts.length > 1 ? r.mortgageParts.map((p, i) => line(esc(p.name || `Part ${i + 1}`), -p.pay, { sub: p.bal != null ? `${short(p.bal)} left` : 'Flat payment' })).join('') : '') +
        line('Mortgage payment', -r.mortgagePay) + line('Of which interest', -r.mortgageInterest) + line('Mortgage balance', -r.mortgageBal, { total: true }), 'Mortgage') : ''}</div>`,
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
      ${group(data.bundles.map(bundleRow).join('') + row({ title: 'Add a life event', act: 'add-bundle', cls: 'act-row', chev: false }), 'Life events', data.bundles.length ? 'Each event is a set of dated lines you can switch on or off, move or scale as one.' : 'A baby, a move, a renovation, a car, a big trip or time off work, as a set of dated costs and income changes you can switch on and off.')}
      ${group(
        row({ title: 'Mortgage', sub: mt.parts.length > 1 ? `${mt.parts.length} parts` : '', value: amt(mt.payment), vsub: mt.balance != null ? `${short(mt.balance)} owed` : 'balance not set', act: 'push', arg: 'mortgage' }) +
        row({ title: 'Upcoming payments and receipts', value: String(flowsOf('oneoff').filter(e => e.on).length), act: 'push', arg: 'events' }), 'Commitments')}
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
      ${group(tgt + row({ title: 'Glide path', sub: rm.glide ? `For ${rm.glideMonths} months before the fix end, new savings are held as cash ISA, not S&S` : 'Off: top-ups follow your usual S&S split', value: rm.glide ? '<span class="pill ok">On</span>' : '<span class="pill">Off</span>', act: 'edit-remortgage' }), 'Getting ready')}
      ${R.laterParts.length ? `<p class="note">After this: ${R.laterParts.map(x => `${esc(partName(x.part, x.index))}’s fix ends ${fMonth(x.fixEnd)}`).join('; ')}. Its readiness appears here once this one has passed.</p>` : ''}
      <p class="note">Worked out in the ${esc(sc[sk].name)} scenario. Figures are projections, not advice.</p>`,
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
      ${readyGroup}${body}${outlook ? group(outlook, 'Projection') : ''}
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
      ${o.full ? group(row({ title: `Balance by ${fMonth(end.date)}`, value: amt(o.endBal) }) + (o.after ? row({ title: 'Payment after the fix', value: amt(o.after), vsub: chg(o.after - (+p.payment || 0)) + ' a month' }) : ''), 'Projection') : ''}`,
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
const ACCESS_OPTS = Object.entries(TM.ACCESS);
function accountSheet(id) {
  const a = id ? acc(id) : { name: '', owner: data.people[0].id, type: 'current', rate: 0, active: true, note: '', access: 'instant' };
  formSheet({
    title: id ? 'Edit account' : 'New account', values: { ...a, access: a.access || 'instant', flexible: a.flexible !== false },
    sections: [{ fields: [{ key: 'name', label: 'Name', type: 'text', ph: 'e.g. Vanguard S&S ISA' }, { key: 'owner', label: 'Belongs to', type: 'select', options: ownerOpts() }, { key: 'type', label: 'Type', type: 'select', options: Object.entries(TYPE_LABEL) }] },
    { head: 'Projection', fields: [{ key: 'rate', label: 'Interest or return', type: 'percent', unit: '%', hint: 'Cash ISAs, savings and pensions use this; S&S ISAs use the scenario return' }, { key: 'active', label: 'Open', type: 'toggle', hint: 'Closed accounts drop out of new updates' }] },
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
function eventSheet(id, inBundle) {
  const x = id ? flowById(id) : { name: '', amount: -1000, start: inBundle ? inBundle.start : thisMonth(), on: true, settles: '' };
  const debtOpts = [['', 'Nothing'], ...data.accounts.filter(a => LIAB.has(a.type)).map(a => [a.id, a.name])];
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
    const v = ({ pool: vPool, acct: vAccount, snaps: vSnaps, snap: vSnap, month: vMonth, scenario: vScenario, spending: vSpending, events: vEvents, mortgage: vMortgage, mpart: vMortgagePart, bundle: vBundle, ready: vReady })[kind];
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
  'new-file': async () => { data = blankFile(); meta = { fileName: 'family-finances.json', dirty: true, savedAt: null, private: false, encrypt: false, base: null, conflict: false }; await TS.setHandle(null); await refreshRoute(); persist(); render(); },
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
  'edit-remortgage': remortgageSheet, 'leak-ok': () => { ui.leak = null; render(); },
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
readyBaseline();
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
