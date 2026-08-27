// "Ask about this statement" — grounded Q&A over parsed rows.
//
// The on-device model is only trusted with two things it does well:
//   1. a small multiple-choice question ("what kind of question is this?")
//   2. narrating an already-computed result in plain words.
// Everything numeric is deterministic: keywords are matched against the rows'
// own vocabulary, direction/limits come from the wording, query.js computes.
import { runQuery, summary, inr } from "./query.js";
import { pickOption } from "./classify.js";

const INTENTS = [
  ["total for a keyword or merchant", "sum"],
  ["the biggest items", "top"],
  ["breakdown by category", "group_account"],
  ["breakdown by merchant", "group_payee"],
  ["list the matching lines", "list"],
  ["money that came in", "in"],
  ["money that went out", "out"],
  ["lines that need review", "low_confidence"],
  ["an overview of the statement", "summary"],
  ["why a line got its category", "explain"],
];

const STOP = new Set(("what did i spend on how much total for the a an in of to my me is are was were were did do does this that statement month rows row line lines show list all any about from with and or by biggest largest top most least smallest which who where when why you your unsure sure need needs review came went out into paid pay payment received get got give given amount amounts number count many much sum spent spend spending expense expenses income inflow outflow outflows inflows category categories merchant merchants payee payees account accounts breakdown explain please tell").split(/\s+/));

// Match question words against the rows' payees/descriptions (grounded keyword).
export function keywordFor(question, rows) {
  const words = question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const vocab = rows.map((r) => `${r.payee || ""} ${r.desc || ""}`.toLowerCase());
  for (const w of words) if (vocab.some((v) => v.includes(w))) return w;
  return null;
}

export function directionFor(question, intent) {
  // the wording wins over the model's intent pick
  if (/\b(came in|received|income|credits?|inflows?|earn(ed|ings)?|got)\b/i.test(question)) return "in";
  if (/\b(spen[dt]|spending|paid|pay|outflows?|expenses?|debits?|costs?|bought|charges?)\b/i.test(question)) return "out";
  if (intent === "in") return "in";
  if (intent === "out") return "out";
  return undefined;
}

export function limitFor(question) {
  const m = question.match(/\b(\d{1,2})\b/);
  return m ? Number(m[1]) : undefined;
}

// gen(messages, maxTokens) → Promise<string>
// Obvious phrasings resolve without the model; the rest is a multiple-choice ask.
export function obviousIntent(q) {
  if (/\b(unsure|not sure|uncertain|confiden|needs? review|doubt)/i.test(q)) return "low_confidence";
  if (/\b(overview|summary|summari[sz]e|big picture)\b/i.test(q)) return "summary";
  if (/\bby (category|categories|account|accounts)\b/i.test(q)) return "group_account";
  if (/\bby (merchant|merchants|payee|payees|vendor|vendors)\b/i.test(q)) return "group_payee";
  if (/\b(biggest|largest|top|highest)\b/i.test(q)) return "top";
  if (/\b(how much|total|sum)\b/i.test(q) || /\b(spen[dt]|spending|paid)\b.*\b(on|for|at|to)\b/i.test(q)) return "sum";
  return null;
}

export async function planQuestion(question, rows, gen) {
  const labels = INTENTS.map((i) => i[0]);
  let intent = obviousIntent(question);
  if (!intent) {
    const msgs = [{ role: "user", content: `Question about a bank statement: "${question}". Which best describes what is being asked? Options: ${labels.join(", ")}. Answer with one option only, copied exactly.` }];
    const picked = pickOption(await gen(msgs, 24), labels);
    intent = (INTENTS.find((i) => i[0] === picked) || [null, "list"])[1];
  }
  const text = keywordFor(question, rows);
  const rowNum = question.match(/\b(?:row|line|#)\s*(\d+)/i)?.[1];
  if (rowNum && /\b(why|explain|how)\b/i.test(question)) intent = "explain";
  const q = { op: intent };
  if (intent === "in" || intent === "out") q.op = "list";
  const direction = directionFor(question, intent);
  if (direction) q.direction = direction;
  if (text) q.text = text;
  if (rowNum) q.row = Number(rowNum);
  const lim = limitFor(question); if (lim && (q.op === "top" || q.op === "list")) q.limit = lim;
  if (q.op === "sum" && !text && !direction) q.op = "summary";
  return q;
}

// Deterministic answer text from the computed result — the primary answer.
export function answerFromResult(q, res) {
  const r = res.result;
  const what = q.text ? `“${q.text}”` : q.direction === "in" ? "money in" : q.direction === "out" ? "money out" : "all lines";
  if (res.op === "summary") {
    return `${r.rows} lines, ${r.from} → ${r.to}. In ${inr(r.inflow)}, out ${inr(r.outflow)}, net ${inr(r.net)}.` +
      (r.closing_balance != null ? ` Closing balance ${inr(r.closing_balance)}.` : "") +
      ` ${r.needs_review} line${r.needs_review === 1 ? "" : "s"} need review.` +
      (r.top_expense_accounts.length ? ` Biggest categories: ${r.top_expense_accounts.slice(0, 3).map((a) => `${a.account} ${inr(a.total)}`).join(", ")}.` : "");
  }
  if (res.op === "explain") return r ? `Row ${r.i} · ${r.date} · ${r.payee} · ${inr(r.amount)} → ${r.account}\n${r.why}` : "I don't see that row.";
  if (!res.matched) return `Nothing matched ${what}. Try a different keyword — payees here include ${[...new Set((res.all || []).map((x) => x.payee))].slice(0, 5).join(", ")}.`;
  if (res.op === "sum" || res.op === "count") return `${what}: ${r.count} line${r.count === 1 ? "" : "s"}` + (res.op === "sum" ? `, out ${inr(r.outflow)}, in ${inr(r.inflow)} (net ${inr(r.net)}).` : ".") + (res.sample?.length ? ` e.g. ${res.sample.slice(0, 3).map((s) => `#${s.i} ${s.payee} ${inr(s.amount)}`).join("; ")}.` : "");
  if (res.op === "group_account" || res.op === "group_payee") return `${what}, by ${res.op === "group_account" ? "category" : "merchant"}:\n` + r.map((g) => `• ${g.key}: ${inr(g.total)} (${g.count})`).join("\n");
  if (res.op === "group_month") return `${what}, by month:\n` + r.map((g) => `• ${g.key}: in ${inr(g.in)}, out ${inr(g.out)}`).join("\n");
  if (res.op === "low_confidence") return r.length ? `${res.matched} line${res.matched === 1 ? "" : "s"} I'm not sure about:\n` + r.map((x) => `• #${x.i} ${x.payee} ${inr(x.amount)} → ${x.account} (${x.source} ${Math.round((x.confidence || 0) * 100)}%)`).join("\n") : "Every line was classified by a rule, your history, or a confident model answer.";
  // top / list
  return `${res.matched} line${res.matched === 1 ? "" : "s"} for ${what}${res.op === "top" ? ", biggest first" : ""}:\n` + r.map((x) => `• #${x.i} ${x.date} ${x.payee} ${inr(x.amount)} → ${x.account}`).join("\n");
}

export function narratePrompt(question, answer) {
  return [
    { role: "system", content: "You are a friendly bookkeeping assistant. Restate the ANSWER in one or two plain sentences for the user. Use only facts from the ANSWER; do not add or change any number." },
    { role: "user", content: `QUESTION: ${question}\nANSWER: ${answer.slice(0, 1500)}` },
  ];
}

export async function answer(question, rows, gen) {
  const q = await planQuestion(question, rows, gen);
  const res = runQuery(rows, q);
  res.all = rows;
  const text = answerFromResult(q, res);
  delete res.all;
  return { query: q, result: res, text };
}

export { summary };
