import { pool, query } from "../../../../lib/db";
import { SCHEMA_SQL, SEED_COMMITMENTS_SQL } from "../../../../lib/schema";

export const maxDuration = 60;

const TYPE = (name) => ({ Assets: "assets", Liabilities: "liabilities", Equity: "equity", Income: "income", Expenses: "expenses" }[name.split(":")[0]]);

// Create the schema on first run. Managed Postgres may forbid `create extension`;
// fall back to built-ins (gen_random_uuid is native on PG13+, citext→text).
async function ensureSchema() {
  const r = await query("select to_regclass('public.transactions') as t");
  if (r[0].t) return "exists";
  try {
    await pool().query(SCHEMA_SQL);
    return "created";
  } catch (e) {
    const sql = SCHEMA_SQL.replace(/create extension[^;]*;/gi, "").replace(/\bcitext\b/g, "text");
    await pool().query(sql);
    return "created-noext";
  }
}

// Admin-only bulk import — the one-door data path: your migrated ledger is POSTed
// straight into shipd's Postgres through the app that owns it (DATABASE_URL is
// wired in by shipd and never leaves the box). Token-gated (ADMIN_TOKEN).
async function _POST(req) {
  if (!process.env.ADMIN_TOKEN || req.headers.get("x-admin-token") !== process.env.ADMIN_TOKEN) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const action = b.action;

  try {
    if (action === "ensure") return Response.json({ ok: true, schema: await ensureSchema() });

    if (action === "status") {
      const c = await query(
        "select (select count(*) from transactions) as txns, (select count(*) from postings) as postings, (select count(*) from accounts) as accounts",
      );
      return Response.json({ ok: true, ...c[0] });
    }

    if (action === "seed") { await pool().query(SEED_COMMITMENTS_SQL); return Response.json({ ok: true, seeded: true }); }

    if (action === "reset") {
      await pool().query(
        "truncate transactions, postings, accounts, balance_assertions, decisions, vettings, reimbursement_requests, reimbursement_lines, recurring_commitments restart identity cascade",
      );
      return Response.json({ ok: true, reset: true });
    }

    if (action === "batch") {
      const { entity = "personal", name = "Personal", accounts = [], txns = [], balances = [] } = b;
      const client = await pool().connect();
      try {
        await client.query("begin");
        await client.query("set local finops.allow_mutation='on'");
        const ws = await client.query("insert into workspaces (slug,name) values ('vk','VK') on conflict (slug) do update set name=excluded.name returning id");
        const wsId = ws.rows[0].id;
        const ent = await client.query("insert into entities (workspace_id,slug,name) values ($1,$2,$3) on conflict (workspace_id,slug) do update set name=excluded.name returning id", [wsId, entity, name]);
        const entId = ent.rows[0].id;

        const acctId = {};
        const getAcct = async (nm) => {
          if (acctId[nm]) return acctId[nm];
          const r = await client.query("insert into accounts (entity_id,name,type) values ($1,$2,$3) on conflict (entity_id,name) do update set type=excluded.type returning id", [entId, nm, TYPE(nm)]);
          return (acctId[nm] = r.rows[0].id);
        };
        for (const a of accounts) await getAcct(a.name);

        let inserted = 0;
        for (const t of txns) {
          const tr = await client.query(
            "insert into transactions (id,entity_id,date,flag,payee,narration,tags,links,metadata,source_file) values ($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9) on conflict (id) do nothing returning id",
            [t.id, entId, t.date, (t.flag || "*").slice(0, 1), t.payee, t.narration || "", t.tags || [], t.meta || {}, t.source_file || null],
          );
          if (!tr.rows.length) continue;
          let pos = 0;
          for (const p of t.postings) await client.query("insert into postings (transaction_id,account_id,amount,currency,position) values ($1,$2,$3,'INR',$4)", [t.id, await getAcct(p.account), p.amount, pos++]);
          inserted++;
        }
        for (const bal of balances) await client.query("insert into balance_assertions (account_id,date,amount,currency) values ($1,$2,$3,'INR')", [await getAcct(bal.account), bal.date, bal.amount]);

        await client.query("commit");
        return Response.json({ ok: true, inserted, of: txns.length });
      } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
    }

    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export const POST = _POST;
