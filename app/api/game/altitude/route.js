import { computeAltitude } from "../../../../lib/altitude";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// GET /api/game/altitude?entity=personal&from=&to= — the composite Climb metric.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    let { from, to, month } = q;
    if (!from && month) { from = `${month}-01`; to = `${month}-31`; }
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await computeAltitude(entity, { from, to }));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
