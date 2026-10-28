/**
 * User DB layer — pure logic (no Prisma / no Clerk / no server-only deps).
 *
 * Extracted from `lib/db/user.ts` so the Clerk-user name-resolution chain,
 * primary-email extraction, and the create/update/noop/reject decision can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * MONEY-620 de-shadow: `__tests__/db/user.test.ts` previously re-declared this
 * logic inline (a shadow). `user.ts` now imports and calls these helpers so the
 * production path and the test execute the SAME code.
 *
 * This module imports nothing server-only, so the tests stay pure and exit
 * cleanly.
 *
 * @see apps/web/__tests__/db/user.test.ts
 */

/** Subset of the Clerk user object the name/email helpers depend on. */
export interface ClerkUserNameInput {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  emailAddresses: { emailAddress: string }[];
}

/**
 * Resolve the display name following the fallback chain used by
 * `getOrCreateDbUser` and `syncClerkUserData`:
 *   fullName  →  "firstName lastName"  →  firstName  →  "Trader".
 *
 * Every falsy value (null / "") falls through to the next rung, so an empty
 * `fullName` does NOT win and a lone `lastName` (no `firstName`) yields
 * "Trader".
 */
export function resolveFullName(clerkUser: ClerkUserNameInput): string {
  return (
    clerkUser.fullName ||
    (clerkUser.firstName && clerkUser.lastName
      ? `${clerkUser.firstName} ${clerkUser.lastName}`
      : clerkUser.firstName || "Trader")
  );
}

/**
 * Extract the primary (first) email from a Clerk user, or `null` when the
 * user has no email addresses.
 */
export function extractEmail(
  clerkUser: Pick<ClerkUserNameInput, "emailAddresses">
): string | null {
  return clerkUser.emailAddresses[0]?.emailAddress ?? null;
}

/**
 * Whether a stored user row needs its `name` rewritten to match the freshly
 * resolved Clerk name. A plain `!==` so a null→value (or value→value) change
 * triggers an update and an identical name is a no-op.
 */
export function needsNameUpdate(
  existingName: string | null,
  newName: string
): boolean {
  return existingName !== newName;
}
