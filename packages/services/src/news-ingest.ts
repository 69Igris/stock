/**
 * News ingestion - MONEY-408.
 *
 * RSS parser + dedup utilities for the news-rss-sync worker. The
 * worker route lives at `workers/src/processors/news-rss-sync.ts`
 * (follow-up); this module ships the pure logic so it can be unit-
 * tested without the worker shell.
 *
 * Source list:
 *   - Economic Times: https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms
 *   - Mint:           https://www.livemint.com/rss/markets
 *   - Business Std:   https://www.business-standard.com/rss/markets-106.rss
 *   - Moneycontrol:   https://www.moneycontrol.com/rss/marketreports.xml
 *   - Bloomberg-IN:   (not free - paid plan; placeholder for now)
 *
 * Symbol enrichment is delegated to a Gemini Flash classifier in the
 * worker; this module returns articles in normalised shape and dedup-
 * keyed by URL.
 */

export interface RawNewsItem {
  url: string;
  title: string;
  summary: string | null;
  source: string;
  publishedAt: Date;
}

export interface IngestedNewsArticle extends RawNewsItem {
  /** Will be populated by the Gemini Flash classifier in the worker. */
  symbols: string[];
  sectors: string[];
  categories: string[];
  language: string;
  sentiment: string | null;
}

/**
 * Title-similarity threshold for dedup. Two titles whose Jaccard-on-
 * words coefficient exceeds this are considered the same story.
 */
export const DEDUP_TITLE_SIM = 0.85;

/** Lowercase, strip punctuation, split on whitespace, drop stopwords */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "at",
  "by",
  "from",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "as",
]);

function tokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  a.forEach((tok) => {
    if (b.has(tok)) intersect++;
  });
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Dedup a batch of fresh items against:
 *   1. Each other (intra-batch - two outlets cover the same story)
 *   2. An optional set of already-stored URLs + titles to avoid re-saving
 *
 * Returns the keepable subset preserving original order. URLs win
 * exact-match dedup; titles win fuzzy-match dedup at DEDUP_TITLE_SIM.
 */
export function dedupNewsBatch(
  items: RawNewsItem[],
  knownUrls: ReadonlySet<string> = new Set(),
  knownTitles: ReadonlyArray<string> = [],
): RawNewsItem[] {
  const out: RawNewsItem[] = [];
  const seenUrls = new Set<string>(knownUrls);
  const seenTitleTokens = knownTitles.map(tokenize);

  for (const item of items) {
    if (seenUrls.has(item.url)) continue;

    const titleTokens = tokenize(item.title);
    let dup = false;
    for (const known of seenTitleTokens) {
      if (jaccard(titleTokens, known) >= DEDUP_TITLE_SIM) {
        dup = true;
        break;
      }
    }
    if (dup) continue;

    seenUrls.add(item.url);
    seenTitleTokens.push(titleTokens);
    out.push(item);
  }

  return out;
}

/**
 * Parse an RSS 2.0 channel into RawNewsItem[]. Tolerates missing
 * description / pubDate fields. Designed for Node's worker
 * environment (consumers supply XML text fetched via fetch).
 */
export function parseRssChannel(xml: string, source: string): RawNewsItem[] {
  // Minimal regex-based RSS parser - no DOM, no extra deps. Items
  // are delimited by <item>...</item>; sub-tags are extracted per
  // item. This is intentionally permissive: malformed feeds drop
  // the bad item but keep the rest.
  const items: RawNewsItem[] = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) ?? [];

  for (const block of matches) {
    const url = pickTag(block, "link");
    const title = pickTag(block, "title");
    if (!url || !title) continue;
    const summary = pickTag(block, "description");
    const pubDateRaw = pickTag(block, "pubDate");
    const publishedAt = pubDateRaw ? new Date(pubDateRaw) : new Date();
    if (Number.isNaN(publishedAt.getTime())) continue;
    items.push({
      // A URL is never entity-decoded (a literal "&amp;" in a query string is
      // part of the real link); title/summary ARE human-readable text that the
      // feed delivers entity-encoded, so decode them or the UI renders the raw
      // "&amp;"/"&#8377;" and the dedup tokenizer is polluted with "amp".
      url: stripCdata(url).trim(),
      title: decodeXmlEntities(stripCdata(title)).trim(),
      summary: summary ? decodeXmlEntities(stripCdata(summary)).trim() : null,
      source,
      publishedAt,
    });
  }

  return items;
}

function pickTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m?.[1] ?? null;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  // Normalise NBSP to a plain ASCII space: the title/summary are display text,
  // and a stray U+00A0 reads identically but trips naive substring matching.
  nbsp: " ",
};

/**
 * Decode the XML/HTML entities that real RSS feeds (ET, Mint, BS, Moneycontrol)
 * routinely emit in `<title>`/`<description>` text: the five predefined XML
 * entities (`&amp; &lt; &gt; &quot; &apos;`), the common `&#39;`/`&nbsp;`, and
 * numeric character references in decimal (`&#8377;` → ₹) and hex (`&#x20B9;`).
 *
 * Why this matters: the parsed title/summary are persisted verbatim into
 * `NewsArticle` and rendered straight into a JSX text node on the discover/news
 * feed — React does NOT decode entities in text content, so without this the
 * user literally sees "Reliance &amp; HDFC" / "&#8377;83". It also keeps the
 * dedup tokenizer honest: `tokenize` strips `&`/`;` via `[^\w\s]`, which would
 * otherwise leave a junk `amp` token in every entity-bearing headline and
 * inflate the Jaccard similarity between unrelated stories.
 *
 * `&amp;` is intentionally resolved LAST (after numeric refs) so an already
 * single-escaped string is decoded exactly once and we never double-decode a
 * sequence like `&amp;#39;` into a quote. Unknown/malformed entities are left
 * untouched rather than dropped.
 */
export function decodeXmlEntities(input: string): string {
  if (!input || input.indexOf("&") === -1) return input;
  return (
    input
      // Numeric refs first: decimal &#NNN; and hex &#xHH; (case-insensitive x).
      .replace(/&#(\d+);/g, (m, dec: string) => codePointOrRaw(m, Number(dec)))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) =>
        codePointOrRaw(m, parseInt(hex, 16)),
      )
      // Named refs except &amp; (which must stay last to avoid double-decoding).
      .replace(/&(lt|gt|quot|apos|#39|nbsp);/g, (m, name: string) =>
        name in NAMED_ENTITIES ? NAMED_ENTITIES[name]! : m,
      )
      .replace(/&amp;/g, "&")
  );
}

/** Resolve a code point to its character, or return the raw match if it's not a
 *  valid/finite scalar (so malformed numeric refs aren't turned into U+FFFD). */
function codePointOrRaw(raw: string, code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return raw;
  try {
    return String.fromCodePoint(code);
  } catch {
    return raw;
  }
}
