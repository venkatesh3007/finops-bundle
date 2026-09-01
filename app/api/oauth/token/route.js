import { verifyCode, verifyRefresh, signAccess, signRefresh, pkceOk, hash } from "../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";

const bad = (error, desc) => Response.json({ error, error_description: desc }, { status: 400 });

// Token endpoint. Public client + PKCE (no client secret anywhere), so the only
// thing that redeems a code is the browser that started the flow.
export async function POST(req) {
  const ct = req.headers.get("content-type") || "";
  const body = ct.includes("json")
    ? await req.json().catch(() => ({}))
    : Object.fromEntries(new URLSearchParams(await req.text()));

  if (body.grant_type === "refresh_token") {
    const p = verifyRefresh(body.refresh_token);
    if (!p) return bad("invalid_grant", "the refresh token is not valid");
    return Response.json({
      access_token: signAccess(p.u), token_type: "Bearer", expires_in: 8 * 3600,
      refresh_token: signRefresh(p.u), scope: "finops",
    });
  }

  if (body.grant_type !== "authorization_code") return bad("unsupported_grant_type", String(body.grant_type || ""));
  const p = verifyCode(body.code);
  if (!p) return bad("invalid_grant", "the authorization code is expired or invalid");
  if (p.r !== body.redirect_uri) return bad("invalid_grant", "redirect_uri does not match the one the code was issued for");
  if (body.client_id && p.k !== hash(String(body.client_id))) return bad("invalid_grant", "this code was issued to a different client");
  if (!pkceOk(body.code_verifier, p.c)) return bad("invalid_grant", "PKCE verification failed");

  return Response.json({
    access_token: signAccess(p.u), token_type: "Bearer", expires_in: 8 * 3600,
    refresh_token: signRefresh(p.u), scope: "finops",
  });
}
