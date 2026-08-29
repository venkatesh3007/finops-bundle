import { resolveEntity } from "../../../../lib/tenant";
import { reparseAll } from "../../../../lib/statements/drafts";

export const maxDuration = 800; // re-parses every stored statement through the gateway

// POST — re-parse every statement you have with the CURRENT parser, so they are
// all read the same way. Already-imported statements are left alone (their rows
// are in the ledger; re-reading the draft wouldn't change that).
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await reparseAll(entity));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
