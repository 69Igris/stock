/**
 * How many watchlists a given instrument belongs to (MONEY-1253).
 *
 * Pure, and in its own module rather than inside `useWatchlistMembership`,
 * for two reasons:
 *
 *  1. The hook is a "use client" file that imports a server action, so a
 *     node test importing it would drag the action in. The rule needs to be
 *     reachable without that.
 *  2. It has to agree EXACTLY with `WatchlistPopover.deriveLists`. If the two
 *     ever diverge, the closed trigger contradicts the popover it opens —
 *     a card reading "Watch" that shows three ticked lists when clicked, which
 *     is the bug this ticket is about wearing a different hat.
 *
 * The popover's rule, mirrored here: lists are scoped by `type === kind`, and
 * an item matches on symbol AND exchange (see `matchesTarget`).
 */

export type WatchlistMembershipKind = "STOCK" | "MF";

/** The shape this needs from a watchlist — deliberately minimal. */
export interface MembershipList {
  type: string;
  items: ReadonlyArray<{ symbol: string; exchange: string }>;
}

/**
 * Number of lists of the matching kind that contain this instrument.
 *
 * Returns 0 for unknown/empty input rather than throwing: membership is
 * decoration on a working page, and a failed watchlist load must leave the
 * cards usable rather than break the screener.
 */
export function countWatchlistMembership(
  lists: ReadonlyArray<MembershipList> | null | undefined,
  symbol: string,
  exchange: string,
  kind: WatchlistMembershipKind
): number {
  if (!lists || lists.length === 0) return 0;
  let n = 0;
  for (const l of lists) {
    // Kind scoping matters: ETFs are stored under STOCK lists while MFs use
    // their own, so counting across both would inflate every ETF card.
    if (l.type !== kind) continue;
    if (
      l.items.some((it) => it.symbol === symbol && it.exchange === exchange)
    ) {
      n += 1;
    }
  }
  return n;
}
