/**
 * Shared by the write tools (upload-tools.ts for local files, url-upload-tools.ts for links):
 * accepted formats, the uploads this process has in flight, and the status report / status tool.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatDuration } from "./format.js";
import { errorResult, text } from "./mcp-server.js";
import type { SonioxClient } from "./soniox-client.js";

/** The write tools are opt-in: SONIOX_ENABLE_UPLOAD=1 in the server's environment. */
export const uploadEnabled = (env: NodeJS.ProcessEnv = process.env) => /^(1|true|yes)$/i.test(env.SONIOX_ENABLE_UPLOAD ?? "");

/** Limit enforced by the presigned upload policy. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Formats uploaded as they are. Soniox only issues upload links for a few audio/* content types but
 * detects the real format from the bytes, so video containers go up labelled as audio (verified with mp4).
 */
export const DIRECT_TYPES: Record<string, string> = {
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
/** Formats with no accepted content type: the audio track has to be converted to m4a with ffmpeg first. */
export const CONVERT_EXTENSIONS = new Set([".mkv", ".avi", ".wmv", ".mpg", ".mpeg", ".3gp", ".aac", ".wma", ".aiff", ".aif", ".amr"]);

export type Phase = "extracting_audio" | "uploading" | "transferring" | "started" | "error";

/** What is known about one submission. `file` is a display label (a path, or host/filename for links). */
export interface JobState {
  id: string;
  name: string;
  file: string;
  sizeBytes: number | null;
  phase: Phase;
  error?: string;
  startedAt: number;
}

export interface Job extends JobState {
  /** Settles when the upload has been handed to Soniox or has failed; never rejects. */
  done: Promise<void>;
}

/**
 * Keeps job state outside the process. Needed on serverless, where the status call can land on an
 * instance that never saw the upload.
 */
export interface JobStore {
  save(state: JobState): Promise<void>;
  load(id: string): Promise<JobState | null>;
  /** A stored job still marked in progress after this long was cut off by the platform's time limit. */
  readonly staleAfterMs: number;
}

/** Uploads started by this server process. Lost on restart; the Soniox record then stays "not_started". */
export const jobs = new Map<string, Job>();

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function snapshot(job: Job): JobState {
  const { done: _done, ...state } = job;
  return state;
}

/** One status report, combining what is known about the upload with what Soniox reports. */
export async function report(client: SonioxClient, id: string, store?: JobStore): Promise<CallToolResult> {
  let job: JobState | undefined = jobs.get(id);
  if (!job && store) {
    const stored = await store.load(id);
    if (stored) {
      const cutOff = stored.phase !== "started" && stored.phase !== "error" && Date.now() - stored.startedAt > store.staleAfterMs;
      job = cutOff
        ? { ...stored, phase: "error", error: "The transfer did not finish within the server's time limit. Try a smaller file, or use the local server." }
        : stored;
    }
  }
  const base = {
    id,
    ...(job ? { name: job.name, file: job.file, size_bytes: job.sizeBytes, elapsed_seconds: Math.round((Date.now() - job.startedAt) / 1000) } : {}),
  };
  const check = `Check again with soniox_get_transcription_status (id=${id}).`;

  if (job?.phase === "error") {
    const message = `Upload failed: ${job.error} An empty transcript "${job.name}" was left in Soniox and can be deleted in the app.`;
    return { isError: true, content: [{ type: "text", text: message }], structuredContent: { ...base, status: "error", message } };
  }
  if (job && job.phase !== "started") {
    const size = job.sizeBytes ? `${megabytes(job.sizeBytes)} ` : "";
    const doing =
      job.phase === "uploading"
        ? `Uploading ${size}to Soniox`
        : job.phase === "transferring"
          ? `Transferring ${size}from the link to Soniox`
          : "Extracting the audio track with ffmpeg";
    const message = `${doing} (${base.elapsed_seconds} s so far). It continues in the background. ${check}`;
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

/** Waits up to waitSeconds for the upload and the transcription, then reports where things stand. */
export async function waitAndReport(client: SonioxClient, job: Job, waitSeconds: number, store?: JobStore): Promise<CallToolResult> {
  const deadline = Date.now() + waitSeconds * 1000;
  await Promise.race([job.done, sleep(waitSeconds * 1000)]);
  while (job.phase === "started" && Date.now() < deadline && (await client.getAsyncStatus(job.id)) === "pending") {
    await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
  }
  return report(client, job.id, store);
}

export function registerStatusTool(server: McpServer, client: SonioxClient, store?: JobStore): void {
  server.registerTool(
    "soniox_get_transcription_status",
    {
      title: "Check a Soniox file transcription",
      description: `Check how far a file submitted with soniox_transcribe_file or soniox_transcribe_url has got: extracting_audio, uploading, transferring, transcribing, completed, not_started or error.

Args: id (transcript id returned when the file was submitted)
Returns: { id, status, name, duration_ms (when completed), message }. Once completed, read the text with soniox_get_transcript.`,
      inputSchema: z.object({ id: z.string().min(1).describe("Transcript id returned when the file was submitted.") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        return await report(client, params.id, store);
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
