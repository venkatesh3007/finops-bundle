import { resolveEntity } from "../../../../lib/tenant";
import { getDraft } from "../../../../lib/statements/drafts";
import { answer, narratePrompt } from "../../../../lib/statements/ask";
import { chatText, gatewayConfigured } from "../../../../lib/statements/gateway";
import { explain } from "../../../../lib/statements/query";

export const maxDuration = 60;

// POST { draft_id, question } → { text, query, result }
// Grounded Q&A over a draft's rows: the frontier model only picks the question
// type and narrates; the numbers are computed in query.js from the stored rows.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { draft_id, question } = await req.json();
    const d = await getDraft(entity, draft_id);
    if (!d) return Response.json({ error: "not found" }, { status: 404 });
    const q = String(question || "").trim().slice(0, 500);
    if (!q) return Response.json({ error: "question required" }, { status: 400 });
    const rows = d.rows || [];
    const why = q.match(/\b(why|explain).*?(?:row|line|#)\s*(\d+)/i) || q.match(/^#?(\d+)\s*\?*$/);
    if (why) {
      const r = rows.find((x) => x.i === Number(why[2] || why[1]));
      return Response.json({ text: r ? `Row ${r.i} · ${r.date} · ${r.payee} · ${r.amount} → ${r.account}\n${explain(r)}` : "I don't see that row number." });
    }
    const gen = gatewayConfigured() ? (msgs, n) => chatText(msgs, { max_tokens: Math.max(n || 24, 24) }) : async () => "";
    const a = await answer(q, rows, gen);
    let narration = "";
    if (gatewayConfigured()) { try { narration = await chatText(narratePrompt(q, a.text), { max_tokens: 160 }); } catch { narration = ""; } }
    return Response.json({ text: narration ? `${a.text}\n\n${narration.trim()}` : a.text, query: a.query, result: a.result });
  } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 400 }); }
}
