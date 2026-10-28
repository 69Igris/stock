/**
 * Stock-document GCS path builders — REAL imports, PURE (no I/O).
 *
 * Covers `packages/research/src/data-sources/stock-document-paths.ts`:
 *   - buildStockDocPath / buildFullDocPath produce the documented
 *     `stocks/{SYMBOL}/{docType}/{filename}` shape, and
 *   - SECURITY: a hostile symbol (`../../x`, slashes, control chars) can NEVER
 *     escape the `stocks/` prefix — the symbol is allow-listed + dot-collapsed so
 *     the path always has exactly the 4 expected segments and never `..`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildStockDocPath,
  buildDocFileName,
  buildFullDocPath,
} from "../src/data-sources/stock-document-paths";

describe("buildDocFileName", () => {
  it("builds SYMBOL-doctype-period.ext, stripping unsafe symbol/period chars", () => {
    assert.equal(
      buildDocFileName("RELIANCE", "annual_report", "FY2024", "pdf"),
      "RELIANCE-annual_report-FY2024.pdf",
    );
    // Period filesystem-unsafe chars → "-"; symbol keeps only [A-Z0-9&].
    assert.equal(
      buildDocFileName("M&M", "quarterly_result", "Q3/2024", "txt"),
      "M&M-quarterly_result-Q3-2024.txt",
    );
  });
});

describe("buildStockDocPath / buildFullDocPath — happy path", () => {
  it("produces stocks/{SYMBOL}/{docType}/{filename}", () => {
    assert.equal(
      buildStockDocPath("reliance", "annual_report", "file.pdf"),
      "stocks/RELIANCE/annual_report/file.pdf",
    );
    assert.equal(
      buildFullDocPath("infy", "quarterly_result", "Q3-2024", "pdf"),
      "stocks/INFY/quarterly_result/INFY-quarterly_result-Q3-2024.pdf",
    );
  });
});

describe("buildStockDocPath — SECURITY: path traversal cannot escape stocks/", () => {
  const hostile: Array<[string, string]> = [
    ["../../etc/passwd", "../../etc/passwd"],
    ["..", ".."],
    ["foo/../bar", "foo/../bar"],
    ["a/b/c", "a/b/c"],
    ["\u0000evil", "nul byte"],
    ["....//....//x", "dot-slash run"],
  ];

  for (const [sym, label] of hostile) {
    it(`neutralises a hostile symbol: ${label}`, () => {
      const p = buildStockDocPath(sym, "annual_report", "f.pdf");
      assert.ok(p.startsWith("stocks/"), `must start with stocks/: ${p}`);
      assert.ok(!p.includes(".."), `must not contain ..: ${p}`);
      // Exactly: stocks / SYMBOL / docType / filename → 4 segments.
      assert.equal(p.split("/").length, 4, `must be 4 segments: ${p}`);
    });
  }

  it("buildFullDocPath stays 4-segment + prefix-locked for a traversal symbol", () => {
    const p = buildFullDocPath("../../secret", "annual_report", "Q1", "txt");
    assert.ok(p.startsWith("stocks/"));
    assert.ok(!p.includes(".."));
    assert.equal(p.split("/").length, 4);
  });

  it("an all-unsafe symbol degrades to a stable UNKNOWN segment (still well-formed)", () => {
    const p = buildStockDocPath("///", "annual_report", "f.pdf");
    assert.equal(p, "stocks/UNKNOWN/annual_report/f.pdf");
  });
});
