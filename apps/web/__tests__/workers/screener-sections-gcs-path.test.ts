/**
 * Screener structured-section GCS path builders (MONEY-853).
 *
 * The stock-document-sync worker archives the NEW Screener sections that aren't
 * PDFs as per-symbol JSON snapshots:
 *   stocks/{SYM}/screener_shareholding/{SYM}-screener_shareholding-<period>.json
 *   stocks/{SYM}/screener_peers/{SYM}-screener_peers-<period>.json
 *   stocks/{SYM}/screener_growth/{SYM}-screener_growth-<period>.json
 * and the credit-rating / announcement PDFs under their own docType folders.
 *
 * This pins the real `buildFullDocPath` / `buildStockDocPath` output for the new
 * StockDocTypes so a rename of the doc type or the path convention can't silently
 * move the archive (same precedent as `corporate-actions-gcs-path.test.ts`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFullDocPath,
  buildStockDocPath,
  buildDocFileName,
  type StockDocType,
} from "@usemoney/research/data-sources/stock-document-paths";

describe("Screener section GCS path builders (MONEY-853)", () => {
  it("screener_shareholding JSON snapshot path", () => {
    assert.strictEqual(
      buildFullDocPath(
        "RELIANCE",
        "screener_shareholding",
        "screener-2026",
        "json"
      ),
      "stocks/RELIANCE/screener_shareholding/RELIANCE-screener_shareholding-screener-2026.json"
    );
  });

  it("screener_peers JSON snapshot path", () => {
    assert.strictEqual(
      buildFullDocPath("TCS", "screener_peers", "screener-2026", "json"),
      "stocks/TCS/screener_peers/TCS-screener_peers-screener-2026.json"
    );
  });

  it("screener_growth JSON snapshot path", () => {
    assert.strictEqual(
      buildFullDocPath("INFY", "screener_growth", "screener-2026", "json"),
      "stocks/INFY/screener_growth/INFY-screener_growth-screener-2026.json"
    );
  });

  it("upper-cases a lower-cased symbol in both folder and filename", () => {
    assert.strictEqual(
      buildFullDocPath("infy", "screener_peers", "screener-2026", "json"),
      "stocks/INFY/screener_peers/INFY-screener_peers-screener-2026.json"
    );
  });

  it("credit_rating PDF path nests under its own docType folder", () => {
    assert.strictEqual(
      buildFullDocPath("RELIANCE", "credit_rating", "Mar 2024", "pdf"),
      // space in period is sanitized by buildDocFileName? No — only path-illegal
      // chars are. A space is kept.
      "stocks/RELIANCE/credit_rating/RELIANCE-credit_rating-Mar 2024.pdf"
    );
  });

  it("announcement PDF path nests under its own docType folder", () => {
    assert.strictEqual(
      buildFullDocPath("ONGC", "announcement", "2024", "pdf"),
      "stocks/ONGC/announcement/ONGC-announcement-2024.pdf"
    );
  });

  it("buildStockDocPath places the file under the docType folder", () => {
    assert.strictEqual(
      buildStockDocPath(
        "WIPRO",
        "screener_shareholding",
        "WIPRO-screener_shareholding-screener-2026.json"
      ),
      "stocks/WIPRO/screener_shareholding/WIPRO-screener_shareholding-screener-2026.json"
    );
  });

  it("buildDocFileName sanitizes path-illegal chars in the period", () => {
    // A "/" in the period (e.g. a quarter "Q1/2024") must not break the path.
    assert.strictEqual(
      buildDocFileName("RELIANCE", "announcement", "Q1/2024", "pdf"),
      "RELIANCE-announcement-Q1-2024.pdf"
    );
  });

  it("the new docTypes are valid StockDocType values (compile-time + runtime)", () => {
    const types: StockDocType[] = [
      "screener_shareholding",
      "screener_peers",
      "screener_growth",
      "credit_rating",
      "announcement",
    ];
    for (const t of types) {
      const path = buildStockDocPath("HDFCBANK", t, `HDFCBANK-${t}.json`);
      assert.ok(path.includes(`/${t}/`), `path nests under /${t}/`);
    }
  });
});
