/**
 * MONEY-1245 follow-up — per-mode history scopes for the side chats.
 *
 * `ChatHistory.pagePath` is the ONLY filter `listChatHistories` applies
 * (`where.pagePath = pagePath`, exact match), so these constants are what
 * decides which past chats a panel shows. Ask Screener used to save all three
 * modes under the bare "/discover/screener", which produced one
 * undifferentiated list AND let a resumed ETF chat replay its screen edits
 * onto the stocks screen.
 *
 * The invariant every assertion below defends: DISTINCT pagePaths. If two
 * modes ever collide, nothing throws and no test elsewhere notices — the
 * lists silently merge again, which is precisely how this shipped the first
 * time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FIRE_CHAT_SCOPE,
  SCREENER_CHAT_SCOPES,
  SIDE_CHAT_PAGE_NAMES,
  SIDE_CHAT_PAGE_PATHS,
  screenerChatScope,
} from "../../lib/chat-history/side-chat-scopes";
import { buildChatResumeHref } from "../../lib/navigation/url-sync-logic";

const MODES = ["stocks", "etf", "mf"] as const;

describe("side-chat history scopes", () => {
  test("every screener mode has a DISTINCT pagePath", () => {
    const paths = MODES.map((m) => SCREENER_CHAT_SCOPES[m].pagePath);
    assert.equal(
      new Set(paths).size,
      MODES.length,
      "two screener modes share a pagePath — their histories would merge"
    );
  });

  test("no screener scope collides with the FIRE scope", () => {
    for (const m of MODES) {
      assert.notEqual(
        SCREENER_CHAT_SCOPES[m].pagePath,
        FIRE_CHAT_SCOPE.pagePath
      );
    }
  });

  test("every screener mode has a distinct display name", () => {
    // The list shows the name, so identical names would be indistinguishable
    // to the user even with the paths correctly separated.
    const names = MODES.map((m) => SCREENER_CHAT_SCOPES[m].pageName);
    assert.equal(new Set(names).size, MODES.length);
  });

  test("each screener pagePath encodes ITS OWN mode", () => {
    // Guards the copy-paste slip where etf's entry keeps "?mode=stocks":
    // distinct paths, but two modes resume onto the same screen.
    for (const m of MODES) {
      const path = SCREENER_CHAT_SCOPES[m].pagePath;
      const params = new URLSearchParams(path.slice(path.indexOf("?")));
      assert.equal(params.get("mode"), m);
    }
  });

  test("screenerChatScope returns the matching scope", () => {
    for (const m of MODES) {
      assert.equal(screenerChatScope(m), SCREENER_CHAT_SCOPES[m]);
    }
  });

  test("an unknown mode falls back to stocks rather than undefined", () => {
    // A missing scope would make useSideChatHistory read `pagePath` off
    // undefined and throw inside the panel.
    const scope = screenerChatScope("commodities" as (typeof MODES)[number]);
    assert.equal(scope, SCREENER_CHAT_SCOPES.stocks);
  });

  test("SIDE_CHAT_PAGE_NAMES covers every scope", () => {
    // /chat-history renders the raw pagePath when a name is missing, so a
    // gap here shows the user "/discover/screener?mode=etf" as a page title.
    const all = [FIRE_CHAT_SCOPE, ...MODES.map((m) => SCREENER_CHAT_SCOPES[m])];
    for (const scope of all) {
      assert.equal(SIDE_CHAT_PAGE_NAMES[scope.pagePath], scope.pageName);
    }
  });

  test("every scope round-trips through the resume href", () => {
    // The end-to-end contract: /chat-history builds this href, the router
    // lands on it, and the panel reads chatId back out while the screener
    // reads its mode.
    for (const m of MODES) {
      const href = buildChatResumeHref(
        SCREENER_CHAT_SCOPES[m].pagePath,
        "chat-1"
      );
      const params = new URLSearchParams(href.slice(href.indexOf("?")));
      assert.equal(params.get("mode"), m);
      assert.equal(params.get("chatId"), "chat-1");
    }

    const fireHref = buildChatResumeHref(FIRE_CHAT_SCOPE.pagePath, "chat-2");
    assert.equal(fireHref, "/fire?chatId=chat-2");
  });

  test("scope pagePaths are resumable routes, not invented ones", () => {
    // "/discover/screener/etf" would be a 404: the per-mode routes do not
    // exist. The screener is ONE route that keeps its mode in ?mode=.
    for (const m of MODES) {
      const path = SCREENER_CHAT_SCOPES[m].pagePath;
      assert.ok(
        path.startsWith("/discover/screener?"),
        `${path} is not the screener route with a query`
      );
    }
  });
});

/**
 * MONEY-1255 — StockSage's history must not list the side chats.
 *
 * Its sidebar called `listChatHistoriesAction` with NO pagePath, which was
 * correct while StockSage was the only writer. MONEY-1245 gave Ask FIRE and
 * Ask Screener saved chats on the same table, and they began appearing there.
 * Nothing about the sidebar changed — its meaning did, because the table
 * stopped being single-tenant.
 *
 * `SIDE_CHAT_PAGE_PATHS` is what the sidebar excludes. It is DERIVED from the
 * scopes rather than hand-listed, and these cases defend that: the first
 * attempt hardcoded ["/fire", "/discover/screener"] and was already wrong,
 * because the screener saves under three per-mode paths and the bare path
 * matches none of them.
 */
describe("side-chat paths excluded from StockSage history (MONEY-1255)", () => {
  test("covers Ask FIRE", () => {
    assert.ok(SIDE_CHAT_PAGE_PATHS.includes(FIRE_CHAT_SCOPE.pagePath));
  });

  test("[regression] covers EVERY screener mode, not a bare path", () => {
    for (const mode of MODES) {
      const path = SCREENER_CHAT_SCOPES[mode].pagePath;
      assert.ok(
        SIDE_CHAT_PAGE_PATHS.includes(path),
        `screener mode "${mode}" (${path}) would leak into StockSage history`
      );
    }
  });

  test("[regression] a new screener mode is excluded automatically", () => {
    // The list is derived, so it must equal the scopes' own paths exactly —
    // no more (over-excluding a StockSage page) and no fewer (a leak).
    const expected = new Set<string>([
      FIRE_CHAT_SCOPE.pagePath,
      ...MODES.map((m) => SCREENER_CHAT_SCOPES[m].pagePath),
    ]);
    assert.deepEqual(new Set(SIDE_CHAT_PAGE_PATHS), expected);
  });

  test("does NOT exclude a page StockSage actually runs on", () => {
    // StockSage is embedded across many routes; over-excluding would silently
    // drop real chats from its history, which is why this is an exclusion
    // list and not an allowlist.
    for (const p of ["/dashboard", "/holdings", "/stock/TCS", "/tradebook"]) {
      assert.ok(!SIDE_CHAT_PAGE_PATHS.includes(p), `${p} must stay listed`);
    }
  });
});
