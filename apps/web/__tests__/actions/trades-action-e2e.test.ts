/**
 * MONEY-620 — trades server actions END-TO-END (real action handlers).
 *
 * The existing `__tests__/actions/trades.test.ts` is a SHADOW: it reimplements
 * trade logic inline (`getTradesAction logic`, `createTradeAction logic`) and
 * asserts the copy — it never imports the real action. This file drives the REAL
 * exported actions from `lib/actions/trades.ts` and pins the contract that
 * actually matters for cache coherency + security:
 *
 *   - createTradeAction: on a successful service write it REVALIDATES the four
 *     dependent pages (/tradebook, /positions, /holdings, /dashboard); on a
 *     service failure it revalidates NOTHING (no stale-cache bust on a no-op).
 *   - closePositionAction: validates via the REAL Zod ClosePositionSchema, then
 *     on success revalidates /tradebook + /positions + /holdings + /dashboard.
 *   - updateTradeAction / deleteTradeAction: success → revalidate the 3 trade
 *     pages; demo + unauth gates short-circuit before the service.
 *   - getTradesAction: demo path filters the static demoTrades through the REAL
 *     Zod TradeFilterSchema (sort + paginate + stats), and the authed path
 *     forwards the resolved userId + validated filters to the service.
 *   - createTradeAction demo gate returns the upsell error, never the service.
 *
 * The `revalidatePath` calls are the load-bearing side-effect (a created trade
 * that doesn't bust /dashboard leaves the user staring at stale P&L), so they're
 * asserted explicitly — exactly the kind of side-effect a mocked unit test of the
 * service alone can never see.
 *
 * Seam: inject stubs for `next/cache` (revalidatePath recorder), `@/lib/auth`,
 * `@/lib/demo/session`, `@/lib/demo/data`, and `@usemoney/services` via
 * `require.cache` before requiring a FRESH action module. `@usemoney/validation`
 * and `@usemoney/utils/error-sanitization` are kept REAL (pure) so the genuine
 * validation + error-sanitization paths run.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/trades.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── recorders ───────────────────────────────────────────────────────────────

interface ServiceCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  revalidated: string[];
  serviceCalls: ServiceCall[];
  authUser: { userId: string } | null;
  isDemo: boolean;
  /** Per-fn return override; defaults to a success result. */
  serviceReturns: Record<string, unknown>;
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

// Two demo trades so pagination + stats are observable.
const DEMO_TRADES = [
  {
    id: "d-1",
    userId: "demo",
    symbol: "RELIANCE",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 10,
    price: 100,
    exitPrice: 120,
    tradeValue: 1000,
    brokerage: 20,
    taxes: 0,
    realizedPnL: 200,
    status: "CLOSED",
    tradeDate: new Date("2026-06-01T00:00:00Z"),
    exitDate: null,
    broker: "ZERODHA",
    brokerUserId: null,
    brokerName: "zerodha",
    tags: [],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "d-2",
    userId: "demo",
    symbol: "TCS",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "SELL",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 5,
    price: 3000,
    exitPrice: null,
    tradeValue: 15000,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2026-06-03T00:00:00Z"),
    exitDate: null,
    broker: "UPSTOX",
    brokerUserId: null,
    brokerName: "upstox",
    tags: [],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

interface TradesActionModule {
  getTradesAction: (filters: unknown) => Promise<{
    success: boolean;
    data?: { trades: unknown[]; total: number; stats: Record<string, number> };
    error?: string;
  }>;
  createTradeAction: (
    formData: unknown
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  updateTradeAction: (
    tradeId: string,
    formData: unknown
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  deleteTradeAction: (
    tradeId: string
  ) => Promise<{ success: boolean; error?: string }>;
  closePositionAction: (
    positionId: string,
    exitPrice: number
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
}

const ACTION_REL = "../../lib/actions/trades";

function loadAction(h: Harness): TradesActionModule {
  const cache = moduleCache();
  const nextCachePath = require.resolve("next/cache");
  const authPath = require.resolve("../../lib/auth");
  const sessionPath = require.resolve("../../lib/demo/session");
  const dataPath = require.resolve("../../lib/demo/data");
  const servicesPath = require.resolve("@usemoney/services");
  const actionPath = require.resolve(ACTION_REL);

  cache[nextCachePath] = {
    exports: {
      __esModule: true,
      revalidatePath: (p: string) => {
        h.revalidated.push(p);
      },
      revalidateTag: () => {},
      unstable_cache: (fn: unknown) => fn,
    },
  };
  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(h.authUser),
    },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo),
      COOKIE_NAME: "sb_demo",
    },
  };
  cache[dataPath] = {
    exports: { __esModule: true, demoTrades: DEMO_TRADES },
  };

  const svcFn =
    (name: string) =>
    (...args: unknown[]) => {
      h.serviceCalls.push({ fn: name, args });
      return Promise.resolve(
        h.serviceReturns[name] ?? { success: true, data: { id: "svc-trade" } }
      );
    };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getTrades: svcFn("getTrades"),
      createTrade: svcFn("createTrade"),
      updateTrade: svcFn("updateTrade"),
      deleteTrade: svcFn("deleteTrade"),
      closePosition: svcFn("closePosition"),
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as TradesActionModule;
}

// A valid TradeForm input (strings, because the real Zod schema coerces them).
function validTradeForm(overrides: Record<string, unknown> = {}): unknown {
  return {
    tradeDate: "2026-06-04",
    symbol: "infy",
    quantity: "10",
    price: "100",
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — trades actions (real handlers, real Zod, mocked I/O)", () => {
  let h: Harness;

  beforeEach(() => {
    h = {
      revalidated: [],
      serviceCalls: [],
      authUser: { userId: "internal-user-1" },
      isDemo: false,
      serviceReturns: {},
    };
  });

  describe("createTradeAction — revalidation side-effects", () => {
    it("revalidates /tradebook,/positions,/holdings,/dashboard on success", async () => {
      const action = loadAction(h);
      const res = await action.createTradeAction(validTradeForm());
      assert.equal(res.success, true);
      // The created trade must bust every page that reads from it.
      assert.deepEqual(h.revalidated.sort(), [
        "/dashboard",
        "/holdings",
        "/positions",
        "/tradebook",
      ]);
      // And the service got the resolved userId + the validated (coerced) data.
      const call = h.serviceCalls.find((c) => c.fn === "createTrade");
      assert.ok(call);
      assert.equal(call!.args[0], "internal-user-1");
      const validated = call!.args[1] as Record<string, unknown>;
      assert.equal(validated.symbol, "INFY"); // Zod .toUpperCase()
      assert.equal(validated.quantity, 10); // string → number
      assert.equal(validated.price, 100);
    });

    it("revalidates NOTHING when the service write fails (no stale bust)", async () => {
      h.serviceReturns.createTrade = {
        success: false,
        error: "Failed to create trade",
      };
      const action = loadAction(h);
      const res = await action.createTradeAction(validTradeForm());
      assert.equal(res.success, false);
      assert.equal(
        h.revalidated.length,
        0,
        "a failed create must not revalidate any page"
      );
    });

    it("rejects invalid form data with the first Zod message (no service call)", async () => {
      const action = loadAction(h);
      // Missing symbol/quantity/price → real schema fails.
      const res = await action.createTradeAction({ tradeDate: "2026-06-04" });
      assert.equal(res.success, false);
      assert.equal(typeof res.error, "string");
      assert.equal(
        h.serviceCalls.some((c) => c.fn === "createTrade"),
        false,
        "invalid input must never reach the service"
      );
      assert.equal(h.revalidated.length, 0);
    });

    it("demo session returns the upsell error and never calls the service", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.createTradeAction(validTradeForm());
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.revalidated.length, 0);
    });

    it("unauthenticated (non-demo) returns Unauthorized, no service, no revalidate", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.createTradeAction(validTradeForm());
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.revalidated.length, 0);
    });
  });

  describe("closePositionAction — real ClosePositionSchema + revalidation", () => {
    it("validates, delegates, and revalidates the four pages on success", async () => {
      h.serviceReturns.closePosition = { success: true, data: { pnl: 500 } };
      const action = loadAction(h);
      const res = await action.closePositionAction("pos-1", 250);
      assert.equal(res.success, true);
      const call = h.serviceCalls.find((c) => c.fn === "closePosition");
      assert.ok(call);
      assert.equal(call!.args[0], "internal-user-1");
      // The schema-validated payload carries positionId + exitPrice.
      assert.deepEqual(call!.args[1], { positionId: "pos-1", exitPrice: 250 });
      assert.deepEqual(h.revalidated.sort(), [
        "/dashboard",
        "/holdings",
        "/positions",
        "/tradebook",
      ]);
    });

    it("rejects a non-positive exitPrice via the REAL schema (throws → no service)", async () => {
      const action = loadAction(h);
      await assert.rejects(
        () => action.closePositionAction("pos-2", -5),
        /Exit price must be positive/
      );
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.revalidated.length, 0);
    });

    it("demo session short-circuits before validation + service", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.closePositionAction("pos-3", 100);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.serviceCalls.length, 0);
    });
  });

  describe("updateTradeAction / deleteTradeAction", () => {
    it("updateTradeAction revalidates the 3 trade pages on success", async () => {
      h.serviceReturns.updateTrade = { success: true, data: { updated: 1 } };
      const action = loadAction(h);
      const res = await action.updateTradeAction("t-1", { price: "150" });
      assert.equal(res.success, true);
      assert.deepEqual(h.revalidated.sort(), [
        "/holdings",
        "/positions",
        "/tradebook",
      ]);
      const call = h.serviceCalls.find((c) => c.fn === "updateTrade");
      assert.equal(call!.args[0], "internal-user-1");
      assert.equal(call!.args[1], "t-1");
    });

    it("deleteTradeAction revalidates the 3 trade pages on success", async () => {
      h.serviceReturns.deleteTrade = { success: true, data: undefined };
      const action = loadAction(h);
      const res = await action.deleteTradeAction("t-2");
      assert.equal(res.success, true);
      assert.deepEqual(h.revalidated.sort(), [
        "/holdings",
        "/positions",
        "/tradebook",
      ]);
      const call = h.serviceCalls.find((c) => c.fn === "deleteTrade");
      assert.deepEqual(call!.args, ["internal-user-1", "t-2"]);
    });

    it("deleteTradeAction does NOT revalidate when the service reports failure", async () => {
      h.serviceReturns.deleteTrade = {
        success: false,
        error: "Cannot delete broker-synced trades.",
      };
      const action = loadAction(h);
      const res = await action.deleteTradeAction("t-synced");
      assert.equal(res.success, false);
      assert.equal(h.revalidated.length, 0);
    });

    it("updateTradeAction demo gate returns upsell, no service/revalidate", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.updateTradeAction("t-3", { price: "9" });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.revalidated.length, 0);
    });
  });

  describe("getTradesAction", () => {
    it("demo path filters/sorts/paginates demoTrades via the real schema", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      // limit 1 → only the newest of the 2 demo trades; total reflects all matches.
      const res = await action.getTradesAction({ skip: 0, limit: 1 });
      assert.equal(res.success, true);
      assert.equal(res.data!.total, 2);
      assert.equal(res.data!.trades.length, 1);
      // Newest-first: TCS (2026-06-03) before RELIANCE (2026-06-01).
      assert.equal((res.data!.trades[0] as { symbol: string }).symbol, "TCS");
      // Stats from the 1 CLOSED demo trade (RELIANCE +200): 1 winner, 100% win.
      assert.equal(res.data!.stats.totalPnL, 200);
      assert.equal(res.data!.stats.winRate, 100);
      assert.equal(res.data!.stats.winners, 1);
      assert.equal(h.serviceCalls.length, 0, "demo must not call the service");
    });

    it("demo path applies a broker filter against brokerName", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.getTradesAction({
        skip: 0,
        limit: 20,
        broker: "upstox",
      });
      assert.equal(res.data!.total, 1);
      assert.equal((res.data!.trades[0] as { symbol: string }).symbol, "TCS");
    });

    it("authed path forwards (userId, validatedFilters) to the service", async () => {
      h.serviceReturns.getTrades = {
        success: true,
        data: { trades: [{ id: "svc" }], total: 1, stats: {} },
      };
      const action = loadAction(h);
      const res = await action.getTradesAction({
        skip: 10,
        limit: 5,
        symbol: "tcs",
      });
      assert.equal(res.success, true);
      const call = h.serviceCalls.find((c) => c.fn === "getTrades");
      assert.ok(call);
      assert.equal(call!.args[0], "internal-user-1");
      const filters = call!.args[1] as Record<string, unknown>;
      assert.equal(filters.skip, 10);
      assert.equal(filters.limit, 5);
      assert.equal(filters.symbol, "tcs");
    });

    it("authed-but-signed-out returns sanitized Unauthorized (no service)", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.getTradesAction({ skip: 0, limit: 20 });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(
        h.serviceCalls.some((c) => c.fn === "getTrades"),
        false
      );
    });
  });
});
