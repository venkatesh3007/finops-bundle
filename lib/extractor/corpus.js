// The grading corpus is simply THE STATEMENTS YOU HAVE ALREADY PARSED.
//
// There is nothing to curate: every draft kept its raw text, so each one is a
// test case with a known-good (or known-bad) result. A parser rewrite is graded
// on all of them at once — the ones that are broken must get better, and the
// ones that already work must not get worse.
import { query } from "../db.js";

export const MAX_CORPUS = 6;
// Reserve slots for statements that currently parse CLEANLY. Without them the
// grading set is all problem cases, and "nothing got worse" becomes vacuous —
// a rewrite could wreck every good statement and still ship.
export const MIN_GUARDS = 2;
// Grade on a bounded slice of each statement. A year-long PDF is thousands of
// rows and dozens of model calls; the champion and the candidate are always run
// on the SAME slice, so the comparison stays apples-to-apples.
export const GRADE_CHARS = 20_000;

// Statements worth grading on, worst first: failures and balance breaks are what
// we're trying to fix; a few clean ones ride along as regression guards.
export async function buildCorpus(entId, { limit = MAX_CORPUS, guards = MIN_GUARDS } = {}) {
  const rows = await query(
    `select id, filename, source, kind, status, rows, reconciliation, meta
       from statement_drafts
      where entity_id = $1
        and (meta ? 'pages' or meta ? 'text')
      order by updated_at desc
      limit 60`, [entId]);

  const items = rows.map((d) => {
    const meta = d.meta || {};
    const pages = Array.isArray(meta.pages) ? meta.pages : null;
    const text = pages && pages.length ? pages.join("\n") : meta.text || "";
    const rec = d.reconciliation;
    const breaks = rec?.continuity?.mismatches?.length || 0;
    const known = {
      rows: Array.isArray(d.rows) ? d.rows.length : 0,
      reconciled: !!rec?.reconciled,
      breaks,
      error: d.status === "failed" ? meta.error || "failed" : null,
    };
    const full = text;
    const graded = full.length > GRADE_CHARS ? full.slice(0, GRADE_CHARS) : full;
    return {
      id: d.id, name: d.filename, source_kind: d.source, bank: d.kind, status: d.status,
      text: graded, truncated: graded.length < full.length, known,
      // was that result produced by the parser that is active right now?
      version: meta.extractor_version ?? null,
      // how badly does this one need attention (higher = worse)
      severity: (d.status === "failed" ? 100 : 0) + breaks * 5 + (rec && !rec.reconciled ? 3 : 0),
    };
  }).filter((x) => x.text && x.text.trim().length > 40);

  // Worst first — those are what we're trying to fix — but always keep a couple
  // of currently-clean statements in the set so the gate has something to protect.
  const broken = items.filter((i) => i.severity > 0).sort((a, b) => b.severity - a.severity);
  const clean = items.filter((i) => i.severity === 0);
  const guardCount = Math.min(guards, clean.length, Math.max(0, limit - 1));
  const picked = [...broken.slice(0, limit - guardCount), ...clean.slice(0, guardCount)];
  // if one pool was short, backfill from whatever is left
  for (const i of [...broken, ...clean]) {
    if (picked.length >= limit) break;
    if (!picked.includes(i)) picked.push(i);
  }
  return {
    items: picked, total: items.length, problems: broken.length,
    guards: picked.filter((i) => i.severity === 0).length,
  };
}

// A compact table of where every statement stands — this is what the model reads
// to "understand the issues" before it touches any code.
export function describeCorpus(items) {
  return items.map((i) => {
    const k = i.known;
    const state = k.error ? `FAILED (${String(k.error).slice(0, 90)})`
      : `${k.rows} rows, ${k.breaks} balance break${k.breaks === 1 ? "" : "s"}, ${k.reconciled ? "reconciles" : "does NOT reconcile"}`;
    return `- ${i.name} [${(i.source_kind || "?").toUpperCase()}${i.bank ? `, ${i.bank}` : ""}]: ${state}`;
  }).join("\n");
}
