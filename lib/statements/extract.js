// Frontier-model statement extraction. The model STRUCTURES pdf.js text into
// transactions; it never OCRs pixels or does math — every number is copied from
// the provided text. lib/reconcile.js then proves the result against the running
// balance. Large statements are chunked by page-range and stitched (the running
// balance chains across the seam), so a 45-page / 1300-row statement never blows
// the output-token budget.
import { reconcile } from "./reconcile.js";

// Routes through the aikaara gateway in "managed" mode (aikaara-as-OpenRouter):
// OpenAI-compatible, auth is the tenant X-Api-Key, and NO provider key is sent —
// so the gateway uses whatever LLM is configured in that tenant's dashboard
// account. No LLM/provider key ever lives in finops.
//   AIKAARA_GATEWAY_URL  e.g. https://api.aikaara.com/gateway/v1
//   AIKAARA_GATEWAY_KEY  a dashboard routing-client key (grk_…) or the tenant X-Api-Key
//                        (AIKAARA_TENANT_KEY is still accepted as an alias)
//   EXTRACT_MODEL        optional; empty → the gateway uses the tenant default model
const GATEWAY_URL = (process.env.AIKAARA_GATEWAY_URL || "").replace(/\/+$/, "");
const TENANT_KEY = process.env.AIKAARA_GATEWAY_KEY || process.env.AIKAARA_TENANT_KEY || "";
const DEFAULT_MODEL = process.env.EXTRACT_MODEL || "";
// Bound each gateway call so its generation finishes under the gateway's ~30s
// edge timeout (DO App Platform ingress). ~4500 chars of statement text is
// roughly 60-90 transactions per call → well under the limit with margin.
const MAX_CHUNK_CHARS = 4500;

export function extractConfigured() {
  return !!(GATEWAY_URL && TENANT_KEY);
}

export const EXTRACT_PROMPT = `You convert a bank OR credit-card statement into structured transactions.
You are given the RAW TEXT already extracted from the PDF, so every number is
exact — COPY numbers character-for-character; never round, re-compute, or invent
one. Return STRICT JSON only, no prose, no markdown fences.

SIGN CONVENTION (unify everything to this): "amount" is signed cashflow for the account holder.
  negative = money OUT  (debit, withdrawal, purchase, card charge, EMI, fee)
  positive = money IN   (deposit, salary, refund, interest, cashback, payment received)
Determine the sign from whichever the statement uses:
  - Separate Debit/Withdrawal vs Credit/Deposit columns -> debit negative, credit positive.
  - A single UNSIGNED "Amount" + a running "Balance" -> use the balance movement:
      bank account: balance DOWN vs the previous row -> negative; UP -> positive.
      credit card:  outstanding UP -> negative (a charge); DOWN -> positive (payment/refund).
  - A signed amount, Dr/Cr suffix, trailing CR/DR, parentheses or minus -> honor it.

DATES -> ISO YYYY-MM-DD.
  - If a row's date has no year ("01 Sep", "01-Apr"), infer it from the PERIOD given below;
    handle a period crossing a year boundary (Sep-Dec = first year, Jan-Mar = next).
  - If the date is printed once as a header for several rows below it, carry it forward
    until the next date header.
  - Disambiguate DD/MM vs MM/DD using the currency/country and the period.

DESCRIPTIONS: merge wrapped/multi-line narrations into one clean string; keep the
merchant/counterparty + reference; strip repeated dates and column headers.

SKIP non-transactions: page headers/footers, column headers, Opening/Closing Balance,
B/F, C/F, carried-forward, sub-totals, totals, interest-summary boxes, page numbers, ads.

NUMBERS: handle Indian grouping (1,15,02,632.61) and international; drop currency symbols
and thousands separators; keep decimals. Foreign-currency card lines: use the INR (home)
amount for "amount"; note the original currency+amount in "description".

Output EXACTLY this JSON shape:
{
  "statement_type": "bank" | "card",
  "currency": "INR",
  "period": {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} | null,
  "opening_balance": <number|null>,
  "closing_balance": <number|null>,
  "transactions": [
    {"date":"YYYY-MM-DD","description":"...","amount": -182.00, "balance": 19544.18}
  ]
}
Every transaction gets its own object, in statement order. "balance" = the running
balance printed on that row (null if there is no balance column). Return ONLY the JSON.`;

// Pull a JSON object out of a messy model response: strip markdown fences (even
// when the closing ``` is missing on a truncated reply), drop known reasoning/
// safety wrappers, then scan from the first "{" to its BALANCE-AWARE matching
// "}" (ignoring braces inside strings) so trailing prose can't corrupt it.
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
  return { json: t.slice(start), truncated: true }; // never balanced → response was cut off
}

async function callModel({ text, filename, bank, period, isChunk, chunkIndex, chunkTotal, priorBalance, rules = "", hint = "" }) {
  const hints = [
    filename && `Filename: ${filename}`,
    bank && `Likely bank/card: ${bank}`,
    period && `Statement period: ${period.from || "?"} to ${period.to || "?"}`,
    isChunk && `This is page-chunk ${chunkIndex + 1} of ${chunkTotal}. Continue the same statement; the running balance immediately BEFORE this chunk's first transaction is ${priorBalance ?? "unknown"}.`,
  ].filter(Boolean).join("\n");
  const user = `${hints}\n\nSTATEMENT TEXT:\n"""\n${text}\n"""`;

  let system = EXTRACT_PROMPT;
  if (rules && rules.trim()) system += `\n\nOPERATOR RULES FOR THIS ACCOUNT — apply these; they override the defaults above when they conflict:\n${rules.trim()}`;
  // A one-off hint for THIS statement (e.g. "the last page has 4 more rows",
  // "the second amount column is USD — use the INR one"). Highest priority.
  if (hint && hint.trim()) system += `\n\nINSTRUCTIONS FROM THE USER FOR THIS PARTICULAR STATEMENT — follow these first; they override everything above when they conflict:\n${hint.trim()}`;
  const body = {
    model: DEFAULT_MODEL || "default", // "default" → gateway falls back to the tenant's default provider/model
    max_tokens: 16000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { "X-Api-Key": TENANT_KEY, "content-type": "application/json" }, // NO Authorization → managed mode
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const { json, truncated } = extractJson(raw);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    if (truncated) throw new Error(`the model's reply was cut off mid-JSON (${raw.length} chars) — this statement is too large for the current model in one pass. Route the finops-extractor client to a stronger model, or split the statement.`);
    throw new Error(`model returned non-JSON: ${String(raw).slice(0, 200)}`);
  }
  return parsed;
}

// pages: string[] (one entry per PDF page). Falls back to a single chunk if given text.
export async function extractStatement({ pages, text, filename = "", bank = "", period = null, rules = "", hint = "" } = {}) {
  if (!extractConfigured()) return { error: "extract_not_configured" };
  const pageList = Array.isArray(pages) && pages.length ? pages : [String(text || "")];

  // Split the statement into <=MAX_CHUNK_CHARS windows on line boundaries so each
  // gateway call generates a bounded number of transactions and finishes under the
  // ~30s edge timeout — even when all transactions sit on one dense page (page
  // count alone can't split that). A compact header (period + opening balance,
  // first lines of page 0) is prefixed to continuation chunks so year-less dates
  // and the running balance stay resolvable across the split.
  const lines = pageList.join("\n").split(/\r?\n/);
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    if (buf && buf.length + line.length + 1 > MAX_CHUNK_CHARS) {
      chunks.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf.trim()) chunks.push(buf);
  if (!chunks.length) chunks.push(pageList.join("\n"));

  let meta = null;
  const all = [];
  let priorBalance = null;
  // The period (for year-less dates) and priorBalance (for the running-balance
  // sign) travel to continuation chunks as HINTS — never by re-prefixing page-0
  // text, which would re-feed early transactions and duplicate them.
  let effectivePeriod = period;
  for (let ci = 0; ci < chunks.length; ci++) {
    const out = await callModel({
      text: chunks[ci], filename, bank, period: effectivePeriod,
      isChunk: chunks.length > 1, chunkIndex: ci, chunkTotal: chunks.length, priorBalance, rules, hint,
    });
    if (ci === 0) {
      meta = { statement_type: out.statement_type || "bank", currency: out.currency || "INR", period: out.period || period, opening_balance: out.opening_balance ?? null, closing_balance: out.closing_balance ?? null };
      effectivePeriod = meta.period || period; // carry the extracted period forward
    }
    const txns = Array.isArray(out.transactions) ? out.transactions : [];
    all.push(...txns);
    const lastBal = [...txns].reverse().find((t) => t.balance != null)?.balance;
    if (lastBal != null) priorBalance = lastBal;
    if (out.closing_balance != null) meta.closing_balance = out.closing_balance; // last chunk's closing wins
  }

  const rec = reconcile(all, { statement_type: meta.statement_type, opening_balance: meta.opening_balance, closing_balance: meta.closing_balance });
  return { ...meta, model: DEFAULT_MODEL || "gateway-default", chunks: chunks.length, transactions: all, reconciliation: rec };
}
