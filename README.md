# Tally

A personal finance tracker and projection tool that runs on iPhone like a native app.
Your figures live in **one file you own** (`family-finances.json`) in iCloud Drive or OneDrive — never in this repository.

## What it does

- **Overview** – net worth, change since the last update, and a chart of recorded history running into the projection.
- **Accounts** – every account grouped by type and person; tap through to each account's history.
- **Update balances** – one screen, pre-filled with your last figures; saving creates a dated milestone.
- **Projection** – month-by-month model of cash and ISAs with Cautious / Base / Optimistic scenarios, 18 months to 10 years. Tap any month for the full cash waterfall and ISA allowance workings.
- **Plan** – income, spending lines, mortgage (including a post-fix remortgage), one-off payments and receipts, cash floor and ISA rules.

The projection logic reproduces the original spreadsheet exactly (see `tests/engine.test.js`).

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and all the styling |
| `app.js` | Screens and editing |
| `storage.js` | Opening and saving your file: live save, encryption, "changed on another device" checks |
| `engine.js` | The projection maths (no screen code) |
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
