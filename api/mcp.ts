/**
 * Vercel Function entry point: stateless Streamable HTTP MCP endpoint at /api/mcp (also /mcp via rewrite).
 *
 * Env (Vercel project settings):
 *   SONIOX_REFRESH_TOKEN  - refresh token from app.soniox.com (localStorage.authTokens.refreshToken)
 *   MCP_AUTH_TOKEN        - shared secret clients must send as "Authorization: Bearer <token>"
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SonioxClient, tokenStoreFromEnv } from "../src/soniox-client.js";
import { createSonioxServer } from "../src/mcp-server.js";
import { bearerMatches } from "../src/auth.js";

// Module-level singleton so warm instances reuse refreshed tokens.
const clientPromise = tokenStoreFromEnv().then((store) => new SonioxClient(store));

async function handle(request: Request): Promise<Response> {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    return new Response("Server misconfigured: MCP_AUTH_TOKEN is not set", { status: 500 });
  }
  if (!bearerMatches(request.headers.get("authorization"), expected)) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createSonioxServer(await clientPromise);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void transport.close();
    void server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
