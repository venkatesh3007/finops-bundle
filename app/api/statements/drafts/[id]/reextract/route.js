import { resolveEntity } from "../../../../../../lib/tenant";
import { processDraft, getDraft } from "../../../../../../lib/statements/drafts";
import { startJob } from "../../../../../../lib/jobs/store";

export const maxDuration = 800; // matches /api/parse; extraction now runs as a job anyway

// POST { hint, remember? } — re-run extraction + classification for THIS statement
// with a one-off instruction ("the last page has 4 more rows", "use the INR column").
// remember=true also appends the hint to the account's persistent extraction rules.
export async function POST(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));
    const hint = String(b.hint || "").slice(0, 2000);
    // Same reason as upload: a re-read with thinking on can outlast any request
    // budget. Run it as a job and hand back the id; `wait: true` keeps the old
    // synchronous behaviour for scripts that want the finished draft.
    if (b.wait) return Response.json(await processDraft(entity, params.id, { hint, remember: !!b.remember }));
    const d = await getDraft(entity, params.id);
    if (!d) return Response.json({ error: "no such draft" }, { status: 404 });
    const job = await startJob(entity, { kind: "extract", title: `Re-read ${d.filename}`, draft_id: params.id });
    processDraft(entity, params.id, { hint, remember: !!b.remember, jobId: job.id }).catch(() => {});
    return Response.json({ ...d, job_id: job.id, status: "processing" });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
