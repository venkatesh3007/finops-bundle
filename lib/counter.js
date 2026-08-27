// THE COUNTER — the rush. A customer (a company you fronted for) walks up asking
// "what do I owe you?" A well-sorted warehouse answers instantly: the itemized
// reimbursement statement + the outstanding total, straight off the Work shelves.
// This is the payoff loop — the reward for having sorted your crates.
import { query } from "./db.js";

async function entityId(slug) {
  const rows = await query("select id from entities where slug=$1", [slug]);
  if (!rows.length) throw new Error(`no entity ${slug}`);
  return rows[0].id;
}
const r0 = (n) => Math.round(Number(n) || 0);
const PLUMB = /correction|reversal|sweep|pass-through|reclassif|recovered|catch-up|missed statement/i;

export async function computeCounter(entity) {
  const entId = await entityId(entity);

  // each company you've fronted for (a Work / Receivable shelf).
  const comps = await query(
    `select a.name, split_part(a.name,':',3) as company,
            round(sum(p.amount),0) as outstanding,
            round(sum(p.amount) filter (where p.amount>0),0) as fronted,
            round(-sum(p.amount) filter (where p.amount<0),0) as reimbursed
       from accounts a join postings p on p.account_id=a.id join transactions t on t.id=p.transaction_id
      where a.entity_id=$1 and a.name like 'Assets:Receivable:%'
      group by a.name`, [entId]);

  const customers = [];
  for (const c of comps) {
    // the statement lines: the real fronted expenses (positive, non-plumbing).
    const items = await query(
      `select to_char(t.date,'YYYY-MM-DD') as date, coalesce(t.payee,'') as payee,
              coalesce(t.narration,'') as narration, round(p.amount,0) as amount, t.source_file as doc
         from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
        where a.entity_id=$1 and a.name=$2 and p.amount>0 and t.corrects_id is null
        order by t.date desc`, [entId, c.name]);
    // real fronted expenses only — drop book plumbing and the lump re-attribution
    // entries (payee "Reclass", or the company's own name on a loan-transfer lump).
    const clean = items.filter((i) =>
      !PLUMB.test(i.payee + " " + i.narration) &&
      i.payee !== "Reclass" && i.payee !== c.company &&
      !/held as loan|attributed frontings|re-attributed|pass-through/i.test(i.narration));
    customers.push({
      company: c.company, account: c.name,
      outstanding: r0(c.outstanding), fronted: r0(c.fronted), reimbursed: r0(c.reimbursed),
      itemCount: clean.length,
      items: clean.map((i) => ({
        date: i.date, desc: (i.payee || i.narration || "—"), amount: r0(i.amount), doc: i.doc || null,
      })),
    });
  }
  // most-owed first; companies fully settled (outstanding 0) go last, still viewable.
  customers.sort((a, b) => b.outstanding - a.outstanding);
  return { entity, customers, totalOwed: customers.reduce((s, c) => s + Math.max(0, c.outstanding), 0) };
}
