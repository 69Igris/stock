/**
 * Pure, server-only-free helpers for the authors actions (`authors.ts`).
 *
 * Extracted out of the `"use server"` action module so username generation,
 * role determination, the role-change / self-demotion guards, invite
 * eligibility, and the partial profile-update builder can be unit-tested
 * against the REAL exported symbols instead of inline copies. `authors.ts`
 * imports and calls these.
 *
 * SECURITY: `canChangeRoles`, `canSelfDemote`, `checkInviteEligibility`, and
 * `canRevokeInvite` are authorization guards — keep them byte-for-byte
 * identical to the checks the actions apply.
 *
 * @see apps/content/__tests__/actions/authors.test.ts
 */

/**
 * Local mirror of the Prisma `ContentRole` enum members so this pure helper
 * module stays free of `@usemoney/database`. Mutually assignable with the real
 * enum (same string members).
 */
export type ContentRole = "OWNER" | "ADMIN" | "WRITER";

/**
 * Username sanitisation: lowercase, replace any non-[a-z0-9_] run-char with
 * `_`, and truncate to 25 chars.
 */
export function sanitizeUsername(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .substring(0, 25);
}

/** Base username from a display name, else the email local-part, else "user". */
export function generateUsernameBase(
  email: string,
  name?: string | null,
): string {
  const baseString = name ?? email.split("@")[0] ?? "user";
  return sanitizeUsername(baseString);
}

/** Append a collision counter to a base username. */
export function usernameWithCounter(base: string, counter: number): string {
  return `${base}_${counter}`;
}

/**
 * Role for a brand-new author: a matching pending-invite role wins, otherwise
 * the very first author is OWNER and everyone else is WRITER.
 */
export function determineNewAuthorRole(
  authorCount: number,
  pendingInviteRole?: ContentRole,
): ContentRole {
  if (pendingInviteRole) return pendingInviteRole;
  return authorCount === 0 ? "OWNER" : "WRITER";
}

/** Only an OWNER may change author roles. */
export function canChangeRoles(currentRole: string): boolean {
  return currentRole === "OWNER";
}

/**
 * Guard a self-demotion: an OWNER demoting themselves is blocked when they are
 * the only owner left.
 */
export function canSelfDemote(
  targetId: string,
  currentId: string,
  newRole: string,
  ownerCount: number,
): { allowed: boolean; error?: string } {
  if (targetId === currentId && newRole !== "OWNER") {
    if (ownerCount <= 1) {
      return {
        allowed: false,
        error:
          "Cannot change your role. You are the only owner. Assign another owner first.",
      };
    }
  }
  return { allowed: true };
}

/** Compose a Clerk display name from first/last, else null. */
export function buildClerkName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  return [firstName, lastName].filter(Boolean).join(" ") || null;
}

/** Only owners and admins may invite members. */
export function checkInviteEligibility(currentRole: string): {
  allowed: boolean;
  error?: string;
} {
  if (currentRole !== "OWNER" && currentRole !== "ADMIN") {
    return {
      allowed: false,
      error: "Only owners and admins can invite members",
    };
  }
  return { allowed: true };
}

/** Only a PENDING invite can be revoked. */
export function canRevokeInvite(status: string): {
  allowed: boolean;
  error?: string;
} {
  if (status !== "PENDING") {
    return {
      allowed: false,
      error: "Only pending invites can be revoked",
    };
  }
  return { allowed: true };
}

/** Partial author-profile update: only include explicitly-provided fields. */
export function buildProfileUpdateData(data: {
  name?: string;
  imageUrl?: string;
}): Record<string, string> {
  const update: Record<string, string> = {};
  if (data.name !== undefined) update.name = data.name;
  if (data.imageUrl !== undefined) update.imageUrl = data.imageUrl;
  return update;
}
