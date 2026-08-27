import { rp, generateAuthenticationOptions, putChallenge } from "../../../../../../lib/webauthn";

export async function POST(req) {
  try {
    const { rpID } = rp(req);
    // Empty allowCredentials → the browser offers the user's discoverable passkeys.
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    await putChallenge("login", options.challenge);
    return Response.json(options);
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
