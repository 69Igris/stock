/**
 * YouTube transcript scraper (MONEY-785, P4) — a dependency-free, best-effort
 * caption fetcher used to ingest earnings-call / analyst / management-interview
 * videos into the research RAG corpus so they become citable.
 *
 * Ported from orvi `packages/ai/src/youtube.ts`. Nothing here adds a dependency:
 * `parseVideoId` is pure string parsing, and the transcript fetcher uses the
 * global `fetch` (Node 18+) to pull the watch page + the public `timedtext`
 * caption endpoint. Both degrade quietly — `parseVideoId` returns null on a bad
 * URL; the fetcher returns null when blocked / captions are unavailable — and
 * never throw, so callers degrade with a clear reason instead of crashing.
 */

/* ----------------------------------------------------------------------------
 * Video-id parser — pure, no network. Safe in the browser + on the server.
 * ------------------------------------------------------------------------- */

/** True when `value` is a bare 11-char YouTube video id (A-Z a-z 0-9 _ -). */
function isVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

/**
 * Extract the 11-char video id from a URL or bare id. Returns null on no match.
 *
 * Accepts the common shapes: `watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`,
 * `/live/`, `/v/`, and the nocookie host — plus a raw 11-char id. Pure: no
 * network, never throws.
 */
export function parseVideoId(input: string): string | null {
  const value = (input ?? "").trim();
  if (!value) return null;

  // Bare id fast-path.
  if (isVideoId(value)) return value;

  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL; try a loose `v=` / last-segment scan below.
    parsed = null;
  }

  if (parsed) {
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    // youtu.be/<id>
    if (host === "youtu.be") {
      const seg = parsed.pathname.split("/").filter(Boolean)[0];
      if (seg && isVideoId(seg)) return seg;
    }

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtube-nocookie.com"
    ) {
      // watch?v=<id>
      const v = parsed.searchParams.get("v");
      if (v && isVideoId(v)) return v;

      // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
      const parts = parsed.pathname.split("/").filter(Boolean);
      const marker = parts[0]?.toLowerCase();
      if (
        marker === "embed" ||
        marker === "shorts" ||
        marker === "live" ||
        marker === "v"
      ) {
        const seg = parts[1];
        if (seg && isVideoId(seg)) return seg;
      }
    }
  }

  // Loose fallback: a `v=<id>` query fragment in a NON-URL string (e.g. a copied
  // `watch?v=…` fragment with no scheme). If the input parsed as a real URL on a
  // host we did NOT recognise above, do NOT mine an id out of it — a
  // `https://evil.com/?v=<id>` must not masquerade as a YouTube link.
  if (parsed) return null;
  const vMatch = /[?&]v=([A-Za-z0-9_-]{11})/.exec(value);
  if (vMatch?.[1]) return vMatch[1];

  return null;
}

/* ----------------------------------------------------------------------------
 * Transcript fetcher — best-effort, dependency-free.
 *
 * Strategy (no API key, no new deps):
 *   1. GET the watch page HTML.
 *   2. Parse the `captionTracks` array out of the embedded ytInitialPlayerResponse
 *      JSON to discover a real timedtext URL (+ language).
 *   3. GET that timedtext URL (asking for the JSON3 format) and flatten the
 *      caption segments into plain text.
 *   4. Fall back to a couple of direct `timedtext` URL shapes if the watch-page
 *      scrape is blocked.
 *
 * Every network hop is wrapped: any failure (consent wall, 429, no captions,
 * region block) resolves to `null` so the caller degrades with a clear reason
 * instead of throwing.
 *
 * Gemini-native alternative / upgrade: the `@google/genai` Vertex SDK supports
 * passing a YouTube URL directly as `fileData: { fileUri, mimeType: "video/*" }`
 * for URL grounding (the model watches the video). That is the higher-fidelity
 * path when an API key is available; this scraper is the no-key default.
 * ------------------------------------------------------------------------- */

/** A realistic UA — YouTube serves a consent/empty page to obvious bots. */
const FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Per-request fetch timeout (ms). Every hop is bounded so a slow/hung response
 * can't stall the worker (the repo's no-orphan discipline). Degrades to null.
 */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Hard caps on the bytes we'll scan / keep from an UNTRUSTED response body.
 * A hostile (or just enormous) watch page / caption file must not let the
 * bracket scanner, the global XML regex, or entity decoding run unbounded.
 */
const MAX_HTML_BYTES = 5_000_000; // ~5 MB watch page is already generous
const MAX_TIMEDTEXT_BYTES = 8_000_000; // ~8 MB caption body
const MAX_CAPTION_TRACKS_BYTES = 200_000; // the captionTracks array itself

/**
 * SSRF guard: the `baseUrl` of a caption track is read out of arbitrary
 * watch-page HTML, so it must be re-validated before we `fetch()` it — a
 * poisoned / MITM'd watch page could otherwise point it at an internal address
 * or an exfil endpoint. Require https on a known YouTube / Google captions host.
 */
function isAllowedTimedTextUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  // No credentials, https only — blocks `http://`, `file:`, `data:`, and
  // `https://user:pass@evil/...` smuggling tricks.
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  // Allow-list: youtube.com (+ subdomains) and Google's caption CDNs.
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com") ||
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com") ||
    host === "google.com" ||
    host.endsWith(".google.com")
  );
}

/**
 * `fetch` wrapper with a bounded timeout (degrades to null on abort / error) and
 * a response-size cap so a hostile body can't blow up the parsers. Returns the
 * (truncated) text body, or null on any failure.
 */
async function fetchTextBounded(
  url: string,
  maxBytes: number,
): Promise<string | null> {
  if (typeof fetch !== "function") return null;
  try {
    const init: RequestInit = { headers: FETCH_HEADERS };
    // Guard: AbortSignal.timeout is Node 17.3+/modern browsers; degrade if absent.
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      init.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    }
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const body = await res.text();
    // Cap the scanned length so the downstream parsers stay bounded.
    return body.length > maxBytes ? body.slice(0, maxBytes) : body;
  } catch {
    // Timeout (abort), network error, region block — degrade quietly.
    return null;
  }
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string };
}

export interface YoutubeTranscript {
  text: string;
  /** Caption language code (e.g. "en", "hi") when discoverable. */
  language?: string;
}

/**
 * Best-effort transcript fetch for `videoId`. Returns the flattened caption text
 * (and language) or `null` when captions can't be retrieved. Never throws.
 */
export async function fetchYoutubeTranscript(
  videoId: string,
): Promise<YoutubeTranscript | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  if (!isVideoId(videoId)) {
    return null;
  }

  // 1) Discover caption tracks from the watch page.
  const track = await discoverCaptionTrack(videoId);
  // SSRF guard: the discovered baseUrl comes from arbitrary watch-page HTML —
  // only fetch it when it points at an allowed YouTube/Google captions host.
  if (track?.baseUrl && isAllowedTimedTextUrl(track.baseUrl)) {
    const text = await fetchTimedText(track.baseUrl);
    if (text) {
      return {
        text,
        ...(track.languageCode ? { language: track.languageCode } : {}),
      };
    }
  }

  // 2) Fallback: hit the public timedtext endpoint directly (English + Hindi,
  //    both the manual and the auto-generated/ASR track).
  for (const lang of ["en", "en-US", "hi"]) {
    for (const asr of [false, true]) {
      const url = buildTimedTextUrl(videoId, lang, asr);
      const text = await fetchTimedText(url);
      if (text) return { text, language: lang };
    }
  }

  // No captions, blocked, or region-locked — degrade to null.
  return null;
}

/** Fetch the watch page and extract the best caption track (prefer manual, English). */
async function discoverCaptionTrack(
  videoId: string,
): Promise<CaptionTrack | null> {
  const html = await fetchTextBounded(
    `https://www.youtube.com/watch?v=${videoId}&hl=en`,
    MAX_HTML_BYTES,
  );
  if (!html) return null;

  const tracks = extractCaptionTracks(html);
  if (tracks.length === 0) return null;

  // Prefer a manual English track, then any manual track, then anything (ASR).
  const isManual = (t: CaptionTrack) => t.kind !== "asr";
  const isEnglish = (t: CaptionTrack) =>
    (t.languageCode ?? "").toLowerCase().startsWith("en");

  return (
    tracks.find((t) => isManual(t) && isEnglish(t)) ??
    tracks.find(isManual) ??
    tracks.find(isEnglish) ??
    tracks[0] ??
    null
  );
}

/** Pull the `captionTracks` array out of the watch-page HTML. */
function extractCaptionTracks(html: string): CaptionTrack[] {
  const marker = '"captionTracks":';
  const at = html.indexOf(marker);
  if (at === -1) return [];

  // Scan from the opening bracket to its matching close so we capture the whole
  // array. Bound the scan window: the captionTracks array is small (a handful of
  // tracks), so a never-closing bracket in a hostile body must bail instead of
  // scanning megabytes.
  const start = html.indexOf("[", at);
  if (start === -1) return [];
  const scanLimit = Math.min(html.length, start + MAX_CAPTION_TRACKS_BYTES);
  let depth = 0;
  let end = -1;
  for (let i = start; i < scanLimit; i++) {
    const ch = html[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];

  const raw = html.slice(start, end + 1);
  try {
    const parsed = JSON.parse(raw) as CaptionTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Build a direct timedtext URL for a language (optionally the ASR track). */
function buildTimedTextUrl(
  videoId: string,
  lang: string,
  asr: boolean,
): string {
  const params = new URLSearchParams({ v: videoId, lang, fmt: "json3" });
  if (asr) {
    params.set("kind", "asr");
  }
  return `https://www.youtube.com/api/timedtext?${params.toString()}`;
}

/**
 * Fetch + flatten a timedtext URL into plain text. Handles both the JSON3 format
 * (`events[].segs[].utf8`) and the legacy XML format (`<text>…</text>`).
 * Returns null when the response is empty/unparseable.
 */
async function fetchTimedText(baseUrl: string): Promise<string | null> {
  // SSRF guard (defense in depth — the caller already checks discovered URLs;
  // the direct-fallback URLs are youtube.com by construction): never fetch a
  // baseUrl that isn't an allowed YouTube/Google captions host.
  if (!isAllowedTimedTextUrl(baseUrl)) return null;

  // Prefer JSON3 — easiest to flatten. The discovered baseUrl already has params;
  // appending fmt=json3 is harmless and upgrades XML tracks to JSON.
  const url = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;

  const bodyText = await fetchTextBounded(url, MAX_TIMEDTEXT_BYTES);
  if (!bodyText || !bodyText.trim()) return null;

  // Try JSON3 first.
  const json = parseJson3(bodyText);
  if (json) return json;

  // Fall back to XML <text> nodes.
  return parseTimedTextXml(bodyText);
}

interface Json3Caption {
  events?: Array<{ segs?: Array<{ utf8?: string }> }>;
}

/** Flatten JSON3 caption segments into a single normalized string. */
function parseJson3(body: string): string | null {
  let doc: Json3Caption;
  try {
    doc = JSON.parse(body) as Json3Caption;
  } catch {
    return null;
  }
  if (!Array.isArray(doc.events)) return null;

  const parts: string[] = [];
  for (const ev of doc.events) {
    if (!Array.isArray(ev.segs)) continue;
    for (const seg of ev.segs) {
      if (typeof seg.utf8 === "string") parts.push(seg.utf8);
    }
  }
  return normalizeTranscript(parts.join(""));
}

/** Flatten the legacy `<transcript><text>…</text></transcript>` XML format. */
function parseTimedTextXml(body: string): string | null {
  const matches = body.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
  if (!matches || matches.length === 0) return null;

  const parts = matches.map((m) =>
    decodeXmlEntities(m.replace(/<text[^>]*>/, "").replace(/<\/text>/, "")),
  );
  return normalizeTranscript(parts.join(" "));
}

/** The max Unicode code point — anything above this is not a valid character. */
const MAX_CODE_POINT = 0x10ffff;

/** Decode the handful of XML/HTML entities timedtext uses. */
function decodeXmlEntities(text: string): string {
  return (
    text
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&#34;/g, '"')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Numeric entity. Bound the digit run (max 7 digits ≥ 0x10FFFF so all valid
      // code points fit) and reject out-of-range / non-finite values rather than
      // feeding garbage into String.fromCodePoint (an absurd `&#99999999999;`
      // would otherwise wrap or throw). Leave a rejected entity untouched.
      .replace(/&#(\d{1,7});/g, (whole, code: string) => {
        const n = Number(code);
        if (!Number.isFinite(n) || n < 0 || n > MAX_CODE_POINT) return whole;
        try {
          return String.fromCodePoint(n);
        } catch {
          return whole;
        }
      })
  );
}

/** Collapse whitespace + newlines into a clean single-spaced transcript. */
function normalizeTranscript(text: string): string | null {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
