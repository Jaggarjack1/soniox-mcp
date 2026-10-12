# soniox-mcp-server

An MCP server that gives Claude read access to your **Soniox App / Smart Scribe** meeting transcripts.

Soniox has no public API for the app, so this talks to the same private backend the web app at
app.soniox.com uses (`mobile-app-backend.soniox.com`). That API is undocumented and can change
without notice; this project is a personal tool, not something Soniox supports.

## Tools (all read-only)

| Tool | What it does |
| --- | --- |
| `soniox_get_workspace_info` | Signed-in user, organization, projects, tags (ids for filtering) |
| `soniox_list_transcripts` | List / full-text search transcripts with date, project, tag filters and paging |
| `soniox_get_transcript` | Full transcript as speaker-labelled paragraphs with `[mm:ss]` timestamps, paged by characters, optional time window |
| `soniox_search_in_transcript` | Find a phrase inside one transcript; returns timestamped hits with context |

Smart Scribe summaries are generated inside the Soniox app and are **not** stored server-side, so
Claude summarises from the transcript text itself.

## How authentication works

The web app logs in with OAuth2 (PKCE) against the Soniox backend and keeps
`{accessToken, refreshToken, expiresAt}` in `localStorage["authTokens"]`. This server reuses that
refresh token. Facts that shape the design:

- access tokens live 1 hour; refresh tokens rotate on every use
- a used refresh token is revoked a few minutes after rotation
- therefore whoever refreshes must **persist** the newest refresh token

Token stores, picked from the environment in this order:

1. `BLOB_READ_WRITE_TOKEN` → private **Vercel Blob** (persistent, shared between Vercel and local). Seeded from `SONIOX_REFRESH_TOKEN`; changing the seed re-seeds the chain.
2. `SONIOX_TOKEN_FILE` → JSON file in the `authTokens` shape (good for local-only use)
3. `SONIOX_REFRESH_TOKEN` alone → memory only (long-running processes only, **not** serverless)
4. default `./soniox-auth.json`

### Getting a refresh token

1. Log in at https://app.soniox.com
2. DevTools → Application → Local Storage → `https://app.soniox.com` → key `authTokens`
3. Copy the value. Either save it as `soniox-auth.json` (file store) or take its `refreshToken` for `SONIOX_REFRESH_TOKEN`.

If the server ever reports `invalid_grant`, the chain was revoked (e.g. you logged out everywhere):
repeat the steps above and update the seed.

## Local use (Claude Desktop / Claude Code, stdio)

```bash
npm install
npm run build
```

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "soniox": {
      "command": "node",
      "args": ["--env-file=C:\\path\\to\\soniox-mcp\\.env", "C:\\path\\to\\soniox-mcp\\dist\\src\\stdio.js"]
    }
  }
}
```

`.env` (gitignored) holds `BLOB_READ_WRITE_TOKEN` + `SONIOX_REFRESH_TOKEN` (shared chain with Vercel)
or, for a file-only setup, `SONIOX_TOKEN_FILE=C:\path\to\soniox-auth.json`.
If your machine runs antivirus/proxy TLS inspection, also set `NODE_EXTRA_CA_CERTS` there; the stdio
child process does not inherit it automatically.

## Remote use (claude.ai custom connector, Vercel)

`api/mcp.ts` is a stateless Streamable HTTP endpoint. Deploy the repo to Vercel with:

- a **private Blob store** connected to the project (provides `BLOB_READ_WRITE_TOKEN`)
- env `SONIOX_REFRESH_TOKEN` (seed) and `MCP_AUTH_TOKEN` (random shared secret, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)

Then in claude.ai → Settings → Connectors → *Add custom connector*:

- URL: `https://<your-project>.vercel.app/mcp`
- Authentication: *No sign in*
- Request headers: `Authorization: Bearer <MCP_AUTH_TOKEN>`

Connectors added in claude.ai also appear in the Claude desktop and mobile apps.

## Development

```bash
npm run dev            # stdio server with tsx
npm run dev:http       # http://127.0.0.1:3333/mcp (set MCP_AUTH_TOKEN to require a bearer)
npm run build && npx tsx scripts/test-client.ts   # live smoke test against your account
npx @modelcontextprotocol/inspector node dist/src/stdio.js
```

`scripts/probe*.py` are the throwaway scripts used to reverse-engineer the API shapes.

## Troubleshooting

- **`Invalid character in chunk size` / empty responses from the HTTP mode.** Some endpoint-security
  products (seen with AVG on Windows) transparently intercept local HTTP requests whose path ends in
  `/mcp` and corrupt the response framing. The server is fine; use another path: locally set
  `MCP_PATH=/soniox`, and on Vercel the same function is also exposed at `/soniox`.
- **`fetch failed` from the stdio server only.** The child process did not inherit `NODE_EXTRA_CA_CERTS`
  (TLS-inspecting antivirus/proxy). Add it to the `.env` file / `env` block.
- **`invalid_grant` on refresh.** The token chain was revoked (logout, or two deployments sharing one
  seed without the Blob store). Log in again at app.soniox.com and update the seed.

## Security notes

- Never commit `soniox-auth.json` or `.env` (both gitignored).
- The remote endpoint is only as secret as `MCP_AUTH_TOKEN`; rotate it by changing the Vercel env var and the connector header.
- Tools are read-only; the server never deletes, renames or shares transcripts.
