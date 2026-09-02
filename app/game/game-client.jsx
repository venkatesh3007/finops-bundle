"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import s from "./game.module.css";

/* ---------- helpers ---------- */
const inr = (n) => (n < 0 ? "−₹" : "₹") + Math.round(Math.abs(n)).toLocaleString("en-IN");
const compact = (n) => {
  const a = Math.abs(n), sg = n < 0 ? "−" : "";
  if (a >= 1e7) return `${sg}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sg}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sg}₹${Math.round(a / 1e3)}k`;
  return `${sg}₹${Math.round(a)}`;
};
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const pad = (n) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monLabel = (m) => { const [y, mo] = m.split("-").map(Number); return `${MON[mo - 1]} ${String(y).slice(2)}`; };
const monLong = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1).toLocaleString("en", { month: "long", year: "numeric" }); };
// which Indian FY (Apr–Mar) a month belongs to → the FY start year
const fyOf = (m) => { const [y, mo] = m.split("-").map(Number); return mo >= 4 ? y : y - 1; };

const THEMES = [
  { id: "climb", name: "Climb", ac: "#f2c14e" },
  { id: "board", name: "Board", ac: "#c98a3c" },
  { id: "machine", name: "Machine", ac: "#35d0c4" },
  { id: "season", name: "Season", ac: "#ff5d6c" },
  { id: "quest", name: "Quest", ac: "#a988ff" },
];

/* ---------- root ---------- */
export default function GameClient({ entity = "personal" }) {
  const [theme, setTheme] = useState("climb");
  const [tab, setTab] = useState("play"); // play | world | statement | status
  const [resetting, setResetting] = useState(false);
  const [help, setHelp] = useState(0); // bump to (re)play the guided tour
  const [me, setMe] = useState(null);   // { caller } from /api/auth/me
  const ac = THEMES.find((t) => t.id === theme).ac;

  useEffect(() => { fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => setMe({ caller: null })); }, []);

  const TABS = [["play", "Play"], ["world", "World"], ["statement", "Statement"], ["status", "Status"]];
  // A signed-in customer whose warehouse is still empty gets onboarding, not a blank board.
  const needsOnboard = me?.caller?.userId && !me.caller.hasData;

  return (
    <div className={s.app} data-theme={theme} style={{ "--ac": ac }}>
      <div className={s.top}>
        <div className={s.brand}>finops<span style={{ color: ac }}>·</span>play</div>
        <div className={s.tabs}>
          {!needsOnboard && TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? s.tabOn : s.tab} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className={s.topRight}>
          {me?.caller?.email && <AccountChip email={me.caller.email} />}
          {!needsOnboard && <a className={s.helpBtn} href="/import" title="Import a bank/card statement (parsed on-device)">⬆</a>}
          {!needsOnboard && <button className={s.helpBtn} title="How to play — replay the walkthrough" onClick={() => { setTab("play"); setHelp((h) => h + 1); }}>?</button>}
          {!needsOnboard && <button className={s.resetBtn} title="Reset game progress" onClick={() => setResetting(true)}>⟳</button>}
          <div className={s.themeDots}>
            {THEMES.map((t) => (
              <button key={t.id} title={t.name} className={theme === t.id ? s.dotOn : s.dot}
                onClick={() => setTheme(t.id)} style={{ "--d": t.ac }} />
            ))}
          </div>
        </div>
      </div>

      {needsOnboard ? <Onboard caller={me.caller} />
        : tab === "play" ? <Play entity={entity} />
        : tab === "world" ? <World entity={entity} />
        : tab === "statement" ? <Ledger entity={entity} />
        : <Status entity={entity} theme={theme} />}

      {resetting && <ResetDialog entity={entity} onClose={() => setResetting(false)} />}
      <Tour enabled={!needsOnboard && tab === "play"} replay={help} />
    </div>
  );
}

// Small identity chip + account menu (start-over, sign-out) for signed-in customers.
function AccountChip({ email }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const btn = { width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line,#2c313d)", background: "transparent", color: "var(--ink,#e7e9ee)", cursor: "pointer", fontSize: 13 };

  async function startOver() {
    setErr(""); setBusy(true);
    try {
      const j = await (await fetch("/api/onboard/reset", { method: "POST" })).json();
      if (j.error) throw new Error(j.error);
      location.reload();
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  }

  return (
    <div style={{ position: "relative" }}>
      <button className={s.dot} title={email} onClick={() => { setOpen((v) => !v); setConfirming(false); setErr(""); }}
        style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--ac)", color: "#fff", fontWeight: 700, fontSize: 12, border: 0, cursor: "pointer" }}>
        {email[0].toUpperCase()}
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: 32, background: "var(--panel2,#1b1f2a)", border: "1px solid var(--line,#2c313d)", borderRadius: 10, padding: 10, minWidth: 220, zIndex: 50, boxShadow: "0 8px 30px rgba(0,0,0,.4)" }}>
          <div style={{ fontSize: 12, color: "var(--mut,#9aa0ad)", marginBottom: 8, wordBreak: "break-all" }}>{email}</div>
          {!confirming ? (
            <button onClick={() => setConfirming(true)} style={{ ...btn, marginBottom: 6 }}>Start over — clear my data</button>
          ) : (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12, color: "var(--lose,#ff8686)", lineHeight: 1.45, marginBottom: 6 }}>Delete every transaction in your warehouse and return to onboarding? This can’t be undone.</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button disabled={busy} onClick={startOver} style={{ ...btn, flex: 1, border: "1px solid var(--lose,#ff5d6c)", color: "var(--lose,#ff8686)" }}>{busy ? "…" : "Yes, wipe it"}</button>
                <button disabled={busy} onClick={() => setConfirming(false)} style={{ ...btn, flex: 1 }}>Cancel</button>
              </div>
            </div>
          )}
          {err && <div style={{ fontSize: 12, color: "var(--lose,#ff8686)", marginBottom: 6 }}>{err}</div>}
          <button onClick={() => fetch("/api/auth/logout", { method: "POST" }).then(() => (location.href = "/login"))} style={btn}>Sign out</button>
        </div>
      )}
    </div>
  );
}

// The first-run screen: a fresh, empty warehouse. Two ways to fill it — a playable
// demo, or the user's own first bank statement (CSV).
function Onboard({ caller }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const name = (caller.name || caller.email || "there").split("@")[0];

  async function loadSample() {
    setErr(""); setBusy("sample");
    try {
      const j = await (await fetch("/api/onboard/sample", { method: "POST" })).json();
      if (j.error) throw new Error(j.error);
      location.reload();
    } catch (e) { setErr(String(e.message || e)); setBusy(""); }
  }

  return (
    <div className={s.onboard}>
      <div className={s.obCard}>
        <div className={s.obKicker}>YOUR WAREHOUSE IS EMPTY</div>
        <h1 className={s.obTitle}>Welcome, {name}.</h1>
        <p className={s.obLead}>
          finops turns your money into a warehouse you run. Bank statements arrive as <b>deliveries</b>;
          a robot stacks the obvious ones; you sort the rest onto shelves. Let’s get your first crates in.
        </p>

        <div className={s.obGrid}>
          <div className={s.obTile}>
            <div className={s.obTileTop}>🏷️ Try it first</div>
            <div className={s.obTileBody}>Load a 2-month sample warehouse — salary, rent, subscriptions, an unsorted pile, and one customer who owes you. Play immediately.</div>
            <button className={s.obBtnGhost} disabled={!!busy} onClick={loadSample}>{busy === "sample" ? "Loading…" : "Load sample warehouse"}</button>
          </div>

          <div className={s.obTile}>
            <div className={s.obTileTop}>📥 Your own statement</div>
            <div className={s.obTileBody}>Upload a bank/card statement (PDF, CSV or XLSX). It is parsed and sorted <b>in your browser</b> — an on-device model, no cloud AI — and you can ask it questions before anything is imported.</div>
            <a className={s.obBtn} href="/import">Import a statement →</a>
          </div>
        </div>
        {err && <div className={s.obErr}>{err}</div>}
      </div>
    </div>
  );
}

/* ======================  THE FOREMAN — guided walkthrough  ================== */
/* Spotlight coach-marks that step a first-timer through the board, then get out
   of the way. Auto-runs once (localStorage), replayable from the ? button. Each
   step highlights a real element by [data-tour] and floats a tip beside it. */
const TOUR = [
  { title: "Welcome to your warehouse", body: "I'm the Foreman — your guide. Six taps and you'll know how to play. I'll get out of your way after that.", cta: "Show me the ropes" },
  { sel: '[data-tour="season"]', place: "below", title: "Your year", body: "Each tile is a month — a delivery of transactions. A gold dot means items are waiting. Tap one to open it." },
  { sel: '[data-tour="head"]', place: "below", title: "What needs YOU", body: "The robot already sorted most of the pile. This big number is what's left for you to decide. The ring is how much of the month is matched." },
  { sel: '[data-tour="quads"]', place: "above", title: "Your warehouse", body: "Every category is a shelf, stacked in an aisle — Fixed/Variable, In/Out. That's your cashflow model and your money's home in one. Tap any shelf to see the crates on it." },
  { sel: '[data-tour="cards"]', place: "above", title: "The calls that need a person", body: "Each card is one transaction that needs your judgment — merchant, amount, where it came from. Categorize it, add it to your plan, accept, or park it — and every call teaches the game a rule for next time." },
  { sel: '[data-tour="lock"]', place: "below", title: "Seal the month", body: "When nothing needs you, lock it to bank your streak. That's a full round." },
  { title: "You're all set", body: "I'll keep a nudge on-screen telling you the single best next move. Tap ? up top to replay this anytime.", cta: "Start playing" },
];
function Tour({ enabled, replay }) {
  const [active, setActive] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);

  // auto-run once for a first-timer; replay when the ? button bumps `replay`
  useEffect(() => {
    if (!enabled) { setActive(false); return; }
    let done = false;
    try { done = localStorage.getItem("finops_tour_v1") === "1"; } catch {}
    if (!done) { setI(0); setActive(true); }
  }, [enabled]);
  useEffect(() => { if (replay > 0) { setI(0); setActive(true); } }, [replay]);

  // find + track the current step's target
  const step = TOUR[i];
  useEffect(() => {
    if (!active) return;
    if (!step.sel) { setRect(null); return; }
    const measure = () => {
      const el = document.querySelector(step.sel);
      if (!el) { setRect(null); return; }
      setRect(el.getBoundingClientRect());
    };
    const el = document.querySelector(step.sel);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(measure, 260);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [active, i, step]);

  const finish = () => { try { localStorage.setItem("finops_tour_v1", "1"); } catch {} setActive(false); };
  if (!active) return null;
  const last = i === TOUR.length - 1;
  const pad = 8;
  const hole = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null;
  // tip position
  let tip = { left: "50%", top: "50%", transform: "translate(-50%,-50%)" };
  if (hole) {
    const below = step.place !== "above" && hole.top + hole.height + 200 < window.innerHeight;
    const left = Math.min(Math.max(hole.left, 14), window.innerWidth - 360);
    tip = below ? { top: hole.top + hole.height + 12, left } : { top: Math.max(14, hole.top - 12), left, transform: "translateY(-100%)" };
  }
  return (
    <div className={s.tourWrap}>
      {hole ? <div className={s.tourHole} style={hole} /> : <div className={s.tourDim} />}
      <div className={s.tourTip} style={tip}>
        <button className={s.tourSkip} onClick={finish}>Skip</button>
        <div className={s.tourHead}><span className={s.tourAv}>👷</span><b>{step.title}</b></div>
        <p className={s.tourBody}>{step.body}</p>
        <div className={s.tourFoot}>
          <div className={s.tourDots}>{TOUR.map((_, k) => <span key={k} className={k === i ? s.tdOn : s.td} />)}</div>
          <div className={s.tourBtns}>
            {i > 0 && !step.cta && <button className={s.tourBack} onClick={() => setI(i - 1)}>Back</button>}
            <button className={s.tourNext} onClick={() => last ? finish() : setI(i + 1)}>{step.cta || (last ? "Done" : "Next")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Reset — clears game progress (unlocks months, clears matches & decisions),
   leaves the books and plan intact. Two-step confirm; reloads on success. */
function ResetDialog({ entity, onClose }) {
  const [busy, setBusy] = useState(false);
  const [alsoQuests, setAlsoQuests] = useState(false);
  const [done, setDone] = useState(null);
  const go = async () => {
    setBusy(true);
    try {
      const j = await (await fetch("/api/game/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, quests: alsoQuests }) })).json();
      if (j.error) { setBusy(false); return; }
      setDone(j.reset);
      setTimeout(() => window.location.reload(), 1100);
    } catch { setBusy(false); }
  };
  return (
    <div className={s.sealOverlay} onClick={busy ? undefined : onClose}>
      <div className={s.resetCard} onClick={(e) => e.stopPropagation()}>
        {done ? (
          <>
            <div className={s.resetTick}>⟳</div>
            <b>Game reset</b>
            <span className={s.resetSub}>{done.months_unlocked} months unlocked · {done.matches_cleared} matches & {done.decisions_cleared} decisions cleared. Reloading…</span>
          </>
        ) : (
          <>
            <div className={s.resetIcon}>⟳</div>
            <b>Reset the game?</b>
            <span className={s.resetSub}>Unlocks every month and clears your matches, rulings, and accept/defer decisions so you can replay. <strong>Your books and your plan stay intact.</strong> Corrections already posted to the ledger can't be undone.</span>
            <label className={s.resetChk}><input type="checkbox" checked={alsoQuests} onChange={(e) => setAlsoQuests(e.target.checked)} /> also reopen resolved quests</label>
            <div className={s.resetActs}>
              <button className={s.resetCancel} disabled={busy} onClick={onClose}>Cancel</button>
              <button className={s.resetGo} disabled={busy} onClick={go}>{busy ? "Resetting…" : "Reset game"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ===================================================================== */
/* ==================  STATEMENT — every line, on demand  ============== */
/* ===================================================================== */
const PROV = {
  statement: { label: "Statement", cls: "pvStatement" },
  forecast: { label: "Forecast", cls: "pvForecast" },
  reconstructed: { label: "Reconstructed", cls: "pvRecon" },
  book: { label: "Book", cls: "pvBook" },
  correction: { label: "Correction", cls: "pvCorr" },
};
const PROV_NOTE = {
  reconstructed: "These lines were entered during cleanup to balance the books — your judgment, not a bank record. Confirm the ones that are right; flag any to revisit.",
  forecast: "Scheduled or expected entries dated ahead — projections of what's due, not money that has moved yet.",
  book: "Valuations and reclassifications (holdings marked to value, receivable/loan reclasses) — internal book entries, not bank/card statement lines.",
};
function Ledger({ entity }) {
  const [month, setMonth] = useState("");   // '' = all months
  const [text, setText] = useState("");
  const [flows, setFlows] = useState(true); // default: real bank/card statement lines (internal transfers hidden)
  const [prov, setProv] = useState("all");  // all | statement | reconstructed
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const PAGE = 60;
  const reviewing = prov === "reconstructed";        // the review lane
  const useFlows = flows && prov === "all";           // flows only makes sense on the mixed view

  const load = useCallback(async (reset) => {
    const off = reset ? 0 : offset;
    const p = new URLSearchParams({ entity, all: "1", limit: String(PAGE), offset: String(off) });
    if (month) p.set("month", month);
    if (text.trim()) p.set("text", text.trim());
    if (useFlows) p.set("flows", "1");
    if (prov !== "all") p.set("prov", prov);
    const j = await (await fetch(`/api/txns?${p}`)).json();
    setTotal(j.total || 0);
    setRows((prev) => (reset || !prev) ? (j.txns || []) : [...prev, ...(j.txns || [])]);
    setOffset(off + (j.txns?.length || 0));
  }, [entity, month, text, useFlows, prov, offset]);

  // reload from top whenever a filter changes
  useEffect(() => { setRows(null); setOffset(0); load(true); /* eslint-disable-next-line */ }, [entity, month, text, useFlows, prov]);

  const review = async (id, action) => {
    setBusy(true);
    try {
      await fetch("/api/game/card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, action, txnId: id }) });
      setRows((rs) => rs.map((r) => r.id === id ? { ...r, status: action === "accept" ? "ok" : "review" } : r));
    } finally { setBusy(false); }
  };

  const MONTHS = monthOptions();
  const VIEWS = [["all", "All"], ["statement", "Statement"], ["forecast", "Forecast"], ["reconstructed", "Reconstructed"], ["book", "Book"]];
  return (
    <div className={s.ledger}>
      <div className={s.provSeg}>
        {VIEWS.map(([id, label]) => (
          <button key={id} className={prov === id ? s.provOn : s.provBtn} onClick={() => setProv(id)}>{label}</button>
        ))}
      </div>
      {PROV_NOTE[prov] && <div className={s.reviewNote}>{PROV_NOTE[prov]}</div>}
      <div className={s.ledgerBar}>
        <input className={s.ledgerSearch} placeholder="Search description…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className={s.ledgerMonth} value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">All months</option>
          {MONTHS.map((m) => <option key={m} value={m}>{monLong(m)}</option>)}
        </select>
        {prov === "all" && <label className={s.ledgerToggle}><input type="checkbox" checked={flows} onChange={(e) => setFlows(e.target.checked)} /> Hide internal transfers</label>}
        <span className={s.ledgerCount}>{total.toLocaleString("en-IN")} lines</span>
      </div>
      {!rows ? <div className={s.loading}>Loading the statement…</div> : (
        <>
          <div className={s.ledgerList}>
            {rows.map((r) => {
              // The raw bank-statement line lives in narration; payee is often just the
              // bank/counterparty. Show the real description first, the counterparty as a tag.
              const narr = (r.narration || "").trim();
              const desc = narr || r.payee || "(no description)";
              const tag = narr && r.payee && r.payee.trim() ? r.payee.trim() : null;
              const pv = PROV[r.provenance] || PROV.statement;
              const reviewed = r.status === "ok" ? "confirmed" : r.status === "review" ? "flagged" : null;
              return (
                <div className={s.stRow} key={r.id}>
                  <span className={s.stDate}>{r.date}</span>
                  <div className={s.stMid}>
                    <div className={s.stTitle}>
                      <span className={`${s.pv} ${s[pv.cls]}`} title={r.provenance === "reconstructed" ? "entered during cleanup" : r.hasDoc ? "from a statement, document attached" : "from a bank/card statement"}>{pv.label}{r.hasDoc ? " 📄" : ""}</span>
                      <b title={desc}>{desc}</b>
                    </div>
                    <span className={s.stSub}>
                      {tag && <span className={s.stTag}>{tag}</span>}
                      {leaf(r.account)}{r.statement ? ` · via ${r.statement}` : ""}{r.doc ? ` · 📄 ${docName(r.doc)}` : ""}
                    </span>
                  </div>
                  {reviewing ? (
                    <div className={s.stReview}>
                      {reviewed ? <span className={reviewed === "confirmed" ? s.rvOk : s.rvFlag}>{reviewed === "confirmed" ? "✓ confirmed" : "⚑ flagged"}</span> : null}
                      <button className={s.rvBtn} disabled={busy} title="confirm" onClick={() => review(r.id, "accept")}>✓</button>
                      <button className={s.rvBtnF} disabled={busy} title="flag to revisit" onClick={() => review(r.id, "review")}>⚑</button>
                    </div>
                  ) : (
                    <span className={`${s.stAmt} ${r.amount < 0 ? s.pos : ""}`}>{inr(Math.abs(r.amount))}</span>
                  )}
                </div>
              );
            })}
            {!rows.length && <div className={s.liE}>No lines match.</div>}
          </div>
          {rows.length < total && <button className={s.ledgerMore} onClick={() => load(false)}>Load more ({total - rows.length} left)</button>}
        </>
      )}
    </div>
  );
}
function monthOptions() {
  const out = [];
  for (let y = 2026, m = 8; !(y === 2025 && m === 3); ) { out.push(`${y}-${pad(m)}`); m--; if (m < 1) { m = 12; y--; } if (y < 2025) break; }
  return out;
}

/* ===================================================================== */
/* ==================  WORLD — Pack · Loot · Quests  =================== */
/* ===================================================================== */
function World({ entity }) {
  const [w, setW] = useState(null);
  const [counter, setCounter] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [pj, cj] = await Promise.all([
      fetch(`/api/game/pack?entity=${entity}`).then((r) => r.json()),
      fetch(`/api/game/counter?entity=${entity}`).then((r) => r.json()).catch(() => null),
    ]);
    setW(pj); setCounter(cj);
  }, [entity]);
  useEffect(() => { setW(null); setCounter(null); load(); }, [load]);

  const quest = useCallback(async (body) => {
    setBusy(true);
    try { const j = await (await fetch("/api/game/pack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, ...body }) })).json(); if (!j.error) await load(); }
    finally { setBusy(false); }
  }, [entity, load]);

  const collect = useCallback(async (company) => {
    setBusy(true);
    try { const j = await (await fetch("/api/game/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "claim", company }) })).json(); if (!j.error) await load(); }
    finally { setBusy(false); }
  }, [load]);

  if (!w) return <div className={s.loading}>Loading your world…</div>;
  if (w.error) return <div className={s.loading}>⚠ {w.error}</div>;
  const hasCounter = counter && !counter.error && counter.customers && counter.customers.length > 0;
  return (
    <div className={s.world}>
      {hasCounter && <TheCounter counter={counter} busy={busy} collect={collect} />}
      <ThePack pack={w.pack} />
      <div className={s.worldGrid}>
        <TheLoot loot={w.loot} />
        <TheQuests quests={w.quests} busy={busy} quest={quest} />
      </div>
    </div>
  );
}

// THE COUNTER — the payoff loop. Every customer you fronted for, the outstanding
// total, and the itemized reimbursement statement a sorted warehouse answers instantly.
function TheCounter({ counter, busy, collect }) {
  const [open, setOpen] = useState(null);
  return (
    <div className={s.counter}>
      <div className={s.counterHead}>
        <div><h3>The Counter</h3><span className={s.packSub}>reimbursements you can collect — the payoff for a sorted warehouse</span></div>
        <div className={s.counterTot}><b>{compact(counter.totalOwed)}</b><span>owed to you</span></div>
      </div>
      <div className={s.custGrid}>
        {counter.customers.map((c) => {
          const settled = c.outstanding <= 0;
          const isOpen = open === c.company;
          return (
            <div key={c.company || c.account} className={`${s.cust} ${settled ? s.custSettled : ""}`}>
              <div className={s.custTop}>
                <b>{c.company || "—"}</b>
                <span className={settled ? s.custZero : s.custOwed}>{settled ? "settled" : compact(c.outstanding)}</span>
              </div>
              <div className={s.custSub}>fronted {compact(c.fronted)} · came back {compact(c.reimbursed)} · {c.itemCount} items</div>
              <div className={s.custActions}>
                <button className={s.custBtn} onClick={() => setOpen(isOpen ? null : c.company)}>{isOpen ? "Hide statement" : "View statement"}</button>
                {!settled && <button className={s.custCollect} disabled={busy} onClick={() => collect(c.company)}>{busy ? "…" : "Collect →"}</button>}
              </div>
              {isOpen && (
                <div className={s.custItems}>
                  {c.items.length === 0 && <div className={s.custEmpty}>No open items — fully reconciled.</div>}
                  {c.items.map((it, i) => (
                    <div className={s.custItem} key={i}>
                      <span className={s.custDate}>{it.date}</span>
                      <span className={s.custDesc}>{it.desc}</span>
                      <b>{compact(it.amount)}</b>
                      {it.doc && <a href={it.doc} target="_blank" rel="noreferrer" className={s.custDoc}>doc</a>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThePack({ pack }) {
  const t = pack.totals;
  return (
    <div className={s.pack}>
      <div className={s.packHead}>
        <div><h3>The Pack</h3><span className={s.packSub}>capital in play — the leverage you chose to carry</span></div>
        <div className={s.packTot}>
          <div><b>{compact(t.inPlay)}</b><span>in play</span></div>
          <div><b>{compact(t.dragMonthly)}</b><span>drag / mo</span></div>
          <div><b>{t.defeated}</b><span>defeated</span></div>
        </div>
      </div>
      <div className={s.bosses}>
        {pack.bosses.map((b) => (
          <div key={b.name} className={`${s.boss} ${b.defeated ? s.bossDead : ""}`}>
            <div className={s.bossTop}>
              <b>{b.name}</b>
              {b.defeated ? <span className={s.bossKO}>DEFEATED</span> : <span className={s.bossOwed}>{compact(b.owed)}</span>}
            </div>
            <div className={s.hpTrack}><div className={s.hpFill} style={{ width: b.hpPct + "%" }} /></div>
            <div className={s.bossFoot}>
              {b.defeated ? <span className={s.bossZero}>cleared · was {compact(b.peak)}</span>
                : <><span>{b.paidPct}% down of {compact(b.peak)}</span>{b.dragMonthly > 0 && <span className={s.bossDrag}>−{compact(b.dragMonthly)}/mo drag</span>}</>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const evIcon = (k) => ({ investment: "◆", loan_emi: "▼", insurance: "⛨", chit_payout: "★", vesting: "✦", premium: "⛨", payday: "▲" }[k] || "•");
function TheLoot({ loot }) {
  return (
    <div className={s.card}>
      <h3>Loot &amp; dues <span className={s.hint}>next {loot.horizonDays} days · {compact(loot.total)} scheduled</span></h3>
      {loot.events.length === 0 && <div className={s.liE}>Nothing scheduled in the window.</div>}
      {loot.events.map((e, i) => (
        <div className={s.lootRow} key={i}>
          <span className={s.lootIcon} data-k={e.direction}>{evIcon(e.kind)}</span>
          <span className={s.lootName}>{e.name}<em>{e.date}</em></span>
          <b className={e.direction === "save" ? s.lootSave : s.lootPay}>{e.direction === "save" ? "" : "−"}{compact(e.amount)}</b>
        </div>
      ))}
    </div>
  );
}

function TheQuests({ quests, busy, quest }) {
  const [add, setAdd] = useState(false);
  const [title, setTitle] = useState("");
  const open = quests.filter((q) => q.status === "open");
  const done = quests.filter((q) => q.status === "done");
  return (
    <div className={s.card}>
      <h3>Quests <span className={s.hint}>{open.length} open · the only unexplained items</span></h3>
      {open.map((q) => (
        <div className={s.quest} key={q.id}>
          <div className={s.questMain}>
            <b>{q.title}</b>
            {q.reward && <span className={s.questReward}>{q.reward}</span>}
          </div>
          <div className={s.questRight}>
            {q.rewardInr ? <span className={s.questInr}>{compact(q.rewardInr)}</span> : null}
            <button className={s.questDone} disabled={busy} title="mark resolved" onClick={() => quest({ action: "quest_done", id: q.id })}>✓</button>
            <button className={s.questDrop} disabled={busy} title="drop" onClick={() => quest({ action: "quest_drop", id: q.id })}>✕</button>
          </div>
        </div>
      ))}
      {!open.length && <div className={s.liE}>No open quests — the book is fully explained. 🎉</div>}
      {add ? (
        <div className={s.questAdd}>
          <input placeholder="New open item…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && (quest({ action: "quest_add", title: title.trim() }), setTitle(""), setAdd(false))} />
          <button className={s.ok} disabled={busy || !title.trim()} onClick={() => { quest({ action: "quest_add", title: title.trim() }); setTitle(""); setAdd(false); }}>Add</button>
        </div>
      ) : <button className={s.addV} onClick={() => setAdd(true)}>+ Park an item</button>}
      {done.length > 0 && <div className={s.questDoneList}>{done.length} resolved · {done.slice(0, 3).map((q) => q.title.split("(")[0].slice(0, 22)).join(" · ")}{done.length > 3 ? "…" : ""}</div>}
    </div>
  );
}

/* ===================================================================== */
/* ======================  PLAY — the cleanup game  ==================== */
/* ===================================================================== */
function Play({ entity }) {
  const nowFy = 2026; // current FY (Apr'26–Mar'27); season strip lets you walk back
  const [fy, setFy] = useState(nowFy);
  const [season, setSeason] = useState(null);
  const [month, setMonth] = useState(null);

  const loadSeason = useCallback(async (year) => {
    const j = await (await fetch(`/api/game/season?entity=${entity}&fy=${year}`)).json();
    setSeason(j);
    // default the open month to the latest month in this FY that has data
    const withData = (j.months || []).filter((m) => m.hasData);
    setMonth((cur) => (cur && j.months.some((m) => m.month === cur)) ? cur : (withData.length ? withData[withData.length - 1].month : j.months[0].month));
  }, [entity]);
  useEffect(() => { loadSeason(fy); }, [fy, loadSeason]);

  if (!season) return <div className={s.loading}>Loading your season…</div>;

  return (
    <div className={s.play}>
      <SeasonStrip season={season} fy={fy} setFy={setFy} month={month} setMonth={setMonth} />
      {month && <MonthBoard entity={entity} month={month} onChanged={() => loadSeason(fy)} />}
    </div>
  );
}

/* ---------- the season: 12 months you navigate (yearly view) ---------- */
function SeasonStrip({ season, fy, setFy, month, setMonth }) {
  const locked = season.months.filter((m) => m.locked).length;
  const played = season.months.filter((m) => m.hasData).length;
  const sc = season.scorecard;
  return (
    <div className={s.season} data-tour="season">
      <div className={s.seasonHead}>
        <button className={s.fyStep} onClick={() => setFy(fy - 1)} aria-label="previous year">‹</button>
        <div className={s.fyLabel}>
          <b>FY {String(fy).slice(2)}–{String(fy + 1).slice(2)}</b>
          <small>{locked}/{played} months sealed</small>
        </div>
        <button className={s.fyStep} onClick={() => setFy(fy + 1)} aria-label="next year">›</button>
      </div>
      {sc && (sc.sealed > 0 || sc.bestStreak > 0) && (
        <div className={s.scorecard}>
          <div className={s.scCell}><b>{sc.sealed}</b><span>sealed</span></div>
          <div className={s.scCell}><b>{sc.avgCoverage != null ? sc.avgCoverage + "%" : "—"}</b><span>avg match</span></div>
          <div className={s.scCell}><b>{sc.exceptionsHandled}</b><span>calls made</span></div>
          <div className={s.scCell}><b>🔥 {sc.currentStreak}</b><span>streak · best {sc.bestStreak}</span></div>
        </div>
      )}
      <div className={s.monthRow}>
        {season.months.map((m) => {
          const state = !m.hasData ? "empty" : m.locked ? "locked" : m.hasPlan ? "open" : "nodata";
          return (
            <button key={m.month}
              className={`${s.mTile} ${s["mt_" + state]} ${m.month === month ? s.mTileOn : ""}`}
              disabled={!m.hasData} onClick={() => setMonth(m.month)}>
              <span className={s.mtName}>{MON[Number(m.month.split("-")[1]) - 1]}</span>
              {m.locked ? <span className={s.mtSeal}>✓</span>
                : m.hasData ? <span className={s.mtDot} /> : <span className={s.mtNil}>·</span>}
              {m.locked && m.lockedExceptions != null && <span className={s.mtEx}>{m.lockedExceptions}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- the board for one month: PLAN → REALITY → LOCK ---------- */
function MonthBoard({ entity, month, onChanged }) {
  const [board, setBoard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expand, setExpand] = useState(false);
  const [payoff, setPayoff] = useState(null);
  const [showDeferred, setShowDeferred] = useState(false);

  const load = useCallback(async () => {
    const j = await (await fetch(`/api/game/month?entity=${entity}&month=${month}`)).json();
    setBoard(j);
  }, [entity, month]);
  useEffect(() => { setBoard(null); setExpand(false); setShowDeferred(false); load(); }, [load]);

  const card = useCallback(async (body) => {
    setBusy(true);
    try {
      const j = await (await fetch("/api/game/card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, month, ...body }) })).json();
      if (!j.error) await load();
      return j;
    } finally { setBusy(false); }
  }, [entity, month, load]);

  const lock = useCallback(async () => {
    setBusy(true);
    try {
      const j = await (await fetch("/api/game/lock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, month }) })).json();
      if (!j.error) { setPayoff(j); await load(); onChanged?.(); }
    } finally { setBusy(false); }
  }, [entity, month, load, onChanged]);

  if (!board) return <div className={s.loading}>Dealing {monLong(month)}…</div>;
  if (board.error) return <div className={s.loading}>⚠ {board.error}</div>;

  const cleared = board.exceptions === 0;
  const misses = board.cards.filter((c) => c.kind === "miss");
  const surprises = board.cards.filter((c) => c.kind === "surprise");

  return (
    <div className={s.board}>
      <BoardHead board={board} onLock={lock} busy={busy} />

      <NextHint board={board} onLock={lock} busy={busy} />

      {/* the warehouse — shelves stacked into floor-plan zones (your cashflow model) */}
      <Warehouse entity={entity} month={month} />

      {/* the auto-matched reel — collapsed by default (never the raw pile) */}
      <button className={s.autoBar} onClick={() => setExpand((x) => !x)}>
        <span className={s.autoTick}>✓</span>
        <span><b>{board.totals.autoMatched + board.totals.manualMatched}</b> of {board.totals.planLines} planned lines matched to reality
          {board.totals.absorbed ? <em> · {board.totals.absorbed} small items absorbed</em> : null}</span>
        <span className={s.autoChevron}>{expand ? "▾" : "▸"}</span>
      </button>
      {expand && <MatchedReel entity={entity} month={month} />}

      {/* the exceptions — the only thing you actually touch */}
      {cleared ? (
        <div className={s.allClear}>
          <div className={s.allClearMark}>✓</div>
          <b>Nothing needs you.</b>
          <span>{monLong(month)} reconciled to {board.coverage.plan}% of plan. {board.locked ? "Sealed." : "Lock it to bank the streak."}</span>
        </div>
      ) : (
        <div className={s.cards} data-tour="cards">
          {board.cards.map((c) => c.kind === "miss"
            ? <MissCard key={c.planLineId} c={c} surprises={surprises} busy={busy} card={card} />
            : <SurpriseCard key={c.txnId} c={c} misses={misses} cats={board.categories} busy={busy} card={card} />)}
        </div>
      )}

      {/* deferred — the review-later stack */}
      {board.deferred.length > 0 && (
        <div className={s.deferred}>
          <button className={s.defHead} onClick={() => setShowDeferred((x) => !x)}>
            ⏳ {board.deferred.length} parked for review {showDeferred ? "▾" : "▸"}
          </button>
          {showDeferred && board.deferred.map((c) => (
            <SurpriseCard key={c.txnId} c={c} misses={misses} cats={board.categories} busy={busy} card={card} parked />
          ))}
        </div>
      )}

      {payoff && <LockSeal payoff={payoff} month={month} onClose={() => setPayoff(null)} />}
    </div>
  );
}

/* THE WAREHOUSE — shelves (categories/counterparties) stacked into floor-plan
   zones (your fixed/variable × in/out aisles). Tap a shelf to open its crates.
   This replaces the quadrant bars: same cashflow read, but you can see inside. */
// turn a typed shelf name into an account under the same family as the source.
function shelfToAccount(input, fromAccount) {
  const s2 = input.trim(); if (!s2) return "";
  if (s2.includes(":")) return s2;
  const cap = s2.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, "");
  const prefix = fromAccount.startsWith("Assets:Receivable") ? "Assets:Receivable"
    : fromAccount.startsWith("Assets:Investments") ? "Assets:Investments"
    : fromAccount.split(":")[0];
  return `${prefix}:${cap}`;
}
function Warehouse({ entity, month }) {
  const [w, setW] = useState(null);
  const [open, setOpen] = useState(null);
  const [crates, setCrates] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadW = useCallback(() => fetch(`/api/game/warehouse?entity=${entity}&month=${month}`).then((r) => r.json()).then(setW), [entity, month]);
  useEffect(() => { setW(null); setOpen(null); loadW(); }, [entity, month, loadW]);

  const loadCrates = useCallback(async (account) => {
    setCrates(null);
    const [y, m] = month.split("-").map(Number); const last = new Date(y, m, 0).getDate();
    const j = await (await fetch(`/api/txns?entity=${entity}&account=${encodeURIComponent(account)}&from=${month}-01&to=${month}-${String(last).padStart(2, "0")}&withcorr=1&limit=60`)).json();
    setCrates(j.txns || []);
  }, [entity, month]);

  const drill = (account) => { if (open === account) { setOpen(null); return; } setOpen(account); loadCrates(account); };

  const reload = async () => { await loadW(); if (open) await loadCrates(open); };
  const post = async (body) => { setBusy(true); try { const j = await (await fetch("/api/game/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, ...body }) })).json(); if (!j.error) await reload(); return j; } finally { setBusy(false); } };
  // move a crate to another shelf — a reclassification (append-only correction).
  const move = (txnId, fromAccount, toAccount, makeRule) => (toAccount && toAccount !== fromAccount) && post({ action: "reclassify", txnId, fromAccount, toAccount, makeRule });
  // bulk-move many crates to one shelf; split one crate across two shelves.
  const bulkMove = (items, toAccount, makeRule) => toAccount && post({ action: "bulk", items, toAccount, makeRule });
  const splitCrate = (txnId, fromAccount, toAccount, amount) => (toAccount && amount > 0) && post({ action: "split", txnId, fromAccount, toAccount, amount });
  // move a whole shelf between the Fixed and Variable aisle.
  const setZone = async (account, fixed) => { setBusy(true); try { const j = await (await fetch("/api/game/zone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, account, fixed }) })).json(); if (!j.error) await loadW(); } finally { setBusy(false); } };

  if (!w) return <div className={s.whLoading} data-tour="quads">Opening the warehouse…</div>;
  if (w.error) return <div className={s.whLoading} data-tour="quads">⚠ {w.error}</div>;

  const inA = w.zones.filter((z) => z.dir === "in").reduce((a, z) => a + z.actual, 0);
  const outA = w.zones.filter((z) => z.dir === "out").reduce((a, z) => a + z.actual, 0);
  const inP = w.zones.filter((z) => z.dir === "in").reduce((a, z) => a + z.planned, 0);
  const outP = w.zones.filter((z) => z.dir === "out").reduce((a, z) => a + z.planned, 0);
  // every shelf across the room = the move targets.
  // Move targets come from the CHART, not from this month's shelves. Deriving them
  // from w.zones meant you could only move a crate somewhere that already had a
  // crate that month — so a first-time destination, which is exactly what a new
  // receivable is, could never be chosen. w.accounts is the full eligible chart;
  // the month's shelves are merged in so their ₹ still shows on the option.
  const shelfByAcct = new Map([...w.zones, ...w.side].flatMap((z) => z.shelves).map((sh) => [sh.account, sh]));
  const eligible = (a) => a.startsWith("Income") || a.startsWith("Expenses")
    || a.startsWith("Assets:Receivable") || a.startsWith("Assets:Investments") || a.startsWith("Assets:Transfers");
  const targets = [...new Set([...(w.accounts || []), ...shelfByAcct.keys()])].filter(eligible).sort()
    .map((account) => shelfByAcct.get(account) || { account, name: account.split(":").slice(1).join(" · ") });

  const Zone = (z, side) => (
    <div className={`${s.whzone} ${side ? s.whsideZone : (z.dir === "in" ? s.whin : s.whout)}`} key={z.key}>
      <div className={s.whzhead}>
        <span className={s.whzlabel}>{z.label}</span>
        <span className={s.whzsum}>{!side && z.planned ? <><span className={s.whzplan}>{compact(z.planned)} →</span> </> : null}<b>{compact(z.actual)}</b></span>
      </div>
      <div className={s.whshelves}>
        {z.shelves.map((sh) => (
          <button key={sh.account} className={`${s.whshelf} ${open === sh.account ? s.whshelfOn : ""}`} onClick={() => drill(sh.account)}>
            <span className={s.whsname}>{sh.name}</span>
            <span className={s.whsamt}>{compact(sh.amount)}{sh.count != null && <i> ·{sh.count}</i>}</span>
          </button>
        ))}
        {!z.shelves.length && <span className={s.whEmpty}>empty — nothing landed here</span>}
      </div>
      {z.shelves.some((sh) => sh.account === open) && (() => { const os = z.shelves.find((sh) => sh.account === open); return (
        <Crates crates={crates} fromAccount={open} shelfAmount={os?.amount} shelfDir={side ? null : z.dir} shelfFixed={os?.fixed}
          targets={targets} onMove={move} onBulk={bulkMove} onSplit={splitCrate} onZone={setZone} busy={busy} />
      ); })()}
    </div>
  );

  return (
    <div className={s.wh} data-tour="quads">
      <div className={s.whaisle}>◤ Inbound · money in</div>
      <div className={s.whrow}>{w.zones.filter((z) => z.dir === "in").map((z) => Zone(z))}</div>
      <div className={s.whaisle}>◣ Outbound · money out</div>
      <div className={s.whrow}>{w.zones.filter((z) => z.dir === "out").map((z) => Zone(z))}</div>
      <div className={s.whnet}>
        <span>Net this month</span>
        <span className={s.whnetNums}><span className={s.whzplan}>plan {compact(inP - outP)} →</span> <b className={inA - outA >= 0 ? s.pos : s.neg}>{compact(inA - outA)}</b></span>
      </div>
      <div className={s.whaisle}>◈ Off-cashflow zones</div>
      <div className={s.whsideRow}>{w.side.map((z) => Zone(z, true))}</div>
    </div>
  );
}
// Book plumbing markers — corrections, reversals, sweeps, pass-throughs. These
// entries cancel real postings; we net them out so the drill shows only the crates
// that actually make up the shelf total.
const PLUMB = /correction|reversal|sweep|pass-through|reclassif|recovered|catch-up|missed statement/i;
// bounded subset-sum: a subset of `pool` summing to `target` (± ₹1), or null.
function subsetSum(pool, target, maxLen) {
  const res = [];
  const dfs = (start, rem, depth) => {
    if (Math.abs(rem) < 1) return true;
    if (depth >= maxLen || start >= pool.length) return false;
    for (let i = start; i < pool.length; i++) { res.push(pool[i]); if (dfs(i + 1, rem - pool[i].a, depth + 1)) return true; res.pop(); }
    return false;
  };
  return dfs(0, target, 0) ? [...res] : null;
}
// Net out cancelling entries so only the REAL crates remain:
//   1) exact opposite-sign pairs (a correction vs its original),
//   2) one-to-many — a plumbing entry (sweep/correction) vs the SET of entries it offsets.
function netOut(crates) {
  const it = crates.map((c) => ({ a: Math.round(Number(c.amount)), plumb: PLUMB.test((c.narration || "") + " " + (c.payee || "")) }));
  const used = new Set();
  for (let i = 0; i < it.length; i++) {
    if (used.has(i)) continue; const a = it[i].a; if (a === 0) { used.add(i); continue; }
    for (let j = i + 1; j < it.length; j++) {
      if (used.has(j)) continue;
      if (Math.sign(a) !== Math.sign(it[j].a) && Math.abs(Math.abs(a) - Math.abs(it[j].a)) < 1) { used.add(i); used.add(j); break; }
    }
  }
  for (let i = 0; i < it.length; i++) {
    if (used.has(i) || !it[i].plumb || it[i].a === 0) continue;
    const target = -it[i].a;
    const pool = it.map((x, j) => ({ j, a: x.a })).filter((x) => !used.has(x.j) && x.j !== i && Math.sign(x.a) === Math.sign(target));
    const sub = subsetSum(pool, target, 5);
    if (sub) { used.add(i); sub.forEach((sx) => used.add(sx.j)); }
  }
  return crates.filter((_, i) => !used.has(i));
}
const VERBS = (acc) => acc.startsWith("Income") ? ["received", "reversed"]
  : acc.startsWith("Assets:Receivable") ? ["fronted", "reimbursed"]
  : acc.startsWith("Assets:Investments") ? ["put in", "took out"]
  : ["spent", "came back"];
function Crates({ crates, fromAccount, shelfAmount, shelfDir, shelfFixed, targets, onMove, onBulk, onSplit, onZone, busy }) {
  const [moving, setMoving] = useState(null);   // txnId with the per-crate action row open
  const [pick, setPick] = useState("");
  const [custom, setCustom] = useState("");
  const [rule, setRule] = useState(true);
  const [splitAmt, setSplitAmt] = useState("");
  const [showPlumbing, setShowPlumbing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [bulkTo, setBulkTo] = useState("");
  if (!crates) return <div className={s.whCratesLoad}>opening…</div>;
  if (!crates.length) return <div className={s.whCratesLoad}>no crates on this shelf</div>;
  const real = netOut(crates);
  const plumbing = crates.length - real.length;
  const list = showPlumbing ? crates : real;
  const primarySign = fromAccount.startsWith("Income") ? -1 : 1;
  const [primaryVerb, backVerb] = VERBS(fromAccount);
  const gross = real.filter((c) => Math.sign(Number(c.amount)) === primarySign).reduce((a, c) => a + Math.abs(Number(c.amount)), 0);
  const back = real.filter((c) => Math.sign(Number(c.amount)) === -primarySign).reduce((a, c) => a + Math.abs(Number(c.amount)), 0);
  const net = shelfAmount != null ? shelfAmount : Math.abs(gross - back);
  const opts = targets.filter((t) => t.account !== fromAccount);
  const LIMIT = showAll ? 999 : 18;
  const target = () => custom.trim() ? shelfToAccount(custom, fromAccount) : pick;
  const doMove = (id) => { onMove(id, fromAccount, target(), rule); setMoving(null); setCustom(""); setPick(""); };
  const doSplit = (id) => { onSplit(id, fromAccount, target(), Number(splitAmt)); setMoving(null); setCustom(""); setPick(""); setSplitAmt(""); };
  const toggleSel = (id) => setSel((s2) => { const n = new Set(s2); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const doBulk = () => { onBulk([...sel].map((id) => ({ txnId: id, fromAccount })), bulkTo, rule); setSel(new Set()); setBulkTo(""); };
  return (
    <div className={s.whCrates}>
      {shelfDir && (
        <div className={s.aisleRow}>
          <span>This shelf is <b>{shelfFixed ? "Fixed" : "Variable"} · {shelfDir === "in" ? "In" : "Out"}</b></span>
          <button className={s.aisleBtn} disabled={busy} onClick={() => onZone(fromAccount, !shelfFixed)}>→ move to {shelfFixed ? "Variable" : "Fixed"} aisle</button>
        </div>
      )}
      <div className={s.whCratesHint}>Select crates to bulk-move, or tap <b>⇄</b> to move / split one — it teaches a rule for next time.
        {plumbing > 0 && <button className={s.plumbBtn} onClick={() => setShowPlumbing((x) => !x)}>{showPlumbing ? "hide" : "show"} {plumbing} netted-out {plumbing === 1 ? "entry" : "entries"}</button>}
      </div>
      {sel.size > 0 && (
        <div className={s.bulkBar}>
          <span className={s.bulkN}>{sel.size} selected</span>
          <select className={s.moveSel} value={bulkTo} onChange={(e) => setBulkTo(e.target.value)}><option value="">move all to…</option>{opts.map((t) => <option key={t.account} value={t.account}>{t.name}</option>)}</select>
          <label className={s.moveRule}><input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} /> rule</label>
          <button className={s.moveGo} disabled={busy || !bulkTo} onClick={doBulk}>Move {sel.size} →</button>
          <button className={s.pickBack} onClick={() => setSel(new Set())}>clear</button>
        </div>
      )}
      {list.slice(0, LIMIT).map((c) => {
        const primary = Math.sign(Number(c.amount)) === primarySign;
        return (
          <div key={c.id}>
            <div className={`${s.crate} ${sel.has(c.id) ? s.crateSel : ""}`}>
              <input type="checkbox" className={s.crSel} checked={sel.has(c.id)} onChange={() => toggleSel(c.id)} />
              <span className={s.crDate}>{c.date}</span>
              <span className={s.crWho} title={c.narration || c.payee}>{c.narration || c.payee || "—"}</span>
              <span className={primary ? s.crAmt : s.crBack} title={primary ? primaryVerb : `${backVerb} — reduces this shelf`}>{primary ? "" : "↩ "}{inr(Math.abs(c.amount))}</span>
              <button className={s.crMove} disabled={busy} title="move or split" onClick={() => setMoving(moving === c.id ? null : c.id)}>⇄</button>
            </div>
            {moving === c.id && (
              <div className={s.moveRow}>
                <select className={s.moveSel} value={pick} onChange={(e) => { setPick(e.target.value); setCustom(""); }}>
                  <option value="">to shelf…</option>
                  {opts.map((t) => <option key={t.account} value={t.account}>{t.name}</option>)}
                </select>
                <input className={s.moveNew} placeholder="or new shelf…" value={custom} onChange={(e) => setCustom(e.target.value)} />
                <label className={s.moveRule}><input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} /> rule</label>
                <button className={s.moveGo} disabled={busy || (!pick && !custom.trim())} onClick={() => doMove(c.id)}>Move all</button>
                <span className={s.splitSep}>or</span>
                <input className={s.splitAmt} inputMode="numeric" placeholder="₹ split" value={splitAmt} onChange={(e) => setSplitAmt(e.target.value.replace(/[^\d]/g, ""))} />
                <button className={s.moveGo2} disabled={busy || !splitAmt || (!pick && !custom.trim())} onClick={() => doSplit(c.id)}>Split</button>
              </div>
            )}
          </div>
        );
      })}
      {list.length > LIMIT && <button className={s.crMoreBtn} onClick={() => setShowAll(true)}>show all {list.length} crates</button>}
      {!showPlumbing && (
        <div className={s.crNet}>
          {real.length} {real.length === 1 ? "crate" : "crates"} · <b>{inr(gross)}</b> {primaryVerb}
          {back > 0 && <> − <b className={s.pos}>{inr(back)}</b> {backVerb}</>} = net <b>{inr(net)}</b>
        </div>
      )}
    </div>
  );
}

/* the four quadrants — Fixed/Variable × In/Out (personal), Work kept apart.
   plan → reality, with the delta as the story. This IS the cashflow board. */
function Quadrants({ b }) {
  const Cell = (key, label, x, dir) => {
    const over = x.delta > 0, under = x.delta < 0;
    // inflow: over is good (green), short is red. outflow: over is caution (red), under is good (green).
    const tone = x.delta === 0 ? "flat" : dir === "in" ? (over ? "good" : "bad") : (over ? "bad" : "good");
    const fill = x.planned > 0 ? Math.min(100, Math.round((x.actual / x.planned) * 100)) : (x.actual > 0 ? 100 : 0);
    return (
      <div className={`${s.quad} ${s["q_" + key]}`} key={key}>
        <div className={s.quadLabel}>{label}</div>
        <div className={s.quadNums}><span className={s.quadPlan}>{compact(x.planned)}</span><span className={s.quadArrow}>→</span><b>{compact(x.actual)}</b></div>
        <div className={s.quadBar}><div className={s["fill_" + tone]} style={{ width: fill + "%" }} /></div>
        {x.delta !== 0 && <div className={`${s.quadDelta} ${s["d_" + tone]}`}>{over ? "+" : ""}{compact(x.delta)} {dir === "in" ? (over ? "more in" : "short") : (over ? "over" : "under")}</div>}
      </div>
    );
  };
  return (
    <div className={s.quads} data-tour="quads">
      <div className={s.quadsGrid}>
        {Cell("fixed_in", "Fixed inflow", b.fixed_in, "in")}
        {Cell("var_in", "Variable inflow", b.var_in, "in")}
        {Cell("fixed_out", "Fixed outflow", b.fixed_out, "out")}
        {Cell("var_out", "Variable outflow", b.var_out, "out")}
      </div>
      <div className={s.quadsFoot}>
        <div className={s.netBox}>
          <span>Net</span>
          <div className={s.netNums}><span className={s.quadPlan}>plan {compact(b.net.planned)}</span><b className={b.net.actual >= 0 ? s.pos : s.neg}>{compact(b.net.actual)}</b></div>
        </div>
        {b.work.actual > 0 && (
          <div className={s.workBox}>
            <span>Work · reimbursable <em>separate from your cashflow</em></span>
            <b>{compact(b.work.actual)}</b>
          </div>
        )}
      </div>
    </div>
  );
}

/* the header: coverage dial · N-need-you · streak · LOCK */
function BoardHead({ board, onLock, busy }) {
  const pct = board.coverage.plan;
  const R = 30, C = 2 * Math.PI * R, off = C * (1 - pct / 100);
  const canLock = board.exceptions === 0 && !board.locked;
  return (
    <div className={s.head} data-tour="head">
      <div className={s.dial}>
        <svg viewBox="0 0 72 72" className={s.dialSvg}>
          <circle cx="36" cy="36" r={R} className={s.dialTrack} />
          <circle cx="36" cy="36" r={R} className={s.dialFill} strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 36 36)" />
        </svg>
        <div className={s.dialPct}><b>{pct}</b><span>%</span></div>
      </div>
      <div className={s.headMid}>
        <div className={s.headMonth}>{monLong(board.month)}{board.locked && <span className={s.sealed}>SEALED</span>}</div>
        <div className={s.needYou}>
          {board.exceptions === 0
            ? <span className={s.needClear}>All matched — nothing needs you</span>
            : <><b>{board.exceptions}</b> need you</>}
        </div>
        <div className={s.headSub}>plan {board.coverage.plan}% · value handled {board.coverage.handled}%</div>
      </div>
      <div className={s.headRight}>
        {board.streak > 0 && <div className={s.streak}>🔥 {board.streak}<small>streak</small></div>}
        <button className={`${s.lockBtn} ${canLock ? s.lockReady : ""}`} data-tour="lock" disabled={busy || board.locked} onClick={onLock}>
          {board.locked ? "Sealed ✓" : board.exceptions === 0 ? "Lock month" : `Lock (${board.exceptions} open)`}
        </button>
      </div>
    </div>
  );
}

/* NEXT HINT — a persistent nudge that always names the single best next move,
   so you (or anyone new) are never wondering what to do. */
function NextHint({ board, onLock, busy }) {
  const scrollCards = () => { const el = document.querySelector('[data-tour="cards"]'); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
  if (board.exceptions > 0) {
    return (
      <button className={s.nextHint} onClick={scrollCards}>
        <span className={s.nextDot} />
        <span>Next: <b>{board.exceptions}</b> {board.exceptions === 1 ? "call needs" : "calls need"} you — decide where each belongs</span>
        <span className={s.nextGo}>Go ↓</span>
      </button>
    );
  }
  if (!board.locked) {
    return (
      <button className={`${s.nextHint} ${s.nextHintGo}`} disabled={busy} onClick={onLock}>
        <span className={s.nextDot} />
        <span>Next: everything's matched — <b>seal {monLong(board.month)}</b> to bank your streak</span>
        <span className={s.nextGo}>Lock →</span>
      </button>
    );
  }
  return (
    <div className={`${s.nextHint} ${s.nextHintDone}`}>
      <span className={s.nextDot} />
      <span>Sealed 🔥 streak {board.streak}. Next: pick another month up top, or drop in a new statement.</span>
    </div>
  );
}

/* a planned line that never landed — the player rules on it */
function MissCard({ c, surprises, busy, card }) {
  const [mode, setMode] = useState(null); // null | 'match' | 'edit'
  const sameDir = (surprises || []).filter((sp) => c.dir === "in" ? sp.flow === "income" : sp.flow === "expense");
  const [pick, setPick] = useState(sameDir[0]?.txnId || "");
  const [amt, setAmt] = useState(String(c.planned));
  return (
    <div className={`${s.exc} ${s.excMiss}`}>
      <div className={s.excLeft}>
        <span className={`${s.chip} ${s["b_" + c.bucket]}`}>{bucketLabel(c.bucket)}</span>
        <div className={s.excMain}>
          <b>{c.label}</b>
          <span className={s.excMeta}>planned {inr(c.planned)}{c.hint ? ` · ${c.hint}` : ""} — no matching {c.dir === "in" ? "receipt" : "payment"} found</span>
        </div>
      </div>
      {!mode ? (
        <div className={s.excActs}>
          {sameDir.length > 0 && <button className={s.actPrimary} disabled={busy} title="it did happen — tie it to the real transaction" onClick={() => setMode("match")}>It happened →</button>}
          <button className={s.actGhost} disabled={busy} title="push it to next month" onClick={() => card({ action: "carry", planLineId: c.planLineId })}>Carry →</button>
          <button className={s.actGhost} disabled={busy} title="fix the planned amount" onClick={() => setMode("edit")}>Edit</button>
          <button className={s.actGhost} disabled={busy} title="it's not coming — drop it" onClick={() => card({ action: "skip", planLineId: c.planLineId })}>Didn't happen</button>
        </div>
      ) : mode === "match" ? (
        <div className={s.linkPick}>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {sameDir.map((sp) => <option key={sp.txnId} value={sp.txnId}>{(sp.payee || sp.narration || "—").slice(0, 34)} · {inr(sp.amount)}</option>)}
          </select>
          <button className={s.actPrimary} disabled={busy || !pick} onClick={() => card({ action: "link", planLineId: c.planLineId, txnId: pick })}>Match ✓</button>
          <button className={s.pickBack} onClick={() => setMode(null)}>✕</button>
        </div>
      ) : (
        <div className={s.moveRow}>
          <span className={s.splitSep}>planned ₹</span>
          <input className={s.splitAmt} inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d]/g, ""))} />
          <button className={s.moveGo} disabled={busy || !amt} onClick={() => { card({ action: "editplan", planLineId: c.planLineId, amount: Number(amt) }); setMode(null); }}>Save</button>
          <button className={s.pickBack} onClick={() => setMode(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

/* an unplanned real transaction ≥₹10k — the case file + one-tap calls */
const WORK_SHELVES = [
  { account: "Assets:Receivable:Flyy", name: "Work · Flyy" },
  { account: "Assets:Receivable:Aikaara", name: "Work · Aikaara" },
  { account: "Assets:Receivable:Arthsutra", name: "Work · Arthsutra" },
];
function SurpriseCard({ c, misses, cats, busy, card, parked }) {
  const [mode, setMode] = useState(null); // null | 'shelf' | 'link'
  const [pick, setPick] = useState(misses[0]?.planLineId || "");
  const [to, setTo] = useState("");
  const [custom, setCustom] = useState("");
  const [rule, setRule] = useState(true);
  const [splitAmt, setSplitAmt] = useState("");
  const isIncome = c.flow === "income";
  const bucket = isIncome ? "var_in" : "var_out";
  const label = (c.payee || c.narration || "Unplanned").slice(0, 40);
  const from = c.account || (isIncome ? "Income:Other" : "Expenses:Other");
  const shelfOpts = [...cats.map((a) => ({ account: a, name: leaf(a) })), ...WORK_SHELVES].filter((o) => o.account !== from);
  const target = () => custom.trim() ? shelfToAccount(custom, from) : to;
  const doShelf = () => {
    const t = target();
    if (!t || t === from) return;
    card({ action: "recat", txnId: c.txnId, fromAccount: from, toAccount: t, makeRule: rule });
    setMode(null); setTo(""); setCustom("");
  };
  const doSplit = () => {
    const t = target();
    if (!t || t === from || !(Number(splitAmt) > 0)) return;
    card({ action: "split", txnId: c.txnId, fromAccount: from, toAccount: t, amount: Number(splitAmt) });
    setMode(null); setTo(""); setCustom(""); setSplitAmt("");
  };

  return (
    <div className={`${s.exc} ${s.excSurprise} ${parked ? s.excParked : ""}`}>
      <div className={s.excLeft}>
        <span className={`${s.chip} ${isIncome ? s.b_var_in : s.b_var_out}`}>{isIncome ? "unexpected in" : "unexpected out"}</span>
        <div className={s.excMain}>
          <b>{c.payee || c.narration || "(no description)"}</b>
          <span className={s.excMeta}>
            {c.date} · <b className={s.amt}>{inr(c.amount)}</b>
            {c.statement ? ` · via ${leaf(c.statement)}` : ""}
            {c.account ? ` · now on ${leaf(c.account)}` : ""}
          </span>
          {c.narration && c.payee && <span className={s.excNarr}>{c.narration}</span>}
          {c.doc && <span className={s.excDoc}>📄 {docName(c.doc)}</span>}
        </div>
      </div>

      {!mode ? (
        <div className={s.excActs}>
          <button className={s.actPrimary} disabled={busy} title="move it to the shelf where it belongs" onClick={() => setMode("shelf")}>Put on a shelf →</button>
          {misses.length > 0 && <button className={s.actGhost} disabled={busy} title="you'd planned for this — tick it off" onClick={() => setMode("link")}>Was expected</button>}
          <button className={s.actGhost} disabled={busy} title="add this as a planned line for the month" onClick={() => card({ action: "newline", bucket, label, amount: c.amount, txnId: c.txnId })}>Add to plan</button>
          <button className={s.actGhost} disabled={busy} title="it's fine where it is — leave it" onClick={() => card({ action: "accept", txnId: c.txnId })}>Looks right</button>
          {!parked && <button className={s.actGhost} disabled={busy} title="park it, decide later" onClick={() => card({ action: "review", txnId: c.txnId })}>Later</button>}
        </div>
      ) : mode === "shelf" ? (
        <div className={s.moveRow}>
          <select className={s.moveSel} value={to} onChange={(e) => { setTo(e.target.value); setCustom(""); }}>
            <option value="">put on shelf…</option>
            {shelfOpts.map((o) => <option key={o.account} value={o.account}>{o.name}</option>)}
          </select>
          <input className={s.moveNew} placeholder="or new shelf…" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <label className={s.moveRule}><input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} /> rule</label>
          <button className={s.moveGo} disabled={busy || (!to && !custom.trim())} onClick={doShelf}>Put all</button>
          <span className={s.splitSep}>or</span>
          <input className={s.splitAmt} inputMode="numeric" placeholder="₹ split" value={splitAmt} onChange={(e) => setSplitAmt(e.target.value.replace(/[^\d]/g, ""))} />
          <button className={s.moveGo2} disabled={busy || !splitAmt || (!to && !custom.trim())} onClick={doSplit}>Split</button>
          <button className={s.pickBack} onClick={() => setMode(null)}>✕</button>
        </div>
      ) : mode === "link" ? (
        <div className={s.linkPick}>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {misses.map((m) => <option key={m.planLineId} value={m.planLineId}>{m.label} · {inr(m.planned)}</option>)}
          </select>
          <button className={s.actPrimary} disabled={busy || !pick} onClick={() => card({ action: "link", planLineId: pick, txnId: c.txnId })}>Match ✓</button>
          <button className={s.pickBack} onClick={() => setMode(null)}>✕</button>
        </div>
      ) : null}
    </div>
  );
}

/* the auto-matched lines, revealed on demand (proof the game did the work) */
function MatchedReel({ entity, month }) {
  // The board already knows the counts; the detail here is a lightweight fetch of
  // the plan lines that matched, straight from the same endpoint's matched set.
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/game/month?entity=${entity}&month=${month}`).then((r) => r.json()).then((j) => {
      if (!live) return;
      // matched aren't returned on the board payload (kept lean); show the absorbed/total tallies instead.
      setRows(j);
    });
    return () => { live = false; };
  }, [entity, month]);
  if (!rows) return <div className={s.reelLoad}>…</div>;
  return (
    <div className={s.reel}>
      <div className={s.reelNote}>
        The matcher ticked <b>{rows.totals.autoMatched}</b> planned lines automatically and folded
        <b> {rows.totals.absorbed}</b> small everyday items into the variable bucket — so you only see the {rows.exceptions} that genuinely need a call.
      </div>
    </div>
  );
}

/* the payoff — a stamp/seal moment when a month locks */
function LockSeal({ payoff, month, onClose }) {
  return (
    <div className={s.sealOverlay} onClick={onClose}>
      <div className={s.sealCard} onClick={(e) => e.stopPropagation()}>
        <div className={s.sealStamp}>SEALED</div>
        <div className={s.sealMonth}>{monLong(month)}</div>
        <div className={s.sealStats}>
          <div><b>{payoff.coverage?.plan ?? "—"}%</b><span>of plan matched</span></div>
          <div><b>{payoff.exceptions ?? 0}</b><span>calls made</span></div>
          <div><b>🔥 {payoff.streak ?? 1}</b><span>month streak</span></div>
        </div>
        <button className={s.sealClose} onClick={onClose}>Onward →</button>
      </div>
    </div>
  );
}

const bucketLabel = (b) => ({ fixed_in: "fixed in", var_in: "variable in", fixed_out: "fixed", var_out: "variable", work: "work" }[b] || b);
const leaf = (a) => (a || "").split(":").slice(1).join(" · ");
const docName = (d) => { const b = d.split("/").pop(); return b.length > 26 ? b.slice(0, 26) + "…" : b; };

/* ===================================================================== */
/* =====================  STATUS — the themed meters  ================== */
/* ===================================================================== */
const lastDayISO = (y, m) => `${y}-${pad(m)}-${lastDay(y, m)}`;
function statusRange(kind, a) {
  if (kind === "month") { const [y, m] = a.split("-").map(Number); return { from: `${y}-${pad(m)}-01`, to: lastDayISO(y, m), label: new Date(y, m - 1).toLocaleString("en", { month: "long", year: "numeric" }) }; }
  if (kind === "quarter") { const [y, q] = a.split("Q").map(Number); const sm = (q - 1) * 3 + 1; return { from: `${y}-${pad(sm)}-01`, to: lastDayISO(y, sm + 2), label: `Q${q} ${y}` }; }
  const y = Number(a); return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${String(y).slice(2)}–${String(y + 1).slice(2)}` };
}
function stepAnchor(kind, a, d) {
  if (kind === "month") { let [y, m] = a.split("-").map(Number); m += d; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return `${y}-${pad(m)}`; }
  if (kind === "quarter") { let [y, q] = a.split("Q").map(Number); q += d; if (q > 4) { q = 1; y++; } if (q < 1) { q = 4; y--; } return `${y}Q${q}`; }
  return String(Number(a) + d);
}

function Status({ entity, theme }) {
  const [kind, setKind] = useState("month");
  const [anchor, setAnchor] = useState({ month: "2026-08", quarter: "2026Q3", year: "2025" });
  const range = useMemo(() => statusRange(kind, anchor[kind]), [kind, anchor]);
  const [data, setData] = useState(null);
  const [ventures, setVentures] = useState([]);
  const [altitude, setAltitude] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/game?entity=${entity}&from=${range.from}&to=${range.to}`);
    const j = await r.json();
    if (j.error) { setToast(j.error); return; }
    setData(j);
    const [v, a] = await Promise.all([
      (await fetch(`/api/ventures?entity=${entity}`)).json(),
      (await fetch(`/api/game/altitude?entity=${entity}&from=${range.from}&to=${range.to}`)).json(),
    ]);
    setVentures(v.ventures || []);
    setAltitude(a.error ? null : a);
  }, [entity, range.from, range.to]);
  useEffect(() => { setData(null); load(); }, [load]);

  const act = useCallback(async (url, body) => {
    setBusy(true);
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, ...body }) })).json();
      setToast(j.error ? `⚠ ${j.error}` : "✓ done");
      if (!j.error) await load();
    } finally { setBusy(false); setTimeout(() => setToast(""), 2600); }
  }, [entity, load]);
  const saveVenture = (b) => act("/api/ventures", b);
  const step = (d) => setAnchor((a) => ({ ...a, [kind]: stepAnchor(kind, a[kind], d) }));

  if (!data) return <div className={s.loading}>Loading your position…</div>;
  const st = data.state;
  const Hero = { climb: Climb, board: Board, machine: Machine, season: Season, quest: Quest }[theme];

  return (
    <div className={s.status}>
      <div className={s.periods}>
        <div className={s.seg}>
          {["year", "quarter", "month"].map((k) => (
            <button key={k} className={kind === k ? s.segOn : ""} onClick={() => setKind(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
          ))}
        </div>
        <div className={s.stepper}>
          <button onClick={() => step(-1)} aria-label="prev">‹</button>
          <span>{range.label}</span>
          <button onClick={() => step(1)} aria-label="next">›</button>
        </div>
      </div>
      {altitude && <Altitude a={altitude} />}
      <Hero st={st} range={range} />
      <MachineMap m={st.machine} />
      <div className={s.detail}>
        <div className={s.grid2}>
          <Statement st={st} />
          <Ventures ventures={ventures} busy={busy} save={saveVenture} />
        </div>
      </div>
      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  );
}

function meterData(st) {
  const f = st.meters.freedom, l = st.meters.leverage;
  return { freedomPct: f.pct, passive: f.passiveMonthly, life: f.expenseMonthly, deployed: l.deployed, cost: l.costMonthly, produces: l.producingMonthly, building: l.building, coversCost: l.coversCostPct, valuePer: l.valuePerRupeePct };
}

function Climb({ st }) {
  const d = meterData(st); const h = Math.max(4, Math.min(100, d.freedomPct));
  return (
    <div className={s.hero}>
      <div className={s.climbStage}>
        <div className={s.climbCol}><div className={s.climbFill} style={{ height: h + "%" }} /><div className={s.you} style={{ bottom: h + "%" }}>▲</div></div>
        <div className={s.climbCapTop}>Free · passive covers life</div><div className={s.climbCapBot}>Base camp</div>
      </div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{d.freedomPct}%<span className={s.bigsub}> to free</span></div>
        <p className={s.pitch}>Passive income <b>{compact(d.passive)}/mo</b> against a <b>{compact(d.life)}/mo</b> life. Every venture that pays cash lifts you.</p>
        <Leverage d={d} tint="You've deployed {C} of leverage — the rope pulling you up, producing {P}/mo against a {K}/mo cost." />
      </div>
    </div>
  );
}
function Board({ st }) {
  const d = meterData(st); const pos = Math.min(7, Math.floor((d.freedomPct / 100) * 8));
  return (
    <div className={s.hero}>
      <div className={s.boardStage}><div className={s.boardLoop}>{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <span key={i} className={`${s.tile} ${i === pos ? s.tileYou : ""}`} style={{ "--i": i }} />)}<div className={s.boardCenter}>Rat Race<small>exit when passive ≥ life</small></div></div></div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{d.freedomPct}%<span className={s.bigsub}> round the loop</span></div>
        <p className={s.pitch}>Your token is <b>{d.freedomPct}%</b> toward the exit. Passive <b>{compact(d.passive)}/mo</b> vs life <b>{compact(d.life)}/mo</b>.</p>
        <Leverage d={d} tint="Loans are the assets you bought to play: {C} deployed, throwing {P}/mo, sitting against {B}." />
      </div>
    </div>
  );
}
function Machine({ st }) {
  const d = meterData(st);
  return (
    <div className={s.hero}>
      <div className={s.machineStage}><div className={s.gear} /><div className={s.gear2} /><div className={s.tank}><div className={s.tankFill} style={{ height: Math.max(3, Math.min(100, d.freedomPct)) + "%" }} /><span className={s.tankPct}>{d.freedomPct}%</span></div></div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{compact(d.produces)}<span className={s.bigsub}>/mo flowing</span></div>
        <p className={s.pitch}>The engine mints <b>{compact(d.produces)}/mo</b> of passive income; tank fills to <b>{d.freedomPct}%</b> of your <b>{compact(d.life)}/mo</b> life.</p>
        <Leverage d={d} tint="{C} of capital fuels the machine, producing {V}% of what it costs — every ₹1 sits against {R}× value." />
      </div>
    </div>
  );
}
function Season({ st }) {
  const d = meterData(st); const won = st.cashflow >= 0; const form = ["W", "L", "W", "L", won ? "W" : "L"];
  return (
    <div className={s.hero}>
      <div className={s.seasonStage}><div className={s.form}>{form.map((r, i) => <span key={i} className={r === "W" ? s.pillW : s.pillL}>{r}</span>)}</div><div className={s.result} style={{ color: won ? "var(--win)" : "var(--lose)" }}>{won ? "W" : "L"} {inr(st.cashflow)}</div><div className={s.resSub}>this period's result</div></div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{d.freedomPct}%<span className={s.bigsub}> table position</span></div>
        <p className={s.pitch}>Win a period by ending in the black. Passive <b>{compact(d.passive)}/mo</b> vs a <b>{compact(d.life)}/mo</b> opponent.</p>
        <Leverage d={d} tint="Squad value {B}, bought with {C} of transfer budget returning {P}/mo." />
      </div>
    </div>
  );
}
function Quest({ st }) {
  const d = meterData(st); const lvl = Math.max(1, Math.floor(d.freedomPct / 20) + 1);
  return (
    <div className={s.hero}>
      <div className={s.questStage}><div className={s.badge}>{lvl}</div><div className={s.xpwrap}><div className={s.xplabel}>Wage Earner → <span style={{ color: "var(--ac)" }}>Investor</span></div><div className={s.xpbar}><div style={{ width: Math.max(4, d.freedomPct) + "%" }} /></div><div className={s.xpsub}>{d.freedomPct}% to the next level</div></div></div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>Lvl {lvl}</div>
        <p className={s.pitch}>XP is passive income: <b>{compact(d.passive)}/mo</b> of <b>{compact(d.life)}/mo</b>. Hit Investor when it covers your life.</p>
        <Leverage d={d} tint="Leverage is your mana — {C} channelled, producing {P}/mo, powering {B} of holdings." />
      </div>
    </div>
  );
}
function Leverage({ d, tint }) {
  const txt = tint.replace("{C}", compact(d.deployed)).replace("{P}", compact(d.produces)).replace("{K}", compact(d.cost)).replace("{B}", compact(d.building)).replace("{V}", d.coversCost ?? "—").replace("{R}", ((d.valuePer || 0) / 100).toFixed(1));
  return (
    <div className={s.lev}>
      <div className={s.levHead}><span>Capital in play</span><b>{compact(d.deployed)}</b></div>
      <div className={s.levBars}>
        <div className={s.levBar}><span>produces</span><div className={s.track}><div style={{ width: Math.min(100, (d.coversCost || 0) / 3) + "%", background: "var(--win)" }} /></div><b>{compact(d.produces)}/mo</b></div>
        <div className={s.levBar}><span>costs</span><div className={s.track}><div style={{ width: "33%", background: "var(--mut2)" }} /></div><b>{compact(d.cost)}/mo</b></div>
      </div>
      <div className={s.levNote}>{txt} <span className={s.levTag}>{d.coversCost != null ? `${d.coversCost}% of cost covered` : "add ventures to score it"}</span></div>
    </div>
  );
}
/* CLIMB — the composite altitude (freedom·debt·runway·streak) */
function Altitude({ a }) {
  const R = 34, C = 2 * Math.PI * R, off = C * (1 - a.altitude / 100);
  return (
    <div className={s.alt}>
      <div className={s.altDial}>
        <svg viewBox="0 0 80 80" className={s.altSvg}>
          <circle cx="40" cy="40" r={R} className={s.altTrack} />
          <circle cx="40" cy="40" r={R} className={s.altFill} strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 40 40)" />
        </svg>
        <div className={s.altNum}><b>{a.altitude}</b><span>altitude</span></div>
      </div>
      <div className={s.altDims}>
        {a.dims.map((d) => (
          <div className={s.altDim} key={d.key}>
            <div className={s.altDimTop}><span>{d.label}</span><b>{d.score}</b><i>×{d.weight}</i></div>
            <div className={s.altBar}><div style={{ width: Math.max(2, d.score) + "%" }} /></div>
            <div className={s.altDetail}>{d.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* THE MACHINE — where the month's money flows: sources → engine → sinks */
function MachineMap({ m }) {
  if (!m) return null;
  const sources = [
    { k: "active", label: "Active income", v: m.inflow.active, c: "#5b9be5" },
    { k: "passive", label: "Passive", v: m.inflow.passive, c: "var(--win)" },
    { k: "capital", label: "Capital raised", v: m.inflow.capital, c: "var(--gold)" },
  ].filter((x) => x.v > 0);
  const sinks = [
    { k: "fixed", label: "Fixed", v: m.sinks.fixed, c: "var(--gold)" },
    { k: "variable", label: "Variable", v: m.sinks.variable, c: "var(--mut)" },
    { k: "savings", label: "Savings / invest", v: m.sinks.savings, c: "var(--win)" },
    { k: "debt", label: "Debt service", v: m.sinks.debt, c: "var(--lose)" },
  ].filter((x) => x.v > 0);
  const maxV = Math.max(1, ...sources.map((x) => x.v), ...sinks.map((x) => x.v));
  const bar = (v) => Math.max(6, Math.round((v / maxV) * 100));
  const Col = (title, rows, align) => (
    <div className={s.mCol} data-align={align}>
      <div className={s.mColH}>{title}</div>
      {rows.map((r) => (
        <div className={s.mNode} key={r.k}>
          <div className={s.mNodeTop}><span>{r.label}</span><b>{compact(r.v)}</b></div>
          <div className={s.mNodeBar}><div style={{ width: bar(r.v) + "%", background: r.c }} /></div>
        </div>
      ))}
      {!rows.length && <div className={s.liE}>—</div>}
    </div>
  );
  return (
    <div className={s.machine}>
      <div className={s.machineH}>The machine <span className={s.hint}>how this period's money moved</span></div>
      <div className={s.machineFlow}>
        {Col("In", sources, "right")}
        <div className={s.mEngine}>
          <div className={s.mGear}>⚙</div>
          <div className={s.mThru}>{compact(m.inflow.total)}<span>through</span></div>
          <div className={m.surplus >= 0 ? s.mSurplus : s.mDeficit}>{m.surplus >= 0 ? "+" : ""}{compact(m.surplus)} <em>{m.surplus >= 0 ? "surplus" : "deficit"}</em></div>
        </div>
        {Col("Out", sinks, "left")}
      </div>
    </div>
  );
}

function Statement({ st }) {
  const G = (label, cls, total, rows) => (
    <div className={s.grp}><div className={`${s.grpH} ${cls}`}><span>{label}</span><span>{inr(total)}</span></div>
      {rows.slice(0, 4).map((r) => <div className={s.li} key={r.account}><span>{r.label}</span><b>{inr(r.amount)}</b></div>)}
      {!rows.length && <div className={s.liE}>—</div>}</div>
  );
  return (
    <div className={s.card}>
      <h3>Income statement</h3>
      {G("Income · active", s.gActive, st.income.activeTotal, st.income.active)}
      {G("Income · passive", s.gPassive, st.income.passiveLedger, st.income.passive)}
      {G("Expenses · fixed", s.gFixed, st.expenses.fixedTotal, st.expenses.fixed)}
      {G("Expenses · variable", s.gVar, st.expenses.variableTotal, st.expenses.variable)}
      <div className={s.payday}><span>Cashflow</span><b className={st.cashflow >= 0 ? s.pos : s.neg}>{inr(st.cashflow)}</b></div>
    </div>
  );
}
function Ventures({ ventures, busy, save }) {
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ name: "", kind: "equity", value: "", monthlyReturn: "" });
  const submit = () => { if (f.name) { save({ ...f, value: Number(f.value) || 0, monthlyReturn: Number(f.monthlyReturn) || 0 }); setAdd(false); setF({ name: "", kind: "equity", value: "", monthlyReturn: "" }); } };
  return (
    <div className={s.card}>
      <h3>Ventures &amp; equity <span className={s.hint}>what your capital builds</span></h3>
      {ventures.map((v) => (
        <div className={s.vRow} key={v.name}><span className={s.vName}>{v.name} <em>{v.kind}</em></span><span className={s.vNums}><b>{compact(v.value)}</b>{v.monthly_return ? <i>{compact(v.monthly_return)}/mo</i> : null}</span></div>
      ))}
      {!ventures.length && <div className={s.liE}>None yet — add what aikaara / flyy / arthsutra are worth.</div>}
      {add ? (
        <div className={s.vForm}>
          <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["equity", "venture", "loan_out", "property", "other"].map((k) => <option key={k}>{k}</option>)}</select>
          <input placeholder="Worth ₹" inputMode="numeric" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^\d]/g, "") })} />
          <input placeholder="₹/mo cash" inputMode="numeric" value={f.monthlyReturn} onChange={(e) => setF({ ...f, monthlyReturn: e.target.value.replace(/[^\d]/g, "") })} />
          <button className={s.ok} disabled={busy || !f.name} onClick={submit}>Save</button>
        </div>
      ) : <button className={s.addV} onClick={() => setAdd(true)}>+ Add a venture / stake</button>}
    </div>
  );
}
