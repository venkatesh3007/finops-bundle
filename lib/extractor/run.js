// The host pipeline. It owns everything the sandboxed module must never touch —
// the gateway call, the stitching of chunk results, and the reconciliation that
// decides whether the output can be trusted.
//
//   module.preprocess → module.chunk → [gateway per chunk] → merge → module.postprocess → reconcile
import { chatText, jsonFrom, gatewayConfigured, gatewayModelLabel } from "../statements/gateway.js";
import { documentNumbers } from "../parser/gates.js";
import { reconcile } from "../statements/reconcile.js";
import { completeness } from "../statements/completeness.js";
import { compileModule } from "./sandbox.js";

// Pull a JSON object out of a messy model reply: strip fences, drop reasoning
// wrappers, then scan to the BALANCE-AWARE matching brace so trailing prose
// can't corrupt it. An unbalanced scan means the reply was cut off.
function extractJson(s) {
  let t = String(s || "").trim().replace(/^﻿/, "");
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  t = t.replace(/<\/?(?:ds_safety|think|reasoning)>[\s\S]*$/i, "");
  const start = t.indexOf("{");
  if (start < 0) return { json: t, truncated: false };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { json: t.slice(start, i + 1), truncated: false };
  }
  return { json: t.slice(start), truncated: true };
}

async function callModel({ prompt, text, filename, bank, period, isChunk, chunkIndex, chunkTotal, priorBalance, rules, hint }) {
  const hints = [
    filename && `Filename: ${filename}`,
    bank && `Likely bank/card: ${bank}`,
    period && `Statement period: ${period.from || "?"} to ${period.to || "?"}`,
    isChunk && `This is page-chunk ${chunkIndex + 1} of ${chunkTotal}. Continue the same statement; the running balance immediately BEFORE this chunk's first transaction is ${priorBalance ?? "unknown"}.`,
  ].filter(Boolean).join("\n");

  let system = prompt;
  if (rules && rules.trim()) system += `\n\nOPERATOR RULES FOR THIS ACCOUNT — apply these; they override the defaults above when they conflict:\n${rules.trim()}`;
  if (hint && hint.trim()) system += `\n\nINSTRUCTIONS FROM THE USER FOR THIS PARTICULAR STATEMENT — follow these first; they override everything above when they conflict:\n${hint.trim()}`;

  const raw = await chatText(
    [{ role: "system", content: system }, { role: "user", content: `${hints}\n\nSTATEMENT TEXT:\n"""\n${text}\n"""` }],
    { max_tokens: 16000 },
  );
  const { json, truncated } = extractJson(raw);
  try {
    return JSON.parse(json);
  } catch {
    if (truncated) throw new Error(`the model's reply was cut off mid-JSON (${raw.length} chars) — this chunk is too large for the current model. Ask the lab to make chunk() split smaller.`);
    throw new Error(`model returned non-JSON: ${String(raw).slice(0, 200)}`);
  }
}

export const MAX_REPAIR_ROUNDS = 2;
const TRANSIENT_ATTEMPTS = 4;      // 1 try + 3 retries
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A retry policy has to key on the KIND of failure. A blanket "try three times"
// re-sends a prompt that was too long the first time, and re-asks a question the
// model already answered honestly.
//   transient  → the request never completed. Retry it unchanged.
//   truncated  → the reply was cut off. Retrying identically truncates again;
//                the chunk has to get smaller.
//   otherwise  → a real answer we disagree with. That is the repair loop's job.
export function isTransient(err) {
  const m = String(err?.message || err);
  return /gateway\s+(?:408|409|425|429|5\d\d)\b/i.test(m) ||
    /\bterminated\b|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|network|fetch failed|aborted/i.test(m);
}
export function isTruncation(err) {
  return /cut off mid-JSON/i.test(String(err?.message || err));
}

// One chunk, with transport retries. Every statement lost on 2026-08-31 was lost
// to a transport error, not a bad parse — a 504 on chunk 3 of 8 threw away the
// seven good chunks around it.
async function callChunk(args, onNote) {
  let delay = 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await callModel(args);
    } catch (e) {
      if (attempt >= TRANSIENT_ATTEMPTS || !isTransient(e)) throw e;
      await onNote?.(`part ${args.chunkIndex + 1}: ${String(e.message || e).slice(0, 80)} — retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

// Halve a chunk on a line boundary. The remedy for a truncated reply, which
// run.js already detected and named but nothing acted on.
function halve(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length < 4) return null;
  const mid = Math.floor(lines.length / 2);
  return [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")];
}

// Run one chunk, splitting it if the reply comes back truncated. Returns the
// merged output of however many sub-calls it took.
async function runChunk({ base, text, ci, total, priorBalance, onNote, extra = "" }, depth = 0) {
  try {
    return await callChunk({ ...base, text, chunkIndex: ci, chunkTotal: total, priorBalance, hint: [base.hint, extra].filter(Boolean).join("\n\n") }, onNote);
  } catch (e) {
    const parts = isTruncation(e) && depth < 2 ? halve(text) : null;
    if (!parts) throw e;
    await onNote?.(`part ${ci + 1}: the reply was cut off — splitting it and reading each half`);
    const merged = { transactions: [] };
    let prior = priorBalance;
    for (const part of parts) {
      const out = await runChunk({ base, text: part, ci, total, priorBalance: prior, onNote, extra }, depth + 1);
      for (const k of ["statement_type", "currency", "period", "opening_balance", "closing_balance", "total_credits", "total_debits"]) {
        if (merged[k] == null && out?.[k] != null) merged[k] = out[k];
      }
      const txns = Array.isArray(out?.transactions) ? out.transactions : [];
      merged.transactions.push(...txns);
      const lb = [...txns].reverse().find((t) => t?.balance != null)?.balance;
      if (lb != null) prior = lb;
    }
    return merged;
  }
}

// Extract with a specific module SOURCE. Used both by the live path (active
// version) and by the lab (a candidate under evaluation).
export async function extractWithModule({ source, pages, text, filename = "", bank = "", period = null, rules = "", hint = "", onNote = null }) {
  if (!gatewayConfigured()) return { error: "extract_not_configured" };
  const mod = compileModule(source); // throws ModuleError — the lab reads that message

  const rawText = Array.isArray(pages) && pages.length ? pages.join("\n") : String(text || "");
  const ctx = { filename, bank, rules, hint, period };
  const cleaned = mod.preprocess(rawText, ctx);
  const chunks = mod.chunk(cleaned, ctx);
  const printedNumbers = documentNumbers(rawText);
  const base = { prompt: mod.prompt, filename, bank, rules, hint, isChunk: chunks.length > 1, period };

  // Rows are kept PER CHUNK, not merged flat, so a repair can replace one chunk's
  // output without disturbing the others — and so chunk accounting can tell which
  // part of the document came back light.
  const perChunk = new Array(chunks.length).fill(null);
  let meta = { statement_type: "bank", currency: "INR", period, opening_balance: null, closing_balance: null, total_credits: null, total_debits: null };
  let metaSeen = false;

  const absorbMeta = (out, first) => {
    if (first && !metaSeen) {
      meta = {
        statement_type: out.statement_type || "bank", currency: out.currency || "INR",
        period: out.period || period, opening_balance: out.opening_balance ?? null, closing_balance: out.closing_balance ?? null,
        total_credits: out.total_credits ?? null, total_debits: out.total_debits ?? null,
      };
      metaSeen = true;
      // once the statement tells us its own period, later chunks get the real one
      if (meta.period) base.period = meta.period;
    }
    // The summary box usually sits on page 1, but not always — take each figure
    // from whichever chunk reports it, without letting a later chunk clobber one.
    for (const k of ["total_credits", "total_debits", "opening_balance"]) {
      if (meta[k] == null && out[k] != null) meta[k] = out[k];
    }
    if (out.closing_balance != null) meta.closing_balance = out.closing_balance;
  };

  const runOne = async (ci, extra = "") => {
    const priorBalance = (() => {
      for (let j = ci - 1; j >= 0; j--) {
        const lb = [...(perChunk[j] || [])].reverse().find((t) => t?.balance != null)?.balance;
        if (lb != null) return lb;
      }
      return null;
    })();
    const out = await runChunk({ base, text: chunks[ci], ci, total: chunks.length, priorBalance, onNote, extra });
    absorbMeta(out, ci === 0);
    return (Array.isArray(out.transactions) ? out.transactions : []).map((t) => ({ ...t, _chunk: ci }));
  };

  // ---- pass 1 -------------------------------------------------------------
  const failures = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    try {
      perChunk[ci] = await runOne(ci);
    } catch (e) {
      // One bad chunk must not throw away the good ones. Record it, keep going,
      // and let the caller see exactly which part of the document is missing.
      perChunk[ci] = [];
      failures.push({ chunk: ci, error: String(e.message || e).slice(0, 200) });
      await onNote?.(`part ${ci + 1} of ${chunks.length} could not be read: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  // Build a full result from the current per-chunk rows and judge it.
  const assess = () => {
    const grounded = (v) => (v != null && printedNumbers.has(Math.abs(Number(v)).toFixed(2)) ? v : null);
    const m = { ...meta };
    const droppedTotals = [];
    for (const k of ["total_credits", "total_debits", "opening_balance", "closing_balance"]) {
      if (m[k] != null && grounded(m[k]) == null) { droppedTotals.push(k); m[k] = null; }
    }
    const flat = perChunk.flatMap((r) => r || []);
    const rows = mod.postprocess(flat, { ...ctx, ...m });
    const rec = reconcile(rows, {
      statement_type: m.statement_type, opening_balance: m.opening_balance, closing_balance: m.closing_balance,
      total_credits: m.total_credits, total_debits: m.total_debits,
    });
    const comp = completeness({
      rows, chunkTexts: chunks, rowsPerChunk: perChunk.map((r) => (r || []).length), period: m.period || period,
    });
    return { meta: m, droppedTotals, rows, rec, comp };
  };

  // Distance from a clean result: every unexplained rupee plus a heavy penalty
  // for a chunk that returned nothing it should have. Lower is better.
  const cost = (a) => {
    const s = a.rec.sides || {};
    const gaps = [s.credits?.gap, s.debits?.gap, a.rec.envelope ? a.rec.envelope.printed_closing - a.rec.envelope.expected_closing : 0]
      .filter((x) => typeof x === "number").reduce((t, x) => t + Math.abs(x), 0);
    return gaps + a.comp.suspect_chunks.length * 1e6 + (a.rec.continuity?.mismatches?.length || 0) * 1e4;
  };

  let best = assess();
  let rounds = 1;

  // ---- repair -------------------------------------------------------------
  // Only chunks we have evidence against are re-run, and only while there is
  // something specific to say. A repair that comes back worse is DISCARDED —
  // the same champion rule the codegen path uses, for the same reason: a re-ask
  // can lose rows, and the previous answer is not recoverable once overwritten.
  for (let round = 1; round <= MAX_REPAIR_ROUNDS && !(best.rec.reconciled && best.comp.complete); round++) {
    const targets = repairTargets(best, failures, chunks.length);
    if (!targets.length) break;
    const instruction = repairInstruction(best, failures);
    if (!instruction) break;
    await onNote?.(`${describeGap(best)} — re-reading part${targets.length > 1 ? "s" : ""} ${targets.map((t) => t + 1).join(", ")}`);

    const snapshot = perChunk.map((r) => (r ? [...r] : r));
    for (const ci of targets) {
      try { perChunk[ci] = await runOne(ci, instruction); } catch (e) {
        perChunk[ci] = snapshot[ci] || [];
        await onNote?.(`part ${ci + 1}: still could not be read (${String(e.message || e).slice(0, 90)})`);
      }
    }
    const candidate = assess();
    rounds = round + 1;
    if (cost(candidate) < cost(best) && candidate.rows.length >= best.rows.length - 0) {
      best = candidate;
      await onNote?.(`better: ${best.rows.length} rows, ${describeGap(best) || "everything ties"}`);
    } else {
      for (let i = 0; i < perChunk.length; i++) perChunk[i] = snapshot[i];
      await onNote?.("that re-read was not an improvement — keeping the previous one");
      break;
    }
  }

  return {
    ...best.meta, model: gatewayModelLabel(), chunks: chunks.length, rounds,
    dropped_totals: best.droppedTotals.length ? best.droppedTotals : null,
    chunk_failures: failures.length ? failures : null,
    completeness: best.comp,
    transactions: best.rows, reconciliation: best.rec,
  };
}

// Which chunks are worth re-reading, in priority order: ones that failed outright,
// then ones the accounting says came back light. Never the whole statement.
function repairTargets(a, failures, total) {
  const t = new Set();
  for (const f of failures) t.add(f.chunk);
  for (const ci of a.comp.suspect_chunks) t.add(ci);
  // Nothing specific to point at, but money is missing: re-read everything only
  // when the statement is small enough that it is cheap to do so.
  if (!t.size && !a.rec.reconciled && total <= 3) for (let i = 0; i < total; i++) t.add(i);
  return [...t].sort((x, y) => x - y);
}

function describeGap(a) {
  const s = a.rec.sides || {};
  if (s.credits && !s.credits.ok) return `money in is short by ${Math.abs(s.credits.gap)}`;
  if (s.debits && !s.debits.ok) return `money out is short by ${Math.abs(s.debits.gap)}`;
  if (a.rec.envelope && !a.rec.envelope.ok) return `opening + net does not reach the printed closing`;
  if (a.comp.findings.length) return a.comp.findings[0];
  return "";
}

// What to tell the model on a re-read. Returns null when there is nothing
// specific to say — an honest "this statement prints no totals" must NOT be
// escalated into pressure to invent one. That is how a cumulative sum got
// returned as a running balance earlier today.
function repairInstruction(a, failures) {
  const lines = [];
  const s = a.rec.sides || {};
  if (s.credits && !s.credits.ok) lines.push(`This statement's own summary says money IN totals ${s.credits.printed}, but the rows returned so far add up to ${s.credits.extracted} — ${Math.abs(s.credits.gap)} of credits/payments has not been read. Look for a payments or credits section that was skipped.`);
  if (s.debits && !s.debits.ok) lines.push(`This statement's own summary says money OUT totals ${s.debits.printed}, but the rows returned so far add up to ${s.debits.extracted} — ${Math.abs(s.debits.gap)} of charges has not been read.`);
  for (const f of a.comp.chunks.filter((c) => c.short)) lines.push(`This part of the document has ${f.candidates} lines that look like transactions but only ${f.returned} came back. Read every one of them.`);
  for (const p of a.comp.coverage.problems || []) lines.push(`Coverage gap: ${p}. Transactions from that stretch are missing.`);
  if (failures.length) lines.push(`Some parts of this document failed to read at all and are being retried — return every transaction you can see in the text you are given.`);
  if (!lines.length) return null;
  lines.push(`Return the COMPLETE list of transactions you can see in the text below. Do not invent a row, a balance or a total to close a gap: if a transaction is not printed here, it is not yours to add, and reporting fewer rows honestly is correct.`);
  return lines.join("\n");
}

// How good was a run? The reconciler is the judge — it compares the extracted
// numbers against the statement's own printed running balance, so a better score
// is not an opinion.
export function scoreRun(result) {
  const rec = result?.reconciliation;
  return {
    rows: result?.transactions?.length || 0,
    reconciled: !!rec?.reconciled,
    breaks: rec?.continuity?.mismatches?.length || 0,
    checked: rec?.continuity?.checked || 0,
    envelope_ok: rec?.envelope ? !!rec.envelope.ok : null,
    with_balance: rec?.withBalance || 0,
    error: result?.error || null,
  };
}
