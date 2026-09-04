// The decision engine — "the game is the decision engine".
//
// A period (month) has MOVES: the open calls you sort by playing. Four kinds the
// owner named: review the unreviewed, add a missing investment, claim a
// reimbursement, add a one-time. generateMoves() derives them from the ledger;
// the resolve*() functions apply a call as new, balanced, append-only entries and
// record the decision so the same call is never asked twice (the "learn").
//
// ── Sealed or not: the whole difference in how a decision is recorded ────────
//
// Append-only is right for a CLOSED book: you do not erase an entry from a period
// you have reported on, you post an amendment and the amendment is the record.
// It is wrong for a first sort of statements that have never been classified —
// there the "history" preserved is the history of your own tidying, and one
// filed-then-undone crate left five entries on two shelves netting to the
// original. Unreadable, and nothing was learned by keeping it.
//
// So: while a month is UNSEALED a move is a move — the posting changes account,
// one row, one place. Once the month is locked, corrections become append-only
// entries with full lineage, exactly as before.
async function monthSealed(client, entId, txnId) {
  const r = await client.query(
    `select 1 from month_locks ml join transactions t on to_char(t.date,'YYYY-MM') = ml.month
      where ml.entity_id=$1 and t.id=$2`, [entId, txnId]);
  return r.rows.length > 0;
}

// The undo stack lives on the transaction: each staged action pushes what is
// needed to walk it back, and undo pops one.
async function pushStaged(client, txnId, entry) {
  await client.query(
    `update transactions
        set metadata = coalesce(metadata,'{}'::jsonb)
          || jsonb_build_object('staged', coalesce(metadata->'staged','[]'::jsonb) || $2::jsonb)
      where id=$1`, [txnId, JSON.stringify([entry])]);
}

// Reclassification never edits history — it posts a correcting entry (from -> to),
// exactly like the Beancount books' corrections-only rule.
import { query, pool } from "./db.js";

async function entityId(slug) {
  const rows = await query("select id from entities where slug=$1", [slug]);
  if (!rows.length) throw new Error(`no entity ${slug}`);
  return rows[0].id;
}

// ── Read: what does this period need sorted? ────────────────────────────────
export async function generateMoves(entity, { from, to, month } = {}) {
  const entId = await entityId(entity);
  // Accept a month (back-compat) or an explicit {from,to} range (year/quarter/custom).
  if (month && !from) { from = `${month}-01`; to = `${month}-31`; }

  // 1) REVIEW — flagged '!' or hitting the vague "Other" bucket, not vetted ok.
  const review = await query(
    `select distinct on (t.id) t.id, to_char(t.date,'YYYY-MM-DD') as date, t.payee,
            a.name as account, p.amount,
            case when t.flag='!' then 'flagged'
                 else 'unclassified (Other)' end as reason,
            d.decision as suggestion
       from transactions t
       join postings p on p.transaction_id=t.id
       join accounts a on a.id=p.account_id
       left join vettings v on v.transaction_id=t.id and v.status in ('ok','review')
       left join decisions d on d.entity_id=t.entity_id and d.key='payee:'||t.payee
      where t.entity_id=$1 and v.id is null and t.corrects_id is null
        and ($2::date is null or t.date >= $2) and ($3::date is null or t.date <= $3)
        and (t.flag='!' or a.name like 'Expenses:Other%')
      order by t.id, abs(p.amount) desc`,
    [entId, from || null, to || null],
  );

  // 2) CLAIM — each company whose receivable balance is positive (owes you).
  const claim = await query(
    `select split_part(a.name,':',3) as company, a.name as account,
            round(sum(p.amount),2) as outstanding, count(distinct t.id) as items
       from accounts a
       join postings p on p.account_id=a.id
       join transactions t on t.id=p.transaction_id
      where a.entity_id=$1 and a.name like 'Assets:Receivable:%'
      group by a.name having sum(p.amount) > 0
      order by outstanding desc`,
    [entId],
  );

  // 3) MISSING COMMITMENT — only meaningful for a single month.
  let missing = [];
  const anchor = from && to && from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : null;
  if (anchor) {
    missing = await query(
      `select rc.name, rc.amount, a.name as account
         from recurring_commitments rc
         left join accounts a on a.id=rc.account_id
        where rc.entity_id=$1 and rc.active and rc.cadence='monthly'
          and not exists (select 1 from postings p join transactions t on t.id=p.transaction_id
                           where p.account_id=rc.account_id and to_char(t.date,'YYYY-MM')=$2)
        order by rc.amount desc`,
      [entId, anchor],
    );
  }

  return {
    from: from || null, to: to || null,
    review: review.map((r) => ({ id: r.id, date: r.date, payee: r.payee, amount: Number(r.amount), account: r.account, reason: r.reason, suggestion: r.suggestion || null })),
    claim: claim.map((c) => ({ company: c.company, account: c.account, outstanding: Number(c.outstanding), items: Number(c.items) })),
    missing_commitments: missing.map((m) => ({ name: m.name, expected: Number(m.amount), account: m.account })),
    counts: { review: review.length, claim: claim.length, missing: missing.length },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────
const TYPE = (name) => ({ Assets: "assets", Liabilities: "liabilities", Equity: "equity", Income: "income", Expenses: "expenses" }[name.split(":")[0]]);

async function accountId(client, entId, name) {
  const r = await client.query("select id from accounts where entity_id=$1 and name=$2", [entId, name]);
  if (r.rows.length) return r.rows[0].id;
  const ins = await client.query(
    "insert into accounts (entity_id, name, type) values ($1,$2,$3) returning id",
    [entId, name, TYPE(name)],
  );
  return ins.rows[0].id;
}

// Post a balanced 2-leg entry inside a transaction. legs: [{account, amount}].
async function postEntry(client, entId, { date, payee, narration, legs, meta = {}, corrects = null }) {
  const sum = legs.reduce((s, l) => s + l.amount, 0);
  if (Math.abs(sum) > 0.005) throw new Error(`entry not balanced: legs sum to ${sum}`);
  const t = await client.query(
    `insert into transactions (entity_id, date, flag, payee, narration, metadata, corrects_id)
     values ($1,$2,'*',$3,$4,$5,$6) returning id`,
    [entId, date, payee, narration || "", meta, corrects],
  );
  const tid = t.rows[0].id;
  let pos = 0;
  for (const l of legs) {
    const aid = await accountId(client, entId, l.account);
    await client.query("insert into postings (transaction_id, account_id, amount, currency, position) values ($1,$2,$3,'INR',$4)", [tid, aid, l.amount, pos++]);
  }
  return tid;
}

// ── Move: reclassify (review) — correcting entry from one account to another ──
// e.g. an Expenses:Other charge is really Dining. Posts Other -amt / Dining +amt,
// records a decision so it's remembered.
export async function resolveReclassify(entity, { txnId, fromAccount, toAccount, makeRule = false }) {
  const entId = await entityId(entity);
  const client = await pool().connect();
  try {
    await client.query("begin");
    const orig = await client.query(
      `select to_char(t.date,'YYYY-MM-DD') date, t.payee, p.amount
         from transactions t join postings p on p.transaction_id=t.id
        where t.id=$1 and p.account_id=(select id from accounts where entity_id=$2 and name=$3)`,
      [txnId, entId, fromAccount],
    );
    if (!orig.rows.length) throw new Error("original posting not found on that account");
    const { date, payee, amount } = orig.rows[0];
    const amt = Number(amount);

    // UNSEALED: move the posting. No correction, no debris.
    if (!(await monthSealed(client, entId, txnId))) {
      await client.query("set local finops.allow_mutation = 'on'");
      // Open the shelf if it is new. The append-only path got this for free from
      // postEntry; looking the id up inline instead meant a name that did not
      // exist yet resolved to NULL and the move quietly did nothing — which is
      // every "or new shelf…" a person types.
      const toId = await accountId(client, entId, toAccount);
      const moved = await client.query(
        `update postings set account_id=$3
          where transaction_id=$1 and account_id=(select id from accounts where entity_id=$2 and name=$4)`,
        [txnId, entId, toId, fromAccount]);
      // And if nothing moved, say so rather than filing it as done.
      if (!moved.rowCount) throw new Error(`nothing on ${fromAccount} to move — the crate may already have been filed elsewhere`);
      await pushStaged(client, txnId, { kind: "move", from: fromAccount, to: toAccount });
      await client.query(
        `insert into vettings (transaction_id, status, note) values ($1,'ok',$2)
         on conflict (transaction_id) do update set status='ok', note=excluded.note`,
        [txnId, `filed to ${toAccount}`]);
      await client.query("commit");
      return { moved: true, from: fromAccount, to: toAccount, amount: amt, staged: true };
    }

    const tid = await postEntry(client, entId, {
      date, payee, narration: `reclassify ${fromAccount} → ${toAccount} (${payee})`,
      legs: [{ account: fromAccount, amount: -amt }, { account: toAccount, amount: amt }],
      meta: { correction_of: txnId, reclassify: true }, corrects: txnId,
    });
    // mark the original reviewed so it leaves the queue (its Other posting stays,
    // append-only; the vetting is what drops it out of review).
    await client.query(
      `insert into vettings (transaction_id, status, note)
       values ($1,'ok',$2) on conflict (transaction_id) do update set status='ok', note=excluded.note`,
      [txnId, `reclassified → ${toAccount}`],
    );
    // A RULE ONLY WHEN ONE IS ASKED FOR. This wrote a payee decision on every
    // reclassification and merely changed the rationale text, so filing one crate
    // silently taught a rule that then classified every future statement from that
    // payee — makeRule:false meant nothing. Two rules appeared this way after the
    // whole rule table had been deliberately purged.
    if (makeRule) await client.query(
      `insert into decisions (entity_id, key, decision, rationale)
       values ($1,$2,$3,'rule: always this payee → this account')
       on conflict (entity_id,key) do update set decision=excluded.decision`,
      [entId, `payee:${payee}`, toAccount],
    );
    await client.query("commit");
    return { correction_txn: tid, from: fromAccount, to: toAccount, amount: amt, learned: makeRule };
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

// ── Move: add a manual holding statements can't see (off-statement investment) ─
export async function addManualEntry(entity, { date, amount, toAccount, fromAccount = "Assets:Cash", note }) {
  const entId = await entityId(entity);
  const client = await pool().connect();
  try {
    await client.query("begin");
    const tid = await postEntry(client, entId, {
      date, payee: note || "Manual entry",
      legs: [{ account: toAccount, amount: Number(amount) }, { account: fromAccount, amount: -Number(amount) }],
      meta: { manual: true },
    });
    await client.query("commit");
    return { txn: tid, added: Number(amount), to: toAccount, from: fromAccount };
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

// ── Move: claim a reimbursement — batch a company's unclaimed fronted txns ─────
export async function claimReimbursement(entity, { company }) {
  const entId = await entityId(entity);
  const acctName = `Assets:Receivable:${company}`;
  const client = await pool().connect();
  try {
    await client.query("begin");
    const acct = await client.query("select id from accounts where entity_id=$1 and name=$2", [entId, acctName]);
    if (!acct.rows.length) throw new Error(`no receivable account for ${company}`);
    const acctId = acct.rows[0].id;
    // fronted (positive) postings not already in a claim
    const lines = await client.query(
      `select t.id as txn_id, p.amount
         from transactions t join postings p on p.transaction_id=t.id
        where p.account_id=$1 and p.amount > 0
          and not exists (select 1 from reimbursement_lines rl where rl.transaction_id=t.id)`,
      [acctId],
    );
    if (!lines.rows.length) throw new Error(`nothing unclaimed for ${company}`);
    // The claim amount is the NET outstanding (fronted − already reimbursed) — the
    // truth of what's owed; the fronted postings ride along as evidence.
    const net = await client.query("select round(sum(amount),2) as s from postings where account_id=$1", [acctId]);
    const total = Number(net.rows[0].s) || 0;
    if (total <= 0) throw new Error(`nothing outstanding for ${company}`);
    const party = await client.query(
      `insert into parties (workspace_id, slug, name)
       select w.id, $1, $2 from workspaces w limit 1
       on conflict (workspace_id, slug) do update set name=excluded.name returning id`,
      [company.toLowerCase(), company],
    );
    const req = await client.query(
      `insert into reimbursement_requests (entity_id, party_id, receivable_account_id, status, amount)
       values ($1,$2,$3,'draft',$4) returning id`,
      [entId, party.rows[0].id, acctId, total],
    );
    for (const l of lines.rows) {
      await client.query("insert into reimbursement_lines (request_id, transaction_id, amount) values ($1,$2,$3) on conflict do nothing",
        [req.rows[0].id, l.txn_id, Number(l.amount)]);
    }
    await client.query("commit");
    return { request: req.rows[0].id, company, total: Math.round(total * 100) / 100, lines: lines.rows.length };
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

// ── Move: SPLIT a crate — move PART of it to another shelf, remainder stays. A
// partial reclassification: posts a balanced entry that moves `amount` (magnitude)
// in the crate's own direction from one account to another. The original stays
// (append-only); the two shelves' nets adjust by the split amount.
export async function splitReclassify(entity, { txnId, fromAccount, toAccount, amount }) {
  const entId = await entityId(entity);
  const client = await pool().connect();
  try {
    await client.query("begin");
    const orig = await client.query(
      `select to_char(t.date,'YYYY-MM-DD') date, t.payee, p.amount
         from transactions t join postings p on p.transaction_id=t.id
        where t.id=$1 and p.account_id=(select id from accounts where entity_id=$2 and name=$3)`,
      [txnId, entId, fromAccount]);
    if (!orig.rows.length) throw new Error("original posting not found on that account");
    const { date, payee, amount: origAmt } = orig.rows[0];
    const oa = Number(origAmt);
    const mag = Math.min(Math.abs(Number(amount)), Math.abs(oa) - 1);   // can't move the whole crate (use Move for that)
    if (!(mag > 0)) throw new Error("split amount must be positive and less than the crate");
    const part = Math.sign(oa) * mag;                                   // signed partial to move
    const tid = await postEntry(client, entId, {
      date, payee, narration: `split ${fromAccount.split(":").pop()} → ${toAccount.split(":").pop()}: ₹${Math.round(mag)} of ₹${Math.round(Math.abs(oa))} (${payee || ""})`,
      legs: [{ account: fromAccount, amount: -part }, { account: toAccount, amount: part }],
      meta: { split_of: txnId },
    });
    await client.query("commit");
    return { split_txn: tid, moved: Math.round(mag), from: fromAccount, to: toAccount };
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
}

// SPLIT ACROSS SEVERAL SHELVES AT ONCE.
//
// splitReclassify moves one amount to one account, so a crate that belongs to
// three places took three passes and left two intermediate states that were
// wrong. This posts ONE entry with a leg per destination: the drill reads as a
// single decision, and it cannot half-apply.
//
// Whatever is left stays where it was — the remainder is not a destination you
// have to name.
export async function splitMany(entity, { txnId, fromAccount, parts }) {
  const entId = await entityId(entity);
  const rows = (parts || [])
    .map((p) => ({ account: String(p.account || "").trim(), amount: Math.abs(Number(p.amount) || 0) }))
    .filter((p) => p.account && p.amount > 0);
  if (rows.length < 1) throw new Error("give at least one destination and amount");
  if (new Set(rows.map((r) => r.account)).size !== rows.length) throw new Error("the same shelf is listed twice — combine them into one line");
  if (rows.some((r) => r.account === fromAccount)) throw new Error("a split cannot send money back to the shelf it is leaving");

  const client = await pool().connect();
  try {
    await client.query("begin");
    const orig = await client.query(
      `select to_char(t.date,'YYYY-MM-DD') date, t.payee, p.amount
         from transactions t join postings p on p.transaction_id=t.id
        where t.id=$1 and p.account_id=(select id from accounts where entity_id=$2 and name=$3)`,
      [txnId, entId, fromAccount]);
    if (!orig.rows.length) throw new Error("original posting not found on that account");
    const { date, payee, amount: origAmt } = orig.rows[0];
    const oa = Number(origAmt), whole = Math.abs(oa);
    const total = rows.reduce((t, r) => t + r.amount, 0);
    if (total > whole + 0.005)
      throw new Error(`those parts add to ₹${Math.round(total)}, more than the ₹${Math.round(whole)} on the crate`);

    const sign = Math.sign(oa);

    // UNSEALED: reshape the postings themselves — the original shrinks to the
    // remainder (or goes, if nothing is left) and each part becomes its own leg.
    if (!(await monthSealed(client, entId, txnId))) {
      await client.query("set local finops.allow_mutation = 'on'");
      const leftoverAmt = sign * (whole - total);
      if (Math.abs(leftoverAmt) < 0.005) {
        await client.query(
          `delete from postings where transaction_id=$1 and account_id=(select id from accounts where entity_id=$2 and name=$3)`,
          [txnId, entId, fromAccount]);
      } else {
        await client.query(
          `update postings set amount=$4 where transaction_id=$1 and account_id=(select id from accounts where entity_id=$2 and name=$3)`,
          [txnId, entId, fromAccount, leftoverAmt]);
      }
      for (const r of rows) {
        const aid = await accountId(client, entId, r.account);
        await client.query(
          `insert into postings (transaction_id, account_id, amount, currency, position)
           values ($1,$2,$3,'INR',(select coalesce(max(position),0)+1 from postings where transaction_id=$1))`,
          [txnId, aid, sign * r.amount]);
      }
      await pushStaged(client, txnId, { kind: "split", from: fromAccount, whole, parts: rows });
      if (Math.abs(leftoverAmt) < 0.005) await client.query(
        `insert into vettings (transaction_id, status, note) values ($1,'ok',$2)
         on conflict (transaction_id) do update set status='ok', note=excluded.note`,
        [txnId, `split across ${rows.length} shelves`]);
      await client.query("commit");
      return { split: true, staged: true, moved: Math.round(total), left: Math.round((whole - total) * 100) / 100, parts: rows };
    }

    const legs = [{ account: fromAccount, amount: -sign * total }];
    for (const r of rows) legs.push({ account: r.account, amount: sign * r.amount });
    const leftover = Math.round((whole - total) * 100) / 100;
    const tid = await postEntry(client, entId, {
      date, payee,
      narration: `split ${fromAccount.split(":").pop()} → ${rows.map((r) => `${r.account.split(":").pop()} ₹${Math.round(r.amount)}`).join(", ")}`
        + ` of ₹${Math.round(whole)}${leftover > 0 ? ` (₹${Math.round(leftover)} left)` : ""}`,
      legs, meta: { split_of: txnId, parts: rows },
    });
    // Nothing is left behind: the crate is fully accounted for, so it is filed.
    if (leftover < 0.01) await client.query(
      `insert into vettings (transaction_id, status, note) values ($1,'ok',$2)
       on conflict (transaction_id) do update set status='ok', note=excluded.note`,
      [txnId, `split across ${rows.length} shelves`]);
    await client.query("commit");
    return { split_txn: tid, moved: Math.round(total), left: leftover, parts: rows, filed: leftover < 0.01 };
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
}

// UNDO THE LAST FILING of a crate.
//
// The books are append-only, so undoing is not deleting: it posts an entry that
// is the exact mirror of the last correction or split, which nets that decision
// to zero and leaves both entries on the record. The crate goes back to
// 'unvetted', so it returns to the list of line items to be decided again.
//
// Only the LAST decision is undone. Pressing it twice walks back two.
export async function undoLastFiling(entity, { txnId }) {
  const entId = await entityId(entity);
  const client = await pool().connect();
  try {
    await client.query("begin");

    // UNSEALED: walk back the last staged action from the stack on the crate.
    if (!(await monthSealed(client, entId, txnId))) {
      const st = await client.query("select coalesce(metadata->'staged','[]'::jsonb) st from transactions where id=$1", [txnId]);
      const stack = st.rows[0]?.st || [];
      // A crate filed BEFORE this change was recorded as an append-only
      // correction and has no stack. Fall through to reversing that entry rather
      // than claiming it was never filed.
      if (stack.length) {
      const step = stack[stack.length - 1];
      await client.query("set local finops.allow_mutation = 'on'");

      if (step.kind === "move") {
        await client.query(
          `update postings set account_id=(select id from accounts where entity_id=$2 and name=$3)
            where transaction_id=$1 and account_id=(select id from accounts where entity_id=$2 and name=$4)`,
          [txnId, entId, step.from, step.to]);
      } else if (step.kind === "split") {
        // drop the parts, then put the original leg back whole
        for (const r of step.parts || []) {
          await client.query(
            `delete from postings where ctid in (
               select p.ctid from postings p join accounts a on a.id=p.account_id
                where p.transaction_id=$1 and a.name=$2 and abs(abs(p.amount)-$3) < 0.005 limit 1)`,
            [txnId, r.account, Math.abs(Number(r.amount))]);
        }
        const back = await client.query(
          `select p.id, p.amount from postings p join accounts a on a.id=p.account_id
            where p.transaction_id=$1 and a.name=$2 limit 1`, [txnId, step.from]);
        const sign = Math.sign(Number(back.rows[0]?.amount) || 1);
        if (back.rows.length) {
          await client.query("update postings set amount=$2 where id=$1", [back.rows[0].id, sign * step.whole]);
        } else {
          const aid = await accountId(client, entId, step.from);
          // the original leg was consumed entirely; recreate it with the sign the
          // parts carried, since that is the direction the money was going
          const anyPart = await client.query(
            `select p.amount from postings p where p.transaction_id=$1 limit 1`, [txnId]);
          const sgn = Math.sign(Number(anyPart.rows[0]?.amount) || 1) * -1;
          await client.query(
            `insert into postings (transaction_id, account_id, amount, currency, position)
             values ($1,$2,$3,'INR',(select coalesce(max(position),0)+1 from postings where transaction_id=$1))`,
            [txnId, aid, sgn * step.whole]);
        }
      }

      await client.query(
        `update transactions set metadata = coalesce(metadata,'{}'::jsonb)
           || jsonb_build_object('staged', (coalesce(metadata->'staged','[]'::jsonb) - -1))
          where id=$1`, [txnId]);
      await client.query(
        `insert into vettings (transaction_id, status, note) values ($1,'unvetted','filing undone')
         on conflict (transaction_id) do update set status='unvetted', note=excluded.note`, [txnId]);
      await client.query("commit");
      return { undone: step, staged: true, txnId };
      }
    }

    // the most recent entry that acted on this crate and has not itself been undone
    const last = await client.query(
      `select t.id, to_char(t.date,'YYYY-MM-DD') date, t.payee, t.narration
         from transactions t
        where t.entity_id=$1
          and (t.corrects_id=$2 or (t.metadata->>'split_of')::uuid=$2)
          and coalesce(t.metadata->>'undo_of','') = ''
          -- "already reversed" is READ from the ledger, not stamped onto it. The
          -- previous version marked the entry metadata.undone = true, which is an
          -- UPDATE on transactions — refused by the append-only guard this very
          -- branch exists to honour, so undo failed every time it was pressed.
          and not exists (
            select 1 from transactions u
             where u.entity_id = t.entity_id and (u.metadata->>'undo_of')::uuid = t.id)
        order by t.created_at desc limit 1`, [entId, txnId]);
    if (!last.rows.length) throw new Error("nothing to undo on this one — it has not been filed, or the filing was already reversed");
    const { id: lastId, date, payee, narration } = last.rows[0];

    const legs = await client.query(
      `select a.name, p.amount from postings p join accounts a on a.id=p.account_id where p.transaction_id=$1`, [lastId]);

    const tid = await postEntry(client, entId, {
      date, payee, narration: `undo — ${String(narration || "").slice(0, 160)}`,
      legs: legs.rows.map((l) => ({ account: l.name, amount: -Number(l.amount) })),
      meta: { undo_of: lastId, undoes: txnId },
    });
    // back into the list to be decided again
    await client.query(
      `insert into vettings (transaction_id, status, note) values ($1,'unvetted','filing undone')
       on conflict (transaction_id) do update set status='unvetted', note=excluded.note`, [txnId]);
    await client.query("commit");
    return { undo_txn: tid, reversed: lastId, txnId };
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
}

// A MANUAL ENTRY — the one thing a statement-driven ledger cannot produce.
//
// Every row in this book comes from an imported PDF, which means anything true
// before the first statement has no way in. A receivable that already existed on
// day one is the clear case: Mandar owed ₹33,995 for dinners fronted in March, so
// April's repayments land on an account that started at zero and the balance goes
// negative — right arithmetic, wrong story. The opening balance is a fact about
// the world, not a transaction on a statement.
//
// Balanced legs only, and it refuses an account that is not open: an opening
// balance is exactly where a typo would be silent and permanent.
export async function addJournalEntry(entity, { date, payee, narration, legs, tags = null }) {
  const entId = await entityId(entity);
  const rows = (legs || [])
    .map((l) => ({ account: String(l.account || "").trim(), amount: Math.round(Number(l.amount) * 100) / 100 }))
    .filter((l) => l.account && Number.isFinite(l.amount) && l.amount !== 0);
  if (rows.length < 2) throw new Error("a journal entry needs at least two legs — what it is, and where it came from");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("date must be YYYY-MM-DD");
  const sum = rows.reduce((t, l) => t + l.amount, 0);
  if (Math.abs(sum) > 0.005)
    throw new Error(`those legs sum to ${Math.round(sum * 100) / 100}, not zero — every entry must balance. Positive is money into an account, negative out of it.`);

  const client = await pool().connect();
  try {
    await client.query("begin");
    for (const l of rows) {
      const open = await client.query(
        `select 1 from accounts a where a.entity_id=$1 and a.name=$2`, [entId, l.account]);
      if (!open.rows.length) throw new Error(`${l.account} is not open — use open_account first.`);
    }
    const tid = await postEntry(client, entId, {
      date, payee: payee || "Manual entry", narration: narration || "",
      legs: rows, meta: { manual: true },
    });
    if (tags?.length) {
      await client.query("set local finops.allow_mutation = 'on'");
      await client.query("update transactions set tags=$2 where id=$1", [tid, tags]);
    }
    // A manual entry is a decision already made — it does not go in the pile.
    await client.query(
      `insert into vettings (transaction_id, status, note) values ($1,'ok','manual entry')
       on conflict (transaction_id) do update set status='ok', note=excluded.note`, [tid]);
    await client.query("commit");
    return { id: tid, date, legs: rows, balanced: true };
  } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
}

// ── Move: send to Review — defer a transaction you can't decide now. It leaves
// the pile and lands in the "Review later" stack (vetting status 'review').
export async function markReview(entity, { txnId, note }) {
  await query(
    `insert into vettings (transaction_id, status, note) values ($1,'review',$2)
     on conflict (transaction_id) do update set status='review', note=excluded.note`,
    [txnId, note || "sent to review"]);
  return { ok: true, txnId, status: "review" };
}
