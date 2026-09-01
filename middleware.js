import { NextResponse } from "next/server";

// Gate: allow the owner passcode (fo_auth) OR a signed-in session (fo_sess).
// Edge can't verify the HMAC (no node crypto), so this is a coarse presence
// check — resolveEntity() re-verifies the signature server-side, so a forged
// fo_sess passes here but reaches no data (401 from the API).
const OPEN = (p) =>
  p === "/api/health" ||
  p.startsWith("/api/admin") ||
  p.startsWith("/api/auth") ||   // login / register / me / logout
  p === "/login" ||
  p === "/api/passcode" ||
  // The MCP connector and its OAuth. These MUST bypass this gate:
  //   .well-known — discovery is unauthenticated by definition; a redirect to
  //     /login here makes the connector undiscoverable.
  //   /api/mcp    — it answers its own 401 carrying the WWW-Authenticate
  //     challenge that tells a client where to authorise. The generic 401 below
  //     has no challenge, so clients would never find the OAuth flow.
  //   /api/oauth  — register and token are public per the spec; approve verifies
  //     the session itself before minting anything.
  //   /oauth/authorize — the consent screen handles its own signed-out state.
  //     The redirect below drops the query string, which would strip the PKCE
  //     challenge and redirect_uri and break the flow silently.
  p.startsWith("/.well-known/") ||
  p === "/api/mcp" ||
  p.startsWith("/api/oauth/") ||
  p === "/oauth/authorize";

export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (OPEN(pathname)) return NextResponse.next();

  const code = process.env.APP_PASSCODE;
  const owner = code && req.cookies.get("fo_auth")?.value === code;
  const session = !!req.cookies.get("fo_sess")?.value;
  if (!code || owner || session) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone(); url.pathname = "/login"; url.search = "";
  return NextResponse.redirect(url);
}
// Exclude self-hosted static workers/vendor (pdf.js worker, transformers/ONNX, the
// llm worker) from the auth gate so the browser can fetch them as modules directly.
export const config = { matcher: ["/((?!_next|favicon.ico|pdf.worker|llm.worker|vendor).*)"] };
