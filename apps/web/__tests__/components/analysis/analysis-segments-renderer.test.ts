/**
 * MONEY-543 - AnalysisSegmentsRenderer dispatcher tests.
 *
 * De-shadowed (MONEY-620): imports the REAL dispatcher logic from
 * components/analysis/analysis-segments-logic.ts, which AnalysisSegmentsRenderer
 * uses (decideSegmentBranch picks the branch, isSupportedAnalysisBlockType gates
 * the block switch, sortSegments orders, emptyPlaceholderText copies, plus the
 * parse/narrow helpers).
 *
 * Two real divergences the old inline shadow hid:
 *   1. It used a `pickBlockRenderer(type) → renderer-name` map that did not exist
 *      in source; the component switches on JSX. The real gate is the
 *      SUPPORTED_ANALYSIS_BLOCK_TYPES set / isSupportedAnalysisBlockType — now
 *      load-bearing (the block list is filtered through it before dispatch).
 *   2. Its emptyPlaceholderText synthesis copy was "Executive synthesis renders
 *      in the page header above." — the REAL component renders "Executive
 *      summary unavailable for this run." for a synthesis segment with no body.
 *      Pinned correctly here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseStructuredReport,
  isStructuredReport,
  isContentBlock,
  isSupportedAnalysisBlockType,
  SUPPORTED_ANALYSIS_BLOCK_TYPES,
  decideSegmentBranch,
  sortSegments,
  emptyPlaceholderText,
  type SegmentResult,
  type StructuredReport,
} from "../../../components/analysis/analysis-segments-logic";

describe("AnalysisSegmentsRenderer - dispatcher logic", () => {
  // ══════════════════════ Sort order ══════════════════════

  describe("sortSegments", () => {
    it("sorts segments by segmentId via localeCompare", () => {
      const out = sortSegments([
        { segmentId: "s2", segmentName: "Two" },
        { segmentId: "s1", segmentName: "One" },
        { segmentId: "s3", segmentName: "Three" },
      ]);
      assert.deepStrictEqual(
        out.map((s) => s.segmentId),
        ["s1", "s2", "s3"]
      );
    });

    it("does not mutate the input array (functional sort)", () => {
      const input: SegmentResult[] = [
        { segmentId: "z", segmentName: "Z" },
        { segmentId: "a", segmentName: "A" },
      ];
      const before = input.map((s) => s.segmentId);
      sortSegments(input);
      assert.deepStrictEqual(
        input.map((s) => s.segmentId),
        before
      );
    });

    it("preserves both entries on duplicate segmentIds", () => {
      const out = sortSegments([
        { segmentId: "s1", segmentName: "First" },
        { segmentId: "s1", segmentName: "Second" },
        { segmentId: "s2", segmentName: "Two" },
      ]);
      assert.deepStrictEqual(
        out.map((s) => s.segmentId),
        ["s1", "s1", "s2"]
      );
    });

    it("sorts mixed alpha IDs naturally", () => {
      const out = sortSegments([
        { segmentId: "valuation", segmentName: "Valuation" },
        { segmentId: "business", segmentName: "Business" },
        { segmentId: "financials", segmentName: "Financials" },
      ]);
      assert.deepStrictEqual(
        out.map((s) => s.segmentId),
        ["business", "financials", "valuation"]
      );
    });

    it("returns [] for empty input", () => {
      assert.deepStrictEqual(sortSegments([]), []);
    });

    it("MONEY-543 BUG-3: a missing segmentId sorts to the START without throwing", () => {
      const broken: SegmentResult[] = [
        { segmentName: "broken" } as unknown as SegmentResult,
        { segmentId: "s2", segmentName: "Two" },
        { segmentId: "s1", segmentName: "One" },
      ];
      let out: SegmentResult[] = [];
      assert.doesNotThrow(() => {
        out = sortSegments(broken);
      });
      assert.strictEqual(out.length, 3);
      assert.strictEqual(out[0]!.segmentId, undefined);
      assert.strictEqual(out[1]!.segmentId, "s1");
      assert.strictEqual(out[2]!.segmentId, "s2");
      // Render key stays stable + never contains literal "undefined".
      const renderKey = `${out[0]!.segmentId ?? "no-id"}-0`;
      assert.strictEqual(renderKey, "no-id-0");
      assert.ok(!renderKey.includes("undefined"));
    });

    it("MONEY-543 BUG-3: 5+ segments with a missing id never throw", () => {
      const broken: SegmentResult[] = [
        { segmentId: "a", segmentName: "A" },
        { segmentId: "b", segmentName: "B" },
        { segmentName: "broken" } as unknown as SegmentResult,
        { segmentId: "c", segmentName: "C" },
        { segmentId: "d", segmentName: "D" },
      ];
      assert.doesNotThrow(() => sortSegments(broken));
      const out = sortSegments(broken);
      assert.deepStrictEqual(
        out.map((s) => s.segmentId),
        [undefined, "a", "b", "c", "d"]
      );
    });
  });

  // ══════════════════════ Branch 1 - Failed ══════════════════════

  describe("decideSegmentBranch — failed", () => {
    it("FAILED (uppercase) status → failed", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Business",
          status: "FAILED",
          error: "Inner agent threw",
        }),
        "failed"
      );
    });

    it("lowercase failed status → failed", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s2",
          segmentName: "Financials",
          status: "failed",
        }),
        "failed"
      );
    });

    it("error present but status absent → failed", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s3",
          segmentName: "Valuation",
          error: "Tool timeout",
        }),
        "failed"
      );
    });

    it("non-terminal status (in_progress/pending) with no payload → empty, not failed", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Business",
          status: "in_progress",
        }),
        "empty"
      );
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Business",
          status: "pending",
        }),
        "empty"
      );
    });

    it("empty-string error does NOT trigger failed (!!'' is false)", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Business",
          error: "",
        }),
        "empty"
      );
    });
  });

  // ══════════════════════ Branch 2 - Structured ══════════════════════

  describe("decideSegmentBranch — structured", () => {
    it("score + summary + sections → structured", () => {
      const seg: SegmentResult = {
        segmentId: "s1",
        segmentName: "Business",
        status: "completed",
        report: {
          score: 75,
          summary: "Strong business model.",
          sections: [{ title: "Moat", type: "text", content: "Wide moat" }],
        } satisfies StructuredReport,
      };
      assert.strictEqual(decideSegmentBranch(seg), "structured");
      const parsed = parseStructuredReport(seg.report);
      assert.strictEqual(parsed?.score, 75);
      assert.strictEqual(parsed?.sections?.length, 1);
    });

    it("only score qualifies", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Business",
          report: { score: 50 },
        }),
        "structured"
      );
    });

    it("only summary qualifies", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Business",
          report: { summary: "One-line" },
        }),
        "structured"
      );
    });

    it("{ content: {...} } envelope is unwrapped", () => {
      const seg: SegmentResult = {
        segmentId: "s1",
        segmentName: "Business",
        report: { content: { score: 80, summary: "Wrapped" } },
      };
      assert.strictEqual(decideSegmentBranch(seg), "structured");
      assert.strictEqual(parseStructuredReport(seg.report)?.score, 80);
    });

    it("{ content: '<json>' } string envelope is JSON-parsed", () => {
      const seg: SegmentResult = {
        segmentId: "s1",
        segmentName: "Business",
        report: { content: JSON.stringify({ score: 72, summary: "From str" }) },
      };
      assert.strictEqual(decideSegmentBranch(seg), "structured");
      assert.strictEqual(parseStructuredReport(seg.report)?.score, 72);
    });

    it("empty sections[] / keyMetrics-only do NOT qualify", () => {
      assert.notStrictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "B",
          report: { sections: [] } satisfies StructuredReport,
        }),
        "structured"
      );
      assert.notStrictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "B",
          report: { keyMetrics: [{ label: "PE", value: "22x" }] },
        }),
        "structured"
      );
    });

    it("report=null → empty", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "B",
          report: null,
        }),
        "empty"
      );
    });
  });

  // ══════════════════════ Branch 3 - contentBlocks ══════════════════════

  describe("decideSegmentBranch — blocks + supported-type gate", () => {
    it("a valid text block → blocks", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Notes",
          contentBlocks: [{ type: "text", text: "hello" }],
        }),
        "blocks"
      );
    });

    it("every persisted block type is supported", () => {
      for (const t of [
        "text",
        "table",
        "card",
        "chart",
        "navigation",
        "comparison",
        "stock-list",
        "error",
      ]) {
        assert.ok(
          isSupportedAnalysisBlockType(t),
          `${t} should be a supported analysis block`
        );
      }
      assert.strictEqual(SUPPORTED_ANALYSIS_BLOCK_TYPES.size, 8);
    });

    it("interactive types are NOT supported (filtered before dispatch)", () => {
      for (const t of [
        "action",
        "research-prompt",
        "research-stream",
        "refusal",
      ]) {
        assert.ok(!isSupportedAnalysisBlockType(t), `${t} must be unsupported`);
      }
    });

    it("unknown / empty block type is unsupported", () => {
      assert.ok(!isSupportedAnalysisBlockType("future-block"));
      assert.ok(!isSupportedAnalysisBlockType(""));
    });

    it("null/invalid entries are filtered by isContentBlock; ≥1 valid → blocks", () => {
      const seg: SegmentResult = {
        segmentId: "s1",
        segmentName: "Mixed",
        contentBlocks: [null, undefined, { type: "text", text: "valid" }],
      };
      const kept = (seg.contentBlocks ?? []).filter(isContentBlock);
      assert.strictEqual(kept.length, 1);
      assert.strictEqual(decideSegmentBranch(seg), "blocks");
    });

    it("only-invalid entries → empty", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Garbage",
          contentBlocks: [null, undefined, { payload: 1 }, { type: 42 }],
        }),
        "empty"
      );
    });

    it("an all-interactive-blocks segment is still 'blocks' (renders nothing after the gate)", () => {
      // isContentBlock accepts any non-empty type, so the branch is 'blocks';
      // the supported-type gate then filters them all out → empty render.
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Actions",
          contentBlocks: [
            { type: "action", actionId: "x" },
            { type: "refusal", message: "nope" },
          ],
        }),
        "blocks"
      );
    });

    it("contentBlocks=[] → empty", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Empty",
          contentBlocks: [],
        }),
        "empty"
      );
    });
  });

  // ══════════════════════ Branch 4 - Empty / synthesis ══════════════════════

  describe("emptyPlaceholderText", () => {
    it("synthesis with no body → 'Executive summary unavailable for this run.' (REAL copy)", () => {
      const seg: SegmentResult = {
        segmentId: "z-synth",
        segmentName: "Synthesis",
        isSynthesis: true,
      };
      assert.strictEqual(decideSegmentBranch(seg), "empty");
      assert.strictEqual(
        emptyPlaceholderText(seg),
        "Executive summary unavailable for this run."
      );
    });

    it("non-synthesis empty → 'No content available for this segment.'", () => {
      assert.strictEqual(
        emptyPlaceholderText({
          segmentId: "s1",
          segmentName: "B",
          isSynthesis: false,
        }),
        "No content available for this segment."
      );
    });

    it("isSynthesis omitted → generic copy", () => {
      assert.strictEqual(
        emptyPlaceholderText({ segmentId: "s1", segmentName: "B" }),
        "No content available for this segment."
      );
    });
  });

  // ══════════════════════ Edge cases ══════════════════════

  describe("decideSegmentBranch — precedence", () => {
    it("report (structured) wins over contentBlocks", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Conflict",
          report: { score: 90 },
          contentBlocks: [{ type: "text", text: "ignored" }],
        }),
        "structured"
      );
    });

    it("failed wins over a structured report", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Crashed",
          status: "FAILED",
          error: "Network error",
          report: { score: 60, summary: "Partial" },
        }),
        "failed"
      );
    });

    it("failed wins over contentBlocks", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Crashed",
          status: "FAILED",
          contentBlocks: [{ type: "text", text: "Partial" }],
        }),
        "failed"
      );
    });

    it("report=null AND contentBlocks=[] → empty", () => {
      assert.strictEqual(
        decideSegmentBranch({
          segmentId: "s1",
          segmentName: "Both null",
          report: null,
          contentBlocks: [],
        }),
        "empty"
      );
    });
  });

  // ══════════════════════ Helpers — parseStructuredReport ══════════════════

  describe("parseStructuredReport", () => {
    it("null / non-object primitives → null", () => {
      assert.strictEqual(parseStructuredReport(null), null);
      assert.strictEqual(parseStructuredReport("nope"), null);
      assert.strictEqual(parseStructuredReport(42), null);
      assert.strictEqual(parseStructuredReport(undefined), null);
    });

    it("plain object passes through", () => {
      const raw = { score: 80, summary: "x" };
      assert.deepStrictEqual(parseStructuredReport(raw), raw);
    });

    it("malformed JSON in { content } falls back to the wrapper itself", () => {
      const raw = { content: "{not valid json", score: 55 };
      assert.strictEqual(parseStructuredReport(raw)?.score, 55);
    });

    it("JSON string content that parses to a non-object falls back to the wrapper", () => {
      const parsed = parseStructuredReport({ content: "42" });
      assert.strictEqual(isStructuredReport(parsed), false);
    });
  });

  // ══════════════════════ Helpers — isContentBlock ══════════════════════

  describe("isContentBlock narrower", () => {
    it("true for { type: 'text' } and any non-empty string type", () => {
      assert.strictEqual(isContentBlock({ type: "text" }), true);
      assert.strictEqual(isContentBlock({ type: "future-type" }), true);
    });

    it("false for null / undefined / primitives", () => {
      assert.strictEqual(isContentBlock(null), false);
      assert.strictEqual(isContentBlock(undefined), false);
      assert.strictEqual(isContentBlock("text"), false);
      assert.strictEqual(isContentBlock(42), false);
    });

    it("false when type is missing / empty / non-string", () => {
      assert.strictEqual(isContentBlock({ content: "x" }), false);
      assert.strictEqual(isContentBlock({ type: "" }), false);
      assert.strictEqual(isContentBlock({ type: 42 }), false);
      assert.strictEqual(isContentBlock({ type: null }), false);
    });
  });
});
