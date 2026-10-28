/**
 * Ask Screener chat — bridge builders (MONEY-1078).
 *
 * `buildScreenerActions` / `buildScreenerSnapshot` are the seam between the
 * screener page's React state and the chat. This suite drives them with a
 * plain `ScreenerLive` object (no React) and asserts:
 *   - actions write to the addressed mode's filter bag, merging not replacing;
 *   - clearFilters wipes even keys outside the chat vocabulary;
 *   - the snapshot reflects the ACTIVE mode only, and is bounded (rows +
 *     option lists capped) so the prompt can't grow with the result set;
 *   - non-vocabulary filter keys (limit, amcAny) are hidden from the model.
 *
 * Source: apps/web/app/discover/screener/lib/chat/bridge.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildScreenerActions,
  buildScreenerSnapshot,
  SNAPSHOT_ROW_CAP,
  SNAPSHOT_OPTION_CAP,
  type ScreenerLive,
} from "@/app/discover/screener/lib/chat/bridge";
import type {
  ScreenResult,
  MfScreenResult,
  EtfScreenResult,
} from "@/lib/actions/screener";

function stockRow(symbol: string): ScreenResult {
  return {
    symbol,
    exchange: "NSE",
    name: `${symbol} Ltd`,
    sector: "IT",
    ltp: 100,
    changePercent: 1,
    marketCap: 50_000,
    pe: 20,
    roe: 25,
    revenueGrowth: 10,
    debtToEquity: 0.1,
    matchScore: 90,
  };
}

function mfRow(code: string): MfScreenResult {
  return {
    schemeCode: code,
    schemeName: `Scheme ${code}`,
    amcName: "SBI",
    category: "Large Cap",
    plan: "DIRECT",
    fundType: "equity",
    riskLevel: "High",
    nav: 42,
    navDate: new Date("2026-07-01T00:00:00Z"),
    aum: 1000,
    returns1Y: 12,
    returns3Y: 15,
    returns5Y: 14,
    expenseRatio: 0.5,
    matchScore: 88,
  };
}

function etfRow(symbol: string): EtfScreenResult {
  return {
    symbol,
    exchange: "NSE",
    name: `${symbol} ETF`,
    yahooSymbol: `${symbol}.NS`,
    ltp: 55,
    changePercent: 0.5,
    aum: 900,
    returns1Y: 11,
    expenseRatio: 0.2,
    assetClass: "equity",
    matchScore: 80,
  };
}

interface Written {
  mode?: string;
  query?: string;
  stocks?: Record<string, unknown>;
  mf?: Record<string, unknown>;
  etf?: Record<string, unknown>;
  sorts: Record<string, string>;
}

function makeLive(overrides: Partial<ScreenerLive> = {}): {
  live: ScreenerLive;
  written: Written;
} {
  const written: Written = { sorts: {} };
  const live: ScreenerLive = {
    mode: "stocks",
    query: "",
    stocksFilters: {},
    mfFilters: {},
    etfFilters: {},
    stocksSort: "match",
    mfSort: "match",
    etfSort: "match",
    stocksRows: [],
    mfRows: [],
    etfRows: [],
    stocksTotal: 0,
    mfTotal: 0,
    etfTotal: 0,
    sectorOptions: [],
    mfCategories: [],
    mfAmcs: [],
    setMode: (m) => {
      written.mode = m;
    },
    setQuery: (q) => {
      written.query = q;
    },
    // The bridge writes with functional updaters (see writeFilters), so the
    // mock resolves them against the live bag the way React would.
    setStocksFilters: (f) => {
      written.stocks = (
        typeof f === "function" ? f(live.stocksFilters) : f
      ) as Record<string, unknown>;
    },
    setMfFilters: (f) => {
      written.mf = (typeof f === "function" ? f(live.mfFilters) : f) as Record<
        string,
        unknown
      >;
    },
    setEtfFilters: (f) => {
      written.etf = (
        typeof f === "function" ? f(live.etfFilters) : f
      ) as Record<string, unknown>;
    },
    setStocksSort: (s) => {
      written.sorts.stocks = s;
    },
    setMfSort: (s) => {
      written.sorts.mf = s;
    },
    setEtfSort: (s) => {
      written.sorts.etf = s;
    },
    isFetching: false,
    fetchError: null,
    fetchGeneration: 0,
    ...overrides,
  };
  return { live, written };
}

describe("buildScreenerActions", () => {
  it("merges into the addressed mode, preserving existing filters", () => {
    const { live, written } = makeLive({
      stocksFilters: { minRoe: 15, sector: "IT" },
    });
    buildScreenerActions(() => live).mergeFilters("stocks", { maxPe: 25 });
    assert.deepEqual(written.stocks, { minRoe: 15, sector: "IT", maxPe: 25 });
  });

  it("writes MF filters when addressed to MF even while stocks is active", () => {
    const { live, written } = makeLive({ mode: "stocks", mfFilters: {} });
    buildScreenerActions(() => live).mergeFilters("mf", { minAum: 5000 });
    assert.deepEqual(written.mf, { minAum: 5000 });
    assert.equal(written.stocks, undefined, "stocks bag must be untouched");
  });

  it("unsetFilters deletes only the named keys", () => {
    const { live, written } = makeLive({
      stocksFilters: { minRoe: 15, maxPe: 25, sector: "IT" },
    });
    buildScreenerActions(() => live).unsetFilters("stocks", ["maxPe"]);
    assert.deepEqual(written.stocks, { minRoe: 15, sector: "IT" });
  });

  it("clearFilters empties the bag INCLUDING non-vocabulary keys", () => {
    const { live, written } = makeLive({
      // `limit` has no chat tool, but "clear all" must still drop it.
      // `limit` IS a real ScreenFilters key — it just has no chat tool.
      stocksFilters: { minRoe: 15, limit: 500 },
    });
    buildScreenerActions(() => live).clearFilters("stocks");
    assert.deepEqual(written.stocks, {});
  });

  it("routes sort to the addressed mode's setter", () => {
    const { live, written } = makeLive();
    const actions = buildScreenerActions(() => live);
    actions.setSort("mf", "aum-desc");
    actions.setSort("stocks", "mcap-desc");
    assert.deepEqual(written.sorts, { mf: "aum-desc", stocks: "mcap-desc" });
  });

  it("reads live state through the getter (no stale closure)", () => {
    let current = makeLive({ stocksFilters: { minRoe: 10 } });
    const actions = buildScreenerActions(() => current.live);
    // Simulate a re-render replacing the live object entirely.
    current = makeLive({ stocksFilters: { minRoe: 99 } });
    actions.mergeFilters("stocks", { maxPe: 20 });
    assert.deepEqual(current.written.stocks, { minRoe: 99, maxPe: 20 });
  });

  it("switchMode delegates to setMode", () => {
    const { live, written } = makeLive();
    buildScreenerActions(() => live).switchMode("etf");
    assert.equal(written.mode, "etf");
  });
});

describe("buildScreenerActions — batched writes (no clobbering)", () => {
  /**
   * Models React's real semantics: `liveRef` is FROZEN between renders while
   * the setter applies each update to the latest QUEUED state. The tool loop
   * runs a hop's calls synchronously, so React never re-renders between them.
   *
   * Regression (MONEY-1078 review): the bridge originally computed `prev`
   * from the frozen ref and passed a VALUE, so every write in a batch started
   * from the same pre-batch bag and the last one clobbered the rest.
   */
  function makeBatched(initial: Record<string, unknown> = {}) {
    let committed = { ...initial }; // what a re-render would expose
    let queued = { ...initial }; // React's pending state
    const live: ScreenerLive = makeLive({ stocksFilters: initial }).live;
    live.stocksFilters = committed as never;
    live.setStocksFilters = ((updater) => {
      queued =
        typeof updater === "function"
          ? (updater as (p: unknown) => Record<string, unknown>)(queued)
          : (updater as Record<string, unknown>);
    }) as typeof live.setStocksFilters;
    return {
      live,
      /** State after React flushes — what the user actually sees. */
      flush: () => {
        committed = { ...queued };
        return committed;
      },
    };
  }

  it("keeps BOTH writes when one call merges and unsets (null-valued key)", () => {
    // setStockFilters({maxPe: 25, sector: null}) → mergeFilters + unsetFilters
    const b = makeBatched({ sector: "IT", minRoe: 15 });
    const actions = buildScreenerActions(() => b.live);
    actions.mergeFilters("stocks", { maxPe: 25 });
    actions.unsetFilters("stocks", ["sector"]);
    assert.deepEqual(
      b.flush(),
      { minRoe: 15, maxPe: 25 },
      "maxPe must survive the unset that follows it"
    );
  });

  it("clearFilters followed by a merge does NOT resurrect the old filters", () => {
    // The prompt tells the model to clear-then-set in ONE batched response.
    const b = makeBatched({ sector: "IT", minRoe: 15 });
    const actions = buildScreenerActions(() => b.live);
    actions.clearFilters("stocks");
    actions.mergeFilters("stocks", { minPe: 10 });
    assert.deepEqual(
      b.flush(),
      { minPe: 10 },
      "the cleared filters must stay cleared"
    );
  });

  it("applies three merges in one batch cumulatively", () => {
    const b = makeBatched({});
    const actions = buildScreenerActions(() => b.live);
    actions.mergeFilters("stocks", { minRoe: 20 });
    actions.mergeFilters("stocks", { maxPe: 25 });
    actions.mergeFilters("stocks", { sector: "IT" });
    assert.deepEqual(b.flush(), { minRoe: 20, maxPe: 25, sector: "IT" });
  });

  it("later writes win on the same key", () => {
    const b = makeBatched({});
    const actions = buildScreenerActions(() => b.live);
    actions.mergeFilters("stocks", { minRoe: 10 });
    actions.mergeFilters("stocks", { minRoe: 20 });
    assert.deepEqual(b.flush(), { minRoe: 20 });
  });
});

describe("buildScreenerSnapshot", () => {
  it("reports the active mode's filters, sort and total", () => {
    const { live } = makeLive({
      mode: "mf",
      mfFilters: { minAum: 1000 },
      mfSort: "aum-desc",
      mfTotal: 42,
      stocksTotal: 999,
      stocksFilters: { minRoe: 15 },
    });
    const snap = buildScreenerSnapshot(live);
    assert.equal(snap.mode, "mf");
    assert.deepEqual(snap.filters, { minAum: 1000 });
    assert.equal(snap.sort, "aum-desc");
    assert.equal(snap.resultTotal, 42);
  });

  it("hides filter keys the chat has no tool for", () => {
    const { live } = makeLive({
      mode: "stocks",
      // `limit` IS a real ScreenFilters key — it just has no chat tool.
      stocksFilters: { minRoe: 15, limit: 500 },
    });
    const snap = buildScreenerSnapshot(live);
    assert.deepEqual(snap.filters, { minRoe: 15 });
  });

  it("omits unset filters so the model sees only what is active", () => {
    const { live } = makeLive({
      mode: "stocks",
      stocksFilters: { minRoe: 15, maxPe: undefined, sector: "" },
    });
    const snap = buildScreenerSnapshot(live);
    assert.deepEqual(snap.filters, { minRoe: 15 });
  });

  it("caps result rows so the prompt cannot grow with the result set", () => {
    const rows = Array.from({ length: 50 }, (_, i) => stockRow(`SYM${i}`));
    const { live } = makeLive({ mode: "stocks", stocksRows: rows });
    const snap = buildScreenerSnapshot(live);
    assert.equal(snap.topResults.length, SNAPSHOT_ROW_CAP);
  });

  it("caps the vocabulary lists", () => {
    const sectors = Array.from({ length: 100 }, (_, i) => ({
      name: `S${i}`,
      count: 1,
    }));
    const { live } = makeLive({ mode: "stocks", sectorOptions: sectors });
    const snap = buildScreenerSnapshot(live);
    assert.equal(snap.available.sectors!.length, SNAPSHOT_OPTION_CAP);
  });

  it("ships only the active mode's vocabulary", () => {
    const base = {
      sectorOptions: [{ name: "IT", count: 3 }],
      mfCategories: [{ name: "Large Cap", count: 5 }],
      mfAmcs: ["SBI"],
    };
    const stocks = buildScreenerSnapshot(
      makeLive({ mode: "stocks", ...base }).live
    );
    assert.deepEqual(stocks.available.sectors, ["IT"]);
    assert.equal(stocks.available.mfCategories, undefined);

    const mf = buildScreenerSnapshot(makeLive({ mode: "mf", ...base }).live);
    assert.deepEqual(mf.available.mfCategories, ["Large Cap"]);
    assert.equal(mf.available.sectors, undefined);
  });

  it("compacts rows per mode (MF and ETF shapes differ)", () => {
    const mf = buildScreenerSnapshot(
      makeLive({ mode: "mf", mfRows: [mfRow("100")] }).live
    );
    assert.deepEqual(Object.keys(mf.topResults[0]!).sort(), [
      "amcName",
      "aum",
      "category",
      "expenseRatio",
      "nav",
      "returns3Y",
      "schemeName",
    ]);

    const etf = buildScreenerSnapshot(
      makeLive({ mode: "etf", etfRows: [etfRow("GOLDBEES")] }).live
    );
    assert.deepEqual(Object.keys(etf.topResults[0]!).sort(), [
      "assetClass",
      "aum",
      "expenseRatio",
      "ltp",
      "name",
      "returns1Y",
      "symbol",
    ]);
  });

  it("marks results stale when the last refetch failed", () => {
    // Behavioural, not a prompt-string match: a failed refetch leaves
    // `filters` FRESH (they are written optimistically) beside a
    // `resultTotal`/`topResults` from BEFORE the change. Unless the snapshot
    // carries the staleness, the model quotes the pre-filter count as the
    // answer — while the user is looking at a "results may be out of date"
    // toast saying the opposite.
    const { live } = makeLive({
      mode: "stocks",
      stocksFilters: { minPe: 25 },
      stocksTotal: 2511, // the PRE-filter count
      fetchError: "Failed to run screener",
    });
    const snap = buildScreenerSnapshot(live);
    assert.deepEqual(snap.filters, { minPe: 25 }, "filters are the new state");
    assert.ok(snap.resultsStale, "must flag that the count does not match");
    assert.match(snap.resultsStale!.reason, /screener/i);
  });

  it("omits the stale marker entirely when the refetch succeeded", () => {
    const { live } = makeLive({ mode: "stocks", fetchError: null });
    const snap = buildScreenerSnapshot(live);
    assert.equal(
      snap.resultsStale,
      undefined,
      "a healthy screen must not carry a staleness flag"
    );
    // Absent, not present-and-false — the prompt keys off its presence.
    assert.ok(!("resultsStale" in snap));
  });

  it("stays JSON-serialisable (it is embedded in the prompt)", () => {
    const { live } = makeLive({
      mode: "mf",
      mfRows: [mfRow("100")],
      mfCategories: [{ name: "Large Cap", count: 5 }],
    });
    const snap = buildScreenerSnapshot(live);
    const round = JSON.parse(JSON.stringify(snap)) as typeof snap;
    assert.equal(round.mode, "mf");
    assert.equal(round.topResults.length, 1);
  });
});
