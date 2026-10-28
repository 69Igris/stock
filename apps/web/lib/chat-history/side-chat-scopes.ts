/**
 * History scopes for the tool-driven side chats — Ask FIRE and Ask Screener
 * (MONEY-1245).
 *
 * A "scope" is the `{pagePath, pageName, pageIcon}` triple a chat is saved
 * under. `ChatHistory.pagePath` is the ONLY filter `listChatHistories` applies
 * (`where.pagePath = pagePath`, an exact match), so the scope is what decides
 * which past chats a panel's history list shows.
 *
 * ## Why Ask Screener needs three of them
 *
 * The screener runs in three modes — stocks, ETFs and mutual funds — and the
 * panel already varies its header label, its suggestion chips and the tools it
 * calls per mode. Its history did not: every mode saved under the single path
 * "/discover/screener". Two things followed, both silent:
 *
 *   - One undifferentiated list. An ETF chat and a stocks chat were the same
 *     row shape with the same page name, so there was no way to tell them
 *     apart before opening one.
 *   - A resumed chat could replay onto the wrong screen. The saved
 *     `toolConversation` is a list of screen edits — set this filter, sort by
 *     that column — expressed in the vocabulary of the mode it was recorded
 *     in. Replaying an ETF chat's tool turns while the user sits in stocks
 *     mode hands the model a history of edits that do not match what is on
 *     screen, which is exactly the blind-resume failure `toolConversation`
 *     was added to prevent.
 *
 * ## Why the mode rides in a query string
 *
 * "/discover/screener?mode=etf" rather than "/discover/screener/etf": the
 * per-mode routes do not exist. The screener is one route that keeps its mode
 * in `?mode=` and reads it back for `initialMode`, so this path is one the
 * router can actually resume onto. That requires the resume href to be built
 * by merging query params — see `buildChatResumeHref` in
 * lib/navigation/url-sync-logic.ts, which replaced a raw
 * `${pagePath}?chatId=${id}` concat that would have emitted a second "?".
 *
 * ## Rows saved before this split
 *
 * They carry the bare "/discover/screener" and match none of the three scopes,
 * so they stop appearing in the in-panel list. That is deliberate and cheap:
 * MONEY-1245 has never been released (it lives on an unmerged branch), so
 * those rows exist only in dev and QA, and /chat-history lists chats across
 * ALL pages — so they remain visible and deletable there. If this ever needs
 * to cover real user rows, backfill `pagePath` to the stocks scope rather than
 * teaching the reader to match a prefix; a prefix match would make the stocks
 * list silently include ETF and MF chats.
 */

import type { ScreenerMode } from "@/components/screener/ModeTabs";

export interface SideChatScope {
  /** Route this chat belongs to. Scopes the history list; must be resumable. */
  pagePath: string;
  /** Display name stored on the row and shown in /chat-history. */
  pageName: string;
  /** Lucide icon name for the /chat-history list. */
  pageIcon: string;
}

export const FIRE_CHAT_SCOPE: SideChatScope = {
  pagePath: "/fire",
  pageName: "Ask FIRE",
  pageIcon: "Flame",
};

export const SCREENER_CHAT_SCOPES: Record<ScreenerMode, SideChatScope> = {
  stocks: {
    pagePath: "/discover/screener?mode=stocks",
    pageName: "Ask Screener · Stocks",
    pageIcon: "ScanSearch",
  },
  etf: {
    pagePath: "/discover/screener?mode=etf",
    pageName: "Ask Screener · ETFs",
    pageIcon: "ScanSearch",
  },
  mf: {
    pagePath: "/discover/screener?mode=mf",
    pageName: "Ask Screener · Mutual Funds",
    pageIcon: "ScanSearch",
  },
};

/** Scope for a screener mode. Unknown modes fall back to stocks, the default. */
export function screenerChatScope(mode: ScreenerMode): SideChatScope {
  return SCREENER_CHAT_SCOPES[mode] ?? SCREENER_CHAT_SCOPES.stocks;
}

/**
 * Display names for every side-chat scope, for /chat-history's page filter and
 * row labels. Exported as a map so that page has one place to merge in rather
 * than a second hand-maintained copy of these strings.
 */
export const SIDE_CHAT_PAGE_NAMES: Record<string, string> = {
  [FIRE_CHAT_SCOPE.pagePath]: FIRE_CHAT_SCOPE.pageName,
  [SCREENER_CHAT_SCOPES.stocks.pagePath]: SCREENER_CHAT_SCOPES.stocks.pageName,
  [SCREENER_CHAT_SCOPES.etf.pagePath]: SCREENER_CHAT_SCOPES.etf.pageName,
  [SCREENER_CHAT_SCOPES.mf.pagePath]: SCREENER_CHAT_SCOPES.mf.pageName,
};

/**
 * Every pagePath owned by a side chat (MONEY-1255).
 *
 * StockSage's history sidebar excludes these. It listed every chat, which was
 * right while it was the only writer; MONEY-1245 gave Ask FIRE and Ask
 * Screener saved chats on the same table and they began appearing there.
 *
 * DERIVED from the scopes above rather than hand-listed. A hardcoded
 * ["/fire", "/discover/screener"] was the first attempt and was already wrong:
 * the screener saves under THREE per-mode paths
 * ("/discover/screener?mode=stocks|etf|mf"), and the bare path it guessed
 * matches none of them. Deriving means a mode added later is excluded the day
 * it ships.
 *
 * These chats remain reachable from /chat-history and each panel's own
 * in-panel history — this hides them from StockSage's list, nothing else.
 */
export const SIDE_CHAT_PAGE_PATHS: readonly string[] =
  Object.keys(SIDE_CHAT_PAGE_NAMES);
