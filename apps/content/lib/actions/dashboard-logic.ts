/**
 * Pure, server-only-free helpers for the dashboard actions (`dashboard.ts`).
 *
 * Extracted out of the `"use server"` action module so the limit clamp, the
 * role-based base `where`, and the pagination skip can be unit-tested against
 * the REAL exported symbols instead of inline copies. `dashboard.ts` imports
 * and calls these.
 *
 * SECURITY: `buildBaseWhere` scopes a WRITER to their own posts — keep it
 * byte-for-byte identical to the action checks.
 *
 * @see apps/content/__tests__/actions/dashboard.test.ts
 */

/** Clamp a requested limit into the supported [1, 20] range. */
export function safeLimit(limit: number): number {
  return Math.min(Math.max(1, limit), 20);
}

/**
 * Role-based base `where` for non-deleted posts: a WRITER is scoped to their
 * own posts; admins/owners see all (non-deleted).
 */
export function buildBaseWhere(
  role: string,
  authorId: string,
): { authorId?: string; status: { not: "DELETED" } } {
  if (role === "WRITER") {
    return { authorId, status: { not: "DELETED" } };
  }
  return { status: { not: "DELETED" } };
}

/** Offset for a zero-indexed page. */
export function buildPaginationSkip(page: number, pageSize: number): number {
  return page * pageSize;
}
