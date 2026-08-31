// Write a parser for THIS document, run it, check it, fix it.
//
// The old approach asked the model to BE the parser — to read five thousand
// numbers and retype them. That is the one thing language models are bad at, and
// it showed: 5,560 rows transcribed, 1,823 of them failing the balance check, and
// one 1,364-row statement costing 67 model calls.
//
// Here the model writes ~40 lines of CODE instead. The code does the
// transcription, so no digit ever passes through a model; the result is
// deterministic; and the cost stops scaling with the size of the statement. The
// reconciler is an objective grader, so the loop closes by itself:
//
//   look at the layout → write a parser → run it → reconcile
//     → still broken? hand back the failures and its own code → try again
//
// A parser that works is cached against the layout's fingerprint, so the next
// statement from that bank costs nothing at all.
import { chatText, gatewayConfigured } from "../statements/gateway.js";
import { acceptable, attemptCost } from "./gates.js";
import { compileParser, PARSER_CONTRACT, ModuleError } from "../extractor/sandbox.js";
import { reconcile } from "../statements/reconcile.js";

export const MAX_ROUNDS = 3;
const SAMPLE_LINES = 90;
const SAMPLE_CHARS = 9000;

// What the model looks at: the top of the statement with its column spacing
// intact, plus a ruler so it can name character offsets exactly.
export function layoutSample(pages) {
  const lines = pages.join("\n").split(/\r?\n/).filter((l) => l.trim());
  const head = lines.slice(0, SAMPLE_LINES);
  const width = Math.min(140, Math.max(...head.map((l) => l.length), 60));
  const ruler = Array.from({ length: Math.ceil(width / 10) }, (_, i) => String(i * 10).padEnd(10, " ")).join("");
  const tens = "    .    |".repeat(Math.ceil(width / 10));
  return `${ruler}\n${tens}\n${head.join("\n")}`.slice(0, SAMPLE_CHARS + 400);
}

// A stable identity for "statements that look like this one", so a parser can be
// reused. Built from the bank plus the shape of the header/column layout — not
// from the dates or amounts, which change every month.
export function fingerprint(pages, bank = "") {
  const lines = pages.join("\n").split(/\r?\n/).filter((l) => l.trim()).slice(0, 40);
  const shape = lines
    .map((l) => l.replace(/\d/g, "9").replace(/[A-Za-z]+/g, "A").replace(/\s{2,}/g, "  ").trim())
    .filter((l) => l.length > 8)
    .slice(0, 12)
    .join("|");
  let h = 0;
  for (let i = 0; i < shape.length; i++) { h = (h * 31 + shape.charCodeAt(i)) | 0; }
  return `${(bank || "unknown").toLowerCase()}:${(h >>> 0).toString(36)}`;
}

function scoreOf(parsed, rec) {
  const t = parsed.transactions;
  return {
    rows: t.length,
    breaks: rec.continuity?.mismatches?.length || 0,
    reconciled: !!rec.reconciled,
    verifiable: !!rec.verifiable,
    checked: rec.continuity?.checked || 0,
    envelope_ok: rec.envelope ? !!rec.envelope.ok : null,
    // A row whose amount is 0, or that carries no balance, is a row the
    // reconciler CANNOT check — so "0 breaks" says nothing about it. These are
    // where a wrapped narration or a missed column quietly loses money.
    zero_amounts: t.filter((x) => x.amount === 0).length,
    no_balance: t.filter((x) => x.balance == null).length,
    note: rec.note || "",
  };
}

const cleanSource = (t) => {
  let s = String(t || "").trim().replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const i = s.indexOf("({");
  return (i > 0 ? s.slice(i) : s).trim();
};

function authorMessages({ sample, filename, bank, previous, failure }) {
  const msgs = [
    { role: "system", content: `You write a small JavaScript parser for ONE bank or credit-card statement layout.

${PARSER_CONTRACT}

The text you are shown came from the PDF with its spacing preserved, so COLUMNS
ARE CHARACTER OFFSETS. A ruler is printed above the sample. Find the header row,
note where each column starts and ends, and slice by those offsets — that is far
more reliable than regex over the whole line, because descriptions contain digits
and spaces.

Rules that decide whether your parser is accepted:
- Every amount must be SIGNED cashflow: negative = money out (withdrawal, debit,
  purchase, charge, fee), positive = money in (deposit, credit, salary, refund).
  Separate Withdrawal/Deposit columns make this trivial — use which column the
  number sits in. For a credit card, a charge is negative.
- "balance" is the running balance printed on that row, or null.
- Dates → "YYYY-MM-DD". Infer the year from the statement period when a row shows
  only day+month, and handle a period crossing a year boundary. If a date is
  printed once as a header for the rows beneath it, carry it forward.
- Join wrapped description lines onto the row they belong to.
- SKIP anything that is not a transaction: page headers/footers, column headers,
  opening/closing balance lines, carried-forward, sub-totals, summary and rewards
  boxes, page numbers, marketing.
- Handle Indian digit grouping (1,15,02,632.61) and strip currency symbols.

Your parser is checked automatically against the statement's OWN printed running
balance: for a bank, balance[i] must equal balance[i-1] + amount[i]; for a card,
outstanding[i] must equal outstanding[i-1] - amount[i]. Rows that fail are
"balance breaks". Aim for zero.

Write for the WHOLE document, not just the sample — it continues in the same
format for many more pages. Be defensive: skip a line you cannot read rather
than throwing.

Reply with ONLY the parser: one parenthesised JavaScript object expression. No
markdown fences, no commentary.` },
    { role: "user", content: `FILE: ${filename}${bank ? ` (looks like ${bank})` : ""}\n\nFIRST LINES OF THE DOCUMENT, SPACING PRESERVED:\n${sample}` },
  ];
  if (previous && failure) {
    msgs.push({ role: "assistant", content: previous });
    msgs.push({ role: "user", content: `That parser ran but the result does not hold up:\n\n${failure}\n\nFix it. Look again at the column offsets in the sample above — a wrong slice boundary, a missed sign, a skipped row, or a duplicated one is the usual cause. Reply with only the corrected parser.` });
  }
  return msgs;
}

// Describe a failure the way a person would, so the next attempt is targeted.
function failureReport(parsed, rec) {
  const m = rec.continuity?.mismatches || [];
  const t = parsed.transactions;
  const zeros = t.map((x, i) => ({ ...x, i })).filter((x) => x.amount === 0);
  const noBal = t.filter((x) => x.balance == null).length;
  const lines = [`${t.length} rows extracted, ${m.length} of them break the running balance.`];
  if (zeros.length) {
    lines.push(`${zeros.length} row(s) came out with amount 0 — that means the amount column was not read for them. This is the most likely place money is being lost. Examples: ${zeros.slice(0, 3).map((z) => `row ${z.i + 1} "${String(z.description).slice(0, 40)}"`).join("; ")}. A wrapped description that continues on the next line, with the amount on the SECOND line, is the usual cause — join the lines before reading the columns.`);
  }
  if (noBal) lines.push(`${noBal} row(s) have no running balance, so they cannot be checked at all — make sure the balance column offset is right.`);
  if (rec.envelope && !rec.envelope.ok) {
    lines.push(`Opening + net comes to ${rec.envelope.expected_closing} but the statement closes at ${rec.envelope.printed_closing} — a gap of ${Math.round((rec.envelope.printed_closing - rec.envelope.expected_closing) * 100) / 100}. That gap usually means a row is MISSING or an amount was not read.`);
  }
  if (!rec.verifiable) {
    lines.push(`NOTHING COULD BE CHECKED: ${rec.note}. Not one row carried a balance and no opening/closing figure was returned, so there is no way to tell whether any amount is right. Almost every statement prints a running balance column, an opening balance, or a closing balance somewhere — find it. Put the running balance on each row as \`balance\`, and set \`opening_balance\`/\`closing_balance\` from the summary lines if the rows themselves have no balance column. This matters more than anything else below: without it the parse cannot be trusted at all.`);
  }
  for (const b of m.slice(0, 6)) {
    lines.push(`• row ${b.index + 1} (${b.date}) "${b.desc}": amount ${b.amount}, previous balance ${b.prev_balance}, so the balance should read ${b.expected_balance} — but the statement prints ${b.printed_balance} (off by ${b.off_by}). Either the amount is wrong, its sign is wrong, or a row is missing just before this one.`);
  }
  if (m.length > 6) lines.push(`…and ${m.length - 6} more like that.`);
  return lines.join("\n");
}

// The loop. `onStep` reports progress so the UI can show the work as it happens.
export async function generateParser({ pages, filename = "", bank = "", cached = null, onStep = async () => {} }) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const sample = layoutSample(pages);

  // A parser that already worked on this layout costs nothing to reuse.
  if (cached) {
    await onStep("reuse", `Reusing the parser I wrote for this layout${cached.label ? ` (${cached.label})` : ""} — no model call needed.`);
    try {
      const parsed = compileParser(cached.source)(pages);
      const rec = reconcile(parsed.transactions, { statement_type: parsed.statement_type, opening_balance: parsed.opening_balance, closing_balance: parsed.closing_balance });
      const score = scoreOf(parsed, rec);
      await onStep("ran", `${score.rows} rows, ${score.breaks} balance breaks.`, score);
      if (acceptable(score)) return { source: cached.source, parsed, rec, score, rounds: 0, reused: true };
      await onStep("note", "The cached parser doesn't hold up on this one — writing a fresh parser for it.");
    } catch (e) {
      await onStep("note", `The cached parser failed on this document (${String(e.message || e).slice(0, 120)}) — writing a fresh one.`);
    }
  }

  let previous = null, failure = null, best = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    await onStep("thinking", round === 1 ? "Reading the layout and writing a parser for it…" : `Revising the parser (attempt ${round})…`);
    let source, run;
    try {
      source = cleanSource(await chatText(authorMessages({ sample, filename, bank, previous, failure }), { max_tokens: 4000 }));
      run = compileParser(source);
    } catch (e) {
      failure = e instanceof ModuleError ? e.message : String(e.message || e);
      previous = source || previous;
      await onStep("error", `That parser wouldn't run: ${failure}`);
      continue;
    }
    await onStep("code", "Wrote a parser for this layout.", { source });

    let parsed;
    try {
      parsed = run(pages);
    } catch (e) {
      failure = String(e.message || e);
      previous = source;
      await onStep("error", `It threw while parsing: ${failure}`);
      continue;
    }

    const rec = reconcile(parsed.transactions, { statement_type: parsed.statement_type, opening_balance: parsed.opening_balance, closing_balance: parsed.closing_balance });
    const score = scoreOf(parsed, rec);
    await onStep("ran", `Ran it: ${score.rows} rows, ${score.breaks} balance breaks${score.reconciled ? " — reconciles ✓" : ""}.`, score);

    const candidate = { source, parsed, rec, score, rounds: round };
    const cost = (x) => attemptCost(x.score);
    if (!best || cost(candidate) < cost(best) || (cost(candidate) === cost(best) && score.rows > best.score.rows)) best = candidate;
    if (acceptable(score)) return candidate;

    failure = failureReport(parsed, rec);
    previous = source;
    if (round < MAX_ROUNDS) await onStep("note", `${score.breaks} rows still don't chain — telling it exactly which ones and trying again.`);
  }

  if (!best) throw new Error("could not produce a working parser for this layout");
  await onStep("note", `Keeping the best of ${MAX_ROUNDS} attempts: ${best.score.rows} rows, ${best.score.breaks} breaks.`);
  return best;
}
