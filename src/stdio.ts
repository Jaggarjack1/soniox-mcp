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
  // Write access is opt-in and local-only: the upload tools read files from this computer.
  const uploadEnabled = /^(1|true|yes)$/i.test(process.env.SONIOX_ENABLE_UPLOAD ?? "");
  if (uploadEnabled) {
    const { registerUploadTools } = await import("./upload-tools.js");
    registerUploadTools(server, client);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`soniox-mcp-server running on stdio (auth: ${client.describeAuth()}, upload tools: ${uploadEnabled ? "on" : "off"})`);
}

main().catch((err) => {
  console.error("soniox-mcp-server failed to start:", err);
  process.exit(1);
});
