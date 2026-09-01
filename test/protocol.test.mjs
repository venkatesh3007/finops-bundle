// Reading one action out of a model's reply. Every case here is a real reply
// shape seen in production, including the one that silently killed two
// investigations by presenting their whole plan as the answer.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = join(mkdtempSync(join(tmpdir(), "finops-proto-")), "protocol.mjs");
writeFileSync(tmp, readFileSync(new URL("../lib/agent/protocol.js", import.meta.url), "utf8"));
const { parseAction, firstJsonObject } = await import(tmp);
const NAMES = ["query_statements", "run_analysis", "read_source", "read_rows", "propose_rule"];

let pass = 0, fail = 0;
const it = (n, f) => { try { f(); pass++; console.log("  ✓", n); } catch (e) { fail++; console.log("  ✗", n, "\n     ", e.message.split("\n")[0]); } };

console.log("the reply that broke it — preamble then several objects");
// Verbatim shape from job d05dcff0: a sentence, then three tool calls at once.
const THE_BAD_REPLY = `I'll investigate the balance breaks in idbi-79657_2025-05.pdf step by step.

{"thought":"First, let me understand the reconciliation and breaks for this statement.","tool":"query_statements","input":{"op":"explain_statement","statement":"idbi-79657_2025-05"}}

{"thought":"Let me look at the breaks in detail.","tool":"run_analysis","input":{"statement":"idbi-79657_2025-05","code":"return ctx.reconciliation"}}

{"thought":"Let me find the break rows.","tool":"run_analysis","input":{"statement":"idbi","code":"const breaks = []; for (let i = 1; i < ctx.rows.length; i++) { } return breaks;"}}`;

it("takes the FIRST tool call instead of choking on all three", () => {
  const a = parseAction(THE_BAD_REPLY, NAMES);
  assert.equal(a.tool, "query_statements");
  assert.equal(a.input.op, "explain_statement");
});
it("does not present the plan as an answer", () =>
  assert.equal(parseAction(THE_BAD_REPLY, NAMES).reply, undefined));

console.log("\nordinary shapes");
it("a bare tool call", () => {
  const a = parseAction('{"thought":"look","tool":"read_rows","input":{"from":1,"to":5}}', NAMES);
  assert.equal(a.tool, "read_rows"); assert.equal(a.input.to, 5);
});
it("a tool call in a fenced block", () => {
  const a = parseAction('```json\n{"tool":"read_source","input":{"grep":"LOVABLE"}}\n```', NAMES);
  assert.equal(a.tool, "read_source");
});
it("an answer", () =>
  assert.equal(parseAction('{"reply":"The April 4 row took 20.00 instead of 1,782.93."}', NAMES).reply,
               "The April 4 row took 20.00 instead of 1,782.93."));
it("prose with no JSON is an answer", () =>
  assert.match(parseAction("Nothing looks wrong with that statement.", NAMES).reply, /Nothing looks wrong/));
it("an empty reply is a failure, never an answer", () =>
  assert.equal(parseAction("   ", NAMES).empty, true));

console.log("\nawkward but real");
it("braces inside a string don't end the object early", () => {
  const a = parseAction('{"tool":"run_analysis","input":{"code":"return ctx.rows.filter(r => { return r.amount < 0 }).length"}}', NAMES);
  assert.equal(a.tool, "run_analysis");
  assert.match(a.input.code, /return r\.amount < 0/);
});
it("escaped quotes inside the code survive", () => {
  const a = parseAction('{"tool":"run_analysis","input":{"code":"return ctx.pages.join(\\"\\\\n\\").length"}}', NAMES);
  assert.equal(a.tool, "run_analysis");
});
it("a tool name that doesn't exist is treated as prose, not a failed call", () => {
  const a = parseAction('{"tool":"delete_everything","input":{}}', NAMES);
  assert.equal(a.tool, undefined);
  assert.ok(a.reply);
});
it("skips a leading non-JSON brace and finds the real object", () => {
  const a = parseAction('Some { stray brace. {"tool":"read_rows","input":{}}', NAMES);
  assert.equal(a.tool, "read_rows");
});
it("firstJsonObject returns null when there is none", () =>
  assert.equal(firstJsonObject("no objects here"), null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
