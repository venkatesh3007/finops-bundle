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
  p === "/api/passcode";

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
export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
