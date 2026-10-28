/**
 * Resend Contacts / Segments Tests — REAL source.
 *
 * De-shadowed (MONEY-620): the previous file re-implemented
 *   - `getSegmentAudienceId` (a module-PRIVATE env resolver),
 *   - a `simulateMoveContactToSegment` concurrency model,
 *   - and the 3-way `resolveSegment` / `wrongSegmentsToRemove` classifier
 * INLINE, asserting those copies.
 *
 * Real-source mapping:
 *   - The 3-way audience classification lives in the worker logic module
 *     `workers/src/processors/resend-contact-sync-logic.ts` as the EXPORTED
 *     `resolveTargetTier(subscription, hasEverPaid, downgradedConfigured)` —
 *     the single source of truth that `resend-contact-sync.ts` + the Resend
 *     migration/reconcile scripts classify against. Imported and asserted here.
 *   - `addContactToSegment` / `removeContactFromSegment` / `moveContactToSegment`
 *     are REAL `@usemoney/email` exports. Their no-audience-configured SKIP path
 *     (`getSegmentAudienceId` → null → `{ success: false }`) runs BEFORE any
 *     Resend client is constructed, so it is reachable under the test runner
 *     (no `RESEND_API_KEY`, and `mock.module` is unavailable under tsx). Driven
 *     here with the audience env vars deleted.
 *
 * The "configured → actually create/remove via Resend" path needs a stubbed
 * Resend client and is out of scope for this pure unit (the classification it
 * depends on is fully covered via `resolveTargetTier`).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetTier } from "../../../../workers/src/processors/resend-contact-sync-logic";

type Segment =
  | "free"
  | "paid"
  | "downgraded"
  | "usemoney-security"
  | "marketing";

let addContactToSegment: (
  segment: Segment,
  contact: { email: string; firstName?: string; lastName?: string }
) => Promise<{ success: boolean }>;
let removeContactFromSegment: (
  segment: Segment,
  email: string
) => Promise<{ success: boolean }>;
let moveContactToSegment: (
  email: string,
  from: Segment,
  to: Segment,
  contact: { email: string }
) => Promise<{ success: boolean }>;
// MONEY-864: the newsletter audience helper the verify route now relies on.
let addToNewsletterAudience: (input: {
  email: string;
  firstName?: string;
  lastName?: string;
}) => Promise<{ ok: boolean; error?: string }>;
let removeFromNewsletterAudience: (input: {
  email: string;
}) => Promise<{ ok: boolean; error?: string }>;
let emailModule: Record<string, unknown>;

const AUDIENCE_ENV_VARS = [
  "RESEND_AUDIENCE_FREE_ID",
  "RESEND_AUDIENCE_PAID_ID",
  "RESEND_AUDIENCE_DOWNGRADED_ID",
  "RESEND_AUDIENCE_USEMONEY_SECURITY_ID",
  "RESEND_AUDIENCE_MARKETING_ID",
  // Deleted BEFORE the module import so the NEWSLETTER_AUDIENCE_ID const
  // (evaluated at import time) resolves to "" and the skip path is reachable.
  "RESEND_AUDIENCE_NEWSLETTER_ID",
];

before(async () => {
  for (const v of AUDIENCE_ENV_VARS) delete process.env[v];
  const mod = await import("@usemoney/email");
  emailModule = mod as unknown as Record<string, unknown>;
  addContactToSegment = mod.addContactToSegment as typeof addContactToSegment;
  removeContactFromSegment =
    mod.removeContactFromSegment as typeof removeContactFromSegment;
  moveContactToSegment =
    mod.moveContactToSegment as typeof moveContactToSegment;
  addToNewsletterAudience =
    mod.addToNewsletterAudience as typeof addToNewsletterAudience;
  removeFromNewsletterAudience =
    mod.removeFromNewsletterAudience as typeof removeFromNewsletterAudience;
});

describe("resolveTargetTier — 3-way audience classification (real worker logic)", () => {
  it("active paid plan → paid (regardless of history)", () => {
    const paid = { planId: "PRO", status: "ACTIVE" };
    assert.strictEqual(resolveTargetTier(paid, false, false), "paid");
    assert.strictEqual(resolveTargetTier(paid, true, true), "paid");
  });

  it("PREMIUM / ULTIMATE active → paid", () => {
    assert.strictEqual(
      resolveTargetTier({ planId: "PREMIUM", status: "ACTIVE" }, true, true),
      "paid"
    );
    assert.strictEqual(
      resolveTargetTier({ planId: "ULTIMATE", status: "ACTIVE" }, true, true),
      "paid"
    );
  });

  it("never paid → free", () => {
    assert.strictEqual(
      resolveTargetTier({ planId: "FREE", status: "ACTIVE" }, false, true),
      "free"
    );
    assert.strictEqual(resolveTargetTier(null, false, true), "free");
  });

  it("cancelled/expired/past-due paid plan with history → downgraded", () => {
    assert.strictEqual(
      resolveTargetTier({ planId: "PRO", status: "CANCELLED" }, true, true),
      "downgraded"
    );
    assert.strictEqual(
      resolveTargetTier({ planId: "PREMIUM", status: "EXPIRED" }, true, true),
      "downgraded"
    );
    assert.strictEqual(
      resolveTargetTier({ planId: "PRO", status: "PAST_DUE" }, true, true),
      "downgraded"
    );
  });

  it("active FREE plan but has paid before → downgraded (downgraded to free)", () => {
    assert.strictEqual(
      resolveTargetTier({ planId: "FREE", status: "ACTIVE" }, true, true),
      "downgraded"
    );
  });

  it("has-ever-paid but downgraded audience NOT configured → free (graceful fallback)", () => {
    assert.strictEqual(
      resolveTargetTier({ planId: "PRO", status: "CANCELLED" }, true, false),
      "free"
    );
  });

  it("currently paid takes precedence over downgrade history (win-back)", () => {
    assert.strictEqual(
      resolveTargetTier({ planId: "PREMIUM", status: "ACTIVE" }, true, true),
      "paid"
    );
  });

  it("unknown plan id treated as non-paid", () => {
    assert.strictEqual(
      resolveTargetTier(
        { planId: "ENTERPRISE", status: "ACTIVE" },
        false,
        true
      ),
      "free"
    );
  });
});

describe("segment writes — no-audience-configured skip path (real @usemoney/email)", () => {
  it("addContactToSegment returns { success: false } when the audience is unset (no Resend call)", async () => {
    const result = await addContactToSegment("free", {
      email: "user@example.com",
    });
    assert.strictEqual(result.success, false);
  });

  it("removeContactFromSegment returns { success: false } when the audience is unset", async () => {
    const result = await removeContactFromSegment("paid", "user@example.com");
    assert.strictEqual(result.success, false);
  });

  it("moveContactToSegment fails when BOTH segments are unconfigured", async () => {
    const result = await moveContactToSegment(
      "user@example.com",
      "free",
      "paid",
      { email: "user@example.com" }
    );
    assert.strictEqual(result.success, false);
  });

  it("does not throw despite no RESEND_API_KEY (skip short-circuits before Resend)", async () => {
    // If the audience resolved to non-null, the function would call
    // getResendClient() which throws without RESEND_API_KEY. A clean false
    // result proves the real skip path ran first.
    await assert.doesNotReject(() =>
      addContactToSegment("usemoney-security", { email: "user@example.com" })
    );
  });
});

describe("newsletter audience helper (real @usemoney/email — verify route path)", () => {
  it("addToNewsletterAudience returns audience-not-configured when NEWSLETTER id unset (no Resend call)", async () => {
    const result = await addToNewsletterAudience({
      email: "reader@example.com",
      firstName: "Reader",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "audience-not-configured");
  });

  it("removeFromNewsletterAudience returns audience-not-configured when unset", async () => {
    const result = await removeFromNewsletterAudience({
      email: "reader@example.com",
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "audience-not-configured");
  });

  it("does not throw without RESEND_API_KEY (skip short-circuits before Resend)", async () => {
    await assert.doesNotReject(() =>
      addToNewsletterAudience({ email: "reader@example.com" })
    );
  });
});

describe("MONEY-864 regression — dead RESEND_AUDIENCE_ID legacy path is retired", () => {
  it("@usemoney/email no longer exports upsertResendContact / unsubscribeResendContact", () => {
    // These read the never-configured RESEND_AUDIENCE_ID and silently no-op'd;
    // re-introducing them is the exact bug fixed in MONEY-864.
    assert.strictEqual(emailModule.upsertResendContact, undefined);
    assert.strictEqual(emailModule.unsubscribeResendContact, undefined);
  });

  it("the newsletter-audience helpers ARE exported (the correct replacement)", () => {
    assert.strictEqual(typeof emailModule.addToNewsletterAudience, "function");
    assert.strictEqual(
      typeof emailModule.removeFromNewsletterAudience,
      "function"
    );
  });
});
