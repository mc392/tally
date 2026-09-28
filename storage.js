// ================= Tally storage =================
// Everything about how the finance file is read and written lives here, so app.js never needs
// to know which route is in use. Three jobs:
//   1. Encryption  - the file can be sealed with a passphrase (AES-GCM, key from PBKDF2).
//   2. Writer mark - every save records which device wrote it, so a save never silently
//                    overwrites changes another device made since this one last read the file.
//   3. Routes      - "handle": Chrome/Edge on a computer write straight back to the file (live save).
//                    Anything else is manual (share sheet / download). Phase 2 adds "native" here.
// The crypto and conflict parts are pure and are tested in node (tests/storage.test.js).

const TallyStorage = (() => {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const ENC_FORMAT = 'tally-encrypted';
  const ITERATIONS = 600000; // PBKDF2-SHA256, OWASP 2023 guidance. Runs once per file open, not per save.

  // ---------- bytes <-> base64 ----------
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

  // ---------- encryption ----------
  // A "seal" is a key plus the salt it was derived from. The salt must travel in the file so the
  // passphrase can derive the same key on another device; the key never leaves this device.
  async function deriveSeal(passphrase, salt = rand(16), iter = ITERATIONS) {
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); // non-extractable: usable, never readable
    return { key, salt: b64(salt), iter };
  }
  const isEncrypted = obj => !!obj && obj.format === ENC_FORMAT;

  async function seal(obj, s, writer) {
    const iv = rand(12); // fresh for every save - never reuse an IV with the same key
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, s.key, new TextEncoder().encode(JSON.stringify(obj))));
    // The writer mark sits outside the sealed part so a conflict can be spotted before decrypting.
    // It holds a random device id, a label like "iPhone", a counter and a time - nothing financial.
    return { app: 'tally', format: ENC_FORMAT, v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: s.iter, salt: s.salt }, iv: b64(iv), ct: b64(ct), writer };
  }
  // Throws WrongPassphrase if the key does not open it (AES-GCM authenticates, so a wrong key
  // or a tampered file both fail here rather than producing garbage).
  async function unseal(env, s) {
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, s.key, unb64(env.ct));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) { const err = new Error('Wrong passphrase, or the file is damaged'); err.name = 'WrongPassphrase'; throw err; }
  }
  const sealFits = (env, s) => !!s && s.salt === env.kdf.salt && s.iter === env.kdf.iter;
  // The seal an encrypted file needs, from the passphrase: same salt and work factor as the file.
  const sealFor = (passphrase, env) => deriveSeal(passphrase, unb64(env.kdf.salt), env.kdf.iter);

  // ---------- writer mark & conflicts ----------
  // base = the writer mark of the version this device last read or wrote.
  // It is a conflict when the file now carries a different mark: someone saved since we last looked.
  // A file with no mark at all (written before this existed) is never a conflict.
  function isConflict(fileWriter, base) {
    if (!fileWriter) return false;
    if (!base) return true; // we have never seen this file's history, but it has one
    return fileWriter.device !== base.device || fileWriter.rev !== base.rev;
  }
  const nextWriter = (fileWriter, base, device) => ({
    device: device.id, label: device.label, at: new Date().toISOString(),
    rev: Math.max(fileWriter ? fileWriter.rev || 0 : 0, base ? base.rev || 0 : 0) + 1,
  });

  // ---------- this device ----------
  function deviceLabel() {
    const ua = (globalThis.navigator && navigator.userAgent) || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Macintosh/.test(ua)) return 'Mac';
    return 'another device';
  }
  function device() {
    let id = null;
    try { id = localStorage.getItem('tally.device'); if (!id) { id = b64(rand(9)).replace(/[+/=]/g, ''); localStorage.setItem('tally.device', id); } } catch (e) { id = id || 'unknown'; }
    return { id, label: deviceLabel() };
  }

  // ---------- small IndexedDB store: file handle + seal ----------
  // Both are structured-cloneable, which localStorage is not (JSON would turn them into {}).
  // Holding the seal here means one passphrase entry per device, not per open. It is no weaker
  // than the working copy this device already keeps between saves.
  const IDB = 'tally', OS = 'kv';
  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore(OS); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function kv(mode, fn) {
    try { const db = await idb(); return await new Promise((res, rej) => { const t = db.transaction(OS, mode); const q = fn(t.objectStore(OS)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); }
    catch (e) { return null; }
  }
  const kvGet = k => kv('readonly', s => s.get(k));
  const kvSet = (k, v) => kv('readwrite', s => v == null ? s.delete(k) : s.put(v, k));

  // ---------- routes ----------
  let handle = null; // FileSystemFileHandle, Chrome/Edge only
  async function restoreHandle() { const h = await kvGet('handle'); if (h && h.getFile) handle = h; return handle; }
  async function setHandle(h) { handle = h || null; await kvSet('handle', handle); }
  async function permission(ask) {
    if (!handle || !handle.queryPermission) return handle ? 'granted' : 'none';
    const o = { mode: 'readwrite' };
    let p = await handle.queryPermission(o);
    if (p !== 'granted' && ask) p = await handle.requestPermission(o); // must be inside a tap
    return p;
  }
  // live = this device can write back without asking (so saves can happen automatically)
  async function route() { if (!handle) return 'manual'; return (await permission(false)) === 'granted' ? 'live' : 'reconnect'; }
  async function readHandle() { const f = await handle.getFile(); return { text: await f.text(), name: f.name }; }
  async function writeHandle(text) { const w = await handle.createWritable(); await w.write(text); await w.close(); }

  return {
    ITERATIONS, deriveSeal, sealFor, seal, unseal, sealFits, isEncrypted, isConflict, nextWriter, device,
    kvGet, kvSet, restoreHandle, setHandle, permission, route, readHandle, writeHandle,
    get handle() { return handle; },
  };
})();

if (typeof module !== 'undefined') module.exports = TallyStorage;
