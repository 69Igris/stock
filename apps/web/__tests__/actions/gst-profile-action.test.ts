/**
 * MONEY-393 §13 - `lib/actions/gst-profile.ts` shape + IDOR + auth.
 *
 * Source-text guards for the 4 GST profile actions:
 *   - getMyGstProfileAction, setMyGstProfileAction
 *   - getMyInvoiceDownloadUrlAction, generateMyInvoiceForPaymentAction
 *
 * Critical regression targets:
 *   - Both invoice actions are IDOR-guarded: they filter Prisma by
 *     BOTH paymentId AND userId so a guessed payment id can't leak
 *     another user's invoice URL.
 *   - generateMyInvoiceForPaymentAction surfaces GstProfileMissingError
 *     as a friendly "Add your GST details in Settings" message - not
 *     a raw error from the service.
 *
 * Source-text only (no runtime import) to dodge @/lib/auth's
 * React-cache dependency, same as preferences-action.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "lib", "actions", "gst-profile.ts"),
  "utf8"
);

describe("MONEY-393 §13 - lib/actions/gst-profile.ts shape", () => {
  it("[exports] 4 server actions declared with the documented names", () => {
    assert.match(SRC, /export\s+async\s+function\s+getMyGstProfileAction\b/);
    assert.match(SRC, /export\s+async\s+function\s+setMyGstProfileAction\b/);
    assert.match(
      SRC,
      /export\s+async\s+function\s+getMyInvoiceDownloadUrlAction\b/
    );
    assert.match(
      SRC,
      /export\s+async\s+function\s+generateMyInvoiceForPaymentAction\b/
    );
  });

  it("[src] file marked 'use server'", () => {
    assert.match(SRC, /^"use server"/m);
  });

  it("[src] every action calls getAuthenticatedUser() before touching the DB", () => {
    const occurrences = SRC.match(/await\s+getAuthenticatedUser\(\)/g) ?? [];
    assert.equal(
      occurrences.length,
      4,
      `expected 4 auth checks (one per action), got ${occurrences.length}`
    );
  });

  it("[src] every action returns Unauthorized on missing authUser", () => {
    const occurrences = SRC.match(/error:\s*"Unauthorized"/g) ?? [];
    assert.equal(occurrences.length, 4);
  });

  it("[idor] download URL action filters Prisma by BOTH paymentId AND userId", () => {
    // The most security-sensitive site - refuses to surface invoice
    // URLs for payments belonging to another user.
    assert.match(
      SRC,
      /prisma\.gstInvoice\.findFirst\([\s\S]{0,400}where:\s*\{[\s\S]{0,200}paymentId,?[\s\S]{0,200}userId:\s*authUser\.userId/,
      "getMyInvoiceDownloadUrlAction must filter by userId in addition to paymentId"
    );
  });

  it("[idor] download URL action only surfaces ISSUED invoices", () => {
    // Catches a regression that surfaces draft/voided invoice URLs.
    assert.match(SRC, /status:\s*"ISSUED"/);
  });

  it("[idor] generate-invoice action filters Payment by BOTH id AND userId", () => {
    assert.match(
      SRC,
      /prisma\.payment\.findFirst\([\s\S]{0,400}where:\s*\{[\s\S]{0,100}id:\s*paymentId,?[\s\S]{0,100}userId:\s*authUser\.userId/,
      "generateMyInvoiceForPaymentAction must IDOR-guard the Payment lookup"
    );
  });

  it("[idor] generate-invoice action returns 'Payment not found' when the Payment query misses", () => {
    // Generic message so an attacker can't distinguish 'doesn't exist'
    // from 'belongs to another user'. Both paths → same error string.
    assert.match(SRC, /"Payment not found"/);
  });

  it("[friendly-errors] GstProfileMissingError surfaces a user-friendly Settings hint", () => {
    // The friendly message guides users to add their GSTIN/legal name
    // in Settings before they can generate an invoice.
    assert.match(
      SRC,
      /GstProfileMissingError[\s\S]{0,300}Add your GST details in Settings/
    );
  });

  it("[friendly-errors] PaymentNotEligibleError surfaces the service's specific reason", () => {
    // The service throws a typed error with a context-specific message
    // (e.g. "refunded payments aren't billable"). Action surfaces it
    // verbatim.
    assert.match(SRC, /PaymentNotEligibleError[\s\S]{0,200}error\.message/);
  });

  it("[setter] setMyGstProfileAction accepts the documented input shape (legalName/address/stateCode/gstin?/pan?)", () => {
    assert.match(
      SRC,
      /setMyGstProfileAction\(input:\s*\{[\s\S]{0,400}legalName:\s*string[\s\S]{0,400}address:\s*string[\s\S]{0,400}stateCode:\s*string[\s\S]{0,400}gstin\?:\s*string[\s\S]{0,400}pan\?:\s*string/
    );
  });

  it("[discriminated-union] every return path is { success, ... }", () => {
    assert.ok(SRC.includes("success: true, data:"));
    assert.ok(SRC.includes("success: false, error:"));
  });

  it("[sanitized-errors] catch blocks all sanitize via instanceof Error", () => {
    // 4 sanitized-error branches plus a friendly fall-through in
    // generateMyInvoiceForPaymentAction (which has 3 catches inside
    // - generic + GstProfileMissing + PaymentNotEligible). The
    // common instanceof check appears in 4 spots (one per action).
    const occurrences =
      SRC.match(/error\s+instanceof\s+Error\s*\?\s*error\.message\s*:/g) ?? [];
    assert.ok(
      occurrences.length >= 4,
      `expected ≥4 sanitized-error branches, got ${occurrences.length}`
    );
  });
});
