/**
 * tile-build-d1 — build the D1 tiles the market-data service reads.
 * MONEY-1467 (data-platform A2).
 *
 *   npx tsx scripts/jobs/tile-build-d1.ts --market=IN --limit=50
 *   npx tsx scripts/jobs/tile-build-d1.ts --market=IN --apply
 *
 * A Cloud Run JOB, not a Pub/Sub handler. A full India build is ~24,000 active
 * listings x a 5-year `DailyPrice` range, which is hours — against Pub/Sub's
 * 600s ack deadline, which is its MAXIMUM and cannot be raised. Past it Pub/Sub
 * does not wait, it REDELIVERS, so a second builder starts on the same listings
 * and both write the same objects.
 *
 * ## IT LIVES IN scripts/jobs/, NOT workers/src/jobs/
 *
 * The A2 brief says `workers/src/jobs/tile-build-d1.ts`. That directory does
 * not exist: all twelve Cloud Run jobs in this repo live in `scripts/jobs/` and
 * are bundled into the workers image by an entry in `workers/tsup.config.ts`.
 * Without that entry the job starts and dies instantly with "Cannot find module
 * /app/dist/tile-build-d1.js", which is the failure four separate comments in
 * that config already warn about.
 *
 * ## IT NEVER CALLS YAHOO
 *
 * `DailyPrice` is already a merged table with provenance: `BHAVCOPY` where
 * bhavcopy-sync parsed the exchange file, `YAHOO` only where
 * `yahoo-price-service` gap-filled or wrote a forming bar, with precedence
 * enforced by `mayWritePriceSource` (MONEY-1175). Gap-filling stays where it
 * is. A builder that fetched would be a SECOND writer racing the first, on a
 * table whose whole design is one declared authority order.
 *
 * What it does instead is COUNT: `yahoo_fill_sessions` per listing, into the
 * manifest and out as a metric. A rising number is a bhavcopy-sync defect, and
 * without this nobody would see it — a Yahoo-filled bar renders identically to
 * an exchange one.
 *
 * ## FAIL CLOSED ON THE STORE
 *
 * With no tile store registered every write is a silent no-op and the port's
 * reader answers `absent`, so the job would walk every listing, report success,
 * and store nothing. It refuses to start instead.
 */
import { prisma } from "@usemoney/database";
import {
  listGoldTileListings,
  readGoldAdjustedBars,
  type GoldAdjustedBar,
} from "@usemoney/lake/gold";
import {
  ADJUSTMENT_POLICY_VERSION,
  TILE_FORMAT_VERSION,
  applyAdjustments,
  buildTilesFromBars,
  decodeTile,
  encodeTile,
  fingerprintActions,
  loadAdjustingActions,
  missingTileRefusal,
  mustReadDeepHistory,
  rebuildReason,
  rewritesClosedYears,
  shardOf,
  tileKey5y,
  zeroWriteRefusal,
  tileKeyYear,
  tileManifestKey,
  type ManifestEntry,
  type SourcedBar,
  type TileBuiltFrom,
  type TileManifest,
  type TileMarket,
} from "@usemoney/core/market-data/tiles/tile-logic";
import {
  FIVE_Y_TILE_CACHE_CONTROL,
  MANIFEST_CACHE_CONTROL,
  TILE_CONTENT_TYPE,
  YEAR_TILE_CACHE_CONTROL,
  getTileStore,
  readTile,
} from "@usemoney/core/market-data/tiles/tile-store";
import type { AdjustingAction } from "@usemoney/core/market-data";
import { toHistoricalBar } from "@usemoney/core/market-data/prices/yahoo-price-logic";
import { initTileStore } from "../../workers/src/lib/tile-store-gcs";

export const JOB_NAME = "tile-build-d1";

/**
 * How far back a FIRST build reads.
 *
 * India's `daily_prices` starts in the 1990s and the reader will ask for up to
 * thirty years, so a first build has to read the lot or the year tiles can only
 * ever duplicate the 5y window. Incremental builds read the 5y window only.
 */
const DEEP_HISTORY_FROM_YEAR = 1990;

/** Listings per batch. Kept small so one slow listing cannot stall a shard. */
const BATCH_SIZE = 200;

interface Args {
  market: TileMarket;
  apply: boolean;
  limit: number | null;
  onlyListing: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const market = (get("market") ?? "IN").toUpperCase();
  if (market !== "IN" && market !== "US") {
    throw new Error(`--market must be IN or US, got ${JSON.stringify(market)}`);
  }
  const limitRaw = get("limit");
  const limit = limitRaw === null ? null : Number(limitRaw);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got ${limitRaw}`);
  }
  return {
    market: market as TileMarket,
    // `--apply` ASKS. Without it the job reads and reports and writes nothing,
    // which is what makes a first run against prod safe to look at.
    apply: argv.includes("--apply"),
    limit,
    onlyListing: get("listing"),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Sharding
   ──────────────────────────────────────────────────────────────────────── */

function shardConfig(): { index: number; count: number } {
  const idx = Number(process.env["CLOUD_RUN_TASK_INDEX"] ?? "0");
  const cnt = Number(process.env["CLOUD_RUN_TASK_COUNT"] ?? "1");
  // `Number.isInteger`, not truthiness: task 0 is a real shard, and `|| 1`
  // would silently turn a single-task execution into an unsharded one — the
  // same class of bug as `isScheduledShard` (MONEY-1379).
  return {
    index: Number.isInteger(idx) && idx >= 0 ? idx : 0,
    count: Number.isInteger(cnt) && cnt >= 1 ? cnt : 1,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Manifest
   ──────────────────────────────────────────────────────────────────────── */

/**
 * One manifest OBJECT PER SHARD, merged on read — MONEY-1467 finding 6.
 *
 * Every task used to load the whole manifest, mutate only its own listings and
 * `put` the whole object at the end, so with `CLOUD_RUN_TASK_COUNT > 1` all but
 * the last shard's entries were lost. The next run read those listings as
 * `no-entry` and rebuilt them in full — including their closed-year tiles,
 * because the lost `years` arrays no longer said they existed. Latent only
 * because the provisioner sets no `--tasks`, and the sharding code exists
 * precisely to be turned on.
 *
 * A per-shard key removes the race rather than narrowing it: no two writers
 * ever touch one object.
 */
function shardManifestKey(
  market: TileMarket,
  index: number,
  count: number,
): string {
  const base = tileManifestKey(market);
  return count <= 1
    ? base
    : base.replace(/\.json$/, `.${index}-of-${count}.json`);
}

async function loadManifest(
  market: TileMarket,
  shard = { index: 0, count: 1 },
): Promise<TileManifest> {
  // Read EVERY shard's manifest, so a listing that moved between shards (a
  // changed `--tasks`) is still seen as built.
  if (shard.count > 1) {
    const merged: TileManifest = {};
    for (let i = 0; i < shard.count; i++) {
      const got = await readTile(shardManifestKey(market, i, shard.count));
      if (got.status === "failed") {
        throw new Error(
          `tile manifest shard ${i}/${shard.count} is unreadable (${got.error.message}); ` +
            'refusing to treat that as "nothing is built"',
        );
      }
      if (got.status === "absent") continue;
      Object.assign(
        merged,
        JSON.parse(got.body.toString("utf8")) as TileManifest,
      );
    }
    return merged;
  }
  const outcome = await readTile(tileManifestKey(market));
  if (outcome.status === "failed") {
    // REFUSE. Treating an unreadable manifest as empty would rebuild every
    // listing on the platform against a paid egress bill, and — worse — would
    // do it every night, reporting success, for as long as the read kept
    // failing. "Cannot read" is not "nothing is built".
    throw new Error(
      `tile manifest is unreadable (${outcome.error.message}); refusing to treat that as "nothing is built"`,
    );
  }
  if (outcome.status === "absent") return {};
  try {
    return JSON.parse(outcome.body.toString("utf8")) as TileManifest;
  } catch (err) {
    throw new Error(
      `tile manifest is not JSON (${err instanceof Error ? err.message : String(err)}); ` +
        "refusing to overwrite it with a fresh one, which would discard every year tile's record",
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   India
   ──────────────────────────────────────────────────────────────────────── */

interface Listing {
  listingId: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  /** India only — what the chart's action query matches besides `symbol`. */
  isin?: string | null;
  previousSymbols?: string[];
  /**
   * US only — `gold.chart_tile_manifest.actions_fingerprint`.
   *
   * India fingerprints `corporate_action` rows from Mongo. The US path has no
   * such table and used to pass `[]`, so its fingerprint was the constant
   * "none" and a new US split never triggered `actions-changed` — leaving every
   * CLOSED YEAR tile on the pre-split basis while the 5-year tile moved. Gold
   * computes it from the same `div_cash` / `split_factor` columns the
   * adjustment itself reads, which is the only version of this that cannot
   * disagree with the adjustment.
   */
  actionsFingerprint?: string;
}

async function indiaListings(args: Args): Promise<Listing[]> {
  if (args.onlyListing) {
    const [symbol, exchange] = args.onlyListing.split(":");
    const row = await prisma.instrumentMapping.findFirst({
      where: { symbol, exchange, isActive: true },
      select: INDIA_LISTING_SELECT,
    });
    return row ? [indiaListing(row)] : [];
  }
  const rows = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      exchange: { in: ["NSE", "BSE"] },
      instrumentType: "EQUITY",
    },
    select: INDIA_LISTING_SELECT,
    ...(args.limit ? { take: args.limit } : {}),
    orderBy: { symbol: "asc" },
  });
  return rows.map(indiaListing);
}

const INDIA_LISTING_SELECT = {
  id: true,
  symbol: true,
  exchange: true,
  isin: true,
  previousSymbols: true,
} as const;

function indiaListing(r: {
  id: string;
  symbol: string;
  exchange: string;
  isin: string | null;
  previousSymbols: string[];
}): Listing {
  return {
    listingId: `${r.symbol}:${r.exchange}`,
    instrumentId: r.id,
    symbol: r.symbol,
    exchange: r.exchange,
    isin: r.isin,
    previousSymbols: r.previousSymbols,
  };
}

async function indiaBars(
  instrumentId: string,
  sinceYear: number,
): Promise<SourcedBar[]> {
  const rows = await prisma.dailyPrice.findMany({
    where: { instrumentId, date: { gte: new Date(Date.UTC(sinceYear, 0, 1)) } },
    select: {
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      source: true,
      // A Yahoo row's fetch instant — the actions Yahoo had already applied.
      // Without it every Yahoo row is divided by the whole timeline again, the
      // MONEY-1382 double adjustment, and prod charts read tiles. MONEY-1541.
      createdAt: true,
    },
    orderBy: { date: "asc" },
  });
  return rows.map((r) => toHistoricalBar({ ...r, adjClose: null }));
}

/**
 * The chart's own loader — MONEY-1541. It was `{symbol, exchange}` selecting
 * `exDate, type, ratio`, so a tile disagreed with the live chart twice over:
 * it missed a bonus the other exchange filed (RELIANCE's Oct-2024 arrived from
 * BSE only) and the rows the chart matches by former symbol or ISIN; and with
 * no `details` or `source` it divided a detector cliff by its SNAPPED ratio and
 * could not apply the DERIVED rules at all.
 *
 * Another company's filings under the same ticker are refused (MONEY-1543) and
 * counted, as are the rows whose issuer nobody can name — those stay admitted.
 */
async function indiaActions(
  listing: Listing,
  counters: BuildCounters,
): Promise<AdjustingAction[]> {
  const { actions, refused, unknownIssuer } = await loadAdjustingActions(
    prisma,
    listing,
  );
  counters.actionsRefused += refused.length;
  counters.actionsIssuerUnknown += unknownIssuer;
  return actions;
}

/* ─────────────────────────────────────────────────────────────────────────
   US — MONEY-1467 finding 2, then MONEY-1506 (B4)
   ────────────────────────────────────────────────────────────────────────

   `main()` used to call `indiaListings()` unconditionally and `buildOne()` used
   to call `indiaBars`/`indiaActions` with no market branch, so `--market=US`
   reached exactly ONE place: the tile KEY. The US job therefore read NSE/BSE
   equities out of `instrumentMapping`, wrote them to `tiles/US/d1/{SYM}:{NSE}/`,
   stamped `built_from: "dailyprice"`, reported `built=N` and exited 0 — India's
   prices published as America's, with nothing anywhere reporting a problem.
   The reader could never surface it either: `resolveListing` builds three-part
   US listing ids, which can never match a two-part India key.

   ## B4 — THE SOURCE IS NOW `lake_gold.adjusted_bar_d1`

   Both halves moved, population and bars, because splitting them would be
   worse than either: the population came from a Mongo `$group` over `candles`
   while the bars would come from BigQuery, so a listing gold has never heard of
   would be walked every night and produce nothing, and one gold holds and Mongo
   does not would never be tiled at all. The lake is one answer to both
   questions.

   What that DELETED, and why none of it is a weakened guard:

     - a `$runCommandRaw` aggregation with a hand-sized `batchSize` and a
       cursor-not-exhausted refusal (MONEY-1479: Prisma's `distinct` on MongoDB
       is client-side, so `findMany({distinct})` loaded 20,268,060 rows to reach
       14,258 listings and was OOM-killed nightly). `chart_tile_manifest` is one
       row per listing — there is no cursor to truncate and nothing to page.
     - `CandleRepository`'s hot-Mongo + cold-GCS merge and its adjustment.
       `adjusted_bar_d1` carries `adj_*` computed by SQL that is proven equal to
       the same TypeScript `CandleRepository` used
       (packages/core/__tests__/market-data/adjustment-sql-parity.test.ts).

   STILL ADJUSTED ON ARRIVAL, so the US path STILL does not call
   `applyAdjustments`. Doing both would apply every split twice and halve a
   decade of prices, silently — the same trap as before the switch, one
   producer over.

   READS ARE BATCHED. ~14,000 US listings at one BigQuery job each is hours of
   latency and a billed 10 MB minimum per job, so a batch is fetched in one
   query and sliced per listing in Node. */

async function usListings(args: Args): Promise<Listing[]> {
  if (args.onlyListing) {
    const [symbol, exchange] = args.onlyListing.split(":");
    if (!symbol || !exchange) return [];
    // Even for ONE listing the fingerprint has to come from gold, or a
    // `--listing` rebuild would write an entry whose `actions_fingerprint`
    // disagrees with every other entry's and rebuild itself for ever.
    const all = await listGoldTileListings("US", null);
    const hit = all.find((l) => l.listingId === args.onlyListing);
    return hit
      ? [
          {
            listingId: hit.listingId,
            instrumentId: "",
            symbol: hit.symbol,
            exchange: hit.exchange,
            actionsFingerprint: hit.actionsFingerprint,
          },
        ]
      : [];
  }
  const rows = await listGoldTileListings("US", args.limit);
  return rows.map((r) => ({
    listingId: r.listingId,
    instrumentId: "",
    symbol: r.symbol,
    exchange: r.exchange,
    actionsFingerprint: r.actionsFingerprint,
  }));
}

/**
 * Adjusted bars for a whole batch, grouped by listing.
 *
 * `fromYear` is the OLDEST any listing in the batch needs — a batch holding one
 * first-build listing would otherwise be read twice. The per-listing window is
 * re-applied in `buildOne`, so an incremental listing still sees only its own
 * five years and the extra rows are discarded rather than tiled.
 */
async function usBarsForBatch(
  listings: readonly Listing[],
  fromYear: number,
): Promise<Map<string, SourcedBar[]>> {
  const rows: GoldAdjustedBar[] = await readGoldAdjustedBars({
    market: "US",
    listingIds: listings.map((l) => l.listingId),
    fromYear,
  });
  const out = new Map<string, SourcedBar[]>();
  for (const r of rows) {
    const list = out.get(r.listingId) ?? [];
    list.push({
      // `YYYY-MM-DD` is a session DATE, so it is read as UTC midnight — the
      // same instant `indiaBars` produces from `DailyPrice.date`, and the one
      // `buildTilesFromBars` re-files into venue-local years.
      date: new Date(`${r.sessionDate}T00:00:00.000Z`),
      open: r.adjOpen,
      high: r.adjHigh,
      low: r.adjLow,
      close: r.adjClose,
      volume: r.adjVolume,
      source: r.source,
    });
    out.set(r.listingId, list);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   Build
   ──────────────────────────────────────────────────────────────────────── */

export interface BuildCounters {
  /** Tiles actually PUT. Becomes `written` in the job outcome. */
  built: number;
  /**
   * Listings with NO bars at all — no tile written.
   *
   * Measured on prod 2026-09-16: 20,718 active NSE/BSE rows typed `EQUITY`, of
   * which only 8,137 carry an ISIN. The rest are bond/debt codes (MONEY-1298 —
   * ~61% of that table was never equity) with no `DailyPrice`, so a full build
   * would write ~12,581 zero-bar objects every night and file a manifest entry
   * for each.
   *
   * NOT fixed by filtering on ISIN, which is the tempting one-liner and the
   * documented trap: `AUGMONT ENTERPRISES` is a real, newly-listed NSE company
   * with no ISIN yet, and CLAUDE.md is explicit that absence of an ISIN is a
   * NECESSARY GATE, never a sufficient signal. Dropping the listing set that
   * way deletes real companies from the chart.
   *
   * So the filter is the BARS, which is the thing that actually decides whether
   * a tile has content: no bars, no tile. The reader already answers `absent`
   * as `no_data`, which is the correct response for a listing with no history.
   */
  skippedNoBars: number;
  /**
   * Tiles written with ZERO bars — counted apart from `built`.
   *
   * The first real run reported `built=50, written=50` over FIFTY EMPTY tiles:
   * the alphabetically-first 50 rows typed `EQUITY` are bond codes
   * (MONEY-1298 — ~61% of that table was never equity), and none has a
   * `DailyPrice`. Every counter said success.
   *
   * An empty tile is not always wrong — a newly-listed instrument legitimately
   * has none — but a run that wrote NOTHING BUT empty tiles is a selection
   * defect, and `written` alone can never say so. This repo's own rule:
   * 0-counts are red flags, so the zero has to be countable.
   */
  builtEmpty: number;
  /**
   * Tiles a dry run WOULD have written. A separate counter because `built`
   * feeds the job outcome's `written` field: incrementing it in the dry-run branch
   * made a permanently un-armed nightly job emit a healthy non-zero `written`
   * every night against an empty bucket — a metric that is not merely useless
   * but actively reassuring.
   */
  wouldBuild: number;
  skipped: number;
  failed: number;
  yahooFillSessions: number;
  /** India actions another issuer filed under the same ticker — MONEY-1543. */
  actionsRefused: number;
  /** India actions admitted because no issuer could be named for them. */
  actionsIssuerUnknown: number;
}

/**
 * How far back this listing's build reads — finding 7, extracted so `main` can
 * size a BATCH query from the same rule rather than a second copy of it.
 *
 * A FIRST build reads everything; an incremental one reads the 5y window only,
 * because closed year tiles are immutable and already written — UNLESS this
 * build must rewrite them (`mustReadDeepHistory`, MONEY-1541), which only a
 * build that reads them can do.
 */
function readFromYearFor(
  entry: ManifestEntry | undefined,
  now: Date,
  identity: { builtFrom: TileBuiltFrom; actionsFingerprint?: string },
): number {
  const windowStartYear = now.getUTCFullYear() - 4;
  return mustReadDeepHistory(entry, {
    policyVersion: ADJUSTMENT_POLICY_VERSION,
    formatVersion: TILE_FORMAT_VERSION,
    ...identity,
  })
    ? DEEP_HISTORY_FROM_YEAR
    : windowStartYear - 1;
}

/**
 * What a listing's tiles are built FROM, as far as it is known before a read.
 * India's fingerprint needs its actions, which are only queried once there are
 * bars — so an India `actions-changed` is caught after the read, in `buildOne`.
 */
function knownIdentity(listing: Listing, isUs: boolean) {
  return isUs
    ? {
        builtFrom: "gold" as const,
        actionsFingerprint: listing.actionsFingerprint ?? "none",
      }
    : { builtFrom: "dailyprice" as const };
}

async function buildOne(
  listing: Listing,
  manifest: TileManifest,
  args: Args,
  now: Date,
  counters: BuildCounters,
  /** US only: this batch's bars, keyed by listing id. */
  prefetched?: Map<string, SourcedBar[]>,
): Promise<void> {
  const store = getTileStore();

  const isUs = args.market === "US";
  // HOW FAR BACK TO READ — finding 7. Reading from `windowStartYear - 1` meant
  // `buildTilesFromBars` could only ever emit year tiles for years the 5y tile
  // ALREADY covers: every year tile was redundant and nothing older than six
  // years was ever written, so a user scrolling past 2021 got `no_data` for
  // ever. The reader is built for thirty years (`yearsForRequest`).
  //
  // A FIRST build for a listing reads everything; an incremental one reads only
  // the 5y window, because closed year tiles are immutable and already written.
  const existing = manifest[listing.listingId];
  const readFromYear = readFromYearFor(
    existing,
    now,
    knownIdentity(listing, isUs),
  );
  // US bars were fetched for the whole BATCH in one BigQuery job; the
  // per-listing window is re-applied here so an incremental listing still sees
  // only its own five years even when a first-build neighbour widened the
  // query.
  const barsSince = Date.UTC(readFromYear, 0, 1);
  if (isUs && !prefetched) {
    // REFUSE rather than read `undefined` as "no bars". A missing prefetch
    // would give every US listing zero bars, `skippedNoBars` would count the
    // whole market, and the run would exit 0 having tiled nothing — the
    // silent-zero shape `zeroWriteRefusal` exists for one layer up.
    throw new Error(
      `${listing.listingId}: the US path needs its batch prefetched from ` +
        "gold.adjusted_bar_d1; an absent map is not an empty market",
    );
  }
  let bars = isUs
    ? (prefetched?.get(listing.listingId) ?? []).filter(
        (b) => b.date.getTime() >= barsSince,
      )
    : await indiaBars(listing.instrumentId, readFromYear);
  const sourceMax = bars.length ? bars[bars.length - 1]!.date : null;

  // The ACTIONS are part of the tile's identity, not just the bars. A new
  // split changes every bar BEFORE its ex-date, which is mostly deep history —
  // so without this the 5y tile is rebuilt on the new basis, the year tiles
  // keep the old one, and the chart shows a step discontinuity exactly at the
  // five-year boundary. `ManifestEntry` carries the fingerprint so the decision
  // is recorded rather than recomputed from something that has already changed.
  // NO BARS, NO TILE. Writing one is not harmless: it costs an object and a
  // manifest entry per listing, nightly, and it makes `built` a number that
  // cannot distinguish "we tiled the market" from "we tiled the bond table".
  // A listing that genuinely has no history is correctly served as `no_data`
  // by the reader's `absent` path.
  if (bars.length === 0) {
    counters.skippedNoBars++;
    return;
  }

  const actions = isUs ? [] : await indiaActions(listing, counters);
  // US: gold computes the fingerprint from the SAME `div_cash` / `split_factor`
  // columns the adjustment reads, so it cannot disagree with the adjustment.
  // India: from its own `corporate_action` rows. `"none"` is the shared literal
  // for "this listing has no actions" — `fingerprintActions([])` returns it too.
  const actionsFingerprint = isUs
    ? (listing.actionsFingerprint ?? "none")
    : fingerprintActions(actions);
  const builtFrom: TileBuiltFrom = isUs ? "gold" : "dailyprice";

  const reason = rebuildReason(manifest[listing.listingId], {
    sourceMaxDate: sourceMax,
    policyVersion: ADJUSTMENT_POLICY_VERSION,
    formatVersion: TILE_FORMAT_VERSION,
    actionsFingerprint,
    builtFrom,
  });
  if (reason === null) {
    counters.skipped++;
    return;
  }
  // India's changed ACTIONS are only known now. Their closed years are
  // rewritten below, which needs every year read — see `mustReadDeepHistory`.
  if (
    !isUs &&
    rewritesClosedYears(reason) &&
    readFromYear > DEEP_HISTORY_FROM_YEAR
  ) {
    bars = await indiaBars(listing.instrumentId, DEEP_HISTORY_FROM_YEAR);
  }

  // US bars arrive ALREADY adjusted from `gold.adjusted_bar_d1` (the `adj_*`
  // columns); re-adjusting would apply every split twice and halve a decade of
  // prices, silently.
  const adjusted = isUs
    ? { bars, actionsUsed: 0, actionsIgnored: 0 }
    : applyAdjustments(bars, actions);
  const built = buildTilesFromBars(adjusted.bars as SourcedBar[], now, {
    market: args.market,
    listingId: listing.listingId,
    instrumentId: listing.instrumentId,
  });

  const yahooFills = built.fiveY.sources.filter((s) => s === "YAHOO").length;
  counters.yahooFillSessions += yahooFills;

  if (!args.apply) {
    counters.wouldBuild++;
    // COUNTED HERE TOO. The documented first run is a DRY run, and it is the
    // very run that produced "50 tiles, every counter says success" over 50
    // empty ones. An alarm that can only fire after `--apply` cannot fire on
    // the execution an operator actually does first.
    if (built.fiveY.bars.length === 0) counters.builtEmpty++;
    return;
  }
  if (!store) throw new Error("no tile store registered");

  await store.put(
    tileKey5y(args.market, listing.listingId),
    encodeTile(built.fiveY),
    TILE_CONTENT_TYPE,
    FIVE_Y_TILE_CACHE_CONTROL,
  );

  const existingYears = new Set(manifest[listing.listingId]?.years ?? []);
  const years: number[] = [...existingYears];
  for (const { year, tile } of built.years) {
    // A closed year is written ONCE. It is rewritten only when the policy or
    // format moved — which is exactly what `reason` tells us, so an ordinary
    // "the source advanced" night does not rewrite a decade of immutable
    // objects for one new session.
    // "actions-changed" joins these two: a new split re-bases every bar before
    // its ex-date, and those live in the year tiles.
    // "source-changed" joins them for the same reason: the producer moved, so
    // a closed year written by the old one is on a basis this run cannot
    // vouch for.
    const mustRewrite = rewritesClosedYears(reason);
    if (existingYears.has(year) && !mustRewrite) continue;
    await store.put(
      tileKeyYear(args.market, listing.listingId, year),
      encodeTile(tile),
      TILE_CONTENT_TYPE,
      YEAR_TILE_CACHE_CONTROL,
    );
    if (!existingYears.has(year)) years.push(year);
  }

  const entry: ManifestEntry = {
    years: years.sort((a, b) => a - b),
    five_y_built_at: built.fiveY.header.built_at,
    adjustment_policy_version: ADJUSTMENT_POLICY_VERSION,
    tile_format_version: TILE_FORMAT_VERSION,
    source_max_date: sourceMax ? sourceMax.toISOString() : null,
    built_from: builtFrom,
    actions_fingerprint: actionsFingerprint,
    yahoo_fill_sessions: yahooFills,
  };
  manifest[listing.listingId] = entry;
  counters.built++;
  if (built.fiveY.bars.length === 0) counters.builtEmpty++;
}

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB_NAME}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB_NAME}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB_NAME}]`, ...a),
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<BuildCounters> {
  const started = Date.now();

  const args = parseArgs(argv);
  const counters: BuildCounters = {
    built: 0,
    builtEmpty: 0,
    skippedNoBars: 0,
    wouldBuild: 0,
    skipped: 0,
    failed: 0,
    yahooFillSessions: 0,
    actionsRefused: 0,
    actionsIssuerUnknown: 0,
  };
  const failures: string[] = [];
  /** First listing this shard SKIPPED, read back at the end to prove the
   *  bucket agrees with the manifest. See `missingTileRefusal`. */
  let verifyListingId: string | null = null;

  // FAIL CLOSED. Without a store every write is a silent no-op, so the job
  // would walk every listing and report success having stored nothing.
  if (args.apply && !initTileStore()) {
    throw new Error(
      "--apply was given but no tile store is registered (LAKE_ENV/DD_ENV must be qa or prod). " +
        "Refusing to run: every write would be a no-op and the run would report success.",
    );
  }

  const { index, count } = shardConfig();
  const manifest = args.apply
    ? await loadManifest(args.market, { index, count })
    : {};
  const now = new Date();

  const all =
    args.market === "US" ? await usListings(args) : await indiaListings(args);
  const mine = all.filter((l) => shardOf(l.listingId, count) === index);
  console.log(
    `[${JOB_NAME}] market=${args.market} shard=${index}/${count} listings=${mine.length}/${all.length} apply=${args.apply}`,
  );

  for (let i = 0; i < mine.length; i += BATCH_SIZE) {
    const batch = mine.slice(i, i + BATCH_SIZE);
    // ONE BigQuery job per batch, not per listing. ~14,000 US listings at one
    // job each is hours of latency and a billed 10 MB minimum apiece. The year
    // asked for is the OLDEST any listing in the batch needs — `buildOne`
    // re-applies each listing's own window to what comes back.
    let prefetched: Map<string, SourcedBar[]> | undefined;
    if (args.market === "US" && batch.length > 0) {
      const fromYear = Math.min(
        ...batch.map((l) =>
          readFromYearFor(manifest[l.listingId], now, knownIdentity(l, true)),
        ),
      );
      prefetched = await usBarsForBatch(batch, fromYear);
    }
    for (const listing of batch) {
      try {
        // Which listing gets read back at the end — see `missingTileRefusal`.
        // Taken by watching the SKIPPED counter move rather than by having
        // `buildOne` report it: a skip is the only outcome whose tile this run
        // did not itself `put`, and so the only one whose presence in the
        // bucket is still an open question.
        const skippedBefore = counters.skipped;
        await buildOne(listing, manifest, args, now, counters, prefetched);
        if (verifyListingId === null && counters.skipped > skippedBefore) {
          verifyListingId = listing.listingId;
        }
      } catch (err) {
        counters.failed++;
        // NAMED, and capped: a run that fails on every listing must not
        // produce a 24,000-line log nobody reads.
        if (failures.length < 20) {
          failures.push(
            `${listing.listingId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    console.log(
      `[${JOB_NAME}] ${Math.min(i + BATCH_SIZE, mine.length)}/${mine.length} built=${counters.built} skipped=${counters.skipped} failed=${counters.failed}`,
    );
  }

  if (args.apply) {
    const store = getTileStore();
    if (store) {
      // Only THIS shard's entries, to its OWN key. (`mine` is the shard's
      // listing list; the subset gets its own name.)
      const shardEntries: TileManifest = {};
      for (const l of mine) {
        const e = manifest[l.listingId];
        if (e) shardEntries[l.listingId] = e;
      }
      await store.put(
        shardManifestKey(args.market, index, count),
        Buffer.from(
          JSON.stringify(count > 1 ? shardEntries : manifest),
          "utf8",
        ),
        TILE_CONTENT_TYPE,
        MANIFEST_CACHE_CONTROL,
      );
    }
  }

  if (failures.length)
    console.error(`[${JOB_NAME}] failures:\n  ${failures.join("\n  ")}`);

  // A RUN THAT WROTE NOTHING IS NEVER HEALTHY — see `zeroWriteRefusal`.
  const refusal = zeroWriteRefusal({
    apply: args.apply,
    walked: mine.length,
    // The PRE-SHARD population. Without it a selector that matches nothing
    // platform-wide exempts every shard and the run reports success.
    population: all.length,
    built: counters.built,
    builtEmpty: counters.builtEmpty,
    skipped: counters.skipped,
  });
  if (refusal) throw new Error(refusal);

  // AND THE BUCKET MUST AGREE WITH THE MANIFEST — see `missingTileRefusal`.
  // One GET, after the manifest write so a legitimate run is already durable.
  // The counters above are in-process bookkeeping and cannot see a bucket
  // whose objects are gone; this is the only assertion in the run that asks
  // storage anything.
  if (args.apply && verifyListingId) {
    const back = await readTile(tileKey5y(args.market, verifyListingId));
    const missing = missingTileRefusal({
      apply: args.apply,
      listingId: verifyListingId,
      outcome: back.status,
    });
    if (missing) throw new Error(missing);
    console.log(
      `[${JOB_NAME}] verified tiles/${args.market}/ against the manifest via ${verifyListingId}`,
    );
  }

  // A run whose output is ENTIRELY empty tiles selected the wrong population.
  // Said at WARN with the numbers, because every other counter reports success.
  // A run whose output is MOSTLY empty tiles selected the wrong population.
  //
  // A RATIO, not equality. The first version fired only when EVERY tile was
  // empty, and the run that proved the counter works reported `builtEmpty=46
  // wouldBuild=50` — 92% empty, no warning. Four real equities among fifty bond
  // codes is the same defect as fifty; "all of them" is a threshold that a
  // single lucky row disarms.
  //
  // An empty tile is not always wrong — a newly-listed instrument has no bars —
  // so a healthy build sits near zero, nowhere near half.
  const produced = counters.built + counters.wouldBuild;
  const emptyRatio = produced > 0 ? counters.builtEmpty / produced : 0;
  if (produced > 0 && emptyRatio > 0.5) {
    console.warn(
      `[${JOB_NAME}] WARNING: ${counters.builtEmpty} of ${produced} tiles ` +
        `${args.apply ? "written" : "that WOULD be written"} are EMPTY ` +
        `(${(emptyRatio * 100).toFixed(0)}%, zero bars). Every other counter reports success. ` +
        "Check the listing selection — rows typed EQUITY include bond/debt codes " +
        "with no DailyPrice (MONEY-1298).",
    );
  }

  console.log(
    `[${JOB_NAME}] done built=${counters.built} skipped=${counters.skipped} ` +
      `builtEmpty=${counters.builtEmpty} noBars=${counters.skippedNoBars} ` +
      `wouldBuild=${counters.wouldBuild} ` +
      `failed=${counters.failed} ` +
      `yahoo_fill_sessions=${counters.yahooFillSessions} ` +
      `actions_refused=${counters.actionsRefused} ` +
      `actions_issuer_unknown=${counters.actionsIssuerUnknown} ` +
      `elapsed=${Math.round((Date.now() - started) / 1000)}s`,
  );

  // The COUNTERS go back to the entry point, which owns the outcome report.
  // A job's exit code IS its Cloud Run status, so reporting 0 over failures is
  // the difference between an alert and a silent gap — the entry sets it.
  return counters;
}

// NO self-invocation here: this file is the shared IMPLEMENTATION, not a tsup
// entry. The two entries are `tile-build-d1-in.ts` and `tile-build-d1-us.ts`,
// which exist because the release's re-pin loop, SETUP_SCRIPT_BY_ENTRYPOINT and
// job-build-provenance.test.ts all key on one tsup entry per Cloud Run job —
// and the two markets must be two jobs, because they follow different producers
// on different schedules.
