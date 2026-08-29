// The assistant's tools. Each one reads or changes real state; none of them lets
// a model produce a number on its own — figures always come back computed.
import { loadCorpus, runQuery, matchStatement } from "../statements/corpus-query.js";
import { render } from "../statements/corpus-ask.js";
import { query } from "../db.js";
import { startJob, listJobs, getJob } from "../jobs/store.js";
import { runParseJob } from "../parser/run-job.js";

export const TOOLS = [
  {
    name: "query_statements",
    what: "Read anything about the parsed statements or the transactions in them. This is how you answer every factual question — totals, which statements don't add up, which rows break the balance and by how much, month coverage gaps, duplicates across statements, spend by merchant or category, biggest rows.",
    input: `{ "op": "overview" | "statements" | "breaks" | "explain_statement" | "coverage" | "duplicates" | "transactions" | "sum" | "group" | "top" | "needs_review",
  "statement": "part of a filename (for explain_statement, or to narrow)",
  "text": "merchant/keyword", "account": "part of a ledger account", "bank": "amex|federal|…",
  "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "direction": "in"|"out", "min": n, "max": n,
  "by": "account"|"payee"|"month"|"statement"|"bank",   // op=group
  "sort": "rows"|"breaks"|"inflow"|"outflow"|"net"|"from"|"to",  // op=statements ranking
  "order": "desc"|"asc", "with_breaks": true, "unverified": true, "limit": n }`,
  },
  {
    name: "parse_statements",
    what: "Re-parse statements by WRITING a fresh parser for each layout, running it, and checking every row against the printed running balance. This is what 'rewrite the parser', 'fix the parsing' and 'parse it properly' mean — pass regenerate:true for those so it does not reuse a cached parser. Runs in the background; returns a job id immediately.",
    input: `{ "statement": "part of a filename to parse just that one",
  "all": true,            // every statement
  "only_broken": true,    // only the ones that don't reconcile
  "regenerate": true }    // ignore any cached parser and write a new one`,
  },
  {
    name: "job_status",
    what: "Check a background run that is already going. Use it only if the user asks about progress — the interface already streams the steps.",
    input: `{ "job_id": "uuid" }  // omit to get the most recent run`,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

// Every tool returns { summary } — text the assistant reads — plus structured
// data the UI can show under "how I worked that out".
export async function runTool(entity, name, input = {}) {
  if (name === "query_statements") {
    const corpus = await loadCorpus(entity);
    if (!corpus.statements.length) return { summary: "There are no parsed statements yet.", data: null };
    const q = { ...input };
    if (q.statement && !matchStatement(corpus.statements, q.statement)) {
      const names = corpus.statements.slice(0, 12).map((s) => s.name).join(", ");
      return { summary: `No statement matches "${q.statement}". The ones that exist: ${names}`, data: null };
    }
    const res = runQuery(corpus, q);
    return { summary: render(q, res, corpus), data: { query: q, result: res } };
  }

  if (name === "parse_statements") {
    const entId = await entityId(entity);
    const rows = await query(
      `select id, filename, reconciliation from statement_drafts
        where entity_id=$1 and status <> 'imported' and (meta ? 'pages' or meta ? 'text')
        order by updated_at desc limit 60`, [entId]);
    if (!rows.length) return { summary: "There are no statements to parse.", data: null };

    let picked = rows;
    if (input.statement) {
      const needle = String(input.statement).toLowerCase();
      picked = rows.filter((r) => r.filename.toLowerCase().includes(needle));
      if (!picked.length) return { summary: `No statement matches "${input.statement}".`, data: null };
    } else if (input.only_broken) {
      picked = rows.filter((r) => !r.reconciliation?.reconciled);
    } else if (!input.all) {
      picked = rows.filter((r) => !r.reconciliation?.reconciled);
    }
    if (!picked.length) return { summary: "Nothing needs re-parsing — every statement already reconciles.", data: null };

    const ids = picked.map((r) => r.id);
    const title = ids.length === 1 ? `Parse ${picked[0].filename}` : `Parse ${ids.length} statements`;
    const job = await startJob(entity, { kind: "parse", title, draft_id: ids.length === 1 ? ids[0] : null });
    runParseJob({ entity, entId, jobId: job.id, draftIds: ids, regenerate: !!input.regenerate }).catch(() => {});
    return {
      summary: `Started: writing a fresh parser for ${ids.length} statement${ids.length === 1 ? "" : "s"} (${picked.slice(0, 4).map((p) => p.filename).join(", ")}${ids.length > 4 ? `, +${ids.length - 4} more` : ""}). It runs in the background; the steps appear as they happen and can be stopped.`,
      data: { job_id: job.id, statements: ids.length },
      job_id: job.id,
    };
  }

  if (name === "job_status") {
    const job = input.job_id ? await getJob(entity, input.job_id) : (await listJobs(entity, { limit: 1 }))[0];
    if (!job) return { summary: "No runs yet.", data: null };
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const last = steps[steps.length - 1] || job.last_step;
    return {
      summary: `${job.title}: ${job.status}${last ? ` — last step: ${last.text}` : ""}`,
      data: { id: job.id, status: job.status, steps: steps.length },
      job_id: job.status === "running" ? job.id : undefined,
    };
  }

  return { summary: `No tool called ${name}.`, data: null };
}
