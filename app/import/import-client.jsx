"use client";
// Statements — the main import screen.
//
//   drop files (any number) → each becomes a card and is processed IN PARALLEL:
//   the browser reads the file (pdf.js text / CSV / XLSX), the server extracts
//   with the frontier model through the gateway, proves every amount against
//   the printed running balance, classifies (your rules → history → frontier)
//   and stores the result as a DRAFT. Drafts survive reloads; open one to review,
//   ask questions, give the extractor a hint and re-run, then import.
//
// The on-device (private) path lives at /import/local.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./import.module.css";
import { csvToGrid, parseGrid, pdfItemsToLines, inferBankAccount } from "../../lib/statements/parse";
import { inr } from "../../lib/statements/query";

const PARALLEL = 3; // statements extracted concurrently (each is chunked server-side)

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Browser-side read: exact text out of the file. No numbers are interpreted here
// for PDFs — the frontier model + reconciler do that server-side.
async function readFile(file) {
  const name = file.name, ext = name.split(".").pop().toLowerCase();
  const buf = await file.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  const base = { filename: name, bytes: buf.byteLength, sha256 };
  // Tabular files parse deterministically when the layout is a normal grid; the
  // raw text rides along so the server can fall back to the frontier extractor
  // when it isn't (a bank that exports a decorated/pivoted "CSV").
  if (ext === "csv" || ext === "txt") {
    const text = new TextDecoder("utf-8").decode(buf);
    return { ...base, source: "csv", rows: parseGrid(csvToGrid(text)).rows, text: text.slice(0, 1_500_000) };
  }
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
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
  throw new Error(`unsupported file type .${ext} — use PDF, CSV or XLSX`);
}

const fmtBytes = (n) => (n == null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const short = (n) => (n == null ? "—" : (n < 0 ? "−" : "") + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 }));

export default function ImportClient() {
  const [drafts, setDrafts] = useState([]);           // server cards
  const [local, setLocal] = useState([]);             // files still being read/uploaded: {key, name, bytes, stage, error}
  const [extraction, setExtraction] = useState(true);
  const [entity, setEntity] = useState("");
  const [open, setOpen] = useState(null);             // draft id in the detail panel
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const inputRef = useRef(null);
  const queue = useRef([]); const running = useRef(0);

  const refresh = useCallback(async () => {
    const j = await (await fetch("/api/statements/drafts")).json();
    if (j.error) { setToast(`⚠ ${j.error}`); return; }
    setDrafts(j.drafts); setExtraction(j.extraction); setEntity(j.entity);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 3200); };

  // Follow a statement being read in the background: refresh the card as it goes,
  // and surface the job's latest step so a two-minute read shows its working
  // ("re-reading part 5", "applied a correction from the document itself")
  // instead of a silent spinner.
  const watchDraft = useCallback(async (id, jobId) => {
    for (let i = 0; i < 240; i++) {          // ~20 minutes at 5s
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const d = await (await fetch(`/api/statements/drafts/${id}`)).json();
        if (jobId) {
          const j = await (await fetch(`/api/jobs/${jobId}`)).json();
          const last = (j.steps || []).slice(-1)[0];
          if (last?.text) setDrafts((ds) => ds.map((x) => (x.id === id ? { ...x, live_step: last.text } : x)));
        }
        if (d?.status && d.status !== "processing") {
          setDrafts((ds) => [ { ...d, rows: undefined, live_step: undefined }, ...ds.filter((x) => x.id !== id) ]);
          if (d.status === "failed") flash(`⚠ ${d.filename}: ${d.meta?.error || "extraction failed"}`);
          return;
        }
      } catch { /* transient — keep watching */ }
    }
  }, []);
  const patchLocal = (key, p) => setLocal((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));

  // ── parallel pipeline: read in the browser, then POST (≤ PARALLEL at a time) ──
  const pump = useCallback(() => {
    while (running.current < PARALLEL && queue.current.length) {
      const job = queue.current.shift(); running.current++;
      (async () => {
        try {
          patchLocal(job.key, { stage: "extracting" });
          const j = await (await fetch("/api/statements/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job.body) })).json();
          if (j.error) throw new Error(j.error);
          setLocal((l) => l.filter((x) => x.key !== job.key));
          setDrafts((ds) => [ { ...j, rows: undefined }, ...ds.filter((d) => d.id !== j.id) ]);
          if (j.duplicate) flash(`${job.body.filename} was already uploaded — opened the existing one`);
          // Reading now happens in the background, so the card lands as
          // 'processing' and fills in as the job reports. Waiting on the request
          // is what used to time out on a long statement.
          if (j.status === "processing") await watchDraft(j.id, j.job_id);
          if (j.status === "failed") flash(`⚠ ${job.body.filename}: ${j.meta?.error || "extraction failed"}`);
        } catch (e) { patchLocal(job.key, { stage: "error", error: e.message }); }
        finally { running.current--; pump(); }
      })();
    }
  }, []);

  const addFiles = useCallback(async (files) => {
    const arr = Array.from(files || []).filter((f) => /\.(pdf|csv|xlsx|xls|txt)$/i.test(f.name));
    if (!arr.length) { flash("Drop PDF, CSV or XLSX statements."); return; }
    for (const f of arr) {
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`;
      setLocal((l) => [...l, { key, name: f.name, bytes: f.size, stage: "reading" }]);
      readFile(f).then((read) => {
        const inferred = inferBankAccount(f.name);
        queue.current.push({ key, body: { ...read, account: inferred.account, kind: inferred.slug } });
        patchLocal(key, { stage: "queued" });
        pump();
      }).catch((e) => patchLocal(key, { stage: "error", error: e.message }));
    }
  }, [pump]);

  // whole page is a drop target
  useEffect(() => {
    const over = (e) => { e.preventDefault(); setDragging(true); };
    const leave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); };
    window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [addFiles]);

  const importOne = async (id, force = false) => {
    const j = await (await fetch(`/api/statements/drafts/${id}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force }) })).json();
    await refresh();
    return j;
  };
  const importAllReady = async () => {
    const ready = drafts.filter((d) => d.status === "ready" && d.needs_review === 0 && d.breaks === 0);
    if (!ready.length) { flash("Nothing clean to import — open the cards that need review."); return; }
    let ok = 0, held = 0;
    for (const d of ready) { const j = await importOne(d.id); if (j.ok) ok++; else held++; }
    flash(`Imported ${ok} statement${ok === 1 ? "" : "s"}${held ? ` · ${held} held (closing balance didn't reconcile — open to see the diff)` : ""}`);
  };
  // Removing a statement is permanent: parsing happens in the browser, so the
  // draft holds the ONLY server-side copy of that statement's text. Always ask.
  const remove = async (id, name) => {
    if (!window.confirm(`Remove “${name}”?\n\nThis deletes the parsed statement and the text it was parsed from. Nothing is removed from your ledger, and you can re-add it by dropping the file again — but it can't be undone here.`)) return;
    await fetch(`/api/statements/drafts/${id}`, { method: "DELETE" });
    setOpen((o) => (o === id ? null : o));
    refresh();
  };

  const busy = local.length > 0;
  const cleanReady = drafts.filter((d) => d.status === "ready" && d.needs_review === 0 && d.breaks === 0).length;
  const empty = !drafts.length && !local.length;

  return (
    <div className={`${s.app} ${dragging ? s.dragging : ""}`}>
      <header className={s.bar}>
        <div className={s.brand}>Statements{entity && entity !== "personal" ? "" : entity ? " · Personal" : ""}</div>
        <div className={s.barRight}>
          <a className={s.link} href="/extractor" title="Every version of the parser, with the scores it shipped on">Parser history</a>
          <a className={s.link} href="/import/local" title="Optional: parse + classify entirely on-device (no cloud model)">Private mode</a>
          <a className={s.link} href="/game">← Board</a>
        </div>
      </header>

      {!extraction && (
        <div className={s.banner}>AI extraction isn't switched on for this workspace yet (gateway not configured). PDFs will fail until it is; CSV/XLSX still parse. <a href="/import/local">Private on-device mode</a> works regardless.</div>
      )}

      <main className={s.main}>
        {empty ? (
          <div className={s.hero} onClick={() => inputRef.current?.click()}>
            <div className={s.heroIcon}>⬇</div>
            <div className={s.heroTitle}>Drop your statements here</div>
            <div className={s.heroSub}>Bank or card · PDF, CSV or XLSX · as many as you like, they're processed in parallel.<br />Every amount is checked against the running balance before you import anything.</div>
            <button className={s.btnBig} onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>Choose files</button>
          </div>
        ) : (
          <>
            <div className={s.toolbar}>
              <button className={s.btn} onClick={() => inputRef.current?.click()}>+ Add statements</button>
              <span className={s.muted}>{drafts.length} stored{busy ? ` · ${local.length} in progress` : ""}</span>
              <div className={s.spacer} />
              <button className={s.btnPrimary} disabled={!cleanReady} onClick={importAllReady}>Import {cleanReady} clean {cleanReady === 1 ? "statement" : "statements"}</button>
            </div>
            <ParserFix count={drafts.length} onReparsed={refresh} />
            <div className={s.grid}>
              {local.map((l) => (
                <div key={l.key} className={`${s.card} ${s.cardBusy}`}>
                  <div className={s.cardName} title={l.name}>{l.name}</div>
                  <div className={s.cardMeta}>{fmtBytes(l.bytes)}</div>
                  <div className={s.cardStatus}>
                    {l.stage === "error" ? <span className={s.bad}>⚠ {l.error}</span> : <><span className={s.spin} /> {l.stage === "reading" ? "Reading file…" : l.stage === "queued" ? "Waiting for a slot…" : "Extracting & verifying…"}</>}
                  </div>
                </div>
              ))}
              {drafts.map((d) => <Card key={d.id} d={d} onOpen={() => setOpen(d.id)} onImport={() => importOne(d.id).then((j) => flash(j.ok ? `Imported ${d.filename}` : `⚠ ${d.filename}: ${j.hint || j.error || "closing balance doesn't reconcile — open for details"}`))} onRemove={() => remove(d.id, d.filename)} />)}
            </div>
            <div className={s.dropHint}>Drop more files anywhere on this page.</div>
          </>
        )}
      </main>

      <input ref={inputRef} type="file" multiple accept=".pdf,.csv,.xlsx,.xls,.txt" style={{ display: "none" }} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      {dragging && <div className={s.dropOverlay}>Drop to add</div>}
      {open && <Detail id={open} onClose={() => { setOpen(null); refresh(); }} onChanged={refresh} />}
      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  );
}

function StatusPill({ d }) {
  if (d.status === "processing" || d.status === "queued") return <span className={`${s.pill} ${s.pillBusy}`}><span className={s.spin} /> Extracting…</span>;
  if (d.status === "failed") return <span className={`${s.pill} ${s.pillBad}`}>⚠ Failed</span>;
  if (d.status === "imported") return <span className={`${s.pill} ${s.pillDone}`}>✓ Imported</span>;
  if (d.breaks) return <span className={`${s.pill} ${s.pillWarn}`}>⚠ {d.breaks} balance {d.breaks === 1 ? "break" : "breaks"}</span>;
  if (d.reconciled) return <span className={`${s.pill} ${s.pillGood}`}>✓ Balance-verified</span>;
  return <span className={`${s.pill}`}>{d.rec_note ? "Not verifiable" : "Parsed"}</span>;
}

function Card({ d, onOpen, onImport, onRemove }) {
  const acct = (d.account || "").replace(/^(Assets:Bank:|Liabilities:Card:)/, "");
  return (
    <div className={`${s.card} ${d.status === "imported" ? s.cardDone : ""}`} onClick={onOpen}>
      <div className={s.cardTop}>
        <div className={s.cardName} title={d.filename}>{d.filename}</div>
        <button className={s.x} title="Remove this statement (asks first)" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      </div>
      <div className={s.cardMeta}>{acct || "account?"} · {d.source?.toUpperCase()} · {d.from && d.to ? `${d.from} → ${d.to}` : fmtBytes(d.bytes)}</div>
      <div className={s.cardStatus}><StatusPill d={d} /></div>
      {d.status !== "failed" && d.rows_count > 0 && (
        <div className={s.cardStats}>
          <span><b>{d.rows_count}</b> rows</span>
          <span className={s.pos}>in {short(d.inflow)}</span>
          <span className={s.neg}>out {short(d.outflow)}</span>
          {d.needs_review > 0 && d.status !== "imported" && <span className={s.warn}>{d.needs_review} to review</span>}
        </div>
      )}
      {d.status === "failed" && <div className={s.bad} style={{ fontSize: 12 }}>{d.meta?.error}</div>}
      {/* A long read shows its working rather than a silent spinner. */}
      {(d.status === "processing" || d.status === "queued") && d.live_step && (
        <div className={s.muted} style={{ fontSize: 12 }}>{d.live_step}</div>
      )}
      <div className={s.cardActions}>
        <button className={s.btnSm} onClick={(e) => { e.stopPropagation(); onOpen(); }}>{d.status === "imported" ? "View" : d.status === "failed" ? "Retry with a hint" : "Review"}</button>
        {d.status === "ready" && <button className={`${s.btnSm} ${s.btnSmPrimary}`} onClick={(e) => { e.stopPropagation(); onImport(); }}>Import</button>}
      </div>
    </div>
  );
}

// ── Detail panel: rows, hint → re-extract, ask, import ─────────────────────
function Detail({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [working, setWorking] = useState("");
  const [result, setResult] = useState(null);
  const [chat, setChat] = useState([]);
  const [q, setQ] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [acctDraft, setAcctDraft] = useState("");

  const load = useCallback(async () => {
    const j = await (await fetch(`/api/statements/drafts/${id}`)).json();
    if (!j.error) { setD(j); setAcctDraft(j.account || ""); setResult(j.result || null); }
  }, [id]);
  useEffect(() => { load(); fetch("/api/statements/context").then((r) => r.json()).then(setCtx); }, [load]);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const candidates = useMemo(() => (ctx?.accounts || []).filter((a) => /^(Expenses|Income):/.test(a) || /^Assets:(Cash|Clearing|Receivable|Investments)/.test(a) || /^Liabilities:Loan/.test(a)), [ctx]);

  const setRowAccount = async (i, account) => {
    setD((x) => ({ ...x, rows: x.rows.map((r) => (r.i === i ? { ...r, account, source: "manual", confidence: 1, flag: "*" } : r)) }));
    await fetch(`/api/statements/drafts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ row_accounts: { [i]: account } }) });
    onChanged();
  };
  const saveAccount = async () => {
    if (!acctDraft || acctDraft === d.account) return;
    setD(await (await fetch(`/api/statements/drafts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: acctDraft }) })).json());
    onChanged();
  };
  const doImport = async (force = false) => {
    setWorking("Importing…");
    const j = await (await fetch(`/api/statements/drafts/${id}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force }) })).json();
    setWorking(""); setResult(j); await load(); onChanged();
  };
  const ask = async (e) => {
    e.preventDefault(); const question = q.trim(); if (!question) return; setQ("");
    setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: "…", pending: true }]);
    const j = await (await fetch("/api/statements/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft_id: id, question }) })).json();
    setChat((c) => c.map((m, i) => (i === c.length - 1 ? { role: "assistant", text: j.error ? `⚠ ${j.error}` : j.text, query: j.query, result: j.result } : m)));
  };

  if (!d) return <div className={s.panelWrap}><div className={s.panel}><div className={s.muted}>Loading…</div></div></div>;
  const rows = (d.rows || []).filter((r) => !onlyReview || r.flag === "!" || r.brk || !r.account);
  const rec = d.reconciliation;
  const reviewCount = (d.rows || []).filter((r) => r.flag === "!" || !r.account).length;

  return (
    <div className={s.panelWrap} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()}>
        <div className={s.panelHead}>
          <div>
            <div className={s.panelTitle} title={d.filename}>{d.filename}</div>
            <div className={s.muted}>{d.source?.toUpperCase()} · {d.rows_count} rows · {d.from} → {d.to} · {d.meta?.model || ""}{d.meta?.chunks > 1 ? ` · ${d.meta.chunks} chunks` : ""}</div>
          </div>
          <StatusPill d={d} />
          <button className={s.x} onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <div className={s.panelBody}>
          <div className={s.acctRow}>
            <span className={s.lbl}>Statement account</span>
            <input className={s.acct} value={acctDraft} onChange={(e) => setAcctDraft(e.target.value)} onBlur={saveAccount} disabled={d.status === "imported"} list="stmt-accts" />
            <datalist id="stmt-accts">{(ctx?.statement_accounts || []).map((a) => <option key={a.name} value={a.name} />)}</datalist>
            <span className={s.muted}>in {inr(d.inflow)} · out {inr(d.outflow)} · net {inr(d.net)}{d.closing_balance != null ? ` · closing ${inr(d.closing_balance)}` : ""}</span>
          </div>

          {rec && !rec.reconciled && (
            <div className={s.warnBox}>
              <b>{d.breaks ? `${d.breaks} row${d.breaks === 1 ? "" : "s"} where the running balance doesn't chain` : "Couldn't verify the numbers"}</b> — {rec.note || "check the ⚠ rows against the PDF, or tell the extractor what it missed below."}
            </div>
          )}
          {d.status === "failed" && <div className={s.errBox}><b>Extraction failed.</b> {d.meta?.error} — add a hint below and retry, or try <a href="/import/local">private on-device mode</a>.</div>}

          <div className={s.tableTools}>
            <span className={s.muted}>{Object.entries(d.meta?.classified_by || {}).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>
            <div className={s.spacer} />
            {reviewCount > 0 && <label className={s.check}><input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} /> only the {reviewCount} that need review</label>}
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>#</th><th>Date</th><th>Description</th><th className={s.r}>Amount</th><th className={s.r}>Balance</th><th>Account</th><th>How</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.i} className={`${r.flag === "!" ? s.flag : ""} ${r.brk ? s.brk : ""}`}>
                    <td className={s.muted}>{r.i}{r.brk && <span className={s.brkMark} title={`Balance break — expected ${inr(r.brk.expected_balance)} but the statement prints ${inr(r.brk.printed_balance)} (off by ${inr(r.brk.off_by)}). Check this row against the PDF.`}> ⚠</span>}</td>
                    <td className={s.nowrap}>{r.date}</td>
                    <td title={r.desc}><b>{r.payee}</b><div className={s.desc}>{r.desc}</div></td>
                    <td className={`${s.r} ${r.amount < 0 ? s.neg : s.pos}`}>{inr(r.amount)}</td>
                    <td className={`${s.r} ${s.muted}`}>{r.balance != null ? inr(r.balance) : ""}</td>
                    <td>
                      <select value={r.account || ""} onChange={(e) => setRowAccount(r.i, e.target.value)} disabled={d.status === "imported"}>
                        <option value="">— pick —</option>
                        {candidates.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </td>
                    <td><span className={`${s.chip} ${s["src_" + (r.source || "none")]}`} title={r.rule || ""}>{r.source || "?"}{r.confidence ? ` ${Math.round(r.confidence * 100)}%` : ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={s.askBox}>
            <div className={s.chat}>
              {chat.length === 0 && <div className={s.muted}>Ask about this statement — “what did I spend on Uber?” · “biggest 5 outflows” · “which rows are you unsure about?” · “why row 12”</div>}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? s.me : s.bot}>
                  <div className={s.bubble}>{m.text}</div>
                  {m.query && <details className={s.trace}><summary>how I got this</summary><pre>{JSON.stringify({ query: m.query, result: m.result }, null, 1).slice(0, 4000)}</pre></details>}
                </div>
              ))}
            </div>
            <form className={s.askRow} onSubmit={ask}><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about these rows…" /><button className={s.btn} disabled={!q.trim()}>Ask</button></form>
          </div>
        </div>

        <div className={s.panelFoot}>
          {result && !result.ok && (
            <div className={s.errBox}>
              <b>Not imported — closing balance doesn't reconcile.</b> {result.hint || result.error}
              {result.assertion && <div className={s.muted}>statement {inr(result.assertion.expected)} · ledger {inr(result.assertion.actual)} · diff {inr(result.assertion.diff)} · would append {result.would_append}, skip {result.skipped_dupes} duplicates</div>}
              {result.reason === "assertion_mismatch" && <button className={s.btn} onClick={() => doImport(true)}>Import anyway and record the gap</button>}
            </div>
          )}
          {result?.ok && <div className={s.okBox}><b>Imported.</b> {result.appended} entries · {result.skipped_dupes} duplicates skipped · {result.flagged} flagged for review{result.assertion ? ` · closing ${inr(result.assertion.expected)} ${result.assertion.ok ? "reconciles ✓" : `off by ${inr(result.assertion.diff)} (recorded)`}` : ""}</div>}
          {d.status !== "imported" && (
            <button className={s.btnPrimary} disabled={!!working || d.status !== "ready" || (d.rows || []).some((r) => !r.account)} onClick={() => doImport(false)}>
              {working || `Import ${d.rows_count} rows into ${d.account || "…"}`}
            </button>
          )}
          {d.status === "imported" && <a className={s.btn} href="/game">Open the board →</a>}
        </div>
      </div>
    </div>
  );
}

// Does this answer's DATA show a parsing problem worth offering a fix for?
// Read from the computed result, not from how the question was phrased.
function hasParseProblem(a) {
  const r = a?.result?.result;
  if (!r) return false;
  if (a.result.op === "overview") return (r.total_breaks || 0) > 0 || (r.envelope_off || 0) > 0;
  if (a.result.op === "breaks") return (a.result.matched || 0) > 0;
  if (a.result.op === "explain_statement") return !!(r.breaks || (r.envelope && !r.envelope.ok) || r.error);
  if (a.result.op === "statements") return Array.isArray(r) && r.some((x) => x.breaks > 0 || !x.reconciled);
  return false;
}

// Follow a background job until it actually ends.
//
// Both callers used to poll `for (let i = 0; i < 300; i++)` — ten minutes at a
// 2s interval — and then fall out of the loop silently. Grading six statements
// twice takes about twenty-five minutes, so the panel simply went blank mid-run
// while the job carried on server-side, which reads exactly like "nothing is
// running". A job ends when the server says it ended; the client doesn't get a
// vote. The ceiling here is a backstop against a leaked interval, not a
// judgement about how long work may take, and hitting it says so out loud.
const FOLLOW_CEILING_MS = 90 * 60 * 1000;

async function followJob(jobId, onSteps, { signal } = {}) {
  const until = Date.now() + FOLLOW_CEILING_MS;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error("stopped watching");
    await new Promise((r) => setTimeout(r, 2000));
    let j;
    try {
      j = await (await fetch(`/api/jobs/${jobId}`)).json();
    } catch {
      continue; // a dropped poll is not a dead job — keep watching
    }
    onSteps?.(j.steps || []);
    if (j.status === "done" || j.status === "failed" || j.status === "cancelled") return j;
  }
  throw new Error("stopped watching this run after 90 minutes — it may still be going; reload to pick it up again");
}

// ── The one box ─────────────────────────────────────────────────────────────
// Say what's wrong with how your statements came out. It reads back every
// statement you've already parsed, works out what's actually going wrong,
// rewrites the parser's own code, and keeps the rewrite only if it beats the
// current parser on ALL of them. Then it offers to re-parse everything so the
// whole set is read the same way.
function ParserFix({ count, onReparsed }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [reparse, setReparse] = useState(null);
  const [steps, setSteps] = useState([]);
  const [rules, setRules] = useState([]);
  const [grade, setGrade] = useState(null);

  const loadRules = useCallback(async () => {
    try { const j = await (await fetch("/api/statements/rules")).json(); setRules(j.rules || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadRules(); }, [loadRules]);

  // Watching a run is separate from starting one, so that a run started before
  // this component mounted — or before the last page reload — can be picked up
  // and shown exactly like one you just kicked off.
  const watchInvestigation = useCallback(async (jobId) => {
    setBusy("fixing");
    try {
      const j = await followJob(jobId, setSteps);
      if (j.status === "done") {
        setRes({ reply: j.result?.reply, proposed_rules: j.result?.proposed_rules || [], steps: j.steps || [] });
        await loadRules();
      } else {
        setRes({ error: j.result?.error || "the investigation stopped" });
      }
    } catch (e) { setRes({ error: e.message }); }
    setBusy("");
  }, [loadRules]);

  const watchGrading = useCallback(async (jobId) => {
    setBusy("grading");
    try {
      const j = await followJob(jobId, setSteps);
      if (j.status === "done") { setGrade(j.result); await loadRules(); await onReparsed(); }
      else { setGrade({ error: j.result?.error || "grading stopped" }); }
    } catch (e) { setGrade({ error: e.message }); }
    setBusy("");
  }, [loadRules, onReparsed]);

  // RE-ATTACH. Work lives in the database, not in this tab: reload the page,
  // come back tomorrow, or open it on another machine and a run that is still
  // going should still be on screen. Without this the only handle on a job was
  // the id returned by the POST that started it, so a refresh orphaned it.
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current) return;
    attached.current = true;
    (async () => {
      try {
        const { jobs = [] } = await (await fetch("/api/jobs")).json();
        const live = jobs.find((j) => j.status === "running" && (j.kind === "investigate" || j.kind === "grade_rule"));
        if (!live) return;
        setSteps(live.last_step ? [live.last_step] : []);
        if (live.kind === "grade_rule") await watchGrading(live.id);
        else await watchInvestigation(live.id);
      } catch { /* nothing to re-attach to */ }
    })();
  }, [watchGrading, watchInvestigation]);

  // One box. A question is answered from computed data straight away; a report
  // of something parsing wrong is answered too, then offers the parser rewrite —
  // that costs minutes and gateway calls, so it is never fired without a click.
  const ask = async (preset) => {
    const q = (typeof preset === "string" ? preset : text).trim();
    if (!q || busy) return;
    setBusy("asking"); setRes(null);
    try {
      const j = await (await fetch("/api/statements/ask-all", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      })).json();
      setAnswers((a) => [...a, { q, ...j }]);
      if (!j.error) setText("");
    } catch (e) { setAnswers((a) => [...a, { q, error: e.message }]); }
    setBusy("");
  };

  // INVESTIGATE, don't guess. This used to jump straight to rewriting the
  // parser's code from a one-line complaint. Now it reads the statement, writes
  // and runs analysis code against the source text, and only proposes a fix once
  // it has evidence — the same way a person would debug it. Steps stream in, so
  // you can see the reasoning rather than a spinner.
  const run = async (complaint) => {
    if (busy) return;
    setBusy("fixing"); setRes(null); setReparse(null); setSteps([]);
    try {
      const start = await (await fetch("/api/statements/investigate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: complaint || "Some statements don't add up. Find out why." }] }),
      })).json();
      if (start.error) throw new Error(start.error);

      await watchInvestigation(start.job_id);
    } catch (e) { setRes({ error: e.message }); setBusy(""); }
  };

  // A proposed rule is not live until it has been graded: every statement in its
  // scope is re-read and it is kept only if nothing gets worse.
  const gradeRule = async (id) => {
    setBusy("grading"); setGrade(null);
    try {
      const start = await (await fetch(`/api/statements/rules/${id}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "grade" }),
      })).json();
      if (start.error) throw new Error(start.error);
      await watchGrading(start.job_id);
    } catch (e) { setGrade({ error: e.message }); setBusy(""); }
  };

  const rejectRule = async (id) => {
    await fetch(`/api/statements/rules/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }) });
    await loadRules();
  };

  const doReparse = async () => {
    setBusy("reparsing");
    try {
      const j = await (await fetch("/api/statements/reparse", { method: "POST" })).json();
      setReparse(j);
      await onReparsed();
    } catch (e) { setReparse({ error: e.message }); }
    setBusy("");
  };

  if (!count) return null;

  return (
    <section className={s.fixBox}>
      {/* Always visible: this is the main control on the page, not a hint. */}
      <div className={s.fixHead}>
        <b>Ask about your statements — or say what parsed wrong</b>
        <span className={s.muted}>{count} parsed · every number computed from them, not guessed</span>
      </div>
      <form className={s.askForm} onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <textarea
          className={s.fixInput} rows={2} value={text} disabled={!!busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
          placeholder={`"which statements don't add up?" · "why does the April one have breaks?" · "how much did I spend on Swiggy?" · "am I missing any months?" — or tell me what's wrong: "it skips the rows after the summary box"`}
        />
        <button className={s.askBtn} type="submit" disabled={!text.trim() || !!busy}>
          {busy === "asking" ? "…" : "Ask"}
        </button>
        <button className={s.fixBtn} type="button" disabled={!!busy} onClick={() => run(text)}
          title="Read the statement, run analysis against the source text, and find out what actually went wrong. Describe the problem above, or leave it empty and it looks at whatever doesn't add up.">
          {busy === "fixing" ? "Investigating…" : "Investigate"}
        </button>
      </form>
      <div className={s.chips}>
        {["How are my statements doing?", "Which ones don't add up?", "Am I missing any months?", "Any duplicate transactions?"].map((c) => (
          <button key={c} className={s.chipBtn} disabled={!!busy} onClick={() => { ask(c); }}>{c}</button>
        ))}
      </div>

      {/* What the investigation is doing, as it does it — the code it runs and what
          came back. A two-minute job should show its working, not a spinner. */}
      {(busy === "fixing" || busy === "grading") && !!steps.length && (
        <div className={s.answer}>
          <div className={s.askedQ}>{busy === "grading" ? "Grading the rule…" : "Investigating…"}</div>
          <ol className={s.trace} style={{ margin: 0, paddingLeft: 18 }}>
            {steps.slice(-8).map((st, i) => (
              <li key={i} className={s.muted} style={{ fontSize: 12, marginBottom: 2 }}>{String(st.text).slice(0, 220)}</li>
            ))}
          </ol>
        </div>
      )}

      {res && !res.error && res.reply && (
        <div className={s.answer}>
          <div className={s.answerText} style={{ whiteSpace: "pre-wrap" }}>{res.reply}</div>
          {!!(res.steps || []).length && (
            <details className={s.trace}>
              <summary>how I worked that out — {(res.steps || []).length} step(s)</summary>
              {(res.steps || []).filter((st) => st.kind === "code").map((st, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <code>{String(st.text).slice(0, 300)}</code>
                  {st.data?.input?.code && <pre>{String(st.data.input.code).slice(0, 1200)}</pre>}
                  {st.data?.summary && <pre className={s.muted}>{String(st.data.summary).slice(0, 1500)}</pre>}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      {res?.error && <div className={s.errBox}>⚠ {res.error}</div>}

      {/* Rules it wants to add. Nothing here is live until it has been graded:
          every statement in scope is re-read and the rule is kept only if
          nothing loses rows, nothing gains breaks, and something improves. */}
      {!!rules.filter((r) => r.status === "proposed").length && (
        <div className={s.answer}>
          <div className={s.askedQ}>Proposed fixes — not applied yet</div>
          {rules.filter((r) => r.status === "proposed").map((r) => (
            <div key={r.id} className={s.fixRow} style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
              <div><b>({r.scope})</b> {r.rule}</div>
              {r.why && <div className={s.muted} style={{ fontSize: 12 }}>{r.why}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button className={s.btnPrimary} disabled={!!busy} onClick={() => gradeRule(r.id)}>
                  {busy === "grading" ? "Testing…" : "Test it on every statement"}
                </button>
                <button className={s.btnSm} disabled={!!busy} onClick={() => rejectRule(r.id)}>Discard</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {grade && (
        <div className={s.answer}>
          {grade.error ? <div className={s.errBox}>⚠ {grade.error}</div> : (
            <>
              <div className={s.answerText}><b>{grade.verdict}</b>{grade.tested ? ` · tested on ${grade.tested} statement(s)` : ""}</div>
              {!!(grade.improvements || []).length && <ul>{grade.improvements.map((x, i) => <li key={i}>✓ {x}</li>)}</ul>}
              {!!(grade.regressions || []).length && <ul>{grade.regressions.map((x, i) => <li key={i} className={s.bad}>✗ {x}</li>)}</ul>}
            </>
          )}
        </div>
      )}

      {/* What this book has learned. Every one of these is applied to future
          statements from that source, and every one earned its place. */}
      {!!rules.filter((r) => r.status === "active").length && (
        <details className={s.trace}>
          <summary>{rules.filter((r) => r.status === "active").length} rule(s) learned from your statements</summary>
          {rules.filter((r) => r.status === "active").map((r) => (
            <div key={r.id} style={{ marginBottom: 6 }}>
              <code>({r.scope})</code> {r.rule}
              {r.evidence?.improvements?.length ? <div className={s.muted} style={{ fontSize: 12 }}>{r.evidence.improvements.join(" · ")}</div> : null}
            </div>
          ))}
        </details>
      )}

      {answers.map((a, n) => (
        <div key={n} className={s.answer}>
          <div className={s.askedQ}>{a.q}</div>
          {a.error ? <div className={s.errBox}>⚠ {a.error}</div> : (
            <>
              <div className={s.answerText}>{a.text}</div>
              <details className={s.trace}>
                <summary>how I worked that out</summary>
                <code>query {JSON.stringify(a.query)}</code>
                <pre>{JSON.stringify(a.result, null, 1).slice(0, 4000)}</pre>
              </details>
              {(a.intent === "complaint" || hasParseProblem(a)) && (
                <div className={s.fixRow}>
                  <button className={s.btnPrimary} onClick={() => run(a.q)} disabled={!!busy}>
                    {busy === "fixing" ? "Investigating…" : a.intent === "complaint" ? "Investigate this" : "Investigate these"}
                  </button>
                  <span className={s.muted}>Reads the source, runs analysis against it, and proposes a fix only with evidence. A few minutes.</span>
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {res && (
        <div className={res.error ? s.errBox : res.promoted ? s.okBox : s.warnBox} style={{ marginTop: 10 }}>
          {res.error ? <b>⚠ {res.error}</b> : (
            <>
              <b>{res.promoted ? `Parser updated to v${res.version}.` : res.no_corpus ? "Nothing to learn from yet." : "Parser unchanged."}</b>{" "}
              {res.message}
              {res.corpus && <div className={s.muted}>Graded on {res.corpus.graded} of your {res.corpus.total} statements ({res.corpus.problems} with problems, {res.corpus.guards} clean as guards).</div>}
              {res.diagnosis && <div className={s.diag}><b>What I found:</b> {res.diagnosis}</div>}
              {(res.improvements || []).length > 0 && (
                <ul className={s.list}>{res.improvements.map((i, n) => <li key={n} className={s.pos}>{i.why}</li>)}</ul>
              )}
              {!res.promoted && (res.attempts || []).length > 0 && (
                <ul className={s.list}>{res.attempts.map((a) => <li key={a.attempt} className={s.muted}>Attempt {a.attempt}: {a.reason}</li>)}</ul>
              )}
              {res.promoted && !reparse && (
                <div className={s.fixRow} style={{ marginTop: 8 }}>
                  <button className={s.btnPrimary} onClick={doReparse} disabled={!!busy}>
                    {busy === "reparsing" ? "Re-parsing everything…" : `Re-parse all ${count} statement${count === 1 ? "" : "s"} with v${res.version}`}
                  </button>
                  <span className={s.muted}>So every statement is read by the same parser.</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {reparse && (
        <div className={reparse.error ? s.errBox : s.okBox} style={{ marginTop: 8 }}>
          {reparse.error ? <b>⚠ {reparse.error}</b> : <><b>Done.</b> {reparse.message}</>}
        </div>
      )}
    </section>
  );
}
