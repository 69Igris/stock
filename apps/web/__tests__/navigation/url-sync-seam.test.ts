/**
 * MONEY-1082 — the IMPERATIVE half of route-scoped URL writes.
 *
 * Why this file exists (RCA): the decision logic was never the part that
 * broke. The defect lived in the call that followed it —
 * `history.replaceState({}, …)` / `(null, …)` instead of forwarding
 * `window.history.state`. Without the state object, Next's patched
 * replaceState skips its `__NA` bypass and dispatches ACTION_RESTORE,
 * i.e. a real navigation. `lib/pricing/useBillingCycle.ts` shipped that
 * bug for months WITH a green test file next to it, because the test only
 * covered `computeAnnualSavings` — the pure arithmetic — and never the URL
 * write.
 *
 * So these tests assert the side effect, not just the return value:
 * whether `replaceState` / `navigate` was called at all, and with exactly
 * what. `applyUrlSync` and `applyGuardedNavigation` are the same functions
 * `useOwnedRoute` calls in production — the tested path IS the shipped path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyGuardedNavigation,
  applyUrlSync,
  type UrlSyncEnv,
} from "../../lib/navigation/url-sync-logic";

/** Records every replaceState call so tests can assert the arguments. */
function makeHistoryEnv(
  pathname: string,
  search: string,
  historyState: unknown
): UrlSyncEnv & { calls: Array<{ state: unknown; url: string }> } {
  const calls: Array<{ state: unknown; url: string }> = [];
  return {
    pathname,
    search,
    historyState,
    calls,
    replaceState: (state, _unused, url) => calls.push({ state, url }),
  };
}

describe("applyUrlSync — the write", () => {
  test("writes the composed URL when still on the owning route", () => {
    const env = makeHistoryEnv("/holdings", "", { __NA: true });
    const decision = applyUrlSync("/holdings", "?tab=mf", env);

    assert.deepEqual(decision, { action: "write", url: "/holdings?tab=mf" });
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0]?.url, "/holdings?tab=mf");
  });

  test("REGRESSION: forwards history.state verbatim, never {} or null", () => {
    // This is the assertion that would have failed on the shipped code.
    // The object identity matters: Next reads `data.__NA` off it to decide
    // whether to skip its router dispatch. A fresh {} has no __NA, so the
    // patch runs ACTION_RESTORE and the "URL-bar edit" becomes a navigation.
    const liveState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["x"] };
    const env = makeHistoryEnv("/holdings", "", liveState);

    applyUrlSync("/holdings", "?tab=mf", env);

    assert.equal(env.calls.length, 1);
    assert.strictEqual(
      env.calls[0]?.state,
      liveState,
      "must pass the SAME history.state object through — a copy or {} loses __NA"
    );
    assert.notDeepEqual(env.calls[0]?.state, {});
    assert.notEqual(env.calls[0]?.state, null);
  });

  test("THE BUG: does not touch history once the user has navigated away", () => {
    // /holdings issued the write; the user is already on /dashboard.
    const env = makeHistoryEnv("/dashboard", "", { __NA: true });
    const decision = applyUrlSync("/holdings", "?tab=mf", env);

    assert.deepEqual(decision, { action: "skip", reason: "off-route" });
    assert.equal(env.calls.length, 0, "an off-route write must be a no-op");
  });

  test("off-route writes stay silent even when clearing the query", () => {
    const env = makeHistoryEnv("/dashboard", "?view=chat", { __NA: true });
    const decision = applyUrlSync("/holdings", "", env);

    assert.deepEqual(decision, { action: "skip", reason: "off-route" });
    assert.equal(env.calls.length, 0);
  });

  test("a no-op write never reaches history (no pointless churn)", () => {
    const env = makeHistoryEnv("/discover/screener", "?mode=stocks", {
      __NA: true,
    });
    const decision = applyUrlSync("/discover/screener", "?mode=stocks", env);

    assert.deepEqual(decision, { action: "skip", reason: "unchanged" });
    assert.equal(env.calls.length, 0);
  });

  test("a null history.state is forwarded as-is, not replaced with {}", () => {
    // Defensive: outside Next (or before hydration) history.state can be
    // null. We still forward it rather than substituting an object — the
    // caller's job is to pass through, not to invent state.
    const env = makeHistoryEnv("/holdings", "", null);
    applyUrlSync("/holdings", "?tab=mf", env);

    assert.equal(env.calls.length, 1);
    assert.strictEqual(env.calls[0]?.state, null);
  });

  test("repeated identical syncs collapse to a single write", () => {
    // Effect-driven callers re-run on every render; only the first should
    // land, after which the live search matches and the rest are no-ops.
    const env = makeHistoryEnv("/holdings", "", { __NA: true });
    applyUrlSync("/holdings", "?tab=mf", env);
    // Simulate the URL bar having been updated by the first write.
    env.search = "?tab=mf";
    applyUrlSync("/holdings", "?tab=mf", env);
    applyUrlSync("/holdings", "?tab=mf", env);

    assert.equal(env.calls.length, 1);
  });
});

describe("applyGuardedNavigation — the navigation", () => {
  test("navigates when the deciding page is still the live one", () => {
    const calls: Array<{ href: string; options?: { scroll?: boolean } }> = [];
    const decision = applyGuardedNavigation(
      "/analysis",
      "/analysis/abc123",
      {
        pathname: "/analysis",
        navigate: (href, options) => calls.push({ href, options }),
      },
      { scroll: false }
    );

    assert.deepEqual(decision, { action: "navigate" });
    assert.deepEqual(calls, [
      { href: "/analysis/abc123", options: { scroll: false } },
    ]);
  });

  test("THE BUG: a redirect that resolved late never fires", () => {
    // /analysis read ?sessionId= and wanted to forward, but the user is on
    // /dashboard by the time the effect ran. Firing here is the yank-back.
    const calls: string[] = [];
    const decision = applyGuardedNavigation("/analysis", "/analysis/abc123", {
      pathname: "/dashboard",
      navigate: (href) => calls.push(href),
    });

    assert.deepEqual(decision, { action: "skip", reason: "off-route" });
    assert.equal(calls.length, 0, "must not navigate from a page we left");
  });

  test("forwards options through untouched when it does navigate", () => {
    let seen: { scroll?: boolean } | undefined = { scroll: true };
    applyGuardedNavigation(
      "/help",
      "/help?tab=faq",
      { pathname: "/help", navigate: (_href, options) => (seen = options) },
      { scroll: false }
    );
    assert.deepEqual(seen, { scroll: false });
  });

  test("omitted options stay omitted rather than becoming {}", () => {
    let seen: unknown = "unset";
    applyGuardedNavigation("/help", "/help?tab=faq", {
      pathname: "/help",
      navigate: (_href, options) => (seen = options),
    });
    assert.equal(seen, undefined);
  });

  test("a dynamic route only owns its own concrete pathname", () => {
    const calls: string[] = [];
    applyGuardedNavigation("/stock/RELIANCE", "/stock/RELIANCE?tab=news", {
      pathname: "/stock/TCS",
      navigate: (href) => calls.push(href),
    });
    assert.equal(
      calls.length,
      0,
      "/stock/TCS must not be rewritten by /stock/RELIANCE"
    );
  });
});
