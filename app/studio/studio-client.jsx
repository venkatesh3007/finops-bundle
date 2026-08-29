"use client";
// The working session. Chat on the left with every step of the work visible as
// it happens — including the parser code being written — and your statements on
// the right, expandable to the full review view. A running job can be stopped.
import { useCallback, useEffect, useRef, useState } from "react";
import s from "./studio.module.css";
import { csvToGrid, parseGrid, pdfItemsToLines, inferBankAccount } from "../../lib/statements/parse";
import { inr } from "../../lib/statements/query";

const POLL_MS = 1200;

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readFile(file) {
  const name = file.name, ext = name.split(".").pop().toLowerCase();
  const buf = await file.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  const base = { filename: name, bytes: buf.byteLength, sha256 };
  if (ext === "csv" || ext === "txt") {
    const text = new TextDecoder("utf-8").decode(buf);
    return { ...base, source: "csv", rows: parseGrid(csvToGrid(text)).rows, text: text.slice(0, 1_500_000) };
  }
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
    const text = grid.map((r) => (r || []).map((c) => (c == null ? "" : String(c))).join("\t")).join("\n");
    return { ...base, source: "xlsx", rows: parseGrid(grid).rows, text: text.slice(0, 1_500_000) };
  }
  if (ext === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) pages.push(pdfItemsToLines((await (await doc.getPage(p)).getTextContent()).items).join("\n"));
    return { ...base, source: "pdf", pages };
  }
  throw new Error(`unsupported file .${ext} — PDF, CSV or XLSX`);
}

const STEP_ICON = {
  read: "📄", note: "·", thinking: "✎", code: "⌨", ran: "▶", cache: "★", reuse: "★",
  classify: "◍", done: "✓", summary: "✓", error: "⚠", stopped: "■", heading: "—", reparse: "↻",
};

function Step({ st }) {
  const [open, setOpen] = useState(false);
  if (st.kind === "heading") return <div className={s.stepHeading}>{st.text}</div>;
  const isCode = st.kind === "code" && st.data?.source;
  return (
    <div className={`${s.step} ${st.kind === "error" ? s.stepErr : ""} ${st.kind === "done" || st.kind === "summary" ? s.stepDone : ""}`}>
      <span className={s.stepIcon}>{STEP_ICON[st.kind] || "·"}</span>
      <div className={s.stepBody}>
        <div>{st.text}</div>
        {st.data?.rows != null && st.kind === "ran" && (
          <div className={s.stepMeta}>{st.data.rows} rows · {st.data.breaks} breaks · {st.data.reconciled ? "reconciles" : st.data.note || "unverified"}</div>
        )}
        {isCode && (
          <>
            <button className={s.link} onClick={() => setOpen((o) => !o)}>{open ? "hide" : "show"} the parser it wrote ({st.data.source.split("\n").length} lines)</button>
            {open && <pre className={s.code}>{st.data.source}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

export default function StudioClient() {
  const [entity, setEntity] = useState("");
  const [drafts, setDrafts] = useState([]);
  const [log, setLog] = useState([]);            // chat + step blocks
  const [job, setJob] = useState(null);          // {id, status, total_steps}
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [openDraft, setOpenDraft] = useState(null);
  const [wide, setWide] = useState(false);
  const inputRef = useRef(null);
  const seen = useRef(0);
  const bottom = useRef(null);

  const refresh = useCallback(async () => {
    const j = await (await fetch("/api/statements/drafts")).json();
    if (!j.error) { setDrafts(j.drafts); setEntity(j.entity); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [log]);

  const say = (role, text, extra = {}) => setLog((l) => [...l, { role, text, ...extra }]);

  // ── poll a running job and stream its steps into the log ──
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let live = true;
    const tick = async () => {
      try {
        const j = await (await fetch(`/api/jobs/${job.id}?since=${seen.current}`)).json();
        if (!live || j.error) return;
        if (j.steps?.length) {
          seen.current = j.total_steps;
          setLog((l) => [...l, ...j.steps.map((st) => ({ role: "step", st }))]);
        }
        if (j.status !== "running") {
          setJob({ ...job, status: j.status });
          setBusy("");
          await refresh();
        }
      } catch { /* transient */ }
    };
    const id = setInterval(tick, POLL_MS);
    tick();
    return () => { live = false; clearInterval(id); };
  }, [job, refresh]);

  const startJob = async (body, label) => {
    setBusy("running");
    say("you", label);
    const j = await (await fetch("/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (j.error) { say("agent", `⚠ ${j.error}`); setBusy(""); return; }
    seen.current = 0;
    setJob({ id: j.job_id, status: "running" });
  };

  const stop = async () => {
    if (!job) return;
    await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    say("agent", "Stopping at the next step…");
  };

  // ── uploads ──
  const addFiles = useCallback(async (files) => {
    const arr = Array.from(files || []).filter((f) => /\.(pdf|csv|xlsx|xls|txt)$/i.test(f.name));
    if (!arr.length) return;
    say("you", `Uploaded ${arr.length} file${arr.length === 1 ? "" : "s"}: ${arr.map((f) => f.name).join(", ")}`);
    const ids = [];
    for (const f of arr) {
      const key = Math.random().toString(36).slice(2);
      setUploads((u) => [...u, { key, name: f.name, stage: "reading" }]);
      try {
        const read = await readFile(f);
        const acct = inferBankAccount(f.name);
        const j = await (await fetch("/api/statements/drafts", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...read, account: acct.account, kind: acct.slug, skip_parse: true }),
        })).json();
        setUploads((u) => u.filter((x) => x.key !== key));
        if (j.error) say("agent", `⚠ ${f.name}: ${j.error}`);
        else { ids.push(j.id); await refresh(); }
      } catch (e) {
        setUploads((u) => u.filter((x) => x.key !== key));
        say("agent", `⚠ ${f.name}: ${e.message}`);
      }
    }
    if (ids.length) await startJob({ draft_ids: ids }, `Parse the ${ids.length} statement${ids.length === 1 ? "" : "s"} I just uploaded`);
  }, [refresh]);

  useEffect(() => {
    const over = (e) => { e.preventDefault(); setDragging(true); };
    const leave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); };
    window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [addFiles]);

  // ── the box: ask, or act ──
  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    const t = q.toLowerCase();
    if (/^(re-?parse|parse|re-?read|redo)\b/.test(t)) {
      const onlyBroken = /broken|breaks|failing|bad|don'?t add|wrong/.test(t);
      return startJob(onlyBroken ? { only_broken: true } : { all: true }, q);
    }
    say("you", q);
    setBusy("asking");
    try {
      const j = await (await fetch("/api/statements/ask-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q }) })).json();
      say("agent", j.error ? `⚠ ${j.error}` : j.text, { query: j.query, data: j.result });
    } catch (e) { say("agent", `⚠ ${e.message}`); }
    setBusy("");
  };

  const running = job?.status === "running";
  const broken = drafts.filter((d) => d.breaks > 0 || !d.reconciled).length;

  return (
    <div className={`${s.app} ${dragging ? s.dragging : ""} ${wide ? s.wide : ""}`}>
      <header className={s.bar}>
        <div className={s.brand}>finops <span className={s.dim}>studio</span></div>
        <div className={s.barRight}>
          <a className={s.link} href="/extractor">Parser history</a>
          <a className={s.link} href="/game">← Board</a>
        </div>
      </header>

      <div className={s.split}>
        {/* ── left: the conversation and the work ── */}
        <section className={s.chat}>
          <div className={s.log}>
            {log.length === 0 && (
              <div className={s.intro}>
                <h1>Drop a statement, or ask about the ones you have.</h1>
                <p>
                  When a statement comes in I don't retype its numbers — I read the layout and <b>write a small parser for it</b>,
                  run that code, and check every row against the statement's own printed running balance. If rows don't chain,
                  I fix the parser and run it again. You'll see each step here, including the code.
                </p>
                <div className={s.suggest}>
                  {["How are my statements doing?", "Which ones don't add up?", "Reparse the broken ones", "Any duplicate transactions?"]
                    .map((c) => <button key={c} onClick={() => { setText(c); setTimeout(() => document.getElementById("studio-input")?.focus(), 0); }}>{c}</button>)}
                </div>
              </div>
            )}
            {log.map((m, i) => m.role === "step" ? <Step key={i} st={m.st} />
              : (
                <div key={i} className={m.role === "you" ? s.you : s.agent}>
                  <div className={s.bubble}>{m.text}</div>
                  {m.query && <details className={s.trace}><summary>how I worked that out</summary><code>{JSON.stringify(m.query)}</code><pre>{JSON.stringify(m.data, null, 1).slice(0, 3000)}</pre></details>}
                </div>
              ))}
            {running && <div className={s.working}><span className={s.spin} /> working…</div>}
            <div ref={bottom} />
          </div>

          <div className={s.composer}>
            <textarea id="studio-input" rows={2} value={text} placeholder="Ask about your statements, or say “reparse the broken ones”…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <div className={s.composerBtns}>
              {running
                ? <button className={s.stop} onClick={stop}>■ Stop</button>
                : <button className={s.send} onClick={send} disabled={!text.trim() || !!busy}>{busy === "asking" ? "…" : "Send"}</button>}
              <button className={s.ghost} onClick={() => inputRef.current?.click()} disabled={running}>＋ Statement</button>
            </div>
          </div>
        </section>

        {/* ── right: the statements ── */}
        <aside className={s.side}>
          <div className={s.sideHead}>
            <b>Statements</b>
            <span className={s.dim}>{drafts.length} · {broken} need attention</span>
            <button className={s.link} onClick={() => setWide((w) => !w)} title="Expand this panel">{wide ? "›› narrow" : "‹‹ expand"}</button>
          </div>
          {!running && broken > 0 && (
            <button className={s.reparse} onClick={() => startJob({ only_broken: true }, `Reparse the ${broken} statements that don't add up`)}>
              ↻ Reparse the {broken} that don't add up
            </button>
          )}
          <div className={s.sideList}>
            {uploads.map((u) => <div key={u.key} className={s.cardBusy}><span className={s.spin} /> {u.name} — reading…</div>)}
            {drafts.map((d) => (
              <div key={d.id} className={`${s.card} ${openDraft === d.id ? s.cardOpen : ""}`} onClick={() => setOpenDraft(openDraft === d.id ? null : d.id)}>
                <div className={s.cardName}>{d.filename}</div>
                <div className={s.cardMeta}>
                  {(d.account || "").replace(/^(Assets:Bank:|Liabilities:Card:)/, "")} · {d.rows_count} rows
                  {d.breaks ? <span className={s.warn}> · {d.breaks} breaks</span> : d.reconciled ? <span className={s.good}> · reconciles ✓</span> : <span className={s.dim}> · unverified</span>}
                </div>
                {openDraft === d.id && <DraftRows id={d.id} />}
              </div>
            ))}
            {!drafts.length && !uploads.length && <div className={s.dim} style={{ padding: 12 }}>No statements yet — drop one anywhere.</div>}
          </div>
        </aside>
      </div>

      <input ref={inputRef} type="file" multiple accept=".pdf,.csv,.xlsx,.xls,.txt" style={{ display: "none" }}
        onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      {dragging && <div className={s.dropOverlay}>Drop to add</div>}
    </div>
  );
}

function DraftRows({ id }) {
  const [d, setD] = useState(null);
  useEffect(() => { fetch(`/api/statements/drafts/${id}`).then((r) => r.json()).then(setD); }, [id]);
  if (!d) return <div className={s.dim}>loading…</div>;
  const rows = (d.rows || []).slice(0, 200);
  return (
    <div className={s.rows} onClick={(e) => e.stopPropagation()}>
      <div className={s.dim}>
        {d.from} → {d.to} · in {inr(d.inflow)} · out {inr(d.outflow)}
        {d.meta?.parser === "codegen" && <> · parsed by generated code{d.meta.parser_reused ? " (reused)" : ` (${d.meta.parser_rounds} round${d.meta.parser_rounds === 1 ? "" : "s"})`}</>}
      </div>
      <table className={s.table}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} className={r.brk ? s.brk : ""}>
              <td className={s.dim}>{r.i}</td>
              <td className={s.nowrap}>{r.date}</td>
              <td title={r.desc}>{String(r.payee || r.desc).slice(0, 34)}</td>
              <td className={`${s.r} ${r.amount < 0 ? s.warn : s.good}`}>{inr(r.amount)}</td>
              <td className={`${s.r} ${s.dim}`}>{r.balance != null ? inr(r.balance) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(d.rows || []).length > 200 && <div className={s.dim}>…{(d.rows || []).length - 200} more</div>}
    </div>
  );
}
