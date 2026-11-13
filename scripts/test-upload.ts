/**
 * Smoke test for the local upload tools. Without arguments it only checks registration and input validation
 * (creates nothing). With file paths it really uploads each file, which creates transcripts in your account.
 * Usage: npm run build && ENV_FILE=.env npx tsx scripts/test-upload.ts [file ...]
 * Per-file options via env: WAIT_SECONDS (default 45), EXTRACT_AUDIO=1, LANGUAGE_HINTS=sl,en
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

type Result = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Result) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");

async function connect(enableUpload: boolean): Promise<Client> {
  const nodeArgs = process.env.ENV_FILE ? [`--env-file=${process.env.ENV_FILE}`, "dist/src/stdio.js"] : ["dist/src/stdio.js"];
  const env = { ...process.env, SONIOX_ENABLE_UPLOAD: enableUpload ? "1" : "0" } as Record<string, string>;
  const client = new Client({ name: "upload-smoke-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: nodeArgs, stderr: "pipe", env }));
  return client;
}

async function main(): Promise<void> {
  const off = await connect(false);
  const offTools = (await off.listTools()).tools.map((t) => t.name);
  await off.close();
  if (offTools.includes("soniox_transcribe_file")) throw new Error("upload tool must not be registered when SONIOX_ENABLE_UPLOAD is off");
  console.log("upload off:", offTools.length, "tools");

  const client = await connect(true);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("upload on: ", tools.length, "tools:", tools.slice(-2).join(", "));

  for (const [label, file_path] of [
    ["relative path", "recording.mp3"],
    ["missing file", resolve("does-not-exist.mp3")],
    ["unsupported type", resolve("package.json")],
  ]) {
    const r = await client.callTool({ name: "soniox_transcribe_file", arguments: { file_path } });
    if (!r.isError) throw new Error(`${label}: expected an error`);
    console.log(`rejected (${label}):`, textOf(r).slice(0, 110));
  }

  for (const file of process.argv.slice(2)) {
    const args: Record<string, unknown> = { file_path: resolve(file), name: `MCP upload test (${file.split(/[\\/]/).pop()})` };
    args.wait_seconds = Number(process.env.WAIT_SECONDS ?? 45);
    if (process.env.EXTRACT_AUDIO) args.extract_audio = true;
    if (process.env.LANGUAGE_HINTS) args.language_hints = process.env.LANGUAGE_HINTS.split(",");
    let r = await client.callTool({ name: "soniox_transcribe_file", arguments: args });
    let sc = r.structuredContent as { id?: string; status?: string } | undefined;
    console.log(`\n${file}\n  -> ${sc?.status}${r.isError ? " (isError)" : ""}: ${textOf(r).split("\n")[0]}`);
    for (let i = 0; sc?.id && !r.isError && sc.status !== "completed" && i < 400; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      r = await client.callTool({ name: "soniox_get_transcription_status", arguments: { id: sc.id } });
      const next = r.structuredContent as { id?: string; status?: string };
      if (next.status !== sc.status) console.log(`  -> ${next.status}: ${textOf(r).split("\n")[0]}`);
      sc = { ...next, id: sc.id };
    }
    if (sc?.id && sc.status === "completed") {
      const t = await client.callTool({ name: "soniox_get_transcript", arguments: { id: sc.id, max_chars: 1000 } });
      const s = t.structuredContent as { languages: string[]; speakers: string[]; text: string };
      console.log(`  languages: ${s.languages.join(",") || "-"} · speakers: ${s.speakers.length} · text: ${s.text.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
