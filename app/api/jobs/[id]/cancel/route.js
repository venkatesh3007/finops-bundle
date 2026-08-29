import { resolveEntity } from "../../../../../lib/tenant";
import { cancelJob } from "../../../../../lib/jobs/store";

// POST — stop a running job. The runner checks between steps, so it stops at the
// next boundary and says what it had already finished.
export async function POST(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const job = await cancelJob(entity, params.id);
    return Response.json({ ok: true, status: job?.status || "unknown" });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
