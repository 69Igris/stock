/**
 * Tests for shared list/data tool rendering (MONEY-587).
 *
 * The narration short-circuit is only safe if the blocks actually render the
 * data. This guards that wrapper shapes ({ scans }, { builtIn, custom },
 * { documents }) unwrap correctly and that stock-like rows become a stock-list
 * while everything else becomes a table.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrimaryRows,
  buildTableBlock,
  buildListToolBlocks,
} from "../../lib/chat/tool-result-blocks";

type AnyBlock = Record<string, unknown>;

describe("tool-result-blocks: extractPrimaryRows", () => {
  it("unwraps bare arrays + named wrappers", () => {
    assert.equal(extractPrimaryRows([1, 2])?.length, 2);
    assert.equal(extractPrimaryRows({ data: [1] })?.length, 1);
    assert.equal(extractPrimaryRows({ scans: [1, 2, 3] })?.length, 3);
    assert.equal(extractPrimaryRows({ documents: [1], total: 1 })?.length, 1);
  });
  it("merges list_strategies { builtIn, custom }", () => {
    assert.equal(
      extractPrimaryRows({ builtIn: [1, 2], custom: [3] })?.length,
      3
    );
  });
  it("falls back to the first array property", () => {
    assert.equal(extractPrimaryRows({ meta: 1, xs: [1, 2, 3, 4] })?.length, 4);
  });
  it("returns null for single-object payloads", () => {
    assert.equal(extractPrimaryRows({ pe: 28, roe: 9 }), null);
    assert.equal(extractPrimaryRows("x"), null);
    assert.equal(extractPrimaryRows(null), null);
  });
});

describe("tool-result-blocks: buildTableBlock", () => {
  it("builds a table with humanized columns + inferred formats", () => {
    const block = buildTableBlock([
      { scanName: "Value", stockCount: 12, executedAt: "2026-01-01" },
      { scanName: "Momentum", stockCount: 7, executedAt: "2026-02-01" },
    ]) as unknown as AnyBlock;
    assert.equal(block.type, "table");
    const cols = block.columns as AnyBlock[];
    // name-ish column sorts first
    assert.equal(cols[0]!.key, "scanName");
    const byKey = Object.fromEntries(cols.map((c) => [c.key, c.format]));
    assert.equal(byKey["stockCount"], "number");
    assert.equal(byKey["executedAt"], "date");
    assert.equal((block.rows as unknown[]).length, 2);
  });
  it("drops id/internal columns and returns null with no scalar columns", () => {
    const block = buildTableBlock([
      { id: "x", name: "A" },
    ]) as unknown as AnyBlock;
    const keys = (block.columns as AnyBlock[]).map((c) => c.key);
    assert.ok(!keys.includes("id"));
    assert.equal(buildTableBlock([{ nested: { a: 1 } }]), null);
  });
});

describe("tool-result-blocks: buildListToolBlocks", () => {
  it("screener -> stock-list", () => {
    const blocks = buildListToolBlocks("run_screener", {
      data: [{ symbol: "TCS", price: 4000 }],
    });
    assert.equal((blocks[0] as unknown as AnyBlock).type, "stock-list");
  });

  it("scan_result with stock rows -> stock-list", () => {
    const blocks = buildListToolBlocks("get_scan_result", {
      scanName: "Breakouts",
      results: [{ symbol: "INFY", price: 1500 }],
    });
    assert.equal((blocks[0] as unknown as AnyBlock).type, "stock-list");
  });

  it("wrapper-shaped list tools render a table (the bug that dropped rows)", () => {
    const hist = buildListToolBlocks("get_scan_history", {
      scans: [{ scanName: "V", stockCount: 5 }],
    });
    assert.equal((hist[0] as unknown as AnyBlock).type, "table");

    const strat = buildListToolBlocks("list_strategies", {
      builtIn: [{ name: "GARP" }],
      custom: [{ name: "Mine" }],
    });
    assert.equal((strat[0] as unknown as AnyBlock).type, "table");
    assert.equal(
      (strat[0] as unknown as AnyBlock).rows &&
        ((strat[0] as unknown as AnyBlock).rows as unknown[]).length,
      2
    );

    const docs = buildListToolBlocks("get_user_documents", {
      documents: [{ title: "Statement.pdf" }],
      total: 1,
    });
    assert.equal((docs[0] as unknown as AnyBlock).type, "table");
  });

  it("non-list single-object payload renders nothing (caller falls back)", () => {
    assert.deepEqual(buildListToolBlocks("get_financial_data", { pe: 28 }), []);
  });
});
