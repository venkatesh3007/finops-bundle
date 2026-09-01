// Error classification: the retry policy has to tell a failed REQUEST from a
// disagreeable ANSWER. Strings are the real ones seen on 2026-08-31.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// run.js imports app modules, so lift just the two classifiers out of its source.
const src = readFileSync(new URL("../lib/extractor/run.js", import.meta.url), "utf8");
const grab = (name) => {
  const i = src.indexOf(`export function ${name}(`);
  const j = src.indexOf("\n}", i);
  return src.slice(i, j + 2).replace("export ", "");
};
const tmp = join(mkdtempSync(join(tmpdir(), "finops-retry-")), "cls.mjs");
writeFileSync(tmp, `${grab("isTransient")}\n${grab("isTruncation")}\nexport { isTransient, isTruncation };\n`);
const { isTransient, isTruncation } = await import(tmp);

let pass = 0, fail = 0;
const it = (n, f) => { try { f(); pass++; console.log("  ✓", n); } catch (e) { fail++; console.log("  ✗", n, "\n     ", e.message.split("\n")[0]); } };

console.log("transient (retry the same request):");
for (const m of [
  "gateway 504: <!DOCTYPE html>",
  "gateway 502: bad gateway",
  "gateway 429: rate limited",
  "TypeError: terminated",
  "socket hang up",
  "fetch failed",
]) it(JSON.stringify(m.slice(0, 34)), () => assert.equal(isTransient(new Error(m)), true));

console.log("\nclient-side timeouts (the nine-minute stall):");
for (const m of [
  "gateway call aborted after 240s — no reply",
  "gateway went quiet for 60s mid-reply — treating it as dropped",
  "gateway call exceeded the time limit",
]) it(JSON.stringify(m.slice(0, 40)), () => assert.equal(isTransient(new Error(m)), true));

console.log("\nNOT transient (never silently retried):");
for (const m of [
  "gateway 400: bad request",
  "gateway 401: unauthorized",
  "model returned non-JSON: Sure, here you go",
  "extract_not_configured",
  "no such draft",
]) it(JSON.stringify(m.slice(0, 34)), () => assert.equal(isTransient(new Error(m)), false));

console.log("\ntruncation (split the chunk, don't just retry):");
it("detects a cut-off reply", () =>
  assert.equal(isTruncation(new Error("the model's reply was cut off mid-JSON (63999 chars) — this chunk is too large")), true));
it("a 504 is not a truncation", () => assert.equal(isTruncation(new Error("gateway 504: <!DOCTYPE html>")), false));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
