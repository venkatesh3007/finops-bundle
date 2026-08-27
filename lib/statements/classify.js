// Row classification — rules first, on-device model for the long tail.
// Pure functions (browser + Node). The model never sees or emits amounts; it
// only picks a counter-account for a description from the entity's own chart.
//
// Provenance is first-class: every classified row carries { source, rule,
// confidence } so "why is this Expenses:Travel?" is answered from a fact.
import { derivePayee } from "./parse.js";

const SALARY = /\b(salary|payroll)\b/i;
const INTEREST = /\binterest\b/i;
const ATM = /\b(atm|cash\s*wdl|cash\s*withdrawal|cwdr)\b/i;
const TRANSFER = /\b(card\s*payment|cc\s*payment|credit\s*card\s*payment|self\s*transfer|own\s*account|transfer\s*to\s*self|internal\s*transfer|autopay|bill\s*desk\s*amex)\b/i;

export function heuristic(desc, amount, opens) {
  const has = (a) => !opens || opens.has(a);
  const d = desc || "";
  if (amount > 0 && SALARY.test(d) && has("Income:Salary")) return { account: "Income:Salary", rule: "keyword:salary" };
  if (INTEREST.test(d)) {
    const a = amount > 0 ? "Income:Interest" : "Expenses:Interest";
    if (has(a)) return { account: a, rule: "keyword:interest" };
  }
  if (ATM.test(d) && has("Assets:Cash")) return { account: "Assets:Cash", rule: "keyword:atm" };
  if (TRANSFER.test(d) && has("Assets:Clearing:SelfTransfers")) return { account: "Assets:Clearing:SelfTransfers", rule: "keyword:self-transfer" };
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ctx: { accounts: string[], decisions: {payee -> account}, history: {payeeNorm -> {account, n}},
//        regex: [{pattern, account}] }
export function buildContext(raw) {
  const accounts = raw.accounts || [];
  const opens = new Set(accounts);
  const decisions = new Map(Object.entries(raw.decisions || {}).map(([k, v]) => [norm(k), v]));
  const history = new Map(Object.entries(raw.history || {}).map(([k, v]) => [norm(k), v]));
  const regex = (raw.regex || []).map((r) => { try { return { re: new RegExp(r.pattern, "i"), account: r.account }; } catch { return null; } }).filter(Boolean);
  const candidates = accounts.filter((a) => /^(Expenses|Income):/.test(a) || /^Assets:(Cash|Clearing|Receivable|Investments)/.test(a) || /^Liabilities:Loan/.test(a));
  return { accounts, opens, decisions, history, regex, candidates };
}

// Deterministic pass. Returns the row with classification fields filled, or
// with account=null when the model is needed.
export function classifyByRules(row, ctx) {
  const payee = derivePayee(row.desc);
  const pn = norm(payee), dn = norm(row.desc);
  const out = { ...row, payee, account: null, source: null, rule: null, confidence: 0 };

  const dec = ctx.decisions.get(pn) || [...ctx.decisions.entries()].find(([k]) => k && dn.includes(k))?.[1];
  if (dec && ctx.opens.has(dec)) return { ...out, account: dec, source: "decision", rule: `decision:payee:${payee}`, confidence: 0.98 };

  for (const r of ctx.regex) if (r.re.test(row.desc) && ctx.opens.has(r.account)) return { ...out, account: r.account, source: "rule", rule: `regex:${r.re.source}`, confidence: 0.95 };

  const h = ctx.history.get(pn);
  if (h && h.n >= 2 && ctx.opens.has(h.account)) return { ...out, account: h.account, source: "history", rule: `history:${payee}→${h.account} (${h.n}×)`, confidence: Math.min(0.97, 0.75 + 0.05 * h.n) };

  const k = heuristic(row.desc, row.amount, ctx.opens);
  if (k) return { ...out, account: k.account, source: "heuristic", rule: k.rule, confidence: 0.85 };
  return out;
}

export const defaultAccount = (row, ctx) => {
  const a = row.amount > 0 ? "Income:Other" : "Expenses:Other";
  return ctx.opens.has(a) ? a : ctx.candidates[0] || a;
};

// ── Model classification: small multiple-choice questions, hierarchically.
// LFM2.5-1.2B answers a 4–7 option question reliably but shows last-option
// bias once a list grows past ~10 (a 28-account chart → everything became
// "Expenses:Travel:Trains"). So: pick the group (Dining / Travel / Health…),
// then the sub-account inside it; never more than MAX_OPTS options at once,
// with tournament rounds when a level is still too wide. Numbers never
// touch the model — only the description and the direction.
const MAX_OPTS = 7;
const NONE = "None of these";

export function candidatesFor(row, ctx) {
  const inflow = row.amount > 0;
  const list = ctx.candidates.filter((a) => (inflow ? !a.startsWith("Expenses:") : !a.startsWith("Income:")));
  return list.length ? list : ctx.candidates;
}

export function questionFor(desc, direction, options) {
  const opts = [...options, NONE];
  return [{ role: "user", content: `Bank statement line: "${String(desc).slice(0, 120)}" (${direction === "IN" ? "money received" : "money paid"}). Which category fits best? Options: ${opts.join(", ")}. Answer with one option only, copied exactly.` }];
}

// Map a free-text answer onto one of the offered labels (exact → contains → token overlap).
export function pickOption(text, options) {
  const t = String(text || "").split("\n")[0].trim().replace(/[`"'*.]+$/g, "").replace(/^[`"'*]+/g, "").trim();
  if (!t) return null;
  const tl = t.toLowerCase();
  if (tl.startsWith(NONE.toLowerCase()) || /^none\b/i.test(t)) return null;
  const exact = options.find((o) => o.toLowerCase() === tl);
  if (exact) return exact;
  const contained = options.filter((o) => tl.includes(o.toLowerCase()) || o.toLowerCase().includes(tl));
  if (contained.length) return contained.sort((a, b) => b.length - a.length)[0];
  const toks = new Set(tl.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  let best = null, bestScore = 0;
  for (const o of options) {
    const sc = o.toLowerCase().split(/[^a-z0-9]+/).filter((w) => toks.has(w)).length;
    if (sc > bestScore) { best = o; bestScore = sc; }
  }
  return bestScore ? best : null;
}

// Ask about `labels` in chunks of MAX_OPTS; winners face off until one remains.
async function tournament(gen, desc, direction, labels) {
  let pool = [...labels];
  while (pool.length > 1) {
    if (pool.length <= MAX_OPTS) {
      const ans = pickOption(await gen(questionFor(desc, direction, pool), 24), pool);
      return ans; // may be null (None)
    }
    const winners = [];
    for (let i = 0; i < pool.length; i += MAX_OPTS) {
      const chunk = pool.slice(i, i + MAX_OPTS);
      const ans = pickOption(await gen(questionFor(desc, direction, chunk), 24), chunk);
      if (ans) winners.push(ans);
    }
    if (!winners.length) return null;
    if (winners.length === pool.length) return winners[0]; // no progress; avoid loops
    pool = winners;
  }
  return pool[0] || null;
}

// Human labels for the model: "Expenses:Travel:Cabs" → group "Travel", leaf "Cabs".
const groupOf = (a) => { const p = a.split(":"); return p.length >= 3 ? p.slice(0, 2).join(":") : a; };
const label = (a) => a.split(":").slice(1).join(" › ") || a;

// gen(messages, maxTokens) → Promise<string>. Returns { account, trace } or { account: null }.
export async function classifyRowWithModel(row, ctx, gen) {
  const cands = candidatesFor(row, ctx);
  const direction = row.amount > 0 ? "IN" : "OUT";
  const desc = row.desc;
  const trace = [];
  // level 1: groups (Expenses:Travel, Expenses:Dining, Assets:Cash, …)
  const groups = [...new Set(cands.map(groupOf))];
  const gLabels = new Map(groups.map((g) => [label(g), g]));
  const gPick = await tournament(gen, desc, direction, [...gLabels.keys()]);
  trace.push(`group:${gPick || "none"}`);
  if (!gPick) return { account: null, trace };
  const group = gLabels.get(gPick);
  const leaves = cands.filter((a) => a === group || groupOf(a) === group);
  if (leaves.length === 1) return { account: leaves[0], trace };
  // level 2: sub-accounts within the group (plus the group itself if it is an account)
  const lLabels = new Map(leaves.map((a) => [a === group ? `${label(a)} (general)` : label(a), a]));
  const lPick = await tournament(gen, desc, direction, [...lLabels.keys()]);
  trace.push(`leaf:${lPick || "none"}`);
  const account = lPick ? lLabels.get(lPick) : leaves.find((a) => a === group) || null;
  return { account, trace };
}

// Merge one model answer into a row (null answer → default, flagged '!').
export function applyModelAnswer(row, account, ctx, modelId) {
  if (account) {
    const generic = /:Other$/.test(account);
    return { ...row, account, source: "model", rule: `model:${modelId}`, confidence: generic ? 0.4 : 0.7 };
  }
  return { ...row, account: defaultAccount(row, ctx), source: "default", rule: "default:unclassified", confidence: 0.2 };
}

export const flagFor = (row) => (row.confidence >= 0.6 && !/:Other$/.test(row.account || "") ? "*" : "!");
