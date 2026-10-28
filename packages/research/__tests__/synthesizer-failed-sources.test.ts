/**
 * MONEY-1060 (fix 2b + fix 7) — synthesizer prompt: FAILED / UNAVAILABLE
 * SOURCES section.
 *
 * Covers the REAL `buildSynthesizerUserPrompt` + `buildUnavailableSourceLines`
 * (packages/research/src/prompts.ts):
 *
 *   - failed tasks that carry outage information (task.error and/or
 *     task.metadata.sourceError — now carried onto tasks by the executor) are
 *     listed under an explicit header instructing the model to treat them as
 *     "source temporarily unavailable", NOT as the company lacking data;
 *   - a failed task with NO error and NO metadata is NOT listed (nothing
 *     actionable to report — this also pins compatibility with the pre-existing
 *     prompt contract that bare failed tools never leak into the prompt);
 *   - stale DB-fallback price rows on COMPLETED fetch_stock_price tasks are
 *     labelled "price as of <date> (DB fallback …)" (fix 7 minimal);
 *   - every line is capped at ~150 chars;
 *   - the section sits between the gathered data and the closing directive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSynthesizerUserPrompt,
  buildUnavailableSourceLines,
} from "../src/prompts";
import type { ResearchTask } from "../src/types";

function task(
  overrides: Partial<ResearchTask> & { id: string; tool: string },
): ResearchTask {
  return {
    type: "data_fetch",
    params: {},
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

const HEADER =
  'FAILED / UNAVAILABLE SOURCES (transient outages — treat as "source temporarily unavailable", NOT as the company lacking data):';

describe("buildUnavailableSourceLines — failed tasks", () => {
  it("lists a failed task's tool + error, appending a distinct metadata.sourceError", () => {
    const lines = buildUnavailableSourceLines([
      task({
        id: "t1",
        tool: "fetch_price_history",
        status: "failed",
        error: "Failed to fetch price history",
        metadata: { sourceError: "ETIMEDOUT query1.finance.yahoo.com" },
      }),
    ]);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0]!,
      /^- fetch_price_history: Failed to fetch price history/,
    );
    assert.match(
      lines[0]!,
      /source error: ETIMEDOUT query1\.finance\.yahoo\.com/,
    );
  });

  it("does not repeat a sourceError already embedded in the error text", () => {
    const lines = buildUnavailableSourceLines([
      task({
        id: "t1",
        tool: "fetch_stock_price",
        status: "failed",
        error: "No price data found for TCS.NS: Yahoo 429",
        metadata: { sourceError: "Yahoo 429" },
      }),
    ]);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /source error:/);
    assert.match(lines[0]!, /Yahoo 429/);
  });

  it("falls back to metadata.sourceError when the task has no error text", () => {
    const lines = buildUnavailableSourceLines([
      task({
        id: "t1",
        tool: "fetch_key_ratios",
        status: "failed",
        metadata: { sourceError: "Yahoo 503" },
      }),
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^- fetch_key_ratios: Yahoo 503/);
  });

  it("SKIPS failed tasks with neither error nor sourceError (nothing actionable)", () => {
    const lines = buildUnavailableSourceLines([
      task({ id: "t1", tool: "compute_dcf", status: "failed" }),
    ]);
    assert.deepEqual(lines, []);
  });

  it("ignores completed / pending tasks (other than stale price rows)", () => {
    const lines = buildUnavailableSourceLines([
      task({ id: "t1", tool: "fetch_news", status: "completed", result: [] }),
      task({ id: "t2", tool: "fetch_earnings", status: "pending" }),
    ]);
    assert.deepEqual(lines, []);
  });

  it("caps each line at 150 chars", () => {
    const lines = buildUnavailableSourceLines([
      task({
        id: "t1",
        tool: "fetch_price_history",
        status: "failed",
        error: "x".repeat(400),
      }),
    ]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.length <= 150, `line too long: ${lines[0]!.length}`);
    assert.match(lines[0]!, /\.\.\.$/);
  });
});

describe("buildUnavailableSourceLines — stale DB price rows (fix 7)", () => {
  it("labels a stale/db price row with its as-of date", () => {
    const lines = buildUnavailableSourceLines([
      task({
        id: "t1",
        tool: "fetch_stock_price",
        status: "completed",
        result: {
          "TCS.NS": {
            symbol: "TCS.NS",
            price: 3900,
            source: "db",
            stale: true,
            asOf: "2026-06-28T00:00:00.000Z",
          },
        },
      }),
    ]);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0]!,
      /- fetch_stock_price: TCS\.NS price as of 2026-06-28 \(DB fallback/,
    );
  });

  it("emits one line per stale row and none for fresh live rows", () => {
    const lines = buildUnavailableSourceLines([
      task({
        id: "t1",
        tool: "fetch_stock_price",
        status: "completed",
        result: {
          "TCS.NS": { symbol: "TCS.NS", price: 4000 }, // live — no label
          "INFY.NS": {
            symbol: "INFY.NS",
            price: 1500,
            source: "db",
            stale: true,
            asOf: "2026-07-01T00:00:00.000Z",
          },
        },
      }),
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /INFY\.NS price as of 2026-07-01/);
  });
});

describe("buildSynthesizerUserPrompt — section wiring", () => {
  it("emits the header + lines when a failed task carries outage info", () => {
    const prompt = buildSynthesizerUserPrompt("Analyze TCS", [
      task({
        id: "t1",
        tool: "fetch_news",
        status: "completed",
        result: [{ headline: "x" }],
      }),
      task({
        id: "t2",
        tool: "fetch_price_history",
        status: "failed",
        error: "Failed to fetch price history: ETIMEDOUT",
        metadata: { sourceError: "ETIMEDOUT" },
      }),
    ]);
    assert.ok(prompt.includes(HEADER), "section header present");
    assert.match(
      prompt,
      /- fetch_price_history: Failed to fetch price history/,
    );
    // Completed data blocks unaffected.
    assert.ok(prompt.includes("--- fetch_news (t1) ---"));
    // Section sits between the gathered data and the closing directive.
    const headerAt = prompt.indexOf(HEADER);
    const dataAt = prompt.indexOf("--- fetch_news (t1) ---");
    const closingAt = prompt.indexOf("Please synthesize the above data");
    assert.ok(dataAt < headerAt && headerAt < closingAt);
  });

  it("omits the section entirely when nothing failed and nothing is stale", () => {
    const prompt = buildSynthesizerUserPrompt("Analyze TCS", [
      task({
        id: "t1",
        tool: "fetch_news",
        status: "completed",
        result: [{ headline: "x" }],
      }),
    ]);
    assert.doesNotMatch(prompt, /FAILED \/ UNAVAILABLE SOURCES/);
    assert.ok(prompt.includes("Please synthesize the above data"));
  });

  it("a failed task with no error/metadata does NOT surface (pre-existing contract)", () => {
    const prompt = buildSynthesizerUserPrompt("q", [
      task({ id: "t3", tool: "compute_dcf", status: "failed" }),
    ]);
    assert.ok(!prompt.includes("compute_dcf"));
    assert.doesNotMatch(prompt, /FAILED \/ UNAVAILABLE SOURCES/);
  });

  it("stale price rows alone are enough to emit the section (fix 7)", () => {
    const prompt = buildSynthesizerUserPrompt("q", [
      task({
        id: "t1",
        tool: "fetch_stock_price",
        status: "completed",
        result: {
          "TCS.NS": {
            price: 3900,
            source: "db",
            stale: true,
            asOf: "2026-06-28T00:00:00.000Z",
          },
        },
      }),
    ]);
    assert.ok(prompt.includes(HEADER));
    assert.match(prompt, /price as of 2026-06-28 \(DB fallback/);
  });
});
