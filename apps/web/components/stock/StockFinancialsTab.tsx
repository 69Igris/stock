"use client";

/**
 * Financials tab for the Stock detail page (MONEY-244 v3.1).
 *
 * Three sub-sections (Income / Balance Sheet / Cash Flow) rendered as
 * compact tables with the most recent 6 periods across the columns.
 * Period type toggle: Annual + Quarterly (MONEY-805). The financials sync now
 * persists QUARTERLY rows too — income-statement only, since Tickertape's
 * interim feed is P&L-only (no quarterly balance-sheet / cash-flow source), so
 * the Quarterly view shows the Income statement section and the Balance sheet /
 * Cash flow sections stay empty for that period type.
 *
 * Source: `StockFinancials` model; populated by the existing
 * Tickertape / Screener.in scrapers. Empty-state appears when the row
 * doesn't exist for this symbol - we don't fabricate values.
 *
 * Playful re-skin: MONEY-489. All props / data-fetch / calculations preserved.
 * Theme-aware: CSS vars used for all colours. No single-theme hex values.
 * Mobile: only the table scrolls horizontally (fin-table-scroll wrapper).
 *   The outer layout does NOT cause horizontal overflow.
 */

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import {
  getStockFinancialsAction,
  type StockFinancialRow,
} from "@/lib/actions/stock-tabs";
import {
  periodOverPeriodPct,
  comparePeriodsDesc,
} from "@/lib/actions/stock-detail-logic";
// MONEY-1300 — the ONE basis vocabulary, imported by SUBPATH rather than from
// the `@usemoney/core/market-data` barrel: this is a client component and the
// barrel drags the whole market-data surface into the browser bundle. The
// module is pure TypeScript with no runtime dependencies.
import { stockFinancialsBasisLabel } from "@usemoney/core/market-data/financials-basis";
import { formatStatementCrores } from "@/app/stock/[symbol]/stock-format";
import { SectionEmpty } from "./SectionShell";
import "./financials-playful.css";

interface StockFinancialsTabProps {
  symbol: string;
  exchange: string;
}

type PeriodType = "QUARTERLY" | "ANNUAL";

interface SectionDef {
  title: string;
  rows: Array<{
    label: string;
    field: keyof Pick<
      StockFinancialRow,
      | "revenue"
      | "grossProfit"
      | "operatingIncome"
      | "netIncome"
      | "ebitda"
      | "totalAssets"
      | "totalLiabilities"
      | "totalEquity"
      | "totalDebt"
      | "operatingCashFlow"
      | "capitalExpenditure"
      | "freeCashFlow"
    >;
  }>;
}

const INCOME_DEF: SectionDef = {
  title: "Income statement",
  rows: [
    { label: "Revenue", field: "revenue" },
    { label: "Gross profit", field: "grossProfit" },
    { label: "Operating income", field: "operatingIncome" },
    { label: "EBITDA", field: "ebitda" },
    { label: "Net income", field: "netIncome" },
  ],
};

const BALANCE_DEF: SectionDef = {
  title: "Balance sheet",
  rows: [
    { label: "Total assets", field: "totalAssets" },
    { label: "Total liabilities", field: "totalLiabilities" },
    { label: "Total equity", field: "totalEquity" },
    { label: "Total debt", field: "totalDebt" },
  ],
};

const CASHFLOW_DEF: SectionDef = {
  title: "Cash flow",
  rows: [
    { label: "Operating cash flow", field: "operatingCashFlow" },
    { label: "Capex", field: "capitalExpenditure" },
    { label: "Free cash flow", field: "freeCashFlow" },
  ],
};

// `formatCr` used to live here and divided by 1e7 under the comment "source
// data is in INR". `StockFinancials`' money columns are CRORES, so HDFC Bank's
// ₹4,70,915 Cr revenue rendered as ₹0.05 Cr — a confident wrong number, which
// fires no empty state. The one shared formatter now lives beside the market-cap
// pair in `stock-format.ts`, whose doc has warned about this exact double
// conversion since MONEY-1144.

// ── Period-aware ordering ──────────────────────────────────────────────────
//
// `StockFinancials.period` is a free-form upstream STRING ("Q3-2024", "FY2024",
// "2024", "Mar 2024", …) and the server action can't reliably order it (a
// lexical DB sort puts 'Q4-2023' AHEAD of 'Q3-2024'). So the action returns ALL
// rows for the statement and the table sorts each bucket NEWEST-FIRST here with
// the period-aware `comparePeriodsDesc` (pure + unit-tested in
// stock-detail-logic) — which the QoQ/YoY delta (rows[0] vs rows[1]) and the
// latest-6 columns depend on.

/** True when a row is the trailing-twelve-month aggregate rather than a period. */
export function isTtmRow(row: { period: string }): boolean {
  return row.period.trim().toUpperCase() === "TTM";
}

// ── The frozen TTM column — MONEY-1235 ─────────────────────────────────────
//
// `periodLabel()` (packages/core/src/market-data/xbrl-projection.ts) emits
// `FY ${y}` and `Q${q}-${fyEnd}` and STRUCTURALLY never emits "TTM". So the
// nightly XBRL projection cannot displace a `period:"TTM"` row: the ~2,123 of
// them stored under `periodType:"ANNUAL"` keep Tickertape values, a Tickertape
// `source` and a frozen `fetchedAt` permanently, while the FY rows beside them
// are refreshed every night.
//
// Two rows, one table, two clocks — and nothing on screen said so. Deriving a
// REAL TTM from the quarterly rows is a later phase (it needs the quarterly
// drain to have run); this is the interim, and it is deliberately a BADGE
// rather than a suppression. The figure is not wrong, it is OLD, and hiding a
// real number is a worse answer than dating it.

/** Epoch ms from a Date / ISO string, or null. Never NaN. */
function toMs(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * `12 Mar 2026`, in UTC and without `Intl`.
 *
 * Deterministic on purpose: a locale-formatted date renders differently on the
 * server and the client, and the day-boundary difference between UTC and IST is
 * immaterial to a badge whose threshold is 45 days.
 */
export function formatAsOfDate(
  v: string | Date | null | undefined
): string | null {
  const t = toMs(v);
  if (t === null) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * How far behind the periodic rows a TTM row may sit before it is badged.
 *
 * 45 days is not a tidy round number: SEBI LODR gives a listed company 45 days
 * after a quarter end to file. A TTM more than one filing window behind the
 * rows beside it therefore cannot contain the newest quarter those rows do.
 */
export const TTM_STALE_BEHIND_DAYS = 45;

/**
 * The TTM row's as-of date, but ONLY when it has stopped moving relative to the
 * rows beside it. `null` means "no badge" — no TTM row, no usable stamps, or a
 * TTM that is keeping up.
 *
 * Deliberately RELATIVE, never against the wall clock. A three-month-old TTM
 * beside three-month-old annual rows is a company that has not filed, which is
 * normal and must not be badged; the defect is a TTM frozen while its
 * neighbours move.
 */
export function staleTtmAsOf(
  rows: StockFinancialRow[],
  behindDays: number = TTM_STALE_BEHIND_DAYS
): string | null {
  const ttm = rows.find(isTtmRow);
  if (!ttm) return null;
  const ttmAt = toMs(ttm.fetchedAt);
  if (ttmAt === null) return null;

  let newestAt: number | null = null;
  for (const r of rows) {
    if (isTtmRow(r)) continue;
    const t = toMs(r.fetchedAt);
    if (t !== null && (newestAt === null || t > newestAt)) newestAt = t;
  }
  // No periodic row with a usable stamp ⇒ nothing to compare against. "Cannot
  // tell" is not "fine", but it is also not evidence, and manufacturing either
  // is worse than saying nothing.
  if (newestAt === null) return null;

  if (newestAt - ttmAt <= behindDays * 24 * 60 * 60 * 1000) return null;
  return formatAsOfDate(new Date(ttmAt));
}

/**
 * The period-over-period % shown on the LEADING column, or null when there is
 * no like-for-like pair to compute it from — MONEY-1235.
 *
 * Extracted from the JSX so the rule can be executed by a test rather than
 * described by one. Two separate things happen here and both matter:
 *
 *  1. The PAIR excludes TTM. The old code paired `rows[0]` with `rows[1]`
 *     directly and only suppressed when `rows[0]` was TTM — the single position
 *     TTM could occupy while every row was undated. Once the XBRL projection
 *     writes `FY 2026` with a real `periodEnd`, dated and undated rows
 *     interleave and TTM can land at ANY index; at index 1 the column-0 delta
 *     compared a fiscal year against a trailing-twelve-month aggregate. Not
 *     like-for-like — and with the projection redefining `operatingIncome` as
 *     EBIT while the frozen TTM row keeps Tickertape's definition, not even the
 *     same metric on both sides.
 *  2. A LEADING TTM still suppresses entirely. The delta chip renders inside
 *     column 0, so an FY-vs-FY number displayed there would be read as the TTM
 *     column's change.
 */
/**
 * Newest six PERIODIC columns, with the TTM column kept — MONEY-1235.
 *
 * A bare `.slice(0, 6)` drops TTM the moment a symbol has more than five
 * periods: Tickertape's TTM row carries no `endDate`, so `sortByPeriodDesc`
 * files it LAST. Prod has 5 FY rows + TTM = 6 today, so it survives at index 5
 * by exactly one place — and the first `createMissing` run or the 2018+
 * backfill adds a seventh period, at which point the TTM column AND the
 * staleness badge computed from it vanish silently. That is the opposite of
 * what the badge was added to do.
 */
export function sixPeriodsKeepingTtm(
  rows: StockFinancialRow[]
): StockFinancialRow[] {
  const sorted = sortByPeriodDesc(rows);
  const ttm = sorted.filter(isTtmRow);
  const periodic = sorted.filter((r) => !isTtmRow(r)).slice(0, 6);
  return [...periodic, ...ttm];
}

export function leadingDelta(
  rows: StockFinancialRow[],
  field: keyof StockFinancialRow
): number | null {
  if (rows[0] && isTtmRow(rows[0])) return null;
  const paired = rows.filter((r) => !isTtmRow(r));
  // 3. NEVER PAIR ACROSS SOURCES — MONEY-1235. Mid-drain the two newest rows
  //    are `FY 2025 / NSE_XBRL` and `FY 2024 / TICKERTAPE`, and this switchover
  //    REDEFINED `operatingIncome` as EBIT (revenue − totalExpenses + finance
  //    costs) where Tickertape's column was its own operating income.
  //    Subtracting one definition from the other renders a definitional step
  //    change as company performance, under a label reading "Change vs the
  //    previous period". `source` is already on the row, so the guard is free.
  if (paired[0] && paired[1] && paired[0].source !== paired[1].source) {
    return null;
  }
  const latest = (paired[0]?.[field] ?? null) as number | null;
  const prior = (paired[1]?.[field] ?? null) as number | null;
  return periodOverPeriodPct(latest, prior);
}

/**
 * Newest-first copy of a financials list.
 *
 * Ordered by `periodEnd` when the source supplied it, falling back to the
 * label-aware `comparePeriodsDesc`. The fallback alone is not enough:
 * `parsePeriodKey("TTM")` finds no digits, so `comparePeriodsDesc` sorts TTM
 * LAST — putting the freshest figure on the platform in the oldest column of a
 * chronological table, and dropping it entirely for any symbol with 7+ annual
 * rows via the `.slice(0, 6)` below.
 */
// ── Consolidated vs standalone — MONEY-1300 ────────────────────────────────
//
// An Indian company files the SAME period twice under SEBI/Ind AS: CONSOLIDATED
// (parent + subsidiaries) and STANDALONE (parent alone). For a holding company
// they differ by a MULTIPLE — 360ONE FY2025 `totalAssets` is 19,768 Cr against
// 7,332 Cr — and measured on prod 2026-08-31, 1,786 of 2,467 symbols with an
// annual period (72%) file BOTH. `StockFinancials` keeps ONE row per period, so
// the figure this table renders is correct and, until now, unattributable.
//
// Displayed, never filtered. And ABSENT is never quietly upgraded: the column is
// MISSING on the ~32,359 rows the XBRL projection has not rewritten, a vendor
// row says the literal "UNKNOWN", and both must read as "Basis not stated"
// rather than "Consolidated" — asserting the group's numbers over the parent's
// is the failure this exists to prevent.

/** One column's own basis, as the `<th>` tooltip sentence. */
export function columnBasisNote(row: StockFinancialRow): string {
  return `${stockFinancialsBasisLabel(row.basis)} — consolidated figures cover the parent and its subsidiaries, standalone the parent alone.`;
}

export function sortByPeriodDesc(
  rows: StockFinancialRow[]
): StockFinancialRow[] {
  return [...rows].sort((a, b) => {
    const ea = a.periodEnd ? new Date(a.periodEnd).getTime() : NaN;
    const eb = b.periodEnd ? new Date(b.periodEnd).getTime() : NaN;
    const va = Number.isFinite(ea);
    const vb = Number.isFinite(eb);
    if (va && vb && ea !== eb) return eb - ea;
    // A row WITH a real end date outranks one without — an undated row cannot
    // be placed, and guessing its position is what produced the TTM bug.
    if (va !== vb) return va ? -1 : 1;
    return comparePeriodsDesc(a.period, b.period);
  });
}

export function StockFinancialsTab({
  symbol,
  exchange,
}: StockFinancialsTabProps) {
  const [period, setPeriod] = useState<PeriodType>("ANNUAL");
  const [data, setData] = useState<{
    income: StockFinancialRow[];
    balance: StockFinancialRow[];
    cashflow: StockFinancialRow[];
  }>({ income: [], balance: [], cashflow: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Periods observed to hold at least one row, this mount.
   *
   * Exists so an empty panel can say WHICH period has data instead of implying
   * the company has none. QUARTERLY is empty for every symbol on the platform
   * right now — `financial-data-sync` is its only Tickertape writer and is
   * scheduled at `tier:"hot"`, which matches 0 of 10,444 symbols (MONEY-1211),
   * and the XBRL quarterly backfill has not been run. So the default-looking
   * message "Financials for X aren't available yet" was being shown on top of
   * 16 populated annual periods, one click away.
   *
   * Populated from responses only. Nothing is assumed about a period that has
   * not been fetched, so "no other period" and "not checked yet" stay distinct.
   */
  const [periodsWithData, setPeriodsWithData] = useState<
    Partial<Record<PeriodType, boolean>>
  >({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockFinancialsAction({ symbol, exchange, periodType: period })
      .then((r) => {
        if (cancelled) return;
        if (!r.success) {
          setError(r.error ?? "Failed to load");
          return;
        }
        setData(r.data);

        const hasRows =
          r.data.income.length > 0 ||
          r.data.balance.length > 0 ||
          r.data.cashflow.length > 0;
        setPeriodsWithData((prev) => ({ ...prev, [period]: hasRows }));

        // THE SIBLING IS PROBED WHETHER OR NOT THIS PERIOD HAD ROWS.
        //
        // It used to run only on an EMPTY result — correct when its only job
        // was turning a dead end into a pointer at the data. That job grew:
        // the Quarterly TAB is now hidden until a quarterly row is observed,
        // and `periodsWithData.QUARTERLY` can only be observed by asking.
        //
        // With the old guard, any symbol that HAS annual rows — the normal
        // case — never probed, so QUARTERLY stayed `undefined`, the tab
        // rendered, and clicking it landed on the empty table the change was
        // written to remove. Worse, the tab then vanished while still
        // selected.
        //
        // One extra read per mount, against a cached action, to keep a control
        // from lying about what is behind it.
        const other: PeriodType =
          period === "QUARTERLY" ? "ANNUAL" : "QUARTERLY";
        getStockFinancialsAction({
          symbol,
          exchange,
          periodType: other,
        })
          .then((o) => {
            if (cancelled || !o.success) return;
            setPeriodsWithData((prev) => ({
              ...prev,
              [other]:
                o.data.income.length > 0 ||
                o.data.balance.length > 0 ||
                o.data.cashflow.length > 0,
            }));
          })
          // A failed probe must not surface as a failed panel — the panel's own
          // result already arrived. Worst case the generic message is shown.
          .catch(() => undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, period]);

  const allEmpty =
    data.income.length === 0 &&
    data.balance.length === 0 &&
    data.cashflow.length === 0;

  // The OTHER period, only when it is known to hold rows. `undefined` covers
  // both "checked, also empty" and "not checked yet" — neither justifies
  // pointing the user at a second empty panel.
  const otherPeriod: PeriodType =
    period === "QUARTERLY" ? "ANNUAL" : "QUARTERLY";
  const otherPeriodWithData: PeriodType | null = periodsWithData[otherPeriod]
    ? otherPeriod
    : null;

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="fin-header">
        <div className="fin-title-block">
          <BarChart3
            aria-hidden="true"
            width={14}
            height={14}
            style={{ color: "var(--emerald-text)", flexShrink: 0 }}
          />
          <span className="fin-title">FINANCIALS</span>
        </div>

        {/* Period toggle.
            THE QUARTERLY TAB IS HIDDEN UNTIL A QUARTERLY ROW IS OBSERVED.
            `stock_financials` holds ZERO quarterly rows for every symbol on the
            platform: `financial-data-sync` was its only Tickertape writer and is
            retired, and the XBRL quarterly drain has not been run. So the tab
            was a control whose entire behaviour was to replace a populated table
            with an empty one — a dead end that reads as missing data rather than
            as a feature that has not landed.
            `periodsWithData` is populated from RESPONSES ONLY, so this shows the
            tab the moment one quarterly row arrives and never guesses before
            then. The check is `!== false`, not `=== true`: before the first
            quarterly fetch the value is UNDEFINED, and hiding a tab we have not
            checked yet would make the drain's first rows invisible until a
            reload. */}
        <div className="fin-tab-strip" role="tablist" aria-label="Period">
          {periodsWithData.QUARTERLY !== false && (
            <button
              type="button"
              role="tab"
              aria-selected={period === "QUARTERLY"}
              className={`fin-tab-btn${period === "QUARTERLY" ? " is-active" : ""}`}
              onClick={() => setPeriod("QUARTERLY")}
            >
              Quarterly
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={period === "ANNUAL"}
            className={`fin-tab-btn${period === "ANNUAL" ? " is-active" : ""}`}
            onClick={() => setPeriod("ANNUAL")}
          >
            Annual
          </button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────── */}
      {loading && allEmpty ? (
        <FinancialsSkeleton />
      ) : error ? (
        <div className="fin-error-card" role="alert">
          {error}
        </div>
      ) : allEmpty ? (
        // MONEY-1255 — the BODY is now generic in both branches; the two-way
        // branch itself is not, and must not be flattened. The switch button
        // is the whole point of the first branch: a populated period sitting
        // one click away is a different situation from nothing anywhere, and
        // only the button can say so once the prose is gone.
        //
        // The second branch is reached when the other period is empty too OR
        // has not answered, and it deliberately carries NO note. An unfinished
        // probe must not claim the other period is empty — which is what any
        // sentence written here would end up doing.
        <SectionEmpty
          note={
            otherPeriodWithData
              ? `No ${period === "QUARTERLY" ? "quarterly" : "annual"} filings for ${symbol} yet — but the ${otherPeriodWithData === "ANNUAL" ? "annual" : "quarterly"} period has data.`
              : undefined
          }
          action={
            otherPeriodWithData ? (
              <>
                {" "}
                <button
                  type="button"
                  className="fin-empty-switch"
                  onClick={() => setPeriod(otherPeriodWithData)}
                >
                  {otherPeriodWithData === "ANNUAL"
                    ? "View annual"
                    : "View quarterly"}
                </button>
              </>
            ) : undefined
          }
        />
      ) : (
        <div>
          {data.income.length > 0 && (
            <FinancialsSection
              def={INCOME_DEF}
              rows={sixPeriodsKeepingTtm(data.income)}
            />
          )}
          {data.balance.length > 0 && (
            <FinancialsSection
              def={BALANCE_DEF}
              rows={sixPeriodsKeepingTtm(data.balance)}
            />
          )}
          {data.cashflow.length > 0 && (
            <FinancialsSection
              def={CASHFLOW_DEF}
              rows={sixPeriodsKeepingTtm(data.cashflow)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Section table ─────────────────────────────────────────────────── */

function FinancialsSection({
  def,
  rows,
}: {
  def: SectionDef;
  rows: StockFinancialRow[];
}) {
  // MONEY-1235 — the TTM column is RENDERED but never PAIRED, and it carries an
  // as-of stamp when it has stopped moving. Both rules live in the exported
  // pure helpers above so a test can execute them.
  const ttmAsOf = staleTtmAsOf(rows);

  return (
    <div className="fin-section-card">
      <div className="fin-section-head">
        <span className="fin-section-label">{def.title}</span>
      </div>
      {/* Only the TABLE itself scrolls — outer card does not */}
      <div className="fin-table-scroll">
        <table className="fin-tbl">
          <thead>
            <tr>
              <th>Metric</th>
              {rows.map((r) => (
                // MONEY-1300 — the per-COLUMN basis. The section badge collapses
                // to "Mixed basis" when the periods disagree, and this is where
                // a reader finds out which column is which.
                <th
                  key={r.period}
                  className="num-col"
                  title={columnBasisNote(r)}
                >
                  {isTtmRow(r) ? (
                    // An aggregate rather than a reporting period — say so, or
                    // a reader takes it for a fiscal year.
                    <span
                      // The basis is repeated here on purpose — MONEY-1300. An
                      // inner `title` SHADOWS the `<th>`'s, so without this the
                      // TTM column would be the one column whose basis a reader
                      // cannot hover for, and it is the column most likely to
                      // disagree with its neighbours (the projection can never
                      // rewrite a "TTM" label, so those rows keep the vendor's).
                      title={
                        ttmAsOf
                          ? `Trailing twelve months — an aggregate, not a reporting period. Last refreshed ${ttmAsOf}; the periods beside it are newer. ${columnBasisNote(r)}`
                          : `Trailing twelve months — an aggregate, not a reporting period. ${columnBasisNote(r)}`
                      }
                    >
                      TTM
                      {/* MONEY-1235 — the as-of stamp, shown only when this
                          column has stopped moving while its neighbours have
                          not. Theme tokens only: --pop-2-text is the accessible
                          amber defined in BOTH the light and dark blocks of
                          playful-app.css. */}
                      {ttmAsOf && (
                        <span
                          style={{
                            display: "block",
                            marginTop: 2,
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                            textTransform: "none",
                            color: "var(--pop-2-text)",
                          }}
                        >
                          as of {ttmAsOf}
                        </span>
                      )}
                    </span>
                  ) : (
                    r.period
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {def.rows.map((m) => {
              // The period-over-period % on the leading column (YoY for Annual,
              // QoQ for Quarterly — driven by the toggle), paired over the
              // REPORTING PERIODS only. See `leadingDelta`.
              const delta = leadingDelta(rows, m.field);
              return (
                <tr key={m.field}>
                  <td className="fin-metric-label">{m.label}</td>
                  {rows.map((r, ci) => (
                    <td key={r.period} className="fin-num">
                      {ci === 0 && delta != null ? (
                        <span className="fin-num-latest">
                          <span>{formatStatementCrores(r[m.field])}</span>
                          <span
                            className={`fin-delta ${
                              delta > 0 ? "up" : delta < 0 ? "down" : "flat"
                            }`}
                            title="Change vs the previous period"
                          >
                            {delta > 0 ? "↑" : delta < 0 ? "↓" : "→"}{" "}
                            {Math.abs(delta).toFixed(1)}%
                          </span>
                        </span>
                      ) : (
                        formatStatementCrores(r[m.field])
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── ComingSoonCard ────────────────────────────────────────────────── */

/** "Coming soon" placeholder for tabs gated on incomplete data
 *  ingestion. Centralised here so the three tab components share the
 *  exact same visual treatment. */
export function ComingSoonCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="fin-coming-card">
      <div className="fin-coming-pill" aria-label="Coming soon">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--emerald)",
            animation: "ph-pulse 1.6s infinite",
            flexShrink: 0,
          }}
          aria-hidden="true"
        />
        Coming soon
      </div>
      <h4 className="fin-coming-title">{title}</h4>
      <p className="fin-coming-desc">{description}</p>
    </div>
  );
}

/* ── Skeleton ──────────────────────────────────────────────────────── */

/** Shimmer placeholder mirroring the populated financials table. */
function FinancialsSkeleton() {
  return (
    <div>
      {[0, 1, 2].map((sec) => (
        <div key={sec} className="fin-skeleton-card">
          <div className="fin-skeleton-head">
            <div className="fin-skeleton-head-bar" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="fin-skeleton-row">
              <div className="fin-skeleton-cell" />
              <div className="fin-skeleton-cell" />
              <div className="fin-skeleton-cell" />
              <div className="fin-skeleton-cell" />
              <div className="fin-skeleton-cell" />
              <div className="fin-skeleton-cell last" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default StockFinancialsTab;
