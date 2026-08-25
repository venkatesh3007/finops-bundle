import { query } from "../../../lib/db";
export const maxDuration = 60;

// GET /api/ventures?entity=personal — list the owner's equity/venture holdings.
export async function GET(req) {
  try {
    const entity = new URL(req.url).searchParams.get("entity") || "personal";
    const rows = await query(
      `select v.id, v.name, v.kind, v.value, v.monthly_return, v.note
         from ventures v join entities e on e.id=v.entity_id
        where e.slug=$1 and v.active order by v.value desc`, [entity]);
    return Response.json({ ventures: rows.map((r) => ({ ...r, value: Number(r.value), monthly_return: Number(r.monthly_return) })) });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}

// POST /api/ventures { entity, name, kind, value, monthlyReturn, note, remove? } — upsert / soft-delete.
export async function POST(req) {
  try {
    const b = await req.json();
    const entity = b.entity || "personal";
    const ent = await query("select id from entities where slug=$1", [entity]);
    if (!ent.length) return Response.json({ error: "no entity" }, { status: 400 });
    if (!b.name) return Response.json({ error: "name required" }, { status: 400 });
    if (b.remove) {
      await query("update ventures set active=false, updated_at=now() where entity_id=$1 and name=$2", [ent[0].id, b.name]);
      return Response.json({ ok: true, removed: b.name });
    }
    await query(
      `insert into ventures (entity_id, name, kind, value, monthly_return, note)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (entity_id, name) do update
         set kind=excluded.kind, value=excluded.value, monthly_return=excluded.monthly_return,
             note=excluded.note, active=true, updated_at=now()`,
      [ent[0].id, b.name, b.kind || "equity", Number(b.value) || 0, Number(b.monthlyReturn) || 0, b.note || null]);
    return Response.json({ ok: true, name: b.name });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
