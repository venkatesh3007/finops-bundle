import { resolveReclassify, splitReclassify, addManualEntry, claimReimbursement, markReview } from "../../../../lib/moves";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;
export async function POST(req) {
  try {
    const b = await req.json(); const { action } = b;
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    let result;
    if (action === "reclassify") result = await resolveReclassify(entity, b);
    else if (action === "bulk") {  // reclassify many crates to one shelf in one call
      const items = Array.isArray(b.items) ? b.items : [];
      result = [];
      for (const it of items) result.push(await resolveReclassify(entity, { txnId: it.txnId, fromAccount: it.fromAccount, toAccount: b.toAccount, makeRule: b.makeRule }));
      result = { moved: result.length };
    }
    else if (action === "split") result = await splitReclassify(entity, b);
    else if (action === "add") result = await addManualEntry(entity, b);
    else if (action === "claim") result = await claimReimbursement(entity, b);
    else if (action === "review") result = await markReview(entity, b);
    else return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
    return Response.json({ ok: true, action, result });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
