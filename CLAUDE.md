# Notes for Claude Code

## Owner
Matt is new to software engineering but works in accounting/finance risk: explain every step plainly, don't skip steps, but technical detail is welcome. Explain any terminal command before asking him to run it.

## Principles
- **Never commit real financial data.** Data lives in the user's `family-finances.json` in iCloud Drive / OneDrive. Tests use synthetic fixtures only.
- No build step, no framework: plain HTML/CSS/JS served by GitHub Pages. Keep it that way unless there's a strong reason.
- iOS-native look: system font, inset grouped lists, large titles, bottom tab bar, bottom sheets. Main screen stays simple; detail lives one tap deeper.
- `engine.js` is pure maths with no DOM access. Any change to projection logic must keep `node tests/engine.test.js` passing, or update the test with a written reason.

## Data file shape (version 1)
`people[]`, `accounts[] {id,name,owner,type,rate,active,note}`, `snapshots[] {date, balances{accountId: amount}}` (liabilities negative),
`income[] {name,owner,monthly,growth}`, `spending[] {name,category,annual,inflates,linked?}`, `bufferPct`,
`events[] {name,amount,date,on,settles?}`, `mortgage {payment,balance,rate,fixEnd,newRate,termEnd,propertyValue}`,
`rules {cashFloor,isaAllowance,isaUsed,isaUsedTaxYear,sweepToSS}`, `scenarios{key:{name,growth,ssReturn,inflation,payRise}}`, `scenario`, `horizonMonths`.
Account types: ss_isa, cash_isa, savings, current, card, card_0, tax. Cash pool = current + card. ISA pot = ss_isa + cash_isa.

## Projection rules (from the original spreadsheet)
Monthly: cash + surplus + one-off items. Above the cash floor → sweep into ISAs up to (new allowance + flexible re-deposit room). Below → withdraw from ISAs (cash ISAs first); withdrawals add re-deposit room for the rest of that tax year. Allowance resets each April. Growth optional per scenario.

## Roadmap (agreed next steps)
1. **OneDrive auto-sync** via Microsoft Graph (free Azure app registration, PKCE sign-in, read/write one file in the app folder). Replaces the manual Save to Files step.
2. **Trading 212 balances** via its official API. Needs a tiny proxy (e.g. Cloudflare Worker) so the API key isn't in the web page and to get around browser CORS limits.
3. Per-person ISA allowances (£20k each) instead of a household figure.
4. Pensions and property as optional net-worth lines.
5. CSV import of past balances.
6. iCloud auto-sync is only possible with a native iOS app (Swift, needs a Mac and Apple Developer account) — out of scope unless requested.
