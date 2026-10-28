/**
 * MONEY-1383 (L2) — preload the charting library only where the page will
 * actually MOUNT a chart.
 *
 * `ChartPreloadLinks` is rendered from the SERVER page (that is the whole
 * point of it — it has to be in the HTML, outside `<PageGuard>`), while the
 * chart itself is gated in the CLIENT. When the two disagree the visitor
 * downloads ~480 KB brotli / 2.5 MB of bundles no document ever executes, and
 * Chrome prints one "preloaded but not used" warning per entry. Two surfaces
 * were doing exactly that:
 *
 *   /stock/[symbol]           client.tsx: `{isDemoMode ? <"Charts disabled in
 *                             demo mode"> : <TradingViewAdvancedChart/>}`
 *                             → every demo visitor.
 *   /paper-trading/terminal   client.tsx: `isFreeUser = !isDemoMode && planId
 *                             === "FREE"`, `{isFreeUser ? <"Charts available
 *                             on Pro plan"> : <TradingViewAdvancedChart/>}`
 *                             → every FREE user, the majority tier.
 *
 * `/etf/[symbol]` renders its chart unconditionally and is deliberately absent
 * from this file.
 *
 * NOTE THE TWO RULES DISAGREE ABOUT DEMO, and that is not a bug in one of
 * them: the stock page HIDES the chart from a demo visitor, the paper terminal
 * SHOWS it (`!isDemoMode &&` is the first clause of `isFreeUser`). One "is the
 * chart visible" predicate would have to pick a side and would be wrong on one
 * of the two pages, so each mirror is written out separately against the
 * expression it mirrors.
 *
 * Pure, so the mirror is asserted directly — this repo has no DOM renderer, so
 * the alternative is no test at all.
 *
 * WHAT A MISMATCH COSTS. Nothing breaks in either direction: a false negative
 * is a missed optimisation (the chart renders, having paid the pre-MONEY-1383
 * latency) and a false positive is the wasted bytes above. That is what lets
 * these run off SERVER signals that only approximate the client's:
 *   - demo is `isDemoSession()` (the HMAC `sb_demo` cookie) where the client
 *     ORs in a `tradebook_demo_mode` localStorage flag, so a stale flag with no
 *     cookie still reads as non-demo here;
 *   - the plan is `getSubscriptionAccess().planId`, which resolves an unknown
 *     or legacy plan id to "FREE" where the client's `getSubscriptionAction()`
 *     may report the legacy paid id.
 * Both residual disagreements land on the harmless side.
 */

/** Mirrors `app/stock/[symbol]/client.tsx` — demo mode replaces the chart. */
export function stockPageShowsChart(input: { isDemo: boolean }): boolean {
  return !input.isDemo;
}

/**
 * Mirrors `app/paper-trading/client.tsx`:
 *   `const isFreeUser = !isDemoMode && planId === "FREE";`
 *   `{isFreeUser ? <upgrade prompt> : <TradingViewAdvancedChart/>}`
 *
 * `planId` is compared to the literal "FREE" exactly as the client does — a
 * plan the client cannot name is a plan it treats as free.
 */
export function paperTerminalShowsChart(input: {
  isDemo: boolean;
  planId: string;
}): boolean {
  return input.isDemo || input.planId !== "FREE";
}
