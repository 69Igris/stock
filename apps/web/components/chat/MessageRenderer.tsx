"use client";

import type { ContentBlock } from "@usemoney/types";
import { ShieldCheck } from "lucide-react";
import { messageIsAdvisory } from "./message-advisory-gate";
import {
  TextBlockRenderer,
  TableBlockRenderer,
  CardBlockRenderer,
  ChartBlockRenderer,
  ActionBlockRenderer,
  NavigationBlockRenderer,
  ComparisonBlockRenderer,
  StockListBlockRenderer,
  ErrorBlockRenderer,
  RefusalBlockRenderer,
  RoastSummaryBlockRenderer,
  PortfolioBlockRenderer,
  HoldingsBlockRenderer,
  TaxReportBlockRenderer,
  RiskBlockRenderer,
  MutualFundBlockRenderer,
  FireBlockRenderer,
  SectorBlockRenderer,
  TechnicalBlockRenderer,
  NewsBlockRenderer,
  ScorecardBlockRenderer,
  PnlBlockRenderer,
  DividendBlockRenderer,
} from "./blocks";
import ResearchPromptRenderer from "./blocks/ResearchPromptRenderer";
import ResearchStreamRenderer from "./blocks/ResearchStreamRenderer";
import ResearchReport from "@/components/analysis/ResearchReport";
import type { StructuredReport } from "@/components/analysis/types";
import { memo } from "react";

/**
 * Memoized wrapper for the chat-inline full report. <ResearchReport> lazy-loads
 * the heavy TradingView chart behind a Suspense boundary; in the chat that tree
 * re-renders on every streaming/poll tick, which can tear down the lazy Suspense
 * mid chunk-load → React 19's "cleaning up async info that was not on the parent
 * Suspense boundary" warning. memo keeps the report (and its Suspense subtree)
 * stable while its data is unchanged.
 */
const ChatStructuredReport = memo(function ChatStructuredReport({
  report,
  symbol,
  sessionId,
}: {
  report: unknown;
  symbol: string;
  sessionId?: string;
}) {
  return (
    <ResearchReport
      report={report as StructuredReport}
      symbol={symbol}
      sessionId={sessionId ?? ""}
      openHref={
        sessionId ? `/analysis/${encodeURIComponent(sessionId)}` : undefined
      }
    />
  );
});

interface MessageRendererProps {
  blocks: ContentBlock[];
  onConfirmAction?: (
    actionId: string,
    tool: string,
    params: Record<string, unknown>
  ) => void;
  onCancelAction?: (actionId: string) => void;
  onResearchStock?: (symbol: string) => void;
  onLoadReport?: (sessionId: string) => void;
  onSelectResearchOption?: (
    optionId: string,
    tool: string,
    params: Record<string, unknown>,
    actionId?: string
  ) => void;
  onCancelResearchPrompt?: (actionId?: string) => void;
  /** MONEY-295: refusal-block suggestion chip clicked - sends as new message. */
  onSelectSuggestion?: (prompt: string) => void;
  /** MONEY-778: retry an error block (re-runs the turn via regenerate). */
  onRetry?: () => void;
}

/**
 * MONEY-587 (C2): derive a STABLE React key for a block.
 *
 * Keying by array index made React reconcile by position: when a message's
 * `blocks` array is rebuilt with a different length/order (research reconcile,
 * save round-trips, streamed `blocks` events), the element at a given index can
 * flip type, forcing React to unmount the old subtree and mount a new one. For
 * a `chart` block that means the memoized TradingView widget is destroyed and
 * recreated — which re-subscribes its UDF datafeed and re-fires
 * `/api/market/udf/history`. Repeated rebuilds → the observed request flood and
 * a chart that never settles (empty OHLC despite bars returning).
 *
 * Anchoring the key to intrinsic, stable block content (chart symbol, action id,
 * nav target) keeps the widget mounted across re-renders. The `${type}:` prefix
 * plus the index fallback keeps keys unique when a block carries no natural id.
 */
function blockKey(block: ContentBlock, index: number): string {
  switch (block.type) {
    case "chart":
      // Symbol identifies the chart subtree across rebuilds; for data-driven
      // (non-TradingView) charts the title is the stable discriminator.
      return `chart:${block.symbol ?? block.title ?? index}`;
    case "action":
      return `action:${block.actionId}`;
    case "research-stream":
    case "research-prompt":
      return `${block.type}:${block.actionId}`;
    case "roast-summary":
      return `roast:${block.sessionId}`;
    default:
      return `${block.type}:${index}`;
  }
}

export default function MessageRenderer({
  blocks,
  onConfirmAction,
  onCancelAction,
  onResearchStock,
  onLoadReport,
  onSelectResearchOption,
  onCancelResearchPrompt,
  onSelectSuggestion,
  onRetry,
}: MessageRendererProps) {
  if (!blocks || blocks.length === 0) return null;

  const showDisclaimer = messageIsAdvisory(blocks);

  return (
    <div className="space-y-1">
      {blocks.map((block, index) => (
        <BlockRenderer
          key={blockKey(block, index)}
          block={block}
          onConfirmAction={onConfirmAction}
          onCancelAction={onCancelAction}
          onResearchStock={onResearchStock}
          onLoadReport={onLoadReport}
          onSelectResearchOption={onSelectResearchOption}
          onCancelResearchPrompt={onCancelResearchPrompt}
          onSelectSuggestion={onSelectSuggestion}
          onRetry={onRetry}
        />
      ))}
      {showDisclaimer && (
        <div className="mt-3 pt-3 border-t border-[var(--border-default)] flex items-end justify-between gap-3 flex-wrap">
          <p className="flex-1 min-w-[180px] text-[10.5px] leading-relaxed text-[var(--text-muted)]/75 italic">
            AI-generated by StockSage (Google Gemini) — informational analysis
            only, not financial advice. UseMoney is not a SEBI-registered
            Investment Adviser / Research Analyst, and StockSage never places
            trades. Past performance is not indicative of future results.
            Consult a SEBI-registered adviser before acting on any of this
            content.
          </p>
          {/* MONEY-778: design's per-answer trust marker (ss-stream.jsx:150). */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              fontWeight: 700,
              color: "var(--emerald)",
              background: "var(--emerald-bg)",
              border: "1px solid var(--emerald)",
              borderRadius: 999,
              padding: "2px 8px",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <ShieldCheck size={10} /> compliance-checked
          </span>
        </div>
      )}
    </div>
  );
}

function BlockRenderer({
  block,
  onConfirmAction,
  onCancelAction,
  onResearchStock,
  onLoadReport,
  onSelectResearchOption,
  onCancelResearchPrompt,
  onSelectSuggestion,
  onRetry,
}: {
  block: ContentBlock;
  onConfirmAction?: (
    actionId: string,
    tool: string,
    params: Record<string, unknown>
  ) => void;
  onCancelAction?: (actionId: string) => void;
  onResearchStock?: (symbol: string) => void;
  onLoadReport?: (sessionId: string) => void;
  onSelectResearchOption?: (
    optionId: string,
    tool: string,
    params: Record<string, unknown>,
    actionId?: string
  ) => void;
  onCancelResearchPrompt?: (actionId?: string) => void;
  onSelectSuggestion?: (prompt: string) => void;
  onRetry?: () => void;
}) {
  switch (block.type) {
    case "text":
      return <TextBlockRenderer block={block} />;
    case "table":
      return <TableBlockRenderer block={block} />;
    case "card":
      return <CardBlockRenderer block={block} />;
    case "chart":
      return <ChartBlockRenderer block={block} />;
    case "action":
      return (
        <ActionBlockRenderer
          block={block}
          onConfirm={onConfirmAction}
          onCancel={onCancelAction}
        />
      );
    case "navigation":
      return (
        <NavigationBlockRenderer block={block} onLoadReport={onLoadReport} />
      );
    case "comparison":
      return <ComparisonBlockRenderer block={block} />;
    case "stock-list":
      return (
        <StockListBlockRenderer block={block} onResearch={onResearchStock} />
      );
    case "error":
      return <ErrorBlockRenderer block={block} onRetry={onRetry} />;
    case "research-prompt":
      return (
        <ResearchPromptRenderer
          block={block}
          onSelect={(optionId, tool, params) =>
            onSelectResearchOption?.(optionId, tool, params, block.actionId)
          }
          onCancel={() => onCancelResearchPrompt?.(block.actionId)}
        />
      );
    case "research-stream":
      return <ResearchStreamRenderer block={block} />;
    case "structured-report":
      // P6 (MONEY-676): the chat-inline full report renders through the SAME
      // <ResearchReport> as /analysis. Memoized (ChatStructuredReport) so the
      // report's lazy TradingView Suspense stays stable across the chat's
      // streaming re-renders — avoids the React 19 "cleaning up async info…"
      // warning during the chart chunk-load.
      return (
        <ChatStructuredReport
          report={block.report}
          symbol={block.symbol}
          sessionId={block.sessionId}
        />
      );
    case "roast-summary":
      return <RoastSummaryBlockRenderer block={block} />;
    case "refusal":
      return (
        <RefusalBlockRenderer
          block={block}
          onSelectSuggestion={onSelectSuggestion}
        />
      );
    // MONEY-587: typed financial blocks
    case "portfolio":
      return <PortfolioBlockRenderer block={block} />;
    case "holdings":
      return <HoldingsBlockRenderer block={block} />;
    case "tax":
      return <TaxReportBlockRenderer block={block} />;
    case "risk":
      return <RiskBlockRenderer block={block} />;
    case "mf":
      return <MutualFundBlockRenderer block={block} />;
    case "fire":
      return <FireBlockRenderer block={block} />;
    case "sector":
      return <SectorBlockRenderer block={block} />;
    case "technical":
      return <TechnicalBlockRenderer block={block} />;
    case "news":
      return <NewsBlockRenderer block={block} />;
    case "scorecard":
      return <ScorecardBlockRenderer block={block} />;
    case "pnl":
      return <PnlBlockRenderer block={block} />;
    case "dividend":
      return <DividendBlockRenderer block={block} />;
    default:
      return null;
  }
}
