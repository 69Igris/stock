/**
 * Raw exchange-feed archive + replay — MONEY-1085.
 *
 * Every raw file we pull from an EXCHANGE goes through {@link getFeedAsset}:
 * the BSE + NSE bhavcopy CSV/ZIPs, the NSE all-indices close file, the NSE
 * instrument-master CSVs (EQUITY_L / SME_EQUITY_L), and BSE's scrip master.
 *
 * Deliberately NOT covered — stated here because "every raw file" invited the
 * opposite reading, and an uncovered feed fails silently:
 *
 *   Zerodha's Kite instrument dump (`api.kite.trade/instruments`) fetches
 *   directly. It is an authenticated developer REST API, not a scraped exchange
 *   website, and this seam's contract is wrong for it in three ways: it sends
 *   browser-impersonation headers (which exist because NSE/BSE 403 bot user
 *   agents), it takes a `referer` positionally, and it maps 404 to `null`
 *   meaning "non-trading day" — for Kite a 404 means the endpoint moved and
 *   must throw. The upside is small too: the endpoint is public, tier-agnostic
 *   and unmetered, which is why `instrument_mappings` is already a QA-DIRECT
 *   collection (see the EXCLUDED block in `scripts/ops/sync-prod-to-qa.sh`) —
 *   QA fetching it itself is the design, not an oversight. The exemption is
 *   pinned by `__tests__/market-data/no-feed-fetch-bypass.test.ts`, so it
 *   cannot silently widen to another feed.
 *
 * ## Why
 *
 * QA and prod each scraped NSE/BSE independently. That doubled our exchange
 * traffic and meant QA's data could differ from prod's for reasons unrelated to
 * the code under test. The obvious fix — mirror prod's Mongo collections into
 * QA — turns out to be the wrong one: `DailyPrice`, `LatestQuote`,
 * `IntradayBar` and `StockProfile` all key on `instrumentId`, a foreign
 * ObjectId into `instrument_mappings`. QA mints its own `_id`s, so a price-only
 * mirror points at the wrong instruments, and mirroring the whole FK cluster
 * means dropping five QA collections and disabling QA's ingest crons.
 *
 * Archiving the RAW file avoids all of that. Prod fetches once and archives;
 * QA replays the same bytes through its OWN ingest, keeping its own `_id`s.
 * Nothing is dropped, the ingest code path stays exercised on both envs, and
 * the daily transfer is ~1.2 MB instead of ~126 MB. It is also what
 * MONEY-840's "scrape-once" principle actually implies: share the artifact,
 * not rows derived from it.
 *
 * Bonus: an archived file is replayable, so a backfill or a bug repro no longer
 * depends on the exchange still serving that day (NSE prunes older bhavcopies).
 *
 * ## Dependency direction
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core CANNOT import it —
 * that would be a cycle. The GCS implementation is therefore injected:
 * core owns the port ({@link FeedArchiveStore}) and the decision logic, and the
 * worker registers a GCS-backed adapter via {@link setFeedArchiveStore}. Unit
 * tests inject a fake, so none of this needs GCP to be covered.
 *
 * ## Modes — `FEED_ARCHIVE_MODE`
 *
 *   `archive` (prod)  fetch from the exchange, then store the bytes
 *   `replay` (qa)     serve the archived bytes; fall back to the exchange on a miss
 *   unset / anything  passthrough — byte-identical to pre-MONEY-1085 behaviour
 *
 * Unset is the default so this is inert until the env vars are set, and prod can
 * be armed before QA.
 */

import { fetchExchangeAsset, type ExchangeFetchOptions } from "./exchange-feed";
import { toIstDateKey } from "./nse-holidays";
import { validateFeedPayload, type FeedPayloadCheck } from "./feed-payload";

/**
 * Identifies which feed a fetch belongs to, for archive keying and logging.
 * Deliberately not derived from the URL — the key must stay stable even if a
 * URL path changes.
 */
export interface FeedDescriptor {
  /**
   * Owning PUBLISHER, used as the first archive-key segment.
   *
   * Still called `exchange` because it names the `feeds/{X}/…` segment and
   * renaming it would orphan nothing today but would churn every call site for
   * no behavioural gain. `RBI` was added by MONEY-1106 (Data Engine P8b): the
   * macro series come from RBI's National Summary Data Page, which is a
   * scraped, rolling, government-published HTML table — the same archive-first
   * case as a bhavcopy and, if anything, a stronger one, because those pages
   * keep only the last few weeks and are NOT date-addressable.
   *
   * Adding a publisher here has two consequences to keep in view:
   *   - `feed-payload.ts` keys its per-feed shape on `${exchange}/${feed}`, so a
   *     new publisher whose payload is not CSV/ZIP/JSON needs a shape entry or
   *     it falls through to the generic guard.
   *   - `fetchExchangeAsset` sends browser-impersonation headers and maps 404 →
   *     null. That is right for a scraped site (RBI included) but wrong for an
   *     authenticated REST API — see the Kite exemption in the module header.
   */
  /**
   * The PUBLISHER, not strictly an exchange — `RBI` has been in this union
   * since the macro feeds, `AMFI` joins it for the fund AUM/TER/scheme
   * master (MONEY-1207), and `TIINGO` for the US price backbone (MONEY-980).
   * Kept as a closed union so a typo cannot silently mint a new archive prefix
   * that nothing ever replays.
   *
   * `TIINGO` is the first AUTHENTICATED member. It fits the seam anyway because
   * `ExchangeFetchOptions.headers` can delete the browser-impersonation
   * defaults (`Origin`/`Referer`) and add `Authorization`, and because
   * `fetchExchangeAsset`'s 404 -> null already means what we need it to mean:
   * measured 2026-08-28, Tiingo answers an unknown ticker (`ENE`) with a 404,
   * which is a real "no such security" rather than a moved endpoint. That is
   * precisely the property Kite lacks, which is why Kite is exempt and this is
   * not.
   */
  exchange: "NSE" | "BSE" | "RBI" | "AMFI" | "TIINGO" | "SEC";
  /** Feed slug, e.g. "bhavcopy" | "indices" | "equity-master" | "sme-master". */
  feed: string;
  /**
   * Trading day the file belongs to. Omit for a live snapshot with no
   * associated day (the instrument masters) — those archive under `current/`
   * and are overwritten each run, which is the right semantics for "the master
   * as it stands now".
   */
  date?: Date;
  /**
   * Object filename to archive under, for feeds whose URL path does not supply
   * a usable one.
   *
   * The exchanges mostly encode the trading day in the filename, so deriving
   * the basename from the URL is right for them. BSE's scrip master is a REST
   * route, not a file: `…/ListofScripData/w?…` derived the basename `w`, with
   * content-type `application/octet-stream` — an unidentifiable blob, which
   * defeats the whole point of keeping the exchange's own filename (see
   * {@link buildFeedArchiveKey}). Set this to a real filename, WITH the
   * extension: it names the object AND drives {@link feedContentType}.
   */
  basename?: string;
}

/**
 * Per-call archive outcome for ONE `getFeedAsset` invocation.
 *
 * Exists because the process-wide {@link FeedArchiveCounters} cannot attribute
 * a write. Callers used to infer "did MY bytes land?" by diffing `archived`
 * across their own call — monotonicity, not attribution — and the workers
 * service runs `containerConcurrency: 10` with no per-process mutex. Any other
 * job archiving concurrently (bhavcopy-sync at 21:00, instrument-sync at
 * 22:00, a Pub/Sub redelivery) could therefore make a family whose OWN write
 * failed read as stored, hand it the terminal `archived` outcome, and
 * suppress every retry for the day — reintroducing the exact MONEY-1100 loss
 * the `store-failed` outcome was added to close.
 *
 * Pass one object per call and read it after; the counters stay for run-level
 * totals, which is what they are actually good at.
 */
export interface FeedAssetOutcome {
  /** Bytes reached the archive backend. */
  stored: boolean;
  /** Bytes were fetched but failed the payload check, so nothing was stored. */
  rejected: boolean;
}

/** A fresh, all-false outcome sink. */
export function emptyFeedAssetOutcome(): FeedAssetOutcome {
  return { stored: false, rejected: false };
}

/** Storage port. Implemented by the worker over GCS; faked in tests. */
export interface FeedArchiveStore {
  /** Return the archived bytes, or null when absent. Must not throw. */
  get(key: string): Promise<Buffer | null>;
  /** Persist bytes at `key`. May throw — callers treat archiving as optional. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export type FeedArchiveMode = "archive" | "replay" | "off";

/**
 * How long we will wait on the archive backend before giving up — MONEY-1157.
 *
 * ## Why a bound is mandatory here
 *
 * `uploadFile` passes no `timeout` and the GCS client is built with no
 * `retryOptions`, so `@google-cloud/storage` 7.x defaults apply:
 * `totalTimeout = 600s`, `maxRetries = 3`. bhavcopy-sync's push subscription
 * uses `--ack-deadline=600`. One slow `put` can therefore consume the ENTIRE
 * ack budget, Pub/Sub redelivers while run #1 is still live, and the two runs
 * race `prisma.dailyPrice.createMany` on the same `(instrumentId, date)`. That
 * unique violation throws the WHOLE `createMany`, which is caught in
 * bhavcopy-sync as `failed += instrumentIds.length` — that leg's prices are
 * lost for the day.
 *
 * 30s matches `EXCHANGE_FETCH_TIMEOUT_MS` and is 5% of the ack budget, so even
 * a run that archives several feeds cannot spend a meaningful fraction of it.
 *
 * NOTE this is deliberately NOT `withSoftTimeout` from `@usemoney/utils`
 * despite the name: that helper only fires telemetry when a threshold is
 * crossed and then keeps awaiting the operation to completion. It bounds
 * nothing, so using it here would leave the ack budget exactly as exposed as
 * it is today. (`@usemoney/core` also does not depend on `@usemoney/utils`.)
 */
export const FEED_ARCHIVE_WRITE_TIMEOUT_MS = 30_000;

/**
 * Same bound for the replay READ. A slow read is the same ack-budget hazard on
 * QA, and giving up is cheap: an unread archive is a replay miss, which already
 * falls back to the exchange.
 */
export const FEED_ARCHIVE_READ_TIMEOUT_MS = 30_000;

/** Per-registration overrides. Both default to the constants above. */
export interface FeedArchiveStoreOptions {
  writeTimeoutMs?: number;
  readTimeoutMs?: number;
}

let store: FeedArchiveStore | null = null;
let writeTimeoutMs = FEED_ARCHIVE_WRITE_TIMEOUT_MS;
let readTimeoutMs = FEED_ARCHIVE_READ_TIMEOUT_MS;

/** A positive, finite millisecond bound, or the fallback. */
function boundMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Register (or clear, with `null`) the archive backend. Called once by the
 * worker at startup; without it every mode degrades to passthrough, so a
 * missing registration can never break ingest.
 *
 * `options` re-resolves the deadlines on EVERY call (omitted → the defaults),
 * so registration is idempotent and a test that tightened them cannot leak that
 * into the next one.
 */
export function setFeedArchiveStore(
  next: FeedArchiveStore | null,
  options?: FeedArchiveStoreOptions,
): void {
  store = next;
  writeTimeoutMs = boundMs(
    options?.writeTimeoutMs,
    FEED_ARCHIVE_WRITE_TIMEOUT_MS,
  );
  readTimeoutMs = boundMs(options?.readTimeoutMs, FEED_ARCHIVE_READ_TIMEOUT_MS);
}

/** The registered store, or null. Exported for assertions in tests. */
export function getFeedArchiveStore(): FeedArchiveStore | null {
  return store;
}

// ─── Observability (MONEY-1157) ──────────────────────────────────────
//
// Before this, the only trace of "were these bytes replayed or scraped?" was a
// console line: `MarketDataSyncLog.source` is "BHAVCOPY" either way, with no
// counter, no field and no metric. So every deployment blocker for this system
// would have presented as "everything COMPLETED, counts normal" — the exact
// zero-signal shape MONEY-1093 fixed for the metadata backfill by persisting
// its own totals onto the sync log. These counters are the same remedy: the
// ingest jobs snapshot them, diff across the run, and write the delta to
// `MarketDataSyncLog.metadata.feedArchive`.
//
// DECIDED (MONEY-1100): `getFeedAsset` does NOT throw when the archive is
// armed but the store fails — the counter delta is the seam, and the caller
// classifies it (report-archive-sync maps armed-but-not-stored to the
// retryable `store-failed` outcome). Throwing here would collapse a STORAGE
// failure into the walk's TRANSPORT stop-loss and abort a multi-hour
// backfill over a GCS blip that the fetch itself survived.

/** Per-outcome tallies for feed fetches that went through the archive. */
export interface FeedArchiveCounters {
  /** Archived bytes served to the ingest — QA did not touch the exchange. */
  replayHits: number;
  /** Nothing archived (or an unreadable/empty object) — fell back to fetch. */
  replayMisses: number;
  /** Archived bytes that FAILED the sanity check — treated as a miss. */
  replayRejected: number;
  /** Fetched bytes persisted to the archive. */
  archived: number;
  /** Fetched bytes NOT persisted because they failed the sanity check. */
  archiveSkipped: number;
  /** The store's `put` threw. */
  archiveFailed: number;
  /** The store's `put` exceeded the deadline and was abandoned. */
  archiveTimedOut: number;
}

const ZERO_COUNTERS: FeedArchiveCounters = {
  replayHits: 0,
  replayMisses: 0,
  replayRejected: 0,
  archived: 0,
  archiveSkipped: 0,
  archiveFailed: 0,
  archiveTimedOut: 0,
};

let counters: FeedArchiveCounters = { ...ZERO_COUNTERS };

/**
 * A COPY of the current process-wide tallies.
 *
 * A copy, not the live object, because the intended use is snapshot-then-diff
 * (see {@link diffFeedArchiveCounters}) — handing back the mutable object would
 * make every "before" snapshot silently equal to its "after".
 */
export function readFeedArchiveCounters(): FeedArchiveCounters {
  return { ...counters };
}

/** Reset the tallies. For tests and for a deterministic worker start. */
export function resetFeedArchiveCounters(): void {
  counters = { ...ZERO_COUNTERS };
}

/**
 * `after - before`, i.e. what happened during one job.
 *
 * Diffing rather than resetting, because two ingest jobs can overlap in a
 * single worker process and a reset would let one steal the other's counts.
 * Clamped at 0 so an interleaved reset can never produce a negative tally.
 */
export function diffFeedArchiveCounters(
  before: FeedArchiveCounters,
  after: FeedArchiveCounters,
): FeedArchiveCounters {
  const delta = { ...ZERO_COUNTERS };
  for (const key of Object.keys(ZERO_COUNTERS) as Array<
    keyof FeedArchiveCounters
  >) {
    delta[key] = Math.max(0, after[key] - before[key]);
  }
  return delta;
}

/** Resolve the mode from the environment. Anything unrecognised is "off". */
export function resolveFeedArchiveMode(
  raw: string | undefined = process.env.FEED_ARCHIVE_MODE,
): FeedArchiveMode {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return v === "archive" || v === "replay" ? v : "off";
}

/**
 * 32-bit FNV-1a, hex. Pure, dependency-free and stable across processes —
 * `node:crypto` is deliberately avoided because this module is re-exported
 * through the `market-data` barrel that apps/web imports.
 *
 * Used only to make {@link buildFeedArchiveKey} collision-free, never for
 * anything security-bearing.
 */
function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Math.imul keeps the 32-bit multiply exact; `h * 16777619` overflows into
    // float precision and stops being a hash.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Cap on the readable half of the query discriminator. */
const QUERY_LABEL_MAX = 48;

/**
 * Discriminator for a query-parameterised feed URL — "" when there is no query.
 *
 * Two URLs that differ ONLY in their query must not archive to the same object.
 * BSE's scrip master is the live case: `…/ListofScripData/w?…&segment=Debt…`
 * returns the FULL ~12,600-row universe while `segment=Equity` returns a
 * different 4,926-row subset (see `bse-master-instruments.ts`). The previous
 * key derivation dropped everything from `?` onward, so both variants were
 * named `w` and the second would have silently overwritten the first.
 *
 * Two halves, doing two different jobs:
 *   - the sorted, sanitised, non-EMPTY params are for the human who opens the
 *     bucket and needs to see WHICH variant an object is (`segment-Debt`);
 *   - the FNV digest of the RAW query is what makes it collision-free, so
 *     truncating the readable half can never reintroduce a collision.
 *
 * Params are sorted so a caller reordering its query string does not orphan the
 * archive, and empty ones (`Group=&Scripcode=&industry=`) are dropped because
 * they carry no information — the digest still covers them verbatim.
 */
function queryDiscriminator(query: string): string {
  if (!query) return "";

  const parts: string[] = [];
  for (const raw of query.split("&")) {
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const value = eq === -1 ? "" : raw.slice(eq + 1);
    if (!key || !value) continue;
    parts.push(`${key}-${value}`);
  }
  parts.sort();

  const label = parts
    .join("_")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, QUERY_LABEL_MAX);

  return `__${label ? `${label}-` : ""}${fnv1a32(query)}`;
}

/** Split "a.csv.zip" into { stem: "a.csv", ext: ".zip" }. */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Build the archive object key for a feed fetch.
 *
 * `feeds/{exchange}/{feed}/{YYYY}/{MM}/{basename}` for dated files, and
 * `feeds/{exchange}/{feed}/current/{basename}` for undated snapshots.
 *
 * Deterministic for a given (descriptor, url) — deliberately no `Date.now()`,
 * so prod's archive key and QA's replay key agree, and so a re-run overwrites
 * the same object rather than accumulating duplicates.
 *
 * The basename comes from `descriptor.basename` when the caller supplies one,
 * else from the URL path — the exchanges already encode the trading day in the
 * filename, so keeping it means an archived object is recognisable and can be
 * handed straight back to a human.
 *
 * A query string is folded INTO the basename rather than dropped. Dropping it
 * was a latent silent overwrite: any two URLs differing only in their query
 * resolved to one key, and the second fetch would have replaced the first with
 * different data under the same name. See {@link queryDiscriminator}.
 *
 * ## Why `YYYY/MM` is IST-derived (MONEY-1157)
 *
 * It used to come from `getUTCFullYear`/`getUTCMonth` while EVERY filename
 * token is IST-derived (`istParts` in bhavcopy.ts adds +5:30). Those two
 * calendars disagree for any Date whose UTC time-of-day is >= 18:30 on a
 * month's last day: an IST-midnight 2026-08-01 yielded prefix `2026/07` with
 * basename `…20260801…`, filing August's bhavcopy under July.
 *
 * Nothing breaks TODAY — dated descriptors all originate from `resolveTargetDay`
 * → `parseIsoDay`, which anchors at UTC NOON precisely so the +5:30 shift cannot
 * cross a day boundary, so prefix and basename happen to agree. But that safety
 * is an unasserted property of a caller in a DIFFERENT package (workers), which
 * is exactly the kind of accidental correctness this codebase has been bitten by
 * before. A backfill driver constructing `new Date("2026-08-01T00:00:00+05:30")`
 * would misfile the object with no error.
 *
 * ## Consequence for objects already archived under an OLD key
 *
 * Both changes above move keys, and either one orphans anything stored under the
 * previous key: a replay looks for the new key, MISSES, and falls back to the
 * exchange — the designed safe failure, so nothing breaks, but the old object is
 * never read again. The feeds whose keys actually move are BSE's scrip master
 * (now a named `.json` object), any future query-bearing URL, and any dated feed
 * whose prefix straddled the UTC/IST boundary.
 *
 * **That window has CLOSED.** The note here used to read "verified 2026-08-08
 * that `gs://stockbook-content-{prod,qa}/feeds/` are both EMPTY … this is the
 * last point at which those changes are free". All of it expired on 2026-08-12:
 * `FEED_ARCHIVE_MODE` is `archive` on prod and `replay` on QA (both live in the
 * Cloud Build specs), the mirroring job and its 00:45 IST scheduler are
 * provisioned, and the two buckets hold ~66,950 objects each.
 *
 * So a key-grammar change is no longer free, and the arithmetic has inverted:
 * it now orphans tens of thousands of objects instead of none. Changing this
 * function means renaming the stored objects first, or deliberately accepting
 * that every orphaned key falls back to the exchange — which for a DATED feed
 * means re-scraping history that NSE and BSE prune, i.e. bytes we cannot get
 * back. Treat the grammar as frozen and migrate explicitly.
 */
export function buildFeedArchiveKey(
  descriptor: FeedDescriptor,
  url: string,
): string {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q + 1);

  const fromUrl = path.split("/").filter(Boolean).pop() || "asset";
  const { stem, ext } = splitExtension(descriptor.basename ?? fromUrl);
  const basename = `${stem}${queryDiscriminator(query)}${ext}`;

  // `toIstDateKey` is the canonical +5:30 conversion (nse-holidays.ts) and is
  // reused rather than re-derived: a fourth private copy of that arithmetic is
  // how these two calendars drifted apart in the first place.
  const [year, month] = descriptor.date
    ? toIstDateKey(descriptor.date).split("-")
    : [];
  const when = descriptor.date ? `${year}/${month}` : "current";
  return `feeds/${descriptor.exchange}/${descriptor.feed}/${when}/${basename}`;
}

/**
 * Content type for the archived object.
 *
 * Inferred from `basename` when the caller supplied one — a REST-route feed has
 * no extension in its URL, which is exactly how BSE's JSON scrip master came to
 * be archived as `application/octet-stream`.
 */
export function feedContentType(url: string, basename?: string): string {
  const path = (basename ?? url.split("?")[0]!).toLowerCase();
  if (path.endsWith(".zip")) return "application/zip";
  if (path.endsWith(".csv")) return "text/csv";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".txt")) return "text/plain";
  // MONEY-1204 — NSE's XBRL filings. Without this branch every archived filing
  // is stored as `application/octet-stream`: an unidentifiable blob that no
  // browser, `gsutil cat` or later extractor can open without being told what
  // it is, which is the same defect BSE's JSON scrip master hit above.
  if (path.endsWith(".xml")) return "application/xml";
  // MONEY-1204 — the same defect, found twice more by audit. Both of these
  // feeds are `enabled: true` and were landing in GCS as octet-stream:
  //   `nse-market-pulse` (format "pdf")  ·  `nse-fii-stats` (format "xls")
  // The `.xls` case is the one that bites: NSE serves these as the legacy
  // OLE2 binary, not OOXML, and the two are different formats behind the same
  // three letters — so they get different types rather than one guess.
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".xlsx"))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (path.endsWith(".xls")) return "application/vnd.ms-excel";
  return "application/octet-stream";
}

/**
 * Sentinel for "we stopped waiting", distinct from any value a store can return
 * (a `put` resolves `undefined`, a `get` resolves `Buffer | null`).
 */
const TIMED_OUT = Symbol("feed-archive:timed-out");

/**
 * Await `work`, giving up after `ms`.
 *
 * The timer is cleared on EVERY exit. A `Promise.race` whose loser keeps a live
 * `setTimeout` holds the event loop open for the full `ms` on every normal call
 * — in a worker that delays shutdown, and in a test it is an orphaned handle.
 *
 * The abandoned promise also gets its own no-op rejection handler: once the race
 * has resolved via the deadline, a later rejection from `work` would otherwise
 * surface as an unhandled rejection and take the worker process down. Attaching
 * a handler does not consume the rejection for the `await` below, so a `work`
 * that rejects BEFORE the deadline still propagates to the caller's catch —
 * which is what keeps the existing "a storage outage does NOT fail the ingest"
 * behaviour intact.
 */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | typeof TIMED_OUT>([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bounded archive read. Never throws; null means "fall back to the exchange". */
async function readArchived(key: string): Promise<Buffer | null> {
  const backend = store;
  if (!backend) return null;
  try {
    const outcome = await withDeadline(backend.get(key), readTimeoutMs);
    if (outcome === TIMED_OUT) {
      console.warn(
        `[feed-archive] replay read TIMED OUT after ${readTimeoutMs}ms for ${key}`,
      );
      return null;
    }
    return outcome;
  } catch (err) {
    console.warn(`[feed-archive] replay read failed for ${key}:`, err);
    return null;
  }
}

/**
 * Bounded, best-effort archive write. Never throws and never reports anything
 * as a FETCH failure — the bytes are already in the caller's hands by now.
 */
async function writeArchived(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<boolean> {
  const backend = store;
  if (!backend) return false;
  try {
    const outcome = await withDeadline(
      backend.put(key, body, contentType),
      writeTimeoutMs,
    );
    if (outcome === TIMED_OUT) {
      counters.archiveTimedOut++;
      console.warn(
        `[feed-archive] SKIPPED archive: ${key} — the write exceeded ` +
          `${writeTimeoutMs}ms and was abandoned so it cannot eat the Pub/Sub ` +
          `ack budget. The fetch SUCCEEDED and the ingest is unaffected.`,
      );
      return false;
    }
    counters.archived++;
    console.log(`[feed-archive] archived: ${key} (${body.length} bytes)`);
    return true;
  } catch (err) {
    counters.archiveFailed++;
    console.warn(`[feed-archive] archive write failed for ${key}:`, err);
    return false;
  }
}

/**
 * GET a raw exchange asset, honouring the archive mode.
 *
 * Returns `null` on a 404 (file not published yet — weekend / holiday /
 * pre-EOD) so callers map a non-trading day to "no rows" rather than an error.
 * Any other non-OK status throws, as before.
 *
 * Archiving is strictly best-effort: a storage failure, a storage timeout, or
 * bytes that fail the per-feed sanity check are logged and swallowed, never
 * surfaced, because losing the archive copy must not fail a price ingest that
 * already succeeded. A replay miss — including an archived object that fails the
 * same sanity check — likewise falls back to the exchange rather than failing,
 * so QA stays functional if the rsync is late or the archived bytes are junk.
 *
 * `fetchOpts` (MONEY-1204) is forwarded verbatim to `fetchExchangeAsset` and is
 * TRANSPORT ONLY — headers and a timeout. It is deliberately NOT part of
 * {@link FeedDescriptor}: the descriptor is what keys the archive object, and a
 * caller that varied a header must never thereby vary where its bytes land.
 * Omitting it leaves every existing caller on the exact defaults.
 *
 * `accept` (MONEY-1613) is a caller's EXTRA condition on the bytes, checked
 * only once `validateFeedPayload` passes and before any archive write — the
 * special-session walk uses it so a stale copy of another day's file is never
 * archived under a weekend key. Bytes it refuses are handled exactly like a
 * failed payload check.
 */
export async function getFeedAsset(
  url: string,
  referer: string,
  descriptor: FeedDescriptor,
  outcome?: FeedAssetOutcome,
  fetchOpts?: ExchangeFetchOptions,
  accept?: (body: Buffer) => FeedPayloadCheck,
): Promise<Response | null> {
  const mode = resolveFeedArchiveMode();
  const key = buildFeedArchiveKey(descriptor, url);
  const checkBytes = (buf: Buffer): FeedPayloadCheck => {
    const check = validateFeedPayload(descriptor, url, buf);
    return check.ok && accept ? accept(buf) : check;
  };

  if (mode === "replay" && store) {
    const cached = await readArchived(key);
    if (cached && cached.length > 0) {
      // The archive is only as good as what was written into it. Validating on
      // the way OUT as well as on the way in means a bad object — archived
      // before this guard existed, or written by any other path — degrades to a
      // miss instead of being replayed as data forever.
      const check = checkBytes(cached);
      if (check.ok) {
        counters.replayHits++;
        console.log(
          `[feed-archive] replay hit: ${key} (${cached.length} bytes)`,
        );
        return new Response(new Uint8Array(cached));
      }
      counters.replayRejected++;
      console.warn(
        `[feed-archive] REJECTED replay: ${key} (${cached.length} bytes) — ` +
          `${check.reason}. Treating it as a MISS and falling back to the ` +
          `exchange; the archived object needs to be re-fetched on prod.`,
      );
    } else {
      counters.replayMisses++;
      console.warn(
        `[feed-archive] replay MISS: ${key} — falling back to the exchange`,
      );
    }
  }

  const res = await fetchExchangeAsset(url, referer, fetchOpts);
  if (!res) return null;

  if (mode === "archive" && store) {
    // Reading the body to archive it consumes the stream, so hand the caller a
    // fresh Response over the same bytes rather than the drained original.
    const buf = Buffer.from(await res.arrayBuffer());

    // Sanity check BEFORE the put. A 200 carrying an HTML throttle page is
    // indistinguishable from real data to `fetchExchangeAsset`, and persisting
    // it means QA replays it indefinitely — or, for the `current/` masters,
    // that it overwrites the last good copy. Skipping the archive leaves the
    // live fetch (this very response) as the only path, which already works.
    const check = checkBytes(buf);
    if (check.ok) {
      // `descriptor.basename` matters here: a REST-route feed (BSE's scrip
      // master) has no extension in its URL, so the content type has to come
      // from the basename the descriptor supplies.
      const stored = await writeArchived(
        key,
        buf,
        feedContentType(url, descriptor.basename),
      );
      if (outcome) outcome.stored = stored;
    } else {
      if (outcome) outcome.rejected = true;
      counters.archiveSkipped++;
      console.warn(
        `[feed-archive] SKIPPED archive: ${key} (${buf.length} bytes) — ` +
          `${check.reason}. The exchange answered 200 with something that is ` +
          `not this feed; NOT persisting it. The ingest continues on the ` +
          `fetched bytes and will simply find no rows.`,
      );
    }
    return new Response(new Uint8Array(buf));
  }

  return res;
}
