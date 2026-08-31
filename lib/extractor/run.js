// The host pipeline. It owns everything the sandboxed module must never touch —
// the gateway call, the stitching of chunk results, and the reconciliation that
// decides whether the output can be trusted.
//
//   module.preprocess → module.chunk → [gateway per chunk] → merge → module.postprocess → reconcile
import { chatText, jsonFrom, gatewayConfigured, gatewayModelLabel } from "../statements/gateway.js";
import { documentNumbers } from "../parser/gates.js";
import { reconcile } from "../statements/reconcile.js";
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

// Extract with a specific module SOURCE. Used both by the live path (active
// version) and by the lab (a candidate under evaluation).
export async function extractWithModule({ source, pages, text, filename = "", bank = "", period = null, rules = "", hint = "" }) {
  if (!gatewayConfigured()) return { error: "extract_not_configured" };
  const mod = compileModule(source); // throws ModuleError — the lab reads that message

  const rawText = Array.isArray(pages) && pages.length ? pages.join("\n") : String(text || "");
  const ctx = { filename, bank, rules, hint, period };
  const cleaned = mod.preprocess(rawText, ctx);
  const chunks = mod.chunk(cleaned, ctx);

  let meta = null;
  const all = [];
  let priorBalance = null;
  let effectivePeriod = period;
  for (let ci = 0; ci < chunks.length; ci++) {
    const out = await callModel({
      prompt: mod.prompt, text: chunks[ci], filename, bank, period: effectivePeriod,
      isChunk: chunks.length > 1, chunkIndex: ci, chunkTotal: chunks.length, priorBalance, rules, hint,
    });
    if (ci === 0) {
      meta = {
        statement_type: out.statement_type || "bank", currency: out.currency || "INR",
        period: out.period || period, opening_balance: out.opening_balance ?? null, closing_balance: out.closing_balance ?? null,
        total_credits: out.total_credits ?? null, total_debits: out.total_debits ?? null,
      };
      effectivePeriod = meta.period || period;
    }
    // The summary box usually sits on page 1, but not always — take the totals from
    // whichever chunk reports them, without letting a later chunk clobber a value.
    if (meta.total_credits == null && out.total_credits != null) meta.total_credits = out.total_credits;
    if (meta.total_debits == null && out.total_debits != null) meta.total_debits = out.total_debits;
    if (meta.opening_balance == null && out.opening_balance != null) meta.opening_balance = out.opening_balance;
    const txns = Array.isArray(out.transactions) ? out.transactions : [];
    all.push(...txns);
    const lastBal = [...txns].reverse().find((t) => t?.balance != null)?.balance;
    if (lastBal != null) priorBalance = lastBal;
    if (out.closing_balance != null) meta.closing_balance = out.closing_balance;
  }
  meta = meta || { statement_type: "bank", currency: "INR", period, opening_balance: null, closing_balance: null };

  // A total the model COMPUTED instead of read is worthless as a check — it is
  // derived from the very rows it is supposed to verify. Keep only figures that
  // actually appear in the document. (Same rule as the codegen path's balances.)
  const printedNumbers = documentNumbers(rawText);
  const grounded = (v) => (v != null && printedNumbers.has(Math.abs(Number(v)).toFixed(2)) ? v : null);
  const droppedTotals = [];
  for (const k of ["total_credits", "total_debits", "opening_balance", "closing_balance"]) {
    if (meta[k] != null && grounded(meta[k]) == null) { droppedTotals.push(k); meta[k] = null; }
  }

  const finalCtx = { ...ctx, ...meta };
  const rows = mod.postprocess(all, finalCtx);
  const rec = reconcile(rows, {
    statement_type: meta.statement_type,
    opening_balance: meta.opening_balance, closing_balance: meta.closing_balance,
    total_credits: meta.total_credits, total_debits: meta.total_debits,
  });
  return { ...meta, model: gatewayModelLabel(), chunks: chunks.length, dropped_totals: droppedTotals, transactions: rows, reconciliation: rec };
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
