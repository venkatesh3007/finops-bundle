// The game state — ONE neutral model all five themes render.
//
// Framing (owner-set): debt is NOT a burden. It's "capital in play" — leverage
// deployed to fund growth, shown factually with its carrying cost; you judge it.
// Two meters that actually matter:
//   FREEDOM  — passive income (ledger passive + venture cash) vs your living cost
//   LEVERAGE — what the deployed capital PRODUCES vs what it COSTS (neutral)
// Ventures/equity are owner-entered (what the leverage is building); a venture that
// pays monthly cash counts as passive income, so it feeds Freedom too.
//
// Plays at any span: pass {from, to} (a month, quarter, year, or custom range).
import { loadEntityFromDb, query } from "./db.js";

const PASSIVE_RE = /^Income:(Interest|Dividend|Rent|Capital|Passive|Royalty)/i;
const FALLBACK_FIXED = ["Expenses:Interest", "Expenses:EMI", "Expenses:Insurance"];
const r2 = (n) => Math.round(n);
const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);

function monthsBetween(from, to) {
  if (!from || !to) return 1;
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return Math.max(1, ty * 12 + tm - (fy * 12 + fm) + 1);
}

export async function computeGameState(entity, { from, to } = {}) {
  const book = await loadEntityFromDb(entity);

  let fixedSet = new Set(FALLBACK_FIXED);
  try {
    const rows = await query(
      `select a.name from recurring_commitments rc join accounts a on a.id=rc.account_id
         join entities e on e.id=rc.entity_id
        where e.slug=$1 and rc.active and rc.kind in ('expense','loan_emi','insurance')`, [entity]);
    rows.forEach((x) => fixedSet.add(x.name));
  } catch { /* commitments optional */ }

  let ventures = [];
  try {
    const rows = await query(
      `select v.name, v.kind, v.value, v.monthly_return from ventures v
         join entities e on e.id=v.entity_id where e.slug=$1 and v.active order by v.value desc`, [entity]);
    ventures = rows.map((r) => ({ name: r.name, kind: r.kind, value: Number(r.value), monthlyReturn: Number(r.monthly_return) }));
  } catch { /* ventures table optional */ }

  const inRange = (t) => (!from || t.date >= from) && (!to || t.date <= to);
  const period = {}, asOf = {};
  for (const t of book.txns) {
    const within = inRange(t);
    for (const p of t.postings) {
      if (p.amount == null || p.currency !== "INR") continue;
      if (within) period[p.account] = (period[p.account] || 0) + p.amount;
      asOf[p.account] = (asOf[p.account] || 0) + p.amount;
    }
  }
  const grp = (src, pred, sign = 1) =>
    Object.entries(src).filter(([a]) => pred(a))
      .map(([a, v]) => ({ account: a, label: a.split(":").slice(1).join(" · "), amount: r2(sign * v) }))
      .filter((x) => x.amount !== 0).sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));

  const income = {
    active: grp(period, (a) => a.startsWith("Income:") && !PASSIVE_RE.test(a) && !a.startsWith("Income:Household"), -1),
    passive: grp(period, (a) => PASSIVE_RE.test(a), -1),
  };
  const expenses = {
    fixed: grp(period, (a) => a.startsWith("Expenses:") && fixedSet.has(a)),
    variable: grp(period, (a) => a.startsWith("Expenses:") && !fixedSet.has(a)),
  };
  const activeTotal = sum(income.active), passiveLedger = sum(income.passive);
  const expenseTotal = sum(expenses.fixed) + sum(expenses.variable);
  const months = monthsBetween(from, to);

  // CAPITAL IN PLAY — leverage deployed (as-of, neutral positive magnitude).
  const loans = grp(asOf, (a) => a.startsWith("Liabilities:Loans:"), -1);
  const capitalInPlay = sum(loans);
  const carryingCostPeriod = Math.abs(sum(grp(period, (a) => a === "Expenses:Interest")));
  const carryingCostMonthly = r2(carryingCostPeriod / months);

  // What the capital is building.
  const ventureValue = ventures.reduce((s, v) => s + v.value, 0);
  const ventureReturn = ventures.reduce((s, v) => s + v.monthlyReturn, 0); // monthly cash
  const bookedAssets = sum(grp(asOf, (a) => a.startsWith("Assets:") && !a.includes(":Household:")));

  const passiveMonthly = r2(passiveLedger / months) + ventureReturn;
  const expenseMonthly = r2(expenseTotal / months);

  // METER 1 — FREEDOM: passive income covers your living cost.
  const freedom = {
    passiveMonthly, expenseMonthly,
    pct: expenseMonthly > 0 ? Math.round((passiveMonthly / expenseMonthly) * 100) : 0,
  };
  // METER 2 — LEVERAGE: neutral read of deployed capital vs its cost + what it builds.
  const leverage = {
    deployed: capitalInPlay,
    costMonthly: carryingCostMonthly,
    producingMonthly: passiveMonthly, // cash the deployed capital / ventures throw off
    building: r2(bookedAssets + ventureValue), // value the leverage sits against
    coversCostPct: carryingCostMonthly > 0 ? Math.round((passiveMonthly / carryingCostMonthly) * 100) : null,
    valuePerRupeePct: capitalInPlay > 0 ? Math.round(((bookedAssets + ventureValue) / capitalInPlay) * 100) : null,
  };

  const reimbursements = grp(asOf, (a) => a.startsWith("Assets:Receivable:"))
    .map((x) => ({ company: x.account.split(":")[2], outstanding: x.amount })).filter((x) => x.outstanding !== 0);

  // Liquid = cash you can actually deploy now (bank + cash), as-of. Feeds runway.
  const liquid = sum(grp(asOf, (a) => a.startsWith("Assets:Bank") || a.startsWith("Assets:Cash")));

  // THE MACHINE — where the month's money actually flows. Sources are not just
  // income: the owner funds growth with CAPITAL (loans drawn, receivables collected),
  // so the machine counts those too or the flow won't balance. Sinks: living
  // (fixed+variable), savings (into investments), and debt service.
  //   raw period flow signs: income posts negative (credit), so -flow = money in.
  //   loans post negative when drawn (borrowed) → -flow = capital in.
  //   receivables post negative when collected → -flow = capital in.
  const rawFlow = (pred) => Object.entries(period).filter(([a]) => pred(a)).reduce((s, [, v]) => s + v, 0);
  const loansDrawn = Math.max(0, -rawFlow((a) => a.startsWith("Liabilities:Loans:")));
  const recvCollected = Math.max(0, -rawFlow((a) => a.startsWith("Assets:Receivable:")));
  const savingsIn = sum(grp(period, (a) => a.startsWith("Assets:Investments:")));   // net into investments
  const debtService = Math.abs(sum(grp(period, (a) => a === "Expenses:Interest" || a === "Expenses:EMI")));
  const incomeIn = activeTotal + passiveLedger;
  const capitalIn = r2(loansDrawn + recvCollected);
  const inflowTotal = incomeIn + capitalIn;
  const machine = {
    inflow: { active: r2(activeTotal), passive: r2(passiveLedger), capital: capitalIn, total: r2(inflowTotal) },
    sinks: {
      fixed: sum(expenses.fixed), variable: sum(expenses.variable),
      savings: r2(Math.max(0, savingsIn)), debt: r2(debtService),
    },
    surplus: r2(inflowTotal - expenseTotal - Math.max(0, savingsIn)),
  };

  return {
    entity, period: { from: from || null, to: to || null, months },
    income: { ...income, activeTotal, passiveLedger, total: activeTotal + passiveLedger },
    expenses: { ...expenses, total: expenseTotal, fixedTotal: sum(expenses.fixed), variableTotal: sum(expenses.variable) },
    cashflow: activeTotal + passiveLedger - expenseTotal,
    capital: { inPlay: capitalInPlay, loans, carryingCostPeriod: r2(carryingCostPeriod), carryingCostMonthly },
    ventures: { items: ventures, totalValue: r2(ventureValue), totalReturn: r2(ventureReturn) },
    produces: { bookedAssets: r2(bookedAssets), ventureValue: r2(ventureValue) },
    meters: { freedom, leverage },
    machine, liquid: r2(liquid),
    reimbursements,
  };
}
