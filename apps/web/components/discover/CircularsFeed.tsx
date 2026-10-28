"use client";

/**
 * NSE circular feed — MONEY-1204 (P14 / 14d.5).
 *
 * `nse_circulars` filtered by department, newest first.
 *
 * ## The React key is (circularNumber, department), not circularNumber
 *
 * NSE re-issues one circular under EVERY department it applies to — 75736 is
 * filed under both "Listing" and "Emerge" with the same subject, and one
 * measured 237-record window held only 205 distinct numbers. That is why the
 * model's unique is the pair, and why `circularKey` exists rather than a
 * template string inline here: keyed on the number alone, React silently drops
 * the second copy of every re-issue and the survivor looks completely normal.
 */

import { useEffect, useState } from "react";
import { FileText, ExternalLink } from "lucide-react";
import { SectionShell, formatAsOf } from "@/components/stock/SectionShell";
import {
  getCircularFeedAction,
  type CircularFeedData,
} from "@/lib/actions/discover-sections";

type CircularView = CircularFeedData["circulars"][number];

/** "366 KB" from an approximate byte count. Null renders nothing. */
function sizeLabel(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface CircularsFeedProps {
  initialDepartment?: string | null;
  limit?: number;
  className?: string;
}

export function CircularsFeed({
  initialDepartment = null,
  limit = 50,
  className = "",
}: CircularsFeedProps) {
  const [department, setDepartment] = useState<string | null>(
    initialDepartment
  );
  const [data, setData] = useState<CircularFeedData | null>(null);
  // The chip row must not collapse to one chip the moment a filter is applied
  // — the filtered response only counts what survived the filter. So the
  // unfiltered response's departments are kept as the chip vocabulary.
  const [allDepartments, setAllDepartments] = useState<
    CircularFeedData["departments"]
  >([]);
  const [prov, setProv] = useState<{
    source: string | null;
    asOf: string | null;
  }>({ source: null, asOf: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCircularFeedAction({
      ...(department ? { department } : {}),
      limit,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data.data);
          setProv({ source: res.data.source, asOf: res.data.asOf });
          if (department === null) setAllDepartments(res.data.data.departments);
          setError(null);
        } else {
          setError(res.error);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load exchange circulars");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [department, limit]);

  const circulars = data?.circulars ?? [];
  const chips =
    allDepartments.length > 0 ? allDepartments : (data?.departments ?? []);

  return (
    <SectionShell
      title="Exchange circulars"
      Icon={FileText}
      eyebrow={department ?? "All departments"}
      loading={loading}
      error={error}
      empty={!loading && !error && circulars.length === 0}
      emptyMessage="We track NSE's circular feed. Nothing has been published for this filter."
      source={prov.source}
      asOf={prov.asOf}
      className={className}
    >
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}
      >
        <Chip
          label="All"
          active={department === null}
          onClick={() => setDepartment(null)}
        />
        {chips.map((d) => (
          <Chip
            key={d.department}
            label={`${d.department} (${d.count})`}
            active={department === d.department}
            onClick={() => setDepartment(d.department)}
          />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {circulars.map((c) => (
          // The model's OWN unique. `c.circularNumber` alone collides across
          // departments — see the module header.
          <CircularRow key={c.key} circular={c} />
        ))}
      </div>

      {data?.hasMore ? (
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            marginTop: 10,
            textAlign: "center",
          }}
        >
          Showing the {circulars.length} most recent · more available
        </div>
      ) : null}
    </SectionShell>
  );
}

function CircularRow({ circular }: { circular: CircularView }) {
  const size = sizeLabel(circular.approxSizeBytes);
  return (
    <div className="pf-card" style={{ padding: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: 1,
            fontWeight: 700,
            textTransform: "uppercase",
            color: "var(--emerald)",
          }}
        >
          {circular.department}
        </span>
        {circular.topic ? (
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: 0.8,
              padding: "1px 6px",
              borderRadius: 999,
              border: "1px solid var(--rule-soft, var(--ink-3))",
              color: "var(--ink-3)",
            }}
          >
            {circular.topic.replace(/_/g, " ")}
          </span>
        ) : null}
        <span
          className="mono"
          style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-3)" }}
        >
          {circular.date
            ? (formatAsOf(`${circular.date}T00:00:00.000Z`) ?? circular.date)
            : "—"}
        </span>
      </div>

      <div style={{ fontSize: 13, marginTop: 5, lineHeight: 1.45 }}>
        {circular.subject}
      </div>

      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          marginTop: 6,
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span>{circular.displayNumber ?? circular.circularNumber}</span>
        {circular.company ? <span>· {circular.company}</span> : null}
        {circular.fileUrl ? (
          <a
            href={circular.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--emerald)",
              textDecoration: "none",
            }}
          >
            {circular.fileName ?? "Attachment"}
            {size ? ` · ~${size}` : ""}
            <ExternalLink size={11} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Chip({
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
        letterSpacing: 0.8,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

export default CircularsFeed;
