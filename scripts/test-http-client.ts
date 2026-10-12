import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://127.0.0.1:3399/mcp";
const token = process.env.MCP_AUTH_TOKEN ?? "testsecret";
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "http-smoke", version: "0.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const r = await client.callTool({ name: "soniox_list_transcripts", arguments: { limit: 2 } });
console.log((r.content as { text?: string }[]).map((c) => c.text).join("\n").slice(0, 500));
await client.close();
