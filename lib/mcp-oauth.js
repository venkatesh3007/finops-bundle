// Stateless OAuth 2.1 authorization server for the MCP connector.
//
// Everything — client ids, auth codes, access and refresh tokens — is an
// HMAC-signed capsule, so there is no table to migrate and nothing to clean up.
// Same construction as lib/session.js (base64url payload + HMAC-SHA256 over
// ADMIN_TOKEN), for the same reason: no new secret to provision.
//
// Deliberately not a general-purpose AS. It exists so claude.ai can connect
// without anyone pasting a key into a chat window — the consent step reuses the
// dashboard session the user already has, so the credential never leaves the
// browser.
import crypto from "crypto";

const SECRET = process.env.ADMIN_TOKEN || "dev-secret-change-me";
export const issuer = () =>
  (process.env.PUBLIC_BASE_URL || "https://d6-finops.apps.aikaara.com").replace(/\/+$/, "");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const mac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");

function sign(payload, aud, ttlSeconds) {
  const body = b64({ ...payload, aud, exp: Date.now() + ttlSeconds * 1000 });
  return `${body}.${mac(`${aud}:${body}`)}`;
}

function verify(token, aud) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = mac(`${aud}:${body}`);
  // constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.aud !== aud || !p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

export const hash = (s) => crypto.createHash("sha256").update(s).digest("base64url");

// --- dynamic client registration: the client_id IS the signed metadata -------
export const signClient = (redirect_uris, name) => sign({ redirect_uris, name }, "client", 400 * 86400);
export const verifyClient = (t) => verify(t, "client");

// claude.ai may present an https URL as its client_id (client id metadata
// documents) rather than registering. Accept that only for Anthropic hosts.
export function anthropicRedirect(clientId, redirectUri) {
  try {
    if (!String(clientId).startsWith("https://")) return false;
    const h = new URL(redirectUri).hostname;
    return ["claude.ai", "claude.com", "anthropic.com"].some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}

export function clientAllowsRedirect(clientId, redirectUri) {
  if (String(clientId).startsWith("https://")) return anthropicRedirect(clientId, redirectUri);
  const c = verifyClient(clientId);
  return !!c && (c.redirect_uris || []).includes(redirectUri);
}

// --- codes and tokens --------------------------------------------------------
// The code binds the user, the PKCE challenge and the redirect it was issued for,
// so a stolen code cannot be redeemed from anywhere else.
export const signCode = (userId, challenge, redirect_uri, clientId) =>
  sign({ u: userId, c: challenge, r: redirect_uri, k: hash(String(clientId)) }, "code", 300);
export const verifyCode = (t) => verify(t, "code");

export const signAccess = (userId) => sign({ u: userId }, "access", 8 * 3600);
export const verifyAccess = (t) => verify(t, "access");
export const signRefresh = (userId) => sign({ u: userId }, "refresh", 60 * 86400);
export const verifyRefresh = (t) => verify(t, "refresh");

export const pkceOk = (verifier, challenge) => !!verifier && hash(verifier) === challenge;
