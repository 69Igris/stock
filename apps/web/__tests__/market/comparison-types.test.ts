/**
 * Fund Comparison Types & InstrumentSearch Logic Tests
 *
 * Part 1: Validates ComparableFund type structure for MF and ETF funds.
 * Part 2: Re-implements and tests the key logic extracted from InstrumentSearch.tsx:
 *   - handleSelect navigation routing
 *   - URL construction for the search API
 *   - Keyboard navigation state machine
 *   - Explicit search vs dropdown selection behavior
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ============== PART 1: ComparableFund Types ==============

interface ComparableFund {
  id: string;
  fundType: "MF" | "ETF";
  name: string;
  issuer: string;
  category: string;
  riskLevel: string | null;
  nav: number;
  navDate: Date | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  aum: number | null;
  expenseRatio: number | null;
  plan: string | null;
  fundManager: string | null;
  crisilRating: string | null;
  volatility: string | null;
  exchange: string | null;
  changePercent: number | null;
}

function createMockMF(overrides?: Partial<ComparableFund>): ComparableFund {
  return {
    id: "119551",
    fundType: "MF",
    name: "SBI Bluechip Fund - Regular Plan - Growth",
    issuer: "SBI Mutual Fund",
    category: "Equity - Large Cap",
    riskLevel: "Moderately High",
    nav: 82.35,
    navDate: new Date("2026-01-30"),
    returns1Y: 15.2,
    returns3Y: 12.8,
    returns5Y: 14.5,
    aum: 42000,
    expenseRatio: 1.55,
    plan: "Regular",
    fundManager: "Sohini Andani",
    crisilRating: "4 Star",
    volatility: "Moderate",
    exchange: null,
    changePercent: null,
    ...overrides,
  };
}

function createMockETF(overrides?: Partial<ComparableFund>): ComparableFund {
  return {
    id: "NIFTYBEES",
    fundType: "ETF",
    name: "Nippon India ETF Nifty BeES",
    issuer: "Nippon India ETF Nifty BeES",
    category: "ETF",
    riskLevel: null,
    nav: 255.4,
    navDate: new Date("2026-01-30"),
    returns1Y: null,
    returns3Y: null,
    returns5Y: null,
    aum: null,
    expenseRatio: null,
    plan: null,
    fundManager: null,
    crisilRating: null,
    volatility: null,
    exchange: "NSE",
    changePercent: 0.85,
    ...overrides,
  };
}

function isValidComparableFund(obj: unknown): obj is ComparableFund {
  if (typeof obj !== "object" || obj === null) return false;
  const fund = obj as Record<string, unknown>;

  if (typeof fund.id !== "string" || fund.id.length === 0) return false;
  if (fund.fundType !== "MF" && fund.fundType !== "ETF") return false;
  if (typeof fund.name !== "string" || fund.name.length === 0) return false;
  if (typeof fund.issuer !== "string") return false;
  if (typeof fund.category !== "string") return false;
  if (fund.riskLevel !== null && typeof fund.riskLevel !== "string")
    return false;
  if (typeof fund.nav !== "number" || isNaN(fund.nav)) return false;
  if (fund.navDate !== null && !(fund.navDate instanceof Date)) return false;
  if (fund.returns1Y !== null && typeof fund.returns1Y !== "number")
    return false;
  if (fund.returns3Y !== null && typeof fund.returns3Y !== "number")
    return false;
  if (fund.returns5Y !== null && typeof fund.returns5Y !== "number")
    return false;
  if (fund.aum !== null && typeof fund.aum !== "number") return false;
  if (fund.expenseRatio !== null && typeof fund.expenseRatio !== "number")
    return false;
  if (fund.plan !== null && typeof fund.plan !== "string") return false;
  if (fund.fundManager !== null && typeof fund.fundManager !== "string")
    return false;
  if (fund.crisilRating !== null && typeof fund.crisilRating !== "string")
    return false;
  if (fund.volatility !== null && typeof fund.volatility !== "string")
    return false;
  if (fund.exchange !== null && typeof fund.exchange !== "string") return false;
  if (fund.changePercent !== null && typeof fund.changePercent !== "number")
    return false;

  return true;
}

describe("ComparableFund Type Validation", () => {
  describe("MF fund creation", () => {
    it("should create a valid MF fund with all required fields", () => {
      const fund = createMockMF();
      assert.strictEqual(fund.fundType, "MF");
      assert.strictEqual(typeof fund.id, "string");
      assert.strictEqual(typeof fund.name, "string");
      assert.strictEqual(typeof fund.issuer, "string");
      assert.strictEqual(typeof fund.category, "string");
      assert.strictEqual(typeof fund.nav, "number");
    });

    it("should pass validation for a complete MF fund", () => {
      const fund = createMockMF();
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should have MF-specific fields populated", () => {
      const fund = createMockMF();
      assert.strictEqual(fund.plan, "Regular");
      assert.strictEqual(fund.fundManager, "Sohini Andani");
      assert.strictEqual(fund.crisilRating, "4 Star");
      assert.strictEqual(fund.volatility, "Moderate");
    });

    it("should have ETF-specific fields as null for MF", () => {
      const fund = createMockMF();
      assert.strictEqual(fund.exchange, null);
      assert.strictEqual(fund.changePercent, null);
    });

    it("should have populated returns for MF", () => {
      const fund = createMockMF();
      assert.strictEqual(fund.returns1Y, 15.2);
      assert.strictEqual(fund.returns3Y, 12.8);
      assert.strictEqual(fund.returns5Y, 14.5);
    });

    it("should have aum and expense ratio for MF", () => {
      const fund = createMockMF();
      assert.strictEqual(fund.aum, 42000);
      assert.strictEqual(fund.expenseRatio, 1.55);
    });
  });

  describe("ETF fund creation", () => {
    it("should create a valid ETF fund with all required fields", () => {
      const fund = createMockETF();
      assert.strictEqual(fund.fundType, "ETF");
      assert.strictEqual(typeof fund.id, "string");
      assert.strictEqual(typeof fund.name, "string");
      assert.strictEqual(typeof fund.issuer, "string");
      assert.strictEqual(typeof fund.category, "string");
      assert.strictEqual(typeof fund.nav, "number");
    });

    it("should pass validation for a complete ETF fund", () => {
      const fund = createMockETF();
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should have ETF-specific fields populated", () => {
      const fund = createMockETF();
      assert.strictEqual(fund.exchange, "NSE");
      assert.strictEqual(fund.changePercent, 0.85);
    });

    it("should have MF-specific fields as null for ETF", () => {
      const fund = createMockETF();
      assert.strictEqual(fund.plan, null);
      assert.strictEqual(fund.fundManager, null);
      assert.strictEqual(fund.crisilRating, null);
      assert.strictEqual(fund.volatility, null);
    });

    it("should have null returns for ETF (from latest quote only)", () => {
      const fund = createMockETF();
      assert.strictEqual(fund.returns1Y, null);
      assert.strictEqual(fund.returns3Y, null);
      assert.strictEqual(fund.returns5Y, null);
    });

    it("should have null aum and expense ratio for ETF", () => {
      const fund = createMockETF();
      assert.strictEqual(fund.aum, null);
      assert.strictEqual(fund.expenseRatio, null);
    });
  });

  describe("Nullable fields", () => {
    it("should accept null for all nullable fields on MF", () => {
      const fund = createMockMF({
        riskLevel: null,
        navDate: null,
        returns1Y: null,
        returns3Y: null,
        returns5Y: null,
        aum: null,
        expenseRatio: null,
        plan: null,
        fundManager: null,
        crisilRating: null,
        volatility: null,
        exchange: null,
        changePercent: null,
      });
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept null for all nullable fields on ETF", () => {
      const fund = createMockETF({
        riskLevel: null,
        navDate: null,
        returns1Y: null,
        returns3Y: null,
        returns5Y: null,
        aum: null,
        expenseRatio: null,
        plan: null,
        fundManager: null,
        crisilRating: null,
        volatility: null,
        exchange: null,
        changePercent: null,
      });
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept navDate as null", () => {
      const fund = createMockMF({ navDate: null });
      assert.strictEqual(fund.navDate, null);
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept riskLevel as null", () => {
      const fund = createMockMF({ riskLevel: null });
      assert.strictEqual(fund.riskLevel, null);
      assert.strictEqual(isValidComparableFund(fund), true);
    });
  });

  describe("nav must be a number", () => {
    it("should accept zero as nav", () => {
      const fund = createMockETF({ nav: 0 });
      assert.strictEqual(fund.nav, 0);
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept decimal nav values", () => {
      const fund = createMockMF({ nav: 123.4567 });
      assert.strictEqual(fund.nav, 123.4567);
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept large nav values", () => {
      const fund = createMockETF({ nav: 99999.99 });
      assert.strictEqual(typeof fund.nav, "number");
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should reject NaN nav via validator", () => {
      const fund = createMockMF({ nav: NaN });
      assert.strictEqual(isValidComparableFund(fund), false);
    });
  });

  describe("Returns fields can be negative", () => {
    it("should accept negative returns1Y", () => {
      const fund = createMockMF({ returns1Y: -5.3 });
      assert.strictEqual(fund.returns1Y, -5.3);
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept negative returns3Y", () => {
      const fund = createMockMF({ returns3Y: -2.1 });
      assert.strictEqual(fund.returns3Y, -2.1);
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept negative returns5Y", () => {
      const fund = createMockMF({ returns5Y: -8.9 });
      assert.strictEqual(fund.returns5Y, -8.9);
      assert.strictEqual(isValidComparableFund(fund), true);
    });

    it("should accept zero returns", () => {
      const fund = createMockMF({
        returns1Y: 0,
        returns3Y: 0,
        returns5Y: 0,
      });
      assert.strictEqual(fund.returns1Y, 0);
      assert.strictEqual(fund.returns3Y, 0);
      assert.strictEqual(fund.returns5Y, 0);
    });

    it("should accept mixed positive and negative returns", () => {
      const fund = createMockMF({
        returns1Y: -3.5,
        returns3Y: 7.2,
        returns5Y: -1.0,
      });
      assert.ok(fund.returns1Y! < 0);
      assert.ok(fund.returns3Y! > 0);
      assert.ok(fund.returns5Y! < 0);
    });
  });

  describe("Multiple funds in array (for comparison)", () => {
    it("should support an array of 2 comparable funds", () => {
      const funds: ComparableFund[] = [createMockMF(), createMockETF()];
      assert.strictEqual(funds.length, 2);
      assert.strictEqual(funds[0].fundType, "MF");
      assert.strictEqual(funds[1].fundType, "ETF");
    });

    it("should support an array of 4 comparable funds", () => {
      const funds: ComparableFund[] = [
        createMockMF({ id: "119551", name: "SBI Bluechip" }),
        createMockMF({ id: "120503", name: "HDFC Top 100" }),
        createMockETF({ id: "NIFTYBEES", name: "Nifty BeES" }),
        createMockETF({ id: "GOLDBEES", name: "Gold BeES" }),
      ];
      assert.strictEqual(funds.length, 4);
    });

    it("should allow comparing funds by returns", () => {
      const funds: ComparableFund[] = [
        createMockMF({ returns1Y: 15.2 }),
        createMockMF({ returns1Y: 12.3 }),
        createMockMF({ returns1Y: 18.7 }),
      ];

      const best = funds.reduce((a, b) =>
        (a.returns1Y ?? -Infinity) > (b.returns1Y ?? -Infinity) ? a : b
      );
      assert.strictEqual(best.returns1Y, 18.7);
    });

    it("should allow filtering by fund type", () => {
      const funds: ComparableFund[] = [
        createMockMF(),
        createMockETF(),
        createMockMF({ id: "120503" }),
      ];

      const mfs = funds.filter((f) => f.fundType === "MF");
      const etfs = funds.filter((f) => f.fundType === "ETF");
      assert.strictEqual(mfs.length, 2);
      assert.strictEqual(etfs.length, 1);
    });

    it("should handle empty comparison array", () => {
      const funds: ComparableFund[] = [];
      assert.strictEqual(funds.length, 0);
    });
  });

  describe("Validation edge cases", () => {
    it("should reject null as a fund", () => {
      assert.strictEqual(isValidComparableFund(null), false);
    });

    it("should reject undefined as a fund", () => {
      assert.strictEqual(isValidComparableFund(undefined), false);
    });

    it("should reject empty object as a fund", () => {
      assert.strictEqual(isValidComparableFund({}), false);
    });

    it("should reject object with invalid fundType", () => {
      const bad = { ...createMockMF(), fundType: "STOCK" };
      assert.strictEqual(isValidComparableFund(bad), false);
    });

    it("should reject object with empty id", () => {
      const bad = { ...createMockMF(), id: "" };
      assert.strictEqual(isValidComparableFund(bad), false);
    });

    it("should reject object with empty name", () => {
      const bad = { ...createMockMF(), name: "" };
      assert.strictEqual(isValidComparableFund(bad), false);
    });
  });
});

// ============== PART 2: InstrumentSearch Logic ==============

interface InstrumentSearchItem {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
  instrumentId?: string;
  sector?: string | null;
  instrumentType?: string;
}

/**
 * Re-implementation of handleSelect navigation logic from InstrumentSearch.tsx.
 * Returns the path that the router would navigate to.
 */
function getNavigationPath(item: InstrumentSearchItem): string {
  if (item.type === "MF" || item.instrumentType === "MF") {
    return `/mf/${item.symbol}`;
  } else if (item.type === "INDEX") {
    return `/stock/${item.symbol}?exchange=${item.exchange}&type=index`;
  } else {
    return `/stock/${item.symbol}?exchange=${item.exchange}`;
  }
}

/**
 * Re-implementation of URL construction logic from InstrumentSearch.tsx fetchResults.
 */
function buildSearchUrl(options: {
  query: string;
  limit?: number;
  includeIndices?: boolean;
  filterTypes?: string[];
}): string {
  const { query, limit = 15, includeIndices = true, filterTypes } = options;

  const params = new URLSearchParams({
    limit: limit.toString(),
    includeIndices: includeIndices.toString(),
  });

  if (query.trim()) {
    params.set("q", query.trim());
  }

  if (filterTypes?.length) {
    params.set("types", filterTypes.join(","));
  }

  return `/api/market/search?${params}`;
}

/**
 * Re-implementation of keyboard navigation state machine from InstrumentSearch.tsx.
 */
interface KeyboardNavState {
  isOpen: boolean;
  highlightedIndex: number;
  resultsLength: number;
}

type KeyboardAction =
  | "select_highlighted"
  | "explicit_search"
  | "close"
  | "arrow_down"
  | "arrow_up"
  | "noop";

function handleKeyDown(
  key: string,
  state: KeyboardNavState
): { action: KeyboardAction; newHighlightedIndex: number } {
  if (key === "Enter") {
    if (
      state.isOpen &&
      state.highlightedIndex >= 0 &&
      state.highlightedIndex < state.resultsLength
    ) {
      return {
        action: "select_highlighted",
        newHighlightedIndex: state.highlightedIndex,
      };
    } else {
      return {
        action: "explicit_search",
        newHighlightedIndex: state.highlightedIndex,
      };
    }
  }

  if (key === "Escape") {
    return { action: "close", newHighlightedIndex: state.highlightedIndex };
  }

  if (!state.isOpen || state.resultsLength === 0) {
    return { action: "noop", newHighlightedIndex: state.highlightedIndex };
  }

  if (key === "ArrowDown") {
    const next =
      state.highlightedIndex < state.resultsLength - 1
        ? state.highlightedIndex + 1
        : 0;
    return { action: "arrow_down", newHighlightedIndex: next };
  }

  if (key === "ArrowUp") {
    const next =
      state.highlightedIndex > 0
        ? state.highlightedIndex - 1
        : state.resultsLength - 1;
    return { action: "arrow_up", newHighlightedIndex: next };
  }

  return { action: "noop", newHighlightedIndex: state.highlightedIndex };
}

/**
 * Re-implementation of explicit search logic from InstrumentSearch.tsx.
 */
function shouldTriggerExplicitSearch(
  hasOnSearch: boolean,
  query: string
): boolean {
  return hasOnSearch && query.trim().length > 0;
}

/**
 * Re-implementation of clear button logic from InstrumentSearch.tsx.
 */
function handleClear(hasOnSearch: boolean): {
  newQuery: string;
  shouldCallOnSearch: boolean;
  searchArgs: { results: InstrumentSearchItem[]; query: string };
} {
  return {
    newQuery: "",
    shouldCallOnSearch: hasOnSearch,
    searchArgs: { results: [], query: "" },
  };
}

// ============== Tests ==============

describe("InstrumentSearch Logic", () => {
  describe("handleSelect navigation", () => {
    it("should navigate to /mf/{symbol} for type=MF", () => {
      const item: InstrumentSearchItem = {
        symbol: "119551",
        name: "SBI Bluechip Fund",
        exchange: "MF",
        type: "MF",
        yahooSymbol: "",
      };
      assert.strictEqual(getNavigationPath(item), "/mf/119551");
    });

    it("should navigate to /mf/{symbol} for instrumentType=MF", () => {
      const item: InstrumentSearchItem = {
        symbol: "120503",
        name: "HDFC Top 100 Fund",
        exchange: "MF",
        type: "EQUITY",
        yahooSymbol: "",
        instrumentType: "MF",
      };
      assert.strictEqual(getNavigationPath(item), "/mf/120503");
    });

    it("should prefer type=MF over instrumentType check", () => {
      const item: InstrumentSearchItem = {
        symbol: "119551",
        name: "SBI Bluechip Fund",
        exchange: "MF",
        type: "MF",
        yahooSymbol: "",
        instrumentType: "EQUITY",
      };
      assert.strictEqual(getNavigationPath(item), "/mf/119551");
    });

    it("should navigate to /stock/{symbol}?exchange={exchange}&type=index for INDEX", () => {
      const item: InstrumentSearchItem = {
        symbol: "NIFTY 50",
        name: "Nifty 50 Index",
        exchange: "NSE",
        type: "INDEX",
        yahooSymbol: "^NSEI",
      };
      assert.strictEqual(
        getNavigationPath(item),
        "/stock/NIFTY 50?exchange=NSE&type=index"
      );
    });

    it("should navigate to /stock/{symbol}?exchange={exchange} for EQUITY", () => {
      const item: InstrumentSearchItem = {
        symbol: "RELIANCE",
        name: "Reliance Industries Ltd",
        exchange: "NSE",
        type: "EQUITY",
        yahooSymbol: "RELIANCE.NS",
      };
      assert.strictEqual(
        getNavigationPath(item),
        "/stock/RELIANCE?exchange=NSE"
      );
    });

    it("should navigate to /stock/{symbol}?exchange={exchange} for ETF", () => {
      const item: InstrumentSearchItem = {
        symbol: "NIFTYBEES",
        name: "Nippon India ETF Nifty BeES",
        exchange: "NSE",
        type: "ETF",
        yahooSymbol: "NIFTYBEES.NS",
      };
      assert.strictEqual(
        getNavigationPath(item),
        "/stock/NIFTYBEES?exchange=NSE"
      );
    });

    it("should handle BSE exchange correctly", () => {
      const item: InstrumentSearchItem = {
        symbol: "RELIANCE",
        name: "Reliance Industries Ltd",
        exchange: "BSE",
        type: "EQUITY",
        yahooSymbol: "RELIANCE.BO",
      };
      assert.strictEqual(
        getNavigationPath(item),
        "/stock/RELIANCE?exchange=BSE"
      );
    });

    it("should handle unknown type as stock", () => {
      const item: InstrumentSearchItem = {
        symbol: "AAPL",
        name: "Apple Inc",
        exchange: "NASDAQ",
        type: "UNKNOWN",
        yahooSymbol: "AAPL",
      };
      assert.strictEqual(
        getNavigationPath(item),
        "/stock/AAPL?exchange=NASDAQ"
      );
    });
  });

  describe("URL construction", () => {
    it("should build base URL with default params", () => {
      const url = buildSearchUrl({ query: "HDFC" });
      assert.ok(url.includes("/api/market/search?"));
      assert.ok(url.includes("limit=15"));
      assert.ok(url.includes("includeIndices=true"));
      assert.ok(url.includes("q=HDFC"));
    });

    it("should include query parameter for non-empty query", () => {
      const url = buildSearchUrl({ query: "HDFC" });
      assert.ok(url.includes("q=HDFC"));
    });

    it("should omit q parameter for empty query", () => {
      const url = buildSearchUrl({ query: "" });
      assert.ok(!url.includes("q="));
    });

    it("should omit q parameter for whitespace-only query", () => {
      const url = buildSearchUrl({ query: "   " });
      assert.ok(!url.includes("q="));
    });

    it("should trim whitespace from query", () => {
      const url = buildSearchUrl({ query: "  HDFC  " });
      assert.ok(url.includes("q=HDFC"));
      assert.ok(!url.includes("q=+"));
    });

    it("should add filterTypes when provided", () => {
      const url = buildSearchUrl({ query: "test", filterTypes: ["MF", "ETF"] });
      assert.ok(url.includes("types=MF%2CETF") || url.includes("types=MF,ETF"));
    });

    it("should not add types param when filterTypes is empty", () => {
      const url = buildSearchUrl({ query: "test", filterTypes: [] });
      assert.ok(!url.includes("types="));
    });

    it("should not add types param when filterTypes is undefined", () => {
      const url = buildSearchUrl({ query: "test" });
      assert.ok(!url.includes("types="));
    });

    it("should use custom limit", () => {
      const url = buildSearchUrl({ query: "test", limit: 10 });
      assert.ok(url.includes("limit=10"));
    });

    it("should use custom includeIndices=false", () => {
      const url = buildSearchUrl({
        query: "test",
        includeIndices: false,
      });
      assert.ok(url.includes("includeIndices=false"));
    });

    it("should handle single filterType", () => {
      const url = buildSearchUrl({ query: "test", filterTypes: ["EQUITY"] });
      assert.ok(url.includes("types=EQUITY"));
    });

    it("should handle combined options", () => {
      const url = buildSearchUrl({
        query: "HDFC",
        limit: 20,
        includeIndices: false,
        filterTypes: ["MF"],
      });
      assert.ok(url.includes("limit=20"));
      assert.ok(url.includes("includeIndices=false"));
      assert.ok(url.includes("q=HDFC"));
      assert.ok(url.includes("types=MF"));
    });
  });

  describe("Keyboard navigation", () => {
    it("should select highlighted item on Enter", () => {
      const result = handleKeyDown("Enter", {
        isOpen: true,
        highlightedIndex: 2,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "select_highlighted");
      assert.strictEqual(result.newHighlightedIndex, 2);
    });

    it("should trigger explicit search on Enter with no highlight", () => {
      const result = handleKeyDown("Enter", {
        isOpen: true,
        highlightedIndex: -1,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "explicit_search");
    });

    it("should trigger explicit search on Enter when dropdown is closed", () => {
      const result = handleKeyDown("Enter", {
        isOpen: false,
        highlightedIndex: -1,
        resultsLength: 0,
      });
      assert.strictEqual(result.action, "explicit_search");
    });

    it("should close on Escape", () => {
      const result = handleKeyDown("Escape", {
        isOpen: true,
        highlightedIndex: 3,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "close");
    });

    it("should close on Escape even when dropdown is already closed", () => {
      const result = handleKeyDown("Escape", {
        isOpen: false,
        highlightedIndex: -1,
        resultsLength: 0,
      });
      assert.strictEqual(result.action, "close");
    });

    it("should increment index on ArrowDown", () => {
      const result = handleKeyDown("ArrowDown", {
        isOpen: true,
        highlightedIndex: 1,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "arrow_down");
      assert.strictEqual(result.newHighlightedIndex, 2);
    });

    it("should wrap around on ArrowDown at last item", () => {
      const result = handleKeyDown("ArrowDown", {
        isOpen: true,
        highlightedIndex: 4,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "arrow_down");
      assert.strictEqual(result.newHighlightedIndex, 0);
    });

    it("should move from -1 to 0 on ArrowDown", () => {
      const result = handleKeyDown("ArrowDown", {
        isOpen: true,
        highlightedIndex: -1,
        resultsLength: 5,
      });
      assert.strictEqual(result.newHighlightedIndex, 0);
    });

    it("should decrement index on ArrowUp", () => {
      const result = handleKeyDown("ArrowUp", {
        isOpen: true,
        highlightedIndex: 3,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "arrow_up");
      assert.strictEqual(result.newHighlightedIndex, 2);
    });

    it("should wrap around on ArrowUp at first item", () => {
      const result = handleKeyDown("ArrowUp", {
        isOpen: true,
        highlightedIndex: 0,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "arrow_up");
      assert.strictEqual(result.newHighlightedIndex, 4);
    });

    it("should noop for ArrowDown when dropdown is closed", () => {
      const result = handleKeyDown("ArrowDown", {
        isOpen: false,
        highlightedIndex: -1,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "noop");
    });

    it("should noop for ArrowUp when dropdown is closed", () => {
      const result = handleKeyDown("ArrowUp", {
        isOpen: false,
        highlightedIndex: -1,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "noop");
    });

    it("should noop for ArrowDown when results are empty", () => {
      const result = handleKeyDown("ArrowDown", {
        isOpen: true,
        highlightedIndex: -1,
        resultsLength: 0,
      });
      assert.strictEqual(result.action, "noop");
    });

    it("should noop for ArrowUp when results are empty", () => {
      const result = handleKeyDown("ArrowUp", {
        isOpen: true,
        highlightedIndex: -1,
        resultsLength: 0,
      });
      assert.strictEqual(result.action, "noop");
    });

    it("should noop for unrecognized keys", () => {
      const result = handleKeyDown("Tab", {
        isOpen: true,
        highlightedIndex: 0,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "noop");
    });

    it("should noop for letter keys", () => {
      const result = handleKeyDown("a", {
        isOpen: true,
        highlightedIndex: 0,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "noop");
    });

    it("should handle single-item list ArrowDown (wraps to 0)", () => {
      const result = handleKeyDown("ArrowDown", {
        isOpen: true,
        highlightedIndex: 0,
        resultsLength: 1,
      });
      assert.strictEqual(result.newHighlightedIndex, 0);
    });

    it("should handle single-item list ArrowUp (wraps to 0)", () => {
      const result = handleKeyDown("ArrowUp", {
        isOpen: true,
        highlightedIndex: 0,
        resultsLength: 1,
      });
      assert.strictEqual(result.newHighlightedIndex, 0);
    });

    it("should handle Enter with highlightedIndex beyond results length", () => {
      const result = handleKeyDown("Enter", {
        isOpen: true,
        highlightedIndex: 10,
        resultsLength: 5,
      });
      assert.strictEqual(result.action, "explicit_search");
    });
  });

  describe("Explicit search vs dropdown behavior", () => {
    it("should trigger explicit search when onSearch exists and query is non-empty", () => {
      assert.strictEqual(shouldTriggerExplicitSearch(true, "HDFC"), true);
    });

    it("should not trigger explicit search when onSearch is absent", () => {
      assert.strictEqual(shouldTriggerExplicitSearch(false, "HDFC"), false);
    });

    it("should not trigger explicit search when query is empty", () => {
      assert.strictEqual(shouldTriggerExplicitSearch(true, ""), false);
    });

    it("should not trigger explicit search when query is whitespace", () => {
      assert.strictEqual(shouldTriggerExplicitSearch(true, "   "), false);
    });

    it("should trigger explicit search with trimmed single-char query", () => {
      assert.strictEqual(shouldTriggerExplicitSearch(true, "A"), true);
    });
  });

  describe("Clear button behavior", () => {
    it("should reset query to empty string", () => {
      const result = handleClear(true);
      assert.strictEqual(result.newQuery, "");
    });

    it("should call onSearch with empty results and empty query when onSearch exists", () => {
      const result = handleClear(true);
      assert.strictEqual(result.shouldCallOnSearch, true);
      assert.deepStrictEqual(result.searchArgs.results, []);
      assert.strictEqual(result.searchArgs.query, "");
    });

    it("should not call onSearch when onSearch does not exist", () => {
      const result = handleClear(false);
      assert.strictEqual(result.shouldCallOnSearch, false);
    });
  });

  describe("InstrumentSearchItem type structure", () => {
    it("should support full item with all fields", () => {
      const item: InstrumentSearchItem = {
        symbol: "RELIANCE",
        name: "Reliance Industries Ltd",
        exchange: "NSE",
        type: "EQUITY",
        yahooSymbol: "RELIANCE.NS",
        instrumentId: "inst_123",
        sector: "Oil & Gas",
        instrumentType: "EQUITY",
      };
      assert.strictEqual(item.symbol, "RELIANCE");
      assert.strictEqual(item.sector, "Oil & Gas");
      assert.strictEqual(item.instrumentId, "inst_123");
      assert.strictEqual(item.instrumentType, "EQUITY");
    });

    it("should support item without optional fields", () => {
      const item: InstrumentSearchItem = {
        symbol: "TCS",
        name: "Tata Consultancy Services Ltd",
        exchange: "NSE",
        type: "EQUITY",
        yahooSymbol: "TCS.NS",
      };
      assert.strictEqual(item.instrumentId, undefined);
      assert.strictEqual(item.sector, undefined);
      assert.strictEqual(item.instrumentType, undefined);
    });

    it("should support null sector", () => {
      const item: InstrumentSearchItem = {
        symbol: "GOLDM",
        name: "Gold Mining ETF",
        exchange: "NSE",
        type: "ETF",
        yahooSymbol: "GOLDM.NS",
        sector: null,
      };
      assert.strictEqual(item.sector, null);
    });

    it("should support INDEX type item", () => {
      const item: InstrumentSearchItem = {
        symbol: "NIFTY 50",
        name: "Nifty 50 Index",
        exchange: "NSE",
        type: "INDEX",
        yahooSymbol: "^NSEI",
      };
      assert.strictEqual(item.type, "INDEX");
    });

    it("should support MF type item", () => {
      const item: InstrumentSearchItem = {
        symbol: "119551",
        name: "SBI Bluechip Fund",
        exchange: "MF",
        type: "MF",
        yahooSymbol: "",
      };
      assert.strictEqual(item.type, "MF");
    });
  });

  describe("Full keyboard navigation flow simulation", () => {
    it("should navigate down through 3 items and wrap", () => {
      let state: KeyboardNavState = {
        isOpen: true,
        highlightedIndex: -1,
        resultsLength: 3,
      };

      // First ArrowDown: -1 -> 0
      let result = handleKeyDown("ArrowDown", state);
      assert.strictEqual(result.newHighlightedIndex, 0);
      state = { ...state, highlightedIndex: result.newHighlightedIndex };

      // Second ArrowDown: 0 -> 1
      result = handleKeyDown("ArrowDown", state);
      assert.strictEqual(result.newHighlightedIndex, 1);
      state = { ...state, highlightedIndex: result.newHighlightedIndex };

      // Third ArrowDown: 1 -> 2
      result = handleKeyDown("ArrowDown", state);
      assert.strictEqual(result.newHighlightedIndex, 2);
      state = { ...state, highlightedIndex: result.newHighlightedIndex };

      // Fourth ArrowDown: 2 -> 0 (wrap)
      result = handleKeyDown("ArrowDown", state);
      assert.strictEqual(result.newHighlightedIndex, 0);
    });

    it("should navigate up through 3 items and wrap", () => {
      let state: KeyboardNavState = {
        isOpen: true,
        highlightedIndex: 2,
        resultsLength: 3,
      };

      // First ArrowUp: 2 -> 1
      let result = handleKeyDown("ArrowUp", state);
      assert.strictEqual(result.newHighlightedIndex, 1);
      state = { ...state, highlightedIndex: result.newHighlightedIndex };

      // Second ArrowUp: 1 -> 0
      result = handleKeyDown("ArrowUp", state);
      assert.strictEqual(result.newHighlightedIndex, 0);
      state = { ...state, highlightedIndex: result.newHighlightedIndex };

      // Third ArrowUp: 0 -> 2 (wrap)
      result = handleKeyDown("ArrowUp", state);
      assert.strictEqual(result.newHighlightedIndex, 2);
    });

    it("should navigate down, then select with Enter", () => {
      let state: KeyboardNavState = {
        isOpen: true,
        highlightedIndex: -1,
        resultsLength: 5,
      };

      // Navigate to index 2
      for (let i = 0; i < 3; i++) {
        const result = handleKeyDown("ArrowDown", state);
        state = { ...state, highlightedIndex: result.newHighlightedIndex };
      }
      assert.strictEqual(state.highlightedIndex, 2);

      // Press Enter to select
      const result = handleKeyDown("Enter", state);
      assert.strictEqual(result.action, "select_highlighted");
      assert.strictEqual(result.newHighlightedIndex, 2);
    });

    it("should close and then noop on arrow keys", () => {
      let state: KeyboardNavState = {
        isOpen: true,
        highlightedIndex: 1,
        resultsLength: 3,
      };

      // Close
      const closeResult = handleKeyDown("Escape", state);
      assert.strictEqual(closeResult.action, "close");
      state = { ...state, isOpen: false };

      // Arrow keys should noop
      const downResult = handleKeyDown("ArrowDown", state);
      assert.strictEqual(downResult.action, "noop");

      const upResult = handleKeyDown("ArrowUp", state);
      assert.strictEqual(upResult.action, "noop");
    });
  });
});
