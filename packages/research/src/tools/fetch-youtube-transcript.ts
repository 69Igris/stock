/**
 * Fetch YouTube Transcript (MONEY-785, P4) — ingest an earnings-call / analyst /
 * management-interview YouTube video's captions so they become citable in the
 * research RAG corpus.
 *
 * The tool resolves the video id, scrapes the public timedtext captions
 * (dependency-free, no API key — see `youtube-transcript.ts`) and returns the
 * transcript text (capped). It is SEBI-safe: it returns the speaker's own words
 * verbatim, no buy/sell call, no synthesized recommendation.
 *
 * Optional persistence (`persistYoutubeTranscript`) upserts the transcript as a
 * `StockDocument` row (docType `video_transcript`, `processingStatus:"READY"`,
 * `textContent` inline) so the existing embed worker picks it up on its next
 * pass — no GCS PDF / Document AI extraction needed because the text is already
 * present. The embed worker's `chunkByDocType` routes `video_transcript` to the
 * concall speaker-turn chunker.
 *
 * Gemini-native alternative / upgrade: instead of scraping captions, the
 * `@google/genai` Vertex SDK can ground directly on the video by passing
 * `fileData: { fileUri: <youtube url>, mimeType: "video/*" }` (the model watches
 * the video). That is the higher-fidelity path when an API key is available;
 * this caption scraper is the no-key default.
 */

import prisma from "@usemoney/database";
import {
  parseVideoId,
  fetchYoutubeTranscript,
} from "../data-sources/youtube-transcript";
import { buildFullDocPath } from "../data-sources/stock-document-paths";
import type { ResearchToolDef, ToolOutput } from "./types";

/** Cap on transcript text we keep (~50k chars). Mirrors the chat token budget. */
export const MAX_TRANSCRIPT_CHARS = 50_000;

/** System userId for shared stock document embeddings (matches the fetcher). */
const SYSTEM_USER_ID = "000000000000000000000001";

const logger = {
  info: (...args: unknown[]) => console.log("[youtube-transcript]", ...args),
  warn: (...args: unknown[]) => console.warn("[youtube-transcript]", ...args),
};

export interface YoutubeTranscriptResult {
  available: boolean;
  videoId: string | null;
  /** The transcript text (capped at `MAX_TRANSCRIPT_CHARS`) when available. */
  transcript?: string;
  language?: string;
  /** The canonical video URL — the citable source. */
  source: string;
  /** Reason the transcript is unavailable (when `available` is false). */
  reason?: string;
}

/** Build a clean canonical watch URL from a video id. */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Canonicalise a stock symbol for the DB key + GCS path: strip the `.NS`/`.BO`
 * exchange suffix, upper-case, then allow-list path-safe ticker chars so a
 * hostile symbol (e.g. `../../x`) can never escape the `stocks/{SYMBOL}/…`
 * prefix. Returns "" when nothing safe remains (caller skips the persist).
 */
function sanitizeSymbol(symbol: string): string {
  return String(symbol || "")
    .replace(/\.(NS|BO)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9.&-]/g, "");
}

export const fetchYoutubeTranscriptTool: ResearchToolDef = {
  name: "fetch_youtube_transcript",
  description:
    "Fetch the transcript of an earnings-call / analyst / management-interview YouTube video so its content becomes citable. Supply a YouTube `url` (or 11-char video id) directly, OR chain this task after a fetch_youtube_candidates task (dependsOn it) — the executor feeds the first discovered candidate url in. Returns the caption text only (no recommendation); degrades to available:false when the video has no captions or is blocked.",
  // MONEY-802: URL discovery now exists — `fetch_youtube_candidates` searches
  // YouTube for the concall/interview video and the executor threads its first
  // candidate into this tool's `url` (see executor.ts resolveParams +
  // extractCandidateUrl). This tool still also accepts a planner-supplied url or
  // an upstream-embedded link (news / announcements) via extractYoutubeUrl.
  category: "data",
  parameters: {
    url: {
      type: "string",
      description:
        "YouTube video URL or 11-char video id. REQUIRED — must be supplied by the caller (no auto-discovery); provide the specific concall/interview video link.",
      required: true,
    },
    symbol: {
      type: "string",
      description:
        "Optional stock symbol this video relates to (used for citation context).",
      required: false,
    },
  },
  cacheTTL: 86400, // 24h — transcripts of a published video don't change
  execute: async (params): Promise<ToolOutput> => {
    const rawUrl = typeof params.url === "string" ? params.url : "";
    if (!rawUrl.trim()) {
      return { success: false, error: "url is required" };
    }

    const videoId = parseVideoId(rawUrl);
    if (!videoId) {
      const result: YoutubeTranscriptResult = {
        available: false,
        videoId: null,
        source: rawUrl,
        reason: "Not a recognisable YouTube URL or video id.",
      };
      return { success: true, data: result, metadata: { source: rawUrl } };
    }

    const source = watchUrl(videoId);

    let transcript: Awaited<ReturnType<typeof fetchYoutubeTranscript>>;
    try {
      transcript = await fetchYoutubeTranscript(videoId);
    } catch {
      // Defensive — the fetcher is documented never-throw, but never crash here.
      transcript = null;
    }

    if (!transcript || !transcript.text) {
      const result: YoutubeTranscriptResult = {
        available: false,
        videoId,
        source,
        reason:
          "No captions available for this video (no captions, blocked, or region-locked).",
      };
      return {
        success: true,
        data: result,
        metadata: { source, sourceTitle: "YouTube", videoId },
      };
    }

    const capped = transcript.text.slice(0, MAX_TRANSCRIPT_CHARS);
    const result: YoutubeTranscriptResult = {
      available: true,
      videoId,
      transcript: capped,
      ...(transcript.language ? { language: transcript.language } : {}),
      source,
    };

    // P4: when a symbol is provided, persist the transcript to the RAG corpus
    // (best-effort, never blocks the response) so future research runs can cite
    // this video. The StockDocument is READY with inline textContent → the embed
    // worker picks it up without GCS/Document AI extraction.
    if (typeof params.symbol === "string" && params.symbol) {
      void persistYoutubeTranscript(
        params.symbol,
        videoId,
        source,
        capped,
      ).catch(() => {});
    }

    return {
      success: true,
      data: result,
      metadata: {
        source,
        sourceTitle: "YouTube transcript",
        videoId,
        ...(transcript.language ? { language: transcript.language } : {}),
        chars: capped.length,
      },
    };
  },
};

/**
 * Minimal structural shape of the prisma surface `persistYoutubeTranscript`
 * touches. Lets tests inject a fake client (no real DB) while production passes
 * the real `prisma` default — the live call site is unchanged. Method args are
 * `any` so the real (more-strongly-typed) prisma client stays assignable.
 */
export interface TranscriptPrismaClient {
  instrumentMapping: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst: (args: any) => Promise<{ id: string } | null>;
  };
  stockDocument: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: (args: any) => Promise<{ id: string }>;
  };
}

/** Resolve the active instrument id for `symbol` on `exchange` (NSE default). */
async function resolveInstrumentId(
  db: TranscriptPrismaClient,
  symbol: string,
  exchange: string,
): Promise<string | null> {
  const inst = await db.instrumentMapping.findFirst({
    where: { symbol, exchange, isActive: true },
    select: { id: true },
  });
  return inst?.id ?? null;
}

/**
 * Persist a fetched transcript as a `StockDocument` so it flows into the embed
 * chain. The text is inline (`textContent` + `processingStatus:"READY"`) — no
 * GCS PDF or Document AI extraction is needed; the embed worker picks up READY
 * docs with non-null `textContent` and routes `video_transcript` to the concall
 * chunker.
 *
 * Best-effort: returns the upserted document id, or null when the symbol can't
 * be resolved / the upsert fails. Never throws.
 */
export async function persistYoutubeTranscript(
  symbol: string,
  videoId: string,
  url: string,
  transcript: string,
  title?: string,
  db: TranscriptPrismaClient = prisma,
): Promise<string | null> {
  // Validate the video id before it flows into the unique-key `period` segment
  // and the GCS path — a non-11-char / unsafe id is never persisted.
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const clean = sanitizeSymbol(symbol);
  if (!clean) return null;
  const exchange = "NSE";
  const text = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  if (!text.trim()) return null;

  try {
    const instrumentId = await resolveInstrumentId(db, clean, exchange);
    if (!instrumentId) {
      logger.warn(
        `No active instrument for ${clean}; skipping transcript persist`,
      );
      return null;
    }

    // `period` keys the unique [symbol, exchange, docType, period] index — use
    // the video id so each distinct video gets its own row (re-fetching the same
    // video updates in place).
    const period = `video-${videoId}`;
    const docTitle =
      title?.trim() || `${clean} — YouTube transcript (${videoId})`;
    // Derive a GCS path for consistency with other docs (no upload — text inline).
    const gcsPath = buildFullDocPath(clean, "video_transcript", period, "txt");

    const doc = await db.stockDocument.upsert({
      where: {
        symbol_exchange_docType_period: {
          symbol: clean,
          exchange,
          docType: "video_transcript",
          period,
        },
      },
      create: {
        instrumentId,
        symbol: clean,
        exchange,
        docType: "video_transcript",
        period,
        title: docTitle,
        sourceUrl: url,
        sourceType: "YOUTUBE",
        gcsPath,
        fileSize: Buffer.byteLength(text, "utf-8"),
        mimeType: "text/plain",
        processingStatus: "READY",
        textContent: text,
        fetchedAt: new Date(),
      },
      update: {
        title: docTitle,
        sourceUrl: url,
        textContent: text,
        fileSize: Buffer.byteLength(text, "utf-8"),
        processingStatus: "READY",
        isEmbedded: false, // re-embed on next pass
        fetchedAt: new Date(),
      },
    });

    logger.info(
      `Stored video_transcript for ${clean} (${videoId}); userId=${SYSTEM_USER_ID}`,
    );
    return doc.id;
  } catch (err) {
    logger.warn(
      `Failed to persist transcript for ${clean} (${videoId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
