"use client";
// The Extractor Lab — where the statement extractor rewrites its own code.
//
// You report what a statement got wrong; that statement is kept as a test case.
// "Improve the extractor" asks the model to rewrite the extractor module, runs
// the candidate against every kept statement, and ships it only if nothing
// regresses. Versions are listed with their scores and can be rolled back.
import { useCallback, useEffect, useState } from "react";
import s from "./extractor.module.css";

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");

function ScoreChip({ score }) {
  if (!score) return <span className={s.chip}>not tested</span>;
  if (score.error) return <span className={`${s.chip} ${s.bad}`}>error</span>;
  const cls = score.reconciled ? s.good : score.breaks ? s.warn : s.chip;
  return (
    <span className={`${s.chip} ${cls}`} title={`${score.rows} rows · ${score.breaks} balance breaks · ${score.checked} rows balance-checked`}>
      {score.rows} rows{score.breaks ? ` · ${score.breaks} breaks` : ""}{score.reconciled ? " ✓" : ""}
    </span>
  );
}

export default function ExtractorClient() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [complaint, setComplaint] = useState("");
  const [target, setTarget] = useState("");
  const [report, setReport] = useState(null);
  const [source, setSource] = useState(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const j = await (await fetch("/api/extractor")).json();
    if (j.error) setToast(`⚠ ${j.error}`); else { setState(j); if (!target && j.fixtures?.length) setTarget(j.fixtures[0].id); }
  }, [target]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 4000); };

  const improve = async () => {
    if (!complaint.trim()) { flash("Describe what the extractor got wrong first."); return; }
    setBusy("improving"); setReport(null);
    try {
      const j = await (await fetch("/api/extractor/improve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ complaint, fixture_id: target || null }),
      })).json();
      setReport(j);
      if (j.error) flash(`⚠ ${j.error}`);
      else if (j.promoted) { flash(`Shipped version ${j.version} — it beat v${j.champion_version} with no regressions.`); setComplaint(""); }
      else flash(j.message || "No candidate beat the current version.");
      await load();
    } catch (e) { flash(`⚠ ${e.message}`); }
    setBusy("");
  };

  const retest = async () => {
    setBusy("testing");
    const j = await (await fetch("/api/extractor/test", { method: "POST" })).json();
    setBusy("");
    if (j.error) flash(`⚠ ${j.error}`); else { flash(`Re-tested version ${j.version} on ${j.scores.length} statement(s).`); await load(); }
  };

  const activate = async (version) => {
    setBusy("activating");
    const j = await (await fetch("/api/extractor/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) })).json();
    setBusy("");
    if (j.error) flash(`⚠ ${j.error}`); else { flash(`Extractor pinned to version ${version}.`); await load(); }
  };

  const showSource = async (version) => {
    const j = await (await fetch(`/api/extractor?version=${version}`)).json();
    setSource(j.source || null);
  };

  const setFixtureActive = async (id, active) => {
    await fetch("/api/extractor/fixtures", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, active }) });
    load();
  };
  const removeFixture = async (id) => { await fetch(`/api/extractor/fixtures?id=${id}`, { method: "DELETE" }); load(); };

  if (!state) return <div className={s.app}><header className={s.bar}><div className={s.brand}>Extractor lab</div></header><main className={s.main}><div className={s.muted}>Loading…</div></main></div>;

  const active = state.fixtures.filter((f) => f.active);

  return (
    <div className={s.app}>
      <header className={s.bar}>
        <div className={s.brand}>Extractor lab <span className={s.ver}>v{state.active_version}</span></div>
        <div className={s.barRight}>
          <button className={s.link} onClick={retest} disabled={!!busy}>{busy === "testing" ? "Re-testing…" : "Re-test current version"}</button>
          <a className={s.link} href="/import">← Statements</a>
        </div>
      </header>

      {!state.configured && <div className={s.banner}>AI extraction isn't switched on for this workspace, so the lab can't run the extractor or rewrite it.</div>}

      <main className={s.main}>
        <p className={s.lede}>
          The statement extractor is a small program — a prompt plus three pure functions that clean the text, split it, and repair the rows.
          Tell it what a statement got wrong and it <b>rewrites that program</b>. Every candidate is run against all the statements you've reported,
          and each result is checked against that statement's own printed running balance. A rewrite ships only if <b>nothing gets worse and the
          statement you reported gets better</b> — so the extractor can improve itself without you having to trust it.
        </p>

        <section className={s.panel}>
          <h2 className={s.h}>Improve the extractor</h2>
          {!active.length ? (
            <div className={s.empty}>
              Nothing to learn from yet. Open a statement on <a href="/import">Statements</a>, hit <b>Report a parsing problem</b>, and it lands here as a test case.
            </div>
          ) : (
            <>
              <label className={s.lbl}>Which statement is wrong?</label>
              <select className={s.select} value={target} onChange={(e) => setTarget(e.target.value)}>
                {active.map((f) => <option key={f.id} value={f.id}>{f.name}{f.baseline ? ` — ${f.baseline.rows} rows, ${f.baseline.breaks} breaks` : ""}</option>)}
              </select>
              <label className={s.lbl}>What did it get wrong?</label>
              <textarea className={s.ta} rows={3} value={complaint} onChange={(e) => setComplaint(e.target.value)}
                placeholder={`e.g. "it skips every row on the last page after the rewards summary" · "foreign-currency rows use the USD figure instead of the INR one" · "rows at the page break get duplicated" · "credits are coming through as negative"`} />
              <div className={s.row}>
                <button className={s.btnPrimary} onClick={improve} disabled={!!busy || !state.configured}>
                  {busy === "improving" ? "Rewriting and testing…" : "Rewrite the extractor and test it"}
                </button>
                <span className={s.muted}>Runs the extractor over {active.length} statement{active.length === 1 ? "" : "s"} per attempt — this takes a minute or two.</span>
              </div>
            </>
          )}
          {report && <Report report={report} />}
        </section>

        <section className={s.panel}>
          <h2 className={s.h}>Statements it's graded on <span className={s.muted}>({active.length} active)</span></h2>
          {!state.fixtures.length ? <div className={s.muted}>None yet.</div> : (
            <table className={s.table}>
              <thead><tr><th>Statement</th><th>What you said</th><th>Current result</th><th /></tr></thead>
              <tbody>
                {state.fixtures.map((f) => (
                  <tr key={f.id} className={f.active ? "" : s.off}>
                    <td><b>{f.name}</b><div className={s.muted}>{f.source_kind?.toUpperCase()} · {Math.round((f.text_bytes || 0) / 1024)} KB</div></td>
                    <td className={s.complaint}>{f.complaint || <span className={s.muted}>—</span>}</td>
                    <td><ScoreChip score={f.baseline} /></td>
                    <td className={s.actions}>
                      <button className={s.btnSm} onClick={() => setFixtureActive(f.id, !f.active)}>{f.active ? "Mute" : "Use"}</button>
                      <button className={s.btnSm} onClick={() => removeFixture(f.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={s.panel}>
          <h2 className={s.h}>Versions</h2>
          <table className={s.table}>
            <thead><tr><th>Version</th><th>Why it was written</th><th>Score when it shipped</th><th /></tr></thead>
            <tbody>
              {state.versions.map((v) => (
                <tr key={v.version}>
                  <td><b>v{v.version}</b>{v.active && <span className={`${s.chip} ${s.good}`} style={{ marginLeft: 6 }}>active</span>}{v.parent_version ? <div className={s.muted}>from v{v.parent_version}</div> : null}</td>
                  <td className={s.complaint}>{v.notes || <span className={s.muted}>—</span>}</td>
                  <td className={s.muted}>{v.score?.verdict || "—"}</td>
                  <td className={s.actions}>
                    <button className={s.btnSm} onClick={() => showSource(v.version)}>Code</button>
                    {!v.active && <button className={s.btnSm} onClick={() => activate(v.version)} disabled={!!busy}>Use this</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>

      {source && (
        <div className={s.modalWrap} onClick={() => setSource(null)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalHead}><b>Extractor v{source.version}</b><button className={s.x} onClick={() => setSource(null)}>×</button></div>
            <pre className={s.code}>{source.source}</pre>
          </div>
        </div>
      )}
      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  );
}

function Report({ report }) {
  if (report.error) return <div className={s.err}>⚠ {report.error}</div>;
  return (
    <div className={report.promoted ? s.ok : s.warnBox}>
      <b>{report.promoted ? `Version ${report.version} shipped.` : "Nothing shipped."}</b>{" "}
      {report.message || report.verdict?.reason}
      <ol className={s.attempts}>
        {(report.attempts || []).map((a) => (
          <li key={a.attempt}>
            <b>Attempt {a.attempt}:</b> {a.reason}
            {(a.improvements || []).map((i, n) => <div key={`i${n}`} className={s.good}>+ {i.why} ({i.before?.rows ?? "?"}→{i.after?.rows ?? "?"} rows, {i.before?.breaks ?? "?"}→{i.after?.breaks ?? "?"} breaks)</div>)}
            {(a.regressions || []).map((r, n) => <div key={`r${n}`} className={s.bad}>− {r.why}</div>)}
          </li>
        ))}
      </ol>
    </div>
  );
}
