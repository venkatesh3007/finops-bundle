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

// A fresh context that shares NOTHING with this realm.
//
// It used to inject this realm's JSON, Math, Object and friends, on the reasoning
// that naming the allowed globals was safer than leaving them out. It is the
// opposite. Any object from the host realm hands the sandbox that realm's
// prototype chain, and therefore its Function constructor:
//
//     JSON.constructor.constructor("return process.env")()
//
// compiles in the HOST realm, where process lives. Measured before this change:
// that expression returned 73 environment variables — ADMIN_TOKEN, DATABASE_URL,
// AIKAARA_GATEWAY_KEY, all of it — to code written by a model.
//
// An empty context is not a weaker sandbox, it is a stronger one: V8 gives it its
// own complete set of intrinsics (JSON, Math, Date, RegExp all work normally) and
// that realm's Function constructor closes over a global with no process, no
// require and no fetch. Verified: the same expression returns "no process".
//
// The rule that follows: ONLY PRIMITIVES CROSS THE BOUNDARY. Data goes in as a
// JSON string and comes out as one.
function freshContext() {
  return vm.createContext(Object.create(null));
}

export class ModuleError extends Error {}

// Round to paise without the binary-float artifact that makes 1.005*100 land on
// 100.49999999999999 (and silently truncate a rupee-and-a-half to 1.00).
const money = (n) => Math.round((Number(n) + (Number(n) >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;

// Compile a module source into callable functions. Throws ModuleError with a
// readable reason — that message is what the improver sees on its next attempt.
// Evaluate `source` in its own context and return a caller that invokes one of
// its methods with JSON-encoded arguments. The compiled functions never leave
// the context and the arguments never enter it as objects.
function compileIn(source, label, ErrorClass) {
  const ctx = freshContext();
  try {
    vm.runInContext(`globalThis.__m = (${String(source).trim().replace(/^\(|\)\s*;?\s*$/g, "")});`, ctx, { timeout: TIMEOUT_MS, displayErrors: true });
  } catch (e) {
    throw new ErrorClass(`${label} did not compile: ${e.message}`);
  }
  const shape = vm.runInContext(`(function(){ const m = globalThis.__m; if (!m || typeof m !== "object") return null;
    return { keys: Object.keys(m), types: Object.keys(m).reduce((a,k)=>(a[k]=typeof m[k],a),{}), prompt: typeof m.prompt === "string" ? m.prompt : null }; })()`, ctx, { timeout: TIMEOUT_MS });
  if (!shape) throw new ErrorClass(`${label} must evaluate to an object`);

  // args go in as JSON, the result comes back as JSON — only strings cross.
  const call = (name, args) => {
    ctx.__args = JSON.stringify(args ?? []);
    let raw;
    try {
      raw = vm.runInContext(`JSON.stringify(globalThis.__m[${JSON.stringify(name)}].apply(null, JSON.parse(__args)) ?? null)`, ctx, { timeout: TIMEOUT_MS });
    } catch (e) {
      throw new ErrorClass(`${name}() failed: ${e.message}`);
    }
    if (typeof raw !== "string") throw new ErrorClass(`${name}() returned something that is not JSON`);
    try { return JSON.parse(raw); } catch { throw new ErrorClass(`${name}() returned something that is not JSON`); }
  };
  return { shape, call, ctx };
}

export function compileModule(source) {
  const { shape, call } = compileIn(source, "module", ModuleError);
  const mod = { prompt: shape.prompt };
  if (typeof mod.prompt !== "string" || mod.prompt.trim().length < 40) throw new ModuleError("module.prompt must be a non-trivial string");
  for (const fn of ["preprocess", "chunk", "postprocess"]) {
    if (shape.types[fn] !== "function") throw new ModuleError(`module.${fn} must be a function`);
  }
  const guard = (name) => (...args) => call(name, args);

  return {
    prompt: mod.prompt,
    preprocess: (text, ctx) => {
      const out = guard("preprocess")(String(text ?? ""), ctx || {});
      if (typeof out !== "string") throw new ModuleError("preprocess() must return a string");
      return out;
    },
    chunk: (text, ctx) => {
      const out = guard("chunk")(String(text ?? ""), ctx || {});
      if (!Array.isArray(out) || !out.length) throw new ModuleError("chunk() must return a non-empty array");
      if (out.some((c) => typeof c !== "string")) throw new ModuleError("chunk() must return an array of strings");
      if (out.length > 200) throw new ModuleError(`chunk() returned ${out.length} pieces (max 200)`);
      return out;
    },
    postprocess: (txns, ctx) => {
      const out = guard("postprocess")(txns || [], ctx || {});
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

// ── per-document parser ─────────────────────────────────────────────────────
// A DIFFERENT contract from the evolving extractor module: this is code written
// for ONE statement's layout. It gets the pdf.js text with its column spacing
// preserved (character offset ≈ x position on the page), so it can slice columns
// deterministically instead of a model retyping thousands of numbers.
export const PARSER_CONTRACT = `A statement parser is ONE JavaScript expression evaluating to an object
(wrap it in parentheses). Only pure built-ins are available: JSON, Math, Number,
String, Array, Object, RegExp, Date, isNaN, parseInt, parseFloat. No require,
no fetch, no fs, no console, no timers.

({
  parse(pages) {
    // pages: string[] — one entry per PDF page. Within a page, lines are
    // separated by "\n" and SPACING IS PRESERVED: a character offset in the
    // line corresponds to a horizontal position on the page. So a column can be
    // read with line.slice(startCol, endCol) once you find the header offsets.
    //
    // Return:
    // {
    //   statement_type: "bank" | "card",
    //   opening_balance: number | null,
    //   closing_balance: number | null,
    //   transactions: [
    //     { date: "YYYY-MM-DD", description: "...", amount: -182.00, balance: 19544.18 }
    //   ]
    // }
    // amount is SIGNED cashflow: negative = money out, positive = money in.
    // balance = the running balance printed on that row, or null.
  },
})`;

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : money(v));

// A whole statement can be thousands of rows — more room than the little pure
// helpers get, still bounded so a runaway loop can't hang the process.
const PARSE_TIMEOUT_MS = 15_000;

export function compileParser(source) {
  const { shape, ctx } = compileIn(source, "parser", ModuleError);
  if (shape.types.parse !== "function") throw new ModuleError("parser.parse must be a function");

  return (pages) => {
    ctx.__args = JSON.stringify([pages ?? []]);
    let raw;
    try {
      raw = vm.runInContext(`JSON.stringify(globalThis.__m.parse.apply(null, JSON.parse(__args)) ?? null)`, ctx, { timeout: PARSE_TIMEOUT_MS });
    } catch (e) {
      throw new ModuleError(`parse() failed: ${e.message}`);
    }
    let out;
    try { out = typeof raw === "string" ? JSON.parse(raw) : null; }
    catch { throw new ModuleError("parse() returned something that is not JSON"); }
    if (!out || typeof out !== "object") throw new ModuleError("parse() must return an object");
    const txns = Array.isArray(out.transactions) ? out.transactions : [];
    return {
      statement_type: out.statement_type === "card" ? "card" : "bank",
      // null must stay null: Number(null) is 0, and a fabricated 0 opening
      // balance would make the reconciler's opening+net=closing check nonsense.
      opening_balance: num(out.opening_balance),
      closing_balance: num(out.closing_balance),
      transactions: txns
        .filter((t) => t && typeof t === "object" && Number.isFinite(Number(t.amount)))
        .map((t) => ({
          date: String(t.date || "").slice(0, 10),
          description: String(t.description ?? "").slice(0, 400),
          amount: money(t.amount),
          balance: t.balance == null || !Number.isFinite(Number(t.balance)) ? null : money(t.balance),
        })),
    };
  };
}

// ---------------------------------------------------------------------------
// ANALYSIS SANDBOX — arbitrary read-only computation over a statement.
//
// This is what separates an investigation from a chatbot. The fixed query
// vocabulary in corpus-query.js can answer "which statements have breaks"; it
// cannot express "pair every amount in the source text with the payee printed
// beside it and compare that pairing to the extracted rows" — which is the
// question that found the two real bugs on 2026-08-31.
//
// Same jail as the parser modules: no require, no fetch, no fs, no process, no
// timers, a wall clock, and the result must survive JSON round-tripping. The
// context is a deep-frozen copy, so nothing an analysis does can reach the
// caller's data.
const ANALYSIS_TIMEOUT_MS = 4000;
const ANALYSIS_MAX_OUTPUT = 64_000;

export class AnalysisError extends Error {}

// `code` is a JS expression OR a body ending in a return, evaluated with `ctx`
// in scope. Returns { value, json } — value already JSON-safe.
export function runAnalysis(code, ctx) {
  const src = String(code || "").trim();
  if (!src) throw new AnalysisError("no code given");
  if (src.length > 20_000) throw new AnalysisError("analysis code is too long (20k max)");
  // Both shapes are allowed: a bare expression, or a body ending in a return.
  // Try the expression form first and fall back on a SyntaxError. Sniffing for
  // the word "return" does NOT work — it matches inside a string, so
  // `Function("return 1+1")` was read as a body and silently evaluated to
  // undefined, which is exactly the kind of quiet wrong answer this whole system
  // exists to prevent.
  // The statement goes in as a JSON string and is parsed inside, so the analysis
  // only ever touches objects belonging to its own realm — see freshContext().
  const c = freshContext();
  try { c.__json = JSON.stringify(ctx ?? {}); }
  catch { throw new AnalysisError("the statement could not be serialised for analysis"); }
  const run = (body) => vm.runInContext(`JSON.stringify((function(ctx){ ${body} })(JSON.parse(__json)) ?? null)`, c, { timeout: ANALYSIS_TIMEOUT_MS, displayErrors: true });
  let raw;
  try {
    try {
      raw = run(`return (${src});`);
    } catch (e) {
      // NOT `instanceof SyntaxError`: the error is constructed inside the vm's
      // realm, so it fails an instanceof against this realm's constructor.
      if (e?.name !== "SyntaxError") throw e;
      raw = run(src);
    }
  } catch (e) {
    // The message is handed back to the model so it can fix its own code —
    // which is the loop that matters, and the one that caught two bad regexes.
    throw new AnalysisError(String(e.message || e).slice(0, 400));
  }
  // Stringifying happens INSIDE the context, so a function or symbol comes back
  // as undefined rather than as a live object.
  if (typeof raw !== "string") throw new AnalysisError("the analysis returned a function or symbol — return data, not code");
  if (raw.length > ANALYSIS_MAX_OUTPUT) {
    throw new AnalysisError(`the analysis returned ${raw.length} characters (max ${ANALYSIS_MAX_OUTPUT}) — aggregate or slice before returning`);
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new AnalysisError("the analysis returned something that is not JSON"); }
  return { value, json: raw };
}
