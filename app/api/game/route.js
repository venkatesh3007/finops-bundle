import { computeGameState } from "../../../lib/game";
import { generateMoves } from "../../../lib/moves";
import { resolveEntity } from "../../../lib/tenant";
export const maxDuration = 60;

// GET /api/game?entity=personal&from=2026-08-01&to=2026-08-31  (or &month=2026-08)
// -> { entity, period, state, moves } — the neutral two-meter model + this span's moves.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    let { from, to, month } = q;
    if (!from && month) { from = `${month}-01`; to = `${month}-31`; }
    const [state, moves] = await Promise.all([
      computeGameState(entity, { from, to }),
      generateMoves(entity, { from, to }),
    ]);
    return Response.json({ entity, period: { from: from || null, to: to || null }, state, moves });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
