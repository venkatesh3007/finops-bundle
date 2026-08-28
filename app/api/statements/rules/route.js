import { resolveEntity } from "../../../../lib/tenant";
import { extractionRules, saveExtractionRules } from "../../../../lib/statements-import";

// GET  -> { rules }        the operator's saved extraction rules for their entity
// POST { rules } -> { ok } upsert them. These get appended to the AI extraction
// prompt on every future statement, so a correction told once is applied again.
// Entity is the caller's own (resolved from the session), never a param.

export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ rules: await extractionRules(entity) });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = await req.json();
    await saveExtractionRules(entity, String(body?.rules || ""));
    return Response.json({ ok: true, rules: await extractionRules(entity) });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
