# Market rates from yield curves

> **Status (28 Sep 2026): Steps 1-5 built. Step 6 (optional) not started.**
> The original hand-off plan is kept below unchanged; this box says how it landed in Tally and where it differs.

## How it fits Tally

| Plan | In Tally |
| --- | --- |
| Rate functions (4.1), variable model (4.3), fixed + rollover (4.4), calibration, scenarios (5) | `curves.js` (`TallyCurves`), pure, tested by `tests/curves.test.js` |
| `accountRate(item, month, curve, rateScenario)` (4.5) | `project()` in `engine.js` builds each modelled item's path once (`TallyCurves.path`) and reads it month by month; mortgage payments are worked out again whenever a part's rate changes |
| `rateModel` on each item (4.2) | `accounts[].rateModel` (savings, cash ISAs) and `mortgage.parts[].rateModel`, data file **version 11**. The current rate is still the account's dated `rates` (or the part's `rate`); a fixed account's fix end is its `maturity` (a part's `fixEnd`); a part's reversion rate is `newRate`. Nothing is stored twice. |
| No model = zero interest (4.2) | **Changed:** no model = the item's own entered rates, carried forward, exactly as before. The rates layer is opt-in per item ("Use market rates", or "Put them all on market rates"), so no existing figure moves by itself. |
| Rate scenarios (5) | `scenarios[k].rates {kind, …}`: market (default), shift, twist, flat, anchor, manual, history. **"Flat" is the old engine exactly** (every item at its entered rates) - the regression guard - and is also the fallback when no curve is to hand. |
| Pipeline (3.1-3.3) | `scripts/fetch-curves.mjs` + `scripts/boe.mjs` (no packages: reads the zip and the .xlsx with Node alone), run by `.github/workflows/rates.yml` at 13:17 UTC on weekdays. Writes `rates/curve-latest.json`, `rates/history/YYYY-MM-DD.json` and `rates/history/index.json`. A curve that fails `TallyCurves.validate` is not written and the run fails (GitHub emails the owner); the last good file stays. |
| App loading (3.4) | `loadCurve()` in `app.js` fetches `rates/curve-latest.json` from the app's own site (the Content-Security-Policy is unchanged), keeps a copy on the device for offline use. **The curve in use is saved in the finance file** (`rateBasis {source, asOf, curve, previous}`), so figures only move when you tap "Use the newer curve", and any projection can be re-run exactly. The one before is kept as `previous` for the "how expectations moved" line on the chart. |
| Screens (6) | Projection › Interest rates (and each scenario's page): the expected Bank Rate chart (market, this plan, the previous curve, today's Bank Rate), the curve's date and age badge, the plan's rate scenario, every account and part with its rule in words, margins for new fixes, and the pass-through suggestion. Each account and mortgage part: "In the projection", with its rate path and repricings marked. Month detail: "Interest rates" - each rate, the interest, "Repriced", and a tap for the workings. Compare deals: a 2- and 5-year fix priced from the market at the switch (tap to add as a deal); "overpay or keep the cash" uses the cash ISA rate averaged over the window. |
| Calibration (Step 5) | Margins: quoted rate (IADB, in the curve file) less today's market rate for the same length (`marginFor`). Pass-through: `estimatePassThrough` fits retail = a + b × Bank Rate(t − lag) for lags 0-6 and keeps the best; the pipeline runs it when an instant-access savings series is configured, and the app only ever shows it as a suggestion. |

## Decisions and deviations

- **Units.** The expected Bank Rate is the curve's instantaneous forward itself (an overnight rate compounded daily is the same figure to 0.01%). A new fix is priced as AER = e^(term rate) − 1 plus a margin in AER terms, as 4.1 says. So a +1% parallel shift moves a variable rate by exactly pass-through × 1%, and a repriced fix's *forward* by exactly 1% (its AER by e^(f+1%) − e^f, a hair more). The test states it that way.
- **Monthly growth.** The engine applies every rate monthly as rate ÷ 12, as it always has for every account. Using (1 + AER)^(1/12) only for modelled items would make "flat" differ from the old engine; consistency won.
- **Calibration base.** A variable item's spread is set against the scenario's *starting* curve (the market for shift / twist / anchor; the path itself for manual and history), so month 0 is the rate you entered under the market, and a shift moves every month including month 0. A month already past (lag reaching before the curve's date) reads today's figure, unshifted.
- **Known future changes are facts.** A dated rate change still to come on a variable account is used as entered; the model takes over from the last one, calibrated to it.
- **Rollover defaults.** Fixed savings and fixed mortgage parts default to *variable* after the fix (easy access / the lender's SVR, calibrated to "Rate after the fix"), which keeps today's access rules: money is free from the maturity month. *Refix* keeps it locked (and readiness shows that). *Close* pays a savings account into cash; a fixed cash ISA that closes joins the instant cash ISA pool instead, so it keeps its ISA wrapper.
- **A chosen remortgage deal wins.** When a scenario takes a deal for a part, the deal's rates apply from the switch, not the market path (a real offer beats a market-implied one). The scenario's `rateShift` is added to modelled trackers and new fixes, matching what it already meant for deals.
- **Series codes.** Only codes named in the plan are configured (`IUDBEDR`, `IUDSOIA`, `IUMBV34`). The others are left blank in `scripts/rates-series.json` until someone looks them up in the Bank's database; with none, a typical margin is used and the screen says "typical".
- **Nothing real is committed by hand.** The sandbox this was built in could not reach the Bank of England, so the parser is tested on a made-up workbook in the Bank's documented layout, and no curve file is shipped: the first real one appears when the workflow first runs. If the Bank's sheet layout differs, the run fails loudly rather than publishing something wrong.

## Still to do

- Step 6 (optional): investment returns linked to the short rate plus a premium (4.6); market-implied inflation from the breakeven curve, RPI less an adjustment (4.7); rate paths in the range of outcomes.
- Look up and fill in the remaining IADB series codes (5-year fix, SVR, instant-access and fixed-bond savings rates).
- Check the Bank of England's terms for reusing its data before the rates files are relied on publicly (section 9). The app credits "Source: Bank of England".

---

## The original plan: using GBP benchmark yield curves in projections

## Purpose
Today, a typical personal-finance projection applies one fixed annual rate to each account for ever. That is wrong in two ways:

1. **Variable rates move.** Instant-access savings, trackers and SVR mortgages follow Bank Rate. If the market expects Bank Rate to rise and then fall, the projection should follow that shape.
2. **Fixed rates end.** A fixed-rate bond or mortgage keeps its rate only until its fix ends. After that, it should be repriced at whatever a new product is likely to cost then, not carried on at the old rate.

This plan adds a **rates layer**. It takes the market's implied path for sterling interest rates from published benchmark curves, and uses it to give every account a month-by-month rate that respects any known fixed periods.

## Who this is for
This is a hand-off to whoever is building the app. It deliberately makes **no assumptions about the app's current state**. Where it refers to "accounts", "the mortgage" or "the monthly projection loop", it means whatever structures exist at the time.

- If a structure doesn't exist yet, build the minimum described here.
- Keep all rate maths in pure functions, separate from the user interface, with unit tests.
- Never put the user's personal financial data in the code repository. Public market data (the curves) is fine to commit.

---

## 1. Concepts the builder needs

| Term | What it means | What it's used for |
| --- | --- | --- |
| **Bank Rate** | The Bank of England's policy rate | The anchor for variable savings rates, trackers and SVRs |
| **SONIA** | The overnight rate banks actually pay each other; closely tracks Bank Rate | The rate the OIS curve is built on |
| **OIS curve** | Sterling overnight index swap curve. It shows the market-implied path of SONIA, and so of Bank Rate | **The primary input.** Its forward rates give the implied path of variable rates |
| **Instantaneous forward rate** f(t) | The market-implied overnight rate at future time t | Monthly variable-rate path |
| **Spot rate** y(T) | The average rate locked in today for a period of T years | Pricing today's fixed products |
| **Forward term rate** F(t, T) | The rate implied today for a fixed period starting at t and ending at T | Repricing a fix when it ends |
| **Nominal gilt curve** | Government bond yields | A cross-check. Slightly different from OIS; the Bank of England recommends OIS for this purpose |
| **Implied inflation curve** | Breakeven inflation (RPI-based) from index-linked gilts | Optional market-based inflation assumption |

**Important caveats to show in the app**
- Market-implied paths are **not forecasts**. They include a term premium (extra yield investors demand for locking money up longer), and they change daily. Label them "market-implied".
- The curve is a benchmark for wholesale rates. Retail rates are a margin above or below it, and variable savings rates usually pass on only part of each Bank Rate move, often with a delay. Section 4 covers how the app bridges this.
- Bank of England curve yields are **continuously compounded**, whereas retail products quote AER. Convert properly (section 4.1).

---

## 2. Data sources

### 2.1 Primary source: Bank of England yield curves (free)
- **What it is.** Daily estimated UK yield curves: nominal gilt, real gilt, implied inflation, and OIS. For each, the spreadsheets give spot rates and instantaneous forward rates. There is a "short end" segment in monthly steps out to about 5 years, and a standard segment with longer maturities.
- **Where.** https://www.bankofengland.co.uk/statistics/yield-curves
- **How often.** Usually published by noon the next business day.
- **How.** Excel workbooks inside zip files. **There is no API.**
- **Use.** The OIS curve (instantaneous forwards and spot rates) is the core input. The nominal gilt and implied inflation curves are optional extras.

### 2.2 Supporting source: Bank of England Statistical Database (free)
- **What it is.** Time series available as CSV from the Interactive Statistical Database (IADB) at https://www.bankofengland.co.uk/boeapps/database/. Data is downloaded by series code.
- **Series to use:**
  - Bank Rate: `IUDBEDR`
  - SONIA: `IUDSOIA`
  - Quoted mortgage rates: 2-year fixed at 75% LTV is `IUMBV34`; look up the 5-year fixed and SVR series codes in the database
  - Quoted savings rates: instant access and fixed-rate bonds (1-year, 2-year). Look up the exact series codes in the database rather than guessing them.
- **Use.**
  - Calibrate retail margins, e.g. the typical 2-year fix rate minus the 2-year OIS spot rate.
  - Estimate pass-through of Bank Rate into instant-access rates from history (section 4.3).
  - Sanity-check the curve's starting point against today's actual Bank Rate.

### 2.3 Cross-check source: Monetary Policy Report conditioning path
- Each quarterly Monetary Policy Report states the market-implied Bank Rate path the Bank used, built as a 15-day average of OIS forwards.
- **Use.** A quarterly sanity check, and a fallback if the daily pipeline breaks.

### 2.4 Commercial sources (optional, cross-check only)
- Some firms publish free SONIA forward curves on the web (e.g. BlueGamma, Chatham Financial). Paid terminals include Bloomberg and LSEG.
- **Check the terms of use before automating anything.** Use these only to eyeball the Bank of England data, never as the default feed.

### 2.5 Manual fallback
- The user can enter a few points by hand, for example the expected Bank Rate in 6 months, 1 year, 2 years and 5 years. The app interpolates between them.
- This must always work, even offline.

---

## 3. Data pipeline

The browser can't reliably fetch the Bank of England files directly: there's no API, the files are zipped Excel, and cross-site restrictions (CORS) block it. So the curves are **prepared ahead of time and served alongside the app**.

### 3.1 Scheduled fetch job
- Run a scheduled job, for example a daily **GitHub Actions** workflow on weekdays, or a small serverless function. It runs a Python or Node script that:
  1. Downloads the latest OIS zip (and optionally the gilt and inflation zips).
  2. Takes the **most recent date** in the short-end and standard sheets, for both spot and forward rates.
  3. Downloads the IADB CSV series from section 2.2.
  4. Validates everything (section 3.3).
  5. Writes the output files (section 3.2) and commits them to the repo, or publishes them to static hosting.
- Market data is public, so committing it is fine. **Never commit user data.**

### 3.2 Output files
`rates/curve-latest.json`
```json
{
  "source": "Bank of England OIS (nominal) curve",
  "asOf": "2026-09-25",
  "compounding": "continuous",
  "shortEnd": { "stepMonths": 1, "forward": [ /* f(1m), f(2m) … f(60m), % */ ], "spot": [ /* y(1m) … y(60m), % */ ] },
  "long":     { "tenorsYears": [5,6,7,8,9,10,15,20,25], "forward": [ ], "spot": [ ] },
  "anchors":  { "bankRate": 3.75, "sonia": 3.70, "asOf": "2026-09-25" },
  "quoted":   { "mortgage2yFix75": { "rate": 4.1, "month": "2026-08" }, "savingsInstant": { }, "savingsFix1y": { }, "savingsFix2y": { } },
  "inflation": { "tenorsYears": [ ], "breakeven": [ ] }
}
```
(The numbers above are placeholders.)

Also write one dated file per fetch, `rates/history/YYYY-MM-DD.json`. This means:
- a projection can be reproduced "as at" a past curve
- the app can show how market expectations have moved since the last review

### 3.3 Validation and fallback
- Reject a fetch if:
  - any rate is outside the range −1% to 15%
  - the date is older than the previous file's date
  - points are missing
  - the 1-month forward rate differs from SONIA by more than 0.5 percentage points
- On rejection, keep the last good file and record the failure.
- The app shows how old the curve is:
  - "Curve as at 25 Sep 2026"
  - Amber after 10 business days: "Curve may be out of date"
  - Red after 30 days, with a suggestion to use the manual path

### 3.4 In the app
- Load `curve-latest.json` from the app's own host at startup, and cache it for offline use.
- When the user saves a projection or scenario, record which curve it used in their data file: `rateBasis: { source, asOf }`. Optionally embed a copy, so the projection can be re-run offline.

---

## 4. Modelling rates in the projection

### 4.1 Core rate functions
All pure functions, all unit-tested. Time `t` is in years from the curve's as-at date.

- **`fwd(t)`: forward rate at time t.** Interpolate linearly on the monthly short-end grid up to 5 years, then on the long grid. Beyond the last tenor, hold flat or blend to an anchor (section 5).
- **`monthRateCC(t0, t1)`: the continuously compounded rate for one projection month.** It is the average of the forward rate between the start and end of the month.
- **`termRateCC(t, n)`: the forward rate for an n-year period starting at t.** It is the average forward rate over the period from t to t + n.
- **Converting to what customers see.** AER = e^(r_cc) − 1. The monthly growth factor is e^(r_cc/12). Retail margins are applied in AER terms, then converted back to a monthly factor.
- **Check.** With a flat curve at 4% continuous, every function must return 4%, and the AER must be about 4.081%.

### 4.2 A rate model for every interest-bearing item
Attach a rate model to each savings account, cash ISA, loan and mortgage. Stocks & shares investments are optional (section 4.6).

```
rateModel: {
  kind: 'fixed' | 'variable' | 'tracker' | 'none',
  rate: 4.20,              // current rate, AER (or the mortgage's quoted rate)
  fixEnd: '2027-03',       // fixed only
  rollover: {              // what happens when a fix ends
    kind: 'refix' | 'variable' | 'manual' | 'close',
    termMonths: 24,        // refix: length of the new fix
    margin: null,          // refix: spread over the forward term rate; null = calibrate (4.4)
    manualRate: null
  },
  passThrough: 0.6,        // variable only: share of each Bank Rate move passed on
  lagMonths: 2,            // variable only: delay before a move is passed on
  floor: 0,                // variable only: rate can't fall below this
  spread: null             // variable/tracker: null = calibrate so month 0 equals `rate` (4.3)
}
```
If an item has no rate model, treat it as `kind: 'none'` (zero interest). Also offer a one-tap "use market rates" upgrade that sets sensible defaults for its type.

### 4.3 Variable products (instant access, SVR, most easy-access cash ISAs)
For each projection month m:
```
expectedBankRate(m) = fwd at the middle of month (m − lagMonths)
rate(m) = max(floor, spread + passThrough × expectedBankRate(m))
```
- **Calibration.** Set `spread = currentRate − passThrough × current SONIA`. The first month then reproduces today's actual rate exactly, and later months move with the curve.
- **This is the fix for "accrues at one rate forever".** If the curve rises then falls, the account's rate rises then falls with it, dampened by the pass-through and delayed by the lag.
- **Default settings** (editable, and shown to the user):
  - instant-access savings: pass-through 0.6, lag 2 months
  - trackers: pass-through 1.0, lag 0–1 month
  - SVR: pass-through 0.9, lag 1 month
- **Advanced option.** Estimate pass-through and lag by regressing the historical IADB instant-access quoted rate on Bank Rate. Show the estimate as a suggestion; never apply it silently.

### 4.4 Fixed products (fixed bonds, fixed cash ISAs, fixed mortgages)
- **Before the fix ends:** use `rate` exactly as entered. Known facts beat market data.
- **When the fix ends,** follow the rollover rule:
  - **`refix`:** the new rate = the forward rate for the new fix period starting at the fix end date, **plus a margin**. It stays fixed for `termMonths`, then rolls again. Each repricing is logged so the user can see it.
  - **`variable`:** switch to the variable model in 4.3. This covers a bond that matures into easy-access, or a mortgage that lapses onto SVR.
  - **`manual`:** use `manualRate` (e.g. an offer already in hand).
  - **`close`:** the balance moves into cash on the maturity date, for example to model a lump sum used at a remortgage.
- **Working out the margin when it's left blank:**
  - Mortgages: margin = today's quoted rate for that fix length (IADB, matched to the loan-to-value band) minus today's OIS spot rate for that length. If the user has a real product offer, their offer wins.
  - Savings bonds: margin = today's quoted fixed-bond rate minus today's OIS spot rate for that length. It is usually negative, because banks pay savers less than wholesale rates.
  - Show the calculated margin and let the user override it.

### 4.5 Where this plugs in
Wherever the app currently computes monthly interest or mortgage interest, replace the constant rate with `accountRate(item, month, curve, rateScenario)`. It returns the AER and the monthly growth factor for that month.
- **Mortgage payments** are recalculated at each repricing, from the balance, the new rate and the remaining term.
- **If the app has remortgage planning or option-comparison features,** price the default options from `termRateCC` at the fix end plus the mortgage margin. The comparison is then anchored to market pricing rather than guesses.
- **If the app has an "overpay or keep the cash" comparison,** use the modelled cash rate path (section 4.3) over the comparison window, not today's rate.

### 4.6 Optional: link investment returns to rates
- Offer a mode where expected investment return = the modelled short rate + an equity risk premium (user setting, e.g. 4%).
- Returns are then consistent with the rate environment, rather than an arbitrary flat percentage.
- Keep the existing flat-return mode as the default.

### 4.7 Optional: market-based inflation
- Offer the implied inflation curve as an inflation assumption.
- Label it clearly as **RPI-based**, and let the user subtract an adjustment (default 1 percentage point) to approximate CPI.
- Keep a flat manual inflation rate as the default.

---

## 5. Rate scenarios
These sit alongside whatever other scenarios the app has, as a "rates" setting.

| Scenario | What it does |
| --- | --- |
| **Market-implied** (default) | Uses the curve as published |
| **Parallel shift** | Market curve ± a set amount (e.g. +1.00% / −1.00%) |
| **Twist** | Short end and long end shifted by different amounts |
| **Flat at today's rate** | Ignores market expectations. This is the old behaviour, for comparison |
| **Long-run anchor** | Market curve for the first N years (default 3), then blended linearly over M years (default 3) to a user-set "neutral" Bank Rate (e.g. 3%). Useful because long-dated forwards include term premium and are less informative for a household projection |
| **Manual path** | Rate points entered by hand and interpolated |
| **Curve as at a past date** | Uses a file from `rates/history/`, to show "what the plan looked like at last review" |

If the app runs randomised projections (Monte Carlo), rate paths can be generated around the chosen scenario by adding a random shock to the forward curve. Treat this as a later extension, not part of the first build.

---

## 6. What the user sees

### 6.1 Rates screen
- A chart of the market-implied Bank Rate path over the next 5–10 years, overlaid with:
  - the selected rate scenario
  - today's Bank Rate as a reference line
  - the curve from the user's previous review (if saved), so they can see how expectations moved
- The source and as-at date, with the staleness badge (section 3.3).
- A scenario picker, with controls for shift, anchor and manual points.

### 6.2 On each account
- A one-line plain-English summary of its rate rule, for example:
  - "Fixed 4.20% until Mar 2027, then a 2-year fix at market + 0.35%"
  - "Variable: follows Bank Rate at 60%, 2-month lag"
- A small chart of its projected rate path, with repricing dates marked.

### 6.3 Month detail
If the app has a month-by-month breakdown, show for each account:
- the rate applied that month
- the interest earned or paid
- a marker if the account repriced that month, with the calculation: forward rate + margin = new rate

### 6.4 Explanations
Every derived number should be explainable. Tapping a rate shows how it was calculated: curve value, pass-through, lag, spread or margin, and floor.

---

## 7. Build order

### Step 1: Rate maths and tests (no network)
- Rate functions (4.1), the variable model (4.3), fixed products with rollover (4.4), calibration, and compounding conversions.
- Test with synthetic curves only.

### Step 2: Manual path and scenarios
- Manual rate path entry and the scenario transforms (5).
- Wire `accountRate` into the monthly projection loop, including mortgage repricing.
- The app becomes fully usable without any live data.

### Step 3: Data pipeline
- The scheduled job (3.1), output files (3.2), validation (3.3), and app loading with caching (3.4).

### Step 4: User-facing screens
- Rates screen (6.1), per-account summaries (6.2), month detail (6.3), and explanations (6.4).

### Step 5: Calibration from Bank of England data
- Margins from IADB quoted rates.
- Suggested pass-through estimates.
- Curve history comparison.

### Step 6 (optional)
- Link investment returns to the rate path (4.6).
- Market-based inflation (4.7).
- Rate uncertainty in randomised projections.

---

## 8. Tests (done when)

**Maths**
- [ ] A flat 4% continuous curve gives 4% from every rate function, an AER of about 4.081%, and a monthly factor of e^(0.04/12).
- [ ] With a hump-shaped curve (rising from 4% to 5% over 12 months, then falling to 3% by month 36), a variable account with pass-through 1 and lag 0 rises then falls in step. With pass-through 0.5 and lag 3, the shape is dampened and delayed by exactly 3 months.
- [ ] Calibration: month 0's rate equals the entered current rate for every variable account.

**Fixed products**
- [ ] A fixed account holds its rate exactly until `fixEnd`. In the first month after, it equals the forward rate for the new fix plus the margin, and it stays constant for `termMonths`.
- [ ] Mortgage payments recalculate at repricing. The balance amortises correctly against a standard repayment calculation.

**Rollover choices**
- [ ] `variable` rollover switches models at the right month.
- [ ] `close` moves the balance to cash on the maturity date.

**Scenarios**
- [ ] A +1% parallel shift raises every variable rate by exactly passThrough × 1%, and every repriced fix by exactly 1%.
- [ ] The long-run anchor blends linearly between year N and year N+M, and equals the anchor afterwards.
- [ ] "Flat at today's rate" reproduces the old constant-rate projection exactly. This is the regression guard.

**Pipeline**
- [ ] A curve file with a rate outside −1% to 15% is rejected, and the previous file is kept.
- [ ] The app shows the correct staleness badge for a given as-at date.
- [ ] With no network and no cached curve, the app falls back to "Flat at today's rate" and says so.

---

## 9. Risks and limitations to state in the app
- Market-implied is **not a forecast**. Show the "Market-implied" label and the curve's as-at date wherever the rates layer affects a figure.
- Retail rates can diverge from the benchmark, especially for savings, where banks compete unevenly. Pass-through and margins are assumptions the user should revisit.
- The curves are published with a one-business-day delay and can move sharply after news or Bank of England announcements. Encourage re-running the projection after big rate events.
- Tax on interest outside ISAs (e.g. above the Personal Savings Allowance) isn't covered here. Flag it as a separate feature if the app models non-ISA savings in any depth.
- Check the Bank of England's terms for reuse and attribution before publishing derived curve files, and credit the source in the app.
