/**
 * Pure logic for the cache-clear endpoint (`app/api/cache/clear/route.ts`).
 *
 * Extracted so the request validation, the valid-action gate, and the
 * per-action result payload builders can be unit tested directly. The route
 * imports & calls these — production runs the same code the tests assert.
 */

export interface CacheClearBody {
  action?: string;
  userId?: string;
  modules?: string[];
  pattern?: string;
}

export interface ClearResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** The clear actions the route accepts. */
export const VALID_CLEAR_ACTIONS = [
  "all",
  "user",
  "pattern",
  "memory",
] as const;

/**
 * Validate that `action` is one of the allowed values; returns an error string
 * (for the 400 body) or null when valid.
 */
export function validateActionType(action: string): string | null {
  if (!(VALID_CLEAR_ACTIONS as readonly string[]).includes(action)) {
    return `Invalid action: ${action}. Valid actions: all, user, pattern, memory`;
  }
  return null;
}

/** Result payload for the "all" (flush everything) action. */
export function buildAllClearResult(keyCount: number): ClearResult {
  return {
    success: true,
    message: `Successfully cleared all Redis cache (${keyCount} keys) and memory cache`,
    details: { keysCleared: keyCount },
  };
}

/** Result payload for the "user" action scoped to specific modules. */
export function buildUserModulesClearResult(
  userId: string,
  modules: string[]
): ClearResult {
  return {
    success: true,
    message: `Successfully cleared cache for user ${userId}, modules: ${modules.join(", ")}`,
    details: { userId, modules },
  };
}

/** Result payload for the "user" action clearing ALL of the user's cache. */
export function buildUserAllClearResult(userId: string): ClearResult {
  return {
    success: true,
    message: `Successfully cleared all cache for user ${userId}`,
    details: { userId, allModules: true },
  };
}

/** Result payload for the "pattern" action. */
export function buildPatternClearResult(
  pattern: string,
  keysDeleted: number
): ClearResult {
  return {
    success: true,
    message: `Successfully cleared ${keysDeleted} keys matching pattern: ${pattern}`,
    details: { pattern, keysDeleted },
  };
}

/** Result payload for the "memory"-only action. */
export function buildMemoryClearResult(): ClearResult {
  return {
    success: true,
    message: "Successfully cleared memory cache",
  };
}
