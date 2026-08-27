import { seasonMap } from "../../../../lib/gameflow";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// GET /api/game/season?entity=personal&fy=2026  — the 12 months of FY Apr'YY–Mar,
// each with plan/data/lock state (the year map you navigate).
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const fy = Number(q.fy) || new Date().getUTCFullYear();
    return Response.json(await seasonMap(entity, `${fy}-04`));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
