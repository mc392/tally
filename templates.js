// ================= Tally life-event templates =================
// Pure: no DOM. A template asks a few questions (`fields`, in the same shape the app's forms use)
// and `build(params, ctx)` returns lines with dates RELATIVE to the event's start month:
//   { name, kind, amount, offset (months after start, may be negative), months (null = never ends), category, inflates, owner, note }
// applyTemplate() turns those into real dated flows tagged with the event's id.
// Every amount is a PLACEHOLDER for the reader to change. None of this is advice, and nothing here
// states a current government rate as fact: where one matters, the line carries a note to check gov.uk.
const TallyTemplates = (() => {
  const M = TallyModelRef();
  function TallyModelRef() { return typeof TallyModel !== 'undefined' ? TallyModel : require('./model.js'); }

  const personField = (key, label, ctx) => ({ key, label, type: 'select', options: ctx.people.map(p => [p.id, p.name]) });
  const perMonth = (hoursPerWeek, rate) => hoursPerWeek * rate * 52 / 12;
  // A pay change is written as the DIFFERENCE from usual pay, so switching the event off restores it exactly.
  const payDip = (ctx, who, months, payDuring, label, offset = 0) => {
    const usual = ctx.usualPay(who);
    if (!months) return [];
    return [{ name: `${label} – ${ctx.name(who)}`, kind: 'income', amount: (+payDuring || 0) - usual, offset, months, category: 'Income', owner: who,
      note: usual ? `Usual take-home ${Math.round(usual)} a month; this line is the change during the period.` : 'No usual pay found for this person, so this line is just the pay during the period.' }];
  };

  const T = {
    baby: {
      name: 'Baby', blurb: 'Kit, parental leave, monthly costs by age, childcare and Child Benefit.', startLabel: 'Due month',
      fields: ctx => [
        { head: 'Parental leave', foot: 'Pay during leave is monthly take-home. Statutory and enhanced pay vary: check gov.uk and each employer’s policy. Leave 0 months for none.', fields: [
          personField('leave1Who', 'First parent', ctx), { key: 'leave1Months', label: 'Months off', type: 'number' }, { key: 'leave1Pay', label: 'Pay during leave', type: 'money' },
          personField('leave2Who', 'Second parent', ctx), { key: 'leave2Months', label: 'Months off', type: 'number' }, { key: 'leave2Pay', label: 'Pay during leave', type: 'money' }] },
        { head: 'Childcare', foot: 'Funded hours depend on age, where you live and whether you both work: check gov.uk and your council.', fields: [
          { key: 'careFrom', label: 'Starts, months after birth', type: 'number' }, { key: 'careUntil', label: 'Ends, months after birth', type: 'number', hint: 'e.g. 60 for starting school' },
          { key: 'careHours', label: 'Hours a week', type: 'number' }, { key: 'careRate', label: 'Cost per hour', type: 'money' },
          { key: 'fundedFrom', label: 'Funded hours from, months after birth', type: 'number' }, { key: 'fundedHours', label: 'Funded hours a week', type: 'number' }] },
        { head: 'Child Benefit', foot: 'Check the current rate and the High Income Child Benefit Charge thresholds on gov.uk before relying on this.', fields: [
          { key: 'childBenefit', label: 'Per month', type: 'money' }] },
      ],
      defaults: ctx => ({ leave1Who: ctx.people[0]?.id, leave1Months: 9, leave1Pay: 800, leave2Who: ctx.people[1]?.id || ctx.people[0]?.id, leave2Months: 1, leave2Pay: 1500,
        careFrom: 12, careUntil: 60, careHours: 30, careRate: 9, fundedFrom: 12, fundedHours: 0, childBenefit: 100 }),
      build: (p, ctx) => {
        const lines = [
          { name: 'Pram, cot and kit', kind: 'oneoff', amount: -2000, offset: -2, category: 'Baby' },
          { name: 'Nursery room', kind: 'oneoff', amount: -800, offset: -3, category: 'Baby' },
          ...payDip(ctx, p.leave1Who, Math.round(+p.leave1Months || 0), p.leave1Pay, 'Parental leave'),
          ...payDip(ctx, p.leave2Who, Math.round(+p.leave2Months || 0), p.leave2Pay, 'Parental leave'),
          { name: 'Everyday costs, age 0–1', kind: 'spend', amount: 250, offset: 0, months: 12, category: 'Baby', inflates: true },
          { name: 'Everyday costs, age 1–3', kind: 'spend', amount: 250, offset: 12, months: 24, category: 'Baby', inflates: true },
          { name: 'Everyday costs, age 3–5', kind: 'spend', amount: 250, offset: 36, months: 24, category: 'Baby', inflates: true },
          { name: 'Everyday costs, age 5+', kind: 'spend', amount: 300, offset: 60, months: null, category: 'Baby', inflates: true },
          { name: 'Child Benefit', kind: 'income', amount: +p.childBenefit || 0, offset: 0, months: null, category: 'Income',
            note: 'Check the High Income Child Benefit Charge on gov.uk: above the threshold some or all of this is paid back through tax.' },
        ];
        const from = Math.round(+p.careFrom || 0), until = Math.max(from, Math.round(+p.careUntil || 0)), funded = Math.min(Math.max(Math.round(+p.fundedFrom || 0), from), until);
        const hrs = +p.careHours || 0, rate = +p.careRate || 0, paidHrs = Math.max(0, hrs - (+p.fundedHours || 0));
        if (hrs && rate) {
          if (funded > from) lines.push({ name: 'Childcare', kind: 'spend', amount: perMonth(hrs, rate), offset: from, months: funded - from, category: 'Baby', inflates: true, note: `${hrs} hours a week at ${rate} an hour` });
          if (until > funded) lines.push({ name: +p.fundedHours ? 'Childcare, after funded hours' : 'Childcare', kind: 'spend', amount: perMonth(paidHrs, rate), offset: funded, months: until - funded, category: 'Baby', inflates: true, note: `${paidHrs} paid hours a week at ${rate} an hour` });
        }
        return lines;
      },
    },
    property: {
      name: 'Property purchase or move', blurb: 'Deposit, stamp duty, fees, moving, a new mortgage payment and running costs.', startLabel: 'Completion month',
      fields: () => [
        { head: 'Buying', foot: 'Stamp duty depends on the price, where you buy and whether you are a first-time buyer: work it out with the gov.uk calculator and enter it here.', fields: [
          { key: 'deposit', label: 'Deposit', type: 'money' }, { key: 'stampDuty', label: 'Stamp duty', type: 'money' },
          { key: 'fees', label: 'Legal and survey fees', type: 'money' }, { key: 'moving', label: 'Moving costs', type: 'money' }] },
        { head: 'Selling the current home', foot: 'Leave both at 0 if you are not selling.', fields: [
          { key: 'sale', label: 'Sale price, after agent fees', type: 'money' }, { key: 'repay', label: 'Mortgage repaid from the sale', type: 'money' }] },
        { head: 'Every month after the move', foot: 'Changes from today: Up for a cost that rises, Down for one that falls. This does not change the mortgage parts on the Mortgage page: update those after the move.', fields: [
          { key: 'mortgageChange', label: 'Change in mortgage payment', type: 'money', signed: ['Down', 'Up'] }, { key: 'runningChange', label: 'Change in running costs', type: 'money', signed: ['Down', 'Up'], hint: 'Council tax, bills, insurance' }] },
      ],
      defaults: () => ({ deposit: 50000, stampDuty: 5000, fees: 3000, moving: 1500, sale: 0, repay: 0, mortgageChange: 300, runningChange: 100 }),
      build: p => [
        { name: 'Deposit', kind: 'oneoff', amount: -Math.abs(+p.deposit || 0), offset: 0, category: 'Property' },
        { name: 'Stamp duty', kind: 'oneoff', amount: -Math.abs(+p.stampDuty || 0), offset: 0, category: 'Property', note: 'Entered by you - check the gov.uk calculator.' },
        { name: 'Legal and survey fees', kind: 'oneoff', amount: -Math.abs(+p.fees || 0), offset: -1, category: 'Property' },
        { name: 'Moving costs', kind: 'oneoff', amount: -Math.abs(+p.moving || 0), offset: 0, category: 'Property' },
        ...(+p.sale ? [{ name: 'Sale of current home', kind: 'oneoff', amount: Math.abs(+p.sale), offset: 0, category: 'Property' }] : []),
        ...(+p.repay ? [{ name: 'Current mortgage repaid', kind: 'oneoff', amount: -Math.abs(+p.repay), offset: 0, category: 'Property' }] : []),
        ...(+p.mortgageChange ? [{ name: 'Change in mortgage payment', kind: 'spend', amount: +p.mortgageChange, offset: 1, months: null, category: 'Property' }] : []),
        ...(+p.runningChange ? [{ name: 'Change in running costs', kind: 'spend', amount: +p.runningChange, offset: 1, months: null, category: 'Property', inflates: true }] : []),
      ].filter(l => l.amount),
    },
    renovation: {
      name: 'Renovation', blurb: 'A project paid for in stages over several months, with a contingency.', startLabel: 'First payment',
      fields: () => [{ foot: 'The total is spread evenly over the months. The contingency is added on top.', fields: [
        { key: 'total', label: 'Total cost', type: 'money' }, { key: 'months', label: 'Paid over', type: 'number', unit: 'months' }, { key: 'contingency', label: 'Contingency', type: 'percent', unit: '%' }] }],
      defaults: () => ({ total: 20000, months: 4, contingency: 15 }),
      build: p => { const n = Math.max(1, Math.round(+p.months || 1)); return [{ name: 'Renovation work', kind: 'spend', amount: (+p.total || 0) / n, offset: 0, months: n, category: 'Home' }]; },
      contingency: p => +p.contingency || 0,
    },
    car: {
      name: 'Car', blurb: 'Buy outright or on finance, running costs, and replacing it every few years.', startLabel: 'Buying month',
      fields: () => [
        { head: 'Buying', foot: 'Buying outright: enter the price and leave finance at 0. On finance: enter the deposit as the price, and the monthly payment.', fields: [
          { key: 'price', label: 'Price or deposit', type: 'money' }, { key: 'financeMonthly', label: 'Finance per month', type: 'money' }, { key: 'financeMonths', label: 'Finance for', type: 'number', unit: 'months' }] },
        { head: 'Running and replacing', fields: [
          { key: 'running', label: 'Running costs a month', type: 'money', hint: 'Fuel or charging, insurance, tax, servicing' },
          { key: 'replaceYears', label: 'Replace every', type: 'number', unit: 'years', hint: '0 = keep it' }, { key: 'cycles', label: 'Replacements to plan for', type: 'number' }] },
      ],
      defaults: () => ({ price: 15000, financeMonthly: 0, financeMonths: 0, running: 200, replaceYears: 0, cycles: 1 }),
      build: p => {
        const l = [];
        if (+p.price) l.push({ name: 'Car purchase', kind: 'oneoff', amount: -Math.abs(+p.price), offset: 0, category: 'Transport' });
        if (+p.financeMonthly && +p.financeMonths) l.push({ name: 'Car finance', kind: 'spend', amount: +p.financeMonthly, offset: 0, months: Math.round(+p.financeMonths), category: 'Transport' });
        if (+p.running) l.push({ name: 'Car running costs', kind: 'spend', amount: +p.running, offset: 0, months: null, category: 'Transport', inflates: true });
        for (let i = 1; +p.replaceYears > 0 && i <= Math.max(0, Math.round(+p.cycles || 0)); i++)
          l.push({ name: `Replacement car ${i}`, kind: 'oneoff', amount: -Math.abs(+p.price || 0), offset: Math.round(12 * +p.replaceYears * i), category: 'Transport' });
        return l;
      },
    },
    trip: {
      name: 'Wedding or big trip', blurb: 'A one-off spend on a date, and optionally a deposit paid ahead of it.', startLabel: 'Month of the event',
      fields: () => [{ foot: 'The projection holds cash for these by counting them in the month they are paid.', fields: [
        { key: 'cost', label: 'Total cost', type: 'money' }, { key: 'deposit', label: 'Of which paid in advance', type: 'money' }, { key: 'depositMonths', label: 'Months ahead', type: 'number' }] }],
      defaults: () => ({ cost: 15000, deposit: 3000, depositMonths: 9 }),
      build: p => {
        const cost = Math.abs(+p.cost || 0), dep = Math.min(cost, Math.abs(+p.deposit || 0));
        return [
          ...(dep ? [{ name: 'Deposit', kind: 'oneoff', amount: -dep, offset: -Math.abs(Math.round(+p.depositMonths || 0)), category: 'Lifestyle' }] : []),
          { name: dep ? 'Balance' : 'Cost', kind: 'oneoff', amount: -(cost - dep), offset: 0, category: 'Lifestyle' },
        ].filter(l => l.amount);
      },
    },
    career: {
      name: 'Career change or sabbatical', blurb: 'A period on different pay, then back to work, with optional course fees.', startLabel: 'First month',
      fields: ctx => [{ foot: 'Pay during the period is monthly take-home; enter 0 for none. Usual pay resumes after it.', fields: [
        personField('who', 'Who', ctx), { key: 'months', label: 'For', type: 'number', unit: 'months' }, { key: 'payDuring', label: 'Pay during it', type: 'money' },
        { key: 'fees', label: 'Course or training fees', type: 'money' }] }],
      defaults: ctx => ({ who: ctx.people[0]?.id, months: 6, payDuring: 0, fees: 0 }),
      build: (p, ctx) => [
        ...payDip(ctx, p.who, Math.round(+p.months || 0), p.payDuring, 'Career break'),
        ...(+p.fees ? [{ name: 'Course fees', kind: 'oneoff', amount: -Math.abs(+p.fees), offset: 0, category: 'Education' }] : []),
      ],
    },
    custom: {
      name: 'Custom', blurb: 'An empty event: add your own lines to it.', startLabel: 'Start month',
      fields: () => [], defaults: () => ({}), build: () => [],
    },
  };

  // ctx: { people:[{id,name}], usualPay(id) → monthly take-home, name(id) → display name }
  function makeContext(d, startMonth) {
    const k = M.monthKey(startMonth);
    const people = (d.people || []).filter(p => p.id !== M.JOINT);
    return {
      people,
      name: id => ((d.people || []).find(p => p.id === id) || { name: id }).name,
      // the person's pay in the start month, from their ordinary income lines (not other life events)
      usualPay: id => (d.flows || []).filter(f => f.kind === 'income' && !f.bundle && f.owner === id && M.flowActive(f, k)).reduce((s, f) => s + (+f.amount || 0), 0),
    };
  }

  // Lines → real flows. A oneoff happens in one month; `months: null` runs on with no end.
  function toFlows(lines, start, bundleId, uid) {
    return lines.map(l => {
      const s = M.shiftMonth(start, l.offset || 0);
      const end = l.kind === 'oneoff' ? s : l.months == null ? null : M.shiftMonth(s, Math.max(1, l.months) - 1);
      const f = { id: uid(), name: l.name, kind: l.kind, amount: l.amount, start: s, end, category: l.category || 'Other', owner: l.owner || null,
        inflates: !!l.inflates, growth: 0, bundle: bundleId, on: true };
      if (l.note) f.note = l.note;
      return f;
    });
  }

  function applyTemplate(key, params, start, d, uid) {
    const t = T[key]; if (!t) throw new Error('Unknown template ' + key);
    const id = uid('b');
    const ctx = makeContext(d, start);
    const bundle = { id, name: t.name, template: key, start, on: true, scale: 1, contingency: t.contingency ? t.contingency(params) : 0 };
    return { bundle, flows: toFlows(t.build(params, ctx), start, id, () => uid('f')) };
  }

  return { T, makeContext, toFlows, applyTemplate, list: () => Object.entries(T).map(([key, t]) => ({ key, name: t.name, blurb: t.blurb })) };
})();

if (typeof module !== 'undefined') module.exports = TallyTemplates;
