import crypto from "crypto";
import { rp, generateRegistrationOptions, putChallenge } from "../../../../../../lib/webauthn";
import { query } from "../../../../../../lib/db";

const normEmail = (e) => (e || "").toString().trim().toLowerCase();
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

export async function POST(req) {
  try {
    const { email } = await req.json();
    const norm = normEmail(email);
    if (!okEmail(norm)) return Response.json({ error: "enter a valid email" }, { status: 400 });

    // Reuse an existing account row for this email (e.g. created via magic-link),
    // but block if it already has a passkey — that person should just sign in.
    const ex = await query("select id from users where lower(email::text)=$1", [norm]);
    let userId;
    if (ex.length) {
      userId = ex[0].id;
      const pk = await query("select 1 from passkeys where user_id=$1 limit 1", [userId]);
      if (pk.length) return Response.json({ error: "account_exists" }, { status: 409 });
    } else {
      userId = crypto.randomUUID();
    }

    const { rpID, rpName } = rp(req);
    const options = await generateRegistrationOptions({
      rpName, rpID,
      userName: norm,
      userID: new Uint8Array(Buffer.from(userId)),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await putChallenge("register", options.challenge, { email: norm, userId });
    return Response.json(options);
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
