/**
 * Tiingo REST client — the ONLY module in this repo that talks to
 * `api.tiingo.com` (MONEY-980).
 *
 * Nothing outside `market-data/tiingo/**`, the backfill script and the
 * `us-eod-sync` worker may import this. Consumers read `CandleRepository`, so a
 * future feed is one new `source` value plus one sync job, with zero downstream
 * changes (prompt-01's seam, enforced by lint + a test that the rule fires).
 *
 * All fetches route through `getFeedAsset`, so prod ARCHIVES what it fetched
 * and QA REPLAYS those same bytes instead of spending our quota twice.
 */

import { unzipSingleEntry } from "../bhavcopy";
import { paceTiingoRequest, TiingoDailyCapError } from "./tiingo-pacer";
import {
  withTiingoBudget,
  recordBytes,
  tiingoStatusFromError,
  type TiingoBudgetLeg,
} from "./tiingo-budget";
import { getFeedAsset } from "../feed-archive";
import type { FeedAssetOutcome } from "../feed-archive";
import {
  parseTiingoEodCsv,
  parseTiingoMasterCsv,
  tiingoLimits,
  type TiingoEodBar,
  type TiingoMasterRow,
} from "./tiingo-logic";

const TIINGO_BASE = "https://api.tiingo.com";
const TIINGO_REFERER = "https://www.tiingo.com/";

/**
 * The daily security master. PUBLIC — no token required (verified: 200 with no
 * Authorization header, 798,715 bytes). Archived UNDATED under `current/`,
 * which is the right semantics for "the master as it stands now" and, unlike a
 * dated key, can never race the prod->QA mirror.
 */
const SUPPORTED_TICKERS_URL =
  "https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip";

/**
 * The first date Tiingo carries. Their coverage summary says "60+ years; data
 * going back from 1962", and the master's earliest `startDate` is 1962 —
 * measured, not assumed.
 */
export const TIINGO_HISTORY_FLOOR = "1962-01-01";

/**
 * Columns we ask for, in the order we want them.
 *
 * `columns` is UNDOCUMENTED for the daily prices endpoint but verified working
 * (200, only the named fields returned). It matters because monthly BANDWIDTH
 * is a metered limit: measured on AAPL's full 11,517-bar history,
 * csv+columns = 820,616 bytes vs csv full = 1,591,394 vs JSON = 2,918,110, and
 * JSON took 17.8s against CSV's 2.4s. Across 24,328 symbols that is roughly
 * 5 GB versus 15 GB — the difference between a comfortable backfill and one
 * that eats a meaningful slice of the monthly allowance.
 *
 * The `adj*` columns are deliberately NOT requested: we store raw prices plus
 * the adjustment inputs and recompute on read.
 */
const EOD_COLUMNS = [
  "date",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "divCash",
  "splitFactor",
].join(",");

/**
 * The error taxonomy moved to `tiingo-errors.ts`, a leaf both this module and
 * `tiingo-pacer.ts` can import. Re-exported here so every existing import site
 * keeps working unchanged.
 */
import { TiingoRateLimitError, TiingoAuthError } from "./tiingo-errors";

export { TiingoRateLimitError, TiingoAuthError } from "./tiingo-errors";

function apiKey(): string {
  const key = process.env.TIINGO_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "TIINGO_API_KEY is not set — required for every api.tiingo.com call",
    );
  }
  return key;
}

/**
 * Headers for an authenticated Tiingo call.
 *
 * `Origin` and `Referer` are DELETED (`null`), not overridden. The archive
 * seam's defaults impersonate a browser because the NSE/BSE hosts demand it;
 * Tiingo is a developer REST API that wants a token and nothing else, and
 * sending a browser `Origin` to it is noise at best. The merge is
 * case-insensitive, so a lowercase `authorization` here would JOIN with a
 * default rather than replace it — spell headers exactly once, canonically.
 */
function tiingoHeaders(accept: string): Record<string, string | null> {
  return {
    Authorization: `Token ${apiKey()}`,
    Accept: accept,
    Origin: null,
    Referer: null,
  };
}

/** What a failed Tiingo request means, decided from the STATUS alone. */
export type TiingoErrorKind = "rate-limit" | "auth-or-entitlement" | "other";

/**
 * Classify a failed Tiingo request. STATUS ONLY — there is no body to read.
 *
 * ## Why there is no `body` parameter (MONEY-980 review, finding 3)
 *
 * There was one, and the single call site passed `""` — always, unavoidably.
 * Every fetch here goes through `getFeedAsset` -> `fetchExchangeAsset`, which
 * throws `Exchange fetch failed: {status} {statusText} ({url})` and DISCARDS
 * the response (`market-data/exchange-feed.ts`). By the time a failure reaches
 * this function the body is gone, and no amount of care at this layer brings it
 * back. Re-requesting it is not an option either: it would spend a second
 * metered request, escape the archive seam this module exists to stay inside
 * (`__tests__/market-data/no-feed-fetch-bypass.test.ts` fails a raw call in a
 * file that names a feed host), and need not even reproduce the same refusal.
 *
 * So a classifier that branched on body text was three dead branches wearing
 * the costume of a diagnosis:
 *   - `text === ""` -> "entitlement" swallowed EVERY 403, token errors included;
 *   - `/token/i` -> "auth" was unreachable, because the string was always empty;
 *   - the phrase-based rate-limit test was unreachable for the same reason, and
 *     it also caught our OWN `TiingoRateLimitError` message, which is now
 *     re-thrown before it can reach a classifier at all (see
 *     {@link decideTiingoFailure}).
 * The signature is now the honest one, and the branch set matches it.
 *
 * ## What the two 403s actually are, kept because it is measured
 *
 * Measured 2026-08-28 against the live API:
 *   - bad / missing token  -> 403 with `{"detail":"Invalid token."}`
 *   - unentitled endpoint  -> 403 with ZERO bytes and no content-type
 * The distinction is REAL and it is recoverable — by hand, in one request, by
 * looking at the body. That is exactly what {@link tiingoAuthMessage} tells the
 * operator to do, instead of this code guessing on their behalf.
 *
 * 401 collapses into the same verdict rather than getting its own "definitely
 * the token" branch: Tiingo does not send it (both refusals above are 403), so
 * a separate arm would be an untested claim about a shape we have never seen,
 * and it leads to the identical operator action anyway.
 *
 * 429 stays its own verdict. Tiingo's 429 shape is UNDOCUMENTED and we have not
 * triggered one, so this is a deliberate bet in the generous direction: the
 * cost of mistaking quota exhaustion for a permanent auth failure is a silently
 * dead nightly job, while the cost of the reverse is one wasted backoff ladder.
 */
export function classifyTiingoError(status: number): TiingoErrorKind {
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 403) return "auth-or-entitlement";
  return "other";
}

/**
 * The HTTP status inside the archive seam's thrown message, or 0.
 *
 * `fetchExchangeAsset` throws `Exchange fetch failed: {status} {statusText}
 * ({url})`, so the status is the only classifiable part that survives — and a
 * transport failure (DNS, abort, timeout) carries none, which is what 0 means.
 */
export function statusFromFeedFailure(err: unknown): number {
  // DELEGATES rather than carrying its own regex. The budget guard has to make
  // the identical judgement — a real 429 reaches `withTiingoBudget`'s catch as
  // a plain Error and must arm the circuit break (MONEY-1309) — and two copies
  // of one rule are free to disagree about the same failure. That is the shape
  // MONEY-1255 found when a `mimeType` exact match and its sibling substring
  // test disagreed about 1,211 rows: the file was right while the row was
  // unreachable, because one rule was stated twice.
  //
  // The arrow points this way (client -> budget) because `tiingo-client.ts`
  // already imports `withTiingoBudget`; putting the shared rule in the budget
  // module is the direction that does not create a cycle.
  return tiingoStatusFromError(err);
}

/**
 * The operator-facing text for a Tiingo refusal.
 *
 * Exported so the WORDING is a tested property rather than a string literal
 * nobody reads until an outage. It must name BOTH causes and BOTH checks: this
 * layer cannot separate them (see {@link classifyTiingoError}), and a message
 * that picks one sends whoever is on call down the wrong path at the exact
 * moment the platform is dark.
 */
export function tiingoAuthMessage(status: number, detail: string): string {
  return (
    `Tiingo refused this request with HTTP ${status || "an unknown status"}. ` +
    `That is EITHER a rejected token OR an endpoint this plan does not cover, ` +
    `and this client CANNOT tell them apart: the two answers differ only in ` +
    `the response body (bad token -> {"detail":"Invalid token."}, unentitled ` +
    `-> zero bytes), and the archive seam throws on a non-OK status without ` +
    `reading it. Check BOTH, cheapest first: (1) TIINGO_API_KEY for THIS ` +
    `environment — re-run the URL below by hand with the same Authorization ` +
    `header; a body with a \`detail\` field names the token as the cause; ` +
    `(2) the plan's endpoint entitlements — an EMPTY body names the plan, and ` +
    `no retry will heal it. ${detail}`
  );
}

/**
 * Attempts per request, INCLUDING the first — so three retries, ~35s of
 * sleeping in total. Exported because the ladder's last-attempt behaviour is a
 * tested property, and a test carrying its own copy of this number would keep
 * passing while the ladder moved underneath it.
 */
export const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * What the retry ladder does with ONE caught failure.
 *
 * `rethrow` exists for a single case and it is the important one — see
 * {@link decideTiingoFailure}.
 */
export type TiingoFailureAction =
  | { action: "rethrow" }
  /** `message` is built here so the operator-facing WORDING is tested too. */
  | { action: "auth"; status: number; message: string }
  | { action: "retry"; delayMs: number }
  | { action: "rate-limited" }
  | { action: "give-up" };

/**
 * The ladder's decision for one caught failure — pure, exported and TESTED.
 *
 * Extracted from `getArchived`'s catch block rather than left inline for the
 * usual reason in this repo: inline, the only way to exercise it is a live 403
 * from Tiingo, so every branch was an unfalsifiable claim. (Same treatment as
 * `diagnoseEdgarFeed`.)
 *
 * ## Our own typed error must never enter the classifier (MONEY-980, finding 3)
 *
 * `paceRequest` throws {@link TiingoRateLimitError} when the plan's DAILY cap
 * is reached. That is not an HTTP response — it never touched the network, it
 * carries no `failed: {status}`, and it is a STOP for the whole run.
 *
 * Before this check it fell into the classifier, parsed as status 0, came back
 * "other", and was retried through the full ~35s backoff ladder — three more
 * attempts, each of which re-entered `paceRequest` and threw the same cap
 * error, before finally surfacing as a generic failure that neither caller
 * circuit-breaks on. The old body-phrase branch (`/rate limit|too many
 * requests|quota/i`) was what USED to catch this string, and it was already
 * dead because the body argument was always `""`.
 *
 * So it is re-thrown FIRST, untouched, and reaches
 * `us-eod-sync` / `tiingo-us-backfill` as the typed error they both break on.
 */
export function decideTiingoFailure(
  err: unknown,
  attempt: number,
): TiingoFailureAction {
  // BOTH typed errors re-throw. `TiingoDailyCapError` was added when pacing
  // moved to the shared module (MONEY-1263) and this arm was NOT widened, so
  // the daily cap fell through to `statusFromFeedFailure` -> status 0 ->
  // "other" -> the full ~35s ladder, re-entering the pacer and raising the
  // identical cap error four times. The comment above described the
  // single-error version as fixed; a rename defeated the fix while leaving the
  // claim standing, which is why the arm now names the CLASS of error rather
  // than one member of it.
  if (
    err instanceof TiingoRateLimitError ||
    err instanceof TiingoDailyCapError
  ) {
    return { action: "rethrow" };
  }

  const status = statusFromFeedFailure(err);
  const kind = classifyTiingoError(status);

  // Deterministic and permanent: neither a bad token nor a missing entitlement
  // heals on retry, and spending the ladder on one only delays the alert.
  if (kind === "auth-or-entitlement") {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      action: "auth",
      status,
      message: tiingoAuthMessage(status, detail),
    };
  }

  if (attempt < MAX_RETRIES) {
    return { action: "retry", delayMs: BACKOFF_BASE_MS * 2 ** (attempt - 1) };
  }
  return kind === "rate-limit"
    ? { action: "rate-limited" }
    : { action: "give-up" };
}

/**
 * Pacing now lives in `tiingo-pacer.ts`, shared by every Tiingo client.
 *
 * It used to be module state HERE, and the corporate-actions and news clients
 * each copied it — so four call sites paced independently against one
 * ACCOUNT-WIDE quota and the effective rate was four times the intended cap
 * (MONEY-1263). A shared ceiling needs shared state.
 *
 * `__resetTiingoThrottle` is kept as a re-export so existing tests keep working
 * and so there is one obvious name to call.
 */
export { __resetTiingoPacer as __resetTiingoThrottle } from "./tiingo-pacer";

/**
 * One archived, authenticated GET with a typed retry ladder.
 *
 * Returns `null` for a 404 — `fetchExchangeAsset` maps it, and for Tiingo that
 * is a real answer rather than a broken endpoint: an unknown ticker (`ENE`)
 * 404s, which the backfill records as NOT_FOUND instead of retrying forever.
 *
 * THE SINGLE REQUEST SEAM of this module (MONEY-1309). Both public functions
 * below go through it, so the shared budget guard is wired here exactly once
 * rather than at each call site — the arrangement that stops the next fetcher
 * added to this file from being the one that forgets.
 */
async function getArchived(
  url: string,
  descriptor: Parameters<typeof getFeedAsset>[2],
  accept: string,
  context: string,
  leg: TiingoBudgetLeg,
  outcome?: FeedAssetOutcome,
): Promise<Response | null> {
  // Resolved ONCE, OUTSIDE the ladder, and that placement is load-bearing.
  //
  // `tiingoHeaders()` calls `apiKey()`, which THROWS when `TIINGO_API_KEY` is
  // unset. Built inside the `try` — as the argument to `getFeedAsset` — that
  // throw became a caught error carrying no HTTP status, so
  // `statusFromFeedFailure` returned 0, `decideTiingoFailure` classified it
  // "other", and the ladder RETRIED it: four attempts, four
  // `paceTiingoRequest()` calls charged against the ACCOUNT-WIDE quota, and
  // 5s + 10s + 20s = ~35s of backoff PER SYMBOL — all for a misconfiguration
  // that cannot heal, and which then surfaced as the generic `give-up` failure
  // rather than as a stop any caller circuit-breaks on. Measured on the
  // sibling: it timed out a 30s test, and a worker inheriting it would spend
  // 35s per call against a 600s Pub/Sub ack deadline.
  //
  // Same class as the `TiingoRateLimitError` / `TiingoDailyCapError` re-throw
  // in `decideTiingoFailure`: a deterministic, permanent, non-HTTP failure has
  // no business in a ladder built for transport flakes. `tiingo-corp-actions.ts`
  // and `tiingo-news.ts` hoist for exactly this reason and say so; this client
  // was the one they both flagged and neither owned (MONEY-1264 note at
  // `tiingo-news.ts`'s `getArchived`). Nothing about the headers varies per
  // attempt — `accept` is a parameter, constant for the call — so hoisting
  // costs nothing.
  const headers = tiingoHeaders(accept);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Budgeted AND paced per ATTEMPT, in that order (MONEY-1309).
      //
      // A retry is another request against the same quota — that is why the
      // pacer sits inside the loop — and it is another request against the same
      // BUDGET for the identical reason. Charging only the first attempt would
      // make a symbol that needs three retries cost one, and the ladder is
      // ~35s of sleeping, so exactly the runs that are already struggling would
      // be the ones under-reported.
      //
      // The budget CHECK is outer and the pacer inner, so a refusal costs zero
      // sleep instead of 180ms of it — and, more importantly, so that
      // `paceTiingoRequest`'s `TiingoDailyCapError` is thrown INSIDE the
      // wrapper, where it is re-thrown untouched (it is a subclass of
      // `TiingoRateLimitError`, which the wrapper's 429 arm would otherwise
      // catch and park the leg over). The wrapper charges the counter only once
      // this whole callback RESOLVES, so a cap throw, a 403 or a transport
      // failure records nothing — MONEY-1255's counted-before-the-call defect,
      // which is the shape that hid Tickertape's block for five months.
      return await withTiingoBudget(leg, async () => {
        await paceTiingoRequest();
        return getFeedAsset(url, TIINGO_REFERER, descriptor, outcome, {
          headers,
        });
      });
    } catch (err) {
      lastErr = err;
      // Every arm of this switch is decided by a pure, tested function; the
      // block below only carries the decision out.
      const decision = decideTiingoFailure(err, attempt);
      switch (decision.action) {
        case "rethrow":
          // Our own typed error (the daily cap). Untouched, so the caller's
          // circuit-breaker sees it.
          throw err;
        case "auth":
          throw new TiingoAuthError(decision.message, decision.status);
        case "retry":
          // Transport / 5xx / a 429 with attempts left.
          await delay(decision.delayMs);
          continue;
        case "rate-limited":
          throw new TiingoRateLimitError(context);
        case "give-up":
          throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error(`Tiingo fetch failed for ${context}`);
}

/**
 * The full security master: 108,489 rows covering US equities, ETFs, mutual
 * funds and Chinese A-shares. Callers narrow it with `isUsCoreSecurity`.
 */
export async function fetchSupportedTickers(): Promise<TiingoMasterRow[]> {
  const res = await getArchived(
    SUPPORTED_TICKERS_URL,
    {
      exchange: "TIINGO",
      feed: "supported-tickers",
      basename: "supported_tickers.zip",
    },
    "application/zip,application/octet-stream,*/*",
    "supported_tickers",
    "master",
  );
  if (!res) return [];
  const buf = Buffer.from(await res.arrayBuffer());
  // Fed from the bytes we actually read, at the one point in this function
  // where they exist. See `fetchTiingoEod` for what a replay does to this
  // number and why it is safe.
  await recordBytes(buf.byteLength);
  const csv = unzipSingleEntry(buf);
  return parseTiingoMasterCsv(csv);
}

/**
 * One symbol's EOD history.
 *
 * A single request returns the ENTIRE history — there is no documented or
 * observed range cap, and AAPL's 46 years came back in one 2.4s call. That is
 * what makes the backfill ~24,328 requests instead of ~231,825 symbol-year
 * requests, so it fits inside one hour's allowance rather than two days'.
 *
 * `null` means the ticker does not exist upstream (404). An EMPTY array means
 * it exists but Tiingo holds no bars — measured on `LEH`, which answers 200
 * with `[]` and null metadata dates. Those are DIFFERENT outcomes and the
 * checkpoint records them differently; collapsing them is how a permanent
 * "not there" gets retried nightly forever.
 */
export async function fetchTiingoEod(args: {
  symbol: string;
  startDate?: string;
  endDate?: string;
  /**
   * Archive partition. Omit to archive the whole-history pull under `current/`;
   * pass a year for an incremental/nightly slice so each day's bytes keep their
   * own object rather than overwriting the backfill's copy.
   */
  year?: number;
}): Promise<{ bars: TiingoEodBar[]; bytes: number } | null> {
  const { symbol, startDate = TIINGO_HISTORY_FLOOR, endDate, year } = args;
  const params = new URLSearchParams({
    startDate,
    format: "csv",
    columns: EOD_COLUMNS,
  });
  if (endDate) params.set("endDate", endDate);

  const url = `${TIINGO_BASE}/tiingo/daily/${encodeURIComponent(symbol)}/prices?${params.toString()}`;

  const res = await getArchived(
    url,
    {
      exchange: "TIINGO",
      feed: "eod",
      // The symbol has to be in the object name: `buildFeedArchiveKey` derives
      // the basename from the URL path, which here ends in `prices` for every
      // symbol alike. Without this, all 24,328 securities would archive over
      // one another.
      basename: `${symbol}${year ? `-${year}` : ""}.csv`,
      ...(year ? { date: new Date(Date.UTC(year, 0, 1)) } : {}),
    },
    "text/csv,*/*",
    symbol,
    "eod",
  );
  if (!res) return null;

  const text = await res.text();
  const bytes = Buffer.byteLength(text, "utf8");

  // The monthly BANDWIDTH meter, fed from the bytes we actually read
  // (MONEY-1309). This is the leg that dominates the bill — the whole US
  // backfill is ~10 GB of COMMERCIAL's 100 GB, essentially all of it here —
  // so a ladder no caller feeds would be a rung nobody ever stands on.
  //
  // A REPLAYED response is counted too, and that is accepted rather than
  // engineered around. QA runs `FEED_ARCHIVE_MODE=replay`, so its bytes come
  // from GCS and cost Tiingo nothing; counting them OVERSTATES QA's spend,
  // which errs toward refusing earlier. It cannot reach prod's budget in any
  // case: `REDIS_URL` is a per-environment secret (`REDIS_URL_QA` at
  // workers/cloudbuild.qa.yaml:256, `REDIS_URL_PROD` at
  // workers/cloudbuild.prod.yaml:261), so the two environments count into two
  // different Redis instances. Distinguishing replay from fetch here would
  // mean threading a `FeedAssetOutcome` through the seam for an error that is
  // bounded, safe-direction, and confined to the environment that makes it.
  await recordBytes(bytes);

  return {
    bars: parseTiingoEodCsv(text),
    bytes,
  };
}
