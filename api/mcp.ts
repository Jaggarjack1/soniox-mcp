/**
 * Vercel Function entry point: stateless Streamable HTTP MCP endpoint at /api/mcp (also /mcp via rewrite).
 *
 * Env (Vercel project settings):
 *   SONIOX_REFRESH_TOKEN  - refresh token from app.soniox.com (localStorage.authTokens.refreshToken)
 *   MCP_AUTH_TOKEN        - shared secret clients must send as "Authorization: Bearer <token>"
 *   SONIOX_ENABLE_UPLOAD  - optional, "1" adds soniox_transcribe_url (transcribe a file from a link)
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { waitUntil } from "@vercel/functions";
import { SonioxClient, tokenStoreFromEnv } from "../src/soniox-client.js";
import { createSonioxServer } from "../src/mcp-server.js";
import { bearerMatches } from "../src/auth.js";
import { BlobJobStore } from "../src/job-store-blob.js";
import { registerStatusTool, uploadEnabled } from "../src/transcription-jobs.js";
import { registerUrlUploadTools } from "../src/url-upload-tools.js";

// Module-level singleton so warm instances reuse refreshed tokens.
const clientPromise = tokenStoreFromEnv().then((store) => new SonioxClient(store));

/** Must stay below maxDuration in vercel.json (300 s), so a slow transfer fails with a message instead of being cut off. */
const MAX_TRANSFER_MS = 270_000;
/** A transfer can outlive the request that started it, so its state is kept in the Blob store. */
const jobStore = process.env.BLOB_READ_WRITE_TOKEN ? new BlobJobStore(330_000) : undefined;

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
  const client = await clientPromise;
  const server = createSonioxServer(client);
  if (uploadEnabled()) {
    registerUrlUploadTools(server, client, { keepAlive: waitUntil, jobStore, maxTransferMs: MAX_TRANSFER_MS });
    registerStatusTool(server, client, jobStore);
  }
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void transport.close();
    void server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
