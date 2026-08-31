// The analysis sandbox and the rule champion gate. These are the two pieces that
// can hurt you: one runs model-written code, the other decides what instruction
// every future statement is read under.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpdir_ = mkdtempSync(join(tmpdir(), "finops-inv-"));
const cp = (from, to) => { const p = join(tmpdir_, to); writeFileSync(p, readFileSync(new URL(from, import.meta.url), "utf8")); return p; };
const { runAnalysis, AnalysisError } = await import(cp("../lib/extractor/sandbox.js", "sandbox.mjs"));
// rules.js imports db.js; lift the two pure functions out of its source instead.
const rulesSrc = readFileSync(new URL("../lib/statements/rules.js", import.meta.url), "utf8");
const grab = (n) => { const i = rulesSrc.indexOf(`export function ${n}(`); return rulesSrc.slice(i, rulesSrc.indexOf("\n}", i) + 2); };
const gp = join(tmpdir_, "grade.mjs");
writeFileSync(gp, `${grab("scoreOf")}\n${grab("gradeRule")}\n`);
const { gradeRule } = await import(gp);

let pass = 0, fail = 0;
const it = (n, f) => { try { f(); pass++; console.log("  ✓", n); } catch (e) { fail++; console.log("  ✗", n, "\n     ", e.message.split("\n")[0]); } };

const ctx = {
  filename: "x.pdf",
  pages: ["03-Jul ZOMATO 1,250.00 48,750.00", "07-Jul SALARY 80,000.00 128,750.00"],
  rows: [{ i: 0, date: "2026-07-03", amount: -1250, balance: 48750 },
         { i: 1, date: "2026-07-07", amount: 80000, balance: 128750 },
         { i: 2, date: "2026-07-07", amount: 80000, balance: 128750 }],
};

console.log("the analysis sandbox — it runs model-written code");
it("evaluates an expression over the statement", () =>
  assert.equal(runAnalysis("ctx.rows.length", ctx).value, 3));
it("accepts a body with a return", () =>
  assert.equal(runAnalysis("const n = ctx.rows.filter(r => r.amount < 0).length; return n;", ctx).value, 1));
it("finds the duplicate — the real 2025-11 shape", () => {
  const v = runAnalysis("ctx.rows.filter((r,i,a) => i && r.amount===a[i-1].amount && r.balance===a[i-1].balance)", ctx).value;
  assert.equal(v.length, 1); assert.equal(v[0].i, 2);
});
it("can read the raw source text", () =>
  assert.equal(runAnalysis("ctx.pages.join('\\n').includes('48,750.00')", ctx).value, true));

console.log("\nthe jail");
for (const [name, code] of [
  ["no require", "require('fs')"],
  ["no process", "process.env"],
  ["no fetch", "fetch('http://x')"],
  ["no require", "require('fs')"],
  ["no timers", "setTimeout(()=>{},1)"],
]) it(name, () => assert.throws(() => runAnalysis(code, ctx), (e) => e instanceof AnalysisError));

it("an infinite loop is cut off, not hung", () =>
  assert.throws(() => runAnalysis("while(true){}", ctx), (e) => e instanceof AnalysisError));
it("returning a function is refused, not silently nulled", () =>
  assert.throws(() => runAnalysis("(() => 1)", ctx), (e) => e instanceof AnalysisError));

console.log("\nrealm isolation — the escape that WAS possible, measured");
// Before the fix, this realm's JSON/Math were injected into the context, so
// JSON.constructor.constructor was the HOST Function constructor and compiled
// code where process lives. It returned 73 environment variables.
for (const [name, code] of [
  ["cannot reach process via JSON",  'JSON.constructor.constructor("return typeof process")()'],
  ["cannot reach process via Math",  'Math.constructor.constructor("return typeof process")()'],
  ["cannot reach process via ctx",   'ctx.constructor.constructor("return typeof process")()'],
  ["cannot read env",                'JSON.constructor.constructor("return (typeof process!==\'undefined\'&&process.env)?Object.keys(process.env).length:null")()'],
  ["cannot reach require",           'JSON.constructor.constructor("return typeof require")()'],
]) it(name, () => {
  const v = runAnalysis(code, ctx).value;
  assert.ok(v === null || v === "undefined", `escaped: got ${JSON.stringify(v)}`);
});
it("intrinsics still work inside the jail", () => {
  assert.equal(runAnalysis('[1,2,3].map(x=>x*2).join(",")', ctx).value, "2,4,6");
  assert.equal(runAnalysis('Math.round(1.5) + new Date(0).getUTCFullYear()', ctx).value, 1972);
  assert.equal(runAnalysis('JSON.stringify({a:1})', ctx).value, '{"a":1}');
});
it("a huge result is refused rather than truncated silently", () =>
  assert.throws(() => runAnalysis("Array.from({length: 200000}, (_,i)=>({i, s:'xxxxxxxxxx'}))", ctx), (e) => /max/.test(e.message)));
it("the context cannot be mutated", () => {
  runAnalysis("(() => { try { ctx.rows.push({}); } catch(e) {} return 1 })()", ctx);
  assert.equal(ctx.rows.length, 3);
});
it("a syntax error comes back as a message to fix, not a crash", () => {
  try { runAnalysis("ctx.rows.filter(", ctx); assert.fail("should throw"); }
  catch (e) { assert.ok(e instanceof AnalysisError && e.message.length > 0); }
});

console.log("\nthe rule champion gate — what every future statement gets read under");
const S = (file, rows, breaks, reconciled) => ({ file, rows, breaks, reconciled });
it("promotes when something improves and nothing regresses", () => {
  const g = gradeRule([S("a",100,2,false), S("b",50,0,true)], [S("a",100,0,true), S("b",50,0,true)]);
  assert.equal(g.promote, true);
  assert.match(g.verdict, /promoted/);
});
it("REJECTS when another statement loses rows", () => {
  const g = gradeRule([S("a",100,2,false), S("b",50,0,true)], [S("a",100,0,true), S("b",47,0,true)]);
  assert.equal(g.promote, false);
  assert.match(g.regressions.join(" "), /b: lost rows \(50 → 47\)/);
});
it("REJECTS when a verified statement stops reconciling", () => {
  const g = gradeRule([S("a",100,2,false), S("b",50,0,true)], [S("a",100,0,true), S("b",50,0,false)]);
  assert.equal(g.promote, false);
  assert.match(g.regressions.join(" "), /stopped reconciling/);
});
it("REJECTS a rule that changes nothing", () => {
  const g = gradeRule([S("a",100,2,false)], [S("a",100,2,false)]);
  assert.equal(g.promote, false);
  assert.match(g.verdict, /changed nothing/);
});
it("counts fewer breaks as an improvement", () => {
  const g = gradeRule([S("a",100,5,false)], [S("a",100,1,false)]);
  assert.equal(g.promote, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
