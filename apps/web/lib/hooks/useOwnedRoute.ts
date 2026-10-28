"use client";

/**
 * useOwnedRoute (MONEY-1082)
 *
 * Route-scoped URL writes that can't yank the user back to a page they've
 * already left. See `lib/navigation/url-sync-logic.ts` for the full write-up
 * of the failure mode; the short version:
 *
 *   App Router navigations are transitions, so the outgoing page stays
 *   mounted while the next route streams in. A `router.replace()` from a
 *   URL-sync effect — or from the `.then()` of a fetch that started before
 *   the click — still runs in that window and re-asserts the old route.
 *
 * Every write here is gated on the caller still being on the route that
 * owns it, checked against the LIVE `window.location` (React's `usePathname`
 * lags a pending transition, so it can't be the source of truth).
 *
 * Usage — query-string state on the page's own route:
 *
 *   const route = useOwnedRoute("/holdings");
 *   // inside the click handler that changed the state, NOT an effect:
 *   route.syncParams({ tab: next === "stocks" ? null : next });
 *
 * Usage — a redirect a page decides for itself:
 *
 *   const route = useOwnedRoute("/analysis");
 *   route.replaceRoute(`/analysis/${sessionId}`);
 *
 * ## Which method to reach for
 *
 * `syncParams`/`syncSearch` touch the URL bar only — no router dispatch, no
 * RSC refetch, no scroll reset. That makes them cheap, but it also means
 * `useSearchParams()` does NOT observe the write.
 *
 *   - URL is write-only (a bookmark for state React already owns, e.g. a
 *     tab held in `useState`) -> `syncParams` / `syncSearch`.
 *   - URL is the source of truth (the component reads the value back via
 *     `useSearchParams()`, or a server component re-renders on it)
 *     -> `replaceRoute` / `pushRoute`, which are real navigations.
 *
 * Picking the first for a param you later read back leaves React holding a
 * stale value, so check how the param is consumed before choosing.
 */

import { useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  applyGuardedNavigation,
  applyUrlSync,
  buildSearch,
  decideRouteNavigation,
  type SearchMergeMode,
} from "@/lib/navigation/url-sync-logic";

export interface OwnedRouteApi {
  /**
   * Write query params on the owning route. No-ops when the app has since
   * navigated elsewhere, or when the URL already matches.
   *
   * @param owned Params this caller owns. `null`/`undefined`/`""` deletes.
   * @param mode  `"merge"` (default) preserves params owned by other
   *              components on the same route; `"replace"` makes these
   *              params the entire query string.
   */
  syncParams: (
    owned: Record<string, string | null | undefined>,
    mode?: SearchMergeMode
  ) => void;
  /**
   * Same guarantees as {@link syncParams}, for callers that already build a
   * complete query string (leading `?` optional). The string becomes the
   * whole query — there is no merge, since the caller authored all of it.
   */
  syncSearch: (nextSearch: string) => void;
  /** Guarded `router.replace` — skipped if we've left the owning route. */
  replaceRoute: (href: string, options?: { scroll?: boolean }) => void;
  /** Guarded `router.push` — skipped if we've left the owning route. */
  pushRoute: (href: string, options?: { scroll?: boolean }) => void;
  /** True when the live URL still belongs to this route. */
  isOnOwnedRoute: () => boolean;
}

/**
 * @param ownerPath Route this component belongs to, e.g. `/holdings`. Omit
 *   on a dynamic route (`/analysis/[sessionId]`) to capture the concrete
 *   pathname at mount — that's the path the component lives on, which is
 *   exactly what a late write must be compared against.
 */
export function useOwnedRoute(ownerPath?: string): OwnedRouteApi {
  const router = useRouter();
  const pathname = usePathname();

  // Captured once. Re-reading `usePathname()` later would defeat the guard:
  // during a transition it still reports the old path, and after one it
  // reports the new page — neither answers "which route owns this write?".
  const mountedPathRef = useRef<string | null>(null);
  if (mountedPathRef.current === null) {
    mountedPathRef.current = pathname ?? "";
  }
  const owner = ownerPath ?? mountedPathRef.current;

  const isOnOwnedRoute = useCallback(() => {
    if (typeof window === "undefined") return false;
    return (
      decideRouteNavigation(owner, window.location.pathname).action ===
      "navigate"
    );
  }, [owner]);

  const syncSearch = useCallback(
    (nextSearch: string) => {
      if (typeof window === "undefined") return;

      // Forwarding `window.history.state` is load-bearing: it carries Next's
      // `__NA` marker, which makes the patched replaceState fall through to
      // the untouched browser API. Pass `{}` or `null` instead and Next
      // dispatches ACTION_RESTORE — i.e. a real navigation.
      applyUrlSync(owner, nextSearch, {
        pathname: window.location.pathname,
        search: window.location.search,
        historyState: window.history.state,
        replaceState: (state, unused, url) =>
          window.history.replaceState(state, unused, url),
      });
    },
    [owner]
  );

  const syncParams = useCallback(
    (
      owned: Record<string, string | null | undefined>,
      mode: SearchMergeMode = "merge"
    ) => {
      if (typeof window === "undefined") return;
      syncSearch(buildSearch(window.location.search, owned, mode));
    },
    [syncSearch]
  );

  const replaceRoute = useCallback(
    (href: string, options?: { scroll?: boolean }) => {
      if (typeof window === "undefined") return;
      applyGuardedNavigation(
        owner,
        href,
        {
          pathname: window.location.pathname,
          navigate: (to, opts) => router.replace(to, opts),
        },
        options
      );
    },
    [owner, router]
  );

  const pushRoute = useCallback(
    (href: string, options?: { scroll?: boolean }) => {
      if (typeof window === "undefined") return;
      applyGuardedNavigation(
        owner,
        href,
        {
          pathname: window.location.pathname,
          navigate: (to, opts) => router.push(to, opts),
        },
        options
      );
    },
    [owner, router]
  );

  return useMemo(
    () => ({ syncParams, syncSearch, replaceRoute, pushRoute, isOnOwnedRoute }),
    [syncParams, syncSearch, replaceRoute, pushRoute, isOnOwnedRoute]
  );
}
