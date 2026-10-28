/**
 * Fetch Cash Flow Statement - Yahoo quoteSummary → Tickertape/Screener fallback
 */

import {
  yahooFetchQuoteSummary,
  withExchangeFallback,
} from "@usemoney/core/market-data";
// MONEY-1300 — every statement this tool returns says whose accounts it is.
import {
  summariseStockFinancialsBasis,
  type StockFinancialsBasisSummary,
} from "@usemoney/core/market-data/financials-basis";
import {
  fetchFinancialsChain,
  fetchFinancialsChainDetailed,
} from "../data-sources/data-source-chain";
import { describeUnavailable } from "./unavailable";
import { dbFirstSatisfiesRequest } from "./db-first-coverage";
import { persistFinancialFallbackInBackground } from "../data-sources/persistence";
import {
  mapTickertapeStatementRow,
  type MappedTickertapeStatement,
} from "../data-sources/db-store-logic";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { FinancialStatement } from "../types";

function extractRaw(obj: unknown): number | undefined {
  if (typeof obj === "number") return obj;
  if (typeof obj === "object" && obj !== null && "raw" in obj) {
    return (obj as Record<string, unknown>).raw as number;
  }
  return undefined;
}

/**
 * The basis every NON-database path reports — MONEY-1300.
 *
 * Yahoo's `quoteSummary` and the Screener chain both return statement figures
 * with no statement of whose accounts they are. "UNKNOWN" is stamped rather
 * than left absent so the field is ALWAYS present on the wire: an absent key is
 * one `?? "Consolidated"` away from a confident wrong label downstream, and for
 * a holding company that label is attached to a number off by a multiple.
 */
const UNSTATED_BASIS = "UNKNOWN" as const;

export function mapCashFlow(items: unknown[]): FinancialStatement[] {
  return items.map((item) => {
    const stmt = item as Record<string, unknown>;
    const operatingCashFlow = extractRaw(stmt.totalCashFromOperatingActivities);
    const capitalExpenditure = extractRaw(stmt.capitalExpenditures);
    const fcf =
      operatingCashFlow != null && capitalExpenditure != null
        ? operatingCashFlow + capitalExpenditure // capex is negative
        : undefined;

    return {
      period:
        ((stmt.endDate as Record<string, unknown>)?.fmt as string) || "Unknown",
      endDate: ((stmt.endDate as Record<string, unknown>)?.raw as string) || "",
      // Yahoo does not report a basis. Say so rather than let the field vanish.
      basis: UNSTATED_BASIS,
      operatingCashFlow,
      capitalExpenditure,
      freeCashFlow: fcf,
      // MONEY-613: depreciation feeds the Beneish M-Score DEPI term.
      depreciation: extractRaw(stmt.depreciation),
    };
  });
}

/**
 * The Tickertape/Screener fallback rows, mapped for BOTH the persist and the
 * tool's own response — MONEY-1205.
 *
 * `fetchFinancialsChain` returns Tickertape's rows VERBATIM (`displayPeriod`,
 * `incTrev`, `balTota`, `cafCfoa`, …). This file used to cast them straight to
 * `FinancialStatement[]` and read `s.period` / `s.revenue` / `s.totalAssets` /
 * `s.operatingCashFlow` off them — none of which exist on that shape. Every
 * field came back `undefined`, so:
 *
 *   - the persist got `{period: undefined, …: null}` rows, and
 *     `if (!row.period) continue` dropped every one. The B6 cache this block
 *     exists to fill has never received a row.
 *   - the tool ALSO returned those raw rows to the executor as `annual`, so the
 *     compute tools (growth, earnings quality) silently no-op'd on them and the
 *     model was handed key names no prompt describes.
 *
 * Both halves are fixed by mapping once, here, with the shared mapper.
 * `statements` is the mapped result minus `period`/`periodEnd`, which the
 * persist takes separately; `rawData` still carries the untouched payload.
 */
function mapChainRows(
  rows: unknown[],
): Array<{ mapped: MappedTickertapeStatement; raw: Record<string, unknown> }> {
  const out: Array<{
    mapped: MappedTickertapeStatement;
    raw: Record<string, unknown>;
  }> = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const raw = r as Record<string, unknown>;
    const mapped = mapTickertapeStatementRow("CASH_FLOW", raw, "ANNUAL");
    if (mapped) out.push({ mapped, raw });
  }
  return out;
}

/** Mapped rows as the tool's `FinancialStatement[]` response shape. */
function toToolStatements(
  mapped: Array<{ mapped: MappedTickertapeStatement }>,
): FinancialStatement[] {
  return mapped.map(({ mapped: m }) => {
    const { period, periodEnd, ...columns } = m;
    return {
      period,
      endDate: periodEnd ? periodEnd.toISOString() : period,
      // The Screener chain carries no basis either — MONEY-1300.
      basis: UNSTATED_BASIS,
      ...columns,
    } as unknown as FinancialStatement;
  });
}

export const fetchCashFlowTool: ResearchToolDef = {
  name: "fetch_cash_flow",
  description:
    "Fetch cash flow statement history (annual and/or quarterly). Every row " +
    "carries `basis` (CONSOLIDATED | STANDALONE | UNKNOWN) — an Indian " +
    "company files both and they can differ by a multiple, so never state a " +
    "figure without its basis.",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance symbol",
      required: true,
    },
    quarterly: {
      type: "boolean",
      description: "Include quarterly data",
      default: false,
    },
  },
  cacheTTL: 21600, // 6h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    const quarterly = params.quarterly as boolean;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      // DB-first (MONEY-614): serve the synced StockFinancials (Tickertape) when
      // present; fall through to the live Yahoo path for un-synced symbols.
      //
      // MONEY-1274 — the short-circuit must be able to answer the question that
      // was actually ASKED. `stock_financials` holds ZERO rows of periodType
      // QUARTERLY (measured 2026-08-28), so `dbQ` is empty for every symbol.
      // Returning here on the ANNUAL rows alone skipped the Yahoo call below —
      // the one source carrying `cashflowStatementHistoryQuarterly` — and
      // returned `success: true` with no `quarterly` key, which the model reads
      // as "no quarterly figures exist" instead of "nobody asked anyone who has
      // them". See fetch-income-statement.ts for the full note.
      const { getDbFirstStatements } = await import("../data-sources/db-store");
      const dbAnnual = await getDbFirstStatements(symbol);
      const dbCashAnnual = dbAnnual?.cashFlow ?? [];
      // The quarterly read is skipped unless the annual half already passed.
      // `dbFirstSatisfiesRequest` returns false on an empty annual whatever the
      // quarterly count is, so fetching it first was a round-trip whose result
      // was then discarded — and `stock_financials` is measured to hold ZERO
      // quarterly rows, so it returned empty every time.
      const dbQ =
        quarterly && dbCashAnnual.length > 0
          ? await getDbFirstStatements(symbol, undefined, "QUARTERLY")
          : null;
      const dbCashQuarterly = dbQ?.cashFlow ?? [];

      // Satisfied only when the DB covers every period the caller requested.
      if (
        dbFirstSatisfiesRequest({
          annualUsable: dbCashAnnual.length > 0,
          quarterlyCount: dbCashQuarterly.length,
          quarterlyRequested: quarterly,
        })
      ) {
        const out: Record<string, FinancialStatement[]> = {
          annual: dbCashAnnual,
        };
        if (quarterly) out.quarterly = dbCashQuarterly;
        return {
          success: true,
          data: out,
          metadata: {
            source: dbAnnual?.source,
            dbFirst: true,
            // MONEY-1300 — the basis across the rows actually returned, beside
            // the source. `source` says who produced the figure; this says
            // whose accounts it describes, and for a holding company that is
            // the difference between 19,768 Cr and 7,332 Cr. Per-period detail
            // stays on each row; "MIXED" here means the periods disagree, which
            // is reachable mid-drain (the projection rewrites recent periods
            // while older ones keep whatever the vendor left).
            basis: summariseStockFinancialsBasis([
              ...(out.annual ?? []),
              ...(out.quarterly ?? []),
            ]) satisfies StockFinancialsBasisSummary,
          },
        };
      }

      const modules = ["cashflowStatementHistory"];
      if (quarterly) modules.push("cashflowStatementHistoryQuarterly");

      const data = await withExchangeFallback(symbol, (s) =>
        yahooFetchQuoteSummary(s, modules),
      );

      if (data) {
        const result: Record<string, FinancialStatement[]> = {};

        const annual = data.cashflowStatementHistory as
          | Record<string, unknown>
          | undefined;
        if (annual?.cashflowStatements) {
          result.annual = mapCashFlow(annual.cashflowStatements as unknown[]);
        }

        if (quarterly) {
          const q = data.cashflowStatementHistoryQuarterly as
            | Record<string, unknown>
            | undefined;
          if (q?.cashflowStatements) {
            result.quarterly = mapCashFlow(q.cashflowStatements as unknown[]);
          }
        }

        // MONEY-1274 — we only came down this path for the QUARTERLY half, so
        // keep the DB's annual: FINANCIALS_AUTHORITY ranks TICKERTAPE above
        // YAHOO, and swapping in the lower-authority figures would be a silent
        // downgrade of data we already held.
        if (dbCashAnnual.length > 0) result.annual = dbCashAnnual;

        if (result.annual?.length || result.quarterly?.length) {
          return { success: true, data: result };
        }
      }

      // Yahoo returned no/empty data - try Tickertape → Screener fallback
      const { result: chainResult, outcome: chainOutcome } =
        await fetchFinancialsChainDetailed(symbol);
      if (chainResult) {
        // Normalize chain shape into { annual: FinancialStatement[] } so the
        // executor's compute_dcf / compute_cash_flow_quality dependency
        // injection (`annual[annual.length - 1].operatingCashFlow` etc.)
        // works for fallback data the same way it does for Yahoo data.
        const ttCashflow = (chainResult.data as { cashFlow?: unknown[] })
          .cashFlow;
        const chainRows = Array.isArray(ttCashflow)
          ? mapChainRows(ttCashflow as unknown[])
          : [];
        const annual = toToolStatements(chainRows);

        // B6 fix (MONEY-218-followup): persist fallback rows so the
        // next run hits StockFinancials cache.
        if (annual.length > 0) {
          persistFinancialFallbackInBackground({
            symbol,
            statementType: "CASH_FLOW",
            periodType: "ANNUAL",
            source: chainResult.source.toUpperCase() as
              | "TICKERTAPE"
              | "SCREENER",
            statements: chainRows.map(({ mapped, raw }) => ({
              ...mapped,
              // MONEY-1205 — THIS row's payload. Passing the whole `ttCashflow`
              // array wrote the same history onto every period row, which is
              // what made them unreadable to the rawData backfill.
              raw,
            })),
          });
        }

        // MONEY-1274 — only report success when the chain actually PRODUCED
        // rows. This returned unconditionally, and `annual` is empty on every
        // real run: the chain is Screener-only since MONEY-1220, and
        // `ScreenerFinancialData` has `annualRevenue` / `annualProfit` /
        // `annualRoe` and NO `income` / `balanceSheet` / `cashFlow` array — so
        // the key read below is always `undefined` and maps to zero rows.
        //
        // The result was `success: true` with an EMPTY statement list, which
        // the model reads as "this company has no statements". Worse, it
        // returned BEFORE the DB-annual fallback and `describeUnavailable`
        // added in this same ticket, so it silently preempted both.
        // MONEY-1274 — same empty-success as the happy path above; see the
        // note there. Fall through to the error rather than reporting a
        // successful fetch of nothing.
        if (annual.length > 0) {
          return {
            success: true,
            data: { annual },
            metadata: { source: chainResult.source, fallback: true },
          };
        }
      }

      // MONEY-1274 — falling through for the quarterly half must never cost the
      // caller the annual rows the DB already had: before this, ASKING FOR
      // QUARTERLY made the annual disappear too. Report the annual, and mark
      // the quarterly genuinely unavailable rather than merely unqueried.
      if (dbCashAnnual.length > 0) {
        return {
          success: true,
          data: { annual: dbCashAnnual },
          metadata: {
            source: dbAnnual?.source,
            dbFirst: true,
            ...(quarterly ? { quarterlyUnavailable: true } : {}),
          },
        };
      }

      // MONEY-1274 (Bug 2) — an outage must not be reported as a fact about
      // the company. See unavailable.ts.
      return describeUnavailable("a cash flow statement", symbol, chainOutcome);
    } catch (error) {
      try {
        const chainResult = await fetchFinancialsChain(symbol);
        if (chainResult) {
          const ttCashflow = (chainResult.data as { cashFlow?: unknown[] })
            .cashFlow;
          const chainRows = Array.isArray(ttCashflow)
            ? mapChainRows(ttCashflow as unknown[])
            : [];
          const annual = toToolStatements(chainRows);

          // MONEY-239 F: catch-block persist (mirror of happy-path).
          if (annual.length > 0) {
            persistFinancialFallbackInBackground({
              symbol,
              statementType: "CASH_FLOW",
              periodType: "ANNUAL",
              source: chainResult.source.toUpperCase() as
                | "TICKERTAPE"
                | "SCREENER",
              statements: chainRows.map(({ mapped, raw }) => ({
                ...mapped,
                // MONEY-1205 — THIS row's payload. Passing the whole
                // `ttCashflow` array wrote the same history onto every period
                // row, which is what made them unreadable to the
                // rawData backfill.
                raw,
              })),
            });
          }

          return {
            success: true,
            data: { annual },
            metadata: { source: chainResult.source, fallback: true },
          };
        }
      } catch {
        // Chain also failed
      }

      return {
        success: false,
        error: `Failed to fetch cash flow: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
