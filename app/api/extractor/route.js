import { resolveEntity } from "../../../lib/tenant";
import { listVersions, listFixtures, activeVersion, getVersion } from "../../../lib/extractor/store";
import { gatewayConfigured } from "../../../lib/statements/gateway";
import { MODULE_CONTRACT } from "../../../lib/extractor/sandbox";

export const dynamic = "force-dynamic";

// GET /api/extractor[?version=N] — the lab's state: versions of the extractor's
// own code, the problem statements it is judged against, and (optionally) the
// full source of one version.
export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const v = new URL(req.url).searchParams.get("version");
    const [versions, fixtures, active] = await Promise.all([
      listVersions(entity), listFixtures(entity), activeVersion(entity),
    ]);
    const one = v ? await getVersion(entity, Number(v)) : null;
    return Response.json({
      entity, configured: gatewayConfigured(), active_version: active.version,
      versions, fixtures, contract: MODULE_CONTRACT,
      source: one ? { version: one.version, source: one.source, notes: one.notes, score: one.score } : null,
    });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
