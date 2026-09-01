"use client";
// Consent screen for the MCP connector. It asks the browser who it is (the
// dashboard session), shows exactly which book is being connected, and mints the
// code only when the person clicks. No key is ever shown, typed or pasted.
import { useCallback, useEffect, useState } from "react";

export const dynamic = "force-dynamic";

export default function Authorize() {
  const [caller, setCaller] = useState(undefined); // undefined = still asking
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setP({
      client_id: q.get("client_id") || "",
      redirect_uri: q.get("redirect_uri") || "",
      state: q.get("state") || "",
      code_challenge: q.get("code_challenge") || "",
      code_challenge_method: q.get("code_challenge_method") || "",
      resource: q.get("resource") || "",
    });
    fetch("/api/auth/me").then((r) => r.json()).then((j) => setCaller(j.caller || null)).catch(() => setCaller(null));
  }, []);

  const approve = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/oauth/approve", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p),
      });
      const j = await r.json();
      if (j.redirect) window.location.href = j.redirect;
      else setErr(j.error || "could not authorise");
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  }, [p]);

  const wrap = { minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b0d10", color: "#e7ecf3",
    font: "15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: 24 };
  const card = { width: "min(460px, 100%)", background: "#12161c", border: "1px solid #232a34",
    borderRadius: 14, padding: 28 };
  const btn = { width: "100%", padding: "12px 16px", borderRadius: 10, border: 0, cursor: "pointer",
    background: "#1f9d55", color: "#fff", fontWeight: 600, fontSize: 15 };

  if (p === null || caller === undefined) return <div style={wrap}><div style={card}>Checking your session…</div></div>;

  if (!caller) {
    const back = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
    return (
      <div style={wrap}><div style={card}>
        <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Sign in to connect</h1>
        <p style={{ color: "#9aa7b6", margin: "0 0 20px" }}>
          Connecting an app to your books needs you signed in here first.
        </p>
        <a href={`/login?next=${encodeURIComponent(back)}`} style={{ ...btn, display: "block", textAlign: "center", textDecoration: "none" }}>
          Sign in
        </a>
      </div></div>
    );
  }

  const missing = !p.client_id || !p.redirect_uri || p.code_challenge_method !== "S256" || !p.code_challenge;

  return (
    <div style={wrap}><div style={card}>
      <h1 style={{ margin: "0 0 6px", fontSize: 20 }}>Connect to your books</h1>
      <p style={{ color: "#9aa7b6", margin: "0 0 18px" }}>
        An app is asking to read and categorise the statements in{" "}
        <b style={{ color: "#e7ecf3" }}>{caller.entity || "your book"}</b>.
      </p>
      <div style={{ background: "#0e1217", border: "1px solid #232a34", borderRadius: 10, padding: 14, marginBottom: 18, fontSize: 13.5 }}>
        <div style={{ color: "#9aa7b6" }}>Signed in as</div>
        <div style={{ marginBottom: 10 }}>{caller.email || (caller.owner ? "passcode owner" : "—")}</div>
        <div style={{ color: "#9aa7b6" }}>Sending you back to</div>
        <div style={{ wordBreak: "break-all" }}>{p.redirect_uri || "—"}</div>
      </div>
      {missing ? (
        <p style={{ color: "#e6a23c", margin: 0 }}>
          This link is missing something it needs (a client, a redirect and a PKCE S256 challenge).
          Start the connection again from the app.
        </p>
      ) : (
        <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} onClick={approve} disabled={busy}>
          {busy ? "Connecting…" : "Allow access"}
        </button>
      )}
      {err && <p style={{ color: "#e05b5b", marginTop: 14 }}>{err}</p>}
      <p style={{ color: "#6b7686", fontSize: 12.5, marginTop: 18, marginBottom: 0 }}>
        You can revoke this at any time by changing ADMIN_TOKEN — every issued token stops working.
      </p>
    </div></div>
  );
}
