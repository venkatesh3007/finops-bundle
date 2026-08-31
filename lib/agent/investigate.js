// The investigation loop: think → run something → look at what came back → revise.
// Longer than the studio's loop because debugging is iterative by nature; every
// tool result is real data, so the model is arguing with the document rather than
// with itself.
import { chatText, gatewayConfigured } from "../statements/gateway.js";
import { INVESTIGATE_PROMPT, investigateContext } from "./investigate-prompt.js";
import { TOOLS, TOOL_NAMES, runTool } from "./investigate-tools.js";
import { loadCorpus } from "../statements/corpus-query.js";

const MAX_TURNS = Number(process.env.INVESTIGATE_TURNS || 10);
const EFFORT = process.env.INVESTIGATE_EFFORT || "high";

function protocol() {
  return `## Using a tool

Reply with ONE JSON object and nothing else.

To use a tool:
{"thought": "one short line on what you are testing and why", "tool": "<name>", "input": { … }}

To answer:
{"reply": "your answer"}

Tools:
${TOOLS.map((t) => `### ${t.name}\n${t.what}\ninput: ${t.input}`).join("\n\n")}

Test before you conclude. A tool result that surprises you is usually your own
code — fix it and run it again rather than reporting the surprise as a finding.`;
}

function parseAction(raw) {
  let t = String(raw || "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) return { reply: t || "…" };
  let o;
  try { o = JSON.parse(t.slice(a, b + 1)); } catch { return { reply: t.slice(0, 4000) }; }
  if (typeof o.reply === "string" && o.reply.trim()) return { reply: o.reply.trim() };
  if (typeof o.tool === "string" && TOOL_NAMES.includes(o.tool)) {
    return { thought: typeof o.thought === "string" ? o.thought.slice(0, 240) : "", tool: o.tool, input: o.input && typeof o.input === "object" ? o.input : {} };
  }
  const text = [o.reply, o.answer, o.text, o.message].find((x) => typeof x === "string" && x.trim());
  return { reply: text ? text.trim() : t.slice(0, 4000) };
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
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const act = parseAction(await chatText(messages, { max_tokens: 8000, effort: EFFORT }));
    if (act.reply) return { reply: act.reply, trace, proposed_rules: proposed };

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

  const last = trace[trace.length - 1];
  return {
    reply: `I ran out of steps before reaching a conclusion. What I found last:\n\n${last?.summary?.slice(0, 2000) || "nothing conclusive"}`,
    trace, proposed_rules: proposed,
  };
}
