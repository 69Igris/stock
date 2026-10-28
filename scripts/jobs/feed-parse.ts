/**
 * Archive → DB parse pass — MONEY-941 (Data Engine P3 step 4).
 *
 * Reads the bytes `feed-backfill.ts` archived to GCS and writes them into
 * `DailyPrice` (cash, source `BHAVCOPY_HIST`) and `DerivativeEOD` (F&O). It
 * NEVER touches an exchange: the archive is the input, which is the whole point
 * of archive-first — parsing can be re-run, fixed and re-run again without
 * asking NSE for anything.
 *
 * A separate entry point from `feed-backfill.ts` rather than a `--parse` flag
 * on it, because the two have opposite operational shapes: the walk is
 * network-bound, rate-limited and polite; the parse is CPU/DB-bound and wants
 * to go as fast as Mongo allows. Sharing one process would mean one set of
 * concurrency knobs serving two jobs badly.
 *
 * ## Instrument resolution, and what happens when it fails
 *
 * Rows resolve by symbol@exchange, then ISIN@exchange (`resolveInstrumentId`,
 * reused from the nightly bhavcopy path so historical rows land under exactly
 * the same rules). Anything unresolved is **DROPPED and counted** — never used
 * to mint an `InstrumentMapping`. That is MONEY-1085's rule and it matters most
 * here: pre-1998 files have no ISIN column at all, so minting from them would
 * create instruments with no identity beyond a symbol string that may since
 * have been reassigned to a different company.
 *
 * ## Usage
 *
 *   node --import tsx scripts/jobs/feed-parse.ts --dry-run
 *   node --import tsx scripts/jobs/feed-parse.ts --families=nse-cm-legacy --limit=50
 *   node --import tsx scripts/jobs/feed-parse.ts --families=x --retry-unreadable
 */

import { createHash } from "node:crypto";

import { prisma } from "@usemoney/database";
import { listFiles, downloadFile } from "@usemoney/storage";
// MONEY-1206 (D2): the archive decoder and its refusal class live in
// packages/core so this job and `scripts/data/backfill-symbol-aliases.ts` cannot
// drift apart — they used to carry a `toCsv` each and only this one knew about
// gzip. `UnreadableFeedFile` must come from the SAME module instance as the
// throw site or `err instanceof UnreadableFeedFile` is false and the refusal
// silently degrades to an unclassified failure.
import { decodeFeedText, UnreadableFeedFile } from "@usemoney/core/market-data";
import {
  parseUdiffBhavcopy,
  parseOldNseCmBhavcopy,
  parseOldBseCmBhavcopy,
  parseOldNseFoBhavcopy,
  parseUdiffFoBhavcopy,
  parseSecBhavdataFull,
  parseScbseallGrossDelivery,
  collapseBySeriesPreference,
  parseBseMasterJson,
  parseNseIndicesCsv,
  utcMidnightOf,
  parseCm52WeekHighLow,
  parseEqBandChanges,
  parseSecList,
  parseSurveillanceIndicator,
  parseFoSecBan,
  parseSeriesChange,
  parseShortSelling,
  STOCK_FLAG_SOURCES,
  parseBulkBlockDeals,
  parseSlbOpenPositions,
  exactDealKey,
  partitionPriceWrites,
  repairCandle,
  judgeRunCompletion,
  withHardTimeout,
  type StockFlagRow,
  type InstitutionalDealType,
  familyById,
  isoDay,
  dateFromArchiveKey,
  type BhavcopyRow,
  type LegacyDerivativeRow,
  // MONEY-1187 P11 — participant-wise F&O positioning.
  parseParticipantPositioning,
  netContracts,
  // MONEY-1204 P0.1 — FII derivatives statistics (xls, per-underlying + rupees).
  parseFiiStatsXls,
  FII_STATS_METRIC,
  FII_STATS_PARTICIPANT,
  // MONEY-1204 P14 / 14b.1 — debt security master (two files, one table) and
  // the debt-segment price series that finally gives the ~12k DEBT rows in
  // `InstrumentMapping` something to show.
  parseWdmList,
  parseCorporateBondReport,
  parseCbmTrades,
  // MONEY-1210 — the WDM half of the same table. `parseWdmTrades` yields rows
  // with no ISIN; `resolveWdmTrades` joins them to one against `BondMaster`.
  parseWdmTrades,
  resolveWdmTrades,
  type BondEodFile,
  type BondEodRow,
  type WdmTradesFile,
  type WdmMasterKey,
  type BondMasterFile,
  // MONEY-1204 P14 / 14b.2 — market-wide F&O open interest per underlying.
  parseCombinedOiDeleq,
  toMwplDailyWrite,
  MWPL_SOURCE,
} from "@usemoney/core/market-data";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time, so this
// process can be running code weeks older than the deployed service with no
// outward sign. THIS is the entry point that happened on: `feed-parse-prod` was
// pinned to `stockbook-workers:prod-fbdc29e2` (14-Aug) while the service ran
// `prod-d7eefba7` (18-Aug), so it exited 0 nightly on code that had never heard
// of the bond families and left `bond_master`/`bond_eod` at 0 rows. This prints
// the commit it is actually running.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
// MONEY-1238. `feed-parse` has been in the zero-write monitor's job list since
// MONEY-1220 (scripts/ops/datadog/apply-monitors.sh) and has never given it a
// datapoint to look at, because this job never called the reporter — so the
// monitor sat permanently in NO DATA. It is, pointedly, the FIRST incident
// named in that monitor's own comment ("feed-parse (stale pinned image)").
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import {
  buildInstrumentIndex,
  resolveInstrumentId,
  isinExchangeKey,
  toIndexSlug,
  type InstrumentIndex,
} from "../../workers/src/processors/bhavcopy-sync-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

// ─── Args ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const DRY_RUN = argv.includes("--dry-run");
const FAMILIES = (arg("families") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT = Number(arg("limit") ?? 0) || 0;
const BATCH = Number(arg("batch") ?? 2000) || 2000;

/**
 * Re-attempt files already checkpointed `UNREADABLE` (MONEY-1205).
 *
 * An `UNREADABLE` checkpoint is a recorded verdict about BYTES, and bytes do not
 * change — so the nightly skips those files, exactly as it skips `DONE`. What
 * DOES change is our parser, and without this flag the only way to re-test a
 * newly-taught layout would be `scripts/migrations/purge-parse-checkpoints.ts`,
 * which deletes by (family, date window) and would take every real `DONE` in
 * the window with it.
 *
 * So: teach the parser, then run once with `--retry-unreadable`. A file that now
 * parses is overwritten `DONE`/`ZERO` and rejoins the normal path; one that
 * still cannot be read is re-stamped `UNREADABLE` and — because it was already
 * known-bad at the START of the run — does NOT turn the run red. That is the
 * whole point of keeping the verdict queryable rather than deleting it.
 */
const RETRY_UNREADABLE = argv.includes("--retry-unreadable");

/**
 * Live progress, read by the beforeExit sentinel (MONEY-1189).
 *
 * Module-level rather than threaded through, because the sentinel fires from a
 * process hook that has no access to main()'s locals — and the whole failure
 * mode being defended against is main() never returning to hand anything over.
 */
const progress = {
  reachedEnd: false,
  planned: 0,
  finished: 0,
  outstanding: new Set<string>(),
};

/**
 * A hung GCS download must not stall the run forever.
 *
 * Generous, because a cold 40MB zip is legitimately slow and killing a healthy
 * download would trade a rare hang for a common failure. It only has to be
 * shorter than "forever".
 */
const DOWNLOAD_TIMEOUT_MS =
  Number(process.env.FEED_PARSE_DOWNLOAD_TIMEOUT_MS) || 120_000;

const log = {
  info: (...a: unknown[]) => console.log("[feed-parse]", ...a),
  warn: (...a: unknown[]) => console.warn("[feed-parse]", ...a),
};

/**
 * Which archived families this pass knows how to parse, and how.
 *
 * `cm-legacy` and `bhavcopy` (UDiFF CM) both produce `BhavcopyRow`; the two FO
 * families both produce `LegacyDerivativeRow`. Everything else in the registry
 * is archived but not yet parsed — that is deliberate (P4 lifts the analytics
 * families), and a family missing from this table is skipped loudly rather than
 * silently.
 */
const PARSERS = {
  "nse-cm-legacy": { kind: "cash", era: "legacy" },
  "nse-cm-udiff-bhavcopy": { kind: "cash", era: "udiff" },
  "bse-cm-udiff-bhavcopy": { kind: "cash", era: "udiff" },
  // MONEY-1101 P7 — BSE's pre-UDiFF cash era, the two overlapping zip families.
  // Both produce `BhavcopyRow`s and go through the SAME `writeCash`, so history
  // lands under identical source-precedence and candle-repair rules as the
  // nightly leg. They also unblock P4.1's stranded half: `bse-gross-delivery`
  // is UPDATE-ONLY, so every pre-2024 BSE delivery row was counted
  // `no-price-row` for want of exactly these price rows.
  "bse-cm-legacy": { kind: "cash", era: "bse-legacy" },
  "bse-cm-isin-legacy": { kind: "cash", era: "bse-legacy" },
  "nse-fo-legacy": { kind: "fo", era: "legacy" },
  "nse-fo-udiff-bhavcopy": { kind: "fo", era: "udiff" },
  "bse-fo-udiff-bhavcopy": { kind: "fo", era: "udiff" },
  // MONEY-1100 P4.1 — delivery. NSE upserts FULL rows (the file carries OHLC);
  // BSE is UPDATE-ONLY (SCBSEALL has no prices — pre-2024 BSE days have no
  // price row to attach to until P7, and a DailyPrice without a close would be
  // a lie).
  "nse-sec-bhavdata-full": { kind: "nse-delivery", era: "n/a" },
  "bse-gross-delivery": { kind: "bse-delivery", era: "n/a" },
  // MONEY-1100 P4.2 — the SAME ind_close_all layout arrives under TWO prefixes:
  // nse-indices-close is the nsearchives copy (walked to 2012), index-snapshot
  // is niftyindices' Daily_Snapshot (2013→). Both feed IndexClose through one
  // writer; the upsert key makes double-coverage harmless.
  "nse-indices-close": { kind: "index-close", era: "n/a" },
  "nse-index-snapshot": { kind: "index-close", era: "n/a" },
  // MONEY-1100 P4.5 — per-stock flags, append-only. One kind, per-family
  // dispatch via FLAG_PARSERS (the functions differ per file shape).
  "nse-52wk-high-low": { kind: "stock-flags", era: "n/a" },
  "nse-eq-band-changes": { kind: "stock-flags", era: "n/a" },
  "nse-sec-list": { kind: "stock-flags", era: "n/a" },
  "nse-surveillance-reg": { kind: "stock-flags", era: "n/a" },
  "nse-surveillance-reg1": { kind: "stock-flags", era: "n/a" },
  "nse-fo-secban": { kind: "stock-flags", era: "n/a" },
  "nse-series-change": { kind: "stock-flags", era: "n/a" },
  "nse-shortselling": { kind: "stock-flags", era: "n/a" },
  // MONEY-1100 P4.6 — deals. dealType CANNOT be sniffed: bulk.csv and
  // block.csv are shape-identical, so it rides the family id.
  "nse-bulk-deals": { kind: "deals", era: "n/a" },
  "nse-block-deals": { kind: "deals", era: "n/a" },
  // SLB — the real URL was found in MONEY-1201 and this family now archives.
  // The registry paths had been wrong by a separator (`open_pos` not `openpos`),
  // which 404s identically to "not published", so five further guesses also
  // failed. NSE's own `/api/daily-reports?key=SLBS` index had the answer, and
  // this repo has polled that endpoint weekly since MONEY-1097 — when a family
  // 404s, read the index BEFORE guessing the next path.
  "nse-slb-openpos": { kind: "slb", era: "n/a" },
  // MONEY-1187 P11 — participant-wise F&O positioning. Both families are
  // column-identical; the OI-vs-VOLUME discriminator is read from the file's
  // TITLE ROW, not from the family id, because the title is the only place
  // either the measure OR the trading date appears. (Contrast the deals
  // families two entries up, where the type genuinely CANNOT be sniffed and so
  // must ride the id — the opposite call, made for the opposite reason.)
  "nse-fao-participant-oi": { kind: "positioning", era: "n/a" },
  "nse-fao-participant-vol": { kind: "positioning", era: "n/a" },
  // MONEY-1204 P0.1 — the ONLY family here whose payload is a binary workbook.
  // Everything above is CSV (or a zip of one) and reaches its writer through
  // `decodeFeedText`, which calls `buf.toString("utf8")`. Doing that to a BIFF8
  // .xls yields mojibake, so this kind is dispatched from the raw Buffer instead
  // — see the guarded `decodeFeedText` call in the parse loop.
  "nse-fii-stats": { kind: "fii-stats", era: "n/a" },
  // MONEY-1204 P14 / 14b.1 — debt. TWO families feed ONE table (`BondMaster`),
  // joined on ISIN, because neither file alone is the master: `wdmlist` is the
  // wholesale-debt universe and `Corporate_bond_report` is the CBM master and
  // the only one of the two carrying issuer / face value / credit rating. The
  // per-family parser rides `BOND_MASTER_PARSERS`, not the kind, for the same
  // reason `FLAG_PARSERS` exists — the two file shapes share nothing but a
  // destination.
  //
  // Listed BEFORE `nse-cbm-trades` on purpose: a full run walks `PARSERS` in
  // insertion order, so the masters exist by the time the EOD writer measures
  // how many of its ISINs join to one. That is an ordering NICETY and never a
  // dependency — `writeBondEod` counts the misses and writes every row anyway,
  // because a price with no master row is still a price.
  "nse-wdm-list": { kind: "bond-master", era: "n/a" },
  "nse-corporate-bond-report": { kind: "bond-master", era: "n/a" },
  "nse-cbm-trades": { kind: "bond-eod", era: "n/a" },
  // MONEY-1210 — the WDM half of `BondEOD.segment`, which has always been
  // `"CBM" | "WDM"` while only CBM had a parser. Rides `BOND_EOD_PARSERS` for
  // the same reason the masters ride their own table: the two files share a
  // destination and nothing else. This one is a MULTI-MEMBER zip whose first
  // entry is the trades CSV, carries NO ISIN (it is resolved against
  // `BondMaster` on `(symbol, issueName)`), and prints its money column in
  // CRORES. See `parseWdmTrades`.
  "nse-wdm-daily": { kind: "bond-eod", era: "n/a" },
  // MONEY-1204 P14 / 14b.2 — market-wide F&O open interest. Named `mwpl` after
  // the table, NOT after what it contains: only the NUMERATOR of MWPL
  // utilisation is obtainable today (the denominator's own family 404s with
  // zero archived objects), so `MwplDaily.mwpl` / `.utilisationPct` are written
  // as the literal null. See the model's doc comment and `mwpl-logic.ts`.
  "nse-combine-oi-deleq": { kind: "mwpl", era: "n/a" },
} as const;

/** Which deal family carries which type — the bytes cannot say. */
const DEAL_TYPES: Readonly<Record<string, InstitutionalDealType>> = {
  "nse-bulk-deals": "BULK",
  "nse-block-deals": "BLOCK",
};

/**
 * Per-family flag dispatch (MONEY-1100 P4.5). Note surveillance-reg1 MUST pass
 * the source override or its rows are stamped as the REG_IND family.
 */
const FLAG_PARSERS: Readonly<
  Record<
    string,
    (csv: string, day: Date) => { rows: StockFlagRow[]; skipped: number }
  >
> = {
  "nse-52wk-high-low": parseCm52WeekHighLow,
  "nse-eq-band-changes": parseEqBandChanges,
  "nse-sec-list": parseSecList,
  "nse-surveillance-reg": (c, d) => parseSurveillanceIndicator(c, d),
  "nse-surveillance-reg1": (c, d) =>
    parseSurveillanceIndicator(c, d, STOCK_FLAG_SOURCES.surveillanceNew),
  "nse-fo-secban": parseFoSecBan,
  "nse-series-change": parseSeriesChange,
  "nse-shortselling": parseShortSelling,
};

/**
 * Per-family debt-master dispatch (MONEY-1204 / 14b.1), the same shape as
 * `FLAG_PARSERS` above and for the same reason: the two files share a
 * destination table and nothing else. `wdmlist` is a plain 13-column table;
 * `Corporate_bond_report` is 25 columns behind two banner rows and a blank, so
 * a single parser would be a header sniffer with two disjoint branches inside
 * it. Riding the family id keeps each shape's rules in its own tested function.
 */
const BOND_MASTER_PARSERS: Readonly<
  Record<string, (csv: string) => BondMasterFile | null>
> = {
  "nse-wdm-list": parseWdmList,
  "nse-corporate-bond-report": parseCorporateBondReport,
};

/**
 * Which EOD family parses which way (MONEY-1210).
 *
 * `nse-cbm-trades` yields `BondEodRow`s directly — its file carries the ISIN.
 * `nse-wdm-daily` cannot: it identifies an instrument by `Security` +
 * `Issue Name`, so its rows arrive UNRESOLVED and must be joined against
 * `BondMaster` before they have a key to be written under. That join needs the
 * database, so it lives in the writer; this table only says which shape a
 * family produces.
 */
type BondEodShape =
  | { via: "isin"; parse: (csv: string) => BondEodFile | null }
  | { via: "symbol-issue"; parse: (csv: string) => WdmTradesFile | null };

const BOND_EOD_PARSERS: Readonly<Record<string, BondEodShape>> = {
  "nse-cbm-trades": { via: "isin", parse: parseCbmTrades },
  "nse-wdm-daily": { via: "symbol-issue", parse: parseWdmTrades },
};

type ParserKey = keyof typeof PARSERS;

/** Marker family used for parse checkpoints, so a re-run resumes. */
const parseCheckpointFamily = (id: string): string => `parse:${id}`;

/**
 * The parse pass's own checkpoint vocabulary (MONEY-1205).
 *
 * `FeedBackfillProgress.status` is a plain `String`, and these rows live under
 * their own `parse:<family>` namespace, so this vocabulary cannot collide with
 * the WALK's DONE/MISSING/ERROR under the bare family id.
 *
 *   DONE        rows were written. Skipped on resume.
 *   ZERO        the file parsed and produced no rows. NON-terminal on purpose —
 *               retried, because 8,621 of these were once DONE-at-zero lies
 *               (MONEY-1169).
 *   UNREADABLE  we opened it, we could NOT read it, and the reason is a property
 *               of the bytes rather than of the moment (MONEY-1205). Skipped on
 *               resume like DONE — but it is the OPPOSITE of DONE, and that is
 *               the entire point. The bug this ticket closes was failure wearing
 *               the DONE label: 414 mwpl files claimed success having written
 *               nothing, and nothing could tell them from a holiday. A row that
 *               SAYS "unreadable", carries the refusal text in `detail`, and is
 *               one indexed query away (`status: "UNREADABLE"`) is auditable
 *               data, not a silence.
 *   (no row)    everything else — download failure, DB error, an exception we
 *               did not classify. Never checkpointed, always retried, and always
 *               red. See `UnreadableFeedFile`.
 */
const PARSE_STATUS = {
  done: "DONE",
  zero: "ZERO",
  unreadable: "UNREADABLE",
} as const;

/**
 * A PREREQUISITE this parse needed was not there — MONEY-1238.
 *
 * The THIRD classification, and it exists because the other two are both wrong
 * for this case. `UnreadableFeedFile` is a verdict about the BYTES: it records
 * `UNREADABLE`, which resume SKIPS, and that is right precisely because
 * re-reading the same bytes cannot produce a different answer. A scrip-master
 * join table we could not list is the opposite — a fact about the MOMENT, which
 * the very next run may well not share — so the file must stay UN-checkpointed
 * and the run must go red.
 *
 * Falling through to the dispatcher's "unclassified" branch already does both
 * of those. What it also does is print `UNCLASSIFIED failure (Error) ... If
 * these bytes are genuinely unreadable, throw UnreadableFeedFile`, about a
 * condition we diagnosed exactly and that has nothing to do with the bytes.
 * A diagnosis that reads as a shrug is how MONEY-1234's INCOMPARABLE verdict
 * hid two broken pipes for a release.
 *
 * Declared HERE and not in packages/core on purpose: every throw site and the
 * `instanceof` that classifies them are in this module, so there is exactly one
 * class object. A duplicated class across a package seam makes `instanceof`
 * silently false, which is the failure MONEY-1206 had to go and fix.
 */
class FeedPrerequisiteUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedPrerequisiteUnavailable";
  }
}

/*
 * parse-status:begin
 *
 * PURE and IMPORT-FREE, the same contract as `unreadable-verdict` further down
 * this file: `feed-parse-status.test.ts` extracts this region and EXECUTES it,
 * so the suite asserts against the real decision rather than against the source
 * text that describes it. `feed-parse.ts` is a script with a top-level `main()`
 * and a module-scope Prisma import, so it cannot be imported into `node:test`.
 */

/** The status a file we could READ is given. UNREADABLE is decided elsewhere. */
export type ParseFileStatus = "DONE" | "ZERO";

/** What ONE file did, reduced to the two numbers the status decision needs. */
export interface FileOutcome {
  /** Rows the parser produced from this file's bytes. */
  rowsParsed: number;
  /**
   * How many of those rows NEVER REACHED THE DATABASE — dropped for want of
   * something OUTSIDE the file (a join table, an instrument, a target row to
   * update), or because the row itself was unusable.
   *
   * NOT the same as "rows we decided not to write", and the distinction is the
   * whole design. A row compared against the stored one and deliberately left
   * alone (`writeCash`'s source-precedence `skipped`, `writeBondMaster`'s
   * `olderThanStored`), a row dropped by POLICY (`writeFo`'s pre-2018 stock
   * retention), a row collapsed into a duplicate we DID keep — all of those
   * reached a decision at the database and are ACCOUNTED. Counting them here
   * would stamp ZERO, which is NON-terminal, on files that are correctly
   * complete, and they would then be re-downloaded and re-parsed every night
   * forever.
   */
  rowsUnaccounted: number;
}

export interface ParseStatusVerdict {
  status: ParseFileStatus;
  /** `rowsParsed - rowsUnaccounted`, floored at 0. */
  rowsAccounted: number;
  /**
   * The file HAD rows and every single one of them was absorbed. Returned
   * rather than left to be inferred, so the caller can SAY it out loud: a
   * counter nothing reads is exactly how this ran unnoticed.
   */
  absorbedAll: boolean;
}

/**
 * DONE or ZERO, for a file we successfully read — MONEY-1238.
 *
 * ## The defect
 *
 * The status was `rowsParsed > 0 ? DONE : ZERO`, and `rowsParsed` was
 * incremented BEFORE the writer had established that it could write anything.
 * `writeBseDelivery` did exactly that: `tally.parsed += out.rows.length`, and
 * only then `const map = await loadScripToIsin(); if (!map) { ...; return; }`.
 * So on a run where the scrip master could not be listed — `listFiles` returns
 * `[]` for a GCS or auth blip exactly as it does for an empty prefix, and says
 * so in its own comment ("callers cannot distinguish [it] from an empty
 * prefix") — every BSE-delivery file in that run stamped **DONE having written
 * nothing**, and the resume path then skipped those days FOREVER. Recovery is a
 * hand-purge of checkpoint rows.
 *
 * That is MONEY-1169's defect (8,621 DONE-at-zero days) and MONEY-1204's (414
 * mwpl files) for the third time, so the rule is stated ONCE, here, instead of
 * being re-derived per writer:
 *
 *   **A file that put NOT ONE row in front of the database is never DONE.**
 *
 * ZERO is the honest answer for it, and ZERO is non-terminal by design — the
 * file is retried, and the retry succeeds the moment the missing prerequisite
 * lands. The cost is re-parsing a genuinely pathological file nightly. The
 * alternative cost is silent, permanent data loss, and this repo has paid that
 * one three times.
 *
 * ## Why the input is `unaccounted` and not `written`
 *
 * "Wrote zero rows" is a DIFFERENT question and gating on it would be a
 * regression: an idempotent re-parse of a day a higher-authority source already
 * owns writes zero rows and is completely correct. See `FileOutcome`.
 *
 * Non-finite input floors to 0, which lands on ZERO — a NaN can make a file be
 * retried, never permanently skipped.
 */
export function decideParseStatus(o: FileOutcome): ParseStatusVerdict {
  const count = (n: number): number =>
    Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  const parsed = count(o.rowsParsed);
  const unaccounted = Math.min(count(o.rowsUnaccounted), parsed);
  const rowsAccounted = parsed - unaccounted;
  return {
    status: rowsAccounted > 0 ? "DONE" : "ZERO",
    rowsAccounted,
    absorbedAll: parsed > 0 && rowsAccounted === 0,
  };
}

/* parse-status:end */

// ─── Bytes → rows ────────────────────────────────────────────────────
//
// `decodeFeedText` (zip / gzip / plain UTF-8) and `UnreadableFeedFile` are
// imported from `packages/core/src/market-data/bhavcopy.ts`. They used to be
// declared right here, and `scripts/data/backfill-symbol-aliases.ts` carried a
// second copy of the decoder that never learned the gzip branch — one archive
// with two readers that disagree about what its bytes say (MONEY-1206 / D2).
// The class moved with the function because a duplicated class makes
// `instanceof` false across the seam, which loses the classification silently.

// ─── Writers ─────────────────────────────────────────────────────────

interface CashTally {
  parsed: number;
  written: number;
  /**
   * MONEY-1175. Rows that already existed but were owned by a LOWER-authority
   * source (in practice YAHOO) and have been overwritten with the exchange's
   * own print. Distinct from `written` because these are repairs of previously
   * corrupted cells, not new coverage — and the two move for different reasons,
   * so collapsing them would hide whichever is broken.
   */
  upgraded: number;
  /**
   * Rows left alone because the incumbent ranks at or above BHAVCOPY_HIST —
   * i.e. a genuine re-run over already-correct data. On a second pass this
   * should approach the row count and `written`/`upgraded` should approach 0;
   * if it does not, precedence is not converging.
   */
  skipped: number;
  /** The same instrument twice in ONE file (multi-series). First wins. */
  dupInFile: number;
  /**
   * Rows dropped because high/low/close were themselves unusable, so there was
   * no trustworthy range to repair the candle from. Should be ~0; a non-zero
   * value means the exchange published something we do not understand.
   */
  droppedUndrawable: number;
  droppedUnresolved: number;
  withoutIsin: number;
  droppedBySeries: Record<string, number>;
  /**
   * MONEY-1101. BSE legacy rows that had no ISIN in the file and were given one
   * from the archived BSE scrip master. Counted separately from `withoutIsin`
   * because the two mean opposite things about data quality: `withoutIsin` is
   * how many rows the FILE could not identify, `isinFromScripMaster` is how
   * many of those we recovered. If the second stops tracking the first, the
   * scrip-master join has silently stopped working.
   */
  isinFromScripMaster: number;
  /**
   * BSE legacy rows whose scrip code is in NO archived scrip master, so they
   * carry no ISIN at all and can only resolve if symbol@BSE happens to hit.
   * Expected to be non-trivial for delisted scrips — the master lists ACTIVE
   * instruments, and an 18-year backfill necessarily touches companies that no
   * longer exist.
   */
  scripNotInMaster: number;
  /**
   * Files whose header matched NO known BSE legacy layout (MONEY-1101).
   *
   * These are RE-THROWN so the file stays un-checkpointed and is retried, and
   * counted here so a format change is a number on the summary line rather than
   * a silence. The distinction this defends is the MONEY-1189 one: a parser
   * that returned `[]` for an unknown shape would checkpoint `ZERO`, look like
   * an empty trading day, and be indistinguishable from real absence.
   */
  unrecognisedFormat: number;
}

async function writeCash(
  rows: BhavcopyRow[],
  index: InstrumentIndex,
  tally: CashTally,
): Promise<void> {
  const payload: Array<{
    instrumentId: string;
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    source: string;
  }> = [];

  for (const row of rows) {
    const instrumentId = resolveInstrumentId(row, index);
    if (!instrumentId) {
      // MONEY-1085: drop and COUNT. Never mint an instrument from a price file.
      tally.droppedUnresolved++;
      continue;
    }
    // MONEY-1175: make the candle drawable BEFORE it is stored. NSE's own
    // 1995-96 files put PREVCLOSE in the OPEN column (verified against the
    // archived bytes), which puts `open` outside [low, high] on gap days —
    // 6,253 rows. Repairing only in a migration would be undone by the next
    // re-parse, so the same `repairCandle` dispatch runs here and there.
    // The GCS archive remains the fidelity source of truth; this table is the
    // chart's source of truth, and an undrawable bar is never useful to it.
    const fixed = repairCandle(row);
    if (!fixed) {
      tally.droppedUndrawable++;
      continue;
    }
    payload.push({
      instrumentId,
      date: row.date,
      open: fixed.open,
      high: fixed.high,
      low: fixed.low,
      close: fixed.close,
      volume: row.volume,
      source: "BHAVCOPY_HIST",
    });
  }

  if (DRY_RUN || payload.length === 0) {
    tally.written += payload.length;
    return;
  }

  // ── Idempotency + source precedence on MongoDB ──────────────────────
  //
  // `createMany({ skipDuplicates: true })` is a SQL-only Prisma feature; the
  // Mongo connector types it as `never`. And a bare `createMany` is worse than
  // useless here: ONE duplicate key throws the WHOLE batch, which is exactly
  // the failure mode already documented in feed-archive.ts (bhavcopy-sync loses
  // a leg's entire day to a single collision).
  //
  // So collisions are resolved BEFORE the write. Every file is a single trading
  // day, which makes that one indexed query per file rather than one per row.
  //
  // MONEY-1175: that query now selects `source`, and the decision is delegated
  // to `partitionPriceWrites`. The previous version skipped EVERY existing row.
  // Its stated intent — "a day already ingested by the nightly job is live data,
  // and history must never clobber it" — is still honoured, because BHAVCOPY and
  // BHAVCOPY_HIST rank EQUAL and equality does not upgrade. What it got wrong was
  // treating a YAHOO row as untouchable. Yahoo is a third-party redistributor
  // returning SPLIT-ADJUSTED closes, so wherever it reached a date first the
  // authoritative exchange print was discarded for good: RELIANCE kept 297
  // exchange rows against 7,646 Yahoo, HDFCBANK 147 against 7,649, while
  // NIFTYBEES — which Yahoo never covered — came out complete back to 2002.
  const date = payload[0]!.date;
  const existingRows = await prisma.dailyPrice.findMany({
    where: { date, instrumentId: { in: payload.map((p) => p.instrumentId) } },
    select: { id: true, instrumentId: true, source: true },
  });
  const existing = new Map(
    existingRows.map((e) => [e.instrumentId, { id: e.id, source: e.source }]),
  );

  const { create, upgrade, preserved, dupInBatch } = partitionPriceWrites(
    payload,
    "BHAVCOPY_HIST",
    existing,
  );
  tally.skipped += preserved;
  tally.dupInFile += dupInBatch;

  for (let i = 0; i < create.length; i += BATCH) {
    const res = await prisma.dailyPrice.createMany({
      data: create.slice(i, i + BATCH),
    });
    tally.written += res.count;
  }

  // Upgrades go through one bulk `update` command per chunk rather than N
  // `prisma.update` round-trips — a single backfilled year is ~5,000 rows a day
  // across ~250 days, and the per-row shape (which the nightly worker still
  // uses) would turn that into over a million sequential calls.
  //
  // `$set` names only OHLCV + source ON PURPOSE. Delivery columns
  // (deliveryQty / deliveryPct / avgPrice / trades) are written by a DIFFERENT
  // family (sec-bhavdata-full) into these same rows, so replacing the whole
  // document here would silently erase them.
  for (let i = 0; i < upgrade.length; i += BATCH) {
    const chunk = upgrade.slice(i, i + BATCH);
    const res = (await prisma.$runCommandRaw({
      update: "daily_prices",
      updates: chunk.map(({ row, existingId }) => ({
        q: { _id: { $oid: existingId } },
        u: {
          $set: {
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            source: row.source,
          },
        },
        multi: false,
      })),
      ordered: false,
    })) as { nModified?: number };
    tally.upgraded += res.nModified ?? 0;
  }
}

interface FoTally {
  parsed: number;
  written: number;
  skipped: number;
  /** Dropped by the pre-2018 STOCK F&O retention rule — policy, not an error. */
  retentionSkipped: number;
  /**
   * The same contract identity appearing TWICE in one exchange file. Counted
   * rather than silently collapsed: a non-zero value means NSE published a
   * duplicate row, which is worth knowing even though we now survive it.
   */
  dupInFile: number;
}

/**
 * Retention cutoff for STOCK derivatives (founder decision 2026-08-11).
 *
 * Index F&O keeps its full history; stock F&O starts here. Pre-2018 stock
 * derivatives are not comparable to today's — options were AMERICAN-style
 * until Jan 2011, physical settlement phased in 2018-19, and lot sizes were
 * revised repeatedly so open interest in CONTRACTS does not compare.
 *
 * Enforced HERE, not only in the migration that removed the 69M existing
 * rows, because a policy that lives in a doc is one `--families=nse-fo-legacy`
 * re-parse away from being silently undone: the checkpoints would be gone or
 * purged, the walk would happily re-create every row, and nothing would fail.
 */
const STOCK_FO_CUTOFF = Date.UTC(2018, 0, 1);

/** Stock derivatives (index F&O is FUTIDX/OPTIDX and is NOT subject to it). */
const isStockDerivative = (instrument: string): boolean =>
  instrument.endsWith("STK");

async function writeFo(
  rows: LegacyDerivativeRow[],
  tally: FoTally,
): Promise<void> {
  if (DRY_RUN || rows.length === 0) {
    tally.written += rows.length;
    return;
  }

  const beforeCutoff = rows.length;
  rows = rows.filter(
    (r) =>
      !isStockDerivative(r.instrument) || r.date.getTime() >= STOCK_FO_CUTOFF,
  );
  const trimmed = beforeCutoff - rows.length;
  if (trimmed > 0) {
    tally.retentionSkipped += trimmed;
    if (rows.length === 0) return;
  }

  // Same pre-filter as the cash path, keyed on the 7-column compound unique.
  // One query per file (all rows share a trading date), then a client-side set.
  const date = rows[0]!.date;
  const key = (r: {
    symbol: string;
    exchange: string;
    instrument: string;
    expiry: Date;
    strike: number;
    optionType: string;
  }): string =>
    [
      r.symbol,
      r.exchange,
      r.instrument,
      r.expiry.toISOString(),
      r.strike,
      r.optionType,
    ].join("|");

  const existing = await prisma.derivativeEOD.findMany({
    where: { date },
    select: {
      symbol: true,
      exchange: true,
      instrument: true,
      expiry: true,
      strike: true,
      optionType: true,
    },
  });
  // Dedupe against the DB *and* WITHIN the file. `seen` is mutated as it
  // filters, so a repeated 7-tuple in one exchange file collapses instead of
  // reaching `createMany`.
  //
  // Without this, ONE duplicated contract row throws P2002 for the WHOLE
  // batch — every other contract in that chunk is lost, and because the throw
  // lands before the checkpoint the same file re-fails on every later run.
  // Observed live on 2026-08-11's nightly against nse-fo-legacy.
  const dbSeen = new Set(existing.map(key));
  const batchSeen = new Set<string>();
  let dupInFile = 0;
  const fresh = rows.filter((r) => {
    const k = key(r);
    if (dbSeen.has(k)) return false; // already stored by an earlier run
    if (batchSeen.has(k)) {
      dupInFile++; // the SAME 7-tuple twice in one exchange file
      return false;
    }
    batchSeen.add(k);
    return true;
  });
  tally.dupInFile += dupInFile;

  for (let i = 0; i < fresh.length; i += BATCH) {
    const chunk = fresh.slice(i, i + BATCH).map((r) => ({
      symbol: r.symbol,
      exchange: r.exchange,
      instrument: r.instrument,
      expiry: r.expiry,
      strike: r.strike,
      optionType: r.optionType,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      settle: r.settle,
      volume: r.volume,
      openInt: r.openInt,
      oiChange: r.oiChange,
      valueLakh: r.valueLakh,
      source: "BHAVCOPY_HIST",
    }));
    const res = await prisma.derivativeEOD.createMany({ data: chunk });
    tally.written += res.count;
  }
}

// ─── Delivery writers (MONEY-1100 P4.1) ──────────────────────────────

interface NseDeliveryTally {
  parsed: number;
  created: number;
  updated: number;
  droppedUnresolved: number;
  dateMismatch: number;
}

/**
 * NSE `sec_bhavdata_full` → DailyPrice, upsert semantics.
 *
 * The file carries full OHLC, so a day the price parse has not covered gets a
 * COMPLETE row (delivery included); a day that already has a row gets its
 * delivery/avgPrice/trades fields filled in place. Updates are per-row prisma
 * calls in bounded batches rather than $runCommandRaw bulk updates because
 * deliveryQty is BigInt — Prisma writes it as BSON Long, while a raw JSON
 * command would store a double and break every subsequent BigInt read.
 */
async function writeNseDelivery(
  csv: string,
  day: Date,
  index: InstrumentIndex,
  tally: NseDeliveryTally,
): Promise<void> {
  const out = parseSecBhavdataFull(csv, day);
  tally.parsed += out.rows.length;
  tally.dateMismatch += out.dateMismatch;

  const unresolved: Array<{
    instrumentId: string;
    row: (typeof out.rows)[number];
  }> = [];
  for (const row of out.rows) {
    const instrumentId = resolveInstrumentId(
      { symbol: row.symbol, exchange: "NSE", isin: null },
      index,
    );
    if (!instrumentId) {
      tally.droppedUnresolved++;
      continue;
    }
    unresolved.push({ instrumentId, row });
  }

  // The file prints one row PER SERIES; symbol resolution maps them all onto
  // one instrument, and two payload entries sharing (instrumentId, date) make
  // createMany throw on the compound unique — one such symbol cost the WHOLE
  // file, 1,643 times, on the first run. EQ wins deterministically.
  const { kept: resolved, collapsed } = collapseBySeriesPreference(unresolved);
  tally.droppedUnresolved += collapsed; // counted, like every other drop

  if (DRY_RUN || resolved.length === 0) return;

  const existing = await prisma.dailyPrice.findMany({
    where: {
      date: day,
      instrumentId: { in: resolved.map((r) => r.instrumentId) },
    },
    select: { instrumentId: true },
  });
  const seen = new Set(existing.map((e) => e.instrumentId));

  const toCreate = resolved.filter((r) => !seen.has(r.instrumentId));
  const toUpdate = resolved.filter((r) => seen.has(r.instrumentId));

  for (let i = 0; i < toCreate.length; i += BATCH) {
    const res = await prisma.dailyPrice.createMany({
      data: toCreate.slice(i, i + BATCH).map(({ instrumentId, row }) => ({
        instrumentId,
        date: day,
        open: row.open ?? row.close,
        high: row.high ?? row.close,
        low: row.low ?? row.close,
        close: row.close,
        volume: row.volume,
        source: "BHAVCOPY_HIST",
        deliveryQty: row.deliveryQty === null ? null : BigInt(row.deliveryQty),
        deliveryPct: row.deliveryPct,
        avgPrice: row.avgPrice,
        trades: row.trades,
      })),
    });
    tally.created += res.count;
  }

  // Bounded concurrency; each update touches one (instrumentId, date) row.
  const UPDATE_CONCURRENCY = 25;
  for (let i = 0; i < toUpdate.length; i += UPDATE_CONCURRENCY) {
    await Promise.all(
      toUpdate.slice(i, i + UPDATE_CONCURRENCY).map(({ instrumentId, row }) =>
        prisma.dailyPrice
          .update({
            where: { instrumentId_date: { instrumentId, date: day } },
            data: {
              deliveryQty:
                row.deliveryQty === null ? null : BigInt(row.deliveryQty),
              deliveryPct: row.deliveryPct,
              avgPrice: row.avgPrice,
              trades: row.trades,
            },
          })
          .then(() => {
            tally.updated++;
          }),
      ),
    );
  }
}

interface BseDeliveryTally {
  parsed: number;
  updated: number;
  noPriceRow: number;
  unresolvedScrip: number;
  dateMismatch: number;
}

/**
 * SCBSEALL scripCode → ISIN, built once per run from the LATEST archived BSE
 * scrip master.
 *
 * ## Why this returns a RESULT and not a nullable map (MONEY-1238)
 *
 * The previous shape memoised a bare `null` for "no master", and the comment
 * here claimed "the family then skips with a loud warning". Neither half was
 * true. There was no `log.warn` on either `return null` path, and the family
 * did not skip: `writeBseDelivery` counted every row `unresolvedScrip`,
 * returned normally, and let the dispatcher stamp the file DONE at zero writes
 * — permanently, because resume skips DONE. A cached fail-open default with a
 * doc comment describing a guard nobody had written.
 *
 * ## An EMPTY listing is a FAILURE here, not an empty prefix
 *
 * That is the guard. `listFiles` swallows GCS and auth errors and returns `[]`,
 * and its own comment says callers "cannot distinguish [it] from an empty
 * prefix". `feeds/BSE/scrip-master/` is never legitimately empty in a working
 * environment — prod archives that master nightly and QA replays the identical
 * object — so "nothing there at all" is the storage layer having a moment, and
 * the only safe reading of a moment is "ask again next run".
 *
 * The failure IS still memoised, because the point of memoising is that this
 * runs once per RUN rather than once per file. It is memoised as an explicit
 * `{ ok: false, reason }` so that nothing downstream can mistake it for a map
 * that happens to be empty — "could not determine" is its own value, never the
 * same value as "determined to be nothing". Both callers turn it into a throw.
 */
type ScripMasterLookup =
  | { ok: true; map: Map<string, string> }
  | { ok: false; reason: string };

let scripToIsin: ScripMasterLookup | undefined;
async function loadScripToIsin(): Promise<ScripMasterLookup> {
  if (scripToIsin !== undefined) return scripToIsin;
  const prefix = "feeds/BSE/scrip-master/";
  const keys = await listFiles(prefix);
  const latest = keys
    .filter((k) => !k.endsWith("/"))
    .sort()
    .pop();
  const unavailable = (reason: string): ScripMasterLookup => {
    log.warn(
      `BSE scrip-master UNAVAILABLE — ${reason} Every BSE family that needs ` +
        "the scripCode→ISIN join will REFUSE its files this run rather than " +
        "resolve nothing and be checkpointed complete (MONEY-1238).",
    );
    scripToIsin = { ok: false, reason };
    return scripToIsin;
  };
  if (!latest) {
    return unavailable(
      `${prefix} listed ${keys.length} object(s), none of them a file. ` +
        "That prefix is never legitimately empty, so this is a storage or " +
        "credentials failure that listFiles returned as [] — look for a " +
        "[storage] listFiles FAILED line above.",
    );
  }
  const buf = await downloadFile(latest);
  if (!buf) {
    return unavailable(`${latest} was listed but could not be downloaded.`);
  }
  const map = new Map<string, string>();
  for (const r of parseBseMasterJson(buf.toString("utf8"))) {
    if (r.scripCode && r.isin) map.set(r.scripCode.trim(), r.isin);
  }
  // A master that parsed to NOTHING is the same failure wearing a different
  // face: the object exists, so `!latest` never fires, and every row of every
  // BSE file then misses the join and is counted instead of written — which is
  // precisely the state that used to be recorded as DONE.
  if (map.size === 0) {
    return unavailable(`${latest} parsed to 0 scripCode→ISIN pairs.`);
  }
  log.info(`BSE scrip-master join map: ${map.size} scripCode→ISIN (${latest})`);
  scripToIsin = { ok: true, map };
  return scripToIsin;
}

/** BSE gross delivery → UPDATE existing DailyPrice rows only. */
async function writeBseDelivery(
  text: string,
  day: Date,
  index: InstrumentIndex,
  tally: BseDeliveryTally,
): Promise<void> {
  const out = parseScbseallGrossDelivery(text, day);
  tally.dateMismatch += out.dateMismatch;
  if (DRY_RUN || out.rows.length === 0) {
    // A dry run writes no checkpoint at all, so crediting file coverage here
    // cannot poison anything — and coverage is the one number a dry run is for.
    tally.parsed += out.rows.length;
    return;
  }

  // THROW, and only AFTER this does `parsed` move (MONEY-1238). The old order
  // credited the file with `out.rows.length` parsed rows and THEN bailed, so
  // `fileRows > 0` and the dispatcher stamped DONE on a file that had written
  // nothing — for good, because resume skips DONE. Nothing about this condition
  // is a property of the bytes, so it is deliberately NOT `UnreadableFeedFile`:
  // it has to leave the file un-checkpointed and make the run red.
  const master = await loadScripToIsin();
  if (!master.ok) {
    throw new FeedPrerequisiteUnavailable(
      "bse-delivery: the BSE scrip-master join table is unavailable, so not " +
        `one of this file's ${out.rows.length} rows can be resolved to an ` +
        `instrument — ${master.reason} NOT checkpointed; will be retried.`,
    );
  }
  const map = master.map;

  tally.parsed += out.rows.length;

  const resolved: Array<{
    instrumentId: string;
    row: (typeof out.rows)[number];
  }> = [];
  for (const row of out.rows) {
    const isin = map.get(row.scripCode);
    const instrumentId = isin
      ? index.byIsinExchange.get(isinExchangeKey(isin, "BSE"))
      : undefined;
    if (!instrumentId) {
      tally.unresolvedScrip++;
      continue;
    }
    resolved.push({ instrumentId, row });
  }
  if (resolved.length === 0) return;

  const existing = await prisma.dailyPrice.findMany({
    where: {
      date: day,
      instrumentId: { in: resolved.map((r) => r.instrumentId) },
    },
    select: { instrumentId: true },
  });
  const seen = new Set(existing.map((e) => e.instrumentId));

  const UPDATE_CONCURRENCY = 25;
  const updatable = resolved.filter((r) => seen.has(r.instrumentId));
  tally.noPriceRow += resolved.length - updatable.length;

  for (let i = 0; i < updatable.length; i += UPDATE_CONCURRENCY) {
    await Promise.all(
      updatable.slice(i, i + UPDATE_CONCURRENCY).map(({ instrumentId, row }) =>
        prisma.dailyPrice
          .update({
            where: { instrumentId_date: { instrumentId, date: day } },
            data: {
              deliveryQty: BigInt(row.deliveryQty),
              deliveryPct: row.deliveryPct,
            },
          })
          .then(() => {
            tally.updated++;
          }),
      ),
    );
  }
}

// ─── BSE legacy cash (MONEY-1101 P7) ─────────────────────────────────

/**
 * Parse one legacy BSE cash bhavcopy and write it through the SHARED cash path.
 *
 * Two things happen here that the generic cash branch cannot do:
 *
 * 1. **Unrecognised header ⇒ throw.** `parseOldBseCmBhavcopy` returns `null`
 *    (not `[]`) when the layout is unknown. Throwing routes it into the
 *    per-file catch, which counts it `unreadable` and — crucially — leaves the
 *    file UN-CHECKPOINTED, so the next run retries it. Returning zero rows
 *    instead would checkpoint `ZERO`, which reads exactly like a real empty
 *    trading day. That conflation is the MONEY-1189 defect, and BSE moving a
 *    column mid-2017 (FILLER1 → TRADING_DATE) is proof this format does drift.
 *
 * 2. **Scrip-code → ISIN backfill.** The pre-2017 file has NO ISIN column at
 *    all, and `InstrumentMapping`'s BSE rows are keyed by ISIN. The map is the
 *    very one `writeBseDelivery` already builds from the archived BSE scrip
 *    master, reused rather than duplicated — one join table for both BSE
 *    historical legs means they cannot drift apart, and a scrip code that
 *    resolves for delivery resolves identically for price.
 *
 * Everything after that is deliberately NOT special-cased: the rows go into the
 * same `writeCash` as every other era, so they inherit `repairCandle` and the
 * MONEY-1175 source-precedence partition instead of a second, subtly different
 * write path for history.
 */
async function writeBseLegacyCash(
  csv: string,
  day: Date,
  index: InstrumentIndex,
  tally: CashTally,
): Promise<number> {
  const out = parseOldBseCmBhavcopy(csv, day);
  if (!out) {
    tally.unrecognisedFormat++;
    throw new UnreadableFeedFile(
      "unrecognised BSE legacy bhavcopy header — no known variant matched. " +
        "The file is NOT checkpointed, so it will be retried; add the new " +
        "layout to detectBseLegacyVariant rather than letting it parse to zero rows.",
    );
  }

  // Only the no-ISIN rows need the map, so a fully-ISIN file (the 2017+ era)
  // never pays for loading it — and the load happens BEFORE any counter moves,
  // so a prerequisite failure leaves this file looking untouched rather than
  // half-counted in a summary the operator then has to unpick (MONEY-1238).
  const master = out.withoutIsin > 0 ? await loadScripToIsin() : null;
  if (master && !master.ok && !DRY_RUN) {
    // THROW rather than fall back (MONEY-1238), and BEFORE any counter moves.
    // The fallback resolves the scrip code as a SYMBOL, which lands "a
    // minority" of the pre-2017 era — and `writeCash` then WRITES that
    // minority, so `fileRows > 0` and the dispatcher stamps the file DONE with
    // the majority of its rows dropped unresolved for good. A half-resolved day
    // recorded as complete is worse than a retried one: the retry costs a
    // re-parse, the DONE costs the rows and cannot be undone without
    // hand-purging checkpoints.
    //
    // Restricted to real runs because a dry run writes no checkpoint, so it has
    // nothing to poison, and it is documented as runnable without credentials —
    // refusing there would be noise about a risk that is structurally absent.
    throw new FeedPrerequisiteUnavailable(
      `bse-legacy-cash: ${out.withoutIsin} of this file's ${out.rows.length} ` +
        "rows carry no ISIN column and the BSE scrip-master join table is " +
        `unavailable — ${master.reason} NOT checkpointed; will be retried.`,
    );
  }

  tally.parsed += out.rows.length;
  tally.withoutIsin += out.withoutIsin;
  for (const [k, v] of Object.entries(out.droppedByGroup)) {
    tally.droppedBySeries[k] = (tally.droppedBySeries[k] ?? 0) + v;
  }

  if (master?.ok) {
    for (const row of out.rows) {
      if (row.isin) continue;
      const isin = master.map.get(row.scripCode);
      if (isin) {
        row.isin = isin;
        tally.isinFromScripMaster++;
      } else {
        tally.scripNotInMaster++;
      }
    }
  } else if (master) {
    // Only reachable on a DRY RUN — the real-run branch threw above. Rows keep
    // isin:null and fall back to symbol@BSE, which resolves a minority.
    // Counted so the cause is visible rather than showing up only as
    // dropped-unresolved.
    tally.scripNotInMaster += out.withoutIsin;
  }

  await writeCash(out.rows, index, tally);
  return out.rows.length;
}

// ─── IndexClose writer (MONEY-1100 P4.2) ─────────────────────────────

interface IndexCloseTally {
  parsed: number;
  upserted: number;
  emptySlug: number;
}

/**
 * ind_close_all → IndexClose, upsert on (indexSlug, date) — the same identity
 * the nightly job uses, so backfill and daily writes can never fork. Upsert
 * rather than create-if-missing because the backfill carries the valuation
 * columns (pe/pb/divYield/volume/turnoverCr) that pre-P4.2 daily rows lack:
 * re-walking a year FILLS those in on rows that already exist.
 */
async function writeIndexClose(
  csv: string,
  day: Date,
  tally: IndexCloseTally,
): Promise<void> {
  const rows = parseNseIndicesCsv(csv, day);
  tally.parsed += rows.length;
  if (DRY_RUN) return;

  for (const row of rows) {
    const indexSlug = toIndexSlug(row.name);
    // Blank/garbage name → empty slug → unfindable row. Skip, count.
    if (!indexSlug) {
      tally.emptySlug++;
      continue;
    }
    await prisma.indexClose.upsert({
      where: { indexSlug_date: { indexSlug, date: row.date } },
      create: {
        indexSlug,
        name: row.name,
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        prevClose: row.prevClose,
        pe: row.pe,
        pb: row.pb,
        divYield: row.divYield,
        volume: row.volume,
        turnoverCr: row.turnoverCr,
        source: "NSE_INDICES",
      },
      update: {
        name: row.name,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        prevClose: row.prevClose,
        pe: row.pe,
        pb: row.pb,
        divYield: row.divYield,
        volume: row.volume,
        turnoverCr: row.turnoverCr,
      },
    });
    tally.upserted++;
  }
}

// ─── StockFlag writer (MONEY-1100 P4.5) ──────────────────────────────

interface FlagTally {
  parsed: number;
  written: number;
  skipped: number;
}

/**
 * Append-only: plain createMany, NO dedupe and NO unique to lean on — a stock
 * carrying the same code for 40 sessions is 40 rows, and the run length IS the
 * datum. Re-run safety comes from the family_date parse checkpoint alone.
 * instrumentId resolves best-effort by symbol@NSE and stays null when the join
 * misses: SME/`$`-suffixed names are exactly the ones that get surveilled, so
 * dropping unresolved rows would throw away the flags most worth having.
 */
async function writeStockFlags(
  familyId: string,
  csv: string,
  day: Date,
  index: InstrumentIndex,
  tally: FlagTally,
): Promise<void> {
  const parse = FLAG_PARSERS[familyId];
  if (!parse) return;
  const out = parse(csv, day);
  tally.parsed += out.rows.length;
  tally.skipped += out.skipped;
  if (DRY_RUN || out.rows.length === 0) return;

  const data = out.rows.map((r) => ({
    symbol: r.symbol,
    exchange: "NSE",
    series: r.series,
    instrumentId:
      resolveInstrumentId(
        { symbol: r.symbol, exchange: "NSE", isin: null },
        index,
      ) ?? null,
    date: r.date,
    kind: r.kind,
    value: r.value,
    source: r.source,
  }));
  for (let i = 0; i < data.length; i += BATCH) {
    const res = await prisma.stockFlag.createMany({
      data: data.slice(i, i + BATCH),
    });
    tally.written += res.count;
  }
}

// ─── Deals + SLB writers (MONEY-1100 P4.6) ───────────────────────────

interface DealsTally {
  parsed: number;
  written: number;
  duplicate: number;
  dateMismatch: number;
  /** Rows unrepresentable in the schema (non-integer qty) — dropped, counted. */
  dropped: number;
}

/**
 * Rolling snapshots re-serve earlier sessions' prints, so idempotency rides
 * the fixed-width dedupeKey (sha256 of the ALL-FIELDS identity) — pre-filter
 * per file, then createMany the fresh remainder. A same-client same-symbol
 * different-price print survives; only byte-identical repeats collapse.
 */
async function writeDeals(
  csv: string,
  dealType: InstitutionalDealType,
  day: Date,
  tally: DealsTally,
): Promise<void> {
  const out = parseBulkBlockDeals(csv, dealType, day);
  tally.parsed += out.rows.length;
  tally.dateMismatch += out.dateMismatch;
  if (DRY_RUN || out.rows.length === 0) return;

  // `qty` is BigInt in the schema, and BigInt() THROWS on a fractional number.
  // The parser guarantees finite-and-positive, not integral, so one shifted
  // column or scaled-unit era would throw here — before the checkpoint is
  // stamped, which makes the identical archived file re-throw on every
  // subsequent nightly run forever. Drop-and-count instead: a deal we cannot
  // represent is one row lost, not a permanently wedged family.
  const withKeys: Array<{ row: (typeof out.rows)[number]; dedupeKey: string }> =
    [];
  for (const row of out.rows) {
    if (!Number.isInteger(row.qty)) {
      tally.dropped++;
      log.warn(
        `deals: non-integer qty ${row.qty} for ${row.symbol} on ` +
          `${row.date.toISOString().slice(0, 10)} — row dropped`,
      );
      continue;
    }
    withKeys.push({
      row,
      dedupeKey: createHash("sha256").update(exactDealKey(row)).digest("hex"),
    });
  }
  if (withKeys.length === 0) return;

  const existing = await prisma.institutionalDeal.findMany({
    where: { dedupeKey: { in: withKeys.map((w) => w.dedupeKey) } },
    select: { dedupeKey: true },
  });
  const seen = new Set(existing.map((e) => e.dedupeKey));
  // Dedupe against the DB *and* within this batch. Two byte-identical rows in
  // one file share a dedupeKey, and `createMany` against the unique index
  // throws P2002 for the WHOLE batch — losing every other deal in it. Block
  // deals execute at one negotiated price, so identical repeats in a single
  // snapshot are plausible rather than theoretical.
  const fresh = withKeys.filter((w) => {
    if (seen.has(w.dedupeKey)) return false;
    seen.add(w.dedupeKey);
    return true;
  });
  tally.duplicate += withKeys.length - fresh.length;

  for (let i = 0; i < fresh.length; i += BATCH) {
    const res = await prisma.institutionalDeal.createMany({
      data: fresh.slice(i, i + BATCH).map(({ row, dedupeKey }) => ({
        date: row.date,
        symbol: row.symbol,
        exchange: row.exchange,
        securityName: row.securityName,
        clientName: row.clientName,
        buySell: row.buySell,
        qty: BigInt(row.qty),
        avgPrice: row.avgPrice,
        dealType: row.dealType,
        remarks: row.remarks,
        dedupeKey,
      })),
    });
    tally.written += res.count;
  }
}

interface SlbTally {
  parsed: number;
  upserted: number;
}

async function writeSlb(
  csv: string,
  day: Date,
  tally: SlbTally,
): Promise<void> {
  const out = parseSlbOpenPositions(csv, day);
  tally.parsed += out.rows.length;
  if (DRY_RUN) return;
  for (const row of out.rows) {
    // Keyed on (symbol, date, SERIES) — MONEY-1201.
    //
    // The file is one row per (security, series), so `symbol_date` made this a
    // LAST-WRITE-WINS overwrite: on 13-Aug-2026, 116 of 331 symbols repeat and
    // 84.2% of the day's open interest would have been discarded while the run
    // counted 331 successes. See the widened @@unique on SlbPosition.
    await prisma.slbPosition.upsert({
      where: {
        symbol_date_series: {
          symbol: row.symbol,
          date: row.date,
          series: row.series,
        },
      },
      create: {
        date: row.date,
        symbol: row.symbol,
        series: row.series,
        openQty: row.openQty,
        expiryDate: row.expiryDate ?? null,
        openValue: row.openValue ?? null,
      },
      update: {
        series: row.series,
        openQty: row.openQty,
        expiryDate: row.expiryDate ?? null,
        openValue: row.openValue ?? null,
      },
    });
    tally.upserted++;
  }
}

/**
 * Participant-wise F&O positioning — MONEY-1187 (P11).
 *
 * The archive already holds 1,636 days of each of these files; only the parse
 * was missing. So this writer is the whole of P11 item 1, and a full backfill is
 * `feed-parse --families=nse-fao-participant-oi,nse-fao-participant-vol` over
 * the existing bytes, with no new egress.
 */
interface PositioningTally {
  parsed: number;
  upserted: number;
  /**
   * Files whose TITLE ROW did not yield a trading date. Counted, never
   * defaulted: the date exists nowhere else in the file, so falling back to the
   * archive key's day would stamp the file with a date the exchange never
   * claimed — the exact wrong-granularity move that let the F&O summaries
   * report SUCCESS across a 456-day hole (MONEY-1189).
   */
  noDate: number;
  /**
   * Files whose title did not say OI vs VOLUME. Also never defaulted: the two
   * files are column-identical, so guessing wrong writes a day's TRADED VOLUME
   * into the OPEN INTEREST series, where it is indistinguishable from a real
   * reading three orders of magnitude out.
   */
  noMeasure: number;
  /**
   * Files the parser rejected outright (`null`) — an unrecognised shape. Kept
   * distinct from a file that parsed to zero rows, because those mean opposite
   * things and collapsing them is how "we cannot read this any more" becomes
   * indistinguishable from "the market was shut".
   */
  unrecognisedFormat: number;
  /**
   * NSE's own totals row disagreeing with the sum of its six legs. Expected to
   * be small and non-zero — the real 2026-08-13 OI file is off by ONE contract
   * in three places, while the volume file balances exactly. Surfaced as a
   * number rather than thrown, because dropping a good day over ±1 contract
   * would be a worse bug than the discrepancy.
   */
  discrepancies: number;
  /** Buckets dropped because a long/short cell was non-finite. */
  droppedLegs: number;
}

async function writePositioning(
  csv: string,
  family: string,
  tally: PositioningTally,
): Promise<number> {
  const out = parseParticipantPositioning(csv);
  if (out === null) {
    tally.unrecognisedFormat++;
    throw new UnreadableFeedFile(
      `${family}: unrecognised participant-positioning layout — the parser did ` +
        "not find its columns. NOT checkpointed; will be retried.",
    );
  }
  // ── All three of these THROW, and all three are about the FILE ───────────
  //
  // MONEY-1204. Each of these counters is per-FILE, not per-row: the tally docs
  // above say so ("Files whose TITLE ROW…"), and the title row is a property of
  // the file. There is no partial outcome behind any of them — a file with no
  // date cannot place a single row in time, and a file with no measure cannot
  // name the `metric` that is part of `MarketPositioning`'s upsert key. So each
  // one means EVERY row of a file that certainly had rows goes unwritten.
  //
  // Returning 0 made that indistinguishable from "parsed fine, the market was
  // shut", and the dispatcher then checkpointed the file DONE and never came
  // back. That is exactly how `nse-combine-oi-deleq` lost 414 files and two
  // years of history in silence. Throwing routes each into the per-file catch,
  // which counts it `unreadable` and leaves it UN-CHECKPOINTED for the next run
  // — the rule `writeBseLegacyCash` states and MONEY-1189 paid for: "we cannot
  // read this" must never wear the same face as "there was nothing to read".
  //
  // The row-level counters in this same tally (`discrepancies`, `droppedLegs`)
  // are deliberately NOT converted. Those mean "this ROW was unusable", and
  // failing a whole file over one bad leg would be a worse bug than the leg.
  if (out.tradingDate === null) {
    tally.noDate++;
    throw new UnreadableFeedFile(
      `${family}: the title row carried no trading date, and the date appears ` +
        "nowhere else in the file. Refusing to stamp it from the archive key " +
        "(MONEY-1189). NOT checkpointed; will be retried.",
    );
  }
  if (out.measure === null) {
    tally.noMeasure++;
    throw new UnreadableFeedFile(
      `${family}: the title row did not say OI vs VOLUME. The two files are ` +
        "column-identical, so guessing would write traded volume into the open- " +
        "interest series. NOT checkpointed; will be retried.",
    );
  }

  tally.parsed += out.rows.length;
  tally.discrepancies += out.discrepancies.length;
  tally.droppedLegs += out.reasons.nonFiniteLeg ?? 0;
  if (DRY_RUN) return out.rows.length;

  const date = out.tradingDate;
  const metric = out.measure;
  for (const row of out.rows) {
    const net = netContracts(row);
    await prisma.marketPositioning.upsert({
      where: {
        date_participant_bucket_metric: {
          date,
          participant: row.participant,
          bucket: row.bucket,
          metric,
        },
      },
      create: {
        date,
        participant: row.participant,
        bucket: row.bucket,
        metric,
        longQty: row.longQty,
        shortQty: row.shortQty,
        netQty: net,
        source: family,
      },
      // A re-walk overwrites. These files are static once published, so an
      // update is normally a no-op — but if NSE ever restates a day, the later
      // reading is the better one, and the alternative (skip-if-present) would
      // pin the restated day to whatever we happened to read first.
      update: {
        longQty: row.longQty,
        shortQty: row.shortQty,
        netQty: net,
        source: family,
      },
    });
    tally.upserted++;
  }
  return out.rows.length;
}

/**
 * FII derivatives statistics — MONEY-1204 / P0.1.
 *
 * Takes the raw Buffer, NOT a stringified payload: this is the only family in
 * `PARSERS` whose archived object is a binary workbook.
 */
interface FiiStatsTally {
  parsed: number;
  upserted: number;
  /** Title row carried no date. A refusal, never a default. */
  noDate: number;
  /** Bytes were not this report at all (parser returned null). */
  unrecognisedFormat: number;
  /** NSE's own segment totals disagreed with its own breakdown. */
  discrepancies: number;
  /** Rows dropped for an unreadable traded leg. */
  droppedRows: number;
  /**
   * Header columns whose label did not match — columns we NEVER READ.
   *
   * Counted per (file x column). Non-zero means every row of that file carries
   * a null for a column NSE almost certainly published, which is the state most
   * easily mistaken for "NSE stopped publishing it".
   */
  unresolvedColumns: number;
}

async function writeFiiStats(
  buf: Buffer,
  family: string,
  tally: FiiStatsTally,
): Promise<number> {
  const out = parseFiiStatsXls(buf);
  if (out === null) {
    tally.unrecognisedFormat++;
    // THROW, not `return 0` — MONEY-1204. See writePositioning for the full
    // reasoning; this is the same per-FILE signal. It matters more here than
    // anywhere else in this job, because the mojibake failure mode is one
    // `decodeFeedText` slip away: a stringified BIFF8 workbook makes this branch fire on
    // 100% of files, and returning 0 would have checkpointed the entire family
    // DONE at zero rows while reporting a clean run.
    throw new UnreadableFeedFile(
      `${family}: these bytes are not the FII derivatives-statistics workbook ` +
        "— the parser found no recognisable sheet. NOT checkpointed; will be " +
        "retried.",
    );
  }
  // A refusal, not a default. Stamping these rows with the archive key's day
  // would be right on an ordinary night and wrong on exactly the nights that
  // matter — a replay, a late publication, a re-walk (MONEY-1189).
  //
  // Per-FILE, so it throws for the same reason the branch above does. The
  // row-level counters here (`droppedRows`, `discrepancies`) and the per-column
  // `unresolvedColumns` are NOT converted: a file with an unread column still
  // has real rows to write, and the `readOrKeep` rule below already stops that
  // column from destroying anything.
  if (out.tradingDate === null) {
    tally.noDate++;
    throw new UnreadableFeedFile(
      `${family}: the title row carried no trading date, and it appears ` +
        "nowhere else in the workbook. NOT checkpointed; will be retried.",
    );
  }

  tally.parsed += out.rows.length;
  tally.discrepancies += out.discrepancies.length;
  tally.droppedRows += out.reasons.nonFiniteLeg ?? 0;
  tally.unresolvedColumns += out.unresolvedColumns.length;
  if (DRY_RUN) return out.rows.length;

  // ── An unread column may NOT clear a stored one ──────────────────────────
  //
  // `openInterestQty` is null for TWO different reasons and they must not be
  // written the same way. A resolved column that printed nothing is a READING,
  // and the update block below is right to persist it — that is the restatement
  // rule this writer already documents. A column whose HEADER did not match was
  // never read at all, and persisting its null DESTROYS whatever a previous,
  // correct parse stored. A green-looking re-walk of the archive would do that
  // to every day in it.
  //
  // So an unread column passes `undefined` (Prisma for "leave this field
  // alone") on UPDATE, while CREATE still writes null — a new row has nothing
  // to preserve, and null there is the honest "we do not have this".
  //
  // This is `InstrumentProvider.mapToUpdate` (MONEY-1093) and the BondMaster
  // writer's rule restated: a provider may supply or replace a field it
  // actually publishes, and may never clear one it does not. The cost is stated
  // rather than hidden — if NSE genuinely retires a column, a stale value
  // persists on rows already written — and it is the safer half of the trade,
  // because the counter above makes it visible on the FIRST run rather than
  // after the history is gone.
  const unread = new Set<string>(out.unresolvedColumns);
  const readOrKeep = <T>(column: string, value: T): T | undefined =>
    unread.has(column) ? undefined : value;
  // netValue is DERIVED from the two value columns; if either was unread its
  // null is likewise not a reading.
  const netValueOnUpdate = (value: number | null): number | null | undefined =>
    unread.has("longValue") || unread.has("shortValue") ? undefined : value;

  const date = out.tradingDate;
  for (const row of out.rows) {
    await prisma.marketPositioning.upsert({
      where: {
        date_participant_bucket_metric: {
          date,
          participant: FII_STATS_PARTICIPANT,
          bucket: row.bucket,
          // Its OWN metric. Borrowing "OI"/"VOLUME" here would target the rows
          // `nse-fao-participant-*` writes for the same participant and day and
          // overwrite them without raising anything.
          metric: FII_STATS_METRIC,
        },
      },
      create: {
        date,
        participant: FII_STATS_PARTICIPANT,
        bucket: row.bucket,
        metric: FII_STATS_METRIC,
        longQty: row.longQty,
        shortQty: row.shortQty,
        netQty: row.netQty,
        longValue: row.longValue,
        shortValue: row.shortValue,
        netValue: row.netValue,
        openInterestQty: row.openInterestQty,
        openInterestValue: row.openInterestValue,
        source: family,
      },
      // A re-walk overwrites every column we actually READ, for the same reason
      // the positioning writer does: these files are static once published, so
      // this is normally a no-op, and if NSE restates a day the later reading is
      // the better one. A column we could not read is left alone — see the
      // `readOrKeep` note above.
      update: {
        longQty: row.longQty,
        shortQty: row.shortQty,
        netQty: row.netQty,
        longValue: readOrKeep("longValue", row.longValue),
        shortValue: readOrKeep("shortValue", row.shortValue),
        netValue: netValueOnUpdate(row.netValue),
        openInterestQty: readOrKeep("openInterestQty", row.openInterestQty),
        openInterestValue: readOrKeep(
          "openInterestValue",
          row.openInterestValue,
        ),
        source: family,
      },
    });
    tally.upserted++;
  }
  return out.rows.length;
}

/**
 * Debt security master — MONEY-1204 (P14 / 14b.1).
 *
 * TWO families, ONE table, joined on ISIN — the only identifier both files
 * print (`wdmlist` spells the instrument `CG2036`, the corporate report spells
 * it `AXBK32`, and those namespaces do not intersect).
 *
 * ## Why an incoming NULL never erases a stored value
 *
 * `BondMaster.isin` is `@unique`, and the two files have DISJOINT column
 * coverage: `wdmlist` has no Issuer, Face Value or Credit Rating column AT ALL,
 * which is why `parseWdmList` hard-codes those three to null. A plain
 * last-write-wins upsert would therefore let tonight's wdmlist BLANK the issuer
 * the corporate report supplied an hour earlier — and the row would still look
 * complete, just poorer, with no error and no counter.
 *
 * So the update path passes `undefined` (Prisma for "leave this field alone")
 * wherever the incoming value is null. This is MONEY-1093's
 * `InstrumentProvider.mapToUpdate` rule applied to a second two-provider table:
 * a provider may supply or replace a field it actually publishes, and may never
 * clear one it does not.
 *
 * The cost is stated rather than hidden: a value can be added or replaced but
 * never cleared, so if NSE ever deliberately blanks a cell the old value
 * persists. For a security master that is the safer half of the trade — issuer,
 * face value, coupon and maturity do not become unknown once known — and the
 * alternative has a live instance (see above), not a hypothetical one.
 *
 * ## Why an OLDER file may not overwrite a NEWER row
 *
 * This table has NO date in its key, so a history re-walk that reaches 2019
 * AFTER tonight's file would silently roll the master back seven years. That is
 * the authority-order question MONEY-1175 answered for prices, and the answer
 * is the same: declare the order instead of leaving it to arrival time. A row
 * is left alone when the STORED `asOf` is strictly newer than the incoming
 * file's, and counted. Equal `asOf` still overwrites, so re-parsing tonight's
 * file after a parser fix repairs the row rather than being refused.
 */
interface BondMasterTally {
  parsed: number;
  upserted: number;
  /** Parser returned `null` — these bytes are not this report. */
  unrecognisedFormat: number;
  /**
   * Rows left alone because the stored master row came from a NEWER file.
   *
   * ZERO on the nightly pass, which is the only pass that exists today — a
   * non-zero there means files are arriving out of order and is worth
   * investigating. EXPECTED to be large, and correct, on a deliberate history
   * re-walk, which is founder-gated.
   */
  olderThanStored: number;
  /**
   * Files whose `asOf` came from the archive key instead of their own bytes.
   *
   * For `nse-wdm-list` this EQUALS the file count by construction — that family
   * prints no date in any column — so it is information, not an alarm. For
   * `nse-corporate-bond-report` it should be 0: a non-zero means the
   * `Details report for :- …` banner stopped parsing and provenance quietly
   * fell back to the key.
   */
  asOfFromKey: number;
  /** Non-blank rows below the header that produced no row (parser's own). */
  skipped: number;
  /** Second sighting of an ISIN inside ONE file; the parser keeps the first. */
  duplicateIsin: number;
  /** Rows without the exchange's short name / security-type code. */
  noSymbolOrSecType: number;
  /** Rows whose ISIN cell was absent or too short to be one. */
  noIsin: number;
  /** Rows whose width disagreed with the header — a layout drift tripwire. */
  columnCountMismatch: number;
}

async function writeBondMaster(
  csv: string,
  family: string,
  day: Date,
  tally: BondMasterTally,
): Promise<number> {
  const parse = BOND_MASTER_PARSERS[family];
  if (!parse) {
    // A WIRING fault, not a format one, so it deliberately does NOT bump
    // `unrecognisedFormat` — that counter is documented as "the parser returned
    // null", and a family routed to kind "bond-master" with no entry in
    // BOND_MASTER_PARSERS never reached a parser at all. Conflating them would
    // send the next reader to hunt an NSE layout change that never happened.
    // It still throws (MONEY-1204): it fires on EVERY file of the family, and
    // returning 0 would checkpoint the whole family DONE at zero rows.
    throw new UnreadableFeedFile(
      `${family}: kind "bond-master" but no entry in BOND_MASTER_PARSERS, so ` +
        "no parser exists for it. This is a dispatch-table bug, not a format " +
        "change. NOT checkpointed; will be retried once the entry is added.",
    );
  }
  const out = parse(csv);
  if (out === null) {
    tally.unrecognisedFormat++;
    // THROW — MONEY-1204, per-FILE. The row-level counters in this tally
    // (`skipped`, `duplicateIsin`, `noSymbolOrSecType`, `noIsin`,
    // `columnCountMismatch`) stay counters: each means "this ROW was unusable",
    // and `olderThanStored` is not a failure at all.
    throw new UnreadableFeedFile(
      `${family}: unrecognised debt-master layout — no known variant matched. ` +
        "NOT checkpointed; will be retried.",
    );
  }

  // THE ONE PLACE in this job where the archive key is a legitimate date, and
  // only for `wdmlist`: that family prints no date in any column, so the key is
  // the only record of which day the master describes — and `asOf` here is
  // PROVENANCE, not identity, so nothing keys off it. The corporate report
  // carries its own `Details report for :- …` banner and that wins.
  //
  // Contrast `BondEOD.date` and `MwplDaily.date` below, which are facts about a
  // trading session and come from the row's own cell, never from here. Stamping
  // those from the key is right on an ordinary night and wrong on exactly the
  // nights that matter — a replay, a late publication, a re-walk (MONEY-1189).
  const asOf = out.asOf ?? day;
  if (out.asOf === null) tally.asOfFromKey++;

  tally.parsed += out.rows.length;
  tally.skipped += out.skipped;
  tally.duplicateIsin += out.reasons.duplicateIsin ?? 0;
  tally.noSymbolOrSecType +=
    (out.reasons.noSymbol ?? 0) + (out.reasons.noSecType ?? 0);
  tally.noIsin += out.reasons.noIsin ?? 0;
  tally.columnCountMismatch += out.reasons.columnCountMismatch ?? 0;
  if (DRY_RUN) return out.rows.length;

  // One read per BATCH for the whole file rather than one per row: the stale
  // guard needs the STORED `asOf`, and wdmlist is ~10.7k rows.
  const stored = new Map<string, Date>();
  for (let i = 0; i < out.rows.length; i += BATCH) {
    const found = await prisma.bondMaster.findMany({
      where: { isin: { in: out.rows.slice(i, i + BATCH).map((r) => r.isin) } },
      select: { isin: true, asOf: true },
    });
    for (const m of found) stored.set(m.isin, m.asOf);
  }

  for (const row of out.rows) {
    const prev = stored.get(row.isin);
    if (prev && prev.getTime() > asOf.getTime()) {
      tally.olderThanStored++;
      continue;
    }
    await prisma.bondMaster.upsert({
      where: { isin: row.isin },
      create: { ...row, asOf },
      // Null-preserving by design — `undefined` leaves the stored value alone.
      // See the header: wdmlist publishes no issuer/faceValue/creditRating
      // column at all, so its nulls mean "not published here", not "no issuer".
      // `symbol`, `secType`, `source` and `asOf` are always published by both
      // files and are always replaced.
      update: {
        symbol: row.symbol,
        secType: row.secType,
        issuer: row.issuer ?? undefined,
        issueName: row.issueName ?? undefined,
        issueDesc: row.issueDesc ?? undefined,
        creditRating: row.creditRating ?? undefined,
        coupon: row.coupon ?? undefined,
        couponFrequency: row.couponFrequency ?? undefined,
        faceValue: row.faceValue ?? undefined,
        issueDate: row.issueDate ?? undefined,
        maturityDate: row.maturityDate ?? undefined,
        nextCouponDate: row.nextCouponDate ?? undefined,
        lastTradedDate: row.lastTradedDate ?? undefined,
        lastTradedPrice: row.lastTradedPrice ?? undefined,
        status: row.status ?? undefined,
        source: row.source,
        asOf,
      },
    });
    tally.upserted++;
  }
  return out.rows.length;
}

/**
 * Debt EOD prices — MONEY-1204 (P14 / 14b.1).
 *
 * `cbm_trd{YYYYMMDD}.csv` → `BondEOD`. The cash bhavcopy does not carry debt at
 * all, which is why a bond page is empty today.
 *
 * ## The join-coverage counter, and why it is not a filter
 *
 * How many of this file's ISINs actually have a `BondMaster` row is UNKNOWN.
 * The real `cbm_trd` sample carries a G-Sec and CP/CD-series ISINs that suggest
 * partial coverage at best, and the two masters between them may simply not
 * list some of what trades. So the writer MEASURES the join and never gates on
 * it: an EOD row with no master row is still a real price, and dropping it
 * would trade a naming gap for a data gap.
 *
 * `noMasterRow` exists because the silent version of this is MONEY-1085's
 * shape — ~766 NSE closes a day disappearing into a lookup that matched
 * nothing, indistinguishable from "these do not trade". A TOTAL miss is called
 * out separately, in the log and in upper case, because partial is expected and
 * total is not: total means the masters were never parsed, or ISIN
 * normalisation stopped agreeing between the two sides (the `cbm_trd` ISINs
 * carry a TRAILING SPACE, which is exactly the sort of thing that silently
 * un-joins a whole feed).
 */
interface BondEodTally {
  parsed: number;
  upserted: number;
  /** Parser returned `null` — these bytes are not this report. */
  unrecognisedFormat: number;
  /** Rows written whose ISIN has NO `BondMaster` row. Measured, never dropped. */
  noMasterRow: number;
  /**
   * Files carrying more than one distinct `Trade Date`. Every row still lands
   * under its OWN date, so this is informational — but one `cbm_trd` file is
   * one session, so a non-zero means the family stopped being same-day
   * addressable or the archive served the wrong object.
   */
  multiDayFiles: number;
  /** Non-blank rows below the header that produced no row (parser's own). */
  skipped: number;
  /** Second sighting of one (ISIN, day) inside ONE file; the parser keeps the first. */
  duplicateIsinDate: number;
  /** Rows whose ISIN cell was absent or too short to be one. */
  noIsin: number;
  /** Rows whose `Trade Date` cell could not be read. */
  unparseableTradeDate: number;
  /** Rows whose width disagreed with the header — a layout drift tripwire. */
  columnCountMismatch: number;
  /**
   * WDM only (MONEY-1210). `(symbol, issueName)` matched TWO `BondMaster`
   * ISINs, so the row was REFUSED. Seven such pairs exist in the 17-Aug master
   * (`RECL27`/`7.38%` -> two ISINs). A dropped price is a recoverable gap; a
   * price filed against the wrong instrument is a lie nothing downstream can
   * detect.
   */
  ambiguousPair: number;
  /**
   * WDM only. The security traded but is not in `wdmlist`, so there is no ISIN
   * and `BondEOD` has no other key. UNLIKE `noMasterRow` — which is a coverage
   * probe on the CBM path and still writes the row — this one must drop.
   */
  noMasterMatch: number;
  /** WDM only. Second sighting of one (symbol, issue, day) inside ONE file. */
  duplicateSymbolIssueDate: number;
  /** WDM only. Rows whose `Security` or `Issue Name` cell was blank. */
  noSymbolOrIssue: number;
}

/**
 * Resolve one WDM trades file to `BondEodRow`s (MONEY-1210).
 *
 * The join is `(symbol, issueName) -> isin` against `BondMaster`. `symbol`
 * alone is NOT enough — 1,352 of 2,488 distinct securities in the 17-Aug
 * `wdmlist` repeat, the fact `BondMaster.symbol` already documents. Candidates
 * are fetched by symbol (the existing `@@index([symbol])` serves this; no new
 * index is required) and disambiguated in memory by issue name.
 */
async function resolveWdmFile(
  parsed: WdmTradesFile,
  tally: BondEodTally,
): Promise<BondEodRow[]> {
  tally.duplicateSymbolIssueDate +=
    parsed.reasons.duplicateSymbolIssueDate ?? 0;
  tally.noSymbolOrIssue +=
    (parsed.reasons.noSymbol ?? 0) + (parsed.reasons.noIssueName ?? 0);

  if (parsed.rows.length === 0) return [];

  const symbols = [...new Set(parsed.rows.map((r) => r.symbol))];
  const masters: WdmMasterKey[] = [];
  for (let i = 0; i < symbols.length; i += BATCH) {
    const found = await prisma.bondMaster.findMany({
      where: { symbol: { in: symbols.slice(i, i + BATCH) } },
      select: { isin: true, symbol: true, issueName: true },
    });
    masters.push(...found);
  }

  const res = resolveWdmTrades(parsed.rows, masters);
  tally.ambiguousPair += res.reasons.ambiguousPair ?? 0;
  tally.noMasterMatch += res.reasons.noMasterMatch ?? 0;

  // The WDM counterpart of the CBM total-join-miss warning, and here it is
  // worse than a coverage gap: with no master there is no ISIN, so these rows
  // are DROPPED rather than written orphaned, and a silent total miss reads
  // exactly like a day on which no wholesale debt traded.
  if (res.rows.length === 0) {
    log.warn(
      `nse-wdm-daily: NOT ONE of this file's ${parsed.rows.length} trades ` +
        "resolved to a BondMaster ISIN, so nothing can be written. Parse " +
        "nse-wdm-list first (--families=nse-wdm-list), or check that " +
        "SECURITY/ISSUE_NAME still agree across the two files.",
    );
  }
  return res.rows;
}

async function writeBondEod(
  csv: string,
  family: string,
  tally: BondEodTally,
): Promise<number> {
  // MONEY-1210 — two file shapes, one destination. A family with no entry here
  // is a programming error rather than a data condition: `PARSERS` routed it to
  // "bond-eod" and this table did not learn about it, the same pairing
  // `BOND_MASTER_PARSERS` guards on the master side.
  const shape = BOND_EOD_PARSERS[family];
  if (!shape) {
    // `UnreadableFeedFile`, NOT a bare Error — the same choice
    // `BOND_MASTER_PARSERS` makes one screen up, and for the same two reasons.
    // A bare Error is read by the dispatcher as possibly-transient: not
    // recorded, retried nightly, red forever. And returning 0 instead would
    // checkpoint the whole family DONE at zero rows, which is the exact
    // silent-success this job has been bitten by twice.
    throw new UnreadableFeedFile(
      `${family}: kind "bond-eod" but no entry in BOND_EOD_PARSERS, so no ` +
        "parser exists for it and its bytes would otherwise be read as some " +
        "other family's layout. This is a dispatch-table bug, not a format " +
        "change. NOT checkpointed; will be retried once the entry is added.",
    );
  }

  if (shape.via === "symbol-issue") {
    const parsedWdm = shape.parse(csv);
    if (parsedWdm === null) {
      tally.unrecognisedFormat++;
      throw new UnreadableFeedFile(
        `${family}: these bytes are not the WDM settled-trades report — the ` +
          "parser found no recognisable header. The likeliest cause is the " +
          "zip's member order changing, since the decoder returns its FIRST " +
          "entry. NOT checkpointed; will be retried.",
      );
    }
    tally.parsed += parsedWdm.rows.length;
    tally.skipped += parsedWdm.skipped;
    tally.columnCountMismatch += parsedWdm.reasons.columnCountMismatch ?? 0;
    tally.unparseableTradeDate += parsedWdm.reasons.unparseableTradeDate ?? 0;
    if (parsedWdm.reasons.multipleTradeDates) tally.multiDayFiles++;

    // Resolve even on a dry run, so it reports the JOIN outcome and not only
    // the parse. A file that parses cleanly and resolves to nothing is exactly
    // the failure worth seeing before the write.
    const rows = await resolveWdmFile(parsedWdm, tally);
    if (DRY_RUN) return rows.length;
    return await upsertBondEodRows(rows, tally);
  }

  const out = shape.parse(csv);
  if (out === null) {
    tally.unrecognisedFormat++;
    // THROW — MONEY-1204, per-FILE. Everything else this tally counts is
    // per-row (`skipped`, `duplicateIsinDate`, `noIsin`, `unparseableTradeDate`,
    // `columnCountMismatch`) or a deliberate measurement (`noMasterRow`,
    // `multiDayFiles`), and none of those is converted: a price with no master
    // row is still a price, and failing the file over it would trade a naming
    // gap for a data gap.
    throw new UnreadableFeedFile(
      `${family}: these bytes are not the CBM trades report — the parser found ` +
        "no recognisable header. NOT checkpointed; will be retried.",
    );
  }

  tally.parsed += out.rows.length;
  tally.skipped += out.skipped;
  tally.duplicateIsinDate += out.reasons.duplicateIsinDate ?? 0;
  tally.noIsin += out.reasons.noIsin ?? 0;
  tally.unparseableTradeDate += out.reasons.unparseableTradeDate ?? 0;
  tally.columnCountMismatch += out.reasons.columnCountMismatch ?? 0;
  if (out.reasons.multipleTradeDates) tally.multiDayFiles++;
  if (DRY_RUN) return out.rows.length;

  // A COVERAGE PROBE, not a filter — see the header. Every row is written
  // whether or not it joins.
  const isins = [...new Set(out.rows.map((r) => r.isin))];
  const known = new Set<string>();
  for (let i = 0; i < isins.length; i += BATCH) {
    const found = await prisma.bondMaster.findMany({
      where: { isin: { in: isins.slice(i, i + BATCH) } },
      select: { isin: true },
    });
    for (const m of found) known.add(m.isin);
  }
  const orphans = out.rows.filter((r) => !known.has(r.isin)).length;
  tally.noMasterRow += orphans;
  if (out.rows.length > 0 && orphans === out.rows.length) {
    log.warn(
      `${family}: NOT ONE of this file's ${out.rows.length} ISINs has a ` +
        "BondMaster row. Either the two masters have not been parsed yet " +
        "(--families=nse-wdm-list,nse-corporate-bond-report first) or ISIN " +
        "normalisation stopped agreeing across the two sides. Prices are " +
        "still written; a total join miss reads exactly like 'this bond does " +
        "not trade' (MONEY-1085), so it is called out rather than tallied.",
    );
  }

  return await upsertBondEodRows(out.rows, tally);
}

/**
 * The shared write. Both EOD shapes converge here once they have an ISIN, so
 * the upsert semantics below are stated once rather than twice.
 */
async function upsertBondEodRows(
  rows: readonly BondEodRow[],
  tally: BondEodTally,
): Promise<number> {
  for (const row of rows) {
    await prisma.bondEOD.upsert({
      where: {
        isin_date_segment: {
          isin: row.isin,
          date: row.date,
          // IN THE KEY. One ISIN can print on one day in both the CBM and WDM
          // segments at different prices, and collapsing them would make the
          // stored price order-dependent — MONEY-1201's SLB lesson, where
          // 84.2% of a day's open interest vanished to exactly that.
          segment: row.segment,
        },
      },
      create: { ...row },
      // A straight overwrite, unlike the master above: this is a price series
      // from ONE source with the segment already in the key, so an incoming
      // null is a restatement of the cell rather than "my file has no such
      // column". Re-walking a static file is a no-op; if NSE restates a session
      // the later reading is the better one.
      update: {
        lastPrice: row.lastPrice,
        lastYtm: row.lastYtm,
        wapPrice: row.wapPrice,
        wtdYtm: row.wtdYtm,
        lastTradeValueLacs: row.lastTradeValueLacs,
        totalTradeValueLacs: row.totalTradeValueLacs,
        source: row.source,
      },
    });
    tally.upserted++;
  }
  return rows.length;
}

/**
 * Market-wide F&O open interest per underlying — MONEY-1204 (P14 / 14b.2).
 *
 * `combineoi_deleq_{DDMMYYYY}.csv` → `MwplDaily`, 688 archived days back to
 * 2023-04.
 *
 * The table is named for MWPL utilisation and stores only its NUMERATOR: the
 * denominator's own family (`nse-mwpl-cli`) 404s with zero archived objects,
 * and the neighbouring `oi_cli_limit` publishes a PER-CLIENT limit, which is a
 * different quantity that would yield a plausible and wrong utilisation. So
 * `toMwplDailyWrite` types `mwpl` / `utilisationPct` as the literal `null` and
 * this writer cannot slip a substitute in even by accident. That is the design;
 * see the model's doc comment.
 *
 * `CombinedOiRow.isIndex` has no column on the model and is dropped by
 * `toMwplDailyWrite`. It is counted here instead, because MWPL does not apply
 * to an index and those rows can never be utilisation candidates even after a
 * denominator lands — a fact that would otherwise be invisible in the table.
 */
interface MwplTally {
  parsed: number;
  upserted: number;
  /** Parser returned `null` — these bytes are not this report. */
  unrecognisedFormat: number;
  /**
   * Header recognised, not ONE legible data row. Distinct from
   * `unrecognisedFormat` and from a holiday: the parser found its columns and
   * every line under them failed, which is a shape change inside a file we can
   * still open.
   */
  noRows: number;
  /** Index underlyings (`NA` in both identity columns). Not MWPL candidates. */
  indexRows: number;
  /** Rows disagreeing with the file's first date. Each keeps its OWN date. */
  mixedDate: number;
  /** Rows whose width disagreed with the header (an unquoted comma in a name). */
  fieldCount: number;
  /** Rows with no underlying symbol. */
  noSymbol: number;
  /** Rows whose `Date` cell could not be read. */
  badDate: number;
  /** Rows carrying NEITHER open-interest measure — they state nothing. */
  noOpenInterest: number;
}

async function writeMwpl(
  csv: string,
  family: string,
  tally: MwplTally,
): Promise<number> {
  const out = parseCombinedOiDeleq(csv);
  if (out === null) {
    tally.unrecognisedFormat++;
    // THROW, never `return 0` — MONEY-1204.
    //
    // This returned 0 and cost 2 years of history in silence. A 0 return is
    // indistinguishable from "the parser read the file and the market was
    // shut", so the dispatcher checkpointed the file DONE and never retried
    // it. Measured on prod 2026-08-18: 409 of 688 archived files (2023-04 →
    // 2025-06) were checkpointed DONE with zero rows, `mwpl_daily` held 270
    // days of a 688-day archive, and the run exited 0 reporting success.
    //
    // Throwing routes it into the per-file catch, which counts it `unreadable`
    // and leaves it UN-CHECKPOINTED so the next run retries it — exactly what
    // `writeBseLegacyCash` does and documents, and what this file's own
    // `unrecognisedFormat` doc has always claimed happened here. The MONEY-1189
    // rule: never let "we cannot read this" wear the same face as "there was
    // nothing to read".
    throw new UnreadableFeedFile(
      `unrecognised combined-OI header for ${family} — no known variant ` +
        "matched. The file is NOT checkpointed and will be retried; add the " +
        "layout to parseCombinedOiDeleq rather than letting it parse to zero.",
    );
  }

  tally.parsed += out.rows.length;
  tally.indexRows += out.rows.filter((r) => r.isIndex).length;
  tally.mixedDate += out.reasons["mixed-date"] ?? 0;
  tally.fieldCount += out.reasons["field-count"] ?? 0;
  tally.noSymbol += out.reasons["no-symbol"] ?? 0;
  tally.badDate += out.reasons["bad-date"] ?? 0;
  tally.noOpenInterest += out.reasons["no-open-interest"] ?? 0;
  if (out.rows.length === 0) {
    tally.noRows++;
    // Same rule, second door. The header matched and EVERY row under it
    // failed — a shape change inside a file we can still open, which this
    // tally's own doc distinguishes from a holiday. NSE does not publish a
    // header-only file on a holiday; it publishes nothing, and a 404 already
    // checkpoints MISSING. So zero legible rows is a parse problem, and
    // checkpointing it DONE would bury it the same way the branch above did.
    throw new UnreadableFeedFile(
      `combined-OI header recognised for ${family} but not one legible data ` +
        "row — the layout changed under a header we still match. NOT " +
        "checkpointed; will be retried.",
    );
  }
  if (DRY_RUN) return out.rows.length;

  for (const row of out.rows) {
    // `date` is the ROW's own `Date` cell, carried through by the parser — the
    // archive key is never consulted here. `family` is deliberately NOT the
    // source string: `MWPL_SOURCE` is the package's own constant and the
    // readers filter on it, so a family id here would write rows nothing finds.
    const write = toMwplDailyWrite(row, MWPL_SOURCE);
    await prisma.mwplDaily.upsert({
      where: { symbol_date: { symbol: write.symbol, date: write.date } },
      create: write,
      // A re-walk overwrites, same call as writePositioning's: these files are
      // static once published, so this is normally a no-op, and if NSE restates
      // a day the later reading is the better one. `mwpl` / `utilisationPct`
      // are re-asserted as null on purpose — if a denominator source ever lands
      // and is then withdrawn, this is what walks the stale utilisation back
      // out rather than leaving it frozen at a number nobody can reproduce.
      update: {
        isin: write.isin,
        notionalOi: write.notionalOi,
        futEquivOi: write.futEquivOi,
        mwpl: write.mwpl,
        utilisationPct: write.utilisationPct,
        source: write.source,
      },
    });
    tally.upserted++;
  }
  return out.rows.length;
}

// ─── Run verdict ─────────────────────────────────────────────────────

/*
 * unreadable-verdict:begin
 *
 * The region between these markers is PURE and IMPORT-FREE on purpose:
 * `feed-parse-unreadable.test.ts` extracts it and EXECUTES it, so the suite
 * asserts against the real decision rather than against the source text that
 * describes it. `feed-parse.ts` is a script with a top-level `main()` and a
 * module-scope Prisma import, so it cannot be imported into `node:test` at all
 * — and MONEY-1204 is the reminder of what the alternative costs: a suite that
 * pinned `return 0;` as source text held the data-loss bug in place.
 *
 * Same division of labour as `judgeRunCompletion` (packages/core, MONEY-1189):
 * the decision is a pure function, and the call site is a three-line shell that
 * cannot be wrong in an interesting way.
 */

/** What the run's files did, reduced to the four numbers the verdict needs. */
export interface UnreadableRunTally {
  /** Refusals at a (family, day) NOT already recorded `UNREADABLE`. */
  newUnreadable: number;
  /** Refusals that were already recorded `UNREADABLE` before this run began. */
  knownUnreadable: number;
  /** Failures we could NOT classify: download, DB, unexpected exception. */
  transientFailures: number;
  /** Objects with no date token — unrecordable, therefore never fatal. */
  undated: number;
  /** Files not opened at all because they were already known-bad. */
  knownBadSkipped: number;
  /** A dry run reads no checkpoints, so it cannot know what is known-bad. */
  dryRun: boolean;
}

export interface UnreadableRunVerdict {
  /** Whether the caller must set a non-zero exit code. */
  exitNonZero: boolean;
  /** Operator-facing line; null when there is nothing to say. */
  message: string | null;
}

/**
 * Should a run that read SOME files report success? — MONEY-1205.
 *
 * ## The defect
 *
 * `process.exitCode` was set by exactly two tripwires: no files seen at all, and
 * every opened file yielding zero rows. Neither fires on PARTIAL failure, so a
 * run that could not read 409 of 688 files exited **0**, and the per-file catch
 * did nothing but `unreadable++` and a warning nobody was watching. Systematic
 * failure reported as success — the same shape as the `return 0` inside the
 * writers, one level up.
 *
 * ## The tension, and where the line is drawn
 *
 * 13 files are expected to fail on EVERY run, forever, and no drift-fixing will
 * change that: one gzip stream stored under a `.csv` key (now handled — see
 * `decodeFeedText`), eleven files whose slash-formatted dates are mutually contradictory
 * (`4/3/2024` can only be day-first, `11/2/2023` can only be month-first) and
 * are deliberately refused rather than guessed, and one publishing the token
 * `20-11-0018`. A naive `unreadable > 0 ⇒ exit 1` would paint the nightly job
 * red forever, and this file already carries the warning about what that does:
 * "how a real tripwire gets trained into background noise and then ignored on
 * the night it fires for real."
 *
 * So the predicate is NOT "did anything fail" but "did anything fail that we had
 * not already written down":
 *
 *   exitNonZero  ⇔  (newUnreadable > 0 || transientFailures > 0) && !dryRun
 *
 * `knownUnreadable` and `knownBadSkipped` are reported on every run and fail
 * none. `undated` never fails a run either, for a different reason: with no date
 * there is no (family, date) checkpoint key, so such a file can never be
 * recorded known-bad and a tripwire on it could never be cleared.
 *
 * A dry run reads no checkpoints (by design — it must be runnable without
 * credentials), so it cannot tell new from known and does not get a vote on the
 * exit code. It still prints the whole verdict.
 */
export function judgeUnreadableFiles(
  t: UnreadableRunTally,
): UnreadableRunVerdict {
  const fatal: string[] = [];
  if (t.newUnreadable > 0) {
    fatal.push(
      `${t.newUnreadable} file(s) could not be read and were NOT already ` +
        "recorded UNREADABLE",
    );
  }
  if (t.transientFailures > 0) {
    fatal.push(
      `${t.transientFailures} file(s) failed for an UNCLASSIFIED reason ` +
        "(download / DB / unexpected exception) and were left un-checkpointed",
    );
  }

  const accounted: string[] = [];
  if (t.knownUnreadable > 0) {
    accounted.push(`${t.knownUnreadable} re-refused (already UNREADABLE)`);
  }
  if (t.knownBadSkipped > 0) {
    accounted.push(`${t.knownBadSkipped} skipped as already UNREADABLE`);
  }
  if (t.undated > 0) {
    accounted.push(`${t.undated} with no date token (cannot be checkpointed)`);
  }
  const tail = accounted.length
    ? ` Not counted against the run: ${accounted.join(", ")}.`
    : "";

  if (fatal.length === 0) {
    return {
      exitNonZero: false,
      message: accounted.length
        ? `unreadable files, all of them already accounted for.${tail}`
        : null,
    };
  }

  return {
    exitNonZero: !t.dryRun,
    message:
      `${fatal.join("; ")}. ` +
      (t.dryRun
        ? "This is a DRY RUN — it reads no checkpoints and so cannot tell a new " +
          "refusal from a known one, which is why the exit code is left alone."
        : "Refusing to report success: a run that could not read a file it had " +
          "never refused before has not done its job. Re-run after fixing, or " +
          "— if these bytes are permanently unreadable — the UNREADABLE " +
          "checkpoints just written make the next run green by themselves.") +
      tail,
  };
}

/* unreadable-verdict:end */

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  // FIRST statement, before any work or any other log line: the whole point is
  // that a reader of a nightly "SUCCEEDED" can tell which commit produced it.
  reportBuildProvenance(log, "feed-parse");

  const targets = (
    FAMILIES.length ? FAMILIES : Object.keys(PARSERS)
  ) as ParserKey[];

  const unknown = targets.filter((t) => !(t in PARSERS));
  if (unknown.length) {
    log.warn(
      `no parser for: ${unknown.join(", ")} — these families are ARCHIVED but ` +
        `not parsed here (analytics families are P4/MONEY-1100). Skipping.`,
    );
  }

  log.info(
    `parsing ${targets.filter((t) => t in PARSERS).length} families` +
      `${LIMIT ? `, max ${LIMIT} files each` : ""}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  // One instrument index for the whole run — the universe does not change
  // between files, and rebuilding it per file would dominate the runtime.
  //
  // A dry run skips it (and every other DB read) so the job can be smoke-tested
  // without credentials. The trade-off is stated rather than hidden: with an
  // empty index nothing resolves, so the dry run reports FILE coverage
  // honestly and its resolution counts are meaningless by construction.
  let index: InstrumentIndex = {
    byIsinExchange: new Map(),
    bySymbolExchange: new Map(),
  };
  if (DRY_RUN) {
    log.warn(
      "DRY RUN: skipping the instrument index and all DB reads. File counts " +
        "are real; resolution/drop counts are NOT meaningful.",
    );
  } else {
    const instruments = await prisma.instrumentMapping.findMany({
      select: { id: true, symbol: true, exchange: true, isin: true },
    });
    index = buildInstrumentIndex(instruments);
    log.info(
      `instrument index: ${index.byIsinExchange.size} ISIN keys, ` +
        `${index.bySymbolExchange.size} symbol keys`,
    );
  }

  let totalFilesSeen = 0;
  let totalFilesAttempted = 0;
  // Run-level parse total, for the MONEY-1169 all-files-yield-nothing tripwire.
  let totalRowsParsed = 0;
  // Rows that actually reached the database — MONEY-1238. Deliberately a
  // SECOND number: `totalRowsParsed` answers "were the bytes readable" and this
  // answers "did anything land", and the six-incidents-in-a-week class
  // (`reportJobOutcome`) is entirely about the second one being zero while the
  // first looks healthy.
  let totalRowsAccounted = 0;

  // MONEY-1205 — the four run-level failure counters the exit code is derived
  // from. They are deliberately separate numbers: the old code had ONE
  // (`unreadable`, per family), it drove nothing, and a run that could not read
  // 409 of 688 files exited 0. Which of these four moves determines whether the
  // run is red, so collapsing them would either cry wolf every night or go
  // silent on the night it matters.
  //
  //   new         a refusal at a (family, day) we had NOT recorded before → RED
  //   known       a refusal we had already recorded → not red BY ITSELF
  //   transient   unclassified: download, DB, unexpected exception → RED, and
  //               never checkpointed
  //   undated     the object name carries no date, so it CANNOT be checkpointed
  //               (the checkpoint key is (family, date)) and therefore can never
  //               join the known-bad set. Counted and logged, never red — a
  //               tripwire nothing can ever clear is the definition of noise.
  let totalNewUnreadable = 0;
  let totalKnownUnreadable = 0;
  let totalTransientFailures = 0;
  let totalUndated = 0;
  let totalKnownBadSkipped = 0;

  for (const id of targets) {
    const spec = PARSERS[id];
    if (!spec) continue;
    const family = familyById(id);
    if (!family) {
      log.warn(`${id}: not in the registry, skipping`);
      continue;
    }

    const prefix = `feeds/${family.exchange}/${family.feed}/`;
    let keys = await listFiles(prefix);
    keys = keys.filter((k) => !k.endsWith("/"));
    totalFilesSeen += keys.length;

    // Resume: skip files already parsed, and files already RECORDED unreadable.
    //
    // One query for both statuses (MONEY-1205). The `UNREADABLE` set does two
    // jobs and they are not the same job:
    //
    //   1. it keeps the nightly off 13 files whose bytes we have already
    //      refused, so `totalFilesAttempted` still means "files with something
    //      new to say" and the zero-rows tripwire below is not retrained into
    //      noise by a permanently-pending set that can never produce a row;
    //   2. it is the run-START snapshot the exit-code decision needs. A refusal
    //      is only allowed to go quiet if it was ALREADY recorded before this
    //      run opened anything — which is why the set is read here and not
    //      inferred from what the loop happens to hit.
    const checkpointRows = DRY_RUN
      ? []
      : await prisma.feedBackfillProgress.findMany({
          where: {
            family: parseCheckpointFamily(id),
            status: { in: [PARSE_STATUS.done, PARSE_STATUS.unreadable] },
          },
          select: { date: true, status: true },
        });
    const done = new Set(
      checkpointRows
        .filter((r) => r.status === PARSE_STATUS.done)
        .map((r) => isoDay(r.date)),
    );
    const knownUnreadable = new Set(
      checkpointRows
        .filter((r) => r.status === PARSE_STATUS.unreadable)
        .map((r) => isoDay(r.date)),
    );

    let knownBadSkipped = 0;
    const pending = keys.filter((k) => {
      const d = dateFromArchiveKey(k);
      if (!d) return true;
      const iso = isoDay(d);
      if (done.has(iso)) return false;
      if (!RETRY_UNREADABLE && knownUnreadable.has(iso)) {
        knownBadSkipped++;
        return false;
      }
      return true;
    });
    const slice = LIMIT ? pending.slice(0, LIMIT) : pending;
    progress.planned += slice.length;
    for (const k of slice) progress.outstanding.add(k);
    // Files this run actually OPENS. Distinct from `totalFilesSeen`, which
    // counts everything listed including already-checkpointed files — see the
    // zero-rows tripwire at the end of main() for why the difference matters.
    totalFilesAttempted += slice.length;
    totalKnownBadSkipped += knownBadSkipped;

    log.info(
      `${id}: ${keys.length} archived, ${done.size} already parsed, ` +
        `${slice.length} to parse` +
        // Never silent: a skipped known-bad file is on the summary of EVERY run,
        // so the set cannot quietly grow into a data gap nobody reads.
        `${knownBadSkipped ? `, ${knownBadSkipped} skipped as already-UNREADABLE (re-test with --retry-unreadable)` : ""}` +
        `${RETRY_UNREADABLE && knownUnreadable.size ? `, RE-TRYING ${knownUnreadable.size} known-unreadable` : ""}`,
    );
    if (slice.length === 0) continue;

    const cash: CashTally = {
      parsed: 0,
      written: 0,
      upgraded: 0,
      skipped: 0,
      dupInFile: 0,
      droppedUndrawable: 0,
      droppedUnresolved: 0,
      withoutIsin: 0,
      droppedBySeries: {},
      isinFromScripMaster: 0,
      scripNotInMaster: 0,
      unrecognisedFormat: 0,
    };
    const fo: FoTally = {
      parsed: 0,
      written: 0,
      skipped: 0,
      retentionSkipped: 0,
      dupInFile: 0,
    };
    const nseDel: NseDeliveryTally = {
      parsed: 0,
      created: 0,
      updated: 0,
      droppedUnresolved: 0,
      dateMismatch: 0,
    };
    const bseDel: BseDeliveryTally = {
      parsed: 0,
      updated: 0,
      noPriceRow: 0,
      unresolvedScrip: 0,
      dateMismatch: 0,
    };
    const idx: IndexCloseTally = { parsed: 0, upserted: 0, emptySlug: 0 };
    const flags: FlagTally = { parsed: 0, written: 0, skipped: 0 };
    const deals: DealsTally = {
      parsed: 0,
      written: 0,
      duplicate: 0,
      dateMismatch: 0,
      dropped: 0,
    };
    const slb: SlbTally = { parsed: 0, upserted: 0 };
    const positioning: PositioningTally = {
      parsed: 0,
      upserted: 0,
      noDate: 0,
      noMeasure: 0,
      unrecognisedFormat: 0,
      discrepancies: 0,
      droppedLegs: 0,
    };
    const fiiStats: FiiStatsTally = {
      parsed: 0,
      upserted: 0,
      noDate: 0,
      unrecognisedFormat: 0,
      discrepancies: 0,
      droppedRows: 0,
      unresolvedColumns: 0,
    };
    const bondMaster: BondMasterTally = {
      parsed: 0,
      upserted: 0,
      unrecognisedFormat: 0,
      olderThanStored: 0,
      asOfFromKey: 0,
      skipped: 0,
      duplicateIsin: 0,
      noSymbolOrSecType: 0,
      noIsin: 0,
      columnCountMismatch: 0,
    };
    const bondEod: BondEodTally = {
      parsed: 0,
      upserted: 0,
      unrecognisedFormat: 0,
      noMasterRow: 0,
      multiDayFiles: 0,
      skipped: 0,
      duplicateIsinDate: 0,
      noIsin: 0,
      unparseableTradeDate: 0,
      columnCountMismatch: 0,
      // MONEY-1210 — WDM-only drop reasons.
      ambiguousPair: 0,
      noMasterMatch: 0,
      duplicateSymbolIssueDate: 0,
      noSymbolOrIssue: 0,
    };
    const mwpl: MwplTally = {
      parsed: 0,
      upserted: 0,
      unrecognisedFormat: 0,
      noRows: 0,
      indexRows: 0,
      mixedDate: 0,
      fieldCount: 0,
      noSymbol: 0,
      badDate: 0,
      noOpenInterest: 0,
    };
    let unreadable = 0;

    for (const key of slice) {
      const rawDay = dateFromArchiveKey(key);
      // Normalize to the row-date convention ONCE, at the boundary. The raw
      // value is UTC NOON (the walk's parseDay convention); stamping or
      // querying with it forked 3.24M DailyPrice rows onto a second
      // date-series 12h from every midnight row (MONEY-1100 postmortem).
      const day = rawDay ? utcMidnightOf(rawDay) : null;
      if (!day) {
        log.warn(`${key}: no date token in the object name — skipping`);
        unreadable++;
        // Counted, never red: with no date there is no checkpoint key, so this
        // file can never be recorded known-bad and a tripwire on it could never
        // be cleared by anything short of renaming the object (MONEY-1205).
        totalUndated++;
        continue;
      }

      // HARD timeout. `downloadFile` sits outside the per-file try/catch below,
      // so a never-settling GCS promise here drains the event loop and Node
      // exits 0 with no output — the suspected mechanism behind the 11-of-21
      // silent partial run (MONEY-1189). Rejecting turns that into a counted
      // skip the resume path retries, because the file stays un-checkpointed.
      let buf: Buffer | null = null;
      try {
        buf = await withHardTimeout(
          () => downloadFile(key),
          DOWNLOAD_TIMEOUT_MS,
          key,
        );
      } catch (err) {
        log.warn(
          `${key}: download failed — ${err instanceof Error ? err.message : err}`,
        );
      }
      if (!buf) {
        unreadable++;
        // TRANSIENT by construction, and the cleanest instance of the
        // distinction this run's exit code rests on: a failed or timed-out GCS
        // download says nothing whatever about the payload, so it is never
        // checkpointed and it always makes the run red. It clears itself on the
        // next run if the storage layer was merely having a moment, and stays
        // red if it was not (MONEY-1205).
        totalTransientFailures++;
        progress.finished++;
        progress.outstanding.delete(key);
        continue;
      }

      try {
        // `decodeFeedText` stringifies the payload. That is right for every CSV/zip
        // family and destructive for a binary workbook, so kinds whose payload
        // is binary are dispatched from `buf` and never read `csv`.
        const csv = spec.kind === "fii-stats" ? "" : decodeFeedText(buf);
        // TWO numbers per file, not one (MONEY-1238). `rowsUnaccounted` is the
        // part of `rowsParsed` that never reached the database at ALL, and
        // `decideParseStatus` is what turns the pair into DONE or ZERO. Every
        // branch below states BOTH — the type requires it — so a new family
        // cannot join without answering the question that cost this job its
        // BSE-delivery history. The audit behind each `rowsUnaccounted: 0`:
        //
        //   stock-flags   every parsed row is createMany'd; the tally's
        //                 `skipped` is the PARSER's own count of lines that
        //                 never became rows, and is not inside `parsed`.
        //   slb           every parsed row is upserted.
        //   positioning   ditto; its three all-or-nothing conditions (no title
        //                 date, no measure, unrecognised layout) THROW, so they
        //                 never arrive here as a quiet zero.
        //   fii-stats     ditto. `unresolvedColumns` is per (file x COLUMN) and
        //                 never removes a row: the rows land, and one of their
        //                 columns is left ALONE rather than blanked (see the
        //                 `readOrKeep` note in writeFiiStats). It reads like
        //                 this defect and is not it.
        //   mwpl          every parsed row is upserted; the row-level reasons
        //                 come off the parser and are not inside `parsed`.
        //   fo            `retentionSkipped` is POLICY and `dupInFile` is a
        //                 collapse into a row we DID keep. Both are decisions a
        //                 retry can never change, so counting them would
        //                 re-parse every pre-2018 stock F&O file nightly,
        //                 forever, for nothing.
        //   bond-master   `olderThanStored` is a comparison AGAINST THE STORED
        //                 ROW — the row reached the database and lost.
        //   bond-eod      already returns the rows that reached the database
        //                 (the WDM path returns the RESOLVED count), which is
        //                 this same invariant, arrived at first.
        let outcome: FileOutcome = { rowsParsed: 0, rowsUnaccounted: 0 };
        if (spec.kind === "stock-flags") {
          const before = flags.parsed;
          await writeStockFlags(id, csv, day, index, flags);
          outcome = { rowsParsed: flags.parsed - before, rowsUnaccounted: 0 };
        } else if (spec.kind === "deals") {
          const before = deals.parsed;
          const beforeDropped = deals.dropped;
          await writeDeals(csv, DEAL_TYPES[id]!, day, deals);
          outcome = {
            rowsParsed: deals.parsed - before,
            // Rows the schema cannot represent (non-integer qty), dropped
            // before any query. `duplicate` is deliberately NOT here: those
            // were matched against the stored `dedupeKey`, which is a decision.
            rowsUnaccounted: deals.dropped - beforeDropped,
          };
        } else if (spec.kind === "slb") {
          const before = slb.parsed;
          await writeSlb(csv, day, slb);
          outcome = { rowsParsed: slb.parsed - before, rowsUnaccounted: 0 };
        } else if (spec.kind === "positioning") {
          // NOTE: `day` is deliberately NOT passed. The trading date comes from
          // the file's own title row; see writePositioning's `noDate` comment.
          outcome = {
            rowsParsed: await writePositioning(csv, id, positioning),
            rowsUnaccounted: 0,
          };
        } else if (spec.kind === "fii-stats") {
          // Raw Buffer, not `csv` — see the PARSERS note. `day` is likewise not
          // passed: the date is the title row's, for the same reason.
          outcome = {
            rowsParsed: await writeFiiStats(buf, id, fiiStats),
            rowsUnaccounted: 0,
          };
        } else if (spec.kind === "bond-master") {
          // `day` IS passed, and this is the ONLY writer in this job entitled
          // to it: `wdmlist` prints no date in any column, so the archive key
          // is the only record of which day the master describes. It is used
          // for `BondMaster.asOf` (provenance) and nothing else — see
          // writeBondMaster's header.
          outcome = {
            rowsParsed: await writeBondMaster(csv, id, day, bondMaster),
            rowsUnaccounted: 0,
          };
        } else if (spec.kind === "bond-eod") {
          // `day` deliberately NOT passed: every row carries its own
          // `Trade Date`, which is the fact and the key.
          outcome = {
            rowsParsed: await writeBondEod(csv, id, bondEod),
            rowsUnaccounted: 0,
          };
        } else if (spec.kind === "mwpl") {
          // `day` deliberately NOT passed: every row carries its own `Date`.
          outcome = {
            rowsParsed: await writeMwpl(csv, id, mwpl),
            rowsUnaccounted: 0,
          };
        } else if (spec.kind === "index-close") {
          const before = idx.parsed;
          const beforeEmptySlug = idx.emptySlug;
          await writeIndexClose(csv, day, idx);
          outcome = {
            rowsParsed: idx.parsed - before,
            // A row whose name does not slug is unfindable and is never
            // upserted. All of them failing to slug means the name column is
            // not where we think it is — which reads as a quiet session and is
            // not one.
            rowsUnaccounted: idx.emptySlug - beforeEmptySlug,
          };
        } else if (spec.kind === "nse-delivery") {
          const before = nseDel.parsed;
          const beforeDropped = nseDel.droppedUnresolved;
          await writeNseDelivery(csv, day, index, nseDel);
          outcome = {
            rowsParsed: nseDel.parsed - before,
            // Rows with no instrument to attach to. A later run resolves them
            // once the instrument master covers the symbol, so a file that
            // resolved NOTHING must stay retryable.
            rowsUnaccounted: nseDel.droppedUnresolved - beforeDropped,
          };
        } else if (spec.kind === "bse-delivery") {
          const before = bseDel.parsed;
          const beforeUnaccounted = bseDel.unresolvedScrip + bseDel.noPriceRow;
          await writeBseDelivery(csv, day, index, bseDel);
          outcome = {
            rowsParsed: bseDel.parsed - before,
            // THE defect this ticket closes, now arithmetic instead of prose.
            // SCBSEALL is UPDATE-ONLY: a row with no scrip-master join
            // (`unresolvedScrip`) and a row with no `DailyPrice` to attach to
            // (`noPriceRow`) both leave the database untouched, and BOTH clear
            // once the missing side lands — the master on the next archive, the
            // price rows when P7's legacy cash families are parsed for that
            // era. Either can absorb 100% of a file.
            rowsUnaccounted:
              bseDel.unresolvedScrip + bseDel.noPriceRow - beforeUnaccounted,
          };
        } else if (spec.kind === "cash" && spec.era === "bse-legacy") {
          // Owns its own tally updates + write, because an unrecognised header
          // must THROW here rather than degrade to zero rows (see the writer).
          const beforeDropped = cash.droppedUnresolved + cash.droppedUndrawable;
          outcome = {
            rowsParsed: await writeBseLegacyCash(csv, day, index, cash),
            rowsUnaccounted:
              cash.droppedUnresolved + cash.droppedUndrawable - beforeDropped,
          };
        } else if (spec.kind === "cash") {
          const parsedRows =
            spec.era === "legacy"
              ? parseOldNseCmBhavcopy(csv, day)
              : {
                  rows: parseUdiffBhavcopy(csv, family.exchange, day),
                  droppedBySeries: {} as Record<string, number>,
                  withoutIsin: 0,
                };
          cash.parsed += parsedRows.rows.length;
          cash.withoutIsin += parsedRows.withoutIsin;
          for (const [k, v] of Object.entries(parsedRows.droppedBySeries)) {
            cash.droppedBySeries[k] = (cash.droppedBySeries[k] ?? 0) + v;
          }
          const beforeDropped = cash.droppedUnresolved + cash.droppedUndrawable;
          await writeCash(parsedRows.rows, index, cash);
          outcome = {
            rowsParsed: parsedRows.rows.length,
            // Rows with no instrument, and rows whose candle could not be made
            // drawable. `skipped` (the MONEY-1175 source-precedence hold) is
            // NOT here and must never be: it is the correct outcome of an
            // idempotent re-parse, and counting it would stamp ZERO on
            // already-complete days and re-parse them nightly forever.
            rowsUnaccounted:
              cash.droppedUnresolved + cash.droppedUndrawable - beforeDropped,
          };
        } else {
          const out =
            spec.era === "legacy"
              ? parseOldNseFoBhavcopy(csv, day)
              : parseUdiffFoBhavcopy(csv, family.exchange, day);
          fo.parsed += out.rows.length;
          fo.skipped += out.skipped;
          await writeFo(out.rows, fo);
          outcome = { rowsParsed: out.rows.length, rowsUnaccounted: 0 };
        }

        if (!DRY_RUN) {
          // MONEY-1169 postmortem, third bite of the same class: a checkpoint
          // that records DONE at ZERO parsed rows is a lie that resume then
          // honors forever. The corrupt-era runs checkpointed 8,621 such days
          // (7,339 cm-legacy + 1,282 BSE) and every one had to be found and
          // purged by hand. ZERO is non-terminal — loadCheckpoints only skips
          // DONE — so a pathological file is retried on the next run instead
          // of being silently declared complete.
          const d = day; // already utcMidnightOf-normalized above
          // MONEY-1238, fourth bite: the gate used to be `fileRows > 0`, and
          // `fileRows` counted rows the PARSER produced — including rows a
          // writer then dropped without the database ever seeing them. See
          // `decideParseStatus`.
          const verdict = decideParseStatus(outcome);
          if (verdict.absorbedAll) {
            // SAY it, at WARN, per file. Every row this file yielded was
            // dropped before the database saw it — the state that reads exactly
            // like a market holiday and is not one. A counter that reaches no
            // verdict is how the BSE-delivery family went quiet.
            log.warn(
              `${key}: all ${outcome.rowsParsed} parsed row(s) were dropped ` +
                "before the database saw them, so NOTHING was written. " +
                `Recording ${PARSE_STATUS.zero} (non-terminal — the next run ` +
                `retries it) rather than ${PARSE_STATUS.done}.`,
            );
          }
          const status =
            verdict.status === "DONE" ? PARSE_STATUS.done : PARSE_STATUS.zero;
          // The MONEY-1169 tripwire asks "could we read these bytes at all",
          // so it keeps counting PARSED rows. `totalRowsAccounted` is the
          // different question — did anything reach the database — and is what
          // the zero-write job outcome reports.
          totalRowsParsed += outcome.rowsParsed;
          totalRowsAccounted += verdict.rowsAccounted;
          await prisma.feedBackfillProgress.upsert({
            where: {
              family_date: { family: parseCheckpointFamily(id), date: d },
            },
            create: {
              family: parseCheckpointFamily(id),
              date: d,
              status,
              bytes: buf.length,
            },
            // `detail: null` clears a previous UNREADABLE refusal text: this is
            // the self-healing path (`--retry-unreadable` after teaching the
            // parser a layout), and a DONE row still carrying "no known variant
            // matched" would send the next reader hunting a live bug that has
            // been fixed.
            update: {
              status,
              bytes: buf.length,
              detail: null,
              at: new Date(),
            },
          });
        }
      } catch (err) {
        unreadable++;
        log.warn(`${key}: ${err instanceof Error ? err.message : err}`);

        // MONEY-1205 — classify, then decide. This catch used to do exactly the
        // two lines above: count a number nothing read, and log a warning into a
        // run that then exited 0. That is the same defect as the `return 0` it
        // was catching, one level up.
        if (err instanceof UnreadableFeedFile) {
          // A verdict about the BYTES. Record it — honestly, as a failure — so
          // the file stops being re-opened nightly and the refusal becomes one
          // indexed query instead of a line in an old log.
          const alreadyKnown = knownUnreadable.has(isoDay(day));
          if (alreadyKnown) totalKnownUnreadable++;
          else totalNewUnreadable++;

          if (!DRY_RUN) {
            const detail = `UNREADABLE ${key}: ${err.message}`.slice(0, 900);
            try {
              await prisma.feedBackfillProgress.upsert({
                where: {
                  family_date: { family: parseCheckpointFamily(id), date: day },
                },
                create: {
                  family: parseCheckpointFamily(id),
                  date: day,
                  status: PARSE_STATUS.unreadable,
                  bytes: buf.length,
                  detail,
                },
                update: {
                  status: PARSE_STATUS.unreadable,
                  bytes: buf.length,
                  detail,
                  at: new Date(),
                },
              });
              log.warn(
                `${key}: recorded ${PARSE_STATUS.unreadable}` +
                  `${alreadyKnown ? " (already known-bad — does not fail the run)" : " (NEW — this run will exit non-zero)"}`,
              );
            } catch (writeErr) {
              // The verdict is what makes tomorrow's run green, so a verdict we
              // FAILED to write must not be treated as written. Counted in both
              // buckets on purpose: both statements are true of this file, and
              // both are fatal, so the exit code is the same either way.
              //
              // Guarded rather than left to propagate because an unguarded throw
              // here would abandon every remaining family over one Mongo hiccup
              // — and the DONE path is already resilient to exactly that (its
              // failures land in this catch as unclassified).
              totalTransientFailures++;
              log.warn(
                `${key}: refused as unreadable, but the ${PARSE_STATUS.unreadable} ` +
                  `checkpoint could NOT be written (${writeErr instanceof Error ? writeErr.message : writeErr}). ` +
                  "The verdict is unrecorded, so this file counts as NEW again " +
                  "on the next run.",
              );
            }
          } else {
            log.warn(
              `${key}: would record ${PARSE_STATUS.unreadable} (dry run — no ` +
                "checkpoint written, and a dry run cannot tell new from known)",
            );
          }
        } else if (err instanceof FeedPrerequisiteUnavailable) {
          // Diagnosed, and transient. Identical TREATMENT to the unclassified
          // branch below — no checkpoint, retried next run, run exits non-zero
          // — but said precisely. "UNCLASSIFIED failure (Error) ... if these
          // bytes are genuinely unreadable, throw UnreadableFeedFile" would
          // send the reader to the parser when the fault is in GCS, and it is
          // deliberately NOT recorded UNREADABLE: that status is skipped on
          // resume, which is the poisoning this ticket removes wearing a
          // different label.
          totalTransientFailures++;
          log.warn(
            `${key}: PREREQUISITE UNAVAILABLE — a join table or input this ` +
              "parse needed could not be loaded. That is a fact about the " +
              "MOMENT, not about the bytes, so the file is NOT checkpointed " +
              `(not even ${PARSE_STATUS.unreadable}), will be retried, and the ` +
              "run exits non-zero.",
          );
        } else {
          // NOT classified, so NOT terminal. A Mongo timeout and a refused
          // layout arrive here as the same `unknown`, and the only safe reading
          // of an unknown is "this might be the moment, not the bytes": no
          // checkpoint (so it retries), and a red run every time until it stops.
          // Marking this terminal is precisely how a blip would become the
          // permanent skip this ticket exists to remove.
          totalTransientFailures++;
          log.warn(
            `${key}: UNCLASSIFIED failure (${err instanceof Error ? err.name : typeof err}) ` +
              "— treated as transient: NOT checkpointed, will be retried, and " +
              "the run will exit non-zero. If these bytes are genuinely " +
              "unreadable, throw UnreadableFeedFile where they are refused.",
          );
        }
      }
      progress.finished++;
      progress.outstanding.delete(key);
    }

    if (spec.kind === "cash") {
      const topDrops = Object.entries(cash.droppedBySeries)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([s, n]) => `${s}=${n}`)
        .join(" ");
      log.info(
        `${id}: parsed ${cash.parsed} rows, wrote ${cash.written}, ` +
          // MONEY-1175: `upgraded` counts cells taken back from a lower-authority
          // source. On the repair run it should be large; on any subsequent run
          // it should be ~0 while `skipped` approaches the row count. A second
          // run that still upgrades thousands of rows means something is writing
          // Yahoo back over the exchange print, which is the regression this
          // counter exists to make impossible to miss.
          `upgraded-from-lower-source ${cash.upgraded}, left-alone ${cash.skipped}, ` +
          `dropped-unresolved ${cash.droppedUnresolved}, no-ISIN ${cash.withoutIsin}` +
          // MONEY-1101: for the BSE legacy families `no-ISIN` is the whole
          // pre-2017 era by construction, so it is only alarming when
          // `isin-from-scrip-master` does NOT track it.
          `${cash.isinFromScripMaster ? `, isin-from-scrip-master ${cash.isinFromScripMaster}` : ""}` +
          `${cash.scripNotInMaster ? `, scrip-not-in-master ${cash.scripNotInMaster}` : ""}` +
          `${cash.unrecognisedFormat ? `, UNRECOGNISED-FORMAT ${cash.unrecognisedFormat}` : ""}` +
          `${cash.dupInFile ? `, DUPLICATE-IN-FILE ${cash.dupInFile}` : ""}` +
          `${cash.droppedUndrawable ? `, DROPPED-UNDRAWABLE ${cash.droppedUndrawable}` : ""}` +
          `${topDrops ? `, series-drops ${topDrops}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "fo") {
      log.info(
        `${id}: parsed ${fo.parsed} contracts, wrote ${fo.written}, ` +
          `skipped ${fo.skipped}` +
          `${fo.retentionSkipped ? `, pre-2018-stock-retention ${fo.retentionSkipped}` : ""}` +
          `${fo.dupInFile ? `, DUPLICATE-IN-FILE ${fo.dupInFile}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "index-close") {
      log.info(
        `${id}: parsed ${idx.parsed} index rows, upserted ${idx.upserted}` +
          `${idx.emptySlug ? `, empty-slug ${idx.emptySlug}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "stock-flags") {
      log.info(
        `${id}: parsed ${flags.parsed} flags, wrote ${flags.written}, ` +
          `skipped ${flags.skipped}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "deals") {
      log.info(
        `${id}: parsed ${deals.parsed} deals, wrote ${deals.written}, ` +
          // dateMismatch here means LAG, not error — rolling snapshots carry
          // earlier sessions' prints. Alarm only when it equals parsed for
          // many consecutive days (the window stopped moving).
          `duplicate ${deals.duplicate}, other-day ${deals.dateMismatch}` +
          `${deals.dropped ? `, DROPPED ${deals.dropped}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "slb") {
      log.info(
        `${id}: parsed ${slb.parsed} positions, upserted ${slb.upserted}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "positioning") {
      log.info(
        `${id}: parsed ${positioning.parsed} rows, upserted ` +
          `${positioning.upserted}` +
          // These four are the ones that mean "we wrote nothing for a file we
          // could read", which is the state most easily mistaken for a holiday.
          `${positioning.unrecognisedFormat ? `, UNRECOGNISED-FORMAT ${positioning.unrecognisedFormat}` : ""}` +
          `${positioning.noDate ? `, NO-TITLE-DATE ${positioning.noDate}` : ""}` +
          `${positioning.noMeasure ? `, NO-MEASURE ${positioning.noMeasure}` : ""}` +
          `${positioning.droppedLegs ? `, dropped-legs ${positioning.droppedLegs}` : ""}` +
          // Lower-case: expected to be small and non-zero. NSE's own totals are
          // off by one contract on some days; that is the exchange's
          // arithmetic, not ours, and it is worth seeing but not alarming on.
          `${positioning.discrepancies ? `, nse-total-mismatch ${positioning.discrepancies}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "fii-stats") {
      log.info(
        `${id}: parsed ${fiiStats.parsed} rows, upserted ` +
          `${fiiStats.upserted}` +
          // Upper-case: each of these means "we wrote nothing for a file we
          // could read" — the state most easily mistaken for a market holiday.
          `${fiiStats.unrecognisedFormat ? `, UNRECOGNISED-FORMAT ${fiiStats.unrecognisedFormat}` : ""}` +
          `${fiiStats.noDate ? `, NO-TITLE-DATE ${fiiStats.noDate}` : ""}` +
          // Upper-case for the same reason: a column whose header we could not
          // match is a column we wrote NOTHING for, on a file we could
          // otherwise read. It reads as "NSE stopped publishing open interest"
          // and is almost always a re-wording on their side or a shear on ours.
          // The stored values are NOT overwritten in that state (writeFiiStats),
          // so this counter is the only notice that the column went dark.
          `${fiiStats.unresolvedColumns ? `, UNRESOLVED-COLUMNS ${fiiStats.unresolvedColumns}` : ""}` +
          `${fiiStats.droppedRows ? `, dropped-rows ${fiiStats.droppedRows}` : ""}` +
          // Lower-case: NSE's segment totals vs its own per-underlying rows. A
          // non-zero here most likely means NSE added an underlying we are not
          // reading, so the published totals now exceed the parts.
          `${fiiStats.discrepancies ? `, nse-total-mismatch ${fiiStats.discrepancies}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "bond-master") {
      log.info(
        `${id}: parsed ${bondMaster.parsed} master rows, upserted ` +
          `${bondMaster.upserted}` +
          // Upper-case: each means "we wrote nothing for a file we could
          // read", the state most easily mistaken for a market holiday.
          `${bondMaster.unrecognisedFormat ? `, UNRECOGNISED-FORMAT ${bondMaster.unrecognisedFormat}` : ""}` +
          `${bondMaster.olderThanStored ? `, OLDER-THAN-STORED ${bondMaster.olderThanStored}` : ""}` +
          // Lower-case: for nse-wdm-list this EQUALS the file count by
          // construction (no date column exists), so it is information. For
          // nse-corporate-bond-report it should be 0 — a non-zero means the
          // `Details report for :- …` banner stopped parsing.
          `${bondMaster.asOfFromKey ? `, asof-from-key ${bondMaster.asOfFromKey}` : ""}` +
          `${bondMaster.duplicateIsin ? `, duplicate-isin ${bondMaster.duplicateIsin}` : ""}` +
          `${bondMaster.noSymbolOrSecType ? `, no-symbol-or-sectype ${bondMaster.noSymbolOrSecType}` : ""}` +
          `${bondMaster.noIsin ? `, no-isin ${bondMaster.noIsin}` : ""}` +
          `${bondMaster.columnCountMismatch ? `, column-count-mismatch ${bondMaster.columnCountMismatch}` : ""}` +
          `${bondMaster.skipped ? `, rows-skipped ${bondMaster.skipped}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "bond-eod") {
      log.info(
        `${id}: parsed ${bondEod.parsed} EOD rows, upserted ` +
          `${bondEod.upserted}` +
          // MONEY-1210 — WDM-only. Both are REFUSALS, not coverage notes: an
          // ambiguous pair would file a real price against a possibly-wrong
          // instrument, and an unmatched security has no ISIN to be written
          // under at all. Silent drops here would read as a quiet session.
          `${bondEod.ambiguousPair ? `, AMBIGUOUS-PAIR ${bondEod.ambiguousPair}` : ""}` +
          `${bondEod.noMasterMatch ? `, NO-MASTER-MATCH ${bondEod.noMasterMatch}` : ""}` +
          `${bondEod.duplicateSymbolIssueDate ? `, dup-symbol-issue ${bondEod.duplicateSymbolIssueDate}` : ""}` +
          `${bondEod.noSymbolOrIssue ? `, no-symbol-or-issue ${bondEod.noSymbolOrIssue}` : ""}` +
          `${bondEod.unrecognisedFormat ? `, UNRECOGNISED-FORMAT ${bondEod.unrecognisedFormat}` : ""}` +
          // The MONEY-1085 counter. PARTIAL is expected and lower-case —
          // cbm_trd prints G-Sec and CP/CD-series ISINs neither master lists.
          // TOTAL is upper-case and means the join itself is broken, which is
          // the reading indistinguishable from "this bond does not trade".
          `${
            bondEod.noMasterRow
              ? bondEod.noMasterRow === bondEod.parsed
                ? `, NO-MASTER-ROW-FOR-ANY-ROW ${bondEod.noMasterRow}`
                : `, no-master-row ${bondEod.noMasterRow}/${bondEod.parsed}`
              : ""
          }` +
          `${bondEod.multiDayFiles ? `, multi-day-files ${bondEod.multiDayFiles}` : ""}` +
          `${bondEod.duplicateIsinDate ? `, duplicate-isin-date ${bondEod.duplicateIsinDate}` : ""}` +
          `${bondEod.noIsin ? `, no-isin ${bondEod.noIsin}` : ""}` +
          `${bondEod.unparseableTradeDate ? `, unparseable-trade-date ${bondEod.unparseableTradeDate}` : ""}` +
          `${bondEod.columnCountMismatch ? `, column-count-mismatch ${bondEod.columnCountMismatch}` : ""}` +
          `${bondEod.skipped ? `, rows-skipped ${bondEod.skipped}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "mwpl") {
      log.info(
        `${id}: parsed ${mwpl.parsed} OI rows, upserted ${mwpl.upserted}` +
          // Upper-case: both mean "we wrote nothing for a file we could read".
          `${mwpl.unrecognisedFormat ? `, UNRECOGNISED-FORMAT ${mwpl.unrecognisedFormat}` : ""}` +
          `${mwpl.noRows ? `, NO-LEGIBLE-ROWS ${mwpl.noRows}` : ""}` +
          // Lower-case: index underlyings are a normal, sizeable slice of the
          // file (9 of 217 in the archived 14-Aug-2026 sample) and are written
          // — they are simply not MWPL-utilisation candidates.
          `${mwpl.indexRows ? `, index-underlyings ${mwpl.indexRows}` : ""}` +
          // Lower-case: rows still land under their OWN date, so a mixed file
          // loses nothing. Worth seeing; not worth alarming on.
          `${mwpl.mixedDate ? `, mixed-date ${mwpl.mixedDate}` : ""}` +
          `${mwpl.fieldCount ? `, field-count ${mwpl.fieldCount}` : ""}` +
          `${mwpl.noSymbol ? `, no-symbol ${mwpl.noSymbol}` : ""}` +
          `${mwpl.badDate ? `, bad-date ${mwpl.badDate}` : ""}` +
          `${mwpl.noOpenInterest ? `, no-open-interest ${mwpl.noOpenInterest}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else if (spec.kind === "nse-delivery") {
      log.info(
        `${id}: parsed ${nseDel.parsed} rows, created ${nseDel.created} ` +
          `full price rows, updated ${nseDel.updated} with delivery, ` +
          `dropped-unresolved ${nseDel.droppedUnresolved}` +
          `${nseDel.dateMismatch ? `, date-mismatch ${nseDel.dateMismatch}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    } else {
      // MONEY-1238 — these two counters used to be printed in lower case and
      // read by nothing else in the process: `unresolvedScrip` reached NO
      // verdict at all, which is how the whole family could write zero rows and
      // still report a clean run. Together they are the family's "never reached
      // the database" total, so when they absorb everything the line says so in
      // upper case, matching the vocabulary the other kinds already use.
      const bseUnaccounted = bseDel.unresolvedScrip + bseDel.noPriceRow;
      const bseAbsorbedAll =
        bseDel.parsed > 0 && bseUnaccounted >= bseDel.parsed;
      log.info(
        `${id}: parsed ${bseDel.parsed} rows, updated ${bseDel.updated}, ` +
          (bseAbsorbedAll
            ? `NOT ONE ROW REACHED THE DATABASE: no-price-row ` +
              `${bseDel.noPriceRow}, UNRESOLVED-SCRIP ${bseDel.unresolvedScrip}` +
              ` — every file is recorded ${PARSE_STATUS.zero}, not ` +
              `${PARSE_STATUS.done}, and will be retried`
            : `no-price-row ${bseDel.noPriceRow} (pre-2024 BSE days wait for ` +
              `P7), unresolved-scrip ${bseDel.unresolvedScrip}`) +
          `${bseDel.dateMismatch ? `, date-mismatch ${bseDel.dateMismatch}` : ""}` +
          `${unreadable ? `, unreadable files ${unreadable}` : ""}`,
      );
    }

    // totalRowsParsed accumulates per-file (fileRows) inside the loop — the
    // per-kind tally ternary this replaced double-counted once five kinds
    // existed and was a sixth-kind bug waiting to happen.
  }

  // MONEY-1205 — partial failure is failure. See `judgeUnreadableFiles` for the
  // predicate and for why "any unreadable file" is the WRONG one.
  //
  // Deliberately placed BEFORE the two tripwires below, both of which `return`.
  // The most likely night for this line to matter is a night when every opened
  // file was one of the known-bad ones and `totalRowsParsed` is therefore 0 —
  // i.e. exactly when the zero-rows tripwire fires and returns early with its
  // "the archive is unreadable, run feed-repair" advice. Setting the exit code
  // first, and printing the breakdown first, means the operator sees which files
  // and which category before reading advice aimed at a different failure.
  const unreadableVerdict = judgeUnreadableFiles({
    newUnreadable: totalNewUnreadable,
    knownUnreadable: totalKnownUnreadable,
    transientFailures: totalTransientFailures,
    undated: totalUndated,
    knownBadSkipped: totalKnownBadSkipped,
    dryRun: DRY_RUN,
  });
  if (unreadableVerdict.message) log.warn(unreadableVerdict.message);
  if (unreadableVerdict.exitNonZero) process.exitCode = 1;

  // MONEY-1238 — emitted HERE, above BOTH tripwires below, because both of them
  // `return`. The nights this metric matters most are precisely the nights one
  // of them fires, and a report placed after them would be missing on exactly
  // those runs while the monitor showed NO DATA — which is what it has shown
  // for this job since the day it was created.
  //
  // The UNITS differ between the two counters and that is deliberate:
  // `selected` counts FILES this run opened, `written` counts ROWS that reached
  // the database. A run that opened 500 files and landed no rows is exactly the
  // "found work, produced nothing" signal the monitor is built on, whereas
  // counting rows on both sides would report `selected: 0` for a run whose
  // every download failed — the broken case reported as an idle one.
  //
  // `written` is `totalRowsAccounted`, never `totalRowsParsed`: parsing a row
  // and dropping it before any query is the whole defect, and reporting it as
  // work done would re-create the silence one layer up.
  if (!DRY_RUN) {
    reportJobOutcome({
      job: "feed-parse",
      selected: totalFilesAttempted,
      written: totalRowsAccounted,
      failed:
        totalTransientFailures +
        totalNewUnreadable +
        totalKnownUnreadable +
        totalUndated,
      skippedReason:
        totalFilesAttempted > 0 && totalRowsAccounted === 0
          ? `${totalFilesAttempted} file(s) opened, ${totalRowsParsed} row(s) ` +
            "parsed, 0 reached the database — read the per-family " +
            "UNRESOLVED / no-price-row / dropped counters above"
          : totalFilesAttempted === 0
            ? `nothing to open: all ${totalFilesSeen} archived file(s) are ` +
              "already checkpointed"
            : undefined,
    });
    // `datadog-metrics` BUFFERS and flushes on a 15s interval. This process is
    // a Cloud Run JOB that exits within moments of this line, so without an
    // explicit flush the three counters die in the buffer and the monitor stays
    // in NO DATA — the exact state this call exists to leave. Never throws (see
    // flushMetrics); a metrics backend having a moment must not fail a run that
    // did its work.
    await flushMetrics();
  }

  // A total of zero files across EVERY family is almost never "nothing to do".
  // `listFiles` returns [] both for an empty prefix and for an auth/network
  // failure, so without this the job would exit 0 announcing success on a
  // credentials problem — the same zero-signal shape this subsystem keeps
  // having to design against.
  if (totalFilesSeen === 0) {
    log.warn(
      "NO archived files found for ANY family. That is either a genuinely " +
        "empty archive (has the backfill walk run?) or a storage failure — " +
        "check the [storage] listFiles error above. NOT treating this as success.",
    );
    process.exitCode = 1;
    return;
  }

  // MONEY-1169 tripwire: files were OPENED and produced zero rows. This exact
  // shape happened in production — thousands of archived files, every one
  // wrapped in a multipart envelope, every parse yielding nothing — and the
  // job exited 0 announcing success. Some files legitimately parse to nothing
  // (a holiday's near-empty CSV), but ALL of them parsing to nothing means the
  // archive is unreadable, not empty.
  //
  // It gates on `totalFilesAttempted`, NOT `totalFilesSeen`. Seen counts every
  // listed object including ones an earlier run already checkpointed, so on a
  // fully caught-up archive — the normal state now that P4.7 runs this nightly
  // — seen is large while nothing is opened and zero rows is the CORRECT
  // outcome. Gating on seen made every quiet night exit 1 with "the archive is
  // unreadable", which is how a real tripwire gets trained into background
  // noise and then ignored on the night it fires for real.
  if (totalFilesAttempted > 0 && totalRowsParsed === 0 && !DRY_RUN) {
    log.warn(
      `${totalFilesAttempted} archived files were opened and NOT ONE produced ` +
        "a single row. The archive is unreadable (corrupt objects? wrong " +
        "format?), not empty — refusing to report success. If objects start " +
        "with a multipart boundary, run the feed-repair job (MONEY-1169).",
    );
    process.exitCode = 1;
    return;
  }

  if (totalFilesAttempted === 0) {
    log.info(
      `Nothing to parse: all ${totalFilesSeen} archived files are already ` +
        "checkpointed. (Expected on a night the archive added nothing.)",
    );
  }

  log.info("Parse complete.");
  progress.reachedEnd = true;
}

/**
 * The silence detector.
 *
 * `beforeExit` fires when the event loop empties WITHOUT an explicit
 * `process.exit()` — precisely the path a never-settling promise takes, and the
 * one that produced an exit code of 0, no error and no summary line. Throwing
 * here is useless; the only lever is the exit code, which is exactly what the
 * caller checks.
 */
process.on("beforeExit", () => {
  const verdict = judgeRunCompletion({
    reachedEnd: progress.reachedEnd,
    planned: progress.planned,
    finished: progress.finished,
    outstanding: [...progress.outstanding],
  });
  if (!verdict.abandoned) return;
  console.error(`[feed-parse] ${verdict.message}`);
  process.exitCode = 1;
});

main()
  .catch((err: unknown) => {
    console.error("[feed-parse] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
