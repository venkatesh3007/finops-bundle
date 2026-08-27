import { clearSessionCookie } from "../../../../lib/session";
export async function POST() {
  const h = new Headers({ "Content-Type": "application/json" });
  h.append("Set-Cookie", clearSessionCookie);
  h.append("Set-Cookie", "fo_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
}
