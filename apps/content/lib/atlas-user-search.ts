/**
 * Atlas Search utility for the Individual-Emails people-picker.
 *
 * Mirrors apps/web/lib/market/atlas-search.ts: uses the $search aggregation
 * stage via Prisma $runCommandRaw against the "user_search" Atlas Search index
 * on the `User` collection (PROD / MongoDB Atlas only).
 *
 * Falls back gracefully (returns null) when Atlas Search is unavailable — e.g.
 * on the DigitalOcean QA/dev DBs which reject $search. The caller then runs the
 * existing Prisma `contains` (regex) query unchanged.
 *
 * See /docs/setup/atlas-search-setup.md (Part 9) for the index definition.
 *
 * MONEY-1128: the availability decision, the 5-minute latch and the error
 * classifier are shared with apps/web + packages/services via
 * `@usemoney/core/search/atlas-gate` — this file no longer keeps its own copy
 * (a `PlanExecutor`/`$search` substring test that latched on timeouts).
 */

import { prisma, Prisma } from "@usemoney/database";
import {
  SEARCH_INDEX,
  isAtlasSearchEnabled,
  reportSearchFailure,
} from "@usemoney/core/search/atlas-gate";

const SUBSYSTEM = "content.users";

interface RawCommandResult {
  cursor?: {
    firstBatch?: Record<string, unknown>[];
  };
  ok?: number;
}

// ============== USER SEARCH ==============

/**
 * Build the `$search` aggregation pipeline for the user people-picker.
 *
 * Pure (no I/O) so it can be unit-tested. Extracted for MONEY-1050.
 *
 * isActive handling: we exclude ONLY explicitly soft-deleted users
 * (`mustNot equals(isActive=false)`) rather than requiring
 * `equals(isActive=true)`. Legacy users created before the `isActive` field
 * existed have NO `isActive` key on their document; Prisma's `@default(true)`
 * only applies to new writes, so those docs are physically missing the field.
 * An `equals(isActive=true)` filter can never match a missing boolean, so it
 * silently dropped ~9 real users (incl. the founder) from the picker. Treating
 * "missing" as active — and excluding only the explicit `false` — keeps them
 * searchable while still hiding genuine soft-deletes.
 */
export function buildUserSearchPipeline(query: string, limit: number) {
  return [
    {
      $search: {
        index: SEARCH_INDEX.USERS,
        compound: {
          should: [
            // Autocomplete prefix match on email (handles "john" → john@…)
            {
              autocomplete: {
                query,
                path: "email",
                fuzzy: { maxEdits: 1, prefixLength: 1 },
              },
            },
            // Autocomplete prefix match on name (handles "joh" → "John Doe")
            {
              autocomplete: {
                query,
                path: "name",
                fuzzy: { maxEdits: 1, prefixLength: 2 },
              },
            },
            // Fuzzy full-text across email + name (handles typos)
            {
              text: {
                query,
                path: ["email", "name"],
                fuzzy: { maxEdits: 1, prefixLength: 2 },
              },
            },
          ],
          minimumShouldMatch: 1,
          // Exclude ONLY explicit soft-deletes; missing isActive = active.
          mustNot: [{ equals: { path: "isActive", value: false } }],
        },
      },
    },
    { $limit: limit },
    { $project: { email: 1, name: 1, _id: 0 } },
  ];
}

/**
 * Search active users using Atlas Search with autocomplete + fuzzy matching.
 * Returns null if Atlas Search is unavailable (index not found / non-Atlas DB),
 * signalling the caller to fall back to the Prisma `contains` query.
 */
export async function searchUsersAtlas(
  query: string,
  limit = 50,
): Promise<Array<{ email: string; name: string | null }> | null> {
  if (!isAtlasSearchEnabled(SEARCH_INDEX.USERS, SUBSYSTEM)) return null;

  const pipeline = buildUserSearchPipeline(query, limit);

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: "User",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = result?.cursor?.firstBatch ?? [];
    return docs as unknown as Array<{ email: string; name: string | null }>;
  } catch (error) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.USERS,
      subsystem: SUBSYSTEM,
      error,
    });
    if (action === "fallback") return null;
    throw error;
  }
}
