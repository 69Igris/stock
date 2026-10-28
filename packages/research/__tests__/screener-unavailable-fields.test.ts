/**
 * MONEY-1121 — an empty screen must say WHY when the cause is missing data.
 *
 * Reported in the MONEY-1095 bug doc as item 6 ("any prompt related to
 * screener is not working"). The ratios feed supplies 7 of the 23 columns
 * `financial-data-sync` declares, so 16 are NULL on every row. A filter on a
 * null column matches nothing, so the screen returned 0 and the UI said "No
 * stocks matched your criteria" — indistinguishable from "no such stocks
 * exist". 32 of the 94 registered strategies filter on at least one of those
 * columns and can therefore never return anything.
 *
 * Measured coverage at the time of writing (2135 rows):
 *   populated — pe, pb, roe, roce, marketCap, beta, dividendYield
 *   all NULL  — debtToEquity, currentRatio, interestCoverage, roa,
 *               evToEbitda, pegRatio, the margins, the growth fields, ...
 *
 * `value_investing` is the reported case: pe < 15 (777 rows), pb < 2 (964),
 * roe > 15 (693), debtToEquity < 1 (0) — the last predicate annihilates it.
 *
 * These tests cover the PURE half (the wording). The DB half lives in
 * `findUnavailableFields`, which is deliberately measured at runtime rather
 * than hard-coded so the warning disappears by itself once a feed populates
 * the column.
 *
 * Source: packages/research/src/tools/run-screener.ts
 *         packages/core/src/screener/engine.ts (findUnavailableFields)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildUnavailableMessage } from "../src/tools/run-screener";

describe("MONEY-1121 — unavailable-field explanation", () => {
  it("names the single blocking column in plain language", () => {
    const msg = buildUnavailableMessage(["debtToEquity"]);
    assert.match(
      msg,
      /debt-to-equity/,
      "must use the human label, not the column name",
    );
    assert.ok(
      !msg.includes("debtToEquity"),
      "the raw camelCase column name must not leak to the user",
    );
  });

  it("uses singular agreement for one field and plural for several", () => {
    assert.match(buildUnavailableMessage(["debtToEquity"]), /which isn't in/);
    assert.match(
      buildUnavailableMessage(["debtToEquity", "currentRatio"]),
      /which aren't in/,
    );
  });

  it("joins several fields readably", () => {
    const msg = buildUnavailableMessage([
      "debtToEquity",
      "currentRatio",
      "interestCoverage",
    ]);
    assert.match(msg, /debt-to-equity, current ratio and interest coverage/);
  });

  it("says the market is not the reason", () => {
    // The whole point: distinguish "we lack the data" from "nothing matched".
    // Without this the user retries with looser criteria forever.
    const msg = buildUnavailableMessage(["debtToEquity"]);
    assert.match(msg, /regardless of the market/);
  });

  it("points at fields that DO have data", () => {
    const msg = buildUnavailableMessage(["debtToEquity"]);
    for (const usable of ["P/E", "P/B", "ROE", "ROCE"]) {
      assert.ok(msg.includes(usable), `should suggest ${usable} as an option`);
    }
  });

  it("falls back to the raw name for a column with no label", () => {
    // A new zero-coverage column must still produce a sensible sentence
    // rather than "undefined".
    const msg = buildUnavailableMessage(["someNewRatio"]);
    assert.match(msg, /someNewRatio/);
    assert.ok(!msg.includes("undefined"));
  });

  it("every labelled field renders without leaking camelCase", () => {
    const labelled = [
      "debtToEquity",
      "currentRatio",
      "interestCoverage",
      "pegRatio",
      "evToEbitda",
      "revenueGrowth",
      "earningsGrowth",
      "grossMargin",
      "operatingMargin",
      "netMargin",
      "roa",
    ];
    for (const field of labelled) {
      const msg = buildUnavailableMessage([field]);
      assert.ok(
        !msg.includes(field) || field === "roa",
        `${field} leaked its column name into the message`,
      );
    }
  });
});
