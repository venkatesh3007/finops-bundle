// EXTRACTION RULES — a fix that ships without a deploy.
//
// The two bugs found on 2026-08-31 were both one sentence of instruction:
//   "a line with no date and no amount continues the transaction ABOVE it"
//   "return rows oldest-first even when the statement prints newest-first"
// Both went out as code edits and a redeploy. They should not have to.
//
// A rule is data: scoped to a bank or a layout, carrying the investigation that
// produced it, and PROMOTED ONLY IF IT DOESN'T MAKE ANYTHING WORSE. That last
// part is the whole safety story — the same champion gate the parser lab and the
// repair loop already use, for the same reason: a plausible instruction can
// quietly cost you rows.
//
// This replaces nothing: `decisions.rules:extract` stays as the operator's own
// free-text notes and is still applied. Rules are the agent's half, and unlike
// that blob they are scoped, evidenced and reversible.
import { query } from "../db.js";

let ensured = false;
export async function ensureRules() {
  if (ensured) return;
  await query(`create table if not exists extraction_rules (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references entities(id) on delete cascade,
    scope text not null default 'global',      -- 'global' | bank slug | 'fp:<fingerprint>'
    rule text not null,
    why text,                                   -- the investigation that produced it
    evidence jsonb,                             -- {statements, before:{...}, after:{...}}
    status text not null default 'proposed' check (status in ('proposed','active','rejected','superseded')),
    created_by text not null default 'agent',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now())`);
  await query("create index if not exists extraction_rules_entity_idx on extraction_rules (entity_id, status, scope)");
  ensured = true;
}

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

// Rules that apply to a statement, most general first so a layout-specific rule
// is read last and wins the argument.
export async function rulesFor(entity, { bank = "", fingerprint = "" } = {}) {
  await ensureRules();
  const entId = await entityId(entity);
  const scopes = ["global"];
  if (bank) scopes.push(String(bank).toLowerCase());
  if (fingerprint) scopes.push(`fp:${fingerprint}`);
  const rows = await query(
    `select * from extraction_rules
      where entity_id=$1 and status='active' and scope = any($2::text[])
      order by array_position($2::text[], scope), created_at`, [entId, scopes]);
  return rows;
}

// Rendered for the extraction prompt. Scope is stated so the model knows a rule
// about one bank is not a general law.
export function renderRules(rows) {
  if (!rows?.length) return "";
  return rows.map((r) => `- (${r.scope}) ${r.rule}`).join("\n");
}

export async function proposeRule(entity, { scope = "global", rule, why = "", evidence = null, createdBy = "agent" }) {
  await ensureRules();
  const entId = await entityId(entity);
  if (!String(rule || "").trim()) throw new Error("a rule needs text");
  const r = await query(
    `insert into extraction_rules (entity_id, scope, rule, why, evidence, status, created_by)
     values ($1,$2,$3,$4,$5,'proposed',$6) returning *`,
    [entId, String(scope).toLowerCase(), String(rule).trim().slice(0, 2000), String(why).slice(0, 4000),
     evidence ? JSON.stringify(evidence) : null, createdBy]);
  return r[0];
}

export async function listRules(entity, { status = null } = {}) {
  await ensureRules();
  const entId = await entityId(entity);
  return status
    ? await query("select * from extraction_rules where entity_id=$1 and status=$2 order by created_at desc", [entId, status])
    : await query("select * from extraction_rules where entity_id=$1 order by created_at desc", [entId]);
}

export async function setRuleStatus(entity, id, status, evidence = null) {
  await ensureRules();
  const entId = await entityId(entity);
  const r = await query(
    `update extraction_rules set status=$3, evidence=coalesce($4, evidence), updated_at=now()
      where entity_id=$1 and id=$2 returning *`,
    [entId, id, status, evidence ? JSON.stringify(evidence) : null]);
  return r[0] || null;
}

// ── the champion gate, for rules ──────────────────────────────────────────────
// A rule is promoted only if, across every statement it touches, nothing loses
// rows, nothing gains breaks, nothing stops reconciling — and at least one
// improves. A rule that changes nothing is not worth carrying.
export function scoreOf(draft) {
  const rec = draft.reconciliation || {};
  return {
    file: draft.filename,
    rows: Array.isArray(draft.rows) ? draft.rows.length : 0,
    breaks: rec.continuity?.mismatches?.length || 0,
    reconciled: !!rec.reconciled,
  };
}

export function gradeRule(before, after) {
  const byFile = new Map(before.map((b) => [b.file, b]));
  const regressions = [], improvements = [];
  for (const a of after) {
    const b = byFile.get(a.file);
    if (!b) continue;
    if (a.rows < b.rows) regressions.push(`${a.file}: lost rows (${b.rows} → ${a.rows})`);
    else if (a.breaks > b.breaks) regressions.push(`${a.file}: more breaks (${b.breaks} → ${a.breaks})`);
    else if (b.reconciled && !a.reconciled) regressions.push(`${a.file}: stopped reconciling`);
    else if (!b.reconciled && a.reconciled) improvements.push(`${a.file}: now reconciles`);
    else if (a.breaks < b.breaks) improvements.push(`${a.file}: ${b.breaks} → ${a.breaks} breaks`);
    else if (a.rows > b.rows && !b.reconciled) improvements.push(`${a.file}: ${b.rows} → ${a.rows} rows`);
  }
  return {
    promote: regressions.length === 0 && improvements.length > 0,
    regressions, improvements,
    verdict: regressions.length ? "rejected — it made something worse"
      : improvements.length ? "promoted — everything held and something improved"
      : "rejected — it changed nothing",
  };
}
