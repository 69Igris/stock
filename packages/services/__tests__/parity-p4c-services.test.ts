/**
 * MONEY-1062 P4c — screener/scans/strategies/saved-screens services (REAL
 * exports, injected fakes via each function's `deps` seam).
 *
 * `@usemoney/services` runs its suite as ESM (no require.cache module-mocking),
 * so every IO collaborator is injected through the service's own deps interface
 * (ScreenerServiceDeps / ScansServiceDeps / StrategiesServiceDeps /
 * SavedScreensServiceDeps) — the result-feedback-service.test.ts style.
 *
 * Pinned here:
 *   - scans: SCAN_CATALOG integrity (non-empty, namespaced+deduped ids,
 *     runnable ⇔ ≥1 mappable band), mapFiltersToScreenFilters band mapping
 *     (tightening, unmapped fields, the non-finite guard), runScan fail-closed
 *     codes + engine args, and the module-load TDZ regression pin (below).
 *   - screener: the ported pure helpers (match scores, where builders,
 *     ETF name-derivation, index resolution) + screenStocks/screenMfs/
 *     screenEtfs through injected prisma/cache/discover (cache-hit shortcut,
 *     path selection, paging clamps, sanitized failures).
 *   - strategies: presets stats-first sort, custom CRUD guards/CONFLICT
 *     mapping, and the G3 async run: gate → PENDING ScanResult → publish, with
 *     the published StrategyScanMessage shape asserted and NEVER published on
 *     a gate failure.
 *   - saved-screens: countFilters semantics, upsert key, ownership scoping,
 *     rename-collision CONFLICT, deleteMany count-0 not-found.
 *
 * Source: packages/services/src/{scans,screener,strategies,saved-screens}.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── TDZ regression pin (MONEY-1062) ─────────────────────────────────────────
// scans.service builds SCAN_CATALOG at module load; that initializer reaches
// the `const FIELD_TO_BAND` table via isScreenerRunnable → applyFilter. The
// table therefore MUST be declared above the `SCAN_CATALOG = buildCatalog()`
// initializer — when it once sat below, every import of the module (and so of
// the whole @usemoney/services barrel) died with a temporal-dead-zone
// ReferenceError at load. A bare dynamic import at module scope succeeding IS
// the pin: if the declaration order regresses, this `await import` rejects and
// the entire test file fails before a single test runs.
const scansService = await import("../src/scans.service");

const {
  SCAN_CATALOG,
  getScan,
  listScanCategories,
  scanCategoryLabel,
  mapFiltersToScreenFilters,
  isScreenerRunnable,
  runScan,
  getScanCatalog,
} = scansService;

import {
  filterScore,
  computeMatchScore,
  computeMfMatchScore,
  computeEtfMatchScore,
  resolveMarketCapRange,
  buildMfScreenWhere,
  buildEtfScreenWhere,
  extractEtfFundHouse,
  deriveEtfCategory,
  deriveEtfAssetClass,
  resolveIndexFilter,
  screenStocks,
  screenMfs,
  screenEtfs,
  MCAP_BUCKETS,
  type ScreenerServiceDeps,
  type ScreenerCache,
  type ScreenResult,
} from "../src/screener.service";

import {
  getStrategyPresets,
  getStrategyCategoriesInfo,
  listStrategies,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  cloneBuiltIn,
  runStrategyScan,
  getScanStatus,
  getScanResult,
  getScanHistory,
  type StrategiesServiceDeps,
  type StrategyStats,
  type StrategyCategory,
} from "../src/strategies.service";

import {
  countFilters,
  saveScreen,
  listSavedScreens,
  loadSavedScreen,
  renameSavedScreen,
  deleteSavedScreen,
  type SavedScreensServiceDeps,
} from "../src/saved-screens.service";

import {
  BUILTIN_STRATEGIES,
  getStrategyCategories,
  getStrategiesByCategory,
} from "@usemoney/research/strategies/builtin-strategies";
import type { ScreenerFilter } from "@usemoney/core/screener/engine";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ════════════════════════════════════════════════════════════════════════════
// scans.service — SCAN_CATALOG integrity
// ════════════════════════════════════════════════════════════════════════════

describe("scans.service — SCAN_CATALOG integrity", () => {
  it("is non-empty and contains at least one inline-runnable scan", () => {
    assert.ok(SCAN_CATALOG.length > 0, "catalog must not be empty");
    assert.ok(
      SCAN_CATALOG.some((s) => s.runnable),
      "at least one runnable scan (runScan happy path depends on it)",
    );
  });

  it("ids are unique and namespaced by source (core:/builtin:/chartink:)", () => {
    const ids = SCAN_CATALOG.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate scan id");
    for (const s of SCAN_CATALOG) {
      assert.match(s.id, /^(core|builtin|chartink):.+/, `bad id ${s.id}`);
      assert.equal(
        s.id.split(":")[0],
        s.source,
        `id namespace must match source for ${s.id}`,
      );
    }
  });

  it("names are deduped on the normalised-name key (merge-order dedupe held)", () => {
    const normalize = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const keys = SCAN_CATALOG.map((s) => normalize(s.name));
    assert.equal(new Set(keys).size, keys.length, "duplicate normalised name");
  });

  it("runnable flag is coherent: runnable ⇔ isScreenerRunnable(filters) for EVERY scan", () => {
    for (const s of SCAN_CATALOG) {
      assert.equal(
        s.runnable,
        isScreenerRunnable(s.filters),
        `runnable flag drift on ${s.id}`,
      );
      if (s.runnable) {
        assert.ok(
          s.filters && s.filters.length > 0,
          `${s.id} runnable but empty`,
        );
        assert.ok(
          mapFiltersToScreenFilters(s.filters!).mappedCount > 0,
          `${s.id} runnable but maps to zero bands`,
        );
      }
    }
  });

  it("only CORE scans are ever runnable (builtin/chartink are browse-only)", () => {
    for (const s of SCAN_CATALOG) {
      if (s.source !== "core") {
        assert.equal(s.runnable, false, `${s.id} must be browse-only`);
      }
    }
  });

  it("getScan finds by id; a ghost id is undefined", () => {
    const first = SCAN_CATALOG[0]!;
    assert.equal(getScan(first.id), first);
    assert.equal(getScan("ghost:nope"), undefined);
  });

  it('listScanCategories puts "All" first with the full count; buckets sum to the total and sort desc', () => {
    const cats = listScanCategories();
    assert.deepEqual(cats[0], {
      category: "all",
      count: SCAN_CATALOG.length,
      label: "All",
    });
    const rest = cats.slice(1);
    const sum = rest.reduce((n, c) => n + c.count, 0);
    assert.equal(sum, SCAN_CATALOG.length);
    for (let i = 1; i < rest.length; i++) {
      assert.ok(rest[i - 1]!.count >= rest[i]!.count, "buckets sorted desc");
    }
    for (const c of rest) {
      assert.equal(
        c.label,
        scanCategoryLabel(c.category as Exclude<typeof c.category, "all">),
      );
    }
  });

  it("getScanCatalog returns the catalog + categories as a ServiceResult", async () => {
    const res = await getScanCatalog();
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.scans, SCAN_CATALOG); // same reference — static data
      assert.equal(res.data.categories[0]!.category, "all");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// scans.service — mapFiltersToScreenFilters band mapping
// ════════════════════════════════════════════════════════════════════════════

describe("scans.service — mapFiltersToScreenFilters", () => {
  it("maps gt/gte to the min band and lt/lte to the max band", () => {
    const m = mapFiltersToScreenFilters([
      { field: "pe", operator: "lte", value: 15 },
      { field: "roe", operator: "gte", value: 12 },
      { field: "dividendYield", operator: "gt", value: 3 },
      { field: "marketCap", operator: "lt", value: 50_000 },
    ] satisfies ScreenerFilter[]);
    assert.deepEqual(m.filters, {
      maxPe: 15,
      minRoe: 12,
      minDividendYield: 3,
      maxMarketCap: 50_000,
    });
    assert.equal(m.mappedCount, 4);
    assert.deepEqual(m.unmapped, []);
  });

  it('"between" sets both bands; "eq" pins min = max', () => {
    const between = mapFiltersToScreenFilters([
      { field: "pe", operator: "between", value: [10, 20] },
    ]);
    assert.deepEqual(between.filters, { minPe: 10, maxPe: 20 });

    const eq = mapFiltersToScreenFilters([
      { field: "debtToEquity", operator: "eq", value: 0.5 },
    ]);
    assert.deepEqual(eq.filters, {
      minDebtToEquity: 0.5,
      maxDebtToEquity: 0.5,
    });
  });

  it("repeated bounds TIGHTEN the band (max of mins, min of maxes)", () => {
    const m = mapFiltersToScreenFilters([
      { field: "pe", operator: "gte", value: 10 },
      { field: "pe", operator: "gte", value: 15 }, // tighter min wins
      { field: "pe", operator: "lte", value: 30 },
      { field: "pe", operator: "lte", value: 20 }, // tighter max wins
    ]);
    assert.deepEqual(m.filters, { minPe: 15, maxPe: 20 });
    assert.equal(m.mappedCount, 4);
  });

  it("unmapped fields (no fundamental band) land in `unmapped`, not in the filters", () => {
    const m = mapFiltersToScreenFilters([
      { field: "rsi_14", operator: "gt", value: 60 },
      { field: "roe", operator: "gt", value: 15 },
      { field: "sma_200_cross", operator: "cross_above", value: 0 },
    ]);
    assert.deepEqual(m.filters, { minRoe: 15 });
    assert.equal(m.mappedCount, 1);
    assert.deepEqual(m.unmapped, ["rsi_14", "sma_200_cross"]);
  });

  it("NON-FINITE guard: Infinity/NaN values never become bands (unmapped instead)", () => {
    const m = mapFiltersToScreenFilters([
      { field: "pe", operator: "gte", value: Infinity },
      { field: "roe", operator: "lte", value: NaN },
      { field: "marketCap", operator: "between", value: [10, Infinity] },
    ]);
    assert.deepEqual(m.filters, {});
    assert.equal(m.mappedCount, 0);
    assert.deepEqual(m.unmapped, ["pe", "roe", "marketCap"]);
  });

  it("a malformed `between` (wrong arity / non-array) is unmapped", () => {
    const m = mapFiltersToScreenFilters([
      {
        field: "pe",
        operator: "between",
        value: [10] as unknown as [number, number],
      },
      { field: "roe", operator: "between", value: 5 },
    ]);
    assert.deepEqual(m.filters, {});
    assert.deepEqual(m.unmapped, ["pe", "roe"]);
  });

  it("a technical operator on a mappable field is still unmapped (cross_above)", () => {
    const m = mapFiltersToScreenFilters([
      { field: "pe", operator: "cross_above", value: 1 },
    ]);
    assert.deepEqual(m.unmapped, ["pe"]);
  });

  it("isScreenerRunnable: undefined/empty/all-unmapped → false; one mappable band → true", () => {
    assert.equal(isScreenerRunnable(undefined), false);
    assert.equal(isScreenerRunnable([]), false);
    assert.equal(
      isScreenerRunnable([{ field: "rsi_14", operator: "gt", value: 60 }]),
      false,
    );
    assert.equal(
      isScreenerRunnable([{ field: "pe", operator: "lt", value: 15 }]),
      true,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// scans.service — runScan (injected screener engine)
// ════════════════════════════════════════════════════════════════════════════

describe("scans.service — runScan (fail-closed, injected engine)", () => {
  function recordingEngine(result?: {
    rows?: ScreenResult[];
    total?: number;
  }): {
    calls: unknown[][];
    screenStocks: typeof screenStocks;
  } {
    const calls: unknown[][] = [];
    const engine = (async (...args: unknown[]) => {
      calls.push(args);
      return {
        success: true,
        data: {
          rows: result?.rows ?? [],
          total: result?.total ?? 0,
          page: 0,
          pageSize: 50,
        },
      };
    }) as unknown as typeof screenStocks;
    return { calls, screenStocks: engine };
  }

  it("ghost id → NOT_FOUND, engine never called", async () => {
    const { calls, screenStocks: engine } = recordingEngine();
    const res = await runScan("ghost:nope", undefined, {
      screenStocks: engine,
    });
    assert.deepEqual(res, {
      success: false,
      error: "Scan not found",
      code: "NOT_FOUND",
    });
    assert.equal(calls.length, 0);
  });

  it("browse-only scan → NOT_RUNNABLE with the web action's exact message, engine never called", async () => {
    const browseOnly = SCAN_CATALOG.find((s) => !s.runnable)!;
    const { calls, screenStocks: engine } = recordingEngine();
    const res = await runScan(browseOnly.id, undefined, {
      screenStocks: engine,
    });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.code, "NOT_RUNNABLE");
      assert.equal(
        res.error,
        "This scan isn't available for one-click run yet. Open it in the screener or ask StockSage to run it.",
      );
    }
    assert.equal(calls.length, 0);
  });

  it("runnable scan: engine gets the MAPPED bands, empty query, page 0, default pageSize 50, match sort", async () => {
    const scan = SCAN_CATALOG.find((s) => s.runnable)!;
    const expected = mapFiltersToScreenFilters(scan.filters!);
    const rows = [{ symbol: "ONGC" } as unknown as ScreenResult];
    const { calls, screenStocks: engine } = recordingEngine({ rows, total: 1 });

    const res = await runScan(scan.id, undefined, { screenStocks: engine });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      expected.filters,
      "",
      { page: 0, pageSize: 50, sort: "match" },
    ]);
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.scanId, scan.id);
      assert.equal(res.data.scanName, scan.name);
      assert.deepEqual(res.data.rows, rows);
      assert.equal(res.data.total, 1);
      assert.deepEqual(res.data.unmapped, expected.unmapped);
      assert.equal(res.data.partial, expected.unmapped.length > 0);
    }
  });

  it("limit clamps to [1, 100] (0 → 1, 500 → 100), mirroring the web action", async () => {
    const scan = SCAN_CATALOG.find((s) => s.runnable)!;
    for (const [limit, expected] of [
      [0, 1],
      [500, 100],
      [25, 25],
    ] as const) {
      const { calls, screenStocks: engine } = recordingEngine();
      await runScan(scan.id, { limit }, { screenStocks: engine });
      const paging = calls[0]![2] as { pageSize: number };
      assert.equal(paging.pageSize, expected, `limit ${limit}`);
    }
  });

  it("engine failure passes through as a plain (code-less) failure", async () => {
    const scan = SCAN_CATALOG.find((s) => s.runnable)!;
    const engine = (async () => ({
      success: false,
      error: "Failed to run screener",
    })) as unknown as typeof screenStocks;
    const res = await runScan(scan.id, undefined, { screenStocks: engine });
    assert.deepEqual(res, { success: false, error: "Failed to run screener" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// screener.service — ported pure helpers
// ════════════════════════════════════════════════════════════════════════════

describe("screener.service — filterScore / match scores", () => {
  it("missing value or an inactive rule scores null (excluded from the mean)", () => {
    assert.equal(filterScore(null, { min: 1 }), null);
    assert.equal(filterScore(undefined, { min: 1 }), null);
    assert.equal(filterScore(5, {}), null); // no bounds
    assert.equal(filterScore("abc", { min: 1 }), null); // non-number vs numeric rule
    assert.equal(filterScore("X", { equals: null }), null); // inactive categorical
    assert.equal(filterScore("X", { equalsAny: [] }), null);
  });

  it("categorical: equals / equalsAny score 1 on hit, 0 on miss", () => {
    assert.equal(filterScore("NSE", { equals: "NSE" }), 1);
    assert.equal(filterScore("BSE", { equals: "NSE" }), 0);
    assert.equal(filterScore("HDFC", { equalsAny: ["HDFC", "SBI"] }), 1);
    assert.equal(filterScore("AXIS", { equalsAny: ["HDFC", "SBI"] }), 0);
  });

  it("numeric: outside a bound → 0; single-bound in-range → 1; two-bound peaks at the midpoint, 0.5 at the edges", () => {
    assert.equal(filterScore(5, { min: 10 }), 0);
    assert.equal(filterScore(15, { min: 10 }), 1);
    assert.equal(filterScore(25, { max: 20 }), 0);
    assert.equal(filterScore(15, { max: 20 }), 1);
    assert.equal(filterScore(15, { min: 10, max: 20 }), 1); // midpoint
    assert.equal(filterScore(10, { min: 10, max: 20 }), 0.5); // edge
    assert.equal(filterScore(20, { min: 10, max: 20 }), 0.5); // edge
    assert.equal(filterScore(9.99, { min: 10, max: 20 }), 0);
  });

  it("computeMatchScore: no active filters (or all-null row) → 100; mean is rounded to an int", () => {
    const nullRow = {
      pe: null,
      roe: null,
      revenueGrowth: null,
      debtToEquity: null,
      marketCap: null,
    };
    assert.equal(computeMatchScore(nullRow, {}), 100);
    // pe scores 1 (midpoint), roe scores 0 (below min) → mean 0.5 → 50
    assert.equal(
      computeMatchScore(
        { ...nullRow, pe: 15, roe: 5 },
        { minPe: 10, maxPe: 20, minRoe: 10 },
      ),
      50,
    );
  });

  it("computeMatchScore: marketCapBucket resolves to the crore thresholds", () => {
    const row = {
      pe: null,
      roe: null,
      revenueGrowth: null,
      debtToEquity: null,
      marketCap: 25_000,
    };
    assert.equal(computeMatchScore(row, { marketCapBucket: "LARGE" }), 100);
    assert.equal(
      computeMatchScore(
        { ...row, marketCap: 10_000 },
        { marketCapBucket: "LARGE" },
      ),
      0,
    );
  });

  it("computeMfMatchScore: categorical + band mix; empty filters → 100", () => {
    const row = {
      category: "Equity",
      amcName: "HDFC",
      plan: "DIRECT",
      riskLevel: null,
      fundType: null,
      aum: 100,
      returns1Y: null,
      returns3Y: null,
      returns5Y: null,
      expenseRatio: null,
    };
    assert.equal(computeMfMatchScore(row, {}), 100);
    // amcAny takes precedence over amcName in the rule
    assert.equal(
      computeMfMatchScore(row, { amcAny: ["SBI"], amcName: "HDFC" }),
      0,
    );
    // category hit (1) + amc miss (0) → 50
    assert.equal(
      computeMfMatchScore(row, { category: "Equity", amcName: "SBI" }),
      50,
    );
  });

  it("computeEtfMatchScore: theme is a name-substring check", () => {
    const row = {
      exchange: "NSE",
      assetClass: "equity",
      name: "NIPPON INDIA ETF GOLD BEES",
      aum: null,
      returns1Y: null,
      expenseRatio: null,
    };
    assert.equal(computeEtfMatchScore(row, {}), 100);
    assert.equal(computeEtfMatchScore(row, { theme: "gold" }), 100);
    assert.equal(computeEtfMatchScore(row, { theme: "silver" }), 0);
  });

  it("resolveMarketCapRange: bucket wins, explicit values fill the bucket's open side", () => {
    assert.deepEqual(resolveMarketCapRange({ marketCapBucket: "MID" }), {
      min: 5_000,
      max: 20_000,
    });
    assert.deepEqual(
      resolveMarketCapRange({ marketCapBucket: "LARGE", maxMarketCap: 99_999 }),
      { min: 20_000, max: 99_999 },
    );
    assert.deepEqual(
      resolveMarketCapRange({ minMarketCap: 1, maxMarketCap: 2 }),
      { min: 1, max: 2 },
    );
    // sanity on the crore thresholds themselves
    assert.deepEqual(MCAP_BUCKETS.SMALL, { max: 5_000 });
  });
});

describe("screener.service — buildMfScreenWhere (env dual-path preserved)", () => {
  it("default (gate ON): navDate freshness bound present as a ~30-day cutoff", () => {
    const prev = process.env.SKIP_MF_NAV_GATE;
    delete process.env.SKIP_MF_NAV_GATE;
    try {
      const where = buildMfScreenWhere({});
      assert.equal(where.isActive, true);
      const nav = where.navDate as { gte: Date };
      assert.ok(nav.gte instanceof Date);
      const days = (Date.now() - nav.gte.getTime()) / 86_400_000;
      assert.ok(days > 29 && days < 31, `cutoff ~30d, got ${days}`);
    } finally {
      if (prev === undefined) delete process.env.SKIP_MF_NAV_GATE;
      else process.env.SKIP_MF_NAV_GATE = prev;
    }
  });

  it("SKIP_MF_NAV_GATE=1 drops the freshness gate (QA/dev stale-NAV path)", () => {
    const prev = process.env.SKIP_MF_NAV_GATE;
    process.env.SKIP_MF_NAV_GATE = "1";
    try {
      const where = buildMfScreenWhere({});
      assert.equal("navDate" in where, false);
    } finally {
      if (prev === undefined) delete process.env.SKIP_MF_NAV_GATE;
      else process.env.SKIP_MF_NAV_GATE = prev;
    }
  });

  it("riskLevel buckets expand to their neighbour sets; unknown values pass through", () => {
    const prev = process.env.SKIP_MF_NAV_GATE;
    process.env.SKIP_MF_NAV_GATE = "1";
    try {
      assert.deepEqual(buildMfScreenWhere({ riskLevel: "low" }).riskLevel, {
        in: ["Low", "Low to Moderate"],
      });
      assert.deepEqual(
        buildMfScreenWhere({ riskLevel: "moderate" }).riskLevel,
        {
          in: ["Low to Moderate", "Moderate", "Moderately High"],
        },
      );
      assert.deepEqual(buildMfScreenWhere({ riskLevel: "high" }).riskLevel, {
        in: ["Moderately High", "High", "Very High"],
      });
      assert.equal(
        buildMfScreenWhere({ riskLevel: "Very High" }).riskLevel,
        "Very High",
      );
    } finally {
      if (prev === undefined) delete process.env.SKIP_MF_NAV_GATE;
      else process.env.SKIP_MF_NAV_GATE = prev;
    }
  });

  it("amcAny takes precedence over amcName; bands compose gte/lte; query ORs name/AMC", () => {
    const prev = process.env.SKIP_MF_NAV_GATE;
    process.env.SKIP_MF_NAV_GATE = "1";
    try {
      const where = buildMfScreenWhere(
        {
          amcAny: ["HDFC", "SBI"],
          amcName: "AXIS",
          minAum: 10,
          maxReturns1Y: 30,
        },
        "  bluechip  ",
      );
      assert.deepEqual(where.amcName, { in: ["HDFC", "SBI"] });
      assert.deepEqual(where.aum, { gte: 10 });
      assert.deepEqual(where.returns1Y, { lte: 30 });
      assert.deepEqual(where.OR, [
        { schemeName: { contains: "bluechip", mode: "insensitive" } },
        { amcName: { contains: "bluechip", mode: "insensitive" } },
      ]);

      const single = buildMfScreenWhere({ amcName: "AXIS" });
      assert.equal(single.amcName, "AXIS");
    } finally {
      if (prev === undefined) delete process.env.SKIP_MF_NAV_GATE;
      else process.env.SKIP_MF_NAV_GATE = prev;
    }
  });
});

describe("screener.service — buildEtfScreenWhere / ETF name derivation / index resolution", () => {
  it("buildEtfScreenWhere: active-ETF base, exchange pin, symbol-prefix + name-contains query", () => {
    // MONEY-1085 follow-up: the funds screener covers ETFs AND the
    // exchange-traded trusts (REIT/INVIT), which were reclassified out of
    // EQUITY. A bare "ETF" filter here would drop them from every list.
    //
    // MONEY-1263 — the no-filter case now pins an India VENUE SCOPE too. This
    // assertion previously matched a shape with no `exchange` key, which was
    // correct while every row in `instrument_mappings` was Indian. The US
    // master writes ~7,600 active ETFs against India's ~541, so without the
    // scope this screener returns US funds in the majority — no error, just a
    // screener about a different country.
    assert.deepEqual(buildEtfScreenWhere({}), {
      isActive: true,
      exchange: { in: ["NSE", "BSE"] },
      instrumentType: { in: ["ETF", "REIT", "INVIT"] },
    });
    // A caller-supplied exchange still overrides the default — the scope is a
    // floor, not a lock.
    const where = buildEtfScreenWhere({ exchange: "BSE" }, "gold");
    assert.equal(where.exchange, "BSE");
    assert.deepEqual(where.OR, [
      { symbol: { startsWith: "GOLD" } },
      { name: { contains: "gold", mode: "insensitive" } },
    ]);
  });

  it("extractEtfFundHouse: known house prefix wins; ' ETF' split fallback; quotes stripped; else Other", () => {
    assert.equal(
      extractEtfFundHouse("NIPPON INDIA ETF GOLD BEES"),
      "Nippon India",
    );
    assert.equal(
      extractEtfFundHouse('"MIRAE ASSET NIFTY 50 ETF"'),
      "Mirae Asset",
    );
    assert.equal(
      extractEtfFundHouse("ZEBRA CAPITAL ETF UNITS"),
      "Zebra Capital",
    );
    assert.equal(extractEtfFundHouse("RANDOM FUND UNITS"), "Other");
  });

  it("deriveEtfCategory: commodity/index/sector keywords with word-boundary IT", () => {
    assert.equal(deriveEtfCategory("NIPPON INDIA ETF GOLD BEES"), "Commodity");
    assert.equal(deriveEtfCategory("SBI NIFTY 50 ETF"), "Large Cap");
    assert.equal(deriveEtfCategory("KOTAK IT ETF"), "Technology");
    assert.equal(deriveEtfCategory("HDFC SMALLCAP 250 ETF"), "Small Cap");
    assert.equal(
      deriveEtfCategory("ICICI PRUDENTIAL PRIVATE BANK ETF"),
      "Banking",
    );
    assert.equal(deriveEtfCategory("MYSTERY THING"), "Other");
  });

  it("deriveEtfAssetClass: debt keywords → debt; gold → other; hybrid/solution; default equity", () => {
    assert.equal(deriveEtfAssetClass("SBI GILT ETF"), "debt");
    assert.equal(deriveEtfAssetClass("AXIS LIQUID ETF"), "debt");
    assert.equal(deriveEtfAssetClass("GOLD BEES"), "other");
    assert.equal(deriveEtfAssetClass("SOME HYBRID ETF"), "hybrid");
    assert.equal(deriveEtfAssetClass("AXIS TARGET MATURITY ETF"), "solution");
    assert.equal(deriveEtfAssetClass("SBI NIFTY 50 ETF"), "equity");
  });

  it('resolveIndexFilter: "all"/undefined/unknown → all; static beats sector; mcap-rank windows', () => {
    assert.deepEqual(resolveIndexFilter(undefined), { kind: "all" });
    assert.deepEqual(resolveIndexFilter("all"), { kind: "all" });
    assert.deepEqual(resolveIndexFilter("not_an_index"), { kind: "all" });

    const nifty50 = resolveIndexFilter("nifty50");
    assert.equal(nifty50.kind, "static");
    assert.equal(nifty50.symbols?.length, 50);
    assert.ok(nifty50.symbols?.includes("RELIANCE"));

    // niftyit is in BOTH the static list and the sector map — static wins.
    assert.equal(resolveIndexFilter("niftyit").kind, "static");

    assert.deepEqual(resolveIndexFilter("nifty100"), {
      kind: "mcap-rank",
      rank: { start: 1, end: 100 },
    });
    assert.deepEqual(resolveIndexFilter("niftymicrocap250"), {
      kind: "mcap-rank",
      rank: { start: 501, end: 750 },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// screener.service — screenStocks / screenMfs / screenEtfs (injected IO)
// ════════════════════════════════════════════════════════════════════════════

interface PrismaCall {
  model: string;
  method: string;
  args: Record<string, unknown>;
}

/** Fake screener prisma: per-delegate findMany impls + a recorded call log. */
function fakeScreenerPrisma(impls: {
  stockRatios?: (args: Record<string, unknown>) => unknown[];
  instrumentMapping?: (args: Record<string, unknown>) => unknown[];
  latestQuote?: (args: Record<string, unknown>) => unknown[];
  indexConstituent?: (args: Record<string, unknown>) => unknown[];
  mutualFundMaster?: (args: Record<string, unknown>) => unknown[];
}): { prisma: ScreenerServiceDeps["prisma"]; calls: PrismaCall[] } {
  const calls: PrismaCall[] = [];
  const delegate = (model: keyof typeof impls) => ({
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model, method: "findMany", args });
      const impl = impls[model];
      if (!impl) throw new Error(`unexpected ${model}.findMany`);
      return impl(args);
    },
  });
  const prisma = {
    stockRatios: delegate("stockRatios"),
    instrumentMapping: delegate("instrumentMapping"),
    latestQuote: delegate("latestQuote"),
    indexConstituent: delegate("indexConstituent"),
    mutualFundMaster: delegate("mutualFundMaster"),
  } as unknown as ScreenerServiceDeps["prisma"];
  return { prisma, calls };
}

/** In-memory cache seam recording get/set. */
function fakeCache(primed?: unknown): {
  cache: ScreenerCache;
  gets: string[];
  sets: Array<{ key: string; value: unknown }>;
} {
  const gets: string[] = [];
  const sets: Array<{ key: string; value: unknown }> = [];
  return {
    gets,
    sets,
    cache: {
      get: async <T>(key: string) => {
        gets.push(key);
        return (primed ?? null) as T | null;
      },
      set: async <T>(key: string, value: T) => {
        sets.push({ key, value });
      },
    },
  };
}

const discoverEmpty = (async () => ({
  success: true as const,
  data: { topGainers: [], topLosers: [], allStocks: [], sectors: [] },
})) as unknown as NonNullable<ScreenerServiceDeps["getDiscoverData"]>;

describe("screener.service — screenStocks (injected prisma/cache/discover)", () => {
  const RATIO_ROW = {
    symbol: "ONGC",
    exchange: "NSE",
    pe: 12,
    roe: 20,
    revenueGrowth: 5,
    debtToEquity: 0.5,
    marketCap: 30_000,
    dividendYield: 4,
    instrument: {
      name: "ONGC Ltd",
      sector: "Energy",
      latestQuote: { price: 250, changePercent: 1.2 },
    },
  };

  it("cache HIT short-circuits: no DB touched, in-memory paging over the ranked list", async () => {
    const ranked = Array.from({ length: 30 }, (_, i) => ({
      symbol: `S${i}`,
      matchScore: 100 - i,
    }));
    const { cache, gets } = fakeCache(ranked);
    const { prisma, calls } = fakeScreenerPrisma({});
    const res = await screenStocks(
      { minPe: 10 },
      undefined,
      { page: 1, pageSize: 10 },
      { prisma, cache },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 30);
      assert.equal(res.data.rows.length, 10);
      assert.equal((res.data.rows[0] as { symbol: string }).symbol, "S10");
      assert.equal(res.data.page, 1);
    }
    assert.equal(calls.length, 0, "cache hit must not touch the DB");
    assert.ok(gets[0]!.startsWith("screener:v3:"), "versioned cache key");
  });

  it("fundamental filters take the ratios-first path: banded where, sector post-filter, real match score, full list cached", async () => {
    const { cache, sets } = fakeCache();
    const { prisma, calls } = fakeScreenerPrisma({
      stockRatios: () => [
        RATIO_ROW,
        {
          ...RATIO_ROW,
          symbol: "TCS",
          instrument: {
            name: "TCS Ltd",
            sector: "Information Technology",
            latestQuote: { price: 4000, changePercent: 0.1 },
          },
        },
      ],
    });
    const filters = { minPe: 10, maxPe: 20, sector: "Energy" };
    const res = await screenStocks(filters, undefined, {}, { prisma, cache });

    const ratioCall = calls.find((c) => c.model === "stockRatios")!;
    assert.deepEqual((ratioCall.args.where as { pe: unknown }).pe, {
      gte: 10,
      lte: 20,
    });

    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 1); // TCS dropped by the sector post-filter
      const row = res.data.rows[0]!;
      assert.equal(row.symbol, "ONGC");
      assert.equal(row.name, "ONGC Ltd");
      assert.equal(row.ltp, 250);
      assert.equal(row.matchScore, computeMatchScore(RATIO_ROW, filters));
    }
    assert.equal(sets.length, 1, "full ranked list cached once");
    assert.equal((sets[0]!.value as unknown[]).length, 1);
  });

  it("index filter: DB IndexConstituent wins; empty DB falls back to the static NIFTY 50 list", async () => {
    // DB-backed membership
    const db = fakeScreenerPrisma({
      indexConstituent: () => [{ symbol: "AAA" }],
      stockRatios: () => [],
    });
    await screenStocks(
      { minPe: 1, index: "nifty50" },
      undefined,
      {},
      { prisma: db.prisma, cache: fakeCache().cache },
    );
    const dbWhere = db.calls.find((c) => c.model === "stockRatios")!.args
      .where as { symbol: { in: string[] } };
    assert.deepEqual(dbWhere.symbol, { in: ["AAA"] });

    // static fallback
    const stat = fakeScreenerPrisma({
      indexConstituent: () => [],
      stockRatios: () => [],
    });
    await screenStocks(
      { minPe: 1, index: "nifty50" },
      undefined,
      {},
      { prisma: stat.prisma, cache: fakeCache().cache },
    );
    const statWhere = stat.calls.find((c) => c.model === "stockRatios")!.args
      .where as { symbol: { in: string[] } };
    assert.equal(statWhere.symbol.in.length, 50);
    assert.ok(statWhere.symbol.in.includes("RELIANCE"));
  });

  it("a query takes the search-first path: symbol/name OR, exact symbol match scores 100", async () => {
    const { prisma, calls } = fakeScreenerPrisma({
      instrumentMapping: () => [
        {
          id: "i1",
          symbol: "RELIANCE",
          exchange: "NSE",
          name: "Reliance Industries",
          sector: "Energy",
          latestQuote: { price: 2900, changePercent: -0.5 },
        },
      ],
      stockRatios: () => [
        {
          instrumentId: "i1",
          pe: 25,
          roe: 9,
          revenueGrowth: 10,
          debtToEquity: 0.4,
          marketCap: 190_000,
          dividendYield: 0.3,
        },
      ],
    });
    const res = await screenStocks(
      {},
      "RELIANCE",
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    const instCall = calls.find((c) => c.model === "instrumentMapping")!;
    assert.deepEqual((instCall.args.where as { OR: unknown }).OR, [
      { symbol: { startsWith: "RELIANCE" } },
      { name: { contains: "RELIANCE", mode: "insensitive" } },
    ]);
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.rows[0]!.matchScore, 100); // exact symbol
      assert.equal(res.data.rows[0]!.marketCap, 190_000); // ratios joined
    }
  });

  it("search + fundamental filter drops rows whose ratios fail the band", async () => {
    const { prisma } = fakeScreenerPrisma({
      instrumentMapping: () => [
        {
          id: "i1",
          symbol: "RELIANCE",
          exchange: "NSE",
          name: "Reliance Industries",
          sector: "Energy",
          latestQuote: { price: 2900, changePercent: -0.5 },
        },
      ],
      stockRatios: () => [
        {
          instrumentId: "i1",
          pe: 25,
          roe: 9,
          revenueGrowth: 10,
          debtToEquity: 0.4,
          marketCap: 190_000,
          dividendYield: 0.3,
        },
      ],
    });
    const res = await screenStocks(
      { minPe: 30 },
      "REL",
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.total, 0);
  });

  it("no filters + no query: discover universe drives the rows (matchScore 100), exchange narrows", async () => {
    const discover = (async () => ({
      success: true as const,
      data: {
        topGainers: [],
        topLosers: [],
        sectors: [],
        allStocks: [
          {
            instrumentId: "i1",
            symbol: "AAA",
            name: "Alpha",
            exchange: "NSE",
            sector: "Energy",
            price: 10,
            changePercent: 1,
          },
          {
            instrumentId: "i2",
            symbol: "BBB",
            name: "Beta",
            exchange: "BSE",
            sector: null,
            price: 20,
            changePercent: -1,
          },
        ],
      },
    })) as unknown as NonNullable<ScreenerServiceDeps["getDiscoverData"]>;
    const { prisma } = fakeScreenerPrisma({
      stockRatios: () => [
        {
          instrumentId: "i1",
          pe: 10,
          roe: 15,
          revenueGrowth: 5,
          debtToEquity: 0.2,
          marketCap: 1000,
        },
      ],
    });
    const res = await screenStocks(
      { exchange: "NSE" },
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
        getDiscoverData: discover,
      },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 1);
      assert.equal(res.data.rows[0]!.symbol, "AAA");
      assert.equal(res.data.rows[0]!.matchScore, 100);
      assert.equal(res.data.rows[0]!.marketCap, 1000); // ratios enrich
    }
  });

  it("empty discover falls back to the instrument universe and excludes MF-named instruments", async () => {
    const { prisma, calls } = fakeScreenerPrisma({
      instrumentMapping: () => [
        {
          id: "i1",
          symbol: "AAA",
          name: "Alpha Ltd",
          exchange: "NSE",
          sector: null,
        },
        {
          id: "i2",
          symbol: "MFX",
          name: "XYZ MUTUAL FUND SCHEME",
          exchange: "NSE",
          sector: null,
        },
      ],
      latestQuote: () => [
        { instrumentId: "i1", price: 12, changePercent: 0.5 },
      ],
      stockRatios: () => [],
    });
    const res = await screenStocks(
      {},
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
        getDiscoverData: discoverEmpty,
      },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 1, "MF-named instrument excluded");
      assert.equal(res.data.rows[0]!.symbol, "AAA");
      assert.equal(res.data.rows[0]!.ltp, 12);
    }
    const universeCall = calls.find((c) => c.model === "instrumentMapping")!;
    const where = universeCall.args.where as Record<string, unknown>;
    assert.equal(where.instrumentType, "EQUITY");
    assert.deepEqual(where.exchange, { in: ["NSE", "BSE"] });
  });

  it("paging clamps: pageSize caps at 200, negative page floors to 0", async () => {
    const { cache } = fakeCache([]);
    const { prisma } = fakeScreenerPrisma({});
    const res = await screenStocks(
      {},
      undefined,
      { page: -5, pageSize: 999 },
      {
        prisma,
        cache,
      },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.page, 0);
      assert.equal(res.data.pageSize, 200);
    }
  });

  it("a DB throw degrades to the sanitized failure message", async () => {
    const prisma = {
      stockRatios: {
        findMany: async () => {
          throw new Error("Mongo down");
        },
      },
      indexConstituent: {
        findMany: async () => [],
      },
    } as unknown as ScreenerServiceDeps["prisma"];
    const res = await screenStocks(
      { minPe: 1 },
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    assert.deepEqual(res, { success: false, error: "Failed to run screener" });
  });
});

describe("screener.service — screenMfs (injected prisma/cache)", () => {
  const MF_ROW = {
    schemeCode: "100001",
    schemeName: "Alpha Bluechip Fund",
    amcName: "HDFC",
    category: "Large Cap",
    plan: "DIRECT",
    fundType: "equity",
    riskLevel: "High",
    nav: 100,
    navDate: new Date("2026-07-01T00:00:00Z"),
    aum: 5000,
    returns1Y: 20,
    returns3Y: 15,
    returns5Y: 12,
    expenseRatio: 0.5,
  };

  it("queries with the buildMfScreenWhere where, scores rows, sorts aum-desc (null → 0), caches the full list", async () => {
    const prev = process.env.SKIP_MF_NAV_GATE;
    process.env.SKIP_MF_NAV_GATE = "1"; // deterministic where (no Date)
    try {
      const { cache, sets } = fakeCache();
      const { prisma, calls } = fakeScreenerPrisma({
        mutualFundMaster: () => [
          { ...MF_ROW, schemeCode: "1", aum: null },
          { ...MF_ROW, schemeCode: "2", aum: 100 },
        ],
      });
      const filters = { category: "Large Cap" };
      const res = await screenMfs(
        filters,
        "blue",
        { sort: "aum-desc" },
        {
          prisma,
          cache,
        },
      );
      const call = calls.find((c) => c.model === "mutualFundMaster")!;
      assert.deepEqual(call.args.where, buildMfScreenWhere(filters, "blue"));
      assert.deepEqual(call.args.orderBy, [{ aum: "desc" }]);

      assert.equal(res.success, true);
      if (res.success) {
        assert.equal(res.data.total, 2);
        // aum 100 sorts above aum null (coerced to 0)
        assert.equal(res.data.rows[0]!.schemeCode, "2");
        assert.equal(res.data.rows[1]!.schemeCode, "1");
        assert.equal(
          res.data.rows[0]!.matchScore,
          computeMfMatchScore({ ...MF_ROW, aum: 100 }, filters),
        );
      }
      assert.equal(sets.length, 1);
      assert.ok(sets[0]!.key.startsWith("screener-mf:v2:"));
    } finally {
      if (prev === undefined) delete process.env.SKIP_MF_NAV_GATE;
      else process.env.SKIP_MF_NAV_GATE = prev;
    }
  });

  it("cache hit pages without the DB; a DB throw degrades to the sanitized message", async () => {
    const primed = Array.from({ length: 5 }, (_, i) => ({
      schemeCode: `${i}`,
    }));
    const hit = await screenMfs(
      {},
      undefined,
      { page: 1, pageSize: 2 },
      {
        prisma: fakeScreenerPrisma({}).prisma,
        cache: fakeCache(primed).cache,
      },
    );
    assert.equal(hit.success, true);
    if (hit.success) {
      assert.equal(hit.data.total, 5);
      assert.deepEqual(
        hit.data.rows.map((r) => (r as { schemeCode: string }).schemeCode),
        ["2", "3"],
      );
    }

    const prisma = {
      mutualFundMaster: {
        findMany: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as ScreenerServiceDeps["prisma"];
    const fail = await screenMfs(
      {},
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    assert.deepEqual(fail, {
      success: false,
      error: "Failed to run mutual fund screener",
    });
  });
});

describe("screener.service — screenEtfs (injected prisma/cache)", () => {
  it("no matching instruments → success with an empty page (no quote/MF lookups)", async () => {
    const { prisma, calls } = fakeScreenerPrisma({
      instrumentMapping: () => [],
    });
    const res = await screenEtfs(
      {},
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data, { rows: [], total: 0, page: 0, pageSize: 25 });
    }
    assert.equal(calls.filter((c) => c.model === "latestQuote").length, 0);
  });

  it("merges quotes (required) + ISIN-matched MF stats; quote-less instruments drop; MF fundType wins assetClass", async () => {
    const { prisma } = fakeScreenerPrisma({
      instrumentMapping: () => [
        {
          id: "e1",
          symbol: "GOLDBEES",
          name: "NIPPON INDIA ETF GOLD BEES",
          exchange: "NSE",
          yahooSymbol: "GOLDBEES.NS",
          isin: "INF1",
        },
        {
          id: "e2",
          symbol: "NOQUOTE",
          name: "SBI NIFTY 50 ETF",
          exchange: "NSE",
          yahooSymbol: "NOQUOTE.NS",
          isin: null,
        },
      ],
      latestQuote: () => [
        { instrumentId: "e1", price: 55, changePercent: 0.2, marketCap: 9000 },
      ],
      mutualFundMaster: () => [
        {
          isinGrowth: "INF1",
          isinDividend: null,
          aum: 5000,
          returns1Y: 12,
          expenseRatio: 0.5,
          fundType: "other",
        },
      ],
    });
    const { cache, sets } = fakeCache();
    const res = await screenEtfs({}, undefined, {}, { prisma, cache });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 1, "quote-less ETF dropped");
      const row = res.data.rows[0]!;
      assert.equal(row.symbol, "GOLDBEES");
      assert.equal(row.ltp, 55);
      assert.equal(row.aum, 5000); // MF AUM preferred over quote marketCap
      assert.equal(row.returns1Y, 12);
      assert.equal(row.expenseRatio, 0.5);
      assert.equal(row.assetClass, "other"); // MF fundType wins over derivation
      assert.equal(row.yahooSymbol, "GOLDBEES.NS");
    }
    assert.equal(sets.length, 1);
    assert.ok(sets[0]!.key.startsWith("screener-etf:v2:"));
  });

  it("assetClass filter uses the effective class; cache hit pages without prisma", async () => {
    const { prisma } = fakeScreenerPrisma({
      instrumentMapping: () => [
        {
          id: "e1",
          symbol: "GOLDBEES",
          name: "NIPPON INDIA ETF GOLD BEES",
          exchange: "NSE",
          yahooSymbol: "GOLDBEES.NS",
          isin: null,
        },
      ],
      latestQuote: () => [
        { instrumentId: "e1", price: 55, changePercent: 0.2, marketCap: 9000 },
      ],
    });
    // derived class for a gold ETF is "other" — an "equity" filter excludes it
    const filtered = await screenEtfs(
      { assetClass: "equity" },
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    assert.equal(filtered.success, true);
    if (filtered.success) assert.equal(filtered.data.total, 0);

    const primed = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }];
    const hit = await screenEtfs(
      {},
      undefined,
      { page: 1, pageSize: 2 },
      {
        prisma: fakeScreenerPrisma({}).prisma,
        cache: fakeCache(primed).cache,
      },
    );
    assert.equal(hit.success, true);
    if (hit.success) {
      assert.equal(hit.data.total, 3);
      assert.deepEqual(
        hit.data.rows.map((r) => (r as { symbol: string }).symbol),
        ["C"],
      );
    }
  });

  it("a DB throw degrades to the sanitized ETF failure message", async () => {
    const prisma = {
      instrumentMapping: {
        findMany: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as ScreenerServiceDeps["prisma"];
    const res = await screenEtfs(
      {},
      undefined,
      {},
      {
        prisma,
        cache: fakeCache().cache,
      },
    );
    assert.deepEqual(res, {
      success: false,
      error: "Failed to run ETF screener",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// strategies.service — presets + categories
// ════════════════════════════════════════════════════════════════════════════

function mkStats(cagr: number): StrategyStats {
  return {
    cagr,
    sharpe: 1,
    maxDrawdown: -10,
    oneYearReturn: cagr,
    period: "5Y",
    equityCurve: [1, 2],
    users: null,
    computedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("strategies.service — getStrategyPresets / categories (injected stats loader)", () => {
  it("stats-first sort: backtested cards lead (cagr desc), stat-less tail is alphabetical", async () => {
    const a = BUILTIN_STRATEGIES[0]!;
    const b = BUILTIN_STRATEGIES[1]!;
    const stats = new Map<string, StrategyStats>([
      [a.id, mkStats(10)],
      [b.id, mkStats(30)],
    ]);
    const res = await getStrategyPresets(
      { limit: BUILTIN_STRATEGIES.length },
      { loadStatsMap: async () => stats },
    );
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.length, BUILTIN_STRATEGIES.length);
    assert.equal(res.data[0]!.id, b.id, "higher cagr first");
    assert.equal(res.data[1]!.id, a.id);
    assert.deepEqual(res.data[0]!.stats, mkStats(30));
    const tail = res.data.slice(2);
    for (const card of tail) assert.equal(card.stats, null);
    for (let i = 1; i < tail.length; i++) {
      assert.ok(
        tail[i - 1]!.name.localeCompare(tail[i]!.name) <= 0,
        "stat-less tail alphabetical",
      );
    }
  });

  it("category filter narrows to the registry's bucket; default stats are null", async () => {
    const category = BUILTIN_STRATEGIES[0]!.category as StrategyCategory;
    const expected = BUILTIN_STRATEGIES.filter((s) => s.category === category);
    const res = await getStrategyPresets(
      { category, limit: expected.length + 10 },
      { loadStatsMap: async () => new Map() },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.length, expected.length);
      for (const card of res.data) {
        assert.equal(card.category, category);
        assert.equal(card.stats, null);
      }
    }
  });

  it("a stats-loader throw degrades to the sanitized presets failure", async () => {
    const res = await getStrategyPresets(undefined, {
      loadStatsMap: async () => {
        throw new Error("redis down");
      },
    });
    assert.deepEqual(res, {
      success: false,
      error: "Failed to load strategy presets",
    });
  });

  it('getStrategyCategoriesInfo prepends "all" with the summed count', async () => {
    const res = await getStrategyCategoriesInfo();
    assert.equal(res.success, true);
    if (!res.success) return;
    const registry = getStrategyCategories();
    assert.equal(res.data.length, registry.length + 1);
    const total = registry.reduce((n, c) => n + c.count, 0);
    assert.deepEqual(res.data[0], {
      category: "all",
      count: total,
      label: "All",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// strategies.service — custom CRUD (injected prisma)
// ════════════════════════════════════════════════════════════════════════════

/** Fake strategies prisma with queue/override impls + a recorded ordered log. */
function fakeStrategiesPrisma(impls?: {
  customFindMany?: (args: Record<string, unknown>) => unknown[];
  customFindFirst?: (args: Record<string, unknown>) => unknown;
  customCreate?: (args: Record<string, unknown>) => unknown;
  customUpdate?: (args: Record<string, unknown>) => unknown;
  customDelete?: (args: Record<string, unknown>) => unknown;
  scanCreate?: (args: Record<string, unknown>) => unknown;
  scanFindFirst?: (args: Record<string, unknown>) => unknown;
  scanFindMany?: (args: Record<string, unknown>) => unknown[];
}): { prisma: StrategiesServiceDeps["prisma"]; log: PrismaCall[] } {
  const log: PrismaCall[] = [];
  const rec = (
    model: string,
    method: string,
    impl: ((args: Record<string, unknown>) => unknown) | undefined,
    fallback: unknown,
  ) => {
    return async (args: Record<string, unknown>) => {
      log.push({ model, method, args });
      return impl ? impl(args) : fallback;
    };
  };
  const prisma = {
    customStrategy: {
      findMany: rec("customStrategy", "findMany", impls?.customFindMany, []),
      findFirst: rec(
        "customStrategy",
        "findFirst",
        impls?.customFindFirst,
        null,
      ),
      create: rec("customStrategy", "create", impls?.customCreate, {
        id: "cs_1",
      }),
      update: rec("customStrategy", "update", impls?.customUpdate, {
        id: "cs_1",
      }),
      delete: rec("customStrategy", "delete", impls?.customDelete, {
        id: "cs_1",
      }),
    },
    scanResult: {
      create: rec("scanResult", "create", impls?.scanCreate, { id: "scan_1" }),
      findFirst: rec("scanResult", "findFirst", impls?.scanFindFirst, null),
      findMany: rec("scanResult", "findMany", impls?.scanFindMany, []),
    },
  } as unknown as StrategiesServiceDeps["prisma"];
  return { prisma, log };
}

describe("strategies.service — listStrategies", () => {
  it("merges the (category-filtered) registry with the caller's custom rows", async () => {
    const category = BUILTIN_STRATEGIES[0]!.category;
    const expectedBuiltIn = getStrategiesByCategory(category);
    const { prisma, log } = fakeStrategiesPrisma({
      customFindMany: () => [
        {
          id: "cs_1",
          name: "Mine",
          description: null,
          category: "value",
          scanType: "fundamental",
          tags: ["t"],
          usageCount: 3,
          lastRunAt: new Date("2026-07-01T00:00:00Z"),
          lastRunCount: 7,
        },
      ],
    });
    const res = await listStrategies("u1", { category }, { prisma });
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.builtIn.length, expectedBuiltIn.length);
    assert.ok(res.data.builtIn.every((s) => s.isBuiltIn));
    assert.deepEqual(res.data.custom, [
      {
        id: "cs_1",
        name: "Mine",
        description: null,
        category: "value",
        scanType: "fundamental",
        tags: ["t"],
        isBuiltIn: false,
        usageCount: 3,
        lastRunAt: "2026-07-01T00:00:00.000Z",
        lastRunCount: 7,
      },
    ]);
    const q = log.find((c) => c.model === "customStrategy")!;
    assert.deepEqual(q.args.where, { userId: "u1" });
    assert.deepEqual(q.args.orderBy, { updatedAt: "desc" });
  });

  it("a DB throw degrades with the error message appended", async () => {
    const { prisma } = fakeStrategiesPrisma({
      customFindMany: () => {
        throw new Error("boom");
      },
    });
    const res = await listStrategies("u1", undefined, { prisma });
    assert.deepEqual(res, {
      success: false,
      error: "Failed to list strategies: boom",
    });
  });
});

describe("strategies.service — createStrategy / updateStrategy / deleteStrategy", () => {
  const VALID = {
    name: "My Screen",
    filters: [{ metric: "pe", operator: "lt", value: 15 }],
    scanType: "fundamental",
  };

  it("guards run BEFORE the DB: short name and empty filters never create", async () => {
    const { prisma, log } = fakeStrategiesPrisma();
    const short = await createStrategy(
      "u1",
      { ...VALID, name: "x" },
      { prisma },
    );
    assert.deepEqual(short, {
      success: false,
      error: "Strategy name must be at least 2 characters",
    });
    const empty = await createStrategy(
      "u1",
      { ...VALID, filters: [] },
      { prisma },
    );
    assert.deepEqual(empty, {
      success: false,
      error: "At least one filter is required",
    });
    assert.equal(log.length, 0);
  });

  it("creates with the ported defaults (logic AND, nulls for absent optionals, [] tags)", async () => {
    const { prisma, log } = fakeStrategiesPrisma({
      customCreate: () => ({ id: "cs_9" }),
    });
    const res = await createStrategy("u1", VALID, { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.id, "cs_9");
    assert.deepEqual(log[0]!.args, {
      data: {
        userId: "u1",
        name: "My Screen",
        description: null,
        filters: VALID.filters,
        logic: "AND",
        scanType: "fundamental",
        chartinkQuery: null,
        category: null,
        tags: [],
      },
    });
  });

  it("maps a unique-constraint create failure to CONFLICT; other errors keep the message", async () => {
    const conflictPrisma = fakeStrategiesPrisma({
      customCreate: () => {
        throw new Error(
          "Unique constraint failed on CustomStrategy_userId_name",
        );
      },
    });
    const conflict = await createStrategy("u1", VALID, {
      prisma: conflictPrisma.prisma,
    });
    assert.deepEqual(conflict, {
      success: false,
      error: "A strategy with this name already exists",
      code: "CONFLICT",
    });

    const otherPrisma = fakeStrategiesPrisma({
      customCreate: () => {
        throw new Error("boom");
      },
    });
    const other = await createStrategy("u1", VALID, {
      prisma: otherPrisma.prisma,
    });
    assert.deepEqual(other, {
      success: false,
      error: "Failed to create strategy: boom",
    });
  });

  it("updateStrategy confirms ownership first (miss → not found, no update) and patches sparsely", async () => {
    const missPrisma = fakeStrategiesPrisma({ customFindFirst: () => null });
    const miss = await updateStrategy(
      "u1",
      "ghost",
      { name: "N" },
      {
        prisma: missPrisma.prisma,
      },
    );
    // MONEY-1183 — same reasoning as the deleteStrategy assertion below:
    // `code` is asserted so the route can tell "no such strategy" (404) from
    // a DB failure (500). A deepEqual is right here precisely because it
    // fails if the field is ever dropped.
    assert.deepEqual(miss, {
      success: false,
      error: "Strategy not found",
      code: "NOT_FOUND",
    });
    assert.equal(
      missPrisma.log.filter((c) => c.method === "update").length,
      0,
      "foreign id must never update",
    );
    assert.deepEqual(missPrisma.log[0]!.args.where, {
      id: "ghost",
      userId: "u1",
    });

    const { prisma, log } = fakeStrategiesPrisma({
      customFindFirst: () => ({ id: "cs_1" }),
    });
    const res = await updateStrategy(
      "u1",
      "cs_1",
      { name: "Renamed", description: "" }, // "" → null; untouched keys omitted
      { prisma },
    );
    assert.equal(res.success, true);
    const update = log.find((c) => c.method === "update")!;
    assert.deepEqual(update.args, {
      where: { id: "cs_1" },
      data: { name: "Renamed", description: null },
    });
  });

  it("deleteStrategy confirms ownership first; delete targets the confirmed id", async () => {
    const missPrisma = fakeStrategiesPrisma({ customFindFirst: () => null });
    const miss = await deleteStrategy("u1", "ghost", {
      prisma: missPrisma.prisma,
    });
    // MONEY-1183 — `code` is asserted, not merely tolerated. The route uses it
    // to tell "no such strategy" (404) from a DB failure (500). Without it both
    // collapsed to 404, so a transient blip looked to the client like the
    // strategy was already gone and it never retried. A deepEqual is the right
    // assertion here precisely because it fails if the field is dropped.
    assert.deepEqual(miss, {
      success: false,
      error: "Strategy not found",
      code: "NOT_FOUND",
    });
    assert.equal(missPrisma.log.filter((c) => c.method === "delete").length, 0);

    const { prisma, log } = fakeStrategiesPrisma({
      customFindFirst: () => ({ id: "cs_1" }),
    });
    const res = await deleteStrategy("u1", "cs_1", { prisma });
    assert.deepEqual(res, { success: true, data: { id: "cs_1" } });
    assert.deepEqual(log.find((c) => c.method === "delete")!.args, {
      where: { id: "cs_1" },
    });
  });
});

describe("strategies.service — cloneBuiltIn", () => {
  it("ghost built-in id fails BEFORE the DB", async () => {
    const { prisma, log } = fakeStrategiesPrisma();
    const res = await cloneBuiltIn("u1", "ghost_builtin", undefined, {
      prisma,
    });
    assert.deepEqual(res, {
      success: false,
      error: "Built-in strategy not found",
    });
    assert.equal(log.length, 0);
  });

  it("clones the registry row with the default name, copied filters and a 'cloned' tag", async () => {
    const b = BUILTIN_STRATEGIES[0]!;
    const { prisma, log } = fakeStrategiesPrisma({
      customCreate: () => ({ id: "cs_clone" }),
    });
    const res = await cloneBuiltIn("u1", b.id, undefined, { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.id, "cs_clone");
    const data = (log[0]!.args as { data: Record<string, unknown> }).data;
    assert.equal(data.userId, "u1");
    assert.equal(data.name, `${b.name} (Custom)`);
    assert.equal(data.scanType, b.scanType);
    assert.deepEqual(data.filters, b.filters);
    assert.deepEqual(data.tags, [...b.tags, "cloned"]);
    assert.equal(data.logic, "AND");
  });

  it("uses the provided custom name; a unique-constraint failure maps to CONFLICT", async () => {
    const b = BUILTIN_STRATEGIES[0]!;
    const named = fakeStrategiesPrisma({
      customCreate: () => ({ id: "cs_x" }),
    });
    await cloneBuiltIn("u1", b.id, "Mine", { prisma: named.prisma });
    assert.equal(
      (named.log[0]!.args as { data: { name: string } }).data.name,
      "Mine",
    );

    const conflict = fakeStrategiesPrisma({
      customCreate: () => {
        throw new Error("Unique constraint failed");
      },
    });
    const res = await cloneBuiltIn("u1", b.id, "Mine", {
      prisma: conflict.prisma,
    });
    assert.deepEqual(res, {
      success: false,
      error: "A strategy with this name already exists",
      code: "CONFLICT",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// strategies.service — runStrategyScan (G3: gate → PENDING create → publish)
// ════════════════════════════════════════════════════════════════════════════

describe("strategies.service — runStrategyScan (injected prisma + publisher)", () => {
  function recordingPublisher(fail = false): {
    published: Array<Record<string, unknown>>;
    orderLog: string[];
    publish: NonNullable<StrategiesServiceDeps["publishStrategyScanJob"]>;
  } {
    const published: Array<Record<string, unknown>> = [];
    const orderLog: string[] = [];
    return {
      published,
      orderLog,
      publish: async (msg) => {
        published.push(msg as unknown as Record<string, unknown>);
        orderLog.push("publish");
        if (fail) throw new Error("pubsub down");
        return "msg_1";
      },
    };
  }

  const CUSTOM_ROW = {
    id: "cs_1",
    name: "My Momentum",
    filters: [{ metric: "rsi", operator: "gt", value: 60 }],
    logic: "OR",
    scanType: "technical",
  };

  it("custom run: ownership gate → PENDING ScanResult → ONE publish with the full message shape", async () => {
    const { published, orderLog, publish } = recordingPublisher();
    const { prisma, log } = fakeStrategiesPrisma({
      customFindFirst: () => CUSTOM_ROW,
      scanCreate: (args) => {
        orderLog.push("create");
        void args;
        return { id: "scan_1" };
      },
    });
    const res = await runStrategyScan("u1", "cs_1", undefined, {
      prisma,
      publishStrategyScanJob: publish,
    });
    assert.deepEqual(res, {
      success: true,
      data: { scanId: "scan_1", status: "PENDING" },
    });

    // gate is ownership-scoped
    assert.deepEqual(log[0], {
      model: "customStrategy",
      method: "findFirst",
      args: { where: { id: "cs_1", userId: "u1" } },
    });
    // PENDING row linked to the custom strategy
    const create = log.find(
      (c) => c.method === "create" && c.model === "scanResult",
    )!;
    assert.deepEqual(create.args, {
      data: {
        strategyId: "cs_1",
        userId: "u1",
        scanName: "My Momentum",
        results: [],
        stockCount: 0,
        status: "PENDING",
      },
    });
    // create STRICTLY before publish (the worker must find the row)
    assert.deepEqual(orderLog, ["create", "publish"]);

    assert.equal(published.length, 1);
    const msg = published[0]!;
    assert.match(String(msg.jobId), UUID_RE);
    assert.equal(msg.userId, "u1");
    assert.equal(msg.scanId, "scan_1");
    assert.equal(msg.strategyId, "cs_1");
    assert.equal(msg.isBuiltIn, false);
    assert.deepEqual(msg.filters, CUSTOM_ROW.filters);
    assert.equal(msg.logic, "OR");
    assert.equal(msg.scanType, "technical");
    assert.equal(msg.limit, 50); // default preview size
  });

  it("explicit limit rides into the message; null row logic falls back to AND", async () => {
    const { published, publish } = recordingPublisher();
    const { prisma } = fakeStrategiesPrisma({
      customFindFirst: () => ({ ...CUSTOM_ROW, logic: null }),
    });
    await runStrategyScan(
      "u1",
      "cs_1",
      { limit: 75 },
      {
        prisma,
        publishStrategyScanJob: publish,
      },
    );
    assert.equal(published[0]!.limit, 75);
    assert.equal(published[0]!.logic, "AND");
  });

  it("GATE FAILURE (foreign/ghost custom): NOT_FOUND — no ScanResult, NOTHING published", async () => {
    const { published, publish } = recordingPublisher();
    const { prisma, log } = fakeStrategiesPrisma({
      customFindFirst: () => null,
    });
    const res = await runStrategyScan("u1", "ghost", undefined, {
      prisma,
      publishStrategyScanJob: publish,
    });
    assert.deepEqual(res, {
      success: false,
      error: "Strategy not found",
      code: "NOT_FOUND",
    });
    assert.equal(
      log.filter((c) => c.model === "scanResult").length,
      0,
      "gate failure must not create an orphan ScanResult",
    );
    assert.equal(published.length, 0, "gate failure must never publish");
  });

  it("built-in run: registry gate, ScanResult.strategyId null, isBuiltIn true in the message", async () => {
    const b = BUILTIN_STRATEGIES[0]!;
    const { published, publish } = recordingPublisher();
    const { prisma, log } = fakeStrategiesPrisma({
      scanCreate: () => ({ id: "scan_b" }),
    });
    const res = await runStrategyScan(
      "u1",
      b.id,
      { isBuiltIn: true },
      {
        prisma,
        publishStrategyScanJob: publish,
      },
    );
    assert.equal(res.success, true);
    assert.equal(
      log.filter((c) => c.model === "customStrategy").length,
      0,
      "built-in path must not query customStrategy",
    );
    const data = (log[0]!.args as { data: Record<string, unknown> }).data;
    assert.equal(data.strategyId, null);
    assert.equal(data.scanName, b.name);
    assert.equal(published[0]!.isBuiltIn, true);
    assert.equal(published[0]!.strategyId, b.id);
    assert.deepEqual(published[0]!.filters, b.filters);
    assert.equal(published[0]!.scanType, b.scanType);
  });

  it("built-in GATE FAILURE (ghost registry id): NOT_FOUND with zero DB work and zero publishes", async () => {
    const { published, publish } = recordingPublisher();
    const { prisma, log } = fakeStrategiesPrisma();
    const res = await runStrategyScan(
      "u1",
      "ghost_builtin",
      { isBuiltIn: true },
      {
        prisma,
        publishStrategyScanJob: publish,
      },
    );
    assert.deepEqual(res, {
      success: false,
      error: "Built-in strategy not found",
      code: "NOT_FOUND",
    });
    assert.equal(log.length, 0);
    assert.equal(published.length, 0);
  });

  it("a publish throw degrades to the sanitized run failure (the PENDING row was already created)", async () => {
    const { publish } = recordingPublisher(true);
    const { prisma, log } = fakeStrategiesPrisma({
      customFindFirst: () => CUSTOM_ROW,
    });
    const res = await runStrategyScan("u1", "cs_1", undefined, {
      prisma,
      publishStrategyScanJob: publish,
    });
    assert.deepEqual(res, {
      success: false,
      error: "Failed to run strategy: pubsub down",
    });
    // Pins today's ordering semantics: the row exists even when publish fails
    // (the client sees a failure and can re-run; the orphan stays PENDING).
    assert.equal(log.filter((c) => c.model === "scanResult").length, 1);
  });
});

describe("strategies.service — scan polling (status / result / history)", () => {
  it("getScanStatus scopes by (id, userId) with a narrow select; miss → 'Scan not found'", async () => {
    const { prisma, log } = fakeStrategiesPrisma({
      scanFindFirst: () => ({
        status: "RUNNING",
        stockCount: 0,
        errorMessage: null,
      }),
    });
    const res = await getScanStatus("u1", "scan_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.status, "RUNNING");
    assert.deepEqual(log[0]!.args, {
      where: { id: "scan_1", userId: "u1" },
      select: { status: true, stockCount: true, errorMessage: true },
    });

    const missPrisma = fakeStrategiesPrisma({ scanFindFirst: () => null });
    const miss = await getScanStatus("u1", "ghost", {
      prisma: missPrisma.prisma,
    });
    assert.deepEqual(miss, {
      success: false,
      error: "Scan not found",
      code: "NOT_FOUND",
    });
  });

  it("getScanResult returns the run with executedAt as an ISO string; miss → not found", async () => {
    const { prisma, log } = fakeStrategiesPrisma({
      scanFindFirst: () => ({
        scanName: "My Momentum",
        stockCount: 2,
        status: "COMPLETED",
        results: [{ symbol: "RELIANCE" }],
        executedAt: new Date("2026-07-10T05:30:00Z"),
      }),
    });
    const res = await getScanResult("u1", "scan_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.executedAt, "2026-07-10T05:30:00.000Z");
      assert.deepEqual(res.data.results, [{ symbol: "RELIANCE" }]);
    }
    assert.deepEqual(log[0]!.args.where, { id: "scan_1", userId: "u1" });

    const missPrisma = fakeStrategiesPrisma({ scanFindFirst: () => null });
    const miss = await getScanResult("u1", "ghost", {
      prisma: missPrisma.prisma,
    });
    assert.deepEqual(miss, {
      success: false,
      error: "Scan not found",
      code: "NOT_FOUND",
    });
  });

  it("getScanHistory lists newest-first, caller-scoped, default take 20 / custom limit", async () => {
    const { prisma, log } = fakeStrategiesPrisma({
      scanFindMany: () => [
        {
          id: "s2",
          scanName: "B",
          stockCount: 1,
          executedAt: new Date("2026-07-10T00:00:00Z"),
        },
      ],
    });
    const res = await getScanHistory("u1", undefined, { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.scans, [
        {
          id: "s2",
          scanName: "B",
          stockCount: 1,
          executedAt: "2026-07-10T00:00:00.000Z",
        },
      ]);
    }
    assert.deepEqual(log[0]!.args.where, { userId: "u1" });
    assert.deepEqual(log[0]!.args.orderBy, { executedAt: "desc" });
    assert.equal(log[0]!.args.take, 20);

    const limited = fakeStrategiesPrisma({ scanFindMany: () => [] });
    await getScanHistory("u1", { limit: 5 }, { prisma: limited.prisma });
    assert.equal(limited.log[0]!.args.take, 5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// saved-screens.service — countFilters + CRUD (injected prisma)
// ════════════════════════════════════════════════════════════════════════════

describe("saved-screens.service — countFilters", () => {
  it("skips limit/null/undefined/blank strings/empty arrays; counts 0, false and real values", () => {
    assert.equal(countFilters({}), 0);
    assert.equal(countFilters({ limit: 50 }), 0);
    assert.equal(countFilters({ a: null, b: undefined }), 0);
    assert.equal(countFilters({ a: "", b: "   " }), 0);
    assert.equal(countFilters({ a: [] }), 0);
    assert.equal(countFilters({ a: 0 }), 1); // numeric 0 IS a real filter value
    assert.equal(countFilters({ a: false }), 1);
    assert.equal(countFilters({ a: "x", b: ["y"], c: 2, limit: 9, d: "" }), 3);
  });
});

/** Fake saved-screens prisma; findFirst answers come from a FIFO queue. */
function fakeSavedScreensPrisma(impls?: {
  upsert?: (args: Record<string, unknown>) => unknown;
  findMany?: (args: Record<string, unknown>) => unknown[];
  findFirstQueue?: Array<unknown>;
  update?: (args: Record<string, unknown>) => unknown;
  deleteMany?: (args: Record<string, unknown>) => unknown;
}): { prisma: SavedScreensServiceDeps["prisma"]; log: PrismaCall[] } {
  const log: PrismaCall[] = [];
  const queue = impls?.findFirstQueue ?? [];
  const prisma = {
    savedScreen: {
      upsert: async (args: Record<string, unknown>) => {
        log.push({ model: "savedScreen", method: "upsert", args });
        if (impls?.upsert) return impls.upsert(args);
        const create = args.create as Record<string, unknown>;
        return {
          id: "ss_1",
          name: create.name,
          mode: create.mode,
          query: create.query,
          filters: create.filters,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-02T00:00:00Z"),
        };
      },
      findMany: async (args: Record<string, unknown>) => {
        log.push({ model: "savedScreen", method: "findMany", args });
        return impls?.findMany ? impls.findMany(args) : [];
      },
      findFirst: async (args: Record<string, unknown>) => {
        log.push({ model: "savedScreen", method: "findFirst", args });
        return queue.length > 0 ? queue.shift() : null;
      },
      update: async (args: Record<string, unknown>) => {
        log.push({ model: "savedScreen", method: "update", args });
        return impls?.update
          ? impls.update(args)
          : {
              id: "ss_1",
              name: (args.data as { name: string }).name,
              mode: "stocks",
              query: null,
              filters: { minPe: 1 },
              createdAt: new Date("2026-07-01T00:00:00Z"),
              updatedAt: new Date("2026-07-03T00:00:00Z"),
            };
      },
      deleteMany: async (args: Record<string, unknown>) => {
        log.push({ model: "savedScreen", method: "deleteMany", args });
        return impls?.deleteMany ? impls.deleteMany(args) : { count: 1 };
      },
    },
  } as unknown as SavedScreensServiceDeps["prisma"];
  return { prisma, log };
}

describe("saved-screens.service — saveScreen (upsert on (userId, mode, name))", () => {
  it("upserts on the composite key; create/update payloads carry filters + normalized query", async () => {
    const { prisma, log } = fakeSavedScreensPrisma();
    const res = await saveScreen(
      "u1",
      { name: "Low PE", mode: "stocks", filters: { minPe: 1, maxPe: 15 } },
      { prisma },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.id, "ss_1");
      assert.equal(res.data.filterCount, 2); // counted from the INPUT filters
      assert.equal(res.data.mode, "stocks");
    }
    const args = log[0]!.args as {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    assert.deepEqual(args.where, {
      userId_mode_name: { userId: "u1", mode: "stocks", name: "Low PE" },
    });
    assert.deepEqual(args.create, {
      userId: "u1",
      mode: "stocks",
      name: "Low PE",
      filters: { minPe: 1, maxPe: 15 },
      query: null, // undefined query normalizes to null
    });
    assert.deepEqual(args.update, {
      filters: { minPe: 1, maxPe: 15 },
      query: null,
    });
  });

  it("a DB throw degrades to the sanitized save failure", async () => {
    const { prisma } = fakeSavedScreensPrisma({
      upsert: () => {
        throw new Error("Mongo down");
      },
    });
    const res = await saveScreen(
      "u1",
      { name: "Low PE", mode: "stocks", filters: {} },
      { prisma },
    );
    assert.deepEqual(res, {
      success: false,
      error: "Failed to save screen",
      code: "INTERNAL",
    });
  });
});

describe("saved-screens.service — listSavedScreens / loadSavedScreen", () => {
  const ROW = {
    id: "ss_1",
    name: "Low PE",
    mode: "stocks",
    query: "pe",
    filters: { minPe: 1, empty: "" },
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-02T00:00:00Z"),
  };

  it("lists caller-scoped, updated-desc, capped at 100; mode narrows; filterCount from row filters", async () => {
    const { prisma, log } = fakeSavedScreensPrisma({ findMany: () => [ROW] });
    const res = await listSavedScreens("u1", undefined, { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.length, 1);
      assert.equal(res.data[0]!.filterCount, 1); // empty-string filter skipped
      assert.equal("filters" in res.data[0]!, false, "summary omits the blob");
    }
    assert.deepEqual(log[0]!.args, {
      where: { userId: "u1" },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    const scoped = fakeSavedScreensPrisma({ findMany: () => [] });
    await listSavedScreens("u1", "mf", { prisma: scoped.prisma });
    assert.deepEqual(scoped.log[0]!.args.where, { userId: "u1", mode: "mf" });
  });

  it("loads one screen ownership-scoped WITH the filter blob; a foreign/ghost id is not-found", async () => {
    const { prisma, log } = fakeSavedScreensPrisma({ findFirstQueue: [ROW] });
    const res = await loadSavedScreen("u1", "ss_1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.filters, { minPe: 1, empty: "" });
      assert.equal(res.data.name, "Low PE");
    }
    assert.deepEqual(log[0]!.args, { where: { id: "ss_1", userId: "u1" } });

    const missPrisma = fakeSavedScreensPrisma();
    const miss = await loadSavedScreen("u1", "ghost", {
      prisma: missPrisma.prisma,
    });
    assert.deepEqual(miss, {
      success: false,
      error: "Screen not found",
      code: "NOT_FOUND",
    });
  });

  it("list/load DB throws degrade to their sanitized messages", async () => {
    const listPrisma = fakeSavedScreensPrisma({
      findMany: () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(
      await listSavedScreens("u1", undefined, { prisma: listPrisma.prisma }),
      {
        success: false,
        error: "Failed to list saved screens",
        code: "INTERNAL",
      },
    );
  });
});

describe("saved-screens.service — renameSavedScreen / deleteSavedScreen", () => {
  const OWNED = {
    id: "ss_1",
    name: "Old",
    mode: "stocks",
    query: null,
    filters: { minPe: 1 },
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-02T00:00:00Z"),
  };

  it("confirms ownership BEFORE updating: a foreign id is not-found with zero writes", async () => {
    const { prisma, log } = fakeSavedScreensPrisma(); // findFirst → null
    const res = await renameSavedScreen(
      "u1",
      { id: "ghost", name: "New" },
      {
        prisma,
      },
    );
    assert.deepEqual(res, {
      success: false,
      error: "Screen not found",
      code: "NOT_FOUND",
    });
    assert.deepEqual(log[0]!.args.where, { id: "ghost", userId: "u1" });
    assert.equal(log.filter((c) => c.method === "update").length, 0);
  });

  it("a same-mode name collision → CONFLICT (409 at the route) with zero writes", async () => {
    const { prisma, log } = fakeSavedScreensPrisma({
      findFirstQueue: [OWNED, { id: "ss_2" }], // ownership hit, then collision hit
    });
    const res = await renameSavedScreen(
      "u1",
      { id: "ss_1", name: "New" },
      {
        prisma,
      },
    );
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.code, "CONFLICT");
      assert.equal(
        res.error,
        'A screen named "New" already exists for this mode',
      );
    }
    // collision probe excludes the row being renamed and pins the SAME mode
    assert.deepEqual(log[1]!.args, {
      where: { userId: "u1", mode: "stocks", name: "New", NOT: { id: "ss_1" } },
      select: { id: true },
    });
    assert.equal(log.filter((c) => c.method === "update").length, 0);
  });

  it("renames when no collision exists and returns the refreshed summary", async () => {
    const { prisma, log } = fakeSavedScreensPrisma({
      findFirstQueue: [OWNED, null],
    });
    const res = await renameSavedScreen(
      "u1",
      { id: "ss_1", name: "New" },
      {
        prisma,
      },
    );
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.name, "New");
    assert.deepEqual(log.find((c) => c.method === "update")!.args, {
      where: { id: "ss_1" },
      data: { name: "New" },
    });
  });

  it("delete uses a SCOPED deleteMany — count 0 (foreign/ghost) is not-found, count 1 succeeds", async () => {
    const missPrisma = fakeSavedScreensPrisma({
      deleteMany: () => ({ count: 0 }),
    });
    const miss = await deleteSavedScreen("u1", "ghost", {
      prisma: missPrisma.prisma,
    });
    assert.deepEqual(miss, {
      success: false,
      error: "Screen not found",
      code: "NOT_FOUND",
    });
    assert.deepEqual(missPrisma.log[0]!.args, {
      where: { id: "ghost", userId: "u1" },
    });

    const { prisma } = fakeSavedScreensPrisma();
    const ok = await deleteSavedScreen("u1", "ss_1", { prisma });
    assert.deepEqual(ok, { success: true, data: { id: "ss_1" } });
  });
});
