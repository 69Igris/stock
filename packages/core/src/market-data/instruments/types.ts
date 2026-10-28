/**
 * Instrument Provider Interface
 *
 * Defines the contract for broker-specific instrument data providers.
 * Each broker implements this interface to supply instrument master data
 * for the central InstrumentMapping table.
 */

import type { Prisma } from "@usemoney/database";

/**
 * Raw instrument data as parsed from broker CSV/API dumps.
 * Each provider produces these, and the sync orchestrator
 * maps them into InstrumentMapping upserts.
 */
export interface RawInstrument {
  /** Canonical trading symbol (e.g., RELIANCE, NIFTY24JANFUT) */
  symbol: string;
  /** Exchange (NSE, BSE, NFO, BFO, MCX) */
  exchange: string;
  /** Full instrument/company name */
  name: string;
  /** ISIN code (universal identifier across brokers) */
  isin?: string;
  /** Instrument type: EQUITY, INDEX, FUTURES, OPTIONS, ETF, MF */
  instrumentType: string;
  /** Broker-specific trading symbol (may differ from canonical symbol) */
  tradingSymbol?: string;
  /** Series (EQ, BE, etc.) */
  series?: string;
  /** Lot size for F&O */
  lotSize?: number;
  /** Tick size (minimum price movement) */
  tickSize?: number;
  /** Expiry date for F&O */
  expiryDate?: Date;
  /** Strike price for options */
  strikePrice?: number;
  /** Option type: CE or PE */
  optionType?: string;
  /** Exchange segment code */
  segmentCode?: string;

  /** Broker-specific token/key fields */
  zerodhaToken?: number;
  upstoxKey?: string;
  angelToken?: string;
  fyersSymbol?: string;
  dhanSecurityId?: string;
  growwSchemeCode?: string;
}

/**
 * Interface that each broker's instrument provider must implement.
 * The sync orchestrator calls these methods in order:
 * 1. fetchInstruments() - download and parse the broker's instrument dump
 * 2. mapToUpsert() - convert each raw instrument into a Prisma-compatible upsert
 */
export interface InstrumentProvider {
  /** Provider name, e.g., "ZERODHA", "UPSTOX" */
  name: string;

  /**
   * Fetch and parse the instrument master dump from the broker.
   * Returns raw instrument records ready for mapping.
   */
  fetchInstruments(): Promise<RawInstrument[]>;

  /**
   * Map a single raw instrument to a partial InstrumentMapping upsert payload.
   * The sync orchestrator uses this to build the upsert query.
   */
  mapToUpsert(raw: RawInstrument): Partial<Prisma.InstrumentMappingCreateInput>;

  /**
   * OPTIONAL — the payload for an instrument that ALREADY EXISTS. Defaults to
   * `mapToUpsert` when a provider does not implement it.
   *
   * This exists because "what I know about a new row" and "what I am allowed to
   * overwrite on an existing row" are different questions, and conflating them
   * cost a live bug (MONEY-1093). A broker dump is authoritative for the fields
   * it actually sources and a GUESS for the rest. On a fresh row a guess beats
   * nothing; on an existing row it silently destroys a better value written by
   * someone else.
   *
   * Concretely: `instrument-sync` runs nightly at 22:00 IST and `bhavcopy-sync`
   * at 21:00 IST on weekdays. Zerodha's dump stamps `series` from its own
   * `instrument_type` column — the literal string "EQ" for every cash
   * instrument, bonds included — so for a year it overwrote the real exchange
   * series one hour after the price feed wrote it, and reverted every
   * deliberate DEBT/REIT re-classification within 24h. Nothing errored; the
   * data just never moved.
   *
   * Rule of thumb for implementors: omit (return `undefined`, or leave the key
   * off) any field your source does not genuinely carry. Prisma drops absent
   * keys, so the other writer's value survives.
   */
  mapToUpdate?(
    raw: RawInstrument,
  ): Partial<Prisma.InstrumentMappingCreateInput>;
}

/**
 * Result summary from an instrument sync operation.
 */
export interface InstrumentSyncResult {
  provider: string;
  totalFetched: number;
  upserted: number;
  failed: number;
  /**
   * Rows this RUN flipped inactive.
   *
   * MONEY-1263 — RUN-LEVEL, not per-provider, and attributed entirely to the
   * FIRST element of the returned array (zero on the rest) so that summing the
   * array yields the run total exactly once. The sweep happens after the
   * provider loop and is computed from the UNION of every provider's symbols,
   * so no single provider owns it. See `syncInstruments`.
   *
   * This was the literal `0` for the life of the field: `syncFromProvider`
   * initialised it and nothing ever assigned it, so the number documented as
   * "the one that makes the CATASTROPHIC failure visible at a glance" was
   * structurally incapable of being anything else.
   */
  deactivated: number;
  /**
   * True when the deactivation circuit breaker REFUSED an oversized sweep.
   *
   * MONEY-1263 — without this, "swept 0 rows because there was nothing stale"
   * and "refused to sweep 4,000 rows because the provider came back empty" are
   * the same observable state: `deactivated: 0`. The second is the
   * catastrophic one, and it reached an operator only as console prose.
   */
  deactivationRefused?: boolean;
  /** Rows the breaker DECLINED to flip. Non-zero only when refused. */
  deactivationRefusedCount?: number;
  errors: string[];
}

/**
 * `InstrumentMapping.instrumentType` values that belong on the FUND side of the
 * product rather than the stock side — MONEY-1085 follow-up.
 *
 * Every place that used to hard-code `instrumentType: "ETF"` for a
 * funds/ETF surface must query this instead. That is not tidiness: REITs and
 * InvITs were reclassified out of `EQUITY`, so a surface still filtering on
 * `"ETF"` alone would drop them from BOTH sides — off the stocks list because
 * they are no longer EQUITY, and off the funds list because they are not ETF.
 * A single shared constant makes that failure impossible to reach by omission.
 *
 * `FUND_INSTRUMENT_TYPES_TEST` (packages/core/__tests__) pins every query site
 * against this list.
 */
export const FUND_INSTRUMENT_TYPES = ["ETF", "REIT", "INVIT"] as const;

export type FundInstrumentType = (typeof FUND_INSTRUMENT_TYPES)[number];

/**
 * Exchange-traded trusts. Priced and traded like equities, but structurally
 * funds: they hold assets and distribute income rather than operating a
 * business, so earnings-based comparisons against operating companies mislead.
 */
export const TRUST_INSTRUMENT_TYPES = ["REIT", "INVIT"] as const;

/**
 * Supported exchanges for instrument syncing.
 *
 * INDIAN venues only, and deliberately so — MONEY-980. `RELEVANT_EXCHANGES` in
 * `zerodha-instruments-logic.ts` is built straight from this list and decides
 * which rows of Kite's 114k-line dump are kept, so a US venue added here would
 * widen a filter that has nothing to do with the US universe. The US exchanges
 * live in `US_EXCHANGES` below.
 */
export const SUPPORTED_EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX"] as const;

/**
 * The exchange scope every INDIA-FACING discover / screener query must carry —
 * MONEY-1263.
 *
 * ## The original reason is GONE; the constant is not
 *
 * This shipped because `instrument_mappings` had briefly become a SHARED table:
 * the US master wrote into it, and the India discover/screener surfaces select
 * the universe by `instrumentType` alone — `{isActive: true, instrumentType:
 * {in: FUND_INSTRUMENT_TYPES}}` with a `take`, no venue clause anywhere — which
 * was exactly right while every row was Indian and catastrophic once ~7,600
 * active US ETFs sat beside India's ~541.
 *
 * MONEY-980 ended that: US securities now live in `us_instruments`, their own
 * collection, and `syncUsInstruments` never touches this table. So the ~14:1
 * flooding this constant was written to stop can no longer happen, and any
 * measured US-row count quoted for THIS table is now zero.
 *
 * The constant and every call site STAY, and not out of sentiment:
 *
 *   - Nothing structurally prevents a future provider from writing non-Indian
 *     rows here again — the pull to merge the two tables recurs, and
 *     `us-instrument-sync.ts` documents why it must be resisted. A venue clause
 *     is a cheap standing guard against a decision being re-made badly.
 *   - The clause is CORRECT on its own terms regardless of the US question:
 *     these surfaces want NSE/BSE cash rows, and `SUPPORTED_EXCHANGES` also
 *     admits NFO/BFO/MCX. Without it, a derivatives or commodity row of the
 *     right `instrumentType` reaches an equity discover page.
 *   - Rows written during the shared period may still be sitting in an
 *     environment that has not been swept.
 *
 * Scoped by EXCHANGE rather than by `market`, deliberately, and that reasoning
 * is unchanged. `market` is ABSENT on all ~20,804 pre-existing India rows — a
 * Mongo `db push` creates indexes, not fields — so `{market: "IN"}` matches ZERO
 * and `{market: null}` matches zero as well (MONEY-1050/1205/1234/1236).
 * Exchange is populated on every row that has ever existed, so it is the one
 * filter that is correct BEFORE any backfill runs.
 *
 * Kept separate from `SUPPORTED_EXCHANGES` even though it is a subset of it:
 * that constant decides which rows of Kite's dump to KEEP, and the two answer
 * different questions. Widening one to include a derivatives venue must not
 * silently put F&O contracts on the discover surface.
 *
 * For resolving a SYMBOL rather than selecting a universe, see
 * `resolve-instrument.ts` — that is the one place a cross-market preference is
 * spelled, and it reads both collections.
 */
export const INDIA_DISCOVER_EXCHANGES = ["NSE", "BSE"] as const;

export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

/**
 * Exchange strings whose Yahoo symbol is the BARE ticker — MONEY-980.
 *
 * US Yahoo symbols carry no suffix: `AAPL`, not `AAPL.NS`. That is a different
 * RULE from the suffix table below, not a different ENTRY in it, and the
 * distinction is the whole point of this constant existing separately:
 *
 *   - `YAHOO_SUFFIX_MAP[exchange] ?? ".NS"` reads an ABSENT key as "India".
 *     Encoding "no suffix" as `NASDAQ: ""` would make correctness hinge on the
 *     one-character difference between `??` and `||` — and `||` reads
 *     identically to almost everyone, while silently reverting every US symbol
 *     to `.NS`. This repo has been burned four times (MONEY-1050, -1205, -1234,
 *     -1235) by absent-vs-empty conflations that looked like nothing.
 *   - The failure is not cosmetic. `InstrumentMapping` has `@@unique
 *     ([yahooSymbol])` and several US tickers are also NSE symbols — `INFY` is
 *     an NYSE ADR and an NSE listing — so a US row suffixed `.NS` collides with
 *     a real Indian row and the upsert fails outright.
 *
 * The eight venues match `TIINGO_US_EXCHANGES` (market-data/tiingo/
 * tiingo-logic.ts) today. They are still two constants because they answer two
 * questions — "which venues does the Tiingo integration ingest" versus "which
 * exchange strings mean a suffix-free Yahoo symbol" — and merging them would
 * make narrowing the ingest scope silently re-suffix stored rows.
 * `selectPrimaryListings` counts and DROPS any in-scope row whose exchange is
 * missing here, so a drift between the two lists is a visible counter rather
 * than a wrong symbol.
 */
export const US_EXCHANGES: ReadonlySet<string> = new Set([
  "NASDAQ",
  "NYSE",
  "AMEX",
  "NYSE ARCA",
  "NYSE MKT",
  "NYSE NAT",
  "BATS",
  // MONEY-980 — the mutual-fund venue. A fund ticker is suffix-free on Yahoo
  // exactly as an equity ticker is, so it belongs here for the same reason.
  // Its absence was caught by the counter this comment describes: with NMFQS in
  // TIINGO_US_EXCHANGES but not here, 49,876 in-scope funds were dropped down
  // to 64 listings — visible, rather than silently re-suffixed.
  "NMFQS",
]);

/**
 * Yahoo Finance symbol suffix mapping by exchange.
 *
 * INDIA ONLY. See `US_EXCHANGES` above for why a US venue must not be added
 * here with an empty suffix.
 */
export const YAHOO_SUFFIX_MAP: Record<string, string> = {
  NSE: ".NS",
  BSE: ".BO",
};

/**
 * Check if a Yahoo symbol should be skipped for price/sector fetching.
 *
 * ## This predicate is TERMINAL — read before widening it
 *
 * `partitionFetchable` (sector-enrichment-logic.ts) sends everything this
 * returns `true` for straight to the `SECTOR_SKIPPED` ("N/A") sentinel WITHOUT
 * fetching, and the enrichment cron only ever selects rows whose sector is
 * null. A non-null sentinel is therefore never reconsidered: one `true` here
 * removes an instrument from sector coverage permanently.
 *
 * This fix changes only what happens NEXT — no rows are rewritten here. Rows
 * already tombstoned are left to the separate data-correction effort that owns
 * them; this file deliberately ships no backfill script.
 *
 * On fetch cost: a symbol released by this change is fetched ONCE. The moment
 * it gets a sector it stops being selected, because the cron reads only
 * null-sector rows — so this widens the one-time backlog slightly and adds
 * nothing recurring.
 *
 * So the bar is "provably not a tradeable equity", not "looks odd". A false
 * positive is silent and permanent; a false negative costs one wasted HTTP
 * call, which the caller already tolerates.
 *
 * MONEY-1172 — two rules were failing that test and account for part of the
 * 14,893 tombstones (67% of the universe):
 *
 *   `/^\d/`  "starts with a digit → BSE bond/debt" also matched **3MINDIA**,
 *            **63MOONS**, **5PAISA** and **20MICRONS** — all real, actively
 *            traded NSE equities. The rule three lines below it even names
 *            3MINDIA and 63MOONS as symbols to protect, but could never see
 *            them: this rule had already returned. Narrowed to an ALL-digit
 *            base, which is what a BSE numeric scrip code actually looks like
 *            (`500325`) and what the original example (`828GUJ2029`) needed
 *            the following `\d{4,}` rule for anyway.
 *
 *   `/^Z[A-Z]/` "BSE suspended/delisted stocks prefixed with Z" confused BSE's
 *            **Z GROUP** — a surveillance classification held in a separate
 *            field — with the first letter of a trading symbol. It tombstoned
 *            ZOMATO.BO, ZYDUSLIFE.BO, ZEEL.BO, ZENSARTECH.BO, ZFCVINDIA.BO and
 *            ZUARI.BO, while ZOMATO.NS passed: the same company was classified
 *            on one exchange and permanently blank on the other. Removed
 *            outright. If Z-group really should be skipped, the group letter is
 *            available directly — MONEY-1093 added BSE's scrip master as an
 *            enricher precisely to supply it — and it belongs in a rule that
 *            reads that field, not the symbol's spelling.
 *
 * The `-BE` rule is retained but is currently unreachable: `buildYahooSymbol`
 * strips `-[A-Z]+$` before this is called, so `SUZLON-BE` arrives as
 * `SUZLON.NS`. Left in place because it is harmless and correct if a provider
 * ever passes the series through; it is not load-bearing today.
 *
 * Genuinely caught here (all verified against the real predicate):
 * - BSE numeric scrip codes (e.g. 500325.BO)
 * - BSE MF/bond codes with 4+ consecutive digits (e.g. HDFC1204DG.BO, 828GUJ2029.BO)
 * - BSE MF payout suffixes after digits (e.g. SFMP68GR.BO)
 * - BSE Fixed Maturity Plans (e.g. KTKFMP46G.BO)
 * - BSE NCDs/debt with roman-numeral codes (e.g. RFHXXIV05G.BO, NFHXXV01G.BO)
 * - BSE RMFINAF* debt series
 */
export function isUnfetchableYahooSymbol(yahooSymbol: string): boolean {
  if (!yahooSymbol) return true;

  // Extract base symbol (before .NS/.BO suffix)
  const base = yahooSymbol.replace(/\.(NS|BO)$/, "");

  // ALL digits → a BSE numeric scrip code, not a trading symbol.
  // NOT `/^\d/`: real equities begin with digits (3MINDIA, 63MOONS, 5PAISA).
  if (/^\d+$/.test(base)) return true;

  // Contains -BE → NSE trade-to-trade series (illiquid/suspended).
  // Unreachable today: buildYahooSymbol strips the series suffix first.
  if (/-BE$/.test(base)) return true;

  // Has 4+ consecutive digits → likely MF/bond code, not regular equity
  // Valid equities like 3MINDIA, 63MOONS only have 1-2 digits
  if (/\d{4,}/.test(base)) return true;

  // Ends with common BSE MF payout suffixes (RG, RD, DD, DQ, GR, RQ)
  // after digits - e.g. SFMP68GR, UTCRFS2RGR
  if (/\d+[A-Z]{2,3}$/.test(base) && /\d{2,}/.test(base)) return true;

  // BSE Fixed Maturity Plans - contain "FMP" followed by digits
  if (/FMP\d/.test(base)) return true;

  // BSE NCDs/debt with roman numeral codes (XX followed by I/V/X pattern)
  // e.g. RFHXXIV05G, RFXXIII12G, NFHXXV01G, NFHXXVI09G, HCPO36MJDG
  if (/XX[IVX]+/.test(base)) return true;

  // BSE RMFINAF* series (debt instruments)
  if (/^RMFINAF/.test(base)) return true;

  return false;
}
