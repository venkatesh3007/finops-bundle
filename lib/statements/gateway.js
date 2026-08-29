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
export async function chatText(messages, { max_tokens = 1024, temperature = 0 } = {}) {
  if (!gatewayConfigured()) throw new Error("extract_not_configured");
  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { "X-Api-Key": KEY, "content-type": "application/json" }, // no Authorization → managed mode
    body: JSON.stringify({ model: MODEL || "default", max_tokens, temperature, messages }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// Lenient JSON pull-out for model replies (fences, prose around the object).
export function jsonFrom(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`model returned non-JSON: ${t.slice(0, 160)}`);
  return JSON.parse(t.slice(a, b + 1));
}
