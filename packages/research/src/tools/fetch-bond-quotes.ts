/**
 * Fetch Bond Quotes — `BondEOD` + `BondMaster` (MONEY-1204 / 14e.2).
 *
 * End-of-day price and yield for a debt instrument, joined by ISIN, with the
 * coupon and maturity from the master.
 *
 * ## This table is nearly empty TODAY, and that is the design constraint
 *
 * Both models are new in this branch and the history walk that fills them is
 * founder-gated. So the ONLY acceptable behaviour is an EMPTY CITED RESULT
 * whose `provenance.note` says the coverage is missing — never a thrown tool,
 * and never an empty array that the synthesizer reads as "this bond does not
 * trade". Those are different claims and only one of them is true.
 *
 * ## Three joins that silently match nothing if you get them wrong
 *
 *   * **ISIN normalisation.** `cbm_trd` prints ISINs with a TRAILING SPACE
 *     ("INE261F08EO7 ") while `wdmlist` does not. Ingest normalises
 *     `.trim().toUpperCase()`, and so does this reader.
 *   * **Segment is part of the identity.** The same ISIN can print in CBM and
 *     WDM on the same day at DIFFERENT prices, which is why the unique key is
 *     `[isin, date, segment]`. Every row here carries its segment; collapsing
 *     them is how MONEY-1201 lost 84.2% of open interest to a last-write-wins
 *     upsert.
 *   * **`BondMaster.symbol` is NOT unique.** One issuer reuses a symbol across
 *     series (BOB appears four times on 14-Aug-2026 with four ISINs and four
 *     maturities), so the join is on ISIN and the symbol is display only.
 *
 * A null `maturityDate` is MEANINGFUL, not missing: perpetual instruments
 * genuinely have none, and defaulting it would invent a redemption that will
 * never happen. A null `coupon` likewise — a zero-coupon bond and a coupon we
 * failed to read are different facts, and only one is tradeable information.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type {
  BondQuoteRow,
  CitedRows,
} from "../data-sources/market-structure-logic";

export interface BondLatestQuote extends BondQuoteRow {
  /** Years to maturity at `date`. Null for perpetuals and unknown maturities. */
  yearsToMaturity: number | null;
}

const MS_PER_YEAR = 365.25 * 86_400_000;

/**
 * Newest print per (ISIN, segment).
 *
 * Per SEGMENT, not per ISIN: the two segments are genuinely different markets
 * for the same paper and their prices differ, so collapsing them would make the
 * answer depend on row order. Input must be sorted date-desc (the reader's
 * `orderBy` does that).
 */
export function latestPerIsinSegment(
  rows: readonly BondQuoteRow[],
): BondLatestQuote[] {
  const best = new Map<string, BondQuoteRow>();
  for (const r of rows) {
    const key = `${r.isin} ${r.segment}`;
    const prev = best.get(key);
    if (!prev || r.date > prev.date) best.set(key, r);
  }
  return [...best.values()]
    .map((r) => ({
      ...r,
      yearsToMaturity: yearsToMaturity(r.date, r.maturityDate),
    }))
    .sort((a, b) =>
      a.isin === b.isin
        ? a.segment.localeCompare(b.segment)
        : a.isin.localeCompare(b.isin),
    );
}

export function yearsToMaturity(
  asOf: string,
  maturityDate: string | null,
): number | null {
  if (maturityDate === null) return null;
  const from = new Date(asOf).getTime();
  const to = new Date(maturityDate).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round(((to - from) / MS_PER_YEAR) * 100) / 100;
}

export const fetchBondQuotesTool: ResearchToolDef = {
  name: "fetch_bond_quotes",
  description:
    "Fetch end-of-day price and YTM for a bond from BondEOD, with coupon/maturity/rating from BondMaster, joined by ISIN. Coverage is thin - an empty result is a data gap, not evidence the bond does not trade.",
  category: "data",
  parameters: {
    isin: {
      type: "string",
      description:
        "ISIN of the bond. The only join key - `bond_eod` has no symbol column.",
      required: false,
    },
    symbol: {
      type: "string",
      description:
        "Instrument symbol, resolved to an ISIN via InstrumentMapping. Note one issuer reuses a symbol across series, so an ISIN is far more precise.",
      required: false,
    },
    days: {
      type: "number",
      description:
        "Lookback window in days (default: 180). Wide on purpose: most listed bonds do not print every day.",
      required: false,
      default: 180,
    },
  },
  cacheTTL: 14_400,
  execute: async (params): Promise<ToolOutput> => {
    const isin =
      typeof params.isin === "string" && params.isin.trim()
        ? params.isin.trim().toUpperCase()
        : null;
    const symbol =
      typeof params.symbol === "string" && params.symbol.trim()
        ? params.symbol
            .replace(/\.(NS|BO)$/i, "")
            .trim()
            .toUpperCase()
        : null;

    if (!isin && !symbol) {
      return { success: false, error: "isin or symbol is required" };
    }

    const days = Math.min(Math.max((params.days as number) || 180, 1), 1825);

    // Lazy import inside the call — see the MONEY-1060 note in
    // fetch-fii-dii-flows.ts.
    const { getBondQuotesFromDb, resolveIsins } =
      await import("../data-sources/market-structure-store");

    const isins = isin ? [isin] : symbol ? await resolveIsins([symbol]) : [];

    const cited: CitedRows<BondQuoteRow> = await getBondQuotesFromDb({
      isins,
      days,
    });

    const latest = latestPerIsinSegment(cited.rows);

    return {
      success: true,
      data: {
        isins,
        rows: latest,
        history: cited.rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
      },
      metadata: {
        isins,
        symbol,
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        days,
        recordCount: latest.length,
        ...(cited.provenance.note ? { note: cited.provenance.note } : {}),
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};
