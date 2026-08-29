import { resolveEntity } from "../../../../lib/tenant";
import { addFixture, listFixtures, setFixtureActive, deleteFixture } from "../../../../lib/extractor/store";
import { getDraft } from "../../../../lib/statements/drafts";

export const dynamic = "force-dynamic";

// POST { draft_id, complaint } — "this statement came out wrong". Snapshots the
// statement's raw text as a fixture the extractor is graded on from now on.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json();
    if (!b.draft_id) return Response.json({ error: "draft_id required" }, { status: 400 });
    const d = await getDraft(entity, b.draft_id);
    if (!d) return Response.json({ error: "not found" }, { status: 404 });
    const meta = d.meta || {};
    const body = Array.isArray(meta.pages) && meta.pages.length ? meta.pages.join("\n") : meta.text || "";
    const rec = d.reconciliation;
    const fixture = await addFixture(entity, {
      name: d.filename, complaint: b.complaint, source_kind: d.source, bank: d.kind,
      text_body: body,
      expected: { min_rows: d.rows_count || 0, want_reconciled: true },
      baseline: { rows: d.rows_count || 0, reconciled: !!rec?.reconciled, breaks: rec?.continuity?.mismatches?.length || 0 },
    });
    return Response.json({ ok: true, fixture });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}

// PATCH { id, active } — take a statement in/out of the grading set.
export async function PATCH(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { id, active } = await req.json();
    await setFixtureActive(entity, id, active);
    return Response.json({ ok: true, fixtures: await listFixtures(entity) });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}

export async function DELETE(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const id = new URL(req.url).searchParams.get("id");
    await deleteFixture(entity, id);
    return Response.json({ ok: true });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
