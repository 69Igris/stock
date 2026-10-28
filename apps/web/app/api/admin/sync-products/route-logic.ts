/**
 * Pure authorization + response-shaping for the admin product-sync route.
 *
 * Extracted from `./route.ts` so the admin gate (must be authenticated AND
 * carry Clerk `publicMetadata.role === "admin"`) and the success-payload shape
 * are tested against the REAL exported symbols the route calls, not an inline
 * copy. Kept free of `@clerk/nextjs/server` / Prisma imports so it stays a
 * cheap pure unit.
 *
 * @see apps/web/__tests__/api/admin-routes.test.ts
 */

/** Subset of Clerk's `User.publicMetadata` the admin gate reads. */
export interface AdminMetadata {
  role?: string;
  [key: string]: unknown;
}

/**
 * True iff the Clerk user's metadata marks them an admin. Mirrors the route's
 * `clerkUser.publicMetadata?.role === "admin"` (case-sensitive, exact match).
 */
export function isClerkUserAdmin(
  publicMetadata: AdminMetadata | null | undefined
): boolean {
  return publicMetadata?.role === "admin";
}

/** Outcome of the admin access gate, carrying the HTTP status to emit. */
export type AdminAccessResult =
  | { allowed: true }
  | { allowed: false; error: string; status: 401 | 403 };

/**
 * Decide whether a request may run the admin sync. Order matches the route:
 * an absent userId (unauthenticated) is 401; a present-but-non-admin user is
 * 403.
 */
export function checkAdminAccess(
  userId: string | null,
  publicMetadata: AdminMetadata | null | undefined
): AdminAccessResult {
  if (!userId) {
    return { allowed: false, error: "Unauthorized", status: 401 };
  }
  if (!isClerkUserAdmin(publicMetadata)) {
    return { allowed: false, error: "Forbidden", status: 403 };
  }
  return { allowed: true };
}

/** Success body returned by POST /api/admin/sync-products. */
export function formatAdminSyncResponse(
  synced: number,
  errors: string[]
): { success: true; synced: number; errors: string[]; timestamp: string } {
  return {
    success: true,
    synced,
    errors,
    timestamp: new Date().toISOString(),
  };
}
