import { resolveEntity } from "../../../../lib/tenant";
import { extractStatement, extractConfigured } from "../../../../lib/statements/extract";

export const maxDuration = 300; // multi-chunk frontier extraction of a large statement

// POST /api/statements/extract  { pages?: string[], text?, filename?, bank?, period? }
// -> { statement_type, currency, period, opening_balance, closing_balance, transactions, reconciliation }
// The statement text goes to the configured frontier provider (server-side key). Only
// reachable by the signed-in caller; the entity is never used to read data, just to gate.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!extractConfigured()) return Response.json({ error: "extract_not_configured", message: "AI extraction isn't switched on — set ANTHROPIC_API_KEY in the app env." }, { status: 503 });

    const b = await req.json();
    const pages = Array.isArray(b.pages) ? b.pages.map((p) => String(p || "")) : null;
    const text = typeof b.text === "string" ? b.text : null;
    if (!pages && !text) return Response.json({ error: "provide pages[] or text" }, { status: 400 });
    const total = (pages ? pages.join("") : text).length;
    if (total > 4_000_000) return Response.json({ error: "statement text too large (4 MB max)" }, { status: 400 });

    const out = await extractStatement({ pages, text, filename: b.filename || "", bank: b.bank || "", period: b.period || null });
    if (out.error) return Response.json(out, { status: out.error === "extract_not_configured" ? 503 : 502 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 502 });
  }
}
