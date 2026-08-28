"use client";
// Browser statement import. The whole pipeline runs client-side:
//   file → pdf.js / CSV / XLSX → exact rows → rules → LFM2.5 (Web Worker, WebGPU)
//   → preview (editable) → ask questions (grounded on the parsed rows) → POST rows.
// No LLM API anywhere; the statement never leaves the browser until you import.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./import.module.css";
import { csvToGrid, parseGrid, pdfItemsToLines, parsePdfLines, inferBankAccount, normalizeCardSigns } from "../../lib/statements/parse";
import { buildContext, classifyByRules, classifyRowWithModel, applyModelAnswer, flagFor } from "../../lib/statements/classify";
import { renderResult, summary, explain, inr } from "../../lib/statements/query";
import { answer as answerQuestion, narratePrompt } from "../../lib/statements/ask";

const MODEL_LABELS = {
  "lfm2.5-1.2b": "LFM2.5 1.2B · ≈0.9 GB · best answers",
  "lfm2.5-350m": "LFM2.5 350M · ≈0.3 GB · fast",
};

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function parseFile(file) {
  const name = file.name, ext = name.split(".").pop().toLowerCase();
  const buf = await file.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  let parsed, method;
  if (ext === "csv" || ext === "txt") {
    parsed = parseGrid(csvToGrid(new TextDecoder("utf-8").decode(buf))); method = "csv";
  } else if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    parsed = parseGrid(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })); method = "xlsx";
  } else if (ext === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"; // copied to public/ on postinstall (uses import.meta; can't be bundled)
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const lines = [], pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const pl = pdfItemsToLines((await page.getTextContent()).items);
      pages.push(pl.join("\n"));           // per-page text, for AI extraction (chunked by page)
      lines.push(...pl, "");
    }
    parsed = parsePdfLines(lines); parsed.pages = pages; method = `pdf (${doc.numPages} pages)`;
  } else throw new Error(`unsupported file type .${ext} — use PDF, CSV or XLSX`);
  return { name, bytes: buf.byteLength, sha256, method, ...parsed };
}

export default function ImportClient() {
  const [modelKey, setModelKey] = useState("lfm2.5-1.2b");
  const [model, setModel] = useState({ state: "idle", pct: 0, device: null, note: "" });
  const [ctxRaw, setCtxRaw] = useState(null);
  const [file, setFile] = useState(null);
  const [acct, setAcct] = useState(null);
  const [rows, setRows] = useState([]);
  const [phase, setPhase] = useState("pick"); // pick | parsed | classifying | ready | importing | done
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [chat, setChat] = useState([]);
  const [q, setQ] = useState("");
  const [thinking, setThinking] = useState(false);
  const worker = useRef(null);
  const pending = useRef(new Map());

  const ctx = useMemo(() => (ctxRaw ? buildContext(ctxRaw) : null), [ctxRaw]);

  // the server resolves WHICH book from the session — the page never names an entity
  useEffect(() => {
    fetch("/api/statements/context").then((r) => r.json()).then((j) => { if (j.error) setProgress(`⚠ ${j.error}`); else setCtxRaw(j); });
  }, []);
  const entity = ctxRaw?.entity || "";

  // ── worker lifecycle ──
  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker("/llm.worker.js", { type: "module" }); // static module worker, see public/llm.worker.js
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        // transformers.js emits per-file events plus an overall `progress_total`
        setModel((prev) => ({ ...prev, state: "loading", note: m.note || prev.note,
          pct: m.status === "progress_total" ? Math.round(m.progress) : prev.pct,
          loaded: m.status === "progress_total" ? m.loaded : prev.loaded, total: m.status === "progress_total" ? m.total : prev.total }));
      } else if (m.type === "ready") setModel({ state: "ready", pct: 100, device: m.device, note: "" });
      else if (m.type === "token") { const p = pending.current.get(m.id); p?.onToken?.(m.text); }
      else if (m.type === "done") { const p = pending.current.get(m.id); pending.current.delete(m.id); p?.resolve(m.text); }
      else if (m.type === "error") {
        if (m.id && pending.current.has(m.id)) { pending.current.get(m.id).reject(new Error(m.error)); pending.current.delete(m.id); }
        else setModel((prev) => ({ ...prev, state: "error", note: m.error }));
      }
    };
    w.onerror = (e) => setModel((prev) => ({ ...prev, state: "error", note: `worker failed: ${e.message || "see console"}` }));
    worker.current = w;
    return w;
  }, []);

  const loadModel = useCallback(() => {
    setModel({ state: "loading", pct: 0, device: null, note: "" });
    ensureWorker().postMessage({ type: "load", model: modelKey });
  }, [ensureWorker, modelKey]);

  const generate = useCallback((messages, max_new_tokens, onToken) => new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    pending.current.set(id, { resolve, reject, onToken });
    ensureWorker().postMessage({ type: "generate", id, messages, max_new_tokens });
  }), [ensureWorker]);

  useEffect(() => () => worker.current?.terminate(), []);

  // ── pipeline ──
  const onFile = async (f) => {
    if (!f || !ctx) return;
    setResult(null); setChat([]); setRows([]);
    setPhase("parsing"); setProgress(`Reading ${f.name}…`);
    try {
      const parsed = await parseFile(f);
      const inferred = inferBankAccount(f.name);
      const normalized = normalizeCardSigns(parsed.rows, inferred.kind).map((r, i) => ({ ...r, i: i + 1 }));
      setFile(parsed); setAcct(inferred);
      const ruled = normalized.map((r) => classifyByRules(r, ctx));
      setRows(ruled);
      const need = ruled.filter((r) => !r.account).length;
      setPhase("parsed");
      setProgress(parsed.rows.length
        ? `${parsed.rows.length} rows via ${parsed.method} · ${ruled.length - need} classified by your rules/history · ${need} for the model`
        : `⚠ Could not find transactions: ${parsed.note}`);
    } catch (e) { setPhase("pick"); setProgress(`⚠ ${e.message}`); }
  };

  const classifyWithModel = async () => {
    const todo = rows.filter((r) => !r.account);
    if (!todo.length) { setPhase("ready"); return; }
    if (model.state !== "ready") { setProgress("Load the model first (or set the remaining rows by hand)."); return; }
    setPhase("classifying");
    let done = 0; const next = [...rows];
    for (const row of todo) {
      setProgress(`Model classifying ${done + 1}/${todo.length} — ${row.payee}…`);
      let account = null, trace = [];
      try { ({ account, trace } = await classifyRowWithModel(row, ctx, (msgs, n) => generate(msgs, n))); } catch (e) { setProgress(`⚠ model error: ${e.message}`); }
      console.debug("[import] model:", row.desc, "⇒", account, trace.join(" "));
      next[row.i - 1] = applyModelAnswer(row, account, ctx, modelKey);
      done++;
      setRows([...next]);
    }
    setPhase("ready"); setProgress(`Done — ${todo.length} rows classified by the model on-device.`);
  };

  // Extract with a frontier model via the aikaara gateway. It returns SIGNED
  // amounts + a running balance; a server-side reconciler verifies the numbers
  // against that balance, so we surface whether it reconciled. We NEVER re-sign
  // AI output (unlike the heuristic path) — the model already got the direction.
  const [extractRec, setExtractRec] = useState(null);
  const extractWithAI = async () => {
    if (!file?.pages?.length) { setProgress("AI extraction works on PDF statements."); return; }
    setPhase("parsing"); setExtractRec(null); setProgress("Extracting with the frontier model (via the aikaara gateway)…");
    try {
      const j = await (await fetch("/api/statements/extract", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages: file.pages, filename: file.name, bank: acct?.name }),
      })).json();
      if (j.error) {
        setProgress(j.error === "extract_not_configured"
          ? "⚠ AI extraction isn't switched on yet — configure the gateway routing client + set AIKAARA_GATEWAY_URL/KEY."
          : `⚠ ${j.message || j.error}`);
        setPhase("parsed"); return;
      }
      const txns = j.transactions || [];
      const normalized = txns.map((t, i) => ({ date: t.date, desc: t.description, amount: t.amount, balance: t.balance, i: i + 1 }));
      const ruled = normalized.map((r) => classifyByRules(r, ctx));
      setRows(ruled); setExtractRec(j.reconciliation || null);
      const need = ruled.filter((r) => !r.account).length;
      setPhase("parsed");
      const rec = j.reconciliation;
      setProgress(`AI extracted ${txns.length} rows · ${rec?.reconciled ? "✓ balance-verified" : `⚠ ${rec?.note || "not balance-verified — review"}`} · ${ruled.length - need} auto-classified · ${need} for the model/picker`);
    } catch (e) { setProgress(`⚠ extract error: ${e.message}`); setPhase("parsed"); }
  };

  const finalRows = useMemo(() => rows.map((r) => ({ ...r, flag: r.account ? flagFor(r) : "!" })), [rows]);
  const sum = useMemo(() => (finalRows.length ? summary(finalRows) : null), [finalRows]);

  const setRowAccount = (i, account) => setRows((rs) => rs.map((r) => (r.i === i ? { ...r, account, source: "manual", rule: "manual", confidence: 1 } : r)));

  const doImport = async (force = false) => {
    if (finalRows.some((r) => !r.account)) { setProgress("Some rows still have no account — classify or set them first."); return; }
    setPhase("importing");
    const r = await fetch("/api/statements/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: file.name, sha256: file.sha256, bytes: file.bytes, account: acct.account, kind: acct.slug, model: modelKey, force,
        rows: finalRows.map(({ date, desc, amount, balance, payee, account, source, rule, confidence, flag, sign_flipped }) => ({ date, desc, amount, balance, payee, account, source, rule, confidence, flag, sign_flipped })) }),
    });
    const j = await r.json();
    setResult(j); setPhase(j.ok ? "done" : "ready");
  };

  // ── ask ──
  const ask = async (question) => {
    if (!question.trim() || thinking) return;
    setQ(""); setThinking(true);
    const mine = { role: "user", text: question };
    setChat((c) => [...c, mine, { role: "assistant", text: "", pending: true }]);
    const update = (patch) => setChat((c) => c.map((m, i) => (i === c.length - 1 ? { ...m, ...patch } : m)));
    try {
      // 0) deterministic intents that need no model
      const why = question.match(/\b(why|explain).*?(?:row|line|#)\s*(\d+)/i) || question.match(/^#?(\d+)\s*\?*$/);
      const recl = question.match(/(?:reclassify|move|set|change)\s+(?:row|line|#)?\s*(\d+)\s+(?:to|as|→)\s+([A-Za-z][A-Za-z0-9:]+)/i);
      if (recl) {
        const i = Number(recl[1]), target = ctx.accounts.find((a) => a.toLowerCase() === recl[2].toLowerCase());
        if (!target) { update({ text: `I don't see "${recl[2]}" in your chart. Accounts include: ${ctx.candidates.slice(0, 8).join(", ")}…`, pending: false }); return; }
        setRowAccount(i, target);
        update({ text: `Done — row ${i} is now ${target} (marked manual, confidence 1.0). It will import that way.`, pending: false }); return;
      }
      if (why) {
        const r = finalRows.find((x) => x.i === Number(why[2] || why[1]));
        update({ text: r ? `Row ${r.i} · ${r.date} · ${r.payee} · ${inr(r.amount)} → ${r.account}\n${explain(r)}` : "I don't see that row number.", pending: false }); return;
      }
      if (model.state !== "ready") { update({ text: "Load the on-device model to ask free-form questions. Meanwhile: \"why row 12\", \"reclassify row 12 to Expenses:Dining\" work without it.", pending: false }); return; }

      // 1) model picks the question TYPE (multiple choice); keywords/direction/limit
      //    are extracted deterministically; query.js computes; the answer text is
      //    rendered from the result — numbers never come from the model.
      const a = await answerQuestion(question, finalRows, (msgs, n) => generate(msgs, n));
      update({ query: a.query, data: a.result, text: a.text });
      // 2) plain-words narration, streamed underneath (facts only from the answer)
      let extra = "";
      try { const final = await generate(narratePrompt(question, a.text), 90, (t) => { extra += t; update({ text: `${a.text}\n\n${extra}` }); }); update({ text: `${a.text}\n\n${final || extra}`.trim(), pending: false }); }
      catch { update({ pending: false }); }
    } catch (e) { update({ text: `⚠ ${e.message}`, pending: false }); }
    finally { setThinking(false); }
  };

  const pct = model.pct || 0;
  const mb = (n) => (n ? `${Math.round(n / 1048576)} MB` : "");

  return (
    <div className={s.wrap}>
      <div className={s.top}>
        <h1>Import a <span className={s.g}>statement</span>{entity && entity !== "personal" ? "" : entity ? " · Personal" : ""}</h1>
        <a className={s.back} href="/game">← Board</a>
      </div>
      <p className={s.lede}>Parsed and classified <b>in your browser</b> — pdf.js reads the numbers exactly, your saved decisions and history classify most lines, and an on-device LFM2.5 model handles the rest. Nothing is sent anywhere until you press Import.</p>

      <div className={s.grid}>
        <section className={s.panel}>
          <h3 className={s.pH}>1 · On-device model</h3>
          <div className={s.row}>
            <select value={modelKey} onChange={(e) => setModelKey(e.target.value)} disabled={model.state === "loading"}>
              {Object.entries(MODEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className={s.btn} onClick={loadModel} disabled={model.state === "loading" || model.state === "ready"}>
              {model.state === "ready" ? `Ready · ${model.device}` : model.state === "loading" ? `Loading ${pct}%${model.total ? ` · ${mb(model.loaded)} / ${mb(model.total)}` : ""}` : model.state === "error" ? "Retry" : "Load model"}
            </button>
          </div>
          {model.state === "loading" && <div className={s.track}><div className={s.fill} style={{ width: `${pct}%` }} /></div>}
          {model.note && <div className={s.note}>{model.note}</div>}
          <div className={s.hint}>Downloads once from Hugging Face and stays cached in this browser. Needs WebGPU (Chrome/Edge; Safari 18+); falls back to slower WASM.</div>
        </section>

        <section className={s.panel}>
          <h3 className={s.pH}>2 · Statement file</h3>
          <input type="file" accept=".pdf,.csv,.xlsx,.xls,.txt" onChange={(e) => onFile(e.target.files?.[0])} disabled={!ctx || phase === "classifying" || phase === "importing"} />
          {acct && (
            <div className={s.row}>
              <span className={s.lbl}>Posts to</span>
              <input className={s.acct} value={acct.account} onChange={(e) => setAcct({ ...acct, account: e.target.value })} />
              <span className={s.chip}>{acct.kind}</span>
            </div>
          )}
          {progress && <div className={s.note}>{progress}</div>}
          {rows.length > 0 && rows.some((r) => !r.account) && phase !== "classifying" && (
            <button className={s.btn} onClick={classifyWithModel}>Classify {rows.filter((r) => !r.account).length} remaining rows with the model</button>
          )}
          {file?.pages?.length > 0 && phase !== "classifying" && phase !== "importing" && (
            <button className={s.btn} onClick={extractWithAI}
              title="Sends the statement text to a frontier model via the aikaara gateway; every amount is verified against the running balance before it's trusted."
              style={{ background: "var(--ac, #2a78d6)", color: "#fff" }}>
              ✦ Extract with AI — handles any layout, balance-verified
            </button>
          )}
        </section>
      </div>

      {sum && (
        <section className={s.panel}>
          <h3 className={s.pH}>3 · Preview <span className={s.side}>{sum.from} → {sum.to}</span></h3>
          <div className={s.stats}>
            <div><b>{sum.rows}</b> rows</div>
            <div className={s.pos}>in {inr(sum.inflow)}</div>
            <div className={s.neg}>out {inr(sum.outflow)}</div>
            <div>net <b>{inr(sum.net)}</b></div>
            {sum.closing_balance != null && <div>closing <b>{inr(sum.closing_balance)}</b></div>}
            <div className={sum.needs_review ? s.warn : ""}>{sum.needs_review} need review</div>
            {extractRec && <div className={extractRec.reconciled ? s.pos : s.warn} title={extractRec.note || ""}>{extractRec.reconciled ? "✓ balance-reconciled" : `⚠ ${extractRec.continuity?.mismatches?.length || 0} balance breaks`}</div>}
            <div className={s.muted}>{Object.entries(sum.classified_by).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>#</th><th>Date</th><th>Description</th><th className={s.r}>Amount</th><th>Account</th><th>How</th></tr></thead>
              <tbody>
                {finalRows.map((r) => (
                  <tr key={r.i} className={r.flag === "!" ? s.flag : ""}>
                    <td className={s.muted}>{r.i}</td>
                    <td className={s.nowrap}>{r.date}</td>
                    <td title={r.desc}><b>{r.payee}</b><div className={s.desc}>{r.desc}</div></td>
                    <td className={`${s.r} ${r.amount < 0 ? s.neg : s.pos}`}>{inr(r.amount)}</td>
                    <td>
                      <select value={r.account || ""} onChange={(e) => setRowAccount(r.i, e.target.value)}>
                        <option value="">— pick —</option>
                        {ctx.candidates.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </td>
                    <td><span className={`${s.chip} ${s["src_" + (r.source || "none")]}`} title={r.rule || ""}>{r.source || "?"}{r.confidence ? ` ${Math.round(r.confidence * 100)}%` : ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {sum && (
        <div className={s.grid}>
          <section className={s.panel}>
            <h3 className={s.pH}>4 · Ask about this statement</h3>
            <div className={s.chat}>
              {chat.length === 0 && <div className={s.hint}>Try: “what did I spend on Uber?” · “biggest 5 outflows” · “why row 12” · “which rows are you unsure about?” · “reclassify row 12 to Expenses:Dining” · “total by account”</div>}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? s.me : s.bot}>
                  <div className={s.bubble}>{m.text || (m.pending ? "…" : "")}</div>
                  {m.query && <details className={s.trace}><summary>how I got this</summary><code>query {JSON.stringify(m.query)}</code><pre>{renderResult(m.data)}</pre></details>}
                </div>
              ))}
            </div>
            <form className={s.row} onSubmit={(e) => { e.preventDefault(); ask(q); }}>
              <input className={s.q} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about the parsed rows…" disabled={thinking} />
              <button className={s.btn} disabled={thinking || !q.trim()}>{thinking ? "…" : "Ask"}</button>
            </form>
          </section>

          <section className={s.panel}>
            <h3 className={s.pH}>5 · Import</h3>
            <p className={s.hint}>Appends {finalRows.length} entries to <b>{acct?.account}</b> (duplicates skipped), records the closing balance as an assertion and checks it against the ledger before committing. Flagged (!) rows land in the review queue.</p>
            <button className={s.btnBig} onClick={() => doImport(false)} disabled={phase === "importing" || phase === "done" || finalRows.some((r) => !r.account)}>
              {phase === "importing" ? "Importing…" : phase === "done" ? "Imported" : `Import ${finalRows.length} rows`}
            </button>
            {result && !result.ok && (
              <div className={s.err}>
                <b>Not imported — closing balance doesn't reconcile.</b>
                <div>{result.hint || result.error}</div>
                {result.assertion && <div className={s.muted}>expected {inr(result.assertion.expected)} · ledger {inr(result.assertion.actual)} · diff {inr(result.assertion.diff)} · would append {result.would_append}, skip {result.skipped_dupes} duplicates</div>}
                {result.reason === "assertion_mismatch" && <button className={s.btn} onClick={() => doImport(true)}>Import anyway and record the gap</button>}
              </div>
            )}
            {result?.ok && (
              <div className={s.ok}>
                <b>Imported.</b> {result.appended} entries appended · {result.skipped_dupes} duplicates skipped · {result.flagged} flagged for review
                {result.assertion && <div className={s.muted}>closing assertion {inr(result.assertion.expected)} on {result.assertion.date} — {result.assertion.ok ? "reconciles ✓" : `off by ${inr(result.assertion.diff)} (recorded)`}</div>}
                <div><a href="/game">Open the board →</a></div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
