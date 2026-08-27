// Multi-tenant entity resolution. The server is authoritative: it derives the
// caller's entity from their SESSION, never from a client-supplied param. A
// signed-in user can therefore only ever reach their own book — passing
// entity=personal in a URL does nothing.
//
//   session cookie (fo_sess)  → that user's own entity  (created on first use)
//   passcode cookie (fo_auth) → "personal"  (the owner / you)
//   neither                   → null  (unauthorized)
import { query } from "./db.js";
import { verifySession, readCookie } from "./session.js";

// deterministic, DB-safe slug from a user id: "u" + first 12 hex chars
function entitySlugFor(userId) {
  return "u" + String(userId).replace(/-/g, "").slice(0, 12);
}

// Find (or lazily create) the workspace + entity that belongs to a user.
// Idempotent: safe to call on every request.
export async function ensureUserEntity(userId) {
  const found = await query(
    `select e.slug
       from entities e
       join workspace_members wm on wm.workspace_id = e.workspace_id
      where wm.user_id = $1
      order by e.created_at
      limit 1`,
    [userId],
  );
  if (found.length) return found[0].slug;

  // First sign-in for this user → mint an empty, isolated workspace + entity.
  const slug = entitySlugFor(userId);
  const u = await query("select coalesce(name, split_part(email::text,'@',1)) as nm from users where id=$1", [userId]);
  const nm = (u[0]?.nm || "My").toString();
  const ws = await query(
    `insert into workspaces (slug, name) values ($1, $2)
       on conflict (slug) do update set slug = excluded.slug
     returning id`,
    [slug, `${nm}'s workspace`],
  );
  const wsId = ws[0].id;
  await query(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')
       on conflict do nothing`,
    [wsId, userId],
  );
  await query(
    `insert into entities (workspace_id, slug, name, base_currency) values ($1, $2, 'Personal', 'INR')
       on conflict (workspace_id, slug) do nothing`,
    [wsId, slug],
  );
  return slug;
}

// The one call every game/data endpoint makes. Returns the entity slug the
// caller is allowed to read/write, or null if unauthenticated.
export async function resolveEntity(req) {
  const userId = verifySession(readCookie(req, "fo_sess"));
  if (userId) return await ensureUserEntity(userId);
  if (readCookie(req, "fo_auth")) return "personal"; // legacy passcode = owner
  return null;
}

// Who is the caller? { userId, entity } for a session user, { owner:true } for
// the passcode, or null. Used by /api/auth/me and onboarding.
export async function resolveCaller(req) {
  const userId = verifySession(readCookie(req, "fo_sess"));
  if (userId) {
    const u = await query("select email::text as email, name from users where id=$1", [userId]);
    if (!u.length) return null;
    const entity = await ensureUserEntity(userId);
    const c = await query("select count(*)::int n from transactions where entity_id=(select id from entities where slug=$1)", [entity]);
    return { userId, email: u[0].email, name: u[0].name, entity, hasData: c[0].n > 0 };
  }
  if (readCookie(req, "fo_auth")) return { owner: true, entity: "personal", hasData: true };
  return null;
}
