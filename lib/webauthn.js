// WebAuthn (passkey) glue over @simplewebauthn/server v13. RP identity is
// derived from the request host so the same build works on localhost and on
// the live domain with no env wiring.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { query } from "./db.js";

export function rp(req) {
  const host = (req.headers.get("host") || "localhost:3000").toLowerCase();
  const bare = host.split(":")[0];
  const proto = bare === "localhost" || bare === "127.0.0.1" ? "http" : "https";
  return { rpID: bare, origin: `${proto}://${host}`, rpName: "finops" };
}

// store a one-time challenge; the client echoes it back on verify (concurrency-safe)
export async function putChallenge(kind, challenge, { email = null, userId = null } = {}) {
  await query(
    "insert into auth_challenges (kind, challenge, email, user_id) values ($1,$2,$3,$4)",
    [kind, challenge, email, userId],
  );
}
// consume (verify present + recent, then delete). returns the row or null.
export async function takeChallenge(kind, challenge) {
  const rows = await query(
    "delete from auth_challenges where kind=$1 and challenge=$2 and created_at > now() - interval '10 minutes' returning email, user_id",
    [kind, challenge],
  );
  return rows[0] || null;
}

export {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  isoBase64URL,
};
