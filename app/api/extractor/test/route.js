import { resolveEntity } from "../../../../lib/tenant";
import { testChampion } from "../../../../lib/extractor/lab";

export const maxDuration = 600;

// POST — re-run the ACTIVE extractor over every saved problem statement and
// record the scores. This is the "where do I stand" button.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await testChampion(entity));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
