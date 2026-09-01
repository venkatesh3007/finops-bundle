// Completeness checks — "are these ALL the rows", as distinct from "are these rows
// right". Cases are the real failures from the 2026-08-31 re-run.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(mkdtempSync(join(tmpdir(), "finops-comp-")), "completeness.mjs");
writeFileSync(tmp, readFileSync(new URL("../lib/statements/completeness.js", import.meta.url), "utf8"));
const { candidateLines, periodCoverage, ordering, chunkAccounting, completeness, statementChain } = await import(tmp);

let pass = 0, fail = 0;
const it = (n, f) => { try { f(); pass++; console.log("  ✓", n); } catch (e) { fail++; console.log("  ✗", n, "\n     ", e.message.split("\n")[0]); } };
const row = (date, amount = -100) => ({ date, amount });

console.log("periodCoverage — the failure no balance check can see");
it("flags 2 days of a 30-day period (the real 2026-07-08)", () => {
  const rows = [row("2026-06-16"), row("2026-06-17")];
  const c = periodCoverage(rows, { from: "2026-06-16", to: "2026-07-08" });
  assert.equal(c.ok, false);
  assert.match(c.problems.join(" "), /nothing in the last 21 days/);
});
it("accepts a statement that spans its period", () => {
  const c = periodCoverage([row("2025-12-09"), row("2026-01-07")], { from: "2025-12-09", to: "2026-01-08" });
  assert.equal(c.ok, true);
});
it("tolerates a few quiet days at each end", () => {
  const c = periodCoverage([row("2026-06-18"), row("2026-07-05")], { from: "2026-06-16", to: "2026-07-08" });
  assert.equal(c.ok, true);
});
it("says so when there are no dated rows", () =>
  assert.equal(periodCoverage([], { from: "2026-06-16", to: "2026-07-08" }).ok, false));
it("doesn't guess when the statement declares no period", () =>
  assert.equal(periodCoverage([row("2026-06-16")], null).ok, null));

console.log("\nordering");
it("catches a last row dated before the first (the real 2025-05-08)", () => {
  const o = ordering([row("2025-04-23"), row("2025-04-21")]);
  assert.equal(o.ok, false);
  assert.match(o.note, /reverse date order|dated before/);
});
it("passes on chronological rows", () => assert.equal(ordering([row("2026-01-01"), row("2026-01-05")]).ok, true));
// The real idbi-79657_2026-08: newest-first, but with several transactions per
// day. The old test demanded a descent on EVERY step, and an equal step is not a
// descent, so it never fired — 76 phantom breaks, 94% of the whole corpus.
it("flags newest-first even when dates repeat", () => {
  const o = ordering([row("2026-08-30"), row("2026-08-29"), row("2026-08-29"), row("2026-08-26")]);
  assert.equal(o.reversed, true);
  assert.equal(o.ok, false);
  assert.match(o.note, /newest first/);
});
it("does not call a genuinely jumbled statement reversed", () => {
  const o = ordering([row("2026-08-02"), row("2026-08-01"), row("2026-08-09")]);
  assert.equal(o.reversed, false);   // it steps forward somewhere, so it is not newest-first
  assert.equal(o.ok, false);
});
it("repeated dates alone are not a reversal", () =>
  assert.equal(ordering([row("2026-08-05"), row("2026-08-05")]).reversed, false));

console.log("\nchunkAccounting — the targeting signal for repair");
const page = ["03-Jul-2026  ZOMATO ORDER   1,250.00", "07-Jul-2026  SALARY  80,000.00",
              "12-Jul-2026  RENT  35,000.00", "18-Jul-2026  AMAZON  2,500.00"].join("\n");
it("counts lines that carry both a date and an amount", () => assert.equal(candidateLines(page), 4));
it("ignores prose with no amounts", () => assert.equal(candidateLines("Thank you for using the Card.\nTerms apply."), 0));
it("flags a chunk that returned far fewer rows than it had candidates", () => {
  const [c] = chunkAccounting([page], [1]);
  assert.equal(c.short, true);
  assert.equal(c.candidates, 4);
});
it("does not flag a chunk with nothing to miss", () => {
  const [c] = chunkAccounting(["Terms and conditions apply."], [0]);
  assert.equal(c.short, false);
});

console.log("\ncompleteness — one verdict + suspect chunks");
it("names the suspect chunk for the repair loop", () => {
  const r = completeness({ rows: [row("2026-07-03")], chunkTexts: [page], rowsPerChunk: [1],
                           period: { from: "2026-07-01", to: "2026-07-31" } });
  assert.equal(r.complete, false);
  assert.deepEqual(r.suspect_chunks, [0]);
  assert.ok(r.findings.some((f) => /transaction-looking lines/.test(f)));
});

console.log("\nstatementChain — the only check that spots a statement you never uploaded");
const rec = (f, from, to, opening, closing) => ({ filename: f, account: "Liabilities:Card:Amex", from, to, opening, closing });
it("flags a missing month between two statements", () => {
  const out = statementChain([rec("oct.pdf","2025-10-09","2025-11-08",100,200), rec("dec.pdf","2025-12-09","2026-01-08",300,400)]);
  assert.ok(out.some((f) => f.kind === "missing_statement"));
});
it("flags opening that doesn't match the previous closing", () => {
  const out = statementChain([rec("oct.pdf","2025-10-09","2025-11-08",100,200), rec("nov.pdf","2025-11-09","2025-12-08",250,400)]);
  const jump = out.find((f) => f.kind === "balance_jump");
  assert.equal(jump.diff, 50);
  assert.match(jump.detail, /opens at 250 but oct\.pdf closed at 200/);
});
it("is quiet when consecutive statements chain", () => {
  const out = statementChain([rec("oct.pdf","2025-10-09","2025-11-08",100,200), rec("nov.pdf","2025-11-09","2025-12-08",200,400)]);
  assert.equal(out.length, 0);
});
it("keeps accounts separate", () => {
  const a = rec("a.pdf","2025-10-09","2025-11-08",100,200);
  const b = { ...rec("b.pdf","2025-11-09","2025-12-08",999,400), account: "Assets:Bank:IDBI" };
  assert.equal(statementChain([a, b]).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
