/**
 * Fetch Stock Flags — `StockFlag` current state per kind (MONEY-1204 / 14e.2).
 *
 * "Is this stock under surveillance, in an F&O ban, on a narrowed price band —
 * and since when?"
 *
 * ## The one thing this tool must not do
 *
 * `StockFlag` carries NO `@@unique`, deliberately: a 40-day GSM stint is 40
 * rows and the RUN LENGTH is the datum. So `rows.some(r => r.kind === "FO_BAN")`
 * — the obvious query — reports a ban that lifted in January as current in
 * August. "Current" is the NEWEST row per kind, judged against the newest day
 * that kind was published MARKET-WIDE, and the store does exactly that.
 *
 * ## Surveillance codes are returned VERBATIM
 *
 * `raw` is what NSE wrote (`"GSM STAGE - I"`, `"Long Term ASM - Stage IV"`).
 * The framework/stage decode is applied HERE, at render, so a wording NSE
 * invents next month survives in the table and a better decode can re-read rows
 * written years ago. An unrecognised code returns `framework: null` beside its
 * intact `raw` — never a guessed framework, because a precise mapping without a
 * catch-all shrinks coverage the moment the exchange adds a stage.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type {
  CitedRows,
  StockFlagRowOut,
} from "../data-sources/market-structure-logic";

/** Split current from ended flags. Both are useful; conflating them is not. */
export function partitionFlags(rows: readonly StockFlagRowOut[]): {
  current: StockFlagRowOut[];
  ended: StockFlagRowOut[];
} {
  const current: StockFlagRowOut[] = [];
  const ended: StockFlagRowOut[] = [];
  for (const r of rows) (r.isCurrent ? current : ended).push(r);
  return { current, ended };
}

/** One-line read of the current state, for the synthesizer to quote. */
export function describeFlags(rows: readonly StockFlagRowOut[]): string {
  const { current } = partitionFlags(rows);
  if (current.length === 0) {
    return "No surveillance, price-band or F&O-ban flag is currently in force.";
  }
  return current
    .map((r) => {
      const since = r.since.slice(0, 10);
      const bound = r.runReachesWindowEdge ? "at least since" : "since";
      return `${r.label} (${bound} ${since}, ${r.observedSessions} session${r.observedSessions === 1 ? "" : "s"} observed)`;
    })
    .join("; ");
}

export const fetchStockFlagsTool: ResearchToolDef = {
  name: "fetch_stock_flags",
  description:
    "Fetch a stock's CURRENT surveillance (ASM/GSM/ESM), price-band, F&O-ban, series-change and 52-week flags from StockFlag, with the run length and start date for each",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE symbol (e.g., RELIANCE)",
      required: true,
    },
    exchange: {
      type: "string",
      description: "Exchange (default: NSE)",
      required: false,
    },
    days: {
      type: "number",
      description:
        "Lookback window in days (default: 120). A run that fills the window reports `runReachesWindowEdge`, so `since` reads as a lower bound.",
      required: false,
      default: 120,
    },
    includeEnded: {
      type: "boolean",
      description:
        "Also return flags whose newest row predates the kind's latest market-wide publication (i.e. flags that have ENDED)",
      required: false,
      default: false,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = String(params.symbol ?? "")
      .replace(/\.(NS|BO)$/i, "")
      .toUpperCase();
    if (!symbol) return { success: false, error: "symbol is required" };

    const days = Math.min(Math.max((params.days as number) || 120, 1), 730);
    const exchange =
      typeof params.exchange === "string" && params.exchange.trim()
        ? params.exchange.trim()
        : undefined;

    // Lazy import inside the call — `market-structure-store` pulls in
    // `@usemoney/database`, which instantiates PrismaClient at module scope.
    const { getStockFlagsFromDb } =
      await import("../data-sources/market-structure-store");
    const cited: CitedRows<StockFlagRowOut> = await getStockFlagsFromDb({
      symbol,
      exchange,
      days,
    });

    const { current, ended } = partitionFlags(cited.rows);
    const rows = params.includeEnded === true ? cited.rows : current;

    return {
      success: true,
      data: {
        symbol,
        rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
        currentCount: current.length,
        endedCount: ended.length,
        summary: describeFlags(cited.rows),
      },
      metadata: {
        symbol,
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        days,
        recordCount: rows.length,
        ...(cited.provenance.note ? { note: cited.provenance.note } : {}),
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};
