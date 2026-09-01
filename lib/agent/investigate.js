// The investigation loop: think → run something → look at what came back → revise.
// Longer than the studio's loop because debugging is iterative by nature; every
// tool result is real data, so the model is arguing with the document rather than
// with itself.
import { chatText, gatewayConfigured } from "../statements/gateway.js";
import { INVESTIGATE_PROMPT, investigateContext } from "./investigate-prompt.js";
import { TOOLS, TOOL_NAMES, runTool } from "./investigate-tools.js";
import { parseAction } from "./protocol.js";
import { loadCorpus } from "../statements/corpus-query.js";

const MAX_TURNS = Number(process.env.INVESTIGATE_TURNS || 14);
// NO THINKING IN A TOOL LOOP — measured, not assumed. The gateway converts the
// provider's reply into OpenAI shape and keeps only the text block, so an
// assistant turn is replayed on the next round with its thinking stripped. The
// provider will not accept that, and it does not error: it returns an empty
// completion with no usage at all. Two real investigations did all their work
// correctly and then answered "…" for exactly this reason.
//   effort "high", 4-turn history -> 0 chars, no usage
//   no thinking,   same history   -> 1454 chars, a correct answer
// The reasoning here comes from the tool loop — look, compute, look again —
// which is worth more than one deep think anyway. Set INVESTIGATE_EFFORT to
// override once the gateway can round-trip thinking blocks.
const EFFORT = process.env.INVESTIGATE_EFFORT || null;

function protocol() {
  return `## Using a tool

Reply with ONE JSON object and nothing else.

To use a tool:
{"thought": "one short line on what you are testing and why", "tool": "<name>", "input": { … }}

To answer:
{"reply": "your answer"}

Tools:
${TOOLS.map((t) => `### ${t.name}\n${t.what}\ninput: ${t.input}`).join("\n\n")}

ONE object per reply. No sentence before it, no second object after it, no plan
listing the calls you intend to make — issue the FIRST tool call and stop. You
will be given the result and asked again, and what you learn will usually change
what you do next. Anything after the first object is discarded.

Test before you conclude. A tool result that surprises you is usually your own
code — fix it and run it again rather than reporting the surprise as a finding.`;
}



// history: [{role, content}]. onNote streams the work to the caller.
export async function investigate(entity, history, { focus = null, onNote = null } = {}) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const corpus = await loadCorpus(entity).catch(() => ({ statements: [] }));

  const messages = [
    { role: "system", content: `${INVESTIGATE_PROMPT}\n\n${protocol()}\n\n## What is on screen\n${investigateContext({ statements: corpus.statements, focus })}` },
    ...history.slice(-8).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content).slice(0, 6000) })),
  ];

  const trace = [];
  const proposed = [];
  // What the investigation actually established, so an empty or lost reply still
  // hands back the work instead of a shrug.
  const findings = () => {
    const seen = trace.filter((t) => t.thought).map((t) => `· ${t.thought}`);
    const last = trace[trace.length - 1];
    return [
      "I didn't get to write this up properly, but here is what the investigation established:",
      "",
      ...seen.slice(-10),
      last?.summary ? `\nThe last thing I measured:\n${String(last.summary).slice(0, 1200)}` : "",
    ].filter(Boolean).join("\n");
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // A budget must degrade into an answer, not into nothing. On the last turn,
    // say so and take the write-up — an investigation that proved its case and
    // then fell off the end of the loop reports nothing, which is what happened:
    // ten turns of evidence, "extra_debits 274 = expected_gap 274, match true",
    // and no conclusion.
    const lastTurn = turn === MAX_TURNS - 1;
    if (lastTurn) {
      messages.push({ role: "user", content: "You have no tool calls left. Write the answer now from what you have already established: what is wrong, the numbers you measured, the cause, and — if you have proved one — call propose_rule. Do not ask for another tool." });
    }
    let raw = await chatText(messages, { max_tokens: 8000, effort: EFFORT });
    // An empty completion is a failure, never an answer. Retry once plainly
    // before giving up — and if it is still empty, hand back the findings.
    if (!String(raw || "").trim()) {
      await onNote?.("the model returned nothing — asking again");
      raw = await chatText(messages, { max_tokens: 8000 });
      if (!String(raw || "").trim()) {
        return { reply: findings(), trace, proposed_rules: proposed, empty_reply: true };
      }
    }
    const act = parseAction(raw, TOOL_NAMES);
    if (act.reply) return { reply: act.reply, trace, proposed_rules: proposed };
    if (lastTurn) {
      // It asked for another tool with nothing left to spend it on. Its own words
      // are still worth more than a raw JSON dump.
      return { reply: act.thought ? `${act.thought}\n\n${findings()}` : findings(), trace, proposed_rules: proposed, out_of_turns: true };
    }

    await onNote?.(act.thought || `running ${act.tool}`);
    trace.push({ tool: act.tool, thought: act.thought, input: act.input });
    let out;
    try { out = await runTool(entity, act.tool, act.input); }
    catch (e) { out = { summary: `The ${act.tool} tool failed: ${String(e.message || e).slice(0, 300)}`, data: null }; }
    trace[trace.length - 1].summary = out.summary;
    trace[trace.length - 1].data = out.data;
    if (out.rule_id) proposed.push(out.rule_id);

    messages.push({ role: "assistant", content: JSON.stringify({ thought: act.thought, tool: act.tool, input: act.input }) });
    messages.push({ role: "user", content: `TOOL RESULT (${act.tool}):\n${String(out.summary).slice(0, 12000)}\n\nCarry on: run something else, or answer. Every number in your answer must come from a result you have seen.` });
  }

  return { reply: findings(), trace, proposed_rules: proposed, out_of_turns: true };
}
