# Tally roadmap

This is the build plan for Claude Code. Work through it phase by phase. Each feature lists why it matters, what Matt will see, how it works underneath, and a "done when" checklist that doubles as the tests.

**Ground rules for every phase**
- No real financial data in the repo. Tests use synthetic fixtures.
- `engine.js` stays pure maths. Every engine change comes with a test in `tests/`.
- The main screens stay simple. Detail lives one tap deeper.
- Data file changes go through a versioned migration (see Phase 0), so an old file always opens.
- Explain each step to Matt in plain language before asking him to run anything.

**Decisions agreed with Matt (28 Sep 2026)** - these override anything below that disagrees.
- **Order inside Phase 1: life events first.** 1.5 life events → 1.1 readiness → 1.2 warnings → 1.3 glide path → 1.4 option comparison → 1.6 scenario comparison → 1.7 precision. "Available to overpay" subtracts earmarked life-event costs, so it only means something once life events exist.
- **Remortgage works towards the EARLIEST fix end, per mortgage part.** The mortgage already has parts (built Sep 2026), each with its own fix end. Readiness counts down to the next part whose fix ends; the option comparison runs for that part. Later parts get their own readiness when they come up.
- **ISA top-ups fill one person first.** Each person has £20,000 a tax year. Top-ups go to the first person in a set order until their allowance is used, then to the next. The order is a setting. The Joint "person" never holds an ISA.
- **Phase 5.1 OneDrive sync is DROPPED.** Live saving is the agreed iCloud route: the small native iPhone app (Apple setup) plus Chrome/Edge writing straight to the file on a computer. The conflict detection 5.1 asks for is already built (the writer mark in `storage.js`).
- **Build as much as possible before the Apple setup.** Everything in Phases 0-4 is web-only and comes first; the iPhone app follows.
- **The "open questions for Matt" at the end are answered by Matt typing them into the app, never by putting them in this repo.** The repository is public; mortgage details, lender terms and balances are his data.

**Already built (not in the plan below, or ahead of it)**
- `storage.js`: live save on a computer, optional passphrase encryption of the file, the "file changed on another device" check, a Content-Security-Policy.
- Mortgage parts: a mortgage split into sub-accounts, each with its own rate, fix and term, projected separately.

**Market rates from yield curves (28 Sep 2026)** - built from the hand-off plan in `docs/YIELD_CURVES.md` (Steps 1-5; Step 6 optional, not started). Opt-in per account and mortgage part; "flat" reproduces the previous engine exactly.

**Priority order**
1. Phase 0: Foundations
2. Phase 1: Remortgage planner and life events (Matt's top priority)
3. Phase 2: Transactions and spend analysis
4. Phase 3: Analysis views
5. Phase 4: Risk and uncertainty
6. Phase 5: Sync and automation

---

## Phase 0: Foundations

> **Status: done (28 Sep 2026).** Data file v2 in `model.js`; a v1 file projects identically (13,920 figures checked against the frozen v1 engine). Also added: `pension` account type, a `flexible` flag on cash ISAs. Not yet: the engine still treats every cash ISA as flexible.

Phase 1 needs a richer data model. Doing this first avoids rewriting the engine twice.

### 0.1 Data file version 2 with migration
- Add `version: 2`. Write `migrate(data)` that upgrades v1 files on open. The original file is never changed until the user saves.
- **Dated flows.** Replace the separate `income`, `spending` and `events` shapes with one list of flows. Old data converts automatically.
  ```
  flows[]: {
    id, name, kind: 'income' | 'spend' | 'oneoff',
    amount,                 // monthly for income/spend, total for oneoff
    start, end,             // 'YYYY-MM' or null (open-ended)
    category, owner,
    inflates: bool, growth: %,
    bundle: bundleId | null, // which life event or decision it belongs to
    on: bool
  }
  ```
  This lets any cost or income start and stop on a date. Nursery fees from month 9 to month 48 and a salary drop during parental leave both become simple rows.
- **Account access.** Add `access` to each account:
  - `instant`
  - `notice` (with `noticeDays`)
  - `fixed` (with `maturity` date)
  - `invested` (can be sold, but the value moves with markets)
  - `locked` (pensions)

  Phase 1 uses this to show which money is genuinely available at a given date.
- **Per-person ISA allowances.** Replace the household figure with £20,000 per person per tax year. Keep the amount paid in so far for each person.

**Done when**
- A v1 file opens, migrates, and projects identical numbers. The existing spreadsheet test still passes.
- Saving writes v2. Opening v2 needs no migration.

---

## Phase 1: Remortgage planner and life events

The goal: arrive at the remortgage date with the right amount of accessible cash to make the best decision, without having accidentally spent it or locked it up in the meantime.

### 1.1 Remortgage readiness dashboard

> **Status: done (28 Sep 2026)**, towards the earliest part's fix end. Earmarks include life-event costs and pay drops as well as one-offs. Within-weeks (notice) money counts as available.
A new screen reached from Plan → Mortgage, pinned to the fix end date.

**What Matt sees**
- A countdown to the fix end, with three key dates marked on a timeline:
  - when a new deal can usually be secured (typically 3 to 6 months before; the lead time is a setting)
  - the decision date
  - the switch date
- A **liquidity ladder** projected to the fix end date, grouped by how quickly each pot could be used:
  - Instant: current accounts, instant-access savings, flexible cash ISAs
  - Within weeks: notice accounts
  - Sellable, but at market value: S&S ISAs, shown in all three scenarios and a "markets −20%" case
  - Not available: fixed bonds maturing after the date, pensions
- **Available to overpay.** This is the accessible cash at the fix end, less the cash floor, less anything earmarked in the following 12 months (known big spends, life events).
- A plain-English verdict. For example: "On current plans you'll have £62k free at fix end. The garden and course payments take £25k before then."

**How it works**
- The engine returns the balance of each account class at every month end, not just totals.
- "Earmarked" means the sum of switched-on one-off and life-event outflows in a window after the fix end. The window length is a setting, 12 months by default.

**Done when**
- The ladder at the fix end reconciles to the projection's month-end balances for that month.
- Moving a big spend from before the fix end to after it changes "Available to overpay" by exactly that amount, less its effect on earmarks.

### 1.2 Lock-up and leakage warnings

> **Status: done (28 Sep 2026).** One chip for any change, not a chip per field: the check runs after every save.
Stops money being tied up or spent before the decision point without Matt noticing.

**What Matt sees**
- A warning chip on any change that reduces accessible cash at the fix end by more than a threshold (default £5k). Examples:
  - adding a fixed-rate bond that matures after the date
  - adding a big spend
  - changing the ISA top-up split towards S&S
- Each warning shows the before and after figures for "Available to overpay".

**How it works**
- Recompute readiness on every edit, then compare it with the value before the edit.

**Done when**
- Adding a 2-year bond with money needed at a fix end 18 months away raises a warning showing the correct amount.

### 1.3 Glide path before the remortgage

> **Status: done (28 Sep 2026).** Both rules act on the S&S share of top-ups only.
An optional rule that changes how the projection saves as the decision nears.

**What Matt sees**
- A setting: "In the N months before fix end, stop sweeping into S&S ISAs and hold new savings as cash ISA or instant cash." Default N is 12.
- A second setting to target a specific overpayment pot, such as "have £50k ready". The projection then sweeps less into ISAs, or only into flexible cash ISAs, until the target is met.
- The readiness screen shows whether the target is met, and by which month.

**How it works**
- New engine rules: `preRemortgageMonths` and `overpayTarget`. During the glide path, top-ups go 100% to flexible cash ISAs, which can be withdrawn and replaced within the tax year.

**Done when**
- With a target set, accessible cash at the fix end is at least the target, whenever surplus allows.
- If it can't be met, the screen shows the shortfall and the month it clears.

### 1.4 Remortgage option comparison

> **Status: done (28 Sep 2026).** "Do nothing" (the part's rate after the fix) is always a column. The overpay-or-keep-cash comparison uses each deal's rate against the weighted cash ISA rate.
Put two to four options side by side at the decision point.

**Inputs for each option**
- product type: fixed or tracker
- rate
- fix length
- arrangement fee, and whether it's paid upfront or added to the loan
- lump-sum overpayment at switch
- regular overpayments during the new fix, capped at the lender's penalty-free allowance (often 10% a year; a setting)
- remaining term, including the option to shorten it
- a rate path for trackers or after the fix, taken from the scenario

**Outputs over a chosen comparison window** (e.g. 5 years), for each option
- monthly payment
- total interest
- total cost including fees
- mortgage balance at the end of the window
- accessible cash at the end of the window
- net worth at the end of the window
- lowest cash month

**The key comparison: overpay or keep the cash?**
- Show the break-even between paying off debt at the mortgage rate and keeping cash in a cash ISA at its rate. Both are effectively tax-free, so the rates compare directly.
- Also show the liquidity cost: money used to overpay can't be taken back out.

**Rate sensitivity grid**
- New payment and 5-year cost at the assumed rate, ±0.5%, and ±1%.

**Done when**
- Each option's payment matches a standard repayment (annuity) calculation to the penny.
- Overpayments reduce the balance and interest exactly as a month-by-month amortisation would.
- Fees added to the loan accrue interest.

### 1.5 Life events library

> **Status: done (28 Sep 2026).** Built first, as agreed. All seven templates; review before save; toggle, shift, scale, contingency; shaded bands; month-detail section. Stamp duty is entered, not calculated from bands (bands differ by nation and change) - revisit if wanted. Dragging a start date is an edit of the month, not a drag.
Pre-built, editable templates that add a bundle of dated flows in one go. Each bundle can be switched on and off, shifted in time, and scaled.

**What Matt sees**
- Plan → "Life events" → "Add from template". Pick one, set a start date, and review every line before saving.
- The bundle appears on the projection charts as a shaded band, and in the month detail as its own section.
- One toggle includes or excludes the whole bundle. Dragging its start date moves every line with it.

**Templates to ship.** Every amount is a placeholder for Matt to edit; the app never presents them as advice.
- **Baby**
  - one-off costs before and after birth (kit, pram, nursery room)
  - a parental leave income change: reduced pay for each parent over a chosen number of months, with fields for enhanced or statutory pay
  - monthly costs in stages (0–1, 1–3, 3–5, 5+ years)
  - childcare from a chosen month, with hours and rate, and optional funded-hours offsets
  - Child Benefit, with a flag reminding Matt to check the High Income Child Benefit Charge thresholds on gov.uk
  - a buffer %
- **Property purchase or move:** deposit, stamp duty (rate bands entered as a setting, not hard-coded), legal and survey fees, moving costs, a new mortgage, a change in running costs, and an optional sale of the current home.
- **Renovation:** a staged spend over months, with a contingency %.
- **Car:** purchase or finance, running costs, and a replacement cycle.
- **Wedding or big trip:** a one-off spend with a savings run-up.
- **Career change or sabbatical:** an income change for a period, with a restart date.
- **Custom:** a blank bundle.

**How it works**
- A template is a JSON definition of flows with offsets relative to a start date (e.g. `startOffset: 9, months: 36`).
- Applying a template turns it into real dated flows tagged with a `bundle` id.

**Done when**
- Shifting a bundle by 6 months shifts every flow by 6 months.
- Switching a bundle off gives an identical projection to one without it.
- The baby template's income dip and childcare start show in the correct months.

### 1.6 Scenario comparison

> **Status: done (28 Sep 2026).** Up to three plans; a plan can switch life events on or off for itself without changing them elsewhere, and adds a rate change for trackers and post-fix rates.
Compare whole plans, not just growth assumptions.

**What Matt sees**
- A scenario becomes: assumptions + which bundles are on + which remortgage option is chosen.
- A "compare" view overlays two or three scenarios on the cash, net worth and "available to overpay" charts, with a difference table at key dates: fix end, +1 year, +3 years.
- An example comparison: "Baby in 2027, 5-year fix, £40k overpay" against "Baby in 2028, 2-year fix, no overpay".

**Done when**
- Every compared figure matches running that scenario on its own.

### 1.7 Short-to-mid-term precision

> **Status: done (28 Sep 2026).** Recalibration arrived with Phase 2: the last three complete months against plan, flagging over 10%. The calendar is a list of months, each opening an editable sheet, rather than a months × flows grid - a grid with a column per flow does not fit a phone. Drift splits the difference by cash / ISAs / other, and says what each could mean; it cannot yet say "spending £2.1k over" without transactions.
The period up to the remortgage decision needs the most accuracy.

- **Cash-flow calendar.** A 24-month grid of months (rows) by flows (columns). Every cell can be edited, so known one-offs can be dropped into exact months.
- **Recalibration from actuals.** Once Phase 2 is live, compare the planned monthly surplus with the rolling 3-month actual surplus. Offer to adjust the plan, and flag if actual spend runs more than 10% over plan.
- **Plan vs actual drift.** Each balance update is compared with what the projection expected for that date. The difference is shown and explained (e.g. "£3.2k behind plan: spending £2.1k over, markets −£1.1k").

---

## Added 28 Sep 2026: balances per account
> **Status: done.** Asked for by Matt after Phase 4. Each account has its own dated balances; in between, savings follow their interest rate plus money recorded in or out, current accounts and cards follow their transactions, everything else a straight line. A balance can be added for one account on its own, and savings can be left to roll forward. Checks flag any move between balances that transactions or interest don't explain, and ask for S&S returns to be cross-checked. Money in and out can be entered by hand. Lloyds imports record the statement's own balances.
>
> **Also done:** interest rates are kept by date - a new rate applies from its date, and every earlier period keeps the rate it had. Account pickers show the full name, whose it is and the type; accounts with the same name show the owner everywhere.
>
> **Also done:** a full balance update can leave any account out with a tick; history charts start at your first own update and count each account only from its first balance; Spending insights - spending, money in, or both, by month and by category, shop or account, over 3, 6 or 12 months, the tax year or everything, with what's changing, the largest items and the transactions behind every figure.

## Phase 2: Transactions and spend analysis

### 2.1 CSV import

> **Status: Lloyds, Amex and map-the-columns done (28 Sep 2026).** Monzo and Trading 212 wait for a real export to confirm their layout. Transactions stay in the main (encrypted) file: a year of both accounts is well under 100KB, so no companion file yet.
- An importer for each format: Monzo, Amex, Lloyds, Trading 212, plus a generic "map the columns" option for anything else.
- Detect the format from the header row. Skip duplicates using a hash of date + amount + description + account.
- Transactions are stored in the data file as `transactions[] {id, account, date, amount, description, merchant, category, flowId}`.
- If the file grows too large, move transactions into a companion file (`family-finances-transactions.json`) in the same folder.

**Done when**
- Importing the same CSV twice adds nothing.
- Each bank's sample file (synthetic) parses correctly.

### 2.2 Categorisation rules

> **Status: done.** Rules are made from "all from this place" and apply to everything already imported. Amex's own categories map onto Plan categories.
- Rules take the form "description contains X → category Y", with an optional amount range.
- Correcting one transaction offers to create a rule and apply it to past matches.
- Monzo's own categories can be used as a starting point.
- Categories map onto Plan spending lines, so actuals line up with the budget.

### 2.3 Budget vs actual

> **Status: done**, by month, tax year so far and 12 months, with drill-down; one line on Overview.
- For each month and category: plan, actual, variance in £ and %, with drill-down to the underlying transactions.
- Year-to-date and rolling 12-month views.
- The main screen shows one line only, e.g. "September: £420 over plan". Everything else sits one tap deeper.

### 2.4 Recurring payments and subscriptions

> **Status: done.**
- Detect charges that repeat on a similar amount and cadence.
- Flag new ones, price rises, and any that have stopped.

### 2.5 Transfers between own accounts

> **Status: done**, within 5 days, across different accounts.
- Match equal and opposite amounts on nearby dates, so moving money between accounts isn't counted as spending.

---

## Phase 3: Analysis views

### 3.1 Where the net worth change came from

> **Status: done (28 Sep 2026).** Contributions to S&S ISAs and pensions are entered on the balance update (no investment-account transactions yet). Interest is estimated from each account's rate.
- Between any two balance updates, split the change into:
  - contributions (net money in)
  - investment growth (market movement)
  - interest
  - debt repayment
- Show a money-weighted return per investment account, using contributions from transactions where they're available, or entered manually otherwise.

### 3.2 Goals

> **Status: done.**
- A goal has a target amount, a date, and which accounts count towards it.
- Show on track / behind, the projected date it's reached, and the extra monthly saving needed.
- Goals appear as markers on the projection chart.

### 3.3 Tax-year view

> **Status: done.**
- ISA usage per person for the current tax year, with what's left.
- A nudge in February and March if allowance is going unused, alongside how much the projection plans to use.
- Flexible ISA re-deposit room shown separately.

### 3.4 Real-terms toggle

> **Status: done**, on the Projection screen.
- Switch any projection into today's money, using the scenario's inflation rate.

---

## Phase 4: Risk and uncertainty

### 4.1 Range of outcomes (Monte Carlo)

> **Status: done (28 Sep 2026)**, in a Web Worker, seeded. Cash rates are not varied yet.
- Run around 2,000 simulated paths, drawing monthly S&S returns from a distribution with the scenario's mean and a volatility setting (default 15% a year). Cash rates can optionally vary too.
- A fan chart shows the 10th, 50th and 90th percentiles.
- Key figures:
  - the probability of breaching the cash floor
  - the probability "available to overpay" at the fix end is below target
  - the range of net worth at the horizon
- Run the simulation in a Web Worker, so the screen stays responsive.

### 4.2 Named stress tests

> **Status: done**, all five.
- One-tap shocks on top of any scenario:
  - markets −25% next month
  - no bonus
  - rates +2% at remortgage
  - one income stops for 6 months
  - a large unexpected cost
- Each shows its effect on cash floor breaches and on readiness at the fix end.

---

## Phase 5: Sync and automation

### 5.1 ~~OneDrive auto-sync~~ - dropped, see Decisions. Replaced by the iCloud iPhone app below.
- **5.1 (replacement) iPhone app with live save to iCloud Drive.** A Capacitor shell that loads the GitHub Pages site, plus one Swift plugin: pick a folder once, then read and write the file there. Built and signed ad hoc on GitHub Actions' macOS runners - no Mac, no TestFlight. Then Face ID for the passphrase, and a bundled copy for offline starts. Pattern: therapy-tracker's `GroundWorkRecordsFolder.swift`.

The original 5.1 text, kept for the record:
- Use Microsoft Graph (Microsoft's free API) with a free app registration and a secure sign-in flow that needs no server (PKCE). Read and write one file in the app's own folder.
- Auto-save after each change, a few seconds after edits stop.
- Detect conflicts using the file's version marker: if the file changed elsewhere, offer to keep this version, keep the other, or view both.

### 5.2 Trading 212 balances
- Use the official Trading 212 API through a small proxy (e.g. a Cloudflare Worker), so the API key never sits in the web page and browser restrictions (CORS) are handled.
- A "Fetch" button fills the Trading 212 lines in the Update balances sheet.

### 5.3 Monzo direct connection
- Monzo's developer API for personal use pulls balances and transactions for Matt's own account. It likely needs the same proxy approach.

### 5.4 Open banking (investigate first)
- Test whether Enable Banking's free restricted mode covers Matt's UK banks before building anything. If it doesn't, stay with CSV import.

### 5.5 Balance reminders

> **Status: done**, as a calendar file.
- An optional reminder at the start of each month to update balances, created in the iPhone Reminders app or as a calendar file. No server needed.

---

## Open questions for Matt (ask when the phase starts)
- The fix end date and current mortgage details, to seed the readiness screen.
- The lender's overpayment allowance and early repayment charges.
- How the ISA split works between the two of you today.
- Which banks to support in the first CSV importer.
- Whether any savings are in fixed-term or notice accounts.
