import { computeCounter } from "../../../../lib/counter";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;
// GET /api/game/counter — who's at the counter (owes you) + statements.
export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await computeCounter(entity));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
