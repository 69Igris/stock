/**
 * Pure, server-only-free helpers for the ideas actions (`ideas.ts`).
 *
 * Extracted out of the `"use server"` action module so the title→slug
 * conversion, the auto-create username helpers, the role-based access guard,
 * and the list `where` builder can be unit-tested against the REAL exported
 * symbols instead of inline copies. `ideas.ts` imports and calls these.
 *
 * SECURITY: `canAccessResource` / `buildIdeaListWhere` enforce that a WRITER
 * only sees their own ideas — keep them byte-for-byte identical to the action
 * checks.
 *
 * @see apps/content/__tests__/actions/ideas.test.ts
 */

/**
 * Title→slug for a derived post URL: lowercase, collapse non-alphanumeric runs
 * to single hyphens, trim leading/trailing hyphens, truncate to 100.
 */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .substring(0, 100);
}

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
  name: string | null | undefined,
  email: string,
): string {
  return sanitizeUsername(name ?? email.split("@")[0] ?? "user");
}

/**
 * Collision-handling username: truncate the base to 22 chars and append the
 * counter (matches the auto-create loop in `ideas.ts`).
 */
export function usernameWithCounter(base: string, counter: number): string {
  return `${base.substring(0, 22)}_${counter}`;
}

/**
 * Resource access guard: a WRITER can only touch their own resource; every
 * other role (ADMIN / OWNER / EDITOR) can access all.
 */
export function canAccessResource(
  role: string,
  resourceAuthorId: string,
  currentAuthorId: string,
): boolean {
  if (role === "WRITER") return resourceAuthorId === currentAuthorId;
  return true;
}

/**
 * Build the idea-list `where`: optional status filter, plus a WRITER is scoped
 * to their own ideas.
 */
export function buildIdeaListWhere(
  role: string,
  authorId: string,
  status?: string,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (role === "WRITER") where.authorId = authorId;
  return where;
}
