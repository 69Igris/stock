"use client";

/**
 * ComparisonResult — renders a completed `ComparisonSession.result` (MONEY-550).
 *
 * The comparison worker (workers/src/processors/comparison.ts) writes:
 *   result = {
 *     kind, depth, symbols,
 *     report,          // StructuredReport (sections-shaped) OR { content: … }
 *     contentBlocks,   // chat-style ContentBlock[] fallback
 *     completedAt,
 *   }
 *
 * Render strategy (highest-fidelity available wins):
 *   1. report has `sections[]`          → reuse <ResearchReport> chrome.
 *   2. report has L3/L4 `contentBlocks` segments → <AnalysisSegmentsRenderer>.
 *   3. top-level `contentBlocks`         → chat block renderers, one by one.
 *
 * ADDITIONALLY: the cross-fund holdings overlap (compute_holdings_overlap) is
 * surfaced PROMINENTLY at the top, regardless of how the synthesizer wove it
 * into prose. We deep-scan the whole result tree for a value matching the
 * HoldingsOverlapResult shape and, when found, render:
 *   - a "Common holdings" panel (stocks held by >=2 funds, aggregate + per-fund
 *     weight, concentration flag),
 *   - a "Distinct / differentiating" panel per fund,
 *   - the overall overlap % + the SEBI-safe observational flags.
 *
 * SEBI: observation-only. No winner, no buy/sell/hold. Theme-aware via the
 * playful `--ink* / --paper* / --*-text` tokens; AA-contrast text on cream.
 */

import { useMemo } from "react";
import { Layers, GitCompareArrows, AlertTriangle, Info } from "lucide-react";
import type { ContentBlock } from "@usemoney/types";
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
import ResearchReport from "@/components/analysis/ResearchReport";
import AnalysisSegmentsRenderer, {
  type SegmentResult,
} from "@/components/analysis/AnalysisSegmentsRenderer";
import type { StructuredReport } from "@/components/analysis/types";

// ──────────────────────────────────────────────────────────────────
// Holdings-overlap shape (mirrors compute_holdings_overlap result)
// ──────────────────────────────────────────────────────────────────

interface OverlapCommonStock {
  key: string;
  name: string;
  sector: string | null;
  fundCount: number;
  perFund: Array<{ fundId: string; weight: number }>;
  aggregateWeight: number;
  avgWeight: number;
}

interface OverlapDistinctHolding {
  key: string;
  name: string;
  weight: number;
  sector: string | null;
}

interface OverlapDistinctFund {
  fundId: string;
  holdings: OverlapDistinctHolding[];
}

interface HoldingsOverlapResult {
  available: boolean;
  reason?: string;
  fundCount?: number;
  fundIds?: string[];
  common: OverlapCommonStock[];
  commonStockCount?: number;
  distinct: OverlapDistinctFund[];
  overallOverlapPct?: number;
  commonWeightShareByFund?: Array<{ fundId: string; sharePct: number }>;
  flags: string[];
}

// ──────────────────────────────────────────────────────────────────
// Props + result shape
// ──────────────────────────────────────────────────────────────────

export interface ComparisonResultData {
  kind?: string;
  depth?: string;
  symbols?: string[];
  report?: unknown;
  contentBlocks?: unknown[];
  completedAt?: string;
  [key: string]: unknown;
}

interface ComparisonResultProps {
  /** The raw `ComparisonSession.result` JSON. */
  result: ComparisonResultData | null | undefined;
  /** kind from the session row ("stock" | "mf"); falls back to result.kind. */
  kind?: string;
  /** symbols from the session row; falls back to result.symbols. */
  symbols?: string[];
  /** Per-segment "Ask AI" deep-dive forwarded into <ResearchReport>. */
  onDeepDive?: (query: string) => void;
}

// Aggregate-weight threshold above which a shared name is flagged
// "concentration if held together" (mirrors the compute tool).
const HIGH_AGGREGATE_WEIGHT = 20;

// ──────────────────────────────────────────────────────────────────
// Result normalisation helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Unwrap a possibly-`{ content: … }`-wrapped report into a StructuredReport.
 * Mirrors `parseStructuredReport` in AnalysisSegmentsRenderer.
 */
function parseStructuredReport(raw: unknown): StructuredReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.content && typeof r.content === "object") {
    return r.content as StructuredReport;
  }
  if (typeof r.content === "string") {
    try {
      const inner = JSON.parse(r.content);
      if (inner && typeof inner === "object") return inner as StructuredReport;
    } catch {
      /* fall through */
    }
  }
  return r as StructuredReport;
}

function isStructuredReport(report: StructuredReport | null): boolean {
  if (!report) return false;
  return (
    typeof report.score === "number" ||
    typeof report.summary === "string" ||
    (Array.isArray(report.sections) && report.sections.length > 0)
  );
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && v.type.length > 0;
}

/**
 * Some L3/L4 segment arrays carry `{ segmentId, segmentName, report?,
 * contentBlocks? }` rather than chat blocks. Detect that so we can route to
 * <AnalysisSegmentsRenderer> instead of the per-block renderer.
 */
function isSegmentArray(value: unknown[]): value is SegmentResult[] {
  return value.some(
    (v) =>
      !!v &&
      typeof v === "object" &&
      ("segmentId" in (v as object) || "segmentName" in (v as object)),
  );
}

/**
 * Detect a HoldingsOverlapResult-shaped object: it always carries `common`
 * (array) + `distinct` (array) + `flags` (array) + an `available` boolean.
 * `available:false` (graceful degradation) is still surfaced — we show the
 * neutral "couldn't decompose holdings" note so the user knows it ran.
 */
function isOverlapShape(value: unknown): value is HoldingsOverlapResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.available === "boolean" &&
    Array.isArray(v.common) &&
    Array.isArray(v.distinct) &&
    Array.isArray(v.flags)
  );
}

/**
 * Walk the result tree (bounded depth) and return the first holdings-overlap
 * payload. The synthesizer may stash it under `report.content.overlap`,
 * inside a tool-result block, or anywhere in the scratchpad — so we search
 * defensively rather than assuming a single canonical path.
 */
function findHoldingsOverlap(
  root: unknown,
  depth = 0,
): HoldingsOverlapResult | null {
  if (depth > 6 || root === null || typeof root !== "object") return null;
  if (isOverlapShape(root)) return root;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findHoldingsOverlap(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const val of Object.values(root as Record<string, unknown>)) {
    if (val && typeof val === "object") {
      const found = findHoldingsOverlap(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

/** Shorten a long fund id / scheme code for a column header. */
function shortLabel(id: string, max = 14): string {
  return id.length > max ? `${id.slice(0, max)}…` : id;
}

// Column palette matching the synchronous CompareClient.
const FUND_COLORS = ["#16a34a", "#3b82f6", "#fbbf24", "#ff6b35", "#a78bfa"];

// ──────────────────────────────────────────────────────────────────
// Holdings-overlap panels
// ──────────────────────────────────────────────────────────────────

function HoldingsOverlapPanels({
  overlap,
}: {
  overlap: HoldingsOverlapResult;
}) {
  // Stable fund order for columns: prefer fundIds, else derive from distinct.
  const fundIds =
    overlap.fundIds && overlap.fundIds.length > 0
      ? overlap.fundIds
      : overlap.distinct.map((d) => d.fundId);

  const colorFor = (fundId: string): string => {
    const idx = fundIds.indexOf(fundId);
    return FUND_COLORS[idx >= 0 ? idx % FUND_COLORS.length : 0];
  };

  const shareByFund = overlap.commonWeightShareByFund ?? [];

  // available:false → neutral degradation note (still tells the user it ran).
  if (!overlap.available) {
    return (
      <section className="pf-card" style={{ padding: 20, marginBottom: 18 }}>
        <div className="pf-sec-h" style={{ marginTop: 0 }}>
          <span className="n">OVERLAP</span>
          <h3>
            Holdings <span className="ser">overlap.</span>
          </h3>
          <span className="rule" />
        </div>
        <div
          className="flex items-start gap-2.5"
          style={{ fontSize: 13.5, color: "var(--ink-3)" }}
        >
          <Info
            className="h-4 w-4 shrink-0"
            style={{ marginTop: 2, color: "var(--ink-3)" }}
          />
          <p style={{ lineHeight: 1.5 }}>
            Couldn&apos;t decompose constituent holdings for these funds
            {overlap.reason ? ` (${overlap.reason})` : ""}. The side-by-side
            analysis below still applies.
          </p>
        </div>
      </section>
    );
  }

  const hasCommon = overlap.common.length > 0;
  const hasDistinct = overlap.distinct.some((d) => d.holdings.length > 0);

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Overlap headline + per-fund common-weight share */}
      <section className="pf-card" style={{ padding: 20, marginBottom: 14 }}>
        <div className="pf-sec-h" style={{ marginTop: 0 }}>
          <span className="n">OVERLAP</span>
          <h3>
            How much do they <span className="ser">share?</span>
          </h3>
          <span className="rule" />
          {typeof overlap.overallOverlapPct === "number" && (
            <span className="meta">
              {overlap.overallOverlapPct.toFixed(1)}% avg weight overlap
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 mb-3">
          <div
            className="h-10 w-10 rounded-[11px] grid place-items-center border-[1.5px] border-[var(--ink)] shrink-0"
            style={{ background: "var(--paper-2)", color: "var(--emerald-text)" }}
          >
            <GitCompareArrows className="h-5 w-5" />
          </div>
          <p
            style={{
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontSize: 16,
              color: "var(--ink-2)",
              lineHeight: 1.4,
            }}
          >
            {overlap.commonStockCount ?? overlap.common.length} name
            {(overlap.commonStockCount ?? overlap.common.length) === 1
              ? ""
              : "s"}{" "}
            appear in two or more of the compared funds. Higher overlap means
            less diversification benefit from holding them together.
          </p>
        </div>

        {/* Per-fund: % of own weight that sits in the shared set */}
        {shareByFund.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 10,
              marginTop: 4,
            }}
          >
            {shareByFund.map((s) => (
              <div
                key={s.fundId}
                className="pf-card flat"
                style={{ padding: "10px 12px", background: "var(--paper-2)" }}
              >
                <div
                  className="flex items-center gap-1.5"
                  style={{ marginBottom: 4 }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: colorFor(s.fundId),
                      flexShrink: 0,
                    }}
                  />
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {shortLabel(s.fundId, 18)}
                  </span>
                </div>
                <div
                  className="num"
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    color: "var(--ink)",
                    letterSpacing: "-0.4px",
                  }}
                >
                  {s.sharePct.toFixed(1)}%
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  in shared names
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Common holdings table */}
      {hasCommon && (
        <section
          className="pf-card"
          style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}
        >
          <div className="pf-sec-h" style={{ margin: "16px 18px 0" }}>
            <span className="n">COMMON</span>
            <h3>
              Held by <span className="ser">two or more.</span>
            </h3>
            <span className="rule" />
            <span className="meta">{overlap.common.length} shared</span>
          </div>
          <div style={{ overflowX: "auto", padding: "8px 0 4px" }}>
            <table className="pf-tbl">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 18 }}>HOLDING</th>
                  <th>SECTOR</th>
                  <th style={{ textAlign: "right" }}>FUNDS</th>
                  <th style={{ textAlign: "right" }}>PER-FUND WEIGHT</th>
                  <th style={{ textAlign: "right", paddingRight: 18 }}>
                    AGGREGATE
                  </th>
                </tr>
              </thead>
              <tbody>
                {overlap.common.slice(0, 25).map((c) => {
                  const concentrated =
                    c.aggregateWeight >= HIGH_AGGREGATE_WEIGHT;
                  return (
                    <tr key={c.key}>
                      <td style={{ paddingLeft: 18 }}>
                        <span className="tk">{c.name}</span>
                      </td>
                      <td>
                        <span
                          className="pf-pill outline"
                          style={{ fontSize: 9.5 }}
                        >
                          {c.sector ?? "—"}
                        </span>
                      </td>
                      <td
                        className="num"
                        style={{ textAlign: "right", color: "var(--ink-3)" }}
                      >
                        {c.fundCount}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <span
                          style={{
                            display: "inline-flex",
                            gap: 8,
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                          }}
                        >
                          {c.perFund.map((pf) => (
                            <span
                              key={`${c.key}-${pf.fundId}`}
                              className="num"
                              style={{
                                fontFamily: "JetBrains Mono, monospace",
                                fontSize: 11.5,
                                color: "var(--ink-2)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                              }}
                              title={pf.fundId}
                            >
                              <span
                                style={{
                                  width: 7,
                                  height: 7,
                                  borderRadius: 99,
                                  background: colorFor(pf.fundId),
                                }}
                              />
                              {pf.weight.toFixed(2)}%
                            </span>
                          ))}
                        </span>
                      </td>
                      <td
                        className="num"
                        style={{
                          textAlign: "right",
                          paddingRight: 18,
                          fontWeight: 700,
                          color: concentrated
                            ? "var(--pop-1-text)"
                            : "var(--ink)",
                        }}
                      >
                        {c.aggregateWeight.toFixed(2)}%
                        {concentrated && (
                          <AlertTriangle
                            className="inline h-3 w-3"
                            style={{
                              marginLeft: 4,
                              color: "var(--pop-1-text)",
                              verticalAlign: -1,
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {overlap.common.length > 25 && (
            <div
              style={{
                padding: "8px 18px 14px",
                fontSize: 11.5,
                color: "var(--ink-3)",
              }}
            >
              + {overlap.common.length - 25} more shared name
              {overlap.common.length - 25 === 1 ? "" : "s"}
            </div>
          )}
        </section>
      )}

      {/* Distinct / differentiating per fund */}
      {hasDistinct && (
        <section style={{ marginBottom: 14 }}>
          <div className="pf-sec-h">
            <span className="n">DISTINCT</span>
            <h3>
              Only in <span className="ser">one fund.</span>
            </h3>
            <span className="rule" />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 14,
            }}
          >
            {overlap.distinct.map((d) => {
              if (d.holdings.length === 0) return null;
              const color = colorFor(d.fundId);
              return (
                <div key={d.fundId} className="pf-card" style={{ padding: 16 }}>
                  <h4
                    style={{
                      fontWeight: 700,
                      fontSize: 13,
                      marginBottom: 10,
                      color: "var(--ink)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      className="mono"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={d.fundId}
                    >
                      {shortLabel(d.fundId, 24)}
                    </span>
                    <span
                      className="pf-pill outline"
                      style={{ fontSize: 9, marginLeft: "auto" }}
                    >
                      {d.holdings.length} unique
                    </span>
                  </h4>
                  <div>
                    {d.holdings.slice(0, 12).map((h) => (
                      <div
                        key={h.key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 0",
                          borderBottom: "1px dashed var(--rule-soft)",
                          fontSize: 13,
                        }}
                      >
                        <span
                          style={{
                            color: "var(--ink-2)",
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {h.name}
                        </span>
                        <span
                          className="num"
                          style={{
                            fontFamily: "JetBrains Mono, monospace",
                            color: "var(--ink-3)",
                            flexShrink: 0,
                            marginLeft: 8,
                          }}
                        >
                          {pct(h.weight)}
                        </span>
                      </div>
                    ))}
                    {d.holdings.length > 12 && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--ink-3)",
                          paddingTop: 6,
                        }}
                      >
                        + {d.holdings.length - 12} more
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* SEBI-safe observational flags */}
      {overlap.flags.length > 0 && (
        <section
          className="pf-card"
          style={{ padding: 18, background: "var(--paper-2)" }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1.2,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Observations
          </div>
          <ul style={{ display: "grid", gap: 8, margin: 0, padding: 0 }}>
            {overlap.flags.map((flag, i) => (
              <li
                key={i}
                className="flex items-start gap-2.5"
                style={{ listStyle: "none" }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{
                    background: "var(--pop-2-text)",
                    marginTop: 7,
                  }}
                />
                <span
                  style={{
                    fontSize: 13.5,
                    color: "var(--ink-2)",
                    lineHeight: 1.5,
                  }}
                >
                  {flag}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Report body — sections / segments / chat blocks
// ──────────────────────────────────────────────────────────────────

function ReportBody({
  result,
  symbolLabel,
  sessionId,
  onDeepDive,
}: {
  result: ComparisonResultData;
  symbolLabel: string;
  sessionId: string;
  onDeepDive?: (query: string) => void;
}) {
  // 1. Structured report (sections / summary / score) → <ResearchReport>.
  const structured = parseStructuredReport(result.report);
  if (isStructuredReport(structured)) {
    return (
      <ResearchReport
        report={structured as StructuredReport}
        symbol={symbolLabel}
        sessionId={sessionId}
        onDeepDive={onDeepDive}
      />
    );
  }

  // 2. / 3. Fall back to contentBlocks (segment array OR chat blocks).
  const blocks = Array.isArray(result.contentBlocks)
    ? result.contentBlocks
    : [];

  if (blocks.length > 0 && isSegmentArray(blocks)) {
    return (
      <AnalysisSegmentsRenderer
        segments={blocks as SegmentResult[]}
        symbol={symbolLabel}
        sessionId={sessionId}
        onDeepDive={onDeepDive}
      />
    );
  }

  const chatBlocks = blocks.filter(isContentBlock);
  if (chatBlocks.length > 0) {
    return (
      <div className="space-y-3">
        {chatBlocks.map((block, i) => {
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

  // Nothing renderable — neutral note.
  return (
    <div className="pf-card" style={{ padding: 20 }}>
      <p
        style={{
          fontFamily: "Instrument Serif, serif",
          fontStyle: "italic",
          fontSize: 15,
          color: "var(--ink-3)",
        }}
      >
        The comparison completed but produced no detailed write-up.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Top-level
// ──────────────────────────────────────────────────────────────────

export default function ComparisonResult({
  result,
  kind,
  symbols,
  onDeepDive,
}: ComparisonResultProps) {
  const overlap = useMemo(
    () => (result ? findHoldingsOverlap(result) : null),
    [result],
  );

  if (!result) {
    return (
      <div className="pf-card" style={{ padding: 20 }}>
        <p
          style={{
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            fontSize: 15,
            color: "var(--ink-3)",
          }}
        >
          No comparison result available.
        </p>
      </div>
    );
  }

  const resolvedSymbols =
    symbols && symbols.length > 0
      ? symbols
      : Array.isArray(result.symbols)
        ? (result.symbols as string[])
        : [];
  const symbolLabel = resolvedSymbols.join(" vs ");
  const resolvedKind = kind ?? (result.kind as string | undefined) ?? "mf";
  // sessionId is only used by <ResearchReport>/<AnalysisSegmentsRenderer> for
  // per-segment deep-dive CTAs; a stable label is sufficient here.
  const sessionId = `cmp-${resolvedSymbols.join("-") || "result"}`;

  return (
    <div>
      {/* Heading strip */}
      <div className="pf-sec-h" style={{ marginTop: 0, marginBottom: 14 }}>
        <span className="n">
          <Layers
            className="inline h-3 w-3"
            style={{ marginRight: 4, verticalAlign: -1 }}
          />
          DEEP COMPARE
        </span>
        <h3>
          {resolvedKind === "stock" ? "Stocks" : "Funds"},{" "}
          <span className="ser">side by side.</span>
        </h3>
        <span className="rule" />
        {symbolLabel && <span className="meta">{symbolLabel}</span>}
      </div>

      {/* Holdings overlap (prominent, above the prose report) */}
      {overlap && <HoldingsOverlapPanels overlap={overlap} />}

      {/* The synthesized report */}
      <ReportBody
        result={result}
        symbolLabel={symbolLabel || resolvedKind}
        sessionId={sessionId}
        onDeepDive={onDeepDive}
      />
    </div>
  );
}
