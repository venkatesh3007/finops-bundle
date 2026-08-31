// The deterministic second opinion. Cases are the two real bugs from 2026-08-31
// plus the false positives an earlier version produced — those matter just as
// much: a cross-check that cries wolf on a statement that reconciles is worse
// than no cross-check at all.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(mkdtempSync(join(tmpdir(), "finops-cc-")), "crosscheck.mjs");
writeFileSync(tmp, readFileSync(new URL("../lib/statements/crosscheck.js", import.meta.url), "utf8"));
const { crossCheck, scanLines } = await import(tmp);

let pass = 0, fail = 0;
const it = (n, f) => { try { f(); pass++; console.log("  ✓", n); } catch (e) { fail++; console.log("  ✗", n, "\n     ", e.message.split("\n")[0]); } };

// An Amex-shaped page: the CR marker sits on the CONTINUATION line, and a
// foreign-currency row prints <foreign> then <home>.
const PAGE = `   Opening Balance Rs    New Credits Rs     New Debits Rs   Closing Balance Rs
    50,000.00 -        90,000.00 +       40,000.00 =        0.00
   Details                                    Foreign Spending      Amount Rs
   March 13   PAYMENT RECEIVED. THANK YOU                        90,000.00
   Card Number XXXX-XXXXXX-01001                                        CR
   March 17   CURSOR, AI POWERED IDE NEW YORK        20.00        1,812.11
                                                UNITED STATES DOLLAR
   March 20   ZOMATO LTD    GURGAON                              38,187.89
`;
const row = (date, desc, amount) => ({ date, desc, amount });
const GOOD = [row("2025-03-13","PAYMENT RECEIVED",90000), row("2025-03-17","CURSOR",-1812.11), row("2025-03-20","ZOMATO",-38187.89)];
const printed = { total_credits: 90000, total_debits: 40000 };

console.log("scanning");
it("finds the transaction lines and skips the summary box", () => {
  const s = scanLines([PAGE]);
  assert.equal(s.length, 3);
});
it("reads the CR marker off the continuation line", () => {
  const s = scanLines([PAGE]);
  assert.equal(s.find((x) => /PAYMENT/.test(x.desc)).credit, true);
});
it("takes the home-currency amount as the last of two", () => {
  const fx = scanLines([PAGE]).find((x) => /CURSOR/.test(x.desc));
  assert.equal(fx.foreign, 20); assert.equal(fx.home, 1812.11);
});

console.log("\nsilence when the extraction is right");
it("says nothing about a correct extraction", () => {
  const r = crossCheck({ pages: [PAGE], rows: GOOD, printed });
  assert.equal(r.source_complete, true);
  assert.equal(r.clean, true, `expected no findings, got: ${r.findings.join(" | ")}`);
});

console.log("\nthe two real bugs");
it("names the FX row when the foreign amount was taken (the LOVABLE bug)", () => {
  const rows = [row("2025-03-13","PAYMENT RECEIVED",90000), row("2025-03-17","CURSOR",-20), row("2025-03-20","ZOMATO",-38187.89)];
  const r = crossCheck({ pages: [PAGE], rows, printed });
  assert.match(r.findings.join(" "), /prints 20 and 1812\.11 side by side/);
  assert.equal(r.wrong_amount[0].understated_by, 1792.11);
});
it("names a line restated under a 'Summary of' heading (the 8,290 bug)", () => {
  const page = PAGE + `   Summary of New Installment Plans Created
   You have enrolled into the following New Installment Plans this month.
   March 21    INSTALLMENT PRINCIPAL AMOUNT                       8,290.00
`;
  const rows = [...GOOD, row("2025-03-21","INSTALLMENT PRINCIPAL AMOUNT",-8290)];
  const r = crossCheck({ pages: [page], rows, printed: { total_credits: 90000, total_debits: 40000 } });
  assert.match(r.findings.join(" "), /sits under "Summary of New Installment Plans Created"/);
});

console.log("\nfalse positives an earlier version produced");
it("does NOT treat 'Total of ...' as a heading (it follows its section)", () => {
  const page = `   Total of new transactions for VENKATESH RAO                     1,000.00
   March 20   ZOMATO LTD    GURGAON                              38,187.89
`;
  const s = scanLines([page]);
  assert.equal(s.find((x) => /ZOMATO/.test(x.desc)).under_summary, null);
});
it("does NOT flag same-day same-amount rows on a statement that adds up", () => {
  const page = `   April 1   UBER   Noida                                          2.00
   April 1   UBER   Noida                                          2.00
`;
  const rows = [row("2026-04-01","UBER",-2), row("2026-04-01","UBER",-2)];
  const r = crossCheck({ pages: [page], rows, printed: { total_credits: 0, total_debits: 4 } });
  assert.equal(r.clean, true, `expected silence, got: ${r.findings.join(" | ")}`);
});
it("flags a duplicate only when a side is actually over-counted", () => {
  const page = `   April 1   AMAZON   Mumbai                                     100.00
`;
  const rows = [row("2026-04-01","AMAZON",-100), row("2026-04-01","AMAZON",-100)];
  const r = crossCheck({ pages: [page], rows, printed: { total_credits: 0, total_debits: 100 } });
  assert.match(r.findings.join(" "), /appears twice .*exactly the 100 this statement is over-counted by/);
});

console.log("\nhonesty when it doesn't understand a layout");
it("withdraws every line-level claim when the scan can't reproduce the printed totals", () => {
  const r = crossCheck({ pages: ["nothing parseable here at all"], rows: GOOD, printed });
  assert.equal(r.source_complete, false);
  assert.equal(r.inconclusive, true);
  assert.equal(r.wrong_amount.length, 0);
  assert.equal(r.missing.length, 0);
  assert.match(r.findings.join(" "), /not making any claim about individual rows/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
