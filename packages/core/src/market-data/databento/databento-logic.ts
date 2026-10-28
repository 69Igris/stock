/**
 * Pure logic for the Databento intraday warehouse — MONEY-1373.
 *
 * Zero I/O by construction: no Prisma, no GCS, no `fetch`, no timers, NO
 * STREAMS. Everything here is arithmetic over plain objects and strings, so its
 * unit test cannot orphan a handle and cannot need a network. The modules that
 * DO perform I/O (`databento-client.ts`, `databento-archive.ts`, the loader)
 * import their decisions from here rather than restating them — the "one rule,
 * stated twice, disagreeing" defect (MONEY-1255) is the most expensive class in
 * this repo's history.
 *
 * The zstd stream helper deliberately lives in `databento-stream.ts` and NOT
 * here. `candle-logic.ts` states the rule this file obeys: `zlib`'s `*Sync`
 * entry points are pure CPU over a Buffer and allocate no handle, "unlike
 * `zlib.createGzip()`, which is a stream and would keep the event loop alive".
 * A transform stream in this file would contradict its sibling one directory
 * over, so the two live apart and this one keeps its claim.
 *
 * ## What this vendor is, in one paragraph
 *
 * Databento is the source of BACKTEST-GRADE intraday truth: consolidated,
 * TRADE-derived bars carrying real volume. Tiingo remains the source of
 * everything users watch. The two are not interchangeable and must never be
 * mixed inside one session — see `databento-day-authority.ts` for the rule and
 * `tiingo-rt-sink-logic.ts` for the generic guard it defers to.
 *
 * Every constant and every parse below was verified on 2026-09-06 against
 * Databento's own client sources (`databento/databento-python`,
 * `databento/dbn`, `databento/databento-rs`) and, for the CSV shapes, by
 * DECODING their checked-in test data. Where the published docs and the
 * measurement disagree, the measurement is what this file implements and the
 * disagreement is called out — the MONEY-980 discipline, which is in this file
 * because that ticket's finding 1 was exactly a documented CSV column order
 * that the live feed did not use.
 */

import { splitCsvLine } from "../csv-line";
import { US_HOLIDAY_TABLE_YEARS, isUsTradingDay } from "../us-market-hours";

/* ─────────────────────────────────────────────────────────────────────────
   Endpoints, datasets, schemas
   ──────────────────────────────────────────────────────────────────────── */

/** The historical API gateway. Every metadata/batch/symbology call goes here. */
export const DATABENTO_HIST_BASE = "https://hist.databento.com/v0";

/**
 * Where batch FILES are served from — a DIFFERENT host from the API gateway.
 *
 * `batch.list_files` returns `urls.https` pointing at
 * `https://api.databento.com/v0/batch/download/{user_id}/{job_id}/{filename}`.
 * Both hosts are therefore in `FEED_HOSTS` (the guard in
 * `no-feed-fetch-bypass.test.ts`), and listing only the gateway would leave the
 * host that moves the actual gigabytes unguarded.
 */
export const DATABENTO_DOWNLOAD_HOST = "api.databento.com";

/**
 * The `Candle.source` stamp. Ranked in `price-source-authority.ts`.
 *
 * A NAMED CONSTANT rather than a literal at each write site: `source` is the
 * field the whole displacement rule turns on, and a second spelling of it is a
 * session that silently holds two sources.
 */
export const DATABENTO_SOURCE = "DATABENTO";

/** The consolidated US equities dataset we buy. */
export const DEFAULT_DATABENTO_DATASET = "EQUS.MINI";

/**
 * The first date EQUS.MINI carries — MEASURED, not assumed.
 *
 * Databento's own launch post says "Historical Databento US Equities Mini data
 * starts from March 28, 2023". The plan this implements originally said "8
 * years of OHLCV"; that is true of the PLAN TIER's included window and false of
 * THIS DATASET, and the two are easy to conflate. Anything earlier has to come
 * from a different dataset (EQUS.ALL is the only credible consolidated
 * candidate) and that is an open question the probe settles — never a guess.
 */
export const EQUS_MINI_HISTORY_FLOOR = "2023-03-28";

/** Schemas this repo knows how to ask for. `ohlcv-1d` is deliberately absent. */
export const DATABENTO_SCHEMAS = [
  "ohlcv-1s",
  "ohlcv-1m",
  "ohlcv-1h",
  "bbo-1m",
  "tbbo",
  "definition",
  "statistics",
] as const;
export type DatabentoSchema = (typeof DATABENTO_SCHEMAS)[number];

/**
 * Schema → this repo's timeframe literal.
 *
 * `M1` / `H1` / `S1`, never `"1m"`. The repo's only timeframe values are `D1`
 * (the Tiingo EOD backbone) and `M1` (the Tiingo realtime sink), and the Prisma
 * `Candle.timeframe` comment reserves exactly `M1 | M5 | M15 | H1 | W1`. A
 * vendor-shaped literal here would key cold shards under
 * `candles/US/1m/{symbol}/{year}` — a second naming scheme for one concept,
 * invisible until a reader asks why AAPL has two shard trees.
 */
export const SCHEMA_TIMEFRAME: Readonly<
  Partial<Record<DatabentoSchema, string>>
> = {
  "ohlcv-1s": "S1",
  "ohlcv-1m": "M1",
  "ohlcv-1h": "H1",
};

/**
 * Schemas whose rows become `Candle` rows.
 *
 * `ohlcv-1s` is EXCLUDED by founder decision (2026-09-06): 8 years of
 * second bars for the S&P baseline is TB-scale, and loading it is weeks of
 * writes for a series no strategy reads yet. It is still HARVESTED — the bytes
 * are unpurchasable later at the included price — and archived raw. Loading it
 * is a later ticket, and the only thing standing between here and there is a
 * one-line change to this array plus a sizing decision.
 *
 * `bbo-1m` and `tbbo` are quote/trade records, not bars; they feed the cost
 * model from the archive and never reach `candles`.
 */
export const LOADABLE_SCHEMAS: readonly DatabentoSchema[] = [
  "ohlcv-1m",
  "ohlcv-1h",
];

export function isLoadableSchema(schema: string): schema is DatabentoSchema {
  return (LOADABLE_SCHEMAS as readonly string[]).includes(schema);
}

/**
 * Symbols per request. Databento's own limit, stated identically in the SDK
 * docstrings and the HTTP reference: "Takes up to 2,000 symbols per request."
 */
export const DATABENTO_MAX_SYMBOLS_PER_REQUEST = 2000;

/** `ALL_SYMBOLS` selects a whole dataset. Cannot be combined with `split_symbols`. */
export const DATABENTO_ALL_SYMBOLS = "ALL_SYMBOLS";

/* ─────────────────────────────────────────────────────────────────────────
   Symbol notation
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Our master and this vendor spell share classes DIFFERENTLY, and the mapping
 * is PROVISIONAL.
 *
 * Databento documents two competing conventions and says `raw_symbol` returns
 * whatever the source publishes. EQUS.MINI follows NASDAQ: Berkshire class B is
 * `BRK.B`. Our `us_instruments` rows carry Tiingo's dash form: `BRK-B`,
 * `SPG-P-J`. So a single trailing class letter flips between `-` and `.` and
 * NOTHING ELSE IS TOUCHED.
 *
 * Preferreds, warrants and units are NOT covered by that rule and pass through
 * unchanged, which means they will fail to resolve and land in the symbology
 * QUARANTINE. That is the intended outcome: a quarantine row is a counted,
 * visible "we do not know", while a guessed transformation is a bar filed under
 * another security. The probe (`scripts/data/databento-probe.ts`) resolves the
 * whole baseline through `symbology.resolve` and its `not_found` list is the
 * evidence that finishes this table.
 */
const CLASS_SUFFIX_OURS = /^([A-Z0-9]+)-([A-Z])$/;
const CLASS_SUFFIX_THEIRS = /^([A-Z0-9]+)\.([A-Z])$/;

/** Our notation → Databento's. */
export function toDatabentoSymbol(ourSymbol: string): string {
  const s = ourSymbol.trim().toUpperCase();
  const m = CLASS_SUFFIX_OURS.exec(s);
  return m ? `${m[1]}.${m[2]}` : s;
}

/** Databento's notation → ours. */
export function fromDatabentoSymbol(rawSymbol: string): string {
  const s = rawSymbol.trim().toUpperCase();
  const m = CLASS_SUFFIX_THEIRS.exec(s);
  return m ? `${m[1]}-${m[2]}` : s;
}

/* ─────────────────────────────────────────────────────────────────────────
   Request building
   ──────────────────────────────────────────────────────────────────────── */

export interface DatabentoJobRequest {
  dataset: string;
  /** OUR notation. Converted to the vendor's here and ONLY here. */
  symbols: readonly string[] | typeof DATABENTO_ALL_SYMBOLS;
  schema: DatabentoSchema;
  /** Inclusive lower bound. */
  start: Date;
  /** EXCLUSIVE upper bound — Databento's own convention. */
  end: Date;
  /**
   * REQUIRED, both of them, and that is the fix for MONEY-1375.
   *
   * They were optional with `?? "day"` / `=== true` fallbacks, so a caller that
   * simply forgot them got `split_symbols=false, split_duration=day` and no
   * error. `ohlcv-1m-baseline` was bought that way — the vendor confirmed
   * receiving exactly that against a manifest saying `true`/`"year"` — and the
   * daily files made the loader flush 439,569 cold shards instead of 2,028:
   * 92 s for the first file rising to 358 s by file 124, an extrapolated 78 h
   * against a 24 h task cap. The ledger cannot tell the two shapes apart (the
   * split shape is not in its unique key), so the only remedy was a hand
   * delete and a re-buy. A required field turns that into a compile error.
   */
  splitSymbols: boolean;
  splitDuration: "day" | "week" | "month" | "year" | "none";
  /** Bytes. Databento accepts 1e9..10e9 inclusive. */
  splitSize?: number;
  limit?: number;
}

/**
 * ISO 8601 UTC, second precision, `Z`-suffixed.
 *
 * One renderer for the quote and the submission, because a quote that
 * described a different window from the job it authorised would be a budget
 * guard measuring the wrong thing — and it would look perfectly healthy.
 */
export function toDatabentoInstant(at: Date): string {
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError("toDatabentoInstant: received an Invalid Date");
  }
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The symbols parameter, as the wire wants it. Throws rather than truncating. */
export function renderSymbolsParam(
  symbols: DatabentoJobRequest["symbols"],
): string {
  if (symbols === DATABENTO_ALL_SYMBOLS) return DATABENTO_ALL_SYMBOLS;
  if (symbols.length === 0) {
    throw new RangeError("renderSymbolsParam: refusing an empty symbol list");
  }
  if (symbols.length > DATABENTO_MAX_SYMBOLS_PER_REQUEST) {
    throw new RangeError(
      `renderSymbolsParam: ${symbols.length} symbols exceeds Databento's ` +
        `${DATABENTO_MAX_SYMBOLS_PER_REQUEST} per request. Chunk the list — ` +
        "truncating here would silently buy a narrower window than the " +
        "manifest asked for, and the coverage report would blame the vendor.",
    );
  }
  return symbols.map(toDatabentoSymbol).join(",");
}

/**
 * The `batch.submit_job` form body.
 *
 * ## Why CSV + zstd and not DBN
 *
 * Billing is on UNCOMPRESSED BINARY size regardless of the encoding asked for,
 * and CSV is transcoded server-side at no extra cost. So DBN buys nothing here
 * and costs a binary decoder in TypeScript that would have to track the
 * vendor's record-layout versions. zstd keeps the transfer small; Node 22's
 * `zlib.createZstdDecompress` decodes it from the standard library.
 *
 * ## The three "pretty" flags are load-bearing, not cosmetic
 *
 *   pretty_px    prices as decimals instead of 1e-9 fixed-point integers, and
 *                — measured — an UNDEF price renders as an EMPTY FIELD rather
 *                than the sentinel 9223372036854775807. A parser that met that
 *                sentinel as a number would store a price of 9.2e18.
 *   pretty_ts    ISO 8601 with nanoseconds and `Z` instead of epoch-nanos.
 *   map_symbols  appends a `symbol` column to every row. Without it the rows
 *                carry only `instrument_id` and we would have to join through
 *                the symbology support file — which, since 2026-02-17, the
 *                vendor no longer generates WHEN map_symbols is on. Asking for
 *                the column is what makes that change a non-event.
 */
export function buildSubmitJobForm(req: DatabentoJobRequest): URLSearchParams {
  if (req.splitSymbols && req.symbols === DATABENTO_ALL_SYMBOLS) {
    throw new RangeError(
      "buildSubmitJobForm: split_symbols cannot be combined with ALL_SYMBOLS " +
        "(Databento refuses it). Name the symbols explicitly.",
    );
  }
  if (req.splitSize !== undefined) {
    if (
      !Number.isFinite(req.splitSize) ||
      req.splitSize < 1e9 ||
      req.splitSize > 10e9
    ) {
      throw new RangeError(
        `buildSubmitJobForm: split_size ${req.splitSize} is outside ` +
          "Databento's documented 1e9..10e9 byte range.",
      );
    }
  }
  if (req.end.getTime() <= req.start.getTime()) {
    throw new RangeError(
      "buildSubmitJobForm: end must be strictly after start (end is EXCLUSIVE).",
    );
  }

  const form = new URLSearchParams({
    dataset: req.dataset,
    symbols: renderSymbolsParam(req.symbols),
    schema: req.schema,
    start: toDatabentoInstant(req.start),
    end: toDatabentoInstant(req.end),
    encoding: "csv",
    compression: "zstd",
    pretty_px: "true",
    pretty_ts: "true",
    map_symbols: "true",
    stype_in: "raw_symbol",
    stype_out: "instrument_id",
    delivery: "download",
    // NO FALLBACK on either. Both fields are required on the request, so an
    // omission is a compile error rather than a silently different purchase.
    split_symbols: req.splitSymbols ? "true" : "false",
    split_duration: req.splitDuration,
  });
  if (req.splitSize !== undefined)
    form.set("split_size", String(req.splitSize));
  if (req.limit !== undefined) form.set("limit", String(req.limit));
  return form;
}

/**
 * The `metadata.get_cost` FORM BODY. Same window rendering as the submission.
 *
 * Sent as a POST body, not a query string — the vendor 414s above ~8 KB of URL
 * and a 2,000-symbol chunk is ~14 KB. Kept as `URLSearchParams` because that is
 * what `request()` serialises as `application/x-www-form-urlencoded`, and
 * because the name still describes what it is: the query, by value.
 */
export function buildCostQuery(req: DatabentoJobRequest): URLSearchParams {
  return new URLSearchParams({
    dataset: req.dataset,
    symbols: renderSymbolsParam(req.symbols),
    schema: req.schema,
    start: toDatabentoInstant(req.start),
    end: toDatabentoInstant(req.end),
    stype_in: "raw_symbol",
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Response parsing
   ──────────────────────────────────────────────────────────────────────── */

export type DatabentoJobState =
  | "received"
  | "queued"
  | "processing"
  | "done"
  | "expired";

export interface DatabentoJob {
  id: string;
  dataset: string;
  schema: string;
  symbols: string;
  start: string;
  end: string;
  state: DatabentoJobState | string;
  tsReceived: string | null;
  /** NULL until the job is processed. See the note on {@link parseJobResponse}. */
  costUsd: number | null;
  recordCount: number | null;
  billedSize: number | null;
  actualSize: number | null;
  packageSize: number | null;
  tsExpiration: string | null;
  progress: number | null;
}

const asString = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;
const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * A `batch.submit_job` / `batch.get_job_details` payload.
 *
 * ## `cost_usd` IS NULL AT SUBMISSION, and the whole budget design turns on it
 *
 * Verified against the vendor's own typed client: `cost_usd` is
 * `Option<f64>` documented "Will be `None` until the job is processed", and
 * their published quickstart capture shows `'cost_usd': None` on a freshly
 * queued job. So the spend a guard must check BEFORE authorising a submission
 * cannot come from the submission's own response — it comes from
 * `metadata.get_cost`, and the ledger stores that quote until the real figure
 * arrives. A guard that read `cost_usd` here would compare against `null` on
 * every call and authorise everything.
 *
 * `bill_id` was REMOVED from this payload by the vendor in 2025-08 and
 * `packaging` is deprecated; both are simply not read. Only `id` is required —
 * a response without one is not a job.
 */
export function parseJobResponse(json: unknown): DatabentoJob {
  if (typeof json !== "object" || json === null) {
    throw new TypeError("parseJobResponse: expected an object");
  }
  const o = json as Record<string, unknown>;
  const id = asString(o["id"]);
  if (id === null) {
    throw new TypeError(
      "parseJobResponse: the response carries no `id`, so there is no job to " +
        "record. Refusing rather than storing a row nothing can poll.",
    );
  }
  return {
    id,
    dataset: asString(o["dataset"]) ?? "",
    schema: asString(o["schema"]) ?? "",
    symbols: asString(o["symbols"]) ?? "",
    start: asString(o["start"]) ?? "",
    end: asString(o["end"]) ?? "",
    state: asString(o["state"]) ?? "received",
    tsReceived: asString(o["ts_received"]),
    costUsd: asNumber(o["cost_usd"]),
    recordCount: asNumber(o["record_count"]),
    billedSize: asNumber(o["billed_size"]),
    actualSize: asNumber(o["actual_size"]),
    packageSize: asNumber(o["package_size"]),
    tsExpiration: asString(o["ts_expiration"]),
    progress: asNumber(o["progress"]),
  };
}

export interface DatabentoJobSummary {
  id: string;
  state: DatabentoJobState | string;
  tsReceived: string | null;
}

/**
 * A `batch.list_jobs` row.
 *
 * SUMMARY ONLY since the vendor's 2026-08 change: "batch.list_jobs will return
 * a summary of each job containing only `id`, `state`, and `ts_received`. A new
 * `batch.get_job_details` endpoint will provide the full details." So the poll
 * loop watches state here and fetches the rest per job — writing this parser to
 * expect the full payload would work today only for whatever the transition
 * still echoes, and would go quietly empty when it stops.
 */
export function parseJobSummary(json: unknown): DatabentoJobSummary {
  if (typeof json !== "object" || json === null) {
    throw new TypeError("parseJobSummary: expected an object");
  }
  const o = json as Record<string, unknown>;
  const id = asString(o["id"]);
  if (id === null) throw new TypeError("parseJobSummary: no `id`");
  return {
    id,
    state: asString(o["state"]) ?? "received",
    tsReceived: asString(o["ts_received"]),
  };
}

export interface DatabentoFile {
  filename: string;
  size: number;
  /** Lower-case hex, algorithm stripped. */
  sha256: string;
  httpsUrl: string;
}

/**
 * A `batch.list_files` row: `{filename, size, hash, urls: {https, ftp}}`.
 *
 * The `hash` is `"sha256:<hex>"`. Anything else THROWS rather than being
 * skipped: the vendor's own client downgrades an unrecognised algorithm to a
 * warning and a mismatch to a warning, and both are wrong for us. These files
 * are the only copy of data bought once, and a truncated download that nothing
 * rejects becomes a coverage gap attributed to the exchange.
 */
export function parseListFiles(json: unknown): DatabentoFile[] {
  if (!Array.isArray(json)) {
    throw new TypeError("parseListFiles: expected an array");
  }
  return json.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError(`parseListFiles: entry ${i} is not an object`);
    }
    const o = entry as Record<string, unknown>;
    const filename = asString(o["filename"]);
    const size = asNumber(o["size"]);
    const hash = asString(o["hash"]);
    const urls = o["urls"];
    if (filename === null || size === null || hash === null) {
      throw new TypeError(
        `parseListFiles: entry ${i} is missing filename/size/hash`,
      );
    }
    if (!hash.startsWith("sha256:")) {
      throw new TypeError(
        `parseListFiles: ${filename} carries hash "${hash}", not a sha256. ` +
          "Refusing: an unverifiable download of data we bought once is worse " +
          "than a failed one, because nothing downstream can tell.",
      );
    }
    const httpsUrl =
      typeof urls === "object" && urls !== null
        ? asString((urls as Record<string, unknown>)["https"])
        : null;
    if (httpsUrl === null) {
      throw new TypeError(
        `parseListFiles: ${filename} has no urls.https — "download" delivery ` +
          "is not available for this job.",
      );
    }
    return { filename, size, sha256: hash.slice("sha256:".length), httpsUrl };
  });
}

/** The support files a batch package carries beside the data. */
export const DATABENTO_SUPPORT_FILES: readonly string[] = [
  "manifest.json",
  "metadata.json",
  "condition.json",
  "symbology.json",
  "symbology.csv",
];

/**
 * Is this a data file or one of the package's support files?
 *
 * Both are ARCHIVED. `condition.json` records the vendor's own per-date
 * dataset condition and `metadata.json` echoes the request, which together are
 * what lets a future reader tell "the session is missing from our load" from
 * "the vendor published nothing that day" — a distinction the coverage report
 * cannot make on its own.
 *
 * Note there is NO symbology file when `map_symbols=true` (vendor change,
 * 2026-02-17). It stays in the list because a job submitted with the flag off
 * would produce one, and a classifier that called it "data" would hand a JSON
 * document to the CSV loader.
 */
export function classifyFile(filename: string): "data" | "support" {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  if (DATABENTO_SUPPORT_FILES.includes(base)) return "support";
  return base.endsWith(".csv.zst") || base.endsWith(".csv")
    ? "data"
    : "support";
}

export interface DatabentoDatasetRange {
  /** Inclusive. */
  start: Date;
  /** EXCLUSIVE. */
  end: Date;
  bySchema: Record<string, { start: Date; end: Date }>;
}

/**
 * `metadata.get_dataset_range` — the AVAILABILITY gate for the daily append.
 *
 * The payload carries a top-level `start`/`end` AND a per-schema map under
 * `schema`. Both matter: the append asks for a session, and whether that
 * session EXISTS yet is a per-schema question under the vendor's T+1 embargo.
 *
 * `end` is EXCLUSIVE — stated verbatim in the vendor's typed client ("The
 * exclusive UTC end timestamp of the available range"). An append that treated
 * it as inclusive would request one session past what exists and read the empty
 * result as a data gap.
 *
 * The deprecated `start_date`/`end_date` keys are deliberately not read.
 */
export function parseDatasetRange(json: unknown): DatabentoDatasetRange {
  if (typeof json !== "object" || json === null) {
    throw new TypeError("parseDatasetRange: expected an object");
  }
  const o = json as Record<string, unknown>;
  const asDate = (v: unknown, what: string): Date => {
    const s = asString(v);
    const ms = s === null ? NaN : Date.parse(s);
    if (!Number.isFinite(ms)) {
      throw new TypeError(`parseDatasetRange: ${what} is not a timestamp`);
    }
    return new Date(ms);
  };
  const bySchema: DatabentoDatasetRange["bySchema"] = {};
  const raw = o["schema"];
  if (typeof raw === "object" && raw !== null) {
    for (const [schema, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const r = v as Record<string, unknown>;
      bySchema[schema] = {
        start: asDate(r["start"], `schema.${schema}.start`),
        end: asDate(r["end"], `schema.${schema}.end`),
      };
    }
  }
  return {
    start: asDate(o["start"], "start"),
    end: asDate(o["end"], "end"),
    bySchema,
  };
}

export interface DatabentoSymbologyResult {
  /** vendor symbol → date-ranged mappings (`d0` inclusive, `d1` exclusive). */
  result: Map<string, Array<{ d0: string; d1: string; s: string }>>;
  partial: string[];
  notFound: string[];
}

/**
 * `symbology.resolve`.
 *
 * Read for EVIDENCE, never for identity. Our key is `listingId`, resolved from
 * `us_instruments`' own occupancy windows; the vendor's `instrument_id` is
 * theirs and means nothing across a ticker recycle. What this call is for is
 * the `not_found` list, which is the measurement that finishes the notation
 * table above.
 */
export function parseSymbologyResult(json: unknown): DatabentoSymbologyResult {
  if (typeof json !== "object" || json === null) {
    throw new TypeError("parseSymbologyResult: expected an object");
  }
  const o = json as Record<string, unknown>;
  const result = new Map<
    string,
    Array<{ d0: string; d1: string; s: string }>
  >();
  const raw = o["result"];
  if (typeof raw === "object" && raw !== null) {
    for (const [sym, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const rows: Array<{ d0: string; d1: string; s: string }> = [];
      for (const e of v) {
        if (typeof e !== "object" || e === null) continue;
        const r = e as Record<string, unknown>;
        const d0 = asString(r["d0"]);
        const d1 = asString(r["d1"]);
        const s = asString(r["s"]);
        if (d0 !== null && d1 !== null && s !== null) rows.push({ d0, d1, s });
      }
      result.set(sym, rows);
    }
  }
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    result,
    partial: strList(o["partial"]),
    notFound: strList(o["not_found"]),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   HTTP classification
   ──────────────────────────────────────────────────────────────────────── */

export type DatabentoFailureKind =
  | "auth"
  | "rate-limit"
  | "bad-request"
  | "upstream";

export interface DatabentoFailure {
  kind: DatabentoFailureKind;
  /** Seconds to wait. Only meaningful for `rate-limit`. */
  retryAfterS: number;
  detail: string;
}

/**
 * What a non-2xx means, and how long to wait.
 *
 * `Retry-After` is documented and honoured by the vendor's own client, WITH A
 * ONE-SECOND DEFAULT when the header is absent — copied here rather than
 * invented, because the alternative (no wait) turns a rate limit into a tight
 * loop against a paid API. Capped at 120s so a pathological header cannot park
 * a job for the rest of its task timeout.
 *
 * Limits are PER IP, not per key. Cloud Run shares egress addresses, which is
 * why the client paces submissions well under the documented 20/minute rather
 * than racing to it.
 */
export function classifyDatabentoHttp(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): DatabentoFailure {
  const detail = bodyText.trim().slice(0, 500);
  if (status === 429) {
    const parsed = Number.parseInt(retryAfterHeader ?? "", 10);
    const retryAfterS =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 1;
    return { kind: "rate-limit", retryAfterS, detail };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", retryAfterS: 0, detail };
  }
  if (status >= 400 && status < 500) {
    return { kind: "bad-request", retryAfterS: 0, detail };
  }
  return { kind: "upstream", retryAfterS: 0, detail };
}

/* ─────────────────────────────────────────────────────────────────────────
   CSV — parsed by column NAME, never by position
   ──────────────────────────────────────────────────────────────────────── */

/**
 * MONEY-980 finding 1, restated because it is the same vendor class of bug:
 * Tiingo's documented EOD column order is `date,open,...` and the live header
 * is `date,close,high,low,open,...`. A positional parser written from the docs
 * swapped open and close on every US security — no error, correct row count,
 * wrong candle. Databento's OHLCV header was VERIFIED by decoding their own
 * checked-in test data, and it is still read by name, because a verified order
 * is a measurement of one day and a name is a contract.
 */
export interface OhlcvColumns {
  tsEvent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  symbol: number;
}

const REQUIRED_OHLCV = [
  "ts_event",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "symbol",
] as const;

export function parseOhlcvHeader(line: string): OhlcvColumns {
  const idx = new Map(
    splitCsvLine(line).map((h, i) => [h.trim().toLowerCase(), i] as const),
  );
  const missing = REQUIRED_OHLCV.filter((c) => !idx.has(c));
  if (missing.length > 0) {
    throw new TypeError(
      `parseOhlcvHeader: missing column(s) ${missing.join(", ")}. ` +
        `Header was: ${line.slice(0, 200)}. ` +
        "A `symbol` column requires map_symbols=true on the job — without it " +
        "rows carry only instrument_id and cannot be mapped to a listing.",
    );
  }
  return {
    tsEvent: idx.get("ts_event")!,
    open: idx.get("open")!,
    high: idx.get("high")!,
    low: idx.get("low")!,
    close: idx.get("close")!,
    volume: idx.get("volume")!,
    symbol: idx.get("symbol")!,
  };
}

/**
 * An ISO-8601 timestamp with NANOSECOND precision → epoch ms.
 *
 * `pretty_ts` renders `2020-12-28T13:00:00.000000000Z` — nine fractional
 * digits. `Date.parse` is only specified for three, so the fraction is
 * TRUNCATED explicitly here rather than trusted to an engine's tolerance. Sub-
 * millisecond precision is meaningless for M1/H1 bars; the S1 archive keeps the
 * original strings and is not loaded.
 *
 * An EMPTY field is a real value: `pretty_ts` renders both `0` and the
 * undefined-timestamp sentinel as `""` (measured in the vendor's CSV
 * serializer). It returns null, and the caller counts the row.
 */
export function parseNanoTimestamp(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const dot = s.indexOf(".");
  const normalized =
    dot === -1 ? s : `${s.slice(0, dot + 4)}${s.endsWith("Z") ? "Z" : ""}`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export interface OhlcvRow {
  symbol: string;
  /** Bar OPEN. Databento timestamps a bar at the START of its interval. */
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Why a row was dropped. Every reason is counted; none is silent. */
export type OhlcvRejection = "fields" | "timestamp" | "price" | "symbol";

/**
 * One OHLCV data line.
 *
 * `ts_event` is the bar's OPEN — the START of the aggregation interval. Worth
 * stating because a widely-used downstream library re-stamps these bars to the
 * interval CLOSE by default, and a series shifted by one interval reconciles
 * against nothing.
 *
 * An empty price field is the UNDEF sentinel under `pretty_px` (measured: the
 * vendor's serializer writes `""` rather than the raw 9223372036854775807).
 * Such a row is REJECTED, not defaulted — a bar with no price is not a bar, and
 * a zero would render as a real crash in every chart.
 */
/**
 * Finite AND positive — the same test `parseBboRow` applies to bid/ask.
 *
 * A NAMED function, and four explicit calls rather than
 * `[open, high, low, close].every(v => ...)`, because this runs once per BAR:
 * a 503-symbol year is ~50 million rows, and both the array literal and the
 * arrow closure would be allocated on every one of them. The loader's heap
 * spawntest caught exactly that — the scaling ratio went from ~1.05x to 1.59x
 * and tripped its 1.5 ceiling — which is what that test exists to notice.
 */
function isUsablePrice(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

export function parseOhlcvRow(
  line: string,
  cols: OhlcvColumns,
  /**
   * Pre-split cells, when the caller already paid for the scan — the same
   * affordance `parseBboRow` has, added for the lake loader (MONEY-1505),
   * which reads two columns this function does not return. Without it a
   * 151.5M-row replay runs the RFC-4180 scan twice per bar.
   */
  preSplit?: readonly string[],
): OhlcvRow | { rejected: OhlcvRejection } {
  const cells = preSplit ?? splitCsvLine(line);
  const at = (i: number): string => (cells[i] ?? "").trim();
  if (cells.length <= cols.symbol) return { rejected: "fields" };

  const symbol = at(cols.symbol);
  if (symbol === "") return { rejected: "symbol" };

  const tsMs = parseNanoTimestamp(at(cols.tsEvent));
  if (tsMs === null) return { rejected: "timestamp" };

  const num = (i: number): number => {
    const raw = at(i);
    return raw === "" ? NaN : Number(raw);
  };
  const open = num(cols.open);
  const high = num(cols.high);
  const low = num(cols.low);
  const close = num(cols.close);
  // FINITE **AND POSITIVE**, the same test `parseBboRow` applies to bid/ask one
  // function down. Finiteness alone let a literal `0` or a negative through —
  // and this function's own comment says a zero "would render as a real crash
  // in every chart" while guarding only the EMPTY case. A `high < low` row is
  // refused too: it cannot be a real bar and it would silently widen any range
  // computed from the series.
  if (
    !isUsablePrice(open) ||
    !isUsablePrice(high) ||
    !isUsablePrice(low) ||
    !isUsablePrice(close) ||
    high < low
  ) {
    return { rejected: "price" };
  }
  const volRaw = num(cols.volume);

  return {
    symbol,
    tsMs,
    open,
    high,
    low,
    close,
    // A missing volume is 0 — for a TRADE-derived feed that genuinely means no
    // shares traded in the interval, unlike the realtime sink's structural
    // zero. The distinction lives in `source`, which is why these bars carry
    // their own stamp.
    volume: Number.isFinite(volRaw) ? volRaw : 0,
  };
}

export interface BboColumns {
  tsRecv: number;
  symbol: number;
  bidPx: number;
  askPx: number;
  bidSz: number;
  askSz: number;
}

const REQUIRED_BBO = ["ts_recv", "symbol", "bid_px_00", "ask_px_00"] as const;

/** Column name -> position, lower-cased. BY NAME is the whole point. */
function headerIndex(line: string): Map<string, number> {
  return new Map(
    splitCsvLine(line).map((h, i) => [h.trim().toLowerCase(), i] as const),
  );
}

function requireColumns(
  fn: string,
  idx: Map<string, number>,
  required: readonly string[],
  line: string,
): void {
  const missing = required.filter((c) => !idx.has(c));
  if (missing.length > 0) {
    throw new TypeError(
      `${fn}: missing column(s) ${missing.join(", ")}. ` +
        `Header was: ${line.slice(0, 200)}`,
    );
  }
}

/**
 * The subsampled-BBO header.
 *
 * `ts_recv` is the END of the interval on this schema, not the start —
 * the opposite of OHLCV's `ts_event`. The cost model buckets by time of day, so
 * getting that backwards would mis-bucket every quote at a bucket boundary.
 */
export function parseBboHeader(line: string): BboColumns {
  const idx = headerIndex(line);
  requireColumns("parseBboHeader", idx, REQUIRED_BBO, line);
  return {
    tsRecv: idx.get("ts_recv")!,
    symbol: idx.get("symbol")!,
    bidPx: idx.get("bid_px_00")!,
    askPx: idx.get("ask_px_00")!,
    bidSz: idx.get("bid_sz_00") ?? -1,
    askSz: idx.get("ask_sz_00") ?? -1,
  };
}

export interface BboRow {
  symbol: string;
  /** Interval END. */
  tsMs: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
}

export type BboRejection =
  | "fields"
  | "timestamp"
  | "price"
  | "crossed"
  | "symbol";

/**
 * One BBO record.
 *
 * A crossed or locked book (`ask <= bid`) is REJECTED rather than clamped: it
 * yields a zero or negative spread, and a spread model built over those reports
 * a cost of zero for exactly the moments execution is hardest.
 */
export function parseBboRow(
  line: string,
  cols: BboColumns,
  /** Pre-split cells, when the caller already paid for the scan. */
  preSplit?: readonly string[],
): BboRow | { rejected: BboRejection } {
  const cells = preSplit ?? splitCsvLine(line);
  const at = (i: number): string => (i >= 0 ? (cells[i] ?? "").trim() : "");
  if (cells.length <= Math.max(cols.symbol, cols.bidPx, cols.askPx)) {
    return { rejected: "fields" };
  }
  const symbol = at(cols.symbol);
  if (symbol === "") return { rejected: "symbol" };
  const tsMs = parseNanoTimestamp(at(cols.tsRecv));
  if (tsMs === null) return { rejected: "timestamp" };

  const num = (i: number): number => {
    const raw = at(i);
    return raw === "" ? NaN : Number(raw);
  };
  const bid = num(cols.bidPx);
  const ask = num(cols.askPx);
  // An empty price here is the UNDEF sentinel — no quote on that side.
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return { rejected: "price" };
  }
  if (ask <= bid) return { rejected: "crossed" };

  const bidSize = num(cols.bidSz);
  const askSize = num(cols.askSz);
  return {
    symbol,
    tsMs,
    bid,
    ask,
    bidSize: Number.isFinite(bidSize) ? bidSize : 0,
    askSize: Number.isFinite(askSize) ? askSize : 0,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   TBBO — the trade, with the quote that stood in front of it
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The `tbbo` header, which is the `bbo-1m` header plus a trade.
 *
 * VERIFIED against Databento's own DBN crate on 2026-09-07: `record.rs` types
 * `Mbp1Msg = TBBOMsg`, and `encode/csv/serialize.rs` emits
 * `ts_recv, ts_event, rtype, publisher_id, instrument_id, action, side, depth,
 * price, size, flags, ts_in_delta, sequence, bid_px_00, ask_px_00, bid_sz_00,
 * ask_sz_00, bid_ct_00, ask_ct_00, symbol`. Every column
 * {@link parseBboHeader} requires is already there, which is why this leg is
 * ~250 lines rather than a second parser.
 *
 * WHAT THE ROW MEANS: the book as it stood IMMEDIATELY BEFORE the trade
 * printed. That is exactly the counterfactual an effective spread wants — the
 * price a resting order would have got — and it is why the trade and the quote
 * have to arrive together rather than be joined after the fact.
 *
 * `price` is REQUIRED. Without it there is no trade, and a tbbo file with no
 * price column is a `bbo` file under the wrong key — worth a TypeError naming
 * the column rather than a fold that silently samples nothing.
 */
export interface TbboColumns extends BboColumns {
  price: number;
  /** `-1` when the vendor did not send it. See {@link parseTbboRow}. */
  action: number;
}

const REQUIRED_TBBO = [...REQUIRED_BBO, "price"] as const;

export function parseTbboHeader(line: string): TbboColumns {
  const idx = headerIndex(line);
  requireColumns("parseTbboHeader", idx, REQUIRED_TBBO, line);
  return {
    tsRecv: idx.get("ts_recv")!,
    symbol: idx.get("symbol")!,
    bidPx: idx.get("bid_px_00")!,
    askPx: idx.get("ask_px_00")!,
    bidSz: idx.get("bid_sz_00") ?? -1,
    askSz: idx.get("ask_sz_00") ?? -1,
    price: idx.get("price")!,
    action: idx.get("action") ?? -1,
  };
}

export interface TbboRow extends BboRow {
  /** The trade price. Finite and > 0, or the row was rejected. */
  price: number;
}

export type TbboRejection = BboRejection | "tradePrice" | "notTrade";

/**
 * One TBBO record: the trade, and the quote that stood in front of it.
 *
 * Delegates the QUOTE half to {@link parseBboRow} rather than restating it —
 * "one rule, stated twice, disagreeing" is the most expensive defect class in
 * this repo's history (MONEY-1255). So a crossed book, an empty side and a
 * non-positive quote are rejected here by exactly the same test that rejects
 * them in the bbo fold, and a future correction to that test reaches both.
 *
 * `action !== "T"` is DEFENSIVE. The schema is trade-only by definition, so a
 * non-trade action means the vendor changed something; counting those rows
 * separately is the difference between noticing that and folding cancellations
 * into the effective spread. When the vendor omits the column entirely
 * (`action: -1`) the check does not apply — absence of the column is not
 * evidence of a non-trade.
 */
export function parseTbboRow(
  line: string,
  cols: TbboColumns,
  /** Pre-split cells, when the caller already paid for the scan. */
  preSplit?: readonly string[],
): TbboRow | { rejected: TbboRejection } {
  // ONE RFC-4180 scan, shared. `parseBboRow` used to split the line and this
  // function split it again — a full scan of a ~200-character line twice, on
  // the hottest loop in the repo (~250M rows in one cost-model build).
  const cells = preSplit ?? splitCsvLine(line);
  const quote = parseBboRow(line, cols, cells);
  if ("rejected" in quote) return quote;

  const at = (i: number): string => (i >= 0 ? (cells[i] ?? "").trim() : "");

  if (cols.action >= 0) {
    const action = at(cols.action);
    if (action !== "" && action !== "T") return { rejected: "notTrade" };
  }

  if (cells.length <= cols.price) return { rejected: "fields" };
  const price = Number(at(cols.price) === "" ? NaN : at(cols.price));
  // A separate rejection from the QUOTE's "price", so the counters can tell
  // "the book was unusable" from "the print was unusable".
  if (!Number.isFinite(price) || price <= 0) return { rejected: "tradePrice" };

  return { ...quote, price };
}

/**
 * The ET session date a vendor batch FILE covers, from its own name.
 *
 * The vendor names a daily split `equs-mini-20240102.ohlcv-1m.csv.zst` —
 * `<dataset>-<YYYYMMDD>.<schema>.<ext>`. That date is the only per-file
 * granularity we have: the LEDGER row spans the whole job (12 months for
 * `tbbo-top50`, one row, ~250 files), so a query that filters on the row's
 * `start`/`end` selects every file of any job the window merely TOUCHES.
 *
 * `null` for a name with no date — a support file, or a single-file job that
 * was not split by day. A caller filtering a window must INCLUDE those rather
 * than drop them: an unparseable name is "we cannot tell", and dropping data
 * we hold because we could not read its filename is the worse error.
 */
export function fileSessionDate(filename: string): string | null {
  const m = /(?:^|[-_.])(\d{4})(\d{2})(\d{2})(?:[-_.]|$)/.exec(filename);
  if (m === null) return null;
  const [, y, mo, d] = m;
  const key = `${y}-${mo}-${d}`;
  // A shape that parses but is not a date (…-20241332…) is "cannot tell", the
  // same as no date at all — never a silent 2024-13-32.
  return Number.isFinite(Date.parse(`${key}T00:00:00Z`)) ? key : null;
}

/**
 * Is this parsed row a TRADE?
 *
 * `TbboRow extends BboRow`, so the union does not discriminate itself and
 * `"price" in row` narrows to `BboRow & Record<"price", unknown>` — a shape
 * that type-checks and then hands `unknown` to arithmetic. The one unavoidable
 * assertion is isolated here, behind a name that says exactly what it
 * guarantees, so no call site has to repeat it.
 */
export function isTbboRow(row: BboRow | TbboRow): row is TbboRow {
  return typeof (row as Partial<TbboRow>).price === "number";
}

/* ─────────────────────────────────────────────────────────────────────────
   Coverage + archive keys
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The ET session dates a range SHOULD contain — the coverage denominator.
 *
 * Derived from the US market calendar rather than from the data, because the
 * whole point of a coverage report is to answer "what is missing", and a
 * denominator computed from what arrived can only ever report 100%. That is the
 * wrong-granularity-completeness-check class this repo has paid for before.
 *
 * Both bounds INCLUSIVE, and both are ET calendar dates (`YYYY-MM-DD`), not
 * instants — a session is a calendar day in New York, and expressing it as a
 * UTC instant is how the post-market spill defect started.
 *
 * ## It REFUSES a year the holiday table has no opinion about
 *
 * `US_MARKET_HOLIDAYS` is DATA, not a derived rule — deliberately, because
 * closures like the 2025-01-09 national day of mourning follow no rule at all.
 * `US_HOLIDAY_TABLE_YEARS` declares the range that data actually covers, and
 * outside it `isUsTradingDay` cannot say "closed"; it can only fail to say
 * "holiday", which reads as an open market.
 *
 * Left unguarded that is a fabricated denominator: every one of a year's ~10
 * closures would be reported as a MISSING SESSION, roughly 30 of them across
 * the harvest's 2023-2025 span, and the natural reading of a coverage report
 * full of gaps is that the vendor short-changed us. So an uncovered year throws
 * here rather than producing a confident wrong answer — the same choice
 * `nextUsSessionBoundary` makes when its search runs out of days.
 */
export function expectedSessions(
  fromDateKey: string,
  toDateKey: string,
): string[] {
  const parse = (k: string): { ms: number; year: number } => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
    if (!m) throw new RangeError(`expectedSessions: bad date key "${k}"`);
    return {
      ms: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
      year: Number(m[1]),
    };
  };
  const from = parse(fromDateKey);
  const to = parse(toDateKey);
  if (
    from.year < US_HOLIDAY_TABLE_YEARS.first ||
    to.year > US_HOLIDAY_TABLE_YEARS.last
  ) {
    throw new RangeError(
      `expectedSessions: ${fromDateKey}..${toDateKey} reaches outside the US ` +
        `holiday table, which covers ${US_HOLIDAY_TABLE_YEARS.first}-` +
        `${US_HOLIDAY_TABLE_YEARS.last}. Extend US_MARKET_HOLIDAYS in ` +
        "us-market-hours.ts rather than letting this compute a denominator " +
        "that counts every market holiday as a missing session.",
    );
  }
  const out: string[] = [];
  const DAY = 86_400_000;
  for (let t = from.ms; t <= to.ms; t += DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    if (isUsTradingDay(key)) out.push(key);
  }
  return out;
}

/**
 * Where a downloaded file is archived.
 *
 * `databento/{dataset}/{schema}/{yyyy}/{jobId}/{filename}` — deliberately
 * OUTSIDE `feeds/`. The prod→QA mirror rsyncs the whole `feeds/` prefix, and
 * this harvest is hundreds of gigabytes that QA receives as ROWS, through the
 * `candles` collection sync, rather than as bytes. `edgar/` sits outside for
 * exactly the same reason and for exactly the same size.
 *
 * The job id is in the path so two jobs covering the same window (a repair, a
 * re-buy after an expiry) cannot overwrite one another — the archive is the
 * only copy of data bought once, so nothing in this layout may replace.
 */
export function databentoArchiveKey(args: {
  dataset: string;
  schema: string;
  year: number;
  jobId: string;
  filename: string;
}): string {
  const base = args.filename.slice(args.filename.lastIndexOf("/") + 1);
  return `databento/${args.dataset}/${args.schema}/${args.year}/${args.jobId}/${base}`;
}

/**
 * Archive job folders that NO ledger row names — MONEY-1540.
 *
 * The ledger is what makes "a window is never bought twice" true and what the
 * loaders drive from, so bytes under a `{jobId}/` folder that no
 * `databento_batch_jobs` row names are spend the budget never counted and data
 * no loader reads. The one found (EQUS-20260907-CXDTCWL9HP) came from the
 * runbook's own §9b wrong-shape re-buy, which DELETES the old row and keeps the
 * bytes; this is how the next one gets seen.
 *
 * Takes object names in the `databentoArchiveKey` layout; anything else under
 * the prefix is ignored rather than guessed at.
 */
export function archiveJobsWithoutLedgerRow(
  objects: Iterable<{ name: string; size: number }>,
  ledgerJobIds: ReadonlySet<string>,
): Array<{ prefix: string; jobId: string; objects: number; bytes: number }> {
  const out = new Map<
    string,
    { prefix: string; jobId: string; objects: number; bytes: number }
  >();
  for (const o of objects) {
    const parts = o.name.split("/");
    if (parts.length !== 6 || parts[0] !== "databento") continue;
    const jobId = parts[4]!;
    if (ledgerJobIds.has(jobId)) continue;
    const prefix = `${parts.slice(0, 5).join("/")}/`;
    const hit = out.get(prefix) ?? { prefix, jobId, objects: 0, bytes: 0 };
    hit.objects++;
    hit.bytes += o.size;
    out.set(prefix, hit);
  }
  return [...out.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}
