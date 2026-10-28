/**
 * MONEY-1157 — the all-zero-sector-counts diagnosability trap.
 *
 * `getUniverseData()` returns a NON-EMPTY, all-zero facet array on BOTH its
 * success path and its catch path. Two guards then disagreed about what that
 * meant:
 *
 *   - `app/discover/screener/page.tsx` accepted it because `sectors.length > 0`
 *     (14 > 0), treating a caught DB error as an authoritative "every sector
 *     has 0 stocks";
 *   - `components/screener/SectorChips.tsx` then dropped every one of those 14
 *     for `count > 0`.
 *
 * Net effect: no sector chips at all, and an outage that looked exactly like a
 * genuinely thin market. Both halves are fixed — the page guard counts instead
 * of measuring length and reports the service's `degraded` sentinel, and the
 * chip strip renders label-only chips when the counts are unavailable rather
 * than rendering nothing.
 *
 * The page half drives the REAL server component through the `require.cache`
 * seam (same technique as __tests__/markets/summary-ssr.test.ts): the props it
 * hands `ScreenerClient` are read off the returned element. Pure + mocked — no
 * DB, no network, no timers left armed.
 *
 * Source: apps/web/app/discover/screener/page.tsx,
 *         apps/web/components/screener/SectorChips.tsx
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { visibleSectorChips } from "@/components/screener/SectorChips";
import { getAllSectorNames } from "@usemoney/core/sector-taxonomy";

// ── The chip-visibility half ────────────────────────────────────────────

describe("MONEY-1157 — visibleSectorChips", () => {
  it("[regression] renders the whole list when NO option has a count", () => {
    // All-zero means the counts are UNAVAILABLE (degraded summary, cold cache,
    // canonical fallback), not that every sector is empty. Filtering on
    // `count > 0` erased the entire strip on exactly those loads.
    const options = getAllSectorNames().map((name) => ({ name, count: 0 }));

    const chips = visibleSectorChips(options, 12);

    assert.equal(chips.length, 12, "capped, but never empty");
    assert.deepEqual(
      chips.map((c) => c.name),
      getAllSectorNames().slice(0, 12),
      "with nothing to rank by, the taxonomy's own order is preserved"
    );
  });

  it("still hides empty sectors when real counts exist", () => {
    const chips = visibleSectorChips(
      [
        { name: "Energy", count: 4 },
        { name: "Utilities", count: 0 },
        { name: "Healthcare", count: 9 },
      ],
      12
    );

    assert.deepEqual(
      chips.map((c) => c.name),
      ["Healthcare", "Energy"],
      "biggest first, zero-count sector dropped"
    );
  });

  it("respects maxChips in both modes", () => {
    const populated = visibleSectorChips(
      [
        { name: "A", count: 3 },
        { name: "B", count: 2 },
        { name: "C", count: 1 },
      ],
      2
    );
    const unpopulated = visibleSectorChips(
      [
        { name: "A", count: 0 },
        { name: "B", count: 0 },
        { name: "C", count: 0 },
      ],
      2
    );

    assert.equal(populated.length, 2);
    assert.equal(unpopulated.length, 2);
  });

  it("never mutates the caller's array", () => {
    const options = [
      { name: "Energy", count: 1 },
      { name: "Healthcare", count: 9 },
    ];
    const snapshot = options.map((o) => ({ ...o }));

    visibleSectorChips(options, 12);

    assert.deepEqual(options, snapshot);
  });

  it("handles an empty option list without throwing", () => {
    assert.deepEqual(visibleSectorChips([], 12), []);
  });
});

// ── The page-guard half ─────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const PAGE_REL = "../../app/discover/screener/page";
const CLIENT_REL = "../../app/discover/screener/client";
const SCREENER_REL = "../../lib/actions/screener";
const DISCOVER_MF_REL = "../../lib/actions/discover-mf";

const priorEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorEntries.has(path)) priorEntries.set(path, moduleCache()[path]);
}

interface SummaryPayload {
  sectors: Array<{ name: string; count: number }>;
  stockCount: number;
  topGainers: unknown[];
  topLosers: unknown[];
  degraded?: true;
}

const EMPTY_PAGE = { rows: [], total: 0, page: 0, pageSize: 25 };

function stubBoundaries(summary: {
  success: boolean;
  data?: SummaryPayload;
}): void {
  const cache = moduleCache();
  const paths = {
    screener: require.resolve(SCREENER_REL),
    services: require.resolve("@usemoney/services"),
    discoverMf: require.resolve(DISCOVER_MF_REL),
    client: require.resolve(CLIENT_REL),
  };
  for (const p of Object.values(paths)) snapshotOnce(p);

  cache[paths.screener] = {
    exports: {
      __esModule: true,
      screenStocksAction: async () => ({ success: true, data: EMPTY_PAGE }),
      screenMfsAction: async () => ({ success: true, data: EMPTY_PAGE }),
      screenEtfsAction: async () => ({ success: true, data: EMPTY_PAGE }),
      getScreenerUniverseCountsAction: async () => ({ mf: 0, etf: 0 }),
    },
  };
  cache[paths.services] = {
    exports: { __esModule: true, getDiscoverSummary: async () => summary },
  };
  cache[paths.discoverMf] = {
    exports: {
      __esModule: true,
      getMfDiscoverDataAction: async () => ({
        success: true,
        data: { categories: [], amcList: [] },
      }),
    },
  };
  cache[paths.client] = { exports: { __esModule: true, default: () => null } };
}

interface PageMod {
  default: (args: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<unknown>;
}

async function renderPage(summary: {
  success: boolean;
  data?: SummaryPayload;
}): Promise<Record<string, unknown>> {
  const cache = moduleCache();
  stubBoundaries(summary);
  delete cache[require.resolve(PAGE_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(PAGE_REL) as PageMod;
  const element = (await mod.default({
    searchParams: Promise.resolve({}),
  })) as { props?: Record<string, unknown> } | null;
  assert.ok(element?.props, "page must render ScreenerClient with props");
  return element.props!;
}

/** The exact shape `getUniverseData` emits — 13 canonical + the bucket. */
function allZeroFacets(): Array<{ name: string; count: number }> {
  return [
    ...getAllSectorNames().map((name) => ({ name, count: 0 })),
    { name: "Not Categorised", count: 0 },
  ];
}

const warns: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  warns.length = 0;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
});

after(() => {
  console.warn = realWarn;
  const cache = moduleCache();
  for (const [path, prior] of priorEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorEntries.clear();
  delete cache[require.resolve(PAGE_REL)];
});

describe("MONEY-1157 — /discover/screener sector-option guard", () => {
  it("[regression] an all-zero payload is NOT treated as authoritative", async () => {
    // `length > 0` accepted this (14 entries). The canonical fallback has 13 —
    // no "Not Categorised" — which is how the two are told apart.
    const props = await renderPage({
      success: true,
      data: {
        sectors: allZeroFacets(),
        stockCount: 0,
        topGainers: [],
        topLosers: [],
      },
    });

    const options = props.sectorOptions as Array<{
      name: string;
      count: number;
    }>;
    assert.equal(options.length, getAllSectorNames().length);
    assert.equal(
      options.some((o) => o.name === "Not Categorised"),
      false,
      "an all-zero discover payload must fall through to the canonical list"
    );
  });

  it("passes REAL counts straight through", async () => {
    const sectors = [
      ...getAllSectorNames().map((name) => ({ name, count: 0 })),
      { name: "Not Categorised", count: 12 },
    ];
    sectors[0] = { name: getAllSectorNames()[0]!, count: 314 };

    const props = await renderPage({
      success: true,
      data: { sectors, stockCount: 326, topGainers: [], topLosers: [] },
    });

    assert.deepEqual(props.sectorOptions, sectors);
  });

  it("[regression] a DEGRADED summary is logged distinctly from thin data", async () => {
    await renderPage({
      success: true,
      data: {
        sectors: allZeroFacets(),
        stockCount: 0,
        topGainers: [],
        topLosers: [],
        degraded: true,
      },
    });

    const line = warns.find((l) => l.includes("/discover/screener"));
    assert.ok(line, "a caught universe failure must leave a record");
    assert.match(line!, /DEGRADED/);
  });

  it("stays silent when the counts are merely thin, not degraded", async () => {
    await renderPage({
      success: true,
      data: {
        sectors: allZeroFacets(),
        stockCount: 0,
        topGainers: [],
        topLosers: [],
      },
    });

    assert.equal(
      warns.some((l) => l.includes("DEGRADED")),
      false,
      "a cold/empty environment is not an outage"
    );
  });

  it("falls back to the canonical taxonomy when the summary itself failed", async () => {
    const props = await renderPage({ success: false });

    const options = props.sectorOptions as Array<{
      name: string;
      count: number;
    }>;
    assert.equal(options.length, getAllSectorNames().length);
    assert.equal(
      options.every((o) => o.count === 0),
      true
    );
  });
});
