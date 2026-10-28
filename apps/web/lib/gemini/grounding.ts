/**
 * Gemini Google-Search GROUNDING — live web search with citations (MONEY-587, task #39).
 *
 * The rest of the app's "news" is a Google-News RSS harvest (lib/actions/news.ts);
 * there is no live web search / Vertex grounding anywhere. This module adds it:
 * a single `groundedGenerate(prompt)` call that asks Vertex to answer with the
 * Google-Search grounding tool enabled, then maps the response's
 * `groundingMetadata` into a typed, citable result the chat (web_search tool)
 * and the CitationsRail WEB group can render.
 *
 * Tool-field compatibility
 * ------------------------
 * The Gemini 2.x grounding tool is `tools: [{ googleSearch: {} }]`; the older
 * form is `{ googleSearchRetrieval: {} }`. The `@google/genai` SDK's `Tool`
 * type natively supports BOTH fields, so we try `googleSearch` first (what the
 * live 2.5 models accept) and fall back to `googleSearchRetrieval` if a request
 * is rejected. If BOTH fail we degrade gracefully — return the ungrounded model
 * text with empty sources, NEVER throw — so a chat turn can't dead-end on a
 * grounding outage.
 *
 * SEBI: any grounded PROSE is scrubbed through `stripRecommendationLanguage`
 * before it leaves this module — grounded web answers can otherwise surface
 * "buy/overvalued/upside" language from third-party pages. UseMoney is not a
 * SEBI-registered Research Analyst.
 */

import type {
  GroundingChunk,
  GroundingMetadata,
  GroundingSupport,
  Tool,
} from "@google/genai";
import { getVertexAIClient, type GeminiGenerateContentResult } from "./client";
import { geminiLogger as logger } from "@usemoney/logger";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";

/** A single de-duplicated web source backing a grounded answer. */
export interface GroundedSource {
  /** 1-based citation index used as the `[i]` marker in the prose. */
  i: number;
  /** Page title (falls back to the domain when the page has no title). */
  title: string;
  /** Pretty source label — the page's host (e.g. "moneycontrol.com"). */
  source: string;
  /** Bare domain/host, for favicon + de-dupe. */
  domain: string;
  /** Canonical URL of the source. */
  url: string;
  /** First grounded text segment that cites this source, when available. */
  snippet?: string;
}

/** Typed result of a grounded generation. */
export interface GroundedResult {
  /** Answer prose (SEBI-scrubbed). May be ungrounded on degrade. */
  text: string;
  /** De-duplicated web sources, citation-indexed. Empty when ungrounded. */
  sources: GroundedSource[];
  /** The web-search queries Gemini actually ran (when reported). */
  queries: string[];
  /** True only when at least one real grounding source was returned. */
  grounded: boolean;
}

export interface GroundedGenerateOptions {
  /** Accessible Vertex model — defaults to gemini-2.5-flash (3.x is 404). */
  model?: string;
  /** Hard wall-clock cap; degrades to ungrounded text on timeout. */
  timeoutMs?: number;
  /** Generation temperature (default 0.4 — grounded answers should be factual). */
  temperature?: number;
  /** Max output tokens (default 1024). */
  maxOutputTokens?: number;
}

/** Pull a hostname out of a URL, dropping protocol + leading "www.". */
function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Bare host or malformed URL — best-effort strip.
    return url
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]!;
  }
}

/**
 * Pure parser: map a Vertex `groundingMetadata` object into typed, de-duplicated,
 * citation-indexed web sources + the queries Gemini ran.
 *
 * - `groundingChunks[].web.{uri,title}` become the sources.
 * - De-dupes by `uri` (keeps first occurrence; later refs reuse the [i]).
 * - Assigns stable 1-based `[i]` indices in first-seen order.
 * - `groundingSupports[].segment.text` (matched to a chunk index) supplies the
 *   per-source snippet.
 * - Only WEB chunks are emitted (retrievedContext / RAG chunks are skipped).
 *
 * Pure (no network, no SDK call) so it is trivially unit-testable.
 */
export function parseGroundingMetadata(
  metadata: GroundingMetadata | undefined | null
): { sources: GroundedSource[]; queries: string[] } {
  const queries = Array.isArray(metadata?.webSearchQueries)
    ? metadata!.webSearchQueries!.filter(
        (q): q is string => typeof q === "string" && q.length > 0
      )
    : [];

  const chunks: GroundingChunk[] = Array.isArray(metadata?.groundingChunks)
    ? metadata!.groundingChunks!
    : [];

  // First-seen snippet per chunk index, harvested from groundingSupports.
  const supports: GroundingSupport[] = Array.isArray(
    metadata?.groundingSupports
  )
    ? metadata!.groundingSupports!
    : [];
  const snippetByChunk = new Map<number, string>();
  for (const sup of supports) {
    const text = sup.segment?.text;
    if (!text) continue;
    for (const idx of sup.groundingChunkIndices ?? []) {
      if (typeof idx === "number" && !snippetByChunk.has(idx)) {
        snippetByChunk.set(idx, text);
      }
    }
  }

  const sources: GroundedSource[] = [];
  const indexByUri = new Map<string, number>();

  chunks.forEach((chunk, chunkIdx) => {
    const web = chunk.web;
    const uri = web?.uri;
    if (!uri || typeof uri !== "string") return; // skip non-web / empty chunks
    if (indexByUri.has(uri)) return; // de-dupe by uri

    const domain = hostOf(uri);
    const title =
      typeof web?.title === "string" && web.title.trim().length > 0
        ? web.title.trim()
        : domain || uri;
    const i = sources.length + 1;
    indexByUri.set(uri, i);
    const rawSnippet = snippetByChunk.get(chunkIdx);
    sources.push({
      i,
      title,
      source: domain || uri,
      domain,
      url: uri,
      snippet: rawSnippet ? rawSnippet.trim() : undefined,
    });
  });

  return { sources, queries };
}

/** Extract concatenated text from the first candidate of a Vertex result. */
function extractText(result: GeminiGenerateContentResult): string {
  const parts = result.response?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/**
 * Build the grounding `tools` array. Tries the Gemini-2.x `googleSearch` shape
 * first (what live 2.5 models accept); the older `googleSearchRetrieval` is the
 * fallback shape. `@google/genai`'s `Tool` type natively supports both fields.
 */
function searchTool(variant: "googleSearch" | "googleSearchRetrieval"): Tool[] {
  if (variant === "googleSearch") {
    return [{ googleSearch: {} }];
  }
  return [{ googleSearchRetrieval: {} }];
}

async function generateWithTool(
  modelName: string,
  prompt: string,
  variant: "googleSearch" | "googleSearchRetrieval",
  temperature: number,
  maxOutputTokens: number
): Promise<GeminiGenerateContentResult> {
  const vertexAI = getVertexAIClient();
  const model = vertexAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature, maxOutputTokens },
    tools: searchTool(variant),
  });
  return model.generateContent(prompt);
}

/**
 * Run a Google-Search-grounded generation and return typed prose + sources.
 *
 * Never throws: on any failure (tool unsupported, timeout, auth) it degrades to
 * the ungrounded model answer with `grounded: false` and empty sources, or — if
 * even that fails — an empty result. Prose is always SEBI-scrubbed.
 */
export async function groundedGenerate(
  prompt: string,
  opts: GroundedGenerateOptions = {}
): Promise<GroundedResult> {
  const modelName = opts.model || "gemini-2.5-flash";
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const temperature = opts.temperature ?? 0.4;
  const maxOutputTokens = opts.maxOutputTokens ?? 1024;

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`grounded generation timed out after ${timeoutMs}ms`)
            ),
          timeoutMs
        )
      ),
    ]);

  // 1) Preferred: Gemini-2.x `googleSearch` tool.
  // 2) Fallback: SDK-typed `googleSearchRetrieval` tool.
  const variants: Array<"googleSearch" | "googleSearchRetrieval"> = [
    "googleSearch",
    "googleSearchRetrieval",
  ];

  for (const variant of variants) {
    try {
      const result = await withTimeout(
        generateWithTool(
          modelName,
          prompt,
          variant,
          temperature,
          maxOutputTokens
        )
      );
      const rawText = extractText(result);
      const metadata = result.response?.candidates?.[0]?.groundingMetadata;
      const { sources, queries } = parseGroundingMetadata(metadata);
      const text = stripRecommendationLanguage(rawText);
      logger.info(
        {
          model: modelName,
          variant,
          sourceCount: sources.length,
          queryCount: queries.length,
        },
        "Grounded generation succeeded"
      );
      return { text, sources, queries, grounded: sources.length > 0 };
    } catch (error) {
      logger.warn(
        {
          model: modelName,
          variant,
          error: error instanceof Error ? error.message : String(error),
        },
        "Grounded generation attempt failed — trying next variant"
      );
    }
  }

  // Both grounding variants failed — degrade to an UNGROUNDED answer so the
  // chat turn still gets a reply (just without live citations).
  try {
    const vertexAI = getVertexAIClient();
    const model = vertexAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature, maxOutputTokens },
    });
    const result = await withTimeout(model.generateContent(prompt));
    const text = stripRecommendationLanguage(extractText(result));
    logger.warn(
      { model: modelName },
      "Grounding unavailable — returned ungrounded answer with no sources"
    );
    return { text, sources: [], queries: [], grounded: false };
  } catch (error) {
    logger.error(
      {
        model: modelName,
        error: error instanceof Error ? error.message : String(error),
      },
      "Grounded generation fully failed (ungrounded fallback also failed)"
    );
    return { text: "", sources: [], queries: [], grounded: false };
  }
}
