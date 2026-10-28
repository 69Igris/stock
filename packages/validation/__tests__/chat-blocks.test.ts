/**
 * Negative / edge-case coverage for the REAL exported chat-block Zod schemas
 * and the `validateBlockData` dispatcher.
 *
 * Source: packages/validation/src/chat-blocks.ts
 *
 * Imports & exercises the actual schemas + the real `validateBlockData` /
 * `BLOCK_SCHEMAS` exports (no shadow). These blocks are parsed from untrusted
 * LLM output, so the `.min(1)` non-empty array gates and enum constraints are
 * the safety net against rendering malformed JSON.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TableBlockSchema,
  TableColumnSchema,
  CardBlockSchema,
  ChartBlockSchema,
  ActionBlockSchema,
  NavigationBlockSchema,
  ComparisonBlockSchema,
  ErrorBlockSchema,
  BLOCK_SCHEMAS,
  validateBlockData,
} from "../src/chat-blocks.ts";

describe("TableColumnSchema / TableBlockSchema (real exports)", () => {
  it("accepts a valid single-column table with one row", () => {
    const r = TableBlockSchema.safeParse({
      columns: [{ key: "sym", label: "Symbol" }],
      rows: [{ sym: "TCS" }],
    });
    assert.equal(r.success, true);
  });

  it("rejects an empty columns array (min 1)", () => {
    const r = TableBlockSchema.safeParse({ columns: [], rows: [{ x: 1 }] });
    assert.equal(r.success, false);
  });

  it("rejects an empty rows array (min 1)", () => {
    const r = TableBlockSchema.safeParse({
      columns: [{ key: "x", label: "X" }],
      rows: [],
    });
    assert.equal(r.success, false);
  });

  it("rejects an out-of-enum column align", () => {
    const r = TableColumnSchema.safeParse({
      key: "x",
      label: "X",
      align: "top",
    });
    assert.equal(r.success, false);
  });

  it("rejects an out-of-enum column format", () => {
    const r = TableColumnSchema.safeParse({
      key: "x",
      label: "X",
      format: "money",
    });
    assert.equal(r.success, false);
  });

  it("rejects a non-positive maxRows", () => {
    const r = TableBlockSchema.safeParse({
      columns: [{ key: "x", label: "X" }],
      rows: [{ x: 1 }],
      maxRows: 0,
    });
    assert.equal(r.success, false);
  });
});

describe("CardBlockSchema (real export)", () => {
  it("accepts a valid metric card", () => {
    const r = CardBlockSchema.safeParse({ variant: "metric", title: "P&L" });
    assert.equal(r.success, true);
  });

  it("rejects an out-of-enum variant", () => {
    const r = CardBlockSchema.safeParse({ variant: "banner", title: "X" });
    assert.equal(r.success, false);
  });

  it("rejects a missing title (required)", () => {
    const r = CardBlockSchema.safeParse({ variant: "metric" });
    assert.equal(r.success, false);
  });
});

describe("ChartBlockSchema (real export)", () => {
  const valid = {
    chartType: "line",
    data: [{ x: 1, y: 2 }],
    xKey: "x",
    yKeys: [{ key: "y", label: "Y" }],
  };

  it("accepts a valid chart", () => {
    assert.equal(ChartBlockSchema.safeParse(valid).success, true);
  });

  it("rejects an out-of-enum chartType", () => {
    assert.equal(
      ChartBlockSchema.safeParse({ ...valid, chartType: "scatter" }).success,
      false,
    );
  });

  it("rejects an empty data array (min 1)", () => {
    assert.equal(
      ChartBlockSchema.safeParse({ ...valid, data: [] }).success,
      false,
    );
  });

  it("rejects an empty yKeys array (min 1)", () => {
    assert.equal(
      ChartBlockSchema.safeParse({ ...valid, yKeys: [] }).success,
      false,
    );
  });
});

describe("ActionBlockSchema (real export)", () => {
  it("accepts a valid action and defaults status to pending", () => {
    const r = ActionBlockSchema.safeParse({
      actionId: "a1",
      tool: "buyStock",
      description: "Buy 10 TCS",
      params: { symbol: "TCS" },
    });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.status, "pending");
  });

  it("rejects an out-of-enum status", () => {
    const r = ActionBlockSchema.safeParse({
      actionId: "a1",
      tool: "buyStock",
      description: "x",
      params: {},
      status: "queued",
    });
    assert.equal(r.success, false);
  });

  it("rejects missing params (required record)", () => {
    const r = ActionBlockSchema.safeParse({
      actionId: "a1",
      tool: "buyStock",
      description: "x",
    });
    assert.equal(r.success, false);
  });
});

describe("NavigationBlockSchema (real export)", () => {
  it("accepts a valid navigation block", () => {
    const r = NavigationBlockSchema.safeParse({
      links: [{ label: "Holdings", href: "/holdings" }],
    });
    assert.equal(r.success, true);
  });

  it("rejects an empty links array (min 1)", () => {
    assert.equal(NavigationBlockSchema.safeParse({ links: [] }).success, false);
  });
});

describe("ComparisonBlockSchema (real export)", () => {
  const valid = {
    items: [{ name: "A" }, { name: "B" }],
    metrics: [{ label: "P/E", values: ["10", "12"] }],
  };

  it("accepts a valid comparison (>= 2 items, >= 1 metric)", () => {
    assert.equal(ComparisonBlockSchema.safeParse(valid).success, true);
  });

  it("rejects fewer than 2 items (min 2)", () => {
    assert.equal(
      ComparisonBlockSchema.safeParse({ ...valid, items: [{ name: "A" }] })
        .success,
      false,
    );
  });

  it("rejects an empty metrics array (min 1)", () => {
    assert.equal(
      ComparisonBlockSchema.safeParse({ ...valid, metrics: [] }).success,
      false,
    );
  });
});

describe("ErrorBlockSchema (real export)", () => {
  it("accepts a valid error block", () => {
    assert.equal(
      ErrorBlockSchema.safeParse({ severity: "warning", title: "Heads up" })
        .success,
      true,
    );
  });

  it("rejects an out-of-enum severity", () => {
    assert.equal(
      ErrorBlockSchema.safeParse({ severity: "critical", title: "X" }).success,
      false,
    );
  });
});

describe("validateBlockData (real export)", () => {
  it("returns success for a valid known block type", () => {
    const r = validateBlockData("error", { severity: "info", title: "Hi" });
    assert.equal(r.success, true);
  });

  it("returns a failure with a joined error message for an invalid known block", () => {
    const r = validateBlockData("error", { severity: "nope", title: "Hi" });
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 0);
  });

  it("rejects an entirely unknown block type", () => {
    const r = validateBlockData("totally-made-up", { foo: "bar" });
    assert.equal(r.success, false);
    if (r.success) return;
    assert.match(r.error, /Unknown block type/);
  });

  it("passes through a known passthrough block when it is an object", () => {
    const r = validateBlockData("scorecard", { score: 7 });
    assert.equal(r.success, true);
  });

  it("rejects a passthrough block that is an array (must be an object)", () => {
    const r = validateBlockData("scorecard", [1, 2, 3]);
    assert.equal(r.success, false);
  });

  it("rejects a passthrough block that is null (must be an object)", () => {
    const r = validateBlockData("portfolio", null);
    assert.equal(r.success, false);
  });

  it("exposes every known block type in BLOCK_SCHEMAS", () => {
    for (const key of [
      "table",
      "card",
      "chart",
      "action",
      "navigation",
      "comparison",
      "error",
    ]) {
      assert.ok(BLOCK_SCHEMAS[key], `expected BLOCK_SCHEMAS to contain ${key}`);
    }
  });
});
