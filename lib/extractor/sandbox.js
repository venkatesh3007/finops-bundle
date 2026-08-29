// Runs an EXTRACTOR MODULE — code that the system writes for itself — without
// letting it touch anything. The module is the part of statement extraction that
// is worth evolving: the prompt, how the text is cleaned, how it's split for the
// model, and how the model's rows are repaired afterwards. All of that is pure
// (string/array in, string/array out), so it can run in a locked-down vm with no
// require, no fs, no network, no timers, and a wall-clock timeout.
//
// The host keeps everything dangerous: the gateway call, the DB, the ledger.
// A bad module can therefore only produce bad ROWS — and the reconciler catches
// those against the statement's own printed balance before anyone sees them.
import vm from "node:vm";

export const MODULE_CONTRACT = `A statement-extractor module is ONE JavaScript expression that evaluates to an
object (wrap it in parentheses). It may use only pure built-ins: JSON, Math,
Number, String, Array, Object, RegExp, Date, isNaN, parseInt, parseFloat.
There is no require/import, no fetch, no fs, no console, no timers.

({
  // Instructions sent to the model as the system prompt. This is the biggest
  // lever — be explicit about sign conventions, dates, and what to skip.
  prompt: "…",

  // Clean the raw statement text before it is split. Return a string.
  // ctx = { filename, bank, statement_type, rules, hint }
  preprocess(text, ctx) { return text; },

  // Split the cleaned text into pieces small enough for one model call.
  // Return an array of strings. Keep every transaction line in exactly one piece.
  chunk(text, ctx) { return [text]; },

  // Repair/normalise the model's rows after all chunks are merged.
  // txns = [{ date:"YYYY-MM-DD", description, amount:Number, balance:Number|null }]
  // ctx also has { opening_balance, closing_balance, period }. Return the array.
  postprocess(txns, ctx) { return txns; },
})`;

const TIMEOUT_MS = 2000;

function baseSandbox() {
  // A fresh, frozen set of pure globals. No console/process/require/fetch.
  return {
    JSON, Math, Number, String, Array, Object, RegExp, Date, Boolean, Error,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
}

export class ModuleError extends Error {}

// Round to paise without the binary-float artifact that makes 1.005*100 land on
// 100.49999999999999 (and silently truncate a rupee-and-a-half to 1.00).
const money = (n) => Math.round((Number(n) + (Number(n) >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;

// Compile a module source into callable functions. Throws ModuleError with a
// readable reason — that message is what the improver sees on its next attempt.
export function compileModule(source) {
  let mod;
  try {
    mod = vm.runInNewContext(`(${String(source).trim().replace(/^\(|\)\s*;?\s*$/g, "")})`, baseSandbox(), { timeout: TIMEOUT_MS, displayErrors: true });
  } catch (e) {
    throw new ModuleError(`module did not compile: ${e.message}`);
  }
  if (!mod || typeof mod !== "object") throw new ModuleError("module must evaluate to an object");
  if (typeof mod.prompt !== "string" || mod.prompt.trim().length < 40) throw new ModuleError("module.prompt must be a non-trivial string");
  for (const fn of ["preprocess", "chunk", "postprocess"]) {
    if (typeof mod[fn] !== "function") throw new ModuleError(`module.${fn} must be a function`);
  }

  const guard = (name, fn) => (...args) => {
    try {
      return vm.runInNewContext("f.apply(null, a)", { ...baseSandbox(), f: fn, a: args }, { timeout: TIMEOUT_MS });
    } catch (e) {
      throw new ModuleError(`${name}() failed: ${e.message}`);
    }
  };

  return {
    prompt: mod.prompt,
    preprocess: (text, ctx) => {
      const out = guard("preprocess", mod.preprocess)(String(text ?? ""), ctx || {});
      if (typeof out !== "string") throw new ModuleError("preprocess() must return a string");
      return out;
    },
    chunk: (text, ctx) => {
      const out = guard("chunk", mod.chunk)(String(text ?? ""), ctx || {});
      if (!Array.isArray(out) || !out.length) throw new ModuleError("chunk() must return a non-empty array");
      if (out.some((c) => typeof c !== "string")) throw new ModuleError("chunk() must return an array of strings");
      if (out.length > 200) throw new ModuleError(`chunk() returned ${out.length} pieces (max 200)`);
      return out;
    },
    postprocess: (txns, ctx) => {
      const out = guard("postprocess", mod.postprocess)(txns || [], ctx || {});
      if (!Array.isArray(out)) throw new ModuleError("postprocess() must return an array");
      // Never let a module invent junk: keep only well-formed rows.
      return out.filter((t) => t && typeof t === "object" && typeof t.amount === "number" && Number.isFinite(t.amount))
        .map((t) => ({
          date: String(t.date || "").slice(0, 10),
          description: String(t.description ?? "").slice(0, 400),
          amount: money(t.amount),
          balance: t.balance == null || !Number.isFinite(Number(t.balance)) ? null : money(t.balance),
        }));
    },
  };
}
