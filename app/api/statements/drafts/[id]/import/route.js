import { resolveCaller } from "../../../../../../lib/tenant";
import { importDraft } from "../../../../../../lib/statements/drafts";

export const maxDuration = 60;

// POST { force? } — append the draft's rows to the ledger (dedupe, opening seed,
// checked closing assertion). 409 with the diff when the closing balance doesn't
// reconcile; force=true records the gap.
export async function POST(req, { params }) {
  try {
    const caller = await resolveCaller(req);
    if (!caller?.entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));
    const result = await importDraft(caller.entity, params.id, { force: !!b.force, userEmail: caller.email || (caller.owner ? "owner" : null) });
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
