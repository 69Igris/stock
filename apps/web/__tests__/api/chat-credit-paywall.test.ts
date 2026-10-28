/**
 * Credit-failure paywall block tests (MONEY-295 Bug 6) - REAL source.
 *
 * Exercises the ACTUAL helpers the chat route calls (from
 * `@/app/api/chat/route-logic`): `creditPaywallTitle`, `creditPaywallMessage`,
 * and `buildCreditPaywallBlocks`.
 *
 * When `consumeCredits` fails (insufficient quota or a stale non-ACTIVE
 * subscription), the chat route returns 200 with structured blocks: a warning
 * ErrorBlock + a NavigationBlock with upgrade and credit-pack CTAs — never a
 * bare 403. Chat stays alive.
 *
 * (Replaces the previous SHADOW version, which reimplemented the entire payload
 * builder inline and asserted the copy. The route now imports & calls these, so
 * this guards the real payload.)
 *
 * Source: apps/web/app/api/chat/route.ts (the consumeCredits-failure branch)
 *         apps/web/app/api/chat/route-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ErrorBlock, NavigationBlock } from "@usemoney/types";

import {
  type CreditFailure,
  buildCreditPaywallBlocks,
  creditPaywallTitle,
} from "@/app/api/chat/route-logic";

/** Mirrors the route's NextResponse body for the credit-failure branch. */
function buildPaywallResponse(creditResult: CreditFailure): {
  response: string;
  blocks: ReturnType<typeof buildCreditPaywallBlocks>;
} {
  return {
    response: creditPaywallTitle(creditResult),
    blocks: buildCreditPaywallBlocks(creditResult),
  };
}

describe("Credit-failure paywall response", () => {
  it("INSUFFICIENT_CREDITS produces 'Not enough credits' title + upgrade CTA", () => {
    const result = buildPaywallResponse({
      success: false,
      error: "Not enough credits. You need 5 but have 0 remaining.",
      code: "INSUFFICIENT_CREDITS",
    });

    const errorBlock = result.blocks[0] as ErrorBlock;
    assert.equal(errorBlock.type, "error");
    assert.equal(errorBlock.severity, "warning");
    assert.equal(errorBlock.title, "Not enough credits");
    assert.match(errorBlock.message || "", /5 but have 0/);
  });

  it("Status-not-active error produces 'needs activation' title", () => {
    const result = buildPaywallResponse({
      success: false,
      error: "Subscription is not active. Please renew your plan.",
      // No code - identified by the error string. (FREE is normalized
      // elsewhere so this only fires for paid plans now.)
    });

    const errorBlock = result.blocks[0] as ErrorBlock;
    assert.equal(errorBlock.title, "Subscription needs activation");
    assert.match(errorBlock.message || "", /Reactivate or downgrade/);
  });

  it("Always includes both upgrade and credit-pack CTAs", () => {
    const result = buildPaywallResponse({
      success: false,
      error: "Not enough credits.",
      code: "INSUFFICIENT_CREDITS",
    });

    const navBlock = result.blocks[1] as NavigationBlock;
    assert.equal(navBlock.type, "navigation");
    assert.equal(navBlock.links.length, 2);
    assert.equal(navBlock.links[0].label, "Upgrade to PRO");
    assert.equal(navBlock.links[0].href, "/pricing");
    assert.equal(navBlock.links[1].label, "Buy credit pack");
    assert.equal(navBlock.links[1].href, "/pricing#credits");
  });

  it("Returns blocks (not bare error) - chat stays alive after paywall", () => {
    const result = buildPaywallResponse({
      success: false,
      error: "Not enough credits.",
      code: "INSUFFICIENT_CREDITS",
    });

    assert.ok(result.blocks.length >= 2);
    assert.ok(typeof result.response === "string");
  });

  it("Inactive heuristic ignores INSUFFICIENT_CREDITS code (avoids false positive)", () => {
    const result = buildPaywallResponse({
      success: false,
      // Crafted to contain "not active" but WITH a code - the code wins,
      // falls through to "Not enough credits".
      error: "User has not active credits left",
      code: "INSUFFICIENT_CREDITS",
    });

    const errorBlock = result.blocks[0] as ErrorBlock;
    assert.equal(errorBlock.title, "Not enough credits");
  });

  it("title matches the response field (route uses the title as response)", () => {
    const result = buildPaywallResponse({
      success: false,
      error: "Not enough credits.",
      code: "INSUFFICIENT_CREDITS",
    });
    assert.equal(result.response, "Not enough credits");
  });
});
