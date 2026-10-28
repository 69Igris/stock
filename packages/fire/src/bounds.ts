/* =====================================================================
   FIRE plan input bounds — SINGLE SOURCE OF TRUTH  (MONEY-1049)
   ---------------------------------------------------------------------
   One canonical range per numeric plan input, shared by the THREE places
   that must agree so they can never drift:

     1. the Plan-inputs sliders (PlanInputsPanel.tsx) — `min`/`max`
     2. the Gemini tool schema (chat/tools.ts) — the "N–M" hints
     3. the chat tool executor (chat/toolExecutor.ts) — the hard clamp

   The sliders enforce these bounds by construction (you can't drag past
   the ends). The chat can't: Gemini emits raw numbers, so without a clamp
   "set my retirement age to 5" or "corpus -5 lakh" flow straight into the
   projection math. Clamping in the executor makes the chat honour exactly
   the same limits the sliders do.

   Cross-field ordering (retire > current, life > retire) is deliberately
   NOT enforced here: those invariants span multiple fields and multiple
   tool calls, so per-call rejection would wrongly drop a value when the
   model legitimately BATCHES the fixes (e.g. setCurrentAge 50 + setRetire
   55 in one turn). The projection is NaN-safe under a temporary inversion
   (maxYears is floored at 40, yearsLeft at 0), and the ordering rule lives
   in the system prompt where the model sees the whole sentence.
   ===================================================================== */

export interface Bound {
  readonly min: number;
  readonly max: number;
}

/**
 * Canonical numeric ranges. Slider-backed fields (lifeExpectancy, the four
 * percent assumptions) mirror the exact slider `min`/`max`; the free-text
 * number inputs (ages, corpus, savings) — which the UI itself leaves
 * unbounded — get sane domain limits that keep the math well-defined.
 */
export const FIRE_BOUNDS = {
  currentAge: { min: 15, max: 100 },
  retirementAge: { min: 20, max: 100 },
  lifeExpectancy: { min: 70, max: 150 }, // ← "Life expectancy" slider
  currentCorpus: { min: 0, max: 1_000_00_00_000 }, // ≥ 0; ~₹1000 Cr ceiling
  monthlySavings: { min: 0, max: 100_00_00_000 }, // ≥ 0; ~₹100 Cr/mo ceiling
  withdrawalRate: { min: 2, max: 25 }, // ← "Withdrawal rate" slider
  taxRate: { min: 0, max: 100 }, // ← "Effective tax rate" slider
  salaryIncrement: { min: 0, max: 100 }, // ← "Salary increment" slider
  savingsIncrement: { min: 0, max: 100 }, // ← "SIP step-up" slider
  allocation: { min: 0, max: 100 },
  expectedReturn: { min: -20, max: 100 },
  expenseAmount: { min: 0, max: 100_00_00_000 },
  goalCost: { min: 0, max: 1_000_00_00_000 },
  inflation: { min: -20, max: 100 },
  yearsAway: { min: 0, max: 100 },
} as const satisfies Record<string, Bound>;

export type FireBoundKey = keyof typeof FIRE_BOUNDS;

/** Clamp `n` into a bound. */
export function clamp(n: number, b: Bound): number {
  return Math.min(b.max, Math.max(b.min, n));
}
