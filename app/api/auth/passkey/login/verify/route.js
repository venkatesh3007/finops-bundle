import { rp, verifyAuthenticationResponse, takeChallenge, isoBase64URL } from "../../../../../../lib/webauthn";
import { query } from "../../../../../../lib/db";
import { sessionCookie } from "../../../../../../lib/session";

export async function POST(req) {
  try {
    const { response, challenge } = await req.json();
    const ch = await takeChallenge("login", challenge);
    if (!ch) return Response.json({ error: "challenge expired — try again" }, { status: 400 });

    const credId = response?.id;
    const rows = await query("select user_id, public_key, counter, transports from passkeys where id=$1", [credId]);
    if (!rows.length) return Response.json({ error: "unknown passkey — create an account first" }, { status: 400 });
    const pk = rows[0];

    const { rpID, origin } = rp(req);
    const ver = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: {
        id: credId,
        publicKey: isoBase64URL.toBuffer(pk.public_key),
        counter: Number(pk.counter),
        transports: (pk.transports || "").split(",").filter(Boolean),
      },
    });
    if (!ver.verified) return Response.json({ error: "could not verify passkey" }, { status: 400 });

    await query("update passkeys set counter=$2 where id=$1", [credId, ver.authenticationInfo.newCounter]);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(pk.user_id) },
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
