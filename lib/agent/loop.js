// The agent loop: think → use a tool → look at the result → answer.
//
// Tool selection is expressed as JSON rather than the provider's native
// tool-calling, because the gateway routes to whichever model the workspace has
// configured and native tool support is not guaranteed. The shape is validated
// on the way back, so a malformed reply degrades to a plain answer instead of an
// error.
import { chatText, gatewayConfigured } from "../statements/gateway.js";
import { SYSTEM_PROMPT, contextBlock } from "./prompt.js";
import { TOOLS, TOOL_NAMES, runTool } from "./tools.js";
import { loadCorpus } from "../statements/corpus-query.js";
import { listJobs } from "../jobs/store.js";

const MAX_TURNS = 4;

function protocol() {
  return `## Using a tool

Reply with ONE JSON object and nothing else.

To use a tool:
{"thought": "one short line on why", "tool": "<name>", "input": { … }}

To answer the user:
{"reply": "your answer"}

Tools available:
${TOOLS.map((t) => `### ${t.name}\n${t.what}\ninput: ${t.input}`).join("\n\n")}

Call a tool before answering anything factual. After a tool result you may call
another tool or answer. Never put a number in "reply" that a tool did not give you.`;
}

function parseAction(raw) {
  let t = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  // An empty model reply is a failure, not an answer. Returning "…" as the
  // assistant's response is how two investigations reported nothing after doing
  // all the work correctly.
  if (!t) return { empty: true };
  if (a < 0 || b < a) return { reply: t };
  let o;
  try { o = JSON.parse(t.slice(a, b + 1)); } catch { return { reply: t.slice(0, 1500) }; }
  if (typeof o.reply === "string" && o.reply.trim()) return { reply: o.reply.trim() };
  if (typeof o.tool === "string" && TOOL_NAMES.includes(o.tool)) {
    return { thought: typeof o.thought === "string" ? o.thought.slice(0, 200) : "", tool: o.tool, input: o.input && typeof o.input === "object" ? o.input : {} };
  }
  // a JSON object that is neither — treat any prose in it as the answer
  const text = [o.reply, o.answer, o.text, o.message].find((x) => typeof x === "string" && x.trim());
  return { reply: text ? text.trim() : t.slice(0, 1500) };
}

// history: [{role:'user'|'assistant', content}] — the visible conversation.
export async function converse(entity, history) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const [corpus, jobs] = await Promise.all([
    loadCorpus(entity).catch(() => ({ statements: [] })),
    listJobs(entity, { limit: 3 }).catch(() => []),
  ]);

  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${protocol()}\n\n## What is on screen right now\n${contextBlock({ statements: corpus.statements, jobs })}` },
    ...history.slice(-10).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content).slice(0, 4000) })),
  ];

  const trace = [];
  let job_id = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const act = parseAction(await chatText(messages, { max_tokens: 1200 }));
    if (act.empty) {
      const last = trace[trace.length - 1];
      return { reply: last?.summary || "I didn't get a reply from the model — try asking again.", trace, job_id };
    }
    if (act.reply) return { reply: act.reply, trace, job_id };

    trace.push({ tool: act.tool, thought: act.thought, input: act.input });
    let out;
    try {
      out = await runTool(entity, act.tool, act.input);
    } catch (e) {
      out = { summary: `The ${act.tool} tool failed: ${String(e.message || e).slice(0, 300)}`, data: null };
    }
    trace[trace.length - 1].summary = out.summary;
    trace[trace.length - 1].data = out.data;
    if (out.job_id) job_id = out.job_id;

    messages.push({ role: "assistant", content: JSON.stringify({ thought: act.thought, tool: act.tool, input: act.input }) });
    messages.push({ role: "user", content: `TOOL RESULT (${act.tool}):\n${out.summary}\n\nNow either call another tool or answer the user. Every number in your answer must come from this result.` });
  }

  // Out of turns: answer from what the tools already returned rather than looping.
  const last = trace[trace.length - 1];
  return { reply: last?.summary || "I couldn't work that out — try asking a different way.", trace, job_id };
}
