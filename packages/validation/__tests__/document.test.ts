/**
 * Negative / edge-case coverage for the REAL exported document Zod schemas.
 *
 * Source: packages/validation/src/document.ts
 *
 * Imports & exercises the actual schemas (no shadow). Covers enum gates, the
 * URL format on ImportUrl, the bounded title/description caps on UploadDocument,
 * the integer/positive/max pagination bounds on DocumentFilter, and the strict
 * `FY` regex (`^\d{4}-\d{2}$`) on GenerateReport.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DocumentCategorySchema,
  DocumentSourceTypeSchema,
  DocumentFilterSchema,
  UploadDocumentSchema,
  ImportUrlSchema,
  FetchNseDocumentSchema,
  GenerateReportSchema,
} from "../src/document.ts";

describe("DocumentCategorySchema / DocumentSourceTypeSchema (real exports)", () => {
  it("accepts a valid category", () => {
    assert.equal(DocumentCategorySchema.safeParse("TAX_REPORT").success, true);
  });

  it("rejects an out-of-enum category", () => {
    assert.equal(DocumentCategorySchema.safeParse("INVOICE").success, false);
  });

  it("rejects an empty-string category", () => {
    assert.equal(DocumentCategorySchema.safeParse("").success, false);
  });

  it("accepts a valid source type", () => {
    assert.equal(DocumentSourceTypeSchema.safeParse("UPLOAD").success, true);
  });

  it("rejects an out-of-enum source type", () => {
    assert.equal(DocumentSourceTypeSchema.safeParse("EMAIL").success, false);
  });
});

describe("DocumentFilterSchema (real export)", () => {
  it("applies skip/limit defaults on empty input", () => {
    const r = DocumentFilterSchema.safeParse({});
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.skip, 0);
    assert.equal(r.data.limit, 20);
  });

  it("rejects negative skip", () => {
    assert.equal(DocumentFilterSchema.safeParse({ skip: -1 }).success, false);
  });

  it("rejects a fractional skip (must be integer)", () => {
    assert.equal(DocumentFilterSchema.safeParse({ skip: 1.5 }).success, false);
  });

  it("rejects zero limit (must be positive)", () => {
    assert.equal(DocumentFilterSchema.safeParse({ limit: 0 }).success, false);
  });

  it("rejects limit above 100", () => {
    assert.equal(DocumentFilterSchema.safeParse({ limit: 101 }).success, false);
  });

  it("accepts limit at the 100 boundary", () => {
    assert.equal(DocumentFilterSchema.safeParse({ limit: 100 }).success, true);
  });

  it("rejects an out-of-enum category filter", () => {
    assert.equal(
      DocumentFilterSchema.safeParse({ category: "NOPE" }).success,
      false,
    );
  });
});

describe("UploadDocumentSchema (real export)", () => {
  it("accepts a valid upload and defaults category to OTHER", () => {
    const r = UploadDocumentSchema.safeParse({ title: "Q3 Statement" });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.category, "OTHER");
  });

  it("rejects empty title (required)", () => {
    assert.equal(UploadDocumentSchema.safeParse({ title: "" }).success, false);
  });

  it("rejects oversized title (> 200 chars)", () => {
    assert.equal(
      UploadDocumentSchema.safeParse({ title: "A".repeat(201) }).success,
      false,
    );
  });

  it("rejects oversized description (> 1000 chars)", () => {
    assert.equal(
      UploadDocumentSchema.safeParse({
        title: "ok",
        description: "A".repeat(1001),
      }).success,
      false,
    );
  });
});

describe("ImportUrlSchema (real export)", () => {
  it("accepts a valid https URL", () => {
    assert.equal(
      ImportUrlSchema.safeParse({ url: "https://example.com/doc.pdf" }).success,
      true,
    );
  });

  it("rejects a non-URL string", () => {
    assert.equal(
      ImportUrlSchema.safeParse({ url: "not a url" }).success,
      false,
    );
  });

  it("rejects an empty url", () => {
    assert.equal(ImportUrlSchema.safeParse({ url: "" }).success, false);
  });

  it("rejects a missing url (required field absent)", () => {
    assert.equal(ImportUrlSchema.safeParse({}).success, false);
  });
});

describe("FetchNseDocumentSchema (real export)", () => {
  it("accepts a valid symbol + docType", () => {
    assert.equal(
      FetchNseDocumentSchema.safeParse({
        symbol: "TCS",
        docType: "annual_report",
      }).success,
      true,
    );
  });

  it("rejects empty symbol", () => {
    assert.equal(
      FetchNseDocumentSchema.safeParse({
        symbol: "",
        docType: "annual_report",
      }).success,
      false,
    );
  });

  it("rejects an out-of-enum docType", () => {
    assert.equal(
      FetchNseDocumentSchema.safeParse({
        symbol: "TCS",
        docType: "balance_sheet",
      }).success,
      false,
    );
  });
});

describe("GenerateReportSchema (real export)", () => {
  it("accepts a valid report type without fy", () => {
    assert.equal(GenerateReportSchema.safeParse({ type: "tax" }).success, true);
  });

  it("accepts a correctly-formatted fy (2025-26)", () => {
    assert.equal(
      GenerateReportSchema.safeParse({ type: "tax", fy: "2025-26" }).success,
      true,
    );
  });

  it("rejects an out-of-enum report type", () => {
    assert.equal(
      GenerateReportSchema.safeParse({ type: "pnl" }).success,
      false,
    );
  });

  it("rejects a malformed fy (wrong format)", () => {
    assert.equal(
      GenerateReportSchema.safeParse({ type: "tax", fy: "2025/2026" }).success,
      false,
    );
  });

  it("rejects a malformed fy (4-digit suffix)", () => {
    assert.equal(
      GenerateReportSchema.safeParse({ type: "tax", fy: "2025-2026" }).success,
      false,
    );
  });
});
