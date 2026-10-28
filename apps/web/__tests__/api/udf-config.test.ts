/**
 * TradingView UDF Config Endpoint - REAL config tests.
 *
 * Asserts the ACTUAL `UDF_CONFIG` constant the GET /api/market/udf/config
 * handler returns (from `@/app/api/market/udf/config/config-logic`). The route
 * returns this object verbatim.
 *
 * (Replaces the previous SHADOW version, which re-declared the entire config
 * object inline and asserted the copy. The config now lives in a single
 * exported constant the route imports, so this guards the real payload.)
 *
 * Source: apps/web/app/api/market/udf/config/route.ts
 *         apps/web/app/api/market/udf/config/config-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UDF_CONFIG } from "@/app/api/market/udf/config/config-logic";

// ============================================================================
// Tests: Required TradingView Fields
// ============================================================================

describe("UDF Config - Response Shape", () => {
  it("should have all required TradingView fields", () => {
    assert.ok("supports_search" in UDF_CONFIG);
    assert.ok("supports_group_request" in UDF_CONFIG);
    assert.ok("supports_marks" in UDF_CONFIG);
    assert.ok("supports_timescale_marks" in UDF_CONFIG);
    assert.ok("supports_time" in UDF_CONFIG);
    assert.ok("supported_resolutions" in UDF_CONFIG);
    assert.ok("exchanges" in UDF_CONFIG);
    assert.ok("symbols_types" in UDF_CONFIG);
  });

  it("should have exactly 8 top-level keys", () => {
    assert.equal(Object.keys(UDF_CONFIG).length, 8);
  });
});

// ============================================================================
// Tests: Boolean Feature Flags
// ============================================================================

describe("UDF Config - Feature Flags", () => {
  it("supports_search should be true", () => {
    assert.equal(UDF_CONFIG.supports_search, true);
  });

  it("supports_time should be true", () => {
    assert.equal(UDF_CONFIG.supports_time, true);
  });

  it("supports_group_request should be false", () => {
    assert.equal(UDF_CONFIG.supports_group_request, false);
  });

  it("supports_marks is true — /marks is implemented (MONEY-1176)", () => {
    // Flipping this without shipping the route makes the widget request an
    // endpoint that 404s on every chart load, so the two must move together.
    assert.equal(UDF_CONFIG.supports_marks, true);
  });

  it("supports_timescale_marks should be false", () => {
    assert.equal(UDF_CONFIG.supports_timescale_marks, false);
  });
});

// ============================================================================
// Tests: Supported Resolutions
// ============================================================================

describe("UDF Config - Supported Resolutions", () => {
  it("should contain minute resolution 1", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("1"));
  });

  it("should contain minute resolution 5", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("5"));
  });

  it("should contain minute resolution 15", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("15"));
  });

  it("should contain minute resolution 30", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("30"));
  });

  it("should contain hourly resolution 60", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("60"));
  });

  it("should contain daily resolution 1D", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("1D"));
  });

  it("should contain weekly resolution 1W", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("1W"));
  });

  it("should contain monthly resolution 1M", () => {
    assert.ok(UDF_CONFIG.supported_resolutions.includes("1M"));
  });

  it("should have 10 total resolutions", () => {
    assert.equal(UDF_CONFIG.supported_resolutions.length, 10);
  });

  it("all resolutions should be strings", () => {
    UDF_CONFIG.supported_resolutions.forEach((r) => {
      assert.equal(typeof r, "string");
    });
  });
});

// ============================================================================
// Tests: Exchanges
// ============================================================================

describe("UDF Config - Exchanges", () => {
  it("should have 4 exchanges", () => {
    assert.equal(UDF_CONFIG.exchanges.length, 4);
  });

  it("should have All Exchanges entry with empty value", () => {
    const all = UDF_CONFIG.exchanges.find((e) => e.name === "All Exchanges");
    assert.ok(all);
    assert.equal(all.value, "");
  });

  it("should have NSE exchange", () => {
    const nse = UDF_CONFIG.exchanges.find((e) => e.value === "NSE");
    assert.ok(nse);
    assert.equal(nse.name, "NSE");
    assert.equal(nse.desc, "National Stock Exchange of India");
  });

  it("should have BSE exchange", () => {
    const bse = UDF_CONFIG.exchanges.find((e) => e.value === "BSE");
    assert.ok(bse);
    assert.equal(bse.name, "BSE");
    assert.equal(bse.desc, "Bombay Stock Exchange");
  });

  it("should have MF exchange", () => {
    const mf = UDF_CONFIG.exchanges.find((e) => e.value === "MF");
    assert.ok(mf);
    assert.equal(mf.name, "MF");
    assert.equal(mf.desc, "Indian Mutual Funds (AMFI)");
  });

  it("each exchange should have value, name, and desc fields", () => {
    UDF_CONFIG.exchanges.forEach((exchange) => {
      assert.ok("value" in exchange);
      assert.ok("name" in exchange);
      assert.ok("desc" in exchange);
      assert.equal(typeof exchange.value, "string");
      assert.equal(typeof exchange.name, "string");
      assert.equal(typeof exchange.desc, "string");
    });
  });
});

// ============================================================================
// Tests: Symbol Types
// ============================================================================

describe("UDF Config - Symbol Types", () => {
  it("should have 6 symbol types", () => {
    // 5 -> 6: "Bond" added on MONEY-1093. DEBT became a distinct
    // instrumentType, and the symbol search previously mapped it to "stock",
    // so a government bond was offered to the user as a share on a trading
    // chart. The count is pinned deliberately — a silently growing list is how
    // a type ends up declared but unmapped, or mapped but undeclared.
    assert.equal(UDF_CONFIG.symbols_types.length, 6);
  });

  it("declares Bond, and it matches what the search endpoint emits", () => {
    const bond = UDF_CONFIG.symbols_types.find((s) => s.name === "Bond");
    assert.ok(bond, "Bond must be declared for the search filter to offer it");
    assert.equal(bond.value, "bond");
  });

  it("should have All type with empty value", () => {
    const all = UDF_CONFIG.symbols_types.find((s) => s.name === "All");
    assert.ok(all);
    assert.equal(all.value, "");
  });

  it("should have Stock type", () => {
    const stock = UDF_CONFIG.symbols_types.find((s) => s.name === "Stock");
    assert.ok(stock);
    assert.equal(stock.value, "stock");
  });

  it("should have ETF type", () => {
    const etf = UDF_CONFIG.symbols_types.find((s) => s.name === "ETF");
    assert.ok(etf);
    assert.equal(etf.value, "etf");
  });

  it("should have Fund type", () => {
    const fund = UDF_CONFIG.symbols_types.find((s) => s.name === "Fund");
    assert.ok(fund);
    assert.equal(fund.value, "fund");
  });

  it("should have Index type", () => {
    const index = UDF_CONFIG.symbols_types.find((s) => s.name === "Index");
    assert.ok(index);
    assert.equal(index.value, "index");
  });

  it("each symbol type should have name and value fields", () => {
    UDF_CONFIG.symbols_types.forEach((symbolType) => {
      assert.ok("name" in symbolType);
      assert.ok("value" in symbolType);
      assert.equal(typeof symbolType.name, "string");
      assert.equal(typeof symbolType.value, "string");
    });
  });
});
