// One small door to the frontier model: the aikaara gateway in "managed" mode
// (OpenAI-compatible; auth = tenant/routing key; the tenant's dashboard decides
// which provider/model answers). No LLM key ever lives in finops.
//   AIKAARA_GATEWAY_URL   e.g. https://api.aikaara.com/gateway/v1
//   AIKAARA_GATEWAY_KEY   dashboard routing-client key (grk_…) or tenant X-Api-Key
//   EXTRACT_MODEL         optional model id; empty → the tenant's default
const GATEWAY_URL = (process.env.AIKAARA_GATEWAY_URL || "").replace(/\/+$/, "");
const KEY = process.env.AIKAARA_GATEWAY_KEY || process.env.AIKAARA_TENANT_KEY || "";
const MODEL = process.env.EXTRACT_MODEL || "";

export const gatewayConfigured = () => !!(GATEWAY_URL && KEY);
export const gatewayModelLabel = () => MODEL || "gateway-default";

// messages: [{role, content}] → assistant text. Throws on transport/HTTP errors.
//
// We ask the gateway to STREAM. Not for incremental output — we want the whole
// string either way — but because a buffered reply that takes longer than ~30s
// never arrives: Cloudflare -> DO App Platform sits in front of the gateway and
// kills a request that has produced no bytes by then, handing us an HTML 504.
// That is what capped us at roughly 2,600 output tokens and made every
// parser-codegen call fail the moment the model got slower than Haiku.
// Streaming makes the first byte land immediately, so the model gets the time it
// needs.
// `effort` turns on extended thinking at the given depth ("low"|"medium"|"high"|
// "max" on this model — "xhigh" is 4.7+ and is rejected). Reading a statement is
// exactly the kind of work it helps with: the FX row that failed a statement today
// needed the model to notice two amounts printed side by side and choose the INR
// one. NOTE: the provider rejects a sampling parameter when thinking is on
// ("`temperature` may only be set to 1 when thinking is enabled"), so temperature
// is omitted whenever effort is asked for.
export async function chatText(messages, { max_tokens = 1024, temperature = 0, effort = null } = {}) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const body = { model: MODEL || "default", max_tokens, stream: true, messages };
  if (effort) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort };
  } else {
    body.temperature = temperature;
  }
  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { "X-Api-Key": KEY, "content-type": "application/json" }, // no Authorization → managed mode
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);

  // A gateway that doesn't yet serve managed streams answers with one buffered
  // JSON completion. Deploys aren't atomic, so handle both shapes.
  if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || "";
  }
  return await readSseText(res);
}

// Accumulate assistant text from an OpenAI-style SSE stream. Keep-alive frames
// (lines starting with ":") carry no data and are skipped by the data: filter.
async function readSseText(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", out = "", failure = null, done = false;
  while (!done) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { done = true; break; }
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.error) { failure = evt.error.message || String(evt.error); continue; }
        const delta = evt?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") out += delta;
      }
    }
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  if (failure) throw new Error(`gateway: ${failure}`);
  return out;
}

// Lenient JSON pull-out for model replies (fences, prose around the object).
export function jsonFrom(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`model returned non-JSON: ${t.slice(0, 160)}`);
  return JSON.parse(t.slice(a, b + 1));
}
