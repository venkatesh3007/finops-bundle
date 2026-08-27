import { resolveEntity } from "../../../../lib/tenant";
import { classificationContext } from "../../../../lib/statements-import";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// GET /api/statements/context
// -> { entity, accounts, decisions, history, regex, statement_accounts } — what the
// browser needs to classify rows deterministically before the on-device model.
// The entity is the CALLER's own (resolved from the session) — never a param.
export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await classificationContext(entity));
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
