/**
 * Watchlist membership count for the screener cards (MONEY-1253).
 *
 * Every screener card rendered "+ Watch" on load, including stocks already in
 * three lists. Nothing was stale: `memberCount` was `useState(0)` and only ever
 * set by `WatchlistPopover.onMembershipChange`, which fires when the popover
 * OPENS. Membership was never fetched, so the label could not have been right.
 *
 * These cases pin the counting rule, which has one hard requirement: it must
 * agree EXACTLY with `WatchlistPopover.deriveLists`. If the two drift, the
 * closed trigger contradicts the popover it opens — a card reading "Watch"
 * that reveals three ticked lists on click, which is the reported bug wearing
 * a different hat.
 *
 * The REAL exported rule is imported, not re-implemented. An earlier test in
 * this branch mirrored its logic locally and stayed green with the bug put
 * back; mutation caught it, and the fix was to share one implementation.
 *
 * Source: apps/web/lib/watchlist/membership-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  countWatchlistMembership,
  type MembershipList,
} from "../../lib/watchlist/membership-logic";

const lists: MembershipList[] = [
  {
    type: "STOCK",
    items: [
      { symbol: "AARTIIND", exchange: "NSE" },
      { symbol: "ABB", exchange: "NSE" },
    ],
  },
  { type: "STOCK", items: [{ symbol: "AARTIIND", exchange: "NSE" }] },
  { type: "STOCK", items: [{ symbol: "AARTIIND", exchange: "NSE" }] },
  { type: "MF", items: [{ symbol: "120503", exchange: "MF" }] },
];

describe("watchlist membership count", () => {
  it("[regression] counts every list a stock belongs to", () => {
    // The screenshot case: AARTIIND is in 3 stock watchlists and the card
    // said "+ Watch".
    assert.equal(
      countWatchlistMembership(lists, "AARTIIND", "NSE", "STOCK"),
      3
    );
  });

  it("counts a stock in exactly one list", () => {
    assert.equal(countWatchlistMembership(lists, "ABB", "NSE", "STOCK"), 1);
  });

  it("returns 0 for a stock in none", () => {
    assert.equal(countWatchlistMembership(lists, "INFY", "NSE", "STOCK"), 0);
  });

  it("[regression] scopes by KIND — MF lists never count toward a stock", () => {
    // ETFs are stored under STOCK lists while MFs use their own. Counting
    // across both would inflate every ETF and fund card.
    assert.equal(countWatchlistMembership(lists, "120503", "MF", "MF"), 1);
    assert.equal(countWatchlistMembership(lists, "120503", "MF", "STOCK"), 0);
  });

  it("[regression] matches on exchange too, not symbol alone", () => {
    // Same ticker on a different exchange is a different instrument; matching
    // on symbol alone would over-count dual-listed names.
    assert.equal(
      countWatchlistMembership(lists, "AARTIIND", "BSE", "STOCK"),
      0
    );
  });

  it("a missing or empty watchlist load reads as 0, never throws", () => {
    // Membership is decoration on a working page — a failed load must leave
    // the cards usable rather than break the screener.
    assert.equal(countWatchlistMembership(null, "ABB", "NSE", "STOCK"), 0);
    assert.equal(countWatchlistMembership(undefined, "ABB", "NSE", "STOCK"), 0);
    assert.equal(countWatchlistMembership([], "ABB", "NSE", "STOCK"), 0);
  });

  it("a list with no items contributes nothing", () => {
    const empty: MembershipList[] = [{ type: "STOCK", items: [] }];
    assert.equal(countWatchlistMembership(empty, "ABB", "NSE", "STOCK"), 0);
  });

  it("a duplicate item within ONE list still counts that list once", () => {
    // The count is lists-containing-it, not items-matching-it. A list that
    // somehow holds the row twice must not read as two watchlists.
    const dupe: MembershipList[] = [
      {
        type: "STOCK",
        items: [
          { symbol: "ABB", exchange: "NSE" },
          { symbol: "ABB", exchange: "NSE" },
        ],
      },
    ];
    assert.equal(countWatchlistMembership(dupe, "ABB", "NSE", "STOCK"), 1);
  });
});
