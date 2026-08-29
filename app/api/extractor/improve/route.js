import { resolveEntity } from "../../../../lib/tenant";
import { improve } from "../../../../lib/extractor/lab";

export const maxDuration = 800; // rewrite + evaluate every fixture through the gateway

// POST { complaint, fixture_id?, dry_run? } — the extractor rewrites its own code
// to fix the problem you described, and ships the new version only if it beats the
// current one on every saved statement.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));
    return Response.json(await improve(entity, {
      complaint: String(b.complaint || "").slice(0, 2000),
      fixture_id: b.fixture_id || null,
      dry_run: !!b.dry_run,
    }));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
