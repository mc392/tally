// Run with:  node tests/insights.test.js
// Spending analytics (Sep 2026): money out, money in and both, by month and by category / merchant / account,
// against the period before, what is changing, the biggest items. A made-up household; every figure by hand.
const assert = require('assert');
const TX = require('../transactions.js');
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${msg}: got ${a}, expected ${b}`);

// Jan-Aug 2026 whole months, September still running. Groceries at Tesco £300 a month, £400 from July, a £50
// refund in March; eating out £100 a month on the card, £40 from June; pay £3,000; a £500 transfer (never counted).
const L = [];
const add = (m, amount, cat, merchant, account = 'cur', day = '10') => L.push({ date: `2026-${m}-${day}`, amount, cat, merchant, account });
for (let i = 1; i <= 8; i++) {
  const m = String(i).padStart(2, '0');
  add(m, i >= 7 ? -400 : -300, 'Groceries', 'Tesco');
  add(m, i >= 6 ? -40 : -100, 'Eating out', 'Cafe', 'amex');
  add(m, 3000, 'Income', 'Employer', 'cur', '28');
  add(m, -500, 'Transfer', 'To saver');
}
add('03', 50, 'Groceries', 'Tesco', 'cur', '15');
add('09', -200, 'Groceries', 'Tesco');
const W = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

let I = TX.insights(L, { months: W, partial: '2026-09' });
// Groceries 250 + 300 + 300 + 300 + 400 + 400 = 1,950; eating out 100 × 3 + 40 × 3 = 420
near(I.total, 2370, 'spent over the six whole months'); near(I.avg, 395, 'a month on average');
assert.strictEqual(I.count, 13, '7 grocery lines (with the refund) and 6 meals out; transfers and pay are not spending');
assert.deepStrictEqual(I.rows.map(r => [r.key, r.total]), [['Groceries', 1950], ['Eating out', 420]], 'biggest first');
near(I.rows[0].share, 1950 / 2370, 'share of spending'); near(I.rows[0].avg, 325, 'groceries a month');
assert.strictEqual(I.series.at(-1).partial, true); near(I.series.at(-1).v, 200, 'September so far is drawn');
assert.strictEqual(I.prev, null, 'no period before given: no comparison');
// last three months against the three before: groceries 283.33 → 366.67, eating out 100 → 40
near(I.movers.up[0].delta, (1100 - 850) / 3, 'groceries rising'); assert.strictEqual(I.movers.up[0].key, 'Groceries');
near(I.movers.down[0].delta, -60, 'eating out falling'); assert.strictEqual(I.movers.down[0].key, 'Eating out');
assert.deepStrictEqual(I.biggest.slice(0, 2).map(t => t.value), [400, 400], 'the biggest items are July and August’s shop');
console.log('  ✓ spending by month and category, the running month shown but not counted, what is changing');

I = TX.insights(L, { months: W, partial: '2026-09', measure: 'income' });
near(I.total, 18000, 'money in'); assert.deepStrictEqual(I.rows.map(r => r.key), ['Income']);
I = TX.insights(L, { months: W, partial: '2026-09', measure: 'net' });
near(I.total, 18000 - 2370, 'in less out'); near(I.series[0].income, 3000); near(I.series[0].spend, 250 + 100, 'March out: groceries after the refund, and eating out');
console.log('  ✓ money in, and in against out');

I = TX.insights(L, { months: W, partial: '2026-09', by: 'merchant' });
assert.deepStrictEqual(I.rows.map(r => [r.key, r.total]), [['Tesco', 1950], ['Cafe', 420]], 'by shop');
I = TX.insights(L, { months: W, partial: '2026-09', by: 'account' });
assert.deepStrictEqual(I.rows.map(r => [r.key, r.total]), [['cur', 1950], ['amex', 420]], 'by account');
near(TX.insights(L, { months: W, partial: '2026-09', account: 'amex' }).total, 420, 'one account only');
I = TX.insights(L, { months: W, partial: '2026-09', by: 'merchant', focus: { by: 'category', key: 'Groceries' } });
assert.deepStrictEqual(I.rows.map(r => r.key), ['Tesco'], 'inside one category, split by shop');
console.log('  ✓ by merchant, by account, one account, and inside one category');

// July-August against May-June: 800 + 80 = 880 against 600 + 140 = 740
I = TX.insights(L, { months: ['2026-07', '2026-08'], prevMonths: ['2026-05', '2026-06'] });
near(I.prev, 740, 'the period before'); near(I.change, 140, 'up £140');
near(I.rows.find(r => r.key === 'Groceries').change, 200, 'groceries up £200'); near(I.rows.find(r => r.key === 'Eating out').change, -60, 'eating out down £60');
assert.strictEqual(I.movers, null, 'two months is too short to say what is changing');
console.log('All insight checks pass ✓');
