import { resolveCard } from "../../../../lib/gameflow";
export const maxDuration = 60;

// POST /api/game/card — one-tap resolution of an exception card.
// { entity, action: link|newline|categorize|accept|review|skip|carry, ...args }
export async function POST(req) {
  try {
    const b = await req.json();
    const entity = b.entity || "personal";
    const result = await resolveCard(entity, b);
    return Response.json({ ok: true, action: b.action, result });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
