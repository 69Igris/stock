/**
 * Tiingo NEWS client — MONEY-1264.
 *
 * Sibling of `tiingo-client.ts` (EOD prices). Same host, same auth, same archive
 * seam, same retry ladder; a different endpoint with a different and much
 * sharper failure mode.
 *
 * Nothing outside `market-data/tiingo/**`, the news seed script and the news
 * worker leg may import this — the `no-feed-fetch-bypass` scan pins that every
 * call here goes through {@link getFeedAsset} rather than a raw `fetch`, so prod
 * ARCHIVES what it fetched and QA REPLAYS those bytes instead of spending the
 * quota twice.
 *
 * ## Read this before changing anything
 *
 * This endpoint serves THREE MONTHS of history and does NOT error when asked for
 * more — it answers 200 with rows from the floor date. See the header of
 * `tiingo-news-logic.ts` for the five measured probes and for why the floor is
 * enforced twice. This module's contribution to that is narrow and deliberate:
 * it owns NO URL construction and NO window arithmetic. It calls
 * {@link buildTiingoNewsUrl} for the request and {@link detectClampedResponse}
 * for the response, and it turns the second one into a thrown error. A future
 * edit that "just adds a query param here" would be reintroducing the bypass.
 *
 * ## What is shared and what is local
 *
 * RATE LIMITING IS SHARED, and that is not a style preference. This file first
 * shipped with its own copy of the EOD client's pacer, carrying its own
 * module-scope `lastRequestAtMs`. So did the corporate-actions client and the
 * permaTicker search. Tiingo's quota is per ACCOUNT, so four private throttles
 * each honouring the full plan limit is a combined rate of FOUR TIMES the cap —
 * and nothing would have said so, because Tiingo publishes no quota headers. The
 * first symptom would have been a 429 wall mid-backfill, produced by the exact
 * machinery built to prevent one. `tiingo-pacer.ts` now holds that state for
 * every Tiingo call in the repo (MONEY-1263); a shared ceiling needs shared
 * state, so do not reintroduce a local one here.
 *
 * The retry LADDER is shared too, by import: {@link decideTiingoFailure} and
 * {@link MAX_RETRIES} come from `tiingo-client.ts`, so the two clients cannot
 * disagree about what a 403 means or about which failures a caller
 * circuit-breaks on.
 *
 * Only the header builder is local, because `tiingo-client.ts` does not export
 * its own and MONEY-1264 does not own that file. It is a pure function of one
 * env var, so a second copy cannot drift into a different BEHAVIOUR — unlike
 * pacing state, where a second copy IS the defect.
 */

import { getFeedAsset } from "../feed-archive";
import type { FeedAssetOutcome } from "../feed-archive";
import {
  MAX_RETRIES,
  TiingoAuthError,
  TiingoRateLimitError,
  decideTiingoFailure,
} from "./tiingo-client";
import { TiingoDailyCapError, paceTiingoRequest } from "./tiingo-pacer";
import { recordBytes, withTiingoBudget } from "./tiingo-budget";
import {
  TiingoNewsClampedError,
  buildTiingoNewsUrl,
  detectClampedResponse,
  parseNewsResponse,
  type TiingoNewsArticle,
  type TiingoNewsQuery,
} from "./tiingo-news-logic";

/**
 * Headers for an authenticated Tiingo call.
 *
 * `Origin` and `Referer` are DELETED (`null`), not overridden — the archive
 * seam's defaults impersonate a browser because the NSE/BSE hosts demand it, and
 * Tiingo is a developer REST API that wants a token and nothing else. The merge
 * is case-insensitive, so a lowercase `authorization` here would JOIN with a
 * default rather than replace it; spell each header exactly once, canonically.
 *
 * Accept is JSON and only JSON: `format=csv` 404s on this endpoint (unlike
 * `/tiingo/daily`), so there is no cheaper wire format to negotiate.
 */
function tiingoNewsHeaders(): Record<string, string | null> {
  const key = process.env.TIINGO_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "TIINGO_API_KEY is not set — required for every api.tiingo.com call",
    );
  }
  return {
    Authorization: `Token ${key}`,
    Accept: "application/json",
    Origin: null,
    Referer: null,
  };
}

/** Referer handed to the seam positionally; deleted from the sent headers. */
const TIINGO_REFERER = "https://www.tiingo.com/";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One archived, authenticated GET with the shared typed retry ladder.
 *
 * Returns `null` for a 404 (`fetchExchangeAsset` maps it). For news that should
 * never happen — an unknown ticker answers 200 with `[]`, not 404 — so a null
 * here means the endpoint itself moved, and the caller surfaces it as such
 * rather than as "no articles".
 */
async function getArchived(
  url: string,
  descriptor: Parameters<typeof getFeedAsset>[2],
  context: string,
  outcome?: FeedAssetOutcome,
): Promise<Response | null> {
  // Resolved ONCE, OUTSIDE the ladder, and that placement is load-bearing.
  //
  // `tiingoNewsHeaders` throws when `TIINGO_API_KEY` is unset. Built inside the
  // `try` it became a caught error carrying no HTTP status, which
  // `decideTiingoFailure` classifies as "other" and RETRIES — so a missing env
  // var cost the full ~35s ladder (5s + 10s + 20s) and four identical failures
  // before surfacing. Measured: it timed out a 30s test.
  //
  // That is the same class as the `TiingoRateLimitError` re-throw in
  // `tiingo-client.ts`: a deterministic, permanent, non-HTTP failure has no
  // business in a ladder built for transport flakes. A worker inheriting it
  // would spend 35s per call against a 600s ack deadline for a misconfiguration
  // that will never heal. Nothing about the headers varies per attempt, so
  // hoisting costs nothing and fixes it at the source.
  const headers = tiingoNewsHeaders();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Budgeted AND paced per ATTEMPT, in that order (MONEY-1309).
      //
      // A retry is another request against the same quota — that is why the
      // pacer sits inside the loop — and it is another request against the same
      // SHARED BUDGET for the identical reason. Charging only the first attempt
      // would make a call that needed three retries cost one, and the ladder is
      // ~35s of sleeping, so exactly the runs already struggling would be the
      // ones under-reported.
      //
      // The budget CHECK is outer and the pacer INNER, matching
      // `tiingo-client.ts`. Two reasons, both load-bearing: a refusal costs
      // zero sleep instead of 180ms of it, and `paceTiingoRequest`'s
      // `TiingoDailyCapError` is thrown INSIDE the wrapper, where it is
      // re-thrown untouched. That second one matters here of all places —
      // `TiingoDailyCapError` is a SUBCLASS of `TiingoRateLimitError`, so a
      // wrapper that caught it on its 429 arm would park this leg for five
      // minutes and log "429, this should be impossible" about the pacer's own
      // cap. The `instanceof TiingoDailyCapError` re-throw below still sees it
      // and still keeps it out of the ladder.
      //
      // The counter is charged only once this callback RESOLVES, so a cap
      // throw, a 403 or a transport failure records nothing — MONEY-1255's
      // counted-before-the-call defect, the shape that hid Tickertape's block
      // for five months.
      return await withTiingoBudget("news", async () => {
        await paceTiingoRequest();
        return getFeedAsset(url, TIINGO_REFERER, descriptor, outcome, {
          headers,
        });
      });
    } catch (err) {
      lastErr = err;

      // The DAILY CAP is a stop, not a flake, and it must leave this loop
      // untouched.
      //
      // `decideTiingoFailure` re-throws `TiingoRateLimitError` for exactly this
      // reason (MONEY-980), but the shared pacer throws `TiingoDailyCapError`,
      // which is a DIFFERENT class that its `instanceof` arm does not name. So
      // it would fall through to `statusFromFeedFailure` -> status 0 ->
      // "other" -> RETRY, spending the whole ~35s ladder re-entering the pacer
      // and throwing the identical cap error four times before surfacing as a
      // generic failure that no caller circuit-breaks on. That is precisely the
      // defect MONEY-980 fixed, reintroduced by a rename.
      //
      // Checked HERE rather than by widening the shared decision function,
      // because MONEY-1264 does not own `tiingo-client.ts` — the same hazard
      // exists in its `getArchived` and is reported rather than edited.
      if (err instanceof TiingoDailyCapError) throw err;

      const decision = decideTiingoFailure(err, attempt);
      switch (decision.action) {
        case "rethrow":
          // Our own typed error (the daily cap). Untouched, so the caller's
          // circuit-breaker sees it.
          throw err;
        case "auth":
          throw new TiingoAuthError(decision.message, decision.status);
        case "retry":
          // Transport / 5xx / a 429 with attempts left. The ladder's timing is
          // `decideTiingoFailure`'s to own, not this file's — a second copy of
          // the backoff arithmetic is how two clients drift apart.
          await delay(decision.delayMs);
          continue;
        case "rate-limited":
          throw new TiingoRateLimitError(context);
        case "give-up":
          throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error(`Tiingo news fetch failed for ${context}`);
}

/** What one successful news request produced. */
export interface TiingoNewsResult {
  articles: TiingoNewsArticle[];
  /** Wire size, for the bandwidth ledger the plan meters. */
  bytes: number;
  /** The exact URL fetched — logged by callers, and the archive key's input. */
  url: string;
}

/**
 * Fetch one page of Tiingo news.
 *
 * `now` is injectable so the floor is testable against the measured probes
 * rather than against the suite's wall clock; production leaves it defaulted.
 *
 * THROWS, and every throw is a refusal to hand back data that would be believed:
 *   - {@link TiingoNewsFloorError}   — pre-floor `startDate`; would have been
 *                                      silently clamped to the last 3 months.
 *   - {@link TiingoNewsClampedError} — the response is not the window we asked
 *                                      for, whatever the floor arithmetic said.
 *   - {@link TiingoNewsParseError}   — a non-array container (an error envelope
 *                                      returning `[]` would look like a quiet
 *                                      day).
 *   - {@link TiingoRateLimitError} / {@link TiingoAuthError} — as in the EOD
 *                                      client, so callers circuit-break on the
 *                                      same two types.
 *
 * An EMPTY `articles` array is NOT an error. It is what a quiet day and an
 * unknown ticker both legitimately return, and the ticker filter is strict
 * enough to trust that reading — measured, `BRK.A` matches zero rows rather than
 * falling through to the unfiltered firehose.
 */
export async function fetchNews(
  query: TiingoNewsQuery,
  opts: { now?: Date; outcome?: FeedAssetOutcome } = {},
): Promise<TiingoNewsResult | null> {
  const now = opts.now ?? new Date();

  // Throws before a single byte leaves the process if the window is pre-floor,
  // the offset is past the measured ceiling, or the dates are malformed.
  const url = buildTiingoNewsUrl(query, now);

  const res = await getArchived(
    url,
    {
      exchange: "TIINGO",
      feed: "news",
      // DATED, so each day's firehose keeps its own object under
      // `feeds/TIINGO/news/{YYYY}/{MM}/` instead of overwriting the previous
      // day's. The basename has to carry the day too: `buildFeedArchiveKey`
      // derives it from the URL path, which is `news` for every request alike.
      // The seam appends its own query discriminator on top, so a ticker-scoped
      // or paginated variant of the same day cannot collide with the firehose.
      date: new Date(`${query.startDate}T00:00:00Z`),
      basename: `news-${query.startDate}.json`,
    },
    `news ${query.startDate}..${query.endDate}`,
    opts.outcome,
  );
  if (res === null) return null;

  const text = await res.text();
  const bytes = Buffer.byteLength(text, "utf8");

  // The monthly BANDWIDTH meter, fed from the bytes we actually read
  // (MONEY-1309). Recorded HERE, before the clamp guard below, because a
  // CLAMPED response cost exactly as many bytes on the wire as a good one:
  // metering only the payloads we ended up accepting would under-report
  // precisely when the endpoint is misbehaving, which is when an operator most
  // needs the number. That is the opposite of the rule for REQUESTS, which are
  // charged only on success — and deliberately so: a failed request cost quota
  // we cannot see, while these bytes are measured from a body already in hand.
  await recordBytes(bytes);

  const articles = parseNewsResponse(text);

  // The second, independent floor guard. It reads the DATES THAT CAME BACK
  // against the window we asked for, so it still fires if the arithmetic in
  // `newsFloorDate` is wrong or Tiingo moves its window under us.
  const clamp = detectClampedResponse({
    startDate: query.startDate,
    endDate: query.endDate,
    articles,
  });
  if (clamp.clamped) {
    throw new TiingoNewsClampedError(`${clamp.reason} (url: ${url})`);
  }

  return { articles, bytes, url };
}
