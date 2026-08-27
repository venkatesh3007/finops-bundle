import { lockMonth } from "../../../../lib/gameflow";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// POST /api/game/lock  { entity, month } — seal the month, return the payoff.
export async function POST(req) {
  try {
    const b = await req.json();
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!/^\d{4}-\d{2}$/.test(b.month || "")) return Response.json({ error: "month=YYYY-MM required" }, { status: 400 });
    return Response.json(await lockMonth(entity, b.month));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
