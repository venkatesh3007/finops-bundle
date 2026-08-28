"use client";
import { useEffect } from "react";

// Lightweight root. A live-preview readiness probe hits `/` and needs a FAST 2xx.
// Rendering the full board here put a heavy on-demand compile on the health-check
// path, which stalled the workspace boot (the probe kept hitting `/` mid-compile).
// So `/` is a tiny client page that returns 200 immediately and redirects to the
// app; users and the preview iframe land on /game right away.
export default function Home() {
  useEffect(() => {
    window.location.replace("/game" + (window.location.search || ""));
  }, []);
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", color: "#667", background: "#0b0b0d" }}>
      <div style={{ opacity: 0.7, fontSize: 14 }}>Loading finops…</div>
    </main>
  );
}
