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


export async function warehouseMonth(entity, month) {
  const entId = await entityId(entity);

  // per-account totals + crate counts for the month (economic legs only).
  // NOTE: corrections are INCLUDED (no corrects_id filter) so a reclassification —
  // a move on the board — nets against the original and the shelf totals update live.
  // A SHELF HOLDS WHAT YOU HAVE FILED, nothing else.
  //
  // Shelves used to be built from wherever the importer's classifier happened to
  // put a row, so the board arrived pre-filled with decisions nobody made. Every
  // imported transaction starts 'unvetted'; it appears in the list of line items
  // and lands on a shelf only once it has been put there — which is what marks it
  // 'ok'. So the board starts blank and fills as the work is done.
  const rows = await query(
    `select a.name, count(distinct t.id)::int n, round(sum(p.amount),2) amt
       from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
       -- A CORRECTION INHERITS WHAT IT CORRECTS. Filing a row posts a reversal
       -- plus a leg on the new account (append-only — nothing is rewritten), and
       -- those entries carry no vetting of their own. Joining on t.id alone
       -- admitted the original and dropped both halves of the correction, so the
       -- old shelf kept the full amount and the new shelf never appeared. A split
       -- records its parent as metadata.split_of rather than corrects_id.
       join vettings v
         on v.transaction_id = coalesce(t.corrects_id, (t.metadata->>'split_of')::uuid, t.id)
        and v.status = 'ok'
      where t.entity_id=$1 and to_char(t.date,'YYYY-MM')=$2
        -- EVERY economic account. This listed four families, so Assets:Clearing
        -- (598 postings, ₹1.02cr of self-transfers and card payments), the loan
        -- accounts and Equity never became shelves — money you cannot see is money
        -- you cannot account for.
        and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
      group by a.name`, [entId, month]);

  // player zoning overrides (move a shelf Fixed↔Variable).
  let ov = new Map();
  try { ov = new Map((await query("select account, fixed from account_zones where entity_id=$1", [entId])).map((r) => [r.account, r.fixed])); } catch { /* table optional */ }

  const Z = { fixed_in: [], var_in: [], fixed_out: [], var_out: [], work: [], invest: [], moves: [] };
  for (const r of rows) {
    const name = r.name, amt = Number(r.amt), mag = Math.abs(amt);
    if (mag < 1) continue;
    // NOTHING IS PRE-SORTED. Fixed vs Variable used to be guessed — a name-regex
    // for income, a recurring-commitments list for expenses — so shelves arrived
    // already sorted into aisles nobody chose. A shelf is Fixed only if the owner
    // has said so (account_zones); everything else starts Variable.
    const shelf = { name: leaf(name), account: name, amount: r0(mag), count: r.n };
    if (name.startsWith("Income:")) {
      const fixed = ov.get(name) === true;
      (fixed ? Z.fixed_in : Z.var_in).push({ ...shelf, fixed });
    } else if (name.startsWith("Expenses:")) {
      const fixed = ov.get(name) === true;
      (fixed ? Z.fixed_out : Z.var_out).push({ ...shelf, fixed });
    } else if (name.startsWith("Assets:Investments:")) Z.invest.push(shelf);
    else if (name.startsWith("Assets:Receivable:")) Z.work.push(shelf);
    else Z.moves.push(shelf);   // clearing, transfers, loans, payables, equity
  }

  // The Pack — loans as-of (not month), the debt you carry.
  const loans = await query(
    `select a.name, round(sum(p.amount),0) amt
       from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
      where t.entity_id=$1 and a.name like 'Liabilities:Loans:%'
      group by a.name having abs(sum(p.amount)) > 1`, [entId]);
  const pack = loans.map((l) => ({ name: l.name.split(":").pop(), account: l.name, amount: r0(Math.abs(Number(l.amt))), count: null }))
    .sort((a, b) => b.amount - a.amount);

  // No plan. The board shows what happened, not what was expected.
  const planned = {};

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
       and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
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
      side("moves", "Transfers, loans & clearing"),
      { key: "pack", label: "The Pack · debt", actual: pack.reduce((s, x) => s + x.amount, 0), shelves: pack },
    ],
  };
}
