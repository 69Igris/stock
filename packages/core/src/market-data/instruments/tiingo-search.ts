/**
 * permaTicker enrichment via Tiingo's `utilities/search` — MONEY-1263.
 *
 * ## Why this exists at all
 *
 * The corporate-actions feed identifies securities by `permaTicker` and NOT by
 * our symbol, so without this column every action row would need a ticker join
 * that we already know to be unreliable — ticker reuse is live, and the batch
 * form returns two different companies both labelled `reax`.
 *
 * ## Why it is an ENRICHER and never an InstrumentProvider
 *
 * The same argument as the BSE scrip master and the EDGAR CIK join: a provider
 * whose symbol set does not match ours CREATES rows rather than filling a
 * column. Search publishes no listing window, so it could not even name a
 * `UsInstrument.listingId`. This only ever UPDATES rows already present, counts
 * what it could not match, and never throws — a metadata gap costs another
 * cycle, a thrown error costs the run.
 *
 * ## Now writes `us_instruments`, not `instrument_mappings` (MONEY-980 TASK B4)
 *
 * US securities moved to their own collection, so the `{market: "US"}`
 * discriminator is gone: the table IS the scope, and there is no longer any way
 * for this enricher to touch an Indian row.
 *
 * ## Why it is NOT a fix for ticker recycling
 *
 * Search resolves the CURRENT occupant only. `DOW` returns Dow Inc. and `BRKL`
 * returns "Corgi BRKB 2x Daily ETF" — never the delisted predecessor. So this
 * complements `Candle.listingId` and does not replace it. Anyone tempted to
 * make `permaTicker` the identity should read `resolveSearchMatch`'s header
 * first.
 *
 * ## Cost
 *
 * ONE request per symbol, paced through the SHARED `paceTiingoRequest`, so it
 * scales with the universe rather than with the calendar. It is therefore
 * rotation-marked (`searchSyncedAt`) and page-limited: the column is a durable
 * property, not a daily quantity, so there is no reason to re-resolve a symbol
 * that already has one.
 *
 * The page moved 500 -> `US_SEARCH_PAGE_SIZE` (800). See that constant for the
 * arithmetic; the short version is that 500 was sized for a table this leg
 * SHARED with ~20,804 Indian rows, and against an isolated, measured population
 * of 41,371 ACTIVE US listings it needed ~52 nights of a single un-chained run
 * to converge. The job now self-chains, so the real lever was the chain and not
 * the page — 7 runs x 800 = 5,600/night, converging in 8.
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
import { US_SEARCH_PAGE_SIZE } from "./us-instrument-names-logic";
import {
  parseSearchResponse,
  resolveSearchMatch,
  type SearchResolution,
} from "./tiingo-search-logic";

const TIINGO_SEARCH_URL = "https://api.tiingo.com/tiingo/utilities/search";
const TIINGO_REFERER = "https://www.tiingo.com/";

export interface TiingoSearchEnrichmentResult {
  /** Rows selected for resolution this run. */
  selected: number;
  /** Rows that resolved to exactly one US security. */
  resolved: number;
  /** Rows the endpoint had no US match for. */
  unmatched: number;
  /** Rows where several US securities share the ticker — deliberately unwritten. */
  ambiguous: number;
  /** Rows actually stamped. */
  written: number;
  /** Upstream calls that failed. Distinct from `unmatched`, which is an ANSWER. */
  transportFailures: number;
  /** The run stopped because the wall-clock budget expired. */
  budgetExhausted: boolean;
  /** The run stopped because Tiingo's daily cap was reached. */
  rateLimited: boolean;
  /** True when TIINGO_SEARCH_ENRICH=off — a deliberate skip, not a failure. */
  disabled: boolean;
  error?: string;
}

function apiKey(): string {
  const key = process.env.TIINGO_API_KEY?.trim();
  if (!key) throw new Error("TIINGO_API_KEY is not set");
  return key;
}

/**
 * One search call. Returns `null` for a transport failure.
 *
 * RETHROWS `TiingoRateLimitError` — and therefore all THREE of its subclasses:
 * `TiingoDailyCapError` (the pacer's own cap), `TiingoBudgetExhaustedError`
 * (the shared budget guard refusing the leg) and the ladder's terminal 429. All
 * three are stops, and the caller circuit-breaks on them. It used to be
 * swallowed by the blanket `catch` below, which is the precise failure
 * `tiingo-pacer.ts`'s own header warns about: the cap throws BEFORE any sleep,
 * so a swallowed one tore through every remaining row of the page in seconds,
 * recorded each as a transport failure, and left the job asking for more work at
 * the exact moment it had run out of allowance.
 *
 * The pacer used to sit OUTSIDE the try for that reason. It now sits INSIDE it,
 * within the `withTiingoBudget` callback (MONEY-1309), because the wrapper has
 * to ENCLOSE the request it charges for — it charges on resolve — and the
 * request has to stay inside the try that turns a transport failure into
 * `null`. What keeps that safe is the `instanceof TiingoRateLimitError`
 * re-throw below: it is now the one arm holding three stops open rather than
 * one, so it must never be narrowed to a concrete class.
 */
async function search(ticker: string): Promise<SearchResolution | null> {
  const url = `${TIINGO_SEARCH_URL}?query=${encodeURIComponent(ticker)}`;
  try {
    // Budgeted, then paced, then fetched (MONEY-1309).
    //
    // The budget CHECK is OUTER and the pacer INNER, the same ordering as
    // `tiingo-client.ts`, so a refusal costs zero sleep rather than a full
    // inter-request gap — and so the pacer's `TiingoDailyCapError` is thrown
    // inside the wrapper, which re-throws it untouched instead of treating it
    // as a 429 and parking the leg for five minutes.
    //
    // This leg is PER SYMBOL against a ~41,371-row active population, so it is
    // one of the two that can actually exhaust an account on its own. It was
    // unwired until MONEY-1309 — see `tiingo-budget-wiring.test.ts` for what
    // that did to the shared counter.
    const res = await withTiingoBudget("search", async () => {
      // The SHARED pacer, not a local delay. A flat sleep would have ignored
      // `TIINGO_PLAN` entirely, pacing identically on a plan with four times
      // the ceiling.
      await paceTiingoRequest();
      return getFeedAsset(
        url,
        TIINGO_REFERER,
        {
          exchange: "TIINGO",
          feed: "search",
          // Undated: a security's permaTicker is a durable property, so "as it
          // stands now" is the right semantics and an un-rotating key can never
          // race the prod->QA mirror. Per-ticker basename, or all ~72k symbols
          // would archive over one another.
          basename: `search-${ticker.toUpperCase()}.json`,
        },
        undefined,
        {
          headers: {
            Authorization: `Token ${apiKey()}`,
            Accept: "application/json",
            Origin: null,
            Referer: null,
          },
        },
      );
    });
    if (res === null) return { kind: "unmatched" };
    const text = await res.text();
    // The monthly BANDWIDTH meter, from the bytes actually read (MONEY-1309).
    // One search response is small, but the leg is one request per symbol and
    // the full enrichment is ~41k of them — a per-call number too small to
    // notice is exactly the kind that goes unmetered and then explains a
    // month's overage nobody can attribute.
    await recordBytes(Buffer.byteLength(text, "utf8"));
    return resolveSearchMatch(ticker, parseSearchResponse(text));
  } catch (error) {
    if (error instanceof TiingoRateLimitError) throw error;
    // A REAL 429 IS NOT A TRANSPORT FAILURE (MONEY-1309).
    //
    // The `instanceof` above only sees a TYPED rate limit, and this leg has no
    // retry ladder to construct one: the request goes straight through
    // `getFeedAsset`, whose seam throws a PLAIN `Error` reading
    // `Exchange fetch failed: 429 Too Many Requests (...)`. So before this arm
    // a 429 fell into `return null`, which the caller books as a
    // `transportFailure` — and, worse, STAMPS the row for. The rotation then
    // moves on, so a rate limit was recorded as "we asked and there was
    // nothing there", and the row went to the back of an 8-night rotation
    // having never been asked at all.
    //
    // Re-thrown as the TYPED error the caller's circuit-break arm is written
    // against, so a 429 stops the run and leaves the row unstamped to lead the
    // next page. `withTiingoBudget` has already parked this leg on the way out.
    if (isTiingoRateLimitFailure(error)) {
      throw new TiingoRateLimitError(`search ${ticker}`);
    }
    return null;
  }
}

/**
 * Stamp `permaTicker` / `openFIGIComposite` on US rows that lack one.
 *
 * Never throws.
 */
export async function enrichUsInstrumentsWithPermaTicker(
  options: { limit?: number; deadlineAtMs?: number } = {},
): Promise<TiingoSearchEnrichmentResult> {
  const result: TiingoSearchEnrichmentResult = {
    selected: 0,
    resolved: 0,
    unmatched: 0,
    ambiguous: 0,
    written: 0,
    transportFailures: 0,
    budgetExhausted: false,
    rateLimited: false,
    disabled: false,
  };

  // `.trim()` before `.toLowerCase()`, matching `US_NAME_ENRICH` and
  // `US_MASTER_SYNC`. Both cloudbuild specs present these flags as one family
  // that behaves identically, and without the trim `"off "` — a trailing space
  // is trivially introduced in YAML — disabled some of them and silently armed
  // the rest. Compared against the LITERAL string, never `Boolean()`:
  // `Boolean("false")` is `true`, which would arm the one configuration meant
  // to keep it off.
  if ((process.env.TIINGO_SEARCH_ENRICH ?? "").trim().toLowerCase() === "off") {
    result.disabled = true;
    return result;
  }

  // Checked ONCE, before the rotation query. `apiKey()` throws, and inside the
  // per-row `search()` that throw is caught by the blanket `catch` that
  // converts a failure to `null` — which the loop below counts as a
  // `transportFailure` and then STAMPS the row for. So a missing secret would
  // burn a whole page of rotation stamps (800/run x up to 7 chained runs =
  // 5,600 ACTIVE rows a night), report 5,600 "upstream failures" against an
  // upstream that was never called, and push every one of those rows to the
  // back of an 8-night rotation while writing no `permaTicker` at all. A
  // missing secret must be one loud failure, not 5,600 quiet ones.
  //
  // Same guard, same words, as `us-instrument-names.ts` — the sibling leg with
  // the identical rotation + stamp shape.
  try {
    apiKey();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`[tiingo-search] ${result.error}`);
    return result;
  }

  const deadlineAtMs = options.deadlineAtMs ?? Number.POSITIVE_INFINITY;

  try {
    // ACTIVE listings only — search resolves the CURRENT occupant of a ticker,
    // so a delisted predecessor would be handed its successor's permaTicker.
    // That is a wrong join key on the corporate-actions feed, i.e. another
    // company's dividends and splits, silently.
    //
    // Ordered by the rotation marker and NEVER filtered on it: on Mongo the
    // marker is ABSENT rather than null on every unstamped row, so
    // `{searchSyncedAt: null}` matches ZERO (MONEY-1050/1205/1234/1236). A
    // missing field sorts lowest, so unstamped rows lead under `asc`, which is
    // exactly the order this wants. `listingId` is the tiebreak because it is
    // the model's only unique, which makes the ordering TOTAL — ordering by the
    // marker alone leaves every unstamped row equal and lets two runs return
    // overlapping pages.
    const rows = await prisma.usInstrument.findMany({
      where: { listingStatus: "ACTIVE" },
      select: { id: true, symbol: true, permaTicker: true },
      orderBy: [{ searchSyncedAt: "asc" }, { listingId: "asc" }],
      take: options.limit ?? US_SEARCH_PAGE_SIZE,
    });
    result.selected = rows.length;

    for (const row of rows) {
      // Checked BETWEEN items, so the true wall is `budget + one request`.
      if (Date.now() >= deadlineAtMs) {
        result.budgetExhausted = true;
        break;
      }

      // Already resolved: skip the call but STILL stamp, or the rotation stalls
      // on the same page forever. Stamping every visited row — not only the
      // ones that produced a write — is the rule `stock-document-sync` had to
      // learn twice.
      if (row.permaTicker) {
        await stamp(row.id);
        continue;
      }

      let outcome: SearchResolution | null;
      try {
        outcome = await search(row.symbol);
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
      if (outcome === null) {
        result.transportFailures++;
        await stamp(row.id);
        continue;
      }

      if (outcome.kind === "resolved") {
        result.resolved++;
        // Guarded on ABSENCE in the WHERE, so a concurrent writer that already
        // filled the column wins and this is a no-op rather than a clobber. The
        // `isSet: false` arm is load-bearing: on Prisma+Mongo an absent field
        // matches neither `{f: null}` nor `{f: {not: null}}` (MONEY-1050).
        const res = await prisma.usInstrument.updateMany({
          where: {
            id: row.id,
            OR: [
              { permaTicker: null },
              { permaTicker: "" },
              { permaTicker: { isSet: false } },
            ],
          },
          data: {
            permaTicker: outcome.permaTicker,
            openFIGIComposite: outcome.openFIGIComposite,
          },
        });
        result.written += res.count;
      } else if (outcome.kind === "ambiguous") {
        result.ambiguous++;
      } else {
        result.unmatched++;
      }

      await stamp(row.id);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function stamp(id: string): Promise<void> {
  try {
    await prisma.usInstrument.update({
      where: { id },
      data: { searchSyncedAt: new Date() },
    });
  } catch {
    // A failed stamp costs this row another attempt next run; it must not cost
    // the run.
  }
}
