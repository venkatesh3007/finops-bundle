// Grade a proposed rule by RE-READING the statements it touches with the rule in
// force, then comparing. No opinion, no model judgment — the reconciler decides.
//
// The rule is applied for the trial only; it becomes active solely if the
// comparison passes. A plausible instruction that quietly costs rows never
// reaches a future statement.
import { query } from "../db.js";
import { extractStatement } from "./extract.js";
import { reconcile } from "./reconcile.js";
import { rulesFor, renderRules, scoreOf, gradeRule, setRuleStatus, ensureRules } from "./rules.js";

const MAX_TRIAL = Number(process.env.RULE_TRIAL_MAX || 8);

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

// Which statements a rule is answerable for: its scope, worst first, so a small
// trial still covers the cases that matter.
export async function statementsInScope(entity, scope, limit = MAX_TRIAL) {
  const entId = await entityId(entity);
  const rows = await query(
    `select * from statement_drafts
      where entity_id=$1 and status <> 'imported' and (meta ? 'pages' or meta ? 'text')`, [entId]);
  const s = String(scope || "global").toLowerCase();
  const inScope = s === "global" ? rows
    : s.startsWith("fp:") ? rows.filter((r) => `fp:${r.meta?.parser_fingerprint || ""}` === s)
    : rows.filter((r) => String(r.kind || "").toLowerCase() === s);
  // broken first — a rule that fixes nothing is rejected, so test where it should bite
  return inScope
    .sort((a, b) => (a.reconciliation?.reconciled === b.reconciliation?.reconciled ? 0 : a.reconciliation?.reconciled ? 1 : -1))
    .slice(0, limit);
}

export async function gradeProposedRule(entity, ruleId, { onNote = null } = {}) {
  await ensureRules();
  const entId = await entityId(entity);
  const r = await query("select * from extraction_rules where entity_id=$1 and id=$2", [entId, ruleId]);
  if (!r.length) throw new Error("no such rule");
  const rule = r[0];

  const drafts = await statementsInScope(entity, rule.scope);
  if (!drafts.length) {
    await setRuleStatus(entity, ruleId, "rejected", { reason: "no statements in scope to test it on" });
    return { promote: false, verdict: "rejected — there are no statements in scope to test it on", tested: 0 };
  }

  const active = renderRules(await rulesFor(entity, {}).catch(() => []));
  const withRule = [active, `LEARNED RULES FOR THIS SOURCE:\n- (${rule.scope}) ${rule.rule}`].filter(Boolean).join("\n\n");

  const before = drafts.map(scoreOf);
  const after = [];
  for (const d of drafts) {
    await onNote?.(`testing the rule on ${d.filename}…`);
    try {
      const out = await extractStatement({
        entity, pages: d.meta?.pages, text: d.meta?.text, filename: d.filename,
        bank: d.kind || "", rules: withRule,
      });
      if (out?.error) { after.push({ ...scoreOf(d), error: out.error }); continue; }
      const rows = out.transactions || [];
      const rec = out.reconciliation || reconcile(rows, {
        statement_type: out.statement_type, opening_balance: out.opening_balance, closing_balance: out.closing_balance,
        total_credits: out.total_credits, total_debits: out.total_debits,
      });
      after.push({ file: d.filename, rows: rows.length, breaks: rec.continuity?.mismatches?.length || 0, reconciled: !!rec.reconciled });
    } catch (e) {
      // A trial that couldn't run is not evidence the rule is good.
      after.push({ ...scoreOf(d), error: String(e.message || e).slice(0, 200) });
    }
  }

  const grade = gradeRule(before, after);
  const evidence = { tested: drafts.length, before, after, ...grade };
  await setRuleStatus(entity, ruleId, grade.promote ? "active" : "rejected", evidence);
  await onNote?.(grade.verdict);
  return { ...grade, tested: drafts.length, before, after, rule: rule.rule, scope: rule.scope };
}
