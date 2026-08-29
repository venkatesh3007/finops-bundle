// Classify the rows that no rule/history/heuristic could — with the frontier
// model through the gateway. The model only ever picks an account NAME from the
// entity's own chart for a description; amounts never come from it. Batched
// (a frontier model handles a numbered list + JSON reliably — unlike the
// on-device 1.2B model, which needs the multiple-choice tournament in classify.js).
import { chatText, jsonFrom, gatewayModelLabel } from "./gateway.js";
import { candidatesFor, defaultAccount, pickOption } from "./classify.js";

const BATCH = 60;

function prompt(batch, ctx) {
  const outs = [...new Set(batch.flatMap((r) => candidatesFor(r, ctx)))];
  const lines = batch.map((r) => `${r.i} | ${r.amount > 0 ? "IN" : "OUT"} | ${String(r.desc).slice(0, 140)}`).join("\n");
  return [
    { role: "system", content: `You are a bookkeeper for Indian bank and credit-card statements. For each numbered line pick the single best account from ACCOUNTS (copy the name exactly). IN = money received, OUT = money paid. Card bill payments / transfers to own accounts → an Assets:Clearing account if present. If genuinely unsure use Expenses:Other (OUT) or Income:Other (IN). Reply with ONLY a JSON object mapping line number → account, e.g. {"12":"Expenses:Dining"}.` },
    { role: "user", content: `ACCOUNTS:\n${outs.join("\n")}\n\nLINES:\n${lines}` },
  ];
}

// rows: classified-by-rules rows (account may be null). Returns rows with the
// gaps filled (source "frontier", or "default" when the model gave nothing usable).
export async function classifyRemaining(rows, ctx) {
  const todo = rows.filter((r) => !r.account);
  if (!todo.length) return rows;
  const byI = new Map(rows.map((r) => [r.i, r]));
  const model = gatewayModelLabel();
  for (let b = 0; b < todo.length; b += BATCH) {
    const batch = todo.slice(b, b + BATCH);
    let map = {};
    try { map = jsonFrom(await chatText(prompt(batch, ctx), { max_tokens: 4000 })); } catch { map = {}; }
    for (const r of batch) {
      const picked = pickOption(String(map[String(r.i)] || ""), candidatesFor(r, ctx));
      byI.set(r.i, picked
        ? { ...r, account: picked, source: "frontier", rule: `frontier:${model}`, confidence: /:Other$/.test(picked) ? 0.45 : 0.8 }
        : { ...r, account: defaultAccount(r, ctx), source: "default", rule: "default:unclassified", confidence: 0.2 });
    }
  }
  return rows.map((r) => byI.get(r.i));
}
