// Server side of browser statement import. The browser parsed + classified;
// this module only validates, dedupes and writes append-only entries to the
// Postgres ledger — no LLM, no file parsing here.
//
// Invariants kept from the Beancount ingest: idempotent dedupe on
// (date, amount, description-prefix) against the statement account; opening
// seed when the account has no history; a closing-balance assertion whose
// arithmetic is CHECKED before commit (the bean-check equivalent) — on a
// mismatch we roll back unless force=true, in which case entries land and the
// assertion is recorded so the gap is visible in reconciliation.
import { query, pool } from "./db.js";
import { rowKey, normalizeDesc } from "./statements/parse.js";

const TYPE = (name) => ({ Assets: "assets", Liabilities: "liabilities", Equity: "equity", Income: "income", Expenses: "expenses" }[name.split(":")[0]]);
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const ACCOUNT_RE = /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z0-9][A-Za-z0-9-]*)+$/;

async function entityId(slug) {
  const rows = await query("select id from entities where slug=$1", [slug]);
  if (!rows.length) throw new Error(`no entity ${slug}`);
  return rows[0].id;
}

async function accountId(client, entId, name) {
  const r = await client.query("select id from accounts where entity_id=$1 and name=$2", [entId, name]);
  if (r.rows.length) return r.rows[0].id;
  const ins = await client.query("insert into accounts (entity_id, name, type) values ($1,$2,$3) returning id", [entId, name, TYPE(name)]);
  return ins.rows[0].id;
}

// What the browser needs to classify deterministically before asking the model.
export async function classificationContext(entity) {
  const entId = await entityId(entity);
  const accounts = (await query("select name from accounts where entity_id=$1 and close_date is null order by name", [entId])).map((r) => r.name);
  const decisions = {};
  for (const d of await query("select key, decision from decisions where entity_id=$1 and key like 'payee:%'", [entId])) decisions[d.key.slice(6)] = d.decision;
  // learned from history: for each payee, the counter-account it most often posts to
  const hist = await query(
    `select t.payee, a.name as account, count(*)::int as n
       from transactions t
       join postings p on p.transaction_id=t.id
       join accounts a on a.id=p.account_id
      where t.entity_id=$1 and t.corrects_id is null and t.payee is not null
        and a.name not like 'Assets:Bank:%' and a.name not like 'Liabilities:Card:%'
      group by t.payee, a.name
      having count(*) >= 2
      order by t.payee, n desc`, [entId]);
  const history = {};
  for (const h of hist) if (!history[h.payee]) history[h.payee] = { account: h.account, n: h.n };
  const stmtAccounts = (await query(
    `select a.name, count(p.id)::int as postings, max(t.date)::text as last_date
       from accounts a left join postings p on p.account_id=a.id left join transactions t on t.id=p.transaction_id
      where a.entity_id=$1 and (a.name like 'Assets:Bank:%' or a.name like 'Liabilities:Card:%')
      group by a.name order by a.name`, [entId]));
  const rules = await extractionRules(entity, entId);
  return { entity, accounts, decisions, history, regex: [], statement_accounts: stmtAccounts, rules };
}

// Free-text operator rules that persist per entity and are fed into the AI
// extraction prompt (e.g. "for foreign-currency card rows, use the INR amount").
// Stored in the same decisions table as classification decisions.
export const EXTRACTION_RULES_KEY = "rules:extract";

export async function extractionRules(entity, entId = null) {
  const id = entId || (await entityId(entity));
  const r = await query("select decision from decisions where entity_id=$1 and key=$2", [id, EXTRACTION_RULES_KEY]);
  return r.length ? r[0].decision : "";
}

export async function saveExtractionRules(entity, rules) {
  const entId = await entityId(entity);
  await query(
    `insert into decisions (entity_id, key, decision, rationale)
     values ($1,$2,$3,'operator extraction rules')
     on conflict (entity_id,key) do update set decision=excluded.decision`,
    [entId, EXTRACTION_RULES_KEY, String(rules || "").slice(0, 4000)],
  );
  return true;
}

// rows: [{ date, desc, amount, balance?, payee, account, source, rule, confidence, flag }]
export async function importStatement(entity, { filename, sha256, bytes, account, kind, model, rows, force = false, userEmail }) {
  if (!ACCOUNT_RE.test(account || "")) throw new Error(`bad statement account: ${account}`);
  if (!Array.isArray(rows) || !rows.length) throw new Error("no rows");
  if (rows.length > 5000) throw new Error("too many rows (max 5000)");
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || "")) throw new Error(`bad date on row: ${JSON.stringify(r).slice(0, 80)}`);
    if (!(Math.abs(Number(r.amount)) > 0 && Math.abs(Number(r.amount)) < 1e10)) throw new Error(`bad amount on row ${r.date}`);
    if (!ACCOUNT_RE.test(r.account || "")) throw new Error(`bad counter account "${r.account}" on row ${r.date}`);
    if (r.account === account) throw new Error(`row ${r.date} posts to the statement account itself`);
  }
  const entId = await entityId(entity);
  const isCard = account.startsWith("Liabilities:Card:");
  const balSign = isCard ? -1 : 1;
  const path = `statements/${entity}/${kind || "other"}/${String(filename).replace(/[^A-Za-z0-9._ -]/g, "_")}`;

  const client = await pool().connect();
  try {
    await client.query("begin");
    const stmtAcct = await accountId(client, entId, account);

    // existing keys on this account (idempotent re-import)
    const ex = await client.query(
      `select to_char(t.date,'YYYY-MM-DD') as date, p.amount, t.narration, t.payee
         from postings p join transactions t on t.id=p.transaction_id
        where p.account_id=$1 and p.currency='INR'`, [stmtAcct]);
    const existing = new Set(ex.rows.map((r) => `${r.date}|${Number(r.amount).toFixed(2)}|${normalizeDesc(r.narration || r.payee || "")}`));
    const hadPostings = ex.rows.length > 0;

    await client.query(
      `insert into documents (entity_id, path, sha256, bytes, kind, metadata)
       values ($1,$2,$3,$4,'statement',$5) on conflict (entity_id, path) do update set sha256=excluded.sha256, bytes=excluded.bytes, metadata=excluded.metadata`,
      [entId, path, sha256 || null, bytes || null, { account, model: model || null, uploaded_by: userEmail || null, rows: rows.length, parsed_in: "browser" }]);

    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const balRows = sorted.filter((r) => r.balance != null);
    const txnIds = []; let skipped = 0, flagged = 0;

    // opening seed for a brand-new account so the closing assertion can hold
    if (!hadPostings && balRows.length) {
      const f = balRows[0];
      const opening = r2(balSign * Number(f.balance) - Number(f.amount));
      if (Math.abs(opening) >= 0.01) {
        const d = new Date(f.date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1);
        const t = await client.query(
          `insert into transactions (entity_id, date, flag, payee, narration, metadata, source_file) values ($1,$2,'*','Opening Balance',$3,$4,$5) returning id`,
          [entId, d.toISOString().slice(0, 10), `seeded from ${filename}`, { file: path, seed: true }, path]);
        const eq = await accountId(client, entId, "Equity:Opening");
        await client.query("insert into postings (transaction_id, account_id, amount, currency, position) values ($1,$2,$3,'INR',0)", [t.rows[0].id, stmtAcct, opening]);
        await client.query("insert into postings (transaction_id, account_id, amount, currency, position) values ($1,$2,$3,'INR',1)", [t.rows[0].id, eq, -opening]);
        txnIds.push(t.rows[0].id);
      }
    }

    for (const r of sorted) {
      const key = rowKey(r);
      if (existing.has(key)) { skipped++; continue; }
      existing.add(key);
      const amt = r2(r.amount);
      const flag = r.flag === "!" ? "!" : "*";
      if (flag === "!") flagged++;
      const meta = { file: path, classified_by: r.source || null, rule: r.rule || null, confidence: r.confidence ?? null, imported_by: userEmail || null };
      if (r.sign_flipped) meta.sign_flipped = true;
      const t = await client.query(
        `insert into transactions (entity_id, date, flag, payee, narration, metadata, source_file) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [entId, r.date, flag, String(r.payee || "Statement").slice(0, 60), String(r.desc || "").slice(0, 400), meta, path]);
      const tid = t.rows[0].id;
      const counter = await accountId(client, entId, r.account);
      await client.query("insert into postings (transaction_id, account_id, amount, currency, position) values ($1,$2,$3,'INR',0)", [tid, stmtAcct, amt]);
      await client.query("insert into postings (transaction_id, account_id, amount, currency, position) values ($1,$2,$3,'INR',1)", [tid, counter, -amt]);
      await client.query("insert into vettings (transaction_id, status) values ($1,'unvetted') on conflict do nothing", [tid]);
      txnIds.push(tid);
    }

    // closing-balance assertion, CHECKED against the ledger (bean-check equivalent).
    // Nothing new appended (a re-upload) → the assertion is already on file; don't duplicate it.
    let assertion = null;
    if (balRows.length && txnIds.length) {
      const last = balRows[balRows.length - 1];
      const expected = r2(balSign * Number(last.balance));
      const d = new Date(last.date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
      const asOf = d.toISOString().slice(0, 10);
      const bal = await client.query(
        `select coalesce(sum(p.amount),0) as bal from postings p join transactions t on t.id=p.transaction_id
          where p.account_id=$1 and p.currency='INR' and t.date < $2`, [stmtAcct, asOf]);
      const actual = r2(bal.rows[0].bal);
      const ok = Math.abs(actual - expected) < 0.01;
      assertion = { date: asOf, expected, actual, diff: r2(actual - expected), ok };
      if (!ok && !force) {
        await client.query("rollback");
        return { ok: false, reason: "assertion_mismatch", assertion, appended: 0, skipped_dupes: skipped, would_append: txnIds.length,
          hint: `After import the ledger says ${account} = ₹${actual.toLocaleString("en-IN")} on ${asOf} but the statement closes at ₹${expected.toLocaleString("en-IN")} (off by ₹${Math.abs(actual - expected).toLocaleString("en-IN")}). Usually a missing earlier statement or duplicate lines. Import anyway to record the gap, or fix the earlier period first.` };
      }
      await client.query("insert into balance_assertions (account_id, date, amount, currency, source_file) values ($1,$2,$3,'INR',$4)", [stmtAcct, asOf, expected, path]);
    }

    await client.query("commit");
    return { ok: true, appended: txnIds.length, skipped_dupes: skipped, flagged, assertion, document: path, txn_ids: txnIds };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}
