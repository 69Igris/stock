/**
 * Pure dispatcher logic for {@link AnalysisSegmentsRenderer} (MONEY-543),
 * extracted from the "use client" component so the branch decision, report
 * parsing, block narrowing, supported-type gate, sort, and placeholder copy are
 * unit-testable. The component imports and uses every export here — there is one
 * implementation of each, exercised by both production and the tests.
 */

import type { ContentBlock } from "@usemoney/types";
import type { StructuredReport } from "./types";

export type { StructuredReport };

/**
 * Shape written by `workers/src/processors/l3-analysis.ts` into
 * `analysisSession.contentBlocks[]`. Defined here (the pure logic module) and
 * re-exported by AnalysisSegmentsRenderer so its existing importers
 * (client.tsx, ComparisonResult.tsx) are unaffected.
 */
export interface SegmentResult {
  segmentId: string;
  segmentName: string;
  report?: unknown;
  contentBlocks?: unknown[];
  status?: string;
  error?: string;
  isSynthesis?: boolean;
}

/** The render branch a segment falls into. */
export type SegmentBranch = "failed" | "structured" | "blocks" | "empty";

/**
 * Unwrap a `{ content: ... }` envelope (object or JSON string); otherwise treat
 * the value itself as the report. Returns null for non-objects.
 */
export function parseStructuredReport(raw: unknown): StructuredReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.content && typeof r.content === "object") {
    return r.content as StructuredReport;
  }
  if (typeof r.content === "string") {
    try {
      const inner = JSON.parse(r.content);
      if (inner && typeof inner === "object") {
        return inner as StructuredReport;
      }
    } catch {
      // Fall through and try the wrapper itself.
    }
  }
  return r as StructuredReport;
}

/** A report is "structured" if it has at least one of score / summary / sections. */
export function isStructuredReport(report: StructuredReport | null): boolean {
  if (!report) return false;
  return (
    typeof report.score === "number" ||
    typeof report.summary === "string" ||
    (Array.isArray(report.sections) && report.sections.length > 0)
  );
}

/** Narrow an unknown (Prisma JSON) to a ContentBlock by its `type` discriminant. */
export function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && v.type.length > 0;
}

/**
 * The block types that have a renderer on a PERSISTED analysis result. The
 * chat-interactive types (action / research-prompt / research-stream / refusal)
 * are intentionally excluded — they're live controls, not persisted content.
 */
export const SUPPORTED_ANALYSIS_BLOCK_TYPES = new Set<ContentBlock["type"]>([
  "text",
  "table",
  "card",
  "chart",
  "navigation",
  "comparison",
  "stock-list",
  "error",
]);

/** True when a block type renders on an analysis result. */
export function isSupportedAnalysisBlockType(type: string): boolean {
  return SUPPORTED_ANALYSIS_BLOCK_TYPES.has(type as ContentBlock["type"]);
}

/**
 * Which render branch a segment falls into. Precedence (mirrors SegmentBody):
 *   1. failed — status "failed" (case-insensitive) OR any non-empty error
 *   2. structured — parseStructuredReport → isStructuredReport
 *   3. blocks — any contentBlocks entry passes isContentBlock
 *   4. empty — otherwise (synthesis marker or genuinely empty)
 */
export function decideSegmentBranch(segment: SegmentResult): SegmentBranch {
  const status = (segment.status || "").toLowerCase();
  if (status === "failed" || !!segment.error) return "failed";

  if (isStructuredReport(parseStructuredReport(segment.report))) {
    return "structured";
  }

  const blocks = Array.isArray(segment.contentBlocks)
    ? segment.contentBlocks.filter(isContentBlock)
    : [];
  if (blocks.length > 0) return "blocks";

  return "empty";
}

/**
 * Sort segments by `segmentId` (functional — never mutates input). MONEY-543
 * BUG-3: `?? ""` narrows a missing/undefined id to "" so the comparator never
 * calls `undefined.localeCompare(...)` (which threw and crashed /analysis).
 */
export function sortSegments(segments: SegmentResult[]): SegmentResult[] {
  return [...segments].sort((a, b) =>
    (a.segmentId ?? "").localeCompare(b.segmentId ?? "")
  );
}

/**
 * Body copy for the final empty placeholder; flips on the synthesis marker.
 * (For a synthesis segment whose report is a non-empty string the component
 * renders the summary paragraphs instead — this is the no-body fallback.)
 */
export function emptyPlaceholderText(segment: SegmentResult): string {
  return segment.isSynthesis
    ? "Executive summary unavailable for this run."
    : "No content available for this segment.";
}
