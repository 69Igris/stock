/**
 * `fetch_us_insider_trades` — Forms 3/4/5 from SEC EDGAR (MONEY-979, T10).
 *
 * DB-only, no egress.
 *
 * ## Why the payload is split by CODE CLASS and not netted into one number
 *
 * "Net insider activity" summed across every transaction code is the single
 * most common way this data is misread. An `F` is shares WITHHELD BY THE ISSUER
 * to pay the tax on a vesting grant — the insider does not choose it and does
 * not sell into the market. An `S` is an open-market sale. An `A` is a grant.
 * A `G` is a gift with no price at all. Added together, every routine vesting
 * event becomes "insider selling", and a model handed one aggregate number has
 * no way to notice.
 *
 * So `netOpenMarketShares` is P minus S ONLY, every other class is reported
 * beside it, and the payload carries the code letters that landed in each
 * bucket so the synthesizer can name them.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { usToolMetadata, type UsToolResult } from "./fetch-us-financials";

/** SEC transaction codes worth naming in the tool description. */
export const US_INSIDER_CODE_LEGEND: Readonly<Record<string, string>> = {
  P: "open market or private purchase",
  S: "open market or private sale",
  A: "grant, award or other acquisition from the issuer",
  F: "shares delivered or withheld to pay an exercise price or tax",
  G: "bona fide gift",
  M: "exercise or conversion of an exempt derivative",
  X: "exercise of an in- or at-the-money derivative",
};

/**
 * The pure half: a repository result plus its summary → a `ToolOutput`.
 * Driven directly by the tests, so the shape and the gap text are covered
 * without a database.
 */
export function buildUsInsiderOutput(args: {
  symbol: string;
  windowDays: number;
  result: UsToolResult<Record<string, unknown>>;
  summary: Record<string, unknown>;
}): ToolOutput {
  return {
    success: true,
    data: {
      symbol: args.symbol,
      windowDays: args.windowDays,
      rows: args.result.rows,
      summary: args.summary,
      asOf: args.result.asOf,
      currency: "USD",
      codeLegend: US_INSIDER_CODE_LEGEND,
      note: "Totals are reported BY CODE CLASS. A code F is a tax withholding on vesting, not a decision to sell - it must never be summed with a code S. `netOpenMarketShares` is P minus S only.",
    },
    metadata: usToolMetadata(args.result, {
      symbol: args.symbol,
      windowDays: args.windowDays,
    }),
  };
}

export const fetchUsInsiderTradesTool: ResearchToolDef = {
  name: "fetch_us_insider_trades",
  description:
    "Fetch US insider transactions (SEC Forms 3/4/5) for a symbol, summarised by transaction-code class - open-market buys (P) and sales (S) reported separately from awards (A), tax withholding (F), gifts (G) and exercises (M/X).",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "US ticker, e.g. AAPL",
      required: true,
    },
    windowDays: {
      type: "number",
      description: "Trailing window in days (default: 180, max: 1825)",
      required: false,
      default: 180,
    },
    limit: {
      type: "number",
      description: "Maximum transaction rows to return (default: 200)",
      required: false,
      default: 200,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = String(params.symbol ?? "").trim();
    if (!symbol) return { success: false, error: "symbol is required" };

    const windowDays = Math.min(
      Math.max(Number(params.windowDays) || 180, 1),
      1825,
    );
    const limit = Number(params.limit) > 0 ? Number(params.limit) : 200;

    const { getInsiderActivity } =
      await import("@usemoney/core/us-fundamentals");
    const out = await getInsiderActivity({ symbol, windowDays, limit });

    return buildUsInsiderOutput({
      symbol,
      windowDays,
      result: out as unknown as UsToolResult<Record<string, unknown>>,
      summary: out.summary as unknown as Record<string, unknown>,
    });
  },
};
