/**
 * US company names from `/tiingo/daily/<ticker>` — the I/O half (MONEY-980, B3).
 *
 * `supported_tickers.zip` carries no name column, so `UsInstrument.name` starts
 * null on all 74,125 rows. This leg fills it, one paced request per listing.
 * Every rule about WHICH response may name WHICH listing is pure and lives in
 * `us-instrument-names-logic.ts`; this file is the fetch, the rotation and the
 * stamping.
 *
 * ## Three things this file is built to get right
 *
 * **The pacer is the SHARED one.** `paceTiingoRequest` in `tiingo/tiingo-pacer.ts`
 * holds module state for the whole process. Four Tiingo clients once carried
 * four private copies of it against ONE account-wide quota, so the effective
 * rate was 4x the cap the pacer exists to enforce (MONEY-1263). A fifth copy
 * here would be a fifth. There is no local delay in this file.
 *
 * **The rotation marker is ordered ASC and stamped on EVERY visited row,**
 * including failures and refusals. `desc` on a growing population pushes the
 * oldest rows further down every cycle and never reaches them —
 * `stock-document-extract` selected `fetchedAt: "desc"` against 36,001 PENDING
 * documents and needed ~2 years to drain. A row that is visited and NOT stamped
 * is selected again on the next run forever, which is the same defect from the
 * other side.
 *
 * **`nameSyncedAt` is never read in a `where`.** On Prisma+Mongo an attribute
 * that was never written is ABSENT rather than null, so `{nameSyncedAt: null}`
 * matches ZERO rows — the class that caused MONEY-1050, -1205, -1234 and -1235.
 * A missing field sorts LOWEST, so `asc` leads with the never-synced rows,
 * which is exactly the order this wants.
 */

import { prisma } from "@usemoney/database";

import { getFeedAsset } from "../feed-archive";
import { TiingoRateLimitError } from "../tiingo/tiingo-errors";
import { paceTiingoRequest } from "../tiingo/tiingo-pacer";
import {
  isTiingoRateLimitFailure,
  recordBytes,
  withTiingoBudget,
} from "../tiingo/tiingo-budget";
import {
  US_NAME_PAGE_SIZE,
  parseTiingoMetadata,
  resolveUsListingName,
  type TiingoDailyMetadata,
} from "./us-instrument-names-logic";

const TIINGO_METADATA_BASE = "https://api.tiingo.com/tiingo/daily";
const TIINGO_REFERER = "https://www.tiingo.com/";

export interface UsNameEnrichmentResult {
  /** Rows the rotation selected this run. */
  selected: number;
  /** Rows for which a request was actually made. */
  fetched: number;
  /**
   * Rows skipped WITHOUT a request because they already carry a name and are
   * DELISTED. A delisted security cannot rename, so re-asking is metered spend
   * with no possible new information. Still stamped — see the module header.
   */
  skippedNamed: number;
  /** Responses that named this exact listing. */
  resolved: number;
  /** Rows actually stamped with a name (guarded on absence — see below). */
  written: number;
  /** 200s carrying no usable name. An ANSWER (`CTEST-I`), not a failure. */
  unnamed: number;
  /**
   * Responses describing a DIFFERENT occupancy of the ticker — the recycled
   * predecessors. A LARGE number here is expected and correct: 1,440 of the
   * 74,125 listings share a ticker with another listing, and the endpoint only
   * ever answers for the current occupant. This is the coverage ceiling, not a
   * fault.
   */
  notThisListing: number;
  /** Nothing to corroborate against, so nothing was written. */
  unverifiable: number;
  /** 404 — the ticker does not exist upstream. A real answer, not a retry. */
  notFound: number;
  /** Requests that failed upstream. Distinct from every ANSWER above. */
  transportFailures: number;
  /** The run stopped because the wall-clock budget expired. */
  budgetExhausted: boolean;
  /** The run stopped because Tiingo's daily cap was reached. */
  rateLimited: boolean;
  /** True when US_NAME_ENRICH=off — a deliberate skip, not a failure. */
  disabled: boolean;
  error?: string;
}

function apiKey(): string {
  const key = process.env.TIINGO_API_KEY?.trim();
  if (!key) throw new Error("TIINGO_API_KEY is not set");
  return key;
}

/**
 * `US_NAME_ENRICH` — the off switch for this leg.
 *
 * Same shape and same word as `EDGAR_CIK_ENRICH` / `TIINGO_SEARCH_ENRICH`, so
 * an operator does not have to remember which spelling this one uses.
 * Compared against the LITERAL string: `Boolean("false")` is `true`, which
 * would arm the one configuration meant to keep it off.
 */
function isNameEnrichEnabled(): boolean {
  return (process.env.US_NAME_ENRICH ?? "").trim().toLowerCase() !== "off";
}

/**
 * One metadata call.
 *
 * Returns `undefined` for a transport failure, `null` for a 404 (a real "no
 * such security"), and the parsed body otherwise. Three outcomes because they
 * are three different facts — collapsing 404 into "failure" is how a permanent
 * "not there" gets retried nightly forever.
 *
 * Rethrows `TiingoRateLimitError` — and therefore its subclasses
 * `TiingoDailyCapError` (the pacer's cap) and `TiingoBudgetExhaustedError`
 * (the shared budget guard's refusal) — so the caller can CIRCUIT-BREAK.
 * Swallowing one would tear through the rest of the page in seconds — both
 * throw BEFORE any sleep — recording each row as a failure and then chaining
 * for more. That single `instanceof` arm now holds three stops open rather
 * than one, so it must never be narrowed to a concrete class.
 */
async function fetchMetadata(
  symbol: string,
): Promise<TiingoDailyMetadata | null | undefined> {
  const url = `${TIINGO_METADATA_BASE}/${encodeURIComponent(symbol)}`;
  try {
    // Budgeted, then paced, then fetched (MONEY-1309).
    //
    // The budget CHECK is OUTER and the pacer INNER, the same ordering as
    // `tiingo-client.ts`: a refusal costs zero sleep, and the pacer's
    // `TiingoDailyCapError` is thrown inside the wrapper, which re-throws it
    // untouched rather than mistaking it for a 429 and parking the leg.
    //
    // The pacer used to sit OUTSIDE this try so that a rate-limit throw could
    // not be caught by the transport-failure arm below and mis-reported as an
    // upstream blip. It sits inside now because the wrapper must ENCLOSE the
    // request it charges for, and the request must stay inside the try. The
    // `instanceof TiingoRateLimitError` re-throw below is what preserves the
    // original property — it covers the cap and the budget refusal alike.
    const res = await withTiingoBudget("metadata", async () => {
      await paceTiingoRequest();
      return getFeedAsset(
        url,
        TIINGO_REFERER,
        {
          exchange: "TIINGO",
          feed: "metadata",
          // UNDATED (no `date`), so it keys under `current/` and overwrites in
          // place: a company name is "as it stands now" and an un-rotating key
          // can never race the 00:45 IST prod->QA mirror. The per-ticker
          // basename is required — `buildFeedArchiveKey` derives the basename
          // from the URL path, which here IS the ticker, but naming it
          // explicitly keeps the object name and content-type stable if the
          // path ever moves.
          basename: `metadata-${symbol.toUpperCase()}.json`,
        },
        undefined,
        {
          headers: {
            Authorization: `Token ${apiKey()}`,
            Accept: "application/json",
            // The seam's browser-impersonation defaults exist because NSE/BSE
            // 403 bot user agents. Tiingo is an authenticated REST API and
            // wants neither.
            Origin: null,
            Referer: null,
          },
        },
      );
    });
    if (res === null) return null;
    const text = await res.text();
    // The monthly BANDWIDTH meter, from the bytes actually read (MONEY-1309).
    // One metadata body is small; the leg is one request per listing across
    // 74,134 of them, which is not.
    await recordBytes(Buffer.byteLength(text, "utf8"));
    return parseTiingoMetadata(text);
  } catch (error) {
    if (error instanceof TiingoRateLimitError) throw error;
    // A REAL 429 IS NOT A TRANSPORT FAILURE (MONEY-1309).
    //
    // Identical shape to `tiingo-search.ts`'s `search()`, and identical reason:
    // this leg has no retry ladder, so nothing ever constructs the typed error
    // the `instanceof` above looks for. A real 429 arrives from the feed seam
    // as a plain `Error` carrying `429` in its message, fell into
    // `return undefined`, and was booked as a transport failure — the row
    // stamped, the rotation advanced, and a rate limit recorded as an upstream
    // blip on a request that never reached the upstream's data.
    //
    // Re-thrown TYPED so the caller circuit-breaks instead of tearing through
    // the rest of the page. `withTiingoBudget` has already parked the leg.
    if (isTiingoRateLimitFailure(error)) {
      throw new TiingoRateLimitError(`metadata ${symbol}`);
    }
    return undefined;
  }
}

/**
 * Fill `UsInstrument.name` for one page of the rotation.
 *
 * Never throws — a name gap costs another cycle; a thrown error costs the run
 * and the two legs beside it.
 */
export async function enrichUsInstrumentNames(
  options: { limit?: number; deadlineAtMs?: number } = {},
): Promise<UsNameEnrichmentResult> {
  const result: UsNameEnrichmentResult = {
    selected: 0,
    fetched: 0,
    skippedNamed: 0,
    resolved: 0,
    written: 0,
    unnamed: 0,
    notThisListing: 0,
    unverifiable: 0,
    notFound: 0,
    transportFailures: 0,
    budgetExhausted: false,
    rateLimited: false,
    disabled: false,
  };

  if (!isNameEnrichEnabled()) {
    result.disabled = true;
    return result;
  }

  // Checked ONCE, before the rotation query. `apiKey()` throws, and inside the
  // per-row fetch that throw is caught by the transport-failure arm — so a
  // missing secret would burn a whole page of rotation stamps, report 1,200
  // "upstream failures" against an upstream that was never called, and push
  // those rows to the back of a 9-night queue. A missing secret must be one
  // loud failure, not 1,200 quiet ones.
  try {
    apiKey();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`[us-instrument-names] ${result.error}`);
    return result;
  }

  const limit = options.limit ?? US_NAME_PAGE_SIZE;
  const deadlineAtMs = options.deadlineAtMs ?? Number.POSITIVE_INFINITY;

  try {
    /**
     * The WHOLE table rotates — no `where` at all.
     *
     * Not a filter on `{name: null}`, and the reason is the one this file's
     * header states: an absent attribute matches neither `{name: null}` nor
     * `{name: {not: null}}` on Prisma+Mongo, so a filter would return zero rows
     * on exactly the population it is meant to select. Emptiness is decided
     * BELOW, from the value in hand, which a projection reads safely.
     *
     * `listingId` is the tiebreak because it is the model's only unique — so
     * the ordering is TOTAL and a page cannot depend on storage order. Ordering
     * by `nameSyncedAt` alone would leave ties (every unstamped row is equal)
     * resolved arbitrarily, which is the MONEY-1211 shape one step removed: not
     * a rotation that never advances, but pages that overlap between runs.
     */
    const rows = await prisma.usInstrument.findMany({
      select: {
        id: true,
        symbol: true,
        exchange: true,
        listingStartDate: true,
        listingStatus: true,
        name: true,
      },
      orderBy: [{ nameSyncedAt: "asc" }, { listingId: "asc" }],
      take: limit,
    });
    result.selected = rows.length;

    for (const row of rows) {
      // Checked BETWEEN items, so the true wall is `budget + one request`. See
      // US_ENRICH_BUDGET_MS for the headroom arithmetic.
      if (Date.now() >= deadlineAtMs) {
        result.budgetExhausted = true;
        break;
      }

      // Already named AND delisted: no call, but STILL stamped, or the rotation
      // stalls on the same page forever.
      if (
        row.name &&
        row.name.trim() !== "" &&
        row.listingStatus !== "ACTIVE"
      ) {
        result.skippedNamed++;
        await stamp(row.id);
        continue;
      }

      let meta: TiingoDailyMetadata | null | undefined;
      try {
        meta = await fetchMetadata(row.symbol);
      } catch (error) {
        // The daily cap, or a 429 wall after the full ladder. Stop the run —
        // this row is NOT stamped, so it leads the next page.
        if (error instanceof TiingoRateLimitError) {
          result.rateLimited = true;
          result.error = error.message;
          break;
        }
        throw error;
      }
      result.fetched++;

      if (meta === undefined) {
        result.transportFailures++;
        await stamp(row.id);
        continue;
      }
      if (meta === null) {
        result.notFound++;
        await stamp(row.id);
        continue;
      }

      const outcome = resolveUsListingName(
        {
          symbol: row.symbol,
          exchange: row.exchange,
          listingStartDate: isoDay(row.listingStartDate),
        },
        meta,
      );

      if (outcome.kind === "resolved") {
        result.resolved++;
        // Guarded on ABSENCE in the WHERE, so a concurrent writer that already
        // filled the column wins and this is a no-op rather than a clobber. The
        // `isSet: false` arm is load-bearing: an absent field matches neither
        // `{name: null}` nor `{name: {not: null}}` (MONEY-1050), and the miss
        // would be silent because `updateMany` reports count 0 rather than
        // failing.
        const res = await prisma.usInstrument.updateMany({
          where: {
            id: row.id,
            OR: [{ name: null }, { name: "" }, { name: { isSet: false } }],
          },
          data: { name: outcome.name },
        });
        result.written += res.count;
      } else if (outcome.kind === "unnamed") {
        result.unnamed++;
      } else if (outcome.kind === "not-this-listing") {
        result.notThisListing++;
      } else {
        result.unverifiable++;
      }

      await stamp(row.id);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  console.log(
    `[us-instrument-names] selected=${result.selected} ` +
      `fetched=${result.fetched} skippedNamed=${result.skippedNamed} ` +
      `written=${result.written} unnamed=${result.unnamed} ` +
      `notThisListing=${result.notThisListing} ` +
      `unverifiable=${result.unverifiable} notFound=${result.notFound} ` +
      `transportFailures=${result.transportFailures} ` +
      `budgetExhausted=${result.budgetExhausted} ` +
      `rateLimited=${result.rateLimited}`,
  );

  return result;
}

/** ISO `YYYY-MM-DD` for a stored Date, or null. */
function isoDay(d: Date | null): string | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return d.toISOString().slice(0, 10);
}

async function stamp(id: string): Promise<void> {
  try {
    await prisma.usInstrument.update({
      where: { id },
      data: { nameSyncedAt: new Date() },
    });
  } catch {
    // A failed stamp costs this row another attempt next run; it must not cost
    // the run.
  }
}
