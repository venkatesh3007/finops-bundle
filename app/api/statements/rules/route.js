import { resolveEntity } from "../../../../lib/tenant";
import { listRules } from "../../../../lib/statements/rules";

// GET — every rule this book has learned, proposed and active.
export async function GET(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ entity, rules: await listRules(entity) });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}
