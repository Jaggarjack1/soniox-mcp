#!/usr/bin/env node
/**
 * Local entry point (stdio) for Claude Desktop / Claude Code.
 * Credentials: SONIOX_TOKEN_FILE (default ./soniox-auth.json) or SONIOX_REFRESH_TOKEN.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SonioxClient, tokenStoreFromEnv } from "./soniox-client.js";
import { createSonioxServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const client = new SonioxClient(await tokenStoreFromEnv());
  const server = createSonioxServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`soniox-mcp-server running on stdio (auth: ${client.describeAuth()})`);
}

main().catch((err) => {
  console.error("soniox-mcp-server failed to start:", err);
  process.exit(1);
});
