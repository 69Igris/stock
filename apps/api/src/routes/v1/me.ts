/**
 * Me Routes (MONEY-402 mobile-parity, MONEY-1062 P1a)
 *
 * The authenticated caller's own profile surface. GET composes the user profile
 * + subscription tier (best-effort). PATCH /persona sets the StockSage chat
 * persona (a composer preference); PATCH /preferences updates the editable
 * profile settings (name, preferredCurrency) — mass-assignment-guarded in the
 * service (privileged keys like plan/role/credits are stripped).
 *
 * MONEY-1062 P1a adds the mobile-parity account surface:
 *   - POST /delete-otp + DELETE /  — two-step account deletion (APP-STORE
 *     BLOCKER). Mirrors apps/web/lib/actions/account.ts: the OTP EMAIL is a
 *     route-layer concern (account-deletion.service deliberately does not
 *     import @usemoney/email — cyclic-dep posture), so this route wires
 *     @usemoney/email the same way the Dodo webhook builds its notifier. The
 *     confirm step mirrors MONEY-445: verify OTP → publish the Pub/Sub job and
 *     return immediately — the WORKER owns the audit row + every destructive
 *     step (no queueAccountDeletion here, exactly like the web action).
 *   - GET/POST /terms + GET /trial — terms acceptance + broker-sync trial
 *     window (mirrors apps/web/lib/actions/user.ts).
 *   - GET/PUT /research-preferences + GET /composer-preferences — preference
 *     surface (mirrors apps/web/lib/actions/preferences.ts).
 *
 * Everything is scoped to the resolved Mongo id from authMiddleware.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
} from "../../lib/response";
import {
  getUserProfile,
  getSubscription,
  updateUserSettings,
  setComposerPreferences,
  getComposerPreferences,
  generateDeleteOtp,
  verifyDeleteOtp,
  getAccountTrialInfo,
  hasAcceptedTerms,
  acceptTerms,
  VALID_DEFAULT_PAGES,
  // MONEY-1062 P4e — email prefs/segments, briefing, walkthrough (DB half).
  getRawEmailPreferences,
  writeEmailPreferences,
  getEmailSegmentState,
  setNewsletterSubscription,
  getLatestBriefing,
  markBriefingViewed,
  getWalkthroughState,
  markWalkthroughSeen,
  resetWalkthrough,
  snoozeWalkthrough,
  // GST profile read/update reuses the existing gst service namespace.
  gst,
} from "@usemoney/services";
// Research preferences are namespaced (not flat-exported from the barrel) —
// subpath import per the "always import subpaths" rule. The Input type is
// type-only (erased at runtime), so the contract-test module seam only needs
// to stub the two functions.
import {
  getResearchPreferences,
  setResearchPreferences,
  type ResearchPreferencesInput,
} from "@usemoney/services/preferences";
import {
  sendEmail,
  addContactToSegment,
  removeContactFromSegment,
  addToAudience,
  removeFromAudience,
  getEffectivePreferences,
  DEFAULT_EMAIL_PREFERENCES,
  EMAIL_SEGMENTS,
  type EmailPreferences,
} from "@usemoney/email";
import { DeleteAccountOtpEmail } from "@usemoney/email/templates";
import { publishAccountDeletionJob } from "@usemoney/pubsub/publish";

const meRoutes = new Hono<AppContext>();

const PersonaSchema = z.object({
  persona: z.enum(["marks", "damodaran", "rj"]).nullable(),
});
const PreferencesSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  preferredCurrency: z.string().min(1).max(8).optional(),
  // MONEY-1062 (D8): post-login landing page — persisted into the
  // User.preferences JSON blob (read-merge-write in updateUserSettings), gated
  // by the same VALID_DEFAULT_PAGES set the web action enforces.
  defaultPage: z.enum(VALID_DEFAULT_PAGES).optional(),
});
const DeleteAccountSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
  reason: z.string().max(500).optional(),
});
const AcceptTermsSchema = z.object({
  marketing: z.boolean().optional(),
  analytics: z.boolean().optional(),
});

// Minimal shape mirror of the web PUT payload (Partial<ResearchPreferencesInput>).
// Styles are a small stable enum so they're mirrored verbatim; skill/preset ids
// are validated as bounded strings here and AUTHORITATIVELY re-validated by
// `researchPreferencesSchema.parse` inside setResearchPreferences — an unknown
// id throws a ZodError which the handler maps back to a 400 (never a 500).
const ResearchStyleSchema = z.enum([
  "auto",
  "quick",
  "deep",
  "comprehensive",
  "advanced",
  "custom",
]);
const SkillIdListSchema = z.array(z.string().min(1).max(64)).max(64);
const ResearchPrefsPutSchema = z.object({
  researchStyle: ResearchStyleSchema.optional(),
  customSkills: SkillIdListSchema.optional(),
  researchFocus: z.string().max(280).optional(),
  preset: z.string().min(1).max(64).optional(),
  extraSkills: SkillIdListSchema.optional(),
  removedSkills: SkillIdListSchema.optional(),
  customPresets: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(80),
        skills: SkillIdListSchema,
        model: z.string().max(64).optional(),
        focus: z.string().max(280).optional(),
        createdAt: z.string().optional(),
      }),
    )
    .max(20)
    .optional(),
  horizon: z.string().min(1).max(16).optional(),
  benchmark: z.string().min(1).max(40).optional(),
  assumptions: z.record(z.unknown()).optional(),
  reportLength: z.string().min(1).max(16).optional(),
  varConfig: z.record(z.unknown()).optional(),
});

// MONEY-1062 P4e schemas.
const EmailSegmentPostSchema = z.object({
  segment: z.enum(["newsletter", "marketing"]),
  subscribed: z.boolean(),
});
const BriefingViewedSchema = z.object({
  briefingId: z.string().min(1).max(64),
});
// Walkthrough writes are a single POST discriminated by `action` — the three
// web actions (mark-seen / reset / snooze) collapse to one REST endpoint. The
// tour version + snooze timestamp are AUTHORITATIVELY re-validated in the
// service (isKnownWalkthroughVersion + Date.parse) → a bad value maps to 400.
const WalkthroughPostSchema = z.object({
  action: z.enum(["seen", "reset", "snooze"]),
  version: z.string().min(1).max(64),
  until: z.string().max(64).optional(),
});
// GST profile PUT — shape only; the gst service Zod (userGstProfileSchema) is
// the authoritative gate (a bad GSTIN/PAN/state throws → mapped to 400).
const GstProfilePutSchema = z.object({
  legalName: z.string().min(1).max(120),
  address: z.string().min(1).max(500),
  stateCode: z.string().min(1).max(8),
  gstin: z.string().max(20).optional(),
  pan: z.string().max(12).optional(),
});

/**
 * Mirror of the web `validateEmailPreferences` gate (email-preferences-logic.ts):
 * every key in the canonical `DEFAULT_EMAIL_PREFERENCES` set must be present AND
 * a boolean. Derived from the email package's defaults so it stays in lockstep
 * with the `EmailPreferences` shape (no hardcoded key list to drift).
 */
function validateEmailPreferencesPayload(body: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Invalid preferences payload" };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_EMAIL_PREFERENCES)) {
    if (typeof record[key] !== "boolean") {
      return { valid: false, error: `Invalid value for ${key}` };
    }
  }
  return { valid: true };
}

/**
 * GET /v1/me
 * Profile (id, email, name, preferred currency) + subscription plan/status.
 * The subscription read is best-effort — a failure doesn't fail the profile.
 */
meRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const clerkUserId = c.get("clerkUserId");

  const profile = await getUserProfile(userId);
  if (!profile.success) {
    // A DB error (code "INTERNAL") is a 500; a genuinely missing user → 404.
    if (profile.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, profile.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, profile.error), 404);
  }

  const subscription = await getSubscription(userId);

  return c.json(
    success({
      ...profile.data,
      clerkUserId,
      plan: subscription.success ? subscription.data.planId : null,
      subscriptionStatus: subscription.success
        ? subscription.data.status
        : null,
    }),
  );
});

/**
 * POST /v1/me/delete-otp
 * Step 1 of account deletion: generate a 6-digit OTP (Redis-backed, 10 min TTL,
 * 3/hour rate limit) and email it to the caller. Mirrors
 * requestDeleteOtpAction: the OTP email is sent HERE (route layer) because the
 * service intentionally never imports @usemoney/email. Greeting-name resolution
 * mirrors the web's DB fallback — the literal "Trader" placeholder seeded at
 * signup is treated as no-name (apps/api has no Clerk profile fetch).
 */
meRoutes.post("/delete-otp", async (c) => {
  const userId = c.get("userId");

  const profile = await getUserProfile(userId);
  if (!profile.success) {
    if (profile.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, profile.error), 500);
    }
    // Ghost session (Clerk token valid, DB row gone — deletion worker already
    // cascaded). Treat as already deleted; the client should sign out.
    return c.json(error(ErrorCodes.NOT_FOUND, profile.error), 404);
  }

  const otpResult = await generateDeleteOtp({
    userId,
    email: profile.data.email,
  });
  if (!otpResult.success) {
    // generateDeleteOtp carries no failure `code`; its only non-exception
    // failure is the 3-per-hour rate limit ("Too many OTP requests…") → 429.
    // Anything else (Redis/crypto failure) is a retryable 500.
    if (/too many/i.test(otpResult.error)) {
      return c.json(
        error(ErrorCodes.RATE_LIMIT_EXCEEDED, otpResult.error),
        429,
      );
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, otpResult.error), 500);
  }
  const { result, otp } = otpResult.data;

  const greetingName =
    profile.data.name && profile.data.name !== "Trader"
      ? profile.data.name
      : "there";

  // Await the send (mirrors the web action) — if delivery fails, surface the
  // error so the user isn't left waiting for a code that's never coming.
  const sendResult = await sendEmail({
    to: profile.data.email,
    subject: "Confirm your UseMoney account deletion",
    react: DeleteAccountOtpEmail({
      name: greetingName,
      otp,
      expiresInMinutes: 10,
    }),
    template: "delete-account-otp",
  });
  if (!sendResult.success) {
    return c.json(
      error(
        ErrorCodes.INTERNAL_ERROR,
        "Failed to send OTP email. Please try again.",
      ),
      500,
    );
  }

  return c.json(
    success({
      maskedEmail: result.maskedEmail,
      expiresAt: result.expiresAt.toISOString(),
    }),
  );
});

/**
 * DELETE /v1/me
 * Step 2 of account deletion: verify the OTP, then publish the deletion job.
 * Mirrors confirmDeleteAccountAction (MONEY-445): the route does the MINIMUM —
 * no snapshot, no audit-row write, no destructive operation. The worker owns
 * the entire pipeline (audit row → Clerk delete → snapshot → Dodo cancel →
 * email → User row delete). The web dialog's typed-"DELETE" anti-fat-finger
 * check is a web-UX concern — the mobile client owns its own confirm UI, so
 * the REST contract is `{ otp, reason? }`.
 */
meRoutes.delete("/", async (c) => {
  const userId = c.get("userId");
  const clerkUserId = c.get("clerkUserId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(DeleteAccountSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid delete payload",
        parsed.issues,
      ),
      400,
    );
  }

  const profile = await getUserProfile(userId);
  if (!profile.success) {
    if (profile.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, profile.error), 500);
    }
    // Ghost session — same signal as /delete-otp: account is already gone.
    return c.json(error(ErrorCodes.NOT_FOUND, profile.error), 404);
  }

  // Single-use, rate-limited verify (5 attempts before lockout). Every verify
  // failure (wrong code / expired / locked out) is client-state → 400, exactly
  // as the web action surfaces it to the dialog.
  const verifyResult = await verifyDeleteOtp(userId, parsed.data.otp);
  if (!verifyResult.success) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, verifyResult.error), 400);
  }

  // Forensics headers (mirrors the web action's headers() capture).
  const ipAddress =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;
  const userAgent = c.req.header("user-agent") || undefined;

  // Publish the deletion job. If publish fails we surface it so the client can
  // retry — there's no audit row yet, so the worker can't pick this up
  // otherwise (mirrors the web action).
  try {
    await publishAccountDeletionJob({
      userId,
      clerkId: clerkUserId ?? null,
      email: profile.data.email,
      name: profile.data.name,
      deletedBy: "user",
      reason: parsed.data.reason,
      ipAddress,
      userAgent,
    });
  } catch (publishError) {
    console.error(
      `[deleteAccount] Pub/Sub publish failed for userId=${userId}:`,
      publishError,
    );
    return c.json(
      error(
        ErrorCodes.INTERNAL_ERROR,
        "Could not queue deletion. Please try again.",
      ),
      500,
    );
  }

  return c.json(success({ message: "Account deletion queued" }));
});

/**
 * GET /v1/me/terms
 * Whether the caller has accepted the Terms of Service. The service mirrors
 * the web action's semantics (mid-deletion counts as accepted; read errors
 * fail OPEN so the client never wrongly blocks the user).
 */
meRoutes.get("/terms", async (c) => {
  const userId = c.get("userId");

  const result = await hasAcceptedTerms(userId);
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing user → 404. (Today the
    // service fails open on read errors, so only the 404 branch is reachable.)
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/me/terms
 * Record terms acceptance (+ optional marketing/analytics opt-ins). Mirrors
 * acceptTermsAction: the DB write lives in the service; the Resend
 * marketing-segment sync stays a fire-and-forget route-layer side effect
 * (this is where @usemoney/email is wired, same as the web action layer).
 */
meRoutes.post("/terms", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(AcceptTermsSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid terms payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await acceptTerms(userId, parsed.data);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  // Fire-and-forget segment sync (mirrors the web action — a Resend failure
  // never fails the acceptance; the weekly contact-sync worker reconciles).
  const nameParts = (result.data.name || "").split(" ");
  if (result.data.marketing) {
    addContactToSegment("marketing", {
      email: result.data.email,
      firstName: nameParts[0] || undefined,
      lastName: nameParts.slice(1).join(" ") || undefined,
    }).catch((err) => {
      console.error("[acceptTerms] Failed to add to marketing segment:", err);
    });
  } else {
    removeContactFromSegment("marketing", result.data.email).catch((err) => {
      console.error(
        "[acceptTerms] Failed to remove from marketing segment:",
        err,
      );
    });
  }

  return c.json(success({ accepted: true }));
});

/**
 * GET /v1/me/trial
 * FREE-plan broker-sync trial window (remaining days + active flag). Wires the
 * shared getAccountTrialInfo service (cached 5 min; Invalid-Date-guarded trial
 * math; MONEY-877 resettable brokerTrialEndsAt honoured).
 */
meRoutes.get("/trial", async (c) => {
  const userId = c.get("userId");

  const result = await getAccountTrialInfo(userId);
  if (!result.success) {
    // getAccountTrialInfo sets no failure `code`: its only non-exception
    // failure is the missing-user read → 404; anything else is a DB/cache
    // failure → 500.
    if (result.error === "User not found") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/me/research-preferences
 * The caller's research preferences (style, skills, focus, preset, run
 * params). Returns the defaults when never saved — clients don't branch on
 * null. Mirrors getMyResearchPreferencesAction.
 */
meRoutes.get("/research-preferences", async (c) => {
  const userId = c.get("userId");

  try {
    const prefs = await getResearchPreferences(userId);
    return c.json(success(prefs));
  } catch (err) {
    console.error("Research preferences read error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load research preferences"),
      500,
    );
  }
});

/**
 * PUT /v1/me/research-preferences
 * Partial update — unspecified fields are preserved by the service merge
 * (mirrors setMyResearchPreferencesAction). Body is shape-validated here and
 * authoritatively re-validated (skill/preset enums) by the service schema; a
 * service-side ZodError maps back to 400, never a 500.
 */
meRoutes.put("/research-preferences", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(ResearchPrefsPutSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid research preferences payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    // The service's schema.parse is the authoritative enum gate; the cast
    // narrows the shape-validated payload to its input type.
    const next = await setResearchPreferences(
      userId,
      parsed.data as unknown as Partial<ResearchPreferencesInput>,
    );
    return c.json(success(next));
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid research preferences"),
        400,
      );
    }
    console.error("Research preferences write error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to save research preferences"),
      500,
    );
  }
});

/**
 * GET /v1/me/composer-preferences
 * All composer preference namespaces (connectors, sources, tools, pinned +
 * recent instruments, model, thinking) in one read — each namespace falls back
 * to its default when unset/corrupt. Mirrors getMyComposerPreferencesAction.
 */
meRoutes.get("/composer-preferences", async (c) => {
  const userId = c.get("userId");

  try {
    const prefs = await getComposerPreferences(userId);
    return c.json(success(prefs));
  } catch (err) {
    console.error("Composer preferences read error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load composer preferences"),
      500,
    );
  }
});

/**
 * PATCH /v1/me/persona
 * Set the StockSage chat persona (marks | damodaran | rj | null).
 */
meRoutes.patch("/persona", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(PersonaSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid persona payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    const prefs = await setComposerPreferences(userId, {
      tools: { persona: parsed.data.persona },
    });
    return c.json(success({ persona: prefs.tools.persona }));
  } catch {
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to update persona"),
      500,
    );
  }
});

/**
 * PATCH /v1/me/preferences
 * Update editable profile settings (name, preferredCurrency, defaultPage).
 * Privileged keys are stripped by the service (mass-assignment guard).
 *
 * D8 defaultPage READ GAP (C1#6): updateUserSettings persists `defaultPage`
 * into the `User.preferences` JSON but returns the UserProfile shape, which
 * does NOT include it — and no @usemoney/services read exposes the raw
 * preferences blob (getUserProfile/getComposerPreferences/getWalkthroughState
 * each return their own namespaces only). Until a service read lands
 * (services-owner gap, reported), this route echoes the just-validated,
 * just-persisted value into the PATCH response so the client can confirm the
 * write; GET /v1/me still cannot return it.
 */
meRoutes.patch("/preferences", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(PreferencesSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid preferences payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await updateUserSettings(userId, parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  // Echo `defaultPage` only when this PATCH set it (input echo — see the D8
  // read-gap note above). An absent key stays absent: we don't know the
  // stored value without a service read.
  return c.json(
    success(
      parsed.data.defaultPage !== undefined
        ? { ...result.data, defaultPage: parsed.data.defaultPage }
        : result.data,
    ),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// MONEY-1062 P4e — email prefs/segments, briefing, walkthrough, GST profile
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/me/email-preferences
 * The caller's effective email preferences. The service returns the RAW JSON;
 * the effective-defaults merge is route-side (@usemoney/email). Mirrors
 * getEmailPreferencesAction.
 */
meRoutes.get("/email-preferences", async (c) => {
  const userId = c.get("userId");

  const result = await getRawEmailPreferences(userId);
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(getEffectivePreferences(result.data.emailPreferences)));
});

/**
 * PATCH /v1/me/email-preferences
 * Update the caller's email preferences (every key must be a boolean). The DB
 * write is the service; the marketing Resend-segment sync stays a route-side
 * fire-and-forget side effect (mirrors updateEmailPreferencesAction).
 */
meRoutes.patch("/email-preferences", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const validation = validateEmailPreferencesPayload(body.data);
  if (!validation.valid) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        validation.error ?? "Invalid email preferences",
      ),
      400,
    );
  }
  const prefs = body.data as EmailPreferences;

  const result = await writeEmailPreferences(userId, prefs);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  // Fire-and-forget marketing-segment sync — only when the flag flipped (mirrors
  // the web action; a Resend failure never fails the update).
  if (result.data.email) {
    const oldPrefs = getEffectivePreferences(result.data.previous);
    if (oldPrefs.marketingEmails !== prefs.marketingEmails) {
      const nameParts = (result.data.name || "").split(" ");
      if (prefs.marketingEmails) {
        addContactToSegment("marketing", {
          email: result.data.email,
          firstName: nameParts[0] || undefined,
          lastName: nameParts.slice(1).join(" ") || undefined,
        }).catch((err) => {
          console.error("[emailPrefs] add to marketing segment failed:", err);
        });
      } else {
        removeContactFromSegment("marketing", result.data.email).catch(
          (err) => {
            console.error(
              "[emailPrefs] remove from marketing segment failed:",
              err,
            );
          },
        );
      }
    }
  }

  return c.json(success(getEffectivePreferences(result.data.updated)));
});

/**
 * GET /v1/me/email-segments
 * The caller's audience-segment subscription state (newsletter + marketing).
 * Newsletter = NewsletterSubscriber ACTIVE (service); marketing is derived
 * route-side from the raw prefs. Mirrors getEmailSegmentSubscriptionsAction.
 */
meRoutes.get("/email-segments", async (c) => {
  const userId = c.get("userId");

  const result = await getEmailSegmentState(userId);
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  const marketing = getEffectivePreferences(
    result.data.emailPreferences,
  ).marketingEmails;
  return c.json(
    success({ newsletter: result.data.newsletterActive, marketing }),
  );
});

/**
 * POST /v1/me/email-segments
 * Subscribe/unsubscribe to an audience segment: guard the segment's audience
 * config, sync the Resend audience (awaited, route-side), then persist the DB
 * state (NewsletterSubscriber upsert, or the marketing prefs merge).
 *
 * DELIBERATE DIVERGENCE FROM WEB (C3#5): addToAudience/removeFromAudience
 * NEVER throw — they return `{ ok: boolean }` — and the web action ignores
 * that flag, silently letting the DB flag and the Resend audience diverge.
 * Here a failed sync FAILS the toggle (500, retry-able) BEFORE any DB write,
 * so the two stores stay consistent. Compliance direction matters on
 * UNSUBSCRIBE: a user must never believe they opted out while still sitting
 * in the Resend audience.
 */
meRoutes.post("/email-segments", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(EmailSegmentPostSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid segment payload",
        parsed.issues,
      ),
      400,
    );
  }
  const { segment, subscribed } = parsed.data;

  // Guard: the segment's audience must be provisioned (else the client shows the
  // "Not yet active" disabled state). Same signal string as the web action.
  const segmentEntry = EMAIL_SEGMENTS.find((s) => s.id === segment);
  if (!segmentEntry?.audienceId) {
    return c.json(error(ErrorCodes.CONFLICT, `${segment}-not-configured`), 409);
  }

  // Contact (email + name) for the audience sync — 404 for a missing user.
  const profile = await getUserProfile(userId);
  if (!profile.success) {
    if (profile.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, profile.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, profile.error), 404);
  }
  const email = profile.data.email;
  const nameParts = (profile.data.name ?? "").split(" ");
  const firstName = nameParts[0] || undefined;
  const lastName = nameParts.slice(1).join(" ") || undefined;

  // Resend audience sync — awaited; a failure fails the toggle BEFORE any DB
  // write (see the route doc). These helpers never throw — failure is the
  // `{ ok: false }` return — so the try/catch is belt-and-braces only.
  try {
    const sync = subscribed
      ? await addToAudience(segment, { email, firstName, lastName })
      : await removeFromAudience(segment, { email });
    if (!sync.ok) {
      console.error("[emailSegments] audience sync failed:", sync.error);
      return c.json(
        error(
          ErrorCodes.INTERNAL_ERROR,
          "Failed to update email subscription. Please try again.",
        ),
        500,
      );
    }
  } catch (err) {
    console.error("[emailSegments] audience sync threw:", err);
    return c.json(
      error(
        ErrorCodes.INTERNAL_ERROR,
        "Failed to update email subscription. Please try again.",
      ),
      500,
    );
  }

  // Persist the DB state (the branch mirrors the web action).
  if (segment === "newsletter") {
    const persisted = await setNewsletterSubscription(userId, subscribed);
    if (!persisted.success) {
      if (persisted.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, persisted.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, persisted.error), 500);
    }
  } else {
    // marketing: merge marketingEmails into the effective prefs, then persist.
    const raw = await getRawEmailPreferences(userId);
    if (!raw.success) {
      if (raw.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, raw.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, raw.error), 500);
    }
    const merged: EmailPreferences = {
      ...getEffectivePreferences(raw.data.emailPreferences),
      marketingEmails: subscribed,
    };
    const written = await writeEmailPreferences(userId, merged);
    if (!written.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, written.error), 500);
    }
  }

  return c.json(success({ segment, subscribed }));
});

/**
 * GET /v1/me/briefing
 * The latest unread login briefing for today (or null). Mirrors
 * getLatestBriefingAction.
 */
meRoutes.get("/briefing", async (c) => {
  const userId = c.get("userId");

  const result = await getLatestBriefing(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/me/briefing/viewed
 * Mark a briefing as viewed (dismissed). IDOR-scoped in the service (non-owned
 * id → 404). Mirrors markBriefingViewedAction. Body: { briefingId }.
 */
meRoutes.post("/briefing/viewed", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(BriefingViewedSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid briefing payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await markBriefingViewed(userId, parsed.data.briefingId);
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success({ viewed: true }));
});

/**
 * GET /v1/me/walkthrough
 * The caller's walkthrough state (seen versions, snooze map, current version).
 * Mirrors getWalkthroughStateAction.
 */
meRoutes.get("/walkthrough", async (c) => {
  const userId = c.get("userId");

  const result = await getWalkthroughState(userId);
  if (!result.success) {
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/me/walkthrough
 * A single write endpoint discriminated by `action` (seen | reset | snooze) —
 * the three web actions (markWalkthroughSeen / reset / snooze) collapsed. Body:
 * { action, version, until? } (until required for snooze). Unknown version /
 * bad timestamp → 400 (validated authoritatively in the service).
 */
meRoutes.post("/walkthrough", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(WalkthroughPostSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid walkthrough payload",
        parsed.issues,
      ),
      400,
    );
  }
  const { action, version, until } = parsed.data;

  let result;
  if (action === "seen") {
    result = await markWalkthroughSeen(userId, version);
  } else if (action === "reset") {
    result = await resetWalkthrough(userId, version);
  } else {
    if (!until) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "until is required for snooze"),
        400,
      );
    }
    result = await snoozeWalkthrough(userId, version, until);
  }

  if (!result.success) {
    if (result.code === "INVALID_INPUT") {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }
    if (result.code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/me/gst-profile
 * The caller's saved GST profile (or null). Reuses the gst service. Mirrors
 * getMyGstProfileAction.
 */
meRoutes.get("/gst-profile", async (c) => {
  const userId = c.get("userId");

  try {
    const profile = await gst.getUserGstProfile(userId);
    return c.json(success(profile));
  } catch (err) {
    console.error("Get GST profile error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load GST profile"),
      500,
    );
  }
});

/**
 * PUT /v1/me/gst-profile
 * Save/update the caller's GST profile. The gst service Zod is the authoritative
 * gate — a bad GSTIN/PAN/state throws a ZodError mapped to 400 (never a 500).
 * Mirrors setMyGstProfileAction.
 */
meRoutes.put("/gst-profile", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(GstProfilePutSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid GST profile payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    const profile = await gst.setUserGstProfile(userId, parsed.data);
    return c.json(success(profile));
  } catch (err) {
    // The gst service Zod (GSTIN/PAN/state) throws a ZodError → 400 with the
    // field-specific message (mirrors the web action surfacing error.message).
    if (err instanceof Error && err.name === "ZodError") {
      const message = parseZodMessage(err) ?? "Invalid GST profile";
      return c.json(error(ErrorCodes.VALIDATION_ERROR, message), 400);
    }
    console.error("Set GST profile error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to save GST profile"),
      500,
    );
  }
});

/**
 * Best-effort extraction of the first ZodError issue message (the gst service
 * throws a raw ZodError; its `.message` is a JSON blob, so surface the first
 * issue's human message like the web action does).
 */
function parseZodMessage(err: Error): string | null {
  try {
    const issues = (err as unknown as { issues?: Array<{ message?: string }> })
      .issues;
    if (Array.isArray(issues) && issues[0]?.message) {
      return issues[0].message;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export default meRoutes;
