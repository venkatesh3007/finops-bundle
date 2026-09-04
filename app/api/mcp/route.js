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
import { query, pool } from "../../../lib/db";
import { ensureUserEntity } from "../../../lib/tenant";
import { verifyAccess, issuer } from "../../../lib/mcp-oauth";
import { listDrafts, getDraft, updateDraft, importDraft, fixRow, clearRowOverrides } from "../../../lib/statements/drafts";
import { classificationContext } from "../../../lib/statements-import";
import { reconcile } from "../../../lib/statements/reconcile";
import { listSourceRules, setSourceRule, resolveHome, accountIsOpen, matchableText } from "../../../lib/statements/source-rules";
import { resolveReclassify, splitMany, undoLastFiling } from "../../../lib/moves";

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
        // where the home account came from: a source rule, a per-statement
        // override, the built-in filename guess, or nothing yet
        account_source: d.meta?.account_source ?? (d.account ? "default" : null),
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
      // `i` is the row's own stable id, NOT its position. updateDraft and fixRow
      // both address by it, so handing back a position would silently edit the
      // neighbouring row.
      let rows = (d.rows || []).map((r, pos) => ({ i: r.i ?? pos + 1, date: r.date, desc: r.desc, amount: r.amount, balance: r.balance, account: r.account, source: r.source, corrected: r.corrected || undefined }));
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

      // MATCH MUST YIELD ROW IDS, not array positions. updateDraft addresses rows
      // by their stored 1-based `i`; forwarding the position wrote to the row
      // above every time, which is how 156 rows ended up one place out.
      const idx = Array.isArray(rows) && rows.length
        ? rows
        : match
          ? (d.rows || []).map((r, pos) => [r, r.i ?? pos + 1])
              .filter(([r]) => String(r.desc || "").toLowerCase().includes(match.toLowerCase()))
              .map(([, id]) => id)
          : [];
      if (!idx.length) throw new Error("nothing selected — pass row indexes, or a `match` that hits at least one row");

      const patch = {};
      for (const i of idx) patch[i] = account;
      await updateDraft(entity, statement_id, { row_accounts: patch });
      return { ok: true, updated: idx.length, account, rows: idx.slice(0, 40) };
    },
  },
  {
    name: "fix_row",
    title: "Correct a row's amount or remove it",
    description: "Correct what a row SAYS, not where it goes: set its amount, flip its sign, or drop a row the parser invented (a summary line read as a transaction, a description fragment turned into a duplicate). This changes the books, so it is only kept if the statement's arithmetic gets no worse — the reconciler decides, and a change that helps nothing is refused with the numbers that explain why. Use set_row_account for categorising; that moves the other leg and never touches amounts.",
    schema: {
      type: "object",
      properties: {
        statement_id: { type: "string" },
        row: { type: "number", description: "the row's `i` from statement_rows — its id, not its position" },
        action: { type: "string", enum: ["set_amount", "flip_sign", "drop"], description: "flip_sign when the printed balance moves the other way (a refund read as a charge); drop when the line is not a transaction at all" },
        amount: { type: "number", description: "set_amount only — negative for money out" },
        reason: { type: "string", description: "what the document says, recorded on the row" },
        force: { type: "boolean", description: "apply even though the reconciler sees no improvement. Only with the statement open in front of you — e.g. a printed total rounded to the rupee." },
      },
      required: ["statement_id", "row", "action"],
    },
    async run({ statement_id, row, action, amount, reason, force }, { entity }) {
      return await fixRow(entity, statement_id, { row, action, amount, reason, force: !!force });
    },
  },
  {
    name: "clear_row_overrides",
    title: "Undo manual categorisation",
    description: "Put manually categorised rows back where the RULES place them — decisions, regex, then payee history — and pick up any set_payee_rule made since. Use it when a batch of assignments went to the wrong rows, or to re-apply rules over earlier hand-picks. Rows the rules cannot place come back with no account, and import_statement will refuse them until they are set. Amounts are never touched.",
    schema: {
      type: "object",
      properties: {
        statement_id: { type: "string", description: "one statement; omit and pass all_statements to do the whole book" },
        all_statements: { type: "boolean", description: "clear manual picks on every not-yet-imported statement" },
      },
    },
    async run({ statement_id, all_statements }, { entity }) {
      if (!statement_id && !all_statements) throw new Error("pass a statement_id, or all_statements:true to do the whole book");
      return await clearRowOverrides(entity, { id: statement_id || null, all: !!all_statements });
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
    name: "list_decisions",
    title: "The payee rules in force",
    description: "Every learned payee → account rule, when it was made and why. Rules made deliberately carry a written rationale; ones the importer learned by itself are marked auto_learned — those are the ones to distrust if a categorisation pass went wrong, because a mis-assigned row teaches a wrong rule that then re-fires on every later classification.",
    schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "only rules pointing at this account" },
        auto_learned_only: { type: "boolean", description: "only rules the importer taught itself" },
      },
    },
    async run({ account, auto_learned_only }, { entity }) {
      const rows = await query(
        `select replace(d.key,'payee:','') as payee, d.decision as account, d.rationale,
                to_char(d.decided_at,'YYYY-MM-DD HH24:MI') as decided_at
           from decisions d join entities e on e.id=d.entity_id
          where e.slug=$1 and d.key like 'payee:%' ${account ? "and d.decision=$2" : ""}
          order by d.decided_at, payee`,
        account ? [entity, account] : [entity]);
      const AUTO = /picked while importing a statement/i;
      const out = rows.map((r) => ({ ...r, auto_learned: AUTO.test(r.rationale || "") }))
                      .filter((r) => (auto_learned_only ? r.auto_learned : true));
      return { rules: out, count: out.length, auto_learned: out.filter((r) => r.auto_learned).length };
    },
  },
  {
    name: "forget_payee_rule",
    title: "Delete payee rules",
    description: "Remove learned payee → account rules. Deleting is usually better than correcting one you are unsure of: with the rule gone the row is reclassified from history and the frontier, and anything still uncertain surfaces for a decision instead of inheriting a guess. Existing postings are untouched — this only changes how future classification runs.",
    schema: {
      type: "object",
      properties: {
        payees: { type: "array", items: { type: "string" }, description: "exact payees from list_decisions" },
        auto_learned_to_account: { type: "string", description: "instead: delete every AUTO-LEARNED rule pointing at this account (e.g. Expenses:EMI). Deliberate rules with a written rationale are kept." },
      },
    },
    async run({ payees, auto_learned_to_account }, { entity }) {
      if (!payees?.length && !auto_learned_to_account)
        throw new Error("pass `payees`, or `auto_learned_to_account` to purge what the importer taught itself");
      const rows = auto_learned_to_account
        ? await query(
            `delete from decisions d using entities e
              where e.id=d.entity_id and e.slug=$1 and d.key like 'payee:%'
                and d.decision=$2 and d.rationale ilike '%picked while importing a statement%'
              returning replace(d.key,'payee:','') as payee, d.decision as account`, [entity, auto_learned_to_account])
        : await query(
            `delete from decisions d using entities e
              where e.id=d.entity_id and e.slug=$1 and d.key = any($2::text[])
              returning replace(d.key,'payee:','') as payee, d.decision as account`,
            [entity, payees.map((p) => `payee:${p}`)]);
      return { forgotten: rows, count: rows.length };
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
    name: "list_unfiled",
    title: "Line items still to be filed",
    description: "Everything posted but not yet put on a shelf. Grouped by payee it is the efficient view — one decision covers every row of that payee — and `detail` lists the rows themselves when a payee needs looking at one by one. A payee already spread across several accounts is shown as such, because those rarely take a single answer.",
    schema: {
      type: "object",
      properties: {
        month: { type: "string", description: "YYYY-MM; omit for the whole book" },
        payee: { type: "string", description: "just this payee, listed row by row" },
        detail: { type: "boolean", description: "list rows instead of grouping by payee" },
        limit: { type: "number", description: "default 40" },
      },
    },
    async run({ month, payee, detail, limit = 40 }, { entity }) {
      const lim = Math.min(Number(limit) || 40, 200);
      const where = [`e.slug=$1`, `coalesce(v.status,'unvetted') <> 'ok'`];
      const args = [entity];
      if (month) { args.push(month); where.push(`to_char(t.date,'YYYY-MM')=$${args.length}`); }
      if (payee) { args.push(payee); where.push(`t.payee=$${args.length}`); }

      if (payee || detail) {
        const rows = await query(
          `select t.id, to_char(t.date,'YYYY-MM-DD') date, t.payee, left(t.narration,90) narration,
                  a.name account, p.amount, t.tags
             from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
             left join vettings v on v.transaction_id=t.id join entities e on e.id=t.entity_id
            where ${where.join(" and ")} and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
            order by t.date, t.id limit ${lim}`, args);
        return { rows, count: rows.length };
      }
      const groups = await query(
        `select t.payee, count(distinct t.id)::int items, round(sum(abs(p.amount))::numeric,0) total,
                array_agg(distinct a.name) sitting_on
           from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
           left join vettings v on v.transaction_id=t.id join entities e on e.id=t.entity_id
          where ${where.join(" and ")} and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
          group by 1 order by 2 desc limit ${lim}`, args);
      const tot = await query(
        `select count(distinct t.id)::int n from transactions t left join vettings v on v.transaction_id=t.id
           join entities e on e.id=t.entity_id where ${where.filter((w) => !w.startsWith("a.name")).join(" and ")}`, args);
      return { payees: groups, shown: groups.length, line_items_waiting: tot[0]?.n ?? null };
    },
  },
  {
    name: "file_rows",
    title: "Put rows on a shelf",
    description: "File line items to an account — every row of a payee at once, or a specific set by id. This is the batch that makes categorising practical: one call for all 158 rows of a payee instead of 158. The account must already be open (open_account first). Nothing is guessed: rows go exactly where you say.",
    schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "where they belong — an account from list_accounts" },
        payee: { type: "string", description: "file every unfiled row of this payee" },
        ids: { type: "array", items: { type: "string" }, description: "instead: specific transaction ids from list_unfiled" },
        month: { type: "string", description: "with `payee`, limit to one month (YYYY-MM)" },
        dry_run: { type: "boolean", description: "report what would move without moving it" },
      },
      required: ["account"],
    },
    async run({ account, payee, ids, month, dry_run }, { entity }) {
      if (!payee && !(ids || []).length) throw new Error("give a `payee` or a list of `ids`");
      if (!(await accountIsOpen(entity, account))) throw new Error(`${account} is not open — use open_account first.`);
      const args = [entity], where = [`e.slug=$1`, `coalesce(v.status,'unvetted') <> 'ok'`];
      if (payee) { args.push(payee); where.push(`t.payee=$${args.length}`); }
      if (ids?.length) { args.push(ids); where.push(`t.id = any($${args.length}::uuid[])`); }
      if (month) { args.push(month); where.push(`to_char(t.date,'YYYY-MM')=$${args.length}`); }
      const rows = await query(
        `select distinct t.id, a.name account, p.amount
           from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
           left join vettings v on v.transaction_id=t.id join entities e on e.id=t.entity_id
          where ${where.join(" and ")} and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
            and a.name <> $${args.push(account)}`, args);
      if (!rows.length) return { filed: 0, note: "nothing unfiled matches that — it may already be on this shelf" };
      if (dry_run) return { would_file: rows.length, to: account, from: [...new Set(rows.map((r) => r.account))], sample: rows.slice(0, 5) };

      const done = [], failed = [];
      for (const r of rows) {
        try { await resolveReclassify(entity, { txnId: r.id, fromAccount: r.account, toAccount: account, makeRule: false }); done.push(r.id); }
        catch (e) { failed.push({ id: r.id, error: String(e.message || e).slice(0, 120) }); }
      }
      return { filed: done.length, to: account, failed: failed.length ? failed.slice(0, 10) : undefined };
    },
  },
  {
    name: "split_row",
    title: "Split one row across shelves",
    description: "Send parts of a single line item to different accounts in one decision. Whatever is not named stays where it is; if the parts add up exactly the row is filed. Refuses parts totalling more than the row.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "transaction id from list_unfiled" },
        from: { type: "string", description: "the account it is on now" },
        parts: { type: "array", description: "[{account, amount}, …]",
                 items: { type: "object", properties: { account: { type: "string" }, amount: { type: "number" } }, required: ["account", "amount"] } },
      },
      required: ["id", "from", "parts"],
    },
    async run({ id, from, parts }, { entity }) {
      return await splitMany(entity, { txnId: id, fromAccount: from, parts });
    },
  },
  {
    name: "unfile",
    title: "Undo a filing",
    description: "Put a line item back the way it was and return it to the unfiled list. Walks back one step, so calling it twice undoes two.",
    schema: { type: "object", properties: { id: { type: "string", description: "transaction id" } }, required: ["id"] },
    async run({ id }, { entity }) { return await undoLastFiling(entity, { txnId: id }); },
  },
  {
    name: "tag_rows",
    title: "Tag line items",
    description: "Label rows with a tag — a trip, a project, a person — without changing where they are filed. This is the right tool for an occasion: tag a Goa trip #goa-sep-2026 and the flights stay on Expenses:Travel:Flights where they accumulate across every trip, instead of growing a new account subtree per trip. Tags are additive; the same row can carry several.",
    schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "e.g. goa-sep-2026 (a leading # is optional)" },
        ids: { type: "array", items: { type: "string" }, description: "transaction ids" },
        payee: { type: "string", description: "instead: every row of this payee" },
        month: { type: "string", description: "narrow to one month (YYYY-MM)" },
        remove: { type: "boolean", description: "take the tag off instead of putting it on" },
      },
      required: ["tag"],
    },
    async run({ tag, ids, payee, month, remove }, { entity }) {
      const t = String(tag).replace(/^#/, "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t)) throw new Error(`"${tag}" is not a usable tag — letters, digits, dot, dash and underscore`);
      if (!payee && !(ids || []).length) throw new Error("give a `payee` or a list of `ids`");
      const args = [entity], where = [`e.slug=$1`];
      if (payee) { args.push(payee); where.push(`t.payee=$${args.length}`); }
      if (ids?.length) { args.push(ids); where.push(`t.id = any($${args.length}::uuid[])`); }
      if (month) { args.push(month); where.push(`to_char(t.date,'YYYY-MM')=$${args.length}`); }
      args.push(t);
      const sql = remove
        // Only touch rows that actually carry it — otherwise every row matching
        // the filter is rewritten for nothing and the count reports rows matched
        // rather than rows changed.
        ? `update transactions t set tags = array_remove(coalesce(t.tags,'{}'), $${args.length})
             from entities e where e.id=t.entity_id and ${where.join(" and ")}
               and coalesce(t.tags,'{}') @> array[$${args.length}] returning t.id`
        : `update transactions t set tags = (select array_agg(distinct x) from unnest(coalesce(t.tags,'{}') || $${args.length}::text) x)
             from entities e where e.id=t.entity_id and ${where.join(" and ")} and not (coalesce(t.tags,'{}') @> array[$${args.length}]) returning t.id`;
      // A tag changes no amount and no account, so it is not the kind of edit the
      // append-only guard exists to stop — but the guard watches every UPDATE on
      // transactions, so it has to be told. SET LOCAL inside one transaction: a
      // pooled query would set the flag on a connection that then does no work.
      const client = await pool().connect();
      try {
        await client.query("begin");
        await client.query("set local finops.allow_mutation = 'on'");
        const r = await client.query(sql, args);
        await client.query("commit");
        return { tag: t, [remove ? "untagged" : "tagged"]: r.rowCount };
      } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
      finally { client.release(); }
    },
  },
  {
    name: "list_tags",
    title: "Tags and what they cost",
    description: "Every tag in the book with how many rows carry it and what they add up to — so a trip or a project has a total without needing its own account subtree. Pass a tag to list its rows.",
    schema: { type: "object", properties: { tag: { type: "string", description: "list the rows carrying this tag" } } },
    async run({ tag }, { entity }) {
      if (tag) {
        const t = String(tag).replace(/^#/, "").trim();
        const rows = await query(
          `select to_char(t.date,'YYYY-MM-DD') date, t.payee, a.name account, p.amount
             from transactions t join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
             join entities e on e.id=t.entity_id
            where e.slug=$1 and coalesce(t.tags,'{}') @> array[$2]
              and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
            order by t.date limit 200`, [entity, t]);
        return { tag: t, rows, count: rows.length, total: Math.round(rows.reduce((s, r) => s + Math.abs(Number(r.amount)), 0) * 100) / 100 };
      }
      const tags = await query(
        `select x tag, count(distinct t.id)::int items, round(sum(abs(p.amount))::numeric,0) total
           from transactions t join lateral unnest(coalesce(t.tags,'{}')) x on true
           join postings p on p.transaction_id=t.id join accounts a on a.id=p.account_id
           join entities e on e.id=t.entity_id
          where e.slug=$1 and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
          group by 1 order by 3 desc`, [entity]);
      return { tags, count: tags.length };
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
    name: "list_source_rules",
    title: "Where each kind of statement posts from",
    description: "The home-account rules in force, by parser kind, and whether the built-in filename guess still applies to that kind. The home account is the leg every row posts FROM — the bank or card the statement belongs to.",
    schema: { type: "object", properties: {} },
    async run(_a, { entity }) {
      const rules = await listSourceRules(entity);
      const kinds = {};
      for (const r of rules) {
        kinds[r.kind] ||= { rules: [], default_rule: null, builtin_guess_in_force: false };
        if (r.match) kinds[r.kind].rules.push({ match: r.match, account: r.account });
        else kinds[r.kind].default_rule = r.account;
      }
      // A kind with no rule at all still falls back to the filename guess.
      const seen = await query(
        `select distinct d.kind from statement_drafts d join entities e on e.id = d.entity_id where e.slug=$1 and d.kind is not null`, [entity]);
      for (const { kind } of seen) if (!kinds[kind]) kinds[kind] = { rules: [], default_rule: null, builtin_guess_in_force: true };
      return { kinds, rule_count: rules.length };
    },
  },
  {
    name: "set_source_rule",
    title: "Set where a kind of statement posts from",
    description: "Teach the books that statements of a kind post from an account, so every future upload lands on the right side of the balance sheet. A rule with `match` applies only to statements whose filename or extracted text contains it; a rule without `match` is the default for that kind. Once a kind has any rule, the built-in guess is ignored: a statement matching no rule gets no home account and cannot be imported until set_statement_account is called. Never touches amounts, counter-legs or reconciliation.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "a parser kind from list_statements: primary, fed, idbi" },
        account: { type: "string", description: "an account from list_accounts — must already be open" },
        match: { type: "string", description: "optional substring, case-insensitive, tested against the filename and the full extracted statement text (header included, not only rows). Omit to set the kind default." },
        apply_to_existing: { type: "boolean", description: "also re-home every not-yet-imported statement of this kind that this rule selects (default false)" },
        remove: { type: "boolean", description: "delete the rule identified by kind+match instead of setting it" },
      },
      required: ["kind", "account"],
    },
    async run({ kind, account, match, apply_to_existing, remove }, { entity }) {
      const rule = await setSourceRule(entity, { kind, account, match, remove: !!remove });
      const rules = await listSourceRules(entity);
      const out = { rule, rules_for_kind: rules.filter((r) => r.kind === kind), applied: [], ambiguous: [], skipped_imported: [] };
      if (!apply_to_existing || remove) return out;

      const ds = await query(
        `select d.id, d.filename, d.account, d.status, d.meta from statement_drafts d
           join entities e on e.id = d.entity_id where e.slug=$1 and d.kind=$2`, [entity, kind]);
      for (const d of ds) {
        if (d.status === "imported") { out.skipped_imported.push(d.id); continue; }
        const home = resolveHome(rules, { kind, filename: d.filename, text: matchableText(d) });
        if (home.ambiguous) { out.ambiguous.push({ statement_id: d.id, filename: d.filename, matched_rules: home.matched.map((r) => r.match) }); continue; }
        if (!home.account || home.account === d.account) continue;
        await query(
          `update statement_drafts set account=$3, meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('account_source','rule'), updated_at=now() where id=$1 and entity_id=(select id from entities where slug=$2)`,
          [d.id, entity, home.account]);
        out.applied.push({ statement_id: d.id, filename: d.filename, account_before: d.account, account_after: home.account });
      }
      return out;
    },
  },
  {
    name: "set_statement_account",
    title: "Re-home one statement",
    description: "Change the account one statement posts from — the home leg of every row. Changes where the statement's own balance is reported, never how much or where the other side goes. Refuses if the statement has already been imported; that is a ledger correction, not a staging change.",
    schema: {
      type: "object",
      properties: {
        statement_id: { type: "string", description: "id from list_statements" },
        account: { type: "string", description: "an account from list_accounts — must already be open" },
      },
      required: ["statement_id", "account"],
    },
    async run({ statement_id, account }, { entity }) {
      const d = await getDraft(entity, statement_id);
      if (!d) throw new Error("no such statement");
      if (d.status === "imported")
        throw new Error(`${d.filename} is already imported — re-homing it now would leave the ledger disagreeing with the statement. That is a ledger correction, not a staging change.`);
      if (!(await accountIsOpen(entity, account))) throw new Error(`${account} is not open — use open_account first.`);
      await query(
        `update statement_drafts set account=$3, meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('account_source','override'), updated_at=now()
          where id=$1 and entity_id=(select id from entities where slug=$2)`, [statement_id, entity, account]);
      return { statement_id, filename: d.filename, kind: d.kind, account_before: d.account, account_after: account, rows: (d.rows || []).length, status: d.status };
    },
  },
  {
    name: "unimport_statement",
    title: "Take a statement back out of the ledger",
    description: "Remove a statement's posted transactions and return it to staging, so its rows can be recategorised and imported again. The ledger is append-only for edits — this is a whole-statement withdrawal, not a partial one, and it is the supported way to correct categories after import: withdraw, fix the rows, import again. Amounts and reconciliation are untouched; re-import is idempotent on (file, row id), so nothing doubles.",
    schema: {
      type: "object",
      properties: {
        statement_id: { type: "string", description: "id from list_statements" },
        all_of_account: { type: "string", description: "instead of one statement: withdraw every imported statement homed to this account" },
      },
    },
    async run({ statement_id, all_of_account }, { entity }) {
      if (!statement_id && !all_of_account) throw new Error("pass a statement_id, or all_of_account to withdraw a whole account");
      const ds = await query(
        all_of_account
          ? `select d.id, d.filename, d.kind from statement_drafts d join entities e on e.id=d.entity_id where e.slug=$1 and d.status='imported' and d.account=$2`
          : `select d.id, d.filename, d.kind from statement_drafts d join entities e on e.id=d.entity_id where e.slug=$1 and d.id=$2 and d.status='imported'`,
        [entity, all_of_account || statement_id]);
      if (!ds.length) throw new Error("nothing imported matches that — check list_statements");

      const out = [];
      const client = await pool().connect();
      try {
        // The append-only guard blocks edits to posted rows on purpose. A
        // deliberate, whole-statement withdrawal is what its finops.allow_mutation
        // escape hatch is for — and it has to be SET LOCAL inside one transaction,
        // because a pooled query would land on a different connection.
        await client.query("begin");
        await client.query("set local finops.allow_mutation = 'on'");
        for (const d of ds) {
          // the same path importStatement writes as source_file
          const path = `statements/${entity}/${d.kind || "other"}/${String(d.filename).replace(/[^A-Za-z0-9._ -]/g, "_")}`;
          const r = await client.query(
            "delete from transactions where entity_id=(select id from entities where slug=$1) and source_file=$2", [entity, path]);
          await client.query("update statement_drafts set status='ready', result=null, updated_at=now() where id=$1", [d.id]);
          out.push({ statement_id: d.id, filename: d.filename, transactions_removed: r.rowCount });
        }
        await client.query("commit");
      } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
      finally { client.release(); }
      return { withdrawn: out, total_transactions_removed: out.reduce((t, x) => t + x.transactions_removed, 0) };
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
      if (!d.account)
        throw new Error("no home account — set_source_rule or set_statement_account first");
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
