import { resolveEntity } from "../../../../lib/tenant";
import { askCorpus, routeIntent } from "../../../../lib/statements/corpus-ask";

export const maxDuration = 120;

// POST { question } — answer a question about ALL your parsed statements.
// Every number is computed in lib/statements/corpus-query.js; the model only
// picks the query and reads the result back. `intent` tells the UI whether this
// sounded like a question or like a report of something parsing wrong.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { question } = await req.json();
    const q = String(question || "").trim().slice(0, 600);
    if (!q) return Response.json({ error: "ask something" }, { status: 400 });
    const out = await askCorpus(entity, q);
    return Response.json({ ...out, intent: routeIntent(q) });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
