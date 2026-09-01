// Reading one action out of a model's reply.
//
// This looked trivial and was not. The first version scanned from the first "{"
// to the LAST "}", which works only when the reply contains exactly one object.
// A model with thinking switched off plans out loud instead of internally, and
// answers like:
//
//     I'll investigate step by step.
//     {"thought":"…","tool":"query_statements","input":{…}}
//     {"thought":"…","tool":"run_analysis","input":{…}}
//     {"thought":"…","tool":"read_rows","input":{…}}
//
// first-to-last spans all three, JSON.parse fails, and the entire plan is
// presented to the user as the answer — nought tool calls, after which the loop
// stops. Two real runs did exactly that.
//
// So: scan for the FIRST BALANCED object, ignore any prose around it, and ignore
// anything after it. The extra calls are not lost — the loop asks again once it
// has the first result, which is the point of a loop.

// Walk to the matching close brace, respecting strings and escapes.
export function firstJsonObject(text) {
  const t = String(text || "");
  for (let start = t.indexOf("{"); start !== -1; start = t.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const slice = t.slice(start, i + 1);
        try { return { value: JSON.parse(slice), text: slice }; } catch { break; } // try the next "{"
      }
    }
  }
  return null;
}

// A reply is either an action to take or an answer to give.
// `names` is the set of tools that actually exist, so a hallucinated tool name
// falls through to being treated as prose rather than a failed call.
export function parseAction(raw, names) {
  const t = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  if (!t) return { empty: true };                       // never an answer
  const found = firstJsonObject(t);
  if (!found) return { reply: t };
  const o = found.value;
  if (typeof o.tool === "string" && names.includes(o.tool)) {
    return {
      thought: typeof o.thought === "string" ? o.thought.slice(0, 240) : "",
      tool: o.tool,
      input: o.input && typeof o.input === "object" ? o.input : {},
    };
  }
  if (typeof o.reply === "string" && o.reply.trim()) return { reply: o.reply.trim() };
  const text = [o.reply, o.answer, o.text, o.message].find((x) => typeof x === "string" && x.trim());
  return { reply: text ? text.trim() : t };
}
