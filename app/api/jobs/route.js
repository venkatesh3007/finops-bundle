import { resolveEntity } from "../../../lib/tenant";
import { listJobs, reapStale } from "../../../lib/jobs/store";

export const dynamic = "force-dynamic";

// GET — recent runs, newest first. Stale ones (process died mid-run) are marked
// failed rather than left spinning.
export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    await reapStale(entity);
    return Response.json({ jobs: await listJobs(entity) });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
