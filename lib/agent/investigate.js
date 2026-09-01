// The investigation loop, on native tool calling.
//
// This used to negotiate a protocol in prose — "reply with ONE JSON object" —
// and parse it back out with a brace scanner. Every failure this week came from
// that: a preamble sentence broke it, three objects broke it, an empty completion
// became the assistant's answer, and turning thinking off to fix one of those
// changed the reply shape and broke the next. None of it was the model.
//
// With tools declared properly the ambiguity is gone. A turn either carries
// tool_calls or it doesn't; there is nothing to parse and nothing to guess.
import { chatMessage, gatewayConfigured } from "../statements/gateway.js";
import { INVESTIGATE_PROMPT, investigateContext } from "./investigate-prompt.js";
import { TOOLS, runTool } from "./investigate-tools.js";
import { loadCorpus } from "../statements/corpus-query.js";

const MAX_LOOKS = Number(process.env.INVESTIGATE_TURNS || 14);
const EFFORT = process.env.INVESTIGATE_EFFORT || "low";

// Our tool descriptions carry their own input shape in prose; give the provider a
// real schema so it validates arguments instead of us discovering them wrong.
const SCHEMAS = {
  run_analysis: { statement: { type: "string" }, code: { type: "string" } },
  read_source: { statement: { type: "string" }, grep: { type: "string" }, around: { type: "integer" }, page: { type: "integer" }, from: { type: "integer" }, to: { type: "integer" } },
  read_rows: { statement: { type: "string" }, from: { type: "integer" }, to: { type: "integer" }, text: { type: "string" } },
  query_statements: { op: { type: "string" }, statement: { type: "string" }, text: { type: "string" }, account: { type: "string" }, bank: { type: "string" }, by: { type: "string" }, sort: { type: "string" }, limit: { type: "integer" } },
  propose_rule: { scope: { type: "string" }, rule: { type: "string" }, why: { type: "string" } },
};
const REQUIRED = { run_analysis: ["code"], propose_rule: ["scope", "rule"] };

const toolDefs = () => TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.what,
    parameters: { type: "object", properties: SCHEMAS[t.name] || {}, required: REQUIRED[t.name] || [] },
  },
}));

export async function investigate(entity, history, { focus = null, onNote = null } = {}) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const corpus = await loadCorpus(entity).catch(() => ({ statements: [] }));

  const messages = [
    { role: "system", content: `${INVESTIGATE_PROMPT}\n\n## What is on screen\n${investigateContext({ statements: corpus.statements, focus })}` },
    ...history.slice(-8).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content).slice(0, 6000) })),
  ];

  const trace = [];
  const proposed = [];
  let looks = 0;

  for (let turn = 0; turn < MAX_LOOKS + 6; turn++) {
    // The budget is on LOOKING. propose_rule is the conclusion, not a step, so it
    // never costs a look and is never refused.
    const spent = looks >= MAX_LOOKS;
    if (spent && turn > 0 && messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: "That is all the investigation you get. If you have PROVED a cause, call propose_rule — it costs you nothing. Then write the answer from what you established: what is wrong, the numbers you measured, and the cause." });
    }

    const reply = await chatMessage(messages, {
      tools: spent ? toolDefs().filter((t) => t.function.name === "propose_rule") : toolDefs(),
      max_tokens: 8000,
      effort: EFFORT,
    });

    // No tool calls means this is the answer. An empty one is a failure, not an
    // answer — say so rather than presenting nothing.
    if (!reply.tool_calls?.length) {
      const text = String(reply.content || "").trim();
      return { reply: text || findings(trace), trace, proposed_rules: proposed, empty_reply: !text };
    }

    // Hand the assistant turn back verbatim, thinking blocks included — the
    // provider verifies their signatures and rejects a turn that dropped them.
    messages.push({
      role: "assistant",
      content: reply.content || null,
      tool_calls: reply.tool_calls,
      ...(reply.reasoning_blocks?.length ? { reasoning_blocks: reply.reasoning_blocks } : {}),
    });

    for (const call of reply.tool_calls) {
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
      await onNote?.(`${name}(${Object.entries(args).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(", ").slice(0, 120)})`);

      let out;
      try { out = await runTool(entity, name, args); }
      catch (e) { out = { summary: `The ${name} tool failed: ${String(e.message || e).slice(0, 300)}`, data: null }; }

      trace.push({ tool: name, thought: reply.content || "", input: args, summary: out.summary, data: out.data });
      if (out.rule_id) proposed.push(out.rule_id);
      if (name !== "propose_rule") looks++;

      messages.push({ role: "tool", tool_call_id: call.id, content: String(out.summary || "").slice(0, 12000) });
    }
  }

  return { reply: findings(trace), trace, proposed_rules: proposed, out_of_turns: true };
}

// What the investigation established, so a lost write-up still returns the work.
function findings(trace) {
  const thoughts = trace.map((t) => t.thought).filter(Boolean);
  const last = trace[trace.length - 1];
  return [
    "I didn't get to write this up properly, but here is what the investigation established:",
    "",
    ...thoughts.slice(-8).map((t) => `· ${String(t).slice(0, 400)}`),
    last?.summary ? `\nThe last thing I measured:\n${String(last.summary).slice(0, 1200)}` : "",
  ].filter(Boolean).join("\n");
}
