/**
 * API Response Helpers
 *
 * Re-exports from @usemoney/api-utils with Hono-specific helpers.
 */

import type { Context } from "hono";

// Re-export from shared package
export {
  success,
  error,
  paginated,
  ErrorCodes,
  type ApiResponse,
  type PaginationParams,
  type ErrorCode,
} from "@usemoney/api-utils";

// Request-parsing helpers (malformed-body + zod → 400). Subpath import per the
// "always import subpaths" rule.
export {
  safeJson,
  zodParse,
  type SafeJsonResult,
  type ZodParseResult,
  type ParseIssue,
} from "@usemoney/api-utils/request";

// Cursor pagination (opaque cursor + envelope).
export {
  encodeCursor,
  decodeCursor,
  paginatedCursor,
  type CursorPage,
} from "@usemoney/api-utils/pagination";

// Hono-specific helpers
import { type ApiResponse, paginated } from "@usemoney/api-utils";

/**
 * Helper to send JSON response with proper status code
 */
export function jsonResponse<T>(
  c: Context,
  data: ApiResponse<T>,
  status: 200 | 201 | 400 | 401 | 403 | 404 | 429 | 500 | 503 = 200,
) {
  return c.json(data, status);
}

/**
 * Pagination helper with 4-argument signature for backward compatibility
 */
export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): ApiResponse<T[]> {
  return paginated(items, { total, page, limit });
}
