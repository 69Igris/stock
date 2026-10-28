/**
 * MONEY-620 — credit-logic.ts pure helpers (REAL exports, no shadow).
 *
 * This is the unit layer for the LIVE credits/billing math + state machine that
 * `packages/services/src/credit.service.ts` and
 * `packages/services/src/credit-reservation.service.ts` CALL. It imports the
 * REAL exported symbols via a relative path (the modules are pure — no Prisma /
 * Redis at import time) and feeds adversarial fixtures: NaN / ±Infinity /
 * negative / over-large amounts, plan→pack split boundaries, and every
 * reservation-lifecycle transition.
 *
 * It is the SECURITY contract for: non-finite cost can't bypass the `>= cost`
 * gate or corrupt a balance; a refund can't exceed the original debit; a
 * negative reservation can't mint free credits; a committed reservation can't
 * be released; a partial-refund ratio can't over-refund.
 *
 * The companion file `credit-services-security-e2e.test.ts` drives the REAL
 * services (recording prisma) to prove these helpers are wired into the live
 * Prisma where-clauses / writes.
 *
 * Source: packages/services/src/credit-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  normalizeCost,
  computeCreditBalance,
  hasEnoughCredits,
  planConsumeSplit,
  refundSplit,
  computeComprehensiveAvailable,
  checkReservationRequest,
  computeReservationExpiry,
  canCommitReservation,
  canRefundReservation,
  computeReservationRefund,
  type SubscriptionCreditSnapshot,
} from "../../../../packages/services/src/credit-logic";

// ── finite() ────────────────────────────────────────────────────────────────

describe("credit-logic.finite", () => {
  it("passes finite numbers through unchanged (incl. negatives & zero)", () => {
    assert.equal(finite(5), 5);
    assert.equal(finite(0), 0);
    assert.equal(finite(-3), -3);
    assert.equal(finite(1.5), 1.5);
  });

  it("collapses NaN / ±Infinity / null / undefined to the fallback (default 0)", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN, 7), 7);
  });
});

// ── normalizeCost() ──────────────────────────────────────────────────────────

describe("credit-logic.normalizeCost", () => {
  it("accepts a finite non-negative number, truncating to an integer", () => {
    assert.equal(normalizeCost(0), 0);
    assert.equal(normalizeCost(5), 5);
    assert.equal(normalizeCost(2.9), 2); // truncates toward zero (Int column)
  });

  it("REJECTS NaN / ±Infinity (would corrupt a balance write / gate)", () => {
    assert.equal(normalizeCost(NaN), null);
    assert.equal(normalizeCost(Infinity), null);
    assert.equal(normalizeCost(-Infinity), null);
  });

  it("REJECTS a negative cost (a 'negative charge' is nonsensical)", () => {
    assert.equal(normalizeCost(-1), null);
    assert.equal(normalizeCost(-0.0001), null);
  });

  it("REJECTS null / undefined / non-number", () => {
    assert.equal(normalizeCost(null), null);
    assert.equal(normalizeCost(undefined), null);
  });
});

// ── computeCreditBalance() ───────────────────────────────────────────────────

const snap = (
  o: Partial<SubscriptionCreditSnapshot> = {}
): SubscriptionCreditSnapshot => ({
  creditsUsed: 0,
  creditsLimit: 5,
  packCreditsUsed: 0,
  packCreditsLimit: 0,
  ...o,
});

describe("credit-logic.computeCreditBalance", () => {
  it("computes plan/pack/total remaining from a clean snapshot", () => {
    const b = computeCreditBalance(
      snap({
        creditsUsed: 2,
        creditsLimit: 5,
        packCreditsUsed: 1,
        packCreditsLimit: 10,
      })
    );
    assert.equal(b.plan, 3);
    assert.equal(b.pack, 9);
    assert.equal(b.total, 12);
  });

  it("floors a `used > limit` drift row at 0 (never negative remaining)", () => {
    const b = computeCreditBalance(snap({ creditsUsed: 9, creditsLimit: 5 }));
    assert.equal(b.plan, 0); // not -4
    assert.equal(b.total, 0);
  });

  it("honours an effective plan-limit override (plan-config source of truth)", () => {
    // stored limit 5 but plan config says 50 → 50 - used 2 = 48.
    const b = computeCreditBalance(
      snap({ creditsUsed: 2, creditsLimit: 5 }),
      50
    );
    assert.equal(b.plan, 48);
  });

  it("finite-guards a corrupt stored column (no NaN balance)", () => {
    const b = computeCreditBalance(
      snap({
        creditsUsed: NaN,
        creditsLimit: 5,
        packCreditsUsed: 0,
        packCreditsLimit: Infinity,
      })
    );
    assert.ok(Number.isFinite(b.plan));
    assert.ok(Number.isFinite(b.pack));
    assert.ok(Number.isFinite(b.total));
    assert.equal(b.plan, 5); // NaN used → 0 → 5-0
    assert.equal(b.pack, 0); // Infinity limit → 0
  });
});

// ── hasEnoughCredits() ───────────────────────────────────────────────────────

describe("credit-logic.hasEnoughCredits", () => {
  it("allows when total >= cost (boundary: total == cost)", () => {
    const r = hasEnoughCredits(snap({ creditsLimit: 5 }), 5);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 5);
    assert.equal(r.cost, 5);
  });

  it("denies at total == cost-1 (off-by-one boundary)", () => {
    const r = hasEnoughCredits(snap({ creditsUsed: 1, creditsLimit: 5 }), 5); // 4 remaining
    assert.equal(r.allowed, false);
  });

  it("allows a zero cost (free action)", () => {
    const r = hasEnoughCredits(snap({ creditsUsed: 5, creditsLimit: 5 }), 0);
    assert.equal(r.allowed, true);
  });

  it("FAILS CLOSED on a non-finite cost (Infinity must NOT pass via Infinity>=cost)", () => {
    // The naive `total >= Infinity` is false anyway, but NaN >= total is ALSO
    // false — assert both are denied, never allowed.
    assert.equal(
      hasEnoughCredits(snap({ creditsLimit: 1000000 }), Infinity).allowed,
      false
    );
    assert.equal(
      hasEnoughCredits(snap({ creditsLimit: 1000000 }), NaN).allowed,
      false
    );
  });

  it("FAILS CLOSED on a negative cost", () => {
    assert.equal(
      hasEnoughCredits(snap({ creditsLimit: 5 }), -1).allowed,
      false
    );
  });

  it("counts pack credits toward affordability", () => {
    const r = hasEnoughCredits(
      snap({
        creditsUsed: 5,
        creditsLimit: 5,
        packCreditsUsed: 0,
        packCreditsLimit: 10,
      }),
      8
    );
    assert.equal(r.allowed, true); // 0 plan + 10 pack >= 8
    assert.equal(r.remaining, 10);
  });
});

// ── planConsumeSplit() ───────────────────────────────────────────────────────

describe("credit-logic.planConsumeSplit", () => {
  it("charges plan-only when plan covers the cost", () => {
    const s = planConsumeSplit(snap({ creditsLimit: 5 }), 3);
    assert.deepEqual(s, {
      source: "plan",
      fromPlan: 3,
      fromPack: 0,
      remaining: 2,
    });
  });

  it("charges the exact plan balance (boundary: planRemaining == cost)", () => {
    const s = planConsumeSplit(snap({ creditsLimit: 5 }), 5);
    assert.deepEqual(s, {
      source: "plan",
      fromPlan: 5,
      fromPack: 0,
      remaining: 0,
    });
  });

  it("splits plan→pack when plan is short (maxes plan, rest from pack)", () => {
    // plan 2 remaining, pack 10 remaining, cost 5 → 2 from plan + 3 from pack.
    const s = planConsumeSplit(
      snap({ creditsUsed: 3, creditsLimit: 5, packCreditsLimit: 10 }),
      5
    );
    assert.deepEqual(s, {
      source: "pack",
      fromPlan: 2,
      fromPack: 3,
      remaining: 7,
    });
  });

  it("uses pack-only when plan is exhausted", () => {
    const s = planConsumeSplit(
      snap({ creditsUsed: 5, creditsLimit: 5, packCreditsLimit: 10 }),
      4
    );
    assert.deepEqual(s, {
      source: "pack",
      fromPlan: 0,
      fromPack: 4,
      remaining: 6,
    });
  });

  it("returns null when neither pool can cover the cost (double-spend guard input)", () => {
    // plan 1 + pack 1 = 2 < cost 3 → null (caller must reject, never grant).
    const s = planConsumeSplit(
      snap({
        creditsUsed: 4,
        creditsLimit: 5,
        packCreditsUsed: 0,
        packCreditsLimit: 1,
      }),
      3
    );
    assert.equal(s, null);
  });

  it("returns null for a non-finite / negative cost (never debits NaN)", () => {
    assert.equal(planConsumeSplit(snap({ creditsLimit: 100 }), NaN), null);
    assert.equal(planConsumeSplit(snap({ creditsLimit: 100 }), Infinity), null);
    assert.equal(planConsumeSplit(snap({ creditsLimit: 100 }), -5), null);
  });

  it("does not let an Infinity balance column fake affordability", () => {
    // A corrupt Infinity limit collapses to 0 via finite(), so the cost is NOT
    // covered — the split returns null rather than 'affording' via Infinity.
    const s = planConsumeSplit(
      snap({ creditsUsed: 0, creditsLimit: Infinity }),
      10
    );
    assert.equal(s, null);
  });
});

// ── refundSplit() — the over-refund / NaN-corruption fix ─────────────────────

describe("credit-logic.refundSplit", () => {
  it("refunds plan first up to what plan owes", () => {
    const r = refundSplit({ creditsUsed: 5, packCreditsUsed: 0 }, 3);
    assert.deepEqual(r, { toPlan: 3, toPack: 0, refunded: 3 });
  });

  it("spills the remainder to pack, capped at pack usage", () => {
    // plan owes 2, pack owes 10; refund 5 → 2 plan + 3 pack.
    const r = refundSplit({ creditsUsed: 2, packCreditsUsed: 10 }, 5);
    assert.deepEqual(r, { toPlan: 2, toPack: 3, refunded: 5 });
  });

  it("CLAMPS an over-large refund to the real outstanding debit (no free credits)", () => {
    // user owes 2 plan + 1 pack = 3, but a caller asks to refund 9999.
    const r = refundSplit({ creditsUsed: 2, packCreditsUsed: 1 }, 9999);
    assert.deepEqual(r, { toPlan: 2, toPack: 1, refunded: 3 }); // never 9999
  });

  it("refunds nothing when nothing was consumed", () => {
    const r = refundSplit({ creditsUsed: 0, packCreditsUsed: 0 }, 5);
    assert.deepEqual(r, { toPlan: 0, toPack: 0, refunded: 0 });
  });

  it("REJECTS a NaN amount (the live bug: Math.max(0, used-NaN)===NaN corrupted the column)", () => {
    assert.equal(
      refundSplit({ creditsUsed: 5, packCreditsUsed: 5 }, NaN),
      null
    );
  });

  it("REJECTS ±Infinity and negative amounts", () => {
    assert.equal(
      refundSplit({ creditsUsed: 5, packCreditsUsed: 5 }, Infinity),
      null
    );
    assert.equal(
      refundSplit({ creditsUsed: 5, packCreditsUsed: 5 }, -Infinity),
      null
    );
    assert.equal(refundSplit({ creditsUsed: 5, packCreditsUsed: 5 }, -3), null);
  });

  it("finite-guards a corrupt used column (refund bounded, never NaN)", () => {
    const r = refundSplit({ creditsUsed: NaN, packCreditsUsed: 5 }, 4);
    assert.ok(r);
    assert.ok(Number.isFinite(r!.refunded));
    // NaN plan usage → 0 plan refundable → all 4 from pack (cap 5).
    assert.deepEqual(r, { toPlan: 0, toPack: 4, refunded: 4 });
  });
});

// ── computeComprehensiveAvailable() ──────────────────────────────────────────

describe("credit-logic.computeComprehensiveAvailable", () => {
  it("computes limit - used, floored at 0", () => {
    assert.equal(
      computeComprehensiveAvailable({
        comprehensiveCreditsUsed: 3,
        comprehensiveCreditsLimit: 10,
      }),
      7
    );
    assert.equal(
      computeComprehensiveAvailable({
        comprehensiveCreditsUsed: 12,
        comprehensiveCreditsLimit: 10,
      }),
      0 // not -2
    );
  });

  it("finite-guards corrupt columns", () => {
    const a = computeComprehensiveAvailable({
      comprehensiveCreditsUsed: NaN,
      comprehensiveCreditsLimit: 10,
    });
    assert.equal(a, 10);
    assert.ok(Number.isFinite(a));
  });
});

// ── checkReservationRequest() — negative-reserve free-credit exploit fix ─────

describe("credit-logic.checkReservationRequest", () => {
  const csnap = (used: number, limit: number) => ({
    comprehensiveCreditsUsed: used,
    comprehensiveCreditsLimit: limit,
  });

  it("accepts a valid request within available credits", () => {
    const r = checkReservationRequest(csnap(0, 10), 5);
    assert.equal(r.ok, true);
    assert.equal(r.credits, 5);
    assert.equal(r.available, 10);
  });

  it("accepts the exact available balance (boundary)", () => {
    const r = checkReservationRequest(csnap(5, 10), 5);
    assert.equal(r.ok, true);
  });

  it("rejects when credits exceed available (insufficient)", () => {
    const r = checkReservationRequest(csnap(8, 10), 5);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient");
  });

  it("REJECTS a negative reserve (exploit: increment of a negative MINTED credits)", () => {
    const r = checkReservationRequest(csnap(0, 10), -5);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid_amount");
    assert.equal(r.credits, 0);
  });

  it("REJECTS a zero reserve (not a reservation)", () => {
    const r = checkReservationRequest(csnap(0, 10), 0);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid_amount");
  });

  it("REJECTS NaN / Infinity reserve amounts", () => {
    assert.equal(
      checkReservationRequest(csnap(0, 10), NaN).reason,
      "invalid_amount"
    );
    assert.equal(
      checkReservationRequest(csnap(0, 10), Infinity).reason,
      "invalid_amount"
    );
  });
});

// ── computeReservationExpiry() ───────────────────────────────────────────────

describe("credit-logic.computeReservationExpiry", () => {
  it("returns a valid Date 30 minutes out by default", () => {
    const now = 1_700_000_000_000;
    const d = computeReservationExpiry(now);
    assert.ok(d instanceof Date);
    assert.equal(d.getTime(), now + 30 * 60 * 1000);
  });

  it("honours a custom positive ttl", () => {
    const now = 1_700_000_000_000;
    const d = computeReservationExpiry(now, 60_000);
    assert.equal(d.getTime(), now + 60_000);
  });

  it("never produces an Invalid Date from a non-finite now/ttl", () => {
    // An Invalid expiry would silently break `expiresAt < new Date()` cleanup.
    assert.equal(Number.isNaN(computeReservationExpiry(NaN).getTime()), false);
    assert.equal(
      Number.isNaN(computeReservationExpiry(Date.now(), NaN).getTime()),
      false
    );
    assert.equal(
      Number.isNaN(computeReservationExpiry(Infinity, -5).getTime()),
      false
    );
  });
});

// ── canCommit / canRefund state machine ──────────────────────────────────────

describe("credit-logic reservation state machine", () => {
  it("canCommit only from RESERVED / ACTIVE", () => {
    assert.equal(canCommitReservation("RESERVED"), true);
    assert.equal(canCommitReservation("ACTIVE"), true);
    assert.equal(canCommitReservation("COMMITTED"), false); // no double-commit
    assert.equal(canCommitReservation("REFUNDED"), false);
    assert.equal(canCommitReservation("EXPIRED"), false);
  });

  it("canRefund blocks COMMITTED (committed-then-released exploit) and REFUNDED (double-refund)", () => {
    assert.equal(canRefundReservation("COMMITTED"), false);
    assert.equal(canRefundReservation("REFUNDED"), false);
    assert.equal(canRefundReservation("RESERVED"), true);
    assert.equal(canRefundReservation("ACTIVE"), true);
    assert.equal(canRefundReservation("EXPIRED"), true);
  });
});

// ── computeReservationRefund() — proportional refund clamp ───────────────────

describe("credit-logic.computeReservationRefund", () => {
  it("refunds the full reservation when nothing completed", () => {
    assert.equal(computeReservationRefund(10, 0, 6), 10);
  });

  it("refunds proportionally to remaining segments (floor)", () => {
    // reserved 10, completed 2/6 → 1 - 1/3 = 2/3 → floor(10*2/3) = 6.
    assert.equal(computeReservationRefund(10, 2, 6), 6);
  });

  it("refunds 0 when fully completed (caller commits instead)", () => {
    assert.equal(computeReservationRefund(10, 6, 6), 0);
  });

  it("treats totalSegments<=0 as 'nothing completed' → full refund", () => {
    assert.equal(computeReservationRefund(10, 5, 0), 10);
  });

  it("CLAMPS completed>total (ratio>1) to 0 refund, never negative", () => {
    assert.equal(computeReservationRefund(10, 99, 6), 0);
  });

  it("CLAMPS a NEGATIVE completed (over-refund exploit) to <= reserved", () => {
    // negative completed → ratio<0 → (1-ratio)>1 → naive refund > reserved.
    const r = computeReservationRefund(10, -50, 6);
    assert.ok(r <= 10, `refund must not exceed reserved, got ${r}`);
    assert.equal(r, 10); // clamped to full reservation, never 18
  });

  it("finite-guards non-finite segment counts (no NaN refund / decrement)", () => {
    assert.ok(Number.isFinite(computeReservationRefund(10, NaN, 6)));
    assert.ok(Number.isFinite(computeReservationRefund(10, 2, NaN)));
    assert.ok(Number.isFinite(computeReservationRefund(NaN, 2, 6)));
    // A corrupt reserved column → 0 refund (can't decrement a NaN/garbage).
    assert.equal(computeReservationRefund(NaN, 2, 6), 0);
  });

  it("never refunds more than the reserved amount for any finite input", () => {
    for (const reserved of [0, 1, 5, 40, 100]) {
      for (const completed of [-10, 0, 1, 3, 5, 50]) {
        for (const total of [0, 1, 6, 12]) {
          const r = computeReservationRefund(reserved, completed, total);
          assert.ok(r >= 0, `refund >= 0 (${reserved},${completed},${total})`);
          assert.ok(
            r <= Math.max(0, reserved),
            `refund <= reserved (${reserved},${completed},${total}) got ${r}`
          );
        }
      }
    }
  });
});
