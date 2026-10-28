/**
 * Pure admin-authorization logic for the admin dashboard.
 *
 * The admin gate ("is this Clerk user an admin?") was duplicated as an inline
 * `verifyAdmin` in every admin API route (config, discounts, discounts/[id],
 * invites, invites/[id], invite), inline in `proxy.ts`, and again in
 * `lib/auth.ts#requireAdmin`. This module is the single source of truth for
 * that predicate so all call sites share ONE implementation and it can be unit
 * tested without importing Clerk / Next.js.
 *
 * Admin rule: `publicMetadata.role === "admin"` OR the user's primary email is
 * in the `ADMIN_EMAILS` allowlist (case-insensitive).
 *
 * @see apps/admin/__tests__/api/config-discounts.test.ts
 * @see apps/admin/__tests__/middleware.test.ts
 */

/** Minimal shape of a Clerk user needed for the admin check. */
export interface AdminCheckUser {
  emailAddresses: Array<{ id: string; emailAddress: string }>;
  primaryEmailAddressId: string | null;
  publicMetadata: Record<string, unknown> | null | undefined;
}

/**
 * Parses the `ADMIN_EMAILS` env value (comma-separated) into a normalized list
 * of trimmed, lowercased, non-empty emails.
 */
export function parseAdminEmails(envValue: string | undefined): string[] {
  return (envValue || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns the user's primary email address (lowercased), or undefined when no
 * email matches `primaryEmailAddressId`.
 */
export function getPrimaryEmail(user: AdminCheckUser): string | undefined {
  return user.emailAddresses
    .find((email) => email.id === user.primaryEmailAddressId)
    ?.emailAddress?.toLowerCase();
}

/**
 * The admin predicate. True when the user has the `admin` role in public
 * metadata OR their primary email is in the admin allowlist.
 *
 * Fails CLOSED: an unknown role and an email absent from the allowlist both
 * yield false.
 */
export function isUserAdmin(
  user: AdminCheckUser,
  adminEmails: string[],
): boolean {
  const isAdminByRole = user.publicMetadata?.role === "admin";
  if (isAdminByRole) return true;

  const userEmail = getPrimaryEmail(user);
  return userEmail !== undefined && adminEmails.includes(userEmail);
}
