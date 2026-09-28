// Run with:  node tests/storage.test.js
// Checks the encryption and the "who saved last" rules in storage.js. Synthetic data only.
const assert = require('assert');
const TS = require('../storage.js');

const FAST = 1000; // PBKDF2 rounds for the test; the app uses TS.ITERATIONS
const sample = { app: 'tally', version: 1, accounts: [{ id: 'a1', type: 'current' }], snapshots: [{ date: '2026-01-01', balances: { a1: 1234.56 } }], note: 'café £ ✓' };
const mark = (device, rev) => ({ device, label: 'Test', rev, at: '2026-09-28T12:00:00.000Z' });

(async () => {
  // --- encryption round trip ---
  const s = await TS.deriveSeal('correct horse battery', undefined, FAST);
  const env = await TS.seal(sample, s, mark('pc', 3));
  assert.ok(TS.isEncrypted(env), 'sealed file is recognised as encrypted');
  assert.ok(!TS.isEncrypted(sample), 'plain file is not');
  const text = JSON.stringify(env);
  assert.ok(!text.includes('1234.56') && !text.includes('current') && !text.includes('café'), 'no figures or labels readable in the file');
  assert.deepStrictEqual(env.writer, mark('pc', 3), 'writer mark readable without the passphrase');
  assert.deepStrictEqual(await TS.unseal(env, s), sample, 'same seal opens it');

  // Another device: derive from the passphrase plus the salt stored in the file
  const s2 = await TS.sealFor('correct horse battery', JSON.parse(text));
  assert.ok(TS.sealFits(env, s2), 'derived seal matches the file');
  assert.deepStrictEqual(await TS.unseal(env, s2), sample, 'passphrase opens it on another device');

  // Wrong passphrase and tampering both fail loudly, never produce data
  const bad = await TS.sealFor('wrong horse battery', env);
  await assert.rejects(TS.unseal(env, bad), e => e.name === 'WrongPassphrase', 'wrong passphrase rejected');
  const ct = Buffer.from(env.ct, 'base64'); ct[5] ^= 1;
  await assert.rejects(TS.unseal({ ...env, ct: ct.toString('base64') }, s), e => e.name === 'WrongPassphrase', 'tampered file rejected');

  // Fresh IV each save: sealing the same data twice gives different files
  const env2 = await TS.seal(sample, s, mark('pc', 4));
  assert.notStrictEqual(env2.iv, env.iv, 'IV not reused'); assert.notStrictEqual(env2.ct, env.ct, 'ciphertext differs');
  assert.strictEqual(env2.kdf.salt, env.kdf.salt, 'salt kept, so the passphrase still opens it');
  const other = await TS.deriveSeal('correct horse battery', undefined, FAST);
  assert.ok(!TS.sealFits(env, other), 'new salt = different key, prompts again');

  // --- conflicts ---
  assert.strictEqual(TS.isConflict(null, null), false, 'old file with no mark: never a conflict');
  assert.strictEqual(TS.isConflict(null, mark('pc', 2)), false, 'mark removed (old build saved): not a conflict');
  assert.strictEqual(TS.isConflict(mark('pc', 2), mark('pc', 2)), false, 'file is what we last saw');
  assert.strictEqual(TS.isConflict(mark('phone', 3), mark('pc', 2)), true, 'another device saved since');
  assert.strictEqual(TS.isConflict(mark('pc', 3), mark('pc', 2)), true, 'this device saved in another tab since');
  assert.strictEqual(TS.isConflict(mark('pc', 1), null), true, 'we never read this file but it has history');

  // --- next mark ---
  const n = TS.nextWriter(mark('phone', 7), mark('pc', 4), { id: 'pc', label: 'Windows PC' });
  assert.strictEqual(n.rev, 8, 'counter moves past both'); assert.strictEqual(n.device, 'pc'); assert.strictEqual(n.label, 'Windows PC');
  assert.strictEqual(TS.nextWriter(null, null, { id: 'x', label: 'y' }).rev, 1, 'first save is 1');

  // The real work factor is what the app uses
  assert.ok(TS.ITERATIONS >= 600000, 'PBKDF2 rounds at OWASP level');
  console.log('All storage checks pass ✓');
})().catch(e => { console.error(e); process.exit(1); });
