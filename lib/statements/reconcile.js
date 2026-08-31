// Deterministic verifier for extracted transactions. This is the safety net that
// makes LLM extraction trustworthy for money: the model transcribes; this proves
// the numbers hang together against the printed running balance. Nothing here
// invents or rounds a number — it only checks continuity.
//
// Sign convention (must match the extraction prompt): amount is signed cashflow —
// negative = money out (debit/charge/withdrawal), positive = money in.
//   bank account: balance[i] == balance[i-1] + amount[i]
//   credit card : outstanding[i] == outstanding[i-1] - amount[i]  (a charge raises what you owe)

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const EPS = 0.02; // a couple of paise of slack for rounding

export function reconcile(txns, { statement_type = "bank", opening_balance = null, closing_balance = null, total_credits = null, total_debits = null } = {}) {
  const rows = (txns || []).filter((t) => t && typeof t.amount === "number" && Number.isFinite(t.amount));
  const card = statement_type === "card";
  const step = (prev, amt) => (card ? r2(prev - amt) : r2(prev + amt));

  // 1) row-to-row balance continuity (only across rows that both carry a balance)
  const mismatches = [];
  let checked = 0;
  let prevBal = opening_balance != null ? Number(opening_balance) : null;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    if (t.balance == null) { prevBal = null; continue; } // gap → can't chain across it
    if (prevBal != null) {
      checked++;
      const expected = step(prevBal, t.amount);
      if (Math.abs(expected - Number(t.balance)) > EPS) {
        mismatches.push({
          index: i, date: t.date, desc: String(t.description || "").slice(0, 48),
          amount: t.amount, prev_balance: r2(prevBal), printed_balance: r2(t.balance), expected_balance: expected,
          off_by: r2(Number(t.balance) - expected),
        });
      }
    }
    prevBal = Number(t.balance);
  }

  // 2) whole-statement envelope: opening + net == closing
  const net = r2(rows.reduce((s, t) => s + t.amount, 0));
  let envelope = null;
  if (opening_balance != null && closing_balance != null) {
    const expectedClosing = card ? r2(Number(opening_balance) - net) : r2(Number(opening_balance) + net);
    envelope = { expected_closing: expectedClosing, printed_closing: r2(closing_balance), ok: Math.abs(expectedClosing - Number(closing_balance)) <= EPS };
  }

  // 3) PER-SIDE totals. On a credit-card statement there is no running balance at
  // all, so (1) never runs and the envelope is a SINGLE number covering the whole
  // statement — it can say money is missing but never which side it went missing
  // on. Nearly every statement prints its own totals ("New Credits Rs / New
  // Debits Rs" on Amex, "Total Withdrawals / Total Deposits" on a bank), so check
  // each side separately: two more independent constraints, and a failure now
  // points at payments or at charges instead of just "something is off".
  const creditsIn = r2(rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const debitsOut = r2(rows.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0));
  const side = (printed, extracted) => {
    if (printed == null) return null;
    const gap = r2(Number(printed) - extracted);
    return { printed: r2(Number(printed)), extracted, gap, ok: Math.abs(gap) <= EPS };
  };
  const sides = { credits: side(total_credits, creditsIn), debits: side(total_debits, debitsOut) };
  const sideChecks = [sides.credits, sides.debits].filter(Boolean);
  const sidesOk = sideChecks.length ? sideChecks.every((x) => x.ok) : null;

  const withBalance = rows.filter((t) => t.balance != null).length;
  const continuityOk = checked === 0 ? null : mismatches.length === 0;
  // "reconciled" = nothing we checked disagreed. If there was nothing to check
  // (no balances, no opening/closing), we can't vouch for it → false + a reason.
  const anyCheck = checked > 0 || envelope != null || sideChecks.length > 0;
  return {
    rows: rows.length,
    withBalance,
    continuity: { checked, mismatches, ok: continuityOk },
    envelope,
    net,
    sides,
    reconciled: anyCheck && mismatches.length === 0 && envelope?.ok !== false && sidesOk !== false,
    verifiable: anyCheck,
    note: !anyCheck ? "no running balance, opening/closing or printed totals to verify against — rows can't be auto-checked"
      : mismatches.length ? `${mismatches.length} row(s) break balance continuity`
      : sides.credits && !sides.credits.ok && sides.debits && !sides.debits.ok
        ? `both sides are short: money in is off by ${sides.credits.gap}, money out by ${sides.debits.gap}`
      : sides.credits && !sides.credits.ok
        ? `money IN doesn't match the statement's own total: it prints ${sides.credits.printed}, the rows add to ${sides.credits.extracted} — ${Math.abs(sides.credits.gap)} of credits/payments is missing`
      : sides.debits && !sides.debits.ok
        ? `money OUT doesn't match the statement's own total: it prints ${sides.debits.printed}, the rows add to ${sides.debits.extracted} — ${Math.abs(sides.debits.gap)} of charges is missing`
      : envelope && !envelope.ok ? "row balances chain but opening+net ≠ closing"
      : "",
  };
}
