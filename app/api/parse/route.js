import { resolveEntity } from "../../../lib/tenant";
import { query } from "../../../lib/db";
import { startJob } from "../../../lib/jobs/store";
import { runParseJob } from "../../../lib/parser/run-job";

export const maxDuration = 800;

// POST { draft_ids?: [], all?: bool, only_broken?: bool }
// Starts a background parse job that WRITES A PARSER for each statement's layout
// and returns immediately with the job id. Progress is read from /api/jobs/:id,
// and /api/jobs/:id/cancel stops it — so a proxy timeout, a reload or a restart
// can't silently kill the work the way the old synchronous call did.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ent = await query("select id from entities where slug=$1", [entity]);
    if (!ent.length) return Response.json({ error: "no entity" }, { status: 400 });
    const entId = ent[0].id;

    const b = await req.json().catch(() => ({}));
    let ids = Array.isArray(b.draft_ids) ? b.draft_ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : [];
    if (!ids.length && (b.all || b.only_broken)) {
      const rows = await query(
        `select id, reconciliation from statement_drafts
          where entity_id=$1 and status <> 'imported' and (meta ? 'pages' or meta ? 'text')
          order by updated_at desc limit 60`, [entId]);
      ids = rows.filter((r) => !b.only_broken || !r.reconciliation?.reconciled).map((r) => r.id);
    }
    if (!ids.length) return Response.json({ error: "nothing to parse — pick a statement, or upload one first" }, { status: 400 });

    const names = await query("select filename from statement_drafts where entity_id=$1 and id = any($2::uuid[])", [entId, ids]);
    const title = ids.length === 1 ? `Parse ${names[0]?.filename || "statement"}` : `Parse ${ids.length} statements`;
    const job = await startJob(entity, { kind: "parse", title, draft_id: ids.length === 1 ? ids[0] : null });

    // fire and forget: the job records its own progress and outcome
    runParseJob({ entity, entId, jobId: job.id, draftIds: ids }).catch(() => {});
    return Response.json({ ok: true, job_id: job.id, statements: ids.length });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
