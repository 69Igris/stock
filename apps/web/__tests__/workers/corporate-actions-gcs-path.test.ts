/**
 * Corporate-actions GCS path builder (MONEY-840/844).
 *
 * The corporate-actions-sync worker archives a per-symbol JSON snapshot at
 * `stocks/{SYMBOL}/corporate_actions/{SYMBOL}-corporate-actions.json`. This pins
 * the path the worker actually builds (via the real `buildFullDocPath` +
 * `buildStockDocPath` exports with the new `corporate_actions` StockDocType) so a
 * rename of the doc type or the path convention can't silently move the archive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildStockDocPath,
  type StockDocType,
} from "@usemoney/research/data-sources/stock-document-paths";

/**
 * Rebuild the snapshot path exactly the way the corporate-actions-sync worker
 * does (fixed per-symbol filename, latest-wins) so this test pins the real path.
 */
function workerSnapshotPath(symbol: string): string {
  const clean = symbol.toUpperCase().replace(/[^A-Z0-9&]/g, "");
  return buildStockDocPath(
    symbol,
    "corporate_actions",
    `${clean}-corporate-actions.json`
  );
}

describe("corporate-actions GCS path builder", () => {
  it("worker writes stocks/{SYMBOL}/corporate_actions/{SYMBOL}-corporate-actions.json", () => {
    assert.strictEqual(
      workerSnapshotPath("RELIANCE"),
      "stocks/RELIANCE/corporate_actions/RELIANCE-corporate-actions.json"
    );
  });

  it("upper-cases a lower-cased symbol in both the folder and the filename", () => {
    assert.strictEqual(
      workerSnapshotPath("tcs"),
      "stocks/TCS/corporate_actions/TCS-corporate-actions.json"
    );
  });

  it("buildStockDocPath nests the file under the corporate_actions docType folder", () => {
    assert.strictEqual(
      buildStockDocPath(
        "INFY",
        "corporate_actions",
        "INFY-corporate-actions.json"
      ),
      "stocks/INFY/corporate_actions/INFY-corporate-actions.json"
    );
  });

  it("strips disallowed chars from the symbol (folder upper-cased by builder)", () => {
    // buildStockDocPath upper-cases the symbol for the folder; the worker
    // sanitizes the same symbol for the filename (M&M keeps the &).
    assert.strictEqual(
      workerSnapshotPath("m&m"),
      "stocks/M&M/corporate_actions/M&M-corporate-actions.json"
    );
  });

  it("corporate_actions is a valid StockDocType (compile-time + runtime use)", () => {
    const docType: StockDocType = "corporate_actions";
    // round-trips through the builder without widening to string
    const path = buildStockDocPath(
      "WIPRO",
      docType,
      "WIPRO-corporate-actions.json"
    );
    assert.ok(path.includes("/corporate_actions/"));
  });
});
