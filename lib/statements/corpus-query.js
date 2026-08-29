// Deterministic query engine over EVERY statement you've parsed.
//
// This is what makes "ask me anything about my statements" answerable correctly:
// no number here is produced by a model. The model's only job (in corpus-ask.js)
// is to turn your sentence into one of these queries and then read the result
// back in plain words. Every figure comes from the stored rows and from the
// reconciler's own arithmetic.
import { query } from "../db.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const sum = (xs) => r2(xs.reduce((a, b) => a + b, 0));

// ── load ────────────────────────────────────────────────────────────────────
export async function loadCorpus(entity) {
  const ent = await query("select id from entities where slug=$1", [entity]);
  if (!ent.length) throw new Error(`no entity ${entity}`);
  const drafts = await query(
    `select id, filename, source, account, kind, status, rows, reconciliation, meta, created_at, updated_at
       from statement_drafts where entity_id=$1 order by updated_at desc limit 200`, [ent[0].id]);

  const statements = [], rows = [];
  for (const d of drafts) {
    const rs = Array.isArray(d.rows) ? d.rows : [];
    const rec = d.reconciliation || null;
    const meta = d.meta || {};
    const dates = rs.map((r) => r.date).filter(Boolean).sort();
    const inflow = sum(rs.filter((r) => r.amount > 0).map((r) => r.amount));
    const outflow = r2(-sum(rs.filter((r) => r.amount < 0).map((r) => r.amount)));
    const breaks = rec?.continuity?.mismatches || [];
    statements.push({
      id: d.id, name: d.filename, source: d.source, account: d.account, bank: d.kind, status: d.status,
      rows: rs.length, from: dates[0] || null, to: dates[dates.length - 1] || null,
      inflow, outflow, net: r2(inflow - outflow),
      reconciled: !!rec?.reconciled, verifiable: !!rec?.verifiable, breaks: breaks.length,
      note: rec?.note || null, envelope: rec?.envelope || null,
      checked: rec?.continuity?.checked || 0, with_balance: rec?.withBalance || 0,
      opening: meta.opening_balance ?? null, closing: meta.closing_balance ?? null,
      statement_type: meta.statement_type || null, parser_version: meta.extractor_version ?? null,
      chunks: meta.chunks ?? null, error: meta.error || null,
      break_rows: breaks,
      imported: d.status === "imported",
    });
    for (const r of rs) {
      rows.push({
        stmt_id: d.id, stmt: d.filename, stmt_account: d.account, bank: d.kind,
        i: r.i, date: r.date, desc: r.desc, payee: r.payee, amount: r.amount, balance: r.balance ?? null,
        account: r.account, source: r.source, confidence: r.confidence, broken: !!r.brk,
      });
    }
  }
  return { statements, rows };
}

// ── filtering ───────────────────────────────────────────────────────────────
const norm = (s) => String(s || "").toLowerCase();

export function matchStatement(statements, ref) {
  if (!ref) return null;
  const q = norm(ref);
  return statements.find((s) => norm(s.name) === q)
    || statements.find((s) => norm(s.name).includes(q))
    || statements.find((s) => norm(s.account).includes(q) || norm(s.bank).includes(q))
    || null;
}

export function filterRows(rows, f = {}) {
  const t = f.text ? norm(f.text) : null;
  const acct = f.account ? norm(f.account) : null;
  const stmt = f.statement ? norm(f.statement) : null;
  const bank = f.bank ? norm(f.bank) : null;
  return rows.filter((r) => {
    if (t && !`${r.desc} ${r.payee || ""}`.toLowerCase().includes(t)) return false;
    if (acct && !norm(r.account).includes(acct)) return false;
    if (stmt && !norm(r.stmt).includes(stmt)) return false;
    if (bank && !(norm(r.bank).includes(bank) || norm(r.stmt_account).includes(bank))) return false;
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (f.direction === "in" && !(r.amount > 0)) return false;
    if (f.direction === "out" && !(r.amount < 0)) return false;
    if (f.min != null && Math.abs(r.amount) < Number(f.min)) return false;
    if (f.max != null && Math.abs(r.amount) > Number(f.max)) return false;
    if (f.broken_only && !r.broken) return false;
    if (f.needs_review && !(r.confidence < 0.6 || /:Other$/.test(r.account || ""))) return false;
    return true;
  });
}

function filterStatements(statements, f = {}) {
  return statements.filter((s) => {
    if (f.statement && !norm(s.name).includes(norm(f.statement))) return false;
    if (f.bank && !(norm(s.bank).includes(norm(f.bank)) || norm(s.account).includes(norm(f.bank)))) return false;
    if (f.with_breaks && !s.breaks) return false;
    if (f.unverified && s.reconciled) return false;
    if (f.from && s.to && s.to < f.from) return false;
    if (f.to && s.from && s.from > f.to) return false;
    return true;
  });
}

const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r) || "—";
    const g = m.get(k) || { key: k, count: 0, in: 0, out: 0, net: 0 };
    g.count++;
    if (r.amount > 0) g.in = r2(g.in + r.amount); else g.out = r2(g.out - r.amount);
    g.net = r2(g.in - g.out);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
};

// ── coverage: what periods do you actually have, per account ────────────────
function coverage(statements) {
  const byAcct = new Map();
  for (const s of statements) {
    const k = s.account || "unknown";
    const g = byAcct.get(k) || { account: k, statements: 0, rows: 0, months: new Set(), from: null, to: null };
    g.statements++; g.rows += s.rows;
    if (s.from) { g.from = !g.from || s.from < g.from ? s.from : g.from; }
    if (s.to) { g.to = !g.to || s.to > g.to ? s.to : g.to; }
    for (let d = s.from; d && s.to && d <= s.to;) {
      g.months.add(d.slice(0, 7));
      const [y, m] = d.split("-").map(Number);
      d = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    }
    byAcct.set(k, g);
  }
  return [...byAcct.values()].map((g) => {
    const months = [...g.months].sort();
    const gaps = [];
    for (let i = 1; i < months.length; i++) {
      const [py, pm] = months[i - 1].split("-").map(Number);
      const expected = `${pm === 12 ? py + 1 : py}-${String(pm === 12 ? 1 : pm + 1).padStart(2, "0")}`;
      if (months[i] !== expected) gaps.push({ after: months[i - 1], before: months[i] });
    }
    return { account: g.account, statements: g.statements, rows: g.rows, from: g.from, to: g.to, months: months.length, gaps };
  }).sort((a, b) => (a.account > b.account ? 1 : -1));
}

// Rows that look like the SAME transaction appearing in more than one statement
// — the thing that would double-count if you imported both.
function duplicates(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.amount}|${norm(r.desc).replace(/[^a-z0-9]/g, "").slice(0, 24)}`;
    (m.get(k) || m.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const [, rs] of m) {
    const stmts = [...new Set(rs.map((r) => r.stmt))];
    if (stmts.length > 1) out.push({ date: rs[0].date, amount: rs[0].amount, desc: String(rs[0].desc).slice(0, 60), statements: stmts, copies: rs.length });
  }
  return out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

// ── the ops ─────────────────────────────────────────────────────────────────
export const OPS = [
  "overview", "statements", "breaks", "explain_statement", "coverage",
  "transactions", "sum", "group", "top", "duplicates", "needs_review",
];

export function runQuery(corpus, q = {}) {
  const { statements, rows } = corpus;
  const op = OPS.includes(q.op) ? q.op : "overview";
  const limit = Math.min(Number(q.limit) || 20, 200);

  if (op === "overview") {
    const dates = statements.flatMap((s) => [s.from, s.to]).filter(Boolean).sort();
    return {
      op, result: {
        statements: statements.length, rows: rows.length,
        reconciled: statements.filter((s) => s.reconciled).length,
        with_breaks: statements.filter((s) => s.breaks).length,
        total_breaks: statements.reduce((a, s) => a + s.breaks, 0),
        unverifiable: statements.filter((s) => !s.verifiable).length,
        envelope_off: statements.filter((s) => s.envelope && !s.envelope.ok).length,
        imported: statements.filter((s) => s.imported).length,
        span: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
        accounts: [...new Set(statements.map((s) => s.account))],
        inflow: sum(statements.map((s) => s.inflow)), outflow: sum(statements.map((s) => s.outflow)),
        parser_versions: [...new Set(statements.map((s) => s.parser_version).filter((v) => v != null))],
      },
    };
  }

  if (op === "statements") {
    const sel = filterStatements(statements, q);
    return { op, matched: sel.length, result: sel.slice(0, limit).map((s) => ({
      name: s.name, account: s.account, from: s.from, to: s.to, rows: s.rows,
      breaks: s.breaks, reconciled: s.reconciled, note: s.note, status: s.status,
      inflow: s.inflow, outflow: s.outflow, parser_version: s.parser_version,
    })) };
  }

  if (op === "breaks") {
    const sel = filterStatements(statements, q).filter((s) => s.breaks);
    const detail = sel.flatMap((s) => s.break_rows.slice(0, q.statement ? limit : 3).map((b) => ({
      statement: s.name, row: b.index + 1, date: b.date, desc: b.desc, amount: b.amount,
      prev_balance: b.prev_balance, printed_balance: b.printed_balance, expected_balance: b.expected_balance, off_by: b.off_by,
    })));
    return { op, matched: sel.reduce((a, s) => a + s.breaks, 0),
      result: { statements: sel.map((s) => ({ name: s.name, breaks: s.breaks, rows: s.rows })), rows: detail.slice(0, limit) } };
  }

  if (op === "explain_statement") {
    const s = matchStatement(statements, q.statement);
    if (!s) return { op, result: null, note: "no statement matched that name" };
    return { op, result: {
      name: s.name, account: s.account, type: s.statement_type, status: s.status, parser_version: s.parser_version, chunks: s.chunks,
      period: { from: s.from, to: s.to }, rows: s.rows, inflow: s.inflow, outflow: s.outflow, net: s.net,
      opening: s.opening, closing: s.closing, envelope: s.envelope,
      reconciled: s.reconciled, verifiable: s.verifiable, checked: s.checked, with_balance: s.with_balance,
      breaks: s.breaks, note: s.note, error: s.error,
      sample_breaks: s.break_rows.slice(0, 8).map((b) => ({
        row: b.index + 1, date: b.date, desc: b.desc, amount: b.amount,
        prev_balance: b.prev_balance, printed_balance: b.printed_balance, expected_balance: b.expected_balance, off_by: b.off_by,
      })),
    } };
  }

  if (op === "coverage") return { op, result: coverage(filterStatements(statements, q)) };
  if (op === "duplicates") { const d = duplicates(rows); return { op, matched: d.length, result: d.slice(0, limit) }; }

  // row-level ops
  const sel = filterRows(rows, q);
  if (op === "sum") {
    const inflow = sum(sel.filter((r) => r.amount > 0).map((r) => r.amount));
    const outflow = r2(-sum(sel.filter((r) => r.amount < 0).map((r) => r.amount)));
    return { op, matched: sel.length, result: { count: sel.length, inflow, outflow, net: r2(inflow - outflow),
      statements: [...new Set(sel.map((r) => r.stmt))].length },
      sample: sel.slice(0, 5).map(brief) };
  }
  if (op === "group") {
    const by = q.by === "payee" ? (r) => r.payee : q.by === "month" ? (r) => (r.date || "").slice(0, 7)
      : q.by === "statement" ? (r) => r.stmt : q.by === "bank" ? (r) => r.stmt_account : (r) => r.account;
    return { op, by: q.by || "account", matched: sel.length, result: groupBy(sel, by).slice(0, limit) };
  }
  if (op === "top") return { op, matched: sel.length, result: [...sel].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, limit).map(brief) };
  if (op === "needs_review") {
    const n = filterRows(rows, { ...q, needs_review: true });
    return { op, matched: n.length, result: n.slice(0, limit).map(brief) };
  }
  return { op: "transactions", matched: sel.length, result: sel.slice(0, limit).map(brief) };
}

const brief = (r) => ({ statement: r.stmt, row: r.i, date: r.date, payee: r.payee, amount: r.amount,
  balance: r.balance, account: r.account, source: r.source, broken: r.broken || undefined,
  desc: String(r.desc || "").slice(0, 70) });

// A compact inventory the planner sees, so it can name real statements.
export function inventory(statements) {
  return statements.slice(0, 40).map((s) =>
    `${s.name} | ${s.account || "?"} | ${s.from || "?"}→${s.to || "?"} | ${s.rows} rows | ${s.breaks} breaks | ${s.reconciled ? "reconciles" : "unverified"}`).join("\n");
}
