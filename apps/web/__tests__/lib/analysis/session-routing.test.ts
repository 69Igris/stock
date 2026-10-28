/**
 * MONEY-543 - Analysis page tier-routing helper tests.
 *
 * `apps/web/app/analysis/[sessionId]/client.tsx` originally used a
 * `sessionId.startsWith("l3-")` check to pick between
 * `getAnalysisStatus/ResultAction` (L3 / L4 = `analysisSession` rows) and
 * `getResearchStatus/ResultAction` (L1 / L2 = `researchSession` rows). The
 * inlined check missed the `l4-` prefix so L4 sessions fell through to the
 * wrong action and 404'd.
 *
 * The fix lifts the prefix decision to `lib/analysis/session-routing.ts`
 * so all three call sites (initial load, status polling, result loader)
 * share one source of truth. These tests pin the helper's contract:
 *
 *   - `isAnalysisSessionId` matches `l3-` AND `l4-`, rejects plain UUIDs,
 *     and is defensively guarded against null / undefined / non-string.
 *   - The prefix check is strict (case-sensitive, no trim, exact `l3-`).
 *   - `getAnalysisTier` discriminates L3 vs L4 for callers that need
 *     tier-aware behaviour beyond "is this an analysis session?".
 *   - `ANALYSIS_SESSION_PREFIXES` is the single list — when a future tier
 *     (L5) is added it must land in the const, not be sprinkled across
 *     prefix checks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ANALYSIS_SESSION_PREFIXES,
  getAnalysisTier,
  isAnalysisSessionId,
} from "../../../lib/analysis/session-routing";

describe("isAnalysisSessionId", () => {
  it("'l3-abc-123' → true (L3 analysis session)", () => {
    assert.equal(isAnalysisSessionId("l3-abc-123"), true);
  });

  it("'l4-xyz' → true (L4 analysis session)", () => {
    assert.equal(isAnalysisSessionId("l4-xyz"), true);
  });

  it("'abc-123' (plain UUID, L1/L2) → false", () => {
    // L1 / L2 sessions live in `researchSession` and use bare UUIDs.
    // They must NOT be misrouted to the L3/L4 analysis action.
    assert.equal(isAnalysisSessionId("abc-123"), false);
  });

  it("'' → false", () => {
    assert.equal(isAnalysisSessionId(""), false);
  });

  it("null → false (defensive guard)", () => {
    // The TS signature says `string`, but client.tsx hands the value
    // through from a Next.js dynamic route param. A bad upstream
    // shouldn't crash the helper — cast through `unknown` to exercise
    // the runtime guard without violating strict mode.
    assert.equal(isAnalysisSessionId(null as unknown as string), false);
  });

  it("undefined → false (defensive guard)", () => {
    assert.equal(isAnalysisSessionId(undefined as unknown as string), false);
  });

  it("non-string (number) → false (defensive guard)", () => {
    assert.equal(isAnalysisSessionId(123 as unknown as string), false);
  });

  it("'L3-abc' (uppercase) → false (case-sensitive)", () => {
    // The check is case-sensitive by design — the worker emits
    // lowercase `l3-` / `l4-` prefixes when it mints sessionIds, so a
    // mixed-case sessionId in the URL bar must NOT be silently
    // upcast. Documented so a refactor to `toLowerCase()` is a
    // conscious decision.
    assert.equal(isAnalysisSessionId("L3-abc"), false);
  });

  it("'l5-foo' (future tier not yet added) → false", () => {
    // Important regression guard: when someone adds L5, both
    // ANALYSIS_SESSION_PREFIXES AND this test must be updated. If
    // they only touch one, the failing case here makes the gap
    // obvious in CI instead of as a silent 404 in production.
    assert.equal(isAnalysisSessionId("l5-foo"), false);
  });

  it("'l3' (no trailing dash) → false", () => {
    // Prefix is exactly `l3-`. A session whose id is literally
    // "l3" (no UUID part) should not match — partial-match is a
    // common bug class for prefix routing.
    assert.equal(isAnalysisSessionId("l3"), false);
  });

  it("' l3-abc' (leading whitespace) → false (strict, no trim)", () => {
    // No silent trimming. A leading space in the URL bar would
    // come through URI-decoded and should fail loudly rather than
    // route to the wrong action.
    assert.equal(isAnalysisSessionId(" l3-abc"), false);
  });
});

describe("getAnalysisTier", () => {
  it("'l3-abc' → 'l3'", () => {
    assert.equal(getAnalysisTier("l3-abc"), "l3");
  });

  it("'l4-abc' → 'l4'", () => {
    assert.equal(getAnalysisTier("l4-abc"), "l4");
  });

  it("'abc' → null (not an analysis session)", () => {
    assert.equal(getAnalysisTier("abc"), null);
  });

  it("L4 prefix wins over L3 prefix (precedence guard)", () => {
    // Documented invariant: getAnalysisTier checks `l4-` first so
    // any hypothetical sessionId that started with `l4-` would
    // never be mis-tagged as L3. (Real sessionIds never collide,
    // but the check order is load-bearing for future tiers.)
    assert.equal(getAnalysisTier("l4-l3-collision"), "l4");
  });
});

describe("ANALYSIS_SESSION_PREFIXES", () => {
  it("contains both 'l3-' and 'l4-'", () => {
    // If someone adds a new tier they MUST add its prefix here.
    // Asserting the membership pins the const so the gap shows up
    // here instead of as a silent missed-route in production.
    assert.equal(ANALYSIS_SESSION_PREFIXES.includes("l3-"), true);
    assert.equal(ANALYSIS_SESSION_PREFIXES.includes("l4-"), true);
  });

  it("has exactly 2 entries (no stray prefixes)", () => {
    // Tightens the contract — a duplicate or accidental entry
    // would silently route bare-UUID sessions to the wrong action.
    assert.equal(ANALYSIS_SESSION_PREFIXES.length, 2);
  });

  it("every prefix in the const matches isAnalysisSessionId", () => {
    // Round-trip invariant: the helper must agree with the const.
    // Catches the bug where someone adds a prefix to the const
    // but forgets to wire it through `startsWith` (or vice versa).
    for (const prefix of ANALYSIS_SESSION_PREFIXES) {
      assert.equal(
        isAnalysisSessionId(`${prefix}sample-uuid`),
        true,
        `prefix ${prefix} should be recognised by isAnalysisSessionId`
      );
    }
  });
});
