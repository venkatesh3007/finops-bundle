import { verifySession, readCookie } from "../../../../lib/session";
import { signCode, clientAllowsRedirect } from "../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";

// The consent step. Authorisation is granted by the SESSION the user already
// holds in this browser — the connector never sees a password or a key, and this
// endpoint cannot mint a code for anyone but the signed-in user.
export async function POST(req) {
  const userId = verifySession(readCookie(req, "fo_sess"));
  if (!userId) return Response.json({ error: "sign in first" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state } = b;
  if (!client_id || !redirect_uri) return Response.json({ error: "missing client_id or redirect_uri" }, { status: 400 });
  if (code_challenge_method !== "S256") return Response.json({ error: "PKCE S256 is required" }, { status: 400 });
  if (!code_challenge) return Response.json({ error: "missing code_challenge" }, { status: 400 });
  if (!clientAllowsRedirect(client_id, redirect_uri))
    return Response.json({ error: "that redirect_uri is not registered for this client" }, { status: 400 });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", signCode(userId, code_challenge, redirect_uri, client_id));
  if (state) url.searchParams.set("state", state);
  return Response.json({ redirect: url.toString() });
}
