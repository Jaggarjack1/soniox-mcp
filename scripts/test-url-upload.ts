/**
 * Smoke test for soniox_transcribe_url. Without arguments it only checks registration and the links that
 * must be refused (creates nothing). With links it really transcribes each, which creates transcripts.
 * Usage: npm run build && ENV_FILE=.env npx tsx scripts/test-url-upload.ts [https-link ...]
 * Against a running HTTP server instead of stdio: MCP_URL=http://127.0.0.1:3399/soniox (and MCP_AUTH_TOKEN).
 * Options via env: WAIT_SECONDS (default 40), LANGUAGE_HINTS=sl,en, NAME="Title"
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Result) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

async function connect(): Promise<Client> {
  const client = new Client({ name: "url-upload-smoke-test", version: "0.0.0" });
  if (process.env.MCP_URL) {
    const headers = process.env.MCP_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } : undefined;
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), { requestInit: { headers } }));
  } else {
    const nodeArgs = process.env.ENV_FILE ? [`--env-file=${process.env.ENV_FILE}`, "dist/src/stdio.js"] : ["dist/src/stdio.js"];
    const env = { ...process.env, SONIOX_ENABLE_UPLOAD: "1" } as Record<string, string>;
    await client.connect(new StdioClientTransport({ command: "node", args: nodeArgs, stderr: "pipe", env }));
  }
  return client;
}

async function main(): Promise<void> {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(tools.length, "tools:", tools.join(", "));
  if (!tools.includes("soniox_transcribe_url") || !tools.includes("soniox_get_transcription_status")) throw new Error("url tools are not registered");

  for (const [label, url] of [
    ["not a link", "recording.mp3"],
    ["plain http", "http://example.com/a.mp3"],
    ["loopback", "https://127.0.0.1/a.mp3"],
    ["private network", "https://192.168.1.10/a.mp3"],
    ["local name", "https://localhost/a.mp3"],
    ["credentials in link", "https://user:pw@example.com/a.mp3"],
    ["web page", "https://example.com/"],
  ]) {
    const r = await client.callTool({ name: "soniox_transcribe_url", arguments: { url } });
    if (!r.isError) throw new Error(`${label}: expected an error`);
    console.log(`rejected (${label}):`, textOf(r).slice(0, 120));
  }

  for (const url of process.argv.slice(2)) {
    const args: Record<string, unknown> = { url, wait_seconds: Number(process.env.WAIT_SECONDS ?? 40) };
    if (process.env.NAME) args.name = process.env.NAME;
    if (process.env.LANGUAGE_HINTS) args.language_hints = process.env.LANGUAGE_HINTS.split(",");
    let r = await client.callTool({ name: "soniox_transcribe_url", arguments: args });
    let sc = r.structuredContent as { id?: string; status?: string; file?: string; size_bytes?: number | null } | undefined;
    console.log(`\n${new URL(url).hostname}\n  -> ${sc?.status}${r.isError ? " (isError)" : ""}: ${textOf(r).split("\n")[0]}`);
    if (sc?.file) console.log(`  source: ${sc.file} · ${sc.size_bytes ?? "unknown"} bytes`);
    for (let i = 0; sc?.id && !r.isError && sc.status !== "completed" && i < 200; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await client.callTool({ name: "soniox_get_transcription_status", arguments: { id: sc.id } });
      const next = r.structuredContent as { id?: string; status?: string };
      if (next.status !== sc.status) console.log(`  -> ${next.status}: ${textOf(r).split("\n")[0]}`);
      sc = { ...next, id: sc.id };
    }
    if (sc?.id && sc.status === "completed") {
      const t = await client.callTool({ name: "soniox_get_transcript", arguments: { id: sc.id, max_chars: 1000 } });
      const s = t.structuredContent as { name: string; text: string };
      console.log(`  "${s.name}": ${s.text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
