/**
 * DerivativeEOD → DerivativeSummary derivation — MONEY-1100 (P4.4 / P4.7).
 *
 * Reads OUR OWN `derivative_eod` rows and writes one `DerivativeSummary` per
 * (underlying, exchange, trading day): futures OI + day-over-day change,
 * basis vs cash, PCR (OI + volume), max pain, rollover share and OI-buildup
 * classification. All math lives in `computeDerivativeSummary`
 * (@usemoney/core/market-data, unit-tested); this job is the I/O harness.
 * It never touches an exchange and never scrapes — the EODs came from the
 * feed archive, and this derives from them.
 *
 * ## Modes
 *
 *   (default)      summarize the LATEST trading day present in DerivativeEOD
 *                  — the nightly increment, scheduled after feed-parse.
 *   --date=ISO     one specific day (re-runs are idempotent: per-day
 *                  delete-then-createMany under the [symbol,exchange,date]
 *                  unique).
 *   --backfill     every DerivativeEOD date with NO summary rows yet,
 *                  ascending. Walking ascending lets each day's rows serve as
 *                  the NEXT day's prev-day chain, so the whole backfill reads
 *                  each day exactly once.
 *
 * ## Underlying cash close
 *
 * Equity underlyings (instrument *STK) resolve symbol@exchange →
 * InstrumentMapping → DailyPrice.close. Index underlyings (instrument *IDX)
 * resolve through INDEX_UNDERLYING_SLUGS → IndexClose.close. Both misses are
 * COUNTED, never guessed — a missing close only nulls `futBasisPct`
 * (`underlyingClose` carries what the basis was priced against, so null there
 * is honest and auditable). The index map covers the F&O underlyings NSE
 * actually lists; anything unmapped increments `unmappedIndex` so the first
 * real run falsifies the map instead of silently nulling forever.
 *
 * ## QA
 *
 * QA has no `derivative_eod` rows (the P3 backfill is prod-only until the
 * feeds/ mirror + a QA-side parse exist — see sync-prod-to-qa.sh notes on
 * QA-DIRECT keying), so on QA this job no-ops loudly. The Scheduler trigger
 * is prod-only for the same reason.
 *
 * ## Usage
 *
 *   node --import tsx scripts/jobs/fo-summary.ts --dry-run
 *   node --import tsx scripts/jobs/fo-summary.ts --date=2026-08-08
 *   node --import tsx scripts/jobs/fo-summary.ts --backfill
 */

import "dotenv/config";

import { prisma, type Prisma } from "@usemoney/database";
import {
  computeDerivativeSummary,
  retainedUnderlyings,
  selectIncompleteDays,
  selectNightlyTargets,
  type DerivativeContractRow,
  type UnderlyingKey,
} from "@usemoney/core/market-data";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time; this prints
// the commit this process is actually running. See the module header.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const DRY_RUN = argv.includes("--dry-run");
/**
 * Rolling retention for the RAW `DerivativeEOD` rows, in days.
 *
 * Nothing in the product reads that table — verified across apps/, services
 * and workers, the only readers are feed-parse's dedupe check and this job.
 * It is a staging table between the GCS archive and `DerivativeSummary`, and
 * at ~26 GB it was 89% of the database. `DerivativeSummary` is kept in FULL
 * (0.35 GB) because that is the layer a future F&O feature would query.
 *
 * The functional minimum is 2 days (this job needs the target day plus the
 * previous TRADING day for day-over-day OI change); 90 leaves a quarter of
 * slack for re-derivation without touching GCS. `--no-prune` disables it.
 */
const EOD_RETENTION_DAYS = Number(arg("retention-days") ?? 90) || 90;
const PRUNE = !argv.includes("--no-prune");
const BACKFILL = argv.includes("--backfill");
const DATE = arg("date");
/**
 * How many trailing days the NIGHTLY run re-checks for completeness.
 *
 * MONEY-1189. The nightly used to target exactly the last EOD date, which made
 * a single missed night PERMANENT — nothing revisited it, and the only thing
 * that could (`--backfill`) was blinded by a day-granularity check. That is not
 * theoretical: on 2026-08-11 this job ran at 18:00Z while that day's 34,815 EOD
 * rows were not written until 19:27Z, 87 minutes later, and the day still has
 * zero summaries.
 *
 * A short window is a self-healing margin for late data and missed runs, not a
 * backfill — deep history stays `--backfill`'s job, because a nightly that
 * quietly becomes a two-year re-derivation is its own outage.
 */
const NIGHTLY_WINDOW_DAYS = Number(arg("nightly-window-days") ?? 7) || 7;

const log = {
  info: (...a: unknown[]) => console.log("[fo-summary]", ...a),
  warn: (...a: unknown[]) => console.warn("[fo-summary]", ...a),
};

/**
 * F&O index underlying → the `IndexClose.indexSlug` candidates that may name
 * it, MOST RECENT NAMING FIRST.
 *
 * ## Why candidates and not one slug
 *
 * NSE renamed its entire index family in November 2015 (CNX Nifty → Nifty 50,
 * CNX IT → Nifty IT, CNX Nifty Junior → Nifty Next 50, CNX 100 → Nifty 100,
 * …). `indexSlug` is derived from the index NAME printed in that day's close
 * file, so the archive legitimately contains BOTH families — verified on prod:
 * 221 distinct slugs including `cnx-nifty` AND `nifty-50`, `cnx-it` AND
 * `nifty-it`, `cnx-nifty-junior` AND `nifty-next-50`.
 *
 * A single slug per underlying is therefore only ever right for ONE era: the
 * first version of this map nulled the basis for every pre-2015 index day, and
 * the derivatives symbols kept the OLD spellings for years (CNXIT, JUNIOR,
 * CNX100, NFTYMCAP50 all showed up in the first backfill's UNMAPPED_INDEX
 * counter). Resolution tries each candidate for the day being summarized and
 * takes the first that actually has a row, so each era resolves itself.
 *
 * Dead underlyings stay mapped — MIDCPNIFTY stopped trading futures in 2025,
 * but its HISTORY still needs a close.
 */
const INDEX_UNDERLYING_SLUGS: Readonly<Record<string, readonly string[]>> = {
  NIFTY: ["nifty-50", "cnx-nifty"],
  MINIFTY: ["nifty-50", "cnx-nifty"],
  BANKNIFTY: ["nifty-bank", "cnx-bank"],
  FINNIFTY: ["nifty-financial-services"],
  MIDCPNIFTY: ["nifty-midcap-select"],
  // Nifty Next 50 was "CNX Nifty Junior", and the futures symbol was JUNIOR.
  NIFTYNXT50: ["nifty-next-50", "cnx-nifty-junior"],
  JUNIOR: ["nifty-next-50", "cnx-nifty-junior"],
  CNX100: ["nifty-100", "cnx-100"],
  NIFTYIT: ["nifty-it", "cnx-it"],
  CNXIT: ["nifty-it", "cnx-it"],
  NFTYMCAP50: ["nifty-midcap-50", "cnx-midcap"],
  NIFTYMID50: ["nifty-midcap-50", "cnx-midcap"],
  NIFTYPSE: ["nifty-pse", "cnx-pse"],
  CNXPSE: ["nifty-pse", "cnx-pse"],
  NIFTYINFRA: ["nifty-infrastructure", "cnx-infrastructure"],
  CNXINFRA: ["nifty-infrastructure", "cnx-infrastructure"],
  NIFTYCPSE: ["nifty-cpse"],
  DEFTY: ["cnx-defty"],
  // BSE index underlyings (SENSEX / BANKEX / SENSEX50) are deliberately NOT
  // listed. `IndexClose` is fed only by NSE's ind_close_all / Daily_Snapshot
  // families — no writer anywhere produces a `bse-*` slug — so mapping them to
  // guessed slugs would convert a LOUD `unmappedIndex` (a named symbol in the
  // run log, actionable) into a silent `indexMiss` count that looks like an
  // ordinary unpublished day. They stay unmapped until a BSE index-close feed
  // exists; then add them here with slugs verified against real rows.
  //
  // Same for the FOREIGN indices NSE briefly listed derivatives on (DJIA,
  // FTSE100, S&P500 — the 2011-2015 global-index products, all surfaced by
  // the first backfill's counter). We do not ingest a close for any of them
  // and never will from an Indian exchange feed, so their basis is
  // permanently unknowable. Leaving them LOUD is the honest state: the log
  // names them every run instead of a silent count implying we tried.
};

/**
 * Retention cutoff for STOCK derivatives — mirrors STOCK_FO_CUTOFF in
 * scripts/jobs/feed-parse.ts. Index F&O keeps its full history.
 */
const STOCK_FO_CUTOFF = Date.UTC(2018, 0, 1);

const EOD_SELECT = {
  symbol: true,
  exchange: true,
  instrument: true,
  expiry: true,
  strike: true,
  optionType: true,
  date: true,
  close: true,
  volume: true,
  openInt: true,
} as const;

type EodRow = DerivativeContractRow;

const toBig = (n: number | null): bigint | null =>
  n === null ? null : BigInt(Math.round(n));

const groupKey = (symbol: string, exchange: string): string =>
  `${symbol}|${exchange}`;

function groupByUnderlying(rows: readonly EodRow[]): Map<string, EodRow[]> {
  const map = new Map<string, EodRow[]>();
  for (const r of rows) {
    const k = groupKey(r.symbol, r.exchange);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  return map;
}

async function fetchDay(date: Date): Promise<EodRow[]> {
  return prisma.derivativeEOD.findMany({
    where: { date },
    select: EOD_SELECT,
  });
}

/** Distinct trading days in a collection, ascending. Raw: Prisma has no distinct-on-Mongo pushdown. */
async function distinctDates(collection: string): Promise<Date[]> {
  const res = (await prisma.$runCommandRaw({
    distinct: collection,
    key: "date",
  })) as { values?: Array<{ $date: string } | string> };
  const dates = (res.values ?? []).map((v) =>
    typeof v === "string" ? new Date(v) : new Date(v.$date),
  );
  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates;
}

/**
 * Per-day EOD coverage: which underlyings have raw rows, and whether each is a
 * stock derivative (so the pre-2018 retention rule can be mirrored).
 *
 * One aggregation instead of a per-day query — `derivative_eod` is a 90-day
 * window in steady state, and during a chunked repair the window is smaller
 * still.
 */
/**
 * Run an aggregate and return every row — or throw.
 *
 * `$runCommandRaw` hands back a RAW cursor: `{cursor: {firstBatch, id}}`. A
 * non-zero `id` means the server is holding more results. `batchSize` is only a
 * request; the server still caps a batch at 16MB.
 *
 * The first version of these two coverage queries read `firstBatch` and stopped.
 * On prod that returned exactly 100,000 of ~340,000 groups with
 * `cursor.id = 32567277457545824` — 71% of the data dropped, silently, by the
 * function whose entire job is detecting missing data. Every day then looked
 * partially summarised, including days that were complete.
 *
 * It cannot be fixed by following the cursor. Prisma marshals the raw reply
 * through JSON, and Mongo cursor ids exceed 2^53 — the id above is already
 * corrupted by float rounding before we could send a `getMore`, so it would
 * address the wrong cursor or none at all.
 *
 * So the contract is inverted: callers keep result sets small (see the
 * year-chunked, one-doc-per-day pipelines below), and this throws if the cursor
 * was NOT exhausted. A loud failure is recoverable; a silent 71% truncation
 * produced a two-year backfill that confirmed the gap did not exist.
 */
async function aggregateAll<T>(
  collection: string,
  pipeline: object[],
): Promise<T[]> {
  const BATCH = 50_000;
  const res = (await prisma.$runCommandRaw({
    aggregate: collection,
    pipeline,
    cursor: { batchSize: BATCH },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: T[]; id?: number } };

  const batch = res.cursor.firstBatch;
  const id = res.cursor.id ?? 0;
  if (Number(id) !== 0) {
    throw new Error(
      `aggregate on ${collection} did not fit one batch ` +
        `(${batch.length} rows, cursor still open). Narrow the chunk — ` +
        `reading a partial batch is what MONEY-1189 was fixing.`,
    );
  }
  return batch;
}

/**
 * Half-open calendar-year windows spanning a collection's ACTUAL date range.
 *
 * Derived rather than hardcoded: `derivative_eod` is pruned after summarising
 * and currently holds ~3 months, while `derivative_summary` reaches back to
 * 2000-06-12. A fixed 1999→now sweep would run ~26 pointless aggregates against
 * the EOD collection on every invocation.
 */
async function yearChunks(
  collection: string,
): Promise<Array<{ gte: Date; lt: Date }>> {
  const rows = await aggregateAll<{ min?: { $date: string }; max?: { $date: string } }>(
    collection,
    [{ $group: { _id: null, min: { $min: "$date" }, max: { $max: "$date" } } }],
  );
  const b = rows[0];
  if (!b?.min || !b?.max) return [];

  const from = new Date(b.min.$date).getUTCFullYear();
  const to = new Date(b.max.$date).getUTCFullYear();
  const out: Array<{ gte: Date; lt: Date }> = [];
  for (let y = from; y <= to; y++) {
    out.push({ gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) });
  }
  return out;
}

/**
 * The `instrument` values that mean "stock underlying", resolved from the data.
 *
 * The writer's test is `instrument.endsWith("STK")` (FUTSTK / OPTSTK). Running
 * that as `$regexMatch` inside the aggregation costs a regex evaluation on each
 * of ~2.5M EOD rows. The distinct instrument set is tiny and stable, so
 * resolving it once and matching with `$in` is the same predicate at a fraction
 * of the cost — and stays exact if NSE ever adds another *STK type.
 */
async function stockInstruments(): Promise<string[]> {
  const rows = await aggregateAll<{ _id: string }>("derivative_eod", [
    { $group: { _id: "$instrument" } },
  ]);
  return rows
    .map((r) => r._id)
    .filter((i): i is string => typeof i === "string" && i.endsWith("STK"));
}

type DayBucket = { _id: { $date: string } | string; u: Array<{ k: string; s: number }> };

/**
 * Per-day EOD coverage: which underlyings a day is expected to have summaries
 * for.
 *
 * The pipeline groups TWICE. The first collapses contracts to underlyings; the
 * second collapses underlyings into one document per day, which is what keeps
 * the reply bounded — ~250 keys/day instead of one document per (day,
 * underlying). Combined with the year chunking, a batch holds ~250 days of
 * ~5KB documents rather than 340,000 loose rows.
 */
async function eodCoverage(): Promise<Map<number, Set<UnderlyingKey>>> {
  const out = new Map<number, Set<UnderlyingKey>>();
  const stkTypes = await stockInstruments();

  for (const win of await yearChunks("derivative_eod")) {
    const rows = await aggregateAll<DayBucket>("derivative_eod", [
      { $match: { date: { $gte: { $date: win.gte.toISOString() }, $lt: { $date: win.lt.toISOString() } } } },
      {
        $group: {
          _id: { date: "$date", symbol: "$symbol", exchange: "$exchange" },
          // An underlying is a STOCK underlying when its contracts are
          // FUTSTK/OPTSTK. $max over a 0/1 flag = "any contract is a stock
          // contract", which is the same test summarizeDay applies per row.
          isStock: {
            $max: { $cond: [{ $in: ["$instrument", stkTypes] }, 1, 0] },
          },
        },
      },
      {
        $group: {
          _id: "$_id.date",
          u: {
            $push: {
              k: { $concat: ["$_id.symbol", "|", "$_id.exchange"] },
              s: "$isStock",
            },
          },
        },
      },
    ]);

    for (const r of rows) {
      const iso = typeof r._id === "string" ? r._id : r._id.$date;
      const ms = new Date(iso).getTime();
      out.set(
        ms,
        retainedUnderlyings(
          ms,
          r.u.map((x) => ({ key: x.k, isStock: x.s === 1 })),
          STOCK_FO_CUTOFF,
        ),
      );
    }
  }

  return out;
}

/** Per-day summary coverage: which underlyings already have a summary row. */
async function summaryCoverage(): Promise<Map<number, Set<UnderlyingKey>>> {
  const out = new Map<number, Set<UnderlyingKey>>();

  for (const win of await yearChunks("derivative_summary")) {
    const rows = await aggregateAll<{ _id: { $date: string } | string; u: string[] }>(
      "derivative_summary",
      [
        { $match: { date: { $gte: { $date: win.gte.toISOString() }, $lt: { $date: win.lt.toISOString() } } } },
        {
          $group: {
            _id: "$date",
            u: { $addToSet: { $concat: ["$symbol", "|", "$exchange"] } },
          },
        },
      ],
    );

    for (const r of rows) {
      const iso = typeof r._id === "string" ? r._id : r._id.$date;
      out.set(new Date(iso).getTime(), new Set(r.u));
    }
  }

  return out;
}

interface CloseCounters {
  stockMiss: number;
  indexMiss: number;
  unmappedIndex: Set<string>;
}

/**
 * Cash closes for every underlying present on `date`, keyed
 * `symbol|exchange`. One batch query per source; misses counted.
 */
async function fetchUnderlyingCloses(
  date: Date,
  groups: Map<string, EodRow[]>,
  counters: CloseCounters,
): Promise<Map<string, number>> {
  const stockSyms = new Map<string, string[]>(); // exchange -> symbols
  // groupKey -> the era-ordered slug candidates for that underlying.
  const indexCandidates = new Map<string, readonly string[]>();

  for (const [key, rows] of groups) {
    const [symbol, exchange] = key.split("|") as [string, string];
    const isIndex = rows.some((r) => r.instrument.includes("IDX"));
    if (isIndex) {
      const candidates = INDEX_UNDERLYING_SLUGS[symbol];
      if (!candidates) {
        counters.unmappedIndex.add(symbol);
        continue;
      }
      indexCandidates.set(key, candidates);
    } else {
      const arr = stockSyms.get(exchange);
      if (arr) arr.push(symbol);
      else stockSyms.set(exchange, [symbol]);
    }
  }

  const closes = new Map<string, number>();

  for (const [exchange, symbols] of stockSyms) {
    const mappings = await prisma.instrumentMapping.findMany({
      where: { symbol: { in: symbols }, exchange },
      select: { id: true, symbol: true },
    });
    const byInstrument = new Map(mappings.map((m) => [m.id, m.symbol]));
    const prices = await prisma.dailyPrice.findMany({
      where: { instrumentId: { in: mappings.map((m) => m.id) }, date },
      select: { instrumentId: true, close: true },
    });
    for (const p of prices) {
      const symbol = byInstrument.get(p.instrumentId);
      if (symbol) closes.set(groupKey(symbol, exchange), p.close);
    }
    counters.stockMiss += symbols.filter(
      (s) => !closes.has(groupKey(s, exchange)),
    ).length;
  }

  if (indexCandidates.size > 0) {
    // One query for every candidate across every index underlying; the
    // era-correct one is whichever came back with a row for THIS day.
    const allSlugs = [...new Set([...indexCandidates.values()].flat())];
    const rows = await prisma.indexClose.findMany({
      where: { indexSlug: { in: allSlugs }, date },
      select: { indexSlug: true, close: true },
    });
    const bySlug = new Map(rows.map((r) => [r.indexSlug, r.close]));
    for (const [key, candidates] of indexCandidates) {
      const hit = candidates.find((s) => bySlug.has(s));
      if (hit !== undefined) closes.set(key, bySlug.get(hit)!);
      // Mapped but no row under ANY spelling: the index simply was not
      // published that day. Counted, never guessed — a null basis is honest.
      else counters.indexMiss++;
    }
  }

  return closes;
}

interface DayResult {
  date: Date;
  underlyings: number;
  written: number;
  /** Sum of the calc's rejected-row audit counters — non-zero is a signal. */
  rejected: number;
  counters: CloseCounters;
}

async function summarizeDay(
  date: Date,
  todayRows: EodRow[],
  prevRows: readonly EodRow[] | null,
): Promise<DayResult> {
  // Pre-2018 STOCK derivatives are out of retention (founder decision
  // 2026-08-11; enforced at the parse writer too). Without this a --backfill
  // would re-derive summaries for underlyings whose EOD rows were deleted,
  // publishing analytics with nothing behind them. Index F&O is unaffected.
  const retained =
    date.getTime() >= STOCK_FO_CUTOFF
      ? todayRows
      : todayRows.filter((r) => !r.instrument.endsWith("STK"));
  const groups = groupByUnderlying(retained);
  const prevGroups = prevRows
    ? groupByUnderlying(
        prevRows.filter(
          (r) =>
            !r.instrument.endsWith("STK") ||
            r.date.getTime() >= STOCK_FO_CUTOFF,
        ),
      )
    : null;
  const counters: CloseCounters = {
    stockMiss: 0,
    indexMiss: 0,
    unmappedIndex: new Set(),
  };
  const closes = await fetchUnderlyingCloses(date, groups, counters);

  let rejected = 0;
  const data: Prisma.DerivativeSummaryCreateManyInput[] = [];
  for (const [key, rows] of groups) {
    const [symbol, exchange] = key.split("|") as [string, string];
    const underlyingClose = closes.get(key) ?? null;
    const calc = computeDerivativeSummary({
      symbol,
      exchange,
      date,
      today: rows,
      prevDay: prevGroups?.get(key) ?? undefined,
      underlyingClose,
    });
    // Rows the calc declined to use. Input is pre-grouped, so its symbol /
    // exchange / date filters should never fire — but non-finite numerics,
    // zero-strike options and UNRECOGNISED option types legitimately do, and
    // that last one is why this counter is logged rather than asserted on: a
    // sustained REJECTED spike in one era is how the pre-2011 American-style
    // CA/PA stock options were found (silently dropped, nulling PCR and max
    // pain across a decade). Treat a spike as "an era speaks a dialect we do
    // not parse yet", not as a grouping bug.
    rejected += calc.rowsRejected + calc.prevRowsRejected;
    data.push({
      symbol,
      exchange,
      date,
      futOi: toBig(calc.futOi),
      futOiChange: toBig(calc.futOiChange),
      futBasisPct: calc.futBasisPct,
      pcrOi: calc.pcrOi,
      pcrVol: calc.pcrVol,
      maxPain: calc.maxPain,
      rolloverPct: calc.rolloverPct,
      oiBuildup: calc.oiBuildup,
      nearFutExpiry: calc.nearFutExpiry,
      nearFutOi: toBig(calc.nearFutOi),
      nearFutClose: calc.nearFutClose,
      maxPainExpiry: calc.maxPainExpiry,
      callOi: toBig(calc.callOi),
      putOi: toBig(calc.putOi),
      callVol: toBig(calc.callVol),
      putVol: toBig(calc.putVol),
      // Echo of the INPUT, not a calc output — the model stores what the
      // basis was priced against (null = no cash close found, basis null).
      underlyingClose,
    });
  }

  if (!DRY_RUN && data.length > 0) {
    // Idempotent per day: replace the whole day under the unique.
    await prisma.derivativeSummary.deleteMany({ where: { date } });
    await prisma.derivativeSummary.createMany({ data });
  }

  return {
    date,
    underlyings: groups.size,
    written: data.length,
    rejected,
    counters,
  };
}

function logDay(r: DayResult): void {
  const iso = r.date.toISOString().slice(0, 10);
  const miss =
    r.counters.stockMiss + r.counters.indexMiss > 0
      ? ` closeMiss(stock=${r.counters.stockMiss} index=${r.counters.indexMiss})`
      : "";
  const unmapped =
    r.counters.unmappedIndex.size > 0
      ? ` UNMAPPED_INDEX=${[...r.counters.unmappedIndex].join(",")}`
      : "";
  const rej = r.rejected > 0 ? ` REJECTED=${r.rejected}` : "";
  log.info(
    `${iso}: underlyings=${r.underlyings} written=${r.written}${miss}${unmapped}${rej}`,
  );
}

/**
 * Drop raw EOD rows outside the retention window — but ONLY for days this job
 * has already summarised.
 *
 * That ordering is the whole safety property: pruning an unsummarised day
 * would discard the input before its output existed. Recoverable from the GCS
 * archive by re-parsing, but silently wrong until someone noticed, which is
 * the failure mode this subsystem keeps having to design against.
 *
 * Runs AFTER the derivation in the same process, so the window maintains
 * itself nightly instead of needing a separate scheduled job that could drift
 * out of step with what has actually been summarised.
 */
/**
 * Drop raw EOD rows for days that are safely summarised.
 *
 * The gate used to be `summarised.has(day)` — the SAME day-granularity mistake
 * as the backfill selector, and the one that made the 2024-07→2026-05 gap
 * permanent rather than merely late. A day carrying only its BSE summaries
 * counted as summarised, so its NSE raw rows were deleted, and with them the
 * only copy of the input the missing NSE summaries could have been derived
 * from. Recovering those 456 days now requires re-downloading and re-parsing
 * the archive.
 *
 * So the gate is completeness, not presence: prune only days where EVERY
 * retained underlying already has a summary row. A day that is still
 * incomplete keeps its raw rows and gets summarised on a later pass.
 */
async function pruneOldEod(): Promise<void> {
  const cutoff = new Date(
    Date.now() - EOD_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  const eodDays = await distinctDates("derivative_eod");
  const incomplete = new Set(
    selectIncompleteDays(await eodCoverage(), await summaryCoverage()).map(
      (d) => d.dateMs,
    ),
  );
  const held = eodDays.filter(
    (d) => d.toISOString() < cutoff && incomplete.has(d.getTime()),
  );
  if (held.length > 0) {
    log.info(
      `retention: HOLDING ${held.length} day(s) past the window — still ` +
        `incomplete, raw rows are the only way to finish them ` +
        `(e.g. ${held.slice(0, 3).map((d) => d.toISOString().slice(0, 10)).join(", ")})`,
    );
  }
  const prunable = eodDays.filter(
    (d) => d.toISOString() < cutoff && !incomplete.has(d.getTime()),
  );
  if (prunable.length === 0) {
    log.info(`retention: nothing outside the ${EOD_RETENTION_DAYS}d window`);
    return;
  }
  let deleted = 0;
  for (const day of prunable) {
    const res = (await prisma.$runCommandRaw({
      delete: "derivative_eod",
      deletes: [{ q: { date: { $date: day.toISOString() } }, limit: 0 }],
    })) as { n?: number };
    deleted += res.n ?? 0;
  }
  log.info(
    `retention: pruned ${deleted.toLocaleString()} raw EOD rows across ` +
      `${prunable.length} summarised day(s) older than ${EOD_RETENTION_DAYS}d ` +
      `(source bytes remain in feeds/NSE/fo-*)`,
  );
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  reportBuildProvenance(log, "fo-summary");

  const eodDates = await distinctDates("derivative_eod");
  if (eodDates.length === 0) {
    log.info("no DerivativeEOD rows — nothing to summarize (expected on QA)");
    await prisma.$disconnect();
    return;
  }

  let targets: Date[];
  if (DATE) {
    const d = new Date(`${DATE}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`bad --date: ${DATE}`);
    targets = [d];
  } else {
    // MONEY-1189 — completeness is measured per (day, UNDERLYING), not per day.
    //
    // The previous check was `eodDates − summaryDates`: a day carrying ANY
    // summary row counted as done. On prod that hid a two-year hole — days with
    // only their BSE half summarised looked complete, so ~108k NSE rows were
    // never derived and every re-run confirmed the gap did not exist.
    const [expected, present] = await Promise.all([
      eodCoverage(),
      summaryCoverage(),
    ]);
    const incomplete = selectIncompleteDays(expected, present);

    const chosen = BACKFILL
      ? incomplete
      : // The nightly sweeps a short trailing window rather than only the last
        // EOD date, so a day whose data lands after the run — or a night that
        // is missed entirely — heals on the next run instead of becoming a
        // permanent hole.
        selectNightlyTargets(
          incomplete,
          eodDates[eodDates.length - 1]!.getTime(),
          NIGHTLY_WINDOW_DAYS,
        );

    targets = chosen.map((d) => new Date(d.dateMs));

    const partial = chosen.filter((d) => d.present > 0);
    log.info(
      `${BACKFILL ? "backfill" : `nightly (${NIGHTLY_WINDOW_DAYS}d window)`}: ` +
        `${targets.length} incomplete day(s) of ${expected.size} with EOD rows` +
        `${partial.length ? `, of which ${partial.length} are PARTIALLY summarised` : ""} — ` +
        `mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`,
    );
    // A partially-summarised day is the exact shape that was invisible before,
    // so name the worst offenders rather than only counting them.
    for (const d of partial.slice(0, 5)) {
      log.info(
        `   partial ${new Date(d.dateMs).toISOString().slice(0, 10)}: ` +
          `${d.present}/${d.expected} underlyings, missing e.g. ${d.missing.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (DRY_RUN && targets.length > 3) targets = targets.slice(0, 3);

  let totalWritten = 0;
  // Rolling prev-day cache: in ascending order, today's rows are the next
  // target's prev-day — each day is read exactly once across a backfill.
  let prevDate: Date | null = null;
  let prevRows: EodRow[] | null = null;

  for (const date of targets) {
    // The previous TRADING day is the previous distinct EOD date, whether or
    // not it was a backfill target.
    const idx = eodDates.findIndex((d) => d.getTime() === date.getTime());
    const wantPrev = idx > 0 ? eodDates[idx - 1]! : null;
    if (wantPrev && (!prevDate || prevDate.getTime() !== wantPrev.getTime())) {
      prevRows = await fetchDay(wantPrev);
      prevDate = wantPrev;
    } else if (!wantPrev) {
      prevRows = null;
      prevDate = null;
    }

    const todayRows = await fetchDay(date);
    const result = await summarizeDay(date, todayRows, prevRows);
    logDay(result);
    totalWritten += result.written;

    prevRows = todayRows;
    prevDate = date;
  }

  log.info(
    `DONE: days=${targets.length} summaries=${totalWritten}${DRY_RUN ? " (dry-run, nothing written)" : ""}`,
  );

  if (PRUNE && !DRY_RUN) await pruneOldEod();

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[fo-summary] failed:", err);
  process.exitCode = 1;
});
