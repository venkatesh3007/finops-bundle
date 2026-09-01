// Background jobs with a visible transcript.
//
// The previous design ran a 5–15 minute rewrite inside one HTTP request: any
// proxy timeout, container restart or closed tab killed it, and the UI could not
// tell "working" from "dead". A job now lives in the database. The request that
// starts it returns immediately with an id; the work continues in the process
// and appends STEPS as it goes; the UI polls those steps and can cancel.
import { query } from "../db.js";

let ensured = false;
export async function ensureJobs() {
  if (ensured) return;
  await query(`create table if not exists parse_jobs (
    id uuid primary key default gen_random_uuid(),
    entity_id uuid not null references entities(id) on delete cascade,
    kind text not null,
    title text,
    status text not null default 'running' check (status in ('running','done','failed','cancelled')),
    steps jsonb not null default '[]',
    result jsonb,
    cancel boolean not null default false,
    draft_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now())`);
  await query("create index if not exists parse_jobs_entity_idx on parse_jobs (entity_id, created_at desc)");
  ensured = true;
}

async function entityId(slug) {
  const r = await query("select id from entities where slug=$1", [slug]);
  if (!r.length) throw new Error(`no entity ${slug}`);
  return r[0].id;
}

export class Cancelled extends Error {}

export async function startJob(entity, { kind, title, draft_id = null }) {
  await ensureJobs();
  const entId = await entityId(entity);
  const r = await query(
    `insert into parse_jobs (entity_id, kind, title, draft_id, steps) values ($1,$2,$3,$4,'[]') returning *`,
    [entId, kind, title || kind, draft_id]);
  return r[0];
}

// Append one visible step. Returns the step so callers can update it later.
export async function step(jobId, kind, text, data = null) {
  const s = { at: new Date().toISOString(), kind, text, ...(data ? { data } : {}) };
  await query(
    `update parse_jobs set steps = steps || $2::jsonb, updated_at = now() where id = $1`,
    [jobId, JSON.stringify([s])]);
  return s;
}

// A unit of work can take minutes (one statement re-read is 1–3 min, sometimes
// more). The reaper below judges liveness by updated_at, so a job that is busy
// but between steps would be declared dead. beat() keeps it honest: hold one of
// these open around long work and the row is touched on a timer.
//
//   const stop = beat(jobId); try { await slowThing(); } finally { stop(); }
export function beat(jobId, everyMs = 60_000) {
  const t = setInterval(() => {
    query("update parse_jobs set updated_at=now() where id=$1 and status='running'", [jobId])
      .catch(() => { /* a heartbeat that fails is not worth failing the job over */ });
  }, everyMs);
  if (typeof t.unref === "function") t.unref();
  return () => clearInterval(t);
}

// Throws Cancelled if the user pressed stop — call this between expensive steps.
export async function checkCancel(jobId) {
  const r = await query("select cancel from parse_jobs where id=$1", [jobId]);
  if (!r.length || r[0].cancel) throw new Cancelled("stopped");
}

export async function finishJob(jobId, status, result = null) {
  await query("update parse_jobs set status=$2, result=$3, updated_at=now() where id=$1",
    [jobId, status, result ? JSON.stringify(result) : null]);
}

export async function cancelJob(entity, id) {
  await ensureJobs();
  const entId = await entityId(entity);
  await query("update parse_jobs set cancel=true, updated_at=now() where entity_id=$1 and id=$2 and status='running'", [entId, id]);
  return getJob(entity, id);
}

export async function getJob(entity, id) {
  await ensureJobs();
  const entId = await entityId(entity);
  const r = await query("select * from parse_jobs where entity_id=$1 and id=$2", [entId, id]);
  return r[0] || null;
}

export async function listJobs(entity, { limit = 20 } = {}) {
  await ensureJobs();
  const entId = await entityId(entity);
  return query(
    `select id, kind, title, status, draft_id, created_at, updated_at,
            jsonb_array_length(steps) as step_count,
            steps -> -1 as last_step
       from parse_jobs where entity_id=$1 order by created_at desc limit $2`, [entId, limit]);
}

// A job whose process died (deploy, crash) is left 'running' forever. A live job
// touches updated_at every 60s via beat(), so anything untouched for five
// minutes really is gone — say so instead of spinning forever.
export async function reapStale(entity) {
  await ensureJobs();
  const entId = await entityId(entity);
  await query(
    `update parse_jobs set status='failed',
            steps = steps || jsonb_build_array(jsonb_build_object(
              'at', now()::text, 'kind', 'error',
              'text', 'This run stopped unexpectedly — the server restarted or the process was interrupted. Nothing was changed.'))
      where entity_id=$1 and status='running' and updated_at < now() - interval '5 minutes'`, [entId]);
}
