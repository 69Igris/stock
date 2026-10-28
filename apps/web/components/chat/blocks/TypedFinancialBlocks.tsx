"use client";

/**
 * Typed financial chat blocks (MONEY-587) — the 12 rich renderers that stop
 * analysis/research/roast data from collapsing into a generic card/table.
 * Each maps 1:1 to a ContentBlock variant and is dispatched from
 * MessageRenderer. Ported from the StockSage "Playful paper" calm-chat design.
 */

import { useState } from "react";
import Link from "next/link";
import type {
  PortfolioBlock,
  HoldingsBlock,
  TaxReportBlock,
  RiskBlock,
  MutualFundBlock,
  FireBlock,
  SectorBlock,
  TechnicalBlock,
  NewsBlock,
  ScorecardBlock,
  PnlBlock,
  DividendBlock,
} from "@usemoney/types";
import {
  ChatBlock,
  BIcon,
  SEBI,
  SEBI_SHORT,
  PartialBanner,
  CbEmpty,
  ND,
  NeedsData,
  Donut,
  Gauge,
  MiniArea,
  ScoreDial,
  BarRow,
  Underwater,
  Favicon,
  Sentiment,
  FlagChip,
  ConfidencePill,
  withStates,
  inr,
  inrShort,
  signedInr,
  // MONEY-587 (task #35): wire the previously-dead primitives into renderers.
  Sparkline,
  TrendArrow,
  VerdictDot,
  MetricStrip,
  KVTable,
  RangeBar,
  RadarChart,
  StackedBar,
  Heatmap,
  FanChart,
  Candles,
  IndicatorRow,
  type MetricTileItem,
  type Candle,
  type CandleMarker,
  type BlockState,
} from "./ChatBlock";

const SEG_COLORS = [
  "var(--emerald-pure)",
  "var(--blue)",
  "var(--purple)",
  "var(--gold-fill)",
  "var(--coral)",
  "var(--pink)",
];

/* ── 1 · Portfolio summary ──────────────────────────────────────────── */
export function PortfolioBlockRenderer({
  block: d,
}: {
  block: PortfolioBlock;
}) {
  // Reference wiring for the withStates state machine + per-type skeleton.
  const state: BlockState =
    d.totalValue == null ? "empty" : d.partial ? "partial" : "normal";
  const stateCfg = {
    icon: "briefcase",
    title: d.title ?? "Portfolio summary",
    sub: d.subtitle,
    disclaimer: SEBI_SHORT,
    emptyIcon: "briefcase",
    emptyTitle: "No portfolio yet",
    emptyDesc: "Connect a broker to see your holdings here.",
    partialNote: "Day P&L still syncing from one broker.",
  };
  // loading / empty / error → typed skeleton or CbEmpty / CbError chrome.
  const chrome = withStates(state, "metric", stateCfg);
  if (chrome) return chrome;
  const segments = d.segments ?? [];
  return (
    <ChatBlock
      icon="briefcase"
      title={d.title ?? "Portfolio summary"}
      sub={d.subtitle}
      disclaimer={SEBI_SHORT}
    >
      {withStates(state, "metric", stateCfg, { bannerOnly: true })}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="cb-label">Total value</div>
          <div className="cb-hero" style={{ fontSize: 34, marginTop: 3 }}>
            {inr(d.totalValue)}
          </div>
        </div>
        {d.dayChange && (
          <div style={{ textAlign: "right" }}>
            <div className="cb-label">Today</div>
            <div
              className={
                "cb-delta " + (d.dayChange.amount >= 0 ? "pos" : "neg")
              }
              style={{ marginTop: 5 }}
            >
              <BIcon name={d.dayChange.amount >= 0 ? "up" : "down"} size={12} />{" "}
              {signedInr(d.dayChange.amount)} · {d.dayChange.pct}%
            </div>
          </div>
        )}
      </div>
      <div className="cb-tiles" style={{ marginTop: 14 }}>
        {d.totalPnL && (
          <div className="cb-tile">
            <div className="l">Total P&amp;L</div>
            <div className={"v " + (d.totalPnL.pct >= 0 ? "cb-pos" : "cb-neg")}>
              {d.totalPnL.pct >= 0 ? "+" : ""}
              {d.totalPnL.pct}%
            </div>
          </div>
        )}
        {d.holdingsValue != null && (
          <div className="cb-tile">
            <div className="l">Holdings</div>
            <div className="v">{inrShort(d.holdingsValue)}</div>
          </div>
        )}
        {d.mfValue != null && (
          <div className="cb-tile">
            <div className="l">MF</div>
            <div className="v">{inrShort(d.mfValue)}</div>
          </div>
        )}
        {d.openPositions != null && (
          <div className="cb-tile">
            <div className="l">Open F&amp;O</div>
            <div className="v">{d.openPositions}</div>
          </div>
        )}
      </div>
      {segments.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="cb-label" style={{ marginBottom: 7 }}>
            Segment allocation
          </div>
          <div className="cb-seg">
            {segments.map((s, i) => (
              <span
                key={i}
                style={{
                  width: s.pct + "%",
                  background: s.color ?? SEG_COLORS[i % SEG_COLORS.length],
                }}
                title={`${s.label} ${s.pct}%`}
              />
            ))}
          </div>
          <div className="cb-legend">
            {segments.map((s, i) => (
              <span key={i} className="it">
                <span
                  className="sw"
                  style={{
                    background: s.color ?? SEG_COLORS[i % SEG_COLORS.length],
                  }}
                />
                {s.label}{" "}
                <b className="num" style={{ color: "var(--ink)" }}>
                  {s.pct}%
                </b>
              </span>
            ))}
          </div>
        </div>
      )}
      {d.brokers && d.brokers.length > 0 && (
        <div
          style={{ marginTop: 14, display: "flex", gap: 7, flexWrap: "wrap" }}
        >
          {d.brokers.map((b, i) => (
            <span key={i} className="cb-chip">
              <span
                className="lg"
                style={{ background: SEG_COLORS[i % SEG_COLORS.length] }}
              />
              {b}
            </span>
          ))}
        </div>
      )}
    </ChatBlock>
  );
}

/* ── 2 · Holdings (sortable) ────────────────────────────────────────── */
export function HoldingsBlockRenderer({ block: d }: { block: HoldingsBlock }) {
  const [sort, setSort] = useState<"pnl" | "day" | "ltp">("pnl");
  const [all, setAll] = useState(false);
  const rows = d.rows ?? [];
  if (rows.length === 0) {
    return (
      <ChatBlock
        icon="layers"
        iconBg="var(--blue)"
        title={d.title ?? "Holdings"}
      >
        <CbEmpty
          icon="layers"
          title="No holdings"
          desc="Connect a broker to see your holdings here."
        />
      </ChatBlock>
    );
  }
  const sorted = [...rows].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));
  const shown = all ? sorted : sorted.slice(0, 4);
  const cols: Array<[string, string]> = [
    ["symbol", "Symbol"],
    ["qty", "Qty"],
    ["avg", "Avg"],
    ["ltp", "LTP"],
    ["pnl", "P&L"],
    ["day", "Day %"],
  ];
  const sortable = new Set(["pnl", "day", "ltp"]);
  return (
    <ChatBlock
      icon="layers"
      iconBg="var(--blue)"
      title={d.title ?? "Holdings"}
      sub={rows.length + " positions"}
      disclaimer={SEBI_SHORT}
      cta={
        rows.length > 4 && (
          <button className="cb-nav-link" onClick={() => setAll((a) => !a)}>
            {all ? "Show less" : `Show all ${rows.length}`}
            <BIcon name={all ? "chevron" : "chevronR"} size={12} />
          </button>
        )
      }
    >
      {d.partial && <PartialBanner>Live prices updating…</PartialBanner>}
      <div className="cb-table-scroll">
        <table className="cb-tbl">
          <thead>
            <tr>
              {cols.map(([k, l]) => (
                <th
                  key={k}
                  className={sortable.has(k) ? "sortable" : ""}
                  onClick={() =>
                    sortable.has(k) && setSort(k as "pnl" | "day" | "ltp")
                  }
                >
                  {l}
                  {sort === k && <span className="arr">▾</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                <td>
                  {r.symbol}
                  {r.sector && (
                    <div
                      style={{
                        fontFamily: "DM Sans",
                        fontWeight: 400,
                        fontSize: 10,
                        color: "var(--ink-4)",
                      }}
                    >
                      {r.sector}
                    </div>
                  )}
                </td>
                <td>{r.qty}</td>
                <td>{r.avg}</td>
                <td>{r.ltp}</td>
                <td className={r.pnl >= 0 ? "cb-pos" : "cb-neg"}>
                  {signedInr(r.pnl)}
                  <div style={{ fontSize: 10 }}>
                    {r.pnlPct >= 0 ? "+" : ""}
                    {r.pnlPct}%
                  </div>
                </td>
                <td className={(r.day ?? 0) >= 0 ? "cb-pos" : "cb-neg"}>
                  {r.day != null ? (
                    (r.day >= 0 ? "+" : "") + r.day + "%"
                  ) : (
                    <ND />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChatBlock>
  );
}

/* ── 3 · Tax report ─────────────────────────────────────────────────── */
export function TaxReportBlockRenderer({
  block: d,
}: {
  block: TaxReportBlock;
}) {
  return (
    <ChatBlock
      icon="file"
      iconBg="var(--gold-fill)"
      title={d.title ?? "Tax report"}
      sub={d.fy}
      disclaimer={SEBI}
      cta={
        // MONEY-1121 - nothing to export when no trades were booked; offering
        // it invites the user to download an empty ITR schedule.
        d.noRealisedTrades ? undefined : (
          <button className="cb-nav-link primary">
            <BIcon name="download" size={12} /> Export to ITR
          </button>
        )
      }
    >
      {d.partial && (
        <PartialBanner>
          LTCG tax still resolving — exemption not yet applied.
        </PartialBanner>
      )}
      {/*
        MONEY-1121 - say "nothing to report" in words. The card previously
        rendered STCG ₹0, LTCG ₹0 and four ₹0 advance-tax quarters, which reads
        as a broken calculation rather than an accurate empty year.
      */}
      {d.noRealisedTrades && (
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
          No shares or units were sold in {d.fy ?? "this financial year"}, so
          there are no capital gains to report yet — nothing is owed and there
          is nothing to file.
          {d.harvest && d.harvest.length > 0 && (
            <> Unrealised positions you could still act on are listed below.</>
          )}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
        {d.stcg && (
          <div className="cb-tile">
            <div className="l">STCG · 111A</div>
            <div className="v">{inrShort(d.stcg.gains)}</div>
            <div
              className="num"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}
            >
              tax {inr(d.stcg.tax)}
            </div>
          </div>
        )}
        {d.ltcg && (
          <div className="cb-tile">
            <div className="l">LTCG · 112A</div>
            <div className="v">{inrShort(d.ltcg.gains)}</div>
            <div
              className="num"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3 }}
            >
              tax {inr(d.ltcg.tax)}
              {d.ltcg.exemptUsed != null && (
                <> · {inrShort(d.ltcg.exemptUsed)} exempt used</>
              )}
            </div>
          </div>
        )}
      </div>
      {d.harvest && d.harvest.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 7px" }}>
            Harvesting opportunities
          </div>
          <div className="cb-stock-list">
            {d.harvest.map((h, i) => (
              <div key={i} className="cb-stock-row">
                <span
                  className="cb-ico"
                  style={{ background: "var(--coral)", width: 24, height: 24 }}
                >
                  <BIcon name="trendDown" size={12} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="tk">{h.symbol}</div>
                  <div className="nm">{h.action}</div>
                </div>
                <div
                  className="num cb-neg"
                  style={{ fontWeight: 700, fontSize: 12.5 }}
                >
                  −{inr(h.loss)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {d.advance && d.advance.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 9px" }}>
            Advance-tax schedule
          </div>
          <div
            style={{ display: "flex", gap: 6, justifyContent: "space-between" }}
          >
            {d.advance.map((a, i) => (
              <div key={i} style={{ flex: 1, textAlign: "center" }}>
                <div
                  style={{
                    height: 5,
                    borderRadius: 99,
                    background: a.paid
                      ? "var(--emerald-pure)"
                      : "var(--rule-soft)",
                    marginBottom: 6,
                  }}
                />
                <div className="num" style={{ fontSize: 11, fontWeight: 700 }}>
                  {inrShort(a.amount)}
                </div>
                <div
                  className="num"
                  style={{
                    fontSize: 9,
                    color: a.paid ? "var(--emerald)" : "var(--ink-4)",
                  }}
                >
                  {a.due}
                  {a.paid ? " ✓" : ""}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {d.itr && (
        <div
          className="cb-kv"
          style={{
            marginTop: 14,
            borderTop: "1px dashed var(--rule-soft)",
            paddingTop: 10,
          }}
        >
          <span className="k">Filing schedule</span>
          <span className="v">{d.itr}</span>
        </div>
      )}
    </ChatBlock>
  );
}

/** Concentration metric tiles for the risk block. Data-quality verdict colour
 * (good/fair/poor) is a neutral concentration band, never buy/sell. */
function concentrationTiles(
  c: NonNullable<RiskBlock["concentration"]>
): MetricTileItem[] {
  const band = (
    v: number,
    poorAt: number,
    fairAt: number
  ): MetricTileItem["verdict"] =>
    v >= poorAt ? "poor" : v >= fairAt ? "fair" : "good";
  const tiles: MetricTileItem[] = [];
  if (c.top != null)
    tiles.push({
      label: "Top holding",
      value: `${c.top}%`,
      verdict: band(c.top, 25, 15),
    });
  if (c.top5 != null)
    tiles.push({
      label: "Top 5",
      value: `${c.top5}%`,
      verdict: band(c.top5, 70, 50),
    });
  if (c.hhi != null)
    tiles.push({
      label: "HHI",
      value: String(c.hhi),
      verdict: band(c.hhi, 2500, 1500),
    });
  return tiles;
}

/* ── 4 · Risk analysis ──────────────────────────────────────────────── */
export function RiskBlockRenderer({ block: d }: { block: RiskBlock }) {
  // Reference wiring for the withStates state machine + per-type skeleton.
  const hasAnyMetric =
    d.var1d != null ||
    d.var1w != null ||
    d.sharpe != null ||
    (d.drawdownSeries?.length ?? 0) > 1 ||
    d.concentration != null ||
    (d.heatmap?.labels.length ?? 0) > 0 ||
    (d.rebalance?.length ?? 0) > 0;
  const state: BlockState = !hasAnyMetric
    ? "empty"
    : d.partial
      ? "partial"
      : "normal";
  const stateCfg = {
    icon: "shield",
    iconBg: "var(--coral)",
    title: d.title ?? "Risk analysis",
    sub: "portfolio",
    disclaimer: SEBI,
    emptyIcon: "shield",
    emptyTitle: "Not enough history",
    emptyDesc: "Risk metrics need at least 30 days of portfolio history.",
    partialNote: "Risk metrics still computing.",
  };
  const chrome = withStates(state, "metric", stateCfg);
  if (chrome) return chrome;
  return (
    <ChatBlock
      icon="shield"
      iconBg="var(--coral)"
      title={d.title ?? "Risk analysis"}
      sub="portfolio"
      disclaimer={SEBI}
    >
      {withStates(state, "metric", stateCfg, { bannerOnly: true })}
      <div className="cb-tiles">
        {d.var1d != null && (
          <div className="cb-tile">
            <div className="l">VaR · 1-day (95%)</div>
            <div className="v cb-neg">{d.var1d}%</div>
          </div>
        )}
        {d.var1w != null && (
          <div className="cb-tile">
            <div className="l">VaR · 1-week</div>
            <div className="v cb-neg">{d.var1w}%</div>
          </div>
        )}
        {d.sharpe != null && (
          <div className="cb-tile">
            <div className="l">Sharpe</div>
            <div className="v">{d.sharpe}</div>
          </div>
        )}
      </div>
      {d.drawdownSeries && d.drawdownSeries.length > 1 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 6px" }}>
            Max drawdown{d.maxDD != null ? ` · ${d.maxDD}%` : ""}
          </div>
          <div
            style={{
              border: "1.5px solid var(--rule-soft)",
              borderRadius: 10,
              padding: 8,
            }}
          >
            <Underwater data={d.drawdownSeries} height={70} />
          </div>
        </>
      )}
      {d.concentration && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 7px" }}>
            Concentration
          </div>
          <MetricStrip items={concentrationTiles(d.concentration)} />
        </>
      )}
      {d.heatmap && d.heatmap.labels.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 7px" }}>
            Correlation heatmap
          </div>
          <Heatmap
            rows={d.heatmap.labels}
            cols={d.heatmap.labels}
            data={d.heatmap.data}
            fmt={(x) => x.toFixed(2)}
          />
        </>
      )}
      {d.rebalance && d.rebalance.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 7px" }}>
            Rebalancing observations
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {d.rebalance.map((r, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  fontSize: 12.5,
                  color: "var(--ink-2)",
                }}
              >
                <FlagChip
                  tone={
                    r.tone === "red"
                      ? "red"
                      : r.tone === "blue"
                        ? "blue"
                        : "amber"
                  }
                >
                  obs
                </FlagChip>
                {r.text}
              </div>
            ))}
          </div>
        </>
      )}
    </ChatBlock>
  );
}

/* ── 5 · Mutual fund overview ───────────────────────────────────────── */
export function MutualFundBlockRenderer({
  block: d,
}: {
  block: MutualFundBlock;
}) {
  const ret = d.returns ?? {};
  return (
    <ChatBlock
      icon="pieChart"
      iconBg="var(--purple)"
      title={d.scheme}
      sub={d.category}
      disclaimer={SEBI}
      cta={
        <button className="cb-nav-link">
          <BIcon name="external" size={12} /> Full fund report
        </button>
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div className="cb-label">NAV</div>
          <div className="cb-hero" style={{ fontSize: 28, marginTop: 3 }}>
            ₹{d.nav}
          </div>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          {(
            [
              ["1Y", ret.y1],
              ["3Y", ret.y3],
              ["5Y", ret.y5],
            ] as const
          ).map(([k, v]) =>
            v != null ? (
              <div key={k} style={{ textAlign: "right" }}>
                <div className="cb-label">{k}</div>
                <div
                  className={"num " + (v >= 0 ? "cb-pos" : "cb-neg")}
                  style={{ fontSize: 15, fontWeight: 700 }}
                >
                  {v >= 0 ? "+" : ""}
                  {v}%
                </div>
              </div>
            ) : null
          )}
        </div>
      </div>
      {d.partial && (
        <PartialBanner>
          Category percentile still computing from peer set.
        </PartialBanner>
      )}
      <div className="cb-tiles" style={{ marginTop: 14 }}>
        {d.aum != null && (
          <div className="cb-tile">
            <div className="l">AUM</div>
            <div className="v">₹{(d.aum / 1000).toFixed(0)}k Cr</div>
          </div>
        )}
        {d.expense != null && (
          <div className="cb-tile">
            <div className="l">Expense</div>
            <div className="v">{d.expense}%</div>
          </div>
        )}
        {d.percentile != null && (
          <div className="cb-tile">
            <div className="l">Category</div>
            <div className="v" style={{ fontSize: 13 }}>
              {d.percentile}ᵗʰ pct
            </div>
          </div>
        )}
      </div>
      {d.percentile != null && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 7px" }}>
            Category percentile
          </div>
          <div className="cb-bar-track">
            <div
              className="cb-bar-fill"
              style={{
                width: d.percentile + "%",
                background: "var(--emerald-pure)",
              }}
            />
          </div>
        </>
      )}
      {d.top && d.top.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 7px" }}>
            Top holdings
          </div>
          {d.top.map((h, i) => (
            <BarRow
              key={i}
              label={h.name}
              value={h.weight + "%"}
              pct={h.weight}
              max={Math.max(9, ...d.top!.map((x) => x.weight))}
            />
          ))}
        </>
      )}
    </ChatBlock>
  );
}

/* ── 6 · FIRE projection ────────────────────────────────────────────── */
export function FireBlockRenderer({ block: d }: { block: FireBlock }) {
  const pctToTarget = d.targetCorpus ? d.currentCorpus / d.targetCorpus : 0;
  return (
    <ChatBlock
      icon="flame"
      iconBg="var(--coral)"
      title="FIRE projection"
      sub="financial independence"
      disclaimer={SEBI_SHORT}
    >
      {d.partial && (
        <PartialBanner>
          Projection still running — withdrawal rate pending.
        </PartialBanner>
      )}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <Gauge
          pct={pctToTarget}
          value={(d.yearsToFI ?? "—") + "y"}
          label="to FI"
          tone="var(--coral)"
        />
        <div style={{ flex: 1, minWidth: 150 }}>
          <KVTable
            rows={[
              { k: "Current corpus", v: inrShort(d.currentCorpus) },
              { k: "Target corpus", v: inrShort(d.targetCorpus) },
              ...(d.monthlySIP != null
                ? [{ k: "Monthly SIP", v: inr(d.monthlySIP) }]
                : []),
              ...(d.withdrawalRate != null
                ? [{ k: "Withdrawal rate", v: `${d.withdrawalRate}%` }]
                : []),
            ]}
          />
        </div>
      </div>
      {d.fan ? (
        <>
          <div className="cb-label" style={{ margin: "14px 0 6px" }}>
            Corpus projection cone · ₹Cr
          </div>
          <div
            style={{
              border: "1.5px solid var(--rule-soft)",
              borderRadius: 10,
              padding: 8,
            }}
          >
            <FanChart bands={d.fan} height={140} />
          </div>
        </>
      ) : (
        d.projection &&
        d.projection.length > 1 && (
          <>
            <div className="cb-label" style={{ margin: "14px 0 6px" }}>
              Corpus projection · ₹Cr
            </div>
            <div
              style={{
                border: "1.5px solid var(--rule-soft)",
                borderRadius: 10,
                padding: 8,
              }}
            >
              <MiniArea data={d.projection} tone="var(--coral)" h={60} />
            </div>
          </>
        )
      )}
      {d.scenario && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 6px" }}>
            Terminal corpus · scenario range (₹Cr)
          </div>
          <RangeBar
            low={d.scenario.low}
            mid={d.scenario.mid}
            high={d.scenario.high}
            current={d.scenario.current ?? null}
            lo={d.scenario.low}
            hi={d.scenario.high}
            fmt={(x) => "₹" + x.toFixed(1) + "Cr"}
          />
        </>
      )}
    </ChatBlock>
  );
}

/* ── 7 · Sector allocation ──────────────────────────────────────────── */
export function SectorBlockRenderer({ block: d }: { block: SectorBlock }) {
  const sectors = d.sectors ?? [];
  if (sectors.length === 0) {
    return (
      <ChatBlock
        icon="pieChart"
        iconBg="var(--blue)"
        title={d.title ?? "Sector allocation"}
      >
        <CbEmpty
          icon="pieChart"
          title="No holdings to allocate"
          desc="Connect a broker to see your sector mix."
        />
      </ChatBlock>
    );
  }
  const verdictTone: Record<string, string> = {
    overweight: "var(--gold-tx)",
    underweight: "var(--pop-3-text)",
    fair: "var(--ink-3)",
  };
  return (
    <ChatBlock
      icon="pieChart"
      iconBg="var(--blue)"
      title={d.title ?? "Sector allocation"}
      disclaimer={SEBI_SHORT}
    >
      {d.partial && (
        <PartialBanner>
          Over/under-weight verdicts still being classified.
        </PartialBanner>
      )}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <Donut
          slices={sectors.map((s, i) => ({
            v: s.pct,
            color: s.color ?? SEG_COLORS[i % SEG_COLORS.length],
          }))}
        />
        <div style={{ flex: 1, minWidth: 170 }}>
          {sectors.map((s, i) => (
            <div key={i} className="cb-kv">
              <span
                className="k"
                style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
              >
                <VerdictDot
                  v={
                    s.verdict === "overweight"
                      ? "poor"
                      : s.verdict === "underweight"
                        ? "fair"
                        : "good"
                  }
                />
                {s.sector}
              </span>
              <span
                className="v"
                style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
              >
                {s.pct}%
                {s.verdict && s.verdict !== "fair" && (
                  <span
                    className="num"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: verdictTone[s.verdict],
                    }}
                  >
                    {s.verdict === "overweight" ? "▲ OW" : "▼ UW"}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <div className="cb-label" style={{ marginBottom: 8 }}>
          Allocation breakdown
        </div>
        <StackedBar
          items={sectors.map((s, i) => ({
            label: s.sector,
            value: s.pct,
            unit: "%",
            color: s.color ?? SEG_COLORS[i % SEG_COLORS.length],
          }))}
          total={100}
        />
      </div>
    </ChatBlock>
  );
}

/* ── 8 · Technical readout ──────────────────────────────────────────── */
export function TechnicalBlockRenderer({
  block: d,
}: {
  block: TechnicalBlock;
}) {
  const rsi = d.rsi;
  const rsiTone =
    rsi == null
      ? "var(--ink-3)"
      : rsi > 70
        ? "var(--poor)"
        : rsi < 30
          ? "var(--good)"
          : "var(--ink-3)";
  const sma = d.sma ?? {};
  // Indicator dashboard: prefer producer-supplied groups; otherwise derive a
  // single "Indicator dashboard" group from the scalar readings we have so the
  // IndicatorRow primitive always has signal-tagged rows to render.
  const derivedRows: Array<{
    name: string;
    value: string;
    signal: "bullish" | "bearish" | "neutral";
  }> = [];
  if (d.trend) {
    const t = d.trend.toLowerCase();
    derivedRows.push({
      name: "Trend",
      value: d.trend,
      signal: t.includes("up")
        ? "bullish"
        : t.includes("down")
          ? "bearish"
          : "neutral",
    });
  }
  if (rsi != null) {
    derivedRows.push({
      name: "RSI (14)",
      value: String(rsi),
      signal: rsi > 70 ? "bearish" : rsi < 30 ? "bullish" : "neutral",
    });
  }
  if (d.macd != null) {
    derivedRows.push({
      name: "MACD",
      value: (d.macd >= 0 ? "+" : "") + d.macd,
      signal: d.macd > 0 ? "bullish" : d.macd < 0 ? "bearish" : "neutral",
    });
  }
  if (sma["50"] != null && sma["200"] != null) {
    const golden = sma["50"] >= sma["200"];
    derivedRows.push({
      name: "SMA 50/200",
      value: golden ? "above" : "below",
      signal: golden ? "bullish" : "bearish",
    });
  }
  const indicatorGroups =
    d.indicatorGroups && d.indicatorGroups.length > 0
      ? d.indicatorGroups
      : derivedRows.length > 0
        ? [{ group: "", rows: derivedRows }]
        : [];
  return (
    <ChatBlock
      icon="candle"
      iconBg="var(--gold-fill)"
      title={`${d.symbol} · technicals`}
      sub={d.trend}
      disclaimer={SEBI}
      cta={
        <button className="cb-nav-link">
          <BIcon name="candle" size={12} /> Open TradingView chart
        </button>
      }
    >
      {d.partial && (
        <PartialBanner>
          MACD &amp; pattern scan still running on live ticks.
        </PartialBanner>
      )}
      {d.candles && d.candles.length > 1 && (
        <div
          style={{
            border: "1.5px solid var(--rule-soft)",
            borderRadius: 10,
            padding: 8,
            marginBottom: 12,
          }}
        >
          <Candles
            data={d.candles as Candle[]}
            markers={(d.patternMarkers ?? []) as CandleMarker[]}
            height={160}
          />
        </div>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {rsi != null && (
          <div
            className="cb-tile"
            style={{
              flex: 1,
              minWidth: 120,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Gauge
              pct={rsi / 100}
              size={78}
              value={rsi}
              label="RSI"
              tone={rsiTone}
            />
            <div>
              <div className="l">RSI (14)</div>
              <div
                className="num"
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}
              >
                {rsi > 70 ? "overbought" : rsi < 30 ? "oversold" : "neutral"}
              </div>
            </div>
          </div>
        )}
        {(d.macd != null || sma["20"] != null) && (
          <div className="cb-tile" style={{ flex: 1, minWidth: 120 }}>
            <div className="l">MACD</div>
            {d.macd != null ? (
              <div className={"v " + (d.macd >= 0 ? "cb-pos" : "cb-neg")}>
                {d.macd >= 0 ? "+" : ""}
                {d.macd}
              </div>
            ) : (
              <div className="v">
                <ND />
              </div>
            )}
            {(sma["20"] != null || sma["50"] != null || sma["200"] != null) && (
              <div
                className="num"
                style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 5 }}
              >
                {sma["20"] != null && <>SMA20 {sma["20"]} </>}
                {sma["50"] != null && <>· 50 {sma["50"]} </>}
                {sma["200"] != null && <>· 200 {sma["200"]}</>}
              </div>
            )}
          </div>
        )}
      </div>
      {((d.support?.length ?? 0) > 0 || (d.resistance?.length ?? 0) > 0) && (
        <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
          <div className="cb-tile" style={{ flex: 1 }}>
            <div className="l">Support</div>
            <div
              className="num"
              style={{ fontSize: 13, fontWeight: 700, color: "var(--up)" }}
            >
              {(d.support ?? []).map((s) => "₹" + s).join(" · ") || <ND />}
            </div>
          </div>
          <div className="cb-tile" style={{ flex: 1 }}>
            <div className="l">Resistance</div>
            <div
              className="num"
              style={{ fontSize: 13, fontWeight: 700, color: "var(--down)" }}
            >
              {(d.resistance ?? []).map((s) => "₹" + s).join(" · ") || <ND />}
            </div>
          </div>
        </div>
      )}
      {d.patterns && d.patterns.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 8px" }}>
            Detected patterns
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {d.patterns.map((p, i) => (
              <span
                key={i}
                className="cb-chip"
                style={{
                  borderColor:
                    p.direction === "bullish" ? "var(--up)" : "var(--down)",
                  color:
                    p.direction === "bullish" ? "var(--up)" : "var(--down)",
                }}
              >
                <BIcon
                  name={p.direction === "bullish" ? "trend" : "trendDown"}
                  size={11}
                />
                {p.name}
                {p.kind && (
                  <span style={{ color: "var(--ink-4)", fontSize: 9 }}>
                    {p.kind}
                  </span>
                )}
              </span>
            ))}
          </div>
        </>
      )}
      {indicatorGroups.length > 0 && (
        <>
          <div className="cb-label" style={{ margin: "16px 0 6px" }}>
            Indicator dashboard
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
              gap: "0 22px",
            }}
          >
            {indicatorGroups.map((g, gi) => (
              <div key={gi}>
                {g.group && (
                  <div
                    className="cb-label"
                    style={{ margin: gi > 1 ? "10px 0 2px" : "0 0 2px" }}
                  >
                    {g.group}
                  </div>
                )}
                {g.rows.map((r, ri) => (
                  <IndicatorRow
                    key={ri}
                    name={r.name}
                    value={r.value}
                    signal={r.signal}
                  />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </ChatBlock>
  );
}

/* ── 9 · News ───────────────────────────────────────────────────────── */
export function NewsBlockRenderer({ block: d }: { block: NewsBlock }) {
  const articles = d.articles ?? [];
  if (articles.length === 0) {
    return (
      <ChatBlock
        icon="newspaper"
        iconBg="var(--blue)"
        title={d.title ?? "News"}
      >
        <CbEmpty
          icon="newspaper"
          title="No recent news"
          desc="Nothing published for this query recently."
        />
      </ChatBlock>
    );
  }
  return (
    <ChatBlock
      icon="newspaper"
      iconBg="var(--blue)"
      title={d.title ?? "News"}
      sub={articles.length + " articles"}
    >
      {d.partial && (
        <PartialBanner>
          Sentiment tagging still in progress for some articles.
        </PartialBanner>
      )}
      <div className="cb-stock-list">
        {articles.map((a, i) => (
          <a
            key={i}
            href={a.url ?? "#"}
            target={a.url ? "_blank" : undefined}
            rel="noopener noreferrer"
            className="cb-stock-row"
            style={{ textDecoration: "none" }}
          >
            <Favicon domain={a.domain} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--ink)",
                  lineHeight: 1.35,
                }}
              >
                {a.headline}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 7,
                  alignItems: "center",
                  marginTop: 4,
                  flexWrap: "wrap",
                }}
              >
                {a.source && (
                  <span
                    className="num"
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      fontWeight: 600,
                    }}
                  >
                    {a.source}
                  </span>
                )}
                {a.at && (
                  <span
                    className="num"
                    style={{ fontSize: 10, color: "var(--ink-4)" }}
                  >
                    · {a.at}
                  </span>
                )}
                {a.sentiment && <Sentiment s={a.sentiment} />}
              </div>
            </div>
            <BIcon
              name="external"
              size={13}
              style={{ color: "var(--ink-4)" }}
            />
          </a>
        ))}
      </div>
    </ChatBlock>
  );
}

/* ── 10 · Scorecard (L3/L4 comprehensive analysis) ──────────────────── */
export function ScorecardBlockRenderer({
  block: d,
}: {
  block: ScorecardBlock;
}) {
  const [open, setOpen] = useState(0);
  const sections = d.sections ?? [];
  return (
    <ChatBlock
      icon="sparkles"
      iconBg="var(--emerald-pure)"
      title={
        d.title ??
        (d.symbol
          ? `${d.symbol} · comprehensive analysis`
          : "Comprehensive analysis")
      }
      sub="scored"
      disclaimer={SEBI}
      cta={
        d.sessionId ? (
          <Link href={`/analysis/${d.sessionId}`} className="cb-nav-link">
            <BIcon name="external" size={12} /> Open in Research
          </Link>
        ) : undefined
      }
    >
      {d.partial && (
        <PartialBanner>
          Some sections still being scored — confidence may rise.
        </PartialBanner>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "4px 0 12px",
          borderBottom: "1px dashed var(--rule-soft)",
          marginBottom: 12,
        }}
      >
        <ScoreDial
          value={d.overall}
          size={62}
          tone={d.overall >= 75 ? "good" : d.overall >= 55 ? "fair" : "poor"}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              gap: 7,
              alignItems: "center",
              marginBottom: 5,
            }}
          >
            <span className="cb-label">Verdict</span>
            {d.confidence && <ConfidencePill level={d.confidence} />}
          </div>
          {d.verdict && (
            <div
              style={{
                fontSize: 15,
                color: "var(--ink-2)",
                lineHeight: 1.35,
                fontFamily: "Instrument Serif, serif",
              }}
            >
              {d.verdict}
            </div>
          )}
        </div>
      </div>
      {sections.length >= 3 && (
        <div style={{ marginBottom: 14 }}>
          <div className="cb-label" style={{ marginBottom: 4 }}>
            Section scores
          </div>
          <RadarChart
            axes={sections.map((s) =>
              s.title.length > 14 ? s.title.slice(0, 13) + "…" : s.title
            )}
            series={[{ values: sections.map((s) => s.score) }]}
            size={200}
          />
        </div>
      )}
      {sections.map((s, i) => (
        <div key={i} className="cb-acc">
          <button
            className="cb-acc-head"
            onClick={() => setOpen((o) => (o === i ? -1 : i))}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background:
                  s.score >= 75
                    ? "var(--good)"
                    : s.score >= 55
                      ? "var(--fair)"
                      : "var(--poor)",
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
              {s.title}
            </span>
            <span
              className="num"
              style={{ fontSize: 12, fontWeight: 700, color: "var(--emerald)" }}
            >
              {s.score}
              <span style={{ color: "var(--ink-4)", fontWeight: 500 }}>
                /100
              </span>
            </span>
            <BIcon
              name="chevron"
              size={14}
              style={{
                color: "var(--ink-4)",
                transform: open === i ? "none" : "rotate(-90deg)",
                transition: ".15s",
              }}
            />
          </button>
          {open === i && (
            <div className="cb-acc-body">
              {s.summary && (
                <p
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    lineHeight: 1.5,
                    marginBottom: 9,
                  }}
                >
                  {s.summary}{" "}
                  {(s.cites ?? []).map((c) => (
                    <span key={c} className="cb-cite" style={{ marginLeft: 3 }}>
                      {c}
                    </span>
                  ))}
                </p>
              )}
              {s.metrics && s.metrics.length > 0 && (
                <div className="cb-tiles">
                  {s.metrics.map(([l, v], j) => (
                    <div key={j} className="cb-tile">
                      <div className="l">{l}</div>
                      <div className="v" style={{ fontSize: 14 }}>
                        {v}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </ChatBlock>
  );
}

/* ── 11 · P&L summary ───────────────────────────────────────────────── */
export function PnlBlockRenderer({ block: d }: { block: PnlBlock }) {
  const realized = d.realized ?? 0;
  const unrealized = d.unrealized ?? 0;
  const total = realized + unrealized;
  return (
    <ChatBlock
      icon="trend"
      iconBg="var(--emerald-pure)"
      title="P&L summary"
      sub={d.trades != null ? d.trades + " trades" : undefined}
      disclaimer={SEBI_SHORT}
    >
      {d.partial && (
        <PartialBanner>
          Win-rate &amp; best/worst still aggregating across brokers.
        </PartialBanner>
      )}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 130 }}>
          <div className="cb-label">Total P&amp;L</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 3,
            }}
          >
            <div
              className={"cb-hero " + (total >= 0 ? "cb-pos" : "cb-neg")}
              style={{ fontSize: 26 }}
            >
              {total >= 0 ? "+" : "−"}
              {inrShort(Math.abs(total))}
            </div>
            {d.equity && d.equity.length > 1 && (
              <Sparkline
                data={d.equity}
                tone={
                  d.equity[d.equity.length - 1]! >= d.equity[0]! ? "up" : "down"
                }
                w={72}
                h={26}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
            <span
              className="num"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              realised{" "}
              <TrendArrow dir={realized >= 0 ? "up" : "down"}>
                {inrShort(Math.abs(realized))}
              </TrendArrow>
            </span>
            <span
              className="num"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              unrealised{" "}
              <TrendArrow dir={unrealized >= 0 ? "up" : "down"}>
                {inrShort(Math.abs(unrealized))}
              </TrendArrow>
            </span>
          </div>
        </div>
        {d.winRate != null && (
          <Gauge
            pct={d.winRate / 100}
            value={d.winRate + "%"}
            label="win rate"
          />
        )}
      </div>
      {d.equity && d.equity.length > 1 && (
        <div
          style={{
            border: "1.5px solid var(--rule-soft)",
            borderRadius: 10,
            padding: 8,
            marginBottom: 12,
          }}
        >
          <MiniArea data={d.equity} h={48} />
        </div>
      )}
      {(d.best || d.worst) && (
        <div style={{ display: "flex", gap: 9 }}>
          {d.best && (
            <div className="cb-tile" style={{ flex: 1 }}>
              <div className="l">Best trade</div>
              <div
                className="num cb-pos"
                style={{ fontSize: 13, fontWeight: 700 }}
              >
                {d.best.symbol} +{inrShort(d.best.amount)}
              </div>
            </div>
          )}
          {d.worst && (
            <div className="cb-tile" style={{ flex: 1 }}>
              <div className="l">Worst trade</div>
              <div
                className="num cb-neg"
                style={{ fontSize: 13, fontWeight: 700 }}
              >
                {d.worst.symbol} −{inrShort(Math.abs(d.worst.amount))}
              </div>
            </div>
          )}
        </div>
      )}
    </ChatBlock>
  );
}

/* ── 12 · Dividends ─────────────────────────────────────────────────── */
export function DividendBlockRenderer({ block: d }: { block: DividendBlock }) {
  const upcoming = d.upcoming ?? [];
  return (
    <ChatBlock
      icon="gauge"
      iconBg="var(--gold-fill)"
      title="Dividends"
      sub="upcoming"
      disclaimer={SEBI_SHORT}
    >
      <div style={{ display: "flex", gap: 9, marginBottom: 12 }}>
        <div className="cb-tile" style={{ flex: 1 }}>
          <div className="l">Portfolio yield</div>
          <div className="v">{d.yield != null ? d.yield + "%" : <ND />}</div>
          {d.yield == null && <NeedsData />}
        </div>
        <div className="cb-tile" style={{ flex: 1 }}>
          <div className="l">Est. annual income</div>
          <div className="v">
            {d.annualIncome != null ? inrShort(d.annualIncome) : <ND />}
          </div>
        </div>
      </div>
      {upcoming.length > 0 ? (
        <>
          <div className="cb-label" style={{ marginBottom: 7 }}>
            Upcoming ex-dates
          </div>
          <div className="cb-stock-list">
            {upcoming.map((u, i) => (
              <div key={i} className="cb-stock-row">
                <span
                  className="cb-ico"
                  style={{
                    background: "var(--gold-fill)",
                    width: 24,
                    height: 24,
                  }}
                >
                  <BIcon name="clock" size={12} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="tk">{u.symbol}</div>
                  <div className="nm">ex-date {u.exDate}</div>
                </div>
                <div
                  className="num"
                  style={{ fontWeight: 700, fontSize: 12.5 }}
                >
                  {inr(u.amount)}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <CbEmpty
          icon="gauge"
          title="No upcoming dividends"
          desc="None of your holdings have announced an ex-date."
        />
      )}
    </ChatBlock>
  );
}
