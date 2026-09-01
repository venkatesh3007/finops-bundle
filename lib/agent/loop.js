// The agent loop: use a tool → look at the result → answer.
//
// Tool selection was expressed as JSON in prose, because the gateway did not
// support native tool calling. It does now, so the negotiation is gone: a turn
// either carries tool_calls or it is the answer. Nothing to parse, nothing to
// guess, and no way for an empty completion to be mistaken for a reply.
import { chatMessage, gatewayConfigured } from "../statements/gateway.js";
import { SYSTEM_PROMPT, contextBlock } from "./prompt.js";
import { TOOLS, runTool } from "./tools.js";
import { loadCorpus } from "../statements/corpus-query.js";
import { listJobs } from "../jobs/store.js";

const MAX_TURNS = 4;

// The provider validates arguments against these, so a malformed call is caught
// before it reaches runTool rather than after.
const SCHEMAS = {
  query_statements: { op: { type: "string" }, statement: { type: "string" }, text: { type: "string" }, account: { type: "string" }, bank: { type: "string" }, from: { type: "string" }, to: { type: "string" }, direction: { type: "string" }, by: { type: "string" }, sort: { type: "string" }, order: { type: "string" }, limit: { type: "integer" } },
  parse_statements: { statement: { type: "string" }, all: { type: "boolean" }, only_broken: { type: "boolean" }, regenerate: { type: "boolean" } },
  job_status: { job_id: { type: "string" } },
};

const toolDefs = () => TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.what, parameters: { type: "object", properties: SCHEMAS[t.name] || {} } },
}));




// history: [{role:'user'|'assistant', content}] — the visible conversation.
export async function converse(entity, history) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const [corpus, jobs] = await Promise.all([
    loadCorpus(entity).catch(() => ({ statements: [] })),
    listJobs(entity, { limit: 3 }).catch(() => []),
  ]);

  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n## What is on screen right now\n${contextBlock({ statements: corpus.statements, jobs })}` },
    ...history.slice(-10).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content).slice(0, 4000) })),
  ];

  const trace = [];
  let job_id = null;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await chatMessage(messages, { tools: toolDefs(), max_tokens: 1200 });

    if (!reply.tool_calls?.length) {
      const text = String(reply.content || "").trim();
      if (text) return { reply: text, trace, job_id };
      const last = trace[trace.length - 1];
      return { reply: last?.summary || "I didn't get a reply from the model — try asking again.", trace, job_id };
    }

    messages.push({
      role: "assistant",
      content: reply.content || null,
      tool_calls: reply.tool_calls,
      ...(reply.reasoning_blocks?.length ? { reasoning_blocks: reply.reasoning_blocks } : {}),
    });

    for (const call of reply.tool_calls) {
      const name = call.function?.name;
      let input = {};
      try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = {}; }
      let out;
      try { out = await runTool(entity, name, input); }
      catch (e) { out = { summary: `The ${name} tool failed: ${String(e.message || e).slice(0, 300)}`, data: null }; }
      trace.push({ tool: name, thought: reply.content || "", input, summary: out.summary, data: out.data });
      if (out.job_id) job_id = out.job_id;
      messages.push({ role: "tool", tool_call_id: call.id, content: String(out.summary || "").slice(0, 8000) });
    }
  }

  // Out of turns: answer from what the tools already returned rather than looping.
  const last = trace[trace.length - 1];
  return { reply: last?.summary || "I couldn't work that out — try asking a different way.", trace, job_id };
}
