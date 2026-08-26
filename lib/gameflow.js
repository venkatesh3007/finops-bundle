// The game loop: PLAN → REALITY → LOCK.
//
// The matcher (matcher.js) is the deterministic first pass — it auto-ticks ~90%
// of a month. gameflow.js is everything around it: it overlays the player's
// persisted decisions (manual links, deferrals, skipped plan lines, locks),
// turns whatever's LEFT into one-tap case-file cards (never the raw pile), and
// seals the month with a payoff. monthState() is what the board renders.
import { query, pool } from "./db.js";
import { matchMonth } from "./matcher.js";
import { resolveReclassify, markReview } from "./moves.js";

async function entityId(slug) {
  const rows = await query("select id from entities where slug=$1", [slug]);
  if (!rows.length) throw new Error(`no entity ${slug}`);
  return rows[0].id;
}
const r0 = (n) => Math.round(Number(n) || 0);

// Case files for a set of surprise txns: the evidence the card shows. Each points
// at its economic account (what it was), its funding statement (bank/card leg),
// and the source document — so nothing is a summary; everything points to source.
async function caseFiles(entId, month, ids) {
  if (!ids.length) return {};
  const rows = await query(
    `select t.id, to_char(t.date,'YYYY-MM-DD') as date, t.payee, t.narration, t.source_file,
       (select a.name from postings p join accounts a on a.id=p.account_id
          where p.transaction_id=t.id and (a.name like 'Expenses:%' or a.name like 'Income:%'
            or a.name like 'Assets:Investments:%' or a.name like 'Assets:Receivable:%'
            or a.name like 'Liabilities:Loans:%')
          order by abs(p.amount) desc limit 1) as account,
       (select a.name from postings p join accounts a on a.id=p.account_id
          where p.transaction_id=t.id and (a.name like 'Assets:Bank:%' or a.name like 'Assets:Cash%'
            or a.name like 'Liabilities:Card:%')
          order by abs(p.amount) desc limit 1) as statement
     from transactions t where t.entity_id=$1 and t.id = any($2)`,
    [entId, ids]);
  const by = {};
  for (const r of rows) by[r.id] = r;
  return by;
}

// The categories the player can drop an unknown into (chips only appear on genuine
// unknowns). Pulled from the accounts the book already uses, minus the noise.
async function expenseCategories(entId) {
  const rows = await query(
    `select name from accounts where entity_id=$1 and name like 'Expenses:%'
       and name not like 'Expenses:Other%' and name not like '%Household%' order by name`, [entId]);
  return rows.map((r) => r.name);
}

// consecutive locked months ending AT `month` (inclusive if it is locked).
function streakEndingAt(lockedMonths, month) {
  const set = new Set(lockedMonths);
  let m = month, streak = 0;
  while (set.has(m)) { streak++; m = prevMonth(m); }
  return streak;
}
function prevMonth(m) {
  let [y, mo] = m.split("-").map(Number); mo--; if (mo < 1) { mo = 12; y--; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

// ── The board state for one month ────────────────────────────────────────────
export async function monthState(entity, month) {
  const entId = await entityId(entity);
  const auto = await matchMonth(entity, month);

  // Persisted player decisions layered on top of the auto-pass.
  const [pmRows, vetRows, plStatus, lockRow, lockedAll] = await Promise.all([
    query(`select pm.plan_line_id, pm.txn_id, pm.method from plan_matches pm
             join plan_lines pl on pl.id=pm.plan_line_id
            where pl.entity_id=$1 and pl.month=$2 and pm.method='manual'`, [entId, month]),
    query(`select v.transaction_id, v.status from vettings v
             join transactions t on t.id=v.transaction_id
            where t.entity_id=$1 and to_char(t.date,'YYYY-MM')=$2 and v.status in ('ok','review','wrong')`, [entId, month]),
    query(`select id, status from plan_lines where entity_id=$1 and month=$2 and status<>'open'`, [entId, month]),
    query(`select plan_coverage, handled_coverage, exceptions, locked_at, stats from month_locks where entity_id=$1 and month=$2`, [entId, month]),
    query(`select month from month_locks where entity_id=$1`, [entId]),
  ]);

  const manualTxn = new Set(pmRows.map((r) => r.txn_id));
  const manualPL = new Set(pmRows.map((r) => r.plan_line_id));
  const vet = new Map(vetRows.map((r) => [r.transaction_id, r.status]));
  const plStat = new Map(plStatus.map((r) => [r.id, r.status]));

  // MISSES — planned lines with no reality. Drop the ones the player already ruled
  // (skipped / carried) or manually linked to a txn.
  const misses = auto.missesPlan
    .filter((pl) => plStat.get(pl.id) !== "skipped" && plStat.get(pl.id) !== "carried" && !manualPL.has(pl.id))
    .map((pl) => ({
      kind: "miss", planLineId: pl.id, bucket: pl.bucket, label: pl.label,
      planned: r0(pl.amount), hint: pl.counterparty_hint || null,
      dir: ["fixed_in", "var_in"].includes(pl.bucket) ? "in" : "out",
    }));

  // SURPRISES — reality not in the plan (≥₹10k personal). Drop manually-linked or
  // already-vetted (ok = accepted, wrong = corrected). 'review' = deferred stack.
  const liveSurprise = auto.surprises.filter((t) => !manualTxn.has(t.id) && !vet.has(t.id));
  const deferred = auto.surprises.filter((t) => vet.get(t.id) === "review");
  const files = await caseFiles(entId, month, [...liveSurprise, ...deferred].map((t) => t.id));
  const shape = (t) => {
    const f = files[t.id] || {};
    return {
      kind: "surprise", txnId: t.id, date: f.date || t.date,
      payee: f.payee || null, narration: f.narration || null,
      amount: r0(t.mag), flow: t.kind, dir: t.dir,
      account: f.account || null, statement: f.statement || null, doc: f.source_file || null,
      canCategorize: (f.account || "").startsWith("Expenses:Other"),
    };
  };
  const surprises = liveSurprise.map(shape);

  const exceptions = misses.length + surprises.length;
  const lockedMonths = lockedAll.map((r) => r.month);
  const locked = !!lockRow.length;

  // THE FOUR QUADRANTS — the owner's cashflow board, reconciled. Fixed/Variable ×
  // In/Out (personal), plus Work (reimbursable) kept apart. Planned comes from the
  // plan; actual is the reality the matcher tied to each bucket, with unplanned
  // reality folded into the variable buckets (surprises + absorbed everyday spend).
  const BK = ["fixed_in", "var_in", "fixed_out", "var_out", "work"];
  const q = Object.fromEntries(BK.map((b) => [b, { planned: 0, actual: 0 }]));
  for (const m of auto.matched) { q[m.plan.bucket].planned += Number(m.plan.amount); q[m.plan.bucket].actual += m.txn.mag; }
  for (const pl of auto.missesPlan) { q[pl.bucket].planned += Number(pl.amount); }
  // Unplanned reality folds into the VARIABLE quadrants — but only genuine personal
  // income/expense. Investments (savings), loans, and receivables (work) are NOT
  // personal variable spend; they live in the machine/pack, not this cashflow board.
  const foldPersonal = (t) => { if (t.kind === "income") q.var_in.actual += t.mag; else if (t.kind === "expense") q.var_out.actual += t.mag; else if (t.kind === "work") q.work.actual += t.mag; };
  for (const t of auto.surprises) foldPersonal(t);
  for (const t of auto.absorbed) foldPersonal(t);
  const withDelta = (o) => ({ planned: r0(o.planned), actual: r0(o.actual), delta: r0(o.actual) - r0(o.planned) });
  for (const b of BK) q[b] = withDelta(q[b]);
  const buckets = {
    ...q,
    inflow: withDelta({ planned: q.fixed_in.planned + q.var_in.planned, actual: q.fixed_in.actual + q.var_in.actual }),
    outflow: withDelta({ planned: q.fixed_out.planned + q.var_out.planned, actual: q.fixed_out.actual + q.var_out.actual }),
  };
  buckets.net = withDelta({ planned: buckets.inflow.planned - buckets.outflow.planned, actual: buckets.inflow.actual - buckets.outflow.actual });

  return {
    entity, month, locked,
    lockedAt: locked ? lockRow[0].locked_at : null,
    coverage: { plan: auto.planCoverage, handled: auto.handledCoverage },
    totals: {
      planLines: auto.planTotal, autoMatched: auto.planMatched,
      manualMatched: manualPL.size, absorbed: auto.absorbed.length,
    },
    exceptions,
    buckets,                                    // the four-quadrant cashflow board, reconciled
    cards: [...misses, ...surprises],          // what actually needs you (the game)
    deferred: deferred.map(shape),             // the "review later" stack
    streak: streakEndingAt(lockedMonths, locked ? month : prevMonth(month)),
    categories: exceptions ? await expenseCategories(entId) : [],
  };
}

// ── A season: 12 months of a financial year, each with its state (the year map) ─
export async function seasonMap(entity, fyStart) {
  const entId = await entityId(entity);
  // fyStart = 'YYYY-04' (Indian FY Apr-Mar). Build the 12 month keys.
  let [y, mo] = fyStart.split("-").map(Number);
  const months = Array.from({ length: 12 }, () => {
    const k = `${y}-${String(mo).padStart(2, "0")}`; mo++; if (mo > 12) { mo = 1; y++; } return k;
  });
  const locks = new Map((await query(
    `select month, plan_coverage, exceptions from month_locks where entity_id=$1 and month = any($2)`,
    [entId, months])).map((r) => [r.month, r]));
  // how many plan lines exist per month (has-a-plan indicator) + txn presence.
  const planCounts = new Map((await query(
    `select month, count(*)::int n from plan_lines where entity_id=$1 and month = any($2) group by month`,
    [entId, months])).map((r) => [r.month, r.n]));
  const txnMonths = new Set((await query(
    `select distinct to_char(date,'YYYY-MM') m from transactions where entity_id=$1 and to_char(date,'YYYY-MM') = any($2)`,
    [entId, months])).map((r) => r.m));

  // scorecard: this FY's sealed months + coverage + exceptions handled, and the
  // best/current lock streak across ALL history (streaks don't stop at FY edges).
  const fySealed = months.filter((m) => locks.has(m));
  const covs = fySealed.map((m) => locks.get(m).plan_coverage).filter((x) => x != null);
  const excHandled = fySealed.reduce((s, m) => s + (locks.get(m).exceptions || 0), 0);
  const allLocked = (await query("select month from month_locks where entity_id=$1", [entId])).map((r) => r.month);
  const { best, current } = streakStats(allLocked);

  return {
    entity, fyStart,
    months: months.map((m) => ({
      month: m,
      hasPlan: (planCounts.get(m) || 0) > 0,
      hasData: txnMonths.has(m),
      locked: locks.has(m),
      lockedCoverage: locks.get(m)?.plan_coverage ?? null,
      lockedExceptions: locks.get(m)?.exceptions ?? null,
    })),
    scorecard: {
      sealed: fySealed.length,
      played: months.filter((m) => txnMonths.has(m)).length,
      avgCoverage: covs.length ? Math.round(covs.reduce((a, b) => a + b, 0) / covs.length) : null,
      exceptionsHandled: excHandled,
      bestStreak: best, currentStreak: current,
    },
  };
}

// best consecutive run of locked months anywhere, and the current run ending at
// the most recent locked month.
function streakStats(lockedMonths) {
  if (!lockedMonths.length) return { best: 0, current: 0 };
  const sorted = [...new Set(lockedMonths)].sort();
  let best = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === nextMonth(sorted[i - 1]) ? run + 1 : 1;
    if (run > best) best = run;
  }
  const last = sorted[sorted.length - 1];
  return { best, current: streakEndingAt(sorted, last) };
}
function nextMonth(m) { let [y, mo] = m.split("-").map(Number); mo++; if (mo > 12) { mo = 1; y++; } return `${y}-${String(mo).padStart(2, "0")}`; }

// ── Card actions (the one-tap moves) ─────────────────────────────────────────
export async function resolveCard(entity, body) {
  const { action } = body;
  const entId = await entityId(entity);

  // Link a surprise txn to an existing plan line (it WAS planned).
  if (action === "link") {
    const { planLineId, txnId } = body;
    await query(
      `insert into plan_matches (plan_line_id, txn_id, confidence, method)
       values ($1,$2,100,'manual') on conflict (plan_line_id, txn_id) do nothing`, [planLineId, txnId]);
    return { linked: { planLineId, txnId } };
  }

  // The surprise IS a new plan line (add it to the plan, matched by this txn).
  if (action === "newline") {
    const { month, bucket, label, amount, txnId, recurring = false } = body;
    const pl = await query(
      `insert into plan_lines (entity_id, month, bucket, label, amount, recurring, source, status)
       values ($1,$2,$3,$4,$5,$6,'game',$7)
       on conflict (entity_id, month, bucket, label) do update set amount=excluded.amount
       returning id`, [entId, month, bucket, label, amount, recurring, "matched"]);
    if (txnId) await query(
      `insert into plan_matches (plan_line_id, txn_id, confidence, method)
       values ($1,$2,100,'manual') on conflict do nothing`, [pl[0].id, txnId]);
    return { planLine: pl[0].id, matched: !!txnId };
  }

  // Categorize an Expenses:Other surprise → reclassify (posts a correction, learns).
  if (action === "categorize") {
    const { txnId, toAccount, makeRule = false } = body;
    return await resolveReclassify(entity, { txnId, fromAccount: "Expenses:Other", toAccount, makeRule });
  }

  // Accept as ordinary variable spend — no plan line, just clears the card.
  if (action === "accept") {
    const { txnId, note } = body;
    await query(
      `insert into vettings (transaction_id, status, note) values ($1,'ok',$2)
       on conflict (transaction_id) do update set status='ok', note=excluded.note`,
      [txnId, note || "accepted — ordinary variable"]);
    return { accepted: txnId };
  }

  // Defer — send to the Review-later stack.
  if (action === "review") return await markReview(entity, body);

  // A miss the player rules on: it didn't happen (skip) or moves to next month (carry).
  if (action === "skip" || action === "carry") {
    const { planLineId } = body;
    await query("update plan_lines set status=$2 where id=$1 and entity_id=$3",
      [planLineId, action === "skip" ? "skipped" : "carried", entId]);
    return { planLineId, status: action === "skip" ? "skipped" : "carried" };
  }

  throw new Error(`unknown card action: ${action}`);
}

// ── LOCK — seal the month, persist the auto-matches, return the payoff ────────
export async function lockMonth(entity, month) {
  const entId = await entityId(entity);
  const state = await monthState(entity, month);
  if (state.locked) return { alreadyLocked: true, month };

  const auto = await matchMonth(entity, month);
  const client = await pool().connect();
  try {
    await client.query("begin");
    // Persist the auto-matches so the sealed month keeps its decisions.
    for (const m of auto.matched) {
      await client.query(
        `insert into plan_matches (plan_line_id, txn_id, confidence, method)
         values ($1,$2,$3,$4) on conflict (plan_line_id, txn_id) do nothing`,
        [m.plan.id, m.txn.id, m.confidence, m.method]);
    }
    const stats = {
      planLines: auto.planTotal, autoMatched: auto.planMatched,
      handled: auto.handledCoverage, absorbed: auto.absorbed.length,
      surprises: auto.surprises.length, misses: auto.missesPlan.length,
    };
    await client.query(
      `insert into month_locks (entity_id, month, plan_coverage, handled_coverage, exceptions, stats)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (entity_id, month) do update
         set plan_coverage=excluded.plan_coverage, handled_coverage=excluded.handled_coverage,
             exceptions=excluded.exceptions, stats=excluded.stats, locked_at=now()`,
      [entId, month, state.coverage.plan, state.coverage.handled, state.exceptions, stats]);
    await client.query("commit");
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }

  // recompute streak now that this month is locked.
  const lockedAll = (await query("select month from month_locks where entity_id=$1", [entId])).map((r) => r.month);
  return {
    locked: true, month,
    coverage: state.coverage, exceptions: state.exceptions,
    streak: streakEndingAt(lockedAll, month),
  };
}
