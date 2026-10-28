/**
 * Atlas Search for content (blog, glossary, newsletter, docs).
 *
 * Uses $search aggregation stage via Prisma $runCommandRaw.
 * Requires Atlas Search index "content_search" on content_posts collection.
 *
 * Falls back gracefully when indexes are unavailable (e.g. DigitalOcean dev DB).
 * See /docs/setup/atlas-search-setup.md for index definitions.
 *
 * MONEY-1128: availability, the 5-minute latch and the error classifier live in
 * `@usemoney/core/search/atlas-gate` — ONE gate shared with instrument search,
 * discover and the CMS people-picker.
 */

import { prisma, Prisma } from "@usemoney/database";
import {
  SEARCH_INDEX,
  isAtlasSearchEnabled,
  reportSearchFailure,
} from "@usemoney/core/search/atlas-gate";

const SUBSYSTEM = "web.content.posts";

// ============== TYPES ==============

export interface AtlasContentResult {
  _id: { $oid: string };
  title: string;
  excerpt: string | null;
  postUrl: string;
  contentType: string;
  featureImage: string | null;
  publishDate: string | null;
  score: number;
}

interface RawCommandResult {
  cursor?: {
    firstBatch?: Record<string, unknown>[];
  };
  ok?: number;
}

// ============== CONTENT SEARCH ==============

export interface ContentSearchOptions {
  contentType?: string; // "BLOG" | "GLOSSARY" | "NEWSLETTER" | "DOCS"
  limit?: number;
  fuzzy?: boolean;
}

/**
 * Build the `$search` pipeline for content search. Pure (no I/O).
 *
 * MONEY-1128 — the three filter clauses used to be `text` operators:
 *
 *   { text: { query: "PUBLISHED", path: "status" } }
 *
 * `status`, `contentPlatform` and `contentType` are all mapped
 * `type: "token"` in the content_search index
 * (docs/setup/atlas-search-setup.md, Step 3). The `text` operator requires an
 * analyzed `string` mapping and cannot match a token-mapped field, so those
 * filters matched nothing and the whole compound query returned zero rows on
 * Atlas. Same defect class as the instrument `exchange` filter; `equals` is the
 * operator token-mapped fields take.
 */
export function buildContentSearchPipeline(
  query: string,
  options: ContentSearchOptions = {}
): Record<string, unknown>[] {
  const { contentType, limit = 15, fuzzy = true } = options;

  const fuzzyOpts = fuzzy ? { fuzzy: { maxEdits: 1, prefixLength: 2 } } : {};

  // Separate should clauses with decreasing boost: title > excerpt > content
  const shouldClauses: Record<string, unknown>[] = [
    {
      text: {
        query,
        path: "title",
        score: { boost: { value: 5 } },
        ...fuzzyOpts,
      },
    },
    {
      text: {
        query,
        path: "excerpt",
        score: { boost: { value: 3 } },
        ...fuzzyOpts,
      },
    },
    {
      text: {
        query,
        path: "content",
        score: { boost: { value: 1 } },
        ...fuzzyOpts,
      },
    },
  ];

  const filterClauses: Record<string, unknown>[] = [
    { equals: { path: "status", value: "PUBLISHED" } },
    { equals: { path: "contentPlatform", value: "STOCKBOOK" } },
  ];

  if (contentType) {
    filterClauses.push({
      equals: { path: "contentType", value: contentType.toUpperCase() },
    });
  }

  return [
    {
      $search: {
        index: SEARCH_INDEX.CONTENT,
        compound: {
          should: shouldClauses,
          minimumShouldMatch: 1,
          filter: filterClauses,
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        title: 1,
        excerpt: 1,
        postUrl: 1,
        contentType: 1,
        featureImage: 1,
        publishDate: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
}

/**
 * Search published content using Atlas Search with fuzzy matching and relevance scoring.
 * Returns null if Atlas Search is unavailable (index not found / non-Atlas DB).
 * Caller should fall back to Prisma `contains` search when null is returned.
 */
export async function searchContentAtlas(
  query: string,
  options: ContentSearchOptions = {}
): Promise<AtlasContentResult[] | null> {
  if (!isAtlasSearchEnabled(SEARCH_INDEX.CONTENT, SUBSYSTEM)) return null;

  const pipeline = buildContentSearchPipeline(query, options);

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: "content_posts",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = result?.cursor?.firstBatch ?? [];
    return docs as unknown as AtlasContentResult[];
  } catch (error) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.CONTENT,
      subsystem: SUBSYSTEM,
      error,
    });
    if (action === "fallback") return null;
    throw error;
  }
}
