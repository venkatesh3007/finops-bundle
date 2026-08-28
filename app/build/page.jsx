"use client";
import { useState, useEffect, useRef } from "react";

// finops modifying itself. Chat on the left drives aikaara's LiveBuild engine
// (via /api/livebuild, server-proxied) against THIS app's own code; the E2B live
// preview renders on the right. "Apply" ships it as a PR.
//
// Boot and edit are DECOUPLED: on load we boot the sandbox with an EMPTY
// instruction (boot-only, no planner) so the preview comes up on its own; then
// every message you type is a refine/edit against that live session. (Sending a
// non-edit phrase like "load the preview" as the first instruction used to hit
// the planner and fail — booting separately avoids that entirely.)
export default function BuildPage() {
  const [session, setSession] = useState(null);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  const bootedRef = useRef(false);

  const api = async (action, extra) =>
    (await fetch("/api/livebuild", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) })).json();

  const poll = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const j = await api("status", { session_id: id });
      if (j.ok) {
        setSession(j.session);
        if (["ready", "failed", "shipped"].includes(j.session.status)) clearInterval(pollRef.current);
      }
    }, 5000);
  };

  // Auto-boot once on mount: propose with no instruction = boot the live sandbox
  // and show its preview, without running any edit.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      setBusy(true);
      setLog([{ role: "agent", text: "Booting a live sandbox of finops from its own code… the preview appears on the right when it's ready. First boot installs dependencies and can take a few minutes." }]);
      const j = await api("propose", { instruction: "" });
      if (j.ok) {
        setSession(j.session);
        poll(j.session.id);
      } else {
        setLog((l) => [...l, { role: "agent", text: "⚠ " + (j.message || j.error || "boot failed") }]);
      }
      setBusy(false);
    })();
    return () => clearInterval(pollRef.current);
  }, []);

  const send = async () => {
    const text = msg.trim();
    if (!text || busy || !session) return;
    setBusy(true);
    setLog((l) => [...l, { role: "you", text }]);
    setMsg("");
    const j = await api("refine", { session_id: session.id, message: text });
    if (j.ok) {
      setSession(j.session);
      poll(j.session.id);
      setLog((l) => [...l, { role: "agent", text: "Applying your change to the live preview…" }]);
    } else {
      setLog((l) => [...l, { role: "agent", text: "⚠ " + (j.message || j.error || "failed") }]);
    }
    setBusy(false);
  };

  const apply = async () => {
    if (!session || busy) return;
    setBusy(true);
    const j = await api("apply", { session_id: session.id, title: "self-modify from finops /build" });
    setLog((l) => [...l, { role: "agent", text: j.ok ? `Shipped ✓ — PR: ${j.session?.pull_request || "opened"}` : "⚠ " + (j.error || "apply failed") }]);
    setBusy(false);
  };

  const st = session?.status;
  const previewReady = !!session?.preview_url && st === "ready";
  const booting = !session || (!previewReady && st !== "failed");
  const canEdit = st === "ready" && !busy;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: 0, height: "100vh", background: "#0b0b0d", color: "#e7e7ea", fontFamily: "system-ui, sans-serif" }}>
      {/* chat */}
      <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #222", minWidth: 0 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #222" }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Modify this app</div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>Tell finops what to change. It rewrites its own code and shows you a live preview — apply it when you like it.</div>
          {session && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>session {session.id} · {st}{session.branch ? ` · ${session.branch}` : ""}</div>}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {log.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "you" ? "flex-end" : "flex-start", maxWidth: "90%", background: m.role === "you" ? "#2a78d6" : "#17171b", color: m.role === "you" ? "#fff" : "#e7e7ea", padding: "8px 11px", borderRadius: 10, fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {m.text}
            </div>
          ))}
          {st === "ready" && log.filter((m) => m.role === "you").length === 0 && (
            <div style={{ opacity: 0.5, fontSize: 13, lineHeight: 1.5 }}>
              Preview's up. Now describe a change, e.g.<br /><br />
              “On the import preview, add a column showing the foreign-currency amount next to the INR amount.”<br /><br />
              or “Make the balance-break rows collapsible.”
            </div>
          )}
        </div>
        <div style={{ padding: 12, borderTop: "1px solid #222", display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
            placeholder={booting ? "Booting the live preview…" : "Describe a change…  (⌘/Ctrl+Enter)"}
            rows={2}
            disabled={!canEdit}
            style={{ flex: 1, resize: "none", background: "#111", color: "inherit", border: "1px solid #333", borderRadius: 8, padding: 8, fontSize: 13, fontFamily: "inherit", opacity: canEdit ? 1 : 0.6 }}
          />
          <button onClick={send} disabled={!canEdit || !msg.trim()} style={{ padding: "9px 14px", borderRadius: 8, border: "none", background: !canEdit || !msg.trim() ? "#333" : "#2a78d6", color: "#fff", cursor: !canEdit || !msg.trim() ? "default" : "pointer", fontSize: 13 }}>
            {busy ? "…" : "Refine"}
          </button>
        </div>
        {session && (
          <div style={{ padding: "10px 12px", borderTop: "1px solid #222", display: "flex", gap: 8 }}>
            <button onClick={apply} disabled={busy || st !== "ready" || log.filter((m) => m.role === "you").length === 0} title={st !== "ready" ? "Wait for the preview to be ready" : "Ship your change as a PR"} style={{ flex: 1, padding: "9px 12px", borderRadius: 8, border: "1px solid #2e7d32", background: st === "ready" ? "#2e7d32" : "transparent", color: st === "ready" ? "#fff" : "#888", cursor: st === "ready" ? "pointer" : "default", fontSize: 13 }}>
              Apply — ship this change
            </button>
          </div>
        )}
      </div>
      {/* live preview */}
      <div style={{ position: "relative", background: "#0f0f12" }}>
        {previewReady ? (
          <iframe key={session.preview_url} src={session.preview_url} title="live preview" style={{ width: "100%", height: "100%", border: "none", background: "#fff" }} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, opacity: 0.6, fontSize: 13 }}>
            <div>{st === "failed" ? "Boot failed — check the logs and retry." : "Booting a live sandbox of finops…"}</div>
            {booting && st !== "failed" && <div style={{ fontSize: 11, opacity: 0.7 }}>{st || "starting"} — first boot installs dependencies, a few minutes</div>}
          </div>
        )}
        {previewReady && st === "editing" && (
          <div style={{ position: "absolute", top: 10, right: 12, background: "#2a78d6", color: "#fff", fontSize: 11, padding: "3px 9px", borderRadius: 999 }}>applying edit…</div>
        )}
      </div>
    </div>
  );
}
