import { resolveEntity } from "../../../../lib/tenant";
import { activate } from "../../../../lib/extractor/store";

// POST { version } — pin/roll back to a specific extractor version.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { version } = await req.json();
    const v = await activate(entity, Number(version));
    return Response.json({ ok: true, active_version: v.version });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
