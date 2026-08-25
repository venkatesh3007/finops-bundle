import { NextResponse } from "next/server";
// Single-passcode gate (APP_PASSCODE). /api/admin is token-gated separately; /api/health open.
export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (pathname === "/api/health" || pathname.startsWith("/api/admin")) return NextResponse.next();
  const code = process.env.APP_PASSCODE;
  if (!code) return NextResponse.next();
  if (pathname === "/login" || pathname === "/api/passcode") return NextResponse.next();
  if (req.cookies.get("fo_auth")?.value === code) return NextResponse.next();
  const url = req.nextUrl.clone(); url.pathname = "/login"; url.search = "";
  return NextResponse.redirect(url);
}
export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
