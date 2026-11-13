/**
 * Local-only write tools: send an audio/video file from this computer to Soniox for transcription.
 * Registered by stdio.ts when SONIOX_ENABLE_UPLOAD is set; never loaded by the remote (Vercel) endpoint.
 *
 * Flow (reverse-engineered, undocumented): create an empty transcript record -> get an S3 presigned POST
 * -> upload the file -> start async transcription of the uploaded object -> poll the async status.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatDuration } from "./format.js";
import { errorResult, text } from "./mcp-server.js";
import type { SonioxClient } from "./soniox-client.js";

const execFileAsync = promisify(execFile);

/** Limit enforced by the presigned upload policy. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Formats uploaded as they are. Soniox only issues upload links for a few audio/* content types but
 * detects the real format from the bytes, so video containers go up labelled as audio (verified with mp4).
 */
const DIRECT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
  ".m4v": "audio/mp4",
  ".mov": "audio/mp4",
};
/** Formats with no accepted content type: the audio track is converted to m4a with ffmpeg first. */
const CONVERT_EXTENSIONS = new Set([".mkv", ".avi", ".wmv", ".mpg", ".mpeg", ".3gp", ".aac", ".wma", ".aiff", ".aif", ".amr"]);

type Phase = "extracting_audio" | "uploading" | "started" | "error";

interface Job {
  id: string;
  name: string;
  file: string;
  sizeBytes: number;
  phase: Phase;
  error?: string;
  startedAt: number;
  done: Promise<void>;
}

/** Uploads started by this server process. Lost on restart; the Soniox record then stays "not_started". */
const jobs = new Map<string, Job>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function findFfmpeg(): Promise<string | null> {
  const candidate = process.env.FFMPEG_PATH || "ffmpeg";
  try {
    await execFileAsync(candidate, ["-version"], { windowsHide: true });
    return candidate;
  } catch {
    return null;
  }
}

async function extractAudio(ffmpeg: string, input: string): Promise<string> {
  const out = join(tmpdir(), `soniox-mcp-${randomUUID()}.m4a`);
  try {
    // 16 kHz mono AAC is what speech recognition needs; a 2 h recording ends up around 60 MB.
    await execFileAsync(
      ffmpeg,
      ["-y", "-nostdin", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", out],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
  } catch (err) {
    await unlink(out).catch(() => {});
    const stderr = (err as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join(" ") ?? "";
    throw new Error(`ffmpeg could not extract the audio track${stderr ? `: ${stderr}` : "."}`);
  }
  return out;
}

async function runUpload(client: SonioxClient, job: Job, plan: { contentType: string; ffmpeg: string | null }): Promise<void> {
  let uploadPath = job.file;
  let temp: string | undefined;
  try {
    if (plan.ffmpeg) {
      job.phase = "extracting_audio";
      temp = await extractAudio(plan.ffmpeg, job.file);
      uploadPath = temp;
      const size = (await stat(temp)).size;
      if (size > MAX_UPLOAD_BYTES) throw new Error(`The extracted audio is ${megabytes(size)}, over Soniox's 512 MB upload limit.`);
    }
    job.phase = "uploading";
    const pre = await client.getPresignedUpload(job.id, plan.contentType);
    const form = new FormData();
    for (const [k, v] of Object.entries(pre.fields)) form.append(k, v);
    form.append("file", await openAsBlob(uploadPath, { type: plan.contentType }), "upload"); // the file must be the last field
    const res = await fetch(pre.url, { method: "POST", body: form });
    if (!res.ok) {
      const code = /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1];
      throw new Error(`Soniox storage rejected the upload (HTTP ${res.status}${code ? `, ${code}` : ""}).`);
    }
    await client.startAsyncTranscription(job.id, pre.fields.key);
    job.phase = "started";
  } catch (err) {
    job.phase = "error";
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (temp) await unlink(temp).catch(() => {});
  }
}

/** One status report, combining what this process knows about its upload with what Soniox reports. */
async function report(client: SonioxClient, id: string): Promise<CallToolResult> {
  const job = jobs.get(id);
  const base = {
    id,
    ...(job ? { name: job.name, file: job.file, size_bytes: job.sizeBytes, elapsed_seconds: Math.round((Date.now() - job.startedAt) / 1000) } : {}),
  };
  const check = `Check again with soniox_get_transcription_status (id=${id}).`;

  if (job?.phase === "error") {
    const message = `Upload failed: ${job.error} An empty transcript "${job.name}" was left in Soniox and can be deleted in the app.`;
    return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ...base, status: "error", message } };
  }
  if (job?.phase === "extracting_audio" || job?.phase === "uploading") {
    const doing = job.phase === "uploading" ? `Uploading ${megabytes(job.sizeBytes)} to Soniox` : "Extracting the audio track with ffmpeg";
    const message = `${doing} (${base.elapsed_seconds} s so far). It continues in the background while this server keeps running. ${check}`;
    return text(message, { ...base, status: job.phase, message });
  }

  const status = await client.getAsyncStatus(id);
  if (status === "completed") {
    const t = await client.getTranscript(id);
    const message =
      `Transcription completed: "${t.name}" · ${formatDuration(t.recording_duration_ms)} · id ${id}\n` +
      `Read it with soniox_get_transcript (id=${id}).`;
    return text(message, { ...base, name: t.name, status, duration_ms: t.recording_duration_ms, message });
  }
  if (status === "pending") {
    const message = `Soniox is transcribing the file. Long recordings take a few minutes. ${check}`;
    return text(message, { ...base, status: "transcribing", message });
  }
  if (status === "not_started") {
    const message = "This transcript has no upload in progress from this server (it was restarted, or the upload never started). Submit the file again.";
    return text(message, { ...base, status, message });
  }
  const message = `Soniox reported status "${status}" for this transcription. The file may be unreadable or have no audio track.`;
  return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ...base, status, message } };
}

export function registerUploadTools(server: McpServer, client: SonioxClient): void {
  const TranscribeInput = z
    .object({
      file_path: z.string().min(1).describe("Absolute path of an audio or video file on this computer, e.g. C:\\Users\\me\\Videos\\call.mp4"),
      name: z.string().min(1).max(200).optional().describe("Transcript title in Soniox. Default: the file name without extension."),
      language_hints: z
        .array(z.string().regex(/^[a-z]{2,3}$/))
        .max(10)
        .optional()
        .describe("Languages spoken, as ISO 639-1 codes, e.g. ['sl','en']. Improves accuracy; omit to auto-detect."),
      project_id: z.uuid().optional().describe("Soniox project to file it under (from soniox_get_workspace_info). Default: the personal project."),
      recorded_at: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("When the recording was made (ISO datetime). Default: the file's last-modified time."),
      extract_audio: z
        .boolean()
        .default(false)
        .describe("Upload only the audio track (needs ffmpeg). Much faster for large videos; automatic for files over 512 MB."),
      wait_seconds: z.number().int().min(0).max(180).default(45).describe("How long to wait for the result before returning (default 45)."),
    })
    .strict();

  server.registerTool(
    "soniox_transcribe_file",
    {
      title: "Transcribe a local audio or video file with Soniox",
      description: `Upload an audio or video file from this computer to Soniox and transcribe it. The result becomes a normal Soniox transcript (visible in the Soniox app) that soniox_get_transcript can read.

This SENDS THE FILE TO SONIOX'S CLOUD and uses the account's transcription quota, so call it only when the user asked to transcribe that specific file.

Supported directly: mp3, wav, m4a, flac, ogg, opus, webm, mp4, m4v, mov (max 512 MB). Larger files and mkv, avi, wmv, mpg, 3gp, aac, wma, aiff, amr need ffmpeg (on PATH or FFMPEG_PATH) so only the audio track is uploaded.

The call waits up to wait_seconds. Short files finish within that; for longer ones the upload and transcription continue in the background and the response tells you to poll soniox_get_transcription_status.

Args: file_path (required, absolute), name, language_hints, project_id, recorded_at, extract_audio, wait_seconds
Returns: { id, name, status: extracting_audio | uploading | transcribing | completed | error, duration_ms (when completed), message }`,
      inputSchema: TranscribeInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const file = params.file_path.trim().replace(/^"(.*)"$/, "$1");
        if (!isAbsolute(file)) return errorResult(new Error("file_path must be an absolute path."));
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return errorResult(new Error(`No file found at ${file}.`));
        if (info.size === 0) return errorResult(new Error("The file is empty."));

        const ext = extname(file).toLowerCase();
        const direct = DIRECT_TYPES[ext];
        if (!direct && !CONVERT_EXTENSIONS.has(ext)) {
          const known = [...Object.keys(DIRECT_TYPES), ...CONVERT_EXTENSIONS].join(" ");
          return errorResult(new Error(`"${ext || "(no extension)"}" is not a supported audio/video format. Supported: ${known}`));
        }
        const needsFfmpeg = !direct || info.size > MAX_UPLOAD_BYTES || params.extract_audio;
        const ffmpeg = needsFfmpeg ? await findFfmpeg() : null;
        if (needsFfmpeg && !ffmpeg) {
          const why = !direct
            ? `${ext} files have to be converted before upload`
            : info.size > MAX_UPLOAD_BYTES
              ? `the file is ${megabytes(info.size)} and Soniox accepts at most 512 MB`
              : "extract_audio was requested";
          return errorResult(
            new Error(`ffmpeg is required because ${why}, but it was not found. Install ffmpeg or set FFMPEG_PATH in the server's environment.`)
          );
        }

        const name = params.name ?? basename(file, extname(file));
        const record = await client.createTranscription({
          name,
          parameters: { enable_language_identification: true, ...(params.language_hints?.length ? { language_hints: params.language_hints } : {}) },
          project_id: params.project_id,
          recorded_at: params.recorded_at ?? info.mtime.toISOString(),
        });
        const job: Job = { id: record.id, name, file, sizeBytes: info.size, phase: "uploading", startedAt: Date.now(), done: Promise.resolve() };
        jobs.set(record.id, job);
        job.done = runUpload(client, job, { contentType: ffmpeg ? "audio/mp4" : direct!, ffmpeg });

        const deadline = Date.now() + params.wait_seconds * 1000;
        await Promise.race([job.done, sleep(params.wait_seconds * 1000)]);
        while (job.phase === "started" && Date.now() < deadline && (await client.getAsyncStatus(record.id)) === "pending") {
          await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
        }
        return await report(client, record.id);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "soniox_get_transcription_status",
    {
      title: "Check a Soniox file transcription",
      description: `Check how far a file submitted with soniox_transcribe_file has got: extracting_audio, uploading, transcribing, completed, not_started or error.

Args: id (transcript id returned by soniox_transcribe_file)
Returns: { id, status, name, duration_ms (when completed), message }. Once completed, read the text with soniox_get_transcript.`,
      inputSchema: z.object({ id: z.string().min(1).describe("Transcript id returned by soniox_transcribe_file.") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        return await report(client, params.id);
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
