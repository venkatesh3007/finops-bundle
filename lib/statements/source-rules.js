// WHERE A STATEMENT POSTS FROM — its home leg.
//
// Until now this was guessed from the filename at upload time and never
// revisited, so two of the three kinds in this book were simply wrong: `primary`
// is two different Amex cards that both landed on Assets:Bank:Primary, and `fed`
// pointed at Assets:Bank:Fed, an account that was never open (the chart has
// Assets:Bank:Federal). set_row_account moves the OTHER leg, so nothing could
// re-home a statement.
//
// A rule is (kind, match, account). Stored in `decisions` under a `source:`
// prefix — the same table that already holds `payee:` precedents and
// `rules:extract` — so this needs no migration and shares their durability.
import { query } from "../db.js";

const PREFIX = "source:";
export const ACCOUNT_RE = /^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z0-9][A-Za-z0-9-]*)+$/;

// key: "source:<kind>" for the kind default, "source:<kind>:<match>" for a match
// rule. A kind never contains a colon, so the first one after it splits cleanly
// and `match` may contain colons of its own.
const keyFor = (kind, match) => `${PREFIX}${kind}${match ? `:${match}` : ""}`;
function parseKey(key) {
  const rest = key.slice(PREFIX.length);
  const i = rest.indexOf(":");
  return i === -1 ? { kind: rest, match: null } : { kind: rest.slice(0, i), match: rest.slice(i + 1) };
}

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

export async function accountIsOpen(entity, account) {
  const r = await query(
    `select 1 from accounts a join entities e on e.id = a.entity_id where e.slug=$1 and a.name=$2`,
    [entity, account]);
  return r.length > 0;
}

export async function listSourceRules(entity) {
  const entId = await entityId(entity);
  const rows = await query(
    "select key, decision, rationale from decisions where entity_id=$1 and key like $2 order by key",
    [entId, `${PREFIX}%`]);
  return rows.map((r) => ({ ...parseKey(r.key), account: r.decision, why: r.rationale || null }));
}

export async function setSourceRule(entity, { kind, account, match = null, remove = false, why = null }) {
  const entId = await entityId(entity);
  const m = match && String(match).trim() ? String(match).trim() : null;
  if (remove) {
    const r = await query("delete from decisions where entity_id=$1 and key=$2 returning key", [entId, keyFor(kind, m)]);
    return { removed: r.length > 0, kind, match: m };
  }
  if (!ACCOUNT_RE.test(account || "")) throw new Error(`"${account}" is not a valid account name`);
  if (!(await accountIsOpen(entity, account))) throw new Error(`${account} is not open — use open_account first.`);
  await query(
    `insert into decisions (entity_id, key, decision, rationale) values ($1,$2,$3,$4)
       on conflict (entity_id,key) do update set decision=excluded.decision, rationale=excluded.rationale`,
    [entId, keyFor(kind, m), account, why || "statement home account"]);
  return { kind, match: m, account };
}

// Which account does THIS statement post from?
//
//   { account, source: "rule" | "default" | null, matched: [...] }
//
// A `match` rule beats the kind default. Two match rules hitting the same
// statement is a genuine ambiguity, not something to break the tie on — it
// returns no account and names both, because guessing here silently books a
// whole statement to the wrong side of the balance sheet.
//
// Once a kind has ANY rule the built-in guess is out of the picture: a statement
// matching nothing gets no home account and is blocked at import rather than
// quietly landing somewhere plausible.
export function resolveHome(rules, { kind, filename = "", text = "" }) {
  const forKind = rules.filter((r) => r.kind === kind);
  // kind_has_rules is the difference between "nobody has said anything about this
  // kind, keep the filename guess" and "rules exist and this statement matched
  // none of them, so it has NO home". Collapsing the two silently re-enables the
  // guess for exactly the statements a rule set was meant to catch.
  if (!forKind.length) return { account: null, source: null, matched: [], kind_has_rules: false };

  const hay = `${filename}\n${text}`.toLowerCase();
  const hits = forKind.filter((r) => r.match && hay.includes(r.match.toLowerCase()));
  if (hits.length > 1) return { account: null, source: null, matched: hits, ambiguous: true, kind_has_rules: true };
  if (hits.length === 1) return { account: hits[0].account, source: "rule", matched: hits, kind_has_rules: true };

  const dflt = forKind.find((r) => !r.match);
  if (dflt) return { account: dflt.account, source: "rule", matched: [dflt], kind_has_rules: true };
  return { account: null, source: null, matched: [], kind_has_rules: true };
}

// The text a rule's `match` is tested against: the filename plus the WHOLE
// extracted statement, header included. A card number lives in the header, not
// in any transaction row, so matching rows alone would never find it.
export const matchableText = (d) =>
  [d.meta?.text || "", ...(Array.isArray(d.meta?.pages) ? d.meta.pages : [])].join("\n");
