import { resolveEntity } from "../../../../../lib/tenant";
import { setRuleStatus } from "../../../../../lib/statements/rules";
import { gradeProposedRule } from "../../../../../lib/statements/rule-grader";
import { startJob, step as jobStep, finishJob } from "../../../../../lib/jobs/store";

export const maxDuration = 800;

// POST { action: "grade" | "reject" | "activate" }
//   grade    — re-read every statement in scope with the rule and promote only
//              if nothing gets worse and something improves. Runs as a job.
//   reject   — throw it away
//   activate — force it on without grading (operator override; recorded as such)
export async function POST(req, { params }) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { action } = await req.json().catch(() => ({}));

    if (action === "reject") return Response.json(await setRuleStatus(entity, params.id, "rejected"));
    if (action === "activate") return Response.json(await setRuleStatus(entity, params.id, "active", { forced_by: "operator", graded: false }));

    const job = await startJob(entity, { kind: "grade_rule", title: "Grading a proposed rule" });
    (async () => {
      try {
        const out = await gradeProposedRule(entity, params.id, {
          onNote: (t) => jobStep(job.id, "note", String(t).slice(0, 300)).catch(() => {}),
        });
        await finishJob(job.id, "done", out);
      } catch (e) {
        await jobStep(job.id, "error", String(e.message || e).slice(0, 300)).catch(() => {});
        await finishJob(job.id, "failed", { error: String(e.message || e).slice(0, 300) });
      }
    })();
    return Response.json({ ok: true, job_id: job.id });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
