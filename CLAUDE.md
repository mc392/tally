# Notes for Claude Code

## Owner
Matt is new to software engineering but works in accounting/finance risk: explain every step plainly, don't skip steps, but technical detail is welcome. Explain any terminal command before asking him to run it.

## Principles
- **The repository is PUBLIC (Sep 2026). Never commit real financial data** - not in tests, fixtures, screenshots, docs or commit messages. Data lives in the user's `family-finances.json` in iCloud Drive / OneDrive, which `.gitignore` blocks. Tests use made-up households with round numbers; a check that genuinely needs real figures goes in `tests/private/`, which is gitignored and never leaves the user's machine. Real figures were once in `tests/engine.test.js` and were removed by rewriting history - don't reintroduce anything shaped like them.
- No build step, no framework: plain HTML/CSS/JS served by GitHub Pages. Keep it that way unless there's a strong reason.
- iOS-native look: system font, inset grouped lists, large titles, bottom tab bar, bottom sheets. Main screen stays simple; detail lives one tap deeper.
- `engine.js` is pure maths with no DOM access. Any change to projection logic must keep `node tests/engine.test.js` passing, or update the test with a written reason.
- **Tally talks to no server but its own.** The Content-Security-Policy in `index.html` makes the browser enforce it. No inline scripts or `onclick=` attributes (the policy blocks them); no third-party scripts, fonts or APIs.

## Storage (`storage.js`, Phase 1 - Sep 2026)
All reading and writing of the finance file goes through `storage.js`; `app.js` asks it for a route and never touches a file API directly.
- **Routes.** `live` = Chrome/Edge on a computer holding a file handle with permission: every `changed()` autosaves 1.2s later. `reconnect` = the handle survived a reload (it is kept in IndexedDB) but the browser wants one tap to grant write access again. `manual` = everything else (iPhone share sheet, download). Phase 2 adds a `native` route here for the iOS shell.
- **Writer mark.** Every save stamps `writer {device, label, rev, at}` on the file; `meta.base` is the mark this device last read or wrote. Before a live write the file is read back, and `isConflict(fileWriter, base)` refuses to write over a mark it has not seen - the header shows *File changed* and the sheet offers load-theirs or overwrite. A file with no mark (older files) is never a conflict. Manual routes cannot read back, so they cannot check. `syncFromFile()` loads a newer file on start and when the app returns to the front, but only if nothing here is unsaved.
- **Encryption.** Optional. AES-GCM-256, key from PBKDF2-SHA256 at 600,000 rounds, fresh 12-byte IV on every save, salt in the file. The envelope is `{app, format:"tally-encrypted", v, kdf, iv, ct, writer}` - the writer mark is outside the sealed part so a conflict is spotted without decrypting. The key is a **non-extractable** `CryptoKey` kept in IndexedDB (`seal`), so the passphrase is asked once per device. There is no recovery: a forgotten passphrase means an unreadable file, and the UI says so.
- **The working copy on the device (localStorage `tally.v1`) is not encrypted.** Encryption protects the copy that leaves the device. Phase 3 may lock the working copy behind Face ID.
- `edits` counts changes so one made while a save is in flight is not marked saved.

## Tests
- `node tests/engine.test.js` - projection maths against the spreadsheet's rules, on a made-up household; every figure worked out by hand, month by month (allowance, floor, withdrawal, re-deposit room, April reset).
- `node tests/mortgage.test.js` - mortgage parts, also worked by hand.
- `node tests/storage.test.js` - encryption round trip, wrong passphrase, tampering, IV reuse, conflict rules.
- `node tests/browser.test.mjs` - the real app in headless Chromium (needs `npm i --no-save playwright`): live save, picking up another device's save, refusing to overwrite it, encryption on, reopening, unlocking on a new device, no CSP violations. Uses a fake file handle, never a real file.
- `sw.js`'s `CACHE` must be bumped when a shell file is added or renamed.

## Data file shape (version 1)
`people[]`, `accounts[] {id,name,owner,type,rate,active,note}`, `snapshots[] {date, balances{accountId: amount}}` (liabilities negative),
`income[] {name,owner,monthly,growth}`, `spending[] {name,category,annual,inflates,linked?}`, `bufferPct`,
`events[] {name,amount,date,on,settles?}`, `mortgage {propertyValue, parts[] {id,name,payment,balance,rate,fixEnd,newRate,termEnd}}`,
`rules {cashFloor,isaAllowance,isaUsed,isaUsedTaxYear,sweepToSS}`, `scenarios{key:{name,growth,ssReturn,inflation,payRise}}`, `scenario`, `horizonMonths`.
Account types: ss_isa, cash_isa, savings, current, card, card_0, tax. Cash pool = current + card. ISA pot = ss_isa + cash_isa.

## Mortgage parts (Sep 2026)
A mortgage is a list of **parts** (UK sub-accounts: e.g. the original loan plus a further advance), each with its own payment, balance, rate, fix and term; `propertyValue` stays on the mortgage because there is one home.
- **Older files hold one flat mortgage.** `normalise()` turns it into a single part (`id:"main"`) and moves `propertyValue` up; `engine.js`'s `mortgageParts()` reads the flat shape too, so the engine works on either. Always go through `mortgageParts()` / `mortgageTotals()`, never `data.mortgage.payment`.
- Each part runs on its own in `project()`: interest at its rate, a payment recalculated by annuity when *its* fix ends. `rows[].mortgageParts` has the per-part figures; the old `mortgagePay/Interest/Bal` are the totals.
- **One behaviour change:** a part whose balance reaches zero now stops costing anything, so its payment leaves the spending. Before, a paid-off mortgage kept charging its payment for ever. For every mortgage not paid off within the horizon the figures are identical to the previous engine (checked on 20,880 figures across six single-mortgage cases over 120 months).
- The mortgage is only counted in spending through a spending line with `linked:"mortgage"`, as before.
- With one part the screen shows its details as it always did; the list appears from the second part on, and the original is named "Part 1" at that point.
- `node tests/mortgage.test.js` - expectations worked out by hand from the rule.

## Projection rules (from the original spreadsheet)
Monthly: cash + surplus + one-off items. Above the cash floor → sweep into ISAs up to (new allowance + flexible re-deposit room). Below → withdraw from ISAs (cash ISAs first); withdrawals add re-deposit room for the rest of that tax year. Allowance resets each April. Growth optional per scenario.

## Roadmap (agreed next steps)
1. **Live save to iCloud Drive on iPhone** (agreed Sep 2026, replaces the earlier OneDrive/Graph plan). Phase 1 (done): `storage.js`, encryption, writer mark. Phase 2: a Capacitor iOS shell that loads this site from GitHub Pages (`server.url`, app-bound domains so the service worker works) plus one small Swift plugin - pick a folder once (security-scoped bookmark), read, write - exposed as a `native` route in `storage.js`. Built and signed ad hoc on GitHub Actions' macOS runners (no Mac, no TestFlight, no App Store Connect). Phase 3: Face ID for the passphrase via the Keychain; a bundled copy for offline starts. Pattern to copy: therapy-tracker's `GroundWorkRecordsFolder.swift`.
2. **Trading 212 balances** via its official API. Needs a tiny proxy (e.g. Cloudflare Worker) so the API key isn't in the web page and to get around browser CORS limits. It will also need that proxy's one address added to `connect-src` in the CSP - add exactly that, never a wildcard.
3. Per-person ISA allowances (£20k each) instead of a household figure.
4. Pensions and property as optional net-worth lines.
5. CSV import of past balances.
