"use client";

/**
 * ResearchReport — StockSage "Playful paper" report renderer (MONEY-587,
 * task #29 / #30). Rebuilt from the old shadcn / Terminal-Luxe card chrome
 * into the paper-ink ss-* design language: a numbered §-section list with a
 * 2px ink top-rule per section, mono/serif typography, emerald-anchored data
 * colour (good/fair/poor never buy/sell), inline [n] citation chips, and a
 * fixed serif-italic dashed-top disclaimer at the very bottom.
 *
 * The data contract is unchanged — this component still consumes a
 * `StructuredReport` (score / summary / keyMetrics / scoreBreakdown /
 * sections[] / strengths / risks / catalysts / technicals / comparisonMeta)
 * exactly as produced by `ResearchAgent.buildStructuredReport()` and reused
 * by AnalysisSegmentsRenderer for L1–L4. Only the rendering changed.
 *
 * SEBI-safe throughout: no BUY/SELL/HOLD verdicts, no labelled price targets,
 * recommendation language scrubbed from stored prose via stripExchangeSuffix.
 */

import Link from "next/link";
import { lazy, Suspense } from "react";
import type { CSSProperties, ReactNode } from "react";
import { PfTradingViewPlaceholder } from "@/components/playful/placeholders";
import { MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { StructuredReport } from "./types";
import { shouldRenderDcfBox } from "@/app/analysis/dcf-display";
import {
  BIcon,
  ScoreDial,
  BarRow,
  KVTable,
  MetricStrip,
  MetricTile,
  ConfidencePill,
  DegradedNote,
  NewsItemCard,
  RadarChart,
  Heatmap,
  FanChart,
  Underwater,
  RangeBar,
  IndicatorRow,
  FlagChip,
  StackedBar,
  type MetricTileItem,
  type KVRow,
  type NewsItem,
  SEBI,
} from "@/components/chat/blocks/ChatBlock";
import { ScorecardBlockRenderer } from "@/components/chat/blocks/TypedFinancialBlocks";
import {
  setHotCitation,
  useCitationState,
} from "@/components/chat/CitationContext";
import type { ScorecardBlock } from "@usemoney/types";
import {
  stripRecommendationLanguage,
  isAdviceAdjacentField,
} from "@usemoney/utils/sanitize-recommendation";
import {
  FundReport,
  CompareReport,
  FundCompareReport,
  detectFundReport,
} from "./FundCompareReport";

// MONEY-650 (B10): the full report opens with an inline candlestick chart, to
// match the chat report. Lazy-loaded (heavy proprietary TradingView widget) so
// it never bloats the report's initial render — same pattern as the chat
// ChartBlockRenderer.
const LazyResearchChart = lazy(() =>
  import("@/components/charts/TradingViewAdvancedChart").then((m) => ({
    default: m.TradingViewAdvancedChart,
  }))
);

/* ──────────────────────────────────────────────────────────────────────
 * SEBI-compliance helpers (preserved from the previous implementation).
 * ──────────────────────────────────────────────────────────────────── */

/**
 * MONEY-457: A "comparison recommendation" code (EQUAL / STOCK_A_PREFERRED /
 * STOCK_B_PREFERRED / <X>_PREFERRED) is legacy data — we no longer surface
 * any preference pill, so this only governs internal layout decisions.
 */
function isComparisonRec(rec: string | undefined): boolean {
  if (!rec) return false;
  return rec === "EQUAL" || rec.endsWith("_PREFERRED");
}

/**
 * MONEY-457: Strip .NS/.BO suffixes AND scrub SEBI-restricted recommendation
 * language from any prose string read out of the stored report. Load-bearing
 * safety net for historical reports already in MongoDB.
 */
function stripExchangeSuffix(text: string): string {
  if (!text) return text;
  return stripRecommendationLanguage(text).replace(/\.(NS|BO)\b/g, "");
}

/* ──────────────────────────────────────────────────────────────────────
 * Citation chips — split prose on [n] markers into emerald-bg pills.
 * ──────────────────────────────────────────────────────────────────── */

const CITE_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 16,
  height: 16,
  padding: "0 4px",
  margin: "0 2px",
  borderRadius: 5,
  background: "var(--emerald-bg)",
  color: "var(--emerald)",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 9.5,
  fontWeight: 700,
  verticalAlign: "middle",
  lineHeight: 1,
};

/**
 * CitedText — renders a prose string, converting inline `[1]` `[2]` markers
 * into small emerald citation chips. Prose is run through stripExchangeSuffix
 * first so the SEBI scrub still applies. Splitting on /(\[\d+\])/ keeps the
 * non-marker text intact.
 */
function CitedText({ text }: { text: string }): JSX.Element {
  const clean = stripExchangeSuffix(text);
  const parts = clean.split(/(\[\d+\])/g);
  // Citation scroll-sync (MONEY-673): hover a chip → highlight its Sources-rail
  // row; click → scroll the rail to it. Falls back to a static chip when no
  // rail is mounted (the store is a no-op then).
  const { hot } = useCitationState();
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[(\d+)\]$/);
        if (!m) return <span key={i}>{p}</span>;
        const n = Number(m[1]);
        const isHot = hot === n;
        return (
          <span
            key={i}
            style={{
              ...CITE_CHIP,
              cursor: "pointer",
              ...(isHot
                ? { background: "var(--emerald)", color: "#fff" }
                : null),
            }}
            onMouseEnter={() => setHotCitation(n)}
            onMouseLeave={() => setHotCitation(null)}
            onClick={() => setHotCitation(n, true)}
            role="link"
            aria-label={`Source ${n}`}
          >
            {m[1]}
          </span>
        );
      })}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Section shell — numbered §-block with 2px ink top-rule.
 * ──────────────────────────────────────────────────────────────────── */

function SectionLabel({
  n,
  children,
  right,
}: {
  n: number;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 14,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          // Design's `.pill` (ss.css:130) inlined — the class is `.ssx`-scoped
          // and the chat-embedded report renders outside `.ssx`, so inline the
          // tokens for identical rendering on both surfaces. Rotated -1.5deg per
          // the design's SectionLabel (ss-shared.jsx:83).
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
      <h3
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: "-0.3px",
          color: "var(--ink)",
          margin: 0,
        }}
      >
        {children}
      </h3>
      {right && <span style={{ flexShrink: 0 }}>{right}</span>}
    </div>
  );
}

/**
 * One-line plain-English explainer per section, keyed on title keywords —
 * shown muted under the section header so a newer investor is never
 * overwhelmed by jargon. Purely educational (SEBI: describes what the
 * section MEANS, never what to do). Unmatched titles show nothing.
 */
const SECTION_EXPLAINERS: Array<[RegExp, string]> = [
  [
    /summary|score card/i,
    "The one-paragraph takeaway — the score is an analysis quality score, not a rating to act on.",
  ],
  [
    /score breakdown/i,
    "How the overall score splits across valuation, profitability, growth and other lenses.",
  ],
  [
    /key metric/i,
    "The headline numbers investors check first — each dot shows data quality, not a verdict.",
  ],
  [
    /business overview/i,
    "What the company actually does, how it makes money, and where.",
  ],
  [
    /financial health/i,
    "How sturdy the balance sheet and margins are — can the business fund itself?",
  ],
  [
    /cash flow|earnings quality/i,
    "Whether reported profits are backed by real cash — a quality check on the earnings.",
  ],
  [
    /valuation/i,
    "What the business might be worth under different assumptions — a range of scenarios, never a price target.",
  ],
  [
    /quant factor/i,
    "How the stock screens on systematic factors like value, quality and momentum.",
  ],
  [
    /technical analysis/i,
    "What the price chart and indicators say about the current trend and momentum.",
  ],
  [
    /pattern/i,
    "Recognisable shapes in the recent price action that traders watch — context, not signals.",
  ],
  [
    /regime|risk/i,
    "How volatile the stock has been and how deep past declines went — what holding it can feel like.",
  ],
  [
    /shareholding|governance/i,
    "Who owns the company (promoters, institutions, public) and how well it is governed.",
  ],
  [
    /peer comparison/i,
    "How the company stacks up against similar businesses on the same yardsticks.",
  ],
  [
    /macro/i,
    "The big-picture forces — rates, currency, sector flows — that can move this stock.",
  ],
  [
    /news|sentiment/i,
    "Recent headlines that feed this analysis — each links to its source.",
  ],
  [
    /swot|strengths/i,
    "The quick pros, cons and upcoming events to keep an eye on.",
  ],
  [
    /scenario/i,
    "Plausible bull / base / bear paths and what would drive each — possibilities, not predictions.",
  ],
  [
    /growth outlook/i,
    "How fast revenue and profits have been compounding, and what could sustain it.",
  ],
  [
    /dividend/i,
    "What the company pays out to shareholders and how comfortably it can keep paying.",
  ],
];

function explainerFor(title: ReactNode): string | null {
  if (typeof title !== "string") return null;
  for (const [re, text] of SECTION_EXPLAINERS) if (re.test(title)) return text;
  return null;
}

function Block({
  n,
  title,
  right,
  children,
}: {
  n: number;
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  const explainer = explainerFor(title);
  return (
    <section style={{ borderTop: "2px solid var(--ink)", padding: "22px 0" }}>
      <SectionLabel n={n} right={right}>
        {title}
      </SectionLabel>
      {explainer && (
        <p
          className="serif"
          style={{
            fontSize: 12.5,
            fontStyle: "italic",
            color: "var(--ink-4)",
            margin: "-8px 0 14px",
            lineHeight: 1.5,
          }}
        >
          {explainer}
        </p>
      )}
      {children}
    </section>
  );
}

function NoData({ n, title }: { n: number; title: ReactNode }) {
  return (
    <Block n={n} title={title}>
      <DegradedNote>
        No data available for this section from the current sources.
      </DegradedNote>
    </Block>
  );
}

/* small "Ask AI" ghost button, paper-ink styled */
function AskAi({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 9px",
        borderRadius: 8,
        border: "1.5px solid var(--rule-soft)",
        background: "transparent",
        color: "var(--ink-3)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      <MessageSquare size={12} /> Ask AI
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Report header — eyebrow, title, trust chips.
 * ──────────────────────────────────────────────────────────────────── */

function TrustChip({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "ok" | "default";
}) {
  const c = tone === "ok" ? "var(--good)" : "var(--ink-3)";
  return (
    <span
      className="cb-chip"
      style={{
        borderColor: tone === "ok" ? "var(--good)" : "var(--rule-soft)",
        color: c,
        fontSize: 10,
        padding: "3px 9px",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      {children}
    </span>
  );
}

function ReportHeader({
  symbol,
  symbolsList,
  isComparison,
  sessionId,
  sourceCount,
  confidence,
  currentPrice,
  openHref,
}: {
  symbol: string;
  symbolsList: string[];
  isComparison: boolean;
  sessionId: string;
  sourceCount: number;
  confidence?: number;
  /** Latest traded price (₹) for the single-stock report — sourced from
   *  report.priceTarget.current (which now also falls back to the
   *  fetch_price_history last close). Rendered under the title; hidden for
   *  comparisons. MONEY-1060 (RC5b). */
  currentPrice?: number;
  /** "Open in Research" link (chat context → /analysis/[sessionId]). */
  openHref?: string;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          fontWeight: 700,
          color: "var(--emerald)",
        }}
      >
        {isComparison ? "Stock comparison" : "Stock research"}
      </div>
      <h2
        style={{
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "-1px",
          marginTop: 6,
          lineHeight: 1.05,
          color: "var(--ink)",
        }}
      >
        {isComparison ? (
          <>
            {symbolsList.join(" ")}{" "}
            <span className="serif" style={{ color: "var(--ink-3)" }}>
              compared
            </span>
          </>
        ) : (
          symbol
        )}
      </h2>
      {/* MONEY-1060 (RC5b): the report's current price — the single visible
          surface for priceTarget.current (which now also falls back to the
          fetch_price_history last close). Single-stock only; a comparison has no
          one price. Paper-ink playful styling (mono numerals, --ink tokens). */}
      {!isComparison && typeof currentPrice === "number" && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginTop: 8,
          }}
        >
          <span
            className="num"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.5px",
              color: "var(--ink)",
            }}
          >
            ₹
            {currentPrice.toLocaleString("en-IN", {
              maximumFractionDigits: 2,
            })}
          </span>
          <span
            className="num"
            style={{
              fontSize: 10,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              fontWeight: 700,
              color: "var(--ink-4)",
            }}
          >
            Current price
          </span>
        </div>
      )}
      <div
        className="trust"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 7,
          marginTop: 12,
          alignItems: "center",
        }}
      >
        <TrustChip tone="ok">
          <BIcon name="shield" size={11} /> Reviewed · SEBI-safe
        </TrustChip>
        {sourceCount > 0 && (
          <TrustChip>
            <BIcon name="search" size={11} /> Grounded in {sourceCount} sources
          </TrustChip>
        )}
        {typeof confidence === "number" && (
          <TrustChip>Confidence · {confidence}%</TrustChip>
        )}
        {/* SEBI: UseMoney never gives recommendations — and we don't surface a
            "recommendation: N/A" chip either (removed by review, 2026-06-12);
            the prose scrubbers remain the compliance guarantee. */}
        {openHref && (
          <Link href={openHref} style={{ textDecoration: "none" }}>
            <TrustChip>
              <BIcon name="external" size={11} /> Open in Research
            </TrustChip>
          </Link>
        )}
        {/* Per-symbol "View chart" links — preserves the previous nav. */}
        {(isComparison ? symbolsList : [symbol]).map((s) => (
          <Link
            key={s}
            href={`/stock/${encodeURIComponent(s)}?exchange=NSE&from=${encodeURIComponent(`/analysis/${sessionId}`)}`}
            style={{ textDecoration: "none" }}
          >
            <TrustChip>
              <BIcon name="trend" size={11} /> {isComparison ? s : "View chart"}
            </TrustChip>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * MiniTable — small aligned numeric table (hero row tinted emerald).
 * ──────────────────────────────────────────────────────────────────── */

const TH_STYLE = (first: boolean): CSSProperties => ({
  textAlign: first ? "left" : "right",
  padding: "9px 12px",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 10,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  color: "var(--ink-4)",
  fontWeight: 700,
  background: "var(--rule-softer)",
  borderBottom: "1.5px solid var(--rule-soft)",
});

function MiniTable({
  cols,
  rows,
  heroRow = -1,
}: {
  cols: ReactNode[];
  rows: ReactNode[][];
  heroRow?: number;
}) {
  return (
    <div
      style={{
        overflowX: "auto",
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 11,
      }}
    >
      <table
        style={{ width: "100%", borderCollapse: "collapse", minWidth: 360 }}
      >
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className="num" style={TH_STYLE(i === 0)}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              key={ri}
              style={{
                background:
                  ri === heroRow ? "var(--emerald-bg)" : "transparent",
              }}
            >
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className="num"
                  style={{
                    textAlign: ci === 0 ? "left" : "right",
                    padding: "9px 12px",
                    fontSize: 12.5,
                    fontWeight: ci === 0 ? 700 : 600,
                    color: ci === 0 ? "var(--emerald)" : "var(--ink-2)",
                    borderBottom:
                      ri < rows.length - 1
                        ? "1px solid var(--rule-softer)"
                        : "none",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* MiniTableBest — best cell per row highlighted neutrally (used by compare). */
export function MiniTableBest({
  cols,
  rows,
}: {
  cols: ReactNode[];
  rows: Array<{ t: ReactNode; vals: ReactNode[]; best?: number[] }>;
}) {
  return (
    <div
      style={{
        overflowX: "auto",
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 11,
      }}
    >
      <table
        style={{ width: "100%", borderCollapse: "collapse", minWidth: 360 }}
      >
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className="num" style={TH_STYLE(i === 0)}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <td
                className="num"
                style={{
                  textAlign: "left",
                  padding: "9px 12px",
                  fontWeight: 700,
                  color: "var(--emerald)",
                  borderBottom:
                    ri < rows.length - 1
                      ? "1px solid var(--rule-softer)"
                      : "none",
                }}
              >
                {r.t}
              </td>
              {r.vals.map((v, ci) => {
                const best = (r.best || []).includes(ci);
                return (
                  <td
                    key={ci}
                    className="num"
                    style={{
                      textAlign: "right",
                      padding: "9px 12px",
                      fontSize: 12.5,
                      fontWeight: best ? 700 : 600,
                      color: best ? "var(--good)" : "var(--ink-2)",
                      background: best ? "var(--emerald-bg)" : "transparent",
                      borderBottom:
                        ri < rows.length - 1
                          ? "1px solid var(--rule-softer)"
                          : "none",
                    }}
                  >
                    {best && "● "}
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* MiniTableConc — concentration / overlap table (zero cells render as "—"). */
export function MiniTableConc({
  cols,
  rows,
}: {
  cols: ReactNode[];
  rows: Array<{ n: ReactNode; weights: number[]; agg: number; flag?: boolean }>;
}) {
  return (
    <div
      style={{
        overflowX: "auto",
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 11,
      }}
    >
      <table
        style={{ width: "100%", borderCollapse: "collapse", minWidth: 380 }}
      >
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className="num" style={TH_STYLE(i === 0)}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <td
                style={{
                  textAlign: "left",
                  padding: "9px 12px",
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: "var(--ink)",
                  borderBottom:
                    ri < rows.length - 1
                      ? "1px solid var(--rule-softer)"
                      : "none",
                }}
              >
                {r.n}
              </td>
              {r.weights.map((w, ci) => (
                <td
                  key={ci}
                  className="num"
                  style={{
                    textAlign: "right",
                    padding: "9px 12px",
                    fontSize: 12.5,
                    color: w === 0 ? "var(--ink-4)" : "var(--ink-2)",
                    borderBottom:
                      ri < rows.length - 1
                        ? "1px solid var(--rule-softer)"
                        : "none",
                  }}
                >
                  {w === 0 ? "—" : w + "%"}
                </td>
              ))}
              <td
                className="num"
                style={{
                  textAlign: "right",
                  padding: "9px 12px",
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: r.flag ? "var(--fair)" : "var(--ink)",
                  borderBottom:
                    ri < rows.length - 1
                      ? "1px solid var(--rule-softer)"
                      : "none",
                }}
              >
                {r.flag && "▲ "}
                {r.agg}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * SWOT columns — Strengths / Risks / Catalysts.
 * ──────────────────────────────────────────────────────────────────── */

function SwotCol({
  icon,
  tone,
  title,
  items,
}: {
  icon: string;
  tone: string;
  title: ReactNode;
  items: string[];
}) {
  return (
    <div
      style={{
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 11,
        padding: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 9,
        }}
      >
        <BIcon name={icon} size={14} style={{ color: tone }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
          {title}
        </span>
      </div>
      <ul
        style={{
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 7,
          margin: 0,
          padding: 0,
        }}
      >
        {items.map((t, i) => (
          <li
            key={i}
            style={{
              fontSize: 12.5,
              color: "var(--ink-2)",
              lineHeight: 1.45,
              display: "flex",
              gap: 7,
            }}
          >
            <span style={{ color: tone }}>·</span>
            <span>
              <CitedText text={t} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * News / risk item shapes → playful renderers.
 * ──────────────────────────────────────────────────────────────────── */

function pickUrl(item: Record<string, string>): string | undefined {
  for (const key of ["url", "link", "sourceUrl", "href"]) {
    const v = item[key];
    if (v && /^https?:\/\//.test(v)) return v;
  }
  return undefined;
}

function formatNewsDate(raw: string | undefined): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "2-digit",
  });
}

function domainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

const SENTIMENTS = ["positive", "neutral", "negative"] as const;
function toSentiment(
  s: string | undefined
): "positive" | "neutral" | "negative" | undefined {
  const v = (s || "").toLowerCase();
  return (SENTIMENTS as readonly string[]).includes(v)
    ? (v as "positive" | "neutral" | "negative")
    : undefined;
}

function NewsList({ items }: { items: Array<Record<string, string>> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((raw, i) => {
        const url = pickUrl(raw);
        const news: NewsItem = {
          url: url || "#",
          domain: domainFromUrl(url),
          title: stripExchangeSuffix(
            raw.title || raw.headline || raw.name || "—"
          ),
          source: raw.source || raw.publisher || undefined,
          date: formatNewsDate(raw.date || raw.pubDate || raw.publishedAt),
          sentiment: toSentiment(raw.sentiment),
        };
        return <NewsItemCard key={i} item={news} />;
      })}
    </div>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  high: "var(--poor)",
  medium: "var(--fair)",
  low: "var(--good)",
};

function RiskList({ items }: { items: Array<Record<string, string>> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((raw, i) => {
        const title = stripExchangeSuffix(
          raw.risk || raw.title || raw.name || "—"
        );
        const severity = (raw.severity || "").toLowerCase();
        const tone = SEVERITY_TONE[severity] || "var(--fair)";
        const mitigation = raw.mitigation || "";
        const description = raw.description || raw.detail || "";
        return (
          <div
            key={i}
            style={{
              border: "1.5px solid var(--rule-soft)",
              borderRadius: 11,
              padding: "11px 13px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
                flexWrap: "wrap",
              }}
            >
              {severity && (
                <span
                  className="num"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    color: tone,
                  }}
                >
                  ● {severity}
                </span>
              )}
              {raw.timeline && (
                <span
                  className="num"
                  style={{ fontSize: 10, color: "var(--ink-4)" }}
                >
                  {raw.timeline}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ink)",
                lineHeight: 1.4,
              }}
            >
              <CitedText text={title} />
            </div>
            {description && (
              <p
                style={{
                  fontSize: 12,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                  margin: "6px 0 0",
                }}
              >
                <CitedText text={description} />
              </p>
            )}
            {mitigation && (
              <div
                style={{
                  marginTop: 8,
                  paddingTop: 8,
                  borderTop: "1px solid var(--rule-softer)",
                }}
              >
                <span
                  className="num"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    color: "var(--emerald)",
                  }}
                >
                  Mitigation
                </span>
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--ink-2)",
                    lineHeight: 1.5,
                    margin: "4px 0 0",
                  }}
                >
                  <CitedText text={mitigation} />
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* markdown prose → paper-ink */
const MD_COMPONENTS = {
  p: ({ children }: { children?: ReactNode }) => (
    <p style={{ margin: "0 0 8px", color: "var(--ink-2)", lineHeight: 1.6 }}>
      {children}
    </p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul style={{ margin: "0 0 8px 18px", color: "var(--ink-2)" }}>
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol style={{ margin: "0 0 8px 18px", color: "var(--ink-2)" }}>
      {children}
    </ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li style={{ marginBottom: 3, color: "var(--ink-2)" }}>{children}</li>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong style={{ fontWeight: 700, color: "var(--ink)" }}>{children}</strong>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h4
      style={{
        fontSize: 13,
        fontWeight: 700,
        color: "var(--ink)",
        margin: "12px 0 4px",
      }}
    >
      {children}
    </h4>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h5
      style={{
        fontSize: 12.5,
        fontWeight: 700,
        color: "var(--ink)",
        margin: "10px 0 4px",
      }}
    >
      {children}
    </h5>
  ),
};

/* ──────────────────────────────────────────────────────────────────────
 * Section dispatcher — maps StructuredReport.sections[] (text/table/news/
 * risks) to the playful Block layouts.
 * ──────────────────────────────────────────────────────────────────── */

type ReportSection = NonNullable<StructuredReport["sections"]>[number];

function verdictToTone(
  v: string | undefined
): "good" | "fair" | "poor" | undefined {
  if (v === "good") return "good";
  if (v === "poor") return "poor";
  if (v === "fair") return "fair";
  return undefined;
}

function trendArrow(t: string | undefined): string {
  if (t === "up") return "↑";
  if (t === "down") return "↓";
  return "→";
}

/** Render the design's chart payloads attached to a section (radar / DCF
 *  sensitivity heatmap / Monte-Carlo fan / underwater drawdown / indicator
 *  dashboard / scenario range). Each is guarded so a section with no chart data
 *  renders nothing — the synthesizer attaches whichever apply. MONEY-490. */
function renderSectionCharts(s: ReportSection): JSX.Element[] {
  const out: JSX.Element[] = [];
  const inr = (x: number) => `₹${Math.round(x).toLocaleString("en-IN")}`;
  /* Composite dial + factor contribution (quant factor profile). */
  if (s.composite && typeof s.composite.score === "number") {
    out.push(
      <div
        key="composite"
        style={{
          display: "flex",
          gap: 24,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <ScoreDial
          value={Math.round(s.composite.score)}
          label={s.composite.label ?? "Composite"}
          sub={s.composite.sub}
        />
        {s.radar && s.radar.axes?.length ? (
          <div style={{ flex: 1, minWidth: 220 }}>
            <RadarChart
              axes={s.radar.axes}
              series={[{ values: s.radar.values }]}
              max={s.radar.max ?? 100}
            />
          </div>
        ) : null}
      </div>
    );
  }
  if (s.contribution && s.contribution.length > 0) {
    out.push(
      <div key="contribution">
        <div
          className="num"
          style={{
            fontSize: 10,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            fontWeight: 700,
            color: "var(--ink-4)",
            marginBottom: 8,
          }}
        >
          Factor contribution
        </div>
        <StackedBar
          items={s.contribution.map((c) => ({
            label: c.label,
            value: c.value,
            unit: "%",
          }))}
        />
      </div>
    );
  }
  /* KV rows (business overview / macro environment). */
  if (s.kv && s.kv.length > 0) {
    out.push(<KVTable key="kv" rows={s.kv.map((r) => ({ k: r.k, v: r.v }))} />);
  }
  /* Shareholding bars (+deltas) and governance flag chips. */
  if (s.bars && s.bars.length > 0) {
    out.push(
      <div key="bars">
        {s.bars.map((b, i) => (
          <BarRow
            key={i}
            label={b.label}
            value={b.value}
            pct={Math.max(0, Math.min(100, b.pct))}
            delta={b.delta}
          />
        ))}
      </div>
    );
  }
  if (s.flags && s.flags.length > 0) {
    out.push(
      <div key="flags" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {s.flags.map((f, i) => (
          <FlagChip
            key={i}
            tone={
              /green|good|ok/i.test(f.tone)
                ? "green"
                : /red|poor|bad/i.test(f.tone)
                  ? "red"
                  : "amber"
            }
          >
            {f.text}
          </FlagChip>
        ))}
      </div>
    );
  }
  if (
    s.radar &&
    s.radar.axes?.length &&
    s.radar.values?.length &&
    !s.composite // already rendered beside the composite dial above
  ) {
    out.push(
      <RadarChart
        key="radar"
        axes={s.radar.axes}
        series={[{ values: s.radar.values }]}
        max={s.radar.max ?? 100}
      />
    );
  }
  if (
    s.range &&
    typeof s.range.low === "number" &&
    typeof s.range.high === "number"
  ) {
    const cur = s.range.current;
    const lo = Math.min(s.range.low, cur ?? s.range.low) * 0.96;
    const hi = Math.max(s.range.high, cur ?? s.range.high) * 1.04;
    out.push(
      <RangeBar
        key="range"
        low={s.range.low}
        mid={s.range.mid}
        high={s.range.high}
        current={cur ?? null}
        lo={lo}
        hi={hi}
        fmt={inr}
      />
    );
  }
  if (s.heatmap && Array.isArray(s.heatmap.data) && s.heatmap.data.length > 0) {
    out.push(
      <Heatmap
        key="heatmap"
        rows={s.heatmap.rows}
        cols={s.heatmap.cols}
        data={s.heatmap.data}
        rowLabel={s.heatmap.rowLabel}
        colLabel={s.heatmap.colLabel}
        fmt={(x) => (x >= 1000 ? `₹${(x / 1000).toFixed(2)}k` : String(x))}
      />
    );
  }
  if (s.fan && Array.isArray(s.fan.p50) && s.fan.p50.length > 0) {
    out.push(
      <FanChart
        key="fan"
        bands={{
          p10: s.fan.p10,
          p25: s.fan.p25,
          p50: s.fan.p50,
          p75: s.fan.p75,
          p90: s.fan.p90,
        }}
      />
    );
  }
  if (Array.isArray(s.underwater) && s.underwater.length > 0) {
    out.push(<Underwater key="uw" data={s.underwater} />);
  }
  if (s.indicators && s.indicators.length > 0) {
    // Design "indicator dashboard": grouped columns (TREND / MOMENTUM /
    // VOLATILITY / VOLUME) when groups are present, flat list otherwise.
    const sig = (v: string) =>
      /bull|pos|^up/i.test(v)
        ? ("bullish" as const)
        : /bear|neg|^down/i.test(v)
          ? ("bearish" as const)
          : ("neutral" as const);
    const groups: string[] = [];
    for (const i of s.indicators) {
      const g = (i.group || "").toUpperCase();
      if (g && !groups.includes(g)) groups.push(g);
    }
    out.push(
      groups.length > 0 ? (
        <div key="ind">
          <div
            className="num"
            style={{
              fontSize: 10,
              letterSpacing: 0.8,
              textTransform: "uppercase",
              fontWeight: 700,
              color: "var(--ink-4)",
              marginBottom: 8,
            }}
          >
            Indicator dashboard
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
              gap: "4px 28px",
            }}
          >
            {groups.map((g) => (
              <div key={g}>
                <div
                  className="num"
                  style={{
                    fontSize: 9.5,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "var(--ink-4)",
                    padding: "6px 0 2px",
                  }}
                >
                  {g}
                </div>
                {s
                  .indicators!.filter(
                    (i) => (i.group || "").toUpperCase() === g
                  )
                  .map((i, k) => (
                    <IndicatorRow
                      key={k}
                      name={i.name}
                      value={i.value}
                      signal={sig(i.signal)}
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div key="ind">
          {s.indicators.map((i, k) => (
            <IndicatorRow
              key={k}
              name={i.name}
              value={i.value}
              signal={sig(i.signal)}
            />
          ))}
        </div>
      )
    );
  }
  return out;
}

function renderSection(
  s: ReportSection,
  n: number,
  symbol: string,
  onDeepDive?: (q: string) => void
): JSX.Element {
  // Section badge pill (design: "Piotroski 8/9" / "Gov 86/100 · A" /
  // "High-Quality Momentum") + the Ask-AI deep-dive affordance.
  const badge = s.badge ? (
    <span
      className="cb-chip num"
      style={{
        borderColor: "var(--good)",
        color: "var(--good)",
        fontSize: 10,
        padding: "3px 9px",
      }}
    >
      {s.badge}
    </span>
  ) : null;
  const askAi = onDeepDive ? (
    <AskAi
      onClick={() =>
        onDeepDive(
          `Tell me more about the ${String(s.title).toLowerCase()} of ${symbol}. Go deeper into this topic with specific analysis.`
        )
      }
    />
  ) : null;
  const right =
    badge || askAi ? (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        {badge}
        {askAi}
      </span>
    ) : undefined;

  /* DCF valuation tiles (a section may carry both prose + dcf). Render only
     when at least one scalar is a number — shouldRenderDcfBox guards the
     MONEY-295 all-null case (../../app/analysis/dcf-display.ts, unit-tested). */
  const dcfTiles = shouldRenderDcfBox(s.dcf) ? (
    <div
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        marginTop: s.content ? 14 : 0,
      }}
    >
      <MetricTile
        label="DCF intrinsic"
        value={
          s.dcf && typeof s.dcf.intrinsicValue === "number"
            ? `₹${s.dcf.intrinsicValue.toLocaleString("en-IN")}`
            : "—"
        }
        verdict={
          s.dcf && typeof s.dcf.intrinsicValue === "number" ? "good" : undefined
        }
      />
      <MetricTile
        label="Current"
        value={
          s.dcf && typeof s.dcf.currentPrice === "number"
            ? `₹${s.dcf.currentPrice.toLocaleString("en-IN")}`
            : "—"
        }
      />
      <MetricTile
        label="Intrinsic vs current"
        value={
          s.dcf && typeof s.dcf.upside === "number"
            ? `${(1 + s.dcf.upside / 100).toFixed(2)}×`
            : "—"
        }
        sub="not a price target"
      />
    </div>
  ) : null;

  // Design chart payloads attached to this section. MONEY-490 "exact match".
  const charts = renderSectionCharts(s);

  /* news */
  if (s.type === "news" && s.items && s.items.length > 0) {
    return (
      <Block key={n} n={n} title={s.title} right={right}>
        <NewsList items={s.items} />
      </Block>
    );
  }

  /* risks */
  if (s.type === "risks" && s.items && s.items.length > 0) {
    return (
      <Block key={n} n={n} title={s.title} right={right}>
        <RiskList items={s.items} />
      </Block>
    );
  }

  /* table */
  if (s.type === "table" && s.columns && s.rows && s.rows.length > 0) {
    return (
      <Block key={n} n={n} title={s.title} right={right}>
        <MiniTable
          cols={s.columns}
          rows={s.rows.map((r) => r.map((cell) => stripExchangeSuffix(cell)))}
          heroRow={s.rows.length > 0 ? 0 : -1}
        />
      </Block>
    );
  }

  /* generic items grid (MF top-holdings / peer-funds style records) */
  if (
    s.items &&
    s.items.length > 0 &&
    s.type !== "news" &&
    s.type !== "risks" &&
    !s.columns
  ) {
    return (
      <Block key={n} n={n} title={s.title} right={right}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
            gap: 10,
          }}
        >
          {s.items.map((item, j) => {
            // MONEY-778: drop advice-adjacent fields (expectedValue, target,
            // upside…) before splitting into headline + rows, so a bare forward
            // target/return never surfaces as a recommendation. Intrinsic value
            // is NOT dropped — the design surfaces it (the purpose-built DCF
            // tiles above read it directly, methodology-framed).
            const entries = Object.entries(item).filter(
              ([k]) => !isAdviceAdjacentField(k)
            );
            if (entries.length === 0) return null;
            const [pk, pv] = entries[0]!;
            const rest = entries.slice(1);
            return (
              <div
                key={j}
                style={{
                  border: "1.5px solid var(--rule-soft)",
                  borderRadius: 11,
                  padding: "11px 13px",
                  background: "var(--paper-3)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: rest.length ? 6 : 0,
                  }}
                >
                  <span
                    className="num"
                    style={{
                      fontSize: 9.5,
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                      fontWeight: 700,
                      color: "var(--ink-4)",
                    }}
                  >
                    {pk}
                  </span>
                  <span
                    className="num"
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--emerald)",
                    }}
                  >
                    {stripExchangeSuffix(pv)}
                  </span>
                </div>
                {rest.length > 0 && (
                  <div
                    style={{
                      paddingTop: 6,
                      borderTop: "1px solid var(--rule-softer)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                    }}
                  >
                    {rest.map(([k, v]) => (
                      <div
                        key={k}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 11.5,
                        }}
                      >
                        <span style={{ color: "var(--ink-3)" }}>{k}</span>
                        <span
                          className="num"
                          style={{ color: "var(--ink-2)", fontWeight: 600 }}
                        >
                          {stripExchangeSuffix(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Block>
    );
  }

  /* prose / text section (+ optional metrics grid + dcf tiles + charts) */
  if (
    s.content ||
    (s.metrics && s.metrics.length > 0) ||
    s.dcf ||
    charts.length > 0
  ) {
    return (
      <Block key={n} n={n} title={s.title} right={right}>
        {s.content && (
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            <ReactMarkdown components={MD_COMPONENTS}>
              {stripExchangeSuffix(s.content)}
            </ReactMarkdown>
          </div>
        )}
        {s.metrics && s.metrics.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
              gap: 9,
              marginTop: s.content ? 14 : 0,
            }}
          >
            {s.metrics.map((m, j) => (
              <div
                key={j}
                style={{
                  border: "1.5px solid var(--rule-soft)",
                  borderRadius: 10,
                  padding: "9px 11px",
                  background: "var(--paper-3)",
                }}
              >
                <div
                  className="num"
                  style={{
                    fontSize: 9.5,
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    fontWeight: 700,
                    color: "var(--ink-4)",
                  }}
                >
                  {m.label}
                </div>
                <div
                  className="num"
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--ink)",
                    marginTop: 4,
                  }}
                >
                  {stripExchangeSuffix(m.value)}
                </div>
                {m.trend && (
                  <span
                    className="num"
                    style={{
                      fontSize: 11,
                      color:
                        m.trend === "up"
                          ? "var(--up)"
                          : m.trend === "down"
                            ? "var(--down)"
                            : "var(--ink-3)",
                    }}
                  >
                    {trendArrow(m.trend)} {m.verdict}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {charts.length > 0 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
              marginTop: s.content || (s.metrics && s.metrics.length) ? 16 : 0,
            }}
          >
            {charts}
          </div>
        )}
        {dcfTiles}
      </Block>
    );
  }

  /* nothing usable → nodata */
  return <NoData key={n} n={n} title={s.title} />;
}

/* ──────────────────────────────────────────────────────────────────────
 * Disclaimer — fixed serif-italic, dashed-top, at the very bottom.
 * ──────────────────────────────────────────────────────────────────── */

function Disclaimer({ text }: { text?: string }) {
  return (
    <div
      style={{
        borderTop: "2px dashed var(--ink)",
        marginTop: 8,
        paddingTop: 16,
      }}
    >
      <p
        className="serif"
        style={{
          fontSize: 14,
          fontStyle: "italic",
          color: "var(--ink-3)",
          lineHeight: 1.55,
          margin: 0,
        }}
      >
        {text || SEBI}
      </p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Single-stock report body — composed from top-level StructuredReport
 * fields + sections[]. Each Block gets a running § number.
 * ──────────────────────────────────────────────────────────────────── */

function StockReportBody({
  report,
  symbol,
  displayScore,
  onDeepDive,
  startN = 0,
}: {
  report: StructuredReport;
  symbol: string;
  displayScore?: number;
  onDeepDive?: (q: string) => void;
  startN?: number;
}) {
  const blocks: JSX.Element[] = [];
  let n = startN;

  /* MONEY-668 item 3: lead with the same unified "scored" card the chat shows
     (overall dial + verdict + confidence + section-score radar + per-section
     rows), which was missing on the research report page. When present it
     subsumes the §1 summary dial + the score-breakdown bars below, so those
     are skipped to avoid a duplicate dial / duplicate section scores. */
  const hasScorecard =
    typeof report.score === "number" &&
    !!report.scoreBreakdown &&
    report.scoreBreakdown.length > 0;
  if (hasScorecard) {
    n += 1;
    const overall =
      typeof displayScore === "number"
        ? displayScore
        : report.score! <= 1
          ? Math.round(report.score! * 100)
          : Math.round(report.score!);
    const confidence =
      typeof report.confidence === "number"
        ? report.confidence >= 70
          ? "High"
          : report.confidence >= 40
            ? "Medium"
            : "Low"
        : undefined;
    const keyMetricPairs = report.keyMetrics?.map(
      (m) => [m.label, stripExchangeSuffix(m.value)] as [string, string]
    );
    const scorecard: ScorecardBlock = {
      type: "scorecard",
      symbol,
      overall,
      confidence,
      verdict: report.summary,
      // MONEY-1060 (RC5b): carry the current price on the scorecard too, from
      // the same priceTarget.current the header shows (which now falls back to
      // the price-history last close). Optional/additive — renderers that don't
      // read it are unaffected.
      currentPrice: report.priceTarget?.current,
      sections: report.scoreBreakdown!.map((c) => ({
        title: c.criterion,
        score: Math.round((c.score / c.maxScore) * 100),
        summary: c.comment,
        metrics: /key metric/i.test(c.criterion) ? keyMetricPairs : undefined,
      })),
    };
    blocks.push(
      <div key={`scorecard-${n}`} style={{ marginBottom: 14 }}>
        <ScorecardBlockRenderer block={scorecard} />
      </div>
    );
  }

  /* "In plain English" — jargon-free walkthrough of what this report says,
     framed for wherever the reader is in their investing journey. Educational
     only (SEBI): explains what each part means, never what to do. */
  if (report.plainSummary) {
    blocks.push(
      <div
        key="plain-english"
        style={{
          border: "1.5px dashed var(--rule-soft)",
          borderRadius: 12,
          padding: "14px 16px",
          background: "var(--paper-3)",
          marginBottom: 14,
        }}
      >
        <div
          className="num"
          style={{
            fontSize: 10,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            fontWeight: 700,
            color: "var(--emerald)",
            marginBottom: 7,
          }}
        >
          In plain English
        </div>
        <p
          className="serif"
          style={{
            fontSize: 14.5,
            lineHeight: 1.65,
            color: "var(--ink-2)",
            margin: 0,
          }}
        >
          <CitedText text={report.plainSummary} />
        </p>
      </div>
    );
  }

  /* §1 summary + quality score (skipped when the scorecard above covers it) */
  if (!hasScorecard && (report.summary || typeof displayScore === "number")) {
    n += 1;
    blocks.push(
      <Block
        key={`summary-${n}`}
        n={n}
        title="Summary"
        right={
          typeof report.confidence === "number" ? (
            <ConfidencePill
              level={
                report.confidence >= 70
                  ? "High"
                  : report.confidence >= 40
                    ? "Medium"
                    : "Low"
              }
            />
          ) : undefined
        }
      >
        <div
          style={{
            display: "flex",
            gap: 18,
            flexWrap: "wrap",
            alignItems: "flex-start",
          }}
        >
          {typeof displayScore === "number" && (
            <div style={{ flexShrink: 0 }}>
              <ScoreDial
                value={displayScore}
                label="Quality score"
                sub="analysis score, not a rating"
              />
            </div>
          )}
          {report.summary && (
            <p
              style={{
                flex: 1,
                minWidth: 220,
                fontSize: 14.5,
                lineHeight: 1.66,
                color: "var(--ink-2)",
                margin: 0,
              }}
            >
              <CitedText text={report.summary} />
            </p>
          )}
        </div>
      </Block>
    );
  }

  /* §_ score breakdown (criteria bars) — skipped when the scorecard renders
     the same per-section scores as its radar + rows. */
  if (
    !hasScorecard &&
    report.scoreBreakdown &&
    report.scoreBreakdown.length > 0
  ) {
    n += 1;
    blocks.push(
      <Block key={`breakdown-${n}`} n={n} title="Score breakdown">
        <div>
          {report.scoreBreakdown.map((c, i) => (
            <BarRow
              key={i}
              label={`${c.criterion} · ${c.score}/${c.maxScore}`}
              value={`${Math.round((c.score / c.maxScore) * 100)}%`}
              pct={(c.score / c.maxScore) * 100}
            />
          ))}
        </div>
      </Block>
    );
  }

  /* §_ key metrics */
  if (report.keyMetrics && report.keyMetrics.length > 0) {
    n += 1;
    const items: MetricTileItem[] = report.keyMetrics.map((m) => ({
      label: m.label,
      value: stripExchangeSuffix(m.value),
      verdict: verdictToTone(m.verdict),
    }));
    blocks.push(
      <Block
        key={`metrics-${n}`}
        n={n}
        title="Key metrics"
        right={
          onDeepDive ? (
            <AskAi
              onClick={() =>
                onDeepDive(
                  `Explain the key financial metrics of ${symbol} in detail. What do these numbers tell us about the company?`
                )
              }
            />
          ) : undefined
        }
      >
        <MetricStrip items={items} />
      </Block>
    );
  }

  /* §_ sections[] (text / table / news / risks) */
  if (report.sections) {
    for (const s of report.sections) {
      n += 1;
      blocks.push(renderSection(s, n, symbol, onDeepDive));
    }
  }

  /* §_ SWOT (strengths / risks / catalysts) */
  const hasSwot =
    (report.strengths && report.strengths.length > 0) ||
    (report.risks && report.risks.length > 0) ||
    (report.catalysts && report.catalysts.length > 0);
  if (hasSwot) {
    n += 1;
    blocks.push(
      <Block key={`swot-${n}`} n={n} title="Strengths · Risks · Catalysts">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
            gap: 12,
          }}
        >
          {report.strengths && report.strengths.length > 0 && (
            <SwotCol
              icon="up"
              tone="var(--good)"
              title="Strengths"
              items={report.strengths}
            />
          )}
          {report.risks && report.risks.length > 0 && (
            <SwotCol
              icon="alert"
              tone="var(--poor)"
              title="Risks"
              items={report.risks}
            />
          )}
          {report.catalysts && report.catalysts.length > 0 && (
            <SwotCol
              icon="sparkles"
              tone="var(--gold-tx)"
              title="Catalysts"
              items={report.catalysts.map(
                (c) => `${c.event}${c.timeline ? ` — ${c.timeline}` : ""}`
              )}
            />
          )}
        </div>
      </Block>
    );
  }

  /* §_ technicals */
  if (report.technicals) {
    n += 1;
    const t = report.technicals;
    const rows: KVRow[] = [
      { k: "Trend", v: t.trend },
      {
        k: "Support",
        v:
          typeof t.support === "number"
            ? `₹${t.support.toLocaleString("en-IN")}`
            : "—",
      },
      {
        k: "Resistance",
        v:
          typeof t.resistance === "number"
            ? `₹${t.resistance.toLocaleString("en-IN")}`
            : "—",
      },
    ];
    if (typeof t.rsi === "number") rows.push({ k: "RSI", v: t.rsi });
    blocks.push(
      <Block key={`technicals-${n}`} n={n} title="Technical overview">
        <KVTable rows={rows} />
      </Block>
    );
  }

  return <>{blocks}</>;
}

/* ──────────────────────────────────────────────────────────────────────
 * Data-sources footer block — "documents researched".
 * ──────────────────────────────────────────────────────────────────── */

export interface DataSourceItem {
  tool: string;
  label: string;
  type: "data_fetch" | "computation" | "analysis" | "synthesis";
  status: "completed" | "failed" | "pending";
  count?: number;
}

function DataSourcesBlock({
  dataSources,
  n,
}: {
  dataSources: DataSourceItem[];
  n: number;
}) {
  const totalPoints = dataSources.reduce((s, d) => s + (d.count || 1), 0);
  const completedPoints = dataSources
    .filter((d) => d.status === "completed")
    .reduce((s, d) => s + (d.count || 1), 0);
  const typeLabel = (t: DataSourceItem["type"]) =>
    t === "data_fetch"
      ? "Data"
      : t === "computation"
        ? "Compute"
        : t === "synthesis"
          ? "AI"
          : "Analysis";
  return (
    <Block
      n={n}
      title="Data sources researched"
      right={
        <span className="num" style={{ fontSize: 11, color: "var(--ink-4)" }}>
          {completedPoints} / {totalPoints} points
        </span>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
          gap: 8,
        }}
      >
        {dataSources.map((src) => {
          const color =
            src.status === "completed"
              ? "var(--good)"
              : src.status === "failed"
                ? "var(--poor)"
                : "var(--ink-4)";
          return (
            <div
              key={src.tool}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 10px",
                borderRadius: 9,
                border: "1.5px solid var(--rule-soft)",
                background: "var(--paper-3)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 99,
                  background: color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  color: "var(--ink-2)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {src.label}
                {(src.count || 0) > 1 && (
                  <span style={{ color: "var(--ink-4)" }}> ({src.count})</span>
                )}
              </span>
              <span
                className="num"
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: "var(--ink-4)",
                  flexShrink: 0,
                }}
              >
                {typeLabel(src.type)}
              </span>
            </div>
          );
        })}
      </div>
    </Block>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Top-level Report dispatcher.
 * ──────────────────────────────────────────────────────────────────── */

interface ResearchReportProps {
  report: StructuredReport;
  symbol: string;
  sessionId: string;
  dataSources?: DataSourceItem[];
  /** Called when user clicks "Ask AI" on a section to deep-dive */
  onDeepDive?: (query: string) => void;
  /** "Open in Research" header link (chat context → /analysis/[sessionId]). */
  openHref?: string;
}

export default function ResearchReport({
  report,
  symbol,
  sessionId,
  dataSources,
  onDeepDive,
  openHref,
}: ResearchReportProps) {
  // Extract individual symbols from display string (e.g. "AMBER vs RELIANCE").
  const symbolsList = symbol.includes(" vs ")
    ? symbol.split(" vs ").map((s) => s.trim())
    : [symbol];

  // Detect comparison via comparisonMeta / recommendation codes / multi-symbol.
  const isComparison =
    !!report.comparisonMeta ||
    isComparisonRec(report.recommendation) ||
    symbolsList.length > 1;

  // Normalize score for display (DB may store 0–1 or 0–100).
  const displayScore =
    typeof report.score === "number"
      ? report.score <= 1
        ? Math.round(report.score * 100)
        : report.score
      : undefined;

  const sourceCount = dataSources?.length ?? 0;

  // Detect MF / fund-overlap reports (task #30). Fund detection wins over the
  // generic comparison path so MF-mode reports get the fund-specific layout.
  const fundKind = detectFundReport(report, symbol);

  // The dispatched body returns its blocks AND the next free § number so the
  // data-sources footer block continues the running count without colliding.
  let body: JSX.Element;
  let bodyN: number;

  if (fundKind === "fundcompare") {
    body = <FundCompareReport report={report} startN={0} />;
    // hero + up to common-holdings + pairwise-matrix + observations + per-fund
    // meta + remaining sections. MONEY-778: +2 for the matrix/observations
    // blocks so the data-sources footer §-number never collides (loose upper
    // bound — over-counting only widens a harmless gap).
    bodyN = 4 + (report.sections?.length ?? 0);
  } else if (fundKind === "fund") {
    body = (
      <FundReport
        report={report}
        symbol={symbol}
        displayScore={displayScore}
        onDeepDive={onDeepDive}
        startN={0}
      />
    );
    bodyN = 5 + (report.sections?.length ?? 0);
  } else if (isComparison) {
    body = (
      <CompareReport
        report={report}
        symbolsList={symbolsList}
        onDeepDive={onDeepDive}
        startN={0}
      />
    );
    bodyN =
      2 +
      (report.comparisonMeta?.perStockBreakdown?.length ?? 0) +
      (report.sections?.length ?? 0) +
      1;
  } else {
    body = (
      <StockReportBody
        report={report}
        symbol={symbol}
        displayScore={displayScore}
        onDeepDive={onDeepDive}
        startN={0}
      />
    );
    bodyN =
      1 +
      (report.scoreBreakdown?.length ? 1 : 0) +
      (report.keyMetrics?.length ? 1 : 0) +
      (report.sections?.length ?? 0) +
      1 +
      (report.technicals ? 1 : 0);
  }

  return (
    <div>
      <ReportHeader
        symbol={symbol}
        symbolsList={symbolsList}
        isComparison={isComparison && fundKind === null}
        sessionId={sessionId}
        sourceCount={sourceCount}
        confidence={
          typeof report.confidence === "number" ? report.confidence : undefined
        }
        currentPrice={report.priceTarget?.current}
        openHref={openHref}
      />
      {/* MONEY-650 (B10): lead the full report with the candlestick chart for
          single-stock (non-fund) reports — the chat report already does. */}
      {!isComparison && fundKind === null && symbolsList[0] && (
        <div style={{ margin: "10px 0 2px" }}>
          <Suspense
            fallback={<PfTradingViewPlaceholder height={360} loading />}
          >
            <LazyResearchChart
              symbol={symbolsList[0].replace(/\.(NS|BO)$/i, "")}
              exchange={
                (symbolsList[0].endsWith(".BO") ? "BSE" : "NSE") as
                  | "NSE"
                  | "BSE"
              }
              height={360}
            />
          </Suspense>
        </div>
      )}
      {body}
      {dataSources && dataSources.length > 0 && (
        <DataSourcesBlock dataSources={dataSources} n={bodyN + 1} />
      )}
      <Disclaimer text={report.disclaimer} />
    </div>
  );
}

/* Re-exported primitives so the fund/compare report module can share them. */
export {
  Block,
  MiniTable,
  CitedText,
  SwotCol,
  NewsList,
  RiskList,
  AskAi,
  stripExchangeSuffix,
  verdictToTone,
};
