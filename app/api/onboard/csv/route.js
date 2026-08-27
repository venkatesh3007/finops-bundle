import { importCsv, parseCsvRows } from "../../../../lib/onboard";
import { resolveEntity } from "../../../../lib/tenant";
export const maxDuration = 60;

// POST /api/onboard/csv  { csv, preview?:bool } — import (or dry-run preview) the
// caller's first bank statement into their own entity.
export async function POST(req) {
  try {
    const entity = await resolveEntity(req);
    if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { csv, preview } = await req.json();
    if (!csv || typeof csv !== "string") return Response.json({ error: "no csv provided" }, { status: 400 });
    if (csv.length > 2_000_000) return Response.json({ error: "file too large (2 MB max)" }, { status: 400 });

    if (preview) {
      const { rows, header } = parseCsvRows(csv);
      return Response.json({ ok: true, preview: true, count: rows.length, header, sample: rows.slice(0, 5) });
    }
    return Response.json({ ok: true, entity, ...(await importCsv(entity, csv)) });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
