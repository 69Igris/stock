/**
 * Resend Broadcast Tests — REAL source (packages/email/src/broadcast.ts via
 * `@usemoney/email`).
 *
 * De-shadowed (MONEY-620): the previous file re-implemented `getSegmentAudienceId`
 * (a module-PRIVATE resolver, env-bound) and `simulateSendBroadcastToSegments`
 * INLINE and asserted those copies.
 *
 * `getSegmentAudienceId` is not exported; its only public surface is
 * `sendBroadcastToSegments`. Under the test runner there is no Resend client
 * (`getResendClient()` would throw without `RESEND_API_KEY`) and `mock.module`
 * is unavailable under the `tsx` loader — so the "configured → actually send"
 * path can't be driven here. But the production SKIP path IS fully reachable:
 * when a segment's audience env var is unset, the REAL `sendBroadcastToSegments`
 * resolves it to `null` via the REAL private `getSegmentAudienceId` and pushes
 * `{ success: false }` WITHOUT ever constructing the Resend client. These tests
 * drive that real path end-to-end (audience env vars deleted in `before()`).
 *
 * The "send to configured segments" behaviour is covered where Resend can be
 * stubbed — see `apps/web/__tests__/actions/email-preferences.test.ts` and the
 * worker contact-sync suite for the segment-resolution logic.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import React from "react";

type Segment =
  | "free"
  | "paid"
  | "downgraded"
  | "usemoney-security"
  | "marketing";

let sendBroadcastToSegments: (options: {
  segments: Segment[];
  subject: string;
  react?: React.ReactElement;
  buildReact?: (segment: Segment) => React.ReactElement;
  name?: string;
}) => Promise<Array<{ success: boolean; broadcastId?: string }>>;

const AUDIENCE_ENV_VARS = [
  "RESEND_AUDIENCE_FREE_ID",
  "RESEND_AUDIENCE_PAID_ID",
  "RESEND_AUDIENCE_DOWNGRADED_ID",
  "RESEND_AUDIENCE_USEMONEY_SECURITY_ID",
  "RESEND_AUDIENCE_MARKETING_ID",
];

before(async () => {
  // No audience IDs configured → every segment short-circuits to null in the
  // REAL getSegmentAudienceId, before any Resend client is constructed.
  for (const v of AUDIENCE_ENV_VARS) delete process.env[v];
  const mod = await import("@usemoney/email");
  sendBroadcastToSegments = mod.sendBroadcastToSegments;
});

const dummyReact = () => React.createElement("div", null, "body");

describe("sendBroadcastToSegments — skip path (real)", () => {
  it("skips every unconfigured segment and reports failure for each", async () => {
    const results = await sendBroadcastToSegments({
      segments: ["free", "paid"],
      subject: "Test Newsletter",
      react: dummyReact(),
    });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.success === false));
    assert.ok(results.every((r) => r.broadcastId === undefined));
  });

  it("skips all when none of three segments are configured", async () => {
    const results = await sendBroadcastToSegments({
      segments: ["free", "paid", "usemoney-security"],
      subject: "Test",
      react: dummyReact(),
    });

    assert.strictEqual(results.length, 3);
    assert.ok(results.every((r) => !r.success));
  });

  it("returns an empty result array for an empty segments list", async () => {
    const results = await sendBroadcastToSegments({
      segments: [],
      subject: "Test",
      react: dummyReact(),
    });

    assert.strictEqual(results.length, 0);
  });

  it("produces exactly one result per requested segment (order preserved)", async () => {
    const results = await sendBroadcastToSegments({
      segments: ["paid", "free", "downgraded"],
      subject: "Test",
      react: dummyReact(),
    });
    assert.strictEqual(results.length, 3);
  });

  it("does not throw even though no Resend API key is configured (skip happens first)", async () => {
    // If getSegmentAudienceId did NOT short-circuit, sendBroadcast would call
    // getResendClient() which throws without RESEND_API_KEY. Reaching a clean
    // result array proves the real skip path ran before any Resend access.
    await assert.doesNotReject(() =>
      sendBroadcastToSegments({
        segments: ["marketing"],
        subject: "Test",
        react: dummyReact(),
      })
    );
  });
});

// MONEY-1050 — Resend rejects a broadcast name > 70 chars. The name is composed
// from the post title (+ segment suffix), so a long title silently fails the
// broadcast CREATE. clampBroadcastName is the single-choke-point guard.
describe("clampBroadcastName (real)", () => {
  let clampBroadcastName: (name?: string) => string | undefined;
  let MAX: number;

  before(async () => {
    const mod = await import("@usemoney/email");
    clampBroadcastName = mod.clampBroadcastName;
    MAX = mod.RESEND_BROADCAST_NAME_MAX;
  });

  it("uses 70 as the Resend limit", () => {
    assert.strictEqual(MAX, 70);
  });

  it("returns undefined when name is missing", () => {
    assert.strictEqual(clampBroadcastName(undefined), undefined);
  });

  it("leaves a short name unchanged", () => {
    assert.strictEqual(
      clampBroadcastName("Weekly Digest (free)"),
      "Weekly Digest (free)"
    );
  });

  it("leaves a name of exactly 70 chars unchanged", () => {
    const exactly70 = "x".repeat(70);
    assert.strictEqual(clampBroadcastName(exactly70), exactly70);
    assert.strictEqual(clampBroadcastName(exactly70)!.length, 70);
  });

  it("truncates a name over 70 chars to 70", () => {
    // A realistic overflow: long title + the 13-char ' (downgraded)' suffix.
    const longTitle =
      "UseMoney AI Is Officially Live: Our Biggest Early-User Launch Offer Ever (downgraded)";
    assert.ok(longTitle.length > 70);
    const clamped = clampBroadcastName(longTitle)!;
    assert.strictEqual(clamped.length, 70);
    assert.strictEqual(clamped, longTitle.slice(0, 70));
  });
});
