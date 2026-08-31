// Is the extraction COMPLETE? The reconciler answers "are these rows correct";
// this answers "are these all the rows". Different question, and on this corpus
// the more dangerous one: across 20 statements re-run on 2026-08-31 there were
// ZERO wrong rows and twelve statements with missing ones.
//
// Everything here is deterministic and layout-agnostic — no model, no per-bank
// rules — and every finding carries a `chunks` list so a repair can re-run just
// the part that looks wrong instead of the whole statement.

const DATE_TOKEN = /\b(?:\d{1,2}[\/\-.][A-Za-z0-9]{2,9}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\b)/;
const AMOUNT_TOKEN = /\d[\d,]*\.\d{2}\b/;
const day = 24 * 60 * 60 * 1000;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || "").slice(0, 10));
const parse = (s) => { const t = Date.parse(`${iso(s)}T00:00:00Z`); return Number.isNaN(t) ? null : t; };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / day);

// A line that carries both a date and a money amount is a plausible transaction.
// Deliberately loose: it is a COUNT used for comparison, not a parser.
export function candidateLines(text) {
  return String(text || "").split(/\r?\n/).filter((l) => DATE_TOKEN.test(l) && AMOUNT_TOKEN.test(l)).length;
}

// Do the extracted rows actually span the period the statement declares?
// Catches the failure that is invisible to every balance check: 2026-07-08 came
// back with 45 rows covering 2026-06-16 to 2026-06-17 — two days of a month —
// and reconciled 0 breaks, because the rows it DID return were self-consistent.
export function periodCoverage(rows, period) {
  const dates = rows.map((r) => iso(r.date)).filter((d) => parse(d) != null).sort();
  if (!dates.length) return { ok: false, reason: "no dated rows at all" };
  const first = dates[0], last = dates[dates.length - 1];
  const span = { first, last, days: daysBetween(first, last) + 1 };
  if (!period?.from || !period?.to) return { ...span, ok: null, reason: "the statement did not declare a period" };
  const startGap = daysBetween(period.from, first);
  const endGap = daysBetween(last, period.to);
  const periodDays = daysBetween(period.from, period.to) + 1;
  // A statement legitimately has quiet days at either end, so allow a few; a
  // fortnight of nothing at one end means rows are missing, not that you didn't spend.
  const TOLERANCE = 7;
  const problems = [];
  if (startGap > TOLERANCE) problems.push(`nothing in the first ${startGap} days (period opens ${period.from}, first row ${first})`);
  if (endGap > TOLERANCE) problems.push(`nothing in the last ${endGap} days (last row ${last}, period closes ${period.to})`);
  const covered = periodDays > 0 ? Math.max(0, Math.min(1, span.days / periodDays)) : null;
  return { ...span, period_days: periodDays, start_gap: startGap, end_gap: endGap, covered, ok: problems.length === 0, problems };
}

// Statements are chronological. Rows that are not tell you either the extractor
// reordered them (harmless, but it hides truncation) or dates are being misparsed
// (harmful). 2025-05-08 came back with its last row dated BEFORE its first.
export function ordering(rows) {
  const dates = rows.map((r) => iso(r.date)).filter((d) => parse(d) != null);
  if (dates.length < 2) return { ok: true, monotonic: true, out_of_order: 0 };
  let out = 0;
  for (let i = 1; i < dates.length; i++) if (parse(dates[i]) < parse(dates[i - 1])) out++;
  const reversedIsSorted = out === dates.length - 1;
  return {
    ok: out === 0, monotonic: out === 0, out_of_order: out,
    note: out === 0 ? "" : reversedIsSorted
      ? "rows are in reverse date order — the statement may list newest first"
      : `${out} row(s) are dated before the row above them, so these are not in statement order`,
  };
}

// Per-chunk accounting: how many lines LOOK like transactions versus how many
// rows came back. This is what turns "290,395.32 is missing somewhere" into
// "chunk 5 has 14 transaction-looking lines and returned 3 rows" — a place to
// look, and the targeting signal the repair loop needs.
export function chunkAccounting(chunkTexts, rowsPerChunk) {
  return (chunkTexts || []).map((text, i) => {
    const candidates = candidateLines(text);
    const returned = rowsPerChunk?.[i] ?? 0;
    // Under-extraction only counts when there was something to miss. A chunk of
    // terms-and-conditions has no candidates and rightly returns nothing.
    const short = candidates >= 3 && returned < Math.ceil(candidates * 0.5);
    return { chunk: i, candidates, returned, short };
  });
}

// One verdict over all of it, plus the chunks a repair should target.
export function completeness({ rows = [], chunkTexts = [], rowsPerChunk = [], period = null } = {}) {
  const coverage = periodCoverage(rows, period);
  const order = ordering(rows);
  const chunks = chunkAccounting(chunkTexts, rowsPerChunk);
  const shortChunks = chunks.filter((c) => c.short);
  const findings = [];
  if (coverage.ok === false) findings.push(...(coverage.problems || [coverage.reason]).map((p) => `period coverage: ${p}`));
  for (const c of shortChunks) findings.push(`part ${c.chunk + 1} of the document has ${c.candidates} transaction-looking lines but returned ${c.returned} rows`);
  if (!order.ok && order.note) findings.push(`row order: ${order.note}`);
  return {
    coverage, ordering: order, chunks,
    suspect_chunks: shortChunks.map((c) => c.chunk),
    complete: findings.length === 0,
    findings,
  };
}

// Cross-statement continuity: this statement's opening should be the previous
// one's closing, for the same account. The ONLY check that can notice a statement
// you never uploaded — everything else verifies a statement against itself.
// Pure on purpose: the caller does the DB read and passes plain records.
// Each: { id, filename, account, from, to, opening, closing }
export function statementChain(records) {
  const byAccount = new Map();
  for (const r of records || []) {
    if (!r.account || !r.from) continue;
    if (!byAccount.has(r.account)) byAccount.set(r.account, []);
    byAccount.get(r.account).push(r);
  }
  const findings = [];
  for (const [account, list] of byAccount) {
    list.sort((a, b) => String(a.from).localeCompare(String(b.from)));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const gapDays = prev.to && cur.from ? daysBetween(prev.to, cur.from) : null;
      if (gapDays != null && gapDays > 1) {
        findings.push({ account, kind: "missing_statement", after: prev.filename, before: cur.filename,
          detail: `no statement covers ${iso(prev.to)} → ${iso(cur.from)} (${gapDays - 1} day(s)) — a statement is missing` });
      }
      if (prev.closing != null && cur.opening != null) {
        const diff = Math.round((Number(cur.opening) - Number(prev.closing)) * 100) / 100;
        if (Math.abs(diff) > 0.02) {
          findings.push({ account, kind: "balance_jump", after: prev.filename, before: cur.filename, diff,
            detail: `${cur.filename} opens at ${cur.opening} but ${prev.filename} closed at ${prev.closing} — a gap of ${diff}` });
        }
      }
    }
  }
  return findings;
}
