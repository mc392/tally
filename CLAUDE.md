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
- `node tests/migration.test.js` - a v1 file migrates and projects **identically** to the frozen pre-v2 engine (`tests/fixtures/engine-v1.js`, never edit it), then dated flows, per-person ISAs, access and pensions.
- `node tests/lifeevents.test.js` - the roadmap's done-when for 1.5: baby template months, off = identical projection, shifted = created later, scale and contingency, every template builds valid lines.
- `node tests/readiness.test.js` - the ladder at the fix end and its reconciliation to net worth, moving a spend across the fix end, a bond that locks money up, glide path and target, earliest part wins; all worked by hand.
- `node tests/options.test.js` - annuity to the penny, overpayments against an independent month-by-month amortisation, fee added accrues interest, household = amortise, comparison = each scenario on its own, per-scenario events and option.
- `node tests/storage.test.js` - encryption round trip, wrong passphrase, tampering, IV reuse, conflict rules.
- `node tests/browser.test.mjs` - the real app in headless Chromium (needs `npm i --no-save playwright`): live save, picking up another device's save, refusing to overwrite it, encryption on, reopening, unlocking on a new device, no CSP violations. Uses a fake file handle, never a real file.
- `sw.js`'s `CACHE` must be bumped when a shell file is added or renamed.

## Data file shape (version 5, Sep 2026)
`model.js` owns the shape: `TallyModel.migrate()` upgrades any older file on open (`normalise()` calls it first), and the file on disk only changes when it is next saved. `engine.js` only ever sees the current version. **A change to the shape means bumping `VERSION`, adding a step to `migrate()`, and a test in `tests/migration.test.js`.**
`people[]`, `accounts[] {id,name,owner,type,rate,active,note,access?,noticeDays?,maturity?,flexible?}`, `snapshots[] {date, balances{accountId: amount}}` (liabilities negative),
`flows[] {id,name,kind:'income'|'spend'|'oneoff',amount,start,end,category,owner,inflates,growth,bundle,on,linked?,settles?}`, `bufferPct`,
`bundles[] {id,name,template,start,on,scale,contingency}` (v3, life events),
`remortgageOptions[] {id,partId,name,type,rate,fixMonths,fee,feeAdded,lump,regular,capPct,termMonths,afterRate}` (v5),
`mortgage {propertyValue, parts[] {id,name,payment,balance,rate,fixEnd,newRate,termEnd}}`,
`rules {cashFloor,isaPerPerson,isaUsedBy{personId:£},isaFillOrder[],isaUsedTaxYear,sweepToSS,remortgage{leadMonths,decideMonths,earmarkMonths,warnAt,glide,glideMonths,target}}` (remortgage: v4), `scenarios{key:{name,growth,ssReturn,inflation,payRise,option,bundles{},rateShift}}` (plan fields: v5), `scenario`, `horizonMonths`.
- **Flows** replaced v1's `income[]`, `spending[]` and `events[]`. Income and spend amounts are **monthly and positive**; a one-off is the total, **signed** (− = money out) and happens in its `start` month. `start`/`end` are `'YYYY-MM'` or null; `TallyModel.flowActive(f, k)` is the only test of whether a flow counts in a month. `monthlyBudget(data, 'YYYY-MM')` is the regular budget for one month (one-offs excluded). `linked:'mortgage'` on a spend flow is how the mortgage enters spending. `bundle` names the life event a flow belongs to.
- **A newer file is refused.** `loadText()` will not open a file whose `version` is above `TallyModel.VERSION`: an out-of-date copy of the app (the service worker serves the cached one first) would drop what it does not know about and save the loss back.
- **ISA allowance is per person** (`isaPerPerson`, default £20,000), filled in `isaFillOrder` - the first person's allowance is used up before the next person's (decided with Matt). The Joint person (`id:'J'`) never holds an ISA. Migration splits the old household figure evenly and puts what was already used against people in fill order, which keeps every projected figure identical. Re-deposit room is still tracked for the household, and every cash ISA is treated as flexible in the projection; `accounts[].flexible` is recorded for Phase 1 readiness but not yet used by the engine.
- **Access** (`instant|notice|fixed|invested|locked`, labels in `TallyModel.ACCESS`): defaulted by type on migration; liabilities have none. Recorded now, used by the Phase 1 readiness ladder.
- **Pension** is an account type (pool `other`, grows at its own rate like savings, access `locked`).
Account types: ss_isa, cash_isa, savings, current, pension, card, card_0, tax. Cash pool = current + card. ISA pot = ss_isa + cash_isa.

## Remortgage readiness (Phase 1.1-1.3, Sep 2026)
- **`readiness(data, scenario, 'YYYY-MM')` in `engine.js` is the one answer** to "what will be free at the remortgage". It works towards the **earliest** mortgage part's fix end still to come (decided with Matt); later parts are listed and get their turn when that one passes. "At the fix end" = balances at the end of the month **before** the switch month.
- **Available to overpay = instant + within weeks − cash floor − earmarks.** Earmarks are the positive `rows[].earmark` of the `earmarkMonths` (12) months from the switch: one-off payments out, plus life-event costs and life-event pay drops. S&S ISAs are shown (every scenario, and markets −20%) but never counted as available.
- **`rows[].byAccess` {instant, notice, invested, fixed, locked, debts} adds up to `net` every month** - there is a test. A fixed account counts as instant from its maturity month. Liabilities (cards, tax) are `debts`.
- **Cash ISAs marked fixed or notice are held apart** (`heldIsa`): never drawn on to top up the floor, grow at their own rate, and a fixed one joins the ordinary cash ISA pool when it matures. Every migrated cash ISA is instant, so existing figures do not move. `isaCash` in a row still includes them; `isaCashFlex` is the drawable pool.
- **Glide path and target (1.3)** act only on the S&S share of top-ups before the fix end: glide sends none to S&S in the last `glideMonths`; a target lets S&S take only what is left once available would still reach the target. Neither moves money that is already invested.
- **Warnings (1.2):** `checkLeak()` runs in every `changed()`, compares available with the figure before the change, and raises `ui.leak` (the orange chip) when it drops by more than `warnAt` (£5,000). It uses the default scenario, not the one being viewed.

## Remortgage deals and whole-plan scenarios (Phase 1.4, 1.6, Sep 2026)
- **`amortise(option, balance, months)` is the pure maths** of one deal: annuity payment on (balance − lump + fee if added), rate for the fix then `afterRate`, regular overpayments capped at `capPct` % of the balance at the start of each deal year. `project()` applies **the same rules** to a part from its fix end when the scenario's `option` names a deal for that part - there is a test that the two agree month by month. Lump sum, an upfront fee and overpayments leave cash as `rows[].dealCash` (they are not spending, so no buffer on them).
- **An option with no `termMonths` runs over what is left of the part's term** (`termEnd − fix end`) in both the household projection and `rateGrid()`. Keep those consistent.
- `compareOptions()` runs "Do nothing" (the part's own rate after the fix) and each deal for the earliest-fixing part through `projectAs()` - the household projection with scenario settings changed, never touching `data` - so every figure on Compare deals is what that scenario would show on its own.
- **A scenario is a whole plan (1.6):** assumptions + `bundles` (per-scenario on/off, absent = the event's own switch; `TallyModel.bundleOn`) + `option` + `rateShift` (added to tracker rates and rates after a new fix only - never to an existing part's own reversion rate, so existing figures do not move). `effectiveFlows(data, sc)` takes the scenario.
- Compare plans overlays up to three scenarios: net worth, cash, and `availableSeries()` (available to overpay if the switch were that month), with a difference table at the fix end, +1 and +3 years.

## Life events (Phase 1.5, Sep 2026)
A life event is a **bundle**: a row in `bundles[]` plus ordinary flows carrying `bundle: id`, with real dates.
- **`TallyModel.effectiveFlows(data)` is the one place bundles are applied** - an event that is off drops all its lines, `scale` multiplies every line, `contingency` % is added to its costs (spend, and one-offs that are money out). `project()` and `monthlyBudget()` both read through it; anything new that totals flows must too.
- **A drop in pay is a NEGATIVE income line** in the event (e.g. parental leave: pay during leave − usual pay). That is what makes switching the event off restore usual pay exactly, without touching the ordinary pay line. `payDip()` in `templates.js` writes it from the person's usual pay in the start month.
- **Shifting** an event (`shiftBundle`) moves its start and every line's start/end by the same months; changing *Starts* on the event's page does this.
- `templates.js` (`TallyTemplates`) is pure: each template has `fields(ctx)` in the form-sheet shape, `defaults(ctx)` and `build(params, ctx)` returning lines with **offsets** from the start month; `applyTemplate()` turns them into dated flows. Every amount is a placeholder, and anything that depends on a government rate (Child Benefit and the High Income Child Benefit Charge, childcare funded hours, statutory pay, stamp duty) carries a note to check gov.uk rather than a figure presented as fact. Stamp duty is entered by the user, not calculated - bands change and differ by nation.
- The property template does **not** change the mortgage parts; it records the payment change as a cost and says so.
- Life-event lines are kept off the ordinary Plan lists and one-offs page; they live on the event's own page (`bundle:id`). Each month's `rows[].bundleNet[id]` is the event's net effect that month, which reconciles exactly to its effect on net worth (with no buffer); the month detail lists it and the projection charts shade each event's span.
- Adding from a template is three sheets: pick → answer its questions → **review every line** (each can be changed or left out). Nothing is written until the last Save.

## Mortgage parts (Sep 2026)
A mortgage is a list of **parts** (UK sub-accounts: e.g. the original loan plus a further advance), each with its own payment, balance, rate, fix and term; `propertyValue` stays on the mortgage because there is one home.
- **Older files hold one flat mortgage.** `normalise()` turns it into a single part (`id:"main"`) and moves `propertyValue` up; `engine.js`'s `mortgageParts()` reads the flat shape too, so the engine works on either. Always go through `mortgageParts()` / `mortgageTotals()`, never `data.mortgage.payment`.
- Each part runs on its own in `project()`: interest at its rate, a payment recalculated by annuity when *its* fix ends. `rows[].mortgageParts` has the per-part figures; the old `mortgagePay/Interest/Bal` are the totals.
- **One behaviour change:** a part whose balance reaches zero now stops costing anything, so its payment leaves the spending. Before, a paid-off mortgage kept charging its payment for ever. For every mortgage not paid off within the horizon the figures are identical to the previous engine (checked on 20,880 figures across six single-mortgage cases over 120 months).
- The mortgage is only counted in spending through a spending line with `linked:"mortgage"`, as before.
- With one part the screen shows its details as it always did; the list appears from the second part on, and the original is named "Part 1" at that point.
- `node tests/mortgage.test.js` - expectations worked out by hand from the rule.

## Switches
`.switch span` has `pointer-events:none` so a tap reaches the checkbox beneath it. Before Sep 2026 it did not, and tapping any switch in the app did nothing. Tests click the `input`, never the span.

## Projection rules (from the original spreadsheet)
Monthly: cash + surplus + one-off items. Above the cash floor → sweep into ISAs up to (new allowance + flexible re-deposit room). Below → withdraw from ISAs (cash ISAs first); withdrawals add re-deposit room for the rest of that tax year. Allowance resets each April. Growth optional per scenario.

## Roadmap
**`docs/ROADMAP.md` is the build plan** - phases 0 to 5, each feature with a "done when" list that doubles as its tests. Its *Decisions* section (28 Sep 2026) overrides the text below it: life events before readiness in Phase 1, remortgage against the earliest part's fix end, ISA top-ups fill one person first, OneDrive dropped in favour of the iCloud iPhone app, and everything web-only is built before the Apple setup. Mark items done in that file as they land.
