import { resolveEntity } from "../../../../lib/tenant";
import { investigate } from "../../../../lib/agent/investigate";
import { startJob, step as jobStep, finishJob } from "../../../../lib/jobs/store";

export const maxDuration = 800;

// POST { messages:[{role,content}], focus? } — investigate what went wrong with a
// parse. Runs as a job (it writes and runs code, several rounds) so the caller
// polls instead of holding a connection open for minutes.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));
    const history = Array.isArray(b.messages) ? b.messages.filter((m) => m && typeof m.content === "string") : [];
    if (!history.length) return Response.json({ error: "nothing to investigate" }, { status: 400 });

    const job = await startJob(entity, { kind: "investigate", title: `Investigate: ${String(history[history.length - 1].content).slice(0, 60)}` });
    (async () => {
      try {
        const out = await investigate(entity, history, {
          focus: b.focus || null,
          onNote: (t) => jobStep(job.id, "note", String(t).slice(0, 300)).catch(() => {}),
        });
        for (const t of out.trace || []) {
          await jobStep(job.id, "code", `${t.tool}: ${t.thought || ""}`, { input: t.input, summary: String(t.summary || "").slice(0, 4000) }).catch(() => {});
        }
        await finishJob(job.id, "done", { reply: out.reply, proposed_rules: out.proposed_rules, steps: (out.trace || []).length, out_of_turns: !!out.out_of_turns, empty_reply: !!out.empty_reply });
      } catch (e) {
        await jobStep(job.id, "error", String(e.message || e).slice(0, 300)).catch(() => {});
        await finishJob(job.id, "failed", { error: String(e.message || e).slice(0, 300) });
      }
    })();
    return Response.json({ ok: true, job_id: job.id });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
