import { computeCounter } from "../../../../lib/counter";
export const maxDuration = 60;
// GET /api/game/counter?entity=personal — who's at the counter (owes you) + statements.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    return Response.json(await computeCounter(q.entity || "personal"));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
