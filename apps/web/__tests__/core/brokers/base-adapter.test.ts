/**
 * Base Broker Adapter Tests
 *
 * Tests the REAL abstract base class:
 *   packages/core/src/brokers/base-adapter.ts → BaseBrokerAdapter
 *
 * A thin concrete subclass (TestAdapter) implements the abstract members with
 * stubs and exposes the protected helpers by calling `super.*`, so the actual
 * production constructor + getBrokerType/getInfo/getEndOfDay/addDays/logApiCall
 * code runs (no inline reimplementation). Console behavior of the real
 * logApiCall is asserted via a console spy.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BaseBrokerAdapter } from "@usemoney/core/brokers";
import type {
  BrokerType,
  BrokerInfo,
  BrokerCredentials,
  AuthResult,
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
  RefreshStrategy,
} from "@usemoney/types";

interface LogEntry {
  method: string;
  endpoint: string;
  status: "success" | "error";
  details?: unknown;
}

/**
 * Concrete subclass over the REAL BaseBrokerAdapter. Abstract members are
 * stubbed; the protected helpers delegate to `super.*` so production code is
 * exercised. `logApiCall` records calls (for bookkeeping assertions) AFTER
 * invoking the real protected method (which only console.logs in development).
 */
class TestAdapter extends BaseBrokerAdapter {
  logCalls: LogEntry[] = [];

  getAuthUrl(): string {
    return "https://example.com/auth";
  }
  async authenticate(): Promise<AuthResult> {
    return { success: true };
  }
  async refreshAccessToken(): Promise<AuthResult> {
    return { success: false };
  }
  async fetchHoldings(_c: BrokerCredentials): Promise<HoldingData[]> {
    return [];
  }
  async fetchPositions(_c: BrokerCredentials): Promise<PositionData[]> {
    return [];
  }
  async fetchOrders(_c: BrokerCredentials): Promise<OrderData[]> {
    return [];
  }
  async fetchTrades(_c: BrokerCredentials): Promise<TradeData[]> {
    return [];
  }
  async fetchMutualFunds(_c: BrokerCredentials): Promise<MutualFundData[]> {
    return [];
  }
  async validateToken(_c: BrokerCredentials): Promise<boolean> {
    return true;
  }
  supportsAutoRefresh(): boolean {
    return this.getInfo().autoRefresh;
  }
  getRefreshStrategy(): RefreshStrategy {
    return "NONE";
  }
  getTokenExpiryDuration(): number {
    return 0;
  }

  // ── expose protected helpers by delegating to the REAL implementations ──
  publicGetEndOfDay(): Date {
    return this.getEndOfDay();
  }
  publicAddDays(days: number): Date {
    return this.addDays(days);
  }
  publicLogApiCall(
    method: string,
    endpoint: string,
    status: "success" | "error",
    details?: unknown
  ): void {
    // Run the REAL protected method (console.logs only in development) …
    this.logApiCall(method, endpoint, status, details);
    // … then record for bookkeeping assertions.
    this.logCalls.push({ method, endpoint, status, details });
  }
}

/**
 * Build a COMPLETE `BrokerInfo` (the real shape the production adapters pass to
 * `super(...)`). Every required field is supplied so the fixture can never
 * assert a shape production does not produce.
 */
function makeBrokerInfo(
  id: BrokerType,
  overrides: Partial<BrokerInfo> = {}
): BrokerInfo {
  return {
    id,
    name: id,
    description: `${id} test broker`,
    color: "#000000",
    segments: ["Equity"],
    features: ["Holdings"],
    cost: "FREE",
    tokenExpiry: "1 day",
    autoRefresh: false,
    mfSupport: false,
    ...overrides,
  };
}

function createZerodhaInfo(): BrokerInfo {
  return makeBrokerInfo("ZERODHA", {
    name: "Zerodha",
    color: "#387ed1",
    autoRefresh: false,
  });
}

function createUpstoxInfo(): BrokerInfo {
  return makeBrokerInfo("UPSTOX", {
    name: "Upstox",
    color: "#7B2D8E",
    autoRefresh: true,
  });
}

describe("Base Broker Adapter (real source)", () => {
  let adapter: TestAdapter;
  let zerodhaInfo: BrokerInfo;

  beforeEach(() => {
    zerodhaInfo = createZerodhaInfo();
    adapter = new TestAdapter("ZERODHA", zerodhaInfo);
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    it("should store broker type", () => {
      assert.equal(adapter.getBrokerType(), "ZERODHA");
    });

    it("should store broker info", () => {
      assert.deepEqual(adapter.getInfo(), zerodhaInfo);
    });

    it("should accept UPSTOX broker type", () => {
      const upstoxAdapter = new TestAdapter("UPSTOX", createUpstoxInfo());
      assert.equal(upstoxAdapter.getBrokerType(), "UPSTOX");
    });

    it("should accept DHAN broker type", () => {
      const info = makeBrokerInfo("DHAN", { name: "Dhan", autoRefresh: true });
      const dhanAdapter = new TestAdapter("DHAN", info);
      assert.equal(dhanAdapter.getBrokerType(), "DHAN");
    });

    it("should accept FYERS broker type", () => {
      const info = makeBrokerInfo("FYERS", { name: "Fyers" });
      const fyersAdapter = new TestAdapter("FYERS", info);
      assert.equal(fyersAdapter.getBrokerType(), "FYERS");
    });

    it("should accept ANGEL_ONE broker type", () => {
      const info = makeBrokerInfo("ANGEL_ONE", {
        name: "Angel One",
        autoRefresh: true,
      });
      const angelAdapter = new TestAdapter("ANGEL_ONE", info);
      assert.equal(angelAdapter.getBrokerType(), "ANGEL_ONE");
    });

    it("should accept GROWW broker type", () => {
      const info = makeBrokerInfo("GROWW", { name: "Groww" });
      const growwAdapter = new TestAdapter("GROWW", info);
      assert.equal(growwAdapter.getBrokerType(), "GROWW");
    });

    it("should store the info object (deep equal)", () => {
      assert.deepEqual(adapter.getInfo(), zerodhaInfo);
    });
  });

  // --------------------------------------------------------------------------
  // getBrokerType
  // --------------------------------------------------------------------------

  describe("getBrokerType", () => {
    it("should return ZERODHA for Zerodha adapter", () => {
      assert.equal(adapter.getBrokerType(), "ZERODHA");
    });

    it("should return UPSTOX for Upstox adapter", () => {
      const upstoxAdapter = new TestAdapter("UPSTOX", createUpstoxInfo());
      assert.equal(upstoxAdapter.getBrokerType(), "UPSTOX");
    });

    it("should return the same value on multiple calls", () => {
      assert.equal(adapter.getBrokerType(), adapter.getBrokerType());
    });

    it("should return a string", () => {
      assert.equal(typeof adapter.getBrokerType(), "string");
    });
  });

  // --------------------------------------------------------------------------
  // getInfo
  // --------------------------------------------------------------------------

  describe("getInfo", () => {
    it("should return the broker info object", () => {
      assert.deepEqual(adapter.getInfo(), zerodhaInfo);
    });

    it("should return info with id field", () => {
      assert.equal(adapter.getInfo().id, "ZERODHA");
    });

    it("should return info with name field", () => {
      assert.equal(adapter.getInfo().name, "Zerodha");
    });

    it("should return info with description field", () => {
      assert.equal(adapter.getInfo().description, "ZERODHA test broker");
    });

    it("should return info with color field", () => {
      assert.equal(adapter.getInfo().color, "#387ed1");
    });

    it("should return info with autoRefresh field", () => {
      assert.equal(adapter.getInfo().autoRefresh, false);
    });

    it("should return the same reference on multiple calls", () => {
      assert.equal(adapter.getInfo(), adapter.getInfo());
    });

    it("should return Upstox info for Upstox adapter", () => {
      const upstoxAdapter = new TestAdapter("UPSTOX", createUpstoxInfo());
      const info = upstoxAdapter.getInfo();
      assert.equal(info.name, "Upstox");
      assert.equal(info.autoRefresh, true);
    });
  });

  // --------------------------------------------------------------------------
  // getEndOfDay (real protected method)
  // --------------------------------------------------------------------------

  describe("getEndOfDay", () => {
    it("should return a Date instance", () => {
      assert.ok(adapter.publicGetEndOfDay() instanceof Date);
    });

    it("should set hours to 23", () => {
      assert.equal(adapter.publicGetEndOfDay().getHours(), 23);
    });

    it("should set minutes to 59", () => {
      assert.equal(adapter.publicGetEndOfDay().getMinutes(), 59);
    });

    it("should set seconds to 59", () => {
      assert.equal(adapter.publicGetEndOfDay().getSeconds(), 59);
    });

    it("should set milliseconds to 999", () => {
      assert.equal(adapter.publicGetEndOfDay().getMilliseconds(), 999);
    });

    it("should return today's date", () => {
      const result = adapter.publicGetEndOfDay();
      const today = new Date();
      assert.equal(result.getFullYear(), today.getFullYear());
      assert.equal(result.getMonth(), today.getMonth());
      assert.equal(result.getDate(), today.getDate());
    });

    it("should return a new Date instance each call", () => {
      assert.notEqual(adapter.publicGetEndOfDay(), adapter.publicGetEndOfDay());
    });

    it("should return end of day regardless of current time", () => {
      const result = adapter.publicGetEndOfDay();
      assert.equal(result.getHours(), 23);
      assert.equal(result.getMinutes(), 59);
      assert.equal(result.getSeconds(), 59);
      assert.equal(result.getMilliseconds(), 999);
    });
  });

  // --------------------------------------------------------------------------
  // addDays (real protected method)
  // --------------------------------------------------------------------------

  describe("addDays", () => {
    it("should return a Date instance", () => {
      assert.ok(adapter.publicAddDays(1) instanceof Date);
    });

    it("should add 1 day correctly", () => {
      const result = adapter.publicAddDays(1);
      const expected = new Date();
      expected.setDate(expected.getDate() + 1);
      assert.equal(result.getDate(), expected.getDate());
    });

    it("should add 7 days correctly", () => {
      const result = adapter.publicAddDays(7);
      const expected = new Date();
      expected.setDate(expected.getDate() + 7);
      assert.equal(result.getDate(), expected.getDate());
      assert.equal(result.getMonth(), expected.getMonth());
    });

    it("should add 30 days correctly", () => {
      const result = adapter.publicAddDays(30);
      const expected = new Date();
      expected.setDate(expected.getDate() + 30);
      assert.equal(result.getFullYear(), expected.getFullYear());
      assert.equal(result.getMonth(), expected.getMonth());
      assert.equal(result.getDate(), expected.getDate());
    });

    it("should subtract days with negative value", () => {
      const result = adapter.publicAddDays(-1);
      const expected = new Date();
      expected.setDate(expected.getDate() - 1);
      assert.equal(result.getDate(), expected.getDate());
    });

    it("should return today for 0 days", () => {
      const result = adapter.publicAddDays(0);
      const today = new Date();
      assert.equal(result.getFullYear(), today.getFullYear());
      assert.equal(result.getMonth(), today.getMonth());
      assert.equal(result.getDate(), today.getDate());
    });

    it("should return a new Date instance each call", () => {
      assert.notEqual(adapter.publicAddDays(1), adapter.publicAddDays(1));
    });

    it("should handle large positive day offsets", () => {
      const result = adapter.publicAddDays(365);
      const expected = new Date();
      expected.setDate(expected.getDate() + 365);
      assert.equal(result.getFullYear(), expected.getFullYear());
    });

    it("should handle large negative day offsets", () => {
      const result = adapter.publicAddDays(-365);
      const expected = new Date();
      expected.setDate(expected.getDate() - 365);
      assert.equal(result.getFullYear(), expected.getFullYear());
    });

    it("should subtract 7 days correctly", () => {
      const result = adapter.publicAddDays(-7);
      const expected = new Date();
      expected.setDate(expected.getDate() - 7);
      assert.equal(result.getDate(), expected.getDate());
    });
  });

  // --------------------------------------------------------------------------
  // logApiCall (real protected method; console behavior asserted via spy)
  // --------------------------------------------------------------------------

  describe("logApiCall", () => {
    const savedNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (savedNodeEnv === undefined) {
        delete (process.env as Record<string, string | undefined>).NODE_ENV;
      } else {
        (process.env as Record<string, string | undefined>).NODE_ENV =
          savedNodeEnv;
      }
    });

    it("should record log call with method", () => {
      adapter.publicLogApiCall("GET", "/holdings", "success");
      assert.equal(adapter.logCalls.length, 1);
      assert.equal(adapter.logCalls[0]!.method, "GET");
    });

    it("should record log call with endpoint", () => {
      adapter.publicLogApiCall("GET", "/holdings", "success");
      assert.equal(adapter.logCalls[0]!.endpoint, "/holdings");
    });

    it("should record log call with success status", () => {
      adapter.publicLogApiCall("GET", "/holdings", "success");
      assert.equal(adapter.logCalls[0]!.status, "success");
    });

    it("should record log call with error status", () => {
      adapter.publicLogApiCall("POST", "/orders", "error");
      assert.equal(adapter.logCalls[0]!.status, "error");
    });

    it("should record log call with details when provided", () => {
      const details = { code: 401, message: "Unauthorized" };
      adapter.publicLogApiCall("GET", "/holdings", "error", details);
      assert.deepEqual(adapter.logCalls[0]!.details, details);
    });

    it("should record log call without details as undefined", () => {
      adapter.publicLogApiCall("GET", "/holdings", "success");
      assert.equal(adapter.logCalls[0]!.details, undefined);
    });

    it("should accumulate multiple log calls", () => {
      adapter.publicLogApiCall("GET", "/holdings", "success");
      adapter.publicLogApiCall("GET", "/positions", "success");
      adapter.publicLogApiCall("POST", "/orders", "error");
      assert.equal(adapter.logCalls.length, 3);
    });

    it("should include broker type in log format when in development", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "development";
      const consoleLogs: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        consoleLogs.push(args);
      };
      try {
        adapter.publicLogApiCall("GET", "/holdings", "success");
        assert.equal(consoleLogs.length, 1);
        const logLine = String(consoleLogs[0]![0]);
        assert.ok(
          logLine.includes("[ZERODHA]"),
          "Log should include broker type"
        );
      } finally {
        console.log = originalLog;
      }
    });

    it("should include method and endpoint in log format when in development", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "development";
      const consoleLogs: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        consoleLogs.push(args);
      };
      try {
        adapter.publicLogApiCall("POST", "/orders", "error");
        const logLine = String(consoleLogs[0]![0]);
        assert.ok(logLine.includes("POST"), "Log should include method");
        assert.ok(logLine.includes("/orders"), "Log should include endpoint");
      } finally {
        console.log = originalLog;
      }
    });

    it("should not log to console in production", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "production";
      const consoleLogs: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        consoleLogs.push(args);
      };
      try {
        adapter.publicLogApiCall("GET", "/holdings", "success");
        assert.equal(consoleLogs.length, 0);
      } finally {
        console.log = originalLog;
      }
    });

    it("should not log to console in test environment", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      const consoleLogs: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        consoleLogs.push(args);
      };
      try {
        adapter.publicLogApiCall("GET", "/holdings", "success");
        assert.equal(consoleLogs.length, 0);
      } finally {
        console.log = originalLog;
      }
    });

    it("should still record logCalls even when not in development", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        "production";
      adapter.publicLogApiCall("GET", "/holdings", "success");
      assert.equal(adapter.logCalls.length, 1);
    });
  });
});
