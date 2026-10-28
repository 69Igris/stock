/**
 * TurnMeta Output Structure Tests (lib/chat-tools/turn-context.ts)
 *
 * De-shadowed (MONEY-620). This file previously inlined three `buildXTurnMeta`
 * builders that "mirrored" the chat route's turnMeta construction. Those copies
 * had already DIVERGED from the route (which now builds turnMeta inline at five
 * separate sites — bareStock / fastTool / pre / stream / gemini — that no single
 * builder represents), so the shadow asserted code that does not exist as a
 * unit. The genuinely-reusable, bug-prone piece is the screener-result →
 * TurnMeta capture, which has been extracted into the exported
 * `deriveScreenerTurnState` / `extractScreenerRows` in turn-context.ts and is
 * now CALLED by the route's fast-path. These tests assert those real exports,
 * plus the real history-fallback (`extractStateFromHistory`) and the TurnMeta
 * JSON serialization contract (a real Redis/Mongo round-trip, no source copy).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveScreenerTurnState,
  extractScreenerRows,
  extractStateFromHistory,
} from "@/lib/chat-tools/turn-context";
import type { TurnMeta } from "@usemoney/types";

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("TurnMeta Output Structure", () => {
  // ── extractScreenerRows (result-shape normalisation) ────────────────────

  describe("extractScreenerRows", () => {
    it("returns a bare array unchanged", () => {
      const arr = [{ symbol: "TCS" }];
      assert.strictEqual(extractScreenerRows(arr), arr);
    });

    it("unwraps a { data: [...] } envelope", () => {
      const rows = [{ symbol: "TCS" }, { symbol: "INFY" }];
      assert.deepStrictEqual(extractScreenerRows({ data: rows }), rows);
    });

    it("returns null for null / undefined", () => {
      assert.strictEqual(extractScreenerRows(null), null);
      assert.strictEqual(extractScreenerRows(undefined), null);
    });

    it("returns null for a scalar", () => {
      assert.strictEqual(extractScreenerRows(42), null);
      assert.strictEqual(extractScreenerRows("oops"), null);
    });

    it("returns null for an object without a data array", () => {
      assert.strictEqual(extractScreenerRows({ message: "started" }), null);
    });
  });

  // ── deriveScreenerTurnState (the real fast-path screener capture) ───────

  describe("deriveScreenerTurnState", () => {
    it("captures screener state from a bare array result", () => {
      const { screenerState, symbols } = deriveScreenerTurnState(
        {
          query: "RSI < 30",
          filters: [{ field: "rsi_14", operator: "lt", value: 30 }],
          indexFilter: "nifty_50",
        },
        [
          { symbol: "TCS", rsi_14: 25 },
          { symbol: "INFY", rsi_14: 28 },
        ],
        "fallback"
      );
      assert.strictEqual(screenerState.query, "RSI < 30");
      assert.strictEqual(screenerState.resultCount, 2);
      assert.strictEqual(screenerState.indexFilter, "nifty_50");
      assert.deepStrictEqual(screenerState.filters, [
        { field: "rsi_14", operator: "lt", value: 30 },
      ]);
      assert.deepStrictEqual(symbols, ["TCS", "INFY"]);
    });

    it("captures screener state from a nested { data: [...] } result", () => {
      const { screenerState, symbols } = deriveScreenerTurnState(
        { query: "low PE" },
        {
          data: [
            { tradingsymbol: "RELIANCE", pe: 28 },
            { tradingsymbol: "HDFC", pe: 22 },
            { tradingsymbol: "ICICI", pe: 19 },
          ],
          message: "Found 3 stocks",
        },
        "fallback"
      );
      assert.strictEqual(screenerState.resultCount, 3);
      assert.strictEqual(screenerState.resultSummary, "RELIANCE, HDFC, ICICI");
      assert.deepStrictEqual(symbols, ["RELIANCE", "HDFC", "ICICI"]);
    });

    it("reads symbols from either `symbol` or `tradingsymbol`", () => {
      const { symbols } = deriveScreenerTurnState(
        {},
        [{ symbol: "A" }, { tradingsymbol: "B" }],
        "q"
      );
      assert.deepStrictEqual(symbols, ["A", "B"]);
    });

    it("caps symbol extraction at 10 stocks", () => {
      const data = Array.from({ length: 15 }, (_, i) => ({
        symbol: `STOCK${i}`,
      }));
      const { symbols } = deriveScreenerTurnState({ query: "all" }, data, "q");
      assert.strictEqual(symbols!.length, 10);
    });

    it("caps result summary at 5 stocks", () => {
      const data = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}` }));
      const { screenerState } = deriveScreenerTurnState(
        { query: "q" },
        data,
        "q"
      );
      assert.strictEqual(screenerState.resultSummary, "S0, S1, S2, S3, S4");
    });

    it("filters out empty-string symbols", () => {
      const { symbols, screenerState } = deriveScreenerTurnState(
        {},
        [{ symbol: "TCS" }, { symbol: "" }, { foo: "bar" }],
        "q"
      );
      // resultCount counts all rows; symbols drops the empties.
      assert.strictEqual(screenerState.resultCount, 3);
      assert.deepStrictEqual(symbols, ["TCS"]);
    });

    it("uses the fallback query when params carry no query", () => {
      const { screenerState } = deriveScreenerTurnState(
        {},
        [{ symbol: "TCS" }],
        "stocks under 20 pe"
      );
      assert.strictEqual(screenerState.query, "stocks under 20 pe");
    });

    it("yields no resultCount/symbols for a non-array result", () => {
      const { screenerState, symbols } = deriveScreenerTurnState(
        { query: "q" },
        { message: "started" },
        "fb"
      );
      assert.strictEqual(screenerState.resultCount, undefined);
      assert.strictEqual(screenerState.resultSummary, undefined);
      assert.strictEqual(symbols, undefined);
    });

    it("does not throw on an empty result array", () => {
      const { screenerState, symbols } = deriveScreenerTurnState(
        { query: "q" },
        [],
        "fb"
      );
      assert.strictEqual(screenerState.resultCount, 0);
      assert.strictEqual(screenerState.resultSummary, "");
      assert.deepStrictEqual(symbols, []);
    });
  });

  // ── JSON Round-Trip (Redis/MongoDB serialization contract) ──────────────

  describe("JSON round-trip fidelity", () => {
    it("should survive JSON.stringify → JSON.parse for full TurnMeta", () => {
      const original: TurnMeta = {
        intent: "screener",
        tier: "L2",
        tool: "run_screener",
        persona: "quant_analyst",
        confidence: 0.92,
        toolParams: {
          query: "RSI < 30",
          filters: [{ field: "rsi_14", operator: "lt", value: 30 }],
        },
        toolSuccess: true,
        symbols: ["TCS", "INFY", "RELIANCE"],
        screenerState: {
          query: "RSI < 30 in Nifty 50",
          strategy: "value_investing",
          filters: [{ field: "rsi_14", operator: "lt", value: 30 }],
          indexFilter: "nifty_50",
          resultCount: 12,
          resultSummary: "TCS, INFY, RELIANCE, HDFC, ICICI",
        },
      };

      const json = JSON.stringify(original);
      const parsed = JSON.parse(json) as TurnMeta;

      assert.deepStrictEqual(parsed, original);
    });

    it("should survive round-trip for minimal TurnMeta", () => {
      const original: TurnMeta = { intent: "quick_lookup", tier: "L1" };
      const parsed = JSON.parse(JSON.stringify(original)) as TurnMeta;
      assert.deepStrictEqual(parsed, original);
    });

    it("should preserve undefined fields as absent (not null)", () => {
      const original: TurnMeta = { intent: "test" };
      const json = JSON.stringify(original);
      const parsed = JSON.parse(json);
      assert.ok(!("tier" in parsed)); // undefined fields are omitted by JSON.stringify
      assert.ok(!("tool" in parsed));
    });

    it("round-trips screenerState produced by deriveScreenerTurnState", () => {
      // End-to-end: the capture's output must serialise cleanly into Redis.
      // JSON drops `undefined` keys (strategy/filters here), so the meaningful
      // contract is idempotency of the JSON form — re-parsing the stored string
      // yields the same string again (no NaN/throw on the derived shape).
      const { screenerState } = deriveScreenerTurnState(
        { query: "RSI < 30", indexFilter: "nifty_50" },
        [{ symbol: "TCS" }, { symbol: "INFY" }],
        "fb"
      );
      const meta: TurnMeta = {
        intent: "screener",
        tier: "L2",
        tool: "run_screener",
        screenerState,
      };
      const stored = JSON.stringify(meta);
      const reStored = JSON.stringify(JSON.parse(stored));
      assert.strictEqual(reStored, stored);
      // The load-bearing values survive the trip.
      const parsed = JSON.parse(stored) as TurnMeta;
      assert.strictEqual(parsed.screenerState!.resultCount, 2);
      assert.strictEqual(parsed.screenerState!.resultSummary, "TCS, INFY");
      assert.strictEqual(parsed.screenerState!.indexFilter, "nifty_50");
    });
  });

  // ── Backward Compatibility (real history fallback) ──────────────────────

  describe("backward compatibility via extractStateFromHistory", () => {
    it("returns null for history with no turnMeta-bearing assistant turn", () => {
      const state = extractStateFromHistory([
        { role: "user", content: "old message" },
        { role: "assistant", content: "old response" },
      ]);
      assert.strictEqual(state, null);
    });

    it("returns null for empty / undefined history", () => {
      assert.strictEqual(extractStateFromHistory([]), null);
      assert.strictEqual(extractStateFromHistory(undefined), null);
    });

    it("picks the most recent assistant turnMeta amid old-format messages", () => {
      const state = extractStateFromHistory([
        { role: "user", content: "old message" },
        { role: "assistant", content: "old response" },
        { role: "user", content: "new message" },
        {
          role: "assistant",
          content: "new response",
          turnMeta: {
            intent: "screener",
            tier: "L2",
            tool: "run_screener",
            symbols: ["TCS", "INFY"],
          },
        },
      ]);
      assert.ok(state);
      assert.strictEqual(state.lastTurnMeta.tool, "run_screener");
      assert.deepStrictEqual(state.activeSymbols, ["TCS", "INFY"]);
      // turnCount counts the user turns in the history.
      assert.strictEqual(state.turnCount, 2);
    });
  });
});
