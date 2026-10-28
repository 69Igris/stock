/**
 * MONEY-866 — newsletter segment routing. The immediate publishPost path used to
 * call sendNewsletterBroadcast directly, which silently no-ops on the "newsletter"
 * token (only the worker routed it) — so an immediately-published newsletter
 * reached NOBODY. splitNewsletterSegments is the shared decision both paths use.
 *
 * Source: packages/email/src/newsletter.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitNewsletterSegments } from "@usemoney/email";

describe("MONEY-866 splitNewsletterSegments — newsletter audience vs legacy tiers", () => {
  it("'newsletter' token sets hasNewsletter (the immediate-publish no-op fix)", () => {
    const r = splitNewsletterSegments(["newsletter"]);
    assert.equal(r.hasNewsletter, true);
    assert.deepEqual(r.legacySegments, []);
  });

  it("legacy per-tier segments stay in legacySegments", () => {
    const r = splitNewsletterSegments(["usemoney-free", "usemoney-paid"]);
    assert.equal(r.hasNewsletter, false);
    assert.deepEqual(r.legacySegments, ["usemoney-free", "usemoney-paid"]);
  });

  it("mixed → hasNewsletter AND the remaining legacy segments", () => {
    const r = splitNewsletterSegments(["newsletter", "usemoney-paid"]);
    assert.equal(r.hasNewsletter, true);
    assert.deepEqual(r.legacySegments, ["usemoney-paid"]);
  });

  it("empty → neither (caller applies the prefer-audience-then-defaults fallback)", () => {
    const r = splitNewsletterSegments([]);
    assert.equal(r.hasNewsletter, false);
    assert.deepEqual(r.legacySegments, []);
  });
});
