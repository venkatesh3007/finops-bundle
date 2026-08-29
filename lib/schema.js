// Auto-generated from db/*.sql — the schema the admin import ensures on boot.
export const SCHEMA_SQL = String.raw`
-- finance-ops — Postgres general ledger (multi-tenant double-entry).
--
-- The re-platform target: replace the git-repo-per-user Beancount model
-- (lib/github.js + lib/ledger.js over .beancount files) with a real database, so
-- finance-ops can be a PUBLIC product (many isolated users) instead of one
-- person's git repo read with one token.
--
-- Invariants carried over from the Beancount model (see CLAUDE.md / the finops MCP
-- guide), now enforced in SQL:
--   1. Entries are IMMUTABLE. A correction is a NEW transaction that references the
--      original (corrects_id) — history is never rewritten. (append_only guard)
--   2. Double-entry: a transaction's postings sum to ZERO per currency.
--      (postings_balanced deferred constraint trigger)
--   3. Inter-entity events are single-writer: record_between posts the two paired
--      legs to both books in ONE action, linked by transfer_group.
--   4. Balance assertions (statement closing balances) anchor reconciliation.
--
-- Git stays available as an optional export ("own your data"), not the live store.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email

-- ── Tenancy ─────────────────────────────────────────────────────────────────
create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null unique,
  name        text,
  created_at  timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null default 'member'
               check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ── Books ───────────────────────────────────────────────────────────────────
-- One entity = one set of books (was ledger/<entity>/). e.g. aikaara, personal,
-- flyy, arthsutra, tangram.
create table entities (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  slug          text not null,
  name          text not null,
  base_currency text not null default 'INR',
  created_at    timestamptz not null default now(),
  unique (workspace_id, slug)
);

-- ── Chart of accounts (hierarchical colon-path) ─────────────────────────────
create table accounts (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entities(id) on delete cascade,
  name        text not null,                    -- 'Expenses:Travel:Cabs'
  type        text not null
              check (type in ('assets', 'liabilities', 'equity', 'income', 'expenses')),
  currency    text,                             -- constrain to one currency; null = any
  open_date   date,
  close_date  date,
  metadata    jsonb not null default '{}',
  unique (entity_id, name)
);
create index accounts_entity_idx on accounts (entity_id);

-- ── Double-entry: transactions + postings ───────────────────────────────────
create table transactions (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entities(id) on delete cascade,
  date           date not null,
  flag           char(1) not null default '*',  -- '*' cleared, '!' needs review
  payee          text,
  narration      text,
  tags           text[] not null default '{}',
  links          text[] not null default '{}',  -- beancount ^link groupings
  metadata       jsonb not null default '{}',   -- file:, import ids, source refs
  source_file    text,                          -- file: evidence (denormalized for reconcile)
  corrects_id    uuid references transactions(id),   -- this txn corrects another
  transfer_group uuid,                          -- pairs the two legs of a record_between
  created_at     timestamptz not null default now(),
  created_by     uuid references users(id)
);
create index transactions_entity_date_idx on transactions (entity_id, date);
create index transactions_transfer_group_idx on transactions (transfer_group)
  where transfer_group is not null;
create index transactions_source_file_idx on transactions (entity_id, source_file)
  where source_file is not null;

create table postings (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  account_id     uuid not null references accounts(id),
  amount         numeric(20, 4) not null,       -- signed; per-txn per-currency sums to 0
  currency       text not null default 'INR',
  cost           jsonb,                         -- lot cost {number, currency, date}
  price          jsonb,                         -- @ price {number, currency}
  metadata       jsonb not null default '{}',
  position       int not null default 0
);
create index postings_account_idx on postings (account_id);
create index postings_transaction_idx on postings (transaction_id);

-- ── Invariants ──────────────────────────────────────────────────────────────
-- Statement closing balances (the reconcile anchor; from statement_ingest).
create table balance_assertions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts(id) on delete cascade,
  date        date not null,
  amount      numeric(20, 4) not null,
  currency    text not null default 'INR',
  source_file text,
  created_at  timestamptz not null default now()
);
create index balance_assertions_account_date_idx on balance_assertions (account_id, date);

-- Evidence documents behind file: metadata (statements, bills). The blob itself
-- lives in object storage; this is the index + provenance.
create table documents (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entities(id) on delete cascade,
  path        text not null,                    -- storage key (was _statements/_inbox path)
  sha256      text,
  bytes       bigint,
  kind        text,                             -- 'statement' | 'bill' | 'export' | 'other'
  metadata    jsonb not null default '{}',
  uploaded_at timestamptz not null default now(),
  unique (entity_id, path)
);

-- ── Relationships (parties.json, inter-project single-writer) ────────────────
create table parties (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug         text not null,
  name         text not null,
  metadata     jsonb not null default '{}',
  unique (workspace_id, slug)
);

-- ── Review workflow (decisions / vetting) ────────────────────────────────────
-- Binding classification precedents (review/decisions.csv).
create table decisions (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid references entities(id) on delete cascade,
  key         text not null,                    -- the ambiguous classification key
  decision    text not null,
  rationale   text,
  decided_by  uuid references users(id),
  decided_at  timestamptz not null default now(),
  unique (entity_id, key)
);

-- Extraction vetting of doc-derived entries (review/vetting.csv).
create table vettings (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  status         text not null default 'unvetted'
                 check (status in ('unvetted', 'ok', 'wrong')),
  note           text,
  vetted_by      uuid references users(id),
  vetted_at      timestamptz,
  unique (transaction_id)
);

-- ── Invariant enforcement ────────────────────────────────────────────────────

-- (2) Double-entry balance: a transaction's postings sum to 0 per currency.
-- Deferred to commit so an entry + its postings can be inserted in one txn.
create or replace function assert_txn_balanced() returns trigger as $$
declare
  txn uuid := coalesce(new.transaction_id, old.transaction_id);
begin
  if exists (
    select 1 from postings p
    where p.transaction_id = txn
    group by p.currency
    having abs(sum(p.amount)) > 0.0001
  ) then
    raise exception 'transaction % is not balanced (postings must sum to 0 per currency)', txn;
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger postings_balanced
  after insert or update or delete on postings
  deferrable initially deferred
  for each row execute function assert_txn_balanced();

-- (1) Append-only ledger: entries + postings are never edited or deleted; a
-- correction is a NEW transaction. A migration/backfill can opt in per-session
-- with:  set local finops.allow_mutation = 'on';
create or replace function guard_append_only() returns trigger as $$
begin
  if current_setting('finops.allow_mutation', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'ledger is append-only — record a correcting entry instead of editing % %',
    tg_table_name, coalesce(old.id, new.id);
end;
$$ language plpgsql;

create trigger transactions_append_only
  before update or delete on transactions
  for each row execute function guard_append_only();

create trigger postings_append_only
  before update or delete on postings
  for each row execute function guard_append_only();

-- ── Reporting helpers ─────────────────────────────────────────────────────────
-- Running account balances (the cashflow/report pipeline reads this instead of
-- re-parsing .beancount).
create view account_balances as
  select a.entity_id, a.id as account_id, a.name, a.type, p.currency,
         sum(p.amount) as balance
    from accounts a
    join postings p on p.account_id = a.id
   group by a.entity_id, a.id, a.name, a.type, p.currency;
-- finance-ops — reimbursement workflow + recurring commitments (fixed expenses).
--
-- Two product ideas that make the ledger legible (Venkatesh, 2026-08-25):
--   1. Company-paid-by-me is a RECEIVABLE, not an expense. It never touches the
--      personal cashflow; it accumulates as "<company> owes me". A reimbursement is
--      that balance being paid down. This layer adds the WORKFLOW on top: group
--      fronted expenses into a claim you send, track claimed → paid, so
--      reimbursements go out on time. Tracks: aikaara, flyy, arthsutra.
--   2. Fixed expenses are DEFINED, first-class recurring commitments — so the
--      cashflow dashboard shows committed vs discretionary and can forecast the month.

-- ── Reimbursement workflow ───────────────────────────────────────────────────
-- A claim batch: expenses I fronted for one company, grouped to send + track.
-- The authoritative "outstanding" is the receivable account's balance (from the
-- ledger / account_balances); this table is the workflow state on top of it.
create table reimbursement_requests (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references entities(id) on delete cascade,  -- MY book holding the receivable
  party_id              uuid not null references parties(id),                      -- the company that owes me
  receivable_account_id uuid references accounts(id),                             -- Assets:Receivable:<Company>
  status                text not null default 'draft'
                        check (status in ('draft', 'claimed', 'partially_paid', 'paid', 'cancelled')),
  claimed_on            date,          -- when I sent the claim
  amount                numeric(20, 4) not null default 0,   -- sum of the lines
  paid_amount           numeric(20, 4) not null default 0,   -- reconciled against reimbursement receipts
  currency              text not null default 'INR',
  note                  text,
  created_at            timestamptz not null default now(),
  created_by            uuid references users(id)
);
create index reimbursement_requests_party_idx on reimbursement_requests (party_id, status);

-- Which fronted transactions are in this claim (the evidence you send).
create table reimbursement_lines (
  request_id     uuid not null references reimbursement_requests(id) on delete cascade,
  transaction_id uuid not null references transactions(id),
  amount         numeric(20, 4) not null,
  primary key (request_id, transaction_id)
);

-- ── Recurring commitments (fixed expenses) ───────────────────────────────────
-- The defined monthly commitments the cashflow dashboard treats as committed
-- outflow (EMIs, insurance, loan interest) or committed savings (SIPs, chits,
-- gold schemes). Kept separate from discretionary spend so the month is predictable.
create table recurring_commitments (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entities(id) on delete cascade,
  name         text not null,                    -- 'Chit fund', 'IDFC EMI', 'Gold scheme (Murthy)'
  account_id   uuid references accounts(id),     -- the account it posts to
  kind         text not null default 'expense'
               check (kind in ('expense', 'investment', 'loan_emi', 'insurance', 'other')),
  amount       numeric(20, 4) not null,          -- expected amount per cadence
  currency     text not null default 'INR',
  cadence      text not null default 'monthly'
               check (cadence in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'custom')),
  day_of_month int,                              -- expected charge day (forecast)
  active       boolean not null default true,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  unique (entity_id, name)
);
create index recurring_commitments_entity_idx on recurring_commitments (entity_id, active);

-- Outstanding per company = the receivable balance, straight from the ledger.
-- (Positive = the company owes me.) The dashboard's Reimbursements section reads
-- this, then overlays claimed/paid workflow state from reimbursement_requests.
create view reimbursement_outstanding as
  select a.entity_id, a.id as account_id, a.name as receivable_account,
         split_part(a.name, ':', 3) as counterparty, p.currency,
         sum(p.amount) as outstanding
    from accounts a
    join postings p on p.account_id = a.id
   where a.name like 'Assets:Receivable:%'
   group by a.entity_id, a.id, a.name, p.currency;

-- ── Statement drafts (browser upload → server-side extraction → review → import) ──
-- One row per uploaded statement, per entity. Holds the parsed/extracted rows so a
-- statement survives reloads, can be revisited, re-extracted with a hint, and
-- imported later. sha256 dedupes re-uploads of the same file.
create table if not exists statement_drafts (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entities(id) on delete cascade,
  filename        text not null,
  sha256          text,
  bytes           bigint,
  source          text,                          -- 'pdf' | 'csv' | 'xlsx'
  account         text,                          -- statement account (Assets:Bank:X / Liabilities:Card:X)
  kind            text,                          -- archive slug (federal, amex-1001, …)
  status          text not null default 'queued' -- queued | processing | ready | imported | failed
                  check (status in ('queued','processing','ready','imported','failed')),
  rows            jsonb not null default '[]',
  reconciliation  jsonb,
  meta            jsonb not null default '{}',   -- period, opening/closing, model, chunks, error, hints[]
  result          jsonb,                         -- import result
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists statement_drafts_entity_idx on statement_drafts (entity_id, updated_at desc);
create index if not exists statement_drafts_sha_idx on statement_drafts (entity_id, sha256);
`;

export const VENTURES_SQL = String.raw`
-- Ventures / equity the owner holds OUTSIDE the double-entry books — what the
-- deployed capital (leverage) is actually building. User-entered (they chose "I'll
-- input venture/equity values"). A venture with a monthly_return is passive income;
-- its value is what the leverage sits against. Nothing here is a liability or a
-- burden — it's the productive side of "capital in play".
create table if not exists ventures (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entities(id) on delete cascade,
  name           text not null,                    -- 'aikaara', 'Flyy equity', 'Arthsutra note'
  kind           text not null default 'equity'
                 check (kind in ('equity', 'venture', 'loan_out', 'property', 'other')),
  value          numeric(20, 2) not null default 0,   -- current worth of the stake
  monthly_return numeric(20, 2) not null default 0,   -- cash it throws off per month (0 if none yet)
  note           text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (entity_id, name)
);
create index if not exists ventures_entity_idx on ventures (entity_id, active);
`;

export const GAME_SQL = String.raw`
-- The game schema. Thesis: the cleanup session WAS the game — plan-vs-reality
-- matching. The matcher IS the game; only exceptions surface. All idempotent so
-- ensureSchema() can run it on every boot to bring a live DB up to date.

-- PLAN: the month's expected structure (imported from notes/YYYY-MM.md, first-class).
create table if not exists plan_lines (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entities(id) on delete cascade,
  month             text not null,                    -- 'YYYY-MM'
  bucket            text not null check (bucket in ('fixed_in','fixed_out','var_in','var_out','work')),
  label             text not null,
  amount            numeric(20,2) not null,           -- planned
  actual            numeric(20,2),                    -- if the note recorded it
  counterparty_hint text,
  expected_window   text,
  recurring         boolean not null default false,
  status            text not null default 'open',     -- open | skipped | carried  (player call on a miss)
  source            text,
  created_at        timestamptz not null default now(),
  unique (entity_id, month, bucket, label)
);
create index if not exists plan_lines_month_idx on plan_lines (entity_id, month);
alter table plan_lines add column if not exists status text not null default 'open';

-- MATCH: reality (a txn) linked to a plan line. Matched = auto-tick; only misses surface.
create table if not exists plan_matches (
  plan_line_id uuid not null references plan_lines(id) on delete cascade,
  txn_id       uuid not null references transactions(id) on delete cascade,
  confidence   numeric(5,2),
  method       text check (method in ('rule','amount_window','fuzzy','manual')),
  created_at   timestamptz not null default now(),
  primary key (plan_line_id, txn_id)
);
create index if not exists plan_matches_txn_idx on plan_matches (txn_id);

-- LOCK: a sealed month. Written when the player locks; carries the payoff snapshot.
create table if not exists month_locks (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entities(id) on delete cascade,
  month          text not null,
  locked_at      timestamptz not null default now(),
  plan_coverage  int, handled_coverage int, exceptions int,
  stats          jsonb not null default '{}',
  unique (entity_id, month)
);

-- LOOT: scheduled money events (chit payout, vesting, EMI, premium).
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  type text not null check (type in ('chit_payout','vesting','emi','premium','payday','other')),
  date date not null, expected_amount numeric(20,2), asset_id uuid,
  status text not null default 'scheduled' check (status in ('scheduled','landed','missed','decided')),
  note text
);

-- Capital in Play cards.
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  name text not null, class text, cost numeric(20,2) default 0, mtm numeric(20,2) default 0,
  produces_pm numeric(20,2) default 0, costs_pm numeric(20,2) default 0,
  unique (entity_id, name)
);

-- Bosses (the Pack): each debt is weight; interest is the daily drag.
create table if not exists debts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  name text not null, principal_open numeric(20,2), principal_now numeric(20,2),
  rate numeric(6,2), emi numeric(20,2), status text not null default 'open',
  unique (entity_id, name)
);

-- ── Auth: passwordless (passkeys + email magic-link) ────────────────────────
-- A user's registered passkeys (WebAuthn credentials). Public keys only.
create table if not exists passkeys (
  id          text primary key,                 -- credential id (base64url)
  user_id     uuid not null references users(id) on delete cascade,
  public_key  text not null,                    -- base64url COSE public key
  counter     bigint not null default 0,
  transports  text,
  label       text,
  created_at  timestamptz not null default now()
);
create index if not exists passkeys_user_idx on passkeys (user_id);
-- Short-lived challenges for register/authenticate + email magic-link tokens.
create table if not exists auth_challenges (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,                     -- 'register' | 'login' | 'maglink'
  challenge  text,                              -- webauthn challenge / magic-link token
  email      text,
  user_id    uuid,
  created_at timestamptz not null default now()
);

-- Shelf zoning overrides — which aisle a category/counterparty shelf lives in.
-- Default zoning is a heuristic; the player can move a shelf Fixed↔Variable and it
-- sticks here (in/out is intrinsic to the account type, so only fixed is overridden).
create table if not exists account_zones (
  entity_id uuid not null references entities(id) on delete cascade,
  account   text not null,
  fixed     boolean not null,
  primary key (entity_id, account)
);

-- Quests: the real open-items register (docs/parked-items.md).
create table if not exists quests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  title text not null, reward_desc text, reward_inr numeric(20,2),
  status text not null default 'open' check (status in ('open','done','dropped')),
  linked_item text, created_at timestamptz not null default now(),
  unique (entity_id, title)
);
`;

export const SEED_COMMITMENTS_SQL = String.raw`
-- Seed the personal book's recurring commitments (the derived fixed-expense list).
-- Amounts/cadence from the ledger analysis; any refinement is a game "move" later.
-- DematViaShraddha is deliberately excluded (household reference, not own cash) —
-- if that's wrong it surfaces as a review decision in the game.
insert into recurring_commitments (entity_id, name, account_id, kind, amount, cadence, day_of_month)
select e.id, v.name, a.id, v.kind, v.amount, v.cadence, v.dom
  from entities e
  cross join (values
    ('Chit fund',            'Assets:Investments:Chits',            'investment', 54855.00, 'monthly',   5),
    ('Gold scheme — Murthy', 'Assets:Investments:GoldSchemeMurthy', 'investment', 50000.00, 'monthly',   1),
    ('Loan interest',        'Expenses:Interest',                   'expense',    35412.00, 'monthly',   1),
    ('Gold scheme — PMJ',    'Assets:Investments:GoldScheme',       'investment', 17000.00, 'monthly',   1),
    ('Mutual fund SIP',      'Assets:Investments:MF',               'investment', 10000.00, 'monthly',   1),
    ('EMI',                  'Expenses:EMI',                        'loan_emi',    9006.00, 'monthly',   7),
    ('Recurring deposit',    'Assets:Investments:Deposits',         'investment', 25000.00, 'quarterly', 1),
    ('Insurance',            'Expenses:Insurance',                  'insurance',  75000.00, 'yearly',    1),
    ('Monexo',               'Assets:Investments:Monexo',           'investment',  1087.00, 'monthly',   1)
  ) as v(name, account, kind, amount, cadence, dom)
  join accounts a on a.entity_id = e.id and a.name = v.account
 where e.slug = 'personal'
on conflict (entity_id, name) do update
  set amount = excluded.amount, account_id = excluded.account_id,
      kind = excluded.kind, cadence = excluded.cadence, day_of_month = excluded.day_of_month;
`;
