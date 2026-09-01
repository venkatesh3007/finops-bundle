// MCP server for the books — so reconciling and categorising can happen in a
// chat client instead of by hand in the dashboard.
//
// Hand-rolled JSON-RPC rather than an SDK: the protocol surface we need is three
// methods (initialize, tools/list, tools/call), and this app carries no
// dependencies it does not need.
//
// EVERY tool is scoped to the caller's OWN entity, resolved from the OAuth token
// server-side. There is no entity parameter to pass and none is honoured, so a
// token can never reach another person's book.
import { query } from "../../../lib/db";
import { ensureUserEntity } from "../../../lib/tenant";
import { verifyAccess, issuer } from "../../../lib/mcp-oauth";
import { listDrafts, getDraft, updateDraft, importDraft } from "../../../lib/statements/drafts";
import { classificationContext } from "../../../lib/statements-import";
import { reconcile } from "../../../lib/statements/reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACCOUNT_RE = /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z0-9][A-Za-z0-9-]*)+$/;
const TYPE = (n) => ({ Assets: "assets", Liabilities: "liabilities", Equity: "equity", Income: "income", Expenses: "expenses" }[n.split(":")[0]]);
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const norm = (rows) => rows.map((r) => ({ ...r, description: r.desc ?? r.description }));

const GUIDE = `You are working on this person's real double-entry books (Postgres).

Ground rules
1. A statement is TRUSTWORTHY when it reconciles: the rows add up to the totals the
   statement itself prints. reconcile_check tells you, and it is the only judge —
   never assert a statement is fine because the rows look plausible.
2. Categorising a row changes where money is reported, not how much. Fixing an
   AMOUNT or a SIGN changes the books: do that only with the document in front of
   you, and re-run reconcile_check afterwards.
3. set_payee_rule is the lever worth using. One rule categorises every future row
   from that payee, so prefer it over repeating set_row_account.
4. Money someone repays you is NOT income. If you paid on their behalf, the inflow
   settles a receivable (Assets:Receivable:<Person>) — open_account creates one.
5. Nothing reaches the ledger until import_statement runs, and it refuses a row
   with no account. Drafts are safe to edit.

Start with list_statements to see what is there and what still needs work.`;

// ── tools ────────────────────────────────────────────────────────────────────
// Each: { name, title, description, schema, run(args, ctx) }. `ctx.entity` is the
// caller's own book.
const TOOLS = [
  {
    name: "list_statements",
    title: "List statements",
    description: "Every statement held for your book: rows, whether it reconciles, its account and period, and whether it has been imported. Start here.",
    schema: { type: "object", properties: { only_unreconciled: { type: "boolean", description: "just the ones that don't add up" } } },
    async run({ only_unreconciled }, { entity }) {
      // listDrafts returns summarize() shape, not raw rows — read that.
      const ds = await listDrafts(entity);
      const out = ds.map((d) => ({
        id: d.id, filename: d.filename, account: d.account, kind: d.kind, status: d.status,
        rows: d.rows_count, period: d.from && d.to ? `${d.from} → ${d.to}` : null,
        reconciled: !!d.reconciled, breaks: d.breaks || 0, note: d.rec_note || null,
        needs_review: d.needs_review || 0,
      })).filter((d) => (only_unreconciled ? !d.reconciled : true));
      return { statements: out, total: out.length, reconciling: out.filter((d) => d.reconciled).length };
    },
  },
  {
    name: "statement_rows",
    title: "Read a statement's rows",
    description: "The rows of one statement with their dates, amounts, descriptions and accounts. Filter to what you're working on rather than pulling hundreds of rows.",
    schema: {
      type: "object",
      properties: {
        statement_id: { type: "string", description: "id from list_statements" },
        match: { type: "string", description: "only rows whose description contains this (case-insensitive)" },
        unclassified_only: { type: "boolean", description: "only rows with no account yet" },
        limit: { type: "number", description: "default 60" }, offset: { type: "number" },
      },
      required: ["statement_id"],
    },
    async run({ statement_id, match, unclassified_only, limit = 60, offset = 0 }, { entity }) {
      const d = await getDraft(entity, statement_id);
      if (!d) throw new Error("no such statement");
      let rows = (d.rows || []).map((r, i) => ({ i, date: r.date, desc: r.desc, amount: r.amount, balance: r.balance, account: r.account, source: r.source }));
      if (match) rows = rows.filter((r) => String(r.desc || "").toLowerCase().includes(match.toLowerCase()));
      if (unclassified_only) rows = rows.filter((r) => !r.account);
      return { filename: d.filename, account: d.account, matched: rows.length, rows: rows.slice(offset, offset + Math.min(limit, 200)) };
    },
  },
  {
    name: "reconcile_check",
    title: "Check a statement adds up",
    description: "Recompute one statement against the totals it prints: per-side gaps, balance-chain breaks, and a plain-language note. The authority on whether a statement can be trusted.",
    schema: { type: "object", properties: { statement_id: { type: "string" } }, required: ["statement_id"] },
    async run({ statement_id }, { entity }) {
      const d = await getDraft(entity, statement_id);
      if (!d) throw new Error("no such statement");
      const rec = reconcile(norm(d.rows || []), {
        statement_type: d.meta?.statement_type, opening_balance: d.meta?.opening_balance, closing_balance: d.meta?.closing_balance,
        total_credits: d.meta?.total_credits, total_debits: d.meta?.total_debits,
      });
      return {
        filename: d.filename, reconciled: !!rec.reconciled, note: rec.note || null,
        sides: rec.sides || null,
        breaks: (rec.continuity?.mismatches || []).slice(0, 20),
        break_count: rec.continuity?.mismatches?.length || 0,
      };
    },
  },
  {
    name: "list_accounts",
    title: "Chart of accounts",
    description: "Every account open in your book — the only accounts a row may be assigned to.",
    schema: { type: "object", properties: { prefix: { type: "string", description: "e.g. 'Assets:Receivable'" } } },
    async run({ prefix }, { entity }) {
      const rows = await query(
        `select a.name, a.type from accounts a join entities e on e.id = a.entity_id
          where e.slug = $1 ${prefix ? "and a.name like $2" : ""} order by a.name`,
        prefix ? [entity, `${prefix}%`] : [entity]);
      return { accounts: rows.map((r) => r.name), count: rows.length };
    },
  },
  {
    name: "open_account",
    title: "Open a new account",
    description: "Add an account to the chart so rows can be assigned to it. Use the existing naming (Assets:Receivable:<Person> for money someone owes you, Expenses:<Category>, Income:<Source>). Money a friend repays you belongs in a receivable, not in Income.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "e.g. Assets:Receivable:Ishan" },
        note: { type: "string", description: "what it is for" },
      },
      required: ["name"],
    },
    async run({ name, note }, { entity }) {
      if (!ACCOUNT_RE.test(name))
        throw new Error(`"${name}" is not a valid account name — use Type:Segment[:Segment], each segment starting with a capital or digit (e.g. Assets:Receivable:Ishan)`);
      const ent = await query("select id from entities where slug=$1", [entity]);
      const existing = await query("select name from accounts where entity_id=$1 and name=$2", [ent[0].id, name]);
      if (existing.length) return { ok: true, name, already_open: true };
      await query("insert into accounts (entity_id, name, type, metadata) values ($1,$2,$3,$4)",
        [ent[0].id, name, TYPE(name), JSON.stringify(note ? { note } : {})]);
      return { ok: true, name, type: TYPE(name), created: true };
    },
  },
  {
    name: "set_row_account",
    title: "Categorise rows",
    description: "Assign an account to one or more rows of a statement. Changes where money is reported, never how much. The account must already be open — use open_account first if it isn't.",
    schema: {
      type: "object",
      properties: {
        statement_id: { type: "string" },
        account: { type: "string", description: "an account from list_accounts" },
        rows: { type: "array", items: { type: "number" }, description: "row indexes from statement_rows" },
        match: { type: "string", description: "instead of row indexes: every row whose description contains this" },
      },
      required: ["statement_id", "account"],
    },
    async run({ statement_id, account, rows, match }, { entity }) {
      const d = await getDraft(entity, statement_id);
      if (!d) throw new Error("no such statement");
      const ent = await query("select id from entities where slug=$1", [entity]);
      const known = await query("select 1 from accounts where entity_id=$1 and name=$2", [ent[0].id, account]);
      if (!known.length) throw new Error(`the account "${account}" is not open — call open_account first, or list_accounts to see what exists`);

      const idx = Array.isArray(rows) && rows.length
        ? rows
        : match
          ? (d.rows || []).map((r, i) => [r, i]).filter(([r]) => String(r.desc || "").toLowerCase().includes(match.toLowerCase())).map(([, i]) => i)
          : [];
      if (!idx.length) throw new Error("nothing selected — pass row indexes, or a `match` that hits at least one row");

      const patch = {};
      for (const i of idx) patch[i] = account;
      await updateDraft(entity, statement_id, { row_accounts: patch });
      return { ok: true, updated: idx.length, account, rows: idx.slice(0, 40) };
    },
  },
  {
    name: "set_payee_rule",
    title: "Remember a payee's account",
    description: "Teach the books that a payee always belongs to an account, so every future statement classifies it without being asked. Prefer this over categorising the same payee twice.",
    schema: {
      type: "object",
      properties: {
        payee: { type: "string", description: "as it appears in the description, e.g. ISHAN LUTHRA" },
        account: { type: "string" },
        why: { type: "string" },
      },
      required: ["payee", "account"],
    },
    async run({ payee, account, why }, { entity }) {
      const ent = await query("select id from entities where slug=$1", [entity]);
      const known = await query("select 1 from accounts where entity_id=$1 and name=$2", [ent[0].id, account]);
      if (!known.length) throw new Error(`the account "${account}" is not open — call open_account first`);
      await query(
        `insert into decisions (entity_id, key, decision, rationale) values ($1,$2,$3,$4)
           on conflict (entity_id,key) do update set decision=excluded.decision, rationale=excluded.rationale`,
        [ent[0].id, `payee:${payee}`, account, why || "set from the MCP connector"]);
      return { ok: true, payee, account };
    },
  },
  {
    name: "search_rows",
    title: "Find rows across statements",
    description: "Search every statement for rows matching a payee or an amount — the way to answer 'what is this recurring transfer' or 'where else does this appear'.",
    schema: {
      type: "object",
      properties: {
        match: { type: "string", description: "text in the description" },
        amount: { type: "number", description: "exact amount, either sign" },
        limit: { type: "number", description: "default 50" },
      },
    },
    async run({ match, amount, limit = 50 }, { entity }) {
      if (!match && amount == null) throw new Error("give a `match` or an `amount`");
      const rows = await query(
        `select d.filename, d.id, r as row from statement_drafts d
           join entities e on e.id = d.entity_id, jsonb_array_elements(d.rows) r
          where e.slug = $1
            ${match ? "and r->>'desc' ilike '%' || $2 || '%'" : ""}
            ${amount != null ? `and abs((r->>'amount')::numeric) = $${match ? 3 : 2}` : ""}
          limit ${Math.min(Number(limit) || 50, 200)}`,
        [entity, ...(match ? [match] : []), ...(amount != null ? [Math.abs(amount)] : [])]);
      return {
        matched: rows.length,
        rows: rows.map((x) => ({
          statement_id: x.id, filename: x.filename,
          date: x.row.date, desc: x.row.desc, amount: x.row.amount, account: x.row.account,
        })),
        total: r2(rows.reduce((t, x) => t + Number(x.row.amount || 0), 0)),
      };
    },
  },
  {
    name: "account_balances",
    title: "Balances by account",
    description: "What each account holds in the ledger — after import, not from drafts.",
    schema: { type: "object", properties: { prefix: { type: "string" } } },
    async run({ prefix }, { entity }) {
      const rows = await query(
        `select a.name, round(sum(p.amount)::numeric, 2) as balance, count(*)::int as postings
           from postings p join accounts a on a.id = p.account_id
           join entities e on e.id = a.entity_id
          where e.slug = $1 ${prefix ? "and a.name like $2" : ""}
          group by a.name order by a.name`,
        prefix ? [entity, `${prefix}%`] : [entity]);
      return { balances: rows };
    },
  },
  {
    name: "import_statement",
    title: "Import a statement into the ledger",
    description: "Post a statement's rows into the books. Every row needs an account first. This writes to the ledger — say what you are importing before you do it.",
    schema: {
      type: "object",
      properties: { statement_id: { type: "string" }, force: { type: "boolean", description: "import even if it does not reconcile" } },
      required: ["statement_id"],
    },
    async run({ statement_id, force }, { entity, email }) {
      const d = await getDraft(entity, statement_id);
      if (!d) throw new Error("no such statement");
      const missing = (d.rows || []).filter((r) => !r.account).length;
      if (missing) throw new Error(`${missing} row(s) have no account yet — categorise them first (statement_rows with unclassified_only)`);
      if (!d.reconciliation?.reconciled && !force)
        throw new Error(`${d.filename} does not reconcile (${d.reconciliation?.note || "totals disagree"}). Fix it, or pass force:true if you have checked it against the document.`);
      const res = await importDraft(entity, statement_id, { force: !!force, userEmail: email });
      return { ok: !!res.ok, ...res };
    },
  },
];

// ── JSON-RPC ─────────────────────────────────────────────────────────────────
const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

async function dispatch(msg, ctx) {
  const { id, method, params } = msg || {};
  if (method === "initialize")
    return rpc(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "finops-books", version: "1.0.0" },
      instructions: GUIDE,
    });
  if (method === "notifications/initialized" || method === "ping") return id == null ? null : rpc(id, {});
  if (method === "tools/list")
    return rpc(id, { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.schema })) });
  if (method === "tools/call") {
    const t = TOOLS.find((x) => x.name === params?.name);
    if (!t) return rpc(id, { ...text(`no such tool: ${params?.name}`), isError: true });
    try {
      return rpc(id, text(await t.run(params.arguments || {}, ctx)));
    } catch (e) {
      // A tool error is a RESULT, not a transport error — the model needs to read
      // it and try something else rather than see the connection fail.
      return rpc(id, { ...text(`ERROR: ${String(e?.message || e)}`), isError: true });
    }
  }
  return rpcErr(id, -32601, `unknown method: ${method}`);
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/api/mcp"`,
    },
  });

async function context(req) {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const p = verifyAccess(bearer);
  if (!p?.u) return null;
  const u = await query("select email::text as email from users where id=$1", [p.u]);
  if (!u.length) return null;
  return { entity: await ensureUserEntity(p.u), email: u[0].email, userId: p.u };
}

export async function POST(req) {
  const ctx = await context(req);
  if (!ctx) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body) return Response.json(rpcErr(null, -32700, "invalid JSON"), { status: 400 });

  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of batch) {
    const r = await dispatch(m, ctx);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0]);
}

// A bare GET is how clients probe for auth before opening a stream.
export async function GET(req) {
  const ctx = await context(req);
  if (!ctx) return unauthorized();
  return Response.json({ ok: true, server: "finops-books", entity: ctx.entity, tools: TOOLS.length });
}
