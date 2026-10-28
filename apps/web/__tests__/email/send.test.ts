/**
 * Email Send / Constants Tests — REAL source (packages/email/src/constants.ts +
 * send.ts via `@usemoney/email`).
 *
 * De-shadowed (MONEY-620): the previous file re-implemented `chunkArray`,
 * `formatSubscribersCSV`, `normalizeEmail` and a batch-mapping INLINE and
 * asserted those copies. None of those are exported by `@usemoney/email`:
 *   - the batch chunking lives INSIDE `sendBatchEmails` (size 100) and calls
 *     `resend.batch.send` — not unit-testable without a stubbed Resend client
 *     (no `RESEND_API_KEY` here, and `mock.module` is unavailable under tsx);
 *   - the subscriber CSV export is a content-app server-action internal
 *     (`apps/content/lib/actions/subscribers.ts`) — wrong layer to import from a
 *     web test, AND the shadow's header had drifted (real header is now
 *     `email,name,subscribed_at,source,segments` — five columns, not four);
 *   - `normalizeEmail` was a trivial route-private util.
 *
 * Two concrete divergences the shadow hid (its copies were asserted, the real
 * source was never run): (1) the CSV column set above, and (2) it claimed
 * `EMAIL_REPLY_TO === "support@email.usemoney.ai"` while the REAL default is
 * `founder@usemoney.ai`.
 *
 * This now asserts the REAL exported constants and the REAL send-function
 * surface. Constants default at module load, so env is cleared in `before()`
 * before `await import`.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

let EMAIL_FROM: string;
let EMAIL_REPLY_TO: string;
let APP_URL: string;
let sendEmail: unknown;
let sendBatchEmails: unknown;
let sendNewsletter: unknown;

before(async () => {
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  delete process.env.NEXT_PUBLIC_APP_URL;
  const mod = await import("@usemoney/email");
  EMAIL_FROM = mod.EMAIL_FROM;
  EMAIL_REPLY_TO = mod.EMAIL_REPLY_TO;
  APP_URL = mod.APP_URL;
  sendEmail = mod.sendEmail;
  sendBatchEmails = mod.sendBatchEmails;
  sendNewsletter = mod.sendNewsletter;
});

describe("Email constants (real @usemoney/email)", () => {
  it("EMAIL_FROM is a display-name + address From header on the usemoney domain", () => {
    // Default (when EMAIL_FROM env is unset) is the founder identity From
    // (MONEY-863: registration/transactional mail is sent as the founder). The
    // display name is intentionally NOT pinned — assert the structural contract
    // that always holds: a non-empty display name + an <address> on the usemoney
    // domain. If a prior import in this process set the env, this still holds.
    assert.match(EMAIL_FROM, /^.+ <[^@]+@[^>]+>$/);
    assert.ok(EMAIL_FROM.includes("usemoney.ai"));
  });

  it("EMAIL_REPLY_TO is a usemoney reply address (default founder@usemoney.ai)", () => {
    assert.match(EMAIL_REPLY_TO, /@usemoney\.ai$/);
    if (!process.env.EMAIL_REPLY_TO) {
      assert.strictEqual(EMAIL_REPLY_TO, "founder@usemoney.ai");
    }
  });

  it("APP_URL is an https usemoney origin (default https://usemoney.ai)", () => {
    assert.ok(APP_URL.startsWith("https://"));
    if (!process.env.NEXT_PUBLIC_APP_URL) {
      assert.strictEqual(APP_URL, "https://usemoney.ai");
    }
  });
});

describe("Email send surface (real exports)", () => {
  it("exports sendEmail / sendBatchEmails / sendNewsletter as functions", () => {
    assert.strictEqual(typeof sendEmail, "function");
    assert.strictEqual(typeof sendBatchEmails, "function");
    assert.strictEqual(typeof sendNewsletter, "function");
  });

  it("sendBatchEmails requires a Resend client (throws 'RESEND_API_KEY is not set' with no key)", async () => {
    // The REAL sendBatchEmails calls getResendClient() up front, which throws
    // when RESEND_API_KEY is unset. Asserting that contract exercises the real
    // function's dependency, not a copy. (Skip if a key happens to be present.)
    if (process.env.RESEND_API_KEY) return;
    const fn = sendBatchEmails as (
      emails: Array<{ to: string; subject: string; react: unknown }>
    ) => Promise<{ sent: number; failed: number }>;
    await assert.rejects(() => fn([]), /RESEND_API_KEY/);
  });

  it("sendNewsletter delegates to the same batch path (requires a Resend client)", async () => {
    if (process.env.RESEND_API_KEY) return;
    const fn = sendNewsletter as (opts: {
      subscriberEmails: string[];
      subject: string;
      react: unknown;
    }) => Promise<{ sent: number; failed: number }>;
    await assert.rejects(
      () => fn({ subscriberEmails: ["a@b.com"], subject: "x", react: null }),
      /RESEND_API_KEY/
    );
  });
});
