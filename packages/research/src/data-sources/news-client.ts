/**
 * Google News RSS Parser
 *
 * Fetches recent news articles from Google News RSS feed.
 * Free, no API key required.
 */

import type { NewsArticle } from "../types";

const NEWS_BASE = "https://news.google.com/rss/search";

/**
 * Fetch recent news articles for a stock/topic
 */
export async function fetchNews(
  query: string,
  maxArticles = 10,
): Promise<NewsArticle[]> {
  try {
    const params = new URLSearchParams({
      q: `${query} stock india`,
      hl: "en-IN",
      gl: "IN",
      ceid: "IN:en",
    });

    const res = await fetch(`${NEWS_BASE}?${params.toString()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UseMoney/1.0)",
      },
    });

    if (!res.ok) {
      console.warn(`[news-client] Fetch failed: ${res.status}`);
      return [];
    }

    const xml = await res.text();
    return parseRssXml(xml, maxArticles);
  } catch (error) {
    console.warn(
      "[news-client] Error fetching news:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Simple RSS XML parser - no external dependency
 */
function parseRssXml(xml: string, maxArticles: number): NewsArticle[] {
  const articles: NewsArticle[] = [];

  // Match <item> blocks
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while (
    (match = itemRegex.exec(xml)) !== null &&
    articles.length < maxArticles
  ) {
    const itemXml = match[1];

    const title = extractTag(itemXml ?? "", "title");
    const link = extractTag(itemXml ?? "", "link");
    const pubDate = extractTag(itemXml ?? "", "pubDate");
    const source = extractTag(itemXml ?? "", "source");

    if (title && link) {
      articles.push({
        title: decodeHtmlEntities(title),
        link,
        pubDate: pubDate || new Date().toISOString(),
        source: source ? decodeHtmlEntities(source) : undefined,
      });
    }
  }

  return articles;
}

function extractTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`,
    "s",
  );
  const match = xml.match(regex);
  return match?.[1]?.trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
