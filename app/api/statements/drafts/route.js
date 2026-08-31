import { resolveEntity } from "../../../../lib/tenant";
import { listDrafts, createAndProcess } from "../../../../lib/statements/drafts";
import { gatewayConfigured } from "../../../../lib/statements/gateway";

export const maxDuration = 800; // matches /api/parse; extraction now runs as a job anyway // frontier extraction of a large statement (chunked)
export const dynamic = "force-dynamic";

// GET  → { drafts: [card…], extraction: bool }   the caller's stored statements
// POST { filename, sha256, bytes, source, account, kind, pages?|rows?, force_new? }
//      → the processed draft (extracted → reconciled → classified). Several POSTs
//        may run in parallel — one per uploaded file.
export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ entity, drafts: await listDrafts(entity), extraction: gatewayConfigured() });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json();
    if (!b.filename) return Response.json({ error: "filename required" }, { status: 400 });
    const size = JSON.stringify(b.pages || b.rows || "").length;
    if (size > 4_000_000) return Response.json({ error: "statement text too large (4 MB max)" }, { status: 400 });
    return Response.json(await createAndProcess(entity, b));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
