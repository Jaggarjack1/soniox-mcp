/**
 * Smoke test: spawn the stdio server, list tools, and exercise each one against the live API.
 * Usage: npm run build && npx tsx scripts/test-client.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

async function main(): Promise<void> {
  // Set ENV_FILE=.env to exercise the same credentials/token store Claude Desktop uses.
  const nodeArgs = process.env.ENV_FILE ? [`--env-file=${process.env.ENV_FILE}`, "dist/src/stdio.js"] : ["dist/src/stdio.js"];
  const transport = new StdioClientTransport({ command: "node", args: nodeArgs, stderr: "pipe", env: { ...process.env } as Record<string, string> });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const ws = await client.callTool({ name: "soniox_get_workspace_info", arguments: {} });
  console.log("\n--- workspace ---\n" + textOf(ws).slice(0, 800));

  const list = await client.callTool({ name: "soniox_list_transcripts", arguments: { limit: 3 } });
  console.log("\n--- list ---\n" + textOf(list).slice(0, 1200));
  const first = (list.structuredContent as { transcripts: { id: string; name: string }[] }).transcripts[0];

  const search = await client.callTool({ name: "soniox_list_transcripts", arguments: { search: "funnel", limit: 5, response_format: "json" } });
  console.log("\n--- search 'funnel' ---\n" + textOf(search).slice(0, 600));

  const get = await client.callTool({ name: "soniox_get_transcript", arguments: { id: first.id, max_chars: 1500 } });
  console.log("\n--- get (first page) ---\n" + textOf(get));
  console.log("structured:", JSON.stringify(get.structuredContent));

  const sc = get.structuredContent as { next_offset: number | null };
  if (sc.next_offset) {
    const page2 = await client.callTool({ name: "soniox_get_transcript", arguments: { id: first.id, offset: sc.next_offset, max_chars: 1200 } });
    console.log("\n--- get (page 2, first 400 chars) ---\n" + textOf(page2).slice(0, 400));
  }

  const win = await client.callTool({ name: "soniox_get_transcript", arguments: { id: first.id, start_ms: 60_000, end_ms: 120_000 } });
  console.log("\n--- get window 1:00-2:00 ---\n" + textOf(win).slice(0, 900));

  const hits = await client.callTool({ name: "soniox_search_in_transcript", arguments: { id: first.id, query: "ok", max_hits: 3, context_chars: 60 } });
  console.log("\n--- search in transcript ---\n" + textOf(hits));

  const bad = await client.callTool({ name: "soniox_get_transcript", arguments: { id: "00000000-0000-0000-0000-000000000000" } });
  console.log("\n--- bad id ---\n" + textOf(bad), "isError:", bad.isError);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
