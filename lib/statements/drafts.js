// Statement drafts — the server-side state behind the /import screen.
//
//   upload (browser reads the file, pdf.js gives page text) → draft 'queued'
//   → process: frontier extraction (PDF) or deterministic rows (CSV/XLSX)
//   → reconcile against the printed running balance → classify (rules → frontier)
//   → 'ready' (review, ask, re-extract with a hint) → import → 'imported'
//
// Everything is scoped to the caller's entity; drafts of other entities are
// invisible (every query joins on entity_id).
import { query, pool } from "../db.js";
import { extractStatement, extractConfigured } from "./extract.js";
import { reconcile } from "./reconcile.js";
import { buildContext, classifyByRules, flagFor } from "./classify.js";
import { classifyRemaining } from "./frontier-classify.js";
import { normalizeCardSigns } from "./parse.js";
import { classificationContext, importStatement, extractionRules, saveExtractionRules } from "../statements-import.js";
import { gatewayModelLabel } from "./gateway.js";
import { startJob, step as jobStep, finishJob, getJob } from "../jobs/store.js";
import { rulesFor, renderRules } from "./rules.js";
import { listSourceRules, resolveHome } from "./source-rules.js";

let ensured = false;
export async function ensureDraftsTable() {
  if (ensured) return;
  await query(`create table if not exists statement_drafts (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references entities(id) on delete cascade,
    filename text not null, sha256 text, bytes bigint, source text, account text, kind text,
    status text not null default 'queued' check (status in ('queued','processing','ready','imported','failed')),
    rows jsonb not null default '[]', reconciliation jsonb, meta jsonb not null default '{}', result jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await query("create index if not exists statement_drafts_entity_idx on statement_drafts (entity_id, updated_at desc)");
  await query("create index if not exists statement_drafts_sha_idx on statement_drafts (entity_id, sha256)");
  ensured = true;
}

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

const r2 = (n) => Math.round(Number(n) * 100) / 100;

// Compact card view (no rows) for the grid.
export function summarize(d) {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const inflow = r2(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const outflow = r2(rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  const review = rows.filter((r) => !r.account || r.confidence < 0.6 || /:Other$/.test(r.account || "")).length;
  const rec = d.reconciliation;
  return {
    id: d.id, filename: d.filename, sha256: d.sha256, bytes: d.bytes == null ? null : Number(d.bytes), source: d.source,
    account: d.account, kind: d.kind, status: d.status, meta: d.meta || {}, result: d.result || null,
    created_at: d.created_at, updated_at: d.updated_at,
    rows_count: rows.length, inflow, outflow, net: r2(inflow - outflow), from: dates[0] || null, to: dates[dates.length - 1] || null,
    needs_review: review,
    reconciled: rec ? !!rec.reconciled : null, breaks: rec?.continuity?.mismatches?.length || 0, rec_note: rec?.note || null,
    complete: d.meta?.completeness ? !!d.meta.completeness.complete : null,
    completeness_findings: d.meta?.completeness?.findings?.length ? d.meta.completeness.findings : null,
    crosscheck_findings: d.meta?.crosscheck?.findings?.length ? d.meta.crosscheck.findings : null,
    chunk_failures: d.meta?.chunk_failures?.length || 0,
    closing_balance: rows.filter((r) => r.balance != null).slice(-1)[0]?.balance ?? d.meta?.closing_balance ?? null,
  };
}

// A draft whose extraction died — deploy, crash, a killed request — is left
// 'processing' with no rows and no error, and nothing in the UI can explain it or
// offer a retry. Anything untouched for 20 minutes is stale: say so. (Jobs have
// had this since day one via reapStale; drafts did not.)
export async function reapStuckDrafts(entity) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  await query(
    `update statement_drafts
        set status='failed',
            meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{error}',
                   to_jsonb('This read stopped unexpectedly — the server restarted or the request was cut off. Nothing was changed; re-extract to try again.'::text)),
            updated_at = now()
      where entity_id=$1 and status='processing' and updated_at < now() - interval '20 minutes'`, [entId]);
}

export async function listDrafts(entity) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  await reapStuckDrafts(entity).catch(() => {});
  const rows = await query("select * from statement_drafts where entity_id=$1 order by updated_at desc limit 200", [entId]);
  return rows.map(summarize);
}

export async function getDraft(entity, id) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  const r = await query("select * from statement_drafts where entity_id=$1 and id=$2", [entId, id]);
  if (!r.length) return null;
  return { ...summarize(r[0]), rows: r[0].rows, reconciliation: r[0].reconciliation };
}

export async function deleteDraft(entity, id) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  await query("delete from statement_drafts where entity_id=$1 and id=$2", [entId, id]);
}

async function save(id, patch) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(patch)) { vals.push(k === "rows" || k === "reconciliation" || k === "meta" || k === "result" ? JSON.stringify(v) : v); sets.push(`${k}=$${vals.length}`); }
  vals.push(id);
  await query(`update statement_drafts set ${sets.join(", ")}, updated_at=now() where id=$${vals.length}`, vals);
}

// Create (or find, by sha256) a draft, then process it to 'ready'.
//   input: { filename, sha256, bytes, source, account, kind, pages?: string[], rows?: [{date,desc,amount,balance}], force_new? }
export async function createAndProcess(entity, input) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  if (input.sha256 && !input.force_new) {
    const dup = await query("select * from statement_drafts where entity_id=$1 and sha256=$2 order by updated_at desc limit 1", [entId, input.sha256]);
    if (dup.length) return { ...summarize(dup[0]), duplicate: true, rows: dup[0].rows, reconciliation: dup[0].reconciliation };
  }
  const meta = {
    pages: Array.isArray(input.pages) ? input.pages : null,
    raw_rows: Array.isArray(input.rows) ? input.rows : null,
    text: typeof input.text === "string" ? input.text : null,
    hints: [],
  };
  // WHERE THIS POSTS FROM. The caller guesses a home account from the filename;
  // an operator's source rule outranks that guess. Once a kind has any rule the
  // guess is discarded entirely — a statement matching nothing gets no home
  // account and is stopped at import, rather than landing on a plausible-looking
  // wrong one. See lib/statements/source-rules.js.
  let account = input.account || null;
  let account_source = account ? "default" : null;
  try {
    const home = resolveHome(await listSourceRules(entity), {
      kind: input.kind || "",
      filename: String(input.filename || ""),
      text: [meta.text || "", ...(meta.pages || [])].join("\n"),
    });
    if (home.kind_has_rules) { account = home.account; account_source = home.source; }
    if (home.ambiguous) meta.account_ambiguous = home.matched.map((r) => r.match);
  } catch { /* a rule lookup must never block an upload */ }
  meta.account_source = account_source;

  const ins = await query(
    `insert into statement_drafts (entity_id, filename, sha256, bytes, source, account, kind, status, meta)
     values ($1,$2,$3,$4,$5,$6,$7,$9,$8) returning *`,
    [entId, String(input.filename || "statement").slice(0, 200), input.sha256 || null, input.bytes || null, input.source || null, account, input.kind || null, JSON.stringify(meta), input.skip_parse ? "queued" : "processing"]);
  // skip_parse: the caller (studio) will run the code-writing parser as a job
  if (input.skip_parse) return { ...summarize(ins[0]), rows: [], reconciliation: null };

  // Extraction is a BACKGROUND JOB, like parsing already was. It used to run
  // inline inside the upload request, which was fine at ~40s a statement — then
  // extended thinking made a 10-chunk statement take many minutes, it blew the
  // route's maxDuration, the handler was killed mid-flight and the draft was
  // orphaned in 'processing' with no rows and no error and no way to retry.
  // Now the request returns at once, the work carries on, and every step of it
  // (including each repair round) is visible through /api/jobs/:id.
  const job = await startJob(entity, { kind: "extract", title: `Read ${ins[0].filename}`, draft_id: ins[0].id });
  processDraft(entity, ins[0].id, { hint: "", jobId: job.id }).catch(() => {});
  return { ...summarize(ins[0]), rows: [], reconciliation: null, job_id: job.id };
}

// (Re)run extraction + classification for a draft. `hint` is a one-off,
// statement-specific instruction; it is recorded in meta.hints for provenance.
export async function processDraft(entity, id, { hint = "", remember = false, jobId = null } = {}) {
  const note = jobId ? (text) => jobStep(jobId, "note", String(text).slice(0, 400)).catch(() => {}) : null;
  await ensureDraftsTable();
  const entId = await entityId(entity);
  const r = await query("select * from statement_drafts where entity_id=$1 and id=$2", [entId, id]);
  if (!r.length) throw new Error("no such draft");
  const d = r[0];
  const meta = { ...(d.meta || {}) };
  await save(id, { status: "processing", meta: { ...meta, error: null } });
  try {
    if (remember && hint.trim()) {
      const cur = await extractionRules(entity, entId);
      await saveExtractionRules(entity, (cur ? cur.trimEnd() + "\n" : "") + hint.trim());
    }
    // Operator notes plus every ACTIVE rule that applies to this bank/layout.
    // A rule is how a fix ships without a deploy.
    const operatorRules = await extractionRules(entity, entId);
    const learned = renderRules(await rulesFor(entity, { bank: d.kind || "" }).catch(() => []));
    const rules = [operatorRules, learned && `LEARNED RULES FOR THIS SOURCE:\n${learned}`].filter(Boolean).join("\n\n");
    let raw = [], rec = null, extracted = null;
    // A PDF always goes to the frontier extractor. A tabular file uses its
    // deterministic parse when that worked (exact, free, instant) and falls back
    // to the extractor when the layout defeated it — so "the AI handles any
    // layout" is true for CSV/XLSX too, not just PDF. A hint always forces a
    // re-extract: the user is telling us the deterministic read was wrong.
    const tabularParsed = Array.isArray(meta.raw_rows) && meta.raw_rows.length > 0;
    const useExtractor = (meta.pages && meta.pages.length) || (!tabularParsed && meta.text) || (hint.trim() && (meta.pages?.length || meta.text));
    if (useExtractor) {
      if (!extractConfigured()) throw new Error("extract_not_configured");
      await note?.(`Reading ${d.filename}…`);
      extracted = await extractStatement({ entity, pages: meta.pages, text: meta.text, filename: d.filename, bank: d.kind || "", rules, hint, onNote: note });
      if (extracted.error) throw new Error(extracted.message || extracted.error);
      raw = (extracted.transactions || []).map((t) => ({ date: t.date, desc: t.description, amount: t.amount, balance: t.balance ?? null }));
      rec = extracted.reconciliation || null;
      meta.period = extracted.period || null; meta.opening_balance = extracted.opening_balance ?? null; meta.closing_balance = extracted.closing_balance ?? null;
      meta.model = extracted.model; meta.chunks = extracted.chunks; meta.statement_type = extracted.statement_type;
      meta.total_credits = extracted.total_credits ?? null; meta.total_debits = extracted.total_debits ?? null;
      meta.dropped_totals = extracted.dropped_totals?.length ? extracted.dropped_totals : null;
      meta.completeness = extracted.completeness ?? null;
      meta.crosscheck = extracted.crosscheck ?? null;
      meta.chunk_failures = extracted.chunk_failures ?? null;
      meta.rounds = extracted.rounds ?? null;
      meta.extractor_version = extracted.extractor_version ?? null; meta.extractor_fallback = extracted.extractor_fallback ?? null;
    } else if (tabularParsed) {
      const kind = (d.account || "").startsWith("Liabilities:Card:") ? "card" : "bank";
      raw = normalizeCardSigns(meta.raw_rows, kind).map((t) => ({ date: t.date, desc: t.desc, amount: t.amount, balance: t.balance ?? null, sign_flipped: t.sign_flipped }));
      rec = reconcile(raw.map((t) => ({ ...t, description: t.desc })), { statement_type: kind });
      meta.model = "deterministic"; meta.statement_type = kind;
    } else throw new Error("nothing to parse: no pages and no rows");
    if (!raw.length) throw new Error(meta.pages ? "the model found no transactions in this file — add a hint below (e.g. which pages/columns hold them) and retry" : "no transaction rows found — this file doesn't look like a CSV/XLSX statement (needs a header row with a date and an amount or debit/credit column)");

    // classification: rules/history/heuristics first, frontier for the tail
    const ctx = buildContext(await classificationContext(entity));
    let rows = raw.map((t, i) => classifyByRules({ ...t, i: i + 1 }, ctx));
    // keep manual picks from a previous pass (same date+amount+desc)
    const prev = new Map((d.rows || []).filter((x) => x.source === "manual").map((x) => [`${x.date}|${x.amount}|${x.desc}`, x.account]));
    rows = rows.map((x) => { const m = prev.get(`${x.date}|${x.amount}|${x.desc}`); return m ? { ...x, account: m, source: "manual", rule: "manual", confidence: 1 } : x; });
    if (rows.some((x) => !x.account)) { try { rows = await classifyRemaining(rows, ctx); } catch (e) { meta.classify_error = String(e.message || e); } }
    rows = rows.map((x) => ({ ...x, flag: x.account ? flagFor(x) : "!" }));
    // mark balance breaks on the rows themselves (index → row.i)
    const breaks = new Map((rec?.continuity?.mismatches || []).map((m) => [m.index + 1, m]));
    rows = rows.map((x) => (breaks.has(x.i) ? { ...x, brk: breaks.get(x.i) } : x));

    if (hint.trim()) meta.hints = [...(meta.hints || []), { hint: hint.trim(), remembered: !!remember, at: new Date().toISOString() }];
    meta.classified_by = rows.reduce((acc, x) => ({ ...acc, [x.source || "none"]: (acc[x.source || "none"] || 0) + 1 }), {});
    await save(id, { status: "ready", rows, reconciliation: rec, meta, result: null });
    if (jobId) {
      const verdict = rec?.reconciled ? "reconciles ✓" : (rec?.note || "needs a look");
      await jobStep(jobId, "done", `${d.filename}: ${rows.length} rows — ${verdict}`).catch(() => {});
      await finishJob(jobId, "done", { draft_id: id, rows: rows.length, reconciled: !!rec?.reconciled }).catch(() => {});
    }
  } catch (e) {
    const msg = String(e?.message || e);
    meta.error = msg === "extract_not_configured" ? "AI extraction isn't switched on for this workspace yet (gateway not configured) — ask the operator, or use private on-device mode" : msg;
    await save(id, { status: "failed", meta });
    if (jobId) {
      await jobStep(jobId, "error", msg.slice(0, 300)).catch(() => {});
      await finishJob(jobId, "failed", { draft_id: id, error: msg.slice(0, 300) }).catch(() => {});
    }
  }
  return getDraft(entity, id);
}

// Re-parse every stored statement with the parser that is active now, so the
// whole set is read by the same code. Imported ones are skipped — their rows are
// already in the ledger, and re-reading the draft would not change that.
export async function reparseAll(entity) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  const rows = await query(
    `select id, filename from statement_drafts
      where entity_id=$1 and status <> 'imported' and (meta ? 'pages' or meta ? 'text')
      order by updated_at desc limit 60`, [entId]);
  const results = [];
  for (const r of rows) {
    try {
      const d = await processDraft(entity, r.id, { hint: "" });
      results.push({ id: r.id, name: r.filename, status: d.status, rows: d.rows_count, breaks: d.breaks, reconciled: d.reconciled });
    } catch (e) {
      results.push({ id: r.id, name: r.filename, status: "failed", error: String(e.message || e) });
    }
  }
  const skipped = (await query("select count(*)::int n from statement_drafts where entity_id=$1 and status='imported'", [entId]))[0].n;
  return {
    ok: true, reparsed: results.length, skipped_imported: skipped, results,
    message: `Re-parsed ${results.length} statement${results.length === 1 ? "" : "s"} with the current parser${skipped ? ` · ${skipped} already-imported left alone` : ""}.`,
  };
}

// PATCH: per-row account edits, statement account/kind.
export async function updateDraft(entity, id, patch) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  const r = await query("select * from statement_drafts where entity_id=$1 and id=$2", [entId, id]);
  if (!r.length) throw new Error("no such draft");
  const d = r[0];
  const upd = {};
  if (patch.account) upd.account = String(patch.account).slice(0, 120);
  if (patch.kind) upd.kind = String(patch.kind).slice(0, 60);
  if (patch.row_accounts && typeof patch.row_accounts === "object") {
    upd.rows = (d.rows || []).map((x) => {
      const a = patch.row_accounts[String(x.i)];
      return a ? { ...x, account: a, source: "manual", rule: "manual", confidence: 1, flag: "*" } : x;
    });
  }
  if (Object.keys(upd).length) await save(id, upd);
  return getDraft(entity, id);
}

// Import a ready draft into the ledger; learn manual picks as decisions.
// UNDO MANUAL CATEGORISATION, back to what the rules say.
//
// A manual pick overwrites the row's account, source, rule and confidence — the
// classifier's own answer is gone. So "clearing" is not blanking: it re-runs the
// deterministic classifier (decisions, then regex, then payee history) and puts
// the row back where the rules would have placed it. Any set_payee_rule made
// since is picked up, so this doubles as "re-apply my rules to rows I had
// overridden".
//
// Rows the rules cannot place come back with no account, which import_statement
// refuses by name — the honest outcome, rather than a plausible guess.
export async function clearRowOverrides(entity, { id = null, all = false } = {}) {
  await ensureDraftsTable();
  const entId = await entityId(entity);
  const where = all ? "entity_id=$1 and status <> 'imported'" : "entity_id=$1 and id=$2";
  const drafts = await query(`select * from statement_drafts where ${where}`, all ? [entId] : [entId, id]);
  if (!drafts.length) throw new Error(all ? "no statements to clear" : "no such statement");

  const ctx = buildContext(await classificationContext(entity));
  const out = [];
  for (const d of drafts) {
    if (d.status === "imported") { out.push({ filename: d.filename, skipped: "already imported" }); continue; }
    const rows = d.rows || [];
    const manual = rows.filter((r) => r.source === "manual").length;
    if (!manual) continue;
    let unplaced = 0;
    const next = rows.map((r) => {
      if (r.source !== "manual") return r;
      const c = classifyByRules({ ...r, account: null, source: null, rule: null, confidence: 0 }, ctx);
      if (!c.account) unplaced++;
      // balance, brk and the row id are the row's own facts, not the classifier's
      return { ...c, i: r.i, balance: r.balance, brk: r.brk, corrected: r.corrected,
               flag: c.account ? flagFor(c) : "!" };
    });
    await save(d.id, { rows: next });
    out.push({ statement_id: d.id, filename: d.filename, cleared: manual, now_unclassified: unplaced });
  }
  return { statements: out, total_cleared: out.reduce((t, x) => t + (x.cleared || 0), 0) };
}

// CORRECT ONE ROW, and prove it against the reconciler before keeping it.
//
// set_row_account moves the counter-leg; this is the other half — the row's own
// amount or sign, or removing a row the parser invented. Those change the books,
// so nothing is written unless the statement's arithmetic gets no worse: the
// reconciler is the judge, exactly as it is for a proposed extraction rule.
//
// `force` exists for the case where the operator has the document open and the
// statement still will not close (a printed total rounded to the rupee, say).
// It records the change and says plainly that it was not proved.
export async function fixRow(entity, id, { row, action, amount = null, reason = null, force = false }) {
  await ensureDraftsTable();
  const d = await getDraft(entity, id);
  if (!d) throw new Error("no such statement");
  if (d.status === "imported")
    throw new Error(`${d.filename} is already imported — correcting it now would leave the ledger disagreeing with the statement. That is a ledger correction, not a staging change.`);

  const rows = d.rows || [];
  const at = rows.findIndex((r) => Number(r.i) === Number(row));
  if (at < 0) throw new Error(`no row ${row} in ${d.filename} — row ids come from statement_rows`);
  const before = rows[at];

  let next;
  if (action === "drop") next = null;
  else if (action === "flip_sign") next = { ...before, amount: -Number(before.amount) };
  else if (action === "set_amount") {
    const v = Number(amount);
    if (!Number.isFinite(v) || v === 0) throw new Error("set_amount needs a non-zero `amount` (negative for money out)");
    next = { ...before, amount: v };
  } else throw new Error(`unknown action "${action}" — use set_amount, flip_sign or drop`);
  if (next) next.corrected = reason || `${action} via the connector`;

  const after = next ? rows.map((r, i) => (i === at ? next : r)) : rows.filter((_, i) => i !== at);
  const meta = d.meta || {};
  const opts = { statement_type: meta.statement_type, opening_balance: meta.opening_balance, closing_balance: meta.closing_balance,
                 total_credits: meta.total_credits, total_debits: meta.total_debits };
  const withDesc = (rs) => rs.map((r) => ({ ...r, description: r.desc ?? r.description }));
  const rec0 = reconcile(withDesc(rows), opts);
  const rec1 = reconcile(withDesc(after), opts);

  // Lower is better: not reconciling costs most, then each break, then the money
  // still unexplained. A change that raises this made the statement worse.
  const score = (rec) => {
    const s = rec.sides || {};
    const gap = [s.credits, s.debits].reduce((t, x) => t + (x && !x.ok ? Math.abs(x.gap) : 0), 0);
    return { ok: !!rec.reconciled, breaks: rec.continuity?.mismatches?.length || 0, gap: Math.round(gap * 100) / 100 };
  };
  const a = score(rec0), b = score(rec1);
  const improved = b.ok || b.breaks < a.breaks || (b.breaks === a.breaks && b.gap < a.gap - 0.005);
  const worse = (!b.ok && a.ok) || b.breaks > a.breaks || (b.breaks === a.breaks && b.gap > a.gap + 0.005);

  if (!improved && !force)
    return { applied: false, filename: d.filename, before: a, after: b,
             refused: worse ? "that makes the statement worse — it was not applied" : "that changes nothing the reconciler can see — it was not applied. Pass force:true if the document says otherwise." };

  await save(id, { rows: after, reconciliation: rec1 });
  return { applied: true, forced: !!force && !improved, filename: d.filename, action,
           row: { i: before.i, date: before.date, desc: before.desc, amount_before: before.amount, amount_after: next ? next.amount : null },
           before: a, after: b, rows_now: after.length };
}

export async function importDraft(entity, id, { force = false, userEmail = null } = {}) {
  const d = await getDraft(entity, id);
  if (!d) throw new Error("no such draft");
  if (d.status === "imported") return { ok: true, already: true, result: d.result };
  if (!d.account) throw new Error("no home account — set_source_rule or set_statement_account first");
  // A row with no amount is not a transaction. IDBI opens each statement with a
  // "B/F" line carrying the brought-forward balance and no movement; posting it
  // would write a meaningless zero entry, and importStatement rejects it outright
  // ("bad amount"), which blocked the whole statement. The balance chain still
  // needs it, so it stays on the draft — it is only excluded from the ledger.
  // The opening seed is unaffected: it comes from the first row that carries a
  // balance, and balance − amount is the same figure either way.
  const rows = (d.rows || [])
    .filter((r) => Math.abs(Number(r.amount)) > 0)
    // `i` travels with the row: importStatement keys its idempotency on it, so
    // dropping it here would silently fall back to the old (date|amount|desc)
    // key and discard genuine repeats all over again.
    .map(({ i, date, desc, amount, balance, payee, account, source, rule, confidence, flag, sign_flipped }) => ({ i, date, desc, amount, balance, payee, account, source, rule, confidence, flag, sign_flipped }));
  if (rows.some((x) => !x.account)) throw new Error("some rows have no account yet");
  const result = await importStatement(entity, { filename: d.filename, sha256: d.sha256, bytes: d.bytes, account: d.account, kind: d.kind, model: d.meta?.model || gatewayModelLabel(), rows, opening_balance: d.meta?.opening_balance ?? null, force, userEmail });
  if (result.ok) {
    const entId = await entityId(entity);
    for (const x of (d.rows || []).filter((x) => x.source === "manual" && x.payee)) {
      await query(`insert into decisions (entity_id, key, decision, rationale) values ($1,$2,$3,'picked while importing a statement')
                   on conflict (entity_id,key) do update set decision=excluded.decision`, [entId, `payee:${x.payee}`, x.account]).catch(() => {});
    }
    await save(id, { status: "imported", result });
  }
  return result;
}
