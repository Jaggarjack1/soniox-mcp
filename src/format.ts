/**
 * Turns Soniox token streams into readable transcript text, with paragraph
 * segmentation, speaker labels, timestamps, pagination and in-transcript search.
 */
import type { SonioxToken, SonioxTranscriptionSummary } from "./soniox-client.js";

export interface Segment {
  speaker: string; // display label, e.g. "Speaker 1" or a named speaker
  speakerId: string;
  start_ms: number;
  end_ms: number;
  text: string;
  languages: string[];
}

const CONTROL_TOKEN = /^<[a-z_]+>$/i; // e.g. <end>, <fin>
const DEFAULT_GAP_MS = 4000;

export function speakerLabel(speakerId: string | null, names?: Record<string, string | null>): string {
  if (speakerId === null || speakerId === undefined || speakerId === "") return "Unknown speaker";
  const custom = names?.[speakerId];
  return custom && custom.trim() ? custom.trim() : `Speaker ${speakerId}`;
}

export function buildSegments(
  tokens: SonioxToken[],
  speakerNames?: Record<string, string | null>,
  opts: { gapMs?: number; startMs?: number; endMs?: number } = {}
): Segment[] {
  const gap = opts.gapMs ?? DEFAULT_GAP_MS;
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let langs = new Set<string>();

  for (const tok of tokens) {
    if (!tok.text || CONTROL_TOKEN.test(tok.text.trim())) continue;
    if (opts.startMs !== undefined && tok.end_ms < opts.startMs) continue;
    if (opts.endMs !== undefined && tok.start_ms > opts.endMs) break;

    const speakerId = tok.speaker ?? "";
    const startsNew =
      !current || current.speakerId !== speakerId || tok.start_ms - current.end_ms >= gap;

    if (startsNew) {
      if (current) {
        current.languages = [...langs];
        current.text = current.text.trim();
        if (current.text) segments.push(current);
      }
      langs = new Set<string>();
      current = {
        speaker: speakerLabel(tok.speaker, speakerNames),
        speakerId,
        start_ms: tok.start_ms,
        end_ms: tok.end_ms,
        text: "",
        languages: [],
      };
    }
    current!.text += tok.text;
    current!.end_ms = Math.max(current!.end_ms, tok.end_ms);
    if (tok.language) langs.add(tok.language);
  }
  if (current) {
    current.languages = [...langs];
    current.text = current.text.trim();
    if (current.text) segments.push(current);
  }
  return segments;
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function renderSegments(segments: Segment[], opts: { timestamps?: boolean } = {}): string {
  const withTs = opts.timestamps ?? true;
  return segments
    .map((s) => (withTs ? `[${formatTimestamp(s.start_ms)}] ${s.speaker}: ${s.text}` : `${s.speaker}: ${s.text}`))
    .join("\n\n");
}

export interface Page {
  text: string;
  offset: number;
  next_offset: number | null;
  has_more: boolean;
  total_chars: number;
}

/** Slice text by character offset, preferring to cut at a paragraph boundary. */
export function paginateText(full: string, offset: number, maxChars: number): Page {
  const start = Math.min(Math.max(0, offset), full.length);
  if (start >= full.length) {
    return { text: "", offset: start, next_offset: null, has_more: false, total_chars: full.length };
  }
  let end = Math.min(full.length, start + maxChars);
  if (end < full.length) {
    const cut = full.lastIndexOf("\n\n", end);
    if (cut > start + Math.floor(maxChars * 0.5)) end = cut;
  }
  const hasMore = end < full.length;
  return {
    text: full.slice(start, end).trim(),
    offset: start,
    next_offset: hasMore ? end : null,
    has_more: hasMore,
    total_chars: full.length,
  };
}

export interface SearchHit {
  start_ms: number;
  timestamp: string;
  speaker: string;
  excerpt: string;
}

export function searchSegments(segments: Segment[], query: string, contextChars = 160, maxHits = 25): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const seg of segments) {
    const lower = seg.text.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx !== -1 && hits.length < maxHits) {
      const from = Math.max(0, idx - contextChars);
      const to = Math.min(seg.text.length, idx + q.length + contextChars);
      const excerpt = (from > 0 ? "…" : "") + seg.text.slice(from, to) + (to < seg.text.length ? "…" : "");
      hits.push({ start_ms: seg.start_ms, timestamp: formatTimestamp(seg.start_ms), speaker: seg.speaker, excerpt });
      idx = lower.indexOf(q, idx + q.length);
    }
    if (hits.length >= maxHits) break;
  }
  return hits;
}

export function transcriptHeader(t: SonioxTranscriptionSummary, extra: Record<string, string | undefined> = {}): string {
  const started = t.transcription_started_at ?? t.created_at;
  const tags = (t.tags ?? []).map((x) => x.tag).join(", ");
  const lines = [
    `# ${t.name}`,
    `- id: ${t.id}`,
    `- recorded: ${started}`,
    `- duration: ${formatDuration(t.recording_duration_ms)}`,
  ];
  if (tags) lines.push(`- tags: ${tags}`);
  if (t.transcription_type && t.transcription_type !== "transcription") lines.push(`- type: ${t.transcription_type}`);
  for (const [k, v] of Object.entries(extra)) if (v) lines.push(`- ${k}: ${v}`);
  return lines.join("\n");
}

export function summaryLine(t: SonioxTranscriptionSummary): string {
  const started = (t.transcription_started_at ?? t.created_at).slice(0, 16).replace("T", " ");
  const tags = (t.tags ?? []).map((x) => x.tag);
  const preview = (t.transcription_string_start ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  const parts = [
    `## ${t.name}`,
    `- id: ${t.id}`,
    `- recorded: ${started} UTC · ${formatDuration(t.recording_duration_ms)}` +
      (t.async_transcription_status && t.async_transcription_status !== "completed"
        ? ` · status: ${t.async_transcription_status}`
        : ""),
  ];
  if (tags.length) parts.push(`- tags: ${tags.join(", ")}`);
  if (preview) parts.push(`- starts: "${preview}${preview.length === 140 ? "…" : ""}"`);
  return parts.join("\n");
}
