/**
 * Self-hosted Streamable HTTP entry point (stateless). Useful for local testing
 * of the remote mode or for running on your own server.
 *
 * Uses the web-standard transport with a small Node bridge so the same code path
 * runs here and in api/mcp.ts (Vercel).
 *
 * Env: PORT (default 3333), HOST (default 127.0.0.1), MCP_PATH (default /mcp),
 *      MCP_AUTH_TOKEN (required unless HOST is loopback),
 *      BLOB_READ_WRITE_TOKEN | SONIOX_TOKEN_FILE | SONIOX_REFRESH_TOKEN
 *
 * Note: some endpoint-security products intercept local HTTP for paths ending in "/mcp"
 * and corrupt the response framing. If clients see "Invalid character in chunk size",
 * set MCP_PATH to something else (e.g. /soniox).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SonioxClient, tokenStoreFromEnv } from "./soniox-client.js";
import { createSonioxServer } from "./server.js";
import { bearerMatches } from "./auth.js";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

if (!AUTH_TOKEN && !isLoopback) {
  console.error("Refusing to bind to a non-loopback host without MCP_AUTH_TOKEN set.");
  process.exit(1);
}

const client = new SonioxClient(await tokenStoreFromEnv());

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function toWebRequest(req: IncomingMessage, body: Buffer): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  return new Request(url, { method, headers, body: hasBody ? new Uint8Array(body) : undefined });
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((v: string, k: string) => {
    if (k.toLowerCase() !== "transfer-encoding") headers[k] = v;
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  headers["content-length"] = String(buf.length);
  res.writeHead(webRes.status, headers);
  res.end(buf);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end("Not found");
    return;
  }
  if (AUTH_TOKEN && !bearerMatches(req.headers.authorization, AUTH_TOKEN)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
    return;
  }
  const body = await readBody(req);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createSonioxServer(client);
  await server.connect(transport);
  try {
    const webRes = await transport.handleRequest(toWebRequest(req, body));
    await sendWebResponse(webRes, res);
  } finally {
    void transport.close();
    void server.close();
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("request failed:", err);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  });
}).listen(PORT, HOST, () => {
  console.error(
    `soniox-mcp-server listening on http://${HOST}:${PORT}${MCP_PATH} (auth: ${client.describeAuth()}; bearer ${AUTH_TOKEN ? "required" : "disabled"})`
  );
});
