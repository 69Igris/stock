/**
 * Pure response-shaping logic for the chat route (`app/api/chat/route.ts`).
 *
 * Extracted so the credit-failure paywall payload and the tool-narrative
 * fallback (the bits with product-meaningful copy + CTA structure) can be unit
 * tested directly. The route imports & calls these — production runs the same
 * code the tests assert.
 *
 * MONEY-295:
 *  - Bug 5 (narrative gate): the L2 fast-path tool narrative is just Flash
 *    summarizing already-fetched tool data (cost ≈ l1_flash). It runs whenever
 *    Gemini is enabled, with NO legacy-quota gate. When Gemini is OFF the route
 *    falls back to a generic stub instead.
 *  - Bug 6 (credit paywall): a failed `consumeCredits` returns 200 with a
 *    structured warning block + upgrade/credit-pack CTAs (never a bare 403), so
 *    chat stays alive.
 */

import type { ContentBlock } from "@usemoney/types";

/** The shape of a failed `consumeCredits` result the paywall reads. */
export interface CreditFailure {
  success: false;
  error?: string;
  code?: string;
}

/**
 * Title for the credit-failure paywall. A non-active subscription (identified
 * by the error string when there's NO error code) gets an "activation" title;
 * everything else is treated as out-of-credits.
 */
export function creditPaywallTitle(creditResult: CreditFailure): string {
  const isInactive =
    !creditResult.code && /not active/i.test(creditResult.error || "");
  return isInactive ? "Subscription needs activation" : "Not enough credits";
}

/** User-facing message body paired with {@link creditPaywallTitle}. */
export function creditPaywallMessage(creditResult: CreditFailure): string {
  const isInactive =
    !creditResult.code && /not active/i.test(creditResult.error || "");
  return isInactive
    ? "Your subscription isn't active. Reactivate or downgrade to FREE to keep using StockSage."
    : creditResult.error ||
        "You've used your monthly credits. Upgrade to PRO for more, or top up with a credit pack.";
}

/**
 * Build the structured paywall blocks for a credit-consumption failure: a
 * warning ErrorBlock plus a NavigationBlock with upgrade + credit-pack CTAs.
 * Returned with a 200 status by the route so the chat surface stays alive.
 */
export function buildCreditPaywallBlocks(
  creditResult: CreditFailure
): ContentBlock[] {
  const title = creditPaywallTitle(creditResult);
  const message = creditPaywallMessage(creditResult);
  return [
    {
      type: "error",
      severity: "warning",
      title,
      message,
    },
    {
      type: "navigation",
      links: [
        {
          label: "Upgrade to PRO",
          href: "/pricing",
          icon: "crown",
          description: "More credits, unlimited brokers",
        },
        {
          label: "Buy credit pack",
          href: "/pricing#credits",
          icon: "package",
          description: "Top up from ₹399",
        },
      ],
    },
  ] as ContentBlock[];
}

/**
 * Whether the L2 fast-path tool NARRATIVE (Flash summary + auto-format blocks)
 * runs. It runs whenever Gemini is enabled — NOT gated by the legacy query
 * quota (MONEY-295 Bug 5). When Gemini is disabled the route uses
 * {@link buildToolNarrativeFallbackBlocks} instead.
 */
export function shouldRunToolNarrative(geminiEnabled: boolean): boolean {
  return geminiEnabled;
}

/** Generic stub shown when the narrative path can't run (Gemini disabled). */
export const TOOL_NARRATIVE_FALLBACK_TEXT = "Here are your results.";

/** Blocks for the Gemini-disabled tool-narrative fallback. */
export function buildToolNarrativeFallbackBlocks(): ContentBlock[] {
  return [
    {
      type: "text",
      content: TOOL_NARRATIVE_FALLBACK_TEXT,
    },
  ] as ContentBlock[];
}
