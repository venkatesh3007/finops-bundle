import { resolveEntity } from "../../../../lib/tenant";
import { fixParser } from "../../../../lib/extractor/lab";

export const maxDuration = 800; // rewrite + evaluate every fixture through the gateway

// POST { complaint, dry_run? } — reads back every statement you've parsed, works
// out what's going wrong, rewrites the parser's own code, and ships the new
// version only if it beats the current one on all of them.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));
    return Response.json(await fixParser(entity, {
      complaint: String(b.complaint || "").slice(0, 2000),
      dry_run: !!b.dry_run,
    }));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
