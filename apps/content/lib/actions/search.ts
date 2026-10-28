"use server";

/**
 * Atlas Search for CMS posts.
 *
 * Uses $search aggregation via Prisma $runCommandRaw.
 * Requires Atlas Search index "content_search" on content_posts collection.
 *
 * Priority: title (boost 5) > excerpt (boost 3) > content (boost 1).
 * Falls back gracefully when Atlas is unavailable (QA/local).
 */

import { prisma, Prisma } from "@usemoney/database";
import {
  createAtlasAvailability,
  isAtlasEnvironmentCheck,
  isAtlasError,
} from "./search-logic";

// ── Atlas availability flag ──

/** Quick check: Atlas Search only works on MongoDB Atlas (mongodb.net). */
const isAtlasEnvironment = isAtlasEnvironmentCheck(
  process.env.DATABASE_URL ?? "",
);

const atlasAvailability = createAtlasAvailability(isAtlasEnvironment);

function isAtlasAvailable(): boolean {
  return atlasAvailability.isAvailable();
}

function markAtlasUnavailable(): void {
  atlasAvailability.markUnavailable();
}

// ── Types ──

interface RawCommandResult {
  cursor?: {
    firstBatch?: Record<string, unknown>[];
  };
  ok?: number;
}

export interface AtlasCmsSearchResult {
  _id: { $oid: string };
  title: string;
  score: number;
}

// ── Search function ──

export interface CmsSearchOptions {
  contentType?: string;
  status?: string;
  limit?: number;
}

/**
 * Search CMS posts using Atlas Search with boosted field priority.
 * Returns matching post IDs in relevance order, or null if Atlas unavailable.
 */
export async function searchPostsAtlas(
  query: string,
  options: CmsSearchOptions = {},
): Promise<string[] | null> {
  if (!isAtlasAvailable()) return null;
  if (!query.trim()) return null;

  const { contentType, status, limit = 50 } = options;

  // Boosted should clauses: title > excerpt > content
  const shouldClauses: Record<string, unknown>[] = [
    {
      text: {
        query,
        path: "title",
        score: { boost: { value: 5 } },
        fuzzy: { maxEdits: 1, prefixLength: 2 },
      },
    },
    {
      text: {
        query,
        path: "excerpt",
        score: { boost: { value: 3 } },
        fuzzy: { maxEdits: 1, prefixLength: 2 },
      },
    },
    {
      text: {
        query,
        path: "content",
        score: { boost: { value: 1 } },
        fuzzy: { maxEdits: 1, prefixLength: 2 },
      },
    },
  ];

  const filterClauses: Record<string, unknown>[] = [];

  // CMS shows all statuses by default, but filter if specified
  if (status) {
    filterClauses.push({ text: { query: status, path: "status" } });
  }
  if (contentType) {
    filterClauses.push({
      text: { query: contentType, path: "contentType" },
    });
  }

  const compound: Record<string, unknown> = {
    should: shouldClauses,
    minimumShouldMatch: 1,
  };
  if (filterClauses.length > 0) {
    compound.filter = filterClauses;
  }

  const pipeline = [
    { $search: { index: "content_search", compound } },
    { $limit: limit },
    { $project: { _id: 1, score: { $meta: "searchScore" } } },
  ];

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: "content_posts",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = result?.cursor?.firstBatch ?? [];
    return docs.map((d) => {
      const id = d._id as { $oid: string } | string;
      return typeof id === "string" ? id : id.$oid;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isAtlasError(msg)) {
      markAtlasUnavailable();
      return null;
    }
    throw error;
  }
}
