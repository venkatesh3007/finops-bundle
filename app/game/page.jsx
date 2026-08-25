import GameClient from "./game-client";

// The board — a Cashflow-game view of the ledger, and a serious Dashboard view of
// the same position. Reads /api/game (Postgres). Entity via ?entity= (default personal).
export const dynamic = "force-dynamic";

export default function GamePage({ searchParams }) {
  const entity = (searchParams?.entity || "personal").toString();
  return <GameClient entity={entity} />;
}
