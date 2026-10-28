/**
 * Credit pure-logic helpers (service layer).
 *
 * Side-effect-free credit math + validation used by the LIVE billing path:
 *   - `credit.service.ts`            (balance compute, has-enough check,
 *                                     plan/pack consume split, refund clamping)
 *   - `credit-reservation.service.ts`(reserve guard, commit/refund state
 *                                     machine, completion-ratio refund math)
 *
 * They are isolated here (away from the Prisma-importing services) so they can
 * be unit-tested without pulling in the Prisma client at import time, and —
 * critically — so the LIVE money path runs the SAME non-finite-guarded,
 * double-spend-safe math the tests assert. This is REAL MONEY + ACCESS
 * CONTROL: a single `NaN`/`Infinity` cost or a check-then-write race must never
 * corrupt a balance, drive it negative, grant free credits, or double-spend.
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts` and the
 * clamp precedent in `./notifications-pagination.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (local copy — same contract as dashboard-logic#finite)
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Credit columns are integer balances that feed `increment`/`decrement` writes
 * and `>= cost` gates. A stored or caller-supplied `NaN`/`±Infinity` would:
 *   - write `NaN` into a balance column (`increment: NaN`) → permanent corruption,
 *   - make `Infinity >= cost` pass the affordability gate with no real credits,
 *   - make every `NaN >= cost` / `NaN < cost` comparison false (silent skip).
 * Every value that enters a balance computation, a `>= cost` comparison, or an
 * `increment`/`decrement` is funnelled through this guard first.
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate + normalise a credit COST/AMOUNT that the user is about to be
 * charged (or refunded). A cost must be a finite, non-negative number. NaN /
 * ±Infinity / negative are rejected so they can never reach a balance write or
 * an affordability gate. The integer truncation matches the `Int` schema
 * columns (`creditsUsed`, `packCreditsUsed`, `comprehensiveCreditsUsed`).
 *
 * Returns the normalised non-negative integer, or `null` when the input is
 * unusable (caller must reject, not silently coerce a bad charge to 0 unless
 * 0 is itself a valid free action — that decision belongs to the caller).
 */
export function normalizeCost(value: number | null | undefined): number | null {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) return null;
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Balance computation (credit.service.getCreditBalance / checkCredits)
// ---------------------------------------------------------------------------

export interface SubscriptionCreditSnapshot {
  creditsUsed: number;
  creditsLimit: number;
  packCreditsUsed: number;
  packCreditsLimit: number;
}

export interface CreditBalanceParts {
  /** Remaining plan credits (never negative). */
  plan: number;
  /** Remaining pack credits (never negative). */
  pack: number;
  /** plan + pack. */
  total: number;
}

/**
 * Compute remaining plan/pack/total credits from a (possibly drifted) snapshot.
 *
 * `effectivePlanLimit` lets the caller override a stale stored `creditsLimit`
 * with the plan-config source of truth (`getCreditBalance` does
 * `max(planConfigLimit, storedLimit)`); when omitted the snapshot's own
 * `creditsLimit` is used. Each remaining is floored at 0 so a `used > limit`
 * row (drift / migration) can never report a NEGATIVE remaining that would let
 * a later subtraction underflow. Every field is finite-guarded so a corrupt
 * stored column can't surface `₹NaN`-style balances to the UI or, worse, pass
 * an affordability check.
 */
export function computeCreditBalance(
  snapshot: SubscriptionCreditSnapshot,
  effectivePlanLimit?: number,
): CreditBalanceParts {
  const planLimit = finite(
    effectivePlanLimit !== undefined
      ? effectivePlanLimit
      : snapshot.creditsLimit,
  );
  const plan = Math.max(0, planLimit - finite(snapshot.creditsUsed));
  const pack = Math.max(
    0,
    finite(snapshot.packCreditsLimit) - finite(snapshot.packCreditsUsed),
  );
  return { plan, pack, total: plan + pack };
}

/**
 * Does the snapshot hold AT LEAST `cost` total (plan+pack) credits?
 *
 * Guards the affordability gate against a non-finite cost: a `NaN` cost makes
 * the naive `total >= cost` comparison FALSE (so it would wrongly deny) and an
 * `Infinity` cost would always deny — but a non-finite cost is a programming
 * error, never an affordable action, so we treat any unusable cost as NOT
 * allowed (fail closed). A normalised 0 cost is always allowed (free action).
 */
export function hasEnoughCredits(
  snapshot: SubscriptionCreditSnapshot,
  cost: number,
  effectivePlanLimit?: number,
): { allowed: boolean; remaining: number; cost: number } {
  const normalized = normalizeCost(cost);
  const { total } = computeCreditBalance(snapshot, effectivePlanLimit);
  if (normalized === null) {
    // Non-finite / negative cost → fail closed.
    return { allowed: false, remaining: total, cost: finite(cost) };
  }
  return { allowed: total >= normalized, remaining: total, cost: normalized };
}

// ---------------------------------------------------------------------------
// Consume split (credit.service.consumeCredits)
// ---------------------------------------------------------------------------

export type CreditSource = "plan" | "pack";

export interface ConsumePlan {
  /** Where the (majority of the) charge lands. */
  source: CreditSource;
  /** Credits taken from the plan pool this charge. */
  fromPlan: number;
  /** Credits taken from the pack pool this charge. */
  fromPack: number;
  /** Total remaining (plan+pack) AFTER this charge lands. */
  remaining: number;
}

/**
 * Decide how a `cost` charge splits across the plan pool then the pack pool,
 * given the snapshot the caller costed from. Plan credits are consumed first,
 * pack credits cover any shortfall. Returns `null` when the snapshot cannot
 * cover the cost (caller must reject — NEVER grant the action without a debit)
 * or when the cost is non-finite/negative.
 *
 * This is the pure decision the atomic `updateMany` charges encode: a `null`
 * here is exactly the `INSUFFICIENT_CREDITS` branch; a non-null `fromPlan` /
 * `fromPack` are the `increment` amounts the conditional writes apply. Keeping
 * it pure lets the test assert the split math (incl. the plan→pack boundary)
 * independently of Prisma, while the service still drives the real writes.
 */
export function planConsumeSplit(
  snapshot: SubscriptionCreditSnapshot,
  cost: number,
): ConsumePlan | null {
  const normalized = normalizeCost(cost);
  if (normalized === null) return null;

  const { plan: planRemaining, pack: packRemaining } =
    computeCreditBalance(snapshot);

  if (planRemaining + packRemaining < normalized) return null;

  if (planRemaining >= normalized) {
    return {
      source: "plan",
      fromPlan: normalized,
      fromPack: 0,
      remaining: planRemaining - normalized + packRemaining,
    };
  }

  const fromPack = normalized - planRemaining;
  return {
    source: "pack",
    fromPlan: planRemaining,
    fromPack,
    remaining: packRemaining - fromPack,
  };
}

// ---------------------------------------------------------------------------
// Refund split (credit.service.refundCredits)
// ---------------------------------------------------------------------------

export interface RefundPlan {
  /** Credits returned to the plan pool (reduces `creditsUsed`). */
  toPlan: number;
  /** Credits returned to the pack pool (reduces `packCreditsUsed`). */
  toPack: number;
  /** Total credits actually refunded (toPlan + toPack). */
  refunded: number;
}

/**
 * Decide how a `amount` refund splits back across plan then pack, clamped so a
 * refund can NEVER exceed what was actually consumed.
 *
 * Refund-side mirror of the consume bug class:
 *   - a non-finite / negative `amount` is rejected (returns `null`) so it can't
 *     write `NaN`/a negative `increment` into a balance column (the live bug:
 *     `Math.max(0, used - NaN)` === NaN corrupted the column);
 *   - `toPlan` is capped at `creditsUsed` and `toPack` at `packCreditsUsed`, so
 *     an over-large `amount` (a caller passing 9999, or a cost larger than the
 *     debit) refunds AT MOST the real outstanding debit — it can't mint free
 *     credits by driving `*Used` below zero.
 *
 * Plan is refunded first (reverse of consumption order), then pack covers the
 * remainder — but only up to each pool's real outstanding usage.
 */
export function refundSplit(
  snapshot: Pick<SubscriptionCreditSnapshot, "creditsUsed" | "packCreditsUsed">,
  amount: number,
): RefundPlan | null {
  const normalized = normalizeCost(amount);
  if (normalized === null) return null;

  const planUsed = Math.max(0, finite(snapshot.creditsUsed));
  const packUsed = Math.max(0, finite(snapshot.packCreditsUsed));

  // Plan first, capped at what plan actually owes.
  const toPlan = Math.min(normalized, planUsed);
  // Pack covers the remainder, capped at what pack actually owes. The overall
  // refund is therefore clamped to (planUsed + packUsed) — never more than the
  // real outstanding debit.
  const remainder = normalized - toPlan;
  const toPack = Math.min(remainder, packUsed);

  return { toPlan, toPack, refunded: toPlan + toPack };
}

// ---------------------------------------------------------------------------
// Reservation: availability guard (credit-reservation.reserveCredits)
// ---------------------------------------------------------------------------

export interface ComprehensiveCreditSnapshot {
  comprehensiveCreditsUsed: number;
  comprehensiveCreditsLimit: number;
}

/**
 * Compute remaining comprehensive credits (floored at 0, finite-guarded).
 */
export function computeComprehensiveAvailable(
  snapshot: ComprehensiveCreditSnapshot,
): number {
  return Math.max(
    0,
    finite(snapshot.comprehensiveCreditsLimit) -
      finite(snapshot.comprehensiveCreditsUsed),
  );
}

export interface ReservationCheck {
  ok: boolean;
  available: number;
  /** Normalised credits the reservation would debit (0 when invalid). */
  credits: number;
  /** Why it failed, when `ok` is false. */
  reason?: "invalid_amount" | "insufficient";
}

/**
 * Validate a reservation request against the live comprehensive balance.
 *
 * Returns the pure decision the atomic reserve encodes:
 *   - rejects a non-finite / negative / zero `credits` request as
 *     `invalid_amount` (a negative `credits` previously slipped through
 *     `available < credits` and `increment: credits` DECREMENTED used → minted
 *     free credits + created a reservation that could be committed/refunded);
 *   - rejects when `credits > available` as `insufficient`.
 *
 * The service uses this BEFORE its guarded `updateMany`, and the guard
 * (`comprehensiveCreditsUsed <= limit - credits`) re-asserts the same threshold
 * atomically at write time to stop the check-then-write double-spend.
 */
export function checkReservationRequest(
  snapshot: ComprehensiveCreditSnapshot,
  credits: number,
): ReservationCheck {
  const normalized = normalizeCost(credits);
  const available = computeComprehensiveAvailable(snapshot);
  // A reservation must debit a POSITIVE amount; 0 (or invalid) is not a
  // reservation.
  if (normalized === null || normalized <= 0) {
    return { ok: false, available, credits: 0, reason: "invalid_amount" };
  }
  if (normalized > available) {
    return {
      ok: false,
      available,
      credits: normalized,
      reason: "insufficient",
    };
  }
  return { ok: true, available, credits: normalized };
}

/**
 * Compute a reservation's expiry `ttlMs` from `now`, defaulting to 30 minutes.
 * Guards a non-finite `now`/`ttlMs` (which would yield an Invalid Date that
 * later breaks `expiresAt < new Date()` cleanup comparisons) by falling back to
 * a valid 30-minute window from the current time.
 */
export function computeReservationExpiry(
  now: number = Date.now(),
  ttlMs: number = 30 * 60 * 1000,
): Date {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30 * 60 * 1000;
  return new Date(safeNow + safeTtl);
}

// ---------------------------------------------------------------------------
// Reservation: commit / refund state machine
// ---------------------------------------------------------------------------

export type ReservationStatus =
  | "RESERVED"
  | "ACTIVE"
  | "COMMITTED"
  | "REFUNDED"
  | "EXPIRED";

/**
 * Is a reservation in a state from which it may be COMMITTED?
 * Only a still-open reservation (RESERVED/ACTIVE) commits — a COMMITTED one
 * must not be committed twice, and a REFUNDED/EXPIRED one is terminal.
 */
export function canCommitReservation(status: string): boolean {
  return status === "RESERVED" || status === "ACTIVE";
}

/**
 * Is a reservation in a state from which it may be REFUNDED?
 * A COMMITTED reservation is terminal (its credits were earned — refunding
 * would mint free credits: the "committed-then-released" exploit). A REFUNDED
 * one must not be refunded twice. Only RESERVED/ACTIVE/EXPIRED-but-unsettled
 * states refund; the live service treats EXPIRED via its own cleanup path, so
 * here we mirror its guard exactly: block REFUNDED and COMMITTED.
 */
export function canRefundReservation(status: string): boolean {
  return status !== "REFUNDED" && status !== "COMMITTED";
}

/**
 * Compute the proportional refund for a partially-completed analysis, clamped.
 *
 * `creditsToRefund = floor(creditsReserved × (1 − completionRatio))` where
 * `completionRatio = completed/total`, but with hard guards the live formula
 * lacked:
 *   - `creditsReserved` finite-guarded (a corrupt reservation row can't write
 *     `decrement: NaN`);
 *   - `completionRatio` clamped to [0, 1]: a `completed > total` ratio would go
 *     negative-refund (handled), but a NEGATIVE `completed` (or non-finite
 *     segment counts) drove the ratio < 0 so `(1 − ratio) > 1` and the refund
 *     EXCEEDED `creditsReserved` — decrementing `comprehensiveCreditsUsed`
 *     below this reservation's contribution = free credits;
 *   - result floored at [0, creditsReserved] so a refund is never negative and
 *     never larger than what was reserved.
 *
 * Returns the integer credits to refund (0 ⇒ caller should commit instead of
 * refunding, matching the live "completed enough to not warrant a refund"
 * branch).
 */
export function computeReservationRefund(
  creditsReserved: number,
  completedSegments: number,
  totalSegments: number,
): number {
  const reserved = Math.max(0, finite(creditsReserved));
  const completed = finite(completedSegments);
  const total = finite(totalSegments);

  const rawRatio = total > 0 ? completed / total : 0;
  // Clamp the completion ratio into [0, 1]; a non-finite ratio collapses to 0
  // (treat as "nothing completed" → full refund, never an over-refund).
  const ratio = Number.isFinite(rawRatio)
    ? Math.min(1, Math.max(0, rawRatio))
    : 0;

  const refund = Math.floor(reserved * (1 - ratio));
  // Never negative, never more than was reserved.
  return Math.min(reserved, Math.max(0, refund));
}

// ── Subscription self-heal (MONEY-295) ─────────────────────────────

/** The existing-subscription fields the self-heal decision reads. */
export interface SubscriptionHealInput {
  planId: string;
  status: string;
  creditsLimit: number | null;
}

/**
 * The patch to apply (only the fields that need healing are present). `status`
 * is the literal "ACTIVE" — the only value the heal ever writes — so the patch
 * is assignable straight into Prisma's `subscription.update` data (a bare
 * `string` is not, since Prisma's status column is the SubscriptionStatus enum).
 */
export interface SubscriptionHealPatch {
  creditsLimit?: number;
  status?: "ACTIVE";
}

export interface SubscriptionHealDecision {
  needsCreditsHeal: boolean;
  needsStatusHeal: boolean;
  patch: SubscriptionHealPatch;
}

/**
 * Pure self-heal decision for `ensureSubscription`. Two drifts are repaired:
 *   1. creditsLimit below the plan's expected credits (only when expected > 0);
 *   2. a FREE plan stuck in a non-ACTIVE status — FREE has no payment to lapse,
 *      so CANCELLED/EXPIRED/PAUSED is stale state from a prior paid plan that
 *      didn't reset on downgrade, and it locks the user out of free-tier
 *      features (MONEY-295). Paid plans may legitimately lapse, so they are not
 *      status-healed.
 *
 * `expectedCredits` is passed in (the service supplies `getPlanCredits(planId)`)
 * so this stays free of the core plan-config dependency. The service CALLS this;
 * the test asserts it — no shadow.
 */
export function decideSubscriptionHeal(
  existing: SubscriptionHealInput,
  expectedCredits: number,
): SubscriptionHealDecision {
  const needsCreditsHeal =
    expectedCredits > 0 && (existing.creditsLimit ?? 0) < expectedCredits;

  const needsStatusHeal =
    existing.planId === "FREE" && existing.status !== "ACTIVE";

  const patch: SubscriptionHealPatch = {};
  if (needsCreditsHeal) patch.creditsLimit = expectedCredits;
  if (needsStatusHeal) patch.status = "ACTIVE";

  return { needsCreditsHeal, needsStatusHeal, patch };
}
