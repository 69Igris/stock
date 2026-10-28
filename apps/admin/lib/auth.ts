import { auth, clerkClient } from "@clerk/nextjs/server";
import { isUserAdmin, parseAdminEmails } from "@/lib/admin-auth-logic";

/**
 * Verify the current user is an admin.
 * Mirrors the middleware check: email in ADMIN_EMAILS OR publicMetadata.role === "admin".
 * Throws "Unauthorized" (no user) or "Forbidden" (not admin).
 */
export async function requireAdmin(): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  if (!isUserAdmin(user, parseAdminEmails(process.env.ADMIN_EMAILS))) {
    throw new Error("Forbidden");
  }
}

/**
 * Boolean admin check for a known Clerk userId, used by the admin API route
 * handlers (which return 401/403 JSON rather than throwing). Shares the same
 * pure predicate as `requireAdmin`.
 */
export async function verifyAdminUserId(userId: string): Promise<boolean> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return isUserAdmin(user, parseAdminEmails(process.env.ADMIN_EMAILS));
}

/**
 * The current admin's primary email, for audit attribution (recordAdminAction).
 * Returns "unknown" when it can't be resolved — never throws, since it's used
 * for logging alongside an action that has already passed requireAdmin().
 */
export async function getAdminActorEmail(): Promise<string> {
  const { userId } = await auth();
  if (!userId) return "unknown";
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    return (
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}
