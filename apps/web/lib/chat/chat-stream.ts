/**
 * Chat streaming protocol (MONEY-291).
 *
 * A tiny SSE event format shared by the server (`/api/chat` success path) and
 * the client (`ChatContext`). The server emits events as `data: <json>\n\n`
 * frames; the client decodes them incrementally.
 *
 *   meta   → blocks already assembled from tools + turnMeta, sent up-front
 *   delta  → cumulative, pre-scrubbed prose-so-far (the client REPLACES the
 *            displayed text with it — scrubbing can shrink earlier text)
 *   blocks → the final parsed blocks (after the narrative completes)
 *   done   → end of turn (final turnMeta + remaining credits)
 *   error  → a recoverable error mid-stream
 */

import type { ContentBlock, TurnMeta } from "@usemoney/types";

export const CHAT_STREAM_CONTENT_TYPE = "text/event-stream";

export type ChatStreamEvent =
  | {
      t: "meta";
      blocks?: ContentBlock[];
      turnMeta?: TurnMeta;
      remaining?: number;
      researchSessionId?: string;
    }
  | { t: "delta"; text: string }
  | { t: "blocks"; blocks: ContentBlock[] }
  | { t: "done"; turnMeta?: TurnMeta; remaining?: number }
  | { t: "error"; message: string };

/** Encode one event as an SSE frame. */
export function encodeSSE(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Decode a growing SSE buffer into complete events + the leftover partial
 * frame (which the caller carries forward to the next read). Malformed frames
 * are skipped rather than throwing.
 */
export function parseSSEChunks(buffer: string): {
  events: ChatStreamEvent[];
  rest: string;
} {
  const events: ChatStreamEvent[] = [];
  let rest = buffer;
  let idx = rest.indexOf("\n\n");
  while (idx !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    idx = rest.indexOf("\n\n");

    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.slice("data:".length).trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json) as ChatStreamEvent);
    } catch {
      // skip a malformed frame
    }
  }
  return { events, rest };
}

/**
 * Strip `:::block:TYPE{...}:::` markers (and bare `:::`) from streaming
 * narrative so the user never sees raw markers flash mid-stream; the final
 * parsed blocks arrive separately via the `blocks` event.
 */
export function stripBlockMarkers(text: string): string {
  return text.replace(/:::block:\w+\s*\{[^}]*\}/g, "").replace(/:::/g, "");
}
