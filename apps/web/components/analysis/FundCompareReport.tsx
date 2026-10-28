"use client";

/**
 * FundReport · CompareReport · FundCompareReport — StockSage "Playful paper"
 * report bodies for the MF / comparison / fund-overlap shapes (MONEY-587,
 * task #30). Dispatched from ResearchReport.tsx, these replace the inline
 * comparison branches and the generic MF section fall-through with purpose-
 * built layouts:
 *
 *   FundReport        — ScoreDial quality + overview KVTable + returns
 *                       snapshot + top-holdings bars + peer funds table.
 *   CompareReport     — per-stock analysis-quality score dials (no winner) +
 *                       per-stock score-breakdown bars + standard section body.
 *   FundCompareReport — holdings-overlap hero % + common-holdings concentration
 *                       table + per-fund comparison meta.
 *
 * All three consume the SAME `StructuredReport` contract that ResearchReport
 * already receives — only the rendering differs. SEBI-safe throughout: no
 * winner is crowned, scores are analysis-quality scores, recommendation prose
 * is scrubbed via the shared stripExchangeSuffix.
 */

import type { ReactNode } from "react";
import type { StructuredReport } from "./types";
import {
  ScoreDial,
  BarRow,
  KVTable,
  ConfidencePill,
  DegradedNote,
  Heatmap,
  FlagChip,
  type KVRow,
} from "@/components/chat/blocks/ChatBlock";
import {
  Block,
  MiniTable,
  MiniTableConc,
  CitedText,
  SwotCol,
  NewsList,
  RiskList,
  AskAi,
  stripExchangeSuffix,
} from "./ResearchReport";

type ReportSection = NonNullable<StructuredReport["sections"]>[number];

/* ──────────────────────────────────────────────────────────────────────
 * Detection — classify a StructuredReport as a fund / fund-overlap report.
 *
 * MF reports arrive as the standard sections[] shape, re-skinned fund-aware
 * by the synthesizer (prompts.ts: "Fund Overview" / "Returns Snapshot" /
 * "Top Holdings" / "Peer Funds" / "Risk Profile" / "Tax Treatment", no
 * technicals/catalysts/priceTarget). We detect via those marker titles.
 * ──────────────────────────────────────────────────────────────────── */

function sectionByTitle(
  report: StructuredReport,
  ...needles: string[]
): ReportSection | undefined {
  const lowered = needles.map((s) => s.toLowerCase());
  return report.sections?.find((s) =>
    lowered.some((nd) => String(s.title).toLowerCase().includes(nd))
  );
}

/**
 * detectFundReport — returns "fundcompare" for a multi-fund overlap report,
 * "fund" for a single-fund report, or null for a stock / generic report.
 *
 * Fund detection: presence of "Fund Overview" or "Returns Snapshot" sections
 * (MF-mode markers) AND no stock-only technicals. Fund-overlap detection:
 * a section whose title mentions "overlap" / "common holdings".
 */
export function detectFundReport(
  report: StructuredReport,
  symbol: string
): "fund" | "fundcompare" | null {
  const overlap = sectionByTitle(
    report,
    "overlap",
    "common holding",
    "holdings overlap"
  );
  if (overlap) return "fundcompare";

  const fundMarker = sectionByTitle(
    report,
    "fund overview",
    "returns snapshot",
    "tracking error",
    "peer funds",
    "peer etfs"
  );
  const looksFund =
    !!fundMarker &&
    !report.technicals &&
    (!report.catalysts || report.catalysts.length === 0);
  // A " vs " symbol or comparisonMeta turns a fund report into a comparison —
  // those are handled by the comparison path, not the single-fund path.
  const isMulti = symbol.includes(" vs ") || !!report.comparisonMeta;
  if (looksFund && !isMulti) return "fund";
  return null;
}

/* shared: render the remaining standard sections (skipping ones already
 * consumed by a specialised renderer above), continuing the § counter. */
function renderRemainingSections(
  report: StructuredReport,
  skip: Set<ReportSection>,
  startN: number,
  symbol: string,
  onDeepDive?: (q: string) => void
): { blocks: JSX.Element[]; nextN: number } {
  const blocks: JSX.Element[] = [];
  let n = startN;
  for (const s of report.sections ?? []) {
    if (skip.has(s)) continue;
    n += 1;
    const right = onDeepDive ? (
      <AskAi
        onClick={() =>
          onDeepDive(
            `Tell me more about the ${String(s.title).toLowerCase()} of ${symbol}.`
          )
        }
      />
    ) : undefined;

    if (s.type === "news" && s.items && s.items.length > 0) {
      blocks.push(
        <Block key={`sec-${n}`} n={n} title={s.title} right={right}>
          <NewsList items={s.items} />
        </Block>
      );
      continue;
    }
    if (s.type === "risks" && s.items && s.items.length > 0) {
      blocks.push(
        <Block key={`sec-${n}`} n={n} title={s.title} right={right}>
          <RiskList items={s.items} />
        </Block>
      );
      continue;
    }
    if (s.type === "table" && s.columns && s.rows && s.rows.length > 0) {
      blocks.push(
        <Block key={`sec-${n}`} n={n} title={s.title} right={right}>
          <MiniTable
            cols={s.columns}
            rows={s.rows.map((r) => r.map((c) => stripExchangeSuffix(c)))}
            heroRow={0}
          />
        </Block>
      );
      continue;
    }
    // prose / metrics fall-through → KV-ish render
    blocks.push(
      <Block key={`sec-${n}`} n={n} title={s.title} right={right}>
        {s.content ? (
          <p
            style={{
              fontSize: 13.5,
              lineHeight: 1.6,
              color: "var(--ink-2)",
              margin: 0,
            }}
          >
            <CitedText text={s.content} />
          </p>
        ) : (
          <DegradedNote>No data available for this section.</DegradedNote>
        )}
      </Block>
    );
  }
  return { blocks, nextN: n };
}

/* ──────────────────────────────────────────────────────────────────────
 * Item-record helpers — MF item[] rows are records like
 *   {Stock, Weight, Sector} / {Scheme, "3Y CAGR", Expense}.
 * ──────────────────────────────────────────────────────────────────── */

function pickField(
  item: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const k of Object.keys(item)) {
    if (keys.some((want) => k.toLowerCase() === want.toLowerCase()))
      return item[k];
  }
  return undefined;
}

function parsePct(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * FundReport — single mutual fund / ETF.
 * ──────────────────────────────────────────────────────────────────── */

export function FundReport({
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
  const consumed = new Set<ReportSection>();
  let n = startN;

  /* §1 score card + summary */
  n += 1;
  blocks.push(
    <Block
      key={`fund-summary-${n}`}
      n={n}
      title="Fund score card & summary"
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
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {typeof displayScore === "number" && (
          <ScoreDial
            value={displayScore}
            label="Quality score"
            sub="analysis score"
          />
        )}
        {report.summary && (
          <p
            style={{
              flex: 1,
              minWidth: 200,
              fontSize: 14,
              lineHeight: 1.6,
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

  /* §_ Fund overview — KVTable from the "Fund Overview" section prose, or
     from a key:value items[] record if the synthesizer used items. */
  const overview = sectionByTitle(report, "fund overview", "overview");
  if (overview) {
    consumed.add(overview);
    n += 1;
    let rows: KVRow[] = [];
    if (overview.items && overview.items.length > 0) {
      // first item is a {label: value} record
      rows = Object.entries(overview.items[0]!).map(([k, v]) => ({
        k,
        v: stripExchangeSuffix(v),
      }));
    } else if (overview.metrics && overview.metrics.length > 0) {
      rows = overview.metrics.map((m) => ({
        k: m.label,
        v: stripExchangeSuffix(m.value),
      }));
    }
    blocks.push(
      <Block key={`fund-overview-${n}`} n={n} title="Fund overview">
        {rows.length > 0 ? (
          <KVTable rows={rows} />
        ) : overview.content ? (
          <p
            style={{
              fontSize: 13.5,
              lineHeight: 1.6,
              color: "var(--ink-2)",
              margin: 0,
            }}
          >
            <CitedText text={overview.content} />
          </p>
        ) : (
          <DegradedNote>No overview data available.</DegradedNote>
        )}
      </Block>
    );
  }

  /* §_ Returns snapshot — metric tiles from the section's metrics[]. */
  const returns = sectionByTitle(report, "returns snapshot", "returns");
  if (returns && returns.metrics && returns.metrics.length > 0) {
    consumed.add(returns);
    n += 1;
    blocks.push(
      <Block key={`fund-returns-${n}`} n={n} title="Returns snapshot">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))",
            gap: 9,
          }}
        >
          {returns.metrics.map((m, i) => (
            <div
              key={i}
              style={{
                border: "1.5px solid var(--rule-soft)",
                borderRadius: 11,
                padding: "11px 12px",
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
                  fontSize: 17,
                  fontWeight: 700,
                  color:
                    m.trend === "up"
                      ? "var(--up)"
                      : m.trend === "down"
                        ? "var(--down)"
                        : "var(--ink)",
                  marginTop: 4,
                }}
              >
                {stripExchangeSuffix(m.value)}
              </div>
            </div>
          ))}
        </div>
      </Block>
    );
  }

  /* §_ Top holdings — weight bars from items[] {Stock, Weight, Sector}. */
  const holdings = sectionByTitle(report, "top holdings", "holdings");
  if (holdings && holdings.items && holdings.items.length > 0) {
    consumed.add(holdings);
    n += 1;
    const maxW = Math.max(
      1,
      ...holdings.items.map((it) => parsePct(pickField(it, "weight", "w")))
    );
    blocks.push(
      <Block key={`fund-holdings-${n}`} n={n} title="Top holdings">
        {holdings.items.map((it, i) => {
          const name =
            pickField(it, "stock", "name", "scheme", "ticker") || "—";
          const w = parsePct(pickField(it, "weight", "w"));
          return (
            <BarRow
              key={i}
              label={name}
              value={`${w}%`}
              pct={w}
              max={Math.max(maxW, w)}
            />
          );
        })}
      </Block>
    );
  }

  /* §_ Peer funds — table from items[] {Scheme, 1Y, 3Y CAGR, Expense}. */
  const peers = sectionByTitle(report, "peer funds", "peer etfs", "peers");
  if (peers && peers.items && peers.items.length > 0) {
    consumed.add(peers);
    n += 1;
    // derive columns from the union of item keys (excluding the name column)
    const nameKeys = ["scheme", "name", "fund", "ticker"];
    const sample = peers.items[0]!;
    const valueCols = Object.keys(sample).filter(
      (k) => !nameKeys.includes(k.toLowerCase())
    );
    const rows = peers.items.map((it) => {
      const name = pickField(it, ...nameKeys) || Object.values(it)[0] || "—";
      return [name, ...valueCols.map((c) => stripExchangeSuffix(it[c] ?? "—"))];
    });
    blocks.push(
      <Block key={`fund-peers-${n}`} n={n} title="Peer funds">
        <MiniTable cols={["", ...valueCols]} rows={rows} heroRow={0} />
      </Block>
    );
  }

  /* §_ remaining sections (Risk Profile, Tax Treatment, etc.) */
  const rest = renderRemainingSections(report, consumed, n, symbol, onDeepDive);
  blocks.push(...rest.blocks);
  n = rest.nextN;

  return <>{blocks}</>;
}

/* ──────────────────────────────────────────────────────────────────────
 * CompareReport — multi-asset comparison (stocks or funds).
 * ──────────────────────────────────────────────────────────────────── */

export function CompareReport({
  report,
  symbolsList,
  onDeepDive,
  startN = 0,
}: {
  report: StructuredReport;
  symbolsList: string[];
  onDeepDive?: (q: string) => void;
  startN?: number;
}) {
  const blocks: JSX.Element[] = [];
  let n = startN;

  const stockScores = report.comparisonMeta?.stockScores ?? [];
  const perStock = report.comparisonMeta?.perStockBreakdown ?? [];

  /* §1 per-symbol analysis-quality score dials (no winner). */
  if (stockScores.length > 0) {
    n += 1;
    blocks.push(
      <Block
        key={`cmp-meta-${n}`}
        n={n}
        title="Comparison meta · per-symbol score"
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
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
            gap: 12,
          }}
        >
          {stockScores.map((m) => (
            <div
              key={m.symbol}
              style={{
                border: "1.5px solid var(--rule-soft)",
                borderRadius: 11,
                padding: 14,
                textAlign: "center",
                background: "var(--paper-3)",
              }}
            >
              <div
                className="num"
                style={{
                  fontWeight: 700,
                  color: "var(--emerald)",
                  marginBottom: 8,
                }}
              >
                {m.symbol}
              </div>
              <ScoreDial value={m.score} size={72} />
            </div>
          ))}
        </div>
        <div
          className="serif"
          style={{
            marginTop: 10,
            fontSize: 12.5,
            fontStyle: "italic",
            color: "var(--ink-3)",
          }}
        >
          No “winner” is crowned — scores are analysis-quality scores, not
          rankings.
        </div>
      </Block>
    );
  }

  /* §_ per-stock score breakdown bars. */
  for (const stock of perStock) {
    n += 1;
    blocks.push(
      <Block
        key={`cmp-bd-${stock.symbol}-${n}`}
        n={n}
        title={`${stock.symbol} · score breakdown`}
      >
        {stock.criteria.map((c, i) => (
          <BarRow
            key={i}
            label={`${c.criterion} · ${c.score}/${c.maxScore}`}
            value={`${Math.round((c.score / c.maxScore) * 100)}%`}
            pct={(c.score / c.maxScore) * 100}
          />
        ))}
      </Block>
    );
  }

  /* §_ comparison summary (prose). */
  if (report.summary) {
    n += 1;
    blocks.push(
      <Block key={`cmp-summary-${n}`} n={n} title="Comparison summary">
        <p
          style={{
            fontSize: 14.5,
            lineHeight: 1.66,
            color: "var(--ink-2)",
            margin: 0,
          }}
        >
          <CitedText text={report.summary} />
        </p>
      </Block>
    );
  }

  /* §_ standard sections (peer tables, news, risks, etc.). */
  const label = symbolsList.join(" vs ");
  const rest = renderRemainingSections(report, new Set(), n, label, onDeepDive);
  blocks.push(...rest.blocks);
  n = rest.nextN;

  /* §_ SWOT, if the comparison report carries top-level strengths/risks. */
  const hasSwot =
    (report.strengths && report.strengths.length > 0) ||
    (report.risks && report.risks.length > 0) ||
    (report.catalysts && report.catalysts.length > 0);
  if (hasSwot) {
    n += 1;
    blocks.push(
      <Block key={`cmp-swot-${n}`} n={n} title="Strengths · Risks · Catalysts">
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

  return <>{blocks}</>;
}

/* ──────────────────────────────────────────────────────────────────────
 * FundCompareReport — holdings-overlap analysis across funds.
 * ──────────────────────────────────────────────────────────────────── */

interface CommonHolding {
  n: ReactNode;
  weights: number[];
  agg: number;
  flag?: boolean;
}

/**
 * Parse an overlap section into a hero % + a concentration table. The section
 * items[] are records like {Stock, "Fund A", "Fund B", "Aggregate"} where the
 * fund columns carry per-fund weights. We read the fund column order from the
 * comparisonMeta.stocks (or the item keys) and aggregate.
 */
function buildOverlap(
  report: StructuredReport,
  overlap: ReportSection
): { funds: string[]; rows: CommonHolding[]; overallOverlap: number | null } {
  const funds = report.comparisonMeta?.stocks ?? [];
  const items = overlap.items ?? [];
  const nameKeys = ["stock", "name", "holding", "scheme", "ticker"];
  const aggKeys = ["agg", "aggregate", "agg %", "total", "combined"];

  // derive the fund columns: keys that aren't a name / aggregate column.
  const sample = items[0] ?? {};
  const fundCols =
    funds.length > 0
      ? funds
      : Object.keys(sample).filter(
          (k) =>
            !nameKeys.includes(k.toLowerCase()) &&
            !aggKeys.includes(k.toLowerCase())
        );

  const rows: CommonHolding[] = items.map((it) => {
    const name =
      (() => {
        for (const k of Object.keys(it))
          if (nameKeys.includes(k.toLowerCase())) return it[k];
        return Object.values(it)[0];
      })() || "—";
    const weights = fundCols.map((fc) => {
      const key = Object.keys(it).find(
        (k) => k.toLowerCase() === fc.toLowerCase()
      );
      return parsePct(key ? it[key] : undefined);
    });
    const aggKey = Object.keys(it).find((k) =>
      aggKeys.includes(k.toLowerCase())
    );
    const agg = aggKey
      ? parsePct(it[aggKey])
      : Math.round(weights.reduce((a, b) => a + b, 0) * 10) / 10;
    return { n: name, weights, agg, flag: agg >= 15 };
  });

  // overall overlap = mean aggregate of common holdings, capped at 100.
  const overallOverlap =
    rows.length > 0
      ? Math.min(
          100,
          Math.round(rows.reduce((a, r) => a + r.agg, 0) / rows.length)
        )
      : null;

  return { funds: fundCols, rows, overallOverlap };
}

export function FundCompareReport({
  report,
  startN = 0,
}: {
  report: StructuredReport;
  startN?: number;
}) {
  const blocks: JSX.Element[] = [];
  let n = startN;

  const overlap = sectionByTitle(
    report,
    "overlap",
    "common holding",
    "holdings overlap"
  );
  const funds = report.comparisonMeta?.stocks ?? [];
  const parsed = overlap
    ? buildOverlap(report, overlap)
    : { funds, rows: [] as CommonHolding[], overallOverlap: null };

  /* overlap hero — big % + funds list (a section, not a Block, like proto). */
  blocks.push(
    <section
      key="fc-hero"
      style={{ borderTop: "2px solid var(--ink)", padding: "22px 0" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div
          className="num"
          style={{
            fontSize: 56,
            fontWeight: 700,
            lineHeight: 1,
            color: "var(--emerald)",
          }}
        >
          {parsed.overallOverlap != null ? `${parsed.overallOverlap}%` : "—"}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>
            holdings overlap
          </div>
          <div
            className="serif"
            style={{ fontSize: 15, fontStyle: "italic", color: "var(--ink-3)" }}
          >
            {parsed.funds.length > 0
              ? `across ${parsed.funds.join(", ")}`
              : "across the compared funds"}
            {report.summary ? "" : " — overlap concentration shown below."}
          </div>
        </div>
      </div>
      {report.summary && (
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--ink-2)",
            marginTop: 14,
          }}
        >
          <CitedText text={report.summary} />
        </p>
      )}
    </section>
  );

  /* §1 common holdings · held by 2+ funds (concentration table). */
  if (parsed.rows.length > 0) {
    n += 1;
    blocks.push(
      <Block
        key={`fc-common-${n}`}
        n={n}
        title="Common holdings · held by 2+ funds"
      >
        <MiniTableConc
          cols={["", ...parsed.funds, "Agg %"]}
          rows={parsed.rows}
        />
      </Block>
    );
  } else if (overlap?.content) {
    n += 1;
    blocks.push(
      <Block key={`fc-common-${n}`} n={n} title="Overlap observations">
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.6,
            color: "var(--ink-2)",
            margin: 0,
          }}
        >
          <CitedText text={overlap.content} />
        </p>
      </Block>
    );
  }

  /* §_ pairwise overlap matrix (Heatmap) — MONEY-778, deterministic payload
     attached by synthesize-report from compute_holdings_overlap.pairwise. */
  if (
    overlap?.heatmap &&
    Array.isArray(overlap.heatmap.data) &&
    overlap.heatmap.data.length > 0
  ) {
    n += 1;
    blocks.push(
      <Block key={`fc-matrix-${n}`} n={n} title="Pairwise overlap matrix">
        <Heatmap
          rows={overlap.heatmap.rows}
          cols={overlap.heatmap.cols}
          data={overlap.heatmap.data}
          colLabel={overlap.heatmap.colLabel}
          fmt={(x) => `${x}%`}
        />
      </Block>
    );
  }

  /* §_ overlap observations · SEBI-safe (flag chips) — MONEY-778, from the
     overlap tool's flags[]. Neutral data observations, never advice. */
  if (overlap?.flags && overlap.flags.length > 0) {
    n += 1;
    blocks.push(
      <Block key={`fc-obs-${n}`} n={n} title="Overlap observations · SEBI-safe">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {overlap.flags.map((f, i) => (
            <div
              key={i}
              style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
            >
              <FlagChip
                tone={(f.tone as "green" | "amber" | "red" | "blue") ?? "blue"}
              >
                obs
              </FlagChip>
              <span
                style={{
                  fontSize: 13,
                  color: "var(--ink-2)",
                  lineHeight: 1.5,
                }}
              >
                <CitedText text={f.text} />
              </span>
            </div>
          ))}
        </div>
      </Block>
    );
  }

  /* §_ per-fund comparison meta (analysis-quality scores, no winner). */
  const stockScores = report.comparisonMeta?.stockScores ?? [];
  if (stockScores.length > 0) {
    n += 1;
    blocks.push(
      <Block
        key={`fc-meta-${n}`}
        n={n}
        title="Per-fund comparison meta"
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
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
            gap: 12,
          }}
        >
          {stockScores.map((m) => (
            <div
              key={m.symbol}
              style={{
                border: "1.5px solid var(--rule-soft)",
                borderRadius: 11,
                padding: 14,
                textAlign: "center",
                background: "var(--paper-3)",
              }}
            >
              <div
                className="num"
                style={{
                  fontWeight: 700,
                  color: "var(--emerald)",
                  fontSize: 13,
                  marginBottom: 8,
                }}
              >
                {m.symbol}
              </div>
              <ScoreDial value={m.score} size={64} />
            </div>
          ))}
        </div>
      </Block>
    );
  }

  /* §_ remaining sections (distinct holdings, observations, etc.). */
  const consumed = new Set<ReportSection>();
  if (overlap) consumed.add(overlap);
  const rest = renderRemainingSections(
    report,
    consumed,
    n,
    funds.join(" vs "),
    undefined
  );
  blocks.push(...rest.blocks);

  return <>{blocks}</>;
}
