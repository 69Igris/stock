/**
 * Pure decision logic for route-scoped URL writes (MONEY-1082).
 *
 * ## The bug this exists to prevent
 *
 * App Router navigations run inside `startTransition`: when the user clicks
 * through to a new route, the OLD page stays mounted and keeps re-rendering
 * until the new route's RSC payload arrives. Anything the old page does in
 * that window still runs — including a `router.replace()` from a URL-sync
 * effect, or the `.then()` of a fetch that started before the click.
 *
 * A URL write issued from that stale context re-asserts the old route and
 * cancels (or undoes) the navigation the user actually asked for. The user
 * sees the new page load and then get yanked back to the page they left.
 * The `/discover/screener` page hit this first and worked around it locally:
 *
 *   "the row navigation to /stock/{symbol} gets yanked back to
 *    /discover/screener when this effect fires during the transition"
 *
 * ## The two writes, and why only one of them is safe
 *
 * Next patches `window.history.pushState`/`replaceState` so external URL
 * changes stay in sync with the router (see `app-router.js`). The patch
 * early-returns to the untouched browser API when the state object carries
 * Next's own `__NA` marker:
 *
 *   history.replaceState(window.history.state, "", url)  // has __NA
 *     -> original replaceState. URL bar only. No router dispatch, no RSC
 *        refetch, cannot change the route.
 *
 *   history.replaceState({}, "", url)   // or (null, ...) — no __NA
 *     -> applyUrlFromHistoryPushReplace() -> ACTION_RESTORE. The router's
 *        canonical URL changes; usePathname/useSearchParams update. This is
 *        a real navigation wearing a history-API costume.
 *
 * So `writeSearchToUrlBar` below always forwards `window.history.state`.
 * That is load-bearing, not incidental — dropping it converts a URL-bar
 * touch-up into a navigation.
 *
 * ## Route ownership
 *
 * Mechanism alone isn't enough: rewriting the URL bar while the user is on
 * a different page is its own bug. Every write is therefore gated on the
 * caller still being on the route that owns it, compared against the LIVE
 * `window.location` rather than React state (which lags a transition).
 *
 * Consumed by `useOwnedRoute` (apps/web/lib/hooks/useOwnedRoute.ts). Kept
 * pure and React-free so it can be unit-tested under node:test.
 */

/** How a page's query string is combined with params it doesn't own. */
export type SearchMergeMode =
  /**
   * The page owns the entire query string; keys it didn't set are dropped.
   * Use when the page is the only writer for that route.
   */
  | "replace"
  /**
   * Only the keys the caller names are touched; every other key already in
   * the URL is preserved. Use when another component also writes params to
   * the same route (e.g. the embedded chat panel's `chatId`).
   */
  | "merge";

export interface UrlSyncInput {
  /** Path the calling component belongs to, e.g. `/holdings`. */
  ownerPath: string;
  /** `window.location.pathname` read at write time. */
  livePath: string;
  /** `window.location.search` read at write time — leading `?` or empty. */
  liveSearch: string;
  /** Desired query string — with or without a leading `?`. */
  nextSearch: string;
}

export type UrlSyncDecision =
  | { action: "write"; url: string }
  | { action: "skip"; reason: "off-route" | "unchanged" };

/**
 * Normalise a query string to the canonical `?a=1` / `""` shape so the
 * "did anything actually change?" comparison can't be fooled by a bare `?`
 * or a missing one.
 */
export function normalizeSearch(search: string): string {
  if (!search) return "";
  const body = search.startsWith("?") ? search.slice(1) : search;
  return body ? `?${body}` : "";
}

/**
 * Normalise a pathname for ownership comparison: trailing slashes are
 * insignificant to Next's routing, so `/holdings/` and `/holdings` are the
 * same owner. The root path stays `/`.
 */
export function normalizePath(path: string): string {
  if (!path) return "";
  if (path === "/") return "/";
  return path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

/**
 * Decide whether a route-scoped query-string write should happen.
 *
 * Skips when the app has moved off the owning route (the stale-write case
 * this module exists for) and when the URL already says what we were going
 * to write (avoids pointless history churn on every render).
 */
export function decideUrlSync(input: UrlSyncInput): UrlSyncDecision {
  const owner = normalizePath(input.ownerPath);
  const live = normalizePath(input.livePath);

  if (owner !== live) return { action: "skip", reason: "off-route" };

  const next = normalizeSearch(input.nextSearch);
  if (normalizeSearch(input.liveSearch) === next) {
    return { action: "skip", reason: "unchanged" };
  }

  return { action: "write", url: `${live}${next}` };
}

/**
 * Decide whether a cross-route navigation issued by a page should still go
 * through. Same ownership rule as {@link decideUrlSync}: a redirect decided
 * by /analysis must not fire once the user is on /dashboard.
 */
export function decideRouteNavigation(
  ownerPath: string,
  livePath: string
): { action: "navigate" } | { action: "skip"; reason: "off-route" } {
  return normalizePath(ownerPath) === normalizePath(livePath)
    ? { action: "navigate" }
    : { action: "skip", reason: "off-route" };
}

/**
 * Build the next query string for a route-scoped write.
 *
 * `merge` starts from what's live in the URL right now and applies only the
 * caller's keys, so params owned by other components survive. `replace`
 * starts empty — the caller's params become the whole query string.
 *
 * A key mapped to `null`/`undefined` is deleted, which is how callers clear
 * a param (e.g. the default tab drops `?tab=` instead of writing `?tab=all`).
 */
export function buildSearch(
  liveSearch: string,
  owned: Record<string, string | null | undefined>,
  mode: SearchMergeMode
): string {
  const params = new URLSearchParams(
    mode === "merge" ? normalizeSearch(liveSearch) : ""
  );

  for (const [key, value] of Object.entries(owned)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }

  return normalizeSearch(params.toString());
}

/**
 * Build the href that resumes a saved chat on the page that owns it.
 *
 * `ChatHistory.pagePath` is usually a bare route ("/fire"), but Ask Screener
 * scopes its history per mode, so it also stores paths that already carry a
 * query ("/discover/screener?mode=etf").
 *
 * The original call site concatenated `${pagePath}?chatId=${id}` directly.
 * For a bare path that is fine; for a path with a query it emits a SECOND
 * "?", and `URLSearchParams` reads everything up to the next "&" as one
 * value — `mode` arrives as "etf?chatId=abc". The chat id is then invisible
 * to the panel AND the mode no longer matches any known mode, so the resume
 * silently lands on the default screen with no chat loaded. Merging through
 * {@link buildSearch} keeps whatever the stored path carries and adds
 * `chatId` beside it.
 *
 * An empty `chatId` yields the bare page href rather than `?chatId=`, which
 * is the honest degradation: no id, no resume.
 */
export function buildChatResumeHref(pagePath: string, chatId: string): string {
  const queryAt = pagePath.indexOf("?");
  const path = queryAt === -1 ? pagePath : pagePath.slice(0, queryAt);
  const search = queryAt === -1 ? "" : pagePath.slice(queryAt);
  return `${path}${buildSearch(search, { chatId }, "merge")}`;
}

/* ────────────────────────────────────────────────────────────────────────
   Injectable seams.

   The decision functions above are easy to test but were never the part
   that broke — the defect lived in the imperative call that followed them
   (`replaceState({}, …)` instead of forwarding `window.history.state`).
   These wrappers take the browser/router surface as data so that call is
   testable under node:test, where there is no DOM. `useOwnedRoute` is a
   thin adapter that passes the real `window` and `router` in.
   ──────────────────────────────────────────────────────────────────────── */

export interface UrlSyncEnv {
  /** Live `window.location.pathname`. */
  pathname: string;
  /** Live `window.location.search`. */
  search: string;
  /**
   * Live `window.history.state`, forwarded VERBATIM to `replaceState`.
   * It carries Next's `__NA` marker, which is what makes the patched
   * replaceState skip its router dispatch. Substituting `{}` or `null`
   * here turns a URL-bar edit into a real navigation — the MONEY-1082 bug.
   */
  historyState: unknown;
  replaceState: (state: unknown, unused: string, url: string) => void;
}

/**
 * Perform a route-scoped query-string write, or decline to. Returns the
 * decision so callers (and tests) can see why nothing happened.
 */
export function applyUrlSync(
  ownerPath: string,
  nextSearch: string,
  env: UrlSyncEnv
): UrlSyncDecision {
  const decision = decideUrlSync({
    ownerPath,
    livePath: env.pathname,
    liveSearch: env.search,
    nextSearch,
  });

  if (decision.action === "write") {
    env.replaceState(env.historyState, "", decision.url);
  }
  return decision;
}

export interface RouteNavEnv {
  /** Live `window.location.pathname`. */
  pathname: string;
  navigate: (href: string, options?: { scroll?: boolean }) => void;
}

/**
 * Perform a cross-route navigation decided by `ownerPath`, or decline to
 * because the app has since moved elsewhere.
 */
export function applyGuardedNavigation(
  ownerPath: string,
  href: string,
  env: RouteNavEnv,
  options?: { scroll?: boolean }
): { action: "navigate" } | { action: "skip"; reason: "off-route" } {
  const decision = decideRouteNavigation(ownerPath, env.pathname);
  if (decision.action === "navigate") env.navigate(href, options);
  return decision;
}
