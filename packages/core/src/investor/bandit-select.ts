/**
 * Outcome-bandit DB seam (MONEY-791, B6).
 *
 * The pure bandit math lives in `./bandit.ts` (no I/O). This module is the thin
 * prisma-backed edge that the synthesizer / chat layer COULD call to pick which
 * explanation FRAMING to use for a user: it reads that user's recent
 * `ResultFeedback` (👍/👎), buckets each row by its `metadata.variantId` tag,
 * computes per-variant win-rates, primes the bandit with informed Beta priors,
 * and returns the selected variant id.
 *
 * Contract (load-bearing, mirrors `context.ts#assembleUserContext`): gated on
 * `DATABASE_URL`, NEVER throws, and returns a sensible default
 * ({@link DEFAULT_VARIANT_ID} = "detailed") whenever there is no data, no DB, or
 * anything goes wrong. Framing is a nice-to-have — it must never break the
 * caller.
 *
 * SERVER-ONLY (imports prisma). Import from the
 * `@usemoney/core/investor/bandit-select` subpath — never the `@usemoney/core`
 * or `@usemoney/core/investor` barrel from client code. The pure helpers stay in
 * `@usemoney/core/investor/bandit`.
 */

import { prisma } from "@usemoney/database";
import {
  DEFAULT_VARIANT_ID,
  EXPLANATION_VARIANTS,
  computeVariantWinRates,
  priorsFromWinRates,
  selectVariant,
  type OutcomeRow,
  type Rng,
} from "./bandit";

/** How many recent feedback rows to read when priming the bandit. */
const FEEDBACK_LOOKBACK = 200;

/** Pull a string `variantId` out of a `ResultFeedback.metadata` JSON blob. */
function readVariantId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const v = (metadata as Record<string, unknown>).variantId;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The metadata blob a `ResultFeedback` row carries to feed the outcome loop.
 * `variantId` is the arm that produced the rated answer; `outcome` is the binary
 * reward the bandit reads (👍 → success, 👎 → failure). One row == one outcome,
 * so {@link pickExplanationVariant} recovers per-variant win/impression counts by
 * simply counting these tagged rows — there is no separate counter to mutate.
 */
export interface VariantOutcomeMetadata {
  variantId: string;
  outcome: "UP" | "DOWN";
}

/**
 * Build the metadata patch that records ONE bandit outcome onto a feedback row
 * (MONEY-800, B6). PURE — no I/O: the caller (the `submitResultFeedbackAction`
 * server action) merges this onto the row's `metadata` JSON when it persists the
 * 👍/👎. Because each row is exactly one tagged outcome, persisting the
 * `variantId` IS the count bump the bandit reads on its next selection pass.
 *
 * Returns `undefined` when there is no `variantId` to record (the answer was not
 * produced under a bandit arm) — the caller then writes no bandit metadata.
 *
 * @param variantId the arm that produced the rated answer (echoed by the client
 *   from the assistant message metadata).
 * @param rating    the thumbs rating the user just submitted.
 * @param existing  any metadata already on the row (preserved + extended).
 */
export function recordVariantOutcome(
  variantId: string | undefined,
  rating: "UP" | "DOWN",
  existing?: unknown,
): (Record<string, unknown> & VariantOutcomeMetadata) | undefined {
  const id = typeof variantId === "string" ? variantId.trim() : "";
  if (!id) return undefined;
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, variantId: id, outcome: rating };
}

/**
 * Pick the explanation-framing variant for a user, primed from their real
 * 👍/👎 win-rates per variant.
 *
 * - When `userId` is omitted, the win-rates are computed GLOBALLY (across all
 *   users) — a reasonable cold-start prior for a brand-new user.
 * - When supplied, only that user's feedback is used.
 *
 * Best-effort: returns {@link DEFAULT_VARIANT_ID} on no-DB / no-data / any error.
 * An optional `rng` flips selection from the deterministic argmax (default) to
 * epsilon-greedy exploration, so callers can keep exploring under-tried framings
 * (and tests stay deterministic by injecting a fixed rng).
 */
export async function pickExplanationVariant(
  userId?: string,
  rng?: Rng,
): Promise<string> {
  if (!process.env.DATABASE_URL) return DEFAULT_VARIANT_ID;

  try {
    const feedback = await prisma.resultFeedback.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: "desc" },
      take: FEEDBACK_LOOKBACK,
      select: { rating: true, metadata: true },
    });

    // Keep only rows that carry a variant tag; the rest hold no arm signal.
    const rows: OutcomeRow[] = [];
    for (const f of feedback) {
      const variantId = readVariantId(f.metadata);
      if (!variantId) continue;
      rows.push({
        variantId,
        // `rating` is the Prisma `ResultFeedbackRating` enum ("UP" | "DOWN").
        outcome: f.rating === "UP" ? "UP" : "DOWN",
      });
    }

    // No tagged feedback yet ⇒ stick with the safe default framing.
    if (rows.length === 0) return DEFAULT_VARIANT_ID;

    const winRates = computeVariantWinRates(rows);
    const priors = priorsFromWinRates(winRates);
    return selectVariant(
      EXPLANATION_VARIANTS,
      priors,
      rng ? { rng, strategy: "epsilon-greedy" } : {},
    );
  } catch (err) {
    // NEVER break the caller — framing is a nice-to-have on the answer.
    console.warn("UseMoney: pickExplanationVariant failed", err);
    return DEFAULT_VARIANT_ID;
  }
}
