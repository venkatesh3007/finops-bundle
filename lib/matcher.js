// The matcher IS the game. Given a month's PLAN (plan_lines from notes) and REALITY
// (the month's transactions), it auto-links each plan line to the transaction that
// fulfilled it — amount within a window, direction, and label/counterparty keywords.
// Matched lines auto-tick; only the misses (unmatched lines + unexplained txns)
// surface as exception cards. Never returns the raw pile.
import { query } from "./db.js";

const STOP = new Set(["the", "and", "for", "via", "inv", "amex", "card", "loan", "emi", "bill", "fee", "trip", "out", "going"]);
const kws = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

export async function matchMonth(entity, month) {
  const ent = (await query("select id from entities where slug=$1", [entity]))[0]?.id;
  if (!ent) throw new Error(`no entity ${entity}`);

  const plan = await query(
    "select id, bucket, label, amount, counterparty_hint from plan_lines where entity_id=$1 and month=$2 order by amount desc",
    [ent, month]);

  // per-transaction flow: magnitude + direction + searchable text.
  const trows = await query(
    `select t.id, to_char(t.date,'YYYY-MM-DD') as date,
            coalesce(t.payee,'')||' '||coalesce(t.narration,'') as text,
            max(abs(p.amount)) as mag,
            coalesce(sum(case when a.name like 'Assets:Bank:%' or a.name like 'Assets:Cash%'
                                or a.name like 'Liabilities:Card:%' then p.amount else 0 end),0) as bankflow,
            bool_or(a.name like 'Income:%' or a.name like 'Assets:Receivable:%') as has_in,
            case when bool_or(a.name like 'Expenses:%') then 'expense'
                 when bool_or(a.name like 'Income:%') then 'income'
                 when bool_or(a.name like 'Assets:Receivable:%') then 'work'
                 when bool_or(a.name like 'Assets:Investments:%') then 'invest'
                 when bool_or(a.name like 'Liabilities:Loans:%') then 'loan'
                 else 'other' end as kind
       from transactions t
       join postings p on p.transaction_id=t.id
       join accounts a on a.id=p.account_id
      where t.entity_id=$1 and to_char(t.date,'YYYY-MM')=$2 and t.corrects_id is null
        and exists (
          select 1 from postings pp join accounts aa on aa.id=pp.account_id
           where pp.transaction_id=t.id and aa.name not like '%Household%'
             and (aa.name like 'Income:%' or aa.name like 'Expenses:%'
                  or aa.name like 'Assets:Investments:%' or aa.name like 'Assets:Receivable:%'
                  or aa.name like 'Liabilities:Loans:%'))
      group by t.id, t.payee, t.narration, t.date`, [ent, month]);

  const txns = trows.map((r) => {
    const bank = Number(r.bankflow), mag = Number(r.mag);
    const dir = bank < -1 ? "out" : bank > 1 ? "in" : (r.has_in ? "in" : "out");
    // cleanup-session adjustments (corrections, reclassifications, pass-throughs,
    // reference/recovered entries) are bookkeeping, not reality to surface.
    const adj = /correction|reclassif|pass-through|recovered|reference|catch-up|missed statement/i.test(r.text);
    return { id: r.id, date: r.date, text: r.text, mag: bank !== 0 ? Math.abs(bank) : mag, dir, kind: r.kind, adj, tk: kws(r.text), used: false };
  });
  const totalTxnValue = txns.reduce((s, t) => s + t.mag, 0);

  const matched = [], missesPlan = [];
  for (const pl of plan) {
    const dir = ["fixed_in", "var_in"].includes(pl.bucket) ? "in" : "out";
    const P = Number(pl.amount);
    const tol = Math.max(P * 0.12, 2000); // ±12% or ₹2000 (plan amounts are rounded)
    const plk = kws(pl.label + " " + (pl.counterparty_hint || ""));
    let best = null, bestScore = -1;
    for (const t of txns) {
      if (t.used || t.dir !== dir) continue;
      const d = Math.abs(t.mag - P);
      if (d > tol) continue;
      const kwHits = plk.filter((k) => t.text.toLowerCase().includes(k)).length;
      const score = kwHits * 100 + (1 - d / (tol + 1)); // keyword first, then closeness
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best) {
      best.used = true;
      const kwHits = plk.filter((k) => best.text.toLowerCase().includes(k)).length;
      matched.push({ plan: pl, txn: best, method: kwHits ? "rule" : "amount_window", confidence: kwHits ? 95 : 70 });
    } else {
      missesPlan.push(pl); // a planned line with no matching transaction = a surprise
    }
  }

  const matchedValue = matched.reduce((s, m) => s + m.txn.mag, 0);
  const unexplained = txns.filter((t) => !t.used); // reality not in the plan

  // NOTHING IS HIDDEN. This used to card only unmatched personal spend or income
  // of ₹10k or more and quietly absorb the rest into the bucket totals — 87% of
  // transactions, ₹61.5L, including 1,118 rows still sitting in Expenses:Other
  // and 537 in Income:Other, which are exactly the ones needing a decision. It
  // also dropped investments, loan movements and anything the text called a
  // correction, on the reasoning that those are "known".
  //
  // The owner is accounting every line by hand, so every line has to appear.
  // SURPRISE_MIN is kept as a knob at 0 rather than deleted: raising it is how
  // absorption comes back, if it ever should.
  const SURPRISE_MIN = Number(process.env.GAME_CARD_MIN || 0);
  const isSurprise = (t) => t.mag >= SURPRISE_MIN;
  const surprises = unexplained.filter(isSurprise);
  const absorbed = unexplained.filter((t) => !isSurprise(t));
  const absorbedValue = absorbed.reduce((s, t) => s + t.mag, 0);
  const handledValue = matchedValue + absorbedValue;
  const exceptions = missesPlan.length + surprises.length;

  return {
    month,
    planTotal: plan.length, planMatched: matched.length,
    planCoverage: plan.length ? Math.round((matched.length / plan.length) * 100) : 100,
    handledCoverage: totalTxnValue ? Math.round((handledValue / totalTxnValue) * 100) : 100,
    exceptions,                                    // the cards you actually see
    detail: { missedPlanLines: missesPlan.length, surprises: surprises.length, absorbedTxns: absorbed.length },
    matched, missesPlan, surprises, absorbed,
  };
}
