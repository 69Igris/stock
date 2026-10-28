/**
 * Fetch Funds Holding — "which mutual funds hold X" (MONEY-1204 / 14e.2).
 *
 * Reads `MfPortfolioHolding`, the SEBI-mandated monthly portfolio disclosures.
 *
 * ## There is NO `symbol` column
 *
 * The AMC files carry the holding's ISIN and its printed name and nothing else.
 * So this tool resolves the caller's symbol to an ISIN through
 * `InstrumentMapping` and queries `@@index([isin, period desc])` — which is the
 * index that exists precisely for this question. `instrumentId` is the
 * secondary path and is NULLABLE by design (an unmatched holding is still a
 * real holding, and dropping it would make the weights fail to sum to 100).
 *
 * ## Absence rules that matter here
 *
 *   * `marketValue` is in ₹ LAKH — the AMCs' own unit, spelled "Lakhs" by SBI
 *     and "Lacs" by the others — and is returned UNCONVERTED under a
 *     unit-carrying name.
 *   * `quantity` is null for cash-equivalent lines, which have none.
 *   * Coverage is 3 of the top-5 AMCs. ABSL and Kotak are deliberately NOT
 *     fetched: their URLs are unproven, and a guessed URL 404s identically to
 *     "not published yet". Nippon keeps only the CURRENT month. An empty result
 *     therefore says so in `provenance.note` rather than implying no fund holds
 *     the stock.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type {
  CitedRows,
  FundHoldingRow,
} from "../data-sources/market-structure-logic";

/**
 * Separator for the composite `(amc, scheme)` rollup key.
 *
 * A NUL cannot occur in an AMC name or a scheme key, so it is unambiguous —
 * but it is written as the ESCAPE `\u0000`, never as a literal byte. git
 * classifies a blob as BINARY on finding a NUL in its first 8000 bytes, and a
 * binary blob has NO diff: `git diff`, `gh pr diff` and every review tool print
 * `Bin 0 -> N bytes` instead of the change, so the file silently stops being
 * reviewable.
 */
const KEY_SEP = "\u0000";

export interface FundHoldingsByScheme {
  amc: string;
  schemeName: string;
  schemeKey: string;
  period: string;
  quantity: number | null;
  marketValueLakh: number | null;
  percentToNav: number | null;
}

/**
 * Newest disclosure per scheme, sorted by conviction (% of NAV) descending.
 *
 * Newest-per-scheme rather than every month, because "which funds hold X" is a
 * present-tense question and a scheme's twelve monthly rows would swamp the
 * answer. A null `percentToNav` sorts LAST rather than as 0 — not reported is
 * not the same as a zero-weight position.
 */
export function rollupBySchemeLatest(
  rows: readonly FundHoldingRow[],
): FundHoldingsByScheme[] {
  const best = new Map<string, FundHoldingRow>();
  for (const r of rows) {
    const key = `${r.amc}${KEY_SEP}${r.schemeKey || r.schemeName}`;
    const prev = best.get(key);
    if (!prev || r.period > prev.period) best.set(key, r);
  }
  return [...best.values()]
    .map((r) => ({
      amc: r.amc,
      schemeName: r.schemeName,
      schemeKey: r.schemeKey,
      period: r.period,
      quantity: r.quantity,
      marketValueLakh: r.marketValueLakh,
      percentToNav: r.percentToNav,
    }))
    .sort((a, b) => {
      const av = a.percentToNav;
      const bv = b.percentToNav;
      if (av === null && bv === null)
        return a.schemeName.localeCompare(b.schemeName);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
}

/** Aggregate exposure across the schemes returned. */
export function totalExposure(schemes: readonly FundHoldingsByScheme[]): {
  schemes: number;
  totalMarketValueLakh: number | null;
} {
  let total = 0;
  let saw = false;
  for (const s of schemes) {
    if (s.marketValueLakh === null) continue;
    total += s.marketValueLakh;
    saw = true;
  }
  // Null, not 0, when no scheme reported a value — the difference between "no
  // fund reported a rupee figure" and "the funds hold ₹0 of it".
  return {
    schemes: schemes.length,
    totalMarketValueLakh: saw ? Math.round(total * 100) / 100 : null,
  };
}

export const fetchFundsHoldingTool: ResearchToolDef = {
  name: "fetch_funds_holding",
  description:
    "Find which mutual-fund schemes hold a given stock, from the AMCs' monthly SEBI portfolio disclosures (MfPortfolioHolding). Queried by ISIN - that table has no symbol column.",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description:
        "NSE symbol (e.g., RELIANCE). Resolved to an ISIN before querying.",
      required: false,
    },
    isin: {
      type: "string",
      description:
        "ISIN to look up directly. Preferred when known - it is the file's own identifier.",
      required: false,
    },
    months: {
      type: "number",
      description: "Lookback in months (default: 6, max: 36)",
      required: false,
      default: 6,
    },
  },
  cacheTTL: 86_400,
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string" && params.symbol.trim()
        ? params.symbol
            .replace(/\.(NS|BO)$/i, "")
            .trim()
            .toUpperCase()
        : null;
    const providedIsin =
      typeof params.isin === "string" && params.isin.trim()
        ? params.isin.trim().toUpperCase()
        : null;

    if (!symbol && !providedIsin) {
      return { success: false, error: "symbol or isin is required" };
    }

    const months = Math.min(Math.max((params.months as number) || 6, 1), 36);

    // Lazy import inside the call — see the MONEY-1060 note in
    // fetch-fii-dii-flows.ts.
    const { getFundsHoldingFromDb, resolveIsins } =
      await import("../data-sources/market-structure-store");

    let isin = providedIsin;
    if (!isin && symbol) {
      isin = (await resolveIsins([symbol]))[0] ?? null;
    }

    const cited: CitedRows<FundHoldingRow> = await getFundsHoldingFromDb({
      isin,
      months,
    });

    const schemes = rollupBySchemeLatest(cited.rows);
    const totals = totalExposure(schemes);

    return {
      success: true,
      data: {
        symbol,
        isin,
        rows: schemes,
        asOf: cited.asOf,
        provenance: cited.provenance,
        ...totals,
      },
      metadata: {
        symbol,
        isin,
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        months,
        recordCount: schemes.length,
        ...(cited.provenance.note ? { note: cited.provenance.note } : {}),
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};
