import { resolveEntity } from "../../../../../../lib/tenant";
import { processDraft } from "../../../../../../lib/statements/drafts";

export const maxDuration = 300;

// POST { hint, remember? } — re-run extraction + classification for THIS statement
// with a one-off instruction ("the last page has 4 more rows", "use the INR column").
// remember=true also appends the hint to the account's persistent extraction rules.
export async function POST(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));
    return Response.json(await processDraft(entity, params.id, { hint: String(b.hint || "").slice(0, 2000), remember: !!b.remember }));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
