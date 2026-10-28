"use client";

/**
 * Funds holding this stock — MONEY-1204 (P14 / 14c.9).
 *
 * The INVERSE of a fund's portfolio page: which mutual-fund schemes disclosed a
 * position in this company last month, how much of each scheme it is, and who
 * entered or exited since the month before.
 *
 * Three rendering rules that carry the data's honesty:
 *
 * 1. **An undisclosed weight renders as "—", never as 0%.** `percentToNav` of 0
 *    is a real disclosed weight; absent is not. The combined figure sums only
 *    disclosed weights and the count of undisclosed schemes is shown next to it,
 *    so the total is never quietly understated by treating absence as zero.
 *
 * 2. **A scheme with no AMFI code still renders — just unlinked.** The code is
 *    null for most rows (it is not derivable from the AMC files), and hiding
 *    those would delete real holders from the list to keep every row clickable.
 *    An unlinked row beats a hidden one.
 *
 * 3. **"Entered / exited" is only claimed when there are two months to compare,
 *    and it says so when they are not consecutive.** Several AMCs publish only
 *    the current month, so a single-month state is the common case — reporting
 *    every holder as "entered" there would be a fabricated signal.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { PieChart, ArrowUpRight, ArrowDownRight } from "lucide-react";
import {
  getStockFundsHoldingAction,
  type StockFundsHoldingData,
} from "@/lib/actions/stock-sections-docs";
import {
  SectionShell,
  SectionEmptyInline,
  formatAsOf,
  type SectionProvenance,
} from "./SectionShell";

interface StockFundsHoldingProps {
  symbol: string;
  exchange?: string;
  className?: string;
  /**
   * Live market cap in RUPEES, for the share-of-market-cap line. OPTIONAL: the
   * rupee value stands on its own and is single-source, so a caller that has no
   * market cap simply gets one fewer caveat rather than a broken tile.
   */
  marketCap?: number | null;
}

/** "3.52%" / "—". Absence is a dash, never a zero. */
function pct(v: number | null, dp = 2): string {
  return v === null ? "—" : `${v.toFixed(dp)}%`;
}

/** Signed delta with an explicit sign; absence stays a dash. */
function signedPct(v: number | null): string {
  if (v === null) return "—";
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(2)}%`;
}

export function StockFundsHolding({
  symbol,
  exchange = "NSE",
  className = "",
  marketCap = null,
}: StockFundsHoldingProps) {
  const [data, setData] = useState<StockFundsHoldingData | null>(null);
  const [prov, setProv] = useState<SectionProvenance>({});
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockFundsHoldingAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setData(r.data.data);
          setProv({
            source: r.data.source,
            asOf: r.data.asOf,
            fallback: r.data.fallback,
            note: r.data.note,
          });
          setEmpty(r.data.empty);
        } else {
          setError(r.error ?? "Failed to load fund ownership");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  return (
    <SectionShell
      title="Funds holding this stock"
      Icon={PieChart}
      eyebrow={
        data && data.fundCount > 0
          ? `${data.fundCount} scheme${data.fundCount === 1 ? "" : "s"}`
          : undefined
      }
      loading={loading}
      error={error}
      empty={empty}
      // MONEY-1255 — demoted, and this is one of the nine that must not be
      // flattened to silence: the two causes are genuinely different (no AMC
      // holds it / this month's disclosures have not landed) and we cannot
      // tell them apart, so the note says BOTH rather than picking one.
      emptyNote={
        "We read the monthly portfolio disclosures AMCs are required to " +
        `publish. No scheme we track has disclosed a position in ${symbol} — ` +
        "or the disclosures for this month have not landed yet."
      }
      className={className}
      {...prov}
    >
      {data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Schemes" value={String(data.fundCount)} />
            <Stat
              label="Value held"
              value={formatValueHeld(data.valueHeldLakh)}
              hint={heldHint(data, marketCap)}
            />
            <Stat
              label="Disclosure month"
              value={formatAsOf(data.period) ?? "—"}
              hint={
                data.priorPeriod
                  ? `vs ${formatAsOf(data.priorPeriod)}`
                  : "no earlier month on file"
              }
            />
          </div>

          {data.monthGap && (
            <p className="font-mono text-[10.5px] uppercase tracking-[1px] text-amber-400">
              Compared months are not consecutive — changes below span the gap
            </p>
          )}
          {!data.comparable && data.fundCount > 0 && (
            <p className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
              Only one disclosure month on file — no month-on-month change yet
            </p>
          )}

          {(data.entered.length > 0 || data.exited.length > 0) && (
            <div className="grid gap-2">
              <MoveTable
                title="Entered"
                Icon={ArrowUpRight}
                tone="emerald"
                rows={data.entered}
                weightLabel="% to NAV"
                weightHint="Weight in this month's disclosure — the month it first appears."
              />
              <MoveTable
                title="Exited"
                Icon={ArrowDownRight}
                tone="red"
                rows={data.exited}
                weightLabel="% to NAV (last)"
                weightHint="The last weight this scheme disclosed before it dropped the stock."
              />
            </div>
          )}

          {data.funds.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)]">
              <table className="w-full min-w-[520px] text-left">
                <thead>
                  <tr className="border-b border-[var(--border-default)]">
                    <Th>Scheme</Th>
                    <Th align="right">% to NAV</Th>
                    <Th align="right">MoM</Th>
                    <Th align="right">Value (₹ lakh)</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.funds.map((f) => (
                    <tr
                      key={f.schemeKey}
                      className="border-b border-[var(--border-default)] last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        {f.href ? (
                          <Link
                            href={f.href}
                            className="text-[13px] font-medium text-[var(--text-primary)] hover:text-emerald-400"
                          >
                            {f.schemeName}
                          </Link>
                        ) : (
                          <span
                            title="No AMFI scheme code resolved for this scheme, so it cannot be linked. The disclosure itself is real."
                            className="cursor-help text-[13px] font-medium text-[var(--text-primary)]"
                          >
                            {f.schemeName}
                          </span>
                        )}
                        {f.amc && (
                          <span className="ml-2 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-dim)]">
                            {f.amc}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-[var(--text-primary)]">
                        {pct(f.percentToNav)}
                      </td>
                      <td
                        className={
                          "px-4 py-2.5 text-right font-mono text-[12.5px] " +
                          (f.deltaPct === null
                            ? "text-[var(--text-dim)]"
                            : f.deltaPct > 0
                              ? "text-emerald-400"
                              : f.deltaPct < 0
                                ? "text-red-400"
                                : "text-[var(--text-muted)]")
                        }
                      >
                        {signedPct(f.deltaPct)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-[var(--text-muted)]">
                        {f.marketValueLakh === null
                          ? "—"
                          : f.marketValueLakh.toLocaleString("en-IN", {
                              maximumFractionDigits: 0,
                            })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.funds.length < data.fundCount && (
            <p className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
              Showing the {data.funds.length} largest of {data.fundCount}{" "}
              schemes
            </p>
          )}
          {data.unresolvedRowCount > 0 && (
            <p className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-dim)]">
              {data.unresolvedRowCount} disclosed row
              {data.unresolvedRowCount === 1 ? "" : "s"} could not be matched to
              an instrument and are excluded from the totals
            </p>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-1 font-mono text-[16px] font-semibold text-[var(--text-primary)]">
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[11px] text-[var(--text-dim)]">{hint}</p>
      )}
    </div>
  );
}

/**
 * Entered / exited schemes, as a TABLE matching the holders table below it.
 *
 * ## WHY THIS STOPPED BEING TWO LISTS SIDE BY SIDE
 *
 * The panels sat in `sm:grid-cols-2`, so each got half a row for names like
 * "HDFC BSE India Sector Leaders Index Fund (An open ended scheme
 * replicating/trac…". Every one truncated at exactly the words that tell two
 * HDFC index funds apart — the whole content of the row. A fund nobody can
 * identify is not a disclosure.
 *
 * They are full width and stacked now, sharing the holders table's columns,
 * alignment and type so the three read as one object rather than three.
 *
 * ## AND IT SHOWS EVERY ROW
 *
 * The list form capped at 8 and printed "+17 more", which hid 17 of the 25
 * funds that sold out of the stock — the most interesting thing on the panel.
 * The table scrolls inside its own container, so length costs the page nothing.
 *
 * `weightLabel` is a prop rather than a constant because the two tables are not
 * reporting the same fact: an EXITED fund has no weight this month — that is
 * what exiting means — so its number is the LAST one it disclosed, and calling
 * that "% to NAV" would read as a current holding.
 */
/**
 * ₹ lakh → a compact rupee figure. The AMCs disclose in LAKH; nobody reads in
 * lakh above a crore, so this steps up once and stops.
 */
/**
 * The line under the value: what share of market cap it is, and what it is NOT.
 *
 * Coverage comes FIRST when it is the more important caveat — a share of market
 * cap computed from 11 of 57 AMCs is a floor, and a reader who takes it as the
 * total is worse off than one who saw no number at all.
 */
export function heldHint(
  data: Pick<
    StockFundsHoldingData,
    "valueHeldLakh" | "undisclosedValueCount" | "fundCount"
  >,
  marketCapRupees: number | null | undefined
): string | undefined {
  const share = heldShareOfMarketCapPct(data.valueHeldLakh, marketCapRupees);
  const parts: string[] = [];
  if (share !== null) parts.push(`${share.toFixed(2)}% of market cap`);
  if (data.undisclosedValueCount > 0) {
    parts.push(
      `${data.undisclosedValueCount} scheme${data.undisclosedValueCount === 1 ? "" : "s"} disclosed no value`
    );
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatValueHeld(lakh: number | null): string {
  if (lakh === null || !Number.isFinite(lakh)) return "—";
  const cr = lakh / 100;
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(2)} L Cr`;
  if (cr >= 1) return `₹${Math.round(cr).toLocaleString("en-IN")} Cr`;
  return `₹${Math.round(lakh).toLocaleString("en-IN")} L`;
}

/**
 * Disclosed value as a share of market cap — the figure the old tile was
 * reaching for and could never express.
 *
 * ## WHY THE OLD TILE WAS REPLACED RATHER THAN CLAMPED
 *
 * It summed `percentToNav` — each scheme's weight IN ITS OWN NAV. Those are
 * fractions with different denominators, so the sum is not a percentage of
 * anything: measured on RELIANCE for Aug 2026 it is 505.36% across 116 scheme
 * rows. Capping it at 100 was briefly shipped and was worse than the raw
 * number, because it made a meaningless figure look meaningful.
 *
 * RUPEES ARE ADDITIVE. `marketValueLakh` shares one denominator, so summing it
 * is legitimate — and divided by market cap it answers the question actually
 * being asked. Measured: ₹53,539 Cr against RELIANCE's ₹16.60 L Cr = 3.2%.
 *
 * ## TWO THINGS THIS DELIBERATELY DOES NOT CLAIM
 *
 *   - IT IS A FLOOR. Only the AMCs whose disclosure URLs are resolved are in
 *     the data (17 of AMFI's 57), so the caller must label coverage rather than
 *     say "funds hold". The panel names the AMC count beside it.
 *   - IT MIXES CLOCKS, and the label must say so. The numerator is a monthly
 *     disclosure (01 Aug 2026 here); the denominator is a LIVE market cap that
 *     moves every tick. The panel already renders the disclosure month, and
 *     this figure is shown next to it for that reason.
 *
 * Returns null rather than 0 when either side is missing: "we cannot compute
 * it" and "funds hold none of it" are opposite claims.
 */
export function heldShareOfMarketCapPct(
  valueHeldLakh: number | null,
  marketCapRupees: number | null | undefined
): number | null {
  if (valueHeldLakh === null || !Number.isFinite(valueHeldLakh)) return null;
  if (
    marketCapRupees === null ||
    marketCapRupees === undefined ||
    !Number.isFinite(marketCapRupees) ||
    marketCapRupees <= 0
  ) {
    return null;
  }
  // 1 lakh = 1e5 rupees.
  return (valueHeldLakh * 1e5 * 100) / marketCapRupees;
}

function MoveTable({
  title,
  Icon,
  tone,
  rows,
  weightLabel,
  weightHint,
}: {
  title: string;
  Icon: typeof ArrowUpRight;
  tone: "emerald" | "red";
  rows: StockFundsHoldingData["entered"];
  weightLabel: string;
  weightHint: string;
}) {
  const accent = tone === "emerald" ? "text-emerald-400" : "text-red-400";
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--border-default)] px-4 py-2.5">
        <Icon className={`h-3.5 w-3.5 ${accent}`} />
        <span
          className={`font-mono text-[10px] uppercase tracking-[1px] ${accent}`}
        >
          {title}
        </span>
        <span className="ml-auto font-mono text-[10px] text-[var(--text-dim)]">
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3">
          <SectionEmptyInline />
        </div>
      ) : (
        <table className="w-full min-w-[520px] text-left">
          <thead>
            <tr className="border-b border-[var(--border-default)]">
              <Th>Scheme</Th>
              <Th align="right">{weightLabel}</Th>
            </tr>
          </thead>
          <tbody>
            {/* EVERY row. The list form capped at 8 and printed "+17 more",
                which hid 17 of the 25 funds that sold out of the stock — the
                single most interesting thing on this panel. The table scrolls
                inside its own container, so length costs the page nothing. */}
            {rows.map((f) => (
              <tr
                key={f.schemeKey}
                className="border-b border-[var(--border-default)] last:border-0"
              >
                <td className="px-4 py-2.5">
                  {f.href ? (
                    <Link
                      href={f.href}
                      className="text-[13px] font-medium text-[var(--text-primary)] hover:text-emerald-400"
                    >
                      {f.schemeName}
                    </Link>
                  ) : (
                    <span
                      title="No AMFI scheme code resolved for this scheme, so it cannot be linked. The disclosure itself is real."
                      className="cursor-help text-[13px] font-medium text-[var(--text-primary)]"
                    >
                      {f.schemeName}
                    </span>
                  )}
                  {f.amc && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-dim)]">
                      {f.amc}
                    </span>
                  )}
                </td>
                <td
                  title={weightHint}
                  className="px-4 py-2.5 text-right font-mono text-[12.5px] text-[var(--text-muted)]"
                >
                  {pct(f.percentToNav)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        "px-4 py-2 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)] " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}

export default StockFundsHolding;
