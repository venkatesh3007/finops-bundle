// Storage for the extractor lab: versions of the extractor's own code, and the
// fixture corpus (real statements that went wrong) it is judged against.
// Everything is per-entity — your extractor evolves on YOUR statements. Version 1
// is seeded from the baseline for each entity on first use.
import { query } from "../db.js";
import { BASELINE_SOURCE, BASELINE_NOTES } from "./baseline.js";

let ensured = false;
export async function ensureTables() {
  if (ensured) return;
  await query(`create table if not exists extractor_versions (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references entities(id) on delete cascade,
    version int not null,
    source text not null,
    notes text,
    parent_version int,
    active boolean not null default false,
    score jsonb,
    created_at timestamptz not null default now(),
    unique (entity_id, version))`);
  await query(`create table if not exists extractor_fixtures (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references entities(id) on delete cascade,
    name text not null,
    complaint text,
    source_kind text,
    text_body text not null,
    bank text,
    expected jsonb not null default '{}',
    baseline jsonb,
    active boolean not null default true,
    created_at timestamptz not null default now())`);
  await query("create index if not exists extractor_versions_entity_idx on extractor_versions (entity_id, version desc)");
  await query("create index if not exists extractor_fixtures_entity_idx on extractor_fixtures (entity_id, created_at desc)");
  ensured = true;
}

export async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

// The version the extractor runs today. Seeds v1 from the baseline the first time.
export async function activeVersion(entity, entId = null) {
  await ensureTables();
  const id = entId || (await entityId(entity));
  const rows = await query("select * from extractor_versions where entity_id=$1 and active order by version desc limit 1", [id]);
  if (rows.length) return rows[0];
  const seeded = await query(
    `insert into extractor_versions (entity_id, version, source, notes, active)
     values ($1, 1, $2, $3, true)
     on conflict (entity_id, version) do update set active = true
     returning *`, [id, BASELINE_SOURCE, BASELINE_NOTES]);
  return seeded[0];
}

export async function listVersions(entity) {
  await ensureTables();
  const id = await entityId(entity);
  await activeVersion(entity, id); // make sure v1 exists so the lab is never empty
  return query(
    `select id, version, notes, parent_version, active, score, created_at,
            length(source) as source_bytes
       from extractor_versions where entity_id=$1 order by version desc limit 50`, [id]);
}

export async function getVersion(entity, version) {
  await ensureTables();
  const id = await entityId(entity);
  const r = await query("select * from extractor_versions where entity_id=$1 and version=$2", [id, version]);
  return r[0] || null;
}

export async function nextVersionNumber(entId) {
  const r = await query("select coalesce(max(version),0)+1 as n from extractor_versions where entity_id=$1", [entId]);
  return r[0].n;
}

export async function saveVersion(entId, { version, source, notes, parent_version, score, active = false }) {
  const r = await query(
    `insert into extractor_versions (entity_id, version, source, notes, parent_version, score, active)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [entId, version, source, notes || null, parent_version || null, score ? JSON.stringify(score) : null, active]);
  return r[0];
}

// Exactly one active version per entity.
export async function activate(entity, version) {
  await ensureTables();
  const id = await entityId(entity);
  const target = await query("select id from extractor_versions where entity_id=$1 and version=$2", [id, version]);
  if (!target.length) throw new Error(`no extractor version ${version}`);
  await query("update extractor_versions set active = (version = $2) where entity_id=$1", [id, version]);
  return getVersion(entity, version);
}

// ── fixtures: real statements the extractor got wrong ──────────────────────
export async function addFixture(entity, { name, complaint, source_kind, text_body, bank, expected, baseline }) {
  await ensureTables();
  const id = await entityId(entity);
  const body = String(text_body || "").slice(0, 120_000); // bound each eval's token cost
  if (!body.trim()) throw new Error("this statement has no stored text to learn from");
  const r = await query(
    `insert into extractor_fixtures (entity_id, name, complaint, source_kind, text_body, bank, expected, baseline)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, name, complaint, created_at`,
    [id, String(name || "statement").slice(0, 200), String(complaint || "").slice(0, 2000),
     source_kind || null, body, bank || null, JSON.stringify(expected || {}), baseline ? JSON.stringify(baseline) : null]);
  return r[0];
}

export async function listFixtures(entity, { activeOnly = false, withBody = false } = {}) {
  await ensureTables();
  const id = await entityId(entity);
  const cols = withBody
    ? "id, name, complaint, source_kind, bank, expected, baseline, active, created_at, text_body"
    : "id, name, complaint, source_kind, bank, expected, baseline, active, created_at, length(text_body) as text_bytes";
  return query(
    `select ${cols} from extractor_fixtures where entity_id=$1 ${activeOnly ? "and active" : ""} order by created_at desc limit 50`, [id]);
}

export async function setFixtureActive(entity, id, active) {
  await ensureTables();
  const entId = await entityId(entity);
  await query("update extractor_fixtures set active=$3 where entity_id=$1 and id=$2", [entId, id, !!active]);
}

export async function deleteFixture(entity, id) {
  await ensureTables();
  const entId = await entityId(entity);
  await query("delete from extractor_fixtures where entity_id=$1 and id=$2", [entId, id]);
}

export async function updateFixtureBaseline(entId, fixtureId, baseline) {
  await query("update extractor_fixtures set baseline=$3 where entity_id=$1 and id=$2", [entId, fixtureId, JSON.stringify(baseline)]);
}
