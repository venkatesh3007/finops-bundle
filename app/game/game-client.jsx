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

// period kind + anchor → {from, to, label}
function rangeOf(kind, a) {
  if (kind === "month") { const [y, m] = a.split("-").map(Number); return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${lastDay(y, m)}`, label: new Date(y, m - 1).toLocaleString("en", { month: "long", year: "numeric" }) }; }
  if (kind === "quarter") { const [y, q] = a.split("Q").map(Number); const sm = (q - 1) * 3 + 1; return { from: `${y}-${pad(sm)}-01`, to: `${y}-${pad(sm + 2)}-${lastDay(y, sm + 2)}`, label: `Q${q} ${y} · ${new Date(y, sm - 1).toLocaleString("en", { month: "short" })}–${new Date(y, sm + 1).toLocaleString("en", { month: "short" })}` }; }
  if (kind === "year") { const y = Number(a); return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${String(y).slice(2)}–${String(y + 1).slice(2)}` }; }
  return { from: a.from, to: a.to, label: "Custom" };
}
function stepAnchor(kind, a, d) {
  if (kind === "month") { let [y, m] = a.split("-").map(Number); m += d; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return `${y}-${pad(m)}`; }
  if (kind === "quarter") { let [y, q] = a.split("Q").map(Number); q += d; if (q > 4) { q = 1; y++; } if (q < 1) { q = 4; y--; } return `${y}Q${q}`; }
  if (kind === "year") return String(Number(a) + d);
  return a;
}
const defaultAnchor = { month: "2026-08", quarter: "2026Q3", year: "2025", custom: { from: "2025-04-01", to: "2026-08-31" } };

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
  const [kind, setKind] = useState("month");
  const [anchor, setAnchor] = useState(defaultAnchor);
  const range = useMemo(() => rangeOf(kind, kind === "custom" ? anchor.custom : anchor[kind]), [kind, anchor]);
  const [data, setData] = useState(null);
  const [ventures, setVentures] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [view, setView] = useState("board"); // board (score) | sort (the work)

  const load = useCallback(async () => {
    const r = await fetch(`/api/game?entity=${entity}&from=${range.from}&to=${range.to}`);
    const j = await r.json();
    if (j.error) { setToast(j.error); return; }
    setData(j);
    const v = await (await fetch(`/api/ventures?entity=${entity}`)).json();
    setVentures(v.ventures || []);
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
  const resolve = (b) => act("/api/game/move", b);
  const saveVenture = (b) => act("/api/ventures", b);

  const step = (d) => setAnchor((a) => ({ ...a, [kind]: stepAnchor(kind, a[kind], d) }));

  if (!data) return <div className={s.loading}>Loading your board…</div>;
  const st = data.state, mv = data.moves;
  const Hero = { climb: Climb, board: Board, machine: Machine, season: Season, quest: Quest }[theme];
  const ac = THEMES.find((t) => t.id === theme).ac;

  return (
    <div className={s.app} data-theme={theme} style={{ "--ac": ac }}>
      <div className={s.top}>
        <div className={s.brand}>finops<span style={{ color: ac }}>·</span>play</div>
        <div className={s.themes}>
          {THEMES.map((t) => (
            <button key={t.id} className={theme === t.id ? s.themeOn : s.themeBtn} onClick={() => setTheme(t.id)} style={theme === t.id ? { "--ac": t.ac } : {}}>{t.name}</button>
          ))}
        </div>
      </div>

      <div className={s.periods}>
        <div className={s.seg}>
          {["year", "quarter", "month", "custom"].map((k) => (
            <button key={k} className={kind === k ? s.segOn : ""} onClick={() => setKind(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
          ))}
        </div>
        {kind !== "custom" ? (
          <div className={s.stepper}>
            <button onClick={() => step(-1)} aria-label="prev">‹</button>
            <span>{range.label}</span>
            <button onClick={() => step(1)} aria-label="next">›</button>
          </div>
        ) : (
          <div className={s.custom}>
            <input type="date" value={anchor.custom.from} onChange={(e) => setAnchor((a) => ({ ...a, custom: { ...a.custom, from: e.target.value } }))} />
            <span>→</span>
            <input type="date" value={anchor.custom.to} onChange={(e) => setAnchor((a) => ({ ...a, custom: { ...a.custom, to: e.target.value } }))} />
          </div>
        )}
      </div>

      {view === "sort" ? (
        <SortMode entity={entity} onBack={() => { setView("board"); load(); }} />
      ) : (
        <>
          <button className={s.sortCTA} onClick={() => setView("sort")}>
            <span className={s.sortCTAn}>{mv.review.length}+</span>
            <span className={s.sortCTAt}><b>Sort your transactions</b><small>read each statement line, put it where it belongs — the board goes true as you go</small></span>
            <span className={s.sortCTAgo}>Play →</span>
          </button>
          <Hero st={st} range={range} />
          <Detail st={st} mv={mv} ventures={ventures} busy={busy} resolve={resolve} saveVenture={saveVenture} />
        </>
      )}

      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  );
}

/* ---------- the two meters (shared data, themes wrap them) ---------- */
function meterData(st) {
  const f = st.meters.freedom, l = st.meters.leverage;
  return {
    freedomPct: f.pct, passive: f.passiveMonthly, life: f.expenseMonthly,
    deployed: l.deployed, cost: l.costMonthly, produces: l.producingMonthly,
    building: l.building, coversCost: l.coversCostPct, valuePer: l.valuePerRupeePct,
  };
}

/* ===================== THEME 01 · THE CLIMB ===================== */
function Climb({ st }) {
  const d = meterData(st);
  const h = Math.max(4, Math.min(100, d.freedomPct));
  return (
    <div className={s.hero}>
      <div className={s.climbStage}>
        <div className={s.climbCol}>
          <div className={s.climbFill} style={{ height: h + "%" }} />
          <div className={s.you} style={{ bottom: h + "%" }}>▲</div>
        </div>
        <div className={s.climbCapTop}>Free · passive covers life</div>
        <div className={s.climbCapBot}>Base camp</div>
      </div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{d.freedomPct}%<span className={s.bigsub}> to free</span></div>
        <p className={s.pitch}>Passive income <b>{compact(d.passive)}/mo</b> against a <b>{compact(d.life)}/mo</b> life. Every venture that pays cash lifts you.</p>
        <Leverage d={d} tint="You've deployed {C} of leverage — it's the rope pulling you up, producing {P}/mo against a {K}/mo cost." />
      </div>
    </div>
  );
}

/* ===================== THEME 02 · THE BOARD ===================== */
function Board({ st }) {
  const d = meterData(st);
  const pos = Math.min(7, Math.floor((d.freedomPct / 100) * 8));
  const tiles = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <div className={s.hero}>
      <div className={s.boardStage}>
        <div className={s.boardLoop}>
          {tiles.map((i) => <span key={i} className={`${s.tile} ${i === pos ? s.tileYou : ""}`} style={{ "--i": i }} />)}
          <div className={s.boardCenter}>Rat Race<small>exit when passive ≥ life</small></div>
        </div>
      </div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{d.freedomPct}%<span className={s.bigsub}> round the loop</span></div>
        <p className={s.pitch}>Your token is <b>{d.freedomPct}%</b> toward the exit. Passive <b>{compact(d.passive)}/mo</b> vs life <b>{compact(d.life)}/mo</b>.</p>
        <Leverage d={d} tint="Loans are the assets you bought to play: {C} deployed, throwing {P}/mo, sitting against {B}." />
      </div>
    </div>
  );
}

/* ===================== THEME 03 · THE MACHINE ===================== */
function Machine({ st }) {
  const d = meterData(st);
  return (
    <div className={s.hero}>
      <div className={s.machineStage}>
        <div className={s.gear} /><div className={s.gear2} />
        <div className={s.tank}><div className={s.tankFill} style={{ height: Math.max(3, Math.min(100, d.freedomPct)) + "%" }} /><span className={s.tankPct}>{d.freedomPct}%</span></div>
      </div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{compact(d.produces)}<span className={s.bigsub}>/mo flowing</span></div>
        <p className={s.pitch}>The engine mints <b>{compact(d.produces)}/mo</b> of passive income; tank fills to <b>{d.freedomPct}%</b> of your <b>{compact(d.life)}/mo</b> life. 100% = it runs itself.</p>
        <Leverage d={d} tint="{C} of capital fuels the machine, producing {V}% of what it costs — every ₹1 sits against {R}× value." />
      </div>
    </div>
  );
}

/* ===================== THEME 04 · THE SEASON ===================== */
function Season({ st }) {
  const d = meterData(st);
  const won = st.cashflow >= 0;
  const form = ["W", "L", "W", "L", won ? "W" : "L"];
  return (
    <div className={s.hero}>
      <div className={s.seasonStage}>
        <div className={s.form}>{form.map((r, i) => <span key={i} className={r === "W" ? s.pillW : s.pillL}>{r}</span>)}</div>
        <div className={s.result} style={{ color: won ? "var(--win)" : "var(--lose)" }}>{won ? "W" : "L"} {inr(st.cashflow)}</div>
        <div className={s.resSub}>this period's result</div>
      </div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>{d.freedomPct}%<span className={s.bigsub}> table position</span></div>
        <p className={s.pitch}>Win a period by ending in the black. Passive <b>{compact(d.passive)}/mo</b> is your reliable scorer vs a <b>{compact(d.life)}/mo</b> opponent.</p>
        <Leverage d={d} tint="Squad value {B}, bought with {C} of transfer budget returning {P}/mo." />
      </div>
    </div>
  );
}

/* ===================== THEME 05 · THE QUEST ===================== */
function Quest({ st, ...p }) {
  const d = meterData(st);
  return (
    <div className={s.hero}>
      <div className={s.questStage}>
        <div className={s.badge}>{Math.max(1, Math.floor(d.freedomPct / 20) + 1)}</div>
        <div className={s.xpwrap}><div className={s.xplabel}>Wage Earner → <span style={{ color: "var(--ac)" }}>Investor</span></div><div className={s.xpbar}><div style={{ width: Math.max(4, d.freedomPct) + "%" }} /></div><div className={s.xpsub}>{d.freedomPct}% to the next level</div></div>
      </div>
      <div className={s.heroText}>
        <div className={s.big} style={{ color: "var(--ac)" }}>Lvl {Math.max(1, Math.floor(d.freedomPct / 20) + 1)}</div>
        <p className={s.pitch}>XP is passive income: <b>{compact(d.passive)}/mo</b> of <b>{compact(d.life)}/mo</b>. Hit Investor when it covers your life.</p>
        <Leverage d={d} tint="Leverage is your mana — {C} channelled, producing {P}/mo, powering {B} of holdings." />
      </div>
    </div>
  );
}

/* ---------- shared LEVERAGE readout (neutral) ---------- */
function Leverage({ d, tint }) {
  const txt = tint
    .replace("{C}", compact(d.deployed)).replace("{P}", compact(d.produces)).replace("{K}", compact(d.cost))
    .replace("{B}", compact(d.building)).replace("{V}", d.coversCost ?? "—").replace("{R}", ((d.valuePer || 0) / 100).toFixed(1));
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

/* ---------- shared detail: statement · moves · ventures ---------- */
function Detail({ st, mv, ventures, busy, resolve, saveVenture }) {
  return (
    <div className={s.detail}>
      <div className={s.grid2}>
        <Statement st={st} />
        <Ventures ventures={ventures} busy={busy} save={saveVenture} />
      </div>
      <Moves mv={mv} busy={busy} resolve={resolve} />
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
        <div className={s.vRow} key={v.name}>
          <span className={s.vName}>{v.name} <em>{v.kind}</em></span>
          <span className={s.vNums}><b>{compact(v.value)}</b>{v.monthly_return ? <i>{compact(v.monthly_return)}/mo</i> : null}</span>
        </div>
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

function Moves({ mv, busy, resolve }) {
  const CATS = ["Expenses:Dining", "Expenses:Travel:Cabs", "Expenses:Shopping", "Expenses:Sports", "Expenses:Health"];
  const total = mv.review.length + mv.claim.length + (mv.missing_commitments?.length || 0);
  return (
    <div className={s.moves}>
      <div className={s.movesH}>Your moves this period <b>{total}</b></div>
      <div className={s.moveCards}>
        <div className={s.moveC}><b>{mv.review.length}</b><span>to review</span></div>
        <div className={s.moveC}><b>{mv.claim.length}</b><span>reimbursements</span></div>
        <div className={s.moveC}><b>{mv.missing_commitments?.length || 0}</b><span>missing</span></div>
        <div className={s.moveC}><b>{mv.claim.reduce((t, c) => t + c.outstanding, 0) ? compact(mv.claim.reduce((t, c) => t + c.outstanding, 0)) : "—"}</b><span>owed to you</span></div>
      </div>
      {mv.claim.map((c) => (
        <div className={s.claimRow} key={c.company}><span>{c.company} owes <b>{inr(c.outstanding)}</b></span>
          <button className={s.ok} disabled={busy} onClick={() => resolve({ action: "claim", company: c.company })}>Claim</button></div>
      ))}
      {mv.review.slice(0, 6).map((r) => <ReviewRow key={r.id} r={r} cats={CATS} busy={busy} resolve={resolve} />)}
    </div>
  );
}
function ReviewRow({ r, cats, busy, resolve }) {
  const opts = r.suggestion && !cats.includes(r.suggestion) ? [r.suggestion, ...cats] : cats;
  const [to, setTo] = useState(r.suggestion || cats[0]);
  return (
    <div className={s.rRow}>
      <span className={s.rDate}>{r.date}</span>
      <span className={s.rWhat}>{r.payee || "(no payee)"} <em>{r.reason}{r.suggestion ? " · learned" : ""}</em></span>
      <select value={to} onChange={(e) => setTo(e.target.value)}>{opts.map((c) => <option key={c} value={c}>{c.split(":").slice(1).join(" · ")}</option>)}</select>
      <button className={s.ok} disabled={busy} onClick={() => resolve({ action: "reclassify", txnId: r.id, fromAccount: r.account, toAccount: to, makeRule: true })}>{inr(r.amount)} ✓</button>
    </div>
  );
}

/* ===================== THE SORT — the core loop ===================== */
const EXP_CATS = [["Dining", "Expenses:Dining"], ["Groceries", "Expenses:Groceries"], ["Cabs", "Expenses:Travel:Cabs"],
  ["Flights", "Expenses:Travel:Flights"], ["Hotels", "Expenses:Travel:Hotels"], ["Shopping", "Expenses:Shopping"],
  ["Health", "Expenses:Health"], ["Subscriptions", "Expenses:Subscriptions"], ["Sports", "Expenses:Sports"],
  ["Utilities", "Expenses:Utilities"], ["Gifts", "Expenses:Gifts"], ["Family", "Expenses:Family"]];
const WORK = [["aikaara", "Assets:Receivable:Aikaara"], ["Flyy", "Assets:Receivable:Flyy"], ["Arthsutra", "Assets:Receivable:Arthsutra"]];
const catLabel = (a) => a.split(":").slice(1).join(" · ");

function SortMode({ entity, onBack }) {
  const [q, setQ] = useState(null);
  const [i, setI] = useState(0);
  const [done, setDone] = useState(0);
  const [streak, setStreak] = useState(0);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");

  const load = useCallback(async () => {
    const j = await (await fetch(`/api/txns?entity=${entity}&queue=1&limit=40`)).json();
    setQ(j); setI(0);
  }, [entity]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (q && i >= q.txns.length && (q.pile || 0) > 0) load(); }, [i, q, load]);

  const card = q?.txns[i];
  const post = async (body, keepStreak) => {
    if (!card || busy) return; setBusy(true);
    try {
      const r = await (await fetch("/api/game/move", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity, ...body }) })).json();
      if (!r.error) { setDone((d) => d + 1); setStreak((k) => keepStreak ? k + 1 : 0); setI((x) => x + 1); }
    } finally { setBusy(false); }
  };
  const sort = (toAccount) => post({ action: "reclassify", txnId: card.id, fromAccount: card.account, toAccount, makeRule: true }, true);
  const review = () => post({ action: "review", txnId: card.id }, false);
  const setCustomCat = () => { if (!custom.trim()) return; const a = custom.includes(":") ? custom : `Expenses:${custom.replace(/^\w/, (c) => c.toUpperCase())}`; sort(a); setCustom(""); };

  const left = Math.max(0, (q?.pile || 0) - i);
  const pct = q?.pile ? Math.min(100, Math.round((done / (done + left || 1)) * 100)) : 0;

  return (
    <div className={s.sort}>
      <div className={s.sortTop}>
        <button className={s.back} onClick={onBack}>‹ board</button>
        <div className={s.sortProg}><b>{done}</b> sorted {streak > 2 && <span className={s.streak}>🔥 {streak}</span>}<span className={s.left}>~{left} left in the pile</span></div>
      </div>
      <div className={s.progbar}><div style={{ width: pct + "%" }} /></div>

      {!q ? <div className={s.sortDone}>Loading the pile…</div>
        : !card ? <div className={s.sortDone}>{left === 0 ? "🎉 Pile cleared — every rupee is where it belongs." : "Loading next…"}</div>
        : (
          <div className={s.sortCard} key={card.id}>
            <div className={s.scHead}>
              <span className={s.scDate}>{card.date}</span>
              <span className={s.scStmt}>{card.statement || "manual / other"}</span>
              {card.doc && <span className={s.scDoc}>📄 {card.doc.length > 22 ? card.doc.slice(0, 22) + "…" : card.doc}</span>}
              <span className={`${s.scAmt} ${card.amount < 0 ? s.pos : ""}`}>{inr(card.amount)}</span>
            </div>
            <div className={s.scLine}>{card.narration || card.payee || "(no description on the statement)"}</div>
            <div className={s.scNow}>sitting in <b>Other</b> — where did this money go?</div>

            {card.suggestion && <button className={s.suggest} disabled={busy} onClick={() => sort(card.suggestion)}>↩ Suggested: <b>{catLabel(card.suggestion)}</b> · learned · one tap</button>}

            <div className={s.catGrid}>
              {EXP_CATS.map(([l, a]) => <button key={a} className={s.cat} disabled={busy} onClick={() => sort(a)}>{l}</button>)}
            </div>
            <div className={s.workRow}>
              <span className={s.workLbl}>Work · reimbursable</span>
              {WORK.map(([l, a]) => <button key={a} className={s.work} disabled={busy} onClick={() => sort(a)}>{l}</button>)}
            </div>
            <div className={s.customRow}>
              <input placeholder="or type a category — e.g. Insurance, Rent…" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setCustomCat()} />
              <button className={s.ok} disabled={busy || !custom.trim()} onClick={setCustomCat}>Set</button>
              <button className={s.reviewBtn} disabled={busy} onClick={review}>⏳ Review later</button>
            </div>
          </div>
        )}

      {q && (q.pile || 0) === 0 && done === 0 && <div className={s.sortDone}>Nothing in the pile — it's all sorted. 🎉</div>}
    </div>
  );
}
