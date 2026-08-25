// The World: three systems the owner named around the month loop.
//   THE PACK  — each loan is a boss. Weight = principal still owed; the drag is
//               the monthly interest it costs. A loan paid to zero is defeated.
//               Framed neutrally: this is capital in play, chosen to fund growth,
//               not shameful debt. You watch the HP fall as you repay.
//   LOOT      — the forward calendar of scheduled money: EMIs, SIPs, chit payouts,
//               premiums, paydays — derived from the recurring commitments.
//   QUESTS    — the real open-items register (docs/parked-items.md): the only
//               unexplained/undecided things in the book, each with its reward.
import { query } from "./db.js";

async function entityId(slug) {
  const rows = await query("select id from entities where slug=$1", [slug]);
  if (!rows.length) throw new Error(`no entity ${slug}`);
  return rows[0].id;
}
const r0 = (n) => Math.round(Number(n) || 0);

export async function computePack(entity, todayISO) {
  const entId = await entityId(entity);

  // ── THE PACK — loans as bosses ──────────────────────────────────────────────
  // current balance (principal_now) + deepest historical balance (max HP).
  const loans = await query(
    `with running as (
       select a.name,
              sum(p.amount) over (partition by a.name order by t.date, t.id) as bal
         from accounts a
         join postings p on p.account_id=a.id
         join transactions t on t.id=p.transaction_id
        where a.entity_id=$1 and a.name like 'Liabilities:Loans:%')
     select r.name,
            (select round(sum(p2.amount),0) from postings p2 join accounts a2 on a2.id=p2.account_id
              where a2.name=r.name and a2.entity_id=$1) as now,
            round(min(r.bal),0) as peak
       from running r group by r.name order by peak`,
    [entId]);

  // monthly interest drag comes from the recurring commitment (falls back to a share
  // of all-time interest if the commitment isn't seeded).
  const dragRow = await query(
    `select rc.amount from recurring_commitments rc where rc.entity_id=$1 and rc.name ilike '%loan interest%' and rc.active limit 1`, [entId]);
  const monthlyInterest = dragRow.length ? Number(dragRow[0].amount) : 0;

  const active = loans.filter((l) => Math.abs(Number(l.now)) > 1);
  const activeOwed = active.reduce((s, l) => s + Math.abs(Number(l.now)), 0) || 1;

  const debts = loans.map((l) => {
    const now = Math.abs(Number(l.now)), peak = Math.abs(Number(l.peak)) || now || 1;
    const paidPct = Math.max(0, Math.min(100, Math.round((1 - now / peak) * 100)));
    const drag = now > 1 ? r0(monthlyInterest * (now / activeOwed)) : 0;
    return {
      name: l.name.split(":").pop(),
      owed: r0(now), peak: r0(peak),
      paidPct,                              // boss HP already taken off
      hpPct: 100 - paidPct,                 // remaining
      dragMonthly: drag,
      defeated: now <= 1,
    };
  });
  const packTotals = {
    inPlay: r0(active.reduce((s, l) => s + Math.abs(Number(l.now)), 0)),
    dragMonthly: r0(monthlyInterest),
    bosses: active.length, defeated: debts.filter((d) => d.defeated).length,
  };

  // ── LOOT — the forward calendar (next ~60 days of scheduled money) ───────────
  const today = todayISO ? new Date(todayISO + "T00:00:00Z") : new Date();
  const commits = await query(
    `select rc.name, rc.kind, rc.amount, rc.cadence, rc.day_of_month
       from recurring_commitments rc where rc.entity_id=$1 and rc.active`, [entId]);
  const horizon = new Date(today); horizon.setUTCDate(horizon.getUTCDate() + 60);
  const events = [];
  for (const c of commits) {
    const dom = c.day_of_month || 1;
    // next 1–2 occurrences within the horizon
    for (let k = 0; k < 3; k++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + k, dom));
      if (c.cadence === "quarterly" && (d.getUTCMonth() % 3 !== 0)) continue;
      if (c.cadence === "yearly" && d.getUTCMonth() !== 0) continue;
      if (d >= today && d <= horizon) {
        events.push({
          name: c.name, kind: c.kind,
          amount: r0(c.amount),
          date: d.toISOString().slice(0, 10),
          direction: (c.kind === "investment") ? "save" : "pay", // money leaving either way, but savings build the machine
        });
      }
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // ── QUESTS — the open-items register ────────────────────────────────────────
  const quests = await query(
    `select id, title, reward_desc, reward_inr, status, linked_item
       from quests where entity_id=$1 and status<>'dropped' order by (status='done'), reward_inr desc nulls last`, [entId]);

  return {
    entity, today: today.toISOString().slice(0, 10),
    pack: { totals: packTotals, bosses: debts },
    loot: { horizonDays: 60, events, total: r0(events.reduce((s, e) => s + e.amount, 0)) },
    quests: quests.map((q) => ({
      id: q.id, title: q.title, reward: q.reward_desc, rewardInr: q.reward_inr ? r0(q.reward_inr) : null,
      status: q.status, linked: q.linked_item,
    })),
  };
}

// quest moves — dashboard-editable (add / complete / drop / reopen).
export async function questMove(entity, { action, id, title, reward, rewardInr, linked }) {
  const entId = await entityId(entity);
  if (action === "quest_add") {
    const r = await query(
      `insert into quests (entity_id, title, reward_desc, reward_inr, linked_item)
       values ($1,$2,$3,$4,$5) on conflict (entity_id, title) do update set reward_desc=excluded.reward_desc
       returning id`, [entId, title, reward || null, rewardInr || null, linked || null]);
    return { id: r[0].id };
  }
  const status = { quest_done: "done", quest_drop: "dropped", quest_open: "open" }[action];
  if (!status) throw new Error(`unknown quest action ${action}`);
  await query("update quests set status=$2 where id=$1 and entity_id=$3", [id, status, entId]);
  return { id, status };
}
