import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocResearchPinUrl as buildPinUrl } from "../../app/documents/doc-research-pin";

// MONEY-396 - Document Vault → Research pin. De-shadowed: imports the REAL
// buildDocResearchPinUrl from app/documents/doc-research-pin.ts, which
// DocumentCard.handleResearchPin pushes. Routes to /stocksage (the StockSage
// chat surface; MONEY-581 moved it off /dashboard) with the doc title encoded
// as a research prompt and the doc id forwarded so the composer can hydrate the
// pinned doc.

test("buildPinUrl encodes title verbatim", () => {
  const url = buildPinUrl({ id: "abc-123", title: "Q3 FY26 Results" });
  assert.match(url, /^\/stocksage\?prompt=/);
  assert.match(url, /docId=abc-123/);
  // Title makes it through encoded form
  assert.match(url, /Q3%20FY26%20Results/);
});

test("buildPinUrl tolerates special characters in title + id", () => {
  const url = buildPinUrl({
    id: "doc/with/slashes&ampersand",
    title: 'Report "Q1" & summary',
  });
  // Both fields are URL-encoded so the route stays well-formed
  assert.match(url, /docId=doc%2Fwith%2Fslashes%26ampersand/);
  // Quote + ampersand are encoded
  assert.match(url, /%22Q1%22/);
  assert.match(url, /%26/);
});

test("buildPinUrl produces stable output for identical input", () => {
  const a = buildPinUrl({ id: "x", title: "y" });
  const b = buildPinUrl({ id: "x", title: "y" });
  assert.equal(a, b);
});
