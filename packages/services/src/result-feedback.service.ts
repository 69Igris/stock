/**
 * Result Feedback Service (MONEY-1062 P4b)
 *
 * Per-result 👍/👎 feedback on an individual AI result (a chat message, a
 * research session, or a roast), with an optional free-text comment. NEW service
 * file — the web action drove Prisma directly. Extracted from
 * apps/web/lib/actions/result-feedback.ts:
 *   :32  submitResultFeedbackAction → submitResultFeedback
 *   :129 clearResultFeedbackAction  → clearResultFeedback
 *   :151 getResultFeedbackAction    → getResultFeedback
 *
 * One row per (user, surface, refId): re-rating upserts, so a user can flip
 * 👍↔👎 or attach a comment without creating duplicates.
 *
 * PORTED FAITHFULLY — the MONEY-800 (B6) bandit OUTCOME side effect:
 *   `recordVariantOutcome(variantId, rating, metadata)` stamps the chosen arm's
 *   `variantId` + the binary thumbs outcome (👍 → success, 👎 → failure) onto the
 *   row's `metadata` JSON. Because the bandit counts one tagged row == one
 *   outcome, persisting the variantId IS the count bump it consumes on its next
 *   selection pass. When there is no arm, the un-anchored `outcome` is stripped
 *   from the caller blob (MONEY-807) so a stale copy of the rating never persists.
 *   All metadata is normalised through the same `toJsonSafe` helper the web
 *   analytics path uses.
 *
 * STRIPPED web/next glue: `getAuthenticatedUser` (route owns auth) and the
 * action's own `safeParse` (the route Zod-validates the mirror schema and passes
 * the parsed data in). IDOR: every read/write is scoped to the caller's userId.
 *
 * @see packages/services/__tests__/result-feedback-service.test.ts
 */

import { prisma, type Prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { recordVariantOutcome } from "@usemoney/core/investor/bandit-select";
import { toJsonSafe } from "@usemoney/core/analytics";
import type { SubmitResultFeedbackData } from "@usemoney/validation";
import type { ServiceResult } from "./types";

export type ResultFeedbackSurface = "CHAT" | "RESEARCH" | "ROAST";

export interface ResultFeedbackState {
  rating: "UP" | "DOWN";
  comment: string | null;
}

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM, so tests pass
 * a fake prisma via `deps` rather than module-mocking. `recordVariantOutcome`
 * stays the REAL pure fn so the bandit side effect is exercised, not stubbed.
 */
export interface ResultFeedbackServiceDeps {
  prisma?: typeof prisma;
}

/**
 * MONEY-807: strip the un-anchored `outcome` from a caller-supplied metadata
 * blob. Without a bandit arm there is no `variantId`, so a bare `outcome` echoed
 * back by the client would just be a copy of the rating — and on a 👍→👎 re-rate
 * it goes STALE vs the `rating` column the bandit actually reads. Ported verbatim
 * from result-feedback.ts:61-68.
 */
function stripUnanchoredOutcome(
  m: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!m || m.outcome === undefined) return m;
  const rest = { ...m };
  delete rest.outcome;
  return rest;
}

/**
 * Submit (or update) a thumbs rating for one AI result. Upserts on
 * (userId, surface, refId) so a re-rate flips the row rather than duplicating.
 * Records the bandit outcome (MONEY-800 B6) into `metadata`.
 */
export async function submitResultFeedback(
  userId: string,
  input: SubmitResultFeedbackData,
  deps: ResultFeedbackServiceDeps = {},
): Promise<ServiceResult<ResultFeedbackState>> {
  const db = deps.prisma ?? prisma;
  const d = input;

  // MONEY-800 (B6): record the explanation-style bandit OUTCOME. Returns
  // undefined when no arm produced the answer → persist the (stripped) caller
  // metadata as-is.
  const bandit = recordVariantOutcome(d.variantId, d.rating, d.metadata);
  const raw = bandit ?? stripUnanchoredOutcome(d.metadata);
  // Normalise through the SAME helper analytics/index.ts uses (single source of
  // truth) so non-serializable values are dropped and the blob is a valid Prisma
  // Json value.
  const metadata: Prisma.InputJsonValue | undefined =
    raw === undefined ? undefined : toJsonSafe(raw);

  try {
    const row = await db.resultFeedback.upsert({
      where: {
        userId_surface_refId: {
          userId,
          surface: d.surface,
          refId: d.refId,
        },
      },
      create: {
        userId,
        surface: d.surface,
        refId: d.refId,
        chatId: d.chatId,
        rating: d.rating,
        comment: d.comment,
        reasons: d.reasons ?? [],
        model: d.model,
        tier: d.tier,
        intent: d.intent,
        symbols: d.symbols ?? [],
        metadata,
      },
      update: {
        rating: d.rating,
        comment: d.comment,
        reasons: d.reasons ?? [],
        // Refresh the provenance snapshot on re-rate (model may have changed).
        model: d.model,
        tier: d.tier,
        intent: d.intent,
        symbols: d.symbols ?? [],
        // Re-stamp the bandit's {variantId, outcome} on re-rate (a 👍→👎 flip
        // must flip the arm's recorded outcome too). No arm → leave existing
        // metadata untouched (the bandit reads the `rating` column for un-armed
        // rows, not metadata).
        ...(metadata !== undefined ? { metadata } : {}),
      },
      select: { rating: true, comment: true },
    });

    return {
      success: true,
      data: { rating: row.rating, comment: row.comment },
    };
  } catch (error) {
    // Never block the chat UI on a feedback write — degrade with a sanitised error.
    logger.error({ error, userId }, "submitResultFeedback service error");
    return { success: false, error: "Could not save your feedback" };
  }
}

/** Remove a previously-submitted rating (toggle the thumb off). */
export async function clearResultFeedback(
  userId: string,
  surface: ResultFeedbackSurface,
  refId: string,
  deps: ResultFeedbackServiceDeps = {},
): Promise<ServiceResult<{ cleared: boolean }>> {
  const db = deps.prisma ?? prisma;
  if (!refId) {
    return {
      success: false,
      error: "refId is required",
      code: "INVALID_INPUT",
    };
  }

  try {
    // IDOR: scoped to the caller's userId + surface + refId.
    await db.resultFeedback.deleteMany({
      where: { userId, surface, refId },
    });
    return { success: true, data: { cleared: true } };
  } catch (error) {
    logger.error({ error, userId }, "clearResultFeedback service error");
    return { success: false, error: "Could not clear your feedback" };
  }
}

/**
 * Hydrate existing ratings for a set of results (e.g. on chat reload) so the UI
 * can show which messages the caller already rated. Keyed by refId; capped at
 * 200 ids. IDOR: the WHERE is always scoped to `userId`.
 */
export async function getResultFeedback(
  userId: string,
  surface: ResultFeedbackSurface,
  refIds: string[],
  deps: ResultFeedbackServiceDeps = {},
): Promise<ServiceResult<Record<string, ResultFeedbackState>>> {
  const db = deps.prisma ?? prisma;
  const ids = (refIds ?? []).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return { success: true, data: {} };

  try {
    const rows = await db.resultFeedback.findMany({
      where: { userId, surface, refId: { in: ids } },
      select: { refId: true, rating: true, comment: true },
    });
    const map: Record<string, ResultFeedbackState> = {};
    for (const r of rows) {
      map[r.refId] = { rating: r.rating, comment: r.comment };
    }
    return { success: true, data: map };
  } catch (error) {
    // Best-effort hydration — a read failure degrades to "nothing rated yet".
    logger.error({ error, userId }, "getResultFeedback service error");
    return { success: true, data: {} };
  }
}
