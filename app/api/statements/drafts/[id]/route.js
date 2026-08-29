import { resolveEntity } from "../../../../../lib/tenant";
import { getDraft, updateDraft, deleteDraft } from "../../../../../lib/statements/drafts";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!UUID.test(params.id)) return Response.json({ error: "bad id" }, { status: 400 });
    const d = await getDraft(entity, params.id);
    return d ? Response.json(d) : Response.json({ error: "not found" }, { status: 404 });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 500 }); }
}

// PATCH { account?, kind?, row_accounts?: { "12": "Expenses:Dining" } }
export async function PATCH(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!UUID.test(params.id)) return Response.json({ error: "bad id" }, { status: 400 });
    return Response.json(await updateDraft(entity, params.id, await req.json()));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}

export async function DELETE(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!UUID.test(params.id)) return Response.json({ error: "bad id" }, { status: 400 });
    await deleteDraft(entity, params.id);
    return Response.json({ ok: true });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
