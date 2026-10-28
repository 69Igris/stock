"use client";

/**
 * MONEY-543: L3/L4 segment renderer.
 *
 * L3/L4 comprehensive analyses don't write an outer `report.sections` array
 * (that's the L1/L2 shape). Instead, the worker pipeline (see
 * `workers/src/processors/l3-analysis.ts`) appends one `SegmentResult` per
 * analytical segment into `analysisSession.contentBlocks[]`. Each segment is
 * the output of an inner ResearchAgent run scoped to one skill (business,
 * financials, valuation, peers, …), so the segment itself carries either:
 *   - a structured `report` (StructuredReport — score/summary/sections/…),
 *     produced by `ResearchAgent.buildStructuredReport()`, OR
 *   - a `contentBlocks` array of chat-style blocks (TextBlock, CardBlock, …)
 *     produced by `ResearchAgent.buildContentBlocks()` when the structured
 *     report couldn't be parsed, OR
 *   - an error + non-"completed" status when the segment's inner agent
 *     failed.
 *
 * This component iterates segments in `segmentId` order and dispatches each
 * to the right sub-renderer. We deliberately reuse the existing
 * `ResearchReport` component for structured reports so the visual chrome on
 * /analysis/[sessionId] is identical between L1/L2 and L3/L4 segments —
 * just iterated.
 */

import {
  TextBlockRenderer,
  TableBlockRenderer,
  CardBlockRenderer,
  ChartBlockRenderer,
  NavigationBlockRenderer,
  ComparisonBlockRenderer,
  StockListBlockRenderer,
  ErrorBlockRenderer,
} from "@/components/chat/blocks";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import ResearchReport from "./ResearchReport";
import type { StructuredReport } from "./types";
import {
  parseStructuredReport,
  isStructuredReport,
  isContentBlock,
  isSupportedAnalysisBlockType,
  decideSegmentBranch,
  sortSegments,
  emptyPlaceholderText,
  type SegmentResult,
} from "./analysis-segments-logic";

// Re-export so existing importers (client.tsx, ComparisonResult.tsx) are
// unaffected by the move of the type into the pure logic module.
export type { SegmentResult };

interface AnalysisSegmentsRendererProps {
  segments: SegmentResult[];
  symbol: string;
  sessionId: string;
  /** Forwarded to <ResearchReport> so per-segment "Ask AI" CTAs work. */
  onDeepDive?: (query: string) => void;
}

// ──────────────────────────────────────────────────────────────────
// Per-segment render — dispatcher
//
// Branch decision + report parsing + block narrowing live in
// ./analysis-segments-logic.ts (pure, unit-tested). This component renders
// the JSX for whichever branch decideSegmentBranch returns.
// ──────────────────────────────────────────────────────────────────

/**
 * Render the body of a single segment. Three branches:
 *   1. Failed / non-completed → placeholder card with the error.
 *   2. Has a structured StructuredReport → reuse <ResearchReport>.
 *   3. Has only chat-style contentBlocks → render via chat block
 *      renderers (text / card / table / chart / comparison / etc).
 * Falls back to a "no content" placeholder when none of the above hold.
 */
function SegmentBody({
  segment,
  symbol,
  sessionId,
  onDeepDive,
}: {
  segment: SegmentResult;
  symbol: string;
  sessionId: string;
  onDeepDive?: (query: string) => void;
}) {
  const branch = decideSegmentBranch(segment);

  // Branch 1: explicit failure or non-terminal status.
  if (branch === "failed") {
    return (
      <div
        className="pf-card flat"
        style={{
          background: "var(--paper-2)",
          borderColor: "#b91c1c",
          padding: "20px 18px",
        }}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            className="h-5 w-5 shrink-0 mt-0.5"
            style={{ color: "#b91c1c" }}
          />
          <div className="space-y-1">
            <p
              style={{
                fontFamily: "Instrument Serif, serif",
                fontStyle: "italic",
                fontSize: 15,
                color: "var(--ink-2)",
              }}
            >
              Couldn&apos;t analyse this segment.
            </p>
            {segment.error && (
              <p
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                  wordBreak: "break-word",
                }}
              >
                {segment.error}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Branch 2: structured report — same chrome as L1/L2 via <ResearchReport>.
  if (branch === "structured") {
    const parsed = parseStructuredReport(segment.report);
    return (
      <ResearchReport
        // Non-null asserted: isStructuredReport already guarded against null.
        report={parsed as StructuredReport}
        symbol={symbol}
        sessionId={sessionId}
        onDeepDive={onDeepDive}
      />
    );
  }

  // Branch 3: fall back to chat-style blocks. The worker stashes raw blocks
  // produced by the inner agent — we render each via its existing chat
  // block renderer. Interactive controls (action / research-prompt /
  // research-stream / refusal) aren't expected here and are filtered out via
  // isSupportedAnalysisBlockType before dispatch.
  if (branch === "blocks") {
    const blocks = Array.isArray(segment.contentBlocks)
      ? segment.contentBlocks
          .filter(isContentBlock)
          .filter((b) => isSupportedAnalysisBlockType(b.type))
      : [];
    return (
      <div className="space-y-3">
        {blocks.map((block, i) => {
          switch (block.type) {
            case "text":
              return <TextBlockRenderer key={i} block={block} />;
            case "table":
              return <TableBlockRenderer key={i} block={block} />;
            case "card":
              return <CardBlockRenderer key={i} block={block} />;
            case "chart":
              return <ChartBlockRenderer key={i} block={block} />;
            case "navigation":
              return <NavigationBlockRenderer key={i} block={block} />;
            case "comparison":
              return <ComparisonBlockRenderer key={i} block={block} />;
            case "stock-list":
              return <StockListBlockRenderer key={i} block={block} />;
            case "error":
              return <ErrorBlockRenderer key={i} block={block} />;
            default:
              return null;
          }
        })}
      </div>
    );
  }

  // Final fallback: nothing to show. Synthesis segments are the common
  // case here — the worker writes a marker `{ isSynthesis: true }` for
  // them without a body because the synthesis lives in the outer page
  // header, not as its own card.
  // MONEY-259: the synthesis segment now carries a real plain-English executive
  // summary in `segment.report` (was a no-op marker). Render it as paragraphs.
  if (segment.isSynthesis && typeof segment.report === "string") {
    const text = segment.report.trim();
    if (text) {
      return (
        <div
          className="space-y-3"
          style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6 }}
        >
          {text.split(/\n{2,}/).map((para, i) => (
            <p key={i} style={{ whiteSpace: "pre-wrap" }}>
              {para.trim()}
            </p>
          ))}
        </div>
      );
    }
  }

  return (
    <p
      style={{
        fontFamily: "Instrument Serif, serif",
        fontStyle: "italic",
        fontSize: 14,
        color: "var(--ink-3)",
        padding: "8px 0",
      }}
    >
      {emptyPlaceholderText(segment)}
    </p>
  );
}

// ──────────────────────────────────────────────────────────────────
// Segment header — status pill + name
// ──────────────────────────────────────────────────────────────────

function SegmentHeader({ segment, n }: { segment: SegmentResult; n: number }) {
  const status = (segment.status || "").toLowerCase();
  const failed = status === "failed" || !!segment.error;
  const completed = status === "completed";

  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-2 min-w-0">
        {/* MONEY-778: the design's zero-padded section-number pill (ss.css `.pill`
            inlined, rotated -1.5deg per ss-shared.jsx SectionLabel), identical to
            ResearchReport's header, so L3/L4 research-details number sections the
            same way chat and the L1/L2 report do. */}
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            fontWeight: 700,
            color: "var(--ink)",
            background: "var(--paper)",
            border: "1.5px solid var(--ink)",
            borderRadius: 999,
            padding: "3px 10px",
            lineHeight: 1,
            transform: "rotate(-1.5deg)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {String(n).padStart(2, "0")}
        </span>
        <h2
          className="truncate"
          style={{
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-0.3px",
            color: "var(--ink)",
            margin: 0,
          }}
        >
          {segment.segmentName}
        </h2>
      </div>
      {failed ? (
        <span
          className="pf-pill coral shrink-0 inline-flex items-center"
          style={{ fontSize: 9.5, padding: "2px 8px" }}
        >
          <AlertTriangle className="mr-1 h-3 w-3" />
          Failed
        </span>
      ) : completed ? (
        <span
          className="pf-pill emerald shrink-0 inline-flex items-center"
          style={{ fontSize: 9.5, padding: "2px 8px" }}
        >
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Completed
        </span>
      ) : (
        <span
          className="pf-pill outline shrink-0 inline-flex items-center"
          style={{ fontSize: 9.5, padding: "2px 8px" }}
        >
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          In progress
        </span>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Top-level component
// ──────────────────────────────────────────────────────────────────

export default function AnalysisSegmentsRenderer({
  segments,
  symbol,
  sessionId,
  onDeepDive,
}: AnalysisSegmentsRendererProps) {
  if (!segments || segments.length === 0) return null;

  // Stable order — matches `analysisSession.segments[]` ordering in the
  // worker pipeline. Sort by segmentId so the UI doesn't reshuffle when
  // the worker appends segments in completion order (which can differ
  // from definition order if any retries happened).
  //
  // MONEY-543 BUG-3: sortSegments (./analysis-segments-logic.ts) defensively
  // narrows `segmentId` before localeCompare so a malformed worker write with
  // a missing id sorts to the start instead of throwing and blanking the page.
  const ordered = sortSegments(segments);

  return (
    <div className="space-y-6">
      {ordered.map((segment, i) => (
        <section
          key={`${segment.segmentId ?? "no-id"}-${i}`}
          className="pf-card"
          style={{ padding: 24 }}
        >
          <SegmentHeader segment={segment} n={i + 1} />
          <SegmentBody
            segment={segment}
            symbol={symbol}
            sessionId={sessionId}
            onDeepDive={onDeepDive}
          />
        </section>
      ))}
    </div>
  );
}
