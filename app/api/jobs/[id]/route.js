import { resolveEntity } from "../../../../lib/tenant";
import { getJob, reapStale } from "../../../../lib/jobs/store";

export const dynamic = "force-dynamic";

// GET /api/jobs/:id[?since=N] — the run's transcript. `since` returns only the
// steps after that index, so the UI can poll cheaply while a job is running.
export async function GET(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    await reapStale(entity);
    const job = await getJob(entity, params.id);
    if (!job) return Response.json({ error: "not found" }, { status: 404 });
    const since = Math.max(0, Number(new URL(req.url).searchParams.get("since") || 0));
    const steps = Array.isArray(job.steps) ? job.steps : [];
    return Response.json({
      id: job.id, kind: job.kind, title: job.title, status: job.status,
      total_steps: steps.length, steps: steps.slice(since),
      result: job.result, created_at: job.created_at, updated_at: job.updated_at,
    });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
