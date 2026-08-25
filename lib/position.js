// The board position — one computation both views (Game + Dashboard) render.
// Turns a period of the ledger into the bifurcations the owner asked for:
//   income  → active vs passive
//   expenses→ fixed vs variable
//   savings → committed asset-building (kept OUT of expenses; it builds net worth)
//   work    → company-fronted (receivables), kept OUT of personal cashflow
// plus the balance sheet and the game's "freedom" (passive income ÷ expenses).
import { loadEntityFromDb, query } from "./db.js";

const PASSIVE_RE = /^Income:(Interest|Dividend|Rent|Capital|Passive|Royalty)/i;
const FALLBACK_FIXED = ["Expenses:Interest", "Expenses:EMI", "Expenses:Insurance"];
const r2 = (n) => Math.round(n);
const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);

export async function computePosition(entity, { month } = {}) {
  const book = await loadEntityFromDb(entity);

  // fixed-expense accounts come from the defined commitments (learned), plus a
  // safe fallback so it works before any are seeded.
  let fixedSet = new Set(FALLBACK_FIXED);
  try {
    const rows = await query(
      `select a.name from recurring_commitments rc
         join accounts a on a.id=rc.account_id
         join entities e on e.id=rc.entity_id
        where e.slug=$1 and rc.active and rc.kind in ('expense','loan_emi','insurance')`,
      [entity],
    );
    rows.forEach((x) => fixedSet.add(x.name));
  } catch { /* commitments table optional */ }

  const inPeriod = (t) => !month || t.date.startsWith(month);

  // period = the reviewed month's income statement; asOf = current snapshot for
  // the balance sheet (a balance sheet is "where you are now", not period-scoped).
  const period = {}, asOf = {};
  for (const t of book.txns) {
    const within = inPeriod(t);
    for (const p of t.postings) {
      if (p.amount == null || p.currency !== "INR") continue;
      if (within) period[p.account] = (period[p.account] || 0) + p.amount;
      asOf[p.account] = (asOf[p.account] || 0) + p.amount;
    }
  }

  const grp = (src, pred, sign = 1) =>
    Object.entries(src).filter(([a]) => pred(a))
      .map(([a, v]) => ({ account: a, label: a.split(":").slice(1).join(" · "), amount: r2(sign * v) }))
      .filter((x) => x.amount !== 0).sort((x, y) => y.amount - x.amount);

  const income = {
    active: grp(period, (a) => a.startsWith("Income:") && !PASSIVE_RE.test(a) && !a.startsWith("Income:Household"), -1),
    passive: grp(period, (a) => PASSIVE_RE.test(a), -1),
  };
  const expenses = {
    fixed: grp(period, (a) => a.startsWith("Expenses:") && fixedSet.has(a)),
    variable: grp(period, (a) => a.startsWith("Expenses:") && !fixedSet.has(a)),
  };
  const savings = grp(period, (a) => a.startsWith("Assets:Investments:")); // + = invested this period
  const work = grp(period, (a) => a.startsWith("Assets:Receivable:"));      // + = fronted this period

  const incomeTotal = sum(income.active) + sum(income.passive);
  const expenseTotal = sum(expenses.fixed) + sum(expenses.variable);
  const passiveTotal = sum(income.passive);

  // Balance sheet as-of the period end (exclude Household reference mirror).
  const bsAccounts = (pred, sign = 1) =>
    Object.entries(asOf).filter(([a]) => pred(a) && !a.includes(":Household:"))
      .map(([a, v]) => ({ account: a, label: a.split(":").slice(1).join(" · "), amount: r2(sign * v) }))
      .filter((x) => x.amount !== 0).sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
  const assets = bsAccounts((a) => a.startsWith("Assets:"));
  const liabilities = bsAccounts((a) => a.startsWith("Liabilities:"), -1);
  const assetsTotal = sum(assets), liabilitiesTotal = sum(liabilities);

  // reimbursements outstanding, per company (as-of, from receivables)
  const reimbursements = bsAccounts((a) => a.startsWith("Assets:Receivable:"))
    .map((x) => ({ company: x.account.split(":")[2], outstanding: x.amount }))
    .filter((x) => x.outstanding !== 0);

  return {
    entity, month: month || null,
    income: { ...income, total: incomeTotal, passiveTotal },
    expenses: { ...expenses, total: expenseTotal, fixedTotal: sum(expenses.fixed), variableTotal: sum(expenses.variable) },
    savings: { committed: savings, total: sum(savings) },
    work: { fronted: work, total: sum(work) },
    payday: incomeTotal - expenseTotal,
    balanceSheet: { assets, liabilities, assetsTotal, liabilitiesTotal, netWorth: assetsTotal - liabilitiesTotal },
    reimbursements,
    // the game's soul: how far out of the rat race (passive income ÷ expenses)
    freedom: expenseTotal > 0 ? Math.round((passiveTotal / expenseTotal) * 100) : 0,
  };
}
