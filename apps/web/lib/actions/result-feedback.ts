"use server";

/**
 * Per-result feedback (MONEY-587).
 *
 * Thumbs up / down on an individual AI result (a chat message, a research
 * session, or a roast), with an optional free-text message — the same shape
 * users expect from ChatGPT / Claude. We store the rating plus a snapshot of
 * what produced it (model / tier / intent / symbols) so the self-improving
 * loop (MONEY-592) can slice the 👎-rate by model, tier, intent and tool.
 *
 * One row per (user, surface, refId): re-rating upserts, so a user can flip
 * 👍↔👎 or attach a message without creating duplicates.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import prisma, { type Prisma } from "@usemoney/database";
import {
  SubmitResultFeedbackSchema,
  type SubmitResultFeedbackInput,
  type ActionResponse,
} from "@usemoney/validation";
import { recordVariantOutcome } from "@usemoney/core/investor/bandit-select";
import { toJsonSafe } from "@usemoney/core/analytics";

export interface ResultFeedbackState {
  rating: "UP" | "DOWN";
  comment: string | null;
}

/** Submit (or update) a thumbs rating for one AI result. */
export async function submitResultFeedbackAction(
  input: SubmitResultFeedbackInput
): Promise<ActionResponse<ResultFeedbackState>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const parsed = SubmitResultFeedbackSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.errors[0]?.message || "Invalid feedback",
    };
  }
  const d = parsed.data;

  // MONEY-800 (B6): record the explanation-style bandit OUTCOME. recordVariantOutcome
  // stamps the chosen arm's `variantId` + the binary thumbs outcome (👍 → success,
  // 👎 → failure) onto the row's `metadata`, merged over any caller-supplied
  // metadata. Because the bandit reads per-variant win/impression counts by
  // counting these tagged rows (one row == one outcome), persisting the variantId
  // IS the count bump it consumes on its next selection pass. Returns undefined
  // when no arm produced the answer → we persist the caller metadata (or null) as-is.
  const bandit = recordVariantOutcome(d.variantId, d.rating, d.metadata);
  // MONEY-807: the bandit ties `outcome` to a `variantId` (one tagged row == one
  // outcome). Without an arm there is no variantId, so a bare `outcome` echoed
  // back by the client would just be a copy of the rating — and on a 👍→👎 re-rate
  // it goes STALE vs the `rating` column the bandit actually reads. Strip the
  // un-anchored `outcome` from the caller blob so we never persist a divergent
  // copy; when an arm IS recorded the bandit's own `{variantId, outcome}` wins.
  const stripUnanchoredOutcome = (
    m: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined => {
    if (!m || m.outcome === undefined) return m;
    const rest = { ...m };
    delete rest.outcome;
    return rest;
  };
  const raw = bandit ?? stripUnanchoredOutcome(d.metadata);
  // Normalise through the SAME helper analytics/index.ts uses (single source of
  // truth) so non-serializable values are dropped and the blob is a valid Prisma
  // Json value — replaces the bare `as Prisma.InputJsonValue` cast.
  const metadata: Prisma.InputJsonValue | undefined =
    raw === undefined ? undefined : toJsonSafe(raw);

  try {
    const row = await prisma.resultFeedback.upsert({
      where: {
        userId_surface_refId: {
          userId: user.userId,
          surface: d.surface,
          refId: d.refId,
        },
      },
      create: {
        userId: user.userId,
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
        // Re-stamp the bandit's `{variantId, outcome}` on re-rate (a 👍→👎 flip
        // must flip the arm's recorded outcome too). When there is no arm
        // (`recordVariantOutcome` → undefined) we leave any existing metadata
        // untouched rather than writing a stale, un-anchored `outcome` patch —
        // the bandit reads the `rating` column, not metadata, for un-armed rows.
        ...(metadata !== undefined ? { metadata } : {}),
      },
      select: { rating: true, comment: true },
    });

    return {
      success: true,
      data: { rating: row.rating, comment: row.comment },
    };
  } catch {
    // Never block the chat UI on a feedback write — degrade silently.
    return { success: false, error: "Could not save your feedback" };
  }
}

/** Remove a previously-submitted rating (toggle the thumb off). */
export async function clearResultFeedbackAction(
  surface: "CHAT" | "RESEARCH" | "ROAST",
  refId: string
): Promise<ActionResponse<{ cleared: boolean }>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };
  if (!refId) return { success: false, error: "refId is required" };

  try {
    await prisma.resultFeedback.deleteMany({
      where: { userId: user.userId, surface, refId },
    });
    return { success: true, data: { cleared: true } };
  } catch {
    return { success: false, error: "Could not clear your feedback" };
  }
}

/**
 * Hydrate existing ratings for a set of results (e.g. on chat reload) so the
 * UI can show which messages the user already rated. Keyed by refId.
 */
export async function getResultFeedbackAction(
  surface: "CHAT" | "RESEARCH" | "ROAST",
  refIds: string[]
): Promise<ActionResponse<Record<string, ResultFeedbackState>>> {
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const ids = (refIds ?? []).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return { success: true, data: {} };

  try {
    const rows = await prisma.resultFeedback.findMany({
      where: { userId: user.userId, surface, refId: { in: ids } },
      select: { refId: true, rating: true, comment: true },
    });
    const map: Record<string, ResultFeedbackState> = {};
    for (const r of rows)
      map[r.refId] = { rating: r.rating, comment: r.comment };
    return { success: true, data: map };
  } catch {
    return { success: true, data: {} };
  }
}
