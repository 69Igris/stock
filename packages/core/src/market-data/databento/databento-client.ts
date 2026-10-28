/**
 * The Databento HTTP client — the ONLY module in this repo that talks to
 * `hist.databento.com` or `api.databento.com` (MONEY-1373).
 *
 * Nothing outside `market-data/databento/**`, the two job entry points and the
 * founder probe may import this. Consumers read `CandleRepository`, so a future
 * feed is one new `source` value plus one sync job — the same seam
 * `tiingo-client.ts` states and the `no-feed-fetch-bypass` suite enforces by
 * file and line.
 *
 * ## Why this does NOT route through `getFeedAsset`
 *
 * Every Tiingo and exchange fetch goes through the archive seam so prod
 * archives what it fetched and QA replays those bytes. This one deliberately
 * does not, for two reasons that both point the same way:
 *
 *   1. `buildFeedArchiveKey` keys under `feeds/`, and these objects must live
 *      OUTSIDE it — the prod→QA mirror rsyncs that whole prefix and this
 *      harvest is hundreds of gigabytes QA receives as ROWS.
 *   2. A replay MISS is a SOFT failure by design: `getFeedAsset` falls back to
 *      the upstream. On a free public exchange file that costs one scrape. Here
 *      it would silently spend a second copy of a metered purchase — which is
 *      precisely the reasoning that already keeps `us-eod-sync` prod-only.
 *
 * So QA never fetches at all: its jobs quote and report, and the rows arrive
 * through `sync-prod-to-qa`.
 *
 * ## Auth
 *
 * HTTP Basic with the API key as the USERNAME and an EMPTY password — not a
 * bearer token. Verified against the vendor's own client
 * (`HTTPBasicAuth(username=self._key, password="")`). A `Bearer` header returns
 * 401 and reads exactly like a bad key.
 */

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

import {
  DATABENTO_HIST_BASE,
  buildCostQuery,
  buildSubmitJobForm,
  classifyDatabentoHttp,
  parseDatasetRange,
  parseJobResponse,
  parseJobSummary,
  parseListFiles,
  parseSymbologyResult,
  toDatabentoSymbol,
  type DatabentoDatasetRange,
  type DatabentoFile,
  type DatabentoJob,
  type DatabentoJobRequest,
  type DatabentoJobSummary,
  type DatabentoSymbologyResult,
} from "./databento-logic";
import {
  DatabentoAuthError,
  DatabentoChecksumError,
  DatabentoRateLimitError,
  DatabentoRequestError,
} from "./databento-errors";
import {
  databentoContentType,
  type DatabentoArchiveStore,
} from "./databento-archive";

/* ─────────────────────────────────────────────────────────────────────────
   Seams
   ──────────────────────────────────────────────────────────────────────── */

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: unknown;
}>;

export interface DatabentoClientOptions {
  fetchImpl?: FetchLike;
  /** Injected in tests so the retry ladder does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. Milliseconds. */
  now?: () => number;
}

/**
 * A REF'D timer, deliberately — MONEY-1539.
 *
 * This timer was `unref()`'d "so a sleep alone never holds the event loop
 * open". But every caller AWAITS it: the pacer's wait IS the job's next step.
 * With nothing else pending, Node sees an empty loop mid-await and exits 0.
 * Measured on prod: 7 of 9 nightly 15:00 IST appends logged
 * `Container called exit(0)` about 0.5 s after writing a chunk's QUOTED row —
 * inside the 5 s submit pacer — so the chunk was never submitted, bbo-1m and
 * the cost model never ran, no job-outcome line was written, and Cloud Run
 * recorded a success.
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The API key, read PER CALL.
 *
 * Never a module-scope const: a module-level read freezes at import, and on a
 * warm container that turns a rotated secret into no secret at all — the trap
 * `bse-client.ts` documents for its retry config and CLAUDE.md restates for
 * every flag in the repo.
 *
 * Throws rather than fetching unauthenticated. An unauthenticated call to this
 * API is a 401, so the alternative is a run that fails later and blames the
 * vendor.
 */
export function databentoApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env["DATABENTO_API_KEY"] ?? "").trim();
  if (key === "") {
    throw new DatabentoAuthError(
      "DATABENTO_API_KEY is not set. The Cloud Run jobs mount it from Secret " +
        "Manager (DATABENTO_API_KEY_QA / _PROD); a local run must export it. " +
        "Refusing to call unauthenticated rather than reporting the 401 as an " +
        "upstream fault.",
    );
  }
  return key;
}

/** Which environment a run stamps its ledger rows with. */
export type DatabentoEnv = "prod" | "qa";

/**
 * `DATABENTO_ENV`, with `NODE_ENV` as the local fallback — MONEY-1373 I0b.
 *
 * `DATABENTO_ENV` is set on both Cloud Run jobs by `setup-databento-jobs.sh`
 * and, until this function existed, was READ BY NOTHING. Both jobs derived the
 * environment from `NODE_ENV`, and `workers/Dockerfile` bakes
 * `ENV NODE_ENV=production` into the image that BOTH environments run — a
 * Cloud Run JOB does not inherit the service's env block, so nothing set it
 * back to "qa". Every QA execution therefore stamped its rows `env: "prod"`,
 * putting QA's purchases in prod's ledger: `sumMonthSpendUsd` is env-scoped, so
 * QA spend consumed the prod budget and the prod window lookup could match a
 * QA row. That is the `TIINGO_RT_EPHEMERAL_TTL_S` shape — a variable shipped in
 * the spec and read by nothing — which the setup script's own header warns
 * about.
 *
 * An unrecognised value THROWS rather than falling back. "prod" is not a safe
 * default to guess into, and a typo that silently resolves to it is exactly how
 * a QA run reaches the prod ledger — the failure this function exists to end.
 */
export function resolveDatabentoEnv(
  env: NodeJS.ProcessEnv = process.env,
): DatabentoEnv {
  const explicit = (env["DATABENTO_ENV"] ?? "").trim();
  if (explicit !== "") {
    if (explicit !== "prod" && explicit !== "qa") {
      throw new DatabentoRequestError(
        `DATABENTO_ENV=${JSON.stringify(explicit)} is neither "prod" nor ` +
          '"qa". Refusing to guess: the value scopes the spend ledger and the ' +
          "idempotent window lookup, so guessing wrong bills one environment " +
          "for another's purchases.",
        0,
      );
    }
    return explicit;
  }
  // Local runs and tests only. In the image this is always "production".
  return env["NODE_ENV"] === "production" ? "prod" : "qa";
}

/** `Authorization: Basic base64(key + ":")`. The scheme is Basic, not Bearer. */
export function databentoAuthHeader(key: string): string {
  return `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Pacing
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Documented per-IP limits: 100 concurrent connections, 100 time-series and
 * 100 symbology requests per second, 20 metadata per second, 20 batch
 * list-jobs per second, and **20 batch submit-job requests per MINUTE**.
 *
 * The submit ceiling is the tight one and it is the only one this repo can
 * plausibly reach, so submissions are paced at one per 5 seconds — 12/minute,
 * comfortably under 20 — rather than raced to the wall. A 429 is the only
 * feedback this API gives about the limit and it arrives after the fact, which
 * is the same argument `tiingo-pacer.ts` makes at length for pacing
 * proactively.
 *
 * Module-scope state is correct here in a way it is NOT for Tiingo: ONE
 * process submits (the harvest job, or the append job, never both at once, and
 * each is a single Cloud Run task for its submit step). The limits are PER IP
 * rather than per key, which is worth remembering on Cloud Run's shared egress
 * — but a second concurrent submitter would be a design change, not a tuning
 * one, and it would have to revisit this comment.
 */
export const DATABENTO_SUBMIT_INTERVAL_MS = 5_000;
export const DATABENTO_METADATA_INTERVAL_MS = 100;

let lastSubmitMs = 0;
let lastMetadataMs = 0;

/** Test hook. Resets the pacer so one test's spacing cannot leak into the next. */
export function __resetDatabentoPacer(): void {
  lastSubmitMs = 0;
  lastMetadataMs = 0;
}

async function pace(
  kind: "submit" | "metadata",
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const interval =
    kind === "submit"
      ? DATABENTO_SUBMIT_INTERVAL_MS
      : DATABENTO_METADATA_INTERVAL_MS;
  const last = kind === "submit" ? lastSubmitMs : lastMetadataMs;
  const wait = last + interval - now();
  if (wait > 0) await sleep(wait);
  if (kind === "submit") lastSubmitMs = now();
  else lastMetadataMs = now();
}

/* ─────────────────────────────────────────────────────────────────────────
   The request ladder
   ──────────────────────────────────────────────────────────────────────── */

/** Network/5xx retries. A 429 is handled separately and does not consume one. */
export const DATABENTO_MAX_RETRIES = 3;
const BACKOFF_MS = [2_000, 8_000, 30_000] as const;

interface RequestArgs {
  url: string;
  method: "GET" | "POST";
  body?: URLSearchParams;
  kind: "submit" | "metadata";
  opts: DatabentoClientOptions;
}

/**
 * One API call, with the ladder.
 *
 * A 429 waits `Retry-After` and retries WITHOUT consuming a retry budget — it
 * is not a fault, it is the vendor telling us the pace. An auth failure never
 * retries: a wrong key does not become right, and hammering it is how a shared
 * egress IP gets noticed. A 4xx that is not 429/401/403 is our own bad request
 * and also never retries.
 */
async function request(args: RequestArgs): Promise<unknown> {
  const { opts } = args;
  const fetchImpl =
    opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const auth = databentoAuthHeader(databentoApiKey());

  let attempt = 0;
  let rateLimitWaits = 0;
  for (;;) {
    await pace(args.kind, now, sleep);

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(args.url, {
        method: args.method,
        headers: {
          Authorization: auth,
          Accept: "application/json",
          ...(args.body
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(args.body ? { body: args.body.toString() } : {}),
      });
    } catch (err) {
      // A TRANSPORT fault on the SPENDING call is never retried.
      //
      // `batch.submit_job` is a POST with no idempotency key, so a socket reset
      // AFTER the vendor accepted the job produces a SECOND paid job on the
      // retry — and only the winning attempt's id reaches the ledger. The
      // orphan is billed, never downloaded, never summed by
      // `sumMonthSpendUsd`, and `stepPoll` skips any vendor job it does not
      // own, so nothing in this repo can ever surface it. Measured with an
      // injected fetch that throws once: two POSTs, one recorded.
      //
      // Surfacing it is strictly better: the next run's idempotent lookup
      // finds the QUOTED row, re-quotes, and re-submits ONCE. A GET is safe to
      // retry and still is; a 429 is safe too, because a refusal means the
      // vendor did not accept it.
      if (args.kind === "submit") {
        throw new DatabentoRequestError(
          `batch.submit_job failed in transport: ${
            err instanceof Error ? err.message : String(err)
          }. NOT retried — this POST carries no idempotency key, so a retry ` +
            "after a lost response would buy the window twice and record only " +
            "one job id. The ledger row stays QUOTED; re-run to submit it once.",
          0,
        );
      }
      if (attempt >= DATABENTO_MAX_RETRIES) throw err;
      await sleep(BACKOFF_MS[attempt] ?? 30_000);
      attempt++;
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    const failure = classifyDatabentoHttp(
      res.status,
      text,
      res.headers.get("Retry-After"),
    );

    if (failure.kind === "rate-limit") {
      // Bounded so a pathological header cannot park a job for its whole task
      // timeout while still looking like progress.
      if (rateLimitWaits >= 10) {
        throw new DatabentoRateLimitError(
          `Databento rate-limited ${args.url} after ${rateLimitWaits} waits`,
          failure.retryAfterS,
        );
      }
      rateLimitWaits++;
      await sleep(failure.retryAfterS * 1000);
      continue;
    }
    if (failure.kind === "auth") {
      throw new DatabentoAuthError(
        `Databento refused ${args.url} with ${res.status}. Either ` +
          "DATABENTO_API_KEY is wrong, or the plan does not cover this " +
          `dataset/schema. Body: ${failure.detail}`,
        res.status,
      );
    }
    if (failure.kind === "bad-request") {
      throw new DatabentoRequestError(
        `Databento rejected ${args.url} with ${res.status}: ${failure.detail}`,
        res.status,
      );
    }
    if (attempt >= DATABENTO_MAX_RETRIES) {
      throw new DatabentoRequestError(
        `Databento ${res.status} on ${args.url} after ${attempt} retries: ${failure.detail}`,
        res.status,
      );
    }
    await sleep(BACKOFF_MS[attempt] ?? 30_000);
    attempt++;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Metadata
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `metadata.get_cost` — the ONLY pre-submission price, and free to call.
 *
 * The submit response's `cost_usd` is NULL until the job is processed, so a
 * guard that waited for it would authorise the spend it was meant to check.
 * This is the number the budget ledger compares against.
 *
 * It "respects any discounts provided by flat rate plans", so a window included
 * in the Standard subscription quotes 0.00 — which is exactly the signal the
 * runbook uses to confirm the subscription is live before the harvest starts.
 */
export async function getCost(
  req: DatabentoJobRequest,
  opts: DatabentoClientOptions = {},
): Promise<number> {
  // A POST FORM, exactly as `batch.submit_job` is sent and exactly as the
  // official client sends this call (`metadata.py: self._post(url=…
  // ".get_cost", data=data)`). It was a GET with the symbols in the query
  // string, and the vendor's front door 414s above ~8 KB of URL: measured live
  // 2026-09-07, 1,000 symbols (7.3 KB) pass and 1,500 (10.8 KB) fail. A
  // 2,000-symbol master chunk is ~14 KB, so `ohlcv-1h-master` could not be
  // QUOTED and therefore could not be bought at all — the quote runs before
  // the submit. POST removes the URL from the equation and keeps the
  // 2,000-symbol chunk the vendor documents, so the quote and the submission
  // keep describing the SAME window, which the budget guard depends on.
  //
  // `kind` stays "metadata" and must: the no-retry-on-transport rule below is
  // keyed on `kind === "submit"` because a submit buys something. A quote is
  // free and idempotent, so it retries.
  const url = `${DATABENTO_HIST_BASE}/metadata.get_cost`;
  const json = await request({
    url,
    method: "POST",
    body: buildCostQuery(req),
    kind: "metadata",
    opts,
  });
  if (typeof json !== "number" || !Number.isFinite(json)) {
    throw new DatabentoRequestError(
      `metadata.get_cost returned ${JSON.stringify(json)}, not a number. ` +
        "Refusing to treat an unreadable quote as zero — that is a budget " +
        "guard that authorises everything.",
      200,
    );
  }
  return json;
}

/**
 * `metadata.get_dataset_range` — what the vendor actually holds.
 *
 * The append's availability gate. Under the T+1 embargo a session simply does
 * not exist yet for some hours, and asking for it returns an empty result that
 * is indistinguishable from a market holiday or a dead job. Reading the range
 * first turns that into a named SKIP.
 */
export async function getDatasetRange(
  dataset: string,
  opts: DatabentoClientOptions = {},
): Promise<DatabentoDatasetRange> {
  const url = `${DATABENTO_HIST_BASE}/metadata.get_dataset_range?dataset=${encodeURIComponent(dataset)}`;
  return parseDatasetRange(
    await request({ url, method: "GET", kind: "metadata", opts }),
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Batch
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `batch.submit_job` — THE SPENDING CALL.
 *
 * Every call site must be inside `withDatabentoBudget`, and that is not a
 * convention: `databento-budget-wiring.test.ts` scans the source for
 * `submitBatchJob(` and fails on any occurrence outside the guard. MONEY-1309
 * is the reason it is a scan and not a code review note — a budget guard wired
 * at one of five legs under-reported spend by ~80%, which is worse than no
 * guard because it manufactures headroom that does not exist.
 */
export async function submitBatchJob(
  req: DatabentoJobRequest,
  opts: DatabentoClientOptions = {},
): Promise<DatabentoJob> {
  const url = `${DATABENTO_HIST_BASE}/batch.submit_job`;
  const body = buildSubmitJobForm(req);
  return parseJobResponse(
    await request({ url, method: "POST", body, kind: "submit", opts }),
  );
}

/**
 * `batch.list_jobs` — SUMMARIES ONLY.
 *
 * Since the vendor's 2026-08 change this returns `id`, `state` and
 * `ts_received` and nothing else; the rest comes from `getJobDetails`. The poll
 * loop watches state here (cheap, one call for every job) and fetches details
 * only for the jobs whose state MOVED.
 */
export async function listJobs(
  args: { states?: readonly string[]; since?: Date },
  opts: DatabentoClientOptions = {},
): Promise<DatabentoJobSummary[]> {
  const params = new URLSearchParams({
    states: (args.states ?? ["queued", "processing", "done"]).join(","),
  });
  if (args.since) params.set("since", args.since.toISOString());
  const url = `${DATABENTO_HIST_BASE}/batch.list_jobs?${params.toString()}`;
  const json = await request({ url, method: "GET", kind: "metadata", opts });
  if (!Array.isArray(json)) {
    throw new DatabentoRequestError(
      "batch.list_jobs did not return an array",
      200,
    );
  }
  return json.map(parseJobSummary);
}

/** `batch.get_job_details` — the full record, including `cost_usd` once processed. */
export async function getJobDetails(
  jobId: string,
  opts: DatabentoClientOptions = {},
): Promise<DatabentoJob> {
  const url = `${DATABENTO_HIST_BASE}/batch.get_job_details?job_id=${encodeURIComponent(jobId)}`;
  return parseJobResponse(
    await request({ url, method: "GET", kind: "metadata", opts }),
  );
}

/** `batch.list_files` — the manifest, with a sha256 per file. */
export async function listFiles(
  jobId: string,
  opts: DatabentoClientOptions = {},
): Promise<DatabentoFile[]> {
  const url = `${DATABENTO_HIST_BASE}/batch.list_files?job_id=${encodeURIComponent(jobId)}`;
  return parseListFiles(
    await request({ url, method: "GET", kind: "metadata", opts }),
  );
}

/**
 * `symbology.resolve` — read for EVIDENCE, never for identity.
 *
 * Our key is `listingId`, resolved from `us_instruments`' own occupancy
 * windows. This call exists so the probe can measure which of our symbols the
 * vendor does not recognise, which is what finishes the notation table in
 * `databento-logic.ts` — and `not_found` is the useful half of the response.
 */
export async function resolveSymbology(
  args: {
    dataset: string;
    /** OUR notation; converted here. */
    symbols: readonly string[];
    startDate: string;
    endDate: string;
  },
  opts: DatabentoClientOptions = {},
): Promise<DatabentoSymbologyResult> {
  const body = new URLSearchParams({
    dataset: args.dataset,
    symbols: args.symbols.map(toDatabentoSymbol).join(","),
    stype_in: "raw_symbol",
    stype_out: "instrument_id",
    start_date: args.startDate,
    end_date: args.endDate,
  });
  const url = `${DATABENTO_HIST_BASE}/symbology.resolve`;
  return parseSymbologyResult(
    await request({ url, method: "POST", body, kind: "metadata", opts }),
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Download
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Stream one batch file straight into the archive, verifying as it goes.
 *
 * ## Nothing is buffered, and the hash is computed on the way past
 *
 * The bytes go `fetch` → a hashing pass-through → the archive store. A
 * download-then-verify-then-upload shape would hold a multi-gigabyte file in
 * memory to check a hash it could have checked in flight.
 *
 * ## A mismatch DELETES and THROWS
 *
 * The vendor's own client warns and keeps the file. That is wrong for us: these
 * bytes are the only copy of data bought once inside a one-month subscription
 * window, and a truncated object that nothing rejects becomes a coverage gap
 * discovered months later with the subscription long cancelled. Deleting the
 * partial object is what makes the retry idempotent — a half-written key that
 * `exists()` reports as present would otherwise be skipped forever.
 *
 * ## The download host is NOT the API gateway
 *
 * `urls.https` points at `api.databento.com`; the API itself is
 * `hist.databento.com`. Both are in `FEED_HOSTS` — listing only the gateway
 * would leave the host that moves the actual gigabytes unguarded.
 */
export async function downloadToArchive(args: {
  file: DatabentoFile;
  key: string;
  store: DatabentoArchiveStore;
  opts?: DatabentoClientOptions;
}): Promise<{ bytes: number; sha256: string }> {
  const opts = args.opts ?? {};
  const fetchImpl =
    opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const auth = databentoAuthHeader(databentoApiKey());

  let attempt = 0;
  for (;;) {
    const res = await fetchImpl(args.file.httpsUrl, {
      method: "GET",
      headers: { Authorization: auth },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const failure = classifyDatabentoHttp(
        res.status,
        text,
        res.headers.get("Retry-After"),
      );
      if (failure.kind === "rate-limit" && attempt < DATABENTO_MAX_RETRIES) {
        await sleep(failure.retryAfterS * 1000);
        attempt++;
        continue;
      }
      if (failure.kind === "auth") {
        throw new DatabentoAuthError(
          `Databento refused the download of ${args.file.filename} with ` +
            `${res.status}: ${failure.detail}`,
          res.status,
        );
      }
      if (failure.kind === "upstream" && attempt < DATABENTO_MAX_RETRIES) {
        await sleep(BACKOFF_MS[attempt] ?? 30_000);
        attempt++;
        continue;
      }
      throw new DatabentoRequestError(
        `Databento ${res.status} downloading ${args.file.filename}: ${failure.detail}`,
        res.status,
      );
    }

    if (res.body === null || res.body === undefined) {
      throw new DatabentoRequestError(
        `Databento returned no body for ${args.file.filename}`,
        res.status,
      );
    }

    const hash = createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });

    const source = toNodeReadable(res.body);
    source.on("error", (err) => tap.destroy(err));
    source.pipe(tap);

    try {
      await args.store.put(
        args.key,
        tap,
        databentoContentType(args.file.filename),
      );
    } catch (err) {
      // THE SAME CLEAN-UP THE CHECKSUM PATH GETS. This module documents that
      // "a half-written object cannot survive to be loaded", and that held only
      // for a checksum MISMATCH — a `put` that rejected after partial bytes
      // threw with no delete and neither stream destroyed. GCS resumable
      // uploads do not normally finalise a partial object, so this is
      // defence in depth; the leak of the response socket was not.
      source.destroy();
      tap.destroy();
      await args.store.delete(args.key).catch(() => {});
      throw err;
    }

    const digest = hash.digest("hex");
    // Case-INSENSITIVE. `parseListFiles` documents the hash as lower-case hex
    // and does not enforce it, while `createHash().digest("hex")` always is —
    // so a vendor that ever emitted upper-case would fail EVERY download,
    // delete every object, and read as vendor-wide corruption.
    if (digest.toLowerCase() !== args.file.sha256.toLowerCase()) {
      // Delete BEFORE throwing: a half-written object that `exists()` reports
      // as present would be skipped by every later run.
      await args.store.delete(args.key).catch(() => {});
      throw new DatabentoChecksumError(
        args.file.filename,
        args.file.sha256,
        digest,
      );
    }
    return { bytes, sha256: digest };
  }
}

/**
 * A `fetch` body as a Node stream.
 *
 * `Readable.fromWeb` when the body is a web `ReadableStream` (what undici's
 * fetch returns), passed through unchanged when a test injects a Node stream
 * directly. Kept as one narrow helper so the cast lives in exactly one place.
 */
function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
