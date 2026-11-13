#!/usr/bin/env node
/**
 * Command-line version of soniox_transcribe_file, for when the local MCP server is not loaded in a session.
 * Sends one audio/video file to Soniox, waits for the transcription and prints the transcript id.
 * Credentials come from the same environment as the stdio server (see README).
 *
 * Usage: node --env-file=.env dist/src/transcribe-cli.js <file> [options]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSegments, formatDuration, renderSegments } from "./format.js";
import { errorResult } from "./mcp-server.js";
import { SonioxClient, tokenStoreFromEnv } from "./soniox-client.js";
import { submitFile } from "./upload-tools.js";

const HELP = `Transcribe a local audio or video file with Soniox.

Usage: node --env-file=.env dist/src/transcribe-cli.js <file> [options]

Options:
  -n, --name <title>     Transcript title in Soniox (default: the file name without extension)
  -l, --lang <codes>     Languages spoken, comma separated ISO codes, e.g. sl,en (default: auto-detect)
      --project <id>     Soniox project id to file it under (default: the personal project)
      --extract-audio    Upload only the audio track (needs ffmpeg); faster for large videos
      --no-wait          Exit once the upload is done instead of waiting for the transcription
      --print            Print the transcript text when it is ready
  -h, --help             Show this help

The file is sent to Soniox's cloud and uses the account's transcription quota.
Progress goes to stderr; the result (id, title, text) goes to stdout.`;

/** Stop waiting after this long; the transcription itself keeps running at Soniox. */
const MAX_WAIT_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (line: string) => console.error(line);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string", short: "n" },
      lang: { type: "string", short: "l" },
      project: { type: "string" },
      "extract-audio": { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals.length !== 1) throw new Error("Give exactly one file to transcribe. Run with --help for usage.");
  if (values.name !== undefined && !values.name.trim()) throw new Error("--name must not be empty.");
  const hints = values.lang?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = hints?.find((h) => !/^[a-z]{2,3}$/.test(h));
  if (bad) throw new Error(`"${bad}" is not a language code. Use ISO codes such as sl,en.`);

  const client = new SonioxClient(await tokenStoreFromEnv());
  const job = await submitFile(client, {
    file_path: resolve(positionals[0]),
    name: values.name?.trim(),
    language_hints: hints,
    project_id: values.project,
    extract_audio: values["extract-audio"],
  });
  log(`Created transcript "${job.name}" (id ${job.id}).`);

  let shown = "";
  const showPhase = () => {
    if (job.phase === shown) return;
    shown = job.phase;
    if (job.phase === "extracting_audio") log("Extracting the audio track with ffmpeg…");
    else if (job.phase === "uploading") log("Uploading to Soniox…");
  };
  const ticker = setInterval(showPhase, 500);
  showPhase();
  await job.done;
  clearInterval(ticker);
  if (job.phase === "error") {
    log(`Upload failed: ${job.error} An empty transcript "${job.name}" was left in Soniox and can be deleted in the app.`);
    return 1;
  }

  if (values["no-wait"]) {
    log("Uploaded. Soniox is transcribing it; the transcript will appear in the app when it is done.");
    console.log(job.id);
    return 0;
  }

  log("Uploaded. Transcribing…");
  const deadline = Date.now() + MAX_WAIT_MS;
  let status = await client.getAsyncStatus(job.id);
  while (status === "pending" && Date.now() < deadline) {
    await sleep(3000);
    status = await client.getAsyncStatus(job.id);
  }
  if (status === "pending") {
    log(`Still transcribing after ${MAX_WAIT_MS / 60000} minutes. It continues at Soniox; the transcript id is ${job.id}.`);
    console.log(job.id);
    return 2;
  }
  if (status !== "completed") {
    log(`Soniox reported status "${status}" for this transcription. The file may be unreadable or have no audio track.`);
    return 1;
  }

  const t = await client.getTranscript(job.id);
  console.log(`"${t.name}" · ${formatDuration(t.recording_duration_ms)} · id ${t.id}`);
  if (values.print) console.log(`\n${renderSegments(buildSegments(t.tokens, t.speaker_names), { timestamps: true })}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const first = errorResult(err).content[0];
    console.error(first?.type === "text" ? first.text : String(err));
    process.exit(1);
  }
);
