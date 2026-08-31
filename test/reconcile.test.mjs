// Tests for the per-side reconciliation checks. Same trick as gates.test.mjs:
// lib/ is ESM in a package with no "type":"module", so copy the (import-free)
// module to a temp .mjs and import that.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(mkdtempSync(join(tmpdir(), "finops-recon-")), "reconcile.mjs");
writeFileSync(tmp, readFileSync(new URL("../lib/statements/reconcile.js", import.meta.url), "utf8"));
const { reconcile } = await import(tmp);

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message.split("\n")[0]); }
};
const tx = (amount) => ({ date: "2026-01-01", description: "x", amount, balance: null });

// The real statement: Amex 2026-01-08. Its own summary box prints
//   Opening 620,903.18 − New Credits 749,017.25 + New Debits 264,522.39 = Closing 136,408.32
// Extraction returned rows netting +194,099.54, i.e. 290,395.32 of credits missing.
const AMEX = { statement_type: "card", opening_balance: 620903.18, closing_balance: 136408.32,
               total_credits: 749017.25, total_debits: 264522.39 };

console.log("per-side checks on a credit-card statement (no running balance at all):");

it("a complete extraction reconciles", () => {
  const r = reconcile([tx(749017.25), tx(-264522.39)], AMEX);
  assert.equal(r.reconciled, true);
  assert.equal(r.sides.credits.ok, true);
  assert.equal(r.sides.debits.ok, true);
});

it("names the CREDITS side when payments are missing (the real 2026-01-08 case)", () => {
  const r = reconcile([tx(458621.93), tx(-264522.39)], AMEX); // 290,395.32 short on credits
  assert.equal(r.reconciled, false);
  assert.equal(r.sides.credits.ok, false);
  assert.equal(r.sides.debits.ok, true);
  assert.equal(r.sides.credits.gap, 290395.32);
  assert.match(r.note, /money IN .*290395\.32 of credits\/payments is missing/);
});

it("names the DEBITS side when charges are missing", () => {
  const r = reconcile([tx(749017.25), tx(-164522.39)], AMEX);
  assert.equal(r.sides.debits.ok, false);
  assert.equal(r.sides.debits.gap, 100000);
  assert.match(r.note, /money OUT .*of charges is missing/);
});

it("reports both sides when both are short", () => {
  const r = reconcile([tx(700000), tx(-200000)], AMEX);
  assert.match(r.note, /both sides are short/);
});

it("0 rows-with-balance means the chain check never runs — sides are the only proof", () => {
  const r = reconcile([tx(749017.25), tx(-264522.39)], AMEX);
  assert.equal(r.withBalance, 0);
  assert.equal(r.continuity.checked, 0);
  assert.equal(r.verifiable, true); // verifiable via sides + envelope, not via chaining
});

it("printed totals alone make a statement verifiable (no opening/closing needed)", () => {
  const r = reconcile([tx(100), tx(-40)], { statement_type: "card", total_credits: 100, total_debits: 40 });
  assert.equal(r.verifiable, true);
  assert.equal(r.reconciled, true);
});

it("no totals and no balances is still honestly unverifiable", () => {
  const r = reconcile([tx(100), tx(-40)], { statement_type: "card" });
  assert.equal(r.verifiable, false);
  assert.equal(r.reconciled, false);
  assert.match(r.note, /can't be auto-checked/);
});

console.log("\nthe existing bank-statement behaviour is unchanged:");
it("row-by-row chaining still works and still catches a break", () => {
  const rows = [
    { date: "2026-07-03", description: "a", amount: -1250, balance: 48750 },
    { date: "2026-07-07", description: "b", amount: 80000, balance: 28750 }, // wrong: dropped leading 1
  ];
  const r = reconcile(rows, { statement_type: "bank", opening_balance: 50000, closing_balance: 28750 });
  assert.equal(r.continuity.mismatches.length, 1);
  assert.equal(r.continuity.mismatches[0].off_by, -100000);
  assert.equal(r.reconciled, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
