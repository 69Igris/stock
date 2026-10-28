/**
 * MONEY-1082 — route-scoped URL write decisions.
 *
 * The defect these guard against: a URL write issued by a page the user has
 * already left (or is mid-transition away from) re-asserts the old route and
 * yanks them back. The decision functions here are the gate; every assertion
 * below is a scenario that produced the yank-back in prod/QA.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildSearch,
  buildChatResumeHref,
  decideRouteNavigation,
  decideUrlSync,
  normalizePath,
  normalizeSearch,
} from "../../lib/navigation/url-sync-logic";

describe("normalizeSearch", () => {
  test("canonicalises the empty forms to ''", () => {
    assert.equal(normalizeSearch(""), "");
    assert.equal(normalizeSearch("?"), "");
  });

  test("adds a leading ? when missing and keeps one when present", () => {
    assert.equal(normalizeSearch("tab=mf"), "?tab=mf");
    assert.equal(normalizeSearch("?tab=mf"), "?tab=mf");
  });
});

describe("normalizePath", () => {
  test("treats a trailing slash as insignificant", () => {
    assert.equal(normalizePath("/holdings/"), "/holdings");
    assert.equal(normalizePath("/holdings"), "/holdings");
  });

  test("preserves the root path", () => {
    assert.equal(normalizePath("/"), "/");
  });

  test("returns '' for empty input rather than throwing", () => {
    assert.equal(normalizePath(""), "");
  });
});

describe("decideUrlSync", () => {
  test("writes when still on the owning route and the query changed", () => {
    const decision = decideUrlSync({
      ownerPath: "/holdings",
      livePath: "/holdings",
      liveSearch: "",
      nextSearch: "?tab=mf",
    });
    assert.deepEqual(decision, { action: "write", url: "/holdings?tab=mf" });
  });

  test("THE BUG: drops the write once the user has navigated away", () => {
    // /holdings issued a tab sync, the user clicked through to /dashboard,
    // and the write resolved afterwards. Writing here is what dragged the
    // user back to /holdings.
    const decision = decideUrlSync({
      ownerPath: "/holdings",
      livePath: "/dashboard",
      liveSearch: "",
      nextSearch: "?tab=mf",
    });
    assert.deepEqual(decision, { action: "skip", reason: "off-route" });
  });

  test("drops the write even when the stale page wanted the empty query", () => {
    // The default-tab case: /holdings wants to clear ?tab= entirely. Left
    // unguarded this rewrites the URL to bare /holdings from /dashboard.
    const decision = decideUrlSync({
      ownerPath: "/holdings",
      livePath: "/dashboard",
      liveSearch: "?view=chat",
      nextSearch: "",
    });
    assert.deepEqual(decision, { action: "skip", reason: "off-route" });
  });

  test("skips a no-op write so repeated renders don't churn history", () => {
    const decision = decideUrlSync({
      ownerPath: "/discover/screener",
      livePath: "/discover/screener",
      liveSearch: "?mode=stocks",
      nextSearch: "?mode=stocks",
    });
    assert.deepEqual(decision, { action: "skip", reason: "unchanged" });
  });

  test("treats '?' and '' as the same query when deciding no-op", () => {
    const decision = decideUrlSync({
      ownerPath: "/holdings",
      livePath: "/holdings",
      liveSearch: "?",
      nextSearch: "",
    });
    assert.deepEqual(decision, { action: "skip", reason: "unchanged" });
  });

  test("normalises a missing leading ? on the caller's next query", () => {
    const decision = decideUrlSync({
      ownerPath: "/holdings",
      livePath: "/holdings",
      liveSearch: "",
      nextSearch: "tab=positions",
    });
    assert.deepEqual(decision, {
      action: "write",
      url: "/holdings?tab=positions",
    });
  });

  test("a trailing slash on either side is still the same owner", () => {
    const decision = decideUrlSync({
      ownerPath: "/holdings",
      livePath: "/holdings/",
      liveSearch: "",
      nextSearch: "?tab=mf",
    });
    assert.equal(decision.action, "write");
  });

  test("a nested route is NOT the owner of its parent", () => {
    // /discover/screener must not be rewritten by /discover, nor vice versa.
    assert.deepEqual(
      decideUrlSync({
        ownerPath: "/discover",
        livePath: "/discover/screener",
        liveSearch: "",
        nextSearch: "?tab=mf",
      }),
      { action: "skip", reason: "off-route" }
    );
  });
});

describe("decideRouteNavigation", () => {
  test("allows a redirect decided by the page the user is still on", () => {
    assert.deepEqual(decideRouteNavigation("/analysis", "/analysis"), {
      action: "navigate",
    });
  });

  test("THE BUG: blocks a redirect that resolved after the user left", () => {
    // /analysis reads ?sessionId= and forwards to /analysis/<id>. If that
    // effect fires once the user is on /dashboard, the forward yanks them
    // out of the page they asked for.
    assert.deepEqual(decideRouteNavigation("/analysis", "/dashboard"), {
      action: "skip",
      reason: "off-route",
    });
  });

  test("dynamic owner paths compare by their concrete pathname", () => {
    assert.deepEqual(decideRouteNavigation("/stock/RELIANCE", "/stock/TCS"), {
      action: "skip",
      reason: "off-route",
    });
    assert.deepEqual(
      decideRouteNavigation("/stock/RELIANCE", "/stock/RELIANCE"),
      { action: "navigate" }
    );
  });
});

describe("buildSearch", () => {
  test("merge preserves params owned by other components", () => {
    // The embedded chat panel owns ?chatId=; a tab switch on the same route
    // must not drop it.
    assert.equal(
      buildSearch("?chatId=abc", { tab: "mf" }, "merge"),
      "?chatId=abc&tab=mf"
    );
  });

  test("replace makes the caller's params the entire query", () => {
    assert.equal(
      buildSearch("?chatId=abc", { tab: "mf" }, "replace"),
      "?tab=mf"
    );
  });

  test("null, undefined and '' all delete the key", () => {
    assert.equal(buildSearch("?tab=mf", { tab: null }, "merge"), "");
    assert.equal(buildSearch("?tab=mf", { tab: undefined }, "merge"), "");
    assert.equal(buildSearch("?tab=mf", { tab: "" }, "merge"), "");
  });

  test("deleting the only key yields '' rather than '?'", () => {
    // A bare "?" would compare unequal to "" and cause a pointless write.
    assert.equal(buildSearch("?tab=mf", { tab: null }, "merge"), "");
  });

  test("overwrites an existing value for an owned key", () => {
    assert.equal(
      buildSearch("?tab=stocks&q=rel", { tab: "positions" }, "merge"),
      "?tab=positions&q=rel"
    );
  });

  test("percent-encodes values so a query can't be smuggled in", () => {
    assert.equal(buildSearch("", { q: "a&b=c" }, "replace"), "?q=a%26b%3Dc");
  });

  test("merge from an empty live query behaves like replace", () => {
    assert.equal(buildSearch("", { tab: "mf" }, "merge"), "?tab=mf");
  });
});

describe("buildChatResumeHref (MONEY-1245 side-chat scopes)", () => {
  test("appends chatId to a bare page path", () => {
    assert.equal(buildChatResumeHref("/fire", "abc123"), "/fire?chatId=abc123");
  });

  test("MERGES into a pagePath that already carries a query", () => {
    // The regression this exists for. Ask Screener scopes its history per
    // mode, so pagePath is "/discover/screener?mode=etf". The old call site
    // concatenated `${pagePath}?chatId=${id}` and emitted a SECOND "?".
    assert.equal(
      buildChatResumeHref("/discover/screener?mode=etf", "abc123"),
      "/discover/screener?mode=etf&chatId=abc123"
    );
  });

  test("the double-'?' form really does lose both params", () => {
    // Pins WHY the concat was wrong, not just that the new output differs:
    // URLSearchParams reads to the next "&", so mode swallows the chat id.
    // The panel then sees no chatId (no resume) and the screener sees a mode
    // matching nothing (default screen) — a silent double failure.
    const broken = "/discover/screener?mode=etf" + "?chatId=abc123";
    const bad = new URLSearchParams(broken.slice(broken.indexOf("?")));
    assert.equal(bad.get("mode"), "etf?chatId=abc123");
    assert.equal(bad.get("chatId"), null);
  });

  test("the built href parses back to BOTH params", () => {
    const href = buildChatResumeHref("/discover/screener?mode=etf", "abc123");
    const params = new URLSearchParams(href.slice(href.indexOf("?")));
    assert.equal(params.get("mode"), "etf");
    assert.equal(params.get("chatId"), "abc123");
  });

  test("every screener mode resumes onto its own screen", () => {
    for (const mode of ["stocks", "etf", "mf"]) {
      const href = buildChatResumeHref(
        `/discover/screener?mode=${mode}`,
        "id1"
      );
      const params = new URLSearchParams(href.slice(href.indexOf("?")));
      assert.equal(params.get("mode"), mode);
      assert.equal(params.get("chatId"), "id1");
    }
  });

  test("replaces a stale chatId rather than appending a second one", () => {
    assert.equal(
      buildChatResumeHref("/fire?chatId=old", "new"),
      "/fire?chatId=new"
    );
  });

  test("an empty id yields the bare page href, not a dangling '?chatId='", () => {
    // No id means no resume. A trailing "?chatId=" would be consumed as an
    // empty deep link and mark itself used for nothing.
    assert.equal(buildChatResumeHref("/fire", ""), "/fire");
    assert.equal(
      buildChatResumeHref("/discover/screener?mode=mf", ""),
      "/discover/screener?mode=mf"
    );
  });

  test("percent-encodes the id so it cannot smuggle extra params", () => {
    assert.equal(
      buildChatResumeHref("/fire", "a&mode=stocks"),
      "/fire?chatId=a%26mode%3Dstocks"
    );
  });
});
