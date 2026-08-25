import { computePosition } from "../../../lib/position";
import { generateMoves } from "../../../lib/moves";
export const maxDuration = 60;
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const entity = q.entity || "personal"; const month = q.month || null;
    const [position, moves] = await Promise.all([computePosition(entity, { month }), generateMoves(entity, { month })]);
    return Response.json({ entity, month, position, moves });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
