import { monthState } from "../../../../lib/gameflow";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// GET /api/game/month?entity=personal&month=2026-08 — the board for one month.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const month = q.month;
    if (!/^\d{4}-\d{2}$/.test(month || "")) return Response.json({ error: "month=YYYY-MM required" }, { status: 400 });
    return Response.json(await monthState(entity, month));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
