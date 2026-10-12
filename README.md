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

## Quick start

Prerequisites: Node.js 20+, a Soniox App account (app.soniox.com), and for the remote
option a GitHub account, a Vercel account (free Hobby plan is enough) and the Vercel CLI
(`npm i -g vercel` or use `npx vercel`).

### Shortcut: let Claude Code do it

The only step a human must do is getting the Soniox token (step 1 below) and saving it as
`soniox-auth.json`, for example on your Desktop. Then paste one of these into Claude Code:

**Local (Claude Desktop):**

> Clone github.com/Jaggarjack1/soniox-mcp into my Documents folder, run npm install and npm run build,
> move soniox-auth.json from my Desktop into that folder, then add it to my Claude Desktop config as an
> MCP server called soniox: command node, args the built dist/src/stdio.js, env SONIOX_TOKEN_FILE pointing
> at the token file. Follow the README if anything is unclear.

**Remote (claude.ai connector), after forking this repo on GitHub:**

> Install the Vercel CLI, log me in, then follow the "Remote" section of the README in
> github.com/<your-username>/soniox-mcp: link the forked repo as a new Vercel project, create a private
> Blob store, set the two secrets using the refresh token from soniox-auth.json on my Desktop and a random
> MCP_AUTH_TOKEN, and deploy. Tell me the final URL and the header value I need.

The manual steps follow.

### 1. Get your Soniox refresh token (needed by every setup)

1. Log in at https://app.soniox.com in a desktop browser.
2. Open DevTools (F12) → **Application** → **Local Storage** → `https://app.soniox.com`.
3. Copy the value of the key **`authTokens`**. It looks like
   `{"accessToken":"…","refreshToken":"…","expiresAt":1760000000000}`.

Keep it secret: it grants full access to your transcripts until you log out everywhere.

### 2a. Local only (Claude Desktop / Claude Code)

```bash
git clone https://github.com/Jaggarjack1/soniox-mcp.git
cd soniox-mcp
npm install
npm run build
# save the authTokens JSON from step 1 as soniox-auth.json in this folder (gitignored)
npx tsx scripts/test-client.ts      # optional: live smoke test, should list your transcripts
```

Add the server to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "soniox": {
      "command": "node",
      "args": ["/absolute/path/to/soniox-mcp/dist/src/stdio.js"],
      "env": { "SONIOX_TOKEN_FILE": "/absolute/path/to/soniox-mcp/soniox-auth.json" }
    }
  }
}
```

Restart Claude Desktop. For Claude Code: `claude mcp add soniox -e SONIOX_TOKEN_FILE=/abs/path/soniox-auth.json -- node /abs/path/dist/src/stdio.js`.

### 2b. Remote (claude.ai custom connector, also usable from Claude Desktop/mobile)

Fork or push this repo to your own GitHub, then:

```bash
vercel login
vercel link                                   # pick/create the project
vercel storage create soniox-mcp-tokens --type blob --access private
vercel storage connect soniox-mcp-tokens --auth token --add-rw-token --yes
#   -> injects BLOB_READ_WRITE_TOKEN into the project (persists rotated Soniox tokens)
vercel env add SONIOX_REFRESH_TOKEN production --sensitive   # paste the refreshToken from step 1
vercel env add MCP_AUTH_TOKEN production --sensitive         # paste a random secret, e.g.:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
vercel --prod                                                # deploy
```

Then in claude.ai → **Settings → Connectors → Add custom connector**:

- Name: `Soniox`
- URL: `https://<your-project>.vercel.app/mcp`
- Authentication: **No sign in**
- Request headers: `Authorization` = `Bearer <MCP_AUTH_TOKEN>`

Connectors added in claude.ai also show up in the Claude desktop and mobile apps, so for most
people the remote setup alone covers everything.

### 2c. Both local and remote with one Soniox login

Soniox revokes a refresh token once it has been rotated, so two independent servers cannot share
one `authTokens` value. Either log in twice (one `authTokens` per server), or let the local server
use the same Vercel Blob as the remote one:

```bash
vercel env pull .env.vercel --environment production   # contains BLOB_READ_WRITE_TOKEN
```

Put `BLOB_READ_WRITE_TOKEN=…` and `SONIOX_REFRESH_TOKEN=…` in a local `.env` and start the stdio
server with `node --env-file=/abs/path/.env /abs/path/dist/src/stdio.js` in the Claude Desktop
config (drop the `SONIOX_TOKEN_FILE` entry).

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
