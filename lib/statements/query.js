// Deterministic query engine over parsed statement rows. The chat model
// translates a question into one of these queries; JS computes the answer; the
// model only narrates. Numbers therefore never come from the model.
//
// query = { op, text?, account?, payee?, from?, to?, direction? ('in'|'out'),
//           min?, max?, source?, flagged?, row?, limit? }
// ops: list | sum | count | group_account | group_month | group_payee | top |
//      summary | explain | low_confidence

const r2 = (n) => Math.round(n * 100) / 100;
const inr = (n) => (n < 0 ? "−₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function filterRows(rows, q = {}) {
  const t = q.text ? String(q.text).toLowerCase() : null;
  const p = q.payee ? String(q.payee).toLowerCase() : null;
  const a = q.account ? String(q.account).toLowerCase() : null;
  return rows.filter((r) => {
    if (t && !`${r.desc} ${r.payee || ""}`.toLowerCase().includes(t)) return false;
    if (p && !String(r.payee || "").toLowerCase().includes(p)) return false;
    if (a && !String(r.account || "").toLowerCase().includes(a)) return false;
    if (q.from && r.date < q.from) return false;
    if (q.to && r.date > q.to) return false;
    if (q.direction === "in" && !(r.amount > 0)) return false;
    if (q.direction === "out" && !(r.amount < 0)) return false;
    if (q.min != null && Math.abs(r.amount) < Number(q.min)) return false;
    if (q.max != null && Math.abs(r.amount) > Number(q.max)) return false;
    if (q.source && r.source !== q.source) return false;
    if (q.flagged && !(r.confidence < 0.6 || /:Other$/.test(r.account || ""))) return false;
    return true;
  });
}

const groupBy = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const g = m.get(k) || { key: k, count: 0, total: 0, in: 0, out: 0 };
    g.count++; g.total = r2(g.total + r.amount);
    if (r.amount > 0) g.in = r2(g.in + r.amount); else g.out = r2(g.out - r.amount);
    m.set(k, g);
  }
  return [...m.values()].sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
};

const brief = (r) => ({ i: r.i, date: r.date, payee: r.payee, amount: r.amount, account: r.account, source: r.source, confidence: r.confidence, desc: String(r.desc).slice(0, 80) });

export function summary(rows) {
  const inflow = r2(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const outflow = r2(rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
  const dates = rows.map((r) => r.date).sort();
  const bySource = {};
  for (const r of rows) bySource[r.source || "?"] = (bySource[r.source || "?"] || 0) + 1;
  const low = rows.filter((r) => r.confidence < 0.6 || /:Other$/.test(r.account || ""));
  return {
    rows: rows.length, from: dates[0], to: dates[dates.length - 1], inflow, outflow, net: r2(inflow - outflow),
    classified_by: bySource, needs_review: low.length,
    top_expense_accounts: groupBy(rows.filter((r) => r.amount < 0), (r) => r.account).slice(0, 8).map((g) => ({ account: g.key, total: g.out, count: g.count })),
    top_payees: groupBy(rows.filter((r) => r.amount < 0), (r) => r.payee).slice(0, 8).map((g) => ({ payee: g.key, total: g.out, count: g.count })),
    closing_balance: rows.filter((r) => r.balance != null).slice(-1)[0]?.balance ?? null,
  };
}

export function runQuery(rows, q) {
  const op = q.op || "list";
  const limit = Math.min(Number(q.limit) || 20, 100);
  if (op === "summary") return { op, result: summary(rows) };
  if (op === "explain") {
    const r = rows.find((x) => x.i === Number(q.row)) || filterRows(rows, q)[0];
    if (!r) return { op, result: null, note: "no such row" };
    return { op, result: { ...brief(r), rule: r.rule, why: explain(r) } };
  }
  const sel = filterRows(rows, q);
  if (op === "low_confidence") {
    const low = sel.filter((r) => r.confidence < 0.6 || /:Other$/.test(r.account || ""));
    return { op, matched: low.length, result: low.slice(0, limit).map(brief) };
  }
  if (op === "count") return { op, matched: sel.length, result: { count: sel.length, total: r2(sel.reduce((s, r) => s + r.amount, 0)) } };
  if (op === "sum") {
    const inflow = r2(sel.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
    const outflow = r2(sel.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
    return { op, matched: sel.length, result: { count: sel.length, inflow, outflow, net: r2(inflow - outflow) }, sample: sel.slice(0, 5).map(brief) };
  }
  if (op === "group_account") return { op, matched: sel.length, result: groupBy(sel, (r) => r.account).slice(0, limit) };
  if (op === "group_payee") return { op, matched: sel.length, result: groupBy(sel, (r) => r.payee).slice(0, limit) };
  if (op === "group_month") return { op, matched: sel.length, result: groupBy(sel, (r) => r.date.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)) };
  if (op === "top") return { op, matched: sel.length, result: [...sel].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, limit).map(brief) };
  return { op: "list", matched: sel.length, result: sel.slice(0, limit).map(brief) };
}

export function explain(r) {
  const s = r.source;
  if (s === "decision") return `You decided this before: payee "${r.payee}" → ${r.account} (a saved decision from the review queue). Confidence ${r.confidence}.`;
  if (s === "rule") return `A saved regex rule matched the description (${r.rule}). Confidence ${r.confidence}.`;
  if (s === "history") return `Your books already post this payee to ${r.account} — ${r.rule.replace("history:", "")}. Confidence ${r.confidence}.`;
  if (s === "heuristic") return `A built-in keyword rule (${r.rule.replace("keyword:", "")}) matched the description. Confidence ${r.confidence}.`;
  if (s === "model") return `No rule or history matched, so the on-device model (${r.rule.replace("model:", "")}) chose ${r.account} from your chart of accounts. Confidence ${r.confidence} — worth a glance.`;
  if (s === "default") return `Nothing matched and the model gave no usable answer, so it defaulted to ${r.account} and is flagged (!) for review.`;
  if (s === "manual") return `You set this account by hand in the preview table.`;
  return `Unclassified.`;
}

// Render a query result compactly for the narration prompt (bounded size).
export function renderResult(res) {
  return JSON.stringify(res, (k, v) => (typeof v === "number" ? r2(v) : v)).slice(0, 6000);
}

export { inr };
