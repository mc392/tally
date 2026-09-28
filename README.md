# Tally

A personal finance tracker and projection tool that runs on iPhone like a native app.
Your figures live in **one file you own** (`family-finances.json`) in iCloud Drive or OneDrive — never in this repository.

## What it does

- **Overview** – net worth, change since the last update, a chart of history running into the projection, and one line on actual spending against plan.
- **Accounts** – every account grouped by type and person, each with how quickly the money can be used (instant, notice, fixed, invested, locked).
- **Update balances** – one screen, pre-filled with your last figures; saving creates a dated milestone and shows what changed and why: money put in, investment growth, interest, debt paid off, and how far ahead of or behind plan you are.
- **Projection** – month by month, in each scenario, 18 months to 10 years, optionally in today's money. Compare up to three whole plans side by side. A range of 2,000 possible futures, and one-tap stress tests.
- **Plan** – income and spending that can start and stop on a month, a 24-month cash-flow calendar, the mortgage (split into parts if it has them), life events from templates (baby, move, renovation, car, big trip, career break), goals, and ISA rules (£20k each, one person's filled first).
- **Remortgage** – a readiness screen for the next fix end (what you'll have free to overpay, what's earmarked, key dates), a warning when a change eats into it, an optional glide path or target, and a side-by-side comparison of the deals you're weighing up.
- **Spending** – import bank statement CSVs (Lloyds and American Express recognised; any bank by picking its columns): categories and rules, transfers between your own accounts matched, budget against actual, recurring payments.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and all the styling |
| `app.js` | Screens and editing |
| `storage.js` | Opening and saving your file: live save, encryption, "changed on another device" checks |
| `engine.js` | The projection maths (no screen code) |
| `model.js` | The shape of the finance file, and upgrading older files |
| `templates.js` | Life-event templates |
| `transactions.js` | Reading bank CSVs, categories, transfers, budget vs actual, recurring payments |
| `analysis.js`, `mc-worker.js` | Goals, where changes came from, the ISA year, stress tests and the range of outcomes |
| `sw.js`, `manifest.webmanifest`, `icons/` | Let iPhone install it to the Home Screen and run it offline |
| `tests/` | Checks the maths still matches the spreadsheet, and that saving and encryption behave |

## Put it online (free, GitHub Pages)

1. In this repository on github.com: **Settings → Pages**.
2. Under *Build and deployment*, set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the site is at **https://mc392.github.io/tally/**.

`.nojekyll` tells GitHub Pages to serve the files exactly as they are, without running its Jekyll site builder over them.

This repository can safely be public: it holds only code. Your data file stays in your own cloud storage.

## Install on iPhone

1. Open the site in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Tally from the Home Screen, tap **Open finance file**, and pick `family-finances.json` from iCloud Drive or OneDrive.

## How saving works today

- The app keeps a working copy on the device between sessions.
- **On a Mac or PC in Chrome or Edge**, open the file from your synced iCloud Drive / OneDrive folder. From then on every change saves straight into it, with no Save button. After the browser restarts it asks once, via **Reconnect**, before writing again.
- **On iPhone**, Save opens the share sheet: choose **Save to Files** → your iCloud Drive / OneDrive folder → replace the old file. (Live save on iPhone is Phase 2: a small native shell.)
- **Changed on another device?** Every save notes which device made it. If the file was saved elsewhere since this device last read it, Tally stops and asks rather than overwriting.

## Encryption (optional, recommended)

**Plan › Your data › Encryption** locks the file with a passphrase before it is saved, so iCloud, OneDrive or anyone who gets hold of the file sees only scrambled data (AES-256). Each device asks for the passphrase once. **There is no reset: if you forget the passphrase, the file cannot be opened.** Keep it in your password manager. The working copy on each device is protected by that device's own lock, not by the passphrase.

## Check the maths

Requires Node.js: `node tests/engine.test.js` and `node tests/storage.test.js`.
The browser test also needs Playwright: `npm i --no-save playwright`, then `node tests/browser.test.mjs`.
