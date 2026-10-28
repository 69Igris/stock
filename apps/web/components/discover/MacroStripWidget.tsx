"use client";

/**
 * Macro strip — MONEY-1204 (P14 / 14d.2).
 *
 * Repo rate, CPI inflation, WPI inflation, forex reserves, from `macro_series`
 * (RBI's NSDP, MOSPI, the Office of the Economic Adviser).
 *
 * ## Every tile carries its OWN date, and that is the whole point
 *
 * These four have genuinely different vintages. The repo rate is a weekly
 * reading and is days old; CPI is a month behind by the time MOSPI prints it;
 * forex reserves are a Friday snapshot. A single "as of" over the strip — the
 * obvious layout — presents the six-week-old number as though it landed with
 * the three-day-old one, every single day. So the strip has NO shared
 * timestamp: each tile prints its own period, and `SectionShell`'s provenance
 * chip carries a note saying so rather than a date that would misdescribe three
 * tiles out of four.
 *
 * ## Unavailable is a state, not a zero
 *
 * `unavailable` distinguishes three real cases and the tile says which:
 * `NO_DATA` (nothing stored), `NO_BASE` (no observation exactly twelve months
 * back, so a YoY cannot be computed), `REBASE` (the base year changed, so the
 * ratio would be arithmetic across two different scales). None of them renders
 * as 0%.
 */

import { useEffect, useState } from "react";
import { LineChart } from "lucide-react";
import { SectionShell, formatAsOf } from "@/components/stock/SectionShell";
import {
  getMacroStripAction,
  type MacroStripData,
} from "@/lib/actions/discover-sections";

type Item = MacroStripData["items"][number];

/** Why a tile has no number, in words a reader can act on. */
const UNAVAILABLE_COPY: Record<string, string> = {
  NO_DATA: "Not published yet",
  NO_BASE: "No year-ago reading",
  REBASE: "Base year changed",
};

/**
 * Format one observation in its OWN unit.
 *
 * The unit is per-row because one source page mixes several — a bare number
 * here would be uninterpretable. `PERCENT` gets one decimal (policy rates and
 * inflation move in tens of basis points); `USD_MILLION` is folded to billions
 * because 702,345 million is not a number anyone reads.
 */
export function formatMacroValue(item: Item): string {
  if (item.value === null || !Number.isFinite(item.value)) return "—";
  switch (item.unit) {
    case "PERCENT":
      return `${item.value.toFixed(item.kind === "YOY" ? 2 : 2)}%`;
    case "USD_MILLION":
      return `$${(item.value / 1000).toLocaleString("en-IN", {
        maximumFractionDigits: 1,
      })} bn`;
    case "INR_CRORE":
      return `₹${item.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
    case "INDEX":
      return item.value.toLocaleString("en-IN", { maximumFractionDigits: 1 });
    default:
      return item.value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
}

/** "07 Aug 2026" for a period key, or `—`. */
function periodLabel(period: string | null): string {
  if (!period) return "—";
  return formatAsOf(`${period}T00:00:00.000Z`) ?? period;
}

export interface MacroStripWidgetProps {
  className?: string;
}

export function MacroStripWidget({ className = "" }: MacroStripWidgetProps) {
  const [data, setData] = useState<MacroStripData | null>(null);
  const [prov, setProv] = useState<{ source: string | null; note?: string }>({
    source: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMacroStripAction()
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data.data);
          setProv({
            source: res.data.source,
            ...(res.data.note ? { note: res.data.note } : {}),
          });
          setError(null);
        } else {
          setError(res.error);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load macro indicators");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = data?.items ?? [];
  const anyValue = items.some((i) => i.value !== null);

  return (
    <SectionShell
      title="Macro"
      Icon={LineChart}
      eyebrow="RBI · MOSPI · OEA"
      loading={loading}
      error={error}
      empty={!loading && !error && !anyValue}
      emptyMessage="We track the policy rate, CPI, WPI and forex reserves from official sources. None has been published to us yet."
      source={prov.source}
      // Deliberately NO `asOf`: these four have different vintages and one
      // shared timestamp would misdescribe three of them. Each tile prints its
      // own date instead.
      note={prov.note}
      className={className}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
        }}
      >
        {items.map((item) => (
          <MacroTile key={item.seriesId} item={item} />
        ))}
      </div>
    </SectionShell>
  );
}

function MacroTile({ item }: { item: Item }) {
  const unavailable = item.value === null;
  return (
    <div className="pf-card" style={{ padding: 12 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.1,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          fontWeight: 700,
          marginBottom: 4,
        }}
      >
        {item.title}
        {item.kind === "YOY" ? " · YoY" : ""}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 800,
          letterSpacing: "-0.4px",
          color: unavailable ? "var(--ink-3)" : "var(--ink)",
          fontFamily: "var(--font-mono, ui-monospace)",
        }}
      >
        {formatMacroValue(item)}
      </div>
      {/* This tile's OWN as-on date. Never a shared one — see the header. */}
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}
      >
        {unavailable
          ? (UNAVAILABLE_COPY[item.unavailable ?? "NO_DATA"] ?? "Not available")
          : `as on ${periodLabel(item.period)}`}
      </div>
      {item.kind === "YOY" && item.basePeriod && !unavailable ? (
        <div
          className="mono"
          style={{ fontSize: 9.5, color: "var(--ink-3)", marginTop: 2 }}
        >
          vs {periodLabel(item.basePeriod)}
        </div>
      ) : null}
    </div>
  );
}

export default MacroStripWidget;
