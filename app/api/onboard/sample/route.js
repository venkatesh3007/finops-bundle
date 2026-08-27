import { seedSample } from "../../../../lib/onboard";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// POST /api/onboard/sample — fill the caller's empty warehouse with a playable demo.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ ok: true, entity, ...(await seedSample(entity)) });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
