#!/usr/bin/env node
/**
 * Local entry point (stdio) for Claude Desktop / Claude Code.
 * Credentials: SONIOX_TOKEN_FILE (default ./soniox-auth.json) or SONIOX_REFRESH_TOKEN.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SonioxClient, tokenStoreFromEnv } from "./soniox-client.js";
import { createSonioxServer } from "./mcp-server.js";
import { registerStatusTool, uploadEnabled } from "./transcription-jobs.js";

async function main(): Promise<void> {
  const client = new SonioxClient(await tokenStoreFromEnv());
  const server = createSonioxServer(client);
  // Write access is opt-in. The file tool is local-only: it reads files from this computer.
  const enabled = uploadEnabled();
  if (enabled) {
    const { registerUploadTools } = await import("./upload-tools.js");
    const { registerUrlUploadTools } = await import("./url-upload-tools.js");
    registerUploadTools(server, client);
    registerUrlUploadTools(server, client);
    registerStatusTool(server, client);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`soniox-mcp-server running on stdio (auth: ${client.describeAuth()}, upload tools: ${enabled ? "on" : "off"})`);
}

main().catch((err) => {
  console.error("soniox-mcp-server failed to start:", err);
  process.exit(1);
});
