// One box, one loop.
//
//   you describe what's wrong, in your own words
//     → the parser reads back EVERY statement you've already parsed and works
//       out what is actually going wrong (diagnose)
//     → it rewrites its own code to fix that (author)
//     → the candidate re-parses all of those statements (evaluate)
//     → each result is checked against that statement's own printed running
//       balance, and the rewrite ships ONLY if nothing got worse (gate)
//     → you get a button to re-parse everything with the new version
//
// The gate is what makes this safe to run on a vague complaint: "better" is
// arithmetic on your statements' own numbers, not the model's opinion of its
// own work. A wrong report simply gets rejected.
import { chatText, gatewayConfigured } from "../statements/gateway.js";
import { MODULE_CONTRACT, ModuleError, compileModule } from "./sandbox.js";
import { extractWithModule, scoreRun } from "./run.js";
import { buildCorpus, describeCorpus, MAX_CORPUS } from "./corpus.js";
import * as store from "./store.js";

const MAX_ATTEMPTS = 3;
const SAMPLE_CHARS = 4000;
const CONCURRENCY = 3;

// Run one parser over the corpus. Concurrency keeps the wall clock sane; each
// item is independent.
export async function evaluate(source, items) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      try {
        const res = await extractWithModule({ source, text: it.text, filename: it.name, bank: it.bank || "" });
        out[i] = { id: it.id, name: it.name, score: res.error ? { error: res.error } : scoreRun(res) };
      } catch (e) {
        out[i] = { id: it.id, name: it.name, score: { error: String(e.message || e) } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

const byId = (rows) => new Map(rows.map((r) => [r.id, r.score]));

// Compare candidate against the current parser, statement by statement.
export function verdict(candidate, champion) {
  const cand = byId(candidate), champ = byId(champion);
  const regressions = [], improvements = [];
  for (const [id, c] of cand) {
    const b = champ.get(id) || {};
    const name = candidate.find((x) => x.id === id)?.name;
    const line = { id, name, before: b, after: c };
    if (c.error) { regressions.push({ ...line, why: `${name}: candidate errored — ${String(c.error).slice(0, 120)}` }); continue; }
    if (b.error) { improvements.push({ ...line, why: `${name}: now parses (it used to fail)` }); continue; }
    if (c.rows < b.rows) regressions.push({ ...line, why: `${name}: ${b.rows - c.rows} fewer rows` });
    else if (c.rows > b.rows) improvements.push({ ...line, why: `${name}: ${c.rows - b.rows} more rows` });
    if (c.breaks > b.breaks) regressions.push({ ...line, why: `${name}: ${c.breaks - b.breaks} more balance breaks` });
    else if (c.breaks < b.breaks) improvements.push({ ...line, why: `${name}: ${b.breaks - c.breaks} fewer balance breaks` });
    if (b.reconciled && !c.reconciled) regressions.push({ ...line, why: `${name}: no longer reconciles` });
    else if (!b.reconciled && c.reconciled) improvements.push({ ...line, why: `${name}: now reconciles` });
  }
  const promote = regressions.length === 0 && improvements.length > 0;
  return {
    promote, regressions, improvements,
    reason: regressions.length ? `kept the current parser — the rewrite broke something: ${regressions[0].why}`
      : !improvements.length ? "kept the current parser — the rewrite changed nothing measurable"
      : `shipped — ${improvements.length} improvement${improvements.length === 1 ? "" : "s"}, nothing regressed`,
  };
}

// Step 1 — read the statements back and say what's actually wrong. This is also
// what the UI shows you, so a run is never a black box.
async function diagnose({ complaint, items, scores }) {
  const scoreById = byId(scores);
  const worst = [...items].sort((a, b) => {
    const sa = scoreById.get(a.id) || {}, sb = scoreById.get(b.id) || {};
    return ((sb.error ? 100 : 0) + (sb.breaks || 0)) - ((sa.error ? 100 : 0) + (sa.breaks || 0));
  }).slice(0, 2);

  const samples = worst.map((w) => {
    const s = scoreById.get(w.id) || {};
    return `--- ${w.name} — currently ${s.error ? `FAILS (${s.error})` : `${s.rows} rows, ${s.breaks} balance breaks, reconciled=${s.reconciled}`}\n${String(w.text).slice(0, SAMPLE_CHARS)}`;
  }).join("\n\n");

  const text = await chatText([
    { role: "system", content: `You maintain a bank-statement parser. Given the user's complaint, the current state of every statement it has parsed, and raw text from the worst ones, say what is ACTUALLY going wrong.

A "balance break" means the extracted rows don't chain against the statement's own printed running balance (bank: balance[i] == balance[i-1] + amount[i]; card: outstanding[i] == outstanding[i-1] - amount[i]). Breaks mean a wrong amount, a missing row, or a duplicated row.

Be concrete and short (under 120 words). Name the mechanism — e.g. "rows under a carried-forward date header lose their date", "the rewards table is being read as transactions", "rows are duplicated where the text is split into chunks", "credits on this card come through with the wrong sign". If the complaint doesn't match what you see in the data, SAY SO plainly.` },
    { role: "user", content: `USER'S COMPLAINT:\n${complaint || "(none given — look for whatever is worst)"}\n\nEVERY STATEMENT'S CURRENT STATE:\n${describeCorpus(items)}\n\nRAW TEXT FROM THE WORST ONES:\n${samples}` },
  ], { max_tokens: 500 });
  return String(text || "").trim();
}

// Step 2 — rewrite the parser.
function authorPrompt({ source, complaint, diagnosis, items, scores, lastFailure }) {
  const msgs = [
    { role: "system", content: `You maintain a bank-statement parser. Rewrite its module so the problems below are fixed WITHOUT breaking the statements that already parse correctly.

${MODULE_CONTRACT}

How your work is judged, automatically, before anything ships: the parser is re-run on every statement listed below and each result is checked against that statement's own printed running balance. Your rewrite is accepted only if NO statement loses rows, NO statement gains balance breaks, none stops reconciling — and at least one measurably improves.

Where the fix belongs:
- prompt — wrong signs, wrong dates, skipped or invented rows, misread columns
- preprocess — junk that confuses the model: repeated page headers/footers, wrapped narration lines that should be joined, marketing/rewards blocks, summary boxes
- chunk — rows lost at a split, duplicated at a seam, or replies cut off mid-JSON (split smaller, on safer boundaries)
- postprocess — deterministic repairs: fixing signs from balance movement, carrying a date header forward, dropping duplicate rows at chunk seams

Prefer a deterministic fix in preprocess/postprocess over asking the model more nicely — code is repeatable, persuasion is not. Keep the parts that already work; change as little as you can.

Reply with ONLY the new module: one parenthesised JavaScript object expression, no markdown fences, no commentary.` },
    { role: "user", content: `CURRENT PARSER SOURCE:\n${source}\n\nUSER'S COMPLAINT:\n${complaint || "(none given)"}\n\nDIAGNOSIS:\n${diagnosis}\n\nEVERY STATEMENT IT IS GRADED ON (these must not get worse):\n${describeCorpus(items)}\n\nRAW TEXT OF THE WORST ONE:\n${String(items[0]?.text || "").slice(0, SAMPLE_CHARS)}` },
  ];
  if (lastFailure) msgs.push({ role: "user", content: `Your previous attempt was rejected: ${lastFailure}. Fix that specifically and try a different approach.` });
  return msgs;
}

function cleanSource(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = t.indexOf("({");
  if (start > 0) t = t.slice(start);
  return t.trim();
}

// The whole thing, driven by one sentence from you.
export async function fixParser(entity, { complaint = "", dry_run = false } = {}) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const entId = await store.entityId(entity);
  const { items, total, problems, guards } = await buildCorpus(entId);
  if (!items.length) {
    return { ok: false, no_corpus: true, message: "There are no parsed statements to learn from yet — drop a statement in first, then tell me what it got wrong." };
  }

  const champion = await store.activeVersion(entity, entId);

  // Where we stand. Re-use a statement's stored result when it came from the
  // parser that's active now; only re-parse the ones whose result is stale.
  // A stored result is only a valid baseline if it came from the parser that is
  // active now AND was produced on the same text we're grading on.
  const reusable = (i) => i.version === champion.version && !i.truncated;
  const stale = items.filter((i) => !reusable(i));
  const fresh = items.filter(reusable)
    .map((i) => ({ id: i.id, name: i.name, score: { rows: i.known.rows, breaks: i.known.breaks, reconciled: i.known.reconciled, error: i.known.error } }));
  const championScores = [...fresh, ...(stale.length ? await evaluate(champion.source, stale) : [])];

  const diagnosis = await diagnose({ complaint, items, scores: championScores });

  const attempts = [];
  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let source;
    try {
      source = cleanSource(await chatText(
        authorPrompt({ source: champion.source, complaint, diagnosis, items, scores: championScores, lastFailure }),
        { max_tokens: 8000 },
      ));
      compileModule(source); // fail fast before spending on a full evaluation
    } catch (e) {
      lastFailure = e instanceof ModuleError ? e.message : String(e.message || e);
      attempts.push({ attempt, reason: `the rewrite wouldn't run: ${lastFailure}`, promoted: false });
      continue;
    }

    const candidateScores = await evaluate(source, items);
    const v = verdict(candidateScores, championScores);
    lastFailure = v.promote ? null : v.reason;
    attempts.push({ attempt, reason: v.reason, promoted: v.promote, improvements: v.improvements, regressions: v.regressions });

    if (v.promote) {
      if (dry_run) return { ok: true, dry_run: true, would_promote: true, diagnosis, attempts, champion_version: champion.version, corpus: { graded: items.length, total, problems, guards } };
      const version = await store.nextVersionNumber(entId);
      await store.saveVersion(entId, {
        version, source, parent_version: champion.version,
        notes: (complaint || diagnosis).slice(0, 500),
        score: { statements: candidateScores, verdict: v.reason, diagnosis },
      });
      await store.activate(entity, version);
      return {
        ok: true, promoted: true, version, champion_version: champion.version, diagnosis, attempts,
        improvements: v.improvements, corpus: { graded: items.length, total, problems, guards },
        message: `Parser updated to v${version}. ${v.improvements.length} statement${v.improvements.length === 1 ? "" : "s"} improved, none got worse — re-parse to apply it everywhere.`,
      };
    }
  }

  return {
    ok: true, promoted: false, diagnosis, attempts, champion_version: champion.version,
    corpus: { graded: items.length, total, problems, guards },
    message: `I tried ${attempts.length} rewrite${attempts.length === 1 ? "" : "s"} and none of them beat the current parser without breaking another statement, so nothing changed. ${attempts[attempts.length - 1]?.reason || ""}`,
  };
}

// Where the current parser stands across your statements (the "re-check" action).
export async function checkParser(entity) {
  const entId = await store.entityId(entity);
  const champion = await store.activeVersion(entity, entId);
  const { items, total, problems } = await buildCorpus(entId);
  if (!items.length) return { version: champion.version, scores: [], corpus: { graded: 0, total: 0, problems: 0 } };
  return { version: champion.version, scores: await evaluate(champion.source, items), corpus: { graded: items.length, total, problems, guards } };
}
