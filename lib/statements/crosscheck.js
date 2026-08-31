// A SECOND OPINION on the extraction — deterministic, no model.
//
// This is the method that found both real bugs on 2026-08-31, by hand:
//   1. scan the source text for transaction-shaped lines and total them
//   2. compare that total to the statement's own printed totals
//        agree  → the document is complete, so any gap is the EXTRACTION's fault
//        differ → the scan or the printed totals are wrong; say so, blame nobody
//   3. match extracted rows against source lines, and name what doesn't line up
//
// The power is not in reading the statement better — it is in having TWO
// independent computations of the same quantity, with the statement's own printed
// figures as the referee. A single extraction pass has one opinion and no way to
// check it.
//
// Deliberately dumb and layout-agnostic: it is a cross-check, not a parser. When
// it cannot make sense of a layout it says so and asserts nothing.

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_ABBR = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
// A leading date in any of the shapes statements use, then a description, then one
// or more amounts at the end of the line. Two trailing amounts is the foreign-
// currency shape: <foreign> <home>.
const LINE = new RegExp(
  String.raw`^\s*(` +
  String.raw`(?:${MONTHS})\s+\d{1,2}|(?:${MONTH_ABBR})\s+\d{1,2}|` +
  String.raw`\d{1,2}[\/\-.](?:\d{1,2}|${MONTH_ABBR})[\/\-.]\d{2,4}|` +
  String.raw`\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:${MONTH_ABBR})` +
  String.raw`)\s+(.+?)\s+((?:[\d,]+\.\d{2}\s+)*[\d,]+\.\d{2})\s*$`, "i");
const CR = /\bCR\b/;
// A transaction-shaped line just under one of these headings is a RESTATEMENT of
// something already counted — the 8,290 bug, where "Summary of New Installment
// Plans Created" repeated a transfer listed earlier in the statement.
//
// Deliberately narrow, learned the hard way: a first version also treated
// "Total of ..." as a heading and matched the "Opening Balance Rs / New Credits
// Rs" column header, which swallowed seven real payment rows and reported
// findings against two statements that reconcile perfectly. "Total of ..." lines
// FOLLOW their section rather than head it, and they carry no date so they never
// parse as transactions anyway. Only a genuine forward-looking heading counts,
// and only for the handful of lines directly beneath it.
const SUMMARY_HEADING = /^\s*summary of\b/i;
const SUMMARY_WINDOW = 4; // non-blank lines after the heading
const num = (s) => Number(String(s).replace(/,/g, ""));
const r2 = (n) => Math.round(n * 100) / 100;

// Every transaction-shaped line in the document, with the context needed to judge it.
export function scanLines(pages) {
  const out = [];
  (pages || []).forEach((page, pi) => {
    const lines = String(page).split(/\r?\n/);
    let heading = null, sinceHeading = 0;
    lines.forEach((ln, i) => {
      if (SUMMARY_HEADING.test(ln) && !LINE.test(ln)) { heading = ln.trim().slice(0, 60); sinceHeading = 0; return; }
      if (heading) { if (!ln.trim()) { heading = null; } else if (++sinceHeading > SUMMARY_WINDOW) heading = null; }
      const m = LINE.exec(ln);
      if (!m) return;
      const amounts = m[3].trim().split(/\s+/).map(num).filter(Number.isFinite);
      if (!amounts.length) return;
      const next = lines[i + 1] || "";
      out.push({
        page: pi + 1, line: i, date: m[1].trim(), desc: m[2].trim().slice(0, 60),
        amounts,
        // The home-currency amount is the LAST one: a foreign line prints
        // <foreign> then <home>.
        home: amounts[amounts.length - 1],
        foreign: amounts.length > 1 ? amounts[0] : null,
        // Statements put the CR marker on the line OR on its continuation.
        credit: CR.test(ln) || CR.test(next),
        under_summary: heading,
      });
    });
  });
  return out;
}

const near = (a, b, eps = 0.02) => a != null && b != null && Math.abs(a - b) <= eps;

// The whole check. `printed` is what the statement says about itself.
export function crossCheck({ pages = [], rows = [], printed = {} } = {}) {
  const scanned = scanLines(pages);
  const real = scanned.filter((s) => !s.under_summary);
  const scanCredits = r2(real.filter((s) => s.credit).reduce((t, s) => t + s.home, 0));
  const scanDebits = r2(real.filter((s) => !s.credit).reduce((t, s) => t + s.home, 0));

  // Step 2: does an independent scan of the document reproduce its printed totals?
  // Only if it does can we hold the extraction responsible for a gap.
  const sourceComplete =
    printed.total_credits != null && printed.total_debits != null
      ? near(scanCredits, Number(printed.total_credits), 1) && near(scanDebits, Number(printed.total_debits), 1)
      : null;

  const rowCredits = r2(rows.filter((r) => r.amount > 0).reduce((t, r) => t + r.amount, 0));
  const rowDebits = r2(rows.filter((r) => r.amount < 0).reduce((t, r) => t - r.amount, 0));

  // Step 3: line-by-line. Match on the home amount; a source line whose home
  // amount is unmatched but whose FOREIGN amount was taken is the FX bug.
  const pool = new Map();
  for (const r of rows) {
    const k = r2(Math.abs(r.amount));
    pool.set(k, (pool.get(k) || 0) + 1);
  }
  const take = (v) => { const k = r2(v); if (pool.get(k)) { pool.set(k, pool.get(k) - 1); return true; } return false; };

  const wrongAmount = [], missing = [];
  for (const s of real) {
    if (take(s.home)) continue;
    if (s.foreign != null && take(s.foreign)) {
      wrongAmount.push({ ...s, took: s.foreign, should_be: s.home, understated_by: r2(s.home - s.foreign) });
    } else {
      missing.push(s);
    }
  }
  // Rows the extraction produced that no real source line accounts for. A summary
  // line counted as a transaction lands here.
  const counted = new Set();
  const extra = [];
  for (const [amt, n] of pool) for (let i = 0; i < n; i++) extra.push(amt);
  for (const s of scanned.filter((x) => x.under_summary)) {
    if (extra.some((a) => near(a, s.home))) { counted.add(s); }
  }

  // The same date and amount extracted twice. This is how the 8,290 was actually
  // found by hand, and it needs no notion of headings at all.
  const seen = new Map();
  const duplicates = [];
  for (const r of rows) {
    const k = `${r.date}|${r2(Math.abs(r.amount))}`;
    if (seen.has(k)) duplicates.push({ date: r.date, amount: r2(Math.abs(r.amount)), desc: String(r.desc || r.description || "").slice(0, 50), first: seen.get(k) });
    else seen.set(k, String(r.desc || r.description || "").slice(0, 50));
  }

  const findings = [];
  for (const w of wrongAmount) {
    findings.push(`${w.date} "${w.desc}" prints ${w.foreign} and ${w.home} side by side (a foreign-currency line) — the extraction took ${w.took}, understating it by ${w.understated_by}. The home-currency amount is the one on the right.`);
  }
  for (const m of missing.slice(0, 6)) {
    findings.push(`${m.date} "${m.desc}" ${m.home} appears in the document but not in the extraction.`);
  }
  if (missing.length > 6) findings.push(`…and ${missing.length - 6} more source line(s) with no extracted row.`);
  for (const s of counted) {
    findings.push(`${s.date} "${s.desc}" ${s.home} sits under "${s.under_summary}" — that is a restatement, not a transaction, and it has been counted as one.`);
  }
  // Duplicates are a LOCALISATION aid for a known over-count, never a standalone
  // alarm. Two charges of the same amount on the same day are ordinary — two ₹2
  // Uber rides, two coffees. Reported only when the arithmetic already says a side
  // is over-counted, and then the ones whose amount exactly explains the gap.
  // Without this gate an earlier version raised nine duplicate findings against a
  // statement that reconciles to the rupee, which cannot have double-counting:
  // its own totals prove it.
  const overDebits = printed.total_debits != null ? r2(rowDebits - Number(printed.total_debits)) : null;
  const overCredits = printed.total_credits != null ? r2(rowCredits - Number(printed.total_credits)) : null;
  const overBy = [overDebits, overCredits].find((x) => x != null && x > 0.02) || null;
  if (overBy && duplicates.length) {
    const exact = duplicates.filter((d) => near(d.amount, overBy));
    for (const d of (exact.length ? exact : duplicates)) {
      findings.push(`${d.date} ${d.amount} appears twice in the extraction ("${d.first}" and "${d.desc}")${near(d.amount, overBy) ? ` — exactly the ${overBy} this statement is over-counted by` : ""}, so it is being counted twice.`);
    }
  }
  // If an independent scan cannot reproduce the statement's own printed totals,
  // the scan does not understand this layout — and nothing it says about
  // individual lines can be trusted. Report that one fact and withdraw the rest,
  // rather than handing over confident nonsense.
  if (sourceComplete === false) {
    return {
      scanned: scanned.length, transaction_lines: real.length,
      scan_credits: scanCredits, scan_debits: scanDebits, row_credits: rowCredits, row_debits: rowDebits,
      source_complete: false, wrong_amount: [], missing: [], summary_lines_counted: [], duplicates,
      findings: [`A plain scan of this document totals ${scanCredits} in and ${scanDebits} out, which does not match its own printed totals (${printed.total_credits} in / ${printed.total_debits} out) — this cross-check does not understand this layout, so it is not making any claim about individual rows.`],
      clean: false, inconclusive: true,
    };
  }

  return {
    duplicates,
    scanned: scanned.length, transaction_lines: real.length,
    scan_credits: scanCredits, scan_debits: scanDebits,
    row_credits: rowCredits, row_debits: rowDebits,
    source_complete: sourceComplete,
    wrong_amount: wrongAmount, missing, summary_lines_counted: [...counted],
    findings,
    clean: findings.length === 0,
  };
}
