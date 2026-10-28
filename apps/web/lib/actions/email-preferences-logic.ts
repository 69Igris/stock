/**
 * Email Preferences — pure validation logic.
 *
 * Extracted from `updateEmailPreferencesAction`
 * (apps/web/lib/actions/email-preferences.ts) so the "every key must be a
 * boolean" gate can be unit-tested without the `"use server"` runtime
 * (Clerk + Prisma + Resend).
 *
 * The action imports `validateEmailPreferences` and uses it directly — no
 * dead/duplicate copy. The full key set (including `usageAnalytics`) lives in
 * the single source of truth `@usemoney/email` `DEFAULT_EMAIL_PREFERENCES`,
 * so this validator stays in lockstep with the `EmailPreferences` shape.
 */

import {
  DEFAULT_EMAIL_PREFERENCES,
  type EmailPreferences,
} from "@usemoney/email";

/** The full set of preference keys (derived from the canonical defaults). */
export const EMAIL_PREFERENCE_KEYS = Object.keys(
  DEFAULT_EMAIL_PREFERENCES
) as Array<keyof EmailPreferences>;

export interface EmailPreferenceValidation {
  valid: boolean;
  /** First offending key's error message (undefined when valid). */
  error?: string;
}

/**
 * Validate that an inbound preferences payload has a boolean for EVERY known
 * key. Returns the first failure so the caller can surface `Invalid value
 * for <key>`. A missing key or a non-boolean value both fail.
 */
export function validateEmailPreferences(
  preferences: Record<string, unknown>
): EmailPreferenceValidation {
  for (const key of EMAIL_PREFERENCE_KEYS) {
    if (typeof preferences[key] !== "boolean") {
      return { valid: false, error: `Invalid value for ${key}` };
    }
  }
  return { valid: true };
}
