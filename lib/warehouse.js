// The Warehouse board. Shelves = the categories/counterparties money landed in;
// zones = the floor plan = your fixed/variable × in/out cashflow model. Each
// account is a shelf; we place it in an aisle by a sensible default (editable
// later in the reorganize slice) and stack its ₹ + crate count for the month.
import { query } from "./db.js";

async function entityId(slug) {
  const rows = await query("select id from entities where slug=$1", [slug]);
  if (!rows.length) throw new Error(`no entity ${slug}`);
  return rows[0].id;
}
const r0 = (n) => Math.round(Number(n) || 0);
const leaf = (a) => a.split(":").slice(1).join(" · ");

// income that behaves like a standing manifest → Fixed In; everything else → Variable In.
const FIXED_IN = /Salary|Consult|Mentor|Pension|Interest|Dividend|Rent|Retainer/i;

export async function warehouseMonth(entity, month) {
  const entId = await entityId(entity);

  // recurring commitments define which expense accounts are "fixed".
  const fixedSet = new Set(["Expenses:Interest", "Expenses:EMI", "Expenses:Insurance"]);
  try {
    const rows = await query(
      `select a.name from recurring_commitments rc join accounts a on a.id=rc.account_id
        where rc.entity_id=$1 and rc.active and rc.kind in ('expense','loan_emi','insurance')`, [entId]);
    rows.forEach((r) => fixedSet.add(r.name));
  } catch { /* optional */ }

  // per-account totals + crate counts for the month (economic legs only).
  // NOTE: corrections are INCLUDED (no corrects_id filter) so a reclassification —
  // a move on the board — nets against the original and the shelf totals update live.
  const rows = await query(
    `select a.name, count(distinct t.id)::int n, round(sum(p.amount),2) amt
       from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
      where t.entity_id=$1 and to_char(t.date,'YYYY-MM')=$2
        and a.name not like '%Household%'
        and (a.name like 'Income:%' or a.name like 'Expenses:%'
             or a.name like 'Assets:Investments:%' or a.name like 'Assets:Receivable:%')
      group by a.name`, [entId, month]);

  // player zoning overrides (move a shelf Fixed↔Variable).
  let ov = new Map();
  try { ov = new Map((await query("select account, fixed from account_zones where entity_id=$1", [entId])).map((r) => [r.account, r.fixed])); } catch { /* table optional */ }

  const Z = { fixed_in: [], var_in: [], fixed_out: [], var_out: [], work: [], invest: [] };
  for (const r of rows) {
    const name = r.name, amt = Number(r.amt), mag = Math.abs(amt);
    if (mag < 1) continue;
    if (name.startsWith("Income:")) {
      const fixed = ov.has(name) ? ov.get(name) : FIXED_IN.test(name);
      (fixed ? Z.fixed_in : Z.var_in).push({ name: leaf(name), account: name, amount: r0(mag), count: r.n, fixed });
    } else if (name.startsWith("Expenses:")) {
      const fixed = ov.has(name) ? ov.get(name) : fixedSet.has(name);
      (fixed ? Z.fixed_out : Z.var_out).push({ name: leaf(name), account: name, amount: r0(mag), count: r.n, fixed });
    } else if (name.startsWith("Assets:Investments:")) Z.invest.push({ name: leaf(name), account: name, amount: r0(mag), count: r.n });
    else if (name.startsWith("Assets:Receivable:")) Z.work.push({ name: leaf(name), account: name, amount: r0(mag), count: r.n });
  }

  // The Pack — loans as-of (not month), the debt you carry.
  const loans = await query(
    `select a.name, round(sum(p.amount),0) amt
       from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
      where t.entity_id=$1 and a.name like 'Liabilities:Loans:%'
      group by a.name having abs(sum(p.amount)) > 1`, [entId]);
  const pack = loans.map((l) => ({ name: l.name.split(":").pop(), account: l.name, amount: r0(Math.abs(Number(l.amt))), count: null }))
    .sort((a, b) => b.amount - a.amount);

  // planned per bucket, from the plan.
  const planned = Object.fromEntries((await query(
    "select bucket, round(sum(amount),0) p from plan_lines where entity_id=$1 and month=$2 group by bucket", [entId, month]))
    .map((r) => [r.bucket, Number(r.p)]));

  const zone = (key, label, dir) => {
    const shelves = Z[key].sort((a, b) => b.amount - a.amount);
    return { key, label, dir, planned: r0(planned[key] || 0), actual: shelves.reduce((s, x) => s + x.amount, 0), shelves };
  };
  const side = (key, label) => { const shelves = Z[key].sort((a, b) => b.amount - a.amount); return { key, label, actual: shelves.reduce((s, x) => s + x.amount, 0), shelves }; };

  // The whole eligible chart travels with the board so a crate can be moved to an
  // account that has no activity this month — a first-time receivable, say. The
  // shelves above are only what MOVED; these are everywhere it COULD move.
  const chart = await query(
    `select a.name from accounts a where a.entity_id=$1
       and (a.name like 'Income:%' or a.name like 'Expenses:%'
            or a.name like 'Assets:Receivable:%' or a.name like 'Assets:Investments:%'
            or a.name like 'Assets:Transfers:%')
      order by a.name`, [entId]);

  return {
    accounts: chart.map((r) => r.name),
    entity, month,
    zones: [
      zone("fixed_in", "Fixed · In", "in"), zone("var_in", "Variable · In", "in"),
      zone("fixed_out", "Fixed · Out", "out"), zone("var_out", "Variable · Out", "out"),
    ],
    side: [
      side("work", "Work · reimbursable"),
      side("invest", "Savings & Invest"),
      { key: "pack", label: "The Pack · debt", actual: pack.reduce((s, x) => s + x.amount, 0), shelves: pack },
    ],
  };
}
