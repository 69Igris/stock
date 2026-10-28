/**
 * Account Lifecycle Server Actions (MONEY-391)
 *
 * Two-step delete account flow:
 *   1. requestDeleteOtpAction() — sends a 6-digit code to the user's email
 *   2. confirmDeleteAccountAction({ otp, typedConfirmation, reason? })
 *      - verifies OTP + typed "DELETE"
 *      - captures DeletedUserAudit (assets, brokers, subscription)
 *      - cancels Dodo subscription
 *      - hard-deletes all user data
 *      - removes the Clerk user (also fires webhook → no-op since row gone)
 *      - returns { success: true } so the client can sign out + redirect
 *
 * Anti-replay: server-side OTP single-use, "DELETE" must match exactly,
 * rate-limited via the OTP service (3 OTPs/hour, 5 verify attempts).
 */

"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import React from "react";
import { prisma } from "@/lib/prisma";
import { generateDeleteOtp, verifyDeleteOtp } from "@usemoney/services";
import { sendEmail } from "@usemoney/email";
import { DeleteAccountOtpEmail } from "@usemoney/email/templates";
import { publishAccountDeletionJob } from "@usemoney/pubsub/publish";

// ── Result types ───────────────────────────────────────────────────

export interface RequestDeleteOtpActionResult {
  success: boolean;
  maskedEmail?: string;
  expiresAt?: string; // ISO
  error?: string;
  /**
   * MONEY-144 - set when the caller's Clerk session is valid but the
   * underlying DB user is gone (deletion worker already cascaded).
   * The dialog handles this by signing the user out and bouncing them
   * to the homepage instead of surfacing a confusing "user missing"
   * error.
   */
  requiresSignOut?: boolean;
}

export interface ConfirmDeleteAccountActionResult {
  success: boolean;
  /** Audit row id — surfaced so support can look up the snapshot if needed. */
  auditId?: string;
  error?: string;
  /** Same ghost-session signal as RequestDeleteOtpActionResult. */
  requiresSignOut?: boolean;
}

// ── 1. Request OTP ─────────────────────────────────────────────────

export async function requestDeleteOtpAction(): Promise<RequestDeleteOtpActionResult> {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return { success: false, error: "Not signed in" };
  }

  const clerkUser = await currentUser();
  const email = clerkUser?.emailAddresses[0]?.emailAddress;
  if (!email) {
    return { success: false, error: "No email on file" };
  }

  // Resolve internal userId (rate-limits keyed on internal id, not clerkId,
  // because Clerk dashboard sometimes assigns a new clerkId on auth-method
  // changes; internal id is the stable handle).
  const dbUser = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true, name: true },
  });
  if (!dbUser) {
    // Ghost session: Clerk auth is valid but our User row is gone
    // (e.g. the delete-account worker already cascaded). Don't reveal
    // the DB state - tell the client to sign out and treat the
    // account as already deleted.
    return {
      success: false,
      error: "Your session has expired. Please sign in again.",
      requiresSignOut: true,
    };
  }

  const otpResult = await generateDeleteOtp({
    userId: dbUser.id,
    email,
  });
  if (!otpResult.success) {
    return { success: false, error: otpResult.error };
  }
  const { result, otp } = otpResult.data;

  // Send the OTP email (await - if delivery fails, surface the error so the
  // user isn't stuck waiting for a code that's coming).
  //
  // Name resolution (MONEY-445): Clerk is the source of truth for the
  // user's name. dbUser.name often carries the literal "Trader"
  // placeholder seeded by lib/db/user.ts when Clerk hadn't returned a
  // firstName at signup time - treat that as no-name so the greeting
  // doesn't say "Hi Trader," for users whose real name is now live
  // on the Clerk record.
  const clerkFirstName =
    clerkUser?.firstName ||
    clerkUser?.fullName?.trim().split(/\s+/)[0] ||
    undefined;
  const fallbackDbName =
    dbUser.name && dbUser.name !== "Trader" ? dbUser.name : undefined;
  const greetingName = clerkFirstName || fallbackDbName || "there";
  const sendResult = await sendEmail({
    to: email,
    subject: "Confirm your UseMoney account deletion",
    react: React.createElement(DeleteAccountOtpEmail, {
      name: greetingName,
      otp,
      expiresInMinutes: 10,
    }),
    template: "delete-account-otp",
  });
  if (!sendResult.success) {
    return {
      success: false,
      error: "Failed to send OTP email. Please try again.",
    };
  }

  return {
    success: true,
    maskedEmail: result.maskedEmail,
    expiresAt: result.expiresAt.toISOString(),
  };
}

// ── 2. Confirm Delete ──────────────────────────────────────────────

export interface ConfirmDeleteAccountInput {
  otp: string;
  typedConfirmation: string; // must equal "DELETE" exactly
  reason?: string;
}

export async function confirmDeleteAccountAction(
  input: ConfirmDeleteAccountInput
): Promise<ConfirmDeleteAccountActionResult> {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return { success: false, error: "Not signed in" };
  }

  // Anti-fat-finger: must type the literal string "DELETE"
  if (input.typedConfirmation !== "DELETE") {
    return {
      success: false,
      error: "Type DELETE exactly to confirm (case-sensitive)",
    };
  }

  // MONEY-445: action does the MINIMUM and publishes. No snapshot, no
  // audit-row write, no destructive operations. The worker creates the
  // audit row as its first idempotent step and owns the entire
  // pipeline (Clerk delete -> snapshot -> Dodo cancel -> email -> User
  // row delete). Sync budget target: <500ms.
  const dbUser = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true, email: true, name: true },
  });
  if (!dbUser) {
    // Same ghost-session case as requestDeleteOtpAction.
    return {
      success: false,
      error: "Your session has expired. Please sign in again.",
      requiresSignOut: true,
    };
  }

  // Verify OTP - single-use, rate-limited (5 attempts before lockout)
  const verifyResult = await verifyDeleteOtp(dbUser.id, input.otp);
  if (!verifyResult.success) {
    return { success: false, error: verifyResult.error };
  }

  // Capture forensics headers BEFORE we lose the request context.
  const headerStore = await headers();
  const ipAddress =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerStore.get("x-real-ip") ||
    undefined;
  const userAgent = headerStore.get("user-agent") || undefined;

  // Publish the deletion job. If Pub/Sub publish fails we surface that
  // to the client so they can retry - there's no audit row yet, so the
  // worker can't pick this up otherwise.
  try {
    await publishAccountDeletionJob({
      userId: dbUser.id,
      clerkId,
      email: dbUser.email,
      name: dbUser.name,
      deletedBy: "user",
      reason: input.reason,
      ipAddress,
      userAgent,
    });
  } catch (publishError) {
    console.error(
      `[deleteAccount] Pub/Sub publish failed for clerkId=${clerkId}:`,
      publishError
    );
    return {
      success: false,
      error: "Could not queue deletion. Please try again.",
    };
  }

  return { success: true };
}
