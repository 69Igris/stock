/**
 * Replay the archived India exchange files into `lake_silver`. MONEY-1497 (B2-IN).
 *
 * A Cloud Run JOB, run as a script. Writes four silver tables from bytes we
 * already hold — no exchange traffic, no Mongo write, nothing a user can see:
 *
 *   price_bar_d1 (market='IN')   NSE + BSE cash bhavcopy, legacy and UDiFF
 *   derivatives_eod_in           NSE + BSE F&O, legacy and UDiFF
 *   delivery_daily               sec_bhavdata_full
 *   index_eod                    ind_close_all, all thirteen columns
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/lake-replay-in.ts --env qa --from 2024-01-01 --to 2024-01-31
 *     npx tsx scripts/jobs/lake-replay-in.ts --env qa --from 2024-01-01 --to 2024-01-31 --apply
 *     npx tsx scripts/jobs/lake-replay-in.ts --env prod --from 1994-11-03 --to 2026-09-22 \
 *         --tables=price_bar_d1 --apply
 *
 * DRY RUN BY DEFAULT. Without `--apply` it fetches, parses, maps and reports —
 * which is the useful half for sizing a shard — and writes no object, no row
 * and no ledger entry.
 *
 * ## WHY THIS IS NOT A FLAG ON `feed-parse`
 *
 * The B2-IN brief says to add the sink inside `feed-parse`. Two measured
 * properties of that job make a replay there load almost nothing while
 * reporting a clean run, which is the failure shape this whole lane exists to
 * remove:
 *
 * 1. **`feed-parse` is LISTING-DRIVEN.** It walks
 *    `listFiles("feeds/{exchange}/{feed}/")`, and `listFiles` FAILS OPEN to
 *    `[]` — an empty prefix and a storage failure are the same answer. The
 *    brief's own rule forbids deciding anything from a listing. This job
 *    COMPUTES every key from the registry's `buildUrl` + `buildFeedArchiveKey`
 *    and fetches it; a 404 is a real absence.
 * 2. **`feed-parse` filters by its own Mongo checkpoint.** `pending` is the
 *    listing minus every file already `DONE` in `FeedBackfillProgress` — which
 *    is nearly all of history, because the P3/P4 backfills already ran. A lake
 *    sink placed inside it would therefore never SEE the history it was added
 *    to replay. Bypassing that filter for one sink would give the replay and
 *    the nightly two different paths through one job, and this repo has paid
 *    for that shape before ("the first run and the thousandth take one path").
 *
 * The same argument, from the other side: `FeedBackfillProgress` records ONE
 * status per (family, date). A Mongo-success / BigQuery-failure would stamp
 * `DONE` and resume would skip it for ever. This job's idempotency is the B1
 * LEDGER instead, which is keyed on (dataset, table, partition, source_hash,
 * parser_version) and cannot be confused with Mongo's.
 *
 * Mongo is untouched either way. `DailyPrice` remains the hot/live table and
 * `mayWritePriceSource` still governs it.
 *
 * ## THE UNIT IS A MONTH, LOADED AS ONE
 *
 * `price_bar_d1` and the three new tables are all MONTH-partitioned, so the
 * ledger claim is a month. Within a month the job streams ONE STAGE OBJECT PER
 * SESSION DATE — a month of NSE F&O UDiFF is every strike on every underlying
 * for ~21 sessions and will not fit in memory — and hands `bq load` a wildcard
 * over the run's own folder. `replaceMonth` DELETEs the month before the load,
 * so a crash between load and accept, or a repaired archive object, cannot
 * leave the month holding two parses.
 */
import {
  buildFeedArchiveKey,
  decodeFeedText,
  familiesForBackfill,
  familyById,
  parseNseIndicesCsv,
  parseOldBseCmBhavcopy,
  parseOldNseCmBhavcopy,
  parseOldNseFoBhavcopy,
  parseSecBhavdataFull,
  parseUdiffBhavcopy,
  parseUdiffFoBhavcopy,
  specialSessionCandidateDates,
  type BhavcopyRow,
  type LegacyDerivativeRow,
  type ReportFamily,
} from "@usemoney/core/market-data";
import { buildListingId } from "@usemoney/core/market-data/tiingo/tiingo-logic";
import { bucketForPrefix } from "@usemoney/core/ops/lake-layout";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import {
  acceptPartition,
  beginRun,
  endRun,
  claimPartition,
  quarantine,
  rejectPartition,
} from "@usemoney/lake/ledger";
import {
  acceptOrRefuse,
  decideCoverage,
  formatRefusal,
  missingSessions,
  objectUri,
  runId,
  throwIfRefused,
  type PartitionRefusal,
} from "@usemoney/lake/ledger-logic";
import {
  INDIA_DEDUPE_KEYS,
  INDIA_FAMILIES,
  INDIA_TABLES,
  IN_MARKET,
  classifyPricedRow,
  decideMonth,
  dedupeIndiaRows,
  enumerateSessionCandidates,
  classifyReadDate,
  classifyReadFile,
  combineBhavcopyProbes,
  combineOwnKeyMatches,
  compareArchivedObjects,
  describeForeignSessions,
  groupDatesByMonth,
  indiaParserVersion,
  indiaPartitionKey,
  indiaSourceHash,
  isIndiaTable,
  isStaleCopyCandidate,
  isSessionInPartition,
  monthDeleteBounds,
  siftRows,
  sourceFor,
  toDeliveryDailyRow,
  toDerivativeEodRow,
  toIndexEodRow,
  toIndiaPriceBarRow,
  type ContributingFile,
  type DeliveryDailyRow,
  type DerivativeEodRow,
  type IndexEodRow,
  type IndiaPriceBarRow,
  type IndiaTable,
  type OwnKeyMatch,
  type ReadDateVerdict,
  type RowProvenance,
} from "@usemoney/lake/india-sink-logic";
import { replaceMonth } from "@usemoney/lake/load";
import {
  encodeNdjson,
  stageKey,
  stageShardPrefix,
  STAGE_UPLOAD_POLICY,
} from "@usemoney/lake/stage-logic";
import { downloadFile, getFileMetadata, uploadFile } from "@usemoney/storage";
import { toIndexSlug } from "../../workers/src/processors/bhavcopy-sync-logic";

import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB = "lake-replay-in";

/**
 * The four silver row shapes this job writes.
 *
 * A UNION rather than `Record<string, unknown>`, so the compiler still knows
 * which columns exist after `mapRows` returns. Widening to an index signature
 * would make every downstream field access unchecked — including
 * `session_date`, which the coverage count is derived from.
 */
type IndiaRow =
  | IndiaPriceBarRow
  | DerivativeEodRow
  | DeliveryDailyRow
  | IndexEodRow;

// `unknown`, not `string`: `reportBuildProvenance` takes a logger whose
// methods accept anything, and a narrower parameter is not assignable to it.
const log = {
  info: (m: unknown) => console.log(m),
  warn: (m: unknown) => console.warn(`WARN  ${String(m)}`),
  err: (m: unknown) => console.error(`ERROR ${String(m)}`),
  error: (m: unknown) => console.error(`ERROR ${String(m)}`),
};

interface Args {
  env: "qa" | "prod";
  from: string;
  to: string;
  tables: IndiaTable[];
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
    const inline = argv.find((a) => a.startsWith(`${flag}=`));
    return inline?.slice(flag.length + 1);
  };

  const env = val("--env");
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");

  const from = val("--from") ?? "";
  const to = val("--to") ?? "";
  if (!from || !to) {
    // NO DEFAULT WINDOW. A replay that defaults to "everything" is a
    // thirty-year walk somebody started by accident; one that defaults to
    // "today" silently does nothing when the operator meant the backfill.
    throw new Error("--from and --to are required (YYYY-MM-DD)");
  }

  const raw = val("--tables");
  const tables = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...INDIA_TABLES];
  for (const t of tables) {
    if (!isIndiaTable(t)) {
      throw new Error(
        `--tables: "${t}" is not one of ${INDIA_TABLES.join(" | ")}`,
      );
    }
  }

  return {
    env,
    from,
    to,
    tables: tables as IndiaTable[],
    apply: argv.includes("--apply"),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Adapters — core's parser rows onto india-sink-logic's inputs
   ────────────────────────────────────────────────────────────────────────

   These are the one place a parser field name and a lake column name meet, and
   they are TYPE-CHECKED against both: a renamed `BhavcopyRow.prevClose` or a
   renamed `IndiaCashBar.sessionDate` fails `yarn type-check`. That is why the
   pure module declares its inputs structurally instead of importing core —
   `packages/core` must not depend on `@usemoney/lake` (databento-repo.ts:911),
   and the mirror keeps the lake package free of the market-data tree.

   `buildListingId` is handed to the two mappers whose rows carry a
   `listing_id`, for the same reason: it is core's, and the ONE builder every
   lake writer uses (MONEY-1522). Pass it, never a lambda — a hand-spelled id
   here is exactly how India's bars and identity came to share no key. */

/** `Date` -> `YYYY-MM-DD`. The parsers emit UTC midnight of the IST day. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function cashRows(
  familyId: string,
  csv: string,
  day: Date,
): BhavcopyRow[] | null {
  switch (familyId) {
    case "nse-cm-legacy":
      return parseOldNseCmBhavcopy(csv, day).rows;
    case "nse-cm-udiff-bhavcopy":
      return parseUdiffBhavcopy(csv, "NSE", day);
    case "bse-cm-udiff-bhavcopy":
      return parseUdiffBhavcopy(csv, "BSE", day);
    case "bse-cm-legacy":
    case "bse-cm-isin-legacy":
      // NULL means "unrecognised header", which is DISTINCT from "no rows" —
      // BSE moved a column mid-2017 and this format demonstrably drifts. The
      // caller treats null as a file it could not read, so the month is not
      // ACCEPTED over it; a zero-row result would be recorded as a quiet day.
      return parseOldBseCmBhavcopy(csv, day)?.rows ?? null;
    default:
      return null;
  }
}

function foRows(
  familyId: string,
  csv: string,
  day: Date,
): LegacyDerivativeRow[] | null {
  switch (familyId) {
    case "nse-fo-legacy":
      return parseOldNseFoBhavcopy(csv, day).rows;
    case "nse-fo-udiff-bhavcopy":
      return parseUdiffFoBhavcopy(csv, "NSE", day).rows;
    case "bse-fo-udiff-bhavcopy":
      return parseUdiffFoBhavcopy(csv, "BSE", day).rows;
    default:
      return null;
  }
}

/**
 * One day-file's silver rows, plus the distinct dates of the rows its parser
 * dropped for not matching the key (see `classifyReadFile`). Only
 * `delivery_daily`'s parser reports them; every other table reports none.
 */
interface MappedFile {
  rows: IndiaRow[];
  mismatchedDates: readonly string[];
}

const fresh = (rows: IndiaRow[]): MappedFile => ({ rows, mismatchedDates: [] });

/**
 * Map one day-file's parsed rows onto silver rows.
 *
 * `exchange` comes from the FAMILY, never from the row: `LegacyDerivativeRow`
 * types its own `exchange` as the literal `"NSE"` even when
 * `parseUdiffFoBhavcopy` was handed `"BSE"`, so trusting the row would file
 * every BSE contract under NSE.
 *
 * `feed-parse` drops pre-2018 STOCK derivatives by RETENTION POLICY
 * (`STOCK_FO_CUTOFF`) before writing Mongo. That filter is deliberately NOT
 * applied here: the policy exists because `derivative_eod` is 24.0 GiB inside a
 * 16 GB-RAM Atlas tier, which is the constraint this table exists to escape.
 * The lake gets what the file said.
 */
function mapRows(
  table: IndiaTable,
  familyId: string,
  exchange: string,
  csv: string,
  day: Date,
  prov: RowProvenance,
): MappedFile | null {
  switch (table) {
    case "price_bar_d1": {
      const rows = cashRows(familyId, csv, day);
      if (rows === null) return null;
      return fresh(
        rows.map((r) =>
          toIndiaPriceBarRow(
            {
              symbol: r.symbol,
              exchange: r.exchange,
              isin: r.isin,
              sessionDate: iso(r.date),
              open: r.open,
              high: r.high,
              low: r.low,
              close: r.close,
              volume: r.volume,
              series: r.series,
            },
            prov,
            sourceFor(table),
            buildListingId,
          ),
        ),
      );
    }
    case "derivatives_eod_in": {
      const rows = foRows(familyId, csv, day);
      if (rows === null) return null;
      return fresh(
        rows.map((r) =>
          toDerivativeEodRow(
            {
              underlying: r.symbol,
              exchange,
              instrumentType: r.instrument,
              expiryDate: iso(r.expiry),
              strike: r.strike,
              optionType: r.optionType,
              sessionDate: iso(r.date),
              open: r.open,
              high: r.high,
              low: r.low,
              close: r.close,
              settle: r.settle,
              openInterest: r.openInt,
              changeInOi: r.oiChange,
              contractsTraded: r.volume,
              valueLakh: r.valueLakh,
            },
            prov,
            sourceFor(table),
          ),
        ),
      );
    }
    case "delivery_daily": {
      if (familyId !== "nse-sec-bhavdata-full") return null;
      const parsed = parseSecBhavdataFull(csv, day);
      return {
        mismatchedDates: parsed.mismatchedDates,
        rows: parsed.rows.map((r) =>
          toDeliveryDailyRow(
            {
              symbol: r.symbol,
              exchange,
              // `sec_bhavdata_full` carries no ISIN column. NULL, never "".
              isin: null,
              series: r.series,
              sessionDate: iso(r.date),
              tradedQty: r.volume,
              deliverableQty: r.deliveryQty,
              deliveryPct: r.deliveryPct,
            },
            prov,
            sourceFor(table),
            buildListingId,
          ),
        ),
      };
    }
    case "index_eod": {
      return fresh(
        parseNseIndicesCsv(csv, day).map((r) =>
          toIndexEodRow(
            {
              indexSlug: toIndexSlug(r.name),
              indexName: r.name,
              exchange,
              sessionDate: iso(r.date),
              open: r.open,
              high: r.high,
              low: r.low,
              close: r.close,
              prevClose: r.prevClose,
              volume: r.volume,
              turnoverCr: r.turnoverCr,
              pe: r.pe,
              pb: r.pb,
              divYield: r.divYield,
            },
            prov,
            sourceFor(table),
          ),
        ),
      );
    }
  }
}

/**
 * The classifier per table and per partition.
 *
 * WRONG_MONTH IS CHECKED FIRST, and for every table including `delivery_daily`.
 * The archive key says which day a file is; the parser reads the day off the
 * file's own column, and the two can disagree. A stray row cannot be corrected
 * later, because `replaceMonth` deletes ONE month and the row is outside it.
 *
 * `delivery_daily` carries no prices, so the PRICE rung would refuse every one
 * of its rows. Its own failure mode is an unbuildable `listing_id`, and
 * `buildListingId` throws on a blank half before such a row is ever
 * constructed — which `replayMonth` counts as an unreadable file.
 */
function classifierFor(
  table: IndiaTable,
  partitionKey: string,
): (row: IndiaRow) => ReturnType<typeof classifyPricedRow> {
  return (row) => {
    if (!isSessionInPartition(partitionKey, row.session_date)) {
      return "WRONG_MONTH";
    }
    if (table === "delivery_daily") return null;
    const priced = row as IndiaPriceBarRow | DerivativeEodRow | IndexEodRow;
    return classifyPricedRow({
      open: priced.open,
      high: priced.high,
      low: priced.low,
      close: priced.close,
    });
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The walk
   ──────────────────────────────────────────────────────────────────────── */

/** The archive key a family's file for `day` lives at, or null if it has none. */
function archiveKeyFor(family: ReportFamily, day: Date): string | null {
  const url = family.buildUrl(day);
  if (!url) return null;
  return buildFeedArchiveKey(
    {
      exchange: family.exchange,
      feed: family.feed,
      date: day,
      basename: family.buildBasename?.(day),
    },
    url,
  );
}

/**
 * Is `exchange`'s cash price bhavcopy in the archive for `date`? `present` is
 * `null` when no bhavcopy family of that exchange is walkable that day —
 * absence then proves nothing. MONEY-1612: the independent signal that turns a
 * stale copy into a holiday, because the bhavcopy archive 404s on holidays.
 *
 * `absentKeys` are the keys that proved it. A holiday's month HASHES them (as
 * generation "absent"), because the proof rests on their absence: archiving
 * one later must change the hash so the month is judged again.
 *
 * KNOWN COST, ACCEPTED: the keys are whatever the price_bar_d1 families that
 * are walkable that day produce. Flipping a price family's `backfillable`
 * flag, or registering a new NSE cash price family, changes `absentKeys` for
 * every holiday and so changes the hash — every delivery month with a holiday
 * reloads once. Correct (the proof changed), and a one-off; said here so the
 * reload is not mistaken for a defect.
 */
interface BhavcopyProbeResult {
  present: boolean | null;
  absentKeys: string[];
}
type BhavcopyProbe = (
  exchange: string,
  date: string,
) => Promise<BhavcopyProbeResult>;

/** `getFileMetadata`, memoised for the run (`null` = no such object). */
type Head = (key: string) => Promise<Record<string, unknown> | null>;

/**
 * One HEAD per archive key per run. The replay reads a file's metadata, and a
 * later file may need the same object's hashes to prove it is a duplicate of
 * it (MONEY-1612) — usually a date earlier in the same month, so a hit.
 */
function makeHead(): Head {
  const memo = new Map<string, Promise<Record<string, unknown> | null>>();
  return (key) => {
    let hit = memo.get(key);
    if (!hit) {
      hit = getFileMetadata(key);
      memo.set(key, hit);
    }
    return hit;
  };
}

/**
 * A per-RUN probe over the price_bar_d1 families' archive keys. Memoised, so a
 * holiday shared by several months or tables costs one HEAD per family. A HEAD
 * (`getFileMetadata`), never a download and never BigQuery.
 */
function makeBhavcopyProbe(from: string, to: string): BhavcopyProbe {
  const windows = familiesForBackfill(from, to, [
    ...INDIA_FAMILIES.price_bar_d1,
  ]);
  const memo = new Map<string, Promise<BhavcopyProbeResult>>();
  return (exchange, date) => {
    const k = `${exchange}|${date}`;
    let hit = memo.get(k);
    if (!hit) {
      hit = (async (): Promise<BhavcopyProbeResult> => {
        const day = new Date(`${date}T00:00:00.000Z`);
        const absentKeys: string[] = [];
        for (const w of windows) {
          if (w.family.exchange !== exchange) continue;
          if (date < w.from || date > w.to) continue;
          const key = archiveKeyFor(w.family, day);
          if (!key) continue;
          if (await getFileMetadata(key)) return { present: true, absentKeys };
          absentKeys.push(key);
        }
        return { present: absentKeys.length ? false : null, absentKeys };
      })();
      memo.set(k, hit);
    }
    return hit;
  };
}

interface MonthTally {
  filesRead: number;
  /**
   * DISTINCT dates a file was read AND parsed for. The COVERAGE DENOMINATOR.
   *
   * Not `filesRead`. Two families publish every session of three of the four
   * tables from 2024 onward, so a healthy 21-session month reads 42 files and
   * yields 21 sessions — and `21 >= 42` is false, which would make
   * `acceptPartition` throw on every month this job was built to load.
   */
  datesRead: Set<string>;
  filesMissing: number;
  filesUnreadable: number;
  /**
   * Files that read and parsed cleanly and produced NO ROWS and held no other
   * date (stale copies are `filesStale`, other-date files `filesForeign`).
   *
   * The FILE count is reported, not gated — but its DATE is still expected, so
   * a date whose only file came back empty is a missing session and refuses
   * the month. What counting dates MASKS is one family going dark while a
   * sibling covers the same date; this number is how an operator sees that.
   * (It used to say "never gated", which was false: every holiday stale copy
   * below was a zero-row file that refused its month — MONEY-1612.)
   */
  filesZeroRows: number;
  /** Files that were a STALE COPY — a duplicate of an earlier weekday. */
  filesStale: number;
  /**
   * Zero-row files holding another date that is NOT a duplicate — e.g. the only
   * copy of a weekend session filed under the next weekday's key.
   */
  filesForeign: number;
  /** Read dates proved to be holidays: only stale copies, no bhavcopy. */
  holidays: Set<string>;
  /** Read dates that are `stale-gap` — still expected — and why, for the log. */
  gaps: Map<string, string>;
  rows: number;
  sessions: Set<string>;
  quarantined: Record<string, number>;
  samples: { reason: string; sample: Record<string, unknown> }[];
}

async function replayMonth(args: {
  table: IndiaTable;
  month: string;
  dates: readonly string[];
  windows: Map<string, { from: string; to: string }>;
  env: "qa" | "prod";
  apply: boolean;
  runIdent: string;
  bhavcopyPresent: BhavcopyProbe;
  head: Head;
  /** The special-session calendar — MONEY-1613. */
  calendarDates: readonly string[];
}): Promise<PartitionRefusal | null> {
  const { table, month, dates, windows, env, apply, runIdent } = args;
  const partitionKey = indiaPartitionKey(`${month}-01`);
  const parserVersion = indiaParserVersion(table);
  const bucket = bucketForPrefix("lake/stage/", env);
  const contributing: ContributingFile[] = [];
  const tally: MonthTally = {
    filesRead: 0,
    datesRead: new Set(),
    filesMissing: 0,
    filesUnreadable: 0,
    filesZeroRows: 0,
    filesStale: 0,
    filesForeign: 0,
    holidays: new Set(),
    gaps: new Map(),
    rows: 0,
    sessions: new Set(),
    quarantined: {},
    samples: [],
  };

  for (const date of dates) {
    // ONE DAY IN MEMORY AT A TIME. Every family that publishes this date
    // contributes to the same shard, so the two `ind_close_all` prefixes can be
    // de-duplicated against each other — which they must be, or the month holds
    // two rows per index-session and every aggregate double-counts.
    const dayRows: IndiaRow[] = [];
    // Per DATE, not per file: whether this date is a session is decided once
    // every family has been read — `classifyReadDate`.
    let freshFiles = 0;
    let foreignFiles = 0;
    let staleFiles = 0;
    const staleExchanges = new Set<string>();
    const foreignNotes: string[] = [];

    for (const familyId of INDIA_FAMILIES[table]) {
      const window = windows.get(familyId);
      if (!window || date < window.from || date > window.to) continue;

      const family = familyById(familyId);
      if (!family) continue;

      const day = new Date(`${date}T00:00:00.000Z`);
      const key = archiveKeyFor(family, day);
      if (!key) continue;

      // METADATA FIRST, and this is the whole no-listing design in two calls.
      // `getFileMetadata` returns null for an absent object and THROWS for an
      // absent bucket, so a 404 is a real gap rather than `listFiles`'s
      // fail-open `[]`. It also supplies the GENERATION, which `downloadFile`
      // cannot — and the generation is what makes a repaired object (MONEY-1169
      // rewrote thousands in place) produce a new month hash instead of being
      // invisible to the ledger for ever.
      const meta = await args.head(key);
      if (!meta) {
        tally.filesMissing++;
        continue;
      }
      const buf = await downloadFile(key);
      if (!buf) {
        tally.filesMissing++;
        continue;
      }

      let mapped: MappedFile | null = null;
      try {
        mapped = mapRows(
          table,
          familyId,
          family.exchange,
          decodeFeedText(buf),
          day,
          {
            sourceObjectUri: objectUri(bucketForPrefix(key, env), key),
            sourceRecordKey: `${familyId}:${date}`,
            pipelineRunId: runIdent,
            // OBSERVED is the SESSION the file describes, never `now`. Point-in-
            // time correctness is observed_at (lake-layout.md §6); stamping the
            // replay's clock would back-date thirty years of history to today.
            observedAtMs: day.getTime(),
            ingestedAtMs: Date.now(),
          },
        );
      } catch (err) {
        // An unreadable file is NOT a missing one. It is counted separately and
        // it does NOT count as read, so the month cannot be ACCEPTED over it.
        tally.filesUnreadable++;
        log.warn(
          `${table} ${familyId} ${date}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (mapped === null) {
        tally.filesUnreadable++;
        log.warn(`${table} ${familyId} ${date}: unrecognised header`);
        continue;
      }

      tally.filesRead++;
      // A stale copy still CONTRIBUTES to the source hash: if the archive
      // object is ever repaired into the real file, the month must reload.
      contributing.push({
        date,
        key,
        generation: String(meta.generation ?? ""),
      });
      // THE BYTES ARE THE PROOF — MONEY-1612. A zero-row file holding only
      // earlier weekdays is a CANDIDATE; it is stale only if it is byte-
      // identical to the file under each held date's own key. 05112021 holds
      // the 2021-11-04 Muhurat session and is its ONLY copy.
      const file = {
        rows: mapped.rows.length,
        keyDate: date,
        mismatchedDates: mapped.mismatchedDates,
        calendarDates: args.calendarDates,
      };
      let ownKeyMatch: OwnKeyMatch | null = null;
      if (isStaleCopyCandidate(file)) {
        const matches: OwnKeyMatch[] = [];
        for (const held of mapped.mismatchedDates) {
          const ownKey = archiveKeyFor(
            family,
            new Date(`${held}T00:00:00.000Z`),
          );
          matches.push(
            compareArchivedObjects(
              meta,
              ownKey ? await args.head(ownKey) : null,
            ),
          );
        }
        ownKeyMatch = combineOwnKeyMatches(matches);
      }
      const kind = classifyReadFile({ ...file, ownKeyMatch });
      if (kind === "stale") {
        tally.filesStale++;
        staleFiles++;
        staleExchanges.add(family.exchange);
        continue;
      }
      if (kind === "foreign") {
        // NOT a duplicate: it holds a session that is not archived under its
        // own key, or not byte-identical to it (MONEY-1612). Still expected, so
        // the month refuses rather than accepting without it. Its rows are NOT
        // loaded under their own date here — that is a separate change.
        tally.filesForeign++;
        foreignFiles++;
        foreignNotes.push(
          describeForeignSessions(
            date,
            mapped.mismatchedDates,
            ownKeyMatch,
            args.calendarDates,
          ),
        );
        continue;
      }
      freshFiles++;
      if (mapped.rows.length === 0) tally.filesZeroRows++;
      dayRows.push(...mapped.rows);
    }

    // Only a date with NOTHING but stale copies needs the bhavcopy probe; a
    // fresh file makes it a session whatever else happened that day.
    let bhavcopy: boolean | null = null;
    let absentKeys: string[] = [];
    if (freshFiles === 0 && foreignFiles === 0 && staleFiles > 0) {
      const probes = await Promise.all(
        [...staleExchanges].map((x) => args.bhavcopyPresent(x, date)),
      );
      bhavcopy = combineBhavcopyProbes(probes.map((p) => p.present));
      absentKeys = probes.flatMap((p) => p.absentKeys);
    }
    const dateVerdict: ReadDateVerdict | null = classifyReadDate({
      freshFiles,
      foreignFiles,
      staleFiles,
      bhavcopyPresent: bhavcopy,
    });
    if (dateVerdict !== null) tally.datesRead.add(date);
    if (dateVerdict === "holiday") {
      tally.holidays.add(date);
      // The holiday is PROVEN by these keys being absent, so they are part of
      // what this month was judged on — MONEY-1612.
      for (const key of absentKeys) {
        contributing.push({ date, key, generation: "absent" });
      }
    }
    if (dateVerdict === "stale-gap") {
      tally.gaps.set(
        date,
        foreignFiles > 0
          ? `file holds ${foreignNotes.join("; ")}`
          : bhavcopy === true
            ? "stale copy, but a bhavcopy IS archived — still expected"
            : "stale copy, no bhavcopy family to probe — still expected",
      );
    }

    if (dayRows.length === 0) continue;

    const deduped = dedupeIndiaRows(dayRows, INDIA_DEDUPE_KEYS[table]);
    const sifted = siftRows(deduped, classifierFor(table, partitionKey));
    for (const [reason, n] of Object.entries(sifted.counts)) {
      tally.quarantined[reason] = (tally.quarantined[reason] ?? 0) + n;
    }
    tally.samples.push(...sifted.quarantined.slice(0, 2));
    if (sifted.rows.length === 0) continue;

    tally.rows += sifted.rows.length;
    for (const r of sifted.rows) tally.sessions.add(r.session_date);

    if (apply) {
      await uploadFile({
        file: Buffer.from(encodeNdjson(sifted.rows), "utf8"),
        fileName: stageKey({
          table,
          partitionKey,
          runId: runIdent,
          part: date,
        }),
        contentType: "application/x-ndjson",
        isPublic: false,
        bucketName: bucket,
        ...STAGE_UPLOAD_POLICY,
      });
    }
  }

  const verdict = decideMonth({
    datesRead: tally.datesRead,
    holidays: tally.holidays,
    sessionDates: tally.sessions,
    rowCount: tally.rows,
  });

  // Per-date notes, printed on their own lines AFTER each verdict line.
  const detail =
    (tally.holidays.size
      ? `\n         holiday ${[...tally.holidays].sort().join(", ")} (stale copy, no bhavcopy)`
      : "") +
    [...tally.gaps]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([d, why]) => `\n         GAP ${d} (${why})`)
      .join("");
  const head =
    `${table} ${month}  read=${tally.filesRead}/${tally.datesRead.size}d ` +
    `missing=${tally.filesMissing} unreadable=${tally.filesUnreadable} ` +
    `zeroRows=${tally.filesZeroRows} stale=${tally.filesStale} ` +
    `foreign=${tally.filesForeign} ` +
    `rows=${tally.rows} sessions=${tally.sessions.size}` +
    (verdict.action === "load" ? ` expected=${verdict.expectedSessions}` : "") +
    (Object.keys(tally.quarantined).length
      ? ` quarantined=${JSON.stringify(tally.quarantined)}`
      : "");

  if (verdict.action === "skip") {
    log.info(`  SKIP   ${head} — ${verdict.reason}${detail}`);
    return null;
  }
  // Read, never a SESSION: a date whose file parsed yet put no row in this
  // month. These are what a coverage refusal is about — MONEY-1612.
  const missing = missingSessions(
    [...tally.datesRead].filter((d) => !tally.holidays.has(d)),
    tally.sessions,
  );
  if (!apply) {
    // The same gate `acceptPartition` will run, so a dry run shows which months
    // an --apply would refuse and why, before anything is written.
    const would = decideCoverage({
      rowCount: tally.rows,
      expectedSessions: verdict.expectedSessions,
      actualSessions: verdict.actualSessions,
    });
    log.info(
      `  DRY    ${head}` +
        (would.accept
          ? ""
          : ` — would REFUSE: ${would.reason} — missing: ${missing.join(", ") || "(not computable)"}`) +
        detail,
    );
    return null;
  }

  const key = {
    dataset: `lake_silver_${env}`,
    table,
    partitionKey,
    sourceHash: indiaSourceHash(contributing),
    parserVersion,
  };
  const claim = await claimPartition(key, { runId: runIdent });
  if (claim.action === "skip") {
    log.info(`  SKIP   ${head} — ledger: ${claim.reason}`);
    return null;
  }

  const bounds = monthDeleteBounds(partitionKey);
  const { deleted, loaded } = await replaceMonth({
    table,
    market: bounds.market,
    fromInclusive: bounds.fromInclusive,
    toExclusive: bounds.toExclusive,
    source: sourceFor(table),
    sourceUris: [
      `gs://${bucket}/${stageShardPrefix({ table, partitionKey, runId: runIdent })}*`,
    ],
  });

  if (Object.keys(tally.quarantined).length > 0) {
    await quarantine({
      dataset: key.dataset,
      table,
      partitionKey,
      runId: runIdent,
      reason: Object.entries(tally.quarantined)
        .map(([r, n]) => `${r}=${n}`)
        .join(","),
      sample: tally.samples.slice(0, 5),
    });
  }

  // ACCEPT LAST, and only with real counts. `acceptPartition` runs
  // `decideCoverage` inside itself and THROWS rather than returning a verdict a
  // caller could ignore — ACCEPTED is what makes every future run skip, so a
  // partial month accepted here is a gap frozen permanently.
  //
  // A REFUSAL IS THIS MONTH'S VERDICT, NOT THE RUN'S — MONEY-1612. It used to
  // escape and exit the container 1, so one partial month (prod 2026-09-23,
  // delivery_daily 2019-10, 19/23) left ~80 later months never attempted and
  // this one LOADING for the lease. `acceptOrRefuse` marks it REJECTED and
  // returns it; `main` carries on and fails the run at the end. Its loaded
  // rows stay in silver — see `acceptOrRefuse` for why. Any other error still
  // propagates and aborts.
  const refusal = await acceptOrRefuse(
    key,
    {
      runId: runIdent,
      rowCount: loaded,
      expectedSessions: verdict.expectedSessions,
      actualSessions: verdict.actualSessions,
      missingSessions: missing,
    },
    { accept: acceptPartition, reject: rejectPartition, quarantine },
  );
  if (refusal) {
    log.error(
      `${formatRefusal(refusal)}  (deleted=${deleted} loaded=${loaded})` +
        detail,
    );
    return refusal;
  }
  log.info(`  LOAD   ${head} deleted=${deleted} loaded=${loaded}${detail}`);
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  await initJobTelemetry();
  reportBuildProvenance(log, JOB);
  process.env.LAKE_ENV = args.env;
  // PINNED FROM `--env` — MONEY-1609. The archived bhavcopies are read through
  // `getFileMetadata` / `downloadFile`, which have no bucket override and read
  // `GCP_STORAGE_BUCKET`; `.env` is QA, so a `--env prod` run from a dev shell
  // read QA's `feeds/` while every log line said prod. `lake-replay-us` pins
  // its read bucket the same way.
  process.env.GCP_STORAGE_BUCKET = bucketForPrefix("feeds/", args.env);
  process.env.GCP_PROJECT_ID ??= "stock-book-483718";

  const startedAt = new Date();
  const runIdent = runId(JOB, startedAt.getTime());
  // MONEY-1613 — weekdays plus the special-session calendar's weekend dates.
  const calendarDates = specialSessionCandidateDates();
  const dates = enumerateSessionCandidates(args.from, args.to, calendarDates);
  const months = groupDatesByMonth(dates);

  log.info(
    `\n${JOB} — ${args.env}  ${args.from}..${args.to}  ` +
      `${dates.length} candidate sessions across ${months.size} months` +
      `  tables=${args.tables.join(",")}  ${args.apply ? "APPLY" : "DRY RUN"}\n`,
  );

  if (args.apply) {
    await beginRun({ runId: runIdent, job: JOB, startedAt });
  }

  let failed = false;
  const refused: PartitionRefusal[] = [];
  const bhavcopyPresent = makeBhavcopyProbe(args.from, args.to);
  const head = makeHead();
  try {
    for (const table of args.tables) {
      // The registry clamps each family to its own era, so a 1994 date is never
      // asked of a 2024 UDiFF family and a 2026 date is never asked of a legacy
      // one whose format was retired. That is a REFUSAL to manufacture 404s,
      // not an optimisation: a walk that 404s uniformly cannot be told from an
      // archive that is empty.
      const windows = new Map<string, { from: string; to: string }>();
      for (const w of familiesForBackfill(args.from, args.to, [
        ...INDIA_FAMILIES[table],
      ])) {
        windows.set(w.family.id, { from: w.from, to: w.to });
      }
      const unreachable = INDIA_FAMILIES[table].filter((f) => !windows.has(f));
      if (unreachable.length > 0) {
        // NAMED, never silent. A family the registry declines to walk in this
        // window is a real fact about the request (before its floor, after its
        // era, or not backfillable) — and a silent omission is how a replay
        // reports a clean run over a table it never filled.
        log.info(
          `${table}: not walked in this window — ${unreachable.join(", ")}`,
        );
      }
      if (windows.size === 0) continue;

      log.info(`\n${table} — ${[...windows.keys()].join(", ")}`);
      for (const [month, monthDates] of months) {
        const refusal = await replayMonth({
          table,
          month,
          dates: monthDates,
          windows,
          env: args.env,
          apply: args.apply,
          runIdent,
          bhavcopyPresent,
          head,
          calendarDates,
        });
        if (refusal) refused.push(refusal);
      }
    }
    // After EVERY month has had its turn: a run that refused any is FAILED and
    // exits non-zero, with each refusal listed, never a clean success.
    throwIfRefused(refused);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (args.apply) {
      await endRun({
        runId: runIdent,
        status: failed ? "FAILED" : "SUCCESS",
        finishedAt: new Date(),
        // The refused months on the run row too, so the ledger alone answers
        // "what did this run refuse" without its logs.
        notes: refused.length ? refused.map(formatRefusal).join("\n") : null,
      }).catch((e) => log.err(`endRun failed: ${String(e)}`));
    }
  }
}

guardCompletion(JOB, main()).catch((err) => {
  log.err(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
