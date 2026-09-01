// The host pipeline. It owns everything the sandboxed module must never touch —
// the gateway call, the stitching of chunk results, and the reconciliation that
// decides whether the output can be trusted.
//
//   module.preprocess → module.chunk → [gateway per chunk] → merge → module.postprocess → reconcile
import { chatText, jsonFrom, gatewayConfigured, gatewayModelLabel } from "../statements/gateway.js";
import { documentNumbers } from "../parser/gates.js";
import { reconcile } from "../statements/reconcile.js";
import { completeness } from "../statements/completeness.js";
import { crossCheck } from "../statements/crosscheck.js";
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

async function callModel({ prompt, text, filename, bank, period, isChunk, chunkIndex, chunkTotal, priorBalance, rules, hint, effort = null }) {
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
    { max_tokens: CHUNK_MAX_TOKENS, effort: effort || EXTRACT_EFFORT },
  );
  const { json, truncated } = extractJson(raw);
  try {
    return JSON.parse(json);
  } catch {
    if (truncated) throw new Error(`the model's reply was cut off mid-JSON (${raw.length} chars) — this chunk is too large for the current model. Ask the lab to make chunk() split smaller.`);
    throw new Error(`model returned non-JSON: ${String(raw).slice(0, 200)}`);
  }
}

export const MAX_REPAIR_ROUNDS = Number(process.env.MAX_REPAIR_ROUNDS || 5);
// EFFORT IS PART OF THE LADDER, not the default. Thinking on every chunk cost 68s
// a chunk against 4s without it — a 17x slowdown paid on chunk 3 of a statement
// where chunk 3 was always fine. Of 8 real statements, 6 were correct on the first
// pass with no thinking at all, and the 2 that were not failed on ONE row each,
// both of which the deterministic cross-check names for free. So: read fast, let
// the checks find the problems, then think hard about only those chunks.
const EXTRACT_EFFORT = process.env.EXTRACT_EFFORT || "low";
const EFFORT_LADDER = ["low", "high", "max"];
const nextEffort = (e) => EFFORT_LADDER[Math.min(EFFORT_LADDER.indexOf(e) + 1, EFFORT_LADDER.length - 1)];

// A single gateway call has to finish well inside the edge's total-request
// ceiling (~5 minutes; keep-alives beat the idle timeout, not this one). 16000
// tokens at this model's rate is minutes of generation on its own — and a page of
// statement is ~30 transactions, nowhere near that. A reply that still gets cut
// off triggers the halve-and-re-read path.
const CHUNK_MAX_TOKENS = Number(process.env.CHUNK_MAX_TOKENS || 8000);
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
async function runChunk({ base, text, ci, total, priorBalance, onNote, extra = "", effort = null }, depth = 0) {
  try {
    return await callChunk({ ...base, text, chunkIndex: ci, chunkTotal: total, priorBalance, effort, hint: [base.hint, extra].filter(Boolean).join("\n\n") }, onNote);
  } catch (e) {
    const parts = isTruncation(e) && depth < 2 ? halve(text) : null;
    if (!parts) throw e;
    await onNote?.(`part ${ci + 1}: the reply was cut off — splitting it and reading each half`);
    const merged = { transactions: [] };
    let prior = priorBalance;
    for (const part of parts) {
      const out = await runChunk({ base, text: part, ci, total, priorBalance: prior, onNote, extra, effort }, depth + 1);
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
export async function extractWithModule({ source, pages, text, filename = "", bank = "", period = null, rules = "", hint = "", onNote = null, repair = true }) {
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

  const runOne = async (ci, extra = "", effortOverride = null) => {
    const priorBalance = (() => {
      for (let j = ci - 1; j >= 0; j--) {
        const lb = [...(perChunk[j] || [])].reverse().find((t) => t?.balance != null)?.balance;
        if (lb != null) return lb;
      }
      return null;
    })();
    const out = await runChunk({ base, text: chunks[ci], ci, total: chunks.length, priorBalance, onNote, extra, effort: effortOverride });
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

  // Corrections accepted so far — deterministic edits the cross-check derived from
  // the document. Applied on every assess so a later round still sees them.
  const applied = [];
  const applyCorrections = (rows) => {
    let out = rows;
    for (const c of applied) {
      if (c.kind === "fix_amount") {
        let done = false;
        out = out.map((r) => {
          if (done || Math.abs(Math.abs(r.amount) - c.from) > 0.02) return r;
          done = true;
          return { ...r, amount: r.amount < 0 ? -c.to : c.to, corrected: c.why };
        });
      } else if (c.kind === "drop_row") {
        let done = false;
        out = out.filter((r) => {
          if (done || Math.abs(Math.abs(r.amount) - c.amount) > 0.02) return true;
          if (c.desc && !String(r.description || r.desc || "").toUpperCase().includes(String(c.desc).toUpperCase().slice(0, 12))) return true;
          done = true; return false;
        });
      }
    }
    return out;
  };

  // Build a full result from the current per-chunk rows and judge it.
  const assess = () => {
    const grounded = (v) => (v != null && printedNumbers.has(Math.abs(Number(v)).toFixed(2)) ? v : null);
    const m = { ...meta };
    const droppedTotals = [];
    for (const k of ["total_credits", "total_debits", "opening_balance", "closing_balance"]) {
      if (m[k] != null && grounded(m[k]) == null) { droppedTotals.push(k); m[k] = null; }
    }
    const flat = applyCorrections(perChunk.flatMap((r) => r || []));
    const rows = mod.postprocess(flat, { ...ctx, ...m });
    const rec = reconcile(rows, {
      statement_type: m.statement_type, opening_balance: m.opening_balance, closing_balance: m.closing_balance,
      total_credits: m.total_credits, total_debits: m.total_debits,
    });
    const comp = completeness({
      rows, chunkTexts: chunks, rowsPerChunk: perChunk.map((r) => (r || []).length), period: m.period || period,
    });
    // A second, deterministic opinion on the same document. It re-reads the source
    // itself and says which SPECIFIC line disagrees with the extraction — the
    // difference between "1762.93 is missing" and "the April 4 LOVABLE line prints
    // 20 and 1782.93 and you took 20".
    let cross = null;
    try {
      cross = crossCheck({
        pages: Array.isArray(pages) && pages.length ? pages : [rawText],
        rows, printed: { total_credits: m.total_credits, total_debits: m.total_debits },
      });
    } catch { cross = null; } // a cross-check must never break an extraction
    return { meta: m, droppedTotals, rows, rec, comp, cross, counts: perChunk.map((r) => (r || []).length) };
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

  // ---- repair ----------------------------------------------------------
  // A ladder, cheapest remedy first, and every rung is proved by the reconciler
  // rather than trusted:
  //   1. apply a deterministic correction the cross-check derived from the
  //      document — no model call at all
  //   2. re-read only the chunks there is evidence against
  //   3. escalate effort rather than repeat the same request
  // A round that doesn't improve is discarded and the loop stops: five rounds of
  // no progress is five rounds of spend.
  let rounds = 1;
  const saidBefore = new Set();
  let effort = EXTRACT_EFFORT;

  for (let round = 1; repair && round <= MAX_REPAIR_ROUNDS && !(best.rec.reconciled && best.comp.complete); round++) {
    // 1. free remedies first.
    const fresh = (best.cross?.corrections || []).filter(
      (c) => !applied.some((a) => a.kind === c.kind && Math.abs((a.amount ?? a.from ?? 0) - (c.amount ?? c.from ?? 0)) < 0.02));
    if (fresh.length) {
      const before = applied.length;
      applied.push(...fresh);
      const candidate = assess();
      rounds = round + 1;
      if (cost(candidate) < cost(best)) {
        best = candidate;
        await onNote?.(`applied ${fresh.length} correction(s) from the document itself: ${fresh[0].why}`);
        continue; // that cost nothing; see where it leaves us
      }
      applied.length = before; // proved nothing — take it back
      await onNote?.("a correction from the document didn't improve the arithmetic — reverted");
    }

    // 2. targeted re-read.
    const targets = repairTargets(best, failures, chunks.length);
    if (!targets.length && best.cross?.findings?.length && chunks.length <= 12) {
      for (let i = 0; i < chunks.length; i++) targets.push(i);
    }
    if (!targets.length) break;
    const instruction = repairInstruction(best, failures);
    if (!instruction) break;

    // 3. a re-read is where thinking earns its cost — the first pass was cheap on
    //    purpose. Escalate every round, and never send the same request twice.
    const key = `${instruction}::${targets.join(",")}`;
    const repeated = saidBefore.has(key);
    if (repeated && effort === "max") { await onNote?.("nothing further to try — leaving it flagged for review"); break; }
    effort = nextEffort(effort);
    await onNote?.(repeated
      ? `same request as last time — thinking harder (effort ${effort}) instead of repeating it`
      : `re-reading with more care (effort ${effort})`);
    saidBefore.add(key);

    await onNote?.(`${describeGap(best)} — re-reading part${targets.length > 1 ? "s" : ""} ${targets.map((t) => t + 1).join(", ")}`);
    const snapshot = perChunk.map((r) => (r ? [...r] : r));
    for (const ci of targets) {
      try { perChunk[ci] = await runOne(ci, instruction, effort); } catch (e) {
        perChunk[ci] = snapshot[ci] || [];
        await onNote?.(`part ${ci + 1}: still could not be read (${String(e.message || e).slice(0, 90)})`);
      }
    }
    const candidate = assess();
    rounds = round + 1;
    if (cost(candidate) < cost(best)) {
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
    crosscheck: best.cross ? { findings: best.cross.findings, source_complete: best.cross.source_complete, inconclusive: !!best.cross.inconclusive } : null,
    corrections_applied: applied.length ? applied : null,
    transactions: best.rows, reconciliation: best.rec,
  };
}

// Which chunks are worth re-reading, in priority order: ones that failed outright,
// ones the accounting says came back light, and — on a statement with a running
// balance — the chunk holding a row that doesn't chain. Never the whole statement.
//
// That last one was missing, and it is the only signal a BANK statement gives:
// IDBI came back with 2 breaks out of 174 rows and no repair round ran at all,
// because a continuity break was never mapped to a chunk. The mismatch carries a
// row index and the chunks report their row counts, so the arithmetic is trivial.
function chunkOfRow(counts, index) {
  let seen = 0;
  for (let ci = 0; ci < counts.length; ci++) {
    if (index < seen + counts[ci]) return ci;
    seen += counts[ci];
  }
  return counts.length - 1;
}

function repairTargets(a, failures, total) {
  const t = new Set();
  for (const f of failures) t.add(f.chunk);
  for (const ci of a.comp.suspect_chunks) t.add(ci);
  for (const m of (a.rec.continuity?.mismatches || []).slice(0, 8)) {
    if (Number.isInteger(m.index) && Array.isArray(a.counts)) t.add(chunkOfRow(a.counts, m.index));
  }
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
  const m = (a.rec.continuity?.mismatches || [])[0];
  if (m) return `${a.rec.continuity.mismatches.length} row(s) don't chain (first: ${m.date}, off by ${m.off_by})`;
  return "";
}

// What to tell the model on a re-read. Returns null when there is nothing
// specific to say — an honest "this statement prints no totals" must NOT be
// escalated into pressure to invent one. That is how a cumulative sum got
// returned as a running balance earlier today.
function repairInstruction(a, failures) {
  const lines = [];
  // Named lines first: a specific row to fix beats a total to hunt for.
  for (const f of (a.cross?.findings || []).slice(0, 8)) lines.push(f);
  const s = a.rec.sides || {};
  for (const [side, noun, hunt] of [["credits", "money IN (payments/credits)", "a payments or credits section that was skipped"],
                                    ["debits", "money OUT (charges)", "a charges section that was skipped"]]) {
    const x = s[side];
    if (!x || x.ok) continue;
    lines.push(x.gap > 0
      ? `This statement's own summary says ${noun} totals ${x.printed}, but the rows returned so far add up to only ${x.extracted} — ${x.gap} has not been read. Look for ${hunt}.`
      : `This statement's own summary says ${noun} totals ${x.printed}, but the rows returned so far add up to ${x.extracted} — that is ${-x.gap} MORE than the statement says exists. Something is being counted twice: a line that also appears in a summary or totals block, or one transaction returned as two rows. Do not add anything; find the duplicate and return it once.`);
  }
  for (const f of a.comp.chunks.filter((c) => c.short)) lines.push(`This part of the document has ${f.candidates} lines that look like transactions but only ${f.returned} came back. Read every one of them.`);
  for (const p of a.comp.coverage.problems || []) lines.push(`Coverage gap: ${p}. Transactions from that stretch are missing.`);
  for (const m of (a.rec.continuity?.mismatches || []).slice(0, 5)) {
    lines.push(`The row dated ${m.date} "${m.desc}" does not chain: with a previous balance of ${m.prev_balance} and an amount of ${m.amount} the running balance should read ${m.expected_balance}, but the statement prints ${m.printed_balance} (off by ${m.off_by}). Re-read that row and the ones around it — either its amount is wrong, its sign is wrong, or a row just before it was skipped.`);
  }
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
