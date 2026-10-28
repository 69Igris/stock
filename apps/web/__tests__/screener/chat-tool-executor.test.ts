/**
 * Ask Screener chat — tool executor (MONEY-1078).
 *
 * `executeScreenerTool` maps a Gemini function call onto a
 * `ScreenerChatActions` method. This suite runs the REAL executor against
 * a recording mock and asserts:
 *   - set*Filters imply their mode (switch happens before the merge);
 *   - invalid/unknown args never reach the actions;
 *   - mode-scoped tools (sort, clear, remove) act on the ACTIVE mode, read
 *     through the getter so a batched switch+act turn resolves correctly;
 *   - failures come back as error ToolResults (fed to the model), not throws.
 *
 * Source: apps/web/app/discover/screener/lib/chat/toolExecutor.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeScreenerTool } from "@/app/discover/screener/lib/chat/toolExecutor";
import type { ScreenerChatActions } from "@/app/discover/screener/lib/chat/actions";
import type { ScreenerMode } from "@/components/screener/ModeTabs";

interface Call {
  name: string;
  args: unknown[];
}

function makeMock(initialMode: ScreenerMode = "stocks") {
  const calls: Call[] = [];
  let mode = initialMode;
  const actions: ScreenerChatActions = {
    switchMode: (m) => {
      calls.push({ name: "switchMode", args: [m] });
      mode = m;
    },
    mergeFilters: (m, f) => calls.push({ name: "mergeFilters", args: [m, f] }),
    unsetFilters: (m, k) => calls.push({ name: "unsetFilters", args: [m, k] }),
    clearFilters: (m) => calls.push({ name: "clearFilters", args: [m] }),
    setQuery: (q) => calls.push({ name: "setQuery", args: [q] }),
    setSort: (m, s) => calls.push({ name: "setSort", args: [m, s] }),
  };
  return { actions, calls, getMode: () => mode };
}

describe("executeScreenerTool — filter merges", () => {
  it("merges validated stock filters without switching when already there", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "setStockFilters",
      { minRoe: 20, maxPe: 25 },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true);
    assert.deepEqual(
      m.calls.map((c) => c.name),
      ["mergeFilters"]
    );
    assert.deepEqual(m.calls[0]!.args[1], { minRoe: 20, maxPe: 25 });
  });

  it("switches mode BEFORE merging when the tool implies another tab", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "setEtfFilters",
      { theme: "Gold" },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true);
    assert.deepEqual(
      m.calls.map((c) => c.name),
      ["switchMode", "mergeFilters"]
    );
    assert.equal(m.calls[0]!.args[0], "etf");
    assert.equal(m.calls[1]!.args[0], "etf");
    if (r.ok) assert.match(r.message, /Switched to ETFs/);
  });

  it("reports clamps and dropped keys back to the model", () => {
    const m = makeMock("mf");
    const r = executeScreenerTool(
      "setMfFilters",
      { maxExpenseRatio: 99, pegRatio: 3 },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.message, /clamped/);
      assert.match(r.message, /pegRatio/);
    }
    assert.deepEqual(m.calls[0]!.args[1], { maxExpenseRatio: 10 });
  });

  it("errors (touching nothing) when every key is invalid", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "setStockFilters",
      { bogus: 1 },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("errors on an empty filter bag", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool("setStockFilters", {}, m.getMode, m.actions);
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("routes explicit nulls to unsetFilters, not mergeFilters", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "setStockFilters",
      { minPe: null, minRoe: 18 },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true);
    assert.deepEqual(
      m.calls.map((c) => c.name),
      ["mergeFilters", "unsetFilters"]
    );
    assert.deepEqual(m.calls[1]!.args[1], ["minPe"]);
  });
});

describe("executeScreenerTool — mode-scoped tools", () => {
  it("clears / removes filters on the ACTIVE mode", () => {
    const m = makeMock("etf");
    executeScreenerTool("clearFilters", {}, m.getMode, m.actions);
    executeScreenerTool(
      "removeFilters",
      { keys: ["minAum", "theme"] },
      m.getMode,
      m.actions
    );
    assert.equal(m.calls[0]!.args[0], "etf");
    assert.equal(m.calls[1]!.args[0], "etf");
    assert.deepEqual(m.calls[1]!.args[1], ["minAum", "theme"]);
  });

  it("resolves the active mode through the GETTER after a batched switch", () => {
    // Mirrors one hop returning [setMfFilters, setSort]: the sort must
    // validate against MF keys, not the pre-switch stocks vocabulary.
    const m = makeMock("stocks");
    executeScreenerTool(
      "setMfFilters",
      { minReturns3Y: 15 },
      m.getMode,
      m.actions
    );
    const r = executeScreenerTool(
      "setSort",
      { sort: "ret3y-desc" },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true, "fund sort should be valid once mode is MF");
    const sortCall = m.calls.find((c) => c.name === "setSort");
    assert.deepEqual(sortCall!.args, ["mf", "ret3y-desc"]);
  });

  it("rejects a sort key that is invalid for the active mode", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "setSort",
      { sort: "aum-desc" },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Valid:/);
    assert.equal(m.calls.length, 0);
  });

  it("errors on removeFilters with no usable keys", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "removeFilters",
      { keys: [] },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("removeFilters only unsets keys in the mode's vocabulary", () => {
    // `amcAny` (the multi-AMC chip selection) is deliberately outside the
    // chat vocab — the chat must not drop a filter it cannot restore.
    const m = makeMock("mf");
    const r = executeScreenerTool(
      "removeFilters",
      { keys: ["minAum", "amcAny", "bogus"] },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true);
    assert.deepEqual(m.calls[0]!.args[1], ["minAum"]);
    if (r.ok) assert.match(r.message, /Ignored unsupported: amcAny, bogus/);
  });

  it("removeFilters errors (touching nothing) when NO key is in the vocab", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "removeFilters",
      { keys: ["amcAny", "limit"] },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("removeFilters rejects inherited Object keys", () => {
    const m = makeMock("stocks");
    const r = executeScreenerTool(
      "removeFilters",
      { keys: ["constructor", "toString"] },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });
});

describe("executeScreenerTool — query, mode, unknown", () => {
  it("sets and clears the search query", () => {
    const m = makeMock();
    const set = executeScreenerTool(
      "setSearchQuery",
      { query: "  RELIANCE " },
      m.getMode,
      m.actions
    );
    assert.equal(set.ok, true);
    assert.equal(m.calls[0]!.args[0], "RELIANCE");

    const clear = executeScreenerTool(
      "setSearchQuery",
      { query: "" },
      m.getMode,
      m.actions
    );
    assert.equal(clear.ok, true);
    if (clear.ok) assert.match(clear.message, /Cleared/);
  });

  it("rejects a non-string query", () => {
    const m = makeMock();
    const r = executeScreenerTool(
      "setSearchQuery",
      { query: 42 },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("switchMode is a no-op when already on that tab", () => {
    const m = makeMock("mf");
    const r = executeScreenerTool(
      "switchMode",
      { mode: "mf" },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, true);
    assert.equal(m.calls.length, 0, "should not re-set the same mode");
  });

  it("rejects an invalid mode", () => {
    const m = makeMock();
    const r = executeScreenerTool(
      "switchMode",
      { mode: "crypto" },
      m.getMode,
      m.actions
    );
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("returns an error ToolResult for an unknown tool name", () => {
    const m = makeMock();
    const r = executeScreenerTool("deleteEverything", {}, m.getMode, m.actions);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown tool/);
    assert.equal(m.calls.length, 0);
  });

  it("never throws — a throwing action surfaces as an error result", () => {
    const m = makeMock();
    const boom: ScreenerChatActions = {
      ...m.actions,
      setQuery: () => {
        throw new Error("state blew up");
      },
    };
    const r = executeScreenerTool(
      "setSearchQuery",
      { query: "x" },
      m.getMode,
      boom
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /state blew up/);
  });
});
