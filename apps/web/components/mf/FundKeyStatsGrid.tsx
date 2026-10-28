"use client";

/**
 * Single-card key-stats grid for the fund detail pages (MONEY-245,
 * design Image #33). Eight cells in a 4-column responsive grid:
 *
 *   AUM · Expense ratio · 3Y CAGR · 5Y CAGR
 *   Since inception · 52W high · 52W low · Benchmark
 *
 * ## MONEY-1205 — two lies removed from this grid
 *
 * 1. The fifth cell was labelled **"10Y CAGR"** and fed `returnsInception`.
 *    Those are different numbers for every fund younger than ten years, which
 *    is most of them: a fund with 2.5 years of history printed its
 *    since-inception CAGR under a 10-year heading. The label now says what the
 *    value is, and the hint carries the period it covers.
 *
 * 2. Every missing value rendered the same bare `-`, so "we have not loaded
 *    this fund's NAV history yet" and "this fund is younger than five years"
 *    were indistinguishable — and both looked like a broken page. Pass
 *    `history` and the grid renders them as different sentences.
 *
 * The 52-week range is also no longer assumed to be a NAV range: `/etf/…`
 * derives it from exchange closes because an ETF has a full OHLC series and a
 * once-daily NAV, and a traded-price high is not a NAV high. `rangeBasis`
 * makes the difference visible instead of silently relabelling one as the
 * other.
 *
 * ## MONEY-1255 — one of those two sentences is now the generic body
 *
 * "Not loaded" became {@link SECTION_EMPTY_BODY} and its reason moved to the
 * cell hint. "Since Feb 2024" did NOT: the fund not existing yet is a true
 * fact about the world, not an absence of data, and saying "no data available"
 * there would state something false. Point 2 above still holds — the two
 * states are still distinguishable on screen, just not both in the value.
 */

import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";

/** What the caller knows about the NAV series behind these numbers. */
export interface FundStatsHistory {
  /** Usable observations. `0` means nothing is stored for this fund yet. */
  dataPoints: number;
  /** Span of the stored series in years; `null` when there is no series. */
  coverageYears: number | null;
  /** ISO date of the first stored observation. */
  firstDate?: string | null;
  /** The scheme's own stated launch date, when the master has one. */
  launchDate?: string | null;
}

interface FundKeyStatsGridProps {
  aum: number | null;
  expenseRatio: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  returnsInception: number | null;
  /** 52-week high (NAV or traded price — see `rangeBasis`). */
  navHigh?: number | null;
  /** 52-week low (NAV or traded price — see `rangeBasis`). */
  navLow?: number | null;
  /**
   * Benchmark display name, e.g. "Nifty 500 TRI".
   *
   * MUST be the scheme's OWN stated benchmark or null. MONEY-610 removed a
   * fabricated one (the fund's CAGR x 0.7 rendered as an index); MONEY-1205
   * removed the ETF page's habit of passing its CATEGORY here, which printed
   * "Benchmark: Other".
   */
  benchmarkName?: string | null;
  /** Omit when the caller has no history information — cells then read `-`. */
  history?: FundStatsHistory | null;
  /** What the 52-week range measures. Default `"NAV"`. */
  rangeBasis?: "NAV" | "PRICE";
}

function formatAum(cr: number | null): string {
  if (cr == null || !Number.isFinite(cr)) return "-";
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}L Cr`;
  if (cr >= 1_000) return `₹${(cr / 1_000).toFixed(1)}k Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(1)}%`;
}

function formatNav(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `₹${v.toFixed(1)}`;
}

/** "Feb 2024" from an ISO date, or null when it is unusable. */
export function monthLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The three states a missing history-derived number can be in. */
export type FundStatsState = "unknown" | "not-loaded" | "too-young" | "sparse";

/**
 * Why is this cell empty?
 *
 * Pure and exported so the rendering rule is unit-testable without a DOM.
 * The order matters: "nothing stored" is checked before "not old enough",
 * because a fund with no series has no age to compare against.
 */
export function fundStatsState(
  history: FundStatsHistory | null | undefined,
  requiredYears: number | null
): FundStatsState {
  if (!history) return "unknown";
  if (history.dataPoints === 0 && history.coverageYears === null) {
    return "not-loaded";
  }
  if (
    requiredYears !== null &&
    history.coverageYears !== null &&
    history.coverageYears < requiredYears
  ) {
    return "too-young";
  }
  return "sparse";
}

interface CellText {
  value: string;
  hint: string;
}

/** Render one history-derived cell, value or explained absence. */
export function historyCellText(
  value: number | null | undefined,
  requiredYears: number | null,
  history: FundStatsHistory | null | undefined,
  format: (v: number | null | undefined) => string
): CellText {
  if (value != null && Number.isFinite(value)) {
    return {
      value: format(value),
      hint:
        requiredYears === null && history?.coverageYears != null
          ? `Annualised over ${history.coverageYears.toFixed(1)} yrs`
          : "Annualised",
    };
  }

  switch (fundStatsState(history, requiredYears)) {
    case "not-loaded":
      // MONEY-1255 — the BODY is generic; the WHY is demoted to the hint,
      // which is this grid's equivalent of `SectionShell`'s tooltip. The other
      // two branches keep their own words on purpose: "Since Feb 2024" is a
      // true fact about the world (the fund did not exist yet), not an absence
      // of data, and flattening it would state something false.
      return { value: SECTION_EMPTY_BODY, hint: "NAV history pending" };
    case "too-young": {
      const started =
        monthLabel(history?.launchDate) ?? monthLabel(history?.firstDate);
      const years = history?.coverageYears;
      return {
        value: started ? `Since ${started}` : "Too new",
        hint:
          years != null
            ? `${years.toFixed(1)} yrs of history`
            : "Younger than this window",
      };
    }
    case "sparse":
      return { value: "-", hint: "Not enough NAV data" };
    default:
      return { value: "-", hint: "Annualised" };
  }
}

/**
 * The 52-week range cells.
 *
 * Split from {@link historyCellText} because the range is not always measured
 * on the NAV series: on `/etf/…` it comes from exchange closes, so "NAV history
 * pending" would be the wrong explanation for a missing value, and "NAV peak"
 * the wrong label for a present one.
 */
export function rangeCellText(
  value: number | null | undefined,
  edge: "peak" | "trough",
  basis: "NAV" | "PRICE",
  history: FundStatsHistory | null | undefined
): CellText {
  const basisLabel = basis === "PRICE" ? "Traded price, not NAV" : "NAV";
  if (value != null && Number.isFinite(value)) {
    return { value: formatNav(value), hint: `${basisLabel} ${edge}` };
  }
  if (basis === "PRICE") {
    return { value: "-", hint: "No price history" };
  }
  return historyCellText(value, 1, history, formatNav);
}

interface CellProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "primary" | "muted";
}

function Cell({ label, value, hint, tone = "primary" }: CellProps) {
  return (
    <div className="px-4 py-3 border-r border-b border-[var(--border-default)] last:border-r-0">
      <div className="font-mono text-[10px] tracking-[1.2px] uppercase font-bold text-[var(--text-muted)] mb-1">
        {label}
      </div>
      <div
        // `leading-[1.15]`, not `leading-none`: a cell value is usually a
        // number on one line, but MONEY-1255's generic empty body wraps, and
        // at line-height 1 the wrapped lines collide.
        className={`font-mono text-[18px] font-bold tabular-nums leading-[1.15] ${
          tone === "primary"
            ? "text-[var(--text-primary)]"
            : "text-[var(--text-secondary)]"
        }`}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[11px] text-[var(--text-dim)] mt-1.5">{hint}</div>
      )}
    </div>
  );
}

export function FundKeyStatsGrid({
  aum,
  expenseRatio,
  returns3Y,
  returns5Y,
  returnsInception,
  navHigh,
  navLow,
  benchmarkName,
  history,
  rangeBasis = "NAV",
}: FundKeyStatsGridProps) {
  const c3Y = historyCellText(returns3Y, 3, history, formatPct);
  const c5Y = historyCellText(returns5Y, 5, history, formatPct);
  const cInception = historyCellText(
    returnsInception,
    null,
    history,
    formatPct
  );
  const cHigh = rangeCellText(navHigh, "peak", rangeBasis, history);
  const cLow = rangeCellText(navLow, "trough", rangeBasis, history);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] overflow-hidden">
      <div className="grid grid-cols-2 sm:grid-cols-4">
        <Cell
          label="AUM"
          value={formatAum(aum)}
          hint="Assets under management"
        />
        <Cell
          label="Expense ratio"
          value={expenseRatio != null ? `${expenseRatio.toFixed(2)}%` : "-"}
          hint="Total expense ratio"
        />
        <Cell
          label="3Y CAGR"
          value={c3Y.value}
          hint={c3Y.hint}
          tone={returns3Y != null && returns3Y >= 0 ? "primary" : "muted"}
        />
        <Cell label="5Y CAGR" value={c5Y.value} hint={c5Y.hint} />
        <Cell
          label="Since inception"
          value={cInception.value}
          hint={cInception.hint}
        />
        <Cell label="52W high" value={cHigh.value} hint={cHigh.hint} />
        <Cell label="52W low" value={cLow.value} hint={cLow.hint} />
        <Cell
          label="Benchmark"
          value={benchmarkName ?? "-"}
          hint="Stated tracking index"
        />
      </div>
    </div>
  );
}

export default FundKeyStatsGrid;
