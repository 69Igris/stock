/**
 * MONEY-392 / MONEY-278: New demo data added for the Terminal Luxe
 * skeleton/loader sweep and the demo chart UDF allow-list.
 *
 * Validates the shape of demoNotifications, demoStrategies, demoQuizzes, and
 * the DEMO_CHART_SYMBOLS allow-list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  demoNotifications,
  demoUnreadNotificationCount,
  demoStrategies,
  demoQuizzes,
  DEMO_CHART_SYMBOLS,
  isDemoChartSymbol,
} from "../../lib/demo/data";

describe("MONEY-392 - demo data extensions", () => {
  describe("demoNotifications", () => {
    it("exports a non-empty array", () => {
      assert.ok(Array.isArray(demoNotifications));
      assert.ok(demoNotifications.length >= 4);
    });

    it("every entry has the required NotificationItem-compatible shape", () => {
      for (const n of demoNotifications) {
        assert.equal(typeof n.id, "string");
        assert.equal(typeof n.title, "string");
        assert.equal(typeof n.body, "string");
        assert.equal(typeof n.read, "boolean");
        assert.equal(typeof n.createdAt, "string");
        const parsed = new Date(n.createdAt);
        assert.equal(
          Number.isNaN(parsed.getTime()),
          false,
          `createdAt for ${n.id} is not a valid date: ${n.createdAt}`
        );
      }
    });

    it("has at least one unread notification (so the bell badge renders)", () => {
      const unread = demoNotifications.filter((n) => !n.read);
      assert.ok(unread.length > 0);
    });

    it("demoUnreadNotificationCount matches the actual unread count", () => {
      const computed = demoNotifications.filter((n) => !n.read).length;
      assert.equal(demoUnreadNotificationCount, computed);
    });
  });

  describe("demoStrategies", () => {
    it("exports a non-empty array", () => {
      assert.ok(Array.isArray(demoStrategies));
      assert.ok(demoStrategies.length >= 2);
    });

    it("every strategy has a complete rule set + backtest", () => {
      for (const s of demoStrategies) {
        assert.equal(typeof s.id, "string");
        assert.equal(typeof s.name, "string");
        assert.equal(typeof s.rules.entry, "string");
        assert.equal(typeof s.rules.exit, "string");
        assert.equal(typeof s.rules.stopLoss, "string");
        assert.equal(typeof s.backtest.cagr, "number");
        assert.equal(typeof s.backtest.sharpe, "number");
        assert.equal(typeof s.backtest.winRate, "number");
      }
    });
  });

  describe("demoQuizzes", () => {
    it("exports a non-empty array", () => {
      assert.ok(Array.isArray(demoQuizzes));
      assert.ok(demoQuizzes.length >= 3);
    });

    it("difficulty is one of the allowed values", () => {
      const allowed = new Set(["Beginner", "Intermediate", "Advanced"]);
      for (const q of demoQuizzes) {
        assert.ok(
          allowed.has(q.difficulty),
          `${q.id} has unexpected difficulty: ${q.difficulty}`
        );
      }
    });

    it("includes at least one quiz with no attempts (fresh state)", () => {
      const fresh = demoQuizzes.filter((q) => q.attempts === 0);
      assert.ok(fresh.length >= 1);
    });
  });

  describe("MONEY-278 - DEMO_CHART_SYMBOLS allow-list", () => {
    it("contains the major Nifty 50 names", () => {
      for (const sym of ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK"]) {
        assert.ok(
          DEMO_CHART_SYMBOLS.has(sym),
          `expected DEMO_CHART_SYMBOLS to include ${sym}`
        );
      }
    });

    it("contains the major indices", () => {
      assert.ok(DEMO_CHART_SYMBOLS.has("NIFTY"));
      assert.ok(DEMO_CHART_SYMBOLS.has("BANKNIFTY"));
    });

    it("isDemoChartSymbol is case-insensitive", () => {
      assert.equal(isDemoChartSymbol("tcs"), true);
      assert.equal(isDemoChartSymbol("TCS"), true);
      assert.equal(isDemoChartSymbol("Tcs"), true);
    });

    it("isDemoChartSymbol rejects symbols outside the allow-list", () => {
      assert.equal(isDemoChartSymbol("AAPL"), false);
      assert.equal(isDemoChartSymbol("ZZUNKNOWN"), false);
      assert.equal(isDemoChartSymbol(""), false);
    });
  });
});
