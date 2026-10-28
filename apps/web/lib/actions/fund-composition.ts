"use server";

/**
 * Fund Composition Server Actions
 *
 * Thin wrappers over @usemoney/services fund composition functions.
 * Provides server actions for fetching and triggering
 * AI-extracted fund portfolio composition data.
 */

import { auth } from "@clerk/nextjs/server";
import {
  createRateLimiter,
  createRateLimitKey,
} from "@usemoney/security/rate-limit";
import {
  consumeCredits as consumeCreditsService,
  refundCredits as refundCreditsService,
  getFundComposition as getFundCompositionService,
  triggerCompositionExtraction as triggerCompositionExtractionService,
} from "@usemoney/services";

import { getAuthenticatedUser } from "@/lib/auth";
import { isDemoSession } from "@/lib/demo/session";

// Re-export types for consumers
export type { FundCompositionData } from "@usemoney/services";

/**
 * 5 extractions per hour per user (MONEY-1405 A1).
 *
 * Dedicated rather than reusing `syncRateLimiter` — which is also 5/hour and
 * has ZERO production callers today, so there is no key collision to fear.
 * What it does have is `uniqueTokenPerInterval: 100`: a shared LRU that evicts
 * is a limit that silently resets, and this one guards a paid
 * `gemini-2.5-pro` thinking call. Same local precedent as the limiter in
 * `app/api/demo/start/route.ts`.
 */
const compositionRateLimiter = createRateLimiter({
  interval: 60 * 60 * 1000, // 1 hour
  uniqueTokenPerInterval: 500,
});
const EXTRACTIONS_PER_HOUR = 5;

/**
 * The DURABLE meter — MONEY-1401 F6.
 *
 * The limiter above is a module-scope `LRUCache`. On Vercel that is per warm
 * lambda instance, so the real ceiling was 5 × instances per hour, resetting on
 * every cold start and every deploy, with no entitlement check of any kind
 * behind it. `/compare`'s "Analyse all holdings" loops up to five funds, so one
 * click spent an entire instance-budget. Meanwhile `/api/chat` meters the same
 * class of spend — a `gemini-2.5-pro` thinking call — against the user's
 * durable credit balance.
 *
 * So both now apply, in the order they cost: the LRU is a free burst guard,
 * credits are the budget. FREE carries 5 credits a month, so this meters rather
 * than hard-blocks — unlike the legacy `consumeAIQuery`, which refuses FREE
 * outright (`subscription.service.ts`) and which `/api/chat` itself keeps only
 * "for backward compat during migration".
 *
 * COST IS PASSED EXPLICITLY, and that is load-bearing rather than stylistic.
 * `getCreditCost(action)` is `CREDIT_COSTS[action] ?? 0`, and `consumeCredits`
 * treats cost 0 as a FREE action that is always allowed — so an action id
 * missing from that table is a meter that silently authorises everything, which
 * is worse than no meter because it reads as one. `costOverride` bypasses the
 * table. Add `fund_composition_extract: 2` to `packages/core/src/subscription/
 * plans.ts` when that file is next touched and this override becomes redundant,
 * not wrong.
 *
 * 2 credits matches `document_analysis`, the nearest neighbour in that table
 * that is also one pro-tier call over one document.
 */
const CREDIT_ACTION = "fund_composition_extract";
const CREDIT_COST = 2;

// ============== ACTIONS ==============

/**
 * Get fund composition — the AMC's own disclosure first, the stored model
 * recollection only when the AMC has published nothing for this scheme.
 * Returns null if neither source has anything.
 *
 * `schemeCode` is the AMFI code the disclosure is keyed by (MONEY-1405 D4/D5).
 * For an MF it IS `fundId`, so the service derives it; for an ETF `fundId` is a
 * trading symbol and the page passes the code it resolved through
 * `lib/fund/fund-identity`. Unauthenticated on purpose — this reads two tables
 * and spends nothing, unlike its sibling below.
 */
export async function getFundCompositionAction(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
  schemeCode?: string
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").FundCompositionData;
  error?: string;
}> {
  const result = await getFundCompositionService(fundType, fundId, schemeCode);

  // The service returns data: null when not yet extracted.
  // The action contract returns data?: undefined in that case.
  if (result?.success && result?.data === null) {
    return { success: true };
  }

  if (result?.success && result?.data) {
    return { success: true, data: result?.data };
  }

  if (!result?.success) {
    return { success: false, error: result?.error };
  }
  return { success: true };
}

/**
 * Trigger composition extraction via Gemini AI.
 * Will use cached DB data if fresh, otherwise calls Gemini.
 *
 * GUARDED — MONEY-1405 A1. This spends a `gemini-2.5-pro` thinking call and
 * was a bare pass-through: no auth, no demo refusal, no limit. Anyone holding
 * a valid `sb_demo` cookie could fan out extractions at will, and /compare
 * fired up to five per page load. The guards live HERE rather than in the two
 * callers because this is the one point every caller routes through.
 */
export async function triggerCompositionExtractionAction(
  fundType: "MF" | "ETF" | "INDEX",
  fundId: string,
  schemeCode?: string
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").FundCompositionData;
  error?: string;
}> {
  const { userId } = await auth();

  // Demo is checked BEFORE the userId guard, and `userId` is threaded through:
  // a demo caller has NO Clerk session, so `isDemoSession(null)` is the branch
  // that reads the cookie — checking it after `!userId` would make it dead
  // code. Passing the value also keeps this to ONE `auth()` per call.
  if (await isDemoSession(userId)) {
    return {
      success: false,
      error:
        "Holdings extraction isn't available in demo mode. Sign up for a free account to run it.",
    };
  }

  if (!userId) {
    return { success: false, error: "Unauthorized" };
  }

  const rl = await compositionRateLimiter.check(
    EXTRACTIONS_PER_HOUR,
    createRateLimitKey("fund-composition", userId)
  );
  if (!rl.success) {
    return {
      success: false,
      error: "Too many holdings extractions. Please try again in an hour.",
    };
  }

  // Credits are keyed by the INTERNAL user id, not the Clerk one. `auth()`
  // above answers "is there a session"; this answers "which user's balance",
  // and it is `cache()`d per request so the extra hop costs nothing.
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized" };
  }

  const charged = await consumeCreditsService(authUser.userId, CREDIT_ACTION, {
    costOverride: CREDIT_COST,
  });
  if (!charged.success) {
    return {
      success: false,
      error: charged.error ?? "Out of AI credits.",
    };
  }

  // The scheme code is passed through only so the write lands on the
  // recollection cache key the read falls back to; the extraction itself has
  // never been keyed by it.
  const result = await triggerCompositionExtractionService(
    fundType,
    fundId,
    schemeCode
  );

  // Refund only when nothing was produced. A successful extraction keeps the
  // charge even if the caller never looks at it — same rule as
  // `generateFiltersFromThesisAction`.
  //
  // The amount is PASSED. `refundCredits`' third argument is a plain number and
  // it falls back to `getCreditCost(action)` — 0 for an id not in the table —
  // and a 0 refund returns `{ refunded: 0 }` successfully. The charge and the
  // refund have to read the same constant or a failed extraction quietly keeps
  // the user's credits.
  if (!result.success) {
    await refundCreditsService(
      authUser.userId,
      CREDIT_ACTION,
      CREDIT_COST
    ).catch(() => {});
  }

  return result;
}
