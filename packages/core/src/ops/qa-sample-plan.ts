/**
 * QA sample plan — which rows of each collection reach QA, and why.
 *
 * ## What this is
 *
 * `sync-prod-to-qa.sh --tier=reference` copies WHOLE collections. Measured
 * against prod on 2026-08-28 that is 12,753,000 rows, and 85% of them are four
 * tables nobody tests against: `stock_flags` (7,597,566), `mf_nav_history`
 * (3,193,427), `slb_positions` (747,614), `derivative_summary` (434,832).
 *
 * QA is a test environment. It needs every SHAPE, not every ROW: enough symbols
 * to exercise a join, enough history to draw a chart, both markets, and the
 * awkward cases (a delisted listing, a recycled ticker, a dual-listed symbol).
 * This module decides, per collection, which slice that is.
 *
 * ## Why the plan is TypeScript and the transport is bash
 *
 * The sync itself stays in `sync-prod-to-qa.sh` — it already solves problems
 * this module must not re-solve, chiefly the post-restore re-link of every
 * REQUIRED `instrument` relation (`stock_ratios`, `stock_financials`,
 * `stock_documents`, `stock_peers`, `stock_shareholding`). Prod's ObjectIds do
 * not exist in QA, and on a required relation Prisma THROWS rather than
 * returning null, so one dangling id takes out every result the caller asked
 * for — that is how QA's screener rendered blank fundamentals for everything on
 * 2026-08-19, 2,135 of 2,135 rows orphaned.
 *
 * That re-link is why the sample tier does NOT need to copy
 * `instrument_mappings` with prod's `_id`s, which was the obvious-looking
 * design and is a trap: it would collide on `@@unique([symbol, exchange])`
 * against QA's own rows, and orphan every QA row pointing at the ids it
 * replaced.
 *
 * What belongs here instead is the part with judgement in it — the strategy per
 * collection — and that part is pure, so it is tested rather than discovered in
 * production.
 *
 * ## Where the halves live
 *
 * The PURE half is here in `packages/core` and the CLI is in
 * `scripts/ops/qa-sample-plan.ts`. That split is not stylistic: the repo root
 * has no `"type": "module"`, so `tsx` loads `scripts/**` as CommonJS, and an
 * ESM test importing a named export from there fails at link time with
 * "does not provide an export named 'SAMPLE_PLAN'" — which is exactly how this
 * module first reached the suite. `packages/core` IS `"type": "module"`, so
 * the logic is importable and testable here and nowhere else.
 *
 * ## Emitting
 *
 *   npx tsx scripts/ops/qa-sample-plan.ts --emit
 *
 * prints one `collection<TAB>mongodumpQueryJSON` line per collection. An empty
 * query means "copy the whole collection", which is a real answer for a small
 * reference table and NOT a fallback for a strategy that failed — see
 * `assertPlanIsDeliberate`.
 */

/** Bounded by a symbol list from the manifest. */
export interface SymbolBound {
  kind: "symbol";
  /** The field holding the ticker. Not always `symbol` — measure, don't assume. */
  field: string;
}
/** Bounded by the ISINs of the sampled symbols. */
export interface IsinBound {
  kind: "isin";
  field: string;
}
/** Bounded by the sampled mutual-fund scheme codes. */
export interface SchemeBound {
  kind: "scheme";
  field: string;
}
/**
 * Market-wide rows with no per-symbol dimension — an FII flow, a circular, an
 * index snapshot. There is no symbol to filter on, so the only honest bound is
 * time. Filtering these by symbol would return ZERO rows, not fewer rows.
 */
export interface RecentBound {
  kind: "recent";
}
/**
 * Copy the whole collection. Only for tables small enough that sampling costs
 * more than it saves, or whose population is DISJOINT from the sample by
 * construction — `upcoming_ipos` is the clearest case: an IPO is not yet
 * listed, so it can never appear in a "top 500 by market cap" list, and a
 * symbol filter would empty the table.
 */
export interface AllBound {
  kind: "all";
}

export type Bound =
  | SymbolBound
  | IsinBound
  | SchemeBound
  | RecentBound
  | AllBound;

export interface SampleDescriptor {
  collection: string;
  market: "IN" | "US" | "BOTH";
  bound: Bound;
  /** Field to apply the history window to. Absent = no time bound. */
  timeField?: string;
  /** Rows in prod, measured 2026-08-28. Documentation, and the input to the saving estimate. */
  prodRows: number;
  /** Why this strategy and not another. Required — see `assertPlanIsDeliberate`. */
  why: string;
}

/**
 * Every collection in `REFERENCE_COLLECTIONS`, plus the US tables this branch
 * adds. Ordered by prod row count descending, so the rows that matter lead.
 */
export const SAMPLE_PLAN: readonly SampleDescriptor[] = [
  {
    collection: "stock_flags",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 7_597_566,
    why: "Largest reference table by 2.4x. Per-symbol per-day surveillance flags — bounds cleanly on both axes.",
  },
  {
    collection: "mf_nav_history",
    market: "IN",
    bound: { kind: "scheme", field: "schemeCode" },
    timeField: "date",
    prodRows: 3_193_427,
    why: "Keyed on schemeCode, NOT symbol: funds are their own universe (14,225 schemes) and a symbol filter returns zero.",
  },
  {
    collection: "slb_positions",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 747_614,
    why: "Securities-lending positions, per symbol per day — 747,614 rows, the third-largest table in the tier and one nothing in QA reads today.",
  },
  {
    collection: "derivative_summary",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 434_832,
    why: "F&O summary per underlying per day. The RAW derivative_eod is not synced at all; this is the derived layer QA would query.",
  },
  {
    collection: "mwpl_daily",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 141_931,
    why: "Market-wide position limits per symbol per day. Named market-wide but stored per underlying, so it does bound on symbol — the noun is about the LIMIT being market-wide, not the row.",
  },
  {
    collection: "xbrl_filings",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "periodEnd",
    prodRows: 108_009,
    why: "Bound on periodEnd, not createdAt: a filing's identity is its PERIOD, and createdAt is when we happened to ingest it — a backfill run would sweep every period into one day and defeat the window.",
  },
  {
    collection: "market_positioning",
    market: "IN",
    bound: { kind: "recent" },
    timeField: "date",
    prodRows: 93_212,
    why: "Participant-wise F&O positioning is market-wide — client type by day, no symbol dimension. Time is the only bound that returns rows.",
  },
  {
    collection: "stock_documents",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "fetchedAt",
    prodRows: 70_094,
    why: "Metadata only; the PDFs live in GCS and are synced by the separate stocks/ prefix mirror.",
  },
  {
    collection: "insider_events",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 65_669,
    why: "Per-symbol insider disclosures, bounded on the disclosure date. Safe to trim: each row is self-contained and nothing computes a running position from the full history.",
  },
  {
    collection: "shareholding_patterns",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    prodRows: 59_020,
    why: "No time bound: only createdAt exists, which is ingest time rather than the quarter the pattern describes. Bounding on it would keep whatever a backfill last touched and drop older quarters that are still current data.",
  },
  {
    collection: "shareholding_breakdown",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    prodRows: 56_783,
    why: "Same as shareholding_patterns — createdAt is not the period.",
  },
  {
    collection: "corporate_actions",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "exDate",
    prodRows: 56_289,
    why: "India actions. US actions are a SEPARATE table (us_corporate_actions) because two India readers deliberately drop the exchange term.",
  },
  {
    collection: "stock_financials",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "periodEnd",
    prodRows: 32_359,
    why: "periodEnd, not fetchedAt, for the reason given on xbrl_filings.",
  },
  {
    collection: "mf_portfolio_holdings",
    market: "IN",
    bound: { kind: "isin", field: "isin" },
    prodRows: 30_501,
    why: "Carries instrumentId and isin but no symbol. ISIN is the portable one — instrumentId is prod's ObjectId and means nothing in QA.",
  },
  {
    collection: "mutual_fund_masters",
    market: "IN",
    bound: { kind: "scheme", field: "schemeCode" },
    prodRows: 14_225,
    why: "The scheme universe the mf_nav_history sample is drawn from. Must be sampled with the SAME scheme list or the NAVs orphan.",
  },
  {
    collection: "bond_master",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 10_782,
    why: "Bonds are disjoint from an equity sample — filtering by equity symbols empties the table. Small enough to take whole.",
  },
  {
    collection: "stock_peers",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    prodRows: 10_461,
    why: "One row per symbol; the peer LIST inside may reference symbols outside the sample, which is harmless — peers render by symbol.",
  },
  {
    collection: "bond_eod",
    market: "IN",
    bound: { kind: "recent" },
    timeField: "date",
    prodRows: 4_914,
    why: "Keyed on ISIN of bonds, disjoint from the equity sample. Time-bound instead.",
  },
  {
    collection: "institutional_deals",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 4_492,
    why: "Bulk and block deals, per symbol per day. Trimming history is safe because each deal is an independent event rather than a cumulative position.",
  },
  {
    collection: "index_constituents",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 3_274,
    why: "Small, and it DEFINES membership — sampling it would silently shrink every index in QA and change screener results.",
  },
  {
    collection: "market_movers",
    market: "IN",
    bound: { kind: "recent" },
    timeField: "date",
    prodRows: 2_720,
    why: "A daily market-wide leaderboard. Filtering by sampled symbols would return a leaderboard that is not one.",
  },
  {
    collection: "stock_ratios",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    prodRows: 2_135,
    why: "One row per instrument. Carries a REQUIRED instrument relation — the post-restore re-link in sync-prod-to-qa.sh is mandatory for this table.",
  },
  {
    collection: "upcoming_events",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 1_990,
    why: "Per-symbol earnings/dividend calendar. Note the window runs BACKWARD from now while these rows point FORWARD, so a $gte cutoff keeps every future event and trims only stale past ones — which is the behaviour wanted, but it is a coincidence of direction rather than a design, so check it if the window ever becomes a $lte.",
  },
  {
    collection: "fund_holdings",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 1_800,
    why: "Keyed on ISIN of fund holdings; small, and composition is only meaningful whole.",
  },
  {
    collection: "stock_news",
    market: "IN",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "pubDate",
    prodRows: 1_645,
    why: "India news only — US news is a separate table now.",
  },
  {
    collection: "index_live_snapshots",
    market: "IN",
    bound: { kind: "recent" },
    timeField: "date",
    prodRows: 1_529,
    why: "Index-level OHLC snapshots keyed by indexSlug, with no symbol column at all — a symbol filter returns zero rows rather than fewer.",
  },
  {
    collection: "upcoming_ipos",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 1_431,
    why: "An IPO is NOT YET LISTED, so it can never appear in a top-500-by-market-cap sample. A symbol filter here returns zero rows and would silently empty QA's IPO surface.",
  },
  {
    collection: "index_memberships",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 924,
    why: "Same as index_constituents — defines membership.",
  },
  {
    collection: "nse_circulars",
    market: "IN",
    bound: { kind: "recent" },
    timeField: "createdAt",
    prodRows: 591,
    why: "NSE circulars are market-wide notices with no symbol dimension. Also note circNumber is NOT unique (NSE re-issues one circular per department), so any dedupe downstream must not assume it is.",
  },
  {
    collection: "macro_series",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 234,
    why: "Keyed on seriesId (repo rate, CPI...). Tiny and market-wide.",
  },
  {
    collection: "fund_composition_meta",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 111,
    why: "111 rows of extraction metadata (which funds have had composition parsed, and when). Sampling it against a symbol list would strand the parsed compositions in fund_holdings with no metadata saying they exist.",
  },
  {
    collection: "institutional_flows",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 22,
    why: "Two rows per trading day, market-wide.",
  },
  {
    collection: "stock_shareholding",
    market: "IN",
    bound: { kind: "all" },
    prodRows: 12,
    why: "Twelve rows. Sampling costs more than copying.",
  },

  // ── US — MONEY-980. All measured at 0 rows in prod on 2026-08-28 because the
  // backfill has not run. They are in the plan anyway: a collection that is
  // absent from the plan is silently never synced, and a table that appears the
  // day the backfill lands would reach QA only when someone remembered it.
  {
    collection: "candles",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "ts",
    prodRows: 0,
    why: "US EOD bars. Portable in a way daily_prices is NOT — keyed on (symbol, exchange, timeframe, ts) with no ObjectId — so a restore lands correctly against QA's own instrument ids.",
  },
  {
    collection: "us_instruments",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    prodRows: 0,
    why: "The US master. Must be sampled with the SAME symbol list as candles, or the bars orphan.",
  },
  {
    collection: "us_fund_nav",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "date",
    prodRows: 0,
    why: "US fund NAVs, split out of candles because funds are 72% of all US bars and a NAV is not OHLCV.",
  },
  {
    collection: "us_stock_news",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "pubDate",
    prodRows: 0,
    why: "US news, split from stock_news.",
  },
  {
    collection: "us_news_articles",
    market: "US",
    // TIME-BOUND, NOT SYMBOL-BOUND, and the difference is not cosmetic.
    //
    // `us_stock_news` above carries a scalar `symbol` — one row IS about one
    // company. `UsNewsArticle` is the ARTICLE-level row from a MARKET-WIDE
    // firehose: its `tickers` is a many-valued TAG array with `@default([])`,
    // and Tiingo's market-wide feed carries articles tagged with nothing at
    // all. A `{tickers: {$in: [...500 symbols]}}` bound would drop every one of
    // those, which is precisely the part of the feed a market-wide poller
    // exists to capture — and it would drop it INVISIBLY, because the guard
    // downstream only asks whether the slice is non-empty.
    //
    // Same call, same words, as `fao_participant_*`: market-wide, no symbol
    // dimension, time is the only bound that returns a representative slice.
    bound: { kind: "recent" },
    // `publishedAt` (when the PUBLISHER published), not `crawlDate` (Tiingo's
    // ingestion clock) and not `fetchedAt` (ours). A backfill or a catch-up run
    // sweeps a wide range of publish dates into one crawl day, so either of the
    // other two would collapse the window and hand QA one day of everything.
    // The same reasoning `xbrl_filings` records for periodEnd-over-createdAt.
    timeField: "publishedAt",
    prodRows: 0,
    why: "MONEY-1309 article-level US news from the 24x7 poller. Market-wide, so time is the only bound that returns a representative slice; a `tickers` $in would silently drop every untagged article. Rows are a title plus Tiingo's snippet — no article body — so a 2-year window is cheap.",
  },
  {
    collection: "us_corporate_actions",
    market: "US",
    bound: { kind: "recent" },
    timeField: "exDate",
    prodRows: 0,
    why: "Keyed on permaTicker, which the symbol manifest does not carry — resolving symbol->permaTicker would need a live join against us_instruments and would silently drop any symbol not yet enriched. Time-bound instead; the table is market-wide per ex-date and small.",
  },
  {
    collection: "fx_rates",
    market: "BOTH",
    bound: { kind: "all" },
    prodRows: 0,
    why: "One row per pair per day. USDINR converts every US value shown in rupees, so a gap is a wrong number rather than a missing chart.",
  },
  {
    collection: "databento_batch_jobs",
    market: "US",
    bound: { kind: "all" },
    prodRows: 0,
    why: "MONEY-1373. The batch-job ledger, and DISJOINT from any symbol sample by construction: the row carries no per-row symbol at all, only a symbolSet label and a hash over the whole population, so a symbol filter returns ZERO rows rather than fewer — and a zero-row sample DELETES QA's table, because mongorestore --drop drops before it restores. It is also the append's high-water mark, so a partial copy would make a QA append re-request ranges prod already paid for. Tens to hundreds of rows.",
  },
  {
    collection: "us_cost_model_versions",
    market: "US",
    bound: { kind: "all" },
    prodRows: 0,
    why: "MONEY-1373. One row per model build, no symbol dimension, and small enough that sampling costs more than it saves.",
  },
  {
    collection: "us_cost_model_rows",
    market: "US",
    bound: { kind: "all" },
    prodRows: 0,
    why: "MONEY-1373. Whole-collection deliberately, even though the row carries `symbol`: a backtest reads the cost model VERSION-PINNED, so a symbol-sliced copy leaves QA holding a version whose missing (listingId, todBucket) cells read as NO COST rather than as absent — fills priced free, silently, in exactly the surface the model exists to make honest. The join key is `listingId` in any case, not `symbol`.",
  },

  // ── US fundamentals — SEC EDGAR (MONEY-979). Measured at 0 rows in prod on
  // 2026-08-29 because the service has not been deployed. In the plan anyway,
  // for the reason the MONEY-980 block above states: a collection absent from
  // the plan is silently never synced, and it would reach QA only when somebody
  // remembered it.
  //
  // NOTE the bound split. Six of these carry a `symbol` column resolved at
  // ingest, so they bound on the SAME symbol manifest as candles and the rows
  // land against a company QA actually has. The other four are keyed by CIK or
  // by manager and carry no symbol at all — bounding those by symbol would
  // return ZERO rows rather than fewer rows, which is the trap `RecentBound`
  // exists for.
  //
  // `us_edgar_cursor` is DELIBERATELY ABSENT and is listed in QA_DIRECT in
  // prod-only-sync-coverage.test.ts instead. It is operational state, not
  // reference data: restoring prod's detection watermark into QA would make any
  // QA detect run skip every filing prod has already seen, and report a clean,
  // healthy, entirely empty run.
  {
    collection: "us_fundamentals",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "periodEnd",
    prodRows: 0,
    why: "Point-in-time statements. Carries a denormalised `symbol`, so it bounds on the same manifest as candles; `periodEnd` (not filedAt) is the history axis a 2-year window should mean here — a 2024 10-K filed in 2025 is a 2024 statement.",
  },
  {
    collection: "us_insider_transactions",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "transactionDate",
    prodRows: 0,
    why: "Forms 3/4/5. Symbol is resolved from the ISSUER cik at ingest, so the manifest bound works; time-bound on the transaction, which is what a user reads, not on filedAt.",
  },
  {
    collection: "us_13f_holdings",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "periodOfReport",
    prodRows: 0,
    why: "13F rows for sampled issuers. `symbol` is null until the CUSIP map resolves it, so this sample is deliberately a subset of a subset — QA gets resolved holdings for known companies, which is exactly what a QA screen needs.",
  },
  {
    collection: "us_beneficial_ownership",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "filedAt",
    prodRows: 0,
    why: "13D/G for sampled subjects. filedAt is the right axis: a 13D is news on the day it is filed.",
  },
  {
    collection: "us_filing_documents",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "filedAt",
    prodRows: 0,
    why: "8-K/6-K exhibit pointers; only the pointer row needs sampling. The TEXT lives in GCS under `edgar/`, which is deliberately OUTSIDE `feeds/` and therefore does NOT ride the prod->QA feeds mirror (raw filings grow ~330 GB/yr). So a QA row here may point at an object QA cannot read — that is accepted, not an oversight: the pointer is what readers join on, and MONEY-1324 copies the READINGS themselves as a reference collection rather than re-deriving them.",
  },
  {
    collection: "us_filing_insights",
    market: "US",
    bound: { kind: "symbol", field: "symbol" },
    timeField: "filedAt",
    prodRows: 0,
    why: "MONEY-1324 P17 readings of 8-K/6-K exhibits. Copied rather than re-derived: every row costs a paid Gemini call, QA's inputs are prod's byte-for-byte (us_filing_documents is already a reference collection), so a QA sweep would buy a second reading of identical bytes. That is why us-filing-insight is PROD_ONLY — this pairing is the other half of that decision and the two must move together.",
  },
  {
    collection: "us_filers",
    market: "US",
    bound: { kind: "all" },
    prodRows: 0,
    why: "One row per SEC filer (~15k), keyed by cik10 with no symbol column — a symbol bound would return zero. Small enough that sampling costs more than it saves, and it is the join target every other US table's cik10 points at, so a partial copy would orphan rows QA does have.",
  },
  {
    collection: "us_filings",
    market: "US",
    bound: { kind: "recent" },
    timeField: "filedAt",
    prodRows: 0,
    why: "The filing ledger for EVERY filer and every form, so it is the largest of these and carries no symbol. Time-bound only. QA gets a recent window, which is what a QA detect/parse test replays against.",
  },
  {
    collection: "us_company_facts",
    market: "US",
    bound: { kind: "recent" },
    timeField: "lastFiledAt",
    prodRows: 0,
    why: "One document per (cik, taxonomy, concept, unit) with the full value history inside it — no symbol, and the row IS the series, so a time bound selects actively-filing companies rather than truncating anyone's history.",
  },
  {
    collection: "us_13f_filings",
    market: "US",
    bound: { kind: "recent" },
    timeField: "periodOfReport",
    prodRows: 0,
    why: "13F cover pages are keyed by MANAGER, not by issuer, so no issuer symbol can bound them. Recent periods only — which also matches the hot window the holdings table keeps.",
  },
  {
    collection: "us_cusip_map",
    market: "US",
    bound: { kind: "all" },
    prodRows: 0,
    why: "CUSIP -> ticker, tens of thousands of rows and the join that makes 13F holdings readable. Sampling it by symbol would drop exactly the unresolved rows whose absence is the thing worth seeing in QA.",
  },
] as const;

export interface SampleWindow {
  /** History depth in years for every time-bounded collection. */
  years: number;
  /** Clock injection — never call `new Date()` inside the builder. */
  now: Date;
}

/**
 * Cap every symbol list at `n`, preserving order.
 *
 * `--universe=N` was previously parsed, echoed into the operator banner and
 * documented in `--help` while being forwarded NOWHERE, so it printed a
 * confident "universe=100" and copied the full manifest. A knob that reports a
 * value it does not apply is worse than no knob: it makes the run look
 * narrower than it was.
 */
export function capUniverse(u: SampleUniverse, n: number): SampleUniverse {
  if (!Number.isFinite(n) || n <= 0) return u;
  return {
    inSymbols: u.inSymbols.slice(0, n),
    usSymbols: u.usSymbols.slice(0, n),
    usFundSymbols: u.usFundSymbols.slice(0, n),
    // ISINs and scheme codes are capped alongside, so a smaller universe is
    // smaller in every dimension rather than only the ones with tickers.
    isins: u.isins.slice(0, n),
    schemeCodes: u.schemeCodes.slice(0, n),
  };
}

export interface SampleUniverse {
  inSymbols: readonly string[];
  usSymbols: readonly string[];
  /**
   * US MUTUAL FUND tickers, separate from `usSymbols` and not optional.
   *
   * `us_fund_nav`'s only writer is leg (b), whose population is
   * `assetType === "Mutual Fund"` — 49,414 of 72,685 US listings. The equity
   * manifest is S&P 500 constituents, curated ETFs and delisted STOCKS, and
   * contains no fund at all, so binding the table to `usSymbols` sampled it
   * against a list that can never match it: zero rows, the empty-guard skips,
   * and the run reports "empty-in-prod" and exits 0.
   *
   * That is the same defect one layer down from the one this branch's own
   * CLAUDE.md records for the leg itself — "a leg whose population is empty by
   * construction selects nothing, writes nothing and reports HEALTHY forever".
   */
  usFundSymbols: readonly string[];
  isins: readonly string[];
  schemeCodes: readonly string[];
}

/** The Mongo query for one collection, as mongodump's `--query` takes it. */
export function buildQuery(
  d: SampleDescriptor,
  u: SampleUniverse,
  w: SampleWindow,
): Record<string, unknown> {
  const q: Record<string, unknown> = {};

  switch (d.bound.kind) {
    case "symbol": {
      // `us_fund_nav` draws from the FUND vector; every other US collection
      // draws from the equity one. Keyed on the collection rather than the
      // market because the two populations are disjoint by construction.
      const syms =
        d.collection === "us_fund_nav"
          ? u.usFundSymbols
          : d.market === "US"
            ? u.usSymbols
            : d.market === "IN"
              ? u.inSymbols
              : [...u.inSymbols, ...u.usSymbols];
      // An EMPTY list is not "match everything" — `$in: []` matches nothing,
      // which is the correct and honest outcome for a market with no sample.
      // The caller decides whether that is expected; see `assertPlanIsDeliberate`.
      q[d.bound.field] = { $in: [...syms] };
      break;
    }
    case "isin":
      q[d.bound.field] = { $in: [...u.isins] };
      break;
    case "scheme":
      q[d.bound.field] = { $in: [...u.schemeCodes] };
      break;
    case "recent":
    case "all":
      break;
  }

  if (d.timeField) {
    const cutoff = new Date(w.now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - w.years);
    // `$date` — mongodump parses --query as Extended JSON, so a bare ISO string
    // would compare as a STRING against a BSON date and match nothing. Silently:
    // an empty result set is indistinguishable from "no rows in the window".
    q[d.timeField] = { $gte: { $date: cutoff.toISOString() } };
  }

  return q;
}

/**
 * Refuse a plan that would silently ship an empty or unexplained slice.
 *
 * Every failure mode this guards is one this repo has already had in
 * production: a job that returned 200 and wrote zero rows for five months; a
 * `$in` over a list that was never populated; a "fix" that narrowed a filter
 * until it matched nothing. An empty QA collection looks exactly like a
 * collection that is legitimately empty, which is why it has to be refused
 * HERE, before the dump, rather than noticed later.
 */
export function assertPlanIsDeliberate(
  plan: readonly SampleDescriptor[],
  u: SampleUniverse,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const d of plan) {
    if (seen.has(d.collection)) problems.push(`${d.collection}: listed twice`);
    seen.add(d.collection);

    if (!d.why.trim()) problems.push(`${d.collection}: no rationale`);

    if (d.bound.kind === "symbol") {
      const n =
        d.collection === "us_fund_nav"
          ? u.usFundSymbols.length
          : d.market === "US"
            ? u.usSymbols.length
            : d.market === "IN"
              ? u.inSymbols.length
              : u.inSymbols.length + u.usSymbols.length;
      if (n === 0) {
        const vector =
          d.collection === "us_fund_nav" ? "US MUTUAL FUND" : d.market;
        problems.push(
          `${d.collection}: symbol-bounded, but the manifest has 0 ${vector} symbols — this would copy NOTHING`,
        );
      }
    }
    if (d.bound.kind === "isin" && u.isins.length === 0) {
      problems.push(
        `${d.collection}: isin-bounded but the manifest has 0 ISINs`,
      );
    }
    if (d.bound.kind === "scheme" && u.schemeCodes.length === 0) {
      problems.push(
        `${d.collection}: scheme-bounded but the manifest has 0 scheme codes`,
      );
    }
  }
  return problems;
}

/** Rough saving, for the operator's confirmation prompt. */
export function estimateRows(
  plan: readonly SampleDescriptor[],
  u: SampleUniverse,
  totalInSymbols: number,
): { before: number; after: number } {
  const before = plan.reduce((a, d) => a + d.prodRows, 0);
  const share =
    totalInSymbols > 0 ? Math.min(1, u.inSymbols.length / totalInSymbols) : 1;
  const after = plan.reduce((a, d) => {
    if (d.bound.kind === "all") return a + d.prodRows;
    if (d.bound.kind === "recent") return a + d.prodRows * 0.25;
    return a + d.prodRows * share * 0.25;
  }, 0);
  return { before, after: Math.round(after) };
}
