/**
 * DCF null-guard tests (MONEY-295)
 *
 * Bug 8: After research completed, /analysis/[sessionId] crashed with
 *   TypeError: Cannot read properties of null (reading 'toLocaleString')
 *   at app/analysis/[sessionId]/client.tsx:314
 * because the synthesizer emitted a `dcf` object whose scalar fields
 * (intrinsicValue / currentPrice / upside) were null when the DCF tool
 * couldn't produce a valid figure (no FCF data, etc.). The TypeScript
 * type claimed `number` but the runtime saw `null` - a contract
 * violation upstream that crashed the whole page render.
 *
 * Fix: type tightened to `number | null`; both the report renderer
 * (ResearchReport.tsx) and the chat-context builder (client.tsx) now
 * guard each scalar separately and skip / render "-" when null.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDcfContextLine,
  shouldRenderDcfBox,
} from "../../app/analysis/dcf-display";

// De-shadowed (MONEY-620): imports the REAL DCF guards from
// app/analysis/dcf-display.ts. The chat-context builder
// (app/analysis/[sessionId]/client.tsx) calls buildDcfContextLine and
// ResearchReport.tsx gates the DCF tiles on shouldRenderDcfBox — so these
// assertions pin the actual crash-fix code path (MONEY-295 Bug 8).

describe("DCF null-guard - chat context builder", () => {
  it("renders all 3 fields when all are valid numbers", () => {
    const result = buildDcfContextLine({
      intrinsicValue: 1500,
      currentPrice: 1350,
      upside: 11.1,
    });
    assert.ok(result);
    assert.match(result, /Intrinsic Value: ₹1,500/);
    assert.match(result, /Current: ₹1,350/);
    assert.match(result, /Upside: 11\.1%/);
  });

  it("does NOT crash when intrinsicValue is null (the original bug)", () => {
    const result = buildDcfContextLine({
      intrinsicValue: null,
      currentPrice: 1350,
      upside: 11.1,
    });
    assert.ok(result);
    assert.doesNotMatch(result, /Intrinsic Value/);
    assert.match(result, /Current: ₹1,350/);
  });

  it("returns null when ALL DCF fields are null (skip the line entirely)", () => {
    const result = buildDcfContextLine({
      intrinsicValue: null,
      currentPrice: null,
      upside: null,
    });
    assert.equal(result, null);
  });

  it("renders just one field when only one is valid", () => {
    const result = buildDcfContextLine({
      intrinsicValue: 1500,
      currentPrice: null,
      upside: null,
    });
    assert.equal(result, "- DCF Intrinsic Value: ₹1,500");
  });

  it("treats 0 as a valid number (not nullish)", () => {
    const result = buildDcfContextLine({
      intrinsicValue: 0,
      currentPrice: 0,
      upside: 0,
    });
    assert.ok(result);
    assert.match(result, /Intrinsic Value: ₹0/);
    assert.match(result, /Upside: 0\.0%/);
  });

  it("treats negative upside as a valid number (loss case)", () => {
    const result = buildDcfContextLine({
      intrinsicValue: 1200,
      currentPrice: 1500,
      upside: -20.0,
    });
    assert.ok(result);
    assert.match(result, /Upside: -20\.0%/);
  });
});

describe("DCF null-guard - render gate", () => {
  it("hides the box when dcf is undefined", () => {
    assert.equal(shouldRenderDcfBox(undefined), false);
  });

  it("hides the box when all fields are null", () => {
    assert.equal(
      shouldRenderDcfBox({
        intrinsicValue: null,
        currentPrice: null,
        upside: null,
      }),
      false
    );
  });

  it("shows the box when at least one field is a valid number", () => {
    assert.equal(
      shouldRenderDcfBox({
        intrinsicValue: 1500,
        currentPrice: null,
        upside: null,
      }),
      true
    );
  });
});
