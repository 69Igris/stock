/**
 * URL import naming + content hints (MONEY-1166).
 *
 * Regression cover for MONEY-1154 bug #4 — "paste url doesnt work". Importing
 * a PDF produced a row titled `www.tcs.com` with file name `www.tcs.com.html`,
 * because the action fell back to the URL's HOSTNAME and hard-coded `.html`.
 * Two defects in one: every document from a host collided on a single name,
 * and the row contradicted itself (`documentType: PDF` beside a `.html` name
 * and a `text/html` mime).
 *
 * Source: apps/web/lib/documents/url-identity.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveUrlDocumentIdentity } from "@/lib/documents/url-identity";

// The exact URL from the bug report.
const TCS_PDF =
  "https://www.tcs.com/content/dam/tcs/investor-relations/financial-statements/2025-26/ar/annual-report-2025-2026.pdf";

describe("deriveUrlDocumentIdentity — the reported bug", () => {
  it("names the TCS annual report from the path, not the hostname", () => {
    const id = deriveUrlDocumentIdentity(TCS_PDF);
    assert.equal(id.title, "annual-report-2025-2026.pdf");
    assert.equal(id.fileName, "annual-report-2025-2026.pdf");
  });

  it("never reproduces the old hostname-derived name", () => {
    const id = deriveUrlDocumentIdentity(TCS_PDF);
    assert.notEqual(id.title, "www.tcs.com");
    assert.notEqual(id.fileName, "www.tcs.com.html");
  });

  it("types a PDF URL as a PDF, not text/html", () => {
    const id = deriveUrlDocumentIdentity(TCS_PDF);
    assert.equal(id.mimeType, "application/pdf");
    assert.equal(id.fileType, "PDF");
  });

  it("two documents on the SAME host no longer collide", () => {
    const a = deriveUrlDocumentIdentity(
      "https://www.tcs.com/a/report-2024.pdf"
    );
    const b = deriveUrlDocumentIdentity(
      "https://www.tcs.com/b/report-2025.pdf"
    );
    assert.notEqual(a.title, b.title);
    assert.notEqual(a.fileName, b.fileName);
  });
});

describe("deriveUrlDocumentIdentity — extension hints", () => {
  const cases: Array<[string, string, string]> = [
    ["https://x.com/d/data.csv", "text/csv", "CSV"],
    ["https://x.com/d/chart.png", "image/png", "IMAGE"],
    ["https://x.com/d/photo.jpeg", "image/jpeg", "IMAGE"],
    ["https://x.com/d/book.xlsx", "", "SPREADSHEET"],
    ["https://x.com/d/legacy.xls", "application/vnd.ms-excel", "SPREADSHEET"],
  ];

  for (const [url, mime, fileType] of cases) {
    it(`${url.split("/").pop()} → ${fileType}`, () => {
      const id = deriveUrlDocumentIdentity(url);
      assert.equal(id.fileType, fileType);
      if (mime) assert.equal(id.mimeType, mime);
    });
  }

  it("does NOT append .html to a name that already has an extension", () => {
    // The old code produced `report.pdf.html`-shaped names.
    const id = deriveUrlDocumentIdentity("https://x.com/d/report.pdf");
    assert.equal(id.fileName, "report.pdf");
    assert.ok(!id.fileName.endsWith(".html"));
  });
});

describe("deriveUrlDocumentIdentity — fallbacks", () => {
  it("a path-less URL still falls back to the hostname (the one valid case)", () => {
    const id = deriveUrlDocumentIdentity("https://example.com/");
    assert.equal(id.title, "example.com");
    assert.equal(id.fileName, "example.com.html");
    assert.equal(id.mimeType, "text/html");
  });

  it("an extensionless page keeps the html fallback and the PDF type", () => {
    // DocumentFileType has no HTML member; PDF is the historical fallback and
    // the worker corrects it from the real content-type.
    const id = deriveUrlDocumentIdentity("https://example.com/investors");
    assert.equal(id.title, "investors");
    assert.equal(id.fileName, "investors.html");
    assert.equal(id.fileType, "PDF");
  });

  it("percent-encoded segments decode to a human-readable name", () => {
    const id = deriveUrlDocumentIdentity(
      "https://x.com/d/Annual%20Report%202026.pdf"
    );
    assert.equal(id.title, "Annual Report 2026.pdf");
  });

  it("an unparseable URL degrades instead of throwing", () => {
    const id = deriveUrlDocumentIdentity("not-a-url");
    assert.equal(id.title, "document");
    assert.equal(id.fileName, "document.html");
  });

  it("a trailing slash does not produce an empty name", () => {
    const id = deriveUrlDocumentIdentity("https://example.com/reports/");
    assert.equal(id.title, "reports");
    assert.ok(id.fileName.length > 0);
  });

  it("every field is a non-empty string for any input", () => {
    for (const url of [
      TCS_PDF,
      "https://example.com/",
      "https://example.com/a/b/c",
      "not-a-url",
      "",
    ]) {
      const id = deriveUrlDocumentIdentity(url);
      assert.ok(id.title.length > 0, `empty title for ${url}`);
      assert.ok(id.fileName.length > 0, `empty fileName for ${url}`);
      assert.ok(id.mimeType.length > 0, `empty mimeType for ${url}`);
      assert.ok(id.fileType.length > 0, `empty fileType for ${url}`);
    }
  });
});
