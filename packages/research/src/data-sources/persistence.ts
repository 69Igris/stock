/**
 * Fallback-data persistence - B6 (MONEY-218-followup).
 *
 * When a research fetch tool falls back from Yahoo to Tickertape /
 * Screener, it returns the data to the executor but historically did
 * NOT write it to the database. The next research run on the same
 * symbol re-fetched from the same fallback source - burning rate
 * limits and adding 2-4 seconds per call.
 *
 * This helper upserts the fallback data into the existing
 * `StockFinancials` model so subsequent runs can hit a fast indexed
 * read instead of the network. The model already supports the shape
 * - it has `source: TICKERTAPE | SCREENER | YAHOO`, `rawData: Json?`,
 * and a unique index on `[symbol, exchange, statementType, periodType,
 * period]`.
 *
 * Design choices:
 *   - **Fire-and-forget.** Persistence runs via `void persist(...)`
 *     so the fetch tool's response time is unaffected. If the DB
 *     write fails (transient Mongo blip), it logs a warning and
 *     drops the row - the fallback chain still works on the next
 *     call.
 *   - **No instrumentId required.** We resolve it lazily; if the
 *     symbol isn't in InstrumentMapping (e.g., obscure ticker),
 *     we skip the persist entirely rather than fail loudly.
 *   - **Bulk upsert.** A balance-sheet response typically has 4-8
 *     statements (4 years annual + N quarters). We loop with
 *     `prisma.stockFinancials.upsert` so the existing unique index
 *     handles dedupe.
 */

import { prisma } from "@usemoney/database";
import {
  mayOverwriteFinancials,
  rupeesToCrores,
} from "@usemoney/core/market-data";
import { getLogger } from "@usemoney/logger";
import { resolveRowRawData } from "./persistence-logic";

const logger = getLogger("research");

export type StatementType = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
export type PeriodType = "ANNUAL" | "QUARTERLY";

/**
 * Fields we know how to persist on each statement row. Anything not
 * in this map gets dropped - we don't want to scribble unknown keys
 * into the model.
 */
export interface FallbackStatementRow {
  /** Period label, e.g. "2024" or "Q3-2024" */
  period: string;
  /**
   * UTC end-of-period. PER-ROW, not per-call: one persist carries N periods, so
   * a call-level `periodEnd` would stamp every year with the same date. Omitted
   * when the source has none (Tickertape's `TTM` row ships `endDate: ""`).
   */
  periodEnd?: Date;
  /**
   * THIS row's upstream payload, verbatim — MONEY-1205.
   *
   * Per-row, for the same reason `periodEnd` is: one persist carries N periods.
   * The call-level `rawData` used to be written onto every one of them, so a
   * symbol's five annual rows all ended up holding the SAME five-element array
   * instead of their own row — see {@link resolveRowRawData}.
   */
  raw?: Record<string, unknown>;
  // Income
  revenue?: number | null;
  grossProfit?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  ebitda?: number | null;
  // Balance Sheet
  totalAssets?: number | null;
  totalLiabilities?: number | null;
  totalEquity?: number | null;
  totalDebt?: number | null;
  totalCash?: number | null;
  // Cash Flow
  operatingCashFlow?: number | null;
  capitalExpenditure?: number | null;
  freeCashFlow?: number | null;
}

/**
 * What the incoming figures are denominated in — MONEY-1205.
 *
 * `StockFinancials` is a ₹ CRORE table. Nothing declared that; it is simply
 * what all 32,359 prod rows are, because every one came from Tickertape and
 * Tickertape's feed is crore. Yahoo's `quoteSummary` financials are ABSOLUTE
 * RUPEES, so a Yahoo row written unconverted lands 10,000,000x too large in a
 * column nothing marks as suspect — and this helper is fire-and-forget with
 * every error swallowed, so it would never surface.
 */
export type FinancialUnits = "CRORE" | "RUPEE";

/**
 * The unit each source publishes in.
 *
 * A TABLE rather than a caller-supplied flag, because the unit is a property of
 * the SOURCE, not of the call site: three fetch tools × two code paths each is
 * six places that would otherwise have to remember, and the one that forgot
 * would be silently wrong. Callers may still override via `units` for a source
 * that changes its mind.
 */
export const SOURCE_UNITS: Record<
  PersistFallbackOptions["source"],
  FinancialUnits
> = {
  TICKERTAPE: "CRORE",
  SCREENER: "CRORE",
  YAHOO: "RUPEE",
};

export interface PersistFallbackOptions {
  symbol: string;
  /** Resolved exchange - defaults to NSE if the symbol resolution misses. */
  exchange?: string;
  statementType: StatementType;
  periodType: PeriodType;
  source: "TICKERTAPE" | "SCREENER" | "YAHOO";
  statements: FallbackStatementRow[];
  /**
   * Denomination of the figures in `statements`. Defaults to
   * {@link SOURCE_UNITS} for `source`. `RUPEE` values are divided by 1e7 on the
   * way in so the column stays ₹ crore.
   */
  units?: FinancialUnits;
  /**
   * Call-level payload, kept for callers that persist a SINGLE row.
   *
   * Prefer `FallbackStatementRow.raw`. An ARRAY here is rejected outright by
   * {@link resolveRowRawData} — it is the whole statement history, not this
   * row's payload, and writing it is what made those rows unreadable.
   */
  rawData?: unknown;
}

/**
 * Upsert each statement row into StockFinancials. Idempotent via the
 * existing `[symbol, exchange, statementType, periodType, period]`
 * unique index.
 *
 * Resolves the exchange + instrumentId from InstrumentMapping when not
 * provided. Skips silently if the symbol is unknown (obscure ticker
 * not in our master list) - better to drop the persist than block the
 * fetch tool's response.
 */
/** The numeric columns a fallback row may carry. */
const FALLBACK_COLUMNS = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "ebitda",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "totalDebt",
  "totalCash",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
] as const satisfies ReadonlyArray<keyof FallbackStatementRow>;

/**
 * Project one fallback row onto the `StockFinancials` columns, in ₹ crore.
 *
 * Three states, matching `mapTickertapeStatementRow`:
 *   - key absent / `undefined` / non-finite → **column OMITTED** (Prisma leaves
 *     the incumbent alone);
 *   - key present and `null`               → `null` (caller says undisclosed);
 *   - finite number                        → the value, ÷1e7 when `RUPEE`.
 *
 * Pure and exported so the unit-conversion can be tested without Prisma.
 */
export function scaleStatementRow(
  row: FallbackStatementRow,
  units: FinancialUnits,
): Partial<Record<(typeof FALLBACK_COLUMNS)[number], number | null>> {
  const out: Partial<Record<(typeof FALLBACK_COLUMNS)[number], number | null>> =
    {};
  for (const column of FALLBACK_COLUMNS) {
    const v = row[column];
    if (v === undefined) continue;
    if (v === null) {
      out[column] = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (units === "CRORE") {
      out[column] = v;
      continue;
    }
    const crores = rupeesToCrores(v);
    if (crores !== undefined) out[column] = crores;
  }
  return out;
}

export async function persistFinancialFallback(
  opts: PersistFallbackOptions,
): Promise<void> {
  const cleanSymbol = opts.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  let instrumentId: string | null = null;
  let exchange = opts.exchange?.toUpperCase() ?? null;

  try {
    // Resolve the instrument so we can populate instrumentId. Filter on
    // exchange when supplied; otherwise pick the first active mapping.
    const instr = await prisma.instrumentMapping.findFirst({
      where: {
        symbol: cleanSymbol,
        ...(exchange ? { exchange } : {}),
        isActive: true,
      },
      select: { id: true, exchange: true },
    });

    if (!instr) {
      logger.debug(
        { symbol: cleanSymbol, statementType: opts.statementType },
        "[persist-fallback] symbol not in InstrumentMapping - skipping",
      );
      return;
    }
    instrumentId = instr.id;
    exchange = instr.exchange;
  } catch (lookupErr) {
    logger.warn(
      { symbol: cleanSymbol, error: String(lookupErr) },
      "[persist-fallback] instrument lookup failed - skipping persist",
    );
    return;
  }

  const fetchedAt = new Date();

  // Sequential upserts. Throughput isn't the bottleneck here (≤ 8 rows
  // per call, fired in the background), and Promise.all on upserts
  // against the same Mongo collection can hit write conflicts on the
  // unique index when two parallel rows target the same key.
  // Counted so a run that legitimately writes nothing is distinguishable from a
  // run that silently failed — this helper reports nothing else.
  let authoritySkips = 0;

  for (const row of opts.statements) {
    if (!row.period) continue;

    // MONEY-1205 — every field used to be `row.x ?? null`, in an unconditional
    // `update:`. A caller that supplied only the income fields (all three fetch
    // tools do) therefore NULLED the eight balance-sheet and cash-flow columns
    // on the same row, and restamped `source` while doing it. `undefined` now
    // means "the caller said nothing about this column" and Prisma leaves it
    // alone; an explicit `null` from the caller still writes null, because that
    // is the caller positively reporting the field as undisclosed.
    const data = scaleStatementRow(
      row,
      opts.units ?? SOURCE_UNITS[opts.source],
    );

    try {
      // MONEY-1204 — the challenger is a RUNTIME value here, not a literal:
      // `opts.source` is "TICKERTAPE" | "SCREENER" | "YAHOO" depending on which
      // rung of the fallback chain produced this row, and SCREENER/YAHOO rank
      // BELOW Tickertape as well as below NSE_XBRL. Hard-coding "TICKERTAPE"
      // would let a Yahoo fallback overwrite a Tickertape row — a demotion the
      // authority table exists to forbid.
      //
      // This is also the site where a wrong write is most invisible: the whole
      // helper is fire-and-forget (`void persistFinancialFallbackInBackground`),
      // every error is swallowed into a warn, and nobody awaits the result. It
      // fails silently by construction, so the guard has to be here rather than
      // in a caller that could notice.
      const rowRaw = resolveRowRawData(row, opts.rawData);

      const incumbent = await prisma.stockFinancials.findUnique({
        where: {
          symbol_exchange_statementType_periodType_period: {
            symbol: cleanSymbol,
            exchange: exchange!,
            statementType: opts.statementType,
            periodType: opts.periodType,
            period: row.period,
          },
        },
        select: { source: true },
      });
      if (!mayOverwriteFinancials(opts.source, incumbent?.source)) {
        authoritySkips++;
        continue;
      }

      await prisma.stockFinancials.upsert({
        where: {
          symbol_exchange_statementType_periodType_period: {
            symbol: cleanSymbol,
            exchange: exchange!,
            statementType: opts.statementType,
            periodType: opts.periodType,
            period: row.period,
          },
        },
        create: {
          instrumentId: instrumentId!,
          symbol: cleanSymbol,
          exchange: exchange!,
          statementType: opts.statementType,
          periodType: opts.periodType,
          period: row.period,
          ...data,
          ...(row.periodEnd ? { periodEnd: row.periodEnd } : {}),
          ...(rowRaw ? { rawData: rowRaw as never } : {}),
          source: opts.source,
          fetchedAt,
        },
        update: {
          ...data,
          ...(row.periodEnd ? { periodEnd: row.periodEnd } : {}),
          // ABSENT, not null — see resolveRowRawData. `?? null` here erased the
          // per-row payload the backfill re-projects the missing columns from.
          ...(rowRaw ? { rawData: rowRaw as never } : {}),
          source: opts.source,
          fetchedAt,
        },
      });
    } catch (upsertErr) {
      logger.warn(
        {
          symbol: cleanSymbol,
          period: row.period,
          statementType: opts.statementType,
          error: String(upsertErr),
        },
        "[persist-fallback] upsert failed - dropping row",
      );
      // Continue with remaining rows; partial persistence is fine.
    }
  }

  if (authoritySkips > 0) {
    logger.debug(
      {
        symbol: cleanSymbol,
        statementType: opts.statementType,
        source: opts.source,
        skipped: authoritySkips,
      },
      "[persist-fallback] rows skipped - a higher-ranked source owns them",
    );
  }
}

/**
 * Fire-and-forget wrapper. Caller doesn't await, so the fetch tool's
 * response time is unaffected. Errors are swallowed by the inner
 * function (logged only).
 */
export function persistFinancialFallbackInBackground(
  opts: PersistFallbackOptions,
): void {
  void persistFinancialFallback(opts).catch(() => {
    // Already logged inside; ignore.
  });
}
