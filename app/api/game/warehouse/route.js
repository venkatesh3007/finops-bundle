import { warehouseMonth } from "../../../../lib/warehouse";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// GET /api/game/warehouse?entity=personal&month=2026-08 — shelves grouped into
// floor-plan zones (fixed/var × in/out + work/invest/pack), for the board.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    if (!/^\d{4}-\d{2}$/.test(q.month || "")) return Response.json({ error: "month=YYYY-MM required" }, { status: 400 });
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await warehouseMonth(entity, q.month));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
