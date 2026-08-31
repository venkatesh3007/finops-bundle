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
