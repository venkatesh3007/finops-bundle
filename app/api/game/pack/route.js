import { computePack, questMove } from "../../../../lib/pack";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// GET /api/game/pack?entity=personal — the Pack (loan bosses) + Loot (calendar) + Quests.
export async function GET(req) {
  try {
    const q = Object.fromEntries(new URL(req.url).searchParams);
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await computePack(entity, q.today));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}

// POST /api/game/pack — quest moves: quest_add | quest_done | quest_drop | quest_open.
export async function POST(req) {
  try {
    const b = await req.json();
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ ok: true, result: await questMove(entity, b) });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
