"use client";
// Parser history — the record behind the one box on the Statements screen.
// Every version the parser has written for itself, why, what it scored when it
// shipped, its source, and a way back to any of them.
import { useCallback, useEffect, useState } from "react";
import s from "./extractor.module.css";

function Score({ score }) {
  if (!score) return <span className={s.chip}>—</span>;
  if (score.error) return <span className={`${s.chip} ${s.bad}`}>error</span>;
  const cls = score.reconciled ? s.good : score.breaks ? s.warn : s.chip;
  return <span className={`${s.chip} ${cls}`} title={`${score.rows} rows · ${score.breaks} balance breaks`}>{score.rows} rows{score.breaks ? ` · ${score.breaks} breaks` : ""}{score.reconciled ? " ✓" : ""}</span>;
}

export default function ExtractorClient() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [check, setCheck] = useState(null);
  const [source, setSource] = useState(null);
  const [rules, setRules] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const j = await (await fetch("/api/extractor")).json();
    if (j.error) setToast(`⚠ ${j.error}`); else setState(j);
  }, []);
  useEffect(() => {
    load();
    fetch("/api/statements/rules").then((r) => r.json()).then((j) => setRules(j.rules || "")).catch(() => {});
  }, [load]);

  const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 4000); };

  const recheck = async () => {
    setBusy("checking"); setCheck(null);
    const j = await (await fetch("/api/extractor/test", { method: "POST" })).json();
    setBusy("");
    if (j.error) flash(`⚠ ${j.error}`); else { setCheck(j); flash(`Checked v${j.version} against ${j.scores.length} statement(s).`); }
  };

  const activate = async (version) => {
    setBusy("activating");
    const j = await (await fetch("/api/extractor/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) })).json();
    setBusy("");
    if (j.error) flash(`⚠ ${j.error}`); else { flash(`Parser rolled back to v${version}. Re-parse from Statements to apply it.`); await load(); }
  };

  const showSource = async (version) => setSource((await (await fetch(`/api/extractor?version=${version}`)).json()).source || null);

  const saveRules = async () => {
    setBusy("rules");
    const j = await (await fetch("/api/statements/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules }) })).json();
    setBusy("");
    flash(j.error ? `⚠ ${j.error}` : "Saved — applied on every future parse.");
  };

  if (!state) return <div className={s.app}><header className={s.bar}><div className={s.brand}>Parser history</div></header><main className={s.main}><div className={s.muted}>Loading…</div></main></div>;

  return (
    <div className={s.app}>
      <header className={s.bar}>
        <div className={s.brand}>Parser history <span className={s.ver}>v{state.active_version} active</span></div>
        <div className={s.barRight}>
          <button className={s.link} onClick={recheck} disabled={!!busy}>{busy === "checking" ? "Checking…" : "Re-check current parser"}</button>
          <a className={s.link} href="/import">← Statements</a>
        </div>
      </header>

      <main className={s.main}>
        <p className={s.lede}>
          The statement parser writes its own code. When you tell it what went wrong — from the box on <a href="/import">Statements</a> — it reads back
          every statement you've parsed, rewrites itself, and keeps the rewrite only if <b>no statement loses rows, gains balance breaks, or stops
          reconciling</b>. Each version it shipped is below, with the source it was written as. Roll back any time.
        </p>

        {check && (
          <section className={s.panel}>
            <h2 className={s.h}>Where v{check.version} stands right now</h2>
            <table className={s.table}>
              <tbody>{check.scores.map((x) => <tr key={x.id}><td><b>{x.name}</b></td><td style={{ textAlign: "right" }}><Score score={x.score} /></td></tr>)}</tbody>
            </table>
            {!check.scores.length && <div className={s.muted}>No parsed statements to check against yet.</div>}
          </section>
        )}

        <section className={s.panel}>
          <h2 className={s.h}>Versions</h2>
          <table className={s.table}>
            <thead><tr><th>Version</th><th>Why it was written</th><th>Result when it shipped</th><th /></tr></thead>
            <tbody>
              {state.versions.map((v) => (
                <tr key={v.version}>
                  <td><b>v{v.version}</b>{v.active && <span className={`${s.chip} ${s.good}`} style={{ marginLeft: 6 }}>active</span>}{v.parent_version ? <div className={s.muted}>from v{v.parent_version}</div> : null}</td>
                  <td className={s.complaint}>{v.notes || <span className={s.muted}>—</span>}</td>
                  <td className={s.muted}>{v.score?.verdict || "—"}{v.score?.diagnosis && <div className={s.diag}>{v.score.diagnosis}</div>}</td>
                  <td className={s.actions}>
                    <button className={s.btnSm} onClick={() => showSource(v.version)}>Code</button>
                    {!v.active && <button className={s.btnSm} onClick={() => activate(v.version)} disabled={!!busy}>Roll back to this</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className={s.panel}>
          <button className={s.disclosure} onClick={() => setRulesOpen((o) => !o)}>{rulesOpen ? "▾" : "▸"} Standing instructions{rules.trim() ? " · in use" : ""}</button>
          {rulesOpen && (
            <div style={{ marginTop: 8 }}>
              <p className={s.muted}>Plain-text notes added to every parse, on top of whatever the parser's own code does. The box on Statements is usually the better tool — it changes the code instead — but anything saved here still applies.</p>
              <textarea className={s.ta} rows={5} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="One instruction per line…" />
              <div className={s.row}><button className={s.btnPrimary} onClick={saveRules} disabled={busy === "rules"}>Save</button></div>
            </div>
          )}
        </section>
      </main>

      {source && (
        <div className={s.modalWrap} onClick={() => setSource(null)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalHead}><b>Parser v{source.version}</b><button className={s.x} onClick={() => setSource(null)}>×</button></div>
            <pre className={s.code}>{source.source}</pre>
          </div>
        </div>
      )}
      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  );
}
