/**
 * Atomic credit decrement — stop concurrent double-spend (MONEY-595 A07).
 *
 * Source: packages/services/src/credit-logic.ts `planConsumeSplit` +
 *         packages/services/src/credit.service.ts `consumeCredits`.
 *
 * The pre-fix read-modify-write (read balance → check → write an ABSOLUTE
 * `creditsUsed` across awaits) let two concurrent requests both read the same
 * balance, both pass the check, and both write the same decremented value, so
 * only ONE charge landed for TWO actions (double-spend).
 *
 * The fix charges via a CONDITIONAL `updateMany` whose `where` re-asserts the
 * guard at write time (`creditsUsed <= creditsLimit - cost`) and whose `data`
 * uses an atomic `increment` (never an absolute value). `count === 0` means
 * another request won the race; the caller re-snapshots and retries a bounded
 * number of times, and fails CLOSED if it never lands a charge.
 *
 * PREVIOUSLY A SHADOW: this file re-declared `chargePlanConditional` +
 * `consumePlanCredits` inline and asserted the COPY. The pure split decision is
 * now an EXPORTED symbol (`planConsumeSplit`) that the LIVE `consumeCredits`
 * CALLS, so this file asserts the REAL export. The atomic-WRITE half (the
 * guarded `updateMany` where-clause + `increment` + lost-race retry + fail
 * closed) is asserted end-to-end against the REAL `consumeCredits` driving a
 * recording prisma in
 * `apps/web/__tests__/services/credit-services-security-e2e.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  planConsumeSplit,
  type SubscriptionCreditSnapshot,
} from "../../../../packages/services/src/credit-logic";

const freshSub = (
  over: Partial<SubscriptionCreditSnapshot> = {}
): SubscriptionCreditSnapshot => ({
  creditsUsed: 0,
  creditsLimit: 5,
  packCreditsUsed: 0,
  packCreditsLimit: 0,
  ...over,
});

describe("consumeCredits atomic decrement (MONEY-595 A07) — real planConsumeSplit", () => {
  it("allows a charge when the user has exactly enough credits (balance == cost)", () => {
    // 5 remaining, cost 5 → plan-only charge, 0 remaining after.
    const split = planConsumeSplit(freshSub({ creditsLimit: 5 }), 5);
    assert.ok(split, "expected a split decision");
    assert.equal(split!.source, "plan");
    assert.equal(split!.fromPlan, 5);
    assert.equal(split!.remaining, 0);
  });

  it("at balance == cost-1 the split is null (insufficient — no debit decision)", () => {
    // limit 5, used 1 ⇒ 4 remaining; cost 5 ⇒ remaining (4) == cost-1.
    const split = planConsumeSplit(
      freshSub({ creditsUsed: 1, creditsLimit: 5 }),
      5
    );
    assert.equal(split, null);
  });

  it("the decision flips to a charge the moment one more credit is available", () => {
    // used 0, limit 5, cost 5 ⇒ exactly affordable.
    assert.ok(
      planConsumeSplit(freshSub({ creditsUsed: 0, creditsLimit: 5 }), 5)
    );
    // used 1 ⇒ only 4 remaining ⇒ null.
    assert.equal(
      planConsumeSplit(freshSub({ creditsUsed: 1, creditsLimit: 5 }), 5),
      null
    );
  });

  it("the charge amount is the FULL cost (increment-based), independent of prior usage", () => {
    // Whatever the starting used value, the decided fromPlan equals the cost —
    // it is the `increment` the atomic updateMany applies, never an absolute
    // 'set to limit-cost'. Two such charges from used 0 would debit 2 then 2.
    const a = planConsumeSplit(
      freshSub({ creditsUsed: 0, creditsLimit: 10 }),
      2
    );
    assert.equal(a!.fromPlan, 2);
    const b = planConsumeSplit(
      freshSub({ creditsUsed: 2, creditsLimit: 10 }),
      2
    );
    assert.equal(b!.fromPlan, 2); // same increment, not a clobbering absolute write
  });

  it("never decides a charge that exceeds the available balance (fail-closed input)", () => {
    // plan 1 + pack 1 = 2 total, cost 5 → null (the caller must reject, never
    // grant the action without a debit).
    const split = planConsumeSplit(
      freshSub({
        creditsUsed: 4,
        creditsLimit: 5,
        packCreditsUsed: 0,
        packCreditsLimit: 1,
      }),
      5
    );
    assert.equal(split, null);
  });

  it("splits across plan then pack without ever over-drawing either pool", () => {
    // plan 2 remaining + pack 10 remaining, cost 5 → 2 plan + 3 pack.
    const split = planConsumeSplit(
      freshSub({ creditsUsed: 3, creditsLimit: 5, packCreditsLimit: 10 }),
      5
    );
    assert.deepEqual(split, {
      source: "pack",
      fromPlan: 2,
      fromPack: 3,
      remaining: 7,
    });
  });
});
