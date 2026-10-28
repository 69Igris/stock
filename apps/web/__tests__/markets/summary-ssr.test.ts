/**
 * MONEY-1131 — /discover/markets renders movers WITHOUT the stock universe.
 *
 * Drives the REAL server component (`app/discover/markets/page.tsx`) through the
 * `require.cache` seam; the props it hands `MarketsClient` are read off the
 * returned element (JSX describes the child, it never invokes it).
 *
 * The defect: this page reads exactly two fields off the Discover payload —
 * `topGainers` and `topLosers` — and never renders a row from `allStocks`, yet
 * it called `getDiscoverDataAction()`, whose universe entry is a ~7,400-row
 * blob. On a cold lambda that is a multi-MB Redis GET plus a multi-MB
 * `JSON.parse` per render, discarded immediately.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/app/discover/markets/page.tsx
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const PAGE_REL = "../../app/discover/markets/page";
const CLIENT_REL = "../../app/discover/markets/client";
const INDICES_REL = "../../lib/actions/discover-indices";
const HEATMAP_REL = "../../lib/actions/discover-heatmap";
const SECTOR_HEATMAP_REL = "../../lib/actions/sector-heatmap";

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const calls: string[] = [];

const GAINER = { symbol: "ONGC", changePercent: 3 };
const LOSER = { symbol: "TCS", changePercent: -2 };

function stubBoundaries(): void {
  const cache = moduleCache();
  const paths = {
    indices: require.resolve(INDICES_REL),
    heatmap: require.resolve(HEATMAP_REL),
    sectorHeatmap: require.resolve(SECTOR_HEATMAP_REL),
    services: require.resolve("@usemoney/services"),
    client: require.resolve(CLIENT_REL),
  };
  for (const p of Object.values(paths)) snapshotOnce(p);

  const record =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };

  cache[paths.indices] = {
    exports: {
      __esModule: true,
      getIndicesAction: record("indices", { success: true, data: [] }),
    },
  };
  cache[paths.heatmap] = {
    exports: {
      __esModule: true,
      getHeatmapDataAction: record("heatmap", { success: true, data: null }),
    },
  };
  cache[paths.sectorHeatmap] = {
    exports: {
      __esModule: true,
      getSectorHeatmapAction: record("sectorHeatmap", {
        success: true,
        data: { buckets: [], stale: false },
      }),
    },
  };
  cache[paths.services] = {
    exports: {
      __esModule: true,
      getDiscoverSummary: record("discoverSummary", {
        success: true,
        data: {
          topGainers: [GAINER],
          topLosers: [LOSER],
          sectors: [],
          stockCount: 7395,
        },
      }),
      // Recorded rather than absent, so a re-introduction fails as an explicit
      // "discoverData was called" instead of an opaque TypeError.
      getDiscoverData: record("discoverData", { success: true, data: {} }),
    },
  };
  cache[paths.client] = {
    exports: { __esModule: true, default: () => null },
  };
}

interface PageMod {
  default: () => Promise<unknown>;
}

async function renderPage(): Promise<Record<string, unknown>> {
  const cache = moduleCache();
  stubBoundaries();
  delete cache[require.resolve(PAGE_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(PAGE_REL) as PageMod;
  const element = (await mod.default()) as {
    props?: Record<string, unknown>;
  } | null;
  assert.ok(element?.props, "page must render MarketsClient with props");
  return element.props!;
}

beforeEach(() => {
  calls.length = 0;
});

after(() => {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(PAGE_REL)];
});

describe("/discover/markets SSR (MONEY-1131)", () => {
  it("takes the row-free summary and never the full universe", async () => {
    await renderPage();

    assert.ok(calls.includes("discoverSummary"));
    assert.equal(
      calls.includes("discoverData"),
      false,
      "the ~7,400-row universe must not be parsed to read topGainers/topLosers"
    );
  });

  it("still hands the client the same movers it always did", async () => {
    const props = await renderPage();

    assert.deepEqual(props.initialGainers, [GAINER]);
    assert.deepEqual(props.initialLosers, [LOSER]);
  });

  it("the other three SSR fetches are untouched by this change", async () => {
    await renderPage();

    for (const name of ["indices", "sectorHeatmap", "heatmap"]) {
      assert.ok(calls.includes(name), `${name} must still be fetched`);
    }
  });
});
