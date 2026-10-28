"use client";

/**
 * FII/DII cash flows — MONEY-1204 (P14 / 14d.2).
 *
 * `institutional_flows` has been collecting since P4 and has never had a
 * reader. This is it: today's net for each side, the trailing 20-SESSION
 * cumulative, and a sparkline of the window.
 *
 * ## ₹ crore, and no rescaling anywhere
 *
 * NSE publishes these in crore and the column stores them unconverted, so the
 * widget renders them in crore too. There is exactly one place a unit could be
 * applied and it is {@link formatCr}. Multiplying to rupees for
 * `formatCurrency` would print ₹1,23,45,60,00,000 for an ordinary day, which no
 * Indian reader parses; and doing it in two places is how one of them ends up a
 * crore out.
 *
 * ## Short windows say so
 *
 * `windowComplete` is false when the feed holds fewer sessions than the window
 * asked for — after a long holiday, or in a fresh environment. The label then
 * reads "17 sessions" instead of "20D", because a 17-session total presented as
 * a 20-day figure is a wrong number with a confident caption.
 *
 * Theme-aware tokens for neutrals; emerald/coral accents follow the house split.
 */

import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { SectionShell } from "@/components/stock/SectionShell";
import {
  getInstitutionalFlowsAction,
  type InstitutionalFlowsData,
} from "@/lib/actions/discover-sections";

type FlowSeries = InstitutionalFlowsData["series"][number];

/**
 * ₹ crore, Indian digit grouping, sign always explicit.
 *
 * Null renders as `—`. Never `₹0 Cr`: a day NSE has not published and a day
 * where buys exactly matched sells are different facts, and this widget is
 * about direction.
 */
export function formatCr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}₹${abs} Cr`;
}

function toneOf(v: number | null | undefined): "pos" | "neg" | "muted" {
  if (v === null || v === undefined || !Number.isFinite(v)) return "muted";
  return v >= 0 ? "pos" : "neg";
}

function toneColor(v: number | null | undefined): string {
  const t = toneOf(v);
  if (t === "muted") return "var(--ink-3)";
  return t === "pos" ? "var(--emerald)" : "var(--pop-1)";
}

export interface InstitutionalFlowsWidgetProps {
  windowSessions?: number;
  className?: string;
}

export function InstitutionalFlowsWidget({
  windowSessions = 20,
  className = "",
}: InstitutionalFlowsWidgetProps) {
  const [data, setData] = useState<InstitutionalFlowsData | null>(null);
  const [prov, setProv] = useState<{
    source: string | null;
    asOf: string | null;
    note?: string;
  }>({ source: null, asOf: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getInstitutionalFlowsAction({ windowSessions })
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data.data);
          setProv({
            source: res.data.source,
            asOf: res.data.asOf,
            ...(res.data.note ? { note: res.data.note } : {}),
          });
          setError(null);
        } else {
          setError(res.error);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load institutional flows");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowSessions]);

  const series = data?.series ?? [];

  return (
    <SectionShell
      title="FII / DII flows"
      Icon={ArrowLeftRight}
      eyebrow="Cash market · ₹ crore"
      loading={loading}
      error={error}
      empty={!loading && !error && series.length === 0}
      emptyMessage="We track NSE's daily FII and DII cash-market flows. Nothing has been published for this period yet."
      source={prov.source}
      asOf={prov.asOf}
      note={prov.note}
      className={className}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {series.map((s) => (
          <FlowCard key={`${s.category}|${s.segment}`} series={s} />
        ))}
      </div>
    </SectionShell>
  );
}

function FlowCard({ series }: { series: FlowSeries }) {
  const net = series.latest?.netCr ?? null;
  const cum = series.cumulativeNetCr;
  // The caption states what was actually summed. `windowComplete === false`
  // means the feed is short of the requested window — after a long holiday, or
  // in a fresh environment — and calling that "20D" would be a wrong number
  // with a confident label.
  const windowLabel = series.windowComplete
    ? `${series.windowSessions}D cumulative`
    : `${series.sessionsCounted}-session cumulative`;

  return (
    <div className="pf-card" style={{ padding: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--ink)",
          }}
        >
          {series.category}
        </span>
        <span
          className="mono"
          style={{ fontSize: 10, letterSpacing: 1, color: "var(--ink-3)" }}
        >
          {series.segment}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Sparkline
            data={series.spark}
            tone={toneOf(cum)}
            width={72}
            height={22}
            ariaLabel={`${series.category} net flow, last ${series.sessionsCounted} sessions`}
          />
        </span>
      </div>

      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: "-0.5px",
          color: toneColor(net),
          fontFamily: "var(--font-mono, ui-monospace)",
        }}
      >
        {formatCr(net)}
      </div>
      <div
        className="mono"
        style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}
      >
        {series.latest?.date ?? "—"} · net
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: "1px dashed var(--rule-soft, var(--ink-3))",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          {windowLabel}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 13,
            fontWeight: 700,
            color: toneColor(cum),
            fontFamily: "var(--font-mono, ui-monospace)",
          }}
        >
          {formatCr(cum)}
        </span>
      </div>

      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 6 }}
      >
        Buy {formatCr(series.latest?.buyCr ?? null)} · Sell{" "}
        {formatCr(series.latest?.sellCr ?? null)}
      </div>
    </div>
  );
}

export default InstitutionalFlowsWidget;
