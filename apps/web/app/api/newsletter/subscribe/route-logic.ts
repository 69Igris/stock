/**
 * Pure logic for the newsletter subscribe route.
 *
 * Extracted from `./route.ts` so the wire contract — input validation, the
 * already-subscribed status → message mapping, the verify-URL shape, the
 * default app URL, and the x-forwarded-for IP parse — is tested against the
 * REAL exported symbols the route calls instead of inline copies. Kept free of
 * Prisma / email-sender imports so it stays a cheap pure unit.
 *
 * @see apps/web/__tests__/api/newsletter.test.ts
 */

import { z } from "zod";

/** Subscriber lifecycle states (mirrors Prisma `SubscriberStatus`). */
export type SubscriberStatus = "PENDING" | "ACTIVE" | "UNSUBSCRIBED";

/** Request body schema for POST /api/newsletter/subscribe. */
export const SubscribeSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  name: z.string().optional(),
});

export type SubscribeInput = z.infer<typeof SubscribeSchema>;

/** Lowercase normalization applied to every email before lookup/storage. */
export function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

/**
 * Short-circuit response for an already-known subscriber. ACTIVE and PENDING
 * subscribers are told no new email is sent; UNSUBSCRIBED falls through to the
 * re-subscribe path (a fresh verification email), so the route only consults
 * this for the two terminal "don't re-send" cases.
 *
 * Returns `null` for UNSUBSCRIBED to signal the caller to run the re-subscribe
 * flow.
 */
export function handleExistingSubscriber(
  status: SubscriberStatus
): { message: string; status: 200 } | null {
  if (status === "ACTIVE") {
    return { message: "You're already subscribed!", status: 200 };
  }
  if (status === "PENDING") {
    return {
      message:
        "A verification email was already sent. Please check your inbox.",
      status: 200,
    };
  }
  // UNSUBSCRIBED → caller re-subscribes.
  return null;
}

/** Build the email-verification link for a freshly issued token. */
export function buildVerifyUrl(appUrl: string, token: string): string {
  return `${appUrl}/api/newsletter/verify?token=${token}`;
}

/** App origin used in the verify link; falls back to the prod host. */
export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";
}

/** First hop in x-forwarded-for, or "anonymous" for rate-limit keying. */
export function parseIpFromHeader(xForwardedFor: string | null): string {
  return xForwardedFor?.split(",")[0] || "anonymous";
}

/** Success body (also used for the re-subscribe path). */
export function newsletterSuccessMessage(): string {
  return "Please check your email to verify your subscription.";
}
