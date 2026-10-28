/**
 * Tests for shared screener -> ContentBlock formatting (MONEY-587).
 *
 * Both chat lanes (/api/chat free-text + /api/chat/execute-tool chip dispatch)
 * render screener results through buildScreenerBlocks, so it must: produce a
 * stock-list block with mapped rows + metrics on hits, an info block on zero
 * matches, and nothing for non-screener payloads (caller falls back).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildScreenerBlocks,
  extractScreenerRows,
} from "../../lib/chat/screener-blocks";

type AnyBlock = Record<string, unknown>;

const ROWS = [
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    exchange: "NSE",
    price: 2950.5,
    roe: 9.1234,
    pe: 28.4,
    debtToEquity: 0.42,
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy",
    sector: "IT",
    exchange: "NSE",
    price: 4100,
    roe: 51.2,
    pe: 30.1,
    debtToEquity: 0.05,
  },
];

describe("screener-blocks: extractScreenerRows", () => {
  it("reads bare arrays and { data } wrappers", () => {
    assert.equal(extractScreenerRows(ROWS)?.length, 2);
    assert.equal(extractScreenerRows({ data: ROWS })?.length, 2);
  });
  it("returns null for non-list payloads", () => {
    assert.equal(extractScreenerRows({ foo: 1 }), null);
    assert.equal(extractScreenerRows("x"), null);
    assert.equal(extractScreenerRows(null), null);
  });
});

describe("screener-blocks: buildScreenerBlocks (hits)", () => {
  const blocks = buildScreenerBlocks({ data: ROWS }, "low debt high roe");
  const block = blocks[0] as unknown as AnyBlock;

  it("emits exactly one stock-list block", () => {
    assert.equal(blocks.length, 1);
    assert.equal(block.type, "stock-list");
    assert.equal(block.total, 2);
  });

  it("maps each row's identity + a metrics map", () => {
    const stocks = block.stocks as AnyBlock[];
    assert.equal(stocks.length, 2);
    assert.equal(stocks[0]!.symbol, "RELIANCE");
    assert.equal(stocks[0]!.sector, "Energy");
    const metrics = stocks[0]!.metrics as Record<string, unknown>;
    // roe formatted as a percent string, price as ₹
    assert.equal(metrics["ROE (%)"], "9.12%");
    assert.ok(String(metrics["Price (₹)"]).startsWith("₹"));
  });

  it("carries the screen query through", () => {
    assert.equal(block.screenQuery, "low debt high roe");
  });
});

describe("screener-blocks: buildScreenerBlocks (edges)", () => {
  it("returns an info error block on zero matches", () => {
    const blocks = buildScreenerBlocks({ data: [] });
    assert.equal(blocks.length, 1);
    const b = blocks[0] as unknown as AnyBlock;
    assert.equal(b.type, "error");
    assert.equal(b.severity, "info");
    assert.match(b.title as string, /No stocks matched/);
  });

  it("returns [] for unrecognised payloads so the caller can fall back", () => {
    assert.deepEqual(buildScreenerBlocks({ foo: 1 }), []);
    assert.deepEqual(buildScreenerBlocks("nope"), []);
    assert.deepEqual(buildScreenerBlocks(null), []);
  });

  it("uses the payload message as the list title when present", () => {
    const blocks = buildScreenerBlocks({
      data: ROWS,
      message: "Top GARP picks",
    });
    assert.equal((blocks[0] as unknown as AnyBlock).title, "Top GARP picks");
  });
});
