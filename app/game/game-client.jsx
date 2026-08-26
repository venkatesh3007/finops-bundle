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
  const ac = THEMES.find((t) => t.id === theme).ac;

  const TABS = [["play", "Play"], ["world", "World"], ["statement", "Statement"], ["status", "Status"]];

  return (
    <div className={s.app} data-theme={theme} style={{ "--ac": ac }}>
      <div className={s.top}>
        <div className={s.brand}>finops<span style={{ color: ac }}>·</span>play</div>
        <div className={s.tabs}>
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? s.tabOn : s.tab} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className={s.topRight}>
          <button className={s.resetBtn} title="Reset game progress" onClick={() => setResetting(true)}>⟳</button>
          <div className={s.themeDots}>
            {THEMES.map((t) => (
              <button key={t.id} title={t.name} className={theme === t.id ? s.dotOn : s.dot}
                onClick={() => setTheme(t.id)} style={{ "--d": t.ac }} />
            ))}
          </div>
        </div>
      </div>

      {tab === "play" ? <Play entity={entity} />
        : tab === "world" ? <World entity={entity} />
        : tab === "statement" ? <Ledger entity={entity} />
        : <Status entity={entity} theme={theme} />}

      {resetting && <ResetDialog entity={entity} onClose={() => setResetting(false)} />}
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
function Ledger({ entity }) {
  const [month, setMonth] = useState("");   // '' = all months
  const [text, setText] = useState("");
  const [flows, setFlows] = useState(true); // default: real bank/card statement lines (internal transfers hidden)
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const PAGE = 60;

  const load = useCallback(async (reset) => {
    const off = reset ? 0 : offset;
    const p = new URLSearchParams({ entity, all: "1", limit: String(PAGE), offset: String(off) });
    if (month) p.set("month", month);
    if (text.trim()) p.set("text", text.trim());
    if (flows) p.set("flows", "1");
    const j = await (await fetch(`/api/txns?${p}`)).json();
    setTotal(j.total || 0);
    setRows((prev) => (reset || !prev) ? (j.txns || []) : [...prev, ...(j.txns || [])]);
    setOffset(off + (j.txns?.length || 0));
  }, [entity, month, text, flows, offset]);

  // reload from top whenever a filter changes
  useEffect(() => { setRows(null); setOffset(0); load(true); /* eslint-disable-next-line */ }, [entity, month, text, flows]);

  const MONTHS = monthOptions();
  return (
    <div className={s.ledger}>
      <div className={s.ledgerBar}>
        <input className={s.ledgerSearch} placeholder="Search description…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className={s.ledgerMonth} value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">All months</option>
          {MONTHS.map((m) => <option key={m} value={m}>{monLong(m)}</option>)}
        </select>
        <label className={s.ledgerToggle}><input type="checkbox" checked={flows} onChange={(e) => setFlows(e.target.checked)} /> Hide internal transfers</label>
        <span className={s.ledgerCount}>{total.toLocaleString("en-IN")} lines</span>
      </div>
      {!rows ? <div className={s.loading}>Loading the statement…</div> : (
        <>
          <div className={s.ledgerList}>
            {rows.map((r) => {
              // The raw bank-statement line lives in narration (e.g. "UPI/…/BILVA
              // CHITS"); payee is often just the bank/counterparty. Show the real
              // description first, the counterparty as a tag.
              const narr = (r.narration || "").trim();
              const desc = narr || r.payee || "(no description)";
              const tag = narr && r.payee && r.payee.trim() ? r.payee.trim() : null;
              return (
                <div className={s.stRow} key={r.id}>
                  <span className={s.stDate}>{r.date}</span>
                  <div className={s.stMid}>
                    <b title={desc}>{desc}</b>
                    <span className={s.stSub}>
                      {tag && <span className={s.stTag}>{tag}</span>}
                      {leaf(r.account)}{r.statement ? ` · via ${r.statement}` : ""}{r.doc ? ` · 📄 ${docName(r.doc)}` : ""}
                    </span>
                  </div>
                  <span className={`${s.stAmt} ${r.amount < 0 ? s.pos : ""}`}>{inr(Math.abs(r.amount))}</span>
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
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const j = await (await fetch(`/api/game/pack?entity=${entity}`)).json();
    setW(j);
  }, [entity]);
  useEffect(() => { setW(null); load(); }, [load]);

  const quest = useCallback(async (body) => {
    setBusy(true);
    try { const j = await (await fetch("/api/game/pack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, ...body }) })).json(); if (!j.error) await load(); }
    finally { setBusy(false); }
  }, [entity, load]);

  if (!w) return <div className={s.loading}>Loading your world…</div>;
  if (w.error) return <div className={s.loading}>⚠ {w.error}</div>;
  return (
    <div className={s.world}>
      <ThePack pack={w.pack} />
      <div className={s.worldGrid}>
        <TheLoot loot={w.loot} />
        <TheQuests quests={w.quests} busy={busy} quest={quest} />
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
    <div className={s.season}>
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

  return (
    <div className={s.board}>
      <BoardHead board={board} onLock={lock} busy={busy} />

      {/* the four-quadrant cashflow board, reconciled: plan → reality */}
      {board.buckets && <Quadrants b={board.buckets} />}

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
        <div className={s.cards}>
          {board.cards.map((c) => c.kind === "miss"
            ? <MissCard key={c.planLineId} c={c} busy={busy} card={card} />
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
    <div className={s.quads}>
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
  return (
    <div className={s.head}>
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
        <button className={s.lockBtn} disabled={busy || board.locked} onClick={onLock}>
          {board.locked ? "Sealed ✓" : board.exceptions === 0 ? "Lock month" : `Lock (${board.exceptions} open)`}
        </button>
      </div>
    </div>
  );
}

/* a planned line that never landed — the player rules on it */
function MissCard({ c, busy, card }) {
  return (
    <div className={`${s.exc} ${s.excMiss}`}>
      <div className={s.excLeft}>
        <span className={`${s.chip} ${s["b_" + c.bucket]}`}>{bucketLabel(c.bucket)}</span>
        <div className={s.excMain}>
          <b>{c.label}</b>
          <span className={s.excMeta}>planned {inr(c.planned)}{c.hint ? ` · ${c.hint}` : ""} — no matching {c.dir === "in" ? "receipt" : "payment"} found</span>
        </div>
      </div>
      <div className={s.excActs}>
        <button className={s.actGhost} disabled={busy} onClick={() => card({ action: "carry", planLineId: c.planLineId })}>Carry →</button>
        <button className={s.actGhost} disabled={busy} onClick={() => card({ action: "skip", planLineId: c.planLineId })}>Didn't happen</button>
      </div>
    </div>
  );
}

/* an unplanned real transaction ≥₹10k — the case file + one-tap calls */
function SurpriseCard({ c, misses, cats, busy, card, parked }) {
  const [mode, setMode] = useState(null); // null | 'cat' | 'link' | 'plan'
  const [pick, setPick] = useState(misses[0]?.planLineId || "");
  const isIncome = c.flow === "income";
  const bucket = isIncome ? "var_in" : "var_out";
  const label = (c.payee || c.narration || "Unplanned").slice(0, 40);

  return (
    <div className={`${s.exc} ${s.excSurprise} ${parked ? s.excParked : ""}`}>
      <div className={s.excLeft}>
        <span className={`${s.chip} ${isIncome ? s.b_var_in : s.b_var_out}`}>{isIncome ? "unexpected in" : "unplanned"}</span>
        <div className={s.excMain}>
          <b>{c.payee || c.narration || "(no description)"}</b>
          <span className={s.excMeta}>
            {c.date} · <b className={s.amt}>{inr(c.amount)}</b>
            {c.statement ? ` · via ${leaf(c.statement)}` : ""}
            {c.account ? ` · ${leaf(c.account)}` : ""}
          </span>
          {c.narration && c.payee && <span className={s.excNarr}>{c.narration}</span>}
          {c.doc && <span className={s.excDoc}>📄 {docName(c.doc)}</span>}
        </div>
      </div>

      {!mode ? (
        <div className={s.excActs}>
          {c.canCategorize && <button className={s.actPrimary} disabled={busy} onClick={() => setMode("cat")}>Categorize</button>}
          {misses.length > 0 && <button className={s.actGhost} disabled={busy} onClick={() => setMode("link")}>Was planned</button>}
          <button className={s.actGhost} disabled={busy} onClick={() => card({ action: "newline", bucket, label, amount: c.amount, txnId: c.txnId })}>Add to plan</button>
          <button className={s.actGhost} disabled={busy} onClick={() => card({ action: "accept", txnId: c.txnId })}>Accept</button>
          {!parked && <button className={s.actGhost} disabled={busy} onClick={() => card({ action: "review", txnId: c.txnId })}>Later</button>}
        </div>
      ) : mode === "cat" ? (
        <div className={s.chipPick}>
          {cats.slice(0, 12).map((a) => (
            <button key={a} className={s.catChip} disabled={busy} onClick={() => card({ action: "categorize", txnId: c.txnId, toAccount: a, makeRule: true })}>{leaf(a)}</button>
          ))}
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
