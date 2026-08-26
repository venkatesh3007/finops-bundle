import { computeAltitude } from "../../../../lib/altitude";
export const maxDuration = 60;

// GET /api/game/altitude?entity=personal&from=&to= — the composite Climb metric.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    let { from, to, month, entity } = q;
    if (!from && month) { from = `${month}-01`; to = `${month}-31`; }
    return Response.json(await computeAltitude(entity || "personal", { from, to }));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
