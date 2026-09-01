import { issuer } from "../../../lib/mcp-oauth";
export const dynamic = "force-dynamic";

// RFC 8414 — what an MCP client reads to discover how to authorise.
export async function GET() {
  const iss = issuer();
  return Response.json({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    registration_endpoint: `${iss}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["finops"],
  });
}
