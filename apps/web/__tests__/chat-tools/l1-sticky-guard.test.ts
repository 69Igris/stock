import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertL1Sticky,
  L1_FREE_CREDIT_ACTIONS,
} from "@/lib/chat-tools/tier-classifier";

/**
 * MONEY-224 - Free-chat lock.
 *
 * The "free chat" promise on the landing page depends on l1_flash chat
 * staying free across the full request lifecycle. These tests pin the
 * guard's behaviour so any future regression that tries to silently
 * upgrade L1 → L2 fails CI here, not in production.
 */

describe("L1_FREE_CREDIT_ACTIONS - contract", () => {
  it("includes l1_flash, l1_definition, follow_up, portfolio_query", () => {
    assert.ok(L1_FREE_CREDIT_ACTIONS.has("l1_flash"));
    assert.ok(L1_FREE_CREDIT_ACTIONS.has("l1_definition"));
    assert.ok(L1_FREE_CREDIT_ACTIONS.has("follow_up"));
    assert.ok(L1_FREE_CREDIT_ACTIONS.has("portfolio_query"));
  });

  it("excludes any l2_* or l3_* charged actions", () => {
    assert.ok(!L1_FREE_CREDIT_ACTIONS.has("l2_research_fast"));
    assert.ok(!L1_FREE_CREDIT_ACTIONS.has("l2_dcf_valuation"));
    assert.ok(!L1_FREE_CREDIT_ACTIONS.has("l3_comprehensive_stock"));
  });
});

describe("assertL1Sticky - happy paths", () => {
  it("passes through l1_flash unchanged when wasOriginallyL1", () => {
    const action = assertL1Sticky({
      proposed: "l1_flash",
      wasOriginallyL1: true,
    });
    assert.equal(action, "l1_flash");
  });

  it("passes through follow_up unchanged when wasOriginallyL1", () => {
    const action = assertL1Sticky({
      proposed: "follow_up",
      wasOriginallyL1: true,
    });
    assert.equal(action, "follow_up");
  });

  it("does NOT interfere with non-L1 turns - L2 stays L2", () => {
    const action = assertL1Sticky({
      proposed: "l2_research_advanced",
      wasOriginallyL1: false, // intentional L2 (deep keyword, multi-symbol, etc.)
    });
    assert.equal(action, "l2_research_advanced");
  });

  it("does NOT interfere with L3 when intentionally requested", () => {
    const action = assertL1Sticky({
      proposed: "l3_comprehensive_stock",
      wasOriginallyL1: false,
    });
    assert.equal(action, "l3_comprehensive_stock");
  });
});

describe("assertL1Sticky - guard fires (regression protection)", () => {
  it("forces l1_flash when L1 tries to upgrade to l2_research_fast", () => {
    const action = assertL1Sticky({
      proposed: "l2_research_fast",
      wasOriginallyL1: true,
      requestId: "test-req-1",
    });
    assert.equal(action, "l1_flash");
  });

  it("forces l1_flash when L1 tries to upgrade to l3_comprehensive_stock", () => {
    const action = assertL1Sticky({
      proposed: "l3_comprehensive_stock",
      wasOriginallyL1: true,
    });
    assert.equal(action, "l1_flash");
  });

  it("forces l1_flash when L1 tries to upgrade to l2_dcf_valuation", () => {
    const action = assertL1Sticky({
      proposed: "l2_dcf_valuation",
      wasOriginallyL1: true,
    });
    assert.equal(action, "l1_flash");
  });

  it("forces l1_flash when L1 tries to upgrade to l2_stock_screener", () => {
    const action = assertL1Sticky({
      proposed: "l2_stock_screener",
      wasOriginallyL1: true,
    });
    assert.equal(action, "l1_flash");
  });
});

describe("assertL1Sticky - edge cases", () => {
  it("does not upgrade when proposal is already free (idempotent)", () => {
    // l1_definition is in FREE_ACTIONS, so guard short-circuits
    const action = assertL1Sticky({
      proposed: "l1_definition",
      wasOriginallyL1: true,
    });
    assert.equal(action, "l1_definition");
  });

  it("respects wasOriginallyL1=false even for free actions (no-op)", () => {
    // L2 turn that legitimately resolved to follow_up via re-trigger
    const action = assertL1Sticky({
      proposed: "follow_up",
      wasOriginallyL1: false,
    });
    assert.equal(action, "follow_up");
  });
});
