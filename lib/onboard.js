// Onboarding for a fresh, empty workspace: seed a playable demo. (A user's own
// statement goes through /import — parsed + classified in the browser.) Writes
// real double-entry txns into the CALLER's entity only (session-resolved).
import { pool, query } from "./db.js";

const TYPE = (name) =>
  ({ Assets: "assets", Liabilities: "liabilities", Equity: "equity", Income: "income", Expenses: "expenses" }[name.split(":")[0]] || "expenses");

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}
async function acctId(client, entId, name) {
  const r = await client.query("select id from accounts where entity_id=$1 and name=$2", [entId, name]);
  if (r.rows.length) return r.rows[0].id;
  const ins = await client.query("insert into accounts (entity_id,name,type) values ($1,$2,$3) returning id", [entId, name, TYPE(name)]);
  return ins.rows[0].id;
}
async function post(client, entId, { date, payee, narration = "", legs, meta = {} }) {
  const sum = legs.reduce((s, l) => s + l.amount, 0);
  if (Math.abs(sum) > 0.005) throw new Error("unbalanced entry");
  const t = await client.query(
    "insert into transactions (entity_id,date,flag,payee,narration,metadata) values ($1,$2,'*',$3,$4,$5) returning id",
    [entId, date, payee, narration, meta],
  );
  const tid = t.rows[0].id;
  let pos = 0;
  for (const l of legs) {
    const aid = await acctId(client, entId, l.account);
    await client.query("insert into postings (transaction_id,account_id,amount,currency,position) values ($1,$2,$3,'INR',$4)", [tid, aid, l.amount, pos++]);
  }
  return tid;
}

// A small, realistic 2-month demo warehouse so the game is instantly playable —
// fixed in/out, variable, an unsorted "Other" pile, and one reimbursable (a
// customer at the counter). Idempotent: refuses to seed a non-empty entity.
export async function seedSample(entity) {
  const entId = await entityId(entity);
  const c = await query("select count(*)::int n from transactions where entity_id=$1", [entId]);
  if (c[0].n > 0) return { skipped: true, existing: c[0].n };
  const client = await pool().connect();
  const bank = "Assets:Bank";
  try {
    await client.query("begin");
    let n = 0;
    for (const m of ["2026-07", "2026-08"]) {
      await post(client, entId, { date: `${m}-01`, payee: "ACME Payroll", narration: "SALARY CREDIT — ACME PAYROLL", legs: [{ account: bank, amount: 120000 }, { account: "Income:Salary", amount: -120000 }] });
      await post(client, entId, { date: `${m}-03`, payee: "Landlord", narration: "NEFT RENT", legs: [{ account: "Expenses:Rent", amount: 35000 }, { account: bank, amount: -35000 }] });
      await post(client, entId, { date: `${m}-05`, payee: "Netflix", narration: "NETFLIX.COM MUMBAI", legs: [{ account: "Expenses:Subscriptions", amount: 649 }, { account: bank, amount: -649 }] });
      await post(client, entId, { date: `${m}-06`, payee: "Airtel", narration: "AIRTEL POSTPAID", legs: [{ account: "Expenses:Utilities", amount: 999 }, { account: bank, amount: -999 }] });
      await post(client, entId, { date: `${m}-08`, payee: "BigBasket", narration: "BIGBASKET GROCERIES", legs: [{ account: "Expenses:Groceries", amount: 6200 }, { account: bank, amount: -6200 }] });
      await post(client, entId, { date: `${m}-12`, payee: "Swiggy", narration: "SWIGGY ORDER 8842", legs: [{ account: "Expenses:Other", amount: 820 }, { account: bank, amount: -820 }] });
      await post(client, entId, { date: `${m}-19`, payee: "UPI", narration: "UPI/CAFE ROASTERY", legs: [{ account: "Expenses:Other", amount: 430 }, { account: bank, amount: -430 }] });
      await post(client, entId, { date: `${m}-15`, payee: "AWS", narration: "AWS CLOUD (billed to Acme)", legs: [{ account: "Assets:Receivable:Acme", amount: 9000 }, { account: bank, amount: -9000 }] });
      n += 8;
    }
    await client.query("commit");
    return { seeded: n };
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
}

// (The server-side CSV importer that used to live here is superseded by the
// browser-side statement import: app/import + lib/statements/* + /api/statements/import.)
