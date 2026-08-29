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
  const remove = async (id) => { await fetch(`/api/statements/drafts/${id}`, { method: "DELETE" }); setOpen((o) => (o === id ? null : o)); refresh(); };

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
              {drafts.map((d) => <Card key={d.id} d={d} onOpen={() => setOpen(d.id)} onImport={() => importOne(d.id).then((j) => flash(j.ok ? `Imported ${d.filename}` : `⚠ ${d.filename}: ${j.hint || j.error || "closing balance doesn't reconcile — open for details"}`))} onRemove={() => remove(d.id)} />)}
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
        <button className={s.x} title="Remove this draft" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
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

// ── The one box ─────────────────────────────────────────────────────────────
// Say what's wrong with how your statements came out. It reads back every
// statement you've already parsed, works out what's actually going wrong,
// rewrites the parser's own code, and keeps the rewrite only if it beats the
// current parser on ALL of them. Then it offers to re-parse everything so the
// whole set is read the same way.
function ParserFix({ count, onReparsed }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState(null);
  const [reparse, setReparse] = useState(null);

  const run = async () => {
    if (!text.trim() || busy) return;
    setBusy("fixing"); setRes(null); setReparse(null);
    try {
      const j = await (await fetch("/api/extractor/improve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ complaint: text }),
      })).json();
      setRes(j);
      if (j.promoted) setText("");
    } catch (e) { setRes({ error: e.message }); }
    setBusy("");
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
      {!open ? (
        <button className={s.fixTrigger} onClick={() => setOpen(true)}>
          ✎ Something parsed wrong? Tell the parser — it'll fix its own code
        </button>
      ) : (
        <>
          <div className={s.fixHead}>
            <b>What did the parser get wrong?</b>
            <button className={s.x} onClick={() => setOpen(false)}>×</button>
          </div>
          <textarea
            className={s.fixInput} rows={2} value={text} onChange={(e) => setText(e.target.value)}
            disabled={!!busy}
            placeholder={`In your own words — e.g. "it's missing the rows on the last page after the summary box" · "foreign-currency rows use the dollar amount instead of the rupee one" · "rows are duplicated near page breaks" · "credits on the Amex come through negative"`}
          />
          <div className={s.fixRow}>
            <button className={s.btnPrimary} onClick={run} disabled={!text.trim() || !!busy}>
              {busy === "fixing" ? "Reading your statements and rewriting the parser…" : "Fix the parser"}
            </button>
            <span className={s.muted}>
              It re-reads your parsed statements, rewrites the parser, and keeps the change only if every statement gets the same or better. Takes a few minutes.
            </span>
          </div>
        </>
      )}

      {res && (
        <div className={res.error ? s.errBox : res.promoted ? s.okBox : s.warnBox} style={{ marginTop: 10 }}>
          {res.error ? <b>⚠ {res.error}</b> : (
            <>
              <b>{res.promoted ? `Parser updated to v${res.version}.` : res.no_corpus ? "Nothing to learn from yet." : "Parser unchanged."}</b>{" "}
              {res.message}
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
