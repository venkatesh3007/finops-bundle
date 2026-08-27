// Statement parsing — runs IN THE BROWSER (also plain Node for tests). Pure
// functions, no I/O: callers hand in a text grid (CSV/XLSX) or pdf.js text
// lines and get back exact rows { date, desc, amount, balance }.
//
// Port of the heuristics that used to live in scripts/statement_ingest.py
// (header-junk-tolerant grids, Indian number formats, debit/credit or signed
// columns, date-leading PDF lines). Numbers are extracted deterministically —
// the on-device model NEVER transcribes amounts, it only classifies rows.

// ── Bank / card inference from the filename ────────────────────────────────
export const KNOWN_BANKS = [
  [/hdfc/i, "HDFC"], [/icici/i, "ICICI"], [/\bsbi\b/i, "SBI"], [/\baxis\b/i, "Axis"],
  [/kotak/i, "Kotak"], [/idbi/i, "IDBI"], [/yes\s*bank/i, "Yes"], [/indusind/i, "IndusInd"],
  [/federal/i, "Federal"], [/\bpnb\b/i, "PNB"], [/canara/i, "Canara"], [/union\s*bank/i, "Union"],
  [/\brbl\b/i, "RBL"], [/idfc/i, "IDFC"], [/amex|american\s*express/i, "Amex"],
  [/\bciti(?:\s*bank)?\b/i, "Citi"], [/hsbc/i, "HSBC"], [/standard\s*chartered|\bscb\b/i, "StandardChartered"],
  [/\bbob\b|bank\s*of\s*baroda/i, "BOB"], [/central\s*bank/i, "Central"],
  [/\bdcb\b/i, "DCB"], [/bandhan/i, "Bandhan"], [/equitas/i, "Equitas"],
  [/\bau\s*(bank|small)/i, "AU"], [/paytm/i, "Paytm"], [/\bslice\b/i, "Slice"],
  [/onecard/i, "OneCard"], [/\bboi\b|bank\s*of\s*india/i, "BOI"], [/\buco\b/i, "UCO"],
  [/\bsbm\b/i, "SBM"], [/razorpay/i, "RazorpayX"],
];
const STOPWORDS = new Set(["statement", "account", "txn", "bank", "card", "credit", "debit", "csv", "xlsx",
  "xls", "pdf", "monthly", "export", "download", "transactions", "transaction", "history", "summary",
  "report", "final", "copy", "new", "the", "for", "data", "inbox", "upload", "file", "and"]);
const CARD_ISSUERS = new Set(["Amex", "OneCard", "Slice"]);

function cardLast4(joined, name) {
  const pat = new RegExp("(?:x{2,}|\\*{2,}|••|ending(?:\\s*in)?|card(?:\\s*(?:no|number|ending))?|" +
    name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")[-_ #:]*(\\d{4})", "g");
  let m;
  while ((m = pat.exec(joined))) {
    const d = Number(m[1]);
    if (!(d >= 1900 && d <= 2099)) return m[1];
  }
  return "";
}

// -> { account, slug, kind: 'card'|'bank', name }
export function inferBankAccount(filename, hints = {}) {
  const joined = [hints.bank, hints.source, hints.kind, filename].filter(Boolean).join(" ").toLowerCase();
  for (const [re, name] of KNOWN_BANKS) {
    if (re.test(joined)) {
      const isCard = CARD_ISSUERS.has(name) || /credit\s*card|\bcredit\b|card\s*ending|\bcc\b/i.test(joined);
      if (isCard) {
        const last4 = cardLast4(joined, name);
        return { account: `Liabilities:Card:${name}${last4}`, slug: last4 ? `${name.toLowerCase()}-${last4}` : name.toLowerCase(), kind: "card", name };
      }
      return { account: `Assets:Bank:${name}`, slug: name.toLowerCase(), kind: "bank", name };
    }
  }
  const stem = filename.replace(/\.[^.]+$/, "");
  for (const tok of stem.match(/[A-Za-z]{3,}/g) || []) {
    if (!STOPWORDS.has(tok.toLowerCase())) {
      const name = tok[0].toUpperCase() + tok.slice(1).toLowerCase();
      return { account: `Assets:Bank:${name}`, slug: name.toLowerCase(), kind: "bank", name };
    }
  }
  return { account: "Assets:Bank:Primary", slug: "primary", kind: "bank", name: "Primary" };
}

// ── Dates (day-first, Indian statements) ───────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
};
const year4 = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

export function parseDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) return iso(year4(+m[3]), +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{2,4})\b/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? iso(year4(+m[3]), mo, +m[1]) : null;
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? iso(+m[3], mo, +m[2]) : null;
  }
  return null;
}

// ── Amounts (₹, commas, parentheses, Dr/Cr suffix) ─────────────────────────
export function parseAmount(v, { allowCrDr = false } = {}) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let crdr = null;
  const m = s.match(/\b(Cr|Dr)\.?\s*$/i);
  if (m) { crdr = m[1].toUpperCase(); s = s.slice(0, m.index).trim(); }
  s = s.replace(/₹|Rs\.?|INR/gi, "").trim();
  let sign = 1;
  if (s.startsWith("(") && s.endsWith(")")) { sign = -1; s = s.slice(1, -1).trim(); }
  else if (s.startsWith("-")) { sign = -1; s = s.slice(1).trim(); }
  else if (s.startsWith("+")) s = s.slice(1).trim();
  s = s.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  let val = sign * Number(s);
  if (allowCrDr && crdr === "DR") val = -Math.abs(val);
  else if (allowCrDr && crdr === "CR") val = Math.abs(val);
  return Math.round(val * 100) / 100;
}

export const normalizeDesc = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);
export const rowKey = (r) => `${r.date}|${Number(r.amount).toFixed(2)}|${normalizeDesc(r.desc)}`;

// "UPI/1234/Swiggy" → payee "Swiggy"; else the text before the first , or /
export function derivePayee(desc) {
  const d = String(desc || "").trim();
  if (!d) return "Statement";
  const m = d.match(/(?:UPI|NEFT|IMPS|RTGS)[/\-]\S+[/\-](.+)$/i);
  let payee = m ? m[1].trim().split(/[/,]/)[0].trim() : d.split(/[,/]/)[0].trim();
  return (payee || d).slice(0, 60);
}

// ── Tabular (CSV / XLSX grid) ──────────────────────────────────────────────
function classifyHeader(cell) {
  const c = String(cell ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^[ .:_-]+|[ .:_-]+$/g, "");
  if (!c) return null;
  if (c.includes("date")) return "date";
  if (c.includes("withdrawal") || c.includes("debit") || c === "dr") return "debit";
  if (c.includes("deposit") || c.includes("credit") || c === "cr") return "credit";
  if (c.includes("balance")) return "balance";
  if (c.includes("amount") || c === "amt") return "amount";
  if (["narration", "description", "particulars", "details", "remarks", "narrative"].some((k) => c.includes(k))) return "desc";
  return null;
}

export function findHeader(grid, maxScan = 40) {
  for (let i = 0; i < Math.min(grid.length, maxScan); i++) {
    const roles = grid[i].map(classifyHeader);
    if (roles.includes("date") && (roles.includes("amount") || roles.includes("debit") || roles.includes("credit"))) {
      const colmap = {};
      roles.forEach((r, idx) => { if (r && !(r in colmap)) colmap[r] = idx; });
      return { headerIdx: i, colmap };
    }
  }
  return null;
}

export function parseGrid(grid) {
  const h = findHeader(grid);
  if (!h) return { rows: [], confidence: "LOW", note: "no header row with a date + amount/debit/credit column" };
  const { headerIdx, colmap } = h;
  const cell = (r, k) => (colmap[k] == null ? null : r[colmap[k]]);
  const rows = [];
  for (const r of grid.slice(headerIdx + 1)) {
    const date = parseDate(cell(r, "date"));
    if (!date) continue;
    const desc = String(cell(r, "desc") ?? "").trim();
    let amount = null;
    if ("debit" in colmap || "credit" in colmap) {
      const deb = parseAmount(cell(r, "debit")) || 0, cred = parseAmount(cell(r, "credit")) || 0;
      if (deb) amount = -Math.abs(deb); else if (cred) amount = Math.abs(cred);
    }
    if (amount == null && "amount" in colmap) amount = parseAmount(cell(r, "amount"), { allowCrDr: true });
    if (!amount) continue;
    const balance = "balance" in colmap ? parseAmount(cell(r, "balance"), { allowCrDr: true }) : null;
    rows.push({ date, desc, amount, balance });
  }
  return { rows, confidence: rows.length >= 3 ? "HIGH" : "LOW", note: rows.length ? "" : "no data rows under the header" };
}

// Minimal RFC-4180-ish CSV → grid (delimiter sniffed from , ; tab |).
export function csvToGrid(text) {
  text = text.replace(/^﻿/, "");
  const sample = text.slice(0, 4096);
  const delim = [",", ";", "\t", "|"].map((d) => [d, (sample.match(new RegExp("\\" + d, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const grid = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); grid.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); grid.push(row); }
  return grid;
}

// ── PDF (pdf.js text items → layout lines → date-leading rows) ─────────────
const PDF_DATE_LEAD = /^\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-]\d{2,4})\b/;
// no leading whitespace in the match — a token's offset must be where its digits are
const MONEY_TOKEN = /(?:₹\s*)?\d[\d,]*\.\d{2}\s*(?:Cr|Dr)?/gi;

// Group pdf.js textContent items into lines by y, order by x, join with
// spacing proportional to the gap (mimics `pdftotext -layout`).
export function pdfItemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const x = it.transform[4], y = Math.round(it.transform[5]);
    let line = rows.find((l) => Math.abs(l.y - y) <= 2);
    if (!line) { line = { y, items: [] }; rows.push(line); }
    line.items.push({ x, str: it.str, w: it.width || 0 });
  }
  rows.sort((a, b) => b.y - a.y);
  // Pad gaps proportionally to the glyph width so character offsets in the
  // line approximate x positions on the page (what `pdftotext -layout` does);
  // parsePdfLines maps money tokens to header columns by those offsets.
  const widths = items.filter((it) => it.str && it.width).map((it) => it.width / it.str.length).sort((a, b) => a - b);
  const charW = widths.length ? widths[Math.floor(widths.length / 2)] : 5;
  return rows.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let out = "";
    for (const it of l.items) {
      const col = Math.round(it.x / charW);
      if (col > out.length) out += " ".repeat(col - out.length);
      else if (out && !out.endsWith(" ") && !it.str.startsWith(" ")) out += " ";
      out += it.str;
    }
    return out;
  });
}

// Header-driven column roles: "Date  Particulars  Withdrawal  Deposit  Balance"
// → character offsets for debit/credit/amount/balance so a money token is
// assigned by its POSITION on the line, not by how many tokens survived.
const HEADER_WORDS = [
  [/withdrawal|debit|\bdr\b/i, "debit"], [/deposit|credit|\bcr\b/i, "credit"],
  [/balance/i, "balance"], [/amount|\bamt\b/i, "amount"],
];
function headerColumns(line) {
  if (!/date/i.test(line)) return null;
  const cols = {};
  for (const [re, role] of HEADER_WORDS) {
    const m = line.match(re);
    if (m && !(role in cols)) cols[role] = m.index + m[0].length / 2;
  }
  return "balance" in cols || "debit" in cols || "credit" in cols || "amount" in cols ? cols : null;
}
const MONEY_ONLY_LINE = /^\s*((?:₹\s*)?\d[\d,]*\.\d{2}\s*(?:Cr|Dr)?\s*)+$/i;

// The "Opening Balance … ₹X" figure from a statement summary (used to sign the
// very first row when amounts are unsigned).
export function findOpeningBalance(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/opening balance|balance b\/?f|brought forward/i.test(lines[i])) {
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        const m = lines[j].match(/(?:₹\s*)?([\d,]+\.\d{2}|[\d,]{2,})/);
        if (m) { const v = parseAmount(m[1]); if (v != null) return v; }
      }
    }
  }
  return null;
}

// Re-sign an unsigned "Amount" column from the running Balance: debit if the
// balance went down, credit if up. Mutates rows in place. Keeps the printed
// magnitude when it agrees with |delta| (else trusts the delta — also repairs
// pdf.js glitches like "954 .00").
export function applyBalanceSign(rows, opening) {
  let prev = opening;
  for (const r of rows) {
    if (r.balance == null) continue;
    if (prev == null) { prev = r.balance; continue; }
    const delta = Math.round((r.balance - prev) * 100) / 100;
    prev = r.balance;
    const mag = Math.abs(Math.abs(delta) - Math.abs(r.amount)) < 0.5 ? Math.abs(r.amount) : Math.abs(delta);
    if (mag) { r.amount = (delta < 0 ? -1 : 1) * mag; r.sign_flipped = true; }
  }
  return rows;
}

export function parsePdfLines(lines) {
  const rows = [];
  let cols = null;
  let i = 0; const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (!cols) {
      const c = headerColumns(line);
      if (c) {
        cols = c;
        // a "Balance" header pushed onto its own line = the right-most column wrapped
        if (!("balance" in cols) && i + 1 < n && /^\s*balance\s*$/i.test(lines[i + 1])) { cols.balance = Infinity; i++; }
        i++; continue;
      }
    }
    const m = line.match(PDF_DATE_LEAD);
    if (!m) { i++; continue; }
    const date = parseDate(m[1]);
    const rest = line.slice(m[0].length);
    const cont = []; let j = i + 1;
    while (j < n && cont.length < 4) {
      const nxt = lines[j];
      if (!nxt.trim() || PDF_DATE_LEAD.test(nxt) || headerColumns(nxt)) break;
      cont.push(nxt.trim()); j++;
    }
    // money tokens on the main line carry a position; wrapped money-only
    // continuation lines (a Balance column pushed to the next line) carry none
    const tokens = [...rest.matchAll(MONEY_TOKEN)].map((mm) => ({ v: parseAmount(mm[0], { allowCrDr: true }), pos: m[0].length + mm.index + mm[0].trimEnd().length / 2, raw: mm[0].trim() })).filter((t) => t.v != null);
    for (const c of cont) if (MONEY_ONLY_LINE.test(c)) for (const mm of c.matchAll(MONEY_TOKEN)) { const v = parseAmount(mm[0], { allowCrDr: true }); if (v != null) tokens.push({ v, pos: null, raw: mm[0] }); }
    if (!date || !tokens.length) { i = j > i + 1 ? j : i + 1; continue; }
    const firstMoney = rest.search(MONEY_TOKEN);
    let desc = (firstMoney >= 0 ? rest.slice(0, firstMoney) : rest).trim();
    const extra = cont.filter((c) => !MONEY_ONLY_LINE.test(c) && !new RegExp(MONEY_TOKEN.source, "i").test(c)).join(" ");
    if (extra) desc = (desc + " " + extra).trim();

    let amount = null, balance = null;
    if (cols) {
      // positioned tokens → nearest header column; unpositioned → whatever role is still empty (balance first)
      const roles = {};
      for (const t of tokens) {
        let role = null;
        if (t.pos != null) {
          let best = Infinity;
          for (const [r, x] of Object.entries(cols)) { const d = x === Infinity ? 1e9 : Math.abs(t.pos - x); if (d < best) { best = d; role = r; } }
        } else role = "balance"; // wrapped money-only line = the right-most (balance) column
        if (role && !(role in roles)) roles[role] = t;
      }
      if (roles.debit && roles.debit.v) amount = -Math.abs(roles.debit.v);
      else if (roles.credit && roles.credit.v) amount = Math.abs(roles.credit.v);
      else if (roles.amount) amount = roles.amount.v;
      if (roles.balance) balance = roles.balance.v;
    }
    if (amount == null) {
      const vals = tokens.map((t) => t.v);
      if (vals.length >= 3) { const [w, d, b] = [Math.abs(vals[0]), Math.abs(vals[1]), vals[2]]; if (w) amount = -w; else if (d) amount = d; balance = b; }
      else if (vals.length === 2) { amount = vals[0]; balance = vals[1]; }
      else if (vals.length === 1) amount = vals[0];
    }
    if (amount && date) rows.push({ date, desc: desc.replace(/\s{2,}/g, " "), amount, balance });
    i = j > i + 1 ? j : i + 1;
  }
  // A single UNSIGNED "Amount" column alongside a running Balance (Federal
  // date-leading statements): every amount parsed the SAME sign. Recover the
  // real direction from the balance delta so debits become negative. Trigger
  // whenever rows actually carry balances (however they were extracted — the
  // Balance header isn't always detected on date-leading layouts); the
  // all-same-sign guard means real debit/credit statements are never touched.
  if (rows.length >= 2) {
    const withBal = rows.filter((r) => r.balance != null).length;
    if (withBal >= rows.length * 0.8 && (rows.every((r) => r.amount >= 0) || rows.every((r) => r.amount <= 0))) {
      applyBalanceSign(rows, findOpeningBalance(lines));
    }
  }
  // Fallback for grouped, year-less layouts (e.g. Federal Bank): the date is a
  // section header ("01 Sep") with no year and no amount, transactions wrap over
  // several lines below it, and the Amount column is unsigned — direction is only
  // knowable from the running balance. Recover sign+magnitude from the balance delta.
  if (rows.length === 0) {
    const grouped = parseGroupedDatePdf(lines);
    if (grouped.rows.length) return grouped;
  }
  return { rows, confidence: rows.length >= 3 ? "HIGH" : "LOW", note: rows.length ? "" : "no date-leading lines with amounts found", columns: cols };
}

// Year-less section dates + balance-delta signing. Verified on a full Federal Bank
// statement: 791/791 txns, running balance reconciles to the printed closing balance.
const YEARLESS_DATE = /^\s*(\d{1,2})\s+([A-Za-z]{3})\s*$/;
const MONEY_LOOSE = /\d[\d, ]*\.\d{2}/g; // tolerant of pdf.js splits like "954 .00"
export function parseGroupedDatePdf(lines) {
  // statement period → per-month year map (handles an FY-boundary span)
  let sM, sY, eM, eY;
  const pr = /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s+to\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i;
  for (const l of lines) {
    const m = l.match(pr);
    if (m) { sM = MONTHS[m[2].slice(0, 3).toLowerCase()]; sY = +m[3]; eM = MONTHS[m[5].slice(0, 3).toLowerCase()]; eY = +m[6]; break; }
  }
  const yearFor = (mon) => (sY == null ? null : sY === eY ? sY : (mon >= sM ? sY : eY));
  if (sY == null) return { rows: [] }; // no period → can't assign years, don't guess
  // seed the running balance from the "Opening Balance" figure
  let prevBal = null;
  for (let i = 0; i < lines.length; i++) {
    if (/opening balance/i.test(lines[i])) {
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        const m = lines[j].match(/₹\s*([\d,]+(?:\.\d{2})?)/);
        if (m) { prevBal = parseAmount(m[1]); break; }
      }
      if (prevBal != null) break;
    }
  }
  let curDate = null, pending = [];
  const rows = [];
  for (const raw of lines) {
    const dh = raw.match(YEARLESS_DATE);
    if (dh) { const mon = MONTHS[dh[2].toLowerCase()]; if (mon) { curDate = iso(yearFor(mon), mon, +dh[1]); pending = []; } continue; }
    if (!curDate) continue;
    const toks = [...raw.matchAll(MONEY_LOOSE)].map((m) => parseAmount(m[0].replace(/\s/g, ""))).filter((v) => v != null);
    const textPart = raw.replace(MONEY_LOOSE, " ").replace(/\s{2,}/g, " ").trim();
    if (toks.length >= 2) {
      const bal = toks[toks.length - 1], amtCol = toks[toks.length - 2];
      const desc = ((pending.join(" ") + " " + textPart).replace(/\s{2,}/g, " ").trim()) || "Statement";
      let signed;
      if (prevBal != null) {
        const delta = Math.round((bal - prevBal) * 100) / 100;
        const mag = Math.abs(Math.abs(delta) - amtCol) < 0.5 ? amtCol : Math.abs(delta); // prefer the printed amount; fall back to |delta|
        signed = (delta < 0 ? -1 : 1) * mag;
      } else signed = -amtCol; // no opening balance → assume a debit (rare; first row only)
      if (curDate && signed) rows.push({ date: curDate, desc: desc.slice(0, 120), amount: signed, balance: bal });
      prevBal = bal; pending = [];
    } else if (textPart) pending.push(textPart);
  }
  return { rows, confidence: rows.length >= 3 ? "HIGH" : "LOW", note: rows.length ? "" : "no grouped year-less dates found", grouped: true };
}

// Card statements print charges as positive "amount" columns. If a file is a
// card and the parsed rows are overwhelmingly positive with no balance column,
// flip the sign so a charge is an outflow (negative) like a bank debit.
export function normalizeCardSigns(rows, kind) {
  if (kind !== "card" || !rows.length) return rows;
  const pos = rows.filter((r) => r.amount > 0).length;
  const hasBal = rows.some((r) => r.balance != null);
  if (!hasBal && pos / rows.length > 0.8) return rows.map((r) => ({ ...r, amount: -r.amount, sign_flipped: true }));
  return rows;
}
