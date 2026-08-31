// The two gates that decide whether a freshly written parser is allowed to count.
//
// Kept in their own dependency-free module for one reason: they are the rules
// that protect real financial data from a model's bad day, and rules like that
// should be testable without a database. See test/gates.test.mjs.

// Is this parser good enough to stop trying?
//
// "No balance breaks" alone is NOT enough: rows with a null balance are skipped
// by the continuity check, so a parser that drops an amount can score zero breaks
// while losing money. The envelope (opening + net = closing) is what catches
// that, and a row with a zero amount is a parse failure on its face.
//
// "Nothing could be checked" is not success either. `verifiable` is false only
// when the parser produced neither running balances nor an opening/closing — and
// since virtually every statement prints at least a closing figure, that is a
// deficiency in the PARSER, not a property of the statement. Accepting it used to
// end the loop on round 1 with a green tick; on one real run that is how 24 of 25
// statements ended up stored with checked=0.
export function acceptable(score) {
  if (score.rows === 0) return false;
  if (score.zero_amounts > 0) return false;
  if (score.envelope_ok === false) return false;
  if (score.breaks > 0) return false;
  if (!score.verifiable) return false;
  return true;
}

// Ranking used to keep the least-bad attempt when none is acceptable. An attempt
// we CAN check, with a few known-bad rows, beats one we cannot check at all — we
// at least know where that one is wrong.
export function attemptCost(score) {
  return score.breaks +
    score.zero_amounts * 3 +
    (score.envelope_ok === false ? 5 : 0) +
    (score.verifiable ? 0 : 4);
}

// What a draft already holds, so a rewrite can be judged against it.
// null = nothing to protect yet (first parse of this statement).
export function priorResult(draft) {
  const rows = Array.isArray(draft.rows) ? draft.rows : [];
  const rec = draft.reconciliation || null;
  if (!rows.length && !rec) return null;
  return {
    rows: rows.length,
    breaks: rec?.continuity?.mismatches?.length || 0,
    reconciled: !!rec?.reconciled,
    verifiable: !!rec?.verifiable,
  };
}

// THE CHAMPION GATE. The parser is written by a model, so a rewrite can come out
// worse than the thing it replaces — and the write is destructive: the old rows
// are overwritten and `result` is nulled, so there is no way back. Without this,
// one "fix the parsing" could turn a statement that reconciled into one that no
// longer does, silently. The extractor lab has always had this rule; the
// per-statement codegen path did not, which is how a whole corpus got downgraded
// in a single run. Equal-or-better is accepted; strictly worse is refused.
// Returns a human-readable reason, or null when the rewrite may be kept.
export function regressionReason(prior, next) {
  if (!prior) return null;
  if (next.rows === 0 && prior.rows > 0) return `the new parser found no rows at all, and the stored parse has ${prior.rows}`;
  if (next.rows < prior.rows) return `the new parser loses rows (${prior.rows} → ${next.rows})`;
  if (next.breaks > prior.breaks) return `the new parser breaks more rows (${prior.breaks} → ${next.breaks} balance breaks)`;
  if (prior.reconciled && !next.reconciled) return `the stored parse reconciles and this one does not`;
  if (prior.verifiable && !next.verifiable) return `the stored parse can be checked against the printed balance and this one cannot`;
  return null;
}

// ---------------------------------------------------------------------------
// ANTI-FABRICATION: a balance only counts if it is actually PRINTED in the
// document.
//
// Making "nothing could be checked" a failure creates pressure to invent
// something checkable, and a model will take that route: asked to find the
// balance column on a statement that has none, it wrote a parser that emitted a
// running cumulative total as `balance` and set opening=0 / closing=<the sum>.
// The reconciler then checked those numbers against each other and reported
// "reconciles ✓, 0 breaks" — a tautology proving only that a cumulative sum
// equals a cumulative sum. That is strictly worse than an honest "unverified":
// it launders unverifiable data as verified, on someone's finances.
//
// So before anything is reconciled, drop every balance that does not appear in
// the source text. A real running balance is printed on the page; a synthesized
// one is not. Deterministic, no model involved.

// Every number that literally appears in the document, normalised to 2dp and
// unsigned (statements write negatives as "-1,234.56", "1,234.56 Cr" or
// "(1,234.56)", so sign is unreliable — magnitude is what we match on).
export function documentNumbers(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) found.add(Math.abs(n).toFixed(2));
  }
  return found;
}

const printed = (set, v) => v != null && Number.isFinite(Number(v)) && set.has(Math.abs(Number(v)).toFixed(2));

// Returns { transactions, opening_balance, closing_balance, dropped } with every
// un-printed balance removed. Rows keep their amounts — only the balance claim is
// discarded, so a statement that genuinely has no balances ends up honestly
// unverifiable instead of falsely reconciled.
export function groundBalances(parsed, text) {
  const set = documentNumbers(text);
  let dropped = 0;
  const transactions = (parsed.transactions || []).map((t) => {
    if (t.balance == null) return t;
    if (printed(set, t.balance)) return t;
    dropped++;
    return { ...t, balance: null };
  });
  const opening = printed(set, parsed.opening_balance) ? parsed.opening_balance : null;
  const closing = printed(set, parsed.closing_balance) ? parsed.closing_balance : null;
  if (parsed.opening_balance != null && opening == null) dropped++;
  if (parsed.closing_balance != null && closing == null) dropped++;
  return { ...parsed, transactions, opening_balance: opening, closing_balance: closing, dropped };
}
