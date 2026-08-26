// CLIMB — the composite altitude the owner named: not passive/burn alone (which
// is ₹0 when nothing's passive and reads as demotivating), but a blend of four
// dimensions, each normalized 0–100, so progress on ANY of them lifts you:
//   FREEDOM   (40%)  passive income vs your living cost
//   DEBT DOWN (25%)  how much of the Pack you've cleared (peak → now)
//   RUNWAY    (20%)  liquid months of cover, toward a full year
//   STREAK    (15%)  consecutive months you've sealed
import { computeGameState } from "./game.js";
import { computePack } from "./pack.js";
import { query } from "./db.js";

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

export async function computeAltitude(entity, { from, to } = {}) {
  const [state, pack, lockRows] = await Promise.all([
    computeGameState(entity, { from, to }),
    computePack(entity),
    query(`select month from month_locks ml join entities e on e.id=ml.entity_id where e.slug=$1`, [entity]),
  ]);

  const freedom = clamp(state.meters.freedom.pct);
  const debtDown = clamp(pack.pack.totals.clearedPct);
  const burn = state.meters.freedom.expenseMonthly || 0;
  const runwayMonths = burn > 0 ? state.liquid / burn : 0;
  const runway = clamp((runwayMonths / 12) * 100);         // a year of cover = 100
  const streakN = currentStreak(lockRows.map((r) => r.month));
  const streak = clamp(streakN * 12);                       // ~8 sealed months = 100

  const dims = [
    { key: "freedom", label: "Freedom", weight: 0.40, score: freedom, detail: `passive covers ${freedom}% of life` },
    { key: "debt", label: "Debt down", weight: 0.25, score: debtDown, detail: `${debtDown}% of the Pack cleared` },
    { key: "runway", label: "Runway", weight: 0.20, score: runway, detail: `${runwayMonths.toFixed(1)} months liquid` },
    { key: "streak", label: "Streak", weight: 0.15, score: streak, detail: `${streakN} months sealed in a row` },
  ];
  const altitude = clamp(dims.reduce((s, d) => s + d.weight * d.score, 0));

  return {
    entity, altitude,
    dims, streakMonths: streakN, runwayMonths: Math.round(runwayMonths * 10) / 10,
    liquid: state.liquid, burn,
  };
}

function currentStreak(lockedMonths) {
  const set = new Set(lockedMonths);
  if (!set.size) return 0;
  const last = [...set].sort().pop();
  let m = last, n = 0;
  while (set.has(m)) { n++; let [y, mo] = m.split("-").map(Number); mo--; if (mo < 1) { mo = 12; y--; } m = `${y}-${String(mo).padStart(2, "0")}`; }
  return n;
}
