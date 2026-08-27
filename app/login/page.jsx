"use client";
import { useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

export default function Login() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showOp, setShowOp] = useState(false);
  const [code, setCode] = useState("");

  const reset = () => { setErr(""); setMsg(""); };
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function signInPasskey() {
    reset(); setBusy("login");
    try {
      const r = await post("/api/auth/passkey/login/options");
      const options = await r.json();
      if (!r.ok) throw new Error(options.error || "could not start");
      let asr;
      try { asr = await startAuthentication({ optionsJSON: options }); }
      catch { setBusy(""); return; } // user cancelled the OS prompt
      const vr = await post("/api/auth/passkey/login/verify", { response: asr, challenge: options.challenge });
      const v = await vr.json();
      if (vr.ok) location.href = "/game";
      else setErr(v.error || "sign-in failed");
    } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  }

  async function createPasskey() {
    reset();
    if (!validEmail) { setErr("Enter your email first — it's how you get back in on a new device."); return; }
    setBusy("create");
    try {
      const r = await post("/api/auth/passkey/register/options", { email: email.trim() });
      const options = await r.json();
      if (!r.ok) {
        if (options.error === "account_exists") setErr("You already have an account — use “Sign in with a passkey”.");
        else setErr(options.error || "could not start");
        setBusy(""); return;
      }
      let att;
      try { att = await startRegistration({ optionsJSON: options }); }
      catch { setBusy(""); return; }
      const vr = await post("/api/auth/passkey/register/verify", { response: att, challenge: options.challenge });
      const v = await vr.json();
      if (vr.ok) location.href = "/game";
      else setErr(v.error || "could not finish");
    } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  }

  async function emailLink() {
    reset();
    if (!validEmail) { setErr("Enter a valid email."); return; }
    setBusy("email");
    try {
      const r = await post("/api/auth/email/request", { email: email.trim() });
      const j = await r.json();
      if (j.sent) setMsg("Check your email — we sent you a sign-in link.");
      else if (j.devLink) setMsg("Dev link (email not configured): " + j.devLink);
      else setErr("Email sign-in isn't switched on yet — create an account with a passkey instead.");
    } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  }

  async function submitCode(e) {
    e.preventDefault(); reset();
    const r = await post("/api/passcode", { code });
    if (r.ok) location.href = "/game"; else setErr("Wrong passcode");
  }

  const B = { padding: "11px 16px", borderRadius: 10, border: 0, fontWeight: 600, fontSize: 15, cursor: "pointer", width: "100%" };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0f1115", color: "#e7e9ee", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>finance<span style={{ color: "#0ca30c" }}>·</span>ops</div>
        <div style={{ color: "#9aa0ad", marginTop: 6, marginBottom: 24, fontSize: 14, lineHeight: 1.5 }}>
          Your money as a warehouse you actually run. Sign in and your deliveries start stacking.
        </div>

        <button onClick={signInPasskey} disabled={!!busy}
          style={{ ...B, background: "#2a78d6", color: "#fff", opacity: busy === "login" ? 0.6 : 1 }}>
          {busy === "login" ? "…" : "🔑  Sign in with a passkey"}
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#6b7280", margin: "18px 0", fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: "#242833" }} /> NEW HERE <div style={{ flex: 1, height: 1, background: "#242833" }} />
        </div>

        <input type="email" inputMode="email" autoComplete="email" value={email} placeholder="you@email.com"
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", padding: 12, fontSize: 15, borderRadius: 10, border: "1px solid #2c313d", background: "#161923", color: "#e7e9ee", boxSizing: "border-box" }} />

        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <button onClick={createPasskey} disabled={!!busy}
            style={{ ...B, background: "#173a1f", color: "#8fe89a", border: "1px solid #1f5a2c", opacity: busy === "create" ? 0.6 : 1 }}>
            {busy === "create" ? "…" : "Create account with a passkey"}
          </button>
          <button onClick={emailLink} disabled={!!busy}
            style={{ ...B, background: "transparent", color: "#9aa0ad", border: "1px solid #2c313d", fontWeight: 500, opacity: busy === "email" ? 0.6 : 1 }}>
            {busy === "email" ? "…" : "Email me a sign-in link"}
          </button>
        </div>

        {err && <div style={{ color: "#ff8686", marginTop: 14, fontSize: 13, lineHeight: 1.5 }}>{err}</div>}
        {msg && <div style={{ color: "#8fe89a", marginTop: 14, fontSize: 13, lineHeight: 1.5, wordBreak: "break-all" }}>{msg}</div>}

        <div style={{ marginTop: 28, textAlign: "center" }}>
          <button onClick={() => setShowOp((v) => !v)} style={{ background: "none", border: 0, color: "#5b6270", fontSize: 12, cursor: "pointer" }}>
            Operator passcode
          </button>
        </div>
        {showOp && (
          <form onSubmit={submitCode} style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Passcode"
              style={{ flex: 1, padding: 10, fontSize: 14, borderRadius: 8, border: "1px solid #2c313d", background: "#161923", color: "#e7e9ee" }} />
            <button style={{ padding: "8px 14px", borderRadius: 8, border: 0, background: "#3a4150", color: "#fff", fontWeight: 600 }}>Enter</button>
          </form>
        )}
      </div>
    </div>
  );
}
