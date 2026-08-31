// Tools for INVESTIGATING a parse, as opposed to answering questions about one.
//
// The difference is arbitrary computation. corpus-query.js answers from a fixed
// vocabulary — totals, breaks, coverage, duplicates. That vocabulary cannot
// express "pair every amount in the source with the payee printed beside it and
// compare that to the extracted rows", which is the question that found both real
// bugs on 2026-08-31. So the agent gets a sandbox and writes the query itself.
import { query } from "../db.js";
import { runAnalysis, AnalysisError } from "../extractor/sandbox.js";
import { loadCorpus, runQuery, matchStatement } from "../statements/corpus-query.js";
import { render } from "../statements/corpus-ask.js";
import { proposeRule } from "../statements/rules.js";

const MAX_TEXT = 12_000;

export const TOOLS = [
  {
    name: "run_analysis",
    what: `Run JavaScript over the statement and get JSON back. THIS IS THE MAIN TOOL — it is how you check a claim instead of asserting it. \`ctx\` holds { filename, bank, kind, period, meta, pages: [string] (the raw text as it came off the PDF, the source of truth), rows: [{i,date,desc,payee,amount,balance}] (what the extraction produced), reconciliation }. Write an expression, or a body ending in \`return\`. Pure JS only — no require, fetch, fs, process or timers; 4s limit; the result must be JSON and under 64KB, so aggregate or slice. Read-only: nothing you run here changes any data.`,
    input: `{ "statement": "part of a filename", "code": "ctx.rows.filter((r,i,a) => i && r.amount === a[i-1].amount && r.balance === a[i-1].balance)" }`,
  },
  {
    name: "read_source",
    what: "Read the raw text of the statement, with line numbers. Use `grep` to find the lines around something, or `page`/`from`/`to` for a slice. This is what the PDF actually says — check it before believing anything about what went wrong.",
    input: `{ "statement": "part of a filename", "grep": "LOVABLE", "around": 4, "page": 3, "from": 40, "to": 70 }`,
  },
  {
    name: "read_rows",
    what: "Read the extracted rows, optionally a slice or a text filter. Cheaper than run_analysis when you just want to look.",
    input: `{ "statement": "part of a filename", "from": 118, "to": 126, "text": "UPI" }`,
  },
  {
    name: "query_statements",
    what: "The deterministic engine over every parsed statement — totals, which ones don't add up, breaks, month coverage, duplicates, spend by merchant. Use it for anything factual across the corpus rather than computing it yourself.",
    input: `{ "op": "overview" | "statements" | "breaks" | "explain_statement" | "coverage" | "duplicates" | "transactions" | "sum" | "group" | "top" | "needs_review", "statement": "...", "limit": n }`,
  },
  {
    name: "propose_rule",
    what: `Write down a fix as a RULE, once you have proved what went wrong. A rule is an instruction added to the extraction prompt for future statements — it ships without a deploy. Scope it as narrowly as the evidence supports: "idbi" if you only saw it on IDBI, "global" only if it is a general truth about statements. It is proposed, not applied: it will be re-run against every statement it touches and promoted only if nothing loses rows, nothing gains breaks, nothing stops reconciling, and at least one improves.`,
    input: `{ "scope": "idbi", "rule": "A line carrying no date and no amount continues the transaction ABOVE it; never attach it to the transaction below.", "why": "On idbi-79657_2025-05 the payees were shifted by one row and a duplicate absorbed the shift; source lines 52-57 show two different wrap patterns." }`,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

async function pickDraft(entity, needle) {
  const entId = await entityId(entity);
  const rows = await query(
    `select * from statement_drafts where entity_id=$1 and (meta ? 'pages' or meta ? 'text')
      order by updated_at desc limit 200`, [entId]);
  if (!rows.length) return { error: "There are no statements stored yet." };
  if (!needle) return { draft: rows[0] };
  const n = String(needle).toLowerCase();
  const hit = rows.find((r) => r.filename.toLowerCase().includes(n));
  if (!hit) return { error: `No statement matches "${needle}". Stored: ${rows.slice(0, 14).map((r) => r.filename).join(", ")}` };
  return { draft: hit };
}

const pagesOf = (d) => {
  const m = d.meta || {};
  return Array.isArray(m.pages) && m.pages.length ? m.pages : (m.text ? [m.text] : []);
};

const contextOf = (d) => ({
  filename: d.filename, bank: d.kind || "", kind: d.kind || "",
  period: d.meta?.period || null,
  meta: {
    statement_type: d.meta?.statement_type, opening_balance: d.meta?.opening_balance,
    closing_balance: d.meta?.closing_balance, total_credits: d.meta?.total_credits,
    total_debits: d.meta?.total_debits, chunks: d.meta?.chunks, rounds: d.meta?.rounds,
  },
  pages: pagesOf(d),
  rows: (d.rows || []).map((r, i) => ({ i, date: r.date, desc: r.desc, payee: r.payee, amount: r.amount, balance: r.balance, account: r.account })),
  reconciliation: d.reconciliation || null,
});

export async function runTool(entity, name, input = {}) {
  if (name === "run_analysis") {
    const { draft, error } = await pickDraft(entity, input.statement);
    if (error) return { summary: error, data: null };
    try {
      const { value } = runAnalysis(input.code, contextOf(draft));
      const shown = JSON.stringify(value);
      return {
        summary: `Ran on ${draft.filename}. Result:\n${shown.length > 6000 ? shown.slice(0, 6000) + " …(truncated)" : shown}`,
        data: { statement: draft.filename, code: input.code, result: value },
      };
    } catch (e) {
      // Handing the error back is the point: fixing your own code and re-running
      // is how a wrong regex gets caught, and it caught two.
      const msg = e instanceof AnalysisError ? e.message : String(e.message || e);
      return { summary: `That analysis didn't run: ${msg}\nFix the code and try again.`, data: { code: input.code, error: msg } };
    }
  }

  if (name === "read_source") {
    const { draft, error } = await pickDraft(entity, input.statement);
    if (error) return { summary: error, data: null };
    const pages = pagesOf(draft);
    const lines = [];
    pages.forEach((p, pi) => String(p).split(/\r?\n/).forEach((l, li) => lines.push({ page: pi + 1, line: li, text: l })));
    let picked = lines;
    if (input.grep) {
      const rx = new RegExp(String(input.grep).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const around = Math.min(Number(input.around ?? 3), 12);
      const keep = new Set();
      lines.forEach((l, idx) => { if (rx.test(l.text)) for (let k = idx - around; k <= idx + around; k++) if (k >= 0 && k < lines.length) keep.add(k); });
      picked = [...keep].sort((a, b) => a - b).map((k) => lines[k]);
      if (!picked.length) return { summary: `Nothing in ${draft.filename} matches "${input.grep}".`, data: null };
    } else if (input.page) {
      picked = lines.filter((l) => l.page === Number(input.page));
    }
    if (input.from != null || input.to != null) picked = picked.slice(Number(input.from || 0), Number(input.to ?? (Number(input.from || 0) + 60)));
    let text = picked.map((l) => `p${l.page}:${String(l.line).padStart(3)}| ${l.text}`).join("\n");
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n…(truncated — narrow the grep or the range)";
    return { summary: `${draft.filename}, raw source:\n${text}`, data: { statement: draft.filename, lines: picked.length } };
  }

  if (name === "read_rows") {
    const { draft, error } = await pickDraft(entity, input.statement);
    if (error) return { summary: error, data: null };
    let rows = (draft.rows || []).map((r, i) => ({ i, ...r }));
    if (input.text) {
      const n = String(input.text).toLowerCase();
      rows = rows.filter((r) => `${r.desc || ""} ${r.payee || ""}`.toLowerCase().includes(n));
    }
    if (input.from != null || input.to != null) rows = rows.slice(Number(input.from || 0), Number(input.to ?? (Number(input.from || 0) + 40)));
    const text = rows.slice(0, 120).map((r) => `[${r.i}] ${r.date}  ${String(r.desc || "").slice(0, 46).padEnd(46)} amt=${String(r.amount).padStart(11)} bal=${r.balance}`).join("\n");
    return { summary: `${draft.filename}, ${rows.length} row(s):\n${text}`, data: { statement: draft.filename, count: rows.length } };
  }

  if (name === "query_statements") {
    const corpus = await loadCorpus(entity);
    if (!corpus.statements.length) return { summary: "There are no parsed statements yet.", data: null };
    const q = { ...input };
    if (q.statement && !matchStatement(corpus.statements, q.statement)) {
      return { summary: `No statement matches "${q.statement}". The ones that exist: ${corpus.statements.slice(0, 12).map((s) => s.name).join(", ")}`, data: null };
    }
    const res = runQuery(corpus, q);
    return { summary: render(q, res, corpus), data: { query: q, result: res } };
  }

  if (name === "propose_rule") {
    if (!String(input.rule || "").trim()) return { summary: "A rule needs text.", data: null };
    const row = await proposeRule(entity, {
      scope: input.scope || "global", rule: input.rule, why: input.why || "",
      evidence: input.evidence || null, createdBy: "agent",
    });
    return {
      summary: `Rule written down for "${row.scope}" and queued for grading — it is NOT active yet. It will be re-run against every statement it touches and promoted only if nothing gets worse and something improves.`,
      data: { rule_id: row.id, scope: row.scope, rule: row.rule },
      rule_id: row.id,
    };
  }

  return { summary: `No tool called ${name}.`, data: null };
}
