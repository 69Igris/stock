/**
 * Research Package - synthesize-report JSON-recovery tests.
 *
 * De-shadowed (MONEY-620 / task 185). The previous version inlined SIX
 * "mirrored" helpers and asserted the copies. Auditing against source
 * (packages/research/src/tools/synthesize-report.ts + compare-stocks.ts)
 * exposed that the shadow had drifted from — and in places FABRICATED —
 * production behaviour:
 *
 *   • `extractFieldsFromTruncated` (shadow) extracted `winner` / `verdict`
 *     and had NO gate. The real `extractFieldsFromTruncatedJson` extracts
 *     score/confidence/recommendation/disclaimer/summary/strengths/risks
 *     ONLY, and returns null unless the text contains `"score"` or
 *     `"recommendation"`. The shadow's winner/verdict tests asserted
 *     behaviour that does not exist.
 *   • `validateReportStructure` (shadow) additionally required non-empty
 *     recommendation/summary. The real one only checks the field TYPES, so
 *     an empty-string recommendation is VALID. The shadow asserted the
 *     opposite.
 *   • `stripExchangeSuffix`, `formatComparisonRec`, `wrapRawTextAsReport`
 *     do not exist as functions in source at all (and the real compare/
 *     synthesize raw-text fallback sets recommendation "N/A", not "HOLD",
 *     per SEBI RA compliance). Those shadow-only helpers are dropped.
 *
 * This file now imports and asserts the REAL exported symbols.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonResponse,
  extractFieldsFromTruncatedJson,
  validateReportStructure,
} from "@usemoney/research/tools/synthesize-report";

describe("parseJsonResponse (real, synthesize-report.ts)", () => {
  it("parses a valid plain JSON object string", () => {
    const r = parseJsonResponse('{"score": 75, "recommendation": "N/A"}');
    assert.strictEqual(r?.score, 75);
    assert.strictEqual(r?.recommendation, "N/A");
  });

  it("parses JSON wrapped in a ```json fenced block", () => {
    const r = parseJsonResponse(
      '```json\n{"score": 80, "summary": "Great stock"}\n```'
    );
    assert.strictEqual(r?.score, 80);
    assert.strictEqual(r?.summary, "Great stock");
  });

  it("parses JSON wrapped in a bare ``` fenced block", () => {
    const r = parseJsonResponse(
      '```\n{"recommendation": "N/A", "confidence": 60}\n```'
    );
    assert.strictEqual(r?.recommendation, "N/A");
    assert.strictEqual(r?.confidence, 60);
  });

  it("recovers a complete object from an unclosed fence", () => {
    const r = parseJsonResponse(
      '```json\n{"score": 55, "recommendation": "N/A"}'
    );
    assert.strictEqual(r?.score, 55);
    assert.strictEqual(r?.recommendation, "N/A");
  });

  it("returns null for plain English prose", () => {
    assert.strictEqual(
      parseJsonResponse("This is just plain English text"),
      null
    );
  });

  it("returns null for an empty string", () => {
    assert.strictEqual(parseJsonResponse(""), null);
  });

  it("parses an object with leading/trailing whitespace", () => {
    const r = parseJsonResponse('  \n  {"score": 65}  \n  ');
    assert.strictEqual(r?.score, 65);
  });

  it("preserves nested objects", () => {
    const r = parseJsonResponse(
      JSON.stringify({
        score: 72,
        comparisonMeta: { winner: "RELIANCE", stocks: ["RELIANCE", "IOC"] },
      })
    );
    const meta = r?.comparisonMeta as Record<string, unknown>;
    assert.strictEqual(meta.winner, "RELIANCE");
  });

  it("extracts an embedded {…} object surrounded by prose", () => {
    const r = parseJsonResponse(
      'Here is the analysis: {"score": 68, "recommendation": "N/A"} End.'
    );
    assert.strictEqual(r?.score, 68);
  });

  it("preserves unicode in string values", () => {
    const r = parseJsonResponse(
      '{"summary": "Revenue ₹1.2L Cr, margins improving"}'
    );
    assert.ok(String(r?.summary).includes("₹"));
  });

  it("returns null for unrecoverable malformed JSON without score/recommendation", () => {
    // `{score: 75}` has an unquoted key → JSON.parse fails, the `{…}` slice
    // also fails, and truncated recovery is gated off (no `"score"` token).
    assert.strictEqual(parseJsonResponse("{score: 75}"), null);
  });

  it("falls back to truncated-field recovery on a cut-off object", () => {
    // Real path #3: not valid JSON, but contains `"score"` → regex recovery.
    const r = parseJsonResponse('{"score": 78, "recommendation": "N/A", "sum');
    assert.strictEqual(r?.score, 78);
    assert.strictEqual(r?.recommendation, "N/A");
  });
});

describe("extractFieldsFromTruncatedJson (real)", () => {
  it("requires a score or recommendation token, else returns null", () => {
    assert.strictEqual(
      extractFieldsFromTruncatedJson('"sections": [{"title": "Overview"}]'),
      null
    );
    assert.strictEqual(
      extractFieldsFromTruncatedJson("Here is my analysis of the market."),
      null
    );
  });

  it("extracts an integer score", () => {
    const r = extractFieldsFromTruncatedJson('{"score": 78, "recommendation":');
    assert.strictEqual(r?.score, 78);
  });

  it("extracts a decimal score as a number", () => {
    const r = extractFieldsFromTruncatedJson(
      '"score": 82.5, rest of truncated json'
    );
    assert.strictEqual(r?.score, 82.5);
  });

  it("extracts the recommendation string", () => {
    const r = extractFieldsFromTruncatedJson(
      '"score": 90, "recommendation": "N/A"'
    );
    assert.strictEqual(r?.recommendation, "N/A");
  });

  it("extracts confidence + disclaimer", () => {
    const r = extractFieldsFromTruncatedJson(
      '"score": 70, "confidence": 85, "disclaimer": "Not investment advice"'
    );
    assert.strictEqual(r?.confidence, 85);
    assert.strictEqual(r?.disclaimer, "Not investment advice");
  });

  it('extracts a summary field (un-escapes \\n and \\")', () => {
    const r = extractFieldsFromTruncatedJson(
      '"score": 70, "summary": "Line 1\\nLine 2 said \\"hi\\""'
    );
    assert.ok(String(r?.summary).includes("Line 1\nLine 2"));
    assert.ok(String(r?.summary).includes('said "hi"'));
  });

  it("extracts string arrays (strengths / risks)", () => {
    const r = extractFieldsFromTruncatedJson(
      '"score": 60, "strengths": ["Moat", "Low debt"], "risks": ["Cyclical"]'
    );
    assert.deepStrictEqual(r?.strengths, ["Moat", "Low debt"]);
    assert.deepStrictEqual(r?.risks, ["Cyclical"]);
  });

  it("does NOT extract winner/verdict (not real fields)", () => {
    const r = extractFieldsFromTruncatedJson(
      '"score": 65, "winner": "TCS", "verdict": "TCS leads"'
    );
    // Gate passes (has "score"), but winner/verdict are never parsed.
    assert.strictEqual(r?.winner, undefined);
    assert.strictEqual(r?.verdict, undefined);
    assert.strictEqual(r?.score, 65);
  });

  it("handles score = 0 and score = 100", () => {
    assert.strictEqual(
      extractFieldsFromTruncatedJson('"score": 0, "recommendation": "N/A"')
        ?.score,
      0
    );
    assert.strictEqual(
      extractFieldsFromTruncatedJson('"score": 100, "recommendation": "N/A"')
        ?.score,
      100
    );
  });

  it("tolerates extra whitespace around the colon", () => {
    const r = extractFieldsFromTruncatedJson(
      '"score"  :  42  , "recommendation": "N/A"'
    );
    assert.strictEqual(r?.score, 42);
  });
});

describe("validateReportStructure (real)", () => {
  it("true when score(number) + recommendation(string) + summary(string)", () => {
    assert.strictEqual(
      validateReportStructure({
        score: 75,
        recommendation: "N/A",
        summary: "Solid",
      }),
      true
    );
  });

  it("true even when recommendation/summary are EMPTY strings (type-only check)", () => {
    // Divergence the shadow hid: real validator does NOT require non-empty.
    assert.strictEqual(
      validateReportStructure({ score: 75, recommendation: "", summary: "" }),
      true
    );
  });

  it("true when score is 0", () => {
    assert.strictEqual(
      validateReportStructure({
        score: 0,
        recommendation: "N/A",
        summary: "Weak",
      }),
      true
    );
  });

  it("false when score is missing or a string", () => {
    assert.strictEqual(
      validateReportStructure({ recommendation: "N/A", summary: "x" }),
      false
    );
    assert.strictEqual(
      validateReportStructure({
        score: "75",
        recommendation: "N/A",
        summary: "x",
      }),
      false
    );
  });

  it("false when recommendation is missing or non-string", () => {
    assert.strictEqual(
      validateReportStructure({ score: 70, summary: "x" }),
      false
    );
    assert.strictEqual(
      validateReportStructure({
        score: 70,
        recommendation: 42 as unknown as string,
        summary: "x",
      }),
      false
    );
  });

  it("false for an empty object", () => {
    assert.strictEqual(validateReportStructure({}), false);
  });
});
