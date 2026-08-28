import GameClient from "./game/game-client";

// Root serves the board DIRECTLY with a 200 rather than redirecting to /game.
// A bare redirect at `/` (the previous next.config rule) returns 307, and a
// live-preview readiness probe that expects a 2xx treats that as "not up yet"
// and waits forever. Serving real content at `/` also cuts one hop for users.
export const dynamic = "force-dynamic";

export default function Home({ searchParams }) {
  const entity = (searchParams?.entity || "personal").toString();
  return <GameClient entity={entity} />;
}
