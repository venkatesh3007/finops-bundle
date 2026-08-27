// Transactional email. Works with either Resend or SendGrid — whichever key the
// operator set in the app env (per the "credentials via env, never in chat" rule).
// Returns true if actually sent, false if no provider is configured.
export function mailerConfigured() {
  return !!(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY);
}

export async function sendEmail({ to, subject, html, text }) {
  const from = process.env.MAILER_FROM || "finops@aikaara.com";

  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
    return true;
  }

  if (process.env.SENDGRID_API_KEY) {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: "finance·ops" },
        subject,
        content: [
          { type: "text/plain", value: text || subject },
          { type: "text/html", value: html },
        ],
      }),
    });
    if (r.status !== 202) throw new Error(`sendgrid ${r.status}: ${await r.text()}`);
    return true;
  }

  return false; // no provider configured
}
