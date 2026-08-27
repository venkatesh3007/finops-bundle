// Stateless signed session cookie. HMAC-signed with ADMIN_TOKEN (already in env —
// no new secret to provision). Cookie name: fo_sess. Value: base64url(payload).sig.
import crypto from "crypto";

const SECRET = process.env.ADMIN_TOKEN || "dev-secret-change-me";
const MAX_AGE = 60 * 60 * 24 * 60; // 60 days

export function signSession(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(cookieValue) {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const { u, t } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() - t > MAX_AGE * 1000) return null;
    return u;
  } catch { return null; }
}

export function sessionCookie(userId) {
  return `fo_sess=${signSession(userId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
export const clearSessionCookie = "fo_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

// read a cookie value from a request's Cookie header
export function readCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
