import { query } from "../../../../lib/db";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// POST /api/game/zone  { entity, account, fixed } — move a shelf between the
// Fixed and Variable aisle (in/out is intrinsic to the account type).
export async function POST(req) {
  try {
    const b = await req.json();
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!b.account) return Response.json({ error: "account required" }, { status: 400 });
    const ent = await query("select id from entities where slug=$1", [entity]);
    if (!ent.length) return Response.json({ error: `no entity ${entity}` }, { status: 400 });
    await query(
      `insert into account_zones (entity_id, account, fixed) values ($1,$2,$3)
       on conflict (entity_id, account) do update set fixed=excluded.fixed`,
      [ent[0].id, b.account, !!b.fixed]);
    return Response.json({ ok: true, account: b.account, fixed: !!b.fixed });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
