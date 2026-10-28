/**
 * Build the QA SAMPLE UNIVERSE manifest — MONEY-980 / QA sampled-sync tier.
 * ==========================================================================
 *
 * ## THIS IS A TEST FIXTURE. IT IS NOT A PRODUCTION DATA DEPENDENCY.
 *
 * Read that again before changing anything here, because it is the property
 * that keeps this file out of every licensing and data-vendor question:
 *
 *   - The generated `qa-sample-universe.json` is CHECKED IN, and it exists for
 *     exactly one purpose: to tell `sync-prod-to-qa.sh --tier=sample` which
 *     rows to copy into a TEST database.
 *   - NOTHING in a production code path may read it. Not the web app, not the
 *     API, not a worker, not a scheduled job. If you ever find yourself
 *     importing this manifest from `apps/` or `workers/`, the design has gone
 *     wrong — the manifest is a list of symbols we happen to find interesting
 *     to test against, not a curated index, not a recommendation, and not a
 *     redistributable dataset.
 *   - DRIFT IS ACCEPTABLE. The S&P 500 changes a few names a quarter. A
 *     manifest that is a few constituents stale still selects a perfectly good
 *     test sample, so there is no freshness SLA, no scheduled regeneration and
 *     no alert. Regenerate it when someone wants to; never wire it to a cron.
 *
 * The one thing that is NOT acceptable is a manifest that SILENTLY shrank. A
 * short list still looks like a successful run, and QA would then be testing
 * against a fraction of the coverage everyone believes it has — the exact
 * failure shape as `financial-data-sync` returning 200 and writing zero rows
 * for five months. So every source is checked, and an unreachable or
 * unexpectedly-small source ABORTS the run rather than emitting a partial
 * universe. See `assertPlausible` below.
 *
 * ## What the manifest holds
 *
 *   us.equities   ~502 S&P 500 constituents      derived: Wikipedia
 *   us.etfs       100 large US ETFs              derived: candles, else static
 *   us.delisted   20 delisted US securities      curated + derived: Tiingo master
 *   us.funds      100 US mutual funds             curated + derived: Tiingo master
 *   in.equities   500 by market cap              derived: PROD
 *   in.etfs       100 by traded volume           derived: PROD
 *   in.schemes    100 MF scheme codes            derived: PROD
 *   isins[]       ISINs of the sampled IN names  derived: PROD
 *   schemeCodes[] == in.schemes.symbols          derived: PROD
 *
 * ## The SHAPE IS THE CONSUMER'S, not this file's
 *
 * `scripts/ops/qa-sample-plan.ts` reads this manifest and flattens it in
 * `universeFromManifest`. That function does `pick(l) => l.symbols` and spreads
 * the result straight into a `Set<string>`, so **`symbols` MUST be a flat array
 * of strings** — an array of `{symbol}` objects would produce a set of
 * `[object Object]` and every `$in` in the plan would match zero rows while the
 * sync reported success. Per-entry detail therefore lives in a SIBLING key
 * (`listings`, `entries`), never inside `symbols`.
 *
 * `schemeCodes` is read as `m.schemeCodes ?? pick(m.in?.schemes)`. Both are
 * emitted, identical, and a run aborts if they ever disagree.
 *
 * ## Measurements this file is built on (2026-08-28, PROD Atlas)
 *
 * Every number below was measured against the PROD cluster
 * (`stockbook.lizbtx.mongodb.net/tradebook`), not the repo `.env`
 * `DATABASE_URL`, which points at QA. Measuring the wrong one has already
 * produced a wrong conclusion on this branch, so the target host is printed on
 * every run and recorded in the manifest.
 *
 *   - `candles` DOES NOT EXIST in prod. Not "is empty" — the collection is
 *     absent from `db.getCollectionNames()`. The US backfill has never run, so
 *     the intended "top 100 US ETFs by 1-year average volume" cannot be derived
 *     today. The data-driven path IS implemented below and is preferred
 *     automatically the moment rows appear; until then the run falls back to a
 *     static list and RECORDS `"method": "static-fallback"` in the JSON so no
 *     reader can mistake one for the other.
 *   - `instrument_mappings` holds NO US rows at all: the distinct exchange set
 *     is exactly `["BSE", "NSE"]`, and `permaTicker` is non-null on zero rows.
 *     So the whole US side of this manifest is necessarily external — there is
 *     nothing in prod to derive it from.
 *   - India ETFs have NO AUM anywhere. `aum`, `fundAum`, `netAssets`,
 *     `expenseRatio` and `amfiSchemeCode` are non-null on ZERO of the 541
 *     active ETF rows, and only ONE ETF carries a `marketCap`. Ranking "by AUM"
 *     is therefore impossible and ranking by market cap would select a list of
 *     one. They are ranked by `latest_quotes.volume`, which is populated on 509
 *     of 541 — stated in the manifest as the ranking metric so the substitution
 *     is visible rather than implied.
 *   - Dual listing is PERVASIVE and had to be decided, not defaulted: 2,226 of
 *     5,185 distinct ISINs quote on both NSE and BSE, and every single one of
 *     the top 15 by market cap appears twice. Left alone, "top 500" would have
 *     been ~250 companies each counted twice. See `dedupeByIsin`.
 *   - MUTUAL FUNDS HAVE NO AUM COLUMN EITHER, and the population that matters
 *     is far smaller than the master suggests: `mutual_fund_masters` holds
 *     14,225 schemes, but only 1,816 of them appear anywhere in
 *     `mf_nav_history` (3,193,427 rows). A list ranked by AUM — had there been
 *     an AUM to rank by — would have selected mostly schemes with ZERO NAV
 *     history, and the sync's zero-match guard skips rather than fails, so QA
 *     would have ended up with no NAV history at all while every job reported
 *     success. The fund list is therefore drawn from the NAV-BEARING
 *     population and ranked by NAV DEPTH; the intersect is still performed and
 *     its before/after counts recorded, so a future divergence is visible
 *     rather than inferred. All 1,816 are `isActive`, so no scheme is lost to
 *     the active filter.
 *
 * ## Every list is VALIDATED against the collection it bounds
 *
 * A manifest that emits plausible symbols which match NOTHING is worse than no
 * manifest: the sync runs, reports success, and leaves QA hollow. So after
 * selection, each list is counted against the collection `qa-sample-plan.ts`
 * will actually bound with it, and the hit count is recorded in
 * `validation` — evidence rather than assertion.
 *
 * The US lists validate to ZERO, and that is CORRECT rather than a failure:
 * `candles`, `us_instruments`, `us_fund_nav`, `us_stock_news` and
 * `us_corporate_actions` do not exist in prod at all. Those are declared
 * `expectedZero` with the reason, so a zero that is expected reads differently
 * from a zero that is not — an undeclared zero aborts the run.
 *
 * ## Usage
 *
 *   node --import tsx scripts/ops/build-qa-sample-universe.ts --env=prod
 *   node --import tsx scripts/ops/build-qa-sample-universe.ts --env=prod --apply
 *
 * DRY RUN IS THE DEFAULT and `--apply` is a BARE flag — never `--apply=true`.
 * MONEY-1252 / MONEY-1261: a wrapper that emitted `--flag=value` had its
 * `--apply` swallowed, and a 54-minute "apply" run wrote nothing while exiting
 * 0. The parser below refuses anything it does not fully understand rather than
 * falling back to a default, because every one of that parser's historical
 * failure modes resolved to MORE work, silently.
 */

import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Narrow subpaths only (standing repo rule), and for the same concrete reason
// `resector-real-estate.ts` documents: a barrel that re-exports something which
// imports `@usemoney/database` would build PrismaClient at module scope from
// whatever `DATABASE_URL` was set at import time, defeating the `--env`
// resolution and the `await import()` in `main()`.
//
// `tiingo-logic` is pure (its only import is `../csv-line`) and `tiingo-client`
// is the same module `scripts/jobs/tiingo-us-backfill.ts` already uses to pull
// the master. Going through the client rather than a raw `fetch()` keeps this
// on the feed-archive seam: `apimedia.tiingo.com` is a FEED_HOST, and
// `supported_tickers.zip` is a PUBLIC file that costs no API quota.
import { fetchSupportedTickers } from "@usemoney/core/market-data/tiingo/tiingo-client";
import {
  buildListingId,
  deriveListingStatus,
  maxEndDate,
} from "@usemoney/core/market-data/tiingo/tiingo-logic";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// Load the repo `.env` explicitly. Scripts in this repo have NO dotenv by
// default, and the two `yarn data:*` siblings once resolved DATABASE_URL
// differently from the same shell because one read `.env` and the other did
// not.
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const GCP_PROJECT = "stock-book-483718";
const OUTPUT_PATH = path.join(HERE, "qa-sample-universe.json");
const SCHEMA_VERSION = 1;

/** Where the S&P 500 constituent table is read from. Recorded in the JSON. */
const SP500_SOURCE_URL =
  "https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw";

/**
 * A descriptive UA, because it is polite and because SEC-style enforcement is
 * real elsewhere in this repo (`EDGAR_CIK_ENRICH` 403s on curl's default).
 */
const USER_AGENT =
  "usemoney-qa-sample-universe/1.0 (+https://usemoney.ai; deepshaswat@gmail.com)";

/* qa-universe-pure:begin
 *
 * Everything from here to the `:end` marker is PURE and IMPORT-FREE: no I/O, no
 * clock, no env. That is what lets `qa-sample-universe.test.ts` lift the region
 * into a temp ESM module and EXECUTE it, rather than assert about its text.
 * Same mechanism as `tiingo-script-decisions.test.ts`, and for the same reason:
 * this file has a top-level `main()` and a `@usemoney/database` import, so
 * importing it into `node:test` would RUN it.
 *
 * Keep it self-contained. A single `import` added below silently breaks the
 * lift, which is why the suite asserts the region has none.
 */

/** Thrown for any argv this parser does not fully understand. */
export class UniverseCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniverseCliError";
  }
}

export interface UniverseCliSpec {
  /** Flags that are present or absent. `--apply`, never `--apply=true`. */
  readonly bare: readonly string[];
  /** Flags that REQUIRE a value: `--env=prod`. */
  readonly valued: readonly string[];
}

export interface UniverseCliArgs {
  has(flag: string): boolean;
  value(flag: string): string | undefined;
}

/**
 * Parse argv, REFUSING anything unrecognised.
 *
 * The rules, identical in spirit to the three Tiingo job scripts: every token is
 * `--flag` or `--flag=value`; every flag must be known; a BARE flag must never
 * carry `=`; a VALUED flag must always carry a non-empty `=` value; no flag may
 * repeat. The SPACE form is rejected outright — supporting it is what made
 * `--limit 500` parse as "no limit at all", i.e. every row.
 *
 * A parser whose failure mode is "do more than asked" is worse than none: the
 * operator's model and the machine's behaviour diverge silently, and only the
 * machine is right.
 */
export function parseUniverseCliArgs(
  argv: readonly string[],
  spec: UniverseCliSpec,
): UniverseCliArgs {
  const known = new Set([...spec.bare, ...spec.valued]);
  const usage =
    "Known flags: " +
    [
      ...spec.bare.map((f) => `--${f}`),
      ...spec.valued.map((f) => `--${f}=<value>`),
    ].join(" ") +
    ".";

  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (const token of argv) {
    if (!token.startsWith("--")) {
      throw new UniverseCliError(
        `Unexpected argument "${token}". Every option is --flag or ` +
          "--flag=value; there are no positional arguments and the SPACE " +
          `form is not accepted. ${usage}`,
      );
    }

    const eq = token.indexOf("=");
    const name = (eq < 0 ? token : token.slice(0, eq)).slice(2);

    if (!known.has(name)) {
      throw new UniverseCliError(
        `Unknown flag "--${name}". Refusing to run rather than ignoring an ` +
          `option you believed was in effect. ${usage}`,
      );
    }
    if (flags.has(name) || values.has(name)) {
      throw new UniverseCliError(
        `--${name} was given more than once. Refusing to guess which ` +
          "occurrence wins.",
      );
    }

    if (eq < 0) {
      if (!spec.bare.includes(name)) {
        throw new UniverseCliError(
          `--${name} requires a value and the SPACE form is not accepted. ` +
            `Use --${name}=<value>.`,
        );
      }
      flags.add(name);
      continue;
    }

    if (!spec.valued.includes(name)) {
      throw new UniverseCliError(
        `--${name} is a bare flag and takes no value. Pass --${name}. ` +
          "An `--apply=true` that neither took effect nor was rejected is " +
          "how a multi-hour run exited 0 having written nothing.",
      );
    }
    const value = token.slice(eq + 1);
    if (value === "") {
      throw new UniverseCliError(`--${name}= was given an empty value.`);
    }
    values.set(name, value);
  }

  return {
    has: (flag: string) => flags.has(flag),
    value: (flag: string) => values.get(flag),
  };
}

/** One S&P 500 constituent, as parsed out of the Wikipedia table. */
export interface Sp500Constituent {
  /** Normalised to Tiingo's spelling — see `toTiingoTicker`. */
  symbol: string;
  /** The spelling Wikipedia used, kept when it differs, for traceability. */
  wikiSymbol?: string;
  name: string;
  sector: string;
  exchange: "NYSE" | "NASDAQ";
}

/**
 * Wikipedia's ticker spelling -> the one our tables actually store.
 *
 * ## A two-symbol bug that would have been invisible
 *
 * Wikipedia writes share classes with a DOT (`BRK.B`, `BF.B`). Tiingo — and
 * therefore `candles.symbol` and `us_instruments.symbol`, whose schema comments
 * both read "dashes not periods: BRK-A, SPG-P-J" — writes them with a DASH.
 * Measured against the live master: `BRK.B` and `BF.B` have ZERO rows, `BRK-B`
 * and `BF-B` have one each.
 *
 * Unnormalised, those two entries would sit in the manifest looking perfectly
 * well-formed and match nothing at all, while the other 500 matched fine — so
 * the slice would be quietly two companies short with no error anywhere. That
 * is the same silent-partial shape as every other guard in this file, just
 * small enough to be dismissed.
 *
 * With the dash form, all 502 constituents resolve to a live USD row in the
 * master, which is why `main()` asserts exactly that rather than trusting this
 * function.
 */
export function toTiingoTicker(symbol: string): string {
  return symbol.replace(/\./g, "-");
}

/**
 * Parse the constituents table out of the raw wikitext.
 *
 * Wikitext rather than rendered HTML because the rendered page is large enough
 * that a summarising fetch TRUNCATES it — measured: ~300 of 502 rows came back,
 * with the tail silently missing. A truncated constituent list is precisely the
 * "looks successful, quietly smaller" failure this file exists to avoid, and it
 * would have been invisible without a count check.
 *
 * The table's rows are stable and machine-shaped:
 *
 *     |-
 *     || {{NyseSymbol|MMM}}
 *     || [[3M]]
 *     || Industrials
 *     || Industrial Conglomerates
 *     ...
 *
 * so the parse keys off the `{{NyseSymbol|…}}` / `{{NasdaqSymbol|…}}` template,
 * which doubles as the LISTING VENUE — the only place the venue appears at all.
 * Measured 2026-08-28: 343 NYSE + 159 Nasdaq = 502 rows, which is right for the
 * index (500 companies, ~503 share classes: GOOG/GOOGL, FOX/FOXA, NWS/NWSA).
 *
 * Security names arrive as `[[3M]]` or `[[Alphabet Inc.|Alphabet]]`; both
 * collapse to the DISPLAY half, which is the human-facing label.
 */
export function parseSp500Wikitext(src: string): Sp500Constituent[] {
  const start = src.indexOf('id="constituents"');
  if (start < 0) {
    throw new Error(
      'the S&P 500 wikitext no longer contains id="constituents" — the page ' +
        "structure changed and this parser must be re-derived rather than " +
        "left to return a short list",
    );
  }
  // The constituents table ends at its own `|}`; a later table (changes to the
  // index) must not bleed in.
  const endRel = src.indexOf("\n|}", start);
  const table = endRel < 0 ? src.slice(start) : src.slice(start, endRel);

  const out: Sp500Constituent[] = [];
  const rowRe = /\{\{(Nyse|Nasdaq)Symbol\|([^}|]+)\}\}/g;

  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(table)) !== null) {
    // Both groups are non-optional in the pattern, but `noUncheckedIndexedAccess`
    // cannot know that. Narrowing beats a non-null assertion: if the pattern is
    // ever edited into optional groups, this SKIPS the row rather than pushing
    // an entry whose symbol is the string "undefined".
    const venue = m[1];
    const raw = m[2];
    if (venue === undefined || raw === undefined) continue;
    const exchange = venue === "Nyse" ? "NYSE" : "NASDAQ";
    const symbol = raw.trim();
    if (symbol === "") continue;

    // Name and sector are the next two `||` cells after the symbol cell.
    const rest = table.slice(rowRe.lastIndex);
    const cells = rest
      .split("\n")
      .filter((l) => l.startsWith("||"))
      .slice(0, 2)
      .map((l) => l.slice(2).trim());

    const normalised = toTiingoTicker(symbol);
    out.push({
      symbol: normalised,
      ...(normalised === symbol ? {} : { wikiSymbol: symbol }),
      name: cleanWikiCell(cells[0] ?? ""),
      sector: cleanWikiCell(cells[1] ?? ""),
      exchange,
    });
  }
  return out;
}

/** `[[Alphabet Inc.|Alphabet]]` -> `Alphabet`; `[[3M]]` -> `3M`. */
export function cleanWikiCell(cell: string): string {
  return cell
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/<ref[^>]*>.*?<\/ref>/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/'''?/g, "")
    .trim();
}

/** A quoted India row, flattened from `latest_quotes` + its instrument. */
export interface IndiaQuoteRow {
  symbol: string;
  exchange: string;
  isin: string | null;
  name: string;
  instrumentType: string;
  isActive: boolean;
  marketCap: number | null;
  volume: number | null;
}

/** What lands in the manifest for an India row. */
export interface IndiaEntry {
  symbol: string;
  exchange: string;
  isin: string | null;
  name: string;
}

/**
 * Collapse dual listings to ONE row per company, preferring NSE.
 *
 * ## Why this is not optional
 *
 * 2,226 of 5,185 distinct ISINs quote on BOTH exchanges, and the two rows carry
 * near-identical market caps (RELIANCE: 17,413,848,432,640 on BSE against
 * 17,351,335,477,248 on NSE — a 0.36% spread that is just the closing-price
 * difference). Ranked naively, the "top 500" is ~250 companies listed twice,
 * and the sample silently loses half its intended breadth while looking exactly
 * the right size.
 *
 * ## Why NSE wins, stated as a choice rather than left to sort order
 *
 * NSE is the primary liquidity venue for Indian equities, and it is what the
 * rest of this repo already treats as primary — the instrument pipeline's own
 * master feed is NSE's `EQUITY_L.csv` / `SME_EQUITY_L.csv`. Picking by "higher
 * market cap" instead would have been WORSE than arbitrary: it would flip
 * between exchanges day to day on a sub-1% price difference, so a regeneration
 * would reshuffle exchanges across hundreds of rows and produce an unreadable
 * diff for no informational gain.
 *
 * Rows with NO ISIN cannot be grouped and are kept as-is — measured at 18 of
 * 7,429, all of them thin BSE listings. Dropping them would be a silent
 * narrowing; keeping them risks at most a handful of duplicate companies deep
 * in the tail, which is the cheaper error for a test fixture.
 */
export function dedupeByIsin(
  rows: readonly IndiaQuoteRow[],
  preferExchange = "NSE",
): IndiaQuoteRow[] {
  const byIsin = new Map<string, IndiaQuoteRow>();
  const noIsin: IndiaQuoteRow[] = [];

  for (const row of rows) {
    if (!row.isin) {
      noIsin.push(row);
      continue;
    }
    const held = byIsin.get(row.isin);
    if (!held) {
      byIsin.set(row.isin, row);
      continue;
    }
    // Deterministic: preferred exchange wins; otherwise the lexically smaller
    // exchange, so the choice never depends on Mongo's return order.
    if (held.exchange === preferExchange) continue;
    if (row.exchange === preferExchange) {
      byIsin.set(row.isin, row);
      continue;
    }
    if (row.exchange < held.exchange) byIsin.set(row.isin, row);
  }

  return [...byIsin.values(), ...noIsin];
}

/**
 * Top `n` by `metric`, descending, with an explicit tie-break.
 *
 * The tie-break is not decoration. Mongo returns equal-metric rows in whatever
 * order it likes, so without one a regeneration reshuffles the boundary of the
 * list and the diff stops being reviewable — the exact property this manifest
 * is supposed to have.
 */
export function topByMetric(
  rows: readonly IndiaQuoteRow[],
  metric: "marketCap" | "volume",
  n: number,
): IndiaQuoteRow[] {
  const withMetric = rows.filter((r) => {
    const v = r[metric];
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  });
  const sorted = [...withMetric].sort((a, b) => {
    const av = a[metric] ?? 0;
    const bv = b[metric] ?? 0;
    if (bv !== av) return bv - av;
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return a.exchange < b.exchange ? -1 : 1;
  });
  return sorted.slice(0, n);
}

/**
 * Emit order for every list: SYMBOL ASCENDING, never by rank.
 *
 * Market caps and volumes move every single day, so a rank-ordered file would
 * reshuffle hundreds of lines on every regeneration and bury the one change
 * anybody cares about (a name entering or leaving). Sorted by symbol, the same
 * event is a one-line add and a one-line delete.
 *
 * For the same reason the volatile METRIC is deliberately not stored on the
 * entry. Its selection-time boundary is recorded once in the list's metadata,
 * which is one churning line instead of five hundred.
 */
export function stableBySymbol<
  T extends { symbol: string; exchange?: string | null },
>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => {
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return (a.exchange ?? "") < (b.exchange ?? "") ? -1 : 1;
  });
}

/**
 * A deliberately-chosen delisted US security.
 *
 * `exchange` + `listingStartDate` are part of the SPEC, not looked up, because
 * a bare ticker is ambiguous for exactly the securities that make this list
 * worth having: `DOW` names Dow Chemical (1972-2017) and Dow Inc. (2019-) with
 * identical exchange, assetType and currency. Naming the window here means a
 * change upstream FAILS rather than silently selecting the other company.
 */
export interface DelistedSpec {
  symbol: string;
  /** Omitted only when `expectAbsent` — the security is not in the master. */
  exchange?: string;
  listingStartDate?: string;
  /** Why this one earns a slot. Copied into the manifest. */
  rationale: string;
  /**
   * True when Tiingo's master has NO row for this ticker at all. Those are the
   * two most valuable probes in the list and they must not be "fixed".
   */
  expectAbsent?: boolean;
  /** The observed upstream behaviour, for the absent ones. */
  upstreamBehaviour?: string;
}

/** A resolved delisted entry, as written to the manifest. */
export interface DelistedEntry {
  symbol: string;
  exchange: string | null;
  assetType: string | null;
  listingId: string | null;
  listingStartDate: string | null;
  listingEndDate: string | null;
  inTiingoMaster: boolean;
  rationale: string;
  upstreamBehaviour?: string;
}

/** The subset of a master row this resolution needs, plus its derived status. */
export interface StatusedMasterRow {
  ticker: string;
  exchange: string;
  assetType: string;
  priceCurrency: string;
  startDate: string | null;
  endDate: string | null;
  status: "ACTIVE" | "DELISTED";
}

/**
 * Resolve curated specs against the Tiingo master, FAILING on any drift.
 *
 * Three things are checked, and each one is a real failure mode rather than a
 * hypothetical:
 *
 *   1. A spec marked `expectAbsent` that turns out to be PRESENT. `ENE` and
 *      `LEH` are in the list precisely because they are missing upstream and
 *      fail DIFFERENTLY (404 versus 200-with-an-empty-array). If Tiingo ever
 *      adds them, the list has silently lost its only coverage of those two
 *      paths and somebody must choose a replacement.
 *   2. A spec that matches ZERO rows, or MORE THAN ONE. More than one means the
 *      `(exchange, listingStartDate)` pair stopped being unique, which is the
 *      ambiguity `listingId` exists to prevent.
 *   3. A resolved row that is ACTIVE. A "delisted sample" made of live
 *      securities exercises none of the cold-storage path, which is the entire
 *      reason the founder asked for these.
 *
 * Every one of those aborts the run. A delisted list that quietly resolved to
 * 12 of 20 would leave the eviction path untested while the manifest still
 * claimed to cover it.
 */
export function resolveDelisted(
  specs: readonly DelistedSpec[],
  master: readonly StatusedMasterRow[],
  makeListingId: (s: string, e: string, d: string | null) => string,
): DelistedEntry[] {
  const out: DelistedEntry[] = [];

  for (const spec of specs) {
    const rows = master.filter(
      (r) => r.ticker === spec.symbol && r.priceCurrency === "USD",
    );

    if (spec.expectAbsent) {
      if (rows.length > 0) {
        throw new Error(
          `delisted spec ${spec.symbol} is marked expectAbsent but Tiingo's ` +
            `master now has ${rows.length} USD row(s) for it. It was chosen ` +
            "because it is MISSING upstream — that coverage is now gone and " +
            "a replacement probe must be chosen deliberately.",
        );
      }
      out.push({
        symbol: spec.symbol,
        exchange: null,
        assetType: null,
        listingId: null,
        listingStartDate: null,
        listingEndDate: null,
        inTiingoMaster: false,
        rationale: spec.rationale,
        upstreamBehaviour: spec.upstreamBehaviour,
      });
      continue;
    }

    const matched = rows.filter(
      (r) =>
        r.exchange === spec.exchange && r.startDate === spec.listingStartDate,
    );

    if (matched.length !== 1) {
      throw new Error(
        `delisted spec ${spec.symbol} (${spec.exchange}, from ` +
          `${spec.listingStartDate}) matched ${matched.length} master rows, ` +
          "expected exactly 1. Tiingo's master changed; re-derive the window " +
          "rather than relaxing the match — a loose match is how two " +
          `companies become one series. Candidates: ${JSON.stringify(
            rows.map((r) => `${r.exchange}/${r.assetType} ${r.startDate}`),
          )}`,
      );
    }

    const row = matched[0];
    if (row === undefined) {
      // Unreachable: the length check above is exactly `!== 1`. Kept because
      // the alternative is a non-null assertion, and an assertion is how a
      // later edit to that check turns into a silent undefined read.
      throw new Error(`delisted spec ${spec.symbol}: match vanished`);
    }
    if (row.status !== "DELISTED") {
      throw new Error(
        `delisted spec ${spec.symbol} resolved to a row Tiingo still reports ` +
          `as ACTIVE (ends ${row.endDate}). A "delisted" sample made of live ` +
          "securities exercises none of the cold-storage or eviction path.",
      );
    }

    out.push({
      symbol: spec.symbol,
      exchange: row.exchange,
      assetType: row.assetType,
      listingId: makeListingId(row.ticker, row.exchange, row.startDate),
      listingStartDate: row.startDate,
      listingEndDate: row.endDate,
      inTiingoMaster: true,
      rationale: spec.rationale,
    });
  }

  return out;
}

/**
 * Abort unless a list is at least `floor` long.
 *
 * The whole point of the file. A source that half-answers produces a short
 * list, a short list looks exactly like a successful run, and QA then tests
 * against coverage nobody knows it lost. `financial-data-sync` returned 200 and
 * wrote zero rows for five months on precisely this shape.
 */
export function assertPlausible(
  listName: string,
  actual: number,
  floor: number,
): void {
  if (actual < floor) {
    throw new Error(
      `${listName} produced only ${actual} rows, below the floor of ` +
        `${floor}. Refusing to write a manifest that would silently shrink ` +
        "QA's test coverage. Fix the source rather than lowering the floor.",
    );
  }
}

/**
 * Keep only the members of `ranked` that exist in `available`, preserving
 * `ranked`'s order.
 *
 * ## Why this is a separate, recorded step and not a `where` clause
 *
 * The failure it guards is silent by construction. Ranking mutual funds over
 * `mutual_fund_masters` and taking the top N selects schemes that may have no
 * row at all in `mf_nav_history` — 12,409 of 14,225 masters are in exactly that
 * state. The resulting manifest is well-formed, the scheme codes are real and
 * correctly typed (both collections store `schemeCode` as a STRING, so this is
 * not a type bug), the generated query is valid, and it matches 0 of 3,193,427
 * rows. The consuming sync's zero-match guard then SKIPS rather than failing,
 * so nothing anywhere reports a problem and QA simply has no NAV history.
 *
 * Doing the intersect inline would hide the same information. The caller
 * records `rankedCount` and `survivingCount` separately on purpose: a list that
 * shrinks from 100 to 6 is something the operator needs to SEE, not something
 * to quietly pad back up to 100 from the tail.
 */
export function intersectPreservingOrder(
  ranked: readonly string[],
  available: ReadonlySet<string>,
): string[] {
  return ranked.filter((x) => available.has(x));
}

/**
 * The ISINs of a set of sampled India rows, deduplicated and sorted.
 *
 * These bound `mf_portfolio_holdings` (30,501 rows), which is keyed on ISIN and
 * carries NO symbol column — so it is the one collection the symbol lists
 * cannot reach. They must be the ISINs OF THE SAMPLED COMPANIES rather than an
 * arbitrary list, or the join lands on holdings of companies the sample does
 * not otherwise contain.
 *
 * Rows with no ISIN contribute nothing rather than a `null` member: a `null` in
 * an `$in` array matches documents where the field is missing, which would
 * silently widen the slice.
 */
export function isinsOf(rows: readonly IndiaEntry[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.isin === "string" && r.isin !== "") seen.add(r.isin);
  }
  return [...seen].sort();
}

/** A candidate US mutual-fund listing, as read off Tiingo's master. */
export interface FundListing {
  ticker: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Pick the US mutual-fund sample: a curated core, then filled by LONGEVITY.
 *
 * ## Why this list has to exist at all
 *
 * `us_fund_nav`'s only writer is `us-eod-sync` leg (b), whose population is
 * `assetType === "Mutual Fund"` — 49,876 of the USD listings, 49,811 of them on
 * the NMFQS venue. The equity lists hold NONE: `us.equities` is the S&P 500,
 * `us.etfs` is validated `assetType=ETF`, and `us.delisted` is stocks. So
 * sampling that table against the equity symbols matched zero rows, the
 * empty-guard skipped it, and the run exited 0 reporting success — the same
 * defect one layer down from the one CLAUDE.md already records for the leg
 * itself ("a leg whose population is empty by construction selects nothing,
 * writes nothing and reports HEALTHY forever").
 *
 * ## Why LONGEVITY and not AUM
 *
 * For the third time in this file: there is no AUM anywhere. Not on
 * `mutual_fund_masters` (no such column), not in Tiingo's master, which carries
 * only ticker/exchange/assetType/priceCurrency/startDate/endDate. Longevity —
 * `endDate - startDate` — is one of the two things actually measurable here,
 * and it is the one that matters for this fixture: a longer series means more
 * cold shards, more year boundaries and more chances to have had a corporate
 * action. The alternative the brief offered, "simple presence in NMFQS", would
 * have been an arbitrary alphabetical slice.
 *
 * ## Why a curated core is pinned FIRST
 *
 * Splits on mutual funds are RARE, so a longevity ranking will not reliably
 * contain one, and `splitFactor` is exactly the sparse path the sampled QA
 * needs to exercise. The four split funds and two dividend funds are therefore
 * pinned ahead of the ranking, and their absence ABORTS rather than quietly
 * yielding a hundred fund tickers with no corporate action among them.
 */
export function selectUsFunds(
  population: readonly FundListing[],
  curated: readonly string[],
  target: number,
): { symbols: string[]; missingCurated: string[] } {
  const byTicker = new Map(population.map((f) => [f.ticker, f]));
  const missingCurated = curated.filter((t) => !byTicker.has(t));

  const longevity = (f: FundListing): number => {
    if (!f.startDate || !f.endDate) return -1;
    const a = Date.parse(`${f.startDate}T00:00:00Z`);
    const b = Date.parse(`${f.endDate}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
    return b - a;
  };

  const picked: string[] = curated.filter((t) => byTicker.has(t));
  const taken = new Set(picked);

  const ranked = [...population].sort((x, y) => {
    const d = longevity(y) - longevity(x);
    if (d !== 0) return d;
    return x.ticker < y.ticker ? -1 : 1;
  });

  for (const f of ranked) {
    if (picked.length >= target) break;
    if (taken.has(f.ticker)) continue;
    picked.push(f.ticker);
    taken.add(f.ticker);
  }

  return { symbols: picked, missingCurated };
}

/* qa-universe-pure:end */

/**
 * The 20 delisted US securities, and why each one is here.
 *
 * The sample must exercise the delisted path end to end — cold GCS storage,
 * on-request load, 30-day eviction. An all-active sample never touches it, and
 * that path would then reach production untested.
 *
 * Every window below was verified against Tiingo's live master on 2026-08-28.
 * The set is chosen for FAILURE-MODE SPREAD, not for name recognition:
 *
 *   2 absent upstream, failing differently (404 vs 200 + empty array)
 *   5 recycled tickers, where a bare symbol is genuinely ambiguous
 *  13 clean single-window delistings, spanning a 42-year history (AET) down to
 *     a 5-year one (LNKD), so cold-shard counts vary by an order of magnitude
 */
const DELISTED_SPECS: readonly DelistedSpec[] = [
  {
    symbol: "ENE",
    expectAbsent: true,
    upstreamBehaviour: "HTTP 404 — ticker unknown to Tiingo",
    rationale:
      "Enron. Absent from the master and 404s on the price endpoint. Pairs " +
      "with LEH: the two failures are DIFFERENT, and collapsing them is how " +
      'a permanent "not there" gets retried nightly forever.',
  },
  {
    symbol: "LEH",
    expectAbsent: true,
    upstreamBehaviour: "HTTP 200 with an EMPTY array and null metadata dates",
    rationale:
      "Lehman Brothers. Exists enough to answer 200 but holds no bars. The " +
      "success-shaped empty response — the harder of the two to handle.",
  },

  // ── Recycled tickers: the reason `listingId` exists ────────────────────
  {
    symbol: "DOW",
    exchange: "NYSE",
    listingStartDate: "1972-06-01",
    rationale:
      "Dow Chemical, 1972-2017. The canonical case: Dow Inc. holds the same " +
      "ticker on the same exchange from 2019, identical in assetType and " +
      "currency. A full-range read that concatenated them would return two " +
      "companies as one continuous series with nothing on the row saying so.",
  },
  {
    symbol: "BRKL",
    exchange: "NASDAQ",
    listingStartDate: "1998-03-25",
    rationale:
      "Brookline Bancorp, 1998-2025. Recycled ACROSS ASSET TYPES — the live " +
      "BRKL is a leveraged ETF on BATS from 2026. Named in the Candle schema " +
      "as the case that defeats permaTicker, since search resolves only the " +
      "current occupant.",
  },
  {
    symbol: "MON",
    exchange: "NYSE",
    listingStartDate: "2000-10-18",
    rationale:
      "Monsanto, 2000-2018. Recycled between TWO DEAD listings — a second, " +
      "unrelated NASDAQ MON ran 2021-2022. Neither is live, so a " +
      '"pick the active one" heuristic has nothing to pick.',
  },
  {
    symbol: "APC",
    exchange: "NYSE",
    listingStartDate: "1986-09-09",
    rationale:
      "Anadarko Petroleum, 1986-2019, acquired by Occidental. Ticker is now " +
      "live again on NASDAQ from 2026 — a dead predecessor under a live " +
      "ticker, which is the shape a naive bare-symbol read gets wrong.",
  },
  {
    symbol: "STI",
    exchange: "NYSE",
    listingStartDate: "1987-12-30",
    rationale:
      "SunTrust Banks, 1987-2019, merged into Truist. Same shape as APC with " +
      "a different live successor (NASDAQ, 2024-), so the pair guards against " +
      "a fix that happens to work for one of them.",
  },

  // ── Clean single-window delistings ────────────────────────────────────
  {
    symbol: "YHOO",
    exchange: "NASDAQ",
    listingStartDate: "1996-04-12",
    rationale:
      "Yahoo!, 1996-2017. Dot-com-era listing with a long, dense history and " +
      "a well-known terminal date.",
  },
  {
    symbol: "TWTR",
    exchange: "NYSE",
    listingStartDate: "2013-11-07",
    rationale:
      "Twitter, 2013-2022. Delisted by going PRIVATE rather than by merger — " +
      "no successor ticker exists to fall back to.",
  },
  {
    symbol: "XLNX",
    exchange: "NASDAQ",
    listingStartDate: "1990-06-18",
    rationale: "Xilinx, 1990-2022, acquired by AMD in an all-stock deal.",
  },
  {
    symbol: "ATVI",
    exchange: "NASDAQ",
    listingStartDate: "1993-10-25",
    rationale:
      "Activision Blizzard, 1993-2023. The most RECENT delisting in the set, " +
      "so its cold shards are the youngest.",
  },
  {
    symbol: "CTXS",
    exchange: "NASDAQ",
    listingStartDate: "1995-12-08",
    rationale: "Citrix Systems, 1995-2022, taken private.",
  },
  {
    symbol: "RTN",
    exchange: "NYSE",
    listingStartDate: "1981-12-31",
    rationale:
      "Raytheon, 1981-2020, merged into RTX. Long history starting on a " +
      "31 December, which is a useful year-boundary case for year-keyed " +
      "cold shards.",
  },
  {
    symbol: "MYL",
    exchange: "NASDAQ",
    listingStartDate: "1987-12-18",
    rationale: "Mylan, 1987-2020, combined into Viatris.",
  },
  {
    symbol: "TIF",
    exchange: "NYSE",
    listingStartDate: "1987-12-30",
    rationale:
      "Tiffany & Co., 1987-2021, acquired by LVMH. Ends in early January, so " +
      "its final shard holds only a handful of bars.",
  },
  {
    symbol: "CELG",
    exchange: "NASDAQ",
    listingStartDate: "1990-03-26",
    rationale: "Celgene, 1990-2019, acquired by Bristol-Myers Squibb.",
  },
  {
    symbol: "RHT",
    exchange: "NYSE",
    listingStartDate: "1999-08-11",
    rationale: "Red Hat, 1999-2019, acquired by IBM.",
  },
  {
    symbol: "AET",
    exchange: "NYSE",
    listingStartDate: "1977-01-03",
    rationale:
      "Aetna, 1977-2018, acquired by CVS. The LONGEST history in the set at " +
      "~42 years — the upper bound on cold-shard count per security.",
  },
  {
    symbol: "LNKD",
    exchange: "NYSE",
    listingStartDate: "2011-05-19",
    rationale:
      "LinkedIn, 2011-2016, acquired by Microsoft. The SHORTEST history at " +
      "~5.5 years — the lower bound, and the opposite extreme from AET.",
  },
  {
    symbol: "VIAB",
    exchange: "NASDAQ",
    listingStartDate: "2005-12-05",
    rationale:
      "Viacom class B, 2005-2019, recombined with CBS. A share-class ticker, " +
      "so it covers the multi-class shape that GOOG/GOOGL has on the live side.",
  },
];

/**
 * Static fallback: 100 large, liquid US ETFs.
 *
 * ## Read the method field before trusting this as a ranking
 *
 * The brief asked for "the top 100 US ETFs by AUM". WE HAVE NO AUM SOURCE — not
 * in prod, not in Tiingo's master, not anywhere in this repo. So this list is
 * honestly labelled `static-fallback` in the manifest and it is NOT an
 * authoritative AUM ranking. It is a curated set of large, well-known,
 * high-liquidity US ETFs spanning the categories a sample ought to exercise:
 * broad-market, factor, sector, international, fixed income across the curve,
 * commodity, and leveraged/inverse.
 *
 * What it IS checked for is existence: every ticker below is verified at
 * generation time against Tiingo's master as a LIVE row with `assetType=ETF`,
 * and an unresolvable ticker aborts the run. That turns a hand-written list
 * into a checked one without overclaiming what it ranks by.
 *
 * `SPLG` is deliberately absent despite being a top-30 ETF by AUM: Tiingo's
 * master has NO row for it at all (verified 2026-08-28). The master is not
 * exhaustive, which is itself worth knowing.
 *
 * The moment `candles` holds rows, `deriveUsEtfsFromCandles` takes over and
 * this list stops being used — see `main()`.
 */
const US_ETF_STATIC: readonly string[] = [
  // Broad market / core
  "SPY", "IVV", "VOO", "VTI", "QQQ", "ITOT", "SCHX", "SCHB", "IWB",
  "DIA", "MDY", "IJH", "IJR", "VO", "VB", "RSP", "OEF",
  // Style / factor
  "VTV", "VUG", "IWF", "IWD", "VIG", "VYM", "SCHD", "QUAL", "DVY", "SDY",
  "SCHG", "IVW", "IVE",
  // International
  "VEA", "IEFA", "VWO", "IEMG", "VXUS", "EFA", "EEM", "ACWI", "URTH", "IXUS",
  "SPDW", "SCHF", "VIGI",
  // Sector
  "XLK", "VGT", "XLV", "XLE", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE",
  "XLC", "XLF", "SMH", "SOXX", "XBI", "IBB", "FDN",
  // Fixed income
  "AGG", "BND", "BNDX", "MUB", "VCIT", "LQD", "BSV", "VCSH", "TLT", "IEF",
  "SHY", "GOVT", "EMB", "HYG", "JNK", "SJNK", "USHY", "TIP", "VTIP",
  "VMBS", "MBB", "SGOV",
  // Real estate
  "VNQ", "VNQI", "REET", "IYR",
  // Commodity / precious metals
  "GLD", "SLV", "IAU", "GDX", "GDXJ", "PDBC", "USO", "UNG",
  // Income / options overlay
  "JEPI", "JEPQ", "PFF",
  // Leveraged / inverse — deliberately included: their corporate-action and
  // split behaviour is the most aggressive in the universe.
  "TQQQ", "SQQQ", "ARKK",
];

// The brief asks for 100 and `assertPlausible` enforces a FLOOR, which by
// itself would happily pass a list of 102 — as it did on the first run. A
// count is a specification here, not a minimum.
if (US_ETF_STATIC.length !== 100) {
  throw new Error(
    `US_ETF_STATIC must hold exactly 100 tickers, found ${US_ETF_STATIC.length}.`,
  );
}
if (new Set(US_ETF_STATIC).size !== US_ETF_STATIC.length) {
  throw new Error("US_ETF_STATIC contains a duplicate ticker.");
}

/**
 * The US mutual funds pinned ahead of the longevity ranking, and the MEASURED
 * fact that earns each one its slot.
 *
 * Splits on mutual funds are rare enough that a longevity ranking will not
 * reliably contain one, and `splitFactor` is a sparse path that otherwise
 * reaches production untested. Every row below was verified by fetching the
 * fund's own EOD series from Tiingo on 2026-08-28 — not taken on trust:
 *
 *   SWPPX  split 2025-08-15  x6     Schwab S&P 500 Index
 *   FCNTX  split 2018-08-10  x10    Fidelity Contrafund
 *   FSPTX  split 2018-08-10  x10    Fidelity Select Technology
 *   DODGX  split 2025-10-27  x16    Dodge & Cox Stock
 *   VFIAX  102 divCash rows, no split   Vanguard 500 Index Admiral
 *   FXAIX   62 divCash rows, no split   Fidelity 500 Index
 *
 * The two dividend funds are here because a fund that has NEVER split is the
 * control case: it proves the adjustment path leaves an unsplit series alone,
 * which a set of four splitters cannot show on its own.
 */
const US_FUND_CURATED: readonly string[] = [
  "DODGX",
  "FCNTX",
  "FSPTX",
  "FXAIX",
  "SWPPX",
  "VFIAX",
];

// ── Impure edges ──────────────────────────────────────────────────────────

interface Options {
  apply: boolean;
  env: "qa" | "prod" | null;
}

function parseOptions(argv: readonly string[]): Options {
  const args = parseUniverseCliArgs(argv, {
    bare: ["apply"],
    valued: ["env"],
  });
  const env = args.value("env");
  if (env !== undefined && env !== "qa" && env !== "prod") {
    throw new UniverseCliError(
      `--env must be "qa" or "prod", got "${env}".`,
    );
  }
  return { apply: args.has("apply"), env: env ?? null };
}

/** Fetch DATABASE_URL from Secret Manager, mirroring scripts/seed-env.sh. */
function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/**
 * Host of a Mongo URI, for display. Never prints any credential.
 *
 * Which database a number came from is the single most important thing this
 * script reports: the repo `.env` points at QA, and measuring QA while
 * believing it was prod has already produced a wrong conclusion on this branch.
 */
function maskedHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "<unparseable connection string>";
  }
}

/** The S&P 500 constituent table, or a loud failure. */
async function fetchSp500(): Promise<Sp500Constituent[]> {
  const res = await fetch(SP500_SOURCE_URL, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(
      `S&P 500 source returned HTTP ${res.status}. Refusing to continue — a ` +
        "manifest without the US equity list is not a smaller manifest, it is " +
        "a broken one.",
    );
  }
  const text = await res.text();
  const rows = parseSp500Wikitext(text);
  // The index holds ~503 share classes for 500 companies. Anything under 450
  // means the page structure moved and the parser is quietly under-matching.
  assertPlausible("us.equity.sp500", rows.length, 450);
  return rows;
}

/**
 * The data-driven US ETF path: 1-year average volume from `candles`.
 *
 * Returns null when there is nothing to derive from, which is the state today
 * (`candles` does not exist in prod). ETF-ness comes from Tiingo's master
 * because prod holds no US instrument rows to ask.
 */
async function deriveUsEtfsFromCandles(
  prisma: { candle: { count: () => Promise<number> } },
  liveEtfTickers: ReadonlySet<string>,
): Promise<string[] | null> {
  let total = 0;
  try {
    total = await prisma.candle.count();
  } catch {
    // A collection that has never been written does not exist in Mongo. That
    // is not an error state here — it is the expected one until the Tiingo
    // backfill runs.
    return null;
  }
  if (total === 0) return null;

  const since = new Date(Date.now() - 365 * 86_400_000);
  const client = prisma as unknown as {
    candle: {
      groupBy: (args: unknown) => Promise<
        Array<{ symbol: string; _avg: { volume: number | null } }>
      >;
    };
  };
  const grouped = await client.candle.groupBy({
    by: ["symbol"],
    where: { timeframe: "D1", ts: { gte: since } },
    _avg: { volume: true },
  });

  const ranked = grouped
    .filter((g) => liveEtfTickers.has(g.symbol))
    .filter((g) => typeof g._avg.volume === "number" && g._avg.volume > 0)
    .sort((a, b) => {
      const av = a._avg.volume ?? 0;
      const bv = b._avg.volume ?? 0;
      if (bv !== av) return bv - av;
      return a.symbol < b.symbol ? -1 : 1;
    })
    .slice(0, 100)
    .map((g) => g.symbol);

  // A candles table that exists but holds too few ETFs is a HALF-DONE backfill,
  // and quietly falling back would hide that. Say so and stop.
  if (ranked.length < 100) {
    throw new Error(
      `candles holds ${total} rows but only ${ranked.length} live ETFs have a ` +
        "1-year average volume — the US backfill looks partial. Refusing to " +
        "silently fall back to the static list, which would make a half-done " +
        "backfill indistinguishable from no backfill at all.",
    );
  }
  return ranked;
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  if (opts.env) process.env.DATABASE_URL = databaseUrlForEnv(opts.env);
  const uri = process.env.DATABASE_URL ?? "";
  if (!uri) {
    throw new Error("DATABASE_URL is not set (pass --env=qa|prod, or set it)");
  }

  console.log(
    `\n  QA sample universe — ${opts.apply ? "APPLY" : "DRY RUN"}` +
      `\n  database: ${maskedHost(uri)}` +
      `\n  output:   ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`,
  );

  const { prisma } = await import("@usemoney/database");

  // ── US: Tiingo master (public file, no quota) ────────────────────────
  console.log("  fetching Tiingo security master…");
  const masterRaw = await fetchSupportedTickers();
  if (masterRaw.length === 0) {
    throw new Error(
      "Tiingo's security master came back EMPTY. That is a transport or " +
        "archive failure, not a real universe — aborting rather than writing " +
        "a manifest with no US listings resolved.",
    );
  }
  const fileMax = maxEndDate(masterRaw);
  if (!fileMax) {
    throw new Error("Tiingo master has no endDate anywhere — cannot derive status");
  }
  const master: StatusedMasterRow[] = masterRaw.map((r) => ({
    ticker: r.ticker,
    exchange: r.exchange,
    assetType: r.assetType,
    priceCurrency: r.priceCurrency,
    startDate: r.startDate,
    endDate: r.endDate,
    status: deriveListingStatus(r, fileMax),
  }));
  console.log(
    `    ${master.length} rows, newest endDate ${fileMax}`,
  );

  const liveEtfTickers = new Set(
    master
      .filter(
        (r) =>
          r.assetType === "ETF" &&
          r.priceCurrency === "USD" &&
          r.status === "ACTIVE",
      )
      .map((r) => r.ticker),
  );

  // ── US: S&P 500 ──────────────────────────────────────────────────────
  console.log("  fetching S&P 500 constituents…");
  const sp500 = await fetchSp500();
  const sp500RetrievedAt = new Date().toISOString();
  console.log(`    ${sp500.length} constituents`);

  // EVERY constituent must resolve to a live USD row in Tiingo's master.
  //
  // This is the check that makes `toTiingoTicker` trustworthy instead of
  // merely plausible: measured 2026-08-28, all 502 resolve with the dash
  // spelling and 2 (`BRK.B`, `BF.B`) resolve with NEITHER spelling if the
  // normaliser is removed. An unresolvable symbol is not a smaller sample — it
  // is a member that matches zero rows while looking exactly like the 500 that
  // work, which is the failure mode this whole file exists to prevent.
  const liveUsdTickers = new Set(
    master
      .filter((r) => r.priceCurrency === "USD" && r.status === "ACTIVE")
      .map((r) => r.ticker),
  );
  const unresolved = sp500
    .map((c) => c.symbol)
    .filter((sym) => !liveUsdTickers.has(sym));
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length} S&P 500 constituent(s) do not resolve to a live ` +
        `USD row in Tiingo's master: ${unresolved.join(", ")}. They would sit ` +
        "in the manifest matching ZERO rows while every other symbol matched " +
        "fine. Most likely a ticker-spelling mismatch — Wikipedia writes " +
        "share classes with a dot (BRK.B), Tiingo with a dash (BRK-B); see " +
        "toTiingoTicker.",
    );
  }
  console.log(`    all ${sp500.length} resolve in the Tiingo master`);

  // ── US: ETFs — derived if possible, static otherwise ─────────────────
  console.log("  resolving US ETFs…");
  const derivedEtfs = await deriveUsEtfsFromCandles(
    prisma as unknown as { candle: { count: () => Promise<number> } },
    liveEtfTickers,
  );
  let usEtfMethod: string;
  let usEtfSource: string;
  let usEtfSymbols: string[];
  if (derivedEtfs) {
    usEtfMethod = "derived:prod-candles";
    usEtfSource = "candles (D1, trailing 365d average volume)";
    usEtfSymbols = derivedEtfs;
    console.log(`    ${usEtfSymbols.length} from candles`);
  } else {
    usEtfMethod = "static-fallback";
    usEtfSource =
      "curated large/liquid US ETFs; existence-validated against the Tiingo master";
    const unresolved = US_ETF_STATIC.filter((t) => !liveEtfTickers.has(t));
    if (unresolved.length > 0) {
      throw new Error(
        `static US ETF list has ${unresolved.length} ticker(s) that are not ` +
          `a LIVE ETF in Tiingo's master: ${unresolved.join(", ")}. Fix the ` +
          "list — an unresolvable ticker would select nothing and shrink the " +
          "sample without saying so.",
      );
    }
    usEtfSymbols = [...US_ETF_STATIC];
    console.log(
      `    ${usEtfSymbols.length} from the static list (candles is empty — ` +
        "the US backfill has not run)",
    );
  }
  assertPlausible("us.etf.top100", usEtfSymbols.length, 100);

  // ── US: delisted ─────────────────────────────────────────────────────
  console.log("  resolving delisted US securities…");
  const delisted = resolveDelisted(DELISTED_SPECS, master, buildListingId);
  assertPlausible("us.delisted", delisted.length, 20);
  console.log(
    `    ${delisted.length} resolved ` +
      `(${delisted.filter((d) => !d.inTiingoMaster).length} deliberately ` +
      "absent from the master)",
  );

  // ── US: mutual funds ─────────────────────────────────────────────────
  //
  // A separate list, never folded into the equity symbols: `us_fund_nav`'s
  // writer selects `assetType === "Mutual Fund"`, which the equity lists
  // contain none of.
  console.log("  selecting US mutual funds…");
  const fundPopulation: FundListing[] = master
    .filter(
      (r) =>
        r.assetType === "Mutual Fund" &&
        r.priceCurrency === "USD" &&
        r.exchange === "NMFQS" &&
        r.status === "ACTIVE",
    )
    .map((r) => ({
      ticker: r.ticker,
      startDate: r.startDate,
      endDate: r.endDate,
    }));

  const { symbols: fundSymbols, missingCurated } = selectUsFunds(
    fundPopulation,
    US_FUND_CURATED,
    100,
  );
  if (missingCurated.length > 0) {
    throw new Error(
      `the pinned US funds ${missingCurated.join(", ")} are no longer live ` +
        "NMFQS listings in Tiingo's master. They are pinned because their " +
        "splits and dividends are MEASURED, and a hundred fund tickers with " +
        "no corporate action among them would leave the sparse splitFactor " +
        "path untested while looking like a full sample.",
    );
  }
  assertPlausible("us.funds", fundSymbols.length, 100);
  const fundSymbolsSorted = [...fundSymbols].sort();
  console.log(
    `    ${fundSymbolsSorted.length} of ${fundPopulation.length} live NMFQS ` +
      `funds (${US_FUND_CURATED.length} pinned, rest by longevity)`,
  );

  // ── India: one read, then pure selection ─────────────────────────────
  console.log("  reading India quotes from the database…");
  const quotes = await prisma.latestQuote.findMany({
    select: {
      marketCap: true,
      volume: true,
      instrument: {
        select: {
          symbol: true,
          exchange: true,
          isin: true,
          name: true,
          instrumentType: true,
          isActive: true,
        },
      },
    },
  });

  const rows: IndiaQuoteRow[] = quotes
    .filter((q) => q.instrument !== null)
    .map((q) => ({
      symbol: q.instrument.symbol,
      exchange: q.instrument.exchange,
      isin: q.instrument.isin,
      name: q.instrument.name,
      instrumentType: q.instrument.instrumentType,
      isActive: q.instrument.isActive,
      marketCap: q.marketCap,
      volume: q.volume,
    }))
    .filter((r) => r.isActive && (r.exchange === "NSE" || r.exchange === "BSE"));
  console.log(`    ${rows.length} active NSE/BSE quoted rows`);

  const toEntry = (r: IndiaQuoteRow): IndiaEntry => ({
    symbol: r.symbol,
    exchange: r.exchange,
    isin: r.isin,
    name: r.name,
  });

  const equityRows = dedupeByIsin(
    rows.filter((r) => r.instrumentType === "EQUITY"),
  );
  const topEquity = topByMetric(equityRows, "marketCap", 500);
  assertPlausible("in.equities", topEquity.length, 500);

  const etfRows = dedupeByIsin(rows.filter((r) => r.instrumentType === "ETF"));
  const topEtf = topByMetric(etfRows, "volume", 100);
  assertPlausible("in.etfs", topEtf.length, 100);

  const equityEntries = stableBySymbol(topEquity.map(toEntry));
  const etfEntries = stableBySymbol(topEtf.map(toEntry));
  const equityCutoff = topEquity[topEquity.length - 1]?.marketCap ?? null;
  const etfCutoff = topEtf[topEtf.length - 1]?.volume ?? null;

  // ── India: mutual-fund scheme codes ──────────────────────────────────
  //
  // Ranked by NAV DEPTH over the NAV-BEARING population, for the reasons in the
  // header: there is no AUM column to rank by, and only 1,816 of 14,225
  // schemes have any NAV history at all.
  console.log("  ranking mutual-fund schemes by NAV depth…");
  const navGroups = await prisma.mfNavHistory.groupBy({
    by: ["schemeCode"],
    _count: { schemeCode: true },
  });
  const availableSchemes = new Set(navGroups.map((g) => g.schemeCode));
  console.log(
    `    ${availableSchemes.size} schemes have NAV history ` +
      `(of ${await prisma.mutualFundMaster.count()} masters)`,
  );

  const rankedSchemes = [...navGroups]
    .sort((a, b) => {
      const d = b._count.schemeCode - a._count.schemeCode;
      if (d !== 0) return d;
      return a.schemeCode < b.schemeCode ? -1 : 1;
    })
    .slice(0, 100)
    .map((g) => g.schemeCode);

  // A no-op today by construction — the pool IS the NAV-bearing set — but kept
  // as a real, recorded step so a future change of ranking source cannot
  // reintroduce the silent-empty-slice failure without the counts moving.
  const schemeCodes = intersectPreservingOrder(rankedSchemes, availableSchemes);
  assertPlausible("in.schemes", schemeCodes.length, 100);
  const schemeCodesSorted = [...schemeCodes].sort();

  // ── ISINs of the sampled India names ─────────────────────────────────
  const isins = isinsOf([...equityEntries, ...etfEntries]);
  assertPlausible("isins", isins.length, 500);

  // ── Validate every list against the collection it bounds ─────────────
  console.log("  validating each list against the collection it bounds…");

  interface Validation {
    list: string;
    collection: string;
    field: string;
    matched: number;
    expectedZero?: string;
  }
  const validations: Validation[] = [];

  const usSymbols = [
    ...new Set([
      ...sp500.map((c) => c.symbol),
      ...usEtfSymbols,
      ...delisted.map((d) => d.symbol),
    ]),
  ];
  const inSymbols = [
    ...new Set([
      ...equityEntries.map((e) => e.symbol),
      ...etfEntries.map((e) => e.symbol),
    ]),
  ];

  // The US tables do not exist in prod — the Tiingo backfill has never run —
  // so a zero here is the CORRECT answer, declared rather than discovered.
  const US_ABSENT =
    "the US data layer has not been backfilled: candles, us_instruments, " +
    "us_fund_nav, us_stock_news and us_corporate_actions do not exist in prod";
  for (const list of ["us.equities", "us.etfs", "us.delisted"]) {
    validations.push({
      list,
      collection: "candles",
      field: "symbol",
      matched: 0,
      expectedZero: US_ABSENT,
    });
  }
  // Stated separately rather than folded into the loop above, because the
  // reason is worth reading on its own: this list CANNOT be hit-count
  // validated today. `us_fund_nav` does not exist in prod, so a zero here is
  // an absent table and not an unmatchable symbol list, and nothing about
  // this row should be read as evidence that the fund tickers resolve. What
  // DOES back them is that every one is a live NMFQS `assetType="Mutual Fund"`
  // row in Tiingo's master at generation time, and that the six pinned funds
  // have measured splits or dividends.
  validations.push({
    list: "us.funds",
    collection: "us_fund_nav",
    field: "symbol",
    matched: 0,
    expectedZero:
      "us_fund_nav does not exist in prod — the Tiingo backfill has never " +
      "run, so this list is NOT hit-count validated. Its tickers are backed " +
      "by presence in the Tiingo master, not by rows in this table.",
  });

  const countIn = async (
    model: { count: (a: unknown) => Promise<number> },
    field: string,
    values: readonly string[],
  ): Promise<number> => model.count({ where: { [field]: { in: [...values] } } });

  validations.push({
    list: "in.equities",
    collection: "stock_flags",
    field: "symbol",
    matched: await countIn(
      prisma.stockFlag as never,
      "symbol",
      equityEntries.map((e) => e.symbol),
    ),
  });
  validations.push({
    list: "in.equities+in.etfs",
    collection: "stock_ratios",
    field: "symbol",
    matched: await countIn(prisma.stockRatios as never, "symbol", inSymbols),
  });
  validations.push({
    list: "isins",
    collection: "mf_portfolio_holdings",
    field: "isin",
    matched: await countIn(prisma.mfPortfolioHolding as never, "isin", isins),
  });
  validations.push({
    list: "schemeCodes",
    collection: "mf_nav_history",
    field: "schemeCode",
    matched: await countIn(
      prisma.mfNavHistory as never,
      "schemeCode",
      schemeCodesSorted,
    ),
  });
  validations.push({
    list: "schemeCodes",
    collection: "mutual_fund_masters",
    field: "schemeCode",
    matched: await countIn(
      prisma.mutualFundMaster as never,
      "schemeCode",
      schemeCodesSorted,
    ),
  });

  // An UNDECLARED zero is the failure this whole section exists to catch.
  const hollow = validations.filter(
    (v) => v.matched === 0 && v.expectedZero === undefined,
  );
  if (hollow.length > 0) {
    throw new Error(
      "these lists matched ZERO rows in the collection they are meant to " +
        `bound: ${hollow
          .map((v) => `${v.list} -> ${v.collection}.${v.field}`)
          .join(", ")}. A manifest that produces empty slices is worse than ` +
        "no manifest — the sync runs, reports success, and leaves QA hollow.",
    );
  }
  for (const v of validations) {
    console.log(
      `    ${v.list.padEnd(20)} ${v.collection}.${v.field} -> ` +
        `${v.matched}${v.expectedZero ? "  (expected: absent)" : ""}`,
    );
  }

  // ── Assemble, in the shape `qa-sample-plan.ts` reads ──────────────────
  const now = new Date().toISOString();
  const manifest = {
    version: SCHEMA_VERSION,
    generatedAt: now,
    generator: "scripts/ops/build-qa-sample-universe.ts",
    consumer: "scripts/ops/qa-sample-plan.ts (universeFromManifest)",
    sourceDatabase: maskedHost(uri),
    notice:
      "TEST FIXTURE — NOT a production data dependency. This file exists only " +
      "so scripts/ops/sync-prod-to-qa.sh --tier=sample can choose a bounded, " +
      "reproducible slice of prod to copy into the QA TEST database. Nothing " +
      "in a production code path may read it. It is not an index, not a " +
      "recommendation and not a redistributable dataset. Drift of a few names " +
      "between refreshes is expected and acceptable; there is no freshness " +
      "SLA and it must not be wired to a schedule.",
    consumerHints: {
      usSymbols:
        "jq -r '[.us.equities.symbols[], .us.etfs.symbols[], .us.delisted.symbols[]] | unique[]'",
      inSymbols: "jq -r '[.in.equities.symbols[], .in.etfs.symbols[]] | unique[]'",
      isins: "jq -r '.isins[]'",
      schemeCodes: "jq -r '.schemeCodes[]'",
      delistedListingIds:
        "jq -r '.us.delisted.listings[] | select(.listingId != null) | .listingId'",
    },
    us: {
      equities: {
        method: "derived:wikipedia",
        source: SP500_SOURCE_URL,
        retrievedAt: sp500RetrievedAt,
        selection:
          "every constituent in the article's #constituents table; the venue " +
          "comes from the row's {{NyseSymbol}} / {{NasdaqSymbol}} template",
        count: sp500.length,
        symbols: sp500.map((c) => c.symbol).sort(),
        entries: stableBySymbol(sp500),
      },
      etfs: {
        method: usEtfMethod,
        source: usEtfSource,
        selection:
          usEtfMethod === "derived:prod-candles"
            ? "top 100 live ETFs by trailing-365d average D1 volume"
            : "curated large/liquid US ETFs across broad-market, factor, " +
              "sector, international, fixed-income, commodity and leveraged " +
              "categories. NOT an authoritative AUM ranking — we have no AUM " +
              "source. Every ticker is verified to be a LIVE assetType=ETF " +
              "row in Tiingo's master at generation time.",
        count: usEtfSymbols.length,
        symbols: [...usEtfSymbols].sort(),
      },
      delisted: {
        method: "curated+derived:tiingo-master",
        source:
          "https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip",
        retrievedAt: now,
        selection:
          "hand-picked for FAILURE-MODE SPREAD so the cold-storage / " +
          "on-request-load / 30-day-eviction path is exercised end to end. " +
          "Tickers and their (exchange, listingStartDate) windows are " +
          "curated; listingId, assetType and the end date are derived from " +
          "Tiingo's master, and any drift aborts the generator rather than " +
          "resolving to a different company.",
        count: delisted.length,
        symbols: delisted.map((d) => d.symbol).sort(),
        listings: stableBySymbol(delisted),
      },
      funds: {
        method: "derived:tiingo-master + curated core",
        source:
          "https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip",
        retrievedAt: now,
        selection:
          "live NMFQS assetType=\"Mutual Fund\" USD listings. A separate " +
          "vector from the equity symbols because us_fund_nav's writer " +
          "(us-eod-sync leg b) selects on assetType, and the equity lists " +
          "hold no funds at all — sampling that table against them matched " +
          "zero rows while the run reported success. Six funds with MEASURED " +
          "corporate actions are pinned first (four splits, two " +
          "dividends-only as the never-split control); the remainder is " +
          "filled by LISTING LONGEVITY (endDate - startDate) desc with a " +
          "ticker tie-break. NOT by AUM — Tiingo's master carries no AUM and " +
          "neither does mutual_fund_masters.",
        rankedBy: "listing longevity (endDate - startDate), after the pinned core",
        populationSize: fundPopulation.length,
        pinned: [...US_FUND_CURATED],
        pinnedEvidence: {
          SWPPX: "split 2025-08-15 x6",
          FCNTX: "split 2018-08-10 x10",
          FSPTX: "split 2018-08-10 x10",
          DODGX: "split 2025-10-27 x16",
          VFIAX: "102 divCash rows, never split",
          FXAIX: "62 divCash rows, never split",
        },
        hitCountValidated: false,
        count: fundSymbolsSorted.length,
        symbols: fundSymbolsSorted,
      },
    },
    in: {
      equities: {
        method: "derived:prod",
        source: "latest_quotes.marketCap joined to instrument_mappings",
        retrievedAt: now,
        selection:
          "active NSE/BSE instrumentType=EQUITY rows with marketCap > 0, " +
          "deduplicated by ISIN preferring the NSE listing (2,226 of 5,185 " +
          "ISINs quote on both exchanges), ranked by marketCap desc with a " +
          "symbol tie-break, then emitted sorted by symbol so a regeneration " +
          "diffs as adds/removes rather than a reshuffle.",
        rankedBy: "latest_quotes.marketCap",
        cutoffValue: equityCutoff,
        count: equityEntries.length,
        symbols: equityEntries.map((e) => e.symbol).sort(),
        entries: equityEntries,
      },
      etfs: {
        method: "derived:prod",
        source: "latest_quotes.volume joined to instrument_mappings",
        retrievedAt: now,
        selection:
          "active NSE/BSE instrumentType=ETF rows, deduplicated by ISIN " +
          "preferring NSE, ranked by traded VOLUME desc. NOT by AUM: no AUM " +
          "field exists on any row (aum / fundAum / netAssets / expenseRatio " +
          "/ amfiSchemeCode are non-null on ZERO of 541 active ETFs) and only " +
          "ONE ETF carries a marketCap, so a market-cap ranking would select " +
          "a list of one.",
        rankedBy: "latest_quotes.volume",
        cutoffValue: etfCutoff,
        count: etfEntries.length,
        symbols: etfEntries.map((e) => e.symbol).sort(),
        entries: etfEntries,
      },
      schemes: {
        method: "derived:prod",
        source: "mf_nav_history grouped by schemeCode",
        retrievedAt: now,
        selection:
          "NOT by AUM — mutual_fund_masters has no AUM column. Drawn from the " +
          "NAV-BEARING population and ranked by NAV row count desc with a " +
          "schemeCode tie-break, because a list ranked over the full master " +
          "would mostly select schemes with zero NAV history and the sync's " +
          "zero-match guard would skip them silently.",
        rankedBy: "mf_nav_history row count per schemeCode",
        poolSize: 14225,
        withNavHistory: availableSchemes.size,
        rankedCount: rankedSchemes.length,
        survivingCount: schemeCodes.length,
        count: schemeCodesSorted.length,
        symbols: schemeCodesSorted,
      },
    },
    isins,
    schemeCodes: schemeCodesSorted,
    validation: validations,
  };

  // `universeFromManifest` reads `m.schemeCodes ?? pick(m.in?.schemes)`. Both
  // are emitted; if they ever disagree the consumer silently prefers one and
  // the other becomes a lie in a checked-in file.
  const a = JSON.stringify(manifest.schemeCodes);
  const b = JSON.stringify(manifest.in.schemes.symbols);
  if (a !== b) {
    throw new Error(
      "top-level schemeCodes and in.schemes.symbols disagree. The consumer " +
        "prefers the former, so the latter would be a silent falsehood.",
    );
  }

  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  console.log("\n  ── counts ──");
  console.log(`    us.equities  ${String(manifest.us.equities.count).padStart(4)}  ${manifest.us.equities.method}`);
  console.log(`    us.etfs      ${String(manifest.us.etfs.count).padStart(4)}  ${manifest.us.etfs.method}`);
  console.log(`    us.delisted  ${String(manifest.us.delisted.count).padStart(4)}  ${manifest.us.delisted.method}`);
  console.log(`    us.funds     ${String(manifest.us.funds.count).padStart(4)}  ${manifest.us.funds.method}`);
  console.log(`    in.equities  ${String(manifest.in.equities.count).padStart(4)}  ${manifest.in.equities.method}`);
  console.log(`    in.etfs      ${String(manifest.in.etfs.count).padStart(4)}  ${manifest.in.etfs.method}`);
  console.log(`    in.schemes   ${String(manifest.in.schemes.count).padStart(4)}  ${manifest.in.schemes.method}`);
  console.log(`    isins        ${String(isins.length).padStart(4)}  derived:prod`);
  console.log(`    usSymbols    ${String(usSymbols.length).padStart(4)}  (deduped union)`);
  console.log(`    inSymbols    ${String(inSymbols.length).padStart(4)}  (deduped union)`);

  if (!opts.apply) {
    const existing = existsSync(OUTPUT_PATH)
      ? readFileSync(OUTPUT_PATH, "utf8")
      : null;
    console.log(
      `\n  DRY RUN — nothing written. ${
        existing === null
          ? "No manifest exists yet."
          : existing === json
            ? "The on-disk manifest is already identical."
            : "The on-disk manifest DIFFERS and would be replaced."
      }\n  Re-run with --apply to write ${path.relative(
        REPO_ROOT,
        OUTPUT_PATH,
      )}.\n`,
    );
    return;
  }

  // Write-then-rename: a crash mid-write must not leave a truncated manifest
  // that still parses as JSON for the first few lists.
  const tmp = `${OUTPUT_PATH}.tmp`;
  writeFileSync(tmp, json, "utf8");
  renameSync(tmp, OUTPUT_PATH);
  console.log(
    `\n  WROTE ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${json.length} bytes)\n`,
  );
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  FAILED: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // The dynamic import means prisma may never have been constructed.
    void import("@usemoney/database")
      .then(({ prisma }) => prisma.$disconnect())
      .catch(() => {});
  });
