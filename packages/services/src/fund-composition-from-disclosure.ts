/**
 * Fund composition built from the AMC's OWN disclosure — MONEY-1405 D4/D5.
 *
 * The panel this feeds used to be served by exactly one thing: `gemini-2.5-pro`
 * at temperature 0.9, asked what it believes a fund holds, with no document in
 * front of it. `buildExtractionPrompt` interpolates three strings we already
 * hold (name, issuer, category) and asks for "the top 15-25 holdings based on
 * the most recent publicly available SEBI portfolio disclosure" — a disclosure
 * it is never given. That is RECALL, not extraction, and it measures like it:
 * on prod 2026-09-13 the 1,800 stored `fund_holdings` rows sum to a p50 of 84%
 * of NAV across 111 funds, 10 of them under 50%.
 *
 * The real thing has been ingested the whole time. `mf_portfolio_holdings` is
 * the SEBI-mandated monthly portfolio statement — 54,248 rows, 662 schemes,
 * with `isin`, `holdingType`, `quantity`, `marketValue` and `percentToNav`
 * straight off the AMC's own workbook. Measured on one scheme that renders
 * today (HDFC NIFTY 50 ETF, 135853, period 2026-07): 52 rows summing to
 * EXACTLY 100.000% — 50 equity lines plus TREPS and Net Current Assets.
 *
 * ## What this module adds, and what it deliberately does not
 *
 * The disclosure carries no sector and no market-cap bucket, which is the only
 * reason the model estimate owned the donuts at all. Both are DERIVABLE from
 * data we already hold and neither needs a vendor:
 *
 *   sector  ISIN -> `InstrumentMapping.sector` (the 13 canonical NSE sectors,
 *           already enriched). Note `InstrumentMapping` has `sector`,
 *           `industry` and `series` and NO market-cap column, so the cap bucket
 *           cannot come from there however much it looks like it should.
 *   cap     index MEMBERSHIP — `index_constituents`, which is keyed by SYMBOL,
 *           so it rides the same ISIN join. NSE's constituent CSVs carry no
 *           weights at all, so membership is a BUCKET and never a weight.
 *
 * ## The rule that matters: an unmatched line is COUNTED
 *
 * Every weight here is a share of NAV, so the donut's denominator is the whole
 * portfolio. Dropping the rows that did not resolve — TREPS, net receivables,
 * an ISIN our master has never seen — does not make the chart cleaner, it
 * silently renormalises every remaining slice upward. So an unresolved line
 * lands in {@link UNCLASSIFIED} and keeps its weight.
 *
 * All the allocation math is {@link ./fund-composition-logic} unchanged
 * (`aggregateByKey`, `coveragePercent`, `normalizeWeightsTo100`): one set of
 * finite guards, exercised by both sources.
 */

import {
  aggregateByKey,
  coveragePercent,
  finite,
  normalizeWeightsTo100,
  round2,
  type AssetSlice,
  type CapSlice,
  type CompositionHolding,
  type NormalizedComposition,
  type SectorSlice,
} from "./fund-composition-logic";

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * WHICH of the two sources produced a composition. Carried on the returned data
 * and rendered, because the two are not interchangeable: one is the filing, the
 * other is a third-party model's recollection of one. Mirrors the
 * `FundCompositionSource` enum on `FundCompositionMeta`.
 */
export type CompositionSource = "AMC_DISCLOSURE" | "GEMINI_RECALL";

/** A composition plus the provenance a reader is entitled to. */
export interface SourcedComposition extends NormalizedComposition {
  source: CompositionSource;
}

/**
 * The bucket for a line we could not attribute — an ISIN our instrument master
 * has never seen, a resolved instrument with no sector, or a cash/receivables
 * line that has no ISIN to join on at all.
 *
 * It is a NAMED value and never `null`/absent, for the reason the `basis:
 * "UNKNOWN"` stamp on `stock_financials` exists: a filter written against an
 * absent field matches nothing in BOTH directions and reads as zero rather than
 * as a bug.
 */
export const UNCLASSIFIED = "Unclassified";

/** Sectors stored as a literal "N/A" are an ABSTENTION, not a sector. */
const NON_SECTORS = new Set(["", "N/A", "NA", "UNKNOWN", "OTHER"]);

// ---------------------------------------------------------------------------
// Market-cap buckets from index membership
// ---------------------------------------------------------------------------

/**
 * The four `IndexConstituent.indexId` values the cap bucket is derived from,
 * in the order a symbol is claimed: the FIRST match wins, so the large-cap
 * indices are checked before the mid and small ones.
 *
 * These are the ids as they exist on prod (measured 2026-09-13: nifty50 50,
 * niftynext50 50, niftymidcap150 150, niftysmallcap250 250 rows). The table
 * holds 17 indices under a vocabulary that is NOT the one `IndexClose` uses
 * ("banknifty" here, "nifty-bank" there), so these strings are checked against
 * the table rather than assumed from a display name.
 */
export const CAP_INDEX_PRIORITY: ReadonlyArray<
  readonly [indexId: string, bucket: CapBucket]
> = [
  ["nifty50", "LARGE"],
  ["niftynext50", "LARGE"],
  ["niftymidcap150", "MID"],
  ["niftysmallcap250", "SMALL"],
];

/** LARGE/MID/SMALL — the only buckets index membership can support. */
export type CapBucket = "LARGE" | "MID" | "SMALL";

/**
 * Symbol -> cap bucket, from index membership.
 *
 * A symbol in two lists (NIFTY 50 is inside NIFTY 100, and the midcap lists
 * overlap at the edges) resolves to the FIRST bucket in
 * {@link CAP_INDEX_PRIORITY}, which is why this walks the priority list rather
 * than the rows. MICRO is deliberately absent: `niftymicrocap250` exists on
 * prod but a micro-cap index member is not a market-cap CLASS a fund fact sheet
 * would recognise, and adding it would put 250 names in a bucket no other
 * surface uses.
 */
export function capBucketsBySymbol(
  rows: ReadonlyArray<{ indexId: string; symbol: string }>,
): Map<string, CapBucket> {
  const out = new Map<string, CapBucket>();
  for (const [indexId, bucket] of CAP_INDEX_PRIORITY) {
    for (const row of rows) {
      if (row?.indexId !== indexId) continue;
      const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
      if (!symbol || out.has(symbol)) continue;
      out.set(symbol, bucket);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** One line of the AMC's disclosure (a `MfPortfolioHolding` subset). */
export interface DisclosureRow {
  instrumentName: string;
  isin: string | null;
  /** EQUITY | DEBT | CASH | DERIVATIVE | REIT_INVIT | GOLD | OTHER */
  holdingType: string;
  /** Share of net assets in PERCENT. Null = not disclosed, not zero. */
  percentToNav: number | null;
}

/** What the ISIN join supplies per instrument. */
export interface InstrumentFacts {
  symbol: string;
  sector: string | null;
  industry: string | null;
}

/** One `InstrumentMapping` candidate for an ISIN, as the service selects it. */
export interface InstrumentRow extends InstrumentFacts {
  isin: string | null;
  exchange: string;
  isActive: boolean | null;
}

/**
 * ISIN -> the ONE instrument row the composition joins through, chosen by an
 * explicit rank rather than by arrival order.
 *
 * This used to be `if (existing && row.exchange !== "NSE") continue` in the
 * service, which correctly kept an NSE row from being displaced by a BSE one
 * and did nothing at all about NSE vs NSE: with no `orderBy` on the query, two
 * NSE rows sharing an ISIN resolved to whichever Mongo returned last, and that
 * is not stable between two identical reads.
 *
 * MEASURED on prod 2026-09-13, because the population matters and is not the
 * one it looks like. The 870 documented NSE suffixed twins (`SYM-BE`/`-SM`/
 * `-ST`/`-BZ` beside a bare `SYM`) CANNOT reach here — they are the rows with
 * NO ISIN, and this join filters `isin: { in: [...] }`. What actually collides
 * is RENAMES: exactly 2 ISINs platform-wide carry more than one NSE row —
 * INE203Y01012 (SILLYMONKS / CRESTO, both active) and INE348N01042 (MANBRO
 * inactive / KDGREEN active). Neither is held by any scheme this surface can
 * currently serve (0 of 505 disclosure ISINs), so this is a determinism guard
 * ahead of the data, not a repair of a live wrong number.
 *
 * The rank RANKS, it never filters — dropping the inactive row would remove an
 * ISIN whose only mapping is inactive from the join entirely, costing that
 * holding its sector for no gain.
 *
 *   1. NSE first. `index_constituents.symbol` is the NSE primary symbol, so a
 *      BSE scrip id here silently costs every cap bucket.
 *   2. ACTIVE first. A renamed-away symbol is not in `index_constituents`
 *      either, so the stale half of a rename pair is the wrong half.
 *   3. Symbol ascending. Pure tie-break, and it is the one that makes two
 *      identical reads agree.
 */
export function resolveInstrumentsByIsin(
  rows: ReadonlyArray<InstrumentRow>,
): Map<string, InstrumentFacts> {
  const best = new Map<string, InstrumentRow>();
  for (const row of rows) {
    const isin = typeof row?.isin === "string" ? row.isin.trim() : "";
    if (!isin) continue;
    const incumbent = best.get(isin);
    if (!incumbent || instrumentRank(row) < instrumentRank(incumbent)) {
      best.set(isin, row);
    }
  }
  const out = new Map<string, InstrumentFacts>();
  for (const [isin, row] of best) {
    out.set(isin, {
      symbol: row.symbol,
      sector: row.sector,
      industry: row.industry,
    });
  }
  return out;
}

/** Sortable rank for {@link resolveInstrumentsByIsin}; lower wins. */
function instrumentRank(row: InstrumentRow): string {
  const exchange = row.exchange === "NSE" ? "0" : "1";
  const active = row.isActive === false ? "1" : "0";
  return `${exchange}${active}${String(row.symbol ?? "")}`;
}

/**
 * The AMC's holdingType vocabulary is NOT the composition one — it carries
 * `DERIVATIVE` and `REIT_INVIT`, which `ExtractedHolding` has never had. Mapped
 * explicitly rather than passed through so the asset donut's legend has one
 * vocabulary; anything unrecognised is OTHER.
 */
const ASSET_CLASS: Readonly<Record<string, string>> = {
  EQUITY: "EQUITY",
  DEBT: "DEBT",
  CASH: "CASH",
  GOLD: "GOLD",
  REIT: "REIT",
  REIT_INVIT: "REIT",
  DERIVATIVE: "OTHER",
  OTHER: "OTHER",
};

function assetClassOf(raw: string): string {
  return ASSET_CLASS[String(raw ?? "").toUpperCase()] ?? "OTHER";
}

/**
 * A breakdown whose every slice is ZERO is not a breakdown — it is an empty
 * circle with a `0.0%` legend under a footer asserting the fund house filed it.
 *
 * `percentToNav` is nullable and null means "not disclosed", which becomes a 0
 * weight so the LINE still renders and still counts. That is right for the
 * holdings list and wrong for a donut: with every weight 0,
 * `normalizeWeightsTo100` correctly refuses to divide by zero and hands back
 * the zeros unchanged, and the UI guards on `sectorBreakdown.length > 0`
 * rather than on any weight being non-zero.
 *
 * MEASURED on prod 2026-09-13: 336 of 54,248 rows have a null `percentToNav`
 * and ZERO of the 662 scheme-months are entirely null, so nothing renders this
 * way today. It is one line against a live failure shape all the same — the
 * AMFI NAVAll parser silently nulled a whole column for 26 days one table over
 * (MONEY-1403) — and the cost of getting it wrong is a false provenance claim,
 * not a missing chart.
 *
 * EXPORTED because applying it here is not enough. `normalizeComposition`
 * DERIVES a breakdown from the holdings whenever the stored one is empty, so
 * every path that re-normalizes a cached composition (`served()` in
 * `fund-composition.service.ts`) silently rebuilds the all-zero slices this
 * dropped — the MISS renders no donut and the HIT renders an empty one, for the
 * next 24h, under a footer crediting the fund house.
 */
export function droppingAllZero<T extends { weight: number }>(
  slices: T[],
): T[] {
  return slices.some((s) => s.weight > 0) ? slices : [];
}

function cleanSector(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || NON_SECTORS.has(trimmed.toUpperCase())) return null;
  return trimmed;
}

/** `Date` -> the `"YYYY-MM"` disclosure month the UI prints. */
export function disclosureMonth(period: Date | null | undefined): string {
  if (!(period instanceof Date) || !Number.isFinite(period.getTime()))
    return "";
  const month = String(period.getUTCMonth() + 1).padStart(2, "0");
  return `${period.getUTCFullYear()}-${month}`;
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** Everything the build needs that is not a per-row join. */
export interface DisclosureCompositionInput {
  fundType: "MF" | "ETF" | "INDEX";
  fundId: string;
  /** The month the disclosure describes; drives `dataAsOf`. */
  period: Date | null;
  holdings: ReadonlyArray<DisclosureRow>;
}

/**
 * Build a composition from one month of an AMC's disclosure.
 *
 * `instrumentsByIsin` and `capByIsin` are pre-joined by the caller (this module
 * imports no I/O), keyed by the RAW ISIN string as stored on the disclosure
 * row. A missing key is the normal case and is handled, never guarded against.
 *
 * The three breakdowns differ on purpose:
 *   - `assetBreakdown` is the raw disclosed weights by asset class. It is the
 *     one place cash / TREPS / debt are visible AS cash, and it is not
 *     rescaled: a portfolio that discloses 99.7% should read 99.7%.
 *   - `sectorBreakdown` and `capBreakdown` cover EVERY line — an unresolved one
 *     under {@link UNCLASSIFIED} — and are then rescaled to exactly 100 by
 *     `normalizeWeightsTo100`, because a donut is a whole.
 */
export function buildCompositionFromDisclosure(
  input: DisclosureCompositionInput,
  instrumentsByIsin: ReadonlyMap<string, InstrumentFacts>,
  capByIsin: ReadonlyMap<string, CapBucket>,
): SourcedComposition {
  const holdings: CompositionHolding[] = (input.holdings ?? []).map((row) => {
    const isin = typeof row?.isin === "string" ? row.isin.trim() : "";
    const facts = isin ? instrumentsByIsin.get(isin) : undefined;
    return {
      holdingName: String(row?.instrumentName ?? "").trim(),
      holdingSymbol: facts?.symbol ?? null,
      isin: isin || null,
      holdingType: assetClassOf(row?.holdingType),
      sector: cleanSector(facts?.sector),
      industry: cleanSector(facts?.industry),
      marketCap: (isin ? capByIsin.get(isin) : undefined) ?? null,
      // `percentToNav` is nullable and null means "not disclosed". It becomes 0
      // weight — the line still renders and still counts toward totalHoldings,
      // which is the difference between an undisclosed weight and a dropped row.
      weightPercent: round2(finite(row?.percentToNav)),
    };
  });

  const sectorBreakdown = droppingAllZero(
    normalizeWeightsTo100(
      aggregateByKey(holdings, (h) => h.sector, UNCLASSIFIED).map((b) => ({
        sector: b.key,
        weight: b.weight,
      })),
    ) as SectorSlice[],
  );

  const capBreakdown = droppingAllZero(
    normalizeWeightsTo100(
      aggregateByKey(holdings, (h) => h.marketCap, UNCLASSIFIED).map((b) => ({
        cap: b.key,
        weight: b.weight,
      })),
    ) as CapSlice[],
  );

  const assetBreakdown = droppingAllZero(
    aggregateByKey(holdings, (h) => h.holdingType, "OTHER").map((b) => ({
      type: b.key,
      weight: b.weight,
    })) as AssetSlice[],
  );

  return {
    fundType: input.fundType,
    fundId: input.fundId,
    // Heaviest first, matching what the Gemini path returns after
    // `normalizeComposition`. Already-sorted input costs one stable pass.
    holdings: holdings
      .slice()
      .sort(
        (a, b) =>
          b.weightPercent - a.weightPercent ||
          a.holdingName.localeCompare(b.holdingName),
      ),
    sectorBreakdown,
    capBreakdown,
    assetBreakdown,
    totalHoldings: holdings.length,
    // NOT a self-report and never rendered. The Gemini path stored the model's
    // own 0.95-0.99 grade of its own two-year-old answer; a filed disclosure
    // has no analogous number and inventing a 1.0 here would be the same
    // manufactured trust one source over.
    confidence: 0,
    dataAsOf: disclosureMonth(input.period),
    coveragePercent: coveragePercent(holdings),
    source: "AMC_DISCLOSURE",
  };
}

// ---------------------------------------------------------------------------
// D5 — the index subset cross-check
// ---------------------------------------------------------------------------

/** What {@link crossCheckIndexSubset} found. Logged, never blocking. */
export interface IndexSubsetCheck {
  indexId: string;
  constituents: number;
  /** Constituents the disclosure does NOT list. Empty = a clean subset. */
  missing: string[];
}

/**
 * Resolve an index from a fund's NAME, by asking the existing route resolver.
 *
 * Reuses `resolveIndexRoute` (`discover-section-logic.ts`) rather than growing a
 * second name->index table: it already owns the slug vocabulary, the aliases
 * ("niftybank" vs "banknifty") and the `IndexConstituent.indexId` mapping, and a
 * private copy here would be a second source of truth for the same question.
 * It is injected because that module is reachable only through the
 * `@usemoney/core/market-data` barrel, which pulls I/O at import time and must
 * not be dragged into a pure module.
 *
 * The name is normalised and scanned as TOKEN WINDOWS, longest first —
 * "HDFC NIFTY NEXT 50 ETF (…tracking NIFTY Next 50 Index TRI)" yields the
 * 3-token window "nifty-next-50" before the 2-token "next-50". Token windows
 * rather than substrings is what keeps "nifty-500" from matching "nifty-50":
 * the tokens are "nifty","500", so the shorter slug is never a window at all.
 *
 * ponytail: O(tokens²) windows over a ≤30-token scheme name, run once per cache
 * miss. If a longer name ever makes that matter, index the slugs by first token.
 */
export function indexIdForFundName(
  fundName: string,
  resolveIndexRoute: (raw: string) => {
    indexId: string | null;
    known: boolean;
  },
  normalizeIndexSlug: (raw: string) => string,
): string | null {
  const tokens = normalizeIndexSlug(String(fundName ?? ""))
    .split("-")
    .filter(Boolean);
  for (let size = tokens.length; size >= 2; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const slug = tokens.slice(start, start + size).join("-");
      const hit = resolveIndexRoute(slug);
      if (hit.known && hit.indexId) return hit.indexId;
    }
  }
  return null;
}

/**
 * D5 — does the ETF's disclosed portfolio contain every constituent of the
 * index it is named after?
 *
 * DIAGNOSTIC ONLY, and it must stay that way. NSE's constituent CSVs carry NO
 * weights (verified), so membership can never be the SOURCE of a composition —
 * it can only answer "did the disclosure lose anyone". A miss is not
 * necessarily a defect either: the index rebalanced between the disclosure
 * month and today, or the fund is sampling. So this is logged with its counts
 * and never gates a render.
 */
export function crossCheckIndexSubset(
  indexId: string | null,
  constituentSymbols: ReadonlyArray<string>,
  holdingSymbols: ReadonlyArray<string | null>,
): IndexSubsetCheck | null {
  if (!indexId || constituentSymbols.length === 0) return null;
  const held = new Set(
    holdingSymbols
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim().toUpperCase()),
  );
  const missing = constituentSymbols
    .map((s) =>
      String(s ?? "")
        .trim()
        .toUpperCase(),
    )
    .filter((s) => s !== "" && !held.has(s));
  return { indexId, constituents: constituentSymbols.length, missing };
}
