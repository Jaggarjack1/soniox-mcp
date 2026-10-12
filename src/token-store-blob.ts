/**
 * Token store backed by a private Vercel Blob. Needed because Soniox rotates the
 * refresh token on every use and revokes the old one after a few minutes, so a
 * serverless deployment must persist the newest token between cold starts.
 *
 * Requires BLOB_READ_WRITE_TOKEN in the environment (auto-injected by Vercel when
 * the Blob store is connected to the project).
 */
import { get, put } from "@vercel/blob";
import type { TokenStore, Tokens } from "./soniox-client.js";

const BLOB_PATH = "soniox-mcp/tokens.json";

interface StoredTokens extends Tokens {
  /** The SONIOX_REFRESH_TOKEN this chain was seeded from; a different seed in env means re-login → re-seed. */
  seedRefreshToken?: string;
}

export class BlobTokenStore implements TokenStore {
  constructor(private readonly seedRefreshToken: string | undefined) {}

  async load(): Promise<Tokens | null> {
    const stored = await this.read();
    if (stored && (!this.seedRefreshToken || stored.seedRefreshToken === this.seedRefreshToken)) {
      return { accessToken: stored.accessToken, refreshToken: stored.refreshToken, expiresAt: stored.expiresAt };
    }
    if (!this.seedRefreshToken) return null;
    // First run, or the env seed changed (user logged in again): start a fresh chain from the seed.
    return { accessToken: "", refreshToken: this.seedRefreshToken, expiresAt: 0 };
  }

  async save(tokens: Tokens): Promise<void> {
    const payload: StoredTokens = { ...tokens, seedRefreshToken: this.seedRefreshToken };
    await put(BLOB_PATH, JSON.stringify(payload), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
  }

  describe(): string {
    return `Vercel Blob ${BLOB_PATH}`;
  }

  private async read(): Promise<StoredTokens | null> {
    try {
      const res = await get(BLOB_PATH, { access: "private", useCache: false });
      if (!res || res.statusCode !== 200) return null;
      const text = await new Response(res.stream).text();
      const parsed = JSON.parse(text) as Partial<StoredTokens>;
      if (!parsed.refreshToken) return null;
      return {
        accessToken: parsed.accessToken ?? "",
        refreshToken: parsed.refreshToken,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
        seedRefreshToken: parsed.seedRefreshToken,
      };
    } catch (err) {
      // Missing blob → first run. Any other failure is worth surfacing in logs.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not.?found|404/i.test(msg)) console.error("BlobTokenStore read failed:", msg);
      return null;
    }
  }
}
