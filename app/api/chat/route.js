import { resolveEntity } from "../../../lib/tenant";
import { converse } from "../../../lib/agent/loop";

export const maxDuration = 200;

// POST { messages: [{role, content}] } — one turn of the assistant.
// It decides which tools to use, runs them, and answers from their results.
// If it started a background run, job_id comes back so the UI streams the steps.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { messages } = await req.json();
    const history = Array.isArray(messages) ? messages.filter((m) => m && typeof m.content === "string") : [];
    if (!history.length) return Response.json({ error: "nothing to reply to" }, { status: 400 });
    return Response.json(await converse(entity, history));
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
