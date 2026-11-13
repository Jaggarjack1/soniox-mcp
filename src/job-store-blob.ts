/**
 * Job state in the private Vercel Blob store, so that a status call on the serverless endpoint can tell
 * how a transfer started by another instance went. Requires BLOB_READ_WRITE_TOKEN.
 */
import { get, put } from "@vercel/blob";
import type { JobState, JobStore } from "./transcription-jobs.js";

const blobPath = (id: string) => `soniox-mcp/jobs/${id}.json`;

export class BlobJobStore implements JobStore {
  constructor(readonly staleAfterMs: number) {}

  async save(state: JobState): Promise<void> {
    await put(blobPath(state.id), JSON.stringify(state), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
  }

  async load(id: string): Promise<JobState | null> {
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) return null;
    try {
      const res = await get(blobPath(id), { access: "private", useCache: false });
      if (!res || res.statusCode !== 200) return null;
      const parsed = JSON.parse(await new Response(res.stream).text()) as Partial<JobState>;
      if (parsed.id !== id || !parsed.phase || typeof parsed.startedAt !== "number") return null;
      return parsed as JobState;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not.?found|404/i.test(msg)) console.error("BlobJobStore read failed:", msg);
      return null;
    }
  }
}
