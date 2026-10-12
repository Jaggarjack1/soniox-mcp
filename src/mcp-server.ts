/**
 * MCP server definition: read-only tools over Soniox App meeting transcripts.
 * Transport-agnostic; see stdio.ts, http.ts and api/mcp.ts (file is named mcp-server.ts because Vercel treats src/server.ts as an app entrypoint) for entry points.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  SonioxApiError,
  type SonioxClient,
  type SonioxTranscription,
  type SonioxTranscriptionSummary,
} from "./soniox-client.js";
import {
  buildSegments,
  formatDuration,
  paginateText,
  renderSegments,
  searchSegments,
  speakerLabel,
  summaryLine,
  transcriptHeader,
} from "./format.js";

export const SERVER_NAME = "soniox-mcp-server";
export const SERVER_VERSION = "0.1.0";

const DEFAULT_PAGE_CHARS = 30_000;
const MAX_PAGE_CHARS = 120_000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return structured ? { content: [{ type: "text", text: t }], structuredContent: structured } : { content: [{ type: "text", text: t }] };
}

function errorResult(err: unknown): CallToolResult {
  let msg: string;
  if (err instanceof SonioxApiError) {
    if (err.status === 404) msg = "Error: transcript not found. Check the id with soniox_list_transcripts.";
    else if (err.status === 401 || err.status === 403)
      msg = "Error: Soniox rejected the credentials. The stored refresh token may be revoked; log in at https://app.soniox.com again and update the stored credentials.";
    else if (err.status === 422) msg = `Error: Soniox rejected the request parameters: ${err.body ?? ""}`.trim();
    else if (err.status === 429) msg = "Error: Soniox rate limit hit. Wait a moment and retry.";
    else msg = `Error: ${err.message}${err.body ? ` — ${err.body.slice(0, 300)}` : ""}`;
  } else if (err instanceof Error) {
    msg = `Error: ${err.message}`;
  } else {
    msg = `Error: ${String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function speakerSummary(t: SonioxTranscription): { ids: string[]; labels: string[] } {
  const ids = new Set<string>();
  for (const tok of t.tokens) if (tok.speaker) ids.add(tok.speaker);
  const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
  return { ids: sorted, labels: sorted.map((id) => speakerLabel(id, t.speaker_names)) };
}

function listItem(t: SonioxTranscriptionSummary) {
  return {
    id: t.id,
    name: t.name,
    recorded_at: t.transcription_started_at ?? t.created_at,
    duration_ms: t.recording_duration_ms,
    duration: formatDuration(t.recording_duration_ms),
    project_id: t.project_id,
    tags: (t.tags ?? []).map((x) => x.tag),
    status: t.async_transcription_status ?? "completed",
    type: t.transcription_type ?? "transcription",
    preview: (t.transcription_string_start ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

export function createSonioxServer(client: SonioxClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ------------------------------------------------------------------ workspace
  server.registerTool(
    "soniox_get_workspace_info",
    {
      title: "Soniox workspace info",
      description: `Get the signed-in Soniox user, their organization, projects (with transcript counts) and tags.

Call this first when you need a project_id or tag id for filtering soniox_list_transcripts, or to confirm which account the server is connected to. Takes no arguments.

Returns markdown listing: user name/email, organization id, projects (name, id, transcript count), tags (name, id).`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [user, projects, tags] = await Promise.all([client.getUserInfo(), client.listProjects(), client.listTags()]);
        const org = user.memberships.find((m) => m.is_personal) ?? user.memberships[0];
        const lines = [
          `# Soniox workspace`,
          `- user: ${[user.first_name, user.last_name].filter(Boolean).join(" ")} <${user.email}>`,
          `- organization: ${org?.organization_name ?? "?"} (${org?.organization_id ?? "?"})`,
          ``,
          `## Projects`,
          ...projects.map((p) => `- ${p.name} — id: ${p.id}${p.transcription_count !== undefined ? ` · ${p.transcription_count} transcripts` : ""}`),
          ``,
          `## Tags`,
          ...(tags.length ? tags.map((t) => `- ${t.tag} — id: ${t.id}`) : ["- (none)"]),
        ];
        return text(lines.join("\n"), {
          user: { id: user.id, email: user.email, name: [user.first_name, user.last_name].filter(Boolean).join(" ") },
          organization_id: org?.organization_id,
          projects: projects.map((p) => ({ id: p.id, name: p.name, transcription_count: p.transcription_count })),
          tags: tags.map((t) => ({ id: t.id, name: t.tag })),
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------ list / search
  const ListInput = z
    .object({
      search: z
        .string()
        .max(200)
        .optional()
        .describe("Full-text search across transcript titles AND spoken content (e.g. 'funnel', 'Flyamelia'). Omit to list everything."),
      created_after: z
        .string()
        .optional()
        .describe("Only transcripts recorded on/after this date. ISO date or datetime, e.g. '2026-09-01' or '2026-09-01T00:00:00Z'."),
      created_before: z.string().optional().describe("Only transcripts recorded before this date (ISO date or datetime)."),
      project_id: z.string().optional().describe("Filter by project id (from soniox_get_workspace_info)."),
      tag_ids: z.array(z.string()).optional().describe("Filter by one or more tag ids (from soniox_get_workspace_info)."),
      transcription_type: z.enum(["transcription", "translation"]).optional().describe("Filter by type. Default: both."),
      order_by: z
        .enum(["-created_at", "created_at", "-transcription_started_at", "transcription_started_at", "name", "-name"])
        .default("-created_at")
        .describe("Sort order. '-' prefix = descending. Default newest first."),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results (1-100, default 20)."),
      offset: z.number().int().min(0).default(0).describe("Pagination offset."),
      response_format: z.enum(["markdown", "json"]).default("markdown").describe("'markdown' (default) or 'json'."),
    })
    .strict();

  server.registerTool(
    "soniox_list_transcripts",
    {
      title: "List or search Soniox transcripts",
      description: `List meeting transcripts recorded with Soniox (Smart Scribe / Soniox App), newest first, with optional full-text search and date/project/tag filters.

The 'search' parameter matches words in the transcript TITLE and in the SPOKEN TEXT, so use it to find which meetings discussed a topic. Results include a short preview of how each recording starts, but not the full text: use soniox_get_transcript with the id for that.

Args:
  - search, created_after, created_before, project_id, tag_ids, transcription_type: filters (all optional)
  - order_by: -created_at (default) | created_at | -transcription_started_at | transcription_started_at | name | -name
  - limit (default 20, max 100), offset (default 0)
  - response_format: markdown | json

Returns: total count, pagination info, and per transcript: name, id, recorded datetime (UTC), duration, tags, preview.

Examples:
  - "What meetings did I have last week?" -> created_after/created_before with the week's dates
  - "Where did we talk about pricing?" -> search="pricing"
  - "Find the Flyamelia workshops" -> search="Flyamelia"`,
      inputSchema: ListInput,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const r = await client.listTranscripts({
          search: params.search,
          created_after: params.created_after,
          created_before: params.created_before,
          project_id: params.project_id,
          tag_ids: params.tag_ids,
          transcription_type: params.transcription_type,
          order_by: params.order_by,
          limit: params.limit,
          offset: params.offset,
        });
        const items = r.transcriptions.map(listItem);
        const hasMore = r.count > params.offset + items.length;
        const structured = {
          total: r.count,
          count: items.length,
          offset: params.offset,
          has_more: hasMore,
          next_offset: hasMore ? params.offset + items.length : null,
          transcripts: items,
        };
        if (!items.length) {
          return text(
            params.search
              ? `No transcripts match "${params.search}" with the given filters.`
              : "No transcripts match the given filters.",
            structured
          );
        }
        if (params.response_format === "json") return text(JSON.stringify(structured, null, 2), structured);
        const head =
          `# Soniox transcripts${params.search ? ` matching "${params.search}"` : ""}\n` +
          `${r.count} total · showing ${params.offset + 1}-${params.offset + items.length}` +
          (hasMore ? ` · more available: call again with offset=${params.offset + items.length}` : "");
        return text([head, ...r.transcriptions.map(summaryLine)].join("\n\n"), structured);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------ get transcript
  const GetInput = z
    .object({
      id: z.string().min(1).describe("Transcript id (UUID) from soniox_list_transcripts."),
      include_timestamps: z.boolean().default(true).describe("Prefix each paragraph with [mm:ss]. Default true."),
      start_ms: z.number().int().min(0).optional().describe("Only include speech starting at/after this time (milliseconds)."),
      end_ms: z.number().int().min(0).optional().describe("Only include speech before this time (milliseconds)."),
      offset: z.number().int().min(0).default(0).describe("Character offset for paging through long transcripts (use next_offset from the previous call)."),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(MAX_PAGE_CHARS)
        .default(DEFAULT_PAGE_CHARS)
        .describe(`Max characters to return per call (default ${DEFAULT_PAGE_CHARS}, max ${MAX_PAGE_CHARS}).`),
    })
    .strict();

  server.registerTool(
    "soniox_get_transcript",
    {
      title: "Get a Soniox transcript",
      description: `Fetch the full text of one Soniox meeting transcript, formatted as speaker-labelled paragraphs with [mm:ss] timestamps.

Long meetings can exceed 100k characters, so the text is paged: the response ends with a footer telling you whether more remains and which 'offset' to pass next. Keep calling until has_more is false when you need the whole meeting. You can also narrow to a time window with start_ms/end_ms (e.g. after locating a moment with soniox_search_in_transcript).

Note: Smart Scribe summaries are generated inside the Soniox app and are not stored on the server, so summarise from this text yourself.

Args:
  - id (required), include_timestamps (default true), start_ms/end_ms (optional window),
    offset (default 0), max_chars (default ${DEFAULT_PAGE_CHARS})

Returns: header (name, id, recorded, duration, speakers, languages) + transcript text + paging footer.
structuredContent: { id, name, recorded_at, duration_ms, speakers, languages, offset, next_offset, has_more, total_chars }`,
      inputSchema: GetInput,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const t = await client.getTranscript(params.id);
        const segments = buildSegments(t.tokens, t.speaker_names, { startMs: params.start_ms, endMs: params.end_ms });
        const full = renderSegments(segments, { timestamps: params.include_timestamps });
        const page = paginateText(full, params.offset, params.max_chars);
        const speakers = speakerSummary(t);
        const languages = [...new Set(segments.flatMap((s) => s.languages))];
        const header = transcriptHeader(t, {
          speakers: speakers.labels.join(", ") || undefined,
          languages: languages.join(", ") || undefined,
          window:
            params.start_ms !== undefined || params.end_ms !== undefined
              ? `${params.start_ms ?? 0} ms – ${params.end_ms ?? t.recording_duration_ms} ms`
              : undefined,
        });
        const footer = page.has_more
          ? `\n\n---\n[Transcript continues: ${page.total_chars - (page.next_offset ?? 0)} more characters. Call soniox_get_transcript again with offset=${page.next_offset}.]`
          : page.total_chars
            ? `\n\n---\n[End of transcript · ${page.total_chars} characters total]`
            : `\n\n[No speech in the requested range.]`;
        const structured = {
          id: t.id,
          name: t.name,
          recorded_at: t.transcription_started_at ?? t.created_at,
          duration_ms: t.recording_duration_ms,
          speakers: speakers.labels,
          languages,
          offset: page.offset,
          next_offset: page.next_offset,
          has_more: page.has_more,
          total_chars: page.total_chars,
        };
        return text(`${header}\n\n${page.text}${footer}`, structured);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ------------------------------------------------------------------ search inside transcript
  const SearchInInput = z
    .object({
      id: z.string().min(1).describe("Transcript id (UUID)."),
      query: z.string().min(1).max(200).describe("Case-insensitive phrase to find in the spoken text."),
      context_chars: z.number().int().min(20).max(1000).default(200).describe("Characters of surrounding text per hit (default 200)."),
      max_hits: z.number().int().min(1).max(100).default(25).describe("Max hits to return (default 25)."),
    })
    .strict();

  server.registerTool(
    "soniox_search_in_transcript",
    {
      title: "Search inside a Soniox transcript",
      description: `Find where a phrase was said inside ONE transcript and return each hit with its timestamp, speaker and surrounding context.

Use after soniox_list_transcripts (which finds WHICH meetings mention a topic) to pinpoint the exact moments, then optionally read around them with soniox_get_transcript using start_ms/end_ms.

Args: id (required), query (required), context_chars (default 200), max_hits (default 25)
Returns: list of hits: [timestamp] Speaker: …excerpt…  plus structuredContent { id, name, query, hits: [{start_ms, timestamp, speaker, excerpt}] }`,
      inputSchema: SearchInInput,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const t = await client.getTranscript(params.id);
        const segments = buildSegments(t.tokens, t.speaker_names);
        const hits = searchSegments(segments, params.query, params.context_chars, params.max_hits);
        const structured = { id: t.id, name: t.name, query: params.query, hit_count: hits.length, hits };
        if (!hits.length) return text(`No occurrences of "${params.query}" in "${t.name}".`, structured);
        const lines = [
          `# "${params.query}" in ${t.name}`,
          `${hits.length} hit${hits.length === 1 ? "" : "s"}${hits.length >= params.max_hits ? " (limit reached; raise max_hits for more)" : ""}`,
          "",
          ...hits.map((h) => `- [${h.timestamp}] ${h.speaker}: ${h.excerpt}`),
        ];
        return text(lines.join("\n"), structured);
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  return server;
}
