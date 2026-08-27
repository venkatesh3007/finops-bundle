import { resolveCaller } from "../../../../lib/tenant";
import { importStatement } from "../../../../lib/statements-import";

export const maxDuration = 60;

// POST /api/statements/import
// { filename, sha256, bytes, account, kind, model, rows:[...], force? }
// The browser parsed (pdf.js / CSV / XLSX) and classified (rules + on-device
// LFM2.5). This writes append-only entries + a CHECKED closing assertion into
// the CALLER's own entity (session-resolved; any `entity` in the body is ignored).
export async function POST(req) {
  try {
    const caller = await resolveCaller(req);
    if (!caller?.entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json();
    delete b.entity; // never trusted from the client
    const result = await importStatement(caller.entity, { ...b, userEmail: caller.email || (caller.owner ? "owner" : null) });
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
