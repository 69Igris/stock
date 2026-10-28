"use server";

import { requireAdmin } from "@/lib/auth";
import { parseAdminEmails } from "@/lib/admin-auth-logic";
import type { AdminUser } from "./admins-types";

const OWNER_EMAIL = "deepshaswat@gmail.com";

/**
 * Resolve the email-based admin allowlist (`ADMIN_EMAILS` env) server-side so
 * the list never ships in the client bundle (MONEY-703 — previously hardcoded
 * in the "use client" /users page).
 *
 * Role-based admins (`publicMetadata.role === "admin"`) are managed in the
 * Clerk dashboard and are intentionally not enumerated here; the email
 * allowlist is the source of truth this page surfaces.
 */
export async function getAdminUsers(): Promise<AdminUser[]> {
  await requireAdmin();

  const emails = new Set<string>([
    OWNER_EMAIL,
    ...parseAdminEmails(process.env.ADMIN_EMAILS),
  ]);

  return [...emails]
    .map((email) => ({ email, isOwner: email === OWNER_EMAIL }))
    .sort((a, b) =>
      a.isOwner === b.isOwner
        ? a.email.localeCompare(b.email)
        : a.isOwner
          ? -1
          : 1,
    );
}
