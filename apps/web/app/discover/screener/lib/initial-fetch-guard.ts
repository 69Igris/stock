/**
 * Mount-time refetch guard for the screener client (MONEY-1131).
 *
 * The client's three per-mode effects fire on mount with EXACTLY the inputs the
 * server already resolved into `initial*Page` — same filters, same query, page
 * 0, sort "match" (the SortDropdown runs controlled, so it does not push a
 * stored value up on mount). Without a guard, every screener load ran its
 * screen twice: once in SSR, again the instant the client hydrated.
 *
 * Two rules make the guard safe, and both are load-bearing:
 *
 *   1. It arms ONE mode — the one the server actually seeded. Since MONEY-1131
 *      the server screens only the requested tab, so the other two are
 *      genuinely un-seeded and their first effect run MUST fetch. Arming them
 *      would leave an empty table behind a tab switch.
 *   2. It arms only when that seed SUCCEEDED. A screen that timed out or
 *      errored server-side has to be retried client-side; skipping there would
 *      turn a transient failure into a permanently empty table with nothing in
 *      flight.
 *
 * Lives here rather than inline in client.tsx so the decision is a pure
 * function the suite can drive directly — the component itself is not mountable
 * in this repo's node:test setup.
 */

import type { ScreenerMode } from "@/components/screener/ModeTabs";

/** Per-mode "the next effect run is a duplicate of SSR — skip it" flags. */
export type InitialFetchGuard = Record<ScreenerMode, boolean>;

/**
 * @param seededMode the mode the server rendered results for
 * @param seeded     whether that server-side screen actually succeeded
 */
export function buildInitialFetchGuard(
  seededMode: ScreenerMode,
  seeded: boolean
): InitialFetchGuard {
  return {
    stocks: seeded && seededMode === "stocks",
    mf: seeded && seededMode === "mf",
    etf: seeded && seededMode === "etf",
  };
}

/**
 * Returns true when the caller must SKIP this run, and consumes the flag so
 * only the FIRST run is ever skipped — switching away and back always refetches.
 *
 * Mutates `guard` deliberately: it is held in a ref, and a skip decision must
 * take effect within the same effect invocation that made it (a state update
 * would not have landed yet).
 */
export function consumeInitialFetchSkip(
  guard: InitialFetchGuard,
  mode: ScreenerMode
): boolean {
  if (!guard[mode]) return false;
  guard[mode] = false;
  return true;
}
