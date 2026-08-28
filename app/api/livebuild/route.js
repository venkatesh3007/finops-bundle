import { resolveEntity } from "../../../lib/tenant";

// Server-side proxy to aikaara's LiveBuild engine — the app rewriting itself.
// The chat widget on /build calls this; we forward to /api/v1/livebuild/* with a
// server-held aikaara tenant key so no key touches the browser. The target is
// always THIS app (finops, LIVEBUILD_TARGET) — the widget can only modify itself.
const BASE = (process.env.AIKAARA_API_BASE || "https://api.aikaara.com").replace(/\/+$/, "") + "/api/v1/livebuild";
const KEY = process.env.AIKAARA_API_KEY || "";
const TARGET = process.env.LIVEBUILD_TARGET || "finops";

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

export async function POST(req) {
  // Gate on a signed-in operator; the widget is a build console, not public.
  const entity = await resolveEntity(req);
  if (!entity) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!KEY) return Response.json({ error: "livebuild_not_configured", message: "Set AIKAARA_API_KEY (an aikaara tenant key) in the finops env to enable self-modify." }, { status: 503 });

  const b = await req.json().catch(() => ({}));
  const action = b.action;
  let res;
  if (action === "propose") res = await call("POST", "/propose", { target: TARGET, instruction: String(b.instruction || ""), actor: "finops-self" });
  else if (action === "status") res = await call("GET", `/${encodeURIComponent(b.session_id)}`);
  else if (action === "refine") res = await call("POST", `/${encodeURIComponent(b.session_id)}/refine`, { message: String(b.message || "") });
  else if (action === "apply") res = await call("POST", `/${encodeURIComponent(b.session_id)}/apply`, { title: b.title || null });
  else if (action === "discard") res = await call("POST", `/${encodeURIComponent(b.session_id)}/discard`);
  else return Response.json({ error: "unknown action" }, { status: 400 });

  return Response.json(res.json, { status: res.status });
}
