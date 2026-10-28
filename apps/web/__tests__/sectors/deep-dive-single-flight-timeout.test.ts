/**
 * MONEY-1157 — the sibling of the heatmap's escaped single-flight timeout.
 *
 * `cachedWithStaleFallback` has exactly TWO call sites in the repo:
 * `lib/actions/discover-heatmap.ts` (see
 * ../markets/heatmap-single-flight-timeout.test.ts) and this one. Both awaited
 * it with no `catch`, and both therefore let its single-flight backstop —
 * `SingleFlightTimeoutError` at 25s, raised by `withDeadline`, not by
 * `compute` — escape past every outcome branch below the call.
 *
 * Here that also bypassed the `SectorNotFoundError` passthrough and the
 * sanitising `console.warn` whose whole purpose is to keep raw Prisma/Mongo
 * text out of the response. This compute has more legs than the heatmap's
 * (instruments, quotes, ratios, 90-day peer daily prices, FII/DII, earnings),
 * so it is at least as likely to reach the deadline.
 *
 * Drives the REAL `getSectorDeepDiveAction` through the `require.cache` seam,
 * stubbing ONLY the cache helper and keeping its REAL error class so the
 * action's `instanceof` is the production one. `compute` is never invoked —
 * nothing here touches Prisma.
 *
 * Source: apps/web/lib/actions/sector-deep-dive.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { ResolveOutcome } from "@usemoney/core/cache/stale-while-error";
import {
  SECTOR_DEEP_DIVE_TIMEOUT_ERROR,
  SECTOR_DEEP_DIVE_FAILED_ERROR,
} from "../../lib/actions/sector-deep-dive-messages";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ACTION_REL = "../../lib/actions/sector-deep-dive";
const CACHE_SPECIFIER = "@usemoney/core/cache/stale-while-error";

const CACHE_PATH = require.resolve(CACHE_SPECIFIER);
const ACTION_PATH = require.resolve(ACTION_REL);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realCacheModule = require(CACHE_SPECIFIER) as {
  SingleFlightTimeoutError: new (key: string, timeoutMs: number) => Error;
};
const { SingleFlightTimeoutError } = realCacheModule;

const priorCacheEntry = moduleCache()[CACHE_PATH];
const priorActionEntry = moduleCache()[ACTION_PATH];

interface DeepDiveShape {
  sector: string;
  stale?: boolean;
  staleSince?: number;
}

interface ActionMod {
  getSectorDeepDiveAction: (args: { sector: string }) => Promise<{
    success: boolean;
    error?: string;
    data?: DeepDiveShape;
  }>;
}

function loadActionWith(
  behaviour: () => Promise<ResolveOutcome<DeepDiveShape>>
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

const timeout = () =>
  Promise.reject(
    new SingleFlightTimeoutError(
      "discover:_global:sector-deep-dive:Energy",
      25_000
    )
  );

describe("MONEY-1157 — sector deep-dive single-flight timeout handling", () => {
  it("[regression] a SingleFlightTimeoutError RESOLVES as a failed result instead of escaping", async () => {
    const mod = loadActionWith(timeout);

    const result = await mod.getSectorDeepDiveAction({ sector: "Energy" });

    assert.equal(result.success, false);
    // A timeout now reports DISTINCTLY from a generic failure, so the panel
    // can say "this was slow, try again" instead of implying a breakage.
    // Still a fixed constant — the sanitising rule the next case pins is
    // untouched — so this is a narrowing of the old assertion, not a
    // loosening: it was `SECTOR_DEEP_DIVE_FAILED_ERROR`, which every failure
    // shared, and is now the one string only a timeout can produce.
    assert.equal(result.error, SECTOR_DEEP_DIVE_TIMEOUT_ERROR);
    assert.notEqual(result.error, SECTOR_DEEP_DIVE_FAILED_ERROR);
  });

  it("[regression] the sanitising warn runs, and the raw message stays out of the response", async () => {
    const mod = loadActionWith(timeout);

    const result = await mod.getSectorDeepDiveAction({ sector: "Energy" });

    const line = logged.warn.find((l) => l.includes("getSectorDeepDiveAction"));
    assert.ok(line, "the failed branch must leave a record");
    assert.match(line!, /sector=Energy/);
    assert.match(line!, /exceeded 25000ms/);
    assert.equal(result.error?.includes("single-flight"), false);
  });

  it("logs an ARBITRARY throw distinctly so a real bug cannot hide as a timeout", async () => {
    const mod = loadActionWith(() =>
      Promise.reject(new TypeError("boom in the cache helper"))
    );

    const result = await mod.getSectorDeepDiveAction({ sector: "Energy" });

    assert.equal(result.success, false);
    const distinct = logged.error.find((l) =>
      l.includes("unexpected error escaped")
    );
    assert.ok(distinct, "a non-timeout escape must be logged at error level");
    assert.match(distinct!, /boom in the cache helper/);
  });

  it("leaves the FRESH and STALE branches untouched", async () => {
    const fresh = loadActionWith(async () => ({
      status: "fresh" as const,
      data: { sector: "Energy" },
    }));
    const freshResult = await fresh.getSectorDeepDiveAction({
      sector: "Energy",
    });
    assert.equal(freshResult.success, true);
    assert.equal(freshResult.data?.stale, undefined);

    const computedAt = Date.parse("2026-08-08T03:00:00.000Z");
    const stale = loadActionWith(async () => ({
      status: "stale" as const,
      data: { sector: "Energy" },
      computedAt,
      error: new Error("db blip"),
    }));
    const staleResult = await stale.getSectorDeepDiveAction({
      sector: "Energy",
    });
    assert.equal(staleResult.success, true);
    assert.equal(staleResult.data?.stale, true);
    assert.equal(staleResult.data?.staleSince, computedAt);
    assert.equal(logged.error.length, 0);
  });
});
