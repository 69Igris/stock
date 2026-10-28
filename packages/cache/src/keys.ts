import crypto from "crypto";
import type { CacheKey, CacheModule } from "./types";

/**
 * Generate a version hash from data/filters
 * Uses MD5 for fast hashing (8 character hash)
 *
 * @param data - Any serializable data (filters, params, etc.)
 * @returns 8-character hex hash
 *
 * @example
 * ```typescript
 * const hash = generateVersionHash({ symbol: 'RELIANCE', broker: 'zerodha' });
 * // Returns: "a8b3c4d2"
 * ```
 */
export function generateVersionHash(data: unknown): string {
  // Sort object keys for consistent hashing
  const dataString = JSON.stringify(
    data,
    Object.keys((data as object) || {}).sort(),
  );
  return crypto.createHash("md5").update(dataString).digest("hex").slice(0, 8);
}

/**
 * Reversibly escape a single cache-key segment so a literal ":" inside it can
 * never be confused with the ":" that joins segments.
 *
 * Without this, generateCacheKey("m", "user", "a:b") and
 * generateCacheKey("m", "user:a", "b") both produce "m:user:a:b:default" — the
 * SAME Redis key for two different logical entries (keyspace collision / cross-
 * entry data bleed). "%" is escaped FIRST so the "%3A" introduced for ":" round-
 * trips cleanly. Segments containing neither character are returned unchanged,
 * so existing keys (Clerk userIds, plain identifiers) keep their exact byte form
 * — only the previously-colliding keys change shape.
 */
function escapeSegment(segment: string): string {
  if (!segment.includes("%") && !segment.includes(":")) return segment;
  return segment.replace(/%/g, "%25").replace(/:/g, "%3A");
}

/** Inverse of {@link escapeSegment} — decode ":" before "%" (reverse order). */
function unescapeSegment(segment: string): string {
  if (!segment.includes("%")) return segment;
  return segment.replace(/%3A/g, ":").replace(/%25/g, "%");
}

/**
 * Generate cache key with module, userId, identifier, and optional version
 * Pattern: {module}:{userId}:{identifier}:{version}
 *
 * @param module - Cache module name
 * @param userId - User ID for namespacing
 * @param identifier - Specific identifier (e.g., 'stats', 'filters', 'page-1')
 * @param filters - Optional filters/params for version hashing
 * @returns Cache key string
 *
 * @example
 * ```typescript
 * const key = generateCacheKey('dashboard', 'user123', 'stats');
 * // Returns: "dashboard:user123:stats:default"
 *
 * const keyWithFilters = generateCacheKey(
 *   'positions',
 *   'user123',
 *   'filters',
 *   { broker: 'zerodha', segment: 'equity' }
 * );
 * // Returns: "positions:user123:filters:a8b3c4d2"
 * ```
 */
export function generateCacheKey(
  module: CacheModule,
  userId: string,
  identifier: string,
  filters?: unknown,
): CacheKey {
  const version = filters ? generateVersionHash(filters) : "default";
  // Escape every segment so a ":" inside userId/identifier can't shift the
  // delimiter boundaries and alias another logical key (see escapeSegment).
  return `${escapeSegment(module)}:${escapeSegment(userId)}:${escapeSegment(identifier)}:${escapeSegment(version)}`;
}

/**
 * Parse cache key back into components
 *
 * @param key - Cache key to parse
 * @returns Object with module, userId, identifier, and version, or null if invalid
 *
 * @example
 * ```typescript
 * const parsed = parseCacheKey('dashboard:user123:stats:default');
 * // Returns: { module: 'dashboard', userId: 'user123', identifier: 'stats', version: 'default' }
 * ```
 */
export function parseCacheKey(key: CacheKey): {
  module: string;
  userId: string;
  identifier: string;
  version: string;
} | null {
  const parts = key.split(":");
  if (parts.length !== 4) {
    return null;
  }

  const [module, userId, identifier, version] = parts;
  if (!module || !userId || !identifier || !version) {
    return null;
  }

  // Decode the escaping applied by generateCacheKey so callers see the original
  // segment values (round-trip). Because each stored segment is escaped, the
  // ":" split above always yields exactly 4 parts for a well-formed key.
  return {
    module: unescapeSegment(module),
    userId: unescapeSegment(userId),
    identifier: unescapeSegment(identifier),
    version: unescapeSegment(version),
  };
}

/**
 * Generate cache key pattern for Redis pattern matching
 * Used for bulk deletion with wildcards
 *
 * @param module - Cache module name
 * @param userId - Optional user ID for user-specific patterns
 * @param identifier - Optional identifier for more specific patterns
 * @returns Pattern string with wildcards
 *
 * @example
 * ```typescript
 * // All dashboard keys for a user
 * const pattern = generateCachePattern('dashboard', 'user123');
 * // Returns: "dashboard:user123:*"
 *
 * // All dashboard stats for a user (all versions)
 * const pattern = generateCachePattern('dashboard', 'user123', 'stats');
 * // Returns: "dashboard:user123:stats:*"
 *
 * // All dashboard keys for all users
 * const pattern = generateCachePattern('dashboard');
 * // Returns: "dashboard:*"
 * ```
 */
export function generateCachePattern(
  module: CacheModule,
  userId?: string,
  identifier?: string,
): string {
  // Escape segments consistently with generateCacheKey so the wildcard pattern
  // matches the (escaped) keys actually stored in Redis. The trailing "*" is a
  // literal Redis glob and is intentionally left unescaped.
  if (identifier && userId) {
    return `${escapeSegment(module)}:${escapeSegment(userId)}:${escapeSegment(identifier)}:*`;
  }
  if (userId) {
    return `${escapeSegment(module)}:${escapeSegment(userId)}:*`;
  }
  return `${escapeSegment(module)}:*`;
}

/**
 * Sanitize userId for logging (show only first 8 characters)
 *
 * @param userId - Full user ID
 * @returns Truncated user ID for safe logging
 *
 * @example
 * ```typescript
 * sanitizeUserId('user_2abc123456789def');
 * // Returns: "user_2ab"
 * ```
 */
export function sanitizeUserId(userId: string): string {
  return userId.slice(0, 8);
}
