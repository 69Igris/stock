/**
 * MONEY-1157 — the heatmap's single-flight timeout must not escape its own
 * error handling.
 *
 * `cachedWithStaleFallback` reports failure TWO ways and the action only
 * handled one. Everything `compute` throws is folded into the RETURNED outcome
 * (`failed` / `stale`) by `resolveWithStaleFallback`, which made the outcome
 * branches in `getHeatmapDataAction` look exhaustive. They were not: the
 * helper's own single-flight backstop REJECTS — `withDeadline` throws
 * `SingleFlightTimeoutError` at `SINGLE_FLIGHT_TIMEOUT_MS` (25s) at the leader
 * and at every follower on the key.
 *
 * That rejection went straight past `outcome.status === "failed"`, so:
 *   - the sanitising `console.warn` there (the file's own comment calls it
 *     "the only record of what actually broke") never ran, and
 *   - the raw internal message reached the client instead of the generic
 *     "Failed to load market heatmap".
 *
 * Prime suspect for the 2026-08-08 prod render of "Couldn't load the sector
 * heatmap · 0 sectors" after a cold deploy, which recovered with no code
 * change once the cache was warm.
 *
 * Drives the REAL `getHeatmapDataAction` through the `require.cache` seam (same
 * technique as ./summary-ssr.test.ts), stubbing ONLY the cache helper — the
 * stub keeps the REAL `SingleFlightTimeoutError` class so the action's
 * `instanceof` check is the production one, not a look-alike. `compute` is
 * never invoked, so nothing here touches Prisma. Runs under the default
 * `node --import tsx --test` (CJS); CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/discover-heatmap.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { ResolveOutcome } from "@usemoney/core/cache/stale-while-error";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ACTION_REL = "../../lib/actions/discover-heatmap";
const CACHE_SPECIFIER = "@usemoney/core/cache/stale-while-error";

const CACHE_PATH = require.resolve(CACHE_SPECIFIER);
const ACTION_PATH = require.resolve(ACTION_REL);

/** The REAL module, captured before the cache entry is swapped for the stub. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realCacheModule = require(CACHE_SPECIFIER) as {
  SingleFlightTimeoutError: new (key: string, timeoutMs: number) => Error;
};
const { SingleFlightTimeoutError } = realCacheModule;

const priorCacheEntry = moduleCache()[CACHE_PATH];
const priorActionEntry = moduleCache()[ACTION_PATH];

interface HeatmapShape {
  stocks: unknown[];
  coverage: { totalScope: number; withQuote: number; withSector: number };
  asOf: string;
  stale?: boolean;
  staleSince?: number;
}

const FRESH_DATA: HeatmapShape = {
  stocks: [],
  coverage: { totalScope: 1, withQuote: 1, withSector: 1 },
  asOf: "2026-08-08T04:00:00.000Z",
};

interface ActionMod {
  getHeatmapDataAction: (args: {
    scope: "all" | "nifty50" | "nifty500";
    timeframe?: "1D" | "1W" | "1M" | "YTD";
  }) => Promise<{ success: boolean; error?: string; data?: HeatmapShape }>;
}

/**
 * Install a `cachedWithStaleFallback` that behaves however the case needs, then
 * (re)load the action so it binds to the stub. `compute` is deliberately never
 * called — this file is about what happens AROUND the compute.
 */
function loadActionWith(
  behaviour: () => Promise<ResolveOutcome<HeatmapShape>>
): ActionMod {
  const cache = moduleCache();
  cache[CACHE_PATH] = {
    exports: {
      ...realCacheModule,
      __esModule: true,
      cachedWithStaleFallback: () => behaviour(),
    },
  };
  delete cache[ACTION_PATH];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ActionMod;
}

/** Capture console output without letting it reach the test runner's stdout. */
const logged: { warn: string[]; error: string[] } = { warn: [], error: [] };
const realWarn = console.warn;
const realError = console.error;

beforeEach(() => {
  logged.warn = [];
  logged.error = [];
  console.warn = (...args: unknown[]) => {
    logged.warn.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logged.error.push(args.map(String).join(" "));
  };
});

after(() => {
  console.warn = realWarn;
  console.error = realError;
  const cache = moduleCache();
  if (priorCacheEntry === undefined) delete cache[CACHE_PATH];
  else cache[CACHE_PATH] = priorCacheEntry;
  if (priorActionEntry === undefined) delete cache[ACTION_PATH];
  else cache[ACTION_PATH] = priorActionEntry;
});

describe("MONEY-1157 — heatmap single-flight timeout handling", () => {
  it("[regression] a SingleFlightTimeoutError RESOLVES as a failed result instead of escaping", async () => {
    const mod = loadActionWith(() =>
      Promise.reject(
        new SingleFlightTimeoutError("discover:_global:heatmap:all:1D", 25_000)
      )
    );

    // Before the fix this REJECTED: the raw error propagated out of the server
    // action, past every outcome branch below it.
    const result = await mod.getHeatmapDataAction({ scope: "all" });

    assert.equal(result.success, false);
    assert.equal(result.error, "Failed to load market heatmap");
  });

  it("[regression] the sanitising warn — the only record of what broke — actually runs", async () => {
    const mod = loadActionWith(() =>
      Promise.reject(
        new SingleFlightTimeoutError("discover:_global:heatmap:all:1D", 25_000)
      )
    );

    await mod.getHeatmapDataAction({ scope: "all" });

    const line = logged.warn.find((l) => l.includes("getHeatmapDataAction"));
    assert.ok(line, "the failed branch must log exactly once, on console.warn");
    assert.match(line!, /scope=all/);
    assert.match(line!, /exceeded 25000ms/);
  });

  it("never leaks the internal message into the user-facing string", async () => {
    const mod = loadActionWith(() =>
      Promise.reject(
        new SingleFlightTimeoutError("discover:_global:heatmap:all:1D", 25_000)
      )
    );

    const result = await mod.getHeatmapDataAction({ scope: "nifty50" });

    assert.equal(result.error, "Failed to load market heatmap");
    assert.equal(result.error?.includes("single-flight"), false);
    assert.equal(result.error?.includes("25000"), false);
  });

  it("contains an ARBITRARY throw too, but logs it distinctly so a real bug cannot hide as a timeout", async () => {
    // The catch must not be so wide that a genuine programming error reads as
    // a routine 25s timeout. It is still contained (a server action returns a
    // ServiceResult, it does not throw at the client) — but it is loud.
    const mod = loadActionWith(() =>
      Promise.reject(new TypeError("cannot read properties of undefined"))
    );

    const result = await mod.getHeatmapDataAction({ scope: "all" });

    assert.equal(result.success, false);
    assert.equal(result.error, "Failed to load market heatmap");

    const distinct = logged.error.find((l) =>
      l.includes("unexpected error escaped")
    );
    assert.ok(
      distinct,
      "a non-timeout escape must be logged at error level, not folded into the timeout line"
    );
    assert.match(distinct!, /cannot read properties of undefined/);
    assert.equal(
      logged.error.some((l) => l.includes("single-flight")),
      false
    );
  });

  it("does not swallow the error — a timeout is never reported as success", async () => {
    const mod = loadActionWith(() =>
      Promise.reject(
        new SingleFlightTimeoutError("discover:_global:heatmap:all:1D", 25_000)
      )
    );

    const result = await mod.getHeatmapDataAction({ scope: "all" });

    assert.equal(result.success, false);
    assert.equal(result.data, undefined);
    assert.ok(logged.warn.length + logged.error.length > 0, "never silent");
  });

  it("leaves the FRESH path untouched — the new catch must not mask normal operation", async () => {
    const mod = loadActionWith(async () => ({
      status: "fresh" as const,
      data: FRESH_DATA,
    }));

    const result = await mod.getHeatmapDataAction({ scope: "all" });

    assert.equal(result.success, true);
    assert.deepEqual(result.data, FRESH_DATA);
    assert.deepEqual(logged.warn, []);
    assert.deepEqual(logged.error, []);
  });

  it("leaves the STALE path untouched — it still degrades rather than dead-ends", async () => {
    const computedAt = Date.parse("2026-08-08T03:00:00.000Z");
    const mod = loadActionWith(async () => ({
      status: "stale" as const,
      data: FRESH_DATA,
      computedAt,
      error: new Error("db blip"),
    }));

    const result = await mod.getHeatmapDataAction({ scope: "all" });

    assert.equal(result.success, true);
    assert.equal(result.data?.stale, true);
    assert.equal(result.data?.staleSince, computedAt);
    assert.equal(logged.error.length, 0);
  });
});
