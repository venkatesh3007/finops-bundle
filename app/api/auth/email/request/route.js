import crypto from "crypto";
import { query } from "../../../../../lib/db";
import { putChallenge } from "../../../../../lib/webauthn";
import { rp } from "../../../../../lib/webauthn";
import { sendEmail, mailerConfigured } from "../../../../../lib/mailer";

const normEmail = (e) => (e || "").toString().trim().toLowerCase();
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

export async function POST(req) {
  try {
    const { email } = await req.json();
    const norm = normEmail(email);
    if (!okEmail(norm)) return Response.json({ error: "enter a valid email" }, { status: 400 });

    // Find or lazily create the account row (no passkey required for email sign-in).
    let u = await query("select id from users where lower(email::text)=$1", [norm]);
    let userId;
    if (u.length) userId = u[0].id;
    else { userId = crypto.randomUUID(); await query("insert into users (id, email) values ($1,$2)", [userId, norm]); }

    const token = crypto.randomBytes(32).toString("base64url");
    await putChallenge("maglink", token, { email: norm, userId });

    const { origin } = rp(req);
    const link = `${origin}/api/auth/email/verify?token=${token}`;

    if (mailerConfigured()) {
      await sendEmail({
        to: norm,
        subject: "Your finance·ops sign-in link",
        text: `Tap to sign in: ${link}\n\nThis link works once and expires in 10 minutes.`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px">
          <h2 style="font-size:18px">finance<span style="color:#0ca30c">·</span>ops</h2>
          <p>Tap the button to sign in. It works once and expires in 10 minutes.</p>
          <p><a href="${link}" style="display:inline-block;background:#2a78d6;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Sign in →</a></p>
          <p style="color:#888;font-size:12px">If you didn't request this, ignore this email.</p>
        </div>`,
      });
      return Response.json({ sent: true });
    }

    // Not configured: never leak the link in production. In dev, return it so the
    // flow is testable end-to-end without an email provider.
    if (process.env.NODE_ENV !== "production") return Response.json({ sent: false, devLink: link });
    return Response.json({ sent: false, reason: "email_not_configured" });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 400 });
  }
}
