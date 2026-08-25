"use client";
import { useState } from "react";
export default function Login() {
  const [code, setCode] = useState(""); const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/passcode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    if (r.ok) location.href = "/game"; else setErr("Wrong passcode");
  };
  return (
    <div style={{ maxWidth: 320, margin: "120px auto", fontFamily: "system-ui", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>finance<span style={{ color: "#0ca30c" }}>·</span>ops</h1>
      <form onSubmit={submit}>
        <input type="password" value={code} autoFocus onChange={(e) => setCode(e.target.value)} placeholder="Passcode"
          style={{ width: "100%", padding: 10, fontSize: 15, borderRadius: 8, border: "1px solid #ccc" }} />
        <button style={{ marginTop: 10, padding: "9px 16px", borderRadius: 8, border: 0, background: "#2a78d6", color: "#fff", fontWeight: 600 }}>Enter</button>
      </form>
      {err && <div style={{ color: "#d03b3b", marginTop: 8 }}>{err}</div>}
    </div>
  );
}
