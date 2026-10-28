"use client";

/**
 * Index detail — MONEY-1204 (P14 / 14d.6, decision D2).
 *
 * The first product reader of `index_closes` valuation columns,
 * `index_constituents` and `index_memberships`. Price + valuation, constituents
 * with weight where NSE published one, and the observed membership change log.
 *
 * ## `—`, never 0, for the valuation block
 *
 * `pe`, `pb`, `divYield`, `volume` and `turnoverCr` are all nullable and null
 * means NOT REPORTED (`-` in NSE's file). A volatility or dividend-points index
 * has no basket to value and prints `-` forever. `?? 0` would render it as a
 * P/E of zero, i.e. the cheapest index on the exchange — a number a screen
 * would sort to the top. Nothing here coalesces.
 *
 * ## The weight column disappears when nothing published one
 *
 * `weightBps` is null on every archive-derived row, because NSE's constituent
 * LIST files carry no weight at all. Rendering "0.00%" for 50 stocks would be a
 * fabricated free-float breakdown, so the column is hidden entirely when
 * `hasWeights` is false rather than filled with a placeholder per row.
 *
 * ## An index with no constituent list is not an error
 *
 * ~90 of the indices NSE publishes closes for have no list. `route.known ===
 * false` renders the price and valuation blocks with the constituents section in
 * its empty state — a 404 for a perfectly real index would be wrong.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers, History, Gauge } from "lucide-react";
import { Sparkline, autoTone } from "@/components/charts";
import { SectionShell, formatAsOf } from "@/components/stock/SectionShell";
import {
  getIndexDetailAction,
  type IndexDetailData,
} from "@/lib/actions/discover-sections";

/** A number for display, or `—`. NEVER a 0 substituted for absence. */
export function orDash(
  v: number | null | undefined,
  opts: { digits?: number; suffix?: string } = {}
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toLocaleString("en-IN", {
    minimumFractionDigits: opts.digits ?? 2,
    maximumFractionDigits: opts.digits ?? 2,
  })}${opts.suffix ?? ""}`;
}

function signed(v: number | null, digits = 2, suffix = ""): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${v >= 0 ? "+" : "−"}${abs}${suffix}`;
}

export interface IndexDetailViewProps {
  slug: string;
  className?: string;
}

export function IndexDetailView({
  slug,
  className = "",
}: IndexDetailViewProps) {
  const [data, setData] = useState<IndexDetailData | null>(null);
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
    getIndexDetailAction({ slug })
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
        if (!cancelled) setError("Failed to load index details");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const detail = data?.detail ?? null;
  const constituents = data?.constituents ?? null;
  const membership = data?.membership ?? null;

  return (
    <div className={className} style={{ display: "grid", gap: 22 }}>
      <SectionShell
        title={data?.route.label ?? "Index"}
        Icon={Gauge}
        eyebrow={detail?.name ?? undefined}
        loading={loading}
        error={error}
        empty={!loading && !error && (detail === null || detail.date === null)}
        emptyMessage="We track NSE's daily index close file. Nothing has been published for this index."
        source={prov.source}
        asOf={prov.asOf}
        note={prov.note}
      >
        {detail ? (
          <div className="pf-card" style={{ padding: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: "-0.8px",
                  fontFamily: "var(--font-mono, ui-monospace)",
                }}
              >
                {orDash(detail.close)}
              </span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color:
                    detail.changePct === null
                      ? "var(--ink-3)"
                      : detail.changePct >= 0
                        ? "var(--emerald)"
                        : "var(--pop-1)",
                }}
              >
                {signed(detail.changeAbs)} ({signed(detail.changePct, 2, "%")})
              </span>
              <span style={{ marginLeft: "auto" }}>
                <Sparkline
                  data={detail.spark.map((p) => p.close ?? 0)}
                  tone={autoTone(detail.spark.map((p) => p.close ?? 0))}
                  width={128}
                  height={34}
                  ariaLabel={`${data?.route.label ?? slug} close, last ${detail.spark.length} sessions`}
                />
              </span>
            </div>

            <div
              style={{
                marginTop: 14,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
                gap: 10,
              }}
            >
              <Stat label="Open" value={orDash(detail.open)} />
              <Stat label="High" value={orDash(detail.high)} />
              <Stat label="Low" value={orDash(detail.low)} />
              <Stat label="Prev close" value={orDash(detail.prevClose)} />
            </div>

            {/* Valuation. Every one of these is `—` when NSE printed `-`; a 0
                P/E would read as a screaming-cheap index. */}
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px dashed var(--rule-soft, var(--ink-3))",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
                gap: 10,
              }}
            >
              <Stat label="P/E" value={orDash(detail.valuation.pe)} />
              <Stat label="P/B" value={orDash(detail.valuation.pb)} />
              <Stat
                label="Div yield"
                value={orDash(detail.valuation.divYield, { suffix: "%" })}
              />
              <Stat
                label="Turnover"
                value={
                  detail.valuation.turnoverCr === null
                    ? "—"
                    : `₹${detail.valuation.turnoverCr.toLocaleString("en-IN", {
                        maximumFractionDigits: 0,
                      })} Cr`
                }
              />
            </div>
          </div>
        ) : null}
      </SectionShell>

      <SectionShell
        title="Constituents"
        Icon={Layers}
        eyebrow={
          constituents && constituents.rows.length > 0
            ? `${constituents.rows.length} stocks`
            : undefined
        }
        loading={loading}
        error={error}
        empty={!loading && !error && (constituents?.rows.length ?? 0) === 0}
        emptyMessage={
          data && !data.route.known
            ? "We do not track a constituent list for this index — price history only."
            : "NSE has not published a constituent list for this index yet."
        }
        source={prov.source}
        asOf={constituents?.syncedAt ?? null}
      >
        {constituents ? (
          <div className="pf-card" style={{ padding: 0, overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 320,
              }}
            >
              <thead>
                <tr>
                  <Th align="left">#</Th>
                  <Th align="left">Symbol</Th>
                  {/* The weight column is absent, not blank, when nothing
                      published one — 50 rows of "0.00%" would be a fabricated
                      free-float breakdown. */}
                  {constituents.hasWeights ? (
                    <Th align="right">Weight</Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {constituents.rows.map((r, i) => (
                  <tr key={r.symbol}>
                    <Td align="left" muted>
                      {r.rank ?? i + 1}
                    </Td>
                    <Td align="left">
                      <Link
                        href={`/stock/${encodeURIComponent(r.symbol)}`}
                        style={{ color: "var(--ink)", textDecoration: "none" }}
                      >
                        {r.symbol}
                      </Link>
                    </Td>
                    {constituents.hasWeights ? (
                      <Td align="right">
                        {r.weightPct === null
                          ? "—"
                          : `${r.weightPct.toFixed(2)}%`}
                      </Td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionShell>

      <SectionShell
        title="Membership changes"
        Icon={History}
        eyebrow={
          membership && membership.observedFrom
            ? `observed since ${formatAsOf(`${membership.observedFrom}T00:00:00.000Z`) ?? membership.observedFrom}`
            : undefined
        }
        loading={loading}
        error={error}
        empty={!loading && !error && (membership?.changes.length ?? 0) === 0}
        emptyMessage="No joins or exits have been observed for this index since we started tracking it."
        source={prov.source}
      >
        {membership ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {membership.changes.slice(0, 40).map((c) => (
                <div
                  key={`${c.symbol}|${c.kind}|${c.date}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 11px",
                    borderRadius: 10,
                    border: "1px solid var(--rule-soft, rgba(0,0,0,0.1))",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: 0.8,
                      padding: "1px 6px",
                      borderRadius: 999,
                      color:
                        c.kind === "ADDED" ? "var(--emerald)" : "var(--pop-1)",
                      border: `1px solid ${c.kind === "ADDED" ? "var(--emerald)" : "var(--pop-1)"}`,
                    }}
                  >
                    {c.kind}
                  </span>
                  <Link
                    href={`/stock/${encodeURIComponent(c.symbol)}`}
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      color: "var(--ink)",
                      textDecoration: "none",
                    }}
                  >
                    {c.symbol}
                  </Link>
                  <span
                    className="mono"
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      color: "var(--ink-3)",
                    }}
                  >
                    {formatAsOf(`${c.date}T00:00:00.000Z`) ?? c.date}
                  </span>
                </div>
              ))}
            </div>
            {membership.preexistingCount > 0 ? (
              // `addedOn: null` means "already a member when we started
              // looking", which is a different claim from "joined on the first
              // day we saw it" — so these are counted, never dated.
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 8 }}
              >
                {membership.preexistingCount} member
                {membership.preexistingCount === 1 ? " was" : "s were"} already
                in the index when tracking began — their join date is not known.
              </div>
            ) : null}
          </>
        ) : null}
      </SectionShell>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontFamily: "var(--font-mono, ui-monospace)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align: "left" | "right";
}) {
  return (
    <th
      className="mono"
      style={{
        textAlign: align,
        padding: "9px 12px",
        fontSize: 10,
        letterSpacing: 1,
        textTransform: "uppercase",
        color: "var(--ink-3)",
        borderBottom: "1.5px solid var(--ink)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  muted = false,
}: {
  children: React.ReactNode;
  align: "left" | "right";
  muted?: boolean;
}) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "8px 12px",
        fontSize: 12.5,
        color: muted ? "var(--ink-3)" : "var(--ink)",
        borderBottom: "1px solid var(--rule-soft, rgba(0,0,0,0.08))",
        fontFamily:
          align === "right" ? "var(--font-mono, ui-monospace)" : "inherit",
      }}
    >
      {children}
    </td>
  );
}

export default IndexDetailView;
