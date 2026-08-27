// Onboarding for a fresh, empty workspace: seed a playable demo, or import the
// user's own first bank statement (CSV). Both write real double-entry txns into
// the CALLER's entity only (the entity is resolved server-side from the session).
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

// ── CSV import ───────────────────────────────────────────────────────────────
// Split a CSV line respecting simple double-quotes.
function splitCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function normDate(s) {
  s = (s || "").trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) { // DD/MM/YYYY (Indian default)
    let [, d, mo, y] = m; if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{2,4})$/))) { // 05-Aug-2026 / 5 Aug 26
    let [, d, mon, y] = m; if (y.length === 2) y = "20" + y;
    const mm = MON[mon.toLowerCase()]; if (!mm) return null;
    return `${y}-${mm}-${d.padStart(2, "0")}`;
  }
  return null;
}
const num = (s) => { const v = Number(String(s || "").replace(/[₹,\s"]/g, "").replace(/[()]/g, "")); return Number.isFinite(v) ? v : null; };

// Detect columns from the header row; support signed-amount OR debit/credit pairs.
function planColumns(header) {
  const H = header.map((h) => h.toLowerCase());
  const find = (re) => H.findIndex((h) => re.test(h));
  const date = find(/date|txn date|value date|posted/);
  const amount = find(/^amount$|^amt$|^signed/);
  const debit = find(/debit|withdrawal|dr\b|paid out|out/);
  const credit = find(/credit|deposit|cr\b|paid in|in\b/);
  const desc = find(/desc|narration|particular|details|remark|payee|transaction|reference/);
  return { date, amount, debit, credit, desc };
}

export function parseCsvRows(csvText) {
  const lines = String(csvText || "").split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { rows: [], header: null, note: "empty file" };
  // find the header: first line whose cells include a 'date'-ish column
  let hi = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cells = splitCsvLine(lines[i]).map((c) => c.toLowerCase());
    if (cells.some((c) => /date/.test(c)) && cells.some((c) => /(amount|debit|credit|withdrawal|deposit|balance)/.test(c))) { hi = i; break; }
  }
  const header = splitCsvLine(lines[hi]);
  const plan = planColumns(header);
  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 2) continue;
    const date = normDate(plan.date >= 0 ? c[plan.date] : c[0]);
    let amount = null;
    if (plan.amount >= 0) amount = num(c[plan.amount]);
    else if (plan.debit >= 0 || plan.credit >= 0) {
      const dr = plan.debit >= 0 ? num(c[plan.debit]) : null;
      const cr = plan.credit >= 0 ? num(c[plan.credit]) : null;
      if (cr) amount = Math.abs(cr); else if (dr) amount = -Math.abs(dr);
    }
    const desc = (plan.desc >= 0 ? c[plan.desc] : c.filter((_, j) => j !== plan.date && j !== plan.amount).join(" ")).trim();
    if (date && amount != null && amount !== 0) rows.push({ date, amount, desc: desc || "Statement line" });
  }
  return { rows, header, plan };
}

// Import parsed rows into the caller's entity. Debits → Expenses:Other (the sort
// pile), credits → Income:Other, both against Assets:Bank. The matcher takes over.
export async function importCsv(entity, csvText) {
  const entId = await entityId(entity);
  const { rows, header } = parseCsvRows(csvText);
  if (!rows.length) return { imported: 0, skipped: 0, note: "no rows recognized — check the file has date + amount columns", header };
  const client = await pool().connect();
  const bank = "Assets:Bank";
  try {
    await client.query("begin");
    let n = 0;
    for (const r of rows) {
      const payee = r.desc.slice(0, 60);
      if (r.amount < 0) await post(client, entId, { date: r.date, payee, narration: r.desc, legs: [{ account: "Expenses:Other", amount: -r.amount }, { account: bank, amount: r.amount }], meta: { imported: true } });
      else await post(client, entId, { date: r.date, payee, narration: r.desc, legs: [{ account: bank, amount: r.amount }, { account: "Income:Other", amount: -r.amount }], meta: { imported: true } });
      n++;
    }
    await client.query("commit");
    return { imported: n };
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
}
