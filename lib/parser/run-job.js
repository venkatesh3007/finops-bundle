// Parse a statement by writing code for it — as a cancellable background job
// whose every step is visible.
import { query } from "../db.js";
import { step, checkCancel, finishJob, Cancelled } from "../jobs/store.js";
import { generateParser, fingerprint } from "./codegen.js";
import { buildContext, classifyByRules, flagFor } from "../statements/classify.js";
import { classifyRemaining } from "../statements/frontier-classify.js";
import { classificationContext } from "../statements-import.js";

let ensured = false;
async function ensureTemplates() {
  if (ensured) return;
  await query(`create table if not exists parser_templates (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references entities(id) on delete cascade,
    fingerprint text not null,
    label text,
    source text not null,
    rows_seen int not null default 0,
    uses int not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (entity_id, fingerprint))`);
  ensured = true;
}

export async function getTemplate(entId, fp) {
  await ensureTemplates();
  const r = await query("select * from parser_templates where entity_id=$1 and fingerprint=$2", [entId, fp]);
  return r[0] || null;
}

async function saveTemplate(entId, fp, { label, source, rows }) {
  await ensureTemplates();
  await query(
    `insert into parser_templates (entity_id, fingerprint, label, source, rows_seen)
     values ($1,$2,$3,$4,$5)
     on conflict (entity_id, fingerprint) do update
       set source = excluded.source, label = excluded.label,
           rows_seen = excluded.rows_seen, uses = parser_templates.uses + 1, updated_at = now()`,
    [entId, fp, label || null, source, rows || 0]);
}

// draft: a row from statement_drafts (its meta holds the pdf.js page text)
export async function parseDraftWithCodegen({ entity, entId, jobId, draft }) {
  const meta = draft.meta || {};
  const pages = Array.isArray(meta.pages) && meta.pages.length ? meta.pages : (meta.text ? [meta.text] : null);
  if (!pages) throw new Error("this statement has no stored text to parse");

  const pageCount = pages.length;
  const lineCount = pages.join("\n").split("\n").filter((l) => l.trim()).length;
  await step(jobId, "read", `Read ${draft.filename} — ${pageCount} page${pageCount === 1 ? "" : "s"}, ${lineCount} lines of text with the column spacing intact.`);
  await checkCancel(jobId);

  const fp = fingerprint(pages, draft.kind || "");
  const cachedRow = await getTemplate(entId, fp);
  const cached = cachedRow ? { source: cachedRow.source, label: cachedRow.label } : null;
  if (!cached) await step(jobId, "note", `New layout (${fp}) — I haven't written a parser for this one yet.`);

  const out = await generateParser({
    pages, filename: draft.filename, bank: draft.kind || "", cached,
    onStep: async (kind, text, data) => { await checkCancel(jobId); await step(jobId, kind, text, data); },
  });

  await checkCancel(jobId);
  const clean = out.score.rows > 0 && out.score.breaks === 0 && !out.score.zero_amounts && out.score.envelope_ok !== false;
  if (clean) {
    await saveTemplate(entId, fp, { label: `${draft.kind || "statement"} · ${draft.filename}`, source: out.source, rows: out.score.rows });
    if (!out.reused) await step(jobId, "cache", `Saved this parser for the layout — the next statement like it parses instantly, with no model call.`);
  }

  // classify the rows the same way the rest of the app does
  await step(jobId, "classify", "Matching each row to an account from your rules, history, then the model for the rest…");
  const raw = out.parsed.transactions.map((t, i) => ({ date: t.date, desc: t.description, amount: t.amount, balance: t.balance, i: i + 1 }));
  const ctx = buildContext(await classificationContext(entity));
  let rows = raw.map((t) => classifyByRules(t, ctx));
  const keep = new Map((draft.rows || []).filter((x) => x.source === "manual").map((x) => [`${x.date}|${x.amount}|${x.desc}`, x.account]));
  rows = rows.map((x) => { const m = keep.get(`${x.date}|${x.amount}|${x.desc}`); return m ? { ...x, account: m, source: "manual", rule: "manual", confidence: 1 } : x; });
  if (rows.some((x) => !x.account)) {
    try { rows = await classifyRemaining(rows, ctx); } catch (e) { await step(jobId, "note", `Classification fell back to defaults: ${String(e.message || e).slice(0, 120)}`); }
  }
  rows = rows.map((x) => ({ ...x, flag: x.account ? flagFor(x) : "!" }));
  const breaks = new Map((out.rec.continuity?.mismatches || []).map((m) => [m.index + 1, m]));
  rows = rows.map((x) => (breaks.has(x.i) ? { ...x, brk: breaks.get(x.i) } : x));

  const newMeta = {
    ...meta,
    parser: "codegen", parser_fingerprint: fp, parser_rounds: out.rounds, parser_reused: !!out.reused,
    statement_type: out.parsed.statement_type,
    opening_balance: out.parsed.opening_balance, closing_balance: out.parsed.closing_balance,
    model: "codegen", chunks: null, error: null,
    classified_by: rows.reduce((a, x) => ({ ...a, [x.source || "none"]: (a[x.source || "none"] || 0) + 1 }), {}),
  };
  await query(
    "update statement_drafts set status='ready', rows=$2, reconciliation=$3, meta=$4, result=null, updated_at=now() where id=$1",
    [draft.id, JSON.stringify(rows), JSON.stringify(out.rec), JSON.stringify(newMeta)]);

  const summary = {
    draft_id: draft.id, name: draft.filename, rows: out.score.rows, breaks: out.score.breaks,
    reconciled: out.score.reconciled, rounds: out.rounds, reused: !!out.reused, fingerprint: fp,
    zero_amounts: out.score.zero_amounts, envelope_ok: out.score.envelope_ok,
  };
  const caveat = out.score.zero_amounts ? ` · ⚠ ${out.score.zero_amounts} row(s) have no amount`
    : out.score.envelope_ok === false ? " · ⚠ opening + net ≠ closing, so a row is probably missing"
    : out.score.reconciled ? " — reconciles ✓" : out.score.verifiable ? "" : " · nothing to verify against";
  await step(jobId, "done", `${draft.filename}: ${out.score.rows} rows, ${out.score.breaks} balance breaks${caveat}.`, summary);
  return summary;
}

// Parse one or many statements in a single job, so the transcript reads as one
// session rather than a pile of disconnected runs.
export async function runParseJob({ entity, entId, jobId, draftIds }) {
  const results = [];
  try {
    for (let i = 0; i < draftIds.length; i++) {
      await checkCancel(jobId);
      const r = await query("select * from statement_drafts where entity_id=$1 and id=$2", [entId, draftIds[i]]);
      if (!r.length) continue;
      if (draftIds.length > 1) await step(jobId, "heading", `Statement ${i + 1} of ${draftIds.length}: ${r[0].filename}`);
      try {
        results.push(await parseDraftWithCodegen({ entity, entId, jobId, draft: r[0] }));
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        await step(jobId, "error", `${r[0].filename}: ${String(e.message || e).slice(0, 300)}`);
        results.push({ draft_id: r[0].id, name: r[0].filename, error: String(e.message || e) });
      }
    }
    const okRows = results.reduce((a, x) => a + (x.rows || 0), 0);
    const okBreaks = results.reduce((a, x) => a + (x.breaks || 0), 0);
    await step(jobId, "summary", `Finished ${results.length} statement${results.length === 1 ? "" : "s"}: ${okRows} rows, ${okBreaks} balance breaks.`);
    await finishJob(jobId, "done", { results, rows: okRows, breaks: okBreaks });
  } catch (e) {
    if (e instanceof Cancelled) {
      await step(jobId, "stopped", "Stopped. Statements already finished keep their new parse; the rest are untouched.");
      await finishJob(jobId, "cancelled", { results });
    } else {
      await step(jobId, "error", String(e.message || e).slice(0, 400));
      await finishJob(jobId, "failed", { results, error: String(e.message || e) });
    }
  }
}
