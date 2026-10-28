/**
 * `fetch_us_financials` — US company financials from SEC EDGAR (MONEY-979, T10).
 *
 * DB-ONLY. Every row was written by `services/us-fundamentals/` out of our own
 * archive of SEC bytes; this tool issues no request to `sec.gov` and never
 * falls back to a scrape. There is nothing to fall back TO — Yahoo's
 * quoteSummary and Tickertape are India paths, and Tickertape 403s our
 * production egress anyway.
 *
 * ## US-ONLY, on purpose
 *
 * This tool does not route. `fetch_income_statement` / `fetch_balance_sheet` /
 * `fetch_cash_flow` keep their India path untouched, and teaching them to
 * dispatch on venue is a SEPARATE change (see the router note at the bottom of
 * this file). Shipping the US path as its own tool first means the India path
 * cannot regress while the US one is being proven.
 *
 * ## The output shape is deliberate
 *
 * `{ annual: FinancialStatement[] }` — the SAME key and the SAME row shape the
 * three existing fetch tools emit, because `input-bindings.ts` reads
 * `dep.result.annual[last].<field>` by name. A US-shaped payload with its own
 * key names would be invisible to every compute tool downstream, which is
 * exactly what happened in MONEY-1205 when raw Tickertape rows were passed
 * through unmapped: the compute tools silently no-op'd and the model was handed
 * key names no prompt describes.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { FinancialStatement } from "../types";

/* ─────────────────────────────────────────────────────────────────────────
   Shared helpers for the four US tools
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The envelope every `@usemoney/core/us-fundamentals` read returns, restated
 * STRUCTURALLY.
 *
 * Declared here rather than imported as a type so these tools can be exercised
 * by a test with plain objects, and so the four of them agree on one shape.
 * The real type is `UsReadResult<T>` in
 * `packages/core/src/us-fundamentals/types.ts`; a drift between the two is a
 * compile error at the call site in `execute`, not a silent mismatch.
 */
export interface UsToolResult<T> {
  rows: T[];
  asOf: string | null;
  currency: "USD";
  origin: string;
  reason: string | null;
  degraded: boolean;
}

/** The source tag every US tool cites. One spelling, one place. */
export const US_TOOL_SOURCE = "SEC_EDGAR";

/**
 * The repository's named reasons, spelled for a reader.
 *
 * A `dataGap` string is what stops an empty result reading as "this company has
 * no insiders". Each reason is a DIFFERENT fact and each gets a different
 * sentence — collapsing them into "no data" is the failure this whole seam is
 * built to avoid.
 *
 * ## Not every reason means the result is EMPTY
 *
 * Three of these ride on a POPULATED payload — `HOLDER_SET_TRUNCATED`,
 * `INSIDER_WINDOW_TRUNCATED` and `AMBIGUOUS_13F_AMENDMENT_TYPE` — and for those
 * the catch-all's "No data: X." was not merely unhelpful, it was FALSE: it
 * appeared beside a holders array and beside a signed `netOpenMarketShares`.
 * A truncation sentence must therefore say which DERIVED field is unsafe, not
 * that nothing came back. `us-tools.test.ts` pins that every reason exported by
 * `@usemoney/core/us-fundamentals` has an entry here, so a fifteenth reason
 * cannot ship without a sentence.
 */
export const US_GAP_EXPLANATIONS: Readonly<Record<string, string>> = {
  NO_IDENTIFIER_SUPPLIED:
    "No symbol or CIK was supplied, so nothing was queried.",
  SYMBOL_NOT_IN_US_UNIVERSE:
    "This symbol matches no active US listing in our security master. It may be an Indian symbol (use the India tools), a delisted ticker, or a spelling we do not carry.",
  SYMBOL_HAS_NO_SEC_CIK:
    "This symbol is a US listing but no SEC CIK has been joined onto it yet, so no EDGAR filings can be located for it. ~14% of active US listings are in this state.",
  CIK10_MALFORMED:
    "The CIK supplied is not a valid 1-10 digit SEC Central Index Key.",
  NO_ROWS_FOR_QUERY:
    "We hold no rows matching this query. The filer is known to us; this period, statement or form is not yet ingested.",
  REQUESTED_PERIOD_HAS_NO_ROWS:
    "We hold NO rows for the period asked about while an earlier period IS populated, so the quarter-on-quarter comparison was refused rather than computed. Do NOT read this as every holder having sold: two ordinary causes produce it — 13Fs are due 45 days after quarter end, so the period may simply not be filed or ingested yet, and the period is matched by EXACT timestamp equality, so an asOf/period argument carrying a time or a timezone offset misses the current period while still finding the prior one. Re-ask with a plain date (YYYY-MM-DD) before concluding anything about the data.",
  NO_13F_FILING_FOR_PERIOD:
    "No 13F-HR was filed by this manager for that report period.",
  NO_PRIOR_13F_PERIOD:
    "This is the earliest 13F period we hold for this issuer, so every holder shows as new and no quarter-on-quarter change could be computed.",
  COLD_SHARD_READ_FAILED:
    "Part of this answer lives in archived (cold) storage and that read FAILED. The rows shown are a SUBSET, not the whole portfolio — do not treat a missing position as a sale.",
  COLD_SHARD_ABSENT:
    "The filing is marked archived but its cold shard was not found. The rows shown are a SUBSET, not the whole portfolio.",
  COLD_STORE_NOT_REGISTERED:
    "Part of this answer lives in archived (cold) storage and no archive backend is configured in this environment. The rows shown are a SUBSET.",
  AMBIGUOUS_13F_AMENDMENT_TYPE:
    "An amendment to this 13F does not say whether it RESTATES or ADDS to the original. It was treated as additive, so the portfolio may be over-counted.",
  HOLDER_SET_TRUNCATED:
    "The holders shown are REAL, but the holder set was capped before the quarter-on-quarter diff, so one side of the comparison is missing rows the other side has. Every `isNew` and every `isExited` flag in this result is therefore UNSAFE and the `exits` list is not a list of sellers — a manager who merely fell past the cap between the two quarters is indistinguishable here from one who liquidated. Quote the positions; do not quote the changes.",
  INSIDER_WINDOW_TRUNCATED:
    "The transactions shown are REAL, but the window held more rows than one read may load, so the SUMMARY was computed over a subset of the window rather than the window. `netOpenMarketShares` and every per-class total are understated by an unknown amount and must not be quoted as the period's totals or compared against another period. Narrow `windowDays` to get a summary that covers what it claims to.",
};

/** A reason code → the sentence that goes in `metadata.dataGap`. */
export function explainUsGap(
  reason: string | null | undefined,
): string | undefined {
  if (!reason) return undefined;
  return US_GAP_EXPLANATIONS[reason] ?? `No data: ${reason}.`;
}

/**
 * The metadata block every US tool ships.
 *
 * `asOf` is the newest ROW's own date, never the fetch time — a fetch time here
 * would make a five-month-stale table look fresh, which is exactly how the
 * Tickertape block hid for five months (MONEY-1220).
 */
export function usToolMetadata<T>(
  result: UsToolResult<T>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const gap = explainUsGap(result.reason);
  return {
    source: US_TOOL_SOURCE,
    origin: result.origin,
    currency: result.currency,
    asOf: result.asOf,
    recordCount: result.rows.length,
    dbOnly: true,
    ...(result.degraded ? { degraded: true } : {}),
    ...(gap ? { dataGap: gap, reason: result.reason } : {}),
    ...extra,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   fetch_us_financials
   ──────────────────────────────────────────────────────────────────────── */

const STATEMENT_ALIASES: Readonly<Record<string, string>> = {
  income: "INCOME",
  "income statement": "INCOME",
  "profit and loss": "INCOME",
  pnl: "INCOME",
  INCOME: "INCOME",
  balance: "BALANCE_SHEET",
  "balance sheet": "BALANCE_SHEET",
  balancesheet: "BALANCE_SHEET",
  BALANCE_SHEET: "BALANCE_SHEET",
  cash: "CASH_FLOW",
  "cash flow": "CASH_FLOW",
  cashflow: "CASH_FLOW",
  CASH_FLOW: "CASH_FLOW",
};

/** A planner's spelling of a statement name → the writer's. */
export function normalizeUsStatementType(value: unknown): string {
  const key = String(value ?? "INCOME").trim();
  return (
    STATEMENT_ALIASES[key] ??
    STATEMENT_ALIASES[key.toLowerCase()] ??
    STATEMENT_ALIASES[key.toUpperCase()] ??
    "INCOME"
  );
}

/**
 * Fields of `FinancialStatement` that a SEC filing structurally cannot supply.
 *
 * Shipped in the metadata so the model states the ABSENCE rather than quoting a
 * number nobody filed. `ebitda` is not a GAAP concept and appears in no
 * taxonomy; it could be approximated as operating income plus D&A, and this
 * repo has decided against exactly that kind of compensating — if a writer
 * cannot fill a column it drops the column and says so.
 */
export const US_FIELDS_NOT_FILED = ["ebitda"] as const;

/**
 * The pure half: a repository result → a `ToolOutput`.
 *
 * Separated so a test can drive the REAL output shape (and the REAL gap
 * explanation) with plain objects and no database.
 */
export function buildUsFinancialsOutput(args: {
  symbol: string;
  statementType: string;
  annual: UsToolResult<Record<string, unknown>>;
  quarterly?: UsToolResult<Record<string, unknown>> | null;
  asOfRequested?: string | null;
}): ToolOutput {
  const data: Record<string, unknown> = {
    symbol: args.symbol,
    statementType: args.statementType,
    annual: args.annual.rows as unknown as FinancialStatement[],
    asOf: args.annual.asOf,
    currency: "USD",
    notReported: [...US_FIELDS_NOT_FILED],
    note: "Amounts are US DOLLARS, not rupees. EBITDA is not filed with the SEC and is deliberately absent rather than derived.",
  };
  if (args.quarterly) {
    data.quarterly = args.quarterly.rows as unknown as FinancialStatement[];
  }

  return {
    success: true,
    data,
    metadata: usToolMetadata(args.annual, {
      symbol: args.symbol,
      statementType: args.statementType,
      asOfRequested: args.asOfRequested ?? null,
      pointInTime: Boolean(args.asOfRequested),
      ...(args.quarterly ? { quarterlyCount: args.quarterly.rows.length } : {}),
    }),
  };
}

export const fetchUsFinancialsTool: ResearchToolDef = {
  name: "fetch_us_financials",
  description:
    "Fetch US company financial statements (income, balance sheet, cash flow) from SEC EDGAR filings. US symbols only - amounts are in USD. Supports point-in-time reads via asOf (what was filed as of that date, not what was later restated).",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description:
        "US ticker, e.g. AAPL or BRK-B (BRK/B and BRK.B are accepted)",
      required: true,
    },
    statement: {
      type: "string",
      description: "income | balance | cash (default: income)",
      required: false,
      default: "income",
    },
    quarterly: {
      type: "boolean",
      description: "Also return quarterly periods",
      required: false,
      default: false,
    },
    asOf: {
      type: "string",
      description:
        "ISO date. Returns each period AS IT WAS FILED on that date, ignoring later restatements. Omit for the current view.",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum periods to return (default: 8)",
      required: false,
      default: 8,
    },
  },
  cacheTTL: 21600, // 6h — filings do not change; restatements arrive as new rows.
  execute: async (params): Promise<ToolOutput> => {
    const symbol = String(params.symbol ?? "").trim();
    if (!symbol) return { success: false, error: "symbol is required" };

    const statementType = normalizeUsStatementType(params.statement);
    const asOf = params.asOf ? String(params.asOf) : null;
    const limit = Number(params.limit) > 0 ? Number(params.limit) : 8;

    // Lazy import: the repository pulls in Prisma at module scope, and a data
    // tool must not drag the client into every bundle that merely enumerates
    // the registry. Same reason as the MONEY-1060 note in fetch-fii-dii-flows.
    const { getStatementsAsFinancialStatements } =
      await import("@usemoney/core/us-fundamentals");

    const annual = await getStatementsAsFinancialStatements({
      symbol,
      statementType: statementType as "INCOME" | "BALANCE_SHEET" | "CASH_FLOW",
      periodType: "ANNUAL",
      asOf,
      limit,
    });

    const quarterly = params.quarterly
      ? await getStatementsAsFinancialStatements({
          symbol,
          statementType: statementType as
            | "INCOME"
            | "BALANCE_SHEET"
            | "CASH_FLOW",
          periodType: "QUARTERLY",
          asOf,
          limit,
        })
      : null;

    return buildUsFinancialsOutput({
      symbol,
      statementType,
      annual: annual as unknown as UsToolResult<Record<string, unknown>>,
      quarterly: quarterly as unknown as UsToolResult<
        Record<string, unknown>
      > | null,
      asOfRequested: asOf,
    });
  },
};

/* ─────────────────────────────────────────────────────────────────────────
   NOTE FOR THE LATER INDIA/US ROUTER (deliberately NOT done here)
   ──────────────────────────────────────────────────────────────────────────

   Teaching `fetch_income_statement` / `fetch_balance_sheet` / `fetch_cash_flow`
   to dispatch on venue is a separate change. What it has to touch, exactly:

     1. A venue decision at the top of each `execute`. `resolveInstrument`
        already returns "US" for the 8 US venues
        (`resolve-instrument-logic.ts:295`), so the rule is: a symbol ending
        `.NS`/`.BO`, or one that resolves to an NSE/BSE instrument, keeps the
        existing path; a symbol that resolves to a US venue goes to
        `getStatementsAsFinancialStatements`. A symbol that resolves to NEITHER
        must keep today's behaviour rather than becoming a US miss.
     2. `statementType` per tool — INCOME / BALANCE_SHEET / CASH_FLOW — and the
        `quarterly` flag those tools already accept.
     3. The US branch must return BEFORE `getDbFirstStatements`, before the
        Yahoo `quoteSummary` call and before `fetchFinancialsChain`. A US symbol
        must produce ZERO Yahoo and ZERO Tickertape/Screener requests; that is
        the assertion the router's test needs (a mocked fetcher, asserted at
        zero calls), not merely "the right rows came back".
     4. `persistFinancialFallbackInBackground` must NOT run on the US branch. It
        writes `StockFinancials`, which is the INDIA table, keyed on
        `instrumentId` — a US row there would be a rupee-denominated ghost.
     5. The currency. Everything downstream of these three tools renders `₹`
        from a hardcoded symbol. Until MONEY-982 (dual-denomination UI) lands, a
        router that silently feeds USD into those renderers produces
        confidently-wrong numbers, which is worse than the tool not existing.
        That is the main reason this ships as its own tool first.
   ────────────────────────────────────────────────────────────────────────── */
