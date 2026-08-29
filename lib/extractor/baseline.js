// v1 of the extractor module — the behaviour that was hard-coded in
// lib/statements/extract.js, now expressed in the evolvable module contract so
// the lab can improve on it. Every later version starts as a rewrite of this.
export const BASELINE_NOTES = "baseline — the original hard-coded extractor, ported to the module contract";

export const BASELINE_SOURCE = `({
  prompt: \`You convert a bank OR credit-card statement into structured transactions.
You are given the RAW TEXT already extracted from the PDF, so every number is
exact — COPY numbers character-for-character; never round, re-compute, or invent
one. Return STRICT JSON only, no prose, no markdown fences.

SIGN CONVENTION (unify everything to this): "amount" is signed cashflow for the account holder.
  negative = money OUT  (debit, withdrawal, purchase, card charge, EMI, fee)
  positive = money IN   (deposit, salary, refund, interest, cashback, payment received)
Determine the sign from whichever the statement uses:
  - Separate Debit/Withdrawal vs Credit/Deposit columns -> debit negative, credit positive.
  - A single UNSIGNED "Amount" + a running "Balance" -> use the balance movement:
      bank account: balance DOWN vs the previous row -> negative; UP -> positive.
      credit card:  outstanding UP -> negative (a charge); DOWN -> positive (payment/refund).
  - A signed amount, Dr/Cr suffix, trailing CR/DR, parentheses or minus -> honor it.

DATES -> ISO YYYY-MM-DD.
  - If a row's date has no year ("01 Sep", "01-Apr"), infer it from the PERIOD given below;
    handle a period crossing a year boundary (Sep-Dec = first year, Jan-Mar = next).
  - If the date is printed once as a header for several rows below it, carry it forward
    until the next date header.
  - Disambiguate DD/MM vs MM/DD using the currency/country and the period.

DESCRIPTIONS: merge wrapped/multi-line narrations into one clean string; keep the
merchant/counterparty + reference; strip repeated dates and column headers.

SKIP non-transactions: page headers/footers, column headers, Opening/Closing Balance,
B/F, C/F, carried-forward, sub-totals, totals, interest-summary boxes, page numbers, ads.

NUMBERS: handle Indian grouping (1,15,02,632.61) and international; drop currency symbols
and thousands separators; keep decimals. Foreign-currency card lines: use the INR (home)
amount for "amount"; note the original currency+amount in "description".

Output EXACTLY this JSON shape:
{
  "statement_type": "bank" | "card",
  "currency": "INR",
  "period": {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} | null,
  "opening_balance": <number|null>,
  "closing_balance": <number|null>,
  "transactions": [
    {"date":"YYYY-MM-DD","description":"...","amount": -182.00, "balance": 19544.18}
  ]
}
Every transaction gets its own object, in statement order. "balance" = the running
balance printed on that row (null if there is no balance column). Return ONLY the JSON.\`,

  preprocess(text, ctx) {
    return text;
  },

  chunk(text, ctx) {
    // Line-boundary windows small enough that one model call finishes inside the
    // gateway's edge timeout. ~4500 chars is roughly 60-90 transactions.
    var MAX = 4500;
    var lines = text.split(/\\r?\\n/);
    var chunks = [];
    var buf = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (buf && buf.length + line.length + 1 > MAX) { chunks.push(buf); buf = ""; }
      buf += (buf ? "\\n" : "") + line;
    }
    if (buf.replace(/\\s/g, "")) chunks.push(buf);
    return chunks.length ? chunks : [text];
  },

  postprocess(txns, ctx) {
    return txns;
  },
})`;
