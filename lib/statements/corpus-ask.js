// Ask anything about all your statements — and get a correct answer.
//
// The rule that makes "correct" achievable: the model never produces a number.
// It only (a) turns your sentence into one of the fixed queries in
// corpus-query.js, and (b) reads the computed result back in plain words. Every
// figure in the answer is computed in JS from the stored rows and the
// reconciler's own arithmetic, and the exact query + data are always shown.
import { chatText, jsonFrom, gatewayConfigured } from "./gateway.js";
import { loadCorpus, runQuery, inventory, OPS, matchStatement } from "./corpus-query.js";

const inr = (n) => (n == null ? "—" : (n < 0 ? "−₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ── is this a question, or a report of something being wrong? ───────────────
const COMPLAINT = /\b(wrong|missing|skipp?(ed|ing)|duplicat|broken|isn'?t working|doesn'?t work|should (be|have)|instead of|fix|incorrect|bad|failed to|not picking|picks up|mis(read|reads|parsed))\b/i;
const QUESTION = /\b(what|which|how many|how much|why|when|where|who|show|list|tell me|is there|are there|do i|did i|can you tell)\b|\?\s*$/i;

export function routeIntent(text) {
  const t = String(text || "").trim();
  if (!t) return "question";
  const q = QUESTION.test(t), c = COMPLAINT.test(t);
  if (q && !c) return "question";
  if (c && !q) return "complaint";
  if (c && q) return "question"; // "why is X missing rows?" — answer first, then offer the fix
  return "question";
}

// ── plan: your sentence → one validated query ───────────────────────────────
const SCHEMA = `{
  "op": one of ${OPS.join(" | ")},
  "statement": "part of a statement's filename or its account"   // for explain_statement / narrowing
  "bank": "amex | federal | idbi | icici | …"
  "text": "merchant or keyword to match in a row's description"
  "account": "part of a ledger account, e.g. Expenses:Travel"
  "from": "YYYY-MM-DD", "to": "YYYY-MM-DD",
  "direction": "in" | "out",
  "min": number, "max": number,
  "by": "account" | "payee" | "month" | "statement" | "bank",   // for op=group
  "with_breaks": true, "unverified": true, "broken_only": true, "needs_review": true,
  "limit": number
}`;

const GUIDE = `op meanings:
- overview            how the whole set stands: how many statements, rows, how many reconcile, total balance breaks
- statements          list statements (add with_breaks / unverified / bank / from / to to narrow)
- breaks              the actual rows where the running balance doesn't chain
- explain_statement   one statement in depth — why it does or doesn't reconcile (needs "statement")
- coverage            per account: date range, months covered, GAPS in the months you hold
- duplicates          the same transaction appearing in more than one statement (double-import risk)
- transactions        list matching rows across all statements
- sum                 total in/out/net for a filter (use for "how much did I spend on X")
- group               totals grouped by account | payee | month | statement | bank
- top                 the biggest rows by amount
- needs_review        rows the classifier wasn't confident about

Examples:
"how are my statements doing" -> {"op":"overview"}
"which ones don't add up" -> {"op":"statements","unverified":true}
"why does the april statement have breaks" -> {"op":"explain_statement","statement":"2026-04"}
"what did I spend on swiggy" -> {"op":"sum","text":"swiggy","direction":"out"}
"biggest 10 expenses" -> {"op":"top","direction":"out","limit":10}
"spend by category" -> {"op":"group","by":"account","direction":"out"}
"am I missing any months" -> {"op":"coverage"}
"any duplicate transactions" -> {"op":"duplicates"}
"show the broken rows in the amex" -> {"op":"breaks","statement":"amex"}`;

export async function plan(question, corpus) {
  const raw = await chatText([
    { role: "system", content: `Turn a question about a set of parsed bank statements into ONE JSON query. Output ONLY the JSON object.\n\nSchema:\n${SCHEMA}\n\n${GUIDE}` },
    { role: "user", content: `STATEMENTS AVAILABLE:\n${inventory(corpus.statements)}\n\nQUESTION: ${question}` },
  ], { max_tokens: 300 });

  let q;
  try { q = jsonFrom(raw); } catch { q = { op: "overview" }; }
  // validate — never trust the shape
  const out = { op: OPS.includes(q.op) ? q.op : "overview" };
  for (const k of ["statement", "bank", "text", "account", "from", "to"]) if (typeof q[k] === "string" && q[k].trim()) out[k] = q[k].trim().slice(0, 80);
  if (q.direction === "in" || q.direction === "out") out.direction = q.direction;
  for (const k of ["min", "max", "limit"]) if (Number.isFinite(Number(q[k]))) out[k] = Number(q[k]);
  if (["account", "payee", "month", "statement", "bank"].includes(q.by)) out.by = q.by;
  for (const k of ["with_breaks", "unverified", "broken_only", "needs_review"]) if (q[k] === true) out[k] = true;
  // a statement reference that matches nothing would silently return nothing
  if (out.statement && !matchStatement(corpus.statements, out.statement)) {
    if (out.op === "explain_statement") out.unmatched_statement = out.statement;
    delete out.statement;
  }
  return out;
}

// ── render: the answer is written FROM the computed result ──────────────────
export function render(q, res, corpus) {
  const r = res.result;
  if (q.unmatched_statement) {
    return `I don't have a statement matching “${q.unmatched_statement}”. You have: ${corpus.statements.slice(0, 12).map((s) => s.name).join(", ")}${corpus.statements.length > 12 ? "…" : ""}`;
  }

  switch (res.op) {
    case "overview": {
      const gaps = r.span ? ` covering ${r.span.from} → ${r.span.to}` : "";
      return [
        `You have ${plural(r.statements, "statement")} with ${r.rows.toLocaleString("en-IN")} rows${gaps}, across ${plural(r.accounts.length, "account")}: ${r.accounts.join(", ")}.`,
        `Money in ${inr(r.inflow)}, out ${inr(r.outflow)}.`,
        `${r.reconciled} of ${r.statements} reconcile against their own printed balance. ${r.with_breaks} have balance breaks (${r.total_breaks} rows in total)${r.envelope_off ? `, and ${r.envelope_off} chain row-to-row but their opening + net ≠ closing (that means rows are missing)` : ""}${r.unverifiable ? `. ${r.unverifiable} carry no balance column at all, so they can't be auto-checked` : ""}.`,
        r.imported ? `${r.imported} already imported into the ledger.` : "None imported yet.",
      ].join("\n");
    }
    case "statements": {
      if (!res.matched) return "No statements match that.";
      return `${plural(res.matched, "statement")}:\n` + r.map((s) =>
        `• ${s.name} — ${s.account || "?"}, ${s.from || "?"} → ${s.to || "?"}, ${s.rows} rows, ${s.breaks ? `${s.breaks} breaks` : "no breaks"}${s.reconciled ? " ✓" : s.note ? ` (${s.note})` : ""}`).join("\n");
    }
    case "breaks": {
      if (!res.matched) return "No balance breaks — every row chains against its statement's printed running balance.";
      const head = `${res.matched} row${res.matched === 1 ? "" : "s"} break the running balance, across ${plural(r.statements.length, "statement")}:`;
      const per = r.statements.map((s) => `• ${s.name}: ${s.breaks} of ${s.rows} rows`).join("\n");
      const rows = r.rows.length ? `\n\nExamples:\n` + r.rows.map((b) =>
        `• ${b.statement} row ${b.row} — ${b.date} ${b.desc} ${inr(b.amount)}: after ${inr(b.prev_balance)} the balance should read ${inr(b.expected_balance)}, the statement prints ${inr(b.printed_balance)} (off by ${inr(b.off_by)})`).join("\n") : "";
      return `${head}\n${per}${rows}`;
    }
    case "explain_statement": {
      if (!r) return res.note || "I couldn't find that statement.";
      const lines = [
        `${r.name} — ${r.account || "?"} (${r.type || "bank"}), ${r.period.from || "?"} → ${r.period.to || "?"}, parsed by parser v${r.parser_version ?? "?"}${r.chunks > 1 ? ` in ${r.chunks} chunks` : ""}.`,
        `${r.rows} rows: in ${inr(r.inflow)}, out ${inr(r.outflow)}, net ${inr(r.net)}.`,
      ];
      if (r.error) lines.push(`It failed to parse: ${r.error}`);
      if (r.reconciled) lines.push(`It reconciles: all ${r.checked} checkable rows chain against the printed balance${r.envelope ? `, and opening + net = closing (${inr(r.envelope.printed_closing)})` : ""}.`);
      else {
        if (!r.verifiable) lines.push(`It can't be verified: ${r.note}`);
        if (r.breaks) lines.push(`${r.breaks} of ${r.rows} rows break the running balance — a wrong amount, a missing row, or a duplicated one.`);
        if (r.envelope && !r.envelope.ok) lines.push(`Rows chain row-to-row, but opening + net comes to ${inr(r.envelope.expected_closing)} while the statement closes at ${inr(r.envelope.printed_closing)} — a gap of ${inr((r.envelope.printed_closing - r.envelope.expected_closing))}, which usually means rows are missing rather than mis-read.`);
      }
      if (r.sample_breaks?.length) lines.push(`\nBreaking rows:\n` + r.sample_breaks.map((b) =>
        `• row ${b.row} — ${b.date} ${b.desc} ${inr(b.amount)}: expected ${inr(b.expected_balance)}, printed ${inr(b.printed_balance)} (off by ${inr(b.off_by)})`).join("\n"));
      return lines.join("\n");
    }
    case "coverage": {
      if (!r.length) return "No statements yet.";
      return r.map((c) => {
        const g = c.gaps.length ? ` — MISSING between ${c.gaps.map((x) => `${x.after} and ${x.before}`).join(", ")}` : " — no gaps";
        return `• ${c.account}: ${plural(c.statements, "statement")}, ${c.rows} rows, ${c.from} → ${c.to}, ${plural(c.months, "month")} covered${g}`;
      }).join("\n");
    }
    case "duplicates": {
      if (!res.matched) return "No transaction appears in more than one statement — nothing would be double-counted on import.";
      return `${plural(res.matched, "transaction")} appear in more than one statement (they'd double-count if you imported both):\n` +
        r.map((d) => `• ${d.date} ${d.desc} ${inr(d.amount)} — in ${d.statements.join(" and ")}`).join("\n");
    }
    case "sum": {
      const what = q.text ? `“${q.text}”` : q.direction === "in" ? "money in" : q.direction === "out" ? "money out" : "everything matched";
      if (!res.matched) return `Nothing matched ${what}.`;
      return `${what}: ${plural(r.count, "row")} across ${plural(r.statements, "statement")} — out ${inr(r.outflow)}, in ${inr(r.inflow)}, net ${inr(r.net)}.` +
        (res.sample?.length ? `\ne.g. ` + res.sample.map((s) => `${s.date} ${s.payee} ${inr(s.amount)} (${s.statement})`).join("; ") : "");
    }
    case "group": {
      if (!res.matched) return "Nothing matched.";
      return `By ${res.by}, ${plural(res.matched, "row")}:\n` + r.map((g) => `• ${g.key}: out ${inr(g.out)}, in ${inr(g.in)} (${g.count} rows)`).join("\n");
    }
    case "top": {
      if (!res.matched) return "Nothing matched.";
      return `Biggest of ${plural(res.matched, "matching row")}:\n` + r.map((x) =>
        `• ${x.date} ${x.payee} ${inr(x.amount)} → ${x.account} (${x.statement}${x.broken ? ", ⚠ balance break" : ""})`).join("\n");
    }
    case "needs_review": {
      if (!res.matched) return "Every row was classified confidently.";
      return `${plural(res.matched, "row")} the classifier wasn't sure about:\n` + r.map((x) =>
        `• ${x.date} ${x.payee} ${inr(x.amount)} → ${x.account} (${x.source}${x.confidence ? ` ${Math.round(x.confidence * 100)}%` : ""}, ${x.statement})`).join("\n");
    }
    default: {
      if (!res.matched) return "No rows matched.";
      return `${plural(res.matched, "row")}:\n` + r.map((x) =>
        `• ${x.date} ${x.payee} ${inr(x.amount)} → ${x.account} (${x.statement}${x.broken ? ", ⚠" : ""})`).join("\n");
    }
  }
}

// ── the whole answer ────────────────────────────────────────────────────────
export async function askCorpus(entity, question) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const corpus = await loadCorpus(entity);
  if (!corpus.statements.length) return { text: "You haven't parsed any statements yet — drop some in and ask again.", empty: true };

  const q = await plan(question, corpus);
  const res = runQuery(corpus, q);
  const facts = render(q, res, corpus);

  // Plain-words framing on top of the facts. It may only restate what's above —
  // and the facts are shown either way, so a bad paraphrase can't hide them.
  let narration = "";
  try {
    narration = (await chatText([
      { role: "system", content: "You are a careful bookkeeping assistant. In ONE or TWO short sentences, answer the user's question using ONLY the FACTS given. Never add, change or recompute a number. If the facts don't answer the question, say exactly what is missing." },
      { role: "user", content: `QUESTION: ${question}\n\nFACTS (computed, authoritative):\n${facts.slice(0, 4000)}` },
    ], { max_tokens: 200 })).trim();
  } catch { narration = ""; }

  return { question, query: q, result: res, facts, narration, text: narration ? `${narration}\n\n${facts}` : facts };
}
