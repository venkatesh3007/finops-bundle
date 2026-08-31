// Tests for the parser gates — the rules that stop a model's bad day from
// overwriting real financial data. Run with: npm test
//
// lib/ is ESM in a package with no "type":"module" (Next transpiles it), so node
// can't import lib/parser/gates.js directly. It has zero imports of its own, so
// we copy it to a temp .mjs and import that. Nothing else is needed — no DB.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(mkdtempSync(join(tmpdir(), "finops-gates-")), "gates.mjs");
writeFileSync(tmp, readFileSync(new URL("../lib/parser/gates.js", import.meta.url), "utf8"));
const { acceptable, attemptCost, priorResult, regressionReason } = await import(tmp);

let pass = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "\n     ", e.message.split("\n")[0]); }
};

// A parse that reconciles: rows, no breaks, checkable, envelope holds.
const good = { rows: 5, breaks: 0, zero_amounts: 0, envelope_ok: true, verifiable: true };
const score = (over) => ({ ...good, ...over });

console.log("acceptable() — is this parser good enough to stop trying?");
it("accepts a fully verified parse", () => assert.equal(acceptable(good), true));
it("REJECTS a parse nothing could check (the 24-of-25 bug)",
  () => assert.equal(acceptable(score({ verifiable: false, envelope_ok: null })), false));
it("rejects zero rows", () => assert.equal(acceptable(score({ rows: 0 })), false));
it("rejects balance breaks", () => assert.equal(acceptable(score({ breaks: 2 })), false));
it("rejects rows with a zero amount", () => assert.equal(acceptable(score({ zero_amounts: 1 })), false));
it("rejects a broken envelope", () => assert.equal(acceptable(score({ envelope_ok: false })), false));

console.log("\nattemptCost() — which attempt to keep when none is acceptable");
it("prefers a checkable parse with 2 breaks over an unchecked clean-looking one", () =>
  assert.ok(attemptCost(score({ breaks: 2 })) < attemptCost(score({ verifiable: false, envelope_ok: null }))));
it("still prefers fewer breaks among checkable parses", () =>
  assert.ok(attemptCost(score({ breaks: 1 })) < attemptCost(score({ breaks: 9 }))));

console.log("\npriorResult() — what the draft already holds");
it("null for a draft with nothing stored", () => assert.equal(priorResult({ rows: [], reconciliation: null }), null));
it("reads rows, breaks, reconciled and verifiable", () => {
  const p = priorResult({ rows: [1, 2, 3], reconciliation: {
    reconciled: false, verifiable: true, continuity: { mismatches: [{}, {}] } } });
  assert.deepEqual(p, { rows: 3, breaks: 2, reconciled: false, verifiable: true });
});

console.log("\nregressionReason() — the champion gate");
const prior = { rows: 5, breaks: 0, reconciled: true, verifiable: true };
it("allows the first parse (nothing to protect)", () => assert.equal(regressionReason(null, good), null));
it("allows an identical re-parse", () =>
  assert.equal(regressionReason(prior, { rows: 5, breaks: 0, reconciled: true, verifiable: true }), null));
it("allows a strict improvement", () =>
  assert.equal(regressionReason({ rows: 5, breaks: 3, reconciled: false, verifiable: true },
                                { rows: 5, breaks: 0, reconciled: true, verifiable: true }), null));
it("REJECTS gaining breaks (the exact Haiku 128,750 -> 28,750 case)", () => {
  const why = regressionReason(prior, { rows: 5, breaks: 2, reconciled: false, verifiable: true });
  assert.match(why, /breaks more rows \(0 → 2/);
});
it("REJECTS losing rows", () =>
  assert.match(regressionReason(prior, { rows: 2, breaks: 0, reconciled: true, verifiable: true }), /loses rows \(5 → 2\)/));
it("REJECTS finding no rows at all", () =>
  assert.match(regressionReason(prior, { rows: 0, breaks: 0, reconciled: false, verifiable: false }), /no rows at all/));
it("REJECTS reconciled -> not reconciled", () =>
  assert.match(regressionReason(prior, { rows: 5, breaks: 0, reconciled: false, verifiable: true }), /reconciles and this one does not/));
it("REJECTS verifiable -> unverifiable (what the 25-statement run did)", () => {
  // Prior is checkable but doesn't reconcile, so the reconciled rule can't fire
  // first — this isolates the verifiability rule. More rows and fewer breaks look
  // like an improvement, and it is still refused: a parse nothing can check is
  // not an upgrade on one that can be.
  const checkable = { rows: 5, breaks: 2, reconciled: false, verifiable: true };
  assert.match(regressionReason(checkable, { rows: 6, breaks: 0, reconciled: false, verifiable: false }),
    /can be checked against the printed balance and this one cannot/);
});
it("a reconciling prior is defended by the reconciled rule first", () =>
  assert.match(regressionReason(prior, { rows: 6, breaks: 0, reconciled: false, verifiable: false }),
    /reconciles and this one does not/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
