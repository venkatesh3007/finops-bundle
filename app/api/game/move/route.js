import { resolveReclassify, addManualEntry, claimReimbursement } from "../../../../lib/moves";
export const maxDuration = 60;
export async function POST(req) {
  try {
    const b = await req.json(); const { action, entity = "personal" } = b;
    let result;
    if (action === "reclassify") result = await resolveReclassify(entity, b);
    else if (action === "add") result = await addManualEntry(entity, b);
    else if (action === "claim") result = await claimReimbursement(entity, b);
    else return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
    return Response.json({ ok: true, action, result });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
