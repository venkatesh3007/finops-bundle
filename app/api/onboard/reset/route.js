import { pool } from "../../../../lib/db";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// POST /api/onboard/reset — "Start over": wipe the CALLER's own workspace back to
// the empty onboarding state. Session-scoped (resolveEntity), and it refuses the
// owner "personal" book so real data can never be cleared from the UI.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (entity === "personal") return Response.json({ error: "the owner book can't be reset here" }, { status: 403 });

    const client = await pool().connect();
    try {
      const er = await client.query("select id from entities where slug=$1", [entity]);
      if (!er.rows.length) return Response.json({ error: "no entity" }, { status: 400 });
      const E = er.rows[0].id;
      const cleared = (await client.query("select count(*)::int n from transactions where entity_id=$1", [E])).rows[0].n;
      await client.query("begin");
      await client.query("set local finops.allow_mutation='on'");
      await client.query("delete from vettings where transaction_id in (select id from transactions where entity_id=$1)", [E]);
      await client.query("delete from plan_matches where plan_line_id in (select id from plan_lines where entity_id=$1)", [E]);
      await client.query("delete from month_locks where entity_id=$1", [E]);
      await client.query("delete from account_zones where entity_id=$1", [E]);
      await client.query("delete from ventures where entity_id=$1", [E]);
      await client.query("delete from postings where transaction_id in (select id from transactions where entity_id=$1)", [E]);
      await client.query("update transactions set corrects_id=null where entity_id=$1", [E]);
      await client.query("delete from transactions where entity_id=$1", [E]);
      await client.query("delete from accounts where entity_id=$1", [E]);
      await client.query("commit");
      return Response.json({ ok: true, entity, cleared });
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
    finally { client.release(); }
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
