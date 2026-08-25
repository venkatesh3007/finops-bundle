"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import s from "./game.module.css";

const inr = (n) => (n < 0 ? "−₹" : "₹") + Math.round(Math.abs(n)).toLocaleString("en-IN");
const compact = (n) => {
  const a = Math.abs(n), sign = n < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(0)}k`;
  return `${sign}₹${a}`;
};
const monthName = (m) => new Date(m + "-01T00:00:00").toLocaleString("en", { month: "long", year: "numeric" });

// The playable window: Apr 2025 → current month.
function monthList() {
  const out = [];
  const now = new Date();
  const end = now.getFullYear() * 12 + now.getMonth();
  for (let y = 2025, mo = 3; y * 12 + mo <= end; mo++) {
    if (mo > 11) { mo = 0; y++; }
    out.push(`${y}-${String(mo + 1).padStart(2, "0")}`);
  }
  return out;
}

export default function GameClient({ entity = "personal" }) {
  const months = useMemo(monthList, []);
  const [mode, setMode] = useState("game");
  const [month, setMonth] = useState(months[months.length - 1]);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const idx = months.indexOf(month);

  const load = useCallback(async () => {
    const r = await fetch(`/api/game?entity=${entity}&month=${month}`);
    const j = await r.json();
    if (j.error) { setToast(j.error); return; }
    setData(j);
  }, [entity, month]);
  useEffect(() => { setData(null); load(); }, [load]);

  const resolve = useCallback(async (body) => {
    setBusy(true);
    try {
      const r = await fetch("/api/game/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity, ...body }),
      });
      const j = await r.json();
      setToast(j.error ? `⚠ ${j.error}` : "✓ sorted");
      if (!j.error) await load();
    } finally { setBusy(false); setTimeout(() => setToast(""), 2600); }
  }, [entity, load]);

  if (!data) return <div className={s.wrap}>Loading your board…</div>;
  const p = data.position, m = data.moves;

  return (
    <div className={s.wrap}>
      <div className={s.top}>
        <h1>The <span className="g">Board</span> · {entity[0].toUpperCase() + entity.slice(1)}</h1>
        <div className={s.seg}>
          <button className={mode === "game" ? s.on : ""} onClick={() => setMode("game")}>Game</button>
          <button className={mode === "dashboard" ? s.on : ""} onClick={() => setMode("dashboard")}>Dashboard</button>
        </div>
      </div>

      <div className={s.scrub}>
        <div className={s.scrubTop}>
          <button className={s.step} onClick={() => setMonth(months[Math.max(0, idx - 1)])} disabled={idx === 0} aria-label="Previous month">‹</button>
          <span className={s.cur}>{monthName(month)}</span>
          <button className={s.step} onClick={() => setMonth(months[Math.min(months.length - 1, idx + 1)])} disabled={idx === months.length - 1} aria-label="Next month">›</button>
          <span className={s.range}>{monthName(months[0])} — {monthName(months[months.length - 1])} · {months.length} months</span>
        </div>
      </div>

      {mode === "game" ? <GameView p={p} m={m} busy={busy} resolve={resolve} /> : <DashboardView p={p} m={m} busy={busy} resolve={resolve} />}

      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  );
}

function Reimbursements({ p, busy, resolve }) {
  return (
    <div className={s.panel}>
      <h3 className={s.pH}>Work — kept separate <span className={s.side} style={{ color: "var(--income)" }}>not your cashflow</span></h3>
      <div className={s.workAmt}>{inr(p.reimbursements.reduce((t, r) => t + Math.max(0, r.outstanding), 0))}</div>
      <div className={s.workSub}>fronted for companies · owed back to you</div>
      <div style={{ marginTop: 12 }}>
        {p.reimbursements.map((r) => (
          <div className={s.coRow} key={r.company}>
            <span>{r.company}</span>
            <span className="num">{r.outstanding > 0 ? inr(r.outstanding) : "settled"}
              {r.outstanding > 0 && <button className={s.claimBtn} disabled={busy} onClick={() => resolve({ action: "claim", company: r.company })} style={{ marginLeft: 8 }}>claim</button>}
            </span>
          </div>
        ))}
      </div>
      <div className={s.workSub} style={{ marginTop: 10 }}>A receivable, never a personal expense. Flyy stays its own book.</div>
    </div>
  );
}

function IncomeStatement({ p }) {
  return (
    <div className={s.panel}>
      <h3 className={s.pH}>Income statement <span className={s.side}>Personal</span></h3>
      <Group cls="active" label="Income · active" total={p.income.total - p.income.passiveTotal} rows={p.income.active} />
      <Group cls="passive" label="Income · passive" total={p.income.passiveTotal} rows={p.income.passive}
        empty="No asset pays you yet — this is the number the game grows" />
      <Group cls="fixed" label="Expenses · fixed" total={p.expenses.fixedTotal} rows={p.expenses.fixed} />
      <Group cls="vary" label="Expenses · variable" total={p.expenses.variableTotal} rows={p.expenses.variable.slice(0, 5)} />
      <div className={s.payday}><span>Payday</span><span className={p.payday >= 0 ? s.pos : s.neg}>{inr(p.payday)}</span></div>
    </div>
  );
}

function Group({ cls, label, total, rows, empty }) {
  return (
    <div className={s.grp}>
      <div className={`${s.grpH} ${s[cls]}`}><span>{label}</span><span className={`${s.gt} num`}>{inr(total)}</span></div>
      {rows.length ? rows.map((r) => (
        <div className={s.li} key={r.account}><span>{r.label}</span><span className={`${s.v} num`}>{inr(r.amount)}</span></div>
      )) : empty ? <div className={`${s.li} ${s.empty}`}><span>{empty}</span><span>₹0</span></div> : null}
    </div>
  );
}

function BalanceSheet({ p }) {
  const bs = p.balanceSheet;
  return (
    <div className={s.panel} style={{ marginTop: 13 }}>
      <h3 className={s.pH}>Balance sheet — as of today</h3>
      <div className={s.bs}>
        <div>
          <h4>Assets · {compact(bs.assetsTotal)}</h4>
          {bs.assets.slice(0, 5).map((a) => <div className={s.li} key={a.account}><span>{a.label}</span><span className={`${s.v} num`}>{inr(a.amount)}</span></div>)}
        </div>
        <div>
          <h4>Liabilities · {compact(bs.liabilitiesTotal)}</h4>
          {bs.liabilities.slice(0, 5).map((a) => <div className={s.li} key={a.account}><span>{a.label}</span><span className={`${s.v} num`}>{inr(a.amount)}</span></div>)}
        </div>
        <div className={s.bsNet}><span>Net worth</span><span className={bs.netWorth >= 0 ? s.pos : s.neg}>{inr(bs.netWorth)}</span></div>
      </div>
    </div>
  );
}

function Moves({ m, p, busy, resolve }) {
  const CATS = ["Expenses:Dining", "Expenses:Travel:Cabs", "Expenses:Shopping", "Expenses:Sports", "Expenses:Health"];
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className={s.sort}>
        <div className={s.sortH}><span className={s.t}>Sort out this month — {m.counts.review + m.counts.claim + m.counts.missing} moves</span></div>
        <div className={s.moves}>
          <div className={s.move}><div className={`${s.n} num`}>{m.counts.review}</div><div className={s.k}>to <b>review</b></div></div>
          <div className={s.move}><div className={`${s.n} num`}>{m.counts.claim}</div><div className={s.k}><b>reimbursements</b> to claim</div></div>
          <div className={s.move}><div className={`${s.n} num`}>{m.counts.missing}</div><div className={s.k}><b>commitments</b> missing</div></div>
          <button className={s.move} style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setAdding((v) => !v)}>
            <div className={`${s.n}`} style={{ fontSize: 15, marginTop: 4 }}>+ add</div><div className={s.k}>investment / one-time</div>
          </button>
        </div>
        {adding && <AddForm busy={busy} resolve={resolve} onDone={() => setAdding(false)} />}
      </div>
      {m.review.length > 0 && (
        <>
          <div className={s.sectionTitle}>Review — pick a category, it learns</div>
          <div className={s.reviewList}>
            {m.review.slice(0, 8).map((r) => (
              <ReviewRow key={r.id} r={r} cats={CATS} busy={busy} resolve={resolve} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ReviewRow({ r, cats, busy, resolve }) {
  // Default to the learned decision for this payee (the "it learns" loop), else first cat.
  const options = r.suggestion && !cats.includes(r.suggestion) ? [r.suggestion, ...cats] : cats;
  const [to, setTo] = useState(r.suggestion || cats[0]);
  return (
    <div className={s.rItem}>
      <span className={s.rdate}>{r.date}</span>
      <span>{r.payee || "(no payee)"} <span style={{ color: "var(--muted)" }}>· {r.reason}</span>
        {r.suggestion && <span style={{ color: "var(--good-text)", marginLeft: 6 }}>· learned</span>}</span>
      <select className={s.pick} value={to} onChange={(e) => setTo(e.target.value)}>
        {options.map((c) => <option key={c} value={c}>{c.split(":").slice(1).join(" · ")}</option>)}
      </select>
      <button className={s.ok} disabled={busy}
        onClick={() => resolve({ action: "reclassify", txnId: r.id, fromAccount: r.account, toAccount: to, makeRule: true })}>
        {inr(r.amount)} ✓
      </button>
    </div>
  );
}

function AddForm({ busy, resolve, onDone }) {
  const [what, setWhat] = useState("");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("Assets:Investments:Gold");
  const [from, setFrom] = useState("Assets:Cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const kinds = [
    ["Assets:Investments:Gold", "Gold"], ["Assets:Investments:MF", "Mutual fund"],
    ["Assets:Investments:Chits", "Chit fund"], ["Assets:Investments:Deposits", "Deposit / FD"],
    ["Expenses:Travel:Hotels", "One-time · travel"], ["Expenses:Other", "One-time · other"],
  ];
  const froms = [["Assets:Cash", "Cash"], ["Assets:Bank:IDBI", "Bank"], ["Equity:Opening", "Opening balance"]];
  const ok = Number(amount) > 0;
  const submit = async () => {
    if (!ok) return;
    await resolve({ action: "add", date, amount: Number(amount), toAccount: to, fromAccount: from, note: what || "Manual entry" });
    onDone();
  };
  return (
    <div className={s.addForm}>
      <input className={s.fi} placeholder="What (e.g. Gold bought in cash)" value={what} onChange={(e) => setWhat(e.target.value)} />
      <input className={s.fi} placeholder="Amount ₹" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
      <select className={s.fi} value={to} onChange={(e) => setTo(e.target.value)}>{kinds.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <select className={s.fi} value={from} onChange={(e) => setFrom(e.target.value)}>{froms.map(([v, l]) => <option key={v} value={v}>from {l}</option>)}</select>
      <input className={s.fi} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <button className={s.ok} disabled={busy || !ok} onClick={submit}>Add to books</button>
    </div>
  );
}

function GameView({ p, m, busy, resolve }) {
  const idle = p.balanceSheet.assets.filter((a) => a.account.startsWith("Assets:Investments") || a.account.includes("Demat")).reduce((t, a) => t + a.amount, 0);
  return (
    <>
      <div className={s.hero}>
        <div className={s.heroH}>
          <span className={s.heroLbl}>Escaping the rat race</span>
          <span className={`${s.heroPct} num`} style={{ color: p.freedom >= 100 ? "var(--good-text)" : "var(--expense)" }}>{p.freedom}%</span>
        </div>
        <div className={s.heroTitle}>Passive income covers <b>{p.freedom}%</b> of your expenses.</div>
        <div className={s.bigtrack}><div className={s.bigfill} style={{ width: `${Math.max(2, Math.min(100, p.freedom))}%` }} /></div>
        <div className={s.legend}>
          <span>Passive income <b>{compact(p.income.passiveTotal)}/mo</b></span>
          <span>Expenses <b>{compact(p.expenses.total)}</b></span>
          <span>Idle assets <b>{compact(idle)}</b></span>
        </div>
      </div>
      <div className={s.grid2}>
        <IncomeStatement p={p} />
        <Reimbursements p={p} busy={busy} resolve={resolve} />
      </div>
      <BalanceSheet p={p} />
      <div style={{ marginTop: 14 }}><Moves m={m} p={p} busy={busy} resolve={resolve} /></div>
    </>
  );
}

function DashboardView({ p, m, busy, resolve }) {
  return (
    <>
      <div className={s.grid2}>
        <IncomeStatement p={p} />
        <Reimbursements p={p} busy={busy} resolve={resolve} />
      </div>
      <BalanceSheet p={p} />
      <div className={s.sectionTitle}>Committed savings this month · {inr(p.savings.total)}</div>
      <div className={s.panel}>
        {p.savings.committed.length ? p.savings.committed.map((a) => (
          <div className={s.li} key={a.account}><span>{a.label}</span><span className={`${s.v} num`}>{inr(a.amount)}</span></div>
        )) : <div className={`${s.li} ${s.empty}`}><span>nothing invested this month</span><span>₹0</span></div>}
      </div>
      <div style={{ marginTop: 14 }}><Moves m={m} p={p} busy={busy} resolve={resolve} /></div>
    </>
  );
}
