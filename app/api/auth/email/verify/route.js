import { takeChallenge } from "../../../../../lib/webauthn";
import { ensureUserEntity } from "../../../../../lib/tenant";
import { sessionCookie } from "../../../../../lib/session";

// GET /api/auth/email/verify?token=… — one-time magic-link. Sets the session
// cookie and bounces to the game (or onboarding for a fresh, empty account).
export async function GET(req) {
  const token = new URL(req.url).searchParams.get("token") || "";
  const ch = await takeChallenge("maglink", token);
  if (!ch || !ch.user_id) {
    const url = new URL("/login?err=link_expired", req.url);
    return Response.redirect(url, 302);
  }
  await ensureUserEntity(ch.user_id);
  const url = new URL("/game", req.url);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": sessionCookie(ch.user_id) } });
}
