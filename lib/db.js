// Postgres data layer for the re-platform. Returns the SAME shapes as the
// Beancount layer (lib/ledger.js) so pages, MCP tools, filterTxns() and
// balances() work unchanged — only the SOURCE of the transactions changes.
//
// Gated by DATA_BACKEND=postgres (see loadEntity in ledger.js). The books were
// migrated 1:1 by scripts/import_beancount.py (verified to the paisa).
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql:///finops";

// One pool per process. lazy so importing this module never opens a socket.
let _pool = null;
export function pool() {
  if (!_pool) _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  return _pool;
}

export async function query(text, params) {
  const r = await pool().query(text, params);
  return r.rows;
}

const num = (v) => (v == null ? null : Number(v));
const withHash = (t) => (t.startsWith("#") ? t : "#" + t);

// Load one entity's whole book as { txns, opens, asserts } — identical shape to
// ledger.js parseBook(). Amounts are JS numbers; tags carry the leading '#' the
// Beancount parser produced so filterTxns()'s tag match is unchanged.
export async function loadEntityFromDb(entity) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(entity)) throw new Error(`bad entity: ${entity}`);
  const ent = await query("select id from entities where slug = $1", [entity]);
  if (!ent.length) throw new Error(`no ledger for ${entity}`);
  const entId = ent[0].id;

  const rows = await query(
    `select t.id, to_char(t.date,'YYYY-MM-DD') as date, t.flag, t.payee, t.narration,
            t.tags, t.metadata, t.source_file,
            a.name as account, p.amount, p.currency, p.position
       from transactions t
       join postings p on p.transaction_id = t.id
       join accounts a on a.id = p.account_id
      where t.entity_id = $1
      order by t.date, t.id, p.position`,
    [entId],
  );

  const byId = new Map();
  for (const r of rows) {
    let t = byId.get(r.id);
    if (!t) {
      t = {
        id: r.id, date: r.date, flag: r.flag, payee: r.payee, narration: r.narration || "",
        tags: (r.tags || []).map(withHash), meta: r.metadata || {}, postings: [],
        source_file: r.source_file || null,
      };
      byId.set(r.id, t);
    }
    t.postings.push({ account: r.account, amount: num(r.amount), currency: r.currency });
  }
  const txns = [...byId.values()];

  const openRows = await query("select name from accounts where entity_id = $1", [entId]);
  const opens = new Set(openRows.map((r) => r.name));

  const assertRows = await query(
    `select a.name as account, to_char(b.date,'YYYY-MM-DD') as date, b.amount, b.currency
       from balance_assertions b join accounts a on a.id = b.account_id
      where a.entity_id = $1 order by b.date`,
    [entId],
  );
  const asserts = assertRows.map((r) => ({ account: r.account, date: r.date, amount: num(r.amount), currency: r.currency }));

  return { txns, opens, asserts };
}

// Which entities exist (replaces globbing ledger/*/).
export async function listEntities() {
  return (await query("select slug, name from entities order by slug")).map((r) => ({ slug: r.slug, name: r.name }));
}
