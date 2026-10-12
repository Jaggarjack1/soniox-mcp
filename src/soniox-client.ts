/**
 * Minimal client for the private Soniox App backend used by app.soniox.com
 * and the Soniox Desktop app. This API is undocumented and may change.
 */
import { readFile, writeFile } from "node:fs/promises";

export const API_BASE = "https://mobile-app-backend.soniox.com";
const OAUTH_CLIENT_ID = "MobileApp";
const OAUTH_CLIENT_SECRET = "MobileApp";
const REQUIRED_HEADERS = { "x-os": "Web", "x-app-version": "100.0.0" };
const REFRESH_MARGIN_MS = 60_000;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface TokenStore {
  load(): Promise<Tokens | null>;
  save(tokens: Tokens): Promise<void>;
  describe(): string;
}

/** Stores tokens in a JSON file (same shape app.soniox.com keeps in localStorage.authTokens). */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Tokens | null> {
    try {
      const raw = (await readFile(this.path, "utf8")).replace(/^﻿/, "");
      const parsed = JSON.parse(raw) as Partial<Tokens>;
      if (!parsed.refreshToken) return null;
      return {
        accessToken: parsed.accessToken ?? "",
        refreshToken: parsed.refreshToken,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      };
    } catch {
      return null;
    }
  }

  async save(tokens: Tokens): Promise<void> {
    await writeFile(this.path, JSON.stringify(tokens, null, 1), "utf8");
  }

  describe(): string {
    return `token file ${this.path}`;
  }
}

/** Seeds from env vars and keeps rotated tokens in memory only (serverless-friendly). */
export class MemoryTokenStore implements TokenStore {
  private tokens: Tokens | null;

  constructor(seedRefreshToken: string, seedAccessToken?: string) {
    this.tokens = { accessToken: seedAccessToken ?? "", refreshToken: seedRefreshToken, expiresAt: 0 };
  }

  async load(): Promise<Tokens | null> {
    return this.tokens;
  }

  async save(tokens: Tokens): Promise<void> {
    this.tokens = tokens;
  }

  describe(): string {
    return "env SONIOX_REFRESH_TOKEN (in-memory)";
  }
}

/**
 * Pick a token store from the environment, in priority order:
 *  1. BLOB_READ_WRITE_TOKEN  → private Vercel Blob (shared, persistent; seeded from SONIOX_REFRESH_TOKEN)
 *  2. SONIOX_TOKEN_FILE      → JSON file
 *  3. SONIOX_REFRESH_TOKEN   → in-memory only (fine for a long-running process, NOT for serverless)
 *  4. ./soniox-auth.json
 */
export async function tokenStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<TokenStore> {
  if (env.BLOB_READ_WRITE_TOKEN) {
    const { BlobTokenStore } = await import("./token-store-blob.js");
    return new BlobTokenStore(env.SONIOX_REFRESH_TOKEN);
  }
  if (env.SONIOX_TOKEN_FILE) return new FileTokenStore(env.SONIOX_TOKEN_FILE);
  if (env.SONIOX_REFRESH_TOKEN) return new MemoryTokenStore(env.SONIOX_REFRESH_TOKEN, env.SONIOX_ACCESS_TOKEN);
  return new FileTokenStore("soniox-auth.json");
}

/** Node's fetch hides the real reason (DNS, TLS, proxy) in error.cause; surface it. */
async function safeFetch(input: string | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new Error(
      `Network error calling Soniox (${detail}). ` +
        "If this runs behind antivirus/proxy TLS inspection, make sure NODE_EXTRA_CA_CERTS is set in the server's environment."
    );
  }
}

export class SonioxApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string
  ) {
    super(message);
    this.name = "SonioxApiError";
  }
}

// ---- API types (only the fields we use) ----
export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  language: string | null;
  confidence?: number;
}

export interface SonioxTag {
  id: string;
  tag: string;
  default?: boolean;
}

export interface SonioxTranscriptionSummary {
  id: string;
  name: string;
  project_id: string;
  organization_id: string;
  author?: { id: string; first_name?: string; last_name?: string; email?: string };
  transcription_string_start?: string;
  created_at: string;
  updated_at: string;
  transcription_started_at?: string | null;
  transcription_finished_at?: string | null;
  recording_duration_ms: number;
  async_transcription_status?: string;
  transcription_type?: string;
  shared?: boolean;
  speaker_names?: Record<string, string | null>;
  tags?: SonioxTag[];
  analysis_results?: unknown[];
}

export interface SonioxTranscription extends SonioxTranscriptionSummary {
  tokens: SonioxToken[];
  parameters?: { language_hints?: string[]; enable_speaker_diarization?: boolean };
}

export interface SonioxProject {
  id: string;
  name: string;
  description?: string;
  is_personal?: boolean;
  transcription_count?: number;
  member_count?: number;
}

export interface SonioxUserInfo {
  id: string;
  first_name?: string;
  last_name?: string;
  email: string;
  memberships: { organization_id: string; organization_name: string; is_personal: boolean }[];
}

export type OrderBy =
  | "name"
  | "-name"
  | "created_at"
  | "-created_at"
  | "transcription_started_at"
  | "-transcription_started_at";

export interface ListTranscriptsParams {
  limit?: number;
  offset?: number;
  search?: string;
  project_id?: string;
  tag_ids?: string[];
  created_after?: string;
  created_before?: string;
  order_by?: OrderBy;
  transcription_type?: "transcription" | "translation";
  organization_id?: string;
}

type QueryValue = string | number | string[] | undefined;

export class SonioxClient {
  private refreshing: Promise<Tokens> | null = null;
  private cached: Tokens | null = null;
  private orgIdCache: string | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly baseUrl: string = API_BASE
  ) {}

  describeAuth(): string {
    return this.store.describe();
  }

  // ---- auth ----
  private isFresh(t: Tokens): boolean {
    return !!t.accessToken && t.expiresAt - REFRESH_MARGIN_MS > Date.now();
  }

  private async currentTokens(): Promise<Tokens> {
    if (this.cached && this.isFresh(this.cached)) return this.cached;
    const t = this.cached ?? (await this.store.load());
    if (!t) {
      throw new Error(
        `No Soniox credentials found (${this.store.describe()}). ` +
          "Log in at https://app.soniox.com, copy the localStorage value 'authTokens' into soniox-auth.json, " +
          "or set SONIOX_REFRESH_TOKEN."
      );
    }
    if (this.isFresh(t)) {
      this.cached = t;
      return t;
    }
    return this.refresh(t.refreshToken);
  }

  private refresh(refreshToken: string): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(refreshToken).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(refreshToken: string): Promise<Tokens> {
    try {
      return await this.exchangeRefreshToken(refreshToken);
    } catch (err) {
      // Another instance may have rotated the token (serverless): reload the store and retry once.
      const latest = await this.store.load();
      if (latest && latest.refreshToken !== refreshToken) {
        if (this.isFresh(latest)) {
          this.cached = latest;
          return latest;
        }
        return this.exchangeRefreshToken(latest.refreshToken);
      }
      throw err;
    }
  }

  private async exchangeRefreshToken(refreshToken: string): Promise<Tokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    });
    const res = await safeFetch(`${this.baseUrl}/o/token/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...REQUIRED_HEADERS,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new SonioxApiError(
        res.status,
        `Soniox token refresh failed (${res.status}). The stored refresh token is probably revoked. ` +
          "Log in at https://app.soniox.com again and update the stored credentials.",
        text
      );
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    const tokens: Tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.cached = tokens;
    await this.store.save(tokens);
    return tokens;
  }

  // ---- http ----
  async request<T>(
    path: string,
    opts: { method?: string; query?: Record<string, QueryValue>; body?: unknown; raw?: boolean } = {},
    retry = true
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
      else url.searchParams.set(k, String(v));
    }
    const tokens = await this.currentTokens();
    const res = await safeFetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: opts.raw ? "*/*" : "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...REQUIRED_HEADERS,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 && retry) {
      await this.refresh(tokens.refreshToken);
      return this.request<T>(path, opts, false);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new SonioxApiError(res.status, `Soniox API ${opts.method ?? "GET"} ${path} failed with ${res.status}`, text);
    }
    if (opts.raw) return (await res.text()) as unknown as T;
    return (await res.json()) as T;
  }

  // ---- endpoints ----
  getUserInfo(): Promise<SonioxUserInfo> {
    return this.request<SonioxUserInfo>("/api/v1/user/info");
  }

  async getOrganizationId(): Promise<string> {
    if (this.orgIdCache) return this.orgIdCache;
    const info = await this.getUserInfo();
    const personal = info.memberships.find((m) => m.is_personal) ?? info.memberships[0];
    if (!personal) throw new Error("Soniox account has no organization membership.");
    this.orgIdCache = personal.organization_id;
    return this.orgIdCache;
  }

  async listProjects(): Promise<SonioxProject[]> {
    const organization_id = await this.getOrganizationId();
    const r = await this.request<{ projects: SonioxProject[] }>("/api/v1/projects/", { query: { organization_id } });
    return r.projects;
  }

  async listTags(): Promise<SonioxTag[]> {
    const r = await this.request<{ tags: SonioxTag[] }>("/api/v1/tags/");
    return r.tags;
  }

  async listTranscripts(
    params: ListTranscriptsParams
  ): Promise<{ transcriptions: SonioxTranscriptionSummary[]; count: number }> {
    const organization_id = params.organization_id ?? (await this.getOrganizationId());
    return this.request("/api/v1/transcriptions/", {
      query: {
        organization_id,
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
        search: params.search,
        project_id: params.project_id,
        tag_ids: params.tag_ids,
        created_after: params.created_after,
        created_before: params.created_before,
        order_by: params.order_by,
        transcription_type: params.transcription_type,
      },
    });
  }

  async getTranscript(id: string): Promise<SonioxTranscription> {
    const r = await this.request<{ transcription: SonioxTranscription }>(
      `/api/v1/transcriptions/${encodeURIComponent(id)}`
    );
    return r.transcription;
  }

  /** Server-side export in a text format (the API also offers pdf/docx, which are binary). */
  exportTranscript(
    id: string,
    format: "txt" | "md",
    opts: { speakerLabels?: boolean; timestamps?: boolean } = {}
  ): Promise<string> {
    return this.request<string>(`/api/v1/transcriptions/${encodeURIComponent(id)}/export`, {
      method: "POST",
      raw: true,
      body: {
        format,
        speaker_labels: opts.speakerLabels ?? true,
        timestamps: opts.timestamps ?? true,
        language_labels: false,
        filename: "transcript",
      },
    });
  }
}
