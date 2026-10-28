/**
 * YouTube search resolver (MONEY-802, discovery half) — a dependency-free,
 * best-effort YouTube *search* that turns a free-text query (e.g.
 * "<company> earnings call FY26") into a handful of candidate watch URLs.
 *
 * This is the missing producer that the transcript pipeline lacked: the prior
 * MONEY-802 pass only threaded an ALREADY-PRESENT YouTube url from upstream data
 * (news / announcements) into `fetch_youtube_transcript`. There was no step that
 * actively *found* the concall/interview video. This module is that step.
 *
 * It mirrors `youtube-transcript.ts` exactly in spirit: it uses the global
 * `fetch` (Node 18+) with a realistic browser UA, bounds every hop with an
 * `AbortSignal.timeout`, caps the scanned body bytes, validates the host
 * (youtube.com only — SSRF-safe), and NEVER throws — it returns `[]` on any
 * failure (consent wall, 429, layout change, region block). The brittleness is
 * inherent: there is no API key, so we scrape `youtube.com/results` and mine
 * `videoId` occurrences out of the embedded `ytInitialData` JSON. A layout shift
 * on YouTube's side degrades this to an empty list, never a crash.
 *
 * Gemini-native alternative / upgrade: when an API key is available the
 * `@google/genai` Vertex SDK can ground on a Google Search of the same query and
 * return a watch URL with far higher reliability; this scraper is the no-key
 * default, consistent with the rest of the YouTube ingestion path.
 */

/** A realistic UA — YouTube serves a consent/empty page to obvious bots. */
const FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Per-request fetch timeout (ms). Bounded so a slow/hung search response can't
 * stall the worker (the repo's no-orphan discipline). Degrades to [].
 */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Hard cap on the bytes we scan from the UNTRUSTED results page. The search HTML
 * is large; we only need the leading `ytInitialData` blob, so a generous slice
 * keeps the regex scan bounded against a hostile / enormous body.
 */
const MAX_RESULTS_HTML_BYTES = 4_000_000; // ~4 MB

/** Default cap on candidate video ids returned from a single search. */
const DEFAULT_MAX_RESULTS = 5;

/** True when `value` is a bare 11-char YouTube video id (A-Z a-z 0-9 _ -). */
function isVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

/**
 * SSRF guard: only ever fetch the YouTube results host over https with no
 * embedded credentials. The query is caller-controlled text, so this is built
 * by us — but we keep the same defensive posture as the transcript fetcher.
 */
function isAllowedSearchUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "www.youtube.com" || host === "youtube.com";
}

/**
 * `fetch` wrapper with a bounded timeout (degrades to null on abort / error) and
 * a response-size cap so a hostile body can't blow up the parser. Returns the
 * (truncated) text body, or null on any failure.
 */
async function fetchTextBounded(
  url: string,
  maxBytes: number,
): Promise<string | null> {
  if (typeof fetch !== "function") return null;
  if (!isAllowedSearchUrl(url)) return null;
  try {
    const init: RequestInit = { headers: FETCH_HEADERS };
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    }
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const body = await res.text();
    return body.length > maxBytes ? body.slice(0, maxBytes) : body;
  } catch {
    // Timeout (abort), network error, region block — degrade quietly.
    return null;
  }
}

/**
 * Extract up to `max` distinct 11-char video ids from a YouTube results-page
 * HTML body, in first-seen (i.e. top-of-results) order.
 *
 * Pure, no network, never throws — exported so it can be unit-tested directly.
 *
 * Strategy: YouTube's results page embeds an `ytInitialData` JSON blob with the
 * search hits; each video renderer carries a `"videoId":"<id>"` field. We scan
 * the whole (byte-capped) body for those occurrences and de-dupe, preserving
 * order. This is intentionally tolerant of layout: it does not depend on the
 * surrounding JSON structure, only on the stable `"videoId":"…"` token. On a
 * layout change that drops that token entirely, it returns [].
 */
export function extractSearchVideoIds(
  html: string,
  max = DEFAULT_MAX_RESULTS,
): string[] {
  if (typeof html !== "string" || html.length === 0) return [];
  const cap = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_RESULTS;

  const ids: string[] = [];
  const seen = new Set<string>();
  // Match `"videoId":"<id>"` (the canonical key inside ytInitialData renderers).
  // The id alphabet is exactly the 11-char YouTube id charset; the {11} bound
  // keeps the regex from over-matching longer tokens.
  const re = /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (id && isVideoId(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
      if (ids.length >= cap) break;
    }
  }
  return ids;
}

/** Build a clean canonical watch URL from a video id. */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Best-effort YouTube search for `query`. Returns up to `max` canonical watch
 * URLs for the top results, or `[]` when the search is blocked / yields nothing
 * / the page layout changed. Never throws.
 *
 * No API key, no new dependency — scrapes `youtube.com/results?search_query=…`
 * and mines the embedded `videoId` occurrences. The result ORDER follows the
 * page's result order (relevance), so the first URL is the top hit.
 */
export async function searchYoutube(
  query: string,
  max = DEFAULT_MAX_RESULTS,
): Promise<string[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  if (typeof fetch !== "function") return [];

  // `hl=en&persist_gl=0` nudges YouTube toward the English layout we parse; the
  // query is URL-encoded so a hostile string can't break out of the param.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    q,
  )}&hl=en`;

  const html = await fetchTextBounded(url, MAX_RESULTS_HTML_BYTES);
  if (!html) return [];

  const ids = extractSearchVideoIds(html, max);
  return ids.map(watchUrl);
}
