import { signClient } from "../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";

// RFC 7591 dynamic client registration. The client_id we hand back is itself the
// signed registration, so there is nothing to store and nothing to expire early.
export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === "string") : [];
  if (!uris.length) return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  const client_id = signClient(uris, String(b.client_name || "MCP client").slice(0, 80));
  return Response.json({
    client_id, redirect_uris: uris,
    client_name: b.client_name || "MCP client",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, { status: 201 });
}
