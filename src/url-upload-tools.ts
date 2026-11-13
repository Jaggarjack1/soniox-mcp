/**
 * Write tool that works on the remote endpoint too: transcribe an audio/video file that is reachable by link.
 * A tool call cannot carry a file, so the server downloads the link and streams it straight into Soniox's
 * upload storage; nothing is kept here. Opt-in with SONIOX_ENABLE_UPLOAD.
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult } from "./mcp-server.js";
import type { PresignedUpload, SonioxClient } from "./soniox-client.js";
import {
  CONVERT_EXTENSIONS,
  DIRECT_TYPES,
  MAX_UPLOAD_BYTES,
  jobs,
  megabytes,
  sleep,
  snapshot,
  waitAndReport,
  type Job,
  type JobStore,
} from "./transcription-jobs.js";

export interface UrlUploadOptions {
  /** Keeps a serverless invocation alive until the transfer has finished (Vercel's waitUntil). */
  keepAlive?: (work: Promise<unknown>) => void;
  /** Where job state is kept when the status call may reach another instance. */
  jobStore?: JobStore;
  /** Give up on a transfer after this long, so it fails with a message instead of being cut off. */
  maxTransferMs?: number;
}

const MAX_REDIRECTS = 5;

/** For links whose file name is not visible (Drive, signed URLs): fall back to the declared media type. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/m4a": ".m4a",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "application/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/webm": ".webm",
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "video/x-m4v": ".m4v",
  "video/quicktime": ".mov",
};

/** Addresses the server must never fetch from: loopback, private networks, link-local, multicast. */
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 127], // :: and ::1
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

/** Only public https addresses are fetched. Checked for the link itself and for every redirect. */
async function assertPublicHttps(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("Only https:// links are accepted.");
  if (url.username || url.password) throw new Error("Links with a username or password in them are not accepted.");
  if (url.port && url.port !== "443") throw new Error("Links on a non-standard port are not accepted.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    addresses = await lookup(host, { all: true }).catch(() => []);
    if (!addresses.length) throw new Error(`The host ${host} could not be found.`);
  }
  if (addresses.some((a) => blocked.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) {
    throw new Error("Links to private or local network addresses are not accepted.");
  }
}

/** Turns the share links people actually paste into direct downloads. */
export function normalizeShareLink(url: URL): URL {
  const host = url.hostname.toLowerCase();
  if (host === "dropbox.com" || host === "www.dropbox.com") {
    const direct = new URL(url);
    direct.searchParams.set("dl", "1");
    return direct;
  }
  if (host === "drive.google.com") {
    const id = /\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
    if (id && /^[\w-]+$/.test(id)) return new URL(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
  }
  return url;
}

async function openSource(start: URL, signal?: AbortSignal): Promise<{ res: Response; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttps(url);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal,
        // identity: the announced length must be the number of bytes that arrive
        headers: { "accept-encoding": "identity", "user-agent": "soniox-mcp-server", accept: "*/*" },
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`Could not download from ${url.hostname} (${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}).`);
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, url };
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location) throw new Error(`${url.hostname} redirected without saying where to.`);
    url = new URL(location, url);
  }
  throw new Error("The link redirects too many times.");
}

function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

function pathFilename(url: URL): string | undefined {
  try {
    return decodeURIComponent(basename(url.pathname)) || undefined;
  } catch {
    return undefined;
  }
}

interface SourceInfo {
  /** File name when the link reveals one. */
  filename?: string;
  extension: string;
  contentType: string;
  /** Announced size, or null when the server does not say. */
  size: number | null;
  lastModified?: string;
}

/** Decides from the response whether this is a media file Soniox accepts. Throws a user-facing error if not. */
function inspectSource(res: Response, finalUrl: URL, originalUrl: URL): SourceInfo {
  const host = finalUrl.hostname;
  if (res.status === 401 || res.status === 403) throw new Error(`${host} refused the download (HTTP ${res.status}). The link has to work without signing in.`);
  if (res.status === 404 || res.status === 410) throw new Error(`${host} has no file at that link (HTTP ${res.status}).`);
  if (res.status !== 200) throw new Error(`${host} answered HTTP ${res.status} instead of the file.`);

  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const names = [dispositionFilename(res.headers.get("content-disposition")), pathFilename(finalUrl), pathFilename(originalUrl)];
  const known = (n?: string) => !!n && (extname(n).toLowerCase() in DIRECT_TYPES || CONVERT_EXTENSIONS.has(extname(n).toLowerCase()));
  const filename = names.find(known);
  const extension = filename ? extname(filename).toLowerCase() : EXTENSION_BY_MIME[mime];

  if (!extension) {
    if (mime === "text/html" || mime === "application/xhtml+xml") {
      throw new Error(
        "The link opens a web page, not a media file. Use a direct download link. Dropbox and Google Drive share links work when the file is shared with anyone who has the link."
      );
    }
    throw new Error(`The link does not look like an audio or video file (type "${mime || "unknown"}"). Supported: ${Object.keys(DIRECT_TYPES).join(" ")}`);
  }
  if (!(extension in DIRECT_TYPES)) {
    throw new Error(`${extension} files have to be converted before upload, which only the local server can do (soniox_transcribe_file with ffmpeg).`);
  }

  const encoded = (res.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity";
  const announced = Number(res.headers.get("content-length"));
  const size = !encoded && Number.isInteger(announced) && announced > 0 ? announced : null;
  if (size !== null && size > MAX_UPLOAD_BYTES) {
    throw new Error(`The file is ${megabytes(size)} and Soniox accepts at most 512 MB. The local server can extract the audio track first.`);
  }
  const modified = Date.parse(res.headers.get("last-modified") ?? "");
  return {
    filename: filename ?? names.find(Boolean),
    extension,
    contentType: DIRECT_TYPES[extension],
    size,
    lastModified: Number.isNaN(modified) ? undefined : new Date(modified).toISOString(),
  };
}

/** Sends a stream of known length to the presigned upload as multipart/form-data, without buffering it. */
async function postToStorage(pre: PresignedUpload, contentType: string, body: Readable, size: number, signal?: AbortSignal): Promise<void> {
  const boundary = `----soniox-mcp-${randomUUID()}`;
  let head = "";
  for (const [k, v] of Object.entries(pre.fields)) head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  // the file must be the last field
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const prefix = Buffer.from(head, "utf8");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  async function* parts(): AsyncGenerator<Buffer> {
    yield prefix;
    let sent = 0;
    for await (const chunk of body) {
      sent += (chunk as Buffer).length;
      if (sent > size) throw new Error("The download sent more data than it announced.");
      yield chunk as Buffer;
    }
    if (sent !== size) throw new Error(`The download ended early (${megabytes(sent)} of ${megabytes(size)}).`);
    yield suffix;
  }

  let req!: ReturnType<typeof httpsRequest>;
  const responded = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = httpsRequest(
      pre.url,
      {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": prefix.length + size + suffix.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
  });
  responded.catch(() => {}); // handled below; avoids an unhandled rejection when the send fails first

  try {
    await pipeline(Readable.from(parts()), req, { signal });
  } catch (err) {
    // Storage may answer with an error and close the connection before the whole body is sent.
    const early = await Promise.race([responded.catch(() => null), sleep(1000).then(() => null)]);
    if (!early || (early.status >= 200 && early.status < 300)) throw err;
  }
  const answer = await responded;
  if (answer.status < 200 || answer.status >= 300) {
    const code = /<Code>([^<]+)<\/Code>/.exec(answer.body)?.[1];
    throw new Error(`Soniox storage rejected the upload (HTTP ${answer.status}${code ? `, ${code}` : ""}).`);
  }
}

/** For downloads that do not announce a length: write to a temp file first, so the length is known. */
async function spool(body: Readable, signal?: AbortSignal): Promise<{ path: string; size: number }> {
  const path = join(tmpdir(), `soniox-mcp-${randomUUID()}.bin`);
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > MAX_UPLOAD_BYTES ? new Error("The file is larger than Soniox's 512 MB upload limit.") : null, chunk);
    },
  });
  try {
    await pipeline(body, cap, createWriteStream(path), { signal });
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
  if (size === 0) {
    await unlink(path).catch(() => {});
    throw new Error("The link returned an empty file.");
  }
  return { path, size };
}

/** Moves the download into Soniox and starts the transcription. Records the outcome on the job; never throws. */
export async function transferSource(
  client: SonioxClient,
  job: Job,
  source: { body: Readable; size: number | null; contentType: string },
  signal?: AbortSignal
): Promise<void> {
  let temp: string | undefined;
  try {
    job.phase = "transferring";
    let body = source.body;
    let size = source.size;
    if (size === null) {
      const spooled = await spool(body, signal);
      temp = spooled.path;
      size = job.sizeBytes = spooled.size;
      body = createReadStream(temp);
    }
    const pre = await client.getPresignedUpload(job.id, source.contentType);
    await postToStorage(pre, source.contentType, body, size, signal);
    await client.startAsyncTranscription(job.id, pre.fields.key);
    job.phase = "started";
  } catch (err) {
    source.body.destroy();
    job.phase = "error";
    job.error = signal?.aborted
      ? "The transfer did not finish within the server's time limit. Try a smaller file, or use the local server."
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    if (temp) await unlink(temp).catch(() => {});
  }
}

export function registerUrlUploadTools(server: McpServer, client: SonioxClient, opts: UrlUploadOptions = {}): void {
  const Input = z
    .object({
      url: z.string().min(1).max(2000).describe("https link to an audio or video file, e.g. a Dropbox or Google Drive share link or a direct download URL."),
      name: z.string().min(1).max(200).optional().describe("Transcript title in Soniox. Default: the file name without extension."),
      language_hints: z
        .array(z.string().regex(/^[a-z]{2,3}$/))
        .max(10)
        .optional()
        .describe("Languages spoken, as ISO 639-1 codes, e.g. ['sl','en']. Improves accuracy; omit to auto-detect."),
      project_id: z.uuid().optional().describe("Soniox project to file it under (from soniox_get_workspace_info). Default: the personal project."),
      recorded_at: z.iso.datetime({ offset: true }).optional().describe("When the recording was made (ISO datetime). Default: the file's last-modified date, else now."),
      wait_seconds: z.number().int().min(0).max(120).default(40).describe("How long to wait for the result before returning (default 40)."),
    })
    .strict();

  server.registerTool(
    "soniox_transcribe_url",
    {
      title: "Transcribe an audio or video file from a link with Soniox",
      description: `Download an audio or video file from an https link and transcribe it with Soniox. The result becomes a normal Soniox transcript (visible in the Soniox app) that soniox_get_transcript can read. Use this when the user gives a link to a recording; a file attached in chat cannot be passed to a tool.

This SENDS THE FILE TO SONIOX'S CLOUD and uses the account's transcription quota, so call it only when the user asked to transcribe that specific link.

The link must work without signing in. Dropbox and Google Drive share links are turned into direct downloads automatically (the file has to be shared with "anyone with the link"). Links to web pages such as YouTube do not work.

Supported: mp3, wav, m4a, flac, ogg, opus, webm, mp4, m4v, mov, up to 512 MB. On the hosted server the transfer has a few minutes, so very large files can time out.

The call waits up to wait_seconds. For longer files the transfer and transcription continue in the background and the response tells you to poll soniox_get_transcription_status.

Args: url (required), name, language_hints, project_id, recorded_at, wait_seconds
Returns: { id, name, status: transferring | transcribing | completed | error, duration_ms (when completed), message }`,
      inputSchema: Input,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        let original: URL;
        try {
          original = new URL(params.url.trim());
        } catch {
          return errorResult(new Error("url is not a valid link."));
        }
        const signal = opts.maxTransferMs ? AbortSignal.timeout(opts.maxTransferMs) : undefined;
        const { res, url: finalUrl } = await openSource(normalizeShareLink(original), signal);
        let info: SourceInfo;
        try {
          info = inspectSource(res, finalUrl, original);
          if (!res.body) throw new Error("The link returned an empty file.");
        } catch (err) {
          await res.body?.cancel().catch(() => {});
          throw err;
        }

        const name = params.name ?? (info.filename ? basename(info.filename, extname(info.filename)) : `Recording from ${finalUrl.hostname}`);
        let job: Job;
        try {
          const record = await client.createTranscription({
            name,
            parameters: { enable_language_identification: true, ...(params.language_hints?.length ? { language_hints: params.language_hints } : {}) },
            project_id: params.project_id,
            recorded_at: params.recorded_at ?? info.lastModified,
          });
          job = {
            id: record.id,
            name,
            // host and file name only: the full link can contain a share secret
            file: `${finalUrl.hostname}/${info.filename ?? `download${info.extension}`}`,
            sizeBytes: info.size,
            phase: "transferring",
            startedAt: Date.now(),
            done: Promise.resolve(),
          };
          jobs.set(job.id, job);
          await opts.jobStore?.save(snapshot(job));
        } catch (err) {
          await res.body.cancel().catch(() => {});
          throw err;
        }

        const body = Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>);
        job.done = transferSource(client, job, { body, size: info.size, contentType: info.contentType }, signal).then(async () => {
          await opts.jobStore?.save(snapshot(job)).catch((e) => console.error("could not store job state:", e instanceof Error ? e.message : e));
        });
        opts.keepAlive?.(job.done);
        return await waitAndReport(client, job, params.wait_seconds, opts.jobStore);
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
