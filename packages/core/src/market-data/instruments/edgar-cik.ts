/**
 * EDGAR CIK enrichment — MONEY-980.
 *
 * Fills `UsInstrument.cik` for ACTIVE US listings from the SEC's public
 * `company_tickers.json`. The CIK is the durable identity of a US filer — what
 * ISIN is for an Indian one, and the join key any future US filings, XBRL or
 * ownership ingest needs. Nothing Tiingo publishes can produce it.
 *
 * MOVED OFF `instrument_mappings` (MONEY-980 TASK B4). US securities now live
 * in their own collection, so this enricher no longer needs — or has — a
 * `{market: "US"}` discriminator: the table IS the scope. That removes the one
 * way this file could ever have touched an Indian row.
 *
 * UPDATE-ONLY, and never a provider. See the header of `edgar-cik-logic.ts` for
 * why (an enricher cannot create a row; a provider upserting on a key EDGAR
 * cannot supply would have to invent half of it), and for what carries the
 * safety of the join in the absence of a name corroboration.
 *
 * Never throws. This runs after the instrument sync and must not be able to
 * fail it: a missing CIK costs another day of waiting, a thrown error costs the
 * whole sync.
 */

import { prisma } from "@usemoney/database";

import { getFeedAsset } from "../feed-archive";
import {
  buildEdgarCikIndex,
  diagnoseEdgarFeed,
  parseEdgarCompanyTickers,
  planEdgarCikEnrichment,
  UNMATCHED_SAMPLE_LIMIT,
  type EdgarTickerRow,
} from "./edgar-cik-logic";

/**
 * The SEC's ticker -> CIK map. One public static object, no auth, no key.
 *
 * Measured 2026-08-28: 795,179 bytes, 10,391 entries, zero duplicate tickers.
 */
export const EDGAR_COMPANY_TICKERS_URL =
  "https://www.sec.gov/files/company_tickers.json";

/**
 * SEC's Internet-access policy REQUIRES a descriptive User-Agent naming the
 * requester, and enforces it: measured 2026-08-28, the same URL answers 403
 * with curl's default UA and 200 with this one. This is not
 * browser-impersonation — it is the identification SEC asks for, so it says
 * what we are and how to reach us.
 */
export const EDGAR_USER_AGENT = "UseMoney/1.0 (deepshaswat@gmail.com)";

/** Referer passed to the seam. SEC does not require one; it is deleted below. */
const EDGAR_REFERER = "https://www.sec.gov/";

/**
 * Routed through `getFeedAsset` (the MONEY-1085 archive seam), which required
 * opening `FeedDescriptor.exchange` to a `SEC` member.
 *
 * The union is closed on purpose — so a typo cannot mint an archive prefix
 * nothing ever replays — and adding a member is a deliberate act, not a
 * convenience. It earns its place here for the MONEY-1157 reason: a host nobody
 * listed is a host nobody protects. `www.sec.gov` is now in `FEED_HOSTS`, so a
 * future raw `fetch()` in this file fails the bypass suite by name and line
 * instead of quietly leaving the archive.
 *
 * Two properties come with it. Prod archives the object under
 * `feeds/SEC/company-tickers/current/company_tickers.json` — UNDATED, because
 * "the map as it stands now" is exactly what an un-rotating `current/` key
 * means, and an undated key can never race the 00:45 IST prod->QA mirror. QA
 * then replays those bytes rather than fetching SEC a second time.
 *
 * THE COST, stated rather than hidden: the seam hands back a `Response` on
 * success and THROWS on any non-OK status, so the `Retry-After` header is no
 * longer readable at the failure site and the ladder below falls back to pure
 * exponential backoff. That is an acceptable loss at this volume — ONE 795 KB
 * request per night against a public static object, four orders of magnitude
 * inside SEC's published 10 req/s limit — and it would NOT be acceptable for a
 * per-symbol feed, where honouring the server's own backoff is the difference
 * between a slow run and a blocked one.
 */
const FETCH_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const EDGAR_TIMEOUT_MS = 60_000;

/**
 * Backoff for one attempt: PURE exponential, capped at 30s. No `Retry-After`.
 *
 * ## Why the parameter is gone (MONEY-980 review, finding 9)
 *
 * It could never have worked from here. The archive seam returns a `Response`
 * only on success and THROWS on every non-OK status (see the block comment
 * above `FETCH_ATTEMPTS`), so by the time this ladder decides how long to wait,
 * the failing response — and with it the header — no longer exists.
 *
 * The previous signature was `(attempt, retryAfterSeconds: number | null)`, and
 * its comment cited the BSE scrip master's defect — "the only call site passed
 * `null`, so the parameter was dead" — as something this version had FIXED. It
 * had not. The single call site passed a local initialised to `null` and
 * reassigned to `null` on BOTH the success and the failure path, so the
 * `Retry-After` branch was unreachable in precisely the way the comment was
 * warning about. Naming a bug is not protection from it; deleting the parameter
 * is, and it leaves the code, this comment and the seam's stated cost all
 * saying the same thing.
 *
 * Restoring the capability means reading the header where it still exists —
 * inside `exchange-feed.ts` — and threading it out of the seam. That is a
 * change to a shared primitive, and one 795 KB nightly request against a public
 * static object, four orders of magnitude inside SEC's 10 req/s limit, does not
 * justify it.
 *
 * Exported (and prefixed, because `brokers/clients/base-client.ts` exports its
 * own `backoffMs`) ONLY so the shape is testable: a `.length` assertion is what
 * stops a dead parameter from being reintroduced under a comment claiming
 * otherwise.
 */
export function edgarBackoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, 30_000);
}

export interface EdgarCikEnrichmentResult {
  /** EDGAR entries parsed out of the payload. */
  fetched: number;
  /** Active US rows whose ticker resolved to a CIK. */
  matched: number;
  /** Active US rows EDGAR has no entry for. Large is NORMAL — see the planner. */
  unmatched: number;
  /**
   * `unmatched` split by venue — MONEY-1353.
   *
   * A single integer cannot tell the steady state from a defect. Measured on
   * prod 2026-09-05, 1,170 of 8,282 ACTIVE US stocks (14.1%) carry no CIK, and
   * the split is NASDAQ 531 / NYSE 377 / BATS 212 / AMEX 24 / NYSE MKT 14 /
   * NYSE ARCA 12 — a shape, not a number, and one venue leaving it is the thing
   * worth paging about.
   */
  unmatchedByExchange: Record<string, number>;
  /**
   * The first {@link UNMATCHED_SAMPLE_LIMIT} unmatched tickers. BOUNDED: the
   * full list is 1,170 entries and a log line that long is a log line nobody
   * reads. `scripts/data/us-cik-unmatched-report.ts` owns the whole population.
   */
  unmatchedSample: string[];
  /** Rows this run actually stamped. */
  cikWritten: number;
  /** Tickers dropped because two EDGAR entries claimed different CIKs. */
  ambiguous: number;
  /** True when EDGAR_CIK_ENRICH=off — a deliberate skip, not a failure. */
  disabled: boolean;
  /** Matched rows that already had a CIK, so nothing was planned. */
  alreadySet: number;
  /**
   * Matched only after `.`/`-` punctuation normalisation.
   *
   * THIS NUMBER FELL BY TWO ORDERS OF MAGNITUDE IN MONEY-1353 AND THAT IS THE
   * FIX, NOT A REGRESSION. Measured against prod's 41,261 ACTIVE rows: 385
   * before, 11 after. The 374 that left are preferreds, and they left because
   * `matchedSecForm` now claims them — resolved by SEC's own spelling against
   * the ambiguity-disambiguated index, instead of by a key that discards the
   * character separating `T-PC` (AT&T) from `TPC` (Tutor Perini). Same CIKs,
   * measured: zero disagreements between the two paths. Anyone watching the
   * sync-log metadata should read `matchedNormalised + matchedSecForm` across
   * that release boundary, not either half.
   */
  matchedNormalised: number;
  /**
   * Matched only after rewriting our `-P-<series>` preferred spelling into
   * SEC's `-P<series>`. An EXACT hit on the disambiguated index — see
   * `toSecPreferredForm`. Measured on prod 2026-09-05: 377, of which 3 were
   * previously UNMATCHED (the rest already carried a CIK).
   */
  matchedSecForm: number;
  /**
   * US rows excluded because they are DELISTED. Reported because the exclusion
   * is a real coverage decision, not a filter detail: `company_tickers.json`
   * describes who is registered today, and stamping a recycled ticker's current
   * registrant onto a dead predecessor's row is the failure this avoids.
   */
  skippedDelisted: number;
  error?: string;
}

/**
 * `EDGAR_CIK_ENRICH` — the off switch for this leg.
 *
 * ONE definition for what was two copies of the same expression, in two
 * functions, ~145 lines apart: the fetch consulted it to decide whether to
 * call SEC, and the enricher consulted it again to decide whether 0 rows meant
 * "disabled" or "dead". Two statements of one rule is exactly how they drift
 * into disagreeing — and a drift here reports a deliberate kill switch as a
 * dead upstream, which pages someone for a configuration choice.
 *
 * `.trim()` before `.toLowerCase()`, matching `US_NAME_ENRICH` and
 * `US_MASTER_SYNC`. Both cloudbuild specs present these flags as one family
 * that behaves identically, and without the trim `"off "` — a trailing space
 * is trivially introduced in YAML — disabled some of them and silently armed
 * the rest. Compared against the LITERAL string, never `Boolean()`:
 * `Boolean("false")` is `true`, which would arm the one configuration meant to
 * keep it off.
 *
 * Read PER CALL, never captured in a module const — a module-scope read freezes
 * at import, so a worker that loads config after boot (or a test that sets the
 * env afterwards) silently gets the default. That exact bug is documented on
 * `bse-client.ts`'s retry config.
 */
function isEdgarCikEnrichDisabled(): boolean {
  return (process.env.EDGAR_CIK_ENRICH ?? "").trim().toLowerCase() === "off";
}

/**
 * Fetch + parse the SEC map, with backoff. Returns [] when unavailable.
 *
 * A 404 is not transient and does not spend retries. Anything 429/5xx or a
 * transport failure does.
 */
export async function fetchEdgarCompanyTickers(): Promise<EdgarTickerRow[]> {
  if (isEdgarCikEnrichDisabled()) {
    console.warn(
      "EDGAR CIK: disabled by EDGAR_CIK_ENRICH=off — skipping fetch",
    );
    return [];
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = edgarBackoffMs(attempt - 1);
      console.warn(
        `EDGAR CIK: retrying in ${wait}ms (attempt ${attempt + 1}/${FETCH_ATTEMPTS})`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await getFeedAsset(
        EDGAR_COMPANY_TICKERS_URL,
        EDGAR_REFERER,
        {
          exchange: "SEC",
          feed: "company-tickers",
          // The URL path already ends in `company_tickers.json`, but naming it
          // explicitly keeps the archived object's name and content-type stable
          // if the path ever moves.
          basename: "company_tickers.json",
        },
        undefined,
        {
          headers: {
            // SEC's access policy REQUIRES a descriptive User-Agent and
            // enforces it (403 with curl's default, 200 with ours). The seam's
            // browser-impersonation defaults are deleted: this is
            // identification, not impersonation, and SEC is not a site that
            // wants an Origin.
            "User-Agent": EDGAR_USER_AGENT,
            Accept: "application/json,*/*",
            Origin: null,
            Referer: null,
          },
          timeoutMs: EDGAR_TIMEOUT_MS,
        },
      );

      // `fetchExchangeAsset` maps 404 -> null. For a static published file that
      // is "SEC moved or withdrew it", which no amount of retrying fixes.
      if (res === null) {
        console.warn("EDGAR CIK: company_tickers.json not available (404)");
        return [];
      }

      return parseEdgarCompanyTickers(await res.text());
    } catch (error) {
      // The seam throws for every non-OK status as well as transport failures,
      // so both classes land here and the status is only readable as text.
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const status = Number(/failed:\s*(\d{3})/.exec(msg)?.[1] ?? 0);
      // 4xx other than 429 is a permanent answer — do not spend the ladder.
      if (status >= 400 && status < 500 && status !== 429) break;
    }
  }

  console.warn(
    `EDGAR CIK: giving up after retries — ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return [];
}

/**
 * Stamp `cik` on ACTIVE US rows that do not have one.
 *
 * Never throws — see the module header.
 */
export async function enrichUsInstrumentsWithCik(): Promise<EdgarCikEnrichmentResult> {
  const result: EdgarCikEnrichmentResult = {
    fetched: 0,
    matched: 0,
    unmatched: 0,
    unmatchedByExchange: {},
    unmatchedSample: [],
    cikWritten: 0,
    ambiguous: 0,
    disabled: false,
    alreadySet: 0,
    matchedNormalised: 0,
    matchedSecForm: 0,
    skippedDelisted: 0,
  };

  /**
   * Persist the outcome. Called from `finally`, so it is reachable from EVERY
   * exit — not just the happy path.
   *
   * The BSE enricher learned this the hard way: its write sat inline at the end
   * of the `try` and was therefore unreachable from the three failure modes
   * that matter most — a 0-row early return above it, a throw during the writes
   * below it, and the kill switch, which returns down the same 0-row path and
   * so was indistinguishable from a dead feed.
   */
  const writeSyncLog = async (): Promise<void> => {
    await prisma.marketDataSyncLog
      .create({
        data: {
          syncType: "INSTRUMENT_SYNC",
          source: "EDGAR_CIK",
          status: result.disabled
            ? "SKIPPED"
            : result.error
              ? "FAILED"
              : "COMPLETED",
          recordsProcessed: result.cikWritten,
          // An unmatched row is one this feed could not enrich, which is what
          // `recordsFailed` means. `ambiguous` counts here too and ONLY here —
          // the BSE version double-counted its equivalent for a release, then
          // over-corrected to counting it zero times.
          recordsFailed: result.unmatched + result.ambiguous,
          errorMessage: result.error ?? null,
          completedAt: new Date(),
          metadata: {
            fetched: result.fetched,
            matched: result.matched,
            matchedNormalised: result.matchedNormalised,
            matchedSecForm: result.matchedSecForm,
            unmatched: result.unmatched,
            unmatchedByExchange: result.unmatchedByExchange,
            unmatchedSample: result.unmatchedSample,
            cikWritten: result.cikWritten,
            alreadySet: result.alreadySet,
            ambiguous: result.ambiguous,
            skippedDelisted: result.skippedDelisted,
          },
        },
      })
      // Never let observability fail the enrichment it observes.
      .catch((e) => console.warn("EDGAR CIK: sync log write failed:", e));
  };

  try {
    const rows = await fetchEdgarCompanyTickers();
    result.fetched = rows.length;

    if (rows.length === 0) {
      // Distinguish a DISABLED feed from a DEAD one. Both produce 0 rows, and
      // reporting the kill switch as a failure would page someone for a
      // deliberate configuration choice.
      result.disabled = isEdgarCikEnrichDisabled();
      result.error = result.disabled
        ? undefined
        : "EDGAR company_tickers.json returned 0 usable rows";
      if (result.error) console.warn(`EDGAR CIK enrichment: ${result.error}`);
      return result;
    }

    const index = buildEdgarCikIndex(rows);
    result.ambiguous = index.ambiguousTickers.length;
    if (index.ambiguousTickers.length > 0) {
      // Loud, because it means SEC's own file disagrees with itself about which
      // company a ticker names — and a wrong CIK attaches another company's
      // filings to this security.
      console.warn(
        `EDGAR CIK: ${index.ambiguousTickers.length} tickers map to more than ` +
          `one CIK and were DROPPED (not resolved): ` +
          `${index.ambiguousTickers.slice(0, 8).join(", ")}`,
      );
    }

    /**
     * ACTIVE US listings only.
     *
     * The `{market: "US"}` clause is GONE because the table is the scope —
     * `us_instruments` holds nothing else. What has NOT changed is why `cik` is
     * absent from the WHERE: on Prisma+Mongo an attribute that was never
     * written is ABSENT rather than null, so `{cik: null}` matches ZERO rows —
     * the class that caused MONEY-1050, -1205, -1234 and -1235. It is SELECTED
     * and the emptiness is decided in the planner from the value in hand. A
     * projection reads absent as null safely; only a filter cannot.
     *
     * `listingStatus: "ACTIVE"` is the recycling guard, not a tidy-up, and it
     * matters MORE here than it did on the old table: `us_instruments`
     * deliberately keeps 31,314 delisted listings, including 1,440 that share a
     * ticker with another listing. `company_tickers.json` describes who is
     * registered TODAY, so stamping it onto a dead predecessor attaches the
     * successor's SEC filings to the wrong company. See the logic file's header.
     */
    const stored = await prisma.usInstrument.findMany({
      where: { listingStatus: "ACTIVE" },
      // `exchange` is selected for the unmatched BREAKDOWN, not for the join —
      // EDGAR's file carries no venue at all. See `EdgarCikPlan`.
      select: { id: true, symbol: true, cik: true, exchange: true },
    });

    const delistedCount = await prisma.usInstrument.count({
      where: { listingStatus: "DELISTED" },
    });
    result.skippedDelisted = delistedCount;

    const plan = planEdgarCikEnrichment(index, stored);
    result.matched = plan.matched;
    result.matchedNormalised = plan.matchedNormalised;
    result.matchedSecForm = plan.matchedSecForm;
    result.unmatched = plan.unmatched;
    result.unmatchedByExchange = plan.unmatchedByExchange;
    result.unmatchedSample = plan.unmatchedSample;
    result.alreadySet = plan.alreadySet;

    // Bounded concurrency, mirroring `UPSERT_CONCURRENCY = 10` in
    // instrument-sync.ts and the BSE enricher's ISIN writes. Each CIK is
    // row-specific so these cannot be batched into one updateMany, and the
    // FIRST run faces thousands of them inside a job whose Pub/Sub ack deadline
    // is 600s — an overrun means Pub/Sub redelivers while this run is still
    // executing.
    const WRITE_CONCURRENCY = 10;
    for (let w = 0; w < plan.updates.length; w += WRITE_CONCURRENCY) {
      const slice = plan.updates.slice(w, w + WRITE_CONCURRENCY);
      const counts = await Promise.all(
        slice.map(async ({ id, cik }) => {
          // Guarded on absence in the WHERE as well as in the plan, so a
          // concurrent writer cannot lose a race and have us overwrite a CIK
          // that just landed. `isSet: false` covers a document that never had
          // the field, which none of the other clauses match under
          // Prisma+Mongo (the MONEY-1050 gotcha) — and the miss would be
          // silent, since updateMany reports count 0 rather than failing.
          const res = await prisma.usInstrument.updateMany({
            where: {
              id,
              OR: [{ cik: null }, { cik: "" }, { cik: { isSet: false } }],
            },
            data: { cik },
          });
          return res.count;
        }),
      );
      result.cikWritten += counts.reduce((a, b) => a + b, 0);
    }

    // Health check as a real (tested) predicate rather than an inline
    // condition. A converged run matches plenty and writes NOTHING, so
    // "planned no writes" must never be the failure signal.
    result.error =
      diagnoseEdgarFeed({
        fetched: rows.length,
        indexedTickers: index.byTicker.size,
        candidates: stored.length,
        matched: plan.matched,
      }) ?? result.error;

    console.log(
      `EDGAR CIK enrichment: ${result.fetched} entries, ` +
        `${stored.length} active US listings, ${result.matched} matched ` +
        `(${result.matchedNormalised} via punctuation variant, ` +
        `${result.matchedSecForm} via SEC preferred form, ` +
        `${result.unmatched} unmatched — reported, not created), ` +
        `${result.cikWritten} CIKs written, ${result.alreadySet} already set, ` +
        `${result.skippedDelisted} delisted rows excluded`,
    );

    // The refusal, made legible. `unmatched` alone could not distinguish the
    // steady state (SEC's file does not list every SPAC warrant) from one venue
    // dropping out, and neither could anyone reading it. Emitted only when
    // there IS a refusal, so a fully-joined universe stays quiet.
    if (result.unmatched > 0) {
      const venues = Object.entries(result.unmatchedByExchange)
        .sort((a, b) => b[1] - a[1])
        .map(([venue, n]) => `${venue} ${n}`)
        .join(", ");
      console.log(
        `EDGAR CIK unmatched by exchange: ${venues} — first ` +
          `${Math.min(result.unmatchedSample.length, UNMATCHED_SAMPLE_LIMIT)}: ` +
          `${result.unmatchedSample.join(", ")} ` +
          `(full breakdown: scripts/data/us-cik-unmatched-report.ts)`,
      );
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.warn(
      `EDGAR CIK enrichment failed (sync unaffected): ${result.error}`,
    );
  } finally {
    // Every exit lands here: success, 0 rows, kill switch, or a throw mid-write.
    await writeSyncLog();
  }

  return result;
}
