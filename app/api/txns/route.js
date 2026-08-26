import { query } from "../../../lib/db";
export const maxDuration = 60;

// GET /api/txns — the source of truth. Powers the sort PILE and every drill-down.
//   ?entity=personal
//   &queue=1                 -> ONE card per transaction that needs sorting (in Other
//                               or flagged), not yet sorted (ok) or deferred (review)
//   &account=Expenses:Dining -> every posting to a category (drill-down)
//   &status=review           -> the deferred "Review later" pile
//   &from=&to=&text=&limit=
// Each row carries the RAW line (payee + narration) + its source account/doc.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const entity = q.entity || "personal";
    const ent = await query("select id from entities where slug=$1", [entity]);
    if (!ent.length) return Response.json({ error: "no entity" }, { status: 400 });
    const entId = ent[0].id;

    const where = ["t.entity_id = $1", "t.corrects_id is null"];
    const params = [entId];
    const P = (v) => { params.push(v); return `$${params.length}`; };
    if (q.account) where.push(`a.name like ${P(q.account + "%")}`);
    if (q.from) where.push(`t.date >= ${P(q.from)}`);
    if (q.to) where.push(`t.date <= ${P(q.to)}`);
    if (q.text) where.push(`(coalesce(t.payee,'')||' '||coalesce(t.narration,'')) ilike ${P("%" + q.text + "%")}`);
    const limit = Math.min(500, Number(q.limit) || 60);

    const cols = `t.id, to_char(t.date,'YYYY-MM-DD') as date, t.payee, t.narration, t.source_file,
                  t.corrects_id, (t.metadata->>'entered_by') as entered_by,
                  a.name as account, p.amount, coalesce(v.status,'unvetted') as status, d.decision as suggestion,
                  (select a2.name from postings p2 join accounts a2 on a2.id=p2.account_id
                     where p2.transaction_id=t.id
                       and (a2.name like 'Assets:Bank:%' or a2.name like 'Assets:Cash%' or a2.name like 'Liabilities:Card:%')
                     order by abs(p2.amount) desc limit 1) as source_account`;
    const joins = `from transactions t
       join postings p on p.transaction_id=t.id
       join accounts a on a.id=p.account_id
       left join vettings v on v.transaction_id=t.id
       left join decisions d on d.entity_id=t.entity_id and d.key='payee:'||t.payee`;

    let rows, pile = null, total = null;
    if (q.all) {
      // THE STATEMENT — every line, one row per transaction (its primary economic
      // leg), newest first. Month + text filters, paginated. This is the full pile
      // the game hides — available on demand when you need to see everything.
      if (q.month) where.push(`to_char(t.date,'YYYY-MM') = ${P(q.month)}`);
      // "flows only" — drop whole transactions that are internal bookkeeping (any leg
      // on the household side, clearing, or equity) so what's left is real bank/card
      // statement movement. Must exclude the TRANSACTION, not just the leg.
      if (q.flows) where.push(`not exists (select 1 from postings pf join accounts af on af.id=pf.account_id
        where pf.transaction_id=t.id and (af.name like 'Assets:Household%' or af.name like 'Assets:Clearing%' or af.name like 'Equity:%'))`);
      // provenance lens: statement (real bank/card line) vs reconstructed (entered
      // during cleanup — metadata.entered_by). Corrections are excluded by the base
      // where (corrects_id is null), so reconstructions are entered_by-set entries.
      if (q.prov === "reconstructed") where.push(`(t.metadata->>'entered_by') is not null`);
      else if (q.prov === "statement") where.push(`(t.metadata->>'entered_by') is null`);
      const offset = Math.max(0, Number(q.offset) || 0);
      const c = await query(
        `select count(distinct t.id) n from transactions t
           join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
          where ${where.join(" and ")}`, params);
      total = Number(c[0].n);
      rows = await query(
        `select * from (
           select distinct on (t.id) ${cols} ${joins} where ${where.join(" and ")}
           order by t.id,
             (case when a.name like 'Assets:Bank:%' or a.name like 'Assets:Cash%' or a.name like 'Liabilities:Card:%' then 2
                   when a.name like 'Equity:%' then 3 else 0 end),
             abs(p.amount) desc
         ) q order by q.date desc, abs(q.amount) desc limit ${limit} offset ${offset}`, params);
    } else if (q.queue) {
      // one card per transaction — its Expenses:Other (or flagged) leg — not yet sorted/deferred.
      where.push(`a.name like 'Expenses:Other%'`);
      where.push(`coalesce(v.status,'unvetted') not in ('ok','review')`);
      rows = await query(
        `select * from (
           select distinct on (t.id) ${cols} ${joins} where ${where.join(" and ")}
           order by t.id, (case when a.name like 'Expenses:Other%' then 0 else 1 end), abs(p.amount) desc
         ) q order by abs(amount) desc, date desc limit ${limit}`, params);
      const c = await query(
        `select count(distinct t.id) as n from transactions t
           join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
           left join vettings v on v.transaction_id=t.id
          where t.entity_id=$1 and t.corrects_id is null
            and a.name like 'Expenses:Other%'
            and coalesce(v.status,'unvetted') not in ('ok','review')`, [entId]);
      pile = Number(c[0].n);
    } else {
      if (q.status) where.push(`coalesce(v.status,'unvetted') = ${P(q.status)}`);
      rows = await query(`select ${cols} ${joins} where ${where.join(" and ")} order by t.date desc, abs(p.amount) desc limit ${limit}`, params);
    }

    return Response.json({
      pile, total,
      txns: rows.map((r) => ({
        id: r.id, date: r.date, payee: r.payee, narration: r.narration || "",
        // where the line came from: the funding bank/card (statement) + the source doc.
        statement: r.source_account ? r.source_account.split(":").slice(1).join(" ") : null,
        doc: r.source_file || null,
        account: r.account, amount: Number(r.amount),
        status: r.status, suggestion: r.suggestion || null,
        // provenance: what kind of line this is.
        provenance: r.corrects_id ? "correction" : (r.entered_by ? "reconstructed" : "statement"),
        hasDoc: !!(r.source_file && r.source_file.length),
      })),
    });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
