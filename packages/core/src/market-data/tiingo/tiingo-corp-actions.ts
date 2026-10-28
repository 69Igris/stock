/**
 * Tiingo US corporate-actions client — dividends and splits — MONEY-1263.
 *
 * The sibling of `tiingo-client.ts`, and bound by the same rules: nothing
 * outside `market-data/tiingo/**`, the backfill script and the corporate-actions
 * worker leg may import this, and EVERY fetch routes through `getFeedAsset` so
 * prod ARCHIVES the bytes it fetched and QA REPLAYS the same bytes instead of
 * spending our quota twice.
 *
 * Consumers read the `UsCorporateAction` table, never this module.
 *
 * ## Why this is a separate file from `tiingo-client.ts`
 *
 * Different route family, different response grammar, different WALK. The price
 * client is symbol-major (one request returns a security's whole history); this
 * one is DAY-major, because the market-wide corporate-actions form takes one
 * `exDate` and refuses a range (see {@link fetchDistributionsByExDate}). Folding
 * two walks into one module would put two unrelated pagination stories behind
 * one set of helpers.
 *
 * ## What is shared, and the one thing that is NOT
 *
 * The pure, exported halves of the price client are IMPORTED rather than
 * re-implemented: {@link TiingoAuthError}, {@link TiingoRateLimitError},
 * `decideTiingoFailure` (the whole retry-ladder decision), and `MAX_RETRIES`.
 * The plan limits come from `tiingo-logic.ts`. So the error taxonomy and the
 * ladder have exactly one definition across both clients.
 *
 * ### The throttle IS shared
 *
 * Every Tiingo request in the repo — this client, EOD, news and the permaTicker
 * search — calls `paceTiingoRequest` from `tiingo-pacer.ts`. The quota is per
 * ACCOUNT, so the pacing state has to be too.
 *
 * This file briefly carried its own copy, because the original pacer was
 * module-private in `tiingo-client.ts`. Four clients then held four independent
 * throttles against one ceiling, each honouring the full plan limit on its own,
 * for a combined rate of 4x the cap (MONEY-1263). Nothing would have failed
 * loudly: Tiingo publishes no quota headers, so the first symptom would have
 * been a 429 wall mid-backfill — the exact outcome proactive pacing exists to
 * prevent, delivered by the machinery meant to prevent it.
 */

import { getFeedAsset } from "../feed-archive";
import { paceTiingoRequest } from "./tiingo-pacer";
import { recordBytes, withTiingoBudget } from "./tiingo-budget";
import type { FeedAssetOutcome } from "../feed-archive";
import {
  decideTiingoFailure,
  MAX_RETRIES,
  TiingoAuthError,
  TiingoRateLimitError,
} from "./tiingo-client";
import { tiingoLimits } from "./tiingo-logic";
import {
  parseDistributionsCsv,
  parseSplitsCsv,
  type TiingoDistributionRow,
  type TiingoSplitRow,
} from "./tiingo-corp-actions-logic";

const TIINGO_BASE = "https://api.tiingo.com";
const TIINGO_REFERER = "https://www.tiingo.com/";

/**
 * The two market-wide routes, spelled once.
 *
 * The slug is also the `feed` segment of the archive key
 * (`feeds/TIINGO/{splits|distributions}/{YYYY}/{MM}/…`) and the key into
 * `FEED_SHAPES`, so the three cannot drift apart by construction.
 */
const DISTRIBUTIONS_FEED = "distributions";
const SPLITS_FEED = "splits";

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
 * Tiingo is a developer REST API that wants a token and nothing else. The merge
 * is case-insensitive, so a lowercase `authorization` here would JOIN with a
 * default rather than replace it — spell each header exactly once, canonically.
 *
 * Duplicated from `tiingo-client.ts` (module-private there) rather than
 * approximated: this is the minimum that had to be copied, and copying it
 * WRONG — a browser `Origin` on an authenticated API — is the kind of thing
 * that produces an intermittent 403 nobody can reproduce.
 */
function tiingoHeaders(): Record<string, string | null> {
  return {
    Authorization: `Token ${apiKey()}`,
    Accept: "text/csv,*/*",
    Origin: null,
    Referer: null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One archived, authenticated GET with the shared retry ladder.
 *
 * Every arm of the switch is decided by `decideTiingoFailure` — the SAME pure
 * function the price client uses — so the ladder has one definition and one set
 * of tests. This block only carries the decision out.
 *
 * Returns `null` for a 404. `fetchExchangeAsset` maps it, and here that would
 * mean the ROUTE moved rather than "no data": a bad path answers 404 with plain
 * HTML (`<h1>Not Found</h1>`), not JSON, so there is nothing to parse and
 * nothing to retry. A day with no corporate actions is a 200, not a 404 — see
 * `isEmptyCorpActionsBody`.
 */
async function getArchived(
  url: string,
  descriptor: Parameters<typeof getFeedAsset>[2],
  context: string,
  outcome?: FeedAssetOutcome,
): Promise<Response | null> {
  // Resolved ONCE, OUTSIDE the ladder, and that placement is load-bearing —
  // MONEY-1263 review, F6.
  //
  // `tiingoHeaders()` calls `apiKey()`, which THROWS when `TIINGO_API_KEY` is
  // unset. Built inside the `try` it became a caught error carrying no HTTP
  // status, so `statusFromFeedFailure` returned 0, `decideTiingoFailure`
  // classified it "other", and the ladder RETRIED it: four attempts, four
  // `paceTiingoRequest()` calls charged against the account-wide quota, and
  // 5s + 10s + 20s = ~35s of backoff PER SYMBOL — for a misconfiguration that
  // cannot heal and that then surfaced as a generic failure rather than as the
  // auth stop every caller circuit-breaks on.
  //
  // Same class as the `TiingoRateLimitError` re-throw below: a deterministic,
  // permanent, non-HTTP failure has no business in a ladder built for transport
  // flakes. `tiingo-news.ts` hoists for exactly this reason and says so.
  // Nothing about the headers varies per attempt, so hoisting costs nothing.
  const headers = tiingoHeaders();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Budgeted AND paced per ATTEMPT, in that order (MONEY-1309).
      //
      // A retry is another request against the same quota — that is why the
      // pacer sits inside the loop — and it is another request against the same
      // SHARED BUDGET for the identical reason.
      //
      // The budget CHECK is outer and the pacer INNER, matching
      // `tiingo-client.ts`: a refusal costs zero sleep instead of the pacer's
      // inter-request gap, and `paceTiingoRequest`'s `TiingoDailyCapError` is
      // thrown INSIDE the wrapper, where it is re-thrown untouched instead of
      // being mistaken for a 429 and parking this leg for five minutes (it is a
      // SUBCLASS of `TiingoRateLimitError`, which is the wrapper's 429 arm).
      // Once it leaves the wrapper, `decideTiingoFailure` re-throws it as
      // before, so the caller's circuit-breaker still sees it.
      //
      // The counter is charged only once this callback RESOLVES, so a cap
      // throw, a 403 or a transport failure records nothing — MONEY-1255's
      // counted-before-the-call defect.
      return await withTiingoBudget("corp-actions", async () => {
        await paceTiingoRequest();
        return getFeedAsset(url, TIINGO_REFERER, descriptor, outcome, {
          headers,
        });
      });
    } catch (err) {
      lastErr = err;
      const decision = decideTiingoFailure(err, attempt);
      switch (decision.action) {
        case "rethrow":
          // Our own typed error (the daily cap). Untouched, so the caller's
          // circuit-breaker sees it rather than a generic failure.
          throw err;
        case "auth":
          throw new TiingoAuthError(decision.message, decision.status);
        case "retry":
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

/** What one market-wide fetch returned. */
export interface CorpActionFetch<T> {
  rows: T[];
  /** Raw response size, for bandwidth accounting and the checkpoint. */
  bytes: number;
}

/**
 * Build the market-wide URL for one route and one ex-date.
 *
 * ## `exDate` is MANDATORY and a range is IMPOSSIBLE
 *
 * Measured 2026-08-28. Omitting `exDate` on the market-wide form is a 400
 * (`{"detail":"Error: Must provide an exDate."}`), and `startExDate` /
 * `endExDate` are REJECTED here — they work only on the per-ticker form
 * (`/corporate-actions/<ticker>/splits`). There is no market-wide range query,
 * which is why the backfill walks days.
 *
 * ## `format=csv` is UNDOCUMENTED and worth ~74% of the bytes
 *
 * Measured on `distributions?exDate=2026-08-25`: 42,809 bytes of JSON against
 * 11,240 of CSV for the same 189 rows. Bandwidth is a metered limit on this
 * plan, so the saving is real rather than cosmetic. The cost is that the CSV
 * serializer has a defect the JSON one does not — an empty day comes back as
 * the literal `None` — which `isEmptyCorpActionsBody` handles explicitly.
 *
 * ## `columns=` is NOT sent, despite being documented
 *
 * Measured: it is SILENTLY IGNORED on these two routes — the response carries
 * every field regardless. Sending it would be a parameter that looks like it is
 * narrowing the payload while doing nothing, and the next person to read this
 * would size the bandwidth budget off a projection that never happened.
 */
export function buildCorpActionsUrl(feed: string, exDate: string): string {
  const params = new URLSearchParams({ exDate, format: "csv" });
  return `${TIINGO_BASE}/tiingo/corporate-actions/${feed}?${params.toString()}`;
}

/**
 * The archive descriptor for one route and one ex-date.
 *
 * DATED (`{ date }`), not `current/`: these rotate per ex-date and each day's
 * bytes must keep their own object. `basename` is mandatory here — the URL path
 * ends in `distributions` / `splits` for EVERY day alike, so
 * `buildFeedArchiveKey` would derive one basename for the whole feed and all
 * 252 days a year would archive over one another. It also carries the `.csv`
 * extension that drives `feedContentType`, without which the object lands as
 * `application/octet-stream` — an unidentifiable blob, the defect BSE's JSON
 * scrip master hit.
 *
 * The `date` is anchored at UTC NOON. `buildFeedArchiveKey` runs it through
 * `toIstDateKey` (+5:30) to pick the `{YYYY}/{MM}` prefix, so a UTC-midnight
 * anchor would sit 5.5 hours from a month boundary and a UTC-23:00 anchor would
 * cross it — filing December's last ex-date under January with no error. Noon is
 * the only anchor that cannot straddle in either direction, and it is the same
 * convention `parseIsoDay` uses.
 */
export function corpActionsDescriptor(
  feed: string,
  exDate: string,
): Parameters<typeof getFeedAsset>[2] {
  return {
    exchange: "TIINGO",
    feed,
    date: new Date(`${exDate}T12:00:00.000Z`),
    basename: `${feed}-${exDate}.csv`,
  };
}

/**
 * Every distribution (cash dividend) with this EX-DATE, market-wide.
 *
 * `null` means the route 404'd — a moved endpoint, not an empty day. An EMPTY
 * array means the day genuinely carried no distributions, which for a market
 * holiday or a weekend is the correct and common answer. Those are DIFFERENT
 * outcomes and the backfill checkpoints them differently; collapsing them is
 * how a broken route gets recorded as "nothing happened that year".
 *
 * No pagination and no truncation at any observed size — the largest day seen
 * is 6,482 rows / 1,353,615 bytes (`exDate=2026-06-30`, a quarter end). A
 * typical weekday is 100-400 rows / 25-90 KB.
 *
 * A THIRD outcome exists and is neither of the above: `parseDistributionsCsv`
 * throws `TiingoCorpActionsShapeError` when the header is not this feed's
 * header. That is deliberately NOT caught here — it is a global condition (a
 * renamed column affects every day alike), it is not retryable, and the whole
 * point of MONEY-1263's F5 fix is that it must not arrive at a caller wearing
 * the same clothes as an empty day.
 */
export async function fetchDistributionsByExDate(
  exDate: string,
  outcome?: FeedAssetOutcome,
): Promise<CorpActionFetch<TiingoDistributionRow> | null> {
  const res = await getArchived(
    buildCorpActionsUrl(DISTRIBUTIONS_FEED, exDate),
    corpActionsDescriptor(DISTRIBUTIONS_FEED, exDate),
    `distributions ${exDate}`,
    outcome,
  );
  if (!res) return null;

  const text = await res.text();
  const bytes = Buffer.byteLength(text, "utf8");
  // The monthly BANDWIDTH meter (MONEY-1309). Not a rounding error on this
  // leg: one quarter-end ex-date measured 1,353,615 bytes of distributions
  // (`exDate=2026-06-30`), and the backfill walks days one at a time.
  await recordBytes(bytes);
  return {
    rows: parseDistributionsCsv(text),
    bytes,
  };
}

/**
 * Every split with this EX-DATE, market-wide. Typically 2-5 rows a day.
 *
 * Same null/empty distinction as {@link fetchDistributionsByExDate}.
 */
export async function fetchSplitsByExDate(
  exDate: string,
  outcome?: FeedAssetOutcome,
): Promise<CorpActionFetch<TiingoSplitRow> | null> {
  const res = await getArchived(
    buildCorpActionsUrl(SPLITS_FEED, exDate),
    corpActionsDescriptor(SPLITS_FEED, exDate),
    `splits ${exDate}`,
    outcome,
  );
  if (!res) return null;

  const text = await res.text();
  const bytes = Buffer.byteLength(text, "utf8");
  // The monthly BANDWIDTH meter (MONEY-1309) — see the sibling above.
  await recordBytes(bytes);
  return {
    rows: parseSplitsCsv(text),
    bytes,
  };
}
