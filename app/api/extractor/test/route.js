import { resolveEntity } from "../../../../lib/tenant";
import { checkParser } from "../../../../lib/extractor/lab";

export const maxDuration = 600;

// POST — re-run the ACTIVE parser over your statements and report where it stands.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await checkParser(entity));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
