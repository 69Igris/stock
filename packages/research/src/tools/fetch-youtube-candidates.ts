/**
 * Fetch YouTube Candidates (MONEY-802, discovery half) — the producer that
 * `fetch_youtube_transcript` was missing.
 *
 * Given a company (`symbol` or `company` name) and an optional `kind`
 * (earnings_call / concall / interview), this tool builds a natural-language
 * YouTube query like "<company> earnings call FY26" and returns a short list of
 * candidate watch URLs. The planner can then chain it into
 * `fetch_youtube_transcript` (discover a url → transcribe it) so a concall /
 * management-interview video's commentary becomes citable — without the user
 * having to paste a link.
 *
 * It is SEBI-safe: it returns *candidate video links only* (data), with no
 * buy/sell/hold call and no synthesized recommendation.
 *
 * BRITTLENESS (no API key): discovery scrapes the public YouTube results page
 * and mines `videoId` occurrences (see `youtube-search.ts`). A YouTube layout
 * change, a consent wall, or a region block degrades this to an empty candidate
 * list — never a crash. Treat the candidates as best-effort hints, not a
 * guaranteed hit; the downstream transcript fetch still validates captions.
 */

import { searchYoutube } from "../data-sources/youtube-search";
import { toNseSymbol } from "../data-sources/symbol-resolver";
import type { ResearchToolDef, ToolOutput } from "./types";

/** Cap on candidate URLs we return (keeps the chained transcript fetch cheap). */
export const MAX_YOUTUBE_CANDIDATES = 5;

/** The discovery intents we know how to phrase as a YouTube query. */
export type YoutubeCandidateKind = "earnings_call" | "interview" | "concall";

/** Phrase fragment per intent — appended to the company in the search query. */
const KIND_PHRASE: Record<YoutubeCandidateKind, string> = {
  earnings_call: "earnings call concall",
  interview: "management interview",
  concall: "concall earnings call",
};

export interface YoutubeCandidate {
  url: string;
  /** Reserved for a future title lookup; omitted by the scrape-only path. */
  title?: string;
}

export interface YoutubeCandidatesResult {
  available: boolean;
  /** The search query that was issued (so the report can show provenance). */
  query: string;
  candidates: YoutubeCandidate[];
  /** Reason no candidates are available (when `available` is false). */
  reason?: string;
}

/**
 * Derive the company label used in the search query. Prefers an explicit
 * `company` name (best for relevance); otherwise falls back to the bare ticker
 * (NSE symbol with the `.NS`/`.BO` suffix stripped). Returns "" when neither is
 * usable.
 *
 * Pure helper — exported for unit testing.
 */
export function resolveCompanyLabel(
  symbol?: unknown,
  company?: unknown,
): string {
  const co = typeof company === "string" ? company.trim() : "";
  if (co) return co;
  const sym = typeof symbol === "string" ? symbol.trim() : "";
  if (!sym) return "";
  // Strip the exchange suffix so the query reads "TCS …" not "TCS.NS …".
  return toNseSymbol(sym).replace(/\.(NS|BO)$/i, "");
}

/**
 * Build the YouTube search query for a company + discovery intent. Appends the
 * current calendar year so freshly-published concalls rank first, while still
 * matching the FY-labelled titles that the channels actually use.
 *
 * Pure helper — exported for unit testing (pass `year` to keep tests
 * deterministic; defaults to the current UTC year).
 */
export function buildCandidateQuery(
  company: string,
  kind?: string,
  year: number = new Date().getUTCFullYear(),
): string {
  const label = (company ?? "").trim();
  if (!label) return "";
  const phrase =
    kind && (KIND_PHRASE as Record<string, string>)[kind]
      ? (KIND_PHRASE as Record<string, string>)[kind]
      : // Default intent when none is given: an earnings call / concall, the
        // most common citable management commentary.
        KIND_PHRASE.earnings_call;
  return `${label} ${phrase} ${year}`.replace(/\s+/g, " ").trim();
}

export const fetchYoutubeCandidatesTool: ResearchToolDef = {
  name: "fetch_youtube_candidates",
  description:
    "Discover candidate YouTube videos (earnings call / concall / management interview) for a company, returning a short list of watch URLs. Best-effort and BRITTLE — it scrapes the public YouTube results page with NO API key, so a layout change / consent wall / region block degrades it to an empty list (never an error). Chain it into fetch_youtube_transcript: this tool finds the url, that tool transcribes it. Returns candidate links only — no recommendation.",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description:
        "Stock symbol (e.g. TCS, RELIANCE.NS). Used to build the search query when `company` is not given.",
      required: false,
    },
    company: {
      type: "string",
      description:
        "Company name (e.g. 'Tata Consultancy Services'). Preferred over `symbol` for search relevance.",
      required: false,
    },
    kind: {
      type: "string",
      description:
        "Discovery intent: 'earnings_call' | 'concall' | 'interview'. Defaults to an earnings-call / concall search.",
      required: false,
    },
  },
  cacheTTL: 3600, // 1h — newly-published videos surface fairly quickly
  execute: async (params): Promise<ToolOutput> => {
    const label = resolveCompanyLabel(params.symbol, params.company);
    if (!label) {
      return { success: false, error: "symbol or company is required" };
    }

    const kind = typeof params.kind === "string" ? params.kind : undefined;
    const query = buildCandidateQuery(label, kind);

    let urls: string[] = [];
    try {
      urls = await searchYoutube(query, MAX_YOUTUBE_CANDIDATES);
    } catch {
      // searchYoutube is documented never-throw, but never crash here.
      urls = [];
    }

    if (urls.length === 0) {
      const result: YoutubeCandidatesResult = {
        available: false,
        query,
        candidates: [],
        reason:
          "No candidate videos found (search blocked, no results, or page layout changed).",
      };
      return { success: true, data: result, metadata: { query } };
    }

    const candidates: YoutubeCandidate[] = urls.map((url) => ({ url }));
    const result: YoutubeCandidatesResult = {
      available: true,
      query,
      candidates,
    };
    return {
      success: true,
      data: result,
      metadata: {
        query,
        sourceTitle: "YouTube search",
        candidateCount: candidates.length,
      },
    };
  },
};
