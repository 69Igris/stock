/**
 * Admin Authorization Utilities
 *
 * Centralized admin access control for protected endpoints.
 * MONEY-1062: unified with the (now removed) apps/web/lib/auth/admin.ts twin.
 * Admin is granted by the UNION of the two prior mechanisms, fail-closed:
 *   1. Clerk publicMetadata.role === "admin"        (web twin's primary)
 *   2. email listed in ADMIN_EMAILS env (CSV)       (web twin's fallback)
 *   3. email === FOUNDER_ADMIN_EMAIL                (this package's original)
 */

import { currentUser } from "@clerk/nextjs/server";
import { auth } from "@clerk/nextjs/server";

// Founder fallback - keeps admin access working in deployments where
// neither the Clerk role nor ADMIN_EMAILS is configured.
const FOUNDER_ADMIN_EMAIL = "deepshaswat@gmail.com";

/**
 * Check if a Clerk user has admin privileges.
 * Primary: user.publicMetadata.role === "admin"
 * Fallbacks: email in ADMIN_EMAILS env var (comma-separated), founder email.
 */
function isAdminUser(user: {
  publicMetadata?: Record<string, unknown>;
  emailAddresses?: { emailAddress: string }[];
}): boolean {
  // Primary check: Clerk publicMetadata role
  if (
    user.publicMetadata &&
    (user.publicMetadata as Record<string, unknown>).role === "admin"
  ) {
    return true;
  }

  const userEmail = user.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  if (!userEmail) return false;

  // Fallback: environment variable with allowed admin emails
  const adminEmails = process.env.ADMIN_EMAILS;
  if (adminEmails) {
    const allowedEmails = adminEmails
      .split(",")
      .map((e) => e.trim().toLowerCase());
    if (allowedEmails.includes(userEmail)) return true;
  }

  // Founder fallback
  return userEmail === FOUNDER_ADMIN_EMAIL.toLowerCase();
}

/**
 * Check if the current user is an admin
 * @returns Promise<boolean> - true if user is admin, false otherwise
 */
export async function isAdmin(): Promise<boolean> {
  try {
    const user = await currentUser();
    if (!user) return false;

    return isAdminUser(user);
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

/**
 * Check if the current user is an admin (using auth() instead of currentUser())
 * This is faster but requires looking up user data separately if needed
 * @returns Promise<{ isAdmin: boolean; userId: string | null }>
 */
export async function checkAdminAuth(): Promise<{
  isAdmin: boolean;
  userId: string | null;
  userEmail: string | null;
}> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return { isAdmin: false, userId: null, userEmail: null };
    }

    // Get full user data to check role metadata + email
    const user = await currentUser();
    if (!user) {
      return { isAdmin: false, userId, userEmail: null };
    }

    const userEmail = user.emailAddresses?.[0]?.emailAddress || null;
    const isAdminResult = isAdminUser(user);

    return { isAdmin: isAdminResult, userId, userEmail };
  } catch (error) {
    console.error("Error checking admin auth:", error);
    return { isAdmin: false, userId: null, userEmail: null };
  }
}

/**
 * Middleware to require admin access
 * Throws an error if user is not admin
 */
export async function requireAdmin(): Promise<void> {
  const admin = await isAdmin();
  if (!admin) {
    throw new Error("Unauthorized: Admin access required");
  }
}

/**
 * Check if running in production environment
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Check if debug features should be enabled
 * Debug features are disabled in production unless explicitly enabled
 */
export function isDebugEnabled(): boolean {
  // Allow debug features in development
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  // In production, only enable if explicitly set
  return process.env.ENABLE_DEBUG_FEATURES === "true";
}
