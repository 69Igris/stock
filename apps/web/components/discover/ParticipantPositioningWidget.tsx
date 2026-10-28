"use client";

/**
 * Participant F&O positioning — MONEY-1204 (P14 / 14d.2).
 *
 * Who is positioned which way in derivatives: FII / DII / CLIENT / PRO, long vs
 * short contracts per bucket, with the day-on-day change in net.
 *
 * ## The metric is part of the identity, not a display option
 *
 * `market_positioning` holds TWO feeds. The participant files write
 * `metric: "OI" | "VOLUME"` with buckets `FUT_IDX`…; `nse-fii-stats` writes
 * `metric: "FII_STATS"` with `IDX_FUT`… plus per-underlying breakdowns and
 * rupee columns. They describe the same FII on the same day in incompatible
 * units. So the toggle sends a metric on every request, the service pins it in
 * the `where`, and the pure builder refuses to render a set that arrived mixed
 * — `grain.ok === false` shows an explicit "cannot render" rather than a
 * plausible chart that is roughly double.
 *
 * OI and VOLUME are also not comparable with each other: open interest is a
 * STOCK (positions standing at close), volume is a FLOW (contracts traded
 * during the day). Same schema, different magnitudes — hence a toggle, never a
 * combined view.
 *
 * ## Contracts, not rupees
 *
 * The participant files publish contract COUNTS and the lot size is not in
 * them, so no notional can be derived. Nothing here prints a ₹ figure.
 */

import { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { SectionShell } from "@/components/stock/SectionShell";
import {
  getMarketPositioningAction,
  type MarketPositioningData,
} from "@/lib/actions/discover-sections";

type Leg = MarketPositioningData["legs"][number];
type Metric = "OI" | "VOLUME";

const METRIC_LABEL: Record<Metric, string> = {
  OI: "Open interest",
  VOLUME: "Volume",
};

/** Contract counts, Indian grouping. Null is `—`, never 0. */
export function formatContracts(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-IN");
}

/** Signed change in contracts. Null is `—`; a real 0 prints as `0`. */
export function formatContractChange(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(Math.round(v)).toLocaleString("en-IN");
  if (v === 0) return "0";
  return v > 0 ? `+${abs}` : `−${abs}`;
}

export interface ParticipantPositioningWidgetProps {
  defaultParticipant?: string;
  defaultMetric?: Metric;
  className?: string;
}

export function ParticipantPositioningWidget({
  defaultParticipant = "FII",
  defaultMetric = "OI",
  className = "",
}: ParticipantPositioningWidgetProps) {
  const [participant, setParticipant] = useState(defaultParticipant);
  const [metric, setMetric] = useState<Metric>(defaultMetric);
  const [data, setData] = useState<MarketPositioningData | null>(null);
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
    // `metric` travels on EVERY request — see the module header. There is no
    // "all metrics" option and there must not be one.
    getMarketPositioningAction({ participant, metric })
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
        if (!cancelled) setError("Failed to load participant positioning");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [participant, metric]);

  const legs = data?.legs ?? [];
  const participants = data?.participants ?? ["FII", "DII", "CLIENT", "PRO"];
  // A set that reached the client mixed is a bug upstream, and the honest
  // render is a refusal — a chart drawn over two grains is roughly double and
  // looks entirely normal.
  const grainBroken = data !== null && data.grain.ok === false;

  return (
    <SectionShell
      title="Participant positioning"
      Icon={Scale}
      eyebrow={`${METRIC_LABEL[metric]} · contracts`}
      loading={loading}
      error={error}
      empty={!loading && !error && legs.length === 0 && !grainBroken}
      emptyMessage="We track NSE's participant-wise F&O positioning. Nothing has been published for this participant yet."
      source={prov.source}
      asOf={prov.asOf}
      note={prov.note}
      className={className}
    >
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}
      >
        {participants.map((p) => (
          <Pill
            key={p}
            active={p === participant}
            onClick={() => setParticipant(p)}
            label={p}
          />
        ))}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {(["OI", "VOLUME"] as const).map((m) => (
            <Pill
              key={m}
              active={m === metric}
              onClick={() => setMetric(m)}
              label={m === "OI" ? "OI" : "VOL"}
            />
          ))}
        </span>
      </div>

      {grainBroken ? (
        <div
          style={{
            borderRadius: 12,
            border: "1.5px solid var(--pop-2, #f59e0b)",
            background:
              "color-mix(in srgb, var(--pop-2, #f59e0b) 8%, transparent)",
            padding: 14,
            fontSize: 12.5,
            color: "var(--ink)",
          }}
        >
          These rows mix two feeds that are not comparable
          {data?.grain.metrics.length
            ? ` (${data.grain.metrics.join(", ")})`
            : ""}
          . Showing a combined figure would double-count, so nothing is charted.
        </div>
      ) : (
        <div className="pf-card" style={{ padding: 0, overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 460 }}
          >
            <thead>
              <tr>
                {["Bucket", "Long", "Short", "Net", "Δ vs prev"].map((h, i) => (
                  <th
                    key={h}
                    className="mono"
                    style={{
                      textAlign: i === 0 ? "left" : "right",
                      padding: "9px 12px",
                      fontSize: 10,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                      borderBottom: "1.5px solid var(--ink)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <LegRow key={leg.bucket} leg={leg} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.previousDate ? (
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 6 }}
        >
          Change measured against the previous published session (
          {data.previousDate}).
        </div>
      ) : null}
    </SectionShell>
  );
}

function LegRow({ leg }: { leg: Leg }) {
  const netTone =
    leg.netQty === null
      ? "var(--ink-3)"
      : leg.netQty >= 0
        ? "var(--emerald)"
        : "var(--pop-1)";
  const chgTone =
    leg.netChange === null
      ? "var(--ink-3)"
      : leg.netChange >= 0
        ? "var(--emerald)"
        : "var(--pop-1)";
  const cell = {
    padding: "9px 12px",
    fontSize: 12.5,
    textAlign: "right" as const,
    fontFamily: "var(--font-mono, ui-monospace)",
    borderBottom: "1px solid var(--rule-soft, rgba(0,0,0,0.08))",
    whiteSpace: "nowrap" as const,
  };
  return (
    <tr>
      <td
        style={{
          ...cell,
          textAlign: "left",
          fontFamily: "inherit",
          fontWeight: 600,
        }}
      >
        {leg.label}
      </td>
      <td style={cell}>{formatContracts(leg.longQty)}</td>
      <td style={cell}>{formatContracts(leg.shortQty)}</td>
      <td style={{ ...cell, color: netTone, fontWeight: 700 }}>
        {formatContracts(leg.netQty)}
      </td>
      <td style={{ ...cell, color: chgTone }}>
        {formatContractChange(leg.netChange)}
      </td>
    </tr>
  );
}

function Pill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="mono"
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        border: "1.5px solid var(--ink)",
        background: active ? "var(--ink)" : "transparent",
        color: active ? "var(--paper)" : "var(--ink)",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

export default ParticipantPositioningWidget;
