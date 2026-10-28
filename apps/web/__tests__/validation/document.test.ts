/**
 * Document Validation Schema Tests
 *
 * Tests for Zod validation schemas for document operations.
 * Imports the REAL exported schemas from packages/validation/src/document.ts
 * (de-shadowed — these are pure zod schemas with no heavy load-time deps, so
 * the production symbol is exercised directly).
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
} from "@usemoney/validation";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocumentCategorySchema", () => {
  const validCategories = [
    "BROKER_STATEMENT",
    "CONTRACT_NOTE",
    "ANNUAL_REPORT",
    "RESEARCH_REPORT",
    "TAX_REPORT",
    "RISK_REPORT",
    "PORTFOLIO_STATEMENT",
    "OTHER",
  ];

  for (const category of validCategories) {
    it(`should accept valid category: ${category}`, () => {
      const result = DocumentCategorySchema.safeParse(category);
      assert.ok(result.success, `Expected ${category} to be valid`);
      assert.strictEqual(result.data, category);
    });
  }

  it("should reject invalid category string", () => {
    const result = DocumentCategorySchema.safeParse("INVALID_CATEGORY");
    assert.ok(!result.success);
  });

  it("should reject empty string", () => {
    const result = DocumentCategorySchema.safeParse("");
    assert.ok(!result.success);
  });

  it("should reject lowercase variant", () => {
    const result = DocumentCategorySchema.safeParse("broker_statement");
    assert.ok(!result.success);
  });
});

describe("DocumentSourceTypeSchema", () => {
  const validTypes = ["UPLOAD", "URL", "NSE_FETCH", "GENERATED"];

  for (const sourceType of validTypes) {
    it(`should accept valid source type: ${sourceType}`, () => {
      const result = DocumentSourceTypeSchema.safeParse(sourceType);
      assert.ok(result.success, `Expected ${sourceType} to be valid`);
      assert.strictEqual(result.data, sourceType);
    });
  }

  it("should reject invalid source type", () => {
    const result = DocumentSourceTypeSchema.safeParse("DOWNLOAD");
    assert.ok(!result.success);
  });

  it("should reject number input", () => {
    const result = DocumentSourceTypeSchema.safeParse(123);
    assert.ok(!result.success);
  });
});

describe("DocumentFilterSchema", () => {
  it("should accept empty object with defaults", () => {
    const result = DocumentFilterSchema.safeParse({});
    assert.ok(result.success);
    assert.strictEqual(result.data!.skip, 0);
    assert.strictEqual(result.data!.limit, 20);
  });

  it("should accept all optional fields", () => {
    const result = DocumentFilterSchema.safeParse({
      category: "TAX_REPORT",
      sourceType: "UPLOAD",
      search: "quarterly",
      skip: 10,
      limit: 50,
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.category, "TAX_REPORT");
    assert.strictEqual(result.data!.sourceType, "UPLOAD");
    assert.strictEqual(result.data!.search, "quarterly");
    assert.strictEqual(result.data!.skip, 10);
    assert.strictEqual(result.data!.limit, 50);
  });

  it("should reject negative skip", () => {
    const result = DocumentFilterSchema.safeParse({ skip: -1 });
    assert.ok(!result.success);
  });

  it("should accept skip of 0", () => {
    const result = DocumentFilterSchema.safeParse({ skip: 0 });
    assert.ok(result.success);
    assert.strictEqual(result.data!.skip, 0);
  });

  it("should reject limit of 0 (not positive)", () => {
    const result = DocumentFilterSchema.safeParse({ limit: 0 });
    assert.ok(!result.success);
  });

  it("should reject limit greater than 100", () => {
    const result = DocumentFilterSchema.safeParse({ limit: 101 });
    assert.ok(!result.success);
  });

  it("should accept limit of exactly 100", () => {
    const result = DocumentFilterSchema.safeParse({ limit: 100 });
    assert.ok(result.success);
    assert.strictEqual(result.data!.limit, 100);
  });

  it("should accept limit of 1", () => {
    const result = DocumentFilterSchema.safeParse({ limit: 1 });
    assert.ok(result.success);
    assert.strictEqual(result.data!.limit, 1);
  });

  it("should reject non-integer skip", () => {
    const result = DocumentFilterSchema.safeParse({ skip: 1.5 });
    assert.ok(!result.success);
  });

  it("should reject non-integer limit", () => {
    const result = DocumentFilterSchema.safeParse({ limit: 10.5 });
    assert.ok(!result.success);
  });

  it("should reject invalid category in filter", () => {
    const result = DocumentFilterSchema.safeParse({ category: "INVALID" });
    assert.ok(!result.success);
  });
});

describe("UploadDocumentSchema", () => {
  it("should accept valid input with all fields", () => {
    const result = UploadDocumentSchema.safeParse({
      title: "Q4 Broker Statement",
      description: "Zerodha broker statement for Q4 FY2025",
      category: "BROKER_STATEMENT",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.title, "Q4 Broker Statement");
    assert.strictEqual(result.data!.category, "BROKER_STATEMENT");
  });

  it("should default category to OTHER", () => {
    const result = UploadDocumentSchema.safeParse({
      title: "My Document",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.category, "OTHER");
  });

  it("should reject empty title", () => {
    const result = UploadDocumentSchema.safeParse({ title: "" });
    assert.ok(!result.success);
    if (!result.success) {
      const titleIssues = result.error.issues.filter((e) =>
        e.path.includes("title")
      );
      assert.ok(titleIssues.length > 0);
    }
  });

  it("should reject title longer than 200 characters", () => {
    const result = UploadDocumentSchema.safeParse({
      title: "A".repeat(201),
    });
    assert.ok(!result.success);
  });

  it("should accept title of exactly 200 characters", () => {
    const result = UploadDocumentSchema.safeParse({
      title: "A".repeat(200),
    });
    assert.ok(result.success);
  });

  it("should reject description longer than 1000 characters", () => {
    const result = UploadDocumentSchema.safeParse({
      title: "Doc",
      description: "B".repeat(1001),
    });
    assert.ok(!result.success);
  });

  it("should accept description of exactly 1000 characters", () => {
    const result = UploadDocumentSchema.safeParse({
      title: "Doc",
      description: "B".repeat(1000),
    });
    assert.ok(result.success);
  });

  it("should allow description to be omitted", () => {
    const result = UploadDocumentSchema.safeParse({ title: "Test" });
    assert.ok(result.success);
    assert.strictEqual(result.data!.description, undefined);
  });
});

describe("ImportUrlSchema", () => {
  it("should accept valid URL", () => {
    const result = ImportUrlSchema.safeParse({
      url: "https://example.com/report.pdf",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.url, "https://example.com/report.pdf");
  });

  it("should reject invalid URL", () => {
    const result = ImportUrlSchema.safeParse({ url: "not-a-url" });
    assert.ok(!result.success);
  });

  it("should reject empty URL", () => {
    const result = ImportUrlSchema.safeParse({ url: "" });
    assert.ok(!result.success);
  });

  it("should allow optional title", () => {
    const result = ImportUrlSchema.safeParse({
      url: "https://example.com/report.pdf",
      title: "Annual Report 2025",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.title, "Annual Report 2025");
  });

  it("should allow title to be omitted", () => {
    const result = ImportUrlSchema.safeParse({
      url: "https://example.com",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.title, undefined);
  });

  it("should default category to OTHER", () => {
    const result = ImportUrlSchema.safeParse({
      url: "https://example.com",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.category, "OTHER");
  });

  it("should accept valid category", () => {
    const result = ImportUrlSchema.safeParse({
      url: "https://example.com",
      category: "RESEARCH_REPORT",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.category, "RESEARCH_REPORT");
  });

  it("should reject title longer than 200 characters", () => {
    const result = ImportUrlSchema.safeParse({
      url: "https://example.com",
      title: "X".repeat(201),
    });
    assert.ok(!result.success);
  });
});

describe("FetchNseDocumentSchema", () => {
  it("should accept valid input", () => {
    const result = FetchNseDocumentSchema.safeParse({
      symbol: "RELIANCE",
      docType: "annual_report",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.symbol, "RELIANCE");
    assert.strictEqual(result.data!.docType, "annual_report");
  });

  it("should accept all valid docTypes", () => {
    const docTypes = ["annual_report", "shareholding", "financial_results"];
    for (const docType of docTypes) {
      const result = FetchNseDocumentSchema.safeParse({
        symbol: "TCS",
        docType,
      });
      assert.ok(result.success, `Expected ${docType} to be valid`);
    }
  });

  it("should reject empty symbol", () => {
    const result = FetchNseDocumentSchema.safeParse({
      symbol: "",
      docType: "annual_report",
    });
    assert.ok(!result.success);
  });

  it("should reject invalid docType", () => {
    const result = FetchNseDocumentSchema.safeParse({
      symbol: "RELIANCE",
      docType: "quarterly_report",
    });
    assert.ok(!result.success);
  });

  it("should reject missing symbol", () => {
    const result = FetchNseDocumentSchema.safeParse({
      docType: "annual_report",
    });
    assert.ok(!result.success);
  });

  it("should reject missing docType", () => {
    const result = FetchNseDocumentSchema.safeParse({
      symbol: "RELIANCE",
    });
    assert.ok(!result.success);
  });
});

describe("GenerateReportSchema", () => {
  it("should accept valid input with type only", () => {
    const result = GenerateReportSchema.safeParse({ type: "tax" });
    assert.ok(result.success);
    assert.strictEqual(result.data!.type, "tax");
  });

  it("should accept all valid types", () => {
    const types = ["tax", "risk", "portfolio_statement"];
    for (const type of types) {
      const result = GenerateReportSchema.safeParse({ type });
      assert.ok(result.success, `Expected ${type} to be valid`);
    }
  });

  it("should reject invalid type", () => {
    const result = GenerateReportSchema.safeParse({
      type: "monthly_summary",
    });
    assert.ok(!result.success);
  });

  it("should accept valid FY format 2025-26", () => {
    const result = GenerateReportSchema.safeParse({
      type: "tax",
      fy: "2025-26",
    });
    assert.ok(result.success);
    assert.strictEqual(result.data!.fy, "2025-26");
  });

  it("should accept valid FY format 2024-25", () => {
    const result = GenerateReportSchema.safeParse({
      type: "risk",
      fy: "2024-25",
    });
    assert.ok(result.success);
  });

  it("should reject FY with only year (2025)", () => {
    const result = GenerateReportSchema.safeParse({
      type: "tax",
      fy: "2025",
    });
    assert.ok(!result.success);
  });

  it("should reject FY with short format (25-26)", () => {
    const result = GenerateReportSchema.safeParse({
      type: "tax",
      fy: "25-26",
    });
    assert.ok(!result.success);
  });

  it("should reject FY with full years (2025-2026)", () => {
    const result = GenerateReportSchema.safeParse({
      type: "tax",
      fy: "2025-2026",
    });
    assert.ok(!result.success);
  });

  it("should allow FY to be omitted", () => {
    const result = GenerateReportSchema.safeParse({ type: "tax" });
    assert.ok(result.success);
    assert.strictEqual(result.data!.fy, undefined);
  });

  it("should reject FY with non-numeric characters", () => {
    const result = GenerateReportSchema.safeParse({
      type: "tax",
      fy: "abcd-ef",
    });
    assert.ok(!result.success);
  });

  it("should reject missing type", () => {
    const result = GenerateReportSchema.safeParse({ fy: "2025-26" });
    assert.ok(!result.success);
  });
});
