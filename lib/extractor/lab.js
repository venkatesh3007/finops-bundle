// The extractor improves its own code.
//
//   you describe what went wrong  →  the model REWRITES the extractor module
//   →  the candidate is run against every saved failing statement
//   →  the reconciler scores each run against the statement's printed balance
//   →  it is promoted ONLY if nothing regresses and something improves
//
// The gate is what makes this safe to run unattended: "better" is decided by
// arithmetic on the statement's own numbers, not by the model's opinion of its
// own work. A rejected candidate is kept with its scores so you can see why.
import { chatText, gatewayConfigured } from "../statements/gateway.js";
import { MODULE_CONTRACT, ModuleError, compileModule } from "./sandbox.js";
import { extractWithModule, scoreRun } from "./run.js";
import * as store from "./store.js";

const MAX_FIXTURES = 6;      // bounds the gateway spend of one improve run
const MAX_ATTEMPTS = 3;      // candidate rewrites before giving up
const SAMPLE_CHARS = 5000;   // how much statement text the author gets to see

// Run one module source against a set of fixtures. Returns [{fixture, score}].
export async function evaluate(source, fixtures) {
  const out = [];
  for (const f of fixtures) {
    try {
      const res = await extractWithModule({
        source, text: f.text_body, filename: f.name, bank: f.bank || "",
      });
      out.push({ fixture_id: f.id, name: f.name, score: res.error ? { error: res.error } : scoreRun(res) });
    } catch (e) {
      out.push({ fixture_id: f.id, name: f.name, score: { error: String(e.message || e) } });
    }
  }
  return out;
}

const byId = (rows) => new Map(rows.map((r) => [r.fixture_id, r.score]));

// Compare candidate against the current champion, fixture by fixture.
export function verdict(candidate, champion, targetFixtureId = null) {
  const cand = byId(candidate), champ = byId(champion);
  const regressions = [], improvements = [], details = [];
  for (const [id, c] of cand) {
    const b = champ.get(id) || {};
    const line = { fixture_id: id, before: b, after: c };
    details.push(line);
    if (c.error) { regressions.push({ ...line, why: `candidate errored: ${c.error}` }); continue; }
    if (b.error) { improvements.push({ ...line, why: "candidate runs where the current one errored" }); continue; }
    if (c.rows < b.rows) regressions.push({ ...line, why: `found ${b.rows - c.rows} fewer rows` });
    else if (c.rows > b.rows) improvements.push({ ...line, why: `found ${c.rows - b.rows} more rows` });
    if (c.breaks > b.breaks) regressions.push({ ...line, why: `${c.breaks - b.breaks} more balance breaks` });
    else if (c.breaks < b.breaks) improvements.push({ ...line, why: `${b.breaks - c.breaks} fewer balance breaks` });
    if (b.reconciled && !c.reconciled) regressions.push({ ...line, why: "no longer reconciles" });
    else if (!b.reconciled && c.reconciled) improvements.push({ ...line, why: "now reconciles" });
  }
  const targetImproved = !targetFixtureId || improvements.some((i) => i.fixture_id === targetFixtureId);
  const promote = regressions.length === 0 && improvements.length > 0 && targetImproved;
  return {
    promote, regressions, improvements, details,
    reason: regressions.length ? `rejected — ${regressions.length} regression(s): ${regressions[0].why}`
      : !improvements.length ? "rejected — nothing measurably improved"
      : !targetImproved ? "rejected — other fixtures improved but the one you reported did not"
      : `promoted — ${improvements.length} improvement(s), no regressions`,
  };
}

function authorPrompt({ source, complaint, target, targetScore, otherScores }) {
  const evidence = [
    target && `THE STATEMENT THAT IS WRONG (${target.name})`,
    target && `What the user says is wrong: ${complaint || target.complaint || "(not described)"}`,
    targetScore && `Current result on it: ${targetScore.rows} rows, ${targetScore.breaks} balance breaks, reconciled=${targetScore.reconciled}${targetScore.error ? `, error=${targetScore.error}` : ""}`,
    target && `First ${SAMPLE_CHARS} characters of its raw text:\n"""\n${String(target.text_body).slice(0, SAMPLE_CHARS)}\n"""`,
  ].filter(Boolean).join("\n\n");

  const others = otherScores?.length
    ? `\n\nThese other statements currently work — your rewrite MUST NOT make them worse:\n${otherScores.map((o) => `- ${o.name}: ${o.score.rows} rows, ${o.score.breaks} breaks, reconciled=${o.score.reconciled}`).join("\n")}`
    : "";

  return [
    { role: "system", content: `You maintain a bank-statement extractor. You are given its CURRENT SOURCE and a statement it handles badly. Rewrite the module so it handles that statement correctly WITHOUT breaking the ones that already work.

${MODULE_CONTRACT}

How your work is judged (automatically, before anything ships): the extractor is run on every saved problem statement and each result is checked against that statement's own printed running balance — bank: balance[i] == balance[i-1] + amount[i]; card: outstanding[i] == outstanding[i-1] - amount[i]. A row that fails is a "balance break". Your rewrite is accepted only if no statement loses rows, none gains balance breaks, and the reported one measurably improves.

Where to make the fix:
- prompt — wrong signs, wrong dates, skipped or invented rows, misread columns
- preprocess — junk that confuses the model: repeated page headers/footers, wrapped narration lines that should be joined, marketing blocks
- chunk — rows lost at a split, or replies cut off mid-JSON (split smaller / on safer boundaries)
- postprocess — deterministic repairs: sign fixes from balance movement, carrying a date header forward, dropping duplicate rows at chunk seams

Prefer a deterministic fix in preprocess/postprocess over asking the model more nicely — code is repeatable, persuasion is not.

Reply with ONLY the new module: one parenthesised JavaScript object expression, no markdown fences, no commentary.` },
    { role: "user", content: `CURRENT SOURCE:\n${source}\n\n${evidence}${others}` },
  ];
}

function cleanSource(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = t.indexOf("({");
  if (start > 0) t = t.slice(start);
  return t.trim();
}

// The whole loop. Returns a report — what it tried, what it scored, what shipped.
export async function improve(entity, { complaint = "", fixture_id = null, dry_run = false } = {}) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const entId = await store.entityId(entity);
  const fixtures = (await store.listFixtures(entity, { activeOnly: true, withBody: true })).slice(0, MAX_FIXTURES);
  if (!fixtures.length) throw new Error("no saved problem statements to learn from — report a problem on a statement first");

  const target = fixture_id ? fixtures.find((f) => f.id === fixture_id) : fixtures[0];
  if (!target) throw new Error("that statement isn't in the corpus (it may have been removed)");

  const champion = await store.activeVersion(entity, entId);
  const championScores = await evaluate(champion.source, fixtures);
  const targetScore = byId(championScores).get(target.id);

  const attempts = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let source;
    try {
      const msgs = authorPrompt({
        source: champion.source, complaint, target, targetScore,
        otherScores: championScores.filter((s) => s.fixture_id !== target.id),
      });
      if (attempts.length) {
        msgs.push({ role: "user", content: `Your previous attempt was not accepted: ${attempts[attempts.length - 1].reason}. Fix that and try a different approach.` });
      }
      source = cleanSource(await chatText(msgs, { max_tokens: 8000 }));
      compileModule(source); // fail fast on a broken module, before spending on evaluation
    } catch (e) {
      attempts.push({ attempt, reason: e instanceof ModuleError ? e.message : String(e.message || e), promoted: false });
      continue;
    }

    const candidateScores = await evaluate(source, fixtures);
    const v = verdict(candidateScores, championScores, target.id);
    attempts.push({ attempt, reason: v.reason, promoted: v.promote, improvements: v.improvements, regressions: v.regressions, scores: candidateScores });

    if (v.promote) {
      if (dry_run) return { ok: true, dry_run: true, attempts, champion_version: champion.version, would_promote: true };
      const version = await store.nextVersionNumber(entId);
      const saved = await store.saveVersion(entId, {
        version, source, parent_version: champion.version,
        notes: (complaint || target.complaint || "improvement").slice(0, 500),
        score: { fixtures: candidateScores, verdict: v.reason },
      });
      await store.activate(entity, version);
      for (const s of candidateScores) await store.updateFixtureBaseline(entId, s.fixture_id, s.score);
      return { ok: true, promoted: true, version: saved.version, attempts, champion_version: champion.version, verdict: v };
    }
  }
  return { ok: true, promoted: false, attempts, champion_version: champion.version, champion_scores: championScores,
           message: `Tried ${attempts.length} rewrite(s); none beat version ${champion.version} without regressing another statement. The current extractor is unchanged.` };
}

// Score the champion as it stands (used by the lab UI's "re-test" button).
export async function testChampion(entity) {
  const entId = await store.entityId(entity);
  const fixtures = (await store.listFixtures(entity, { activeOnly: true, withBody: true })).slice(0, MAX_FIXTURES);
  if (!fixtures.length) return { version: (await store.activeVersion(entity, entId)).version, scores: [] };
  const champion = await store.activeVersion(entity, entId);
  const scores = await evaluate(champion.source, fixtures);
  for (const s of scores) await store.updateFixtureBaseline(entId, s.fixture_id, s.score);
  return { version: champion.version, scores };
}
