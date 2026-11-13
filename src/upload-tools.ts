/**
 * Local-only write tool: send an audio/video file from this computer to Soniox for transcription.
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
import { z } from "zod";
import { errorResult } from "./mcp-server.js";
import type { SonioxClient } from "./soniox-client.js";
import { CONVERT_EXTENSIONS, DIRECT_TYPES, MAX_UPLOAD_BYTES, jobs, megabytes, waitAndReport, type Job } from "./transcription-jobs.js";

const execFileAsync = promisify(execFile);

export interface SubmitOptions {
  file_path: string;
  name?: string;
  language_hints?: string[];
  project_id?: string;
  recorded_at?: string;
  extract_audio?: boolean;
}

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

/**
 * Checks the file, creates the transcript record and starts the upload in the background (await job.done).
 * Throws before anything is created in Soniox when the file cannot be sent.
 */
export async function submitFile(client: SonioxClient, opts: SubmitOptions): Promise<Job> {
  const file = opts.file_path.trim().replace(/^"(.*)"$/, "$1");
  if (!isAbsolute(file)) throw new Error("file_path must be an absolute path.");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`No file found at ${file}.`);
  if (info.size === 0) throw new Error("The file is empty.");

  const ext = extname(file).toLowerCase();
  const direct = DIRECT_TYPES[ext];
  if (!direct && !CONVERT_EXTENSIONS.has(ext)) {
    const known = [...Object.keys(DIRECT_TYPES), ...CONVERT_EXTENSIONS].join(" ");
    throw new Error(`"${ext || "(no extension)"}" is not a supported audio/video format. Supported: ${known}`);
  }
  const needsFfmpeg = !direct || info.size > MAX_UPLOAD_BYTES || !!opts.extract_audio;
  const ffmpeg = needsFfmpeg ? await findFfmpeg() : null;
  if (needsFfmpeg && !ffmpeg) {
    const why = !direct
      ? `${ext} files have to be converted before upload`
      : info.size > MAX_UPLOAD_BYTES
        ? `the file is ${megabytes(info.size)} and Soniox accepts at most 512 MB`
        : "extract_audio was requested";
    throw new Error(`ffmpeg is required because ${why}, but it was not found. Install ffmpeg or set FFMPEG_PATH in the environment.`);
  }

  const name = opts.name ?? basename(file, extname(file));
  const record = await client.createTranscription({
    name,
    parameters: { enable_language_identification: true, ...(opts.language_hints?.length ? { language_hints: opts.language_hints } : {}) },
    project_id: opts.project_id,
    recorded_at: opts.recorded_at ?? info.mtime.toISOString(),
  });
  const job: Job = { id: record.id, name, file, sizeBytes: info.size, phase: "uploading", startedAt: Date.now(), done: Promise.resolve() };
  jobs.set(record.id, job);
  job.done = runUpload(client, job, { contentType: ffmpeg ? "audio/mp4" : direct!, ffmpeg });
  return job;
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
        const job = await submitFile(client, params);
        return await waitAndReport(client, job, params.wait_seconds);
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
