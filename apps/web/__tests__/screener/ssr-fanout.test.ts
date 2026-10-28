/**
 * MONEY-1131 — the screener SSR page fans out per ACTIVE TAB, not unconditionally.
 *
 * Drives the REAL server component (`app/discover/screener/page.tsx`) through
 * the `require.cache` seam — every boundary it imports is replaced with a
 * recorder, including `./client`, so the props it hands down are observable
 * too. Nothing here re-declares the page's logic; the assertions are about what
 * the real module DID.
 *
 * The defect: the page `Promise.all`-ed SIX heavy calls on every load — all
 * three screens (stocks + ~14k MFs + ETFs), the full ~7,400-row Discover
 * universe, the MF filter-option payload and a 200-row ETF list — whichever tab
 * the URL asked for. Two of the three screens were rendered by nobody; the
 * client's per-mode effect re-runs the screen on tab switch anyway.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/app/discover/screener/page.tsx
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const PAGE_REL = "../../app/discover/screener/page";
const CLIENT_REL = "../../app/discover/screener/client";
const SCREENER_ACTIONS_REL = "../../lib/actions/screener";
const MF_DISCOVER_REL = "../../lib/actions/discover-mf";

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

/** Every boundary call the page can make, in the order the page lists them. */
interface Recorder {
  calls: string[];
  clientProps: Record<string, unknown> | null;
  /** Flip to make the ACTIVE tab's screen fail, as a timeout/DB error would. */
  screenFails: boolean;
}
const rec: Recorder = { calls: [], clientProps: null, screenFails: false };

function pagedOk(total: number) {
  return {
    success: true as const,
    data: { rows: [{ symbol: "SEED" }], total, page: 0, pageSize: 25 },
  };
}

function stubBoundaries(): void {
  const cache = moduleCache();
  const actionsPath = require.resolve(SCREENER_ACTIONS_REL);
  const mfPath = require.resolve(MF_DISCOVER_REL);
  const corePath = require.resolve("@usemoney/core");
  const servicesPath = require.resolve("@usemoney/services");
  const clientPath = require.resolve(CLIENT_REL);
  for (const p of [actionsPath, mfPath, corePath, servicesPath, clientPath]) {
    snapshotOnce(p);
  }

  const record =
    <T>(name: string, value: T) =>
    async () => {
      rec.calls.push(name);
      return value;
    };

  cache[actionsPath] = {
    exports: {
      __esModule: true,
      screenStocksAction: async () => {
        rec.calls.push("screenStocks");
        return rec.screenFails
          ? { success: false, error: "boom" }
          : pagedOk(111);
      },
      screenMfsAction: async () => {
        rec.calls.push("screenMfs");
        return rec.screenFails
          ? { success: false, error: "boom" }
          : pagedOk(222);
      },
      screenEtfsAction: async () => {
        rec.calls.push("screenEtfs");
        return rec.screenFails
          ? { success: false, error: "boom" }
          : pagedOk(333);
      },
      getScreenerUniverseCountsAction: record("universeCounts", {
        mf: 1700,
        etf: 312,
      }),
    },
  };
  cache[mfPath] = {
    exports: {
      __esModule: true,
      getMfDiscoverDataAction: record("mfDiscover", {
        success: true,
        data: { categories: [{ name: "Flexi Cap", count: 5 }], amcList: ["A"] },
      }),
    },
  };
  cache[corePath] = {
    exports: {
      __esModule: true,
      getAllSectorNames: () => ["Energy", "Information Technology"],
    },
  };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getDiscoverSummary: record("discoverSummary", {
        success: true,
        data: {
          topGainers: [],
          topLosers: [],
          sectors: [{ name: "Energy", count: 42 }],
          stockCount: 7395,
        },
      }),
      // Present so an accidental re-introduction of the full-universe call is
      // RECORDED rather than crashing — the assertions below then fail loudly
      // with "discoverData" in `calls` instead of an opaque TypeError.
      getDiscoverData: record("discoverData", { success: true, data: {} }),
    },
  };
  cache[clientPath] = {
    exports: {
      __esModule: true,
      default: (props: Record<string, unknown>) => {
        rec.clientProps = props;
        return null;
      },
    },
  };
}

interface PageMod {
  default: (args: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<unknown>;
}

/**
 * Render the server component and hand back the props it passed down.
 *
 * JSX only DESCRIBES the child (it never invokes it), so the props are read off
 * the returned element rather than from inside the stubbed component.
 */
async function renderPage(
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const cache = moduleCache();
  stubBoundaries();
  delete cache[require.resolve(PAGE_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(PAGE_REL) as PageMod;
  const element = (await mod.default({
    searchParams: Promise.resolve(params),
  })) as { type?: unknown; props?: Record<string, unknown> } | null;
  assert.ok(element?.props, "page must render ScreenerClient with props");
  const clientMod = moduleCache()[require.resolve(CLIENT_REL)]!.exports as {
    default: unknown;
  };
  assert.equal(
    element.type,
    clientMod.default,
    "the rendered child must be ScreenerClient itself"
  );
  rec.clientProps = element.props!;
  return element.props!;
}

beforeEach(() => {
  rec.calls = [];
  rec.clientProps = null;
  rec.screenFails = false;
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

describe("screener SSR — only the active tab is screened (MONEY-1131)", () => {
  it("stocks tab: screens stocks only; no MF/ETF screen, no MF options, no full universe", async () => {
    await renderPage({ mode: "stocks" });

    assert.ok(
      rec.calls.includes("screenStocks"),
      "active tab must be screened"
    );
    assert.equal(
      rec.calls.includes("screenMfs"),
      false,
      "MF screen must not run for the stocks tab"
    );
    assert.equal(
      rec.calls.includes("screenEtfs"),
      false,
      "ETF screen must not run for the stocks tab"
    );
    assert.equal(
      rec.calls.includes("mfDiscover"),
      false,
      "MF filter options are MF-tab-only"
    );
    assert.equal(
      rec.calls.includes("discoverData"),
      false,
      "the full ~7,400-row universe must never be pulled for sector counts"
    );
    assert.ok(rec.calls.includes("discoverSummary"), "summary replaces it");
  });

  it("mf tab: screens MFs and pulls its option lists; stocks/ETF screens stay off", async () => {
    await renderPage({ mode: "mf" });

    assert.ok(rec.calls.includes("screenMfs"));
    assert.ok(
      rec.calls.includes("mfDiscover"),
      "Category/AMC dropdowns need their options on the tab that renders them"
    );
    assert.equal(rec.calls.includes("screenStocks"), false);
    assert.equal(rec.calls.includes("screenEtfs"), false);
  });

  it("etf tab: screens ETFs only", async () => {
    await renderPage({ mode: "etf" });

    assert.ok(rec.calls.includes("screenEtfs"));
    assert.equal(rec.calls.includes("screenStocks"), false);
    assert.equal(rec.calls.includes("screenMfs"), false);
    assert.equal(rec.calls.includes("mfDiscover"), false);
  });

  it("exactly ONE screen runs per load, whichever tab is asked for", async () => {
    for (const mode of ["stocks", "mf", "etf"]) {
      rec.calls = [];
      await renderPage({ mode });
      const screens = rec.calls.filter((c) => c.startsWith("screen"));
      assert.deepEqual(
        screens.length,
        1,
        `${mode}: expected 1 screen, got ${screens.join(",")}`
      );
    }
  });

  it("a bad ?mode falls back to stocks and still screens only once", async () => {
    await renderPage({ mode: "nonsense" });
    assert.deepEqual(
      rec.calls.filter((c) => c.startsWith("screen")),
      ["screenStocks"]
    );
  });
});

describe("screener SSR — props handed to the client (MONEY-1131)", () => {
  it("seeds ONLY the active tab's page; the others arrive as empty envelopes", async () => {
    const props = await renderPage({ mode: "etf" });

    const etfPage = props.initialEtfPage as { total: number };
    const stocksPage = props.initialStocksPage as { total: number; rows: [] };
    const mfPage = props.initialMfPage as { total: number; rows: [] };
    assert.equal(etfPage.total, 333, "active tab carries real results");
    assert.deepEqual(
      [stocksPage.total, stocksPage.rows.length],
      [0, 0],
      "un-screened tabs are empty, not stale"
    );
    assert.deepEqual([mfPage.total, mfPage.rows.length], [0, 0]);
  });

  it("initialPageSeeded is true only when the active screen SUCCEEDED", async () => {
    const ok = await renderPage({ mode: "stocks" });
    assert.equal(ok.initialPageSeeded, true);

    rec.screenFails = true;
    const failed = await renderPage({ mode: "stocks" });
    assert.equal(
      failed.initialPageSeeded,
      false,
      "a failed SSR screen must NOT let the client skip its retry"
    );
  });

  it("badge counts come from the cheap sources, not from screening idle tabs", async () => {
    const props = await renderPage({ mode: "stocks" });
    assert.deepEqual(props.counts, { stocks: 7395, mf: 1700, etf: 312 });
  });

  it("sector options come from the summary, with the canonical taxonomy as fallback", async () => {
    const props = await renderPage({ mode: "stocks" });
    assert.deepEqual(props.sectorOptions, [{ name: "Energy", count: 42 }]);
  });
});
