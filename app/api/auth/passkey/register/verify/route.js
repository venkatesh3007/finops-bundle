import { rp, verifyRegistrationResponse, takeChallenge, isoBase64URL } from "../../../../../../lib/webauthn";
import { query } from "../../../../../../lib/db";
import { ensureUserEntity } from "../../../../../../lib/tenant";
import { sessionCookie } from "../../../../../../lib/session";

export async function POST(req) {
  try {
    const { response, challenge } = await req.json();
    const ch = await takeChallenge("register", challenge);
    if (!ch) return Response.json({ error: "challenge expired — try again" }, { status: 400 });

    const { rpID, origin } = rp(req);
    const ver = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
    });
    if (!ver.verified || !ver.registrationInfo) return Response.json({ error: "could not verify passkey" }, { status: 400 });

    const cred = ver.registrationInfo.credential; // { id, publicKey, counter, transports }
    const userId = ch.user_id;
    await query("insert into users (id, email) values ($1,$2) on conflict (id) do nothing", [userId, ch.email]);
    await query(
      "insert into passkeys (id, user_id, public_key, counter, transports) values ($1,$2,$3,$4,$5) on conflict (id) do nothing",
      [cred.id, userId, isoBase64URL.fromBuffer(cred.publicKey), cred.counter || 0, (cred.transports || []).join(",")],
    );
    await ensureUserEntity(userId);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(userId) },
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
