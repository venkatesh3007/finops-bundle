import { query, pool } from "../../../../lib/db";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// POST /api/game/reset  { entity, quests?:bool }
// Resets the GAME PROGRESS so every month is replayable — WITHOUT touching the
// books or the plan. Clears: month locks, plan↔txn matches, plan-line rulings
// (skip/carry), and the accept/defer overlay (vettings). The ledger is append-only,
// so any corrections already posted stay (that's by design). Optionally reopens
// resolved quests too.
export async function POST(req) {
  let b = {};
  try { b = await req.json(); } catch { /* empty body ok */ }
  const entity = await resolveEntity(req);
  if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const ent = await query("select id from entities where slug=$1", [entity]);
    if (!ent.length) return Response.json({ error: `no entity ${entity}` }, { status: 400 });
    const entId = ent[0].id;

    const client = await pool().connect();
    try {
      await client.query("begin");
      const locks = await client.query("delete from month_locks where entity_id=$1", [entId]);
      const matches = await client.query(
        "delete from plan_matches where plan_line_id in (select id from plan_lines where entity_id=$1)", [entId]);
      await client.query("update plan_lines set status='open' where entity_id=$1 and status<>'open'", [entId]);
      const vettings = await client.query(
        `delete from vettings where transaction_id in (select id from transactions where entity_id=$1)
           and status in ('ok','review','wrong')`, [entId]);
      let quests = { rowCount: 0 };
      if (b.quests) quests = await client.query(
        "update quests set status='open' where entity_id=$1 and status='done'", [entId]);
      await client.query("commit");
      return Response.json({
        ok: true, reset: {
          months_unlocked: locks.rowCount, matches_cleared: matches.rowCount,
          decisions_cleared: vettings.rowCount, quests_reopened: quests.rowCount,
        },
      });
    } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
