/**
 * User service pure-logic helpers.
 *
 * Side-effect-free decision/validation/mapping logic used by
 * `./user.service.ts`. Isolated here (away from the Prisma-importing service)
 * so it can be unit-tested without pulling in the Prisma client at import time,
 * and — critically — so the LIVE user-facing path (profile read, currency
 * preference, settings update, onboarding-state derivation) runs the SAME
 * security-hardened logic the unit test asserts (no shadow).
 *
 * Source of truth consolidated from the inline logic that previously lived in
 * `apps/web/lib/actions/user.ts` (currency allow-list, trial calc) and
 * `apps/web/lib/actions/walkthrough.ts` (onboarding/seen-version derivation).
 *
 * SECURITY (MONEY-620). Three classes of bug this module closes are asserted by
 * `apps/web/__tests__/services/user-logic-unit.test.ts` and, on the LIVE service,
 * `apps/web/__tests__/services/user-poison-live.test.ts`:
 *
 *   1. Currency allow-list — an invalid / garbage `preferredCurrency` must NOT
 *      persist verbatim. {@link normalizeCurrency} maps anything outside the
 *      allow-list back to the default (`"INR"`), so a client can never write
 *      `"'; DROP"` / `"BTC"` / `"inr "` into the column. {@link isValidCurrency}
 *      is the strict gate the *update* path uses to reject (rather than silently
 *      coerce) an explicit bad value.
 *
 *   2. Mass-assignment — a settings PATCH from the client must NOT be able to
 *      set privileged fields (plan / role / credits / isActive / clerkId /
 *      email / id / *AcceptedAt / subscription). {@link sanitizeUserSettingsPatch}
 *      strips every non-whitelisted key (allow-list, not deny-list, so a NEW
 *      privileged column added later is denied by default), and re-validates the
 *      currency inside the patch.
 *
 *   3. Invalid-Date — a corrupt `createdAt` must never throw `RangeError` on
 *      `.toISOString()`. {@link safeIso} / {@link calculateTrialInfo} guard it.
 *
 * This module imports nothing server-only, so the unit tests stay pure and exit
 * cleanly.
 *
 * @see apps/web/__tests__/services/user-logic-unit.test.ts
 * @see apps/web/__tests__/services/user-poison-live.test.ts
 */

// ---------------------------------------------------------------------------
// Currency allow-list (validation + defaulting)
// ---------------------------------------------------------------------------

/**
 * The currencies a user may select. Mirrors the allow-list in
 * `apps/web/lib/actions/user.ts` (`VALID_CURRENCIES`) and the country→currency
 * map in `@usemoney/core` (`COUNTRY_CURRENCY`: IN/US/GB/EU). Kept as a
 * `readonly` tuple so the union type is derived from the single source.
 */
export const SUPPORTED_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** The column default (`User.preferredCurrency @default("INR")`). */
export const DEFAULT_CURRENCY: SupportedCurrency = "INR";

/**
 * Strict membership test against {@link SUPPORTED_CURRENCIES}.
 *
 * NOTE: case- and whitespace-SENSITIVE on purpose — this is the gate the
 * *update* path uses to REJECT an explicit bad value (`"inr"`, `" INR "`,
 * `"BTC"`, an injection string) rather than silently coerce it. `null` /
 * `undefined` / non-string all return `false`.
 */
export function isValidCurrency(value: unknown): value is SupportedCurrency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}

/**
 * Coerce an arbitrary stored / client value to a SAFE currency for READ /
 * defaulting surfaces: a valid code is returned verbatim; ANYTHING else
 * (`null`, `""`, `"BTC"`, `"inr"`, an object, a SQL-ish injection string)
 * collapses to `fallback` (default `"INR"`).
 *
 * This is the guard the read path (`getCurrencyPreference`) funnels the stored
 * column through, so even if a legacy / corrupt row already holds garbage, the
 * UI is handed a valid code and the user's column is self-heals to the default
 * on next write — garbage is never echoed back as if it were a real preference.
 */
export function normalizeCurrency(
  value: unknown,
  fallback: SupportedCurrency = DEFAULT_CURRENCY,
): SupportedCurrency {
  return isValidCurrency(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Default landing page (preferences.defaultPage)
// ---------------------------------------------------------------------------

/**
 * The pages a user may pick as their post-login landing page. Mirrors the
 * allow-list in `apps/web/lib/actions/user.ts` (`VALID_DEFAULT_PAGES`), which is
 * the set `updateDefaultPagePreferenceAction` enforces before writing
 * `User.preferences.defaultPage`. Kept as a `readonly` tuple so the union type
 * derives from the single source.
 */
export const VALID_DEFAULT_PAGES = ["dashboard", "stocksage"] as const;
export type DefaultPage = (typeof VALID_DEFAULT_PAGES)[number];

/**
 * Strict membership test against {@link VALID_DEFAULT_PAGES}. `null` /
 * `undefined` / non-string / any page id outside the set all return `false` —
 * the SAME gate the web action applies (an unlisted page id is rejected, not
 * coerced), so a client can never write an arbitrary string into
 * `preferences.defaultPage`.
 */
export function isValidDefaultPage(value: unknown): value is DefaultPage {
  return (
    typeof value === "string" &&
    (VALID_DEFAULT_PAGES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Settings PATCH sanitisation (mass-assignment guard)
// ---------------------------------------------------------------------------

/**
 * The ONLY user-writable settings keys. An allow-list (not a deny-list) so a
 * future privileged column (e.g. a new `role`) is denied by default rather than
 * silently writable. `preferredCurrency` is included but re-validated below;
 * `name` is a free-text display name; `defaultPage` is the post-login landing
 * page (a `preferences`-JSON key, re-validated against {@link VALID_DEFAULT_PAGES}).
 */
export const WRITABLE_USER_SETTINGS_KEYS = [
  "name",
  "preferredCurrency",
  "defaultPage",
] as const;
export type WritableUserSettingsKey =
  (typeof WRITABLE_USER_SETTINGS_KEYS)[number];

/**
 * The sanitised, persist-safe COLUMN patch — only allow-listed scalar `User`
 * columns, so it is safe to spread straight into `prisma.user.update`'s `data`.
 * `defaultPage` is intentionally NOT here — it is a `preferences`-JSON key (see
 * {@link SanitizedUserPreferencesPatch}), never a column.
 */
export interface SanitizedUserSettingsPatch {
  name?: string;
  preferredCurrency?: SupportedCurrency;
}

/**
 * The sanitised patch for keys that live in the `User.preferences` JSON blob
 * (namespaced, NOT scalar columns). The service must MERGE this into the
 * existing `preferences` (read-merge-write, mirroring the web action) rather
 * than spread it into `data` — spreading a JSON key as a column would be an
 * invalid Prisma call, and overwriting `preferences` wholesale would clobber the
 * sibling namespaces (research / composer / …).
 */
export interface SanitizedUserPreferencesPatch {
  defaultPage?: DefaultPage;
}

/** Outcome of {@link sanitizeUserSettingsPatch}. */
export interface SanitizeUserSettingsResult {
  /** Allow-listed, validated scalar COLUMNS — safe to spread into `data`. */
  patch: SanitizedUserSettingsPatch;
  /**
   * Allow-listed, validated `preferences`-JSON keys — the service MERGES these
   * into `User.preferences` (never a column spread). Empty when the caller sent
   * no preference keys.
   */
  preferences: SanitizedUserPreferencesPatch;
  /**
   * Keys the caller submitted that were stripped (privileged, unknown, or a
   * present-but-INVALID allow-listed value). Surfaced so the service can log an
   * attempted mass-assignment without failing the (otherwise legitimate)
   * request. NEVER reflected to the client.
   */
  rejectedKeys: string[];
}

// Hard maximum so a client can't store a multi-megabyte display name.
const MAX_NAME_LENGTH = 100;

/**
 * Strip a client-supplied settings object down to ONLY the allow-listed,
 * validated fields (mass-assignment guard).
 *
 * Guarantees:
 *   - Privileged / unknown keys (`plan`, `planId`, `role`, `isAdmin`,
 *     `credits*`, `creditsLimit`, `isActive`, `clerkId`, `email`, `id`,
 *     `termsAcceptedAt`, `subscription`, `__proto__`, …) NEVER appear in
 *     `patch` — they're recorded in `rejectedKeys` instead.
 *   - `preferredCurrency` is accepted ONLY when it passes {@link isValidCurrency};
 *     a present-but-invalid currency is rejected (recorded), not coerced, so the
 *     caller decides whether to fail or fall back. (The dedicated currency
 *     endpoint coerces; a bulk settings PATCH should not silently rewrite it.)
 *   - `name` is trimmed; an empty-after-trim or over-long name is rejected.
 *   - `defaultPage` is accepted ONLY when it passes {@link isValidDefaultPage}
 *     (the `{ dashboard, stocksage }` set the web action enforces); it is routed
 *     to `preferences` (a JSON key, NOT a column). A present-but-invalid page id
 *     is rejected (recorded), never coerced.
 *   - A non-object / null / array input yields an empty patch (no throw).
 *
 * Behaviour-preserving: a legitimate `{ name, preferredCurrency }` patch passes
 * through unchanged (empty `preferences`).
 */
export function sanitizeUserSettingsPatch(
  input: unknown,
): SanitizeUserSettingsResult {
  const patch: SanitizedUserSettingsPatch = {};
  const preferences: SanitizedUserPreferencesPatch = {};
  const rejectedKeys: string[] = [];

  // Reject non-plain-object inputs outright (null, array, primitive). An array
  // is `typeof "object"` so it's excluded explicitly.
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { patch, preferences, rejectedKeys };
  }

  const allow = new Set<string>(WRITABLE_USER_SETTINGS_KEYS);

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // Anything not on the allow-list is a rejected (privileged/unknown) key.
    if (!allow.has(key)) {
      rejectedKeys.push(key);
      continue;
    }

    if (key === "name") {
      if (typeof value !== "string") {
        rejectedKeys.push(key);
        continue;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
        rejectedKeys.push(key);
        continue;
      }
      patch.name = trimmed;
    } else if (key === "preferredCurrency") {
      // Strict: an explicit but invalid currency in a bulk PATCH is rejected,
      // not silently coerced (avoids surprising the user with a default write).
      if (!isValidCurrency(value)) {
        rejectedKeys.push(key);
        continue;
      }
      patch.preferredCurrency = value;
    } else if (key === "defaultPage") {
      // Enforce the SAME page-id set the web action allows; an unlisted id is
      // rejected (recorded), not coerced. Routed to `preferences` — it is a
      // `User.preferences.defaultPage` JSON key, never a scalar column, so it
      // must NEVER land in `patch` (which is spread into `prisma.user.update`).
      if (!isValidDefaultPage(value)) {
        rejectedKeys.push(key);
        continue;
      }
      preferences.defaultPage = value;
    }
  }

  return { patch, preferences, rejectedKeys };
}

// ---------------------------------------------------------------------------
// Invalid-Date guard
// ---------------------------------------------------------------------------

/**
 * True when `d` is a usable, finite calendar date (not `null`, not
 * `new Date("garbage")`). Guards every `getTime()` / `.toISOString()` that would
 * otherwise yield `NaN` or throw `RangeError`. Mirrors `dashboard-logic.ts#isValidDate`.
 */
export function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** ISO-8601 string for a valid date, else `null` (never throws). */
export function safeIso(d: Date | null | undefined): string | null {
  return isValidDate(d) ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Profile-shape mapping
// ---------------------------------------------------------------------------

/** The internal user row subset the profile mapper reads. */
export interface UserProfileRow {
  id: string;
  email: string;
  name: string | null;
  preferredCurrency: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The client-facing profile shape (dates as ISO strings, currency normalised). */
export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  preferredCurrency: SupportedCurrency;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Map a stored user row to the client-facing profile shape. The stored
 * `preferredCurrency` is funnelled through {@link normalizeCurrency} (a legacy
 * garbage value never leaks out), and dates degrade to `null` instead of
 * throwing on an Invalid Date.
 */
export function toUserProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    preferredCurrency: normalizeCurrency(row.preferredCurrency),
    createdAt: safeIso(row.createdAt),
    updatedAt: safeIso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Trial info (de-shadow of apps/web/lib/actions/user.ts getAccountTrialInfoAction)
// ---------------------------------------------------------------------------

/** Trial window length: a FREE account gets 30 days of broker sync. */
export const TRIAL_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface TrialInfo {
  /** ISO creation timestamp, or `null` for a corrupt/invalid `createdAt`. */
  createdAt: string | null;
  remainingDays: number;
  isExpired: boolean;
}

/**
 * Compute trial info from the account creation date. Days elapsed are floored
 * (a partial day does not count); `remainingDays` is clamped at 0 and the trial
 * is expired once `daysSinceCreation >= TRIAL_DAYS`.
 *
 * De-shadow: this is the REAL exported logic that `getAccountTrialInfoAction`
 * (and the service `getAccountTrialInfo`) now compute. The previous
 * `__tests__/actions/user.test.ts` re-declared this inline and asserted the copy
 * — a shadow. An Invalid `createdAt` no longer throws on `.toISOString()`; it
 * yields a fully-expired result with a `null` timestamp.
 */
export function calculateTrialInfo(
  createdAt: Date | null | undefined,
  now: Date = new Date(),
  trialEndsAt: Date | null | undefined = null,
): TrialInfo {
  // MONEY-877: the broker trial ends at brokerTrialEndsAt when set (a fixed,
  // resettable expiry), else createdAt + 30d. With trialEndsAt unset this is
  // mathematically identical to the old createdAt-based result, so legacy/new rows
  // are unchanged; a goodwill reset just stamps a future end date.
  const effectiveEnd = isValidDate(trialEndsAt)
    ? trialEndsAt
    : isValidDate(createdAt)
      ? new Date(createdAt.getTime() + TRIAL_DAYS * MS_PER_DAY)
      : null;

  if (!isValidDate(effectiveEnd) || !isValidDate(now)) {
    // Corrupt dates → treat as expired (fail closed: a garbage date should not
    // grant an unbounded trial), with an honest `null` timestamp.
    return { createdAt: safeIso(createdAt), remainingDays: 0, isExpired: true };
  }

  const msLeft = effectiveEnd.getTime() - now.getTime();
  const remainingDays = Math.max(0, Math.ceil(msLeft / MS_PER_DAY));
  const isExpired = msLeft <= 0;

  return {
    createdAt: safeIso(createdAt),
    remainingDays,
    isExpired,
  };
}

// ---------------------------------------------------------------------------
// Onboarding-state derivation
// ---------------------------------------------------------------------------

export interface OnboardingStateInput {
  /** `User.walkthroughVersionsSeen` (may contain dupes / garbage in theory). */
  seenVersions: readonly unknown[] | null | undefined;
  /** `User.termsAcceptedAt`. */
  termsAcceptedAt: Date | null | undefined;
  /** The current tour version the app wants the user to have seen. */
  currentVersion: string;
}

export interface OnboardingState {
  /** De-duplicated, string-only list of tour versions the user has completed. */
  seenVersions: string[];
  /** Has the user accepted the latest T&C / risk disclosure? */
  hasAcceptedTerms: boolean;
  /** Has the user seen the CURRENT tour version? */
  hasSeenCurrentWalkthrough: boolean;
  /**
   * True when the user is fully onboarded: terms accepted AND current
   * walkthrough seen. Drives whether the app pops the onboarding modal.
   */
  isOnboarded: boolean;
}

/**
 * Derive the onboarding state from the stored flags. Defensive against a
 * non-array / mixed-type `seenVersions` (only string entries are kept, and they
 * are de-duplicated). `hasAcceptedTerms` is a strict non-null check on
 * `termsAcceptedAt` (an Invalid Date stored there still counts as "a decision
 * was recorded", matching the live `termsAcceptedAt != null` gate).
 */
export function deriveOnboardingState(
  input: OnboardingStateInput,
): OnboardingState {
  const seen = Array.isArray(input.seenVersions)
    ? Array.from(
        new Set(
          input.seenVersions.filter((v): v is string => typeof v === "string"),
        ),
      )
    : [];

  const hasAcceptedTerms = input.termsAcceptedAt != null;
  const hasSeenCurrentWalkthrough = seen.includes(input.currentVersion);

  return {
    seenVersions: seen,
    hasAcceptedTerms,
    hasSeenCurrentWalkthrough,
    isOnboarded: hasAcceptedTerms && hasSeenCurrentWalkthrough,
  };
}

// ---------------------------------------------------------------------------
// Walkthrough tour versions + snooze prefs (MONEY-1062 P4e — apps/api
// /v1/me/walkthrough)
//
// MIRROR of apps/web/lib/walkthrough/tours/index.ts. That module is the source
// of truth but is web-app-local (imports web tour step definitions) and cannot
// be imported by @usemoney/services or apps/api. Only the version-id ALLOW-LIST
// (a small, stable set) is duplicated here — the tour STEP content stays
// web-only. Keep this list in lockstep with the web module when a new tour
// version ships. `readSnoozedUntil` / `mergePreferencesWithSnooze` are ported
// verbatim from apps/web/lib/actions/walkthrough.ts.
// ---------------------------------------------------------------------------

/** The tour version the app currently wants users to have seen. */
export const CURRENT_WALKTHROUGH_VERSION = "v1-core";

/** Allow-listed tour version ids (mirror of the web tours registry). */
export const KNOWN_WALKTHROUGH_VERSIONS = ["v1-core"] as const;
export type WalkthroughVersion = (typeof KNOWN_WALKTHROUGH_VERSIONS)[number];

/** Narrowing guard for a tour version id (rejects unknown/garbage). */
export function isKnownWalkthroughVersion(v: unknown): v is WalkthroughVersion {
  return (
    typeof v === "string" &&
    (KNOWN_WALKTHROUGH_VERSIONS as readonly string[]).includes(v)
  );
}

interface WalkthroughPreferencesShape {
  walkthrough?: { snoozedUntil?: Record<string, string> };
  [key: string]: unknown;
}

/**
 * Read the `preferences.walkthrough.snoozedUntil` map defensively (only
 * string→string entries survive). Ported from apps/web walkthrough.ts.
 */
export function readSnoozedUntil(prefs: unknown): Record<string, string> {
  if (!prefs || typeof prefs !== "object") return {};
  const w = (prefs as WalkthroughPreferencesShape).walkthrough;
  if (!w || typeof w !== "object") return {};
  const map = w.snoozedUntil;
  if (!map || typeof map !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Merge a `snoozedUntil` map back into the `preferences` JSON blob without
 * clobbering sibling namespaces (research/composer/defaultPage). Ported from
 * apps/web walkthrough.ts.
 */
export function mergePreferencesWithSnooze(
  existing: unknown,
  snoozedUntil: Record<string, string>,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const walkthrough =
    (base.walkthrough as { snoozedUntil?: Record<string, string> }) ?? {};
  base.walkthrough = { ...walkthrough, snoozedUntil };
  return base;
}
