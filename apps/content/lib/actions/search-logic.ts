/**
 * Pure, server-only-free helpers for Atlas Search (`search.ts`).
 *
 * Extracted out of the `"use server"` action module so the Atlas error
 * classification, the environment detection, the retry constant, and the
 * availability state machine can be unit-tested against the REAL exported
 * symbols instead of inline copies. `search.ts` imports and calls these.
 *
 * @see apps/content/__tests__/actions/search.test.ts
 */

/** How long to skip Atlas after a SearchNotEnabled-style failure (5 min). */
export const ATLAS_RETRY_MS = 5 * 60 * 1000;

/**
 * Classify a raw error message as an Atlas-Search-unavailable signal
 * (case-sensitive substring match) so we can fall back to Prisma.
 */
export function isAtlasError(msg: string): boolean {
  return (
    msg.includes("index not found") ||
    msg.includes("$search") ||
    msg.includes("Atlas Search") ||
    msg.includes("SearchNotEnabled") ||
    msg.includes("PlanExecutor")
  );
}

/** Quick check: Atlas Search only works on MongoDB Atlas (mongodb.net). */
export function isAtlasEnvironmentCheck(databaseUrl: string): boolean {
  return databaseUrl.includes("mongodb.net");
}

/** A short-circuiting availability gate with a retry cooldown. */
export interface AtlasAvailability {
  isAvailable(): boolean;
  markUnavailable(): void;
  getUnavailableUntil(): number;
}

/**
 * Build the Atlas availability state machine: available immediately in an
 * Atlas environment, never available otherwise, and unavailable for
 * `ATLAS_RETRY_MS` after `markUnavailable()`.
 */
export function createAtlasAvailability(
  isAtlasEnvironment: boolean,
): AtlasAvailability {
  let unavailableUntil = 0;

  return {
    isAvailable(): boolean {
      if (!isAtlasEnvironment) return false;
      return Date.now() >= unavailableUntil;
    },
    markUnavailable(): void {
      unavailableUntil = Date.now() + ATLAS_RETRY_MS;
    },
    getUnavailableUntil(): number {
      return unavailableUntil;
    },
  };
}
