/**
 * `identity-sync` — seed and maintain `lake_silver.listing`. MONEY-1498 (B3).
 *
 * A Cloud Run JOB, never a Pub/Sub handler. It scans the whole instrument
 * universe (74k US rows + ~27k India rows, measured 2026-08-30) and a Pub/Sub
 * push subscription's ack deadline is 600s — Pub/Sub's maximum. Past it the
 * message is REDELIVERED, so a second copy of the job starts concurrently
 * against the same table, and our own dedupe then answers the redelivery 409
 * `RETRY_LATER` while Pub/Sub counts those as delivery attempts and
 * dead-letters a job that is still running and will succeed. A job has no ack
 * deadline; the bound is its task timeout.
 *
 * ## THE SHELL. EVERY DECISION IS IN `packages/lake/src/identity-logic.ts`
 *
 * This file reads Mongo, reads BigQuery, applies `diffListings`, writes. It
 * decides nothing — not which fields version a row, not which window contains
 * an as-of, not what a method is worth.
 *
 * ## WHAT HISTORY EACH MARKET ACTUALLY HAS
 *
 * US is REAL: `UsInstrument` carries `listingStartDate` / `listingEndDate` and
 * holds DELISTED rows, so the DOW pair resolves correctly either side of 2017.
 * DELISTED ROWS ARE IN SCOPE deliberately — the nightly Tiingo legs narrow to
 * ACTIVE, and an identity table that did the same could never name the
 * predecessor half of a recycled ticker, which is the whole problem.
 *
 * INDIA is CURRENT-ONLY. `InstrumentMapping` is overwritten on every
 * instrument-sync, and NSE symbol-change history is NOT archived by this repo:
 * `packages/core/src/market-data/report-registry.ts` holds 26 families and none
 * of them is a symbolchange/namechange family (verified 2026-09-22). So India
 * map rows are written UNDATED — `valid_from` NULL, method
 * `SYMBOL_VENUE_CURRENT` — and `resolveListing` returns `dated: false` for
 * them. Writing a fabricated `valid_from` would make a guess indistinguishable
 * from knowledge, which is the failure this table exists to end.
 *
 * ## HOW A LISTING'S FIRST VERSION IS DATED — MONEY-1544
 *
 * `firstVersions` in identity-logic.ts decides; this file only supplies the
 * dates. Until MONEY-1544 every first version opened on the day this job ran
 * (2026-09-22 on prod, all 98,249), so the release `universe()` could answer
 * nothing earlier.
 *
 *   US    Tiingo's `listingStartDate`; a DELISTED listing is ACTIVE to its
 *         `listingEndDate` (inclusive) and DELISTED from the day after. An
 *         ACTIVE listing's `listingEndDate` is its latest PRICE, never a
 *         delisting — every ACTIVE row carries one (measured 2026-09-23).
 *   IN    the listing's first session in `lake_silver.price_bar_d1`. India has
 *         no inception date; the bhavcopy archive's first evidence of trading
 *         is the honest lower bound, and it is TRUNCATED by the archive: NSE
 *         from 1994-11-03, BSE from 2024-01-01. `InstrumentMapping.createdAt`
 *         was measured and rejected — all 23,912 in-scope rows were created in
 *         2026, which would claim a 1995 listing began this year. A listing
 *         with no bar falls back to the day this job first observed it.
 *   IN, NO LONGER IN THE MASTER (MONEY-1602)  an inactive `InstrumentMapping`
 *         row with bars — and a bar id NO master row carries (HDFC Ltd,
 *         RELCAPITAL: the master only holds what existed in 2026) — is a
 *         listing: ACTIVE from its first bar, DELISTED from the day after its
 *         last. An inactive row with no bars is counted and never becomes a
 *         listing. `classifyInactive` decides, including refusing everything
 *         while the bar archive is mid-rewrite.
 *
 * A change observed LATER on a listing that already exists is dated the day
 * this job observes it — except a delisting whose source names a sane end
 * (`changeDate`).
 *
 * `--rebase-history` re-dates every listing's FIRST version to its source date
 * and keeps its observed end (`planRebase`), re-stamping what it cannot move.
 * It is a dry run without `--apply`; each write is conditional on the row it
 * replaces being unchanged; a second run plans nothing. India is held back
 * until its bar archive is whole (`archiveIsCurrent`).
 *
 * ## LISTING IDS ARE BUILT BY `buildListingId`, NOT BY THIS FILE
 *
 * `Candle.listingId` and `UsInstrument.listingId` are written by that function.
 * A listing id built two ways that disagree by one character silently splits one
 * security's history into two — invisible except as a chart that goes blank
 * before a date. It is imported rather than restated.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/identity-sync.ts --env qa --seed      # dry run
 *     npx tsx scripts/jobs/identity-sync.ts --env qa --seed --apply
 *     npx tsx scripts/jobs/identity-sync.ts --env prod --apply   # nightly diff
 *     npx tsx scripts/jobs/identity-sync.ts --env prod --rebase-history          # plan
 *     npx tsx scripts/jobs/identity-sync.ts --env prod --rebase-history --apply  # MONEY-1544
 */
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import { BigQuery } from "@google-cloud/bigquery";
import { PrismaClient } from "@prisma/client";
import { buildListingId } from "@usemoney/core/market-data/tiingo/tiingo-logic";
import { LAKE_REGION, datasetFor } from "@usemoney/core/ops/lake-layout";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { beginRun, endRun } from "@usemoney/lake/ledger";
import { runId } from "@usemoney/lake/ledger-logic";
import {
  IDENTITY_PARSER_VERSION,
  confidenceFor,
  diffListings,
  archiveHeads,
  archiveIsCurrent,
  classifyInactive,
  inactivePrecedence,
  planRebase,
  tradedTo,
  type ArchiveHead,
  type BarWindow,
  type IncomingListing,
  type ListingRow,
  type MapMethod,
  type RebaseOp,
  type SourceMapRow,
  type SourceSystem,
} from "@usemoney/lake/identity-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

/**
 * Built from the URI `--env` resolves, NOT the ambient `DATABASE_URL` —
 * MONEY-1509. `@usemoney/database`'s singleton is constructed AT IMPORT, so
 * setting the variable inside main() would be too late; an explicit
 * datasource removes the import-order trap entirely. Same shape as
 * `embeddings-v2-backfill`.
 */
let prisma: PrismaClient;

const JOB = "identity-sync";
const GCP_PROJECT = "stock-book-483718";

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

interface Args {
  env: "qa" | "prod";
  apply: boolean;
  seed: boolean;
  rebaseHistory: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env");
  const env = i >= 0 ? argv[i + 1] : undefined;
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");
  return {
    env,
    apply: argv.includes("--apply"),
    seed: argv.includes("--seed"),
    rebaseHistory: argv.includes("--rebase-history"),
  };
}

/** UTC today as `YYYY-MM-DD` — read ONCE and threaded through. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Sources -> IncomingListing
   ──────────────────────────────────────────────────────────────────────── */

interface Built {
  listings: IncomingListing[];
  maps: SourceMapRow[];
  /** snake_case because these go straight into an UNNEST the SQL reads by name. */
  aliases: {
    listing_id: string;
    symbol: string;
    venue: string;
    /** EXCLUSIVE. Only a delisted listing's own label has one. */
    valid_to: string | null;
  }[];
}

/**
 * India also returns whether each venue's bar archive is whole
 * (`archiveIsCurrent`). REQUIRED, and handed to `rebase` as its own argument:
 * it used to be an optional field of `Built` that `main` never copied across,
 * so `rebase` defaulted it to an empty map and held back every India listing
 * while the same run logged both venues CURRENT (MONEY-1614).
 */
type IndiaBuilt = Built & { indiaHeads: ReadonlyMap<string, ArchiveHead> };

/**
 * US, from `UsInstrument` — ACTIVE **and** DELISTED.
 *
 * `UsFiler` IS NOT QUERIED, and the spec asks for it. `UsInstrument.cik` is
 * already the SEC Central Index Key, written by the nightly `company_tickers`
 * join, so reading `UsFiler` for the same value would add a query, a second
 * possible spelling of one fact, and nothing else. `UsFiler` carries things
 * this table has no column for — `formerNames`, SIC, state of incorporation —
 * which is a filer-side enrichment, not an identity one; wire it when a reader
 * needs it.
 *
 * `UsCusipMap` IS queried, because the CUSIP exists nowhere else here.
 *
 * Both `cik10` and `cusip` may be null. A null means "not known", never
 * "none", and no rule may read its absence as a signal — the mistake that
 * nearly retyped 45 real companies as bonds in MONEY-1298.
 */
async function buildUs(): Promise<Built> {
  const rows = await prisma.usInstrument.findMany({
    select: {
      listingId: true,
      symbol: true,
      exchange: true,
      assetType: true,
      name: true,
      listingStatus: true,
      listingStartDate: true,
      listingEndDate: true,
      permaTicker: true,
      cik: true,
    },
  });

  // cik -> cusip, one query rather than one per row.
  const ciks = [
    ...new Set(rows.map((r) => r.cik).filter((c): c is string => !!c)),
  ];
  const cusipRows = ciks.length
    ? await prisma.usCusipMap.findMany({
        where: { cik10: { in: ciks } },
        select: { cusip: true, cik10: true },
      })
    : [];
  const cusipByCik = new Map(cusipRows.map((c) => [c.cik10 ?? "", c.cusip]));

  const listings: IncomingListing[] = [];
  const maps: SourceMapRow[] = [];
  const aliases: Built["aliases"] = [];

  for (const r of rows) {
    const start = isoOrNull(r.listingStartDate);
    // The SAME function the candle writer uses — never a second spelling.
    const listingId =
      r.listingId?.trim() || buildListingId(r.symbol, r.exchange, start);
    const status = r.listingStatus === "DELISTED" ? "DELISTED" : "ACTIVE";
    // DELISTED only — an ACTIVE row's end date is its latest price.
    const listedTo = tradedTo(status, isoOrNull(r.listingEndDate));

    listings.push({
      listingId,
      market: "US",
      venue: r.exchange,
      symbol: r.symbol,
      isin: null,
      name: r.name,
      assetType: r.assetType,
      currency: "USD",
      status,
      permaTicker: r.permaTicker,
      cik10: r.cik,
      cusip: r.cik ? (cusipByCik.get(r.cik) ?? null) : null,
      sector: null, // no US sector source yet; NULL is "not known", not "none"
      industry: null,
      source: "TIINGO",
      listedFrom: start,
      listedTo,
    });

    // The vendor's OWN key, with the vendor's OWN window.
    maps.push({
      source: "TIINGO",
      sourceKey: r.symbol,
      listingId,
      validFrom: start,
      validTo: listedTo,
      method: "VENDOR_NATIVE",
      confidence: confidenceFor("VENDOR_NATIVE"),
    });

    if (r.permaTicker) {
      maps.push(
        mapRow(
          "TIINGO",
          r.permaTicker,
          listingId,
          start,
          listedTo,
          "EXACT_PERMATICKER",
        ),
      );
    }
    if (r.cik) {
      // SEC's key has no listing window of its own — a filer outlives a listing.
      maps.push(mapRow("SEC", r.cik, listingId, start, null, "EXACT_CIK"));
    }
    // The label's START stays NULL: Tiingo keys a renamed company's whole
    // history under its CURRENT ticker (META from 2012-05-18, a decade before
    // the ticker existed), so the listing's start is not the label's. Its END
    // is real — a delisted listing stopped trading under this label that day.
    aliases.push({
      listing_id: listingId,
      symbol: r.symbol,
      venue: r.exchange,
      valid_to: listedTo,
    });
  }

  return { listings, maps, aliases };
}

function mapRow(
  source: SourceSystem,
  sourceKey: string,
  listingId: string,
  validFrom: string | null,
  validTo: string | null,
  method: MapMethod,
): SourceMapRow {
  return {
    source,
    sourceKey,
    listingId,
    validFrom,
    validTo,
    method,
    confidence: confidenceFor(method),
  };
}

/**
 * India, from `InstrumentMapping` — CURRENT-ONLY, and the map rows say so.
 *
 * Every MAP window of an ACTIVE row is `validFrom: null`, because we genuinely
 * do not know when a key began to name this listing. The `listing` row still
 * needs a `valid_from` (NOT NULL), and its first version gets the listing's
 * FIRST BAR in `price_bar_d1` — the archive's first evidence it traded — or,
 * with no bar, the day we first observed it. Neither is an inception date, and
 * neither claims one: "traded from here, by our archive" and "known since we
 * started looking" are both true statements, where a createdAt would not be.
 *
 * INACTIVE rows are read too (MONEY-1602), and so are bar ids no master row
 * carries, or every Indian company that stopped trading before today would be
 * in no universe. Their bars are the only record of when they traded, so
 * `classifyInactive` admits them from the bars and every one of their map
 * rows carries that window: a delisted instrument's symbol, ISIN or Kite token
 * named it WHILE it traded, and an undated row would tie with the active
 * successor that wears the same ISIN.
 *
 * Scoped to CASH EQUITY and funds. F&O contracts expire and would add a row per
 * strike per expiry — millions of versions describing nothing anyone joins on.
 */
async function buildIndia(
  barRows: readonly BarRow[],
  today: string,
): Promise<IndiaBuilt> {
  const rows = await prisma.instrumentMapping.findMany({
    where: {
      instrumentType: {
        in: ["EQUITY", "ETF", "INDEX", "MF", "REIT", "INVIT", "DEBT"],
      },
    },
    select: {
      symbol: true,
      exchange: true,
      name: true,
      isin: true,
      instrumentType: true,
      isActive: true,
      sector: true,
      industry: true,
      previousSymbols: true,
      zerodhaToken: true,
      upstoxKey: true,
      yahooSymbol: true,
    },
  });

  // NO start date exists for an India row, so the id carries `unknown` —
  // `buildListingId`'s own branch for exactly this, rather than a made-up date.
  const idOf = (r: { symbol: string; exchange: string }) =>
    buildListingId(r.symbol, r.exchange, null);
  const bars = new Map(barRows.map((b) => [b.listingId, b]));
  // A bar id identity can join is one filed under the ONE spelling; the rest
  // are the pre-MONEY-1522 spelling, still present while the rewrite runs.
  const canonical = barRows.filter(
    (b) => b.listingId === idOf({ symbol: b.symbol, exchange: b.venue }),
  );
  const heads = archiveHeads(
    barRows,
    new Set(canonical.map((b) => b.listingId)),
  );

  // BARS WITH NO MASTER ROW AT ALL: the companies that stopped trading before
  // `InstrumentMapping` existed — every row in it was created in 2026. HDFC
  // Ltd, RELCAPITAL, CENTURYTEX: 5,406 ids on prod (measured 2026-09-23,
  // projected past the rewrite), against 743 inactive master rows with bars.
  // Without them the India universe is not survivorship-free at all. They
  // carry what the bars carry: a symbol, a venue and the latest ISIN the bars
  // name — no name and no type (NULL is "not known"). The ISIN matters: BSE
  // files some securities under a second symbol on the same day (`IDEA#` beside
  // `IDEA`, 41 ISINs / 133 ISIN-days measured 2026-09-23), and without it the
  // overlap test could not see that `IDEA#` is IDEA counted twice.
  const masterIds = new Set(rows.map(idOf));
  const barOnly: IndiaRow[] = canonical
    .filter((b) => !masterIds.has(b.listingId))
    .map((b) => ({
      symbol: b.symbol,
      exchange: b.venue,
      name: null,
      isin: b.isin,
      instrumentType: null,
      isActive: false,
      sector: null,
      industry: null,
      previousSymbols: [],
      zerodhaToken: null,
      upstoxKey: null,
      yahooSymbol: null,
    }));
  // ACTIVE rows first; then every row the master no longer lists, in
  // `inactivePrecedence` order — so of two with one ISIN on the same days the
  // same one wins every night, and the other is refused OVERLAPS_SIBLING.
  const precedence = (r: IndiaRow) => ({
    listingId: idOf(r),
    bars: bars.get(idOf(r))?.bars ?? 0,
  });
  const candidates: IndiaRow[] = [
    ...rows.filter((r) => r.isActive),
    ...[...rows.filter((r) => !r.isActive), ...barOnly].sort((a, b) =>
      inactivePrecedence(precedence(a), precedence(b)),
    ),
  ];

  // ACTIVE instruments' bar windows by (venue, ISIN) — the master's ISIN and
  // the one their bars carry: the overlap test.
  const activeByIsin = new Map<string, BarWindow[]>();
  for (const r of rows) {
    const w = bars.get(idOf(r));
    if (!r.isActive || !w) continue;
    for (const isin of new Set([r.isin, w.isin])) {
      if (!isin) continue;
      const k = `${r.exchange}|${isin}`;
      activeByIsin.set(k, [...(activeByIsin.get(k) ?? []), w]);
    }
  }

  const listings: IncomingListing[] = [];
  const maps: SourceMapRow[] = [];
  const aliases: Built["aliases"] = [];
  const refused = new Map<string, IndiaRow[]>();
  const admitted = new Map<string, IndiaRow[]>();
  const admittedByIsin = new Map<string, BarWindow[]>();

  for (const r of candidates) {
    const listingId = idOf(r);
    const venueSource: SourceSystem = r.exchange === "BSE" ? "BSE" : "NSE";

    // ACTIVE: open, dated by the first bar — once the venue's archive is whole,
    // else the observed day (a first bar read mid-rewrite may be the
    // rewrite's frontier). INACTIVE: whatever its bars say.
    const w = bars.get(listingId);
    let status: "ACTIVE" | "DELISTED" = "ACTIVE";
    let listedFrom = archiveIsCurrent(heads.get(r.exchange), today)
      ? (w?.first ?? null)
      : null;
    let listedTo: string | null = null;
    let isin = r.isin;
    // A map window only for a row the master no longer lists — see the doc.
    let from: string | null = null;
    let to: string | null = null;
    if (!r.isActive) {
      // A row the master no longer lists takes the bars' ISIN where it has none.
      isin = r.isin ?? w?.isin ?? null;
      const isinKey = isin ? `${r.exchange}|${isin}` : null;
      const v = classifyInactive({
        bars: w ?? null,
        head: heads.get(r.exchange),
        today,
        activeSameIsin: isinKey ? (activeByIsin.get(isinKey) ?? []) : [],
        siblingSameIsin: isinKey ? (admittedByIsin.get(isinKey) ?? []) : [],
      });
      if (!v.admit) {
        const k = `${v.reason} ${r.exchange} ${r.instrumentType ?? "BARS-ONLY"}`;
        refused.set(k, [...(refused.get(k) ?? []), r]);
        continue;
      }
      ({ status, listedFrom, listedTo } = v);
      from = listedFrom;
      to = listedTo;
      const k = `${status} ${r.exchange} ${r.instrumentType ?? "BARS-ONLY"}`;
      admitted.set(k, [...(admitted.get(k) ?? []), r]);
      if (isinKey && w)
        admittedByIsin.set(isinKey, [
          ...(admittedByIsin.get(isinKey) ?? []),
          w,
        ]);
    }

    listings.push({
      listingId,
      market: "IN",
      venue: r.exchange,
      symbol: r.symbol,
      isin,
      name: r.name,
      assetType: r.instrumentType,
      currency: "INR",
      status,
      permaTicker: null,
      cik10: null,
      cusip: null,
      sector: r.sector,
      industry: r.industry,
      source: venueSource,
      listedFrom,
      listedTo,
    });

    maps.push(
      mapRow(
        venueSource,
        r.symbol,
        listingId,
        from,
        to,
        r.isActive ? "SYMBOL_VENUE_CURRENT" : "SYMBOL_VENUE_DATED",
      ),
    );
    if (isin) {
      // ISIN is the DURABLE identity — it is what let Zomato-era prices
      // reattach to ETERNAL (MONEY-1175) — so it is the strongest India rung.
      maps.push(mapRow(venueSource, isin, listingId, from, to, "EXACT_ISIN"));
    }
    if (r.zerodhaToken !== null) {
      maps.push(
        mapRow(
          "KITE",
          String(r.zerodhaToken),
          listingId,
          from,
          to,
          "VENDOR_NATIVE",
        ),
      );
    }
    if (r.upstoxKey) {
      maps.push(
        mapRow("UPSTOX", r.upstoxKey, listingId, from, to, "VENDOR_NATIVE"),
      );
    }
    if (r.yahooSymbol) {
      maps.push(
        mapRow("YAHOO", r.yahooSymbol, listingId, from, to, "VENDOR_NATIVE"),
      );
    }

    aliases.push({
      listing_id: listingId,
      symbol: r.symbol,
      venue: r.exchange,
      valid_to: listedTo,
    });
    for (const prev of r.previousSymbols) {
      // UNDATED on purpose. `previousSymbols` carries the LABEL and not the
      // date — NSE's symbol-change history is not archived here — so a window
      // would be invented. Both dates NULL is the honest encoding, and
      // `resolveSymbol` ranks it below any dated row.
      aliases.push({
        listing_id: listingId,
        symbol: prev,
        venue: r.exchange,
        valid_to: null,
      });
      maps.push(
        mapRow(
          venueSource,
          prev,
          listingId,
          null,
          null,
          "SYMBOL_ALIAS_UNDATED",
        ),
      );
    }
  }

  // COUNTED, NEVER DROPPED SILENTLY: every inactive row, admitted or not, by
  // outcome, venue and type, with the first names.
  for (const [k, rs] of [...admitted].sort())
    log.info(`  inactive, admitted ${k}: ${rs.length}`);
  for (const [k, rs] of [...refused].sort()) {
    log.info(
      `  inactive, not a listing: ${k} ${rs.length} (${rs
        .slice(0, 8)
        .map((r) => r.symbol)
        .join(", ")}${rs.length > 8 ? ", …" : ""})`,
    );
  }
  for (const [venue, h] of [...heads].sort())
    log.info(
      `  ${venue} bar archive: newest ${h.newest}, ${h.staleIds} bar ids ` +
        `still on the old spelling — ` +
        (archiveIsCurrent(h, today)
          ? "CURRENT"
          : "NOT CURRENT: no India bar is used"),
    );

  return { listings, maps, aliases, indiaHeads: heads };
}

/* ─────────────────────────────────────────────────────────────────────────
   BigQuery
   ──────────────────────────────────────────────────────────────────────── */

function client(): BigQuery {
  // LOCATION STATED. A BigQuery job runs in ONE location and defaults to the US
  // multi-region, while these datasets are created `asia-south1`. Without it
  // every statement fails with "Dataset not found in location US", which reads
  // as un-provisioned rather than as a wrong region.
  return new BigQuery({ projectId: GCP_PROJECT, location: LAKE_REGION });
}

function silver(env: "qa" | "prod", table: string): string {
  return `\`${GCP_PROJECT}.${datasetFor("lake_silver", env)}.${table}\``;
}

/** One India listing's span in `price_bar_d1`. */
interface BarRow {
  listingId: string;
  symbol: string;
  venue: string;
  first: string;
  last: string;
  /** The latest ISIN the bars carry; NULL on pre-ISIN-era bars. */
  isin: string | null;
  /** How many sessions it printed — `inactivePrecedence`'s first key. */
  bars: number;
}

/** An `InstrumentMapping` row, or a bar id no master row carries. */
interface IndiaRow {
  symbol: string;
  exchange: string;
  name: string | null;
  isin: string | null;
  instrumentType: string | null;
  isActive: boolean;
  sector: string | null;
  industry: string | null;
  previousSymbols: string[];
  zerodhaToken: number | null;
  upstoxKey: string | null;
  yahooSymbol: string | null;
}

/**
 * Every India listing id's FIRST and LAST session in `price_bar_d1`. The first
 * starts an India listing; the last ends an inactive one (see the header).
 * Joined on `listing_id` EXACTLY: MONEY-1522 made `{symbol}:{exchange}:unknown`
 * the one spelling, and a normalising join here would be the second spelling
 * that bug was. Ids of the old spelling still come back, and `archiveHeads`
 * reads them as "not joinable" — which is how a half-rewritten archive is seen.
 */
async function readBarWindows(
  bq: BigQuery,
  env: "qa" | "prod",
): Promise<BarRow[]> {
  const [rows] = await bq.query({
    query: `SELECT listing_id, ANY_VALUE(symbol) AS symbol,
                   ANY_VALUE(exchange) AS venue,
                   ARRAY_AGG(isin IGNORE NULLS ORDER BY session_date DESC
                             LIMIT 1)[SAFE_OFFSET(0)] AS isin,
                   CAST(MIN(session_date) AS STRING) AS first_bar,
                   CAST(MAX(session_date) AS STRING) AS last_bar,
                   COUNT(*) AS bars
            FROM ${silver(env, "price_bar_d1")}
            WHERE market = 'IN'
            GROUP BY listing_id`,
  });
  return (
    rows as {
      listing_id: string;
      symbol: string;
      venue: string;
      first_bar: string;
      bars: number;
      last_bar: string;
      isin: string | null;
    }[]
  ).map((r) => ({
    listingId: r.listing_id,
    symbol: r.symbol,
    venue: r.venue,
    first: r.first_bar,
    last: r.last_bar,
    bars: Number(r.bars),
    isin: r.isin ?? null,
  }));
}

/**
 * `openOnly`: the OPEN versions — the only ones a diff compares against.
 * Otherwise every version, which the rebase needs to tell a listing that has
 * changed since from one that has not.
 */
async function readListings(
  bq: BigQuery,
  env: "qa" | "prod",
  openOnly: boolean,
): Promise<(ListingRow & { parserVersion: string })[]> {
  const [rows] = await bq.query({
    query: `SELECT listing_id, market, venue, symbol, isin, name, asset_type,
                   currency, status, CAST(valid_from AS STRING) AS valid_from,
                   CAST(valid_to AS STRING) AS valid_to,
                   perma_ticker, cik10, cusip, sector, industry, source,
                   parser_version
            FROM ${silver(env, "listing")}
            ${openOnly ? "WHERE valid_to IS NULL" : ""}`,
  });
  return (rows as Record<string, unknown>[]).map((r) => ({
    listingId: String(r.listing_id),
    market: r.market as ListingRow["market"],
    venue: String(r.venue),
    symbol: String(r.symbol),
    isin: (r.isin as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    assetType: (r.asset_type as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    status: r.status as ListingRow["status"],
    validFrom: String(r.valid_from),
    validTo: (r.valid_to as string | null) ?? null,
    permaTicker: (r.perma_ticker as string | null) ?? null,
    cik10: (r.cik10 as string | null) ?? null,
    cusip: (r.cusip as string | null) ?? null,
    sector: (r.sector as string | null) ?? null,
    industry: (r.industry as string | null) ?? null,
    source: r.source as SourceSystem,
    parserVersion: String(r.parser_version),
  }));
}

/**
 * Run a parameterised query in CHUNKS of its row array — MONEY-1509.
 *
 * BigQuery carries query PARAMETERS in the request body, so a single
 * `bq.query` whose `@rows` array holds the whole batch is one enormous HTTP
 * request. The seed builds 98,249 listing rows and 204,446 map rows, and the
 * API answers **413 Request Entity Too Large** — as an HTML error page, not a
 * JSON API error, so the failure surfaces as an unreadable parse rather than
 * as a quota message naming the cause.
 *
 * That made B3 un-seedable: the DDL applied, the code merged, `--seed` built
 * every row correctly, and the first real `--apply` could never write one.
 * `lake_silver_prod.listing` sat at 0 rows with nothing reporting a failure
 * until somebody looked at the table.
 *
 * 2,000 is deliberately conservative. A listing row is ~23 mostly-short string
 * fields, so a chunk is well under a megabyte against the 10 MB ceiling; this
 * is a seed job run by hand, and the cost of being wrong here is another
 * unreadable 413 rather than a slow run.
 */
const QUERY_ROW_CHUNK = 2_000;

async function queryInChunks<T>(
  bq: BigQuery,
  rows: readonly T[],
  build: (chunk: readonly T[]) => Parameters<BigQuery["query"]>[0],
  size = QUERY_ROW_CHUNK,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await bq.query(build(rows.slice(i, i + size)));
  }
}

/* ── One `listing` row -> INSERT, shared by the diff and the rebase ─────── */

const LISTING_COLUMNS = `listing_id, market, venue, symbol, isin, name, asset_type,
  currency, valid_from, valid_to, status, perma_ticker, cik10, cusip, sector,
  industry, source, source_object_uri, source_record_key, parser_version,
  pipeline_run_id, observed_at, ingested_at`;

/** The VALUES for {@link LISTING_COLUMNS}, read off struct alias `a`. */
function listingValues(a: string): string {
  return `${a}.listing_id, ${a}.market, ${a}.venue, ${a}.symbol, ${a}.isin,
    ${a}.name, ${a}.asset_type, ${a}.currency, DATE(${a}.valid_from),
    DATE(${a}.valid_to), ${a}.status, ${a}.perma_ticker, ${a}.cik10, ${a}.cusip,
    ${a}.sector, ${a}.industry, ${a}.source, ${a}.source_object_uri,
    ${a}.listing_id, @parser_version, @run_id, @observed_at, @ingested_at`;
}

function listingParam(o: ListingRow) {
  return {
    listing_id: o.listingId,
    market: o.market,
    venue: o.venue,
    symbol: o.symbol,
    isin: o.isin,
    name: o.name,
    asset_type: o.assetType,
    currency: o.currency,
    valid_from: o.validFrom,
    valid_to: o.validTo,
    status: o.status,
    perma_ticker: o.permaTicker,
    cik10: o.cik10,
    cusip: o.cusip,
    sector: o.sector,
    industry: o.industry,
    source: o.source,
    // The row came from a Mongo collection, not an archived object. Named
    // rather than left NULL: `lake-layout.md` §5 makes this column
    // mandatory so a wrong number can be traced to what produced it.
    source_object_uri:
      o.market === "US"
        ? "mongo://us_instruments"
        : "mongo://instrument_mappings",
  };
}

const LISTING_PARAM_TYPE = {
  listing_id: "STRING",
  market: "STRING",
  venue: "STRING",
  symbol: "STRING",
  isin: "STRING",
  name: "STRING",
  asset_type: "STRING",
  currency: "STRING",
  valid_from: "STRING",
  valid_to: "STRING",
  status: "STRING",
  perma_ticker: "STRING",
  cik10: "STRING",
  cusip: "STRING",
  sector: "STRING",
  industry: "STRING",
  source: "STRING",
  source_object_uri: "STRING",
} as const;

/**
 * observed_at is when the SOURCE asserted it. These sources are Mongo tables
 * refreshed by their own syncs and carrying no assertion stamp we can read per
 * row, so the honest value is the moment we read them — NOT a back-dated
 * listing date, which would claim the source said this in 1972.
 */
function provenance(runIdValue: string, now: Date) {
  return {
    params: {
      parser_version: IDENTITY_PARSER_VERSION,
      run_id: runIdValue,
      observed_at: now,
      ingested_at: now,
    },
    types: {
      parser_version: "STRING",
      run_id: "STRING",
      observed_at: "TIMESTAMP",
      ingested_at: "TIMESTAMP",
    },
  } as const;
}

/**
 * Write the diff. CLOSES FIRST, then opens.
 *
 * The order is load-bearing: opening the successor first would leave two rows
 * with `valid_to IS NULL` for one listing, and a crash between the two
 * statements would make that permanent — `instrument_current` would then hold
 * both, and every `WHERE valid_to IS NULL` join would double-count. Closing
 * first leaves, at worst, a listing briefly absent, which a re-run fixes.
 */
async function writeDiff(
  bq: BigQuery,
  env: "qa" | "prod",
  diff: ReturnType<typeof diffListings>,
  runIdValue: string,
): Promise<void> {
  const now = new Date();

  if (diff.close.length > 0) {
    // Each close carries its OWN `valid_to` (MONEY-1602): a delisting is dated
    // from the source's end when `changeDate` finds it sane, else today.
    await queryInChunks(bq, diff.close, (chunk) => ({
      query: `UPDATE ${silver(env, "listing")} t
              SET valid_to = DATE(k.valid_to)
              FROM UNNEST(@keys) k
              WHERE t.valid_to IS NULL
                AND k.listing_id = t.listing_id
                AND k.valid_from = CAST(t.valid_from AS STRING)`,
      params: {
        keys: chunk.map((c) => ({
          listing_id: c.listingId,
          valid_from: c.validFrom,
          valid_to: c.validTo,
        })),
      },
      types: {
        keys: [
          { listing_id: "STRING", valid_from: "STRING", valid_to: "STRING" },
        ],
      },
    }));
  }

  if (diff.open.length > 0) {
    // valid_to is WRITTEN, not NULL: a listing first seen DELISTED opens as a
    // closed ACTIVE row plus its open DELISTED successor (`firstVersions`).
    const prov = provenance(runIdValue, now);
    await queryInChunks(bq, diff.open, (chunk) => ({
      query: `INSERT ${silver(env, "listing")} (${LISTING_COLUMNS})
              SELECT ${listingValues("r")} FROM UNNEST(@rows) r`,
      params: { ...prov.params, rows: chunk.map(listingParam) },
      types: { ...prov.types, rows: [LISTING_PARAM_TYPE] },
    }));
  }

  if (diff.enrich.length > 0) {
    // IN PLACE, and only on enrichment columns. `assertEnrichIsSafe` has
    // already refused anything else; this statement names them explicitly so a
    // future identity column cannot be added to the set by accident.
    await queryInChunks(bq, diff.enrich, (chunk) => ({
      query: `UPDATE ${silver(env, "listing")} t
              SET perma_ticker = COALESCE(e.perma_ticker, t.perma_ticker),
                  cik10  = COALESCE(e.cik10,  t.cik10),
                  cusip  = COALESCE(e.cusip,  t.cusip),
                  sector = COALESCE(e.sector, t.sector),
                  industry = COALESCE(e.industry, t.industry),
                  ingested_at = @ingested_at
              FROM UNNEST(@rows) e
              WHERE e.listing_id = t.listing_id
                AND e.valid_from = CAST(t.valid_from AS STRING)
                AND t.valid_to IS NULL`,
      params: {
        ingested_at: now,
        rows: chunk.map((e) => ({
          listing_id: e.listingId,
          valid_from: e.validFrom,
          perma_ticker: e.fields.permaTicker ?? null,
          cik10: e.fields.cik10 ?? null,
          cusip: e.fields.cusip ?? null,
          sector: e.fields.sector ?? null,
          industry: e.fields.industry ?? null,
        })),
      },
      types: {
        ingested_at: "TIMESTAMP",
        rows: [
          {
            listing_id: "STRING",
            valid_from: "STRING",
            perma_ticker: "STRING",
            cik10: "STRING",
            cusip: "STRING",
            sector: "STRING",
            industry: "STRING",
          },
        ],
      },
    }));
  }
}

/**
 * Apply a {@link planRebase} plan — MONEY-1544/1602.
 *
 * ONE MERGE PER CHUNK, deleting each stored row and inserting its replacements
 * in the same statement, so a listing is never half-rebased: a DML statement
 * is atomic, and ops are chunked WHOLE (never split across two statements).
 *
 * THE INSERT IS CONDITIONAL ON THE DELETE, in the same statement. Every row of
 * an op carries the key of the row it replaces (start, end, status), and the
 * source subquery keeps an op only while that row still exists UNCHANGED. A
 * row closed, re-dated or removed since the read loses its whole op: no delete
 * and no insert. Without that, a row that changed after the read kept its new
 * self AND gained the replacement — a second open version.
 *
 * Then the invariant is CHECKED per listing: exactly one open version each.
 */
async function writeRebase(
  bq: BigQuery,
  env: "qa" | "prod",
  ops: readonly RebaseOp[],
  runIdValue: string,
): Promise<void> {
  const prov = provenance(runIdValue, new Date());
  const keyMatches = (a: string) =>
    `${a}.listing_id = s.listing_id
       AND CAST(${a}.valid_from AS STRING) = s.old_from
       AND IFNULL(CAST(${a}.valid_to AS STRING), '') = IFNULL(s.old_to, '')
       AND ${a}.status = s.old_status`;
  await queryInChunks(
    bq,
    ops,
    (chunk) => ({
      query: `MERGE ${silver(env, "listing")} t
              USING (
                SELECT s.* FROM UNNEST(@rows) s
                WHERE EXISTS (SELECT 1 FROM ${silver(env, "listing")} c
                              WHERE ${keyMatches("c")})
              ) s
              ON s.op = 'DEL' AND ${keyMatches("t")}
              WHEN MATCHED THEN DELETE
              WHEN NOT MATCHED BY TARGET AND s.op = 'INS' THEN
                INSERT (${LISTING_COLUMNS}) VALUES (${listingValues("s")})`,
      params: {
        ...prov.params,
        rows: chunk.flatMap((o) => {
          const key = {
            old_from: o.replaces.validFrom,
            old_to: o.replaces.validTo,
            old_status: o.replaces.status,
          };
          return [
            { op: "DEL", ...listingParam(o.replaces), ...key },
            ...o.rows.map((r) => ({ op: "INS", ...listingParam(r), ...key })),
          ];
        }),
      },
      types: {
        ...prov.types,
        rows: [
          {
            op: "STRING",
            ...LISTING_PARAM_TYPE,
            old_from: "STRING",
            old_to: "STRING",
            old_status: "STRING",
          },
        ],
      },
    }),
    // Up to three struct rows per op (a delisted listing's DEL + two INS).
    Math.floor(QUERY_ROW_CHUNK / 3),
  );

  // EXACT, per listing. A distinct-count against an open-count would let a
  // listing with no open version cancel one with two.
  const [bad] = await bq.query({
    query: `SELECT listing_id, COUNTIF(valid_to IS NULL) AS open_rows
            FROM ${silver(env, "listing")}
            GROUP BY listing_id
            HAVING COUNTIF(valid_to IS NULL) != 1
            LIMIT 20`,
  });
  const rows = bad as { listing_id: string; open_rows: number }[];
  if (rows.length > 0) {
    throw new Error(
      `rebase left listings without exactly one open version: ` +
        rows.map((r) => `${r.listing_id} (${r.open_rows})`).join(", "),
    );
  }
}

/**
 * `source_instrument_map` and `symbol_history`.
 *
 * ponytail: DELETE-then-INSERT the whole table on --seed, MERGE-by-natural-key
 * on a nightly. Both tables are derivable from their sources in full, carry no
 * state a reader accumulates, and are ~200k rows — so a rebuild is cheaper to
 * write and to reason about than an incremental differ. Move to a keyed MERGE
 * if the rebuild starts costing real time or the tables gain hand-curated rows.
 */
async function rebuildMaps(
  bq: BigQuery,
  env: "qa" | "prod",
  built: Built,
  runIdValue: string,
): Promise<void> {
  const now = new Date();
  const common = {
    parser_version: IDENTITY_PARSER_VERSION,
    run_id: runIdValue,
    observed_at: now,
    ingested_at: now,
  };
  const commonTypes = {
    parser_version: "STRING",
    run_id: "STRING",
    observed_at: "TIMESTAMP",
    ingested_at: "TIMESTAMP",
  } as const;

  await bq.query({
    query: `DELETE FROM ${silver(env, "source_instrument_map")} WHERE TRUE`,
  });
  await queryInChunks(bq, built.maps, (chunk) => ({
    query: `INSERT ${silver(env, "source_instrument_map")}
            (source, source_key, listing_id, valid_from, valid_to, confidence, method,
             source_object_uri, source_record_key, parser_version, pipeline_run_id,
             observed_at, ingested_at)
            SELECT r.source, r.source_key, r.listing_id,
                   SAFE.PARSE_DATE('%Y-%m-%d', r.valid_from),
                   SAFE.PARSE_DATE('%Y-%m-%d', r.valid_to),
                   r.confidence, r.method, 'mongo://identity-sync',
                   CONCAT(r.source, '/', r.source_key), @parser_version, @run_id,
                   @observed_at, @ingested_at
            FROM UNNEST(@rows) r`,
    params: {
      ...common,
      rows: chunk.map((m) => ({
        source: m.source,
        source_key: m.sourceKey,
        listing_id: m.listingId,
        valid_from: m.validFrom,
        valid_to: m.validTo,
        confidence: m.confidence,
        method: m.method,
      })),
    },
    types: {
      ...commonTypes,
      rows: [
        {
          source: "STRING",
          source_key: "STRING",
          listing_id: "STRING",
          valid_from: "STRING",
          valid_to: "STRING",
          confidence: "FLOAT64",
          method: "STRING",
        },
      ],
    },
  }));

  await bq.query({
    query: `DELETE FROM ${silver(env, "symbol_history")} WHERE TRUE`,
  });
  await queryInChunks(bq, built.aliases, (chunk) => ({
    query: `INSERT ${silver(env, "symbol_history")}
            (listing_id, symbol, venue, valid_from, valid_to, source_object_uri,
             source_record_key, parser_version, pipeline_run_id, observed_at, ingested_at)
            SELECT r.listing_id, r.symbol, r.venue, NULL,
                   SAFE.PARSE_DATE('%Y-%m-%d', r.valid_to), 'mongo://identity-sync',
                   CONCAT(r.venue, '/', r.symbol), @parser_version, @run_id,
                   @observed_at, @ingested_at
            FROM UNNEST(@rows) r`,
    params: { ...common, rows: chunk },
    types: {
      ...commonTypes,
      rows: [
        {
          listing_id: "STRING",
          symbol: "STRING",
          venue: "STRING",
          valid_to: "STRING",
        },
      ],
    },
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
   main
   ──────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs();
  // FIRST — before any client is constructed. Resolves DATABASE_URL from
  // Secret Manager for THIS --env and pins LAKE_ENV/LAKE_PROJECT to match, so
  // the Mongo read, the BigQuery write and the ledger run cannot disagree.
  const { databaseUrl } = pinJobEnv(args.env);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  await initJobTelemetry();
  reportBuildProvenance(log, JOB);

  const startedAt = new Date();
  const id = runId(JOB, startedAt.getTime());
  const today = todayIso();

  log.info(
    `env=${args.env} seed=${args.seed} rebaseHistory=${args.rebaseHistory} ` +
      `apply=${args.apply} today=${today}`,
  );

  const bq = client();
  const barRows = await readBarWindows(bq, args.env);
  const [us, india] = await Promise.all([
    buildUs(),
    buildIndia(barRows, today),
  ]);
  const built: Built = {
    listings: [...us.listings, ...india.listings],
    maps: [...us.maps, ...india.maps],
    aliases: [...us.aliases, ...india.aliases],
  };
  log.info(
    `built US ${us.listings.length} + IN ${india.listings.length} listings, ` +
      `${built.maps.length} map rows, ${built.aliases.length} symbol rows; ` +
      `source-dated: US ${countDated(us.listings)}, IN ${countDated(india.listings)} ` +
      `(${barRows.length} IN listing ids have a bar)`,
  );

  if (args.rebaseHistory) {
    await rebase(bq, args, built, india.indiaHeads, id, startedAt, today);
    return;
  }

  // A SEED READS THE TABLE TOO, which is why `--seed` changes nothing here and
  // is only a label on the run. It is deliberately NOT a truncate: re-running
  // the seed over a populated table must be a no-op rather than a rewrite that
  // discards every version boundary already recorded. `diffListings` gives that
  // for free, so the first run and the thousandth take the same path — the one
  // that is exercised nightly.
  const current = await readListings(bq, args.env, true);
  const diff = diffListings({ current, incoming: built.listings, today });

  log.info(
    `diff: close ${diff.close.length}, open ${diff.open.length}, ` +
      `enrich ${diff.enrich.length}, unchanged ${diff.unchanged}`,
  );
  // How each close is dated — the source's end, or the observed day and why.
  const dating = new Map<string, number>();
  for (const c of diff.close)
    dating.set(c.datedBy, (dating.get(c.datedBy) ?? 0) + 1);
  log.info(
    `close dating: ${
      [...dating]
        .sort()
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "none"
    }`,
  );
  for (const c of diff.close.slice(0, 10))
    log.info(
      `  close ${c.listingId}: ${c.reason} -> ${c.validTo} (${c.datedBy})`,
    );

  if (!args.apply) {
    log.info("DRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  await beginRun({ runId: id, job: JOB, startedAt });
  try {
    await writeDiff(bq, args.env, diff, id);
    await rebuildMaps(bq, args.env, built, id);
    await endRun({
      runId: id,
      status: "SUCCESS",
      finishedAt: new Date(),
      rowsIn: built.listings.length,
      rowsOut: diff.open.length + diff.close.length + diff.enrich.length,
      rowsRejected: 0,
      notes: `close=${diff.close.length} open=${diff.open.length} enrich=${diff.enrich.length}`,
    });
  } catch (err) {
    await endRun({
      runId: id,
      status: "FAILED",
      finishedAt: new Date(),
      notes: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  log.info("done");
}

function countDated(listings: readonly IncomingListing[]): number {
  return listings.filter((l) => l.listedFrom !== null).length;
}

/**
 * `--rebase-history`: re-date first versions, and nothing else. It writes
 * `listing` only — `symbol_history` and the maps are rebuilt by the ordinary
 * `--apply` run that follows it.
 */
async function rebase(
  bq: BigQuery,
  args: Args,
  built: Built,
  heads: ReadonlyMap<string, ArchiveHead>,
  id: string,
  startedAt: Date,
  today: string,
): Promise<void> {
  // India waits for its bar archive: re-dated or re-stamped now, an India
  // first version would take a first bar the rewrite has not reached yet.
  const held = (r: { market: string; venue: string }) =>
    r.market === "IN" && !archiveIsCurrent(heads.get(r.venue), today);
  const all = await readListings(bq, args.env, false);
  const current = all.filter((r) => !held(r));
  const heldBack = new Set(all.filter(held).map((r) => r.listingId)).size;
  const plan = planRebase({
    current,
    incoming: built.listings.filter((l) => !held(l)),
  });

  const count = new Map<string, number>();
  for (const o of plan.ops) {
    const k = `${o.kind} ${o.replaces.market}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const rowsOut = plan.ops.reduce((n, o) => n + o.rows.length, 0);
  log.info(
    `rebase: ${
      [...count]
        .sort()
        .map(([k, n]) => `${k} ${n}`)
        .join(", ") || "nothing"
    } ` +
      `-> ${rowsOut} rows; unchanged ${plan.unchanged}, not in source ` +
      `${plan.notInSource}, cannot re-date ${plan.cannotRedate.length}, ` +
      `India held back (archive not current) ${heldBack}`,
  );
  for (const o of plan.ops.filter((o) => o.kind === "REDATE").slice(0, 5))
    log.info(
      `  ${o.listingId}: ${o.replaces.status} [${o.replaces.validFrom}, ` +
        `${o.replaces.validTo ?? "open"}) -> ` +
        o.rows
          .map((r) => `${r.status} [${r.validFrom}, ${r.validTo ?? "open"})`)
          .join(" + "),
    );
  for (const lid of plan.cannotRedate.slice(0, 10))
    log.warn(`  cannot re-date without crossing an observed boundary: ${lid}`);

  if (!args.apply) {
    log.info("DRY RUN — nothing written. Re-run with --apply.");
    return;
  }
  await beginRun({ runId: id, job: JOB, startedAt });
  try {
    await writeRebase(bq, args.env, plan.ops, id);
    await endRun({
      runId: id,
      status: "SUCCESS",
      finishedAt: new Date(),
      rowsIn: current.length,
      rowsOut,
      rowsRejected: 0,
      notes: `rebase-history ops=${plan.ops.length} cannotRedate=${plan.cannotRedate.length} heldBack=${heldBack}`,
    });
  } catch (err) {
    await endRun({
      runId: id,
      status: "FAILED",
      finishedAt: new Date(),
      notes: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  log.info(
    "rebase done — re-run it as a dry run (expect nothing), then the " +
      "ordinary --apply to rebuild symbol_history",
  );
}

guardCompletion(JOB, main())
  .catch((err) => {
    log.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  })
  // OPTIONAL CHAIN — MONEY-1523. `prisma` is assigned inside `main()`, after
  // `pinJobEnv`. A bad `--env` throws before that, and an unguarded
  // `.$disconnect()` would replace the real error with a TypeError.
  .finally(() => void prisma?.$disconnect());
