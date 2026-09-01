import { issuer } from "../../../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";

// RFC 9728 — the 401 from /api/mcp points here, and this points at the AS.
export async function GET() {
  const iss = issuer();
  return Response.json({
    resource: `${iss}/api/mcp`,
    authorization_servers: [iss],
    scopes_supported: ["finops"],
  });
}
