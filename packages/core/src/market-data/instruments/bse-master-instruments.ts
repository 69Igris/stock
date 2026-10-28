/**
 * BSE scrip master enrichment (MONEY-1093).
 *
 * Fills `InstrumentMapping.series` (the BSE group letter) and `isin` for the
 * whole active BSE universe in one pass, instead of waiting ~10 trading days
 * for the daily bhavcopy to happen to include each instrument.
 *
 * UPDATE-ONLY. See the header of `bse-master-logic.ts` for why this is not an
 * `InstrumentProvider`, and for why it deliberately does not write
 * `instrumentType` even though BSE's `Segment` field would allow it.
 */

import { prisma } from "@usemoney/database";

import { BSE_REFERER } from "../exchange-feed";
import { getFeedAsset } from "../feed-archive";
import {
  parseBseMasterJson,
  planBseMasterEnrichment,
  diagnoseBseFeed,
  type BseMasterRow,
} from "./bse-master-logic";

/**
 * BSE's "List of Scrips" API.
 *
 * `segment=Debt` is NOT a typo and NOT a debt filter — it is how this endpoint
 * returns the FULL active universe. Measured 2026-07-30:
 *
 *   segment=Debt   → 12,612 rows (Debentures and Bonds, Equity, Commercial
 *                    Papers, MF, PreferenceShares, and blanks)
 *   segment=Equity →  4,926 rows (equity only)
 *   segment=       →      0 rows
 *
 * So the parameter behaves as a lower bound over BSE's internal segment
 * ordering rather than an equality filter. Anyone "fixing" this to
 * `segment=Equity` would silently drop every bond — i.e. exactly the rows this
 * module exists to classify.
 */
export const BSE_SCRIP_MASTER_URL =
  "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w" +
  "?Group=&Scripcode=&industry=&segment=Debt&status=Active";

export interface BseMasterEnrichmentResult {
  fetched: number;
  matched: number;
  unmatched: number;
  seriesWritten: number;
  isinWritten: number;
  /** Symbol matched but ISINs disagreed — skipped, not guessed at. */
  isinConflicts: number;
  /** True when BSE_MASTER_ENRICH=off — a deliberate skip, not a failure. */
  disabled: boolean;
  /**
   * Symbol matches whose `series`/`isin` were withheld because neither an ISIN
   * nor a company name corroborated the scrip_id/tradingsymbol identity.
   */
  uncorroborated: number;
  /** Stored rows sharing an ISIN, making ISIN-fallback ambiguous. */
  duplicateStoredIsins: number;
  error?: string;
}

/**
 * Retry policy for `api.bseindia.com`.
 *
 * `getFeedAsset` -> `fetchExchangeAsset` throws on any non-404 with no retry, no
 * backoff and no `Retry-After` handling. That host is rate-limited enough that
 * `bse-announcements-sync-daily` is confined to PROD_ONLY_JOBS — while this
 * enricher rides `instrument-sync-daily`, which runs on QA *and* prod, so both
 * environments hit it nightly.
 *
 * `packages/research/src/data-sources/bse-client.ts` already implements exactly
 * this for the same host. It cannot be reused here: `packages/research` depends
 * on `packages/core`, not the reverse. Hoisting a shared retry into
 * `exchange-feed.ts` is the right follow-up, but that seam also carries the daily
 * price seed, so widening its behaviour is deliberately not done in this change.
 *
 * ## Which environments hit this host
 *
 * Stated plainly, because it is a real tension with the SCRAPE-ONCE-IN-PROD
 * policy: this enricher rides `instrument-sync-daily`, which is NOT in
 * `PROD_ONLY_JOBS` — QA needs the Zerodha instrument dump from that same job,
 * and `instrument_mappings` is a QA-DIRECT collection so QA cannot be fed from
 * prod. `bhavcopy-sync-daily` is in exactly the same position and already
 * scrapes both exchanges on QA.
 *
 * The designed mitigation is the feed archive: this fetch goes through
 * `getFeedAsset`, so with `FEED_ARCHIVE_MODE=archive` on prod and `replay` on
 * QA, QA reads prod's archived bytes and never touches BSE. Both are ARMED as of
 * 2026-08-12 — `workers/cloudbuild.prod.yaml` sets "archive",
 * `workers/cloudbuild.qa.yaml` sets "replay" — so QA no longer hits this host
 * nightly. This feed is one of the cases where that actually holds: the
 * descriptor below passes NO `date`, so `buildFeedArchiveKey` files it under
 * `current/` and every run overwrites in place. A key that never rotates cannot
 * outrun the 00:45 IST prod->QA mirror, so QA's replay hits every night, at
 * worst serving prod's copy from the previous day — the right staleness for "the
 * master as it stands now". A DATED feed gets no such guarantee: its key rotates
 * daily, so whether replay hits depends on the mirror having run since prod
 * archived that day's key.
 *
 * The retry below stays load-bearing regardless: prod still fetches BSE for
 * real, any env with `FEED_ARCHIVE_MODE` unset (local dev, and the documented
 * default for a new env) fetches, and a replay miss deliberately falls back to
 * the exchange.
 *
 * `BSE_MASTER_ENRICH=off` disables the fetch entirely, per environment, without
 * a code change — still the quickest lever if the shared egress IP becomes a
 * problem.
 */
const FETCH_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;

/**
 * Backoff for one attempt, honouring `Retry-After` when the server sent one.
 *
 * The parameter used to be dead: the only call site passed `null`, so the header
 * was never read — while the block comment above framed this whole retry as
 * fixing `fetchExchangeAsset`'s "no Retry-After handling". `getFeedAsset`
 * throws rather than returning the response, so the header is recovered from the
 * error message, which is where the status code already comes from.
 */
function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (
    retryAfterSeconds !== null &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    return Math.min(retryAfterSeconds * 1_000, 30_000);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, 30_000);
}

/**
 * `Retry-After` seconds parsed out of a thrown fetch error, when present.
 *
 * `fetchExchangeAsset` throws `Exchange fetch failed: <status> <statusText>`
 * and does not surface headers, so this is best-effort: a numeric
 * `retry-after: N` embedded in the message is honoured, anything else falls
 * back to exponential backoff. Returning null is the normal case.
 */
function retryAfterFromError(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const m = /retry-?after[":\s]+(\d+)/i.exec(msg);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Fetch + parse the master, with backoff. Returns [] when unavailable. */
export async function fetchBseScripMaster(): Promise<BseMasterRow[]> {
  if ((process.env.BSE_MASTER_ENRICH ?? "").toLowerCase() === "off") {
    console.warn(
      "BSE scrip master: disabled by BSE_MASTER_ENRICH=off — skipping fetch",
    );
    return [];
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = backoffMs(attempt - 1, retryAfterFromError(lastError));
      console.warn(
        `BSE scrip master: retrying in ${wait}ms (attempt ${attempt + 1}/${FETCH_ATTEMPTS})`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await getFeedAsset(BSE_SCRIP_MASTER_URL, BSE_REFERER, {
        exchange: "BSE",
        feed: "scrip-master",
        // This URL is a REST route, not a file: its path ends `/ListofScripData/w`,
        // so the derived basename was the single letter `w` with content-type
        // `application/octet-stream`. `basename` names the object AND picks the
        // content type. The `segment` value still reaches the key via
        // `buildFeedArchiveKey`'s query discriminator, so the `segment=Equity`
        // variant this module warns about can never overwrite this one.
        basename: "bse-scrip-master.json",
      });
      if (!res) {
        // A genuine 404 is not a transient condition — do not spend retries.
        console.warn("BSE scrip master: not available (404)");
        return [];
      }
      return parseBseMasterJson(await res.text());
    } catch (error) {
      lastError = error;
      // 4xx other than 429 will not become truthy by waiting.
      const msg = error instanceof Error ? error.message : String(error);
      const transient =
        /\b(429|5\d\d)\b/.test(msg) || /fetch failed/i.test(msg);
      if (!transient) break;
    }
  }

  console.warn(
    `BSE scrip master: giving up after retries — ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return [];
}

/**
 * Enrich existing BSE rows from the scrip master.
 *
 * Never throws: this runs after the instrument sync and must not be able to
 * fail it. A metadata gap costs another day of waiting; a thrown error costs
 * the whole sync.
 */
export async function enrichBseInstrumentsFromMaster(): Promise<BseMasterEnrichmentResult> {
  const result: BseMasterEnrichmentResult = {
    fetched: 0,
    matched: 0,
    unmatched: 0,
    seriesWritten: 0,
    isinWritten: 0,
    isinConflicts: 0,
    disabled: false,
    uncorroborated: 0,
    duplicateStoredIsins: 0,
  };

  /**
   * Persist the outcome. Called from `finally`, so it is reachable from EVERY
   * exit — not just the happy path.
   *
   * It used to sit inline at the end of the `try`, which made it unreachable
   * from the three failure modes that matter most:
   *   - 0 usable rows (endpoint moved, JSON shape changed) returns early, ABOVE
   *     this point;
   *   - a throw during the chunked writes is caught BELOW it;
   *   - the `BSE_MASTER_ENRICH=off` kill switch returns [] down the same 0-row
   *     path, so a disabled feed and a dead one were indistinguishable.
   *
   * The comment on the original write argued this row is essential precisely
   * because "a permanently broken feed is indistinguishable from a converged
   * universe" — and then the row was skipped in exactly the broken cases.
   */
  const writeSyncLog = async (): Promise<void> => {
    await prisma.marketDataSyncLog
      .create({
        data: {
          syncType: "INSTRUMENT_SYNC",
          source: "BSE_MASTER",
          status: result.disabled
            ? "SKIPPED"
            : result.error
              ? "FAILED"
              : "COMPLETED",
          recordsProcessed: result.seriesWritten + result.isinWritten,
          // Conflicts count HERE, and only here.
          //
          // The double-count was fixed in BOTH places at once — `unmatched++`
          // was removed from the planner AND `+ result.isinConflicts` from this
          // line — so a conflict went from being counted twice to being counted
          // ZERO times. Either change alone was correct. An ISIN conflict is a
          // row this feed refused to enrich, which is exactly what
          // `recordsFailed` means.
          recordsFailed: result.unmatched + result.isinConflicts,
          errorMessage: result.error ?? null,
          completedAt: new Date(),
          metadata: {
            fetched: result.fetched,
            matched: result.matched,
            unmatched: result.unmatched,
            seriesWritten: result.seriesWritten,
            isinWritten: result.isinWritten,
            isinConflicts: result.isinConflicts,
            duplicateStoredIsins: result.duplicateStoredIsins,
          },
        },
      })
      // Never let observability fail the enrichment it observes.
      .catch((e) => console.warn("BSE master: sync log write failed:", e));
  };

  try {
    const rows = await fetchBseScripMaster();
    result.fetched = rows.length;
    if (rows.length === 0) {
      // A total collapse means the endpoint moved or the shape changed. Say so
      // rather than reporting a clean run that did nothing.
      // Distinguish a DISABLED feed from a DEAD one. Both produce 0 rows, and
      // reporting the kill switch as a failure would page someone for a
      // deliberate configuration choice.
      result.error =
        process.env.BSE_MASTER_ENRICH === "off"
          ? undefined
          : "BSE scrip master returned 0 usable rows";
      result.disabled = process.env.BSE_MASTER_ENRICH === "off";
      if (result.error) console.warn(`BSE master enrichment: ${result.error}`);
      return result;
    }

    const stored = await prisma.instrumentMapping.findMany({
      where: { exchange: "BSE", isActive: true },
      // `name` corroborates the scrip_id/tradingsymbol identity when neither
      // side has an ISIN yet — which is every BSE row before this feed's first
      // successful run.
      select: {
        id: true,
        symbol: true,
        isin: true,
        series: true,
        name: true,
      },
    });

    const plan = planBseMasterEnrichment(rows, stored);
    result.matched = plan.matched;
    result.unmatched = plan.unmatched;
    result.isinConflicts = plan.isinConflicts.length;
    result.uncorroborated = plan.uncorroborated;
    result.duplicateStoredIsins = plan.duplicateStoredIsins.length;

    // Loud, because both mean the catalogue disagrees with the exchange about
    // which row is which security — and a wrong `series` propagates into an
    // unrecoverable sector wipe via the repair script.
    if (plan.isinConflicts.length > 0) {
      console.warn(
        `BSE master: ${plan.isinConflicts.length} rows matched by symbol but ` +
          `the ISINs disagree — SKIPPED. Samples: ` +
          plan.isinConflicts
            .slice(0, 5)
            .map(
              (c) =>
                `${c.scripId} master=${c.masterIsin} stored=${c.storedIsin}`,
            )
            .join("; "),
      );
    }
    if (plan.rejectedGroups.size > 0) {
      // A shape change in BSE's GROUP column, which would otherwise be a silent
      // no-op: rows "fetched", nothing written, no error set.
      console.warn(
        `BSE master: ${plan.rejectedGroups.size} distinct group values failed ` +
          `the shape check and were NOT written to series: ` +
          [...plan.rejectedGroups.entries()]
            .slice(0, 8)
            .map(([g, n]) => `"${g}"×${n}`)
            .join(", "),
      );
    }
    if (plan.duplicateStoredIsins.length > 0) {
      console.warn(
        `BSE master: ${plan.duplicateStoredIsins.length} ISINs are shared by ` +
          `more than one active BSE row, so ISIN-fallback resolution is ` +
          `ambiguous for them: ${plan.duplicateStoredIsins.slice(0, 5).join(", ")}`,
      );
    }

    // Chunked at 200, matching `deactivateStaleInstruments`. Group F alone can
    // carry ~6,500 ObjectIds, and a single oversized `$in` failing would lose
    // the whole group.
    const ID_CHUNK = 200;
    for (const [group, ids] of plan.seriesGroups) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const res = await prisma.instrumentMapping.updateMany({
          where: { id: { in: ids.slice(i, i + ID_CHUNK) } },
          data: { series: group },
        });
        result.seriesWritten += res.count;
      }
    }

    // Bounded concurrency, mirroring `UPSERT_CONCURRENCY = 10` in
    // instrument-sync.ts. Each ISIN is unique so these must be per-row writes,
    // and the FIRST run faces ~11,500 of them. Sequentially that is 11,500
    // round trips inside a job whose Pub/Sub ack deadline is 600s — an overrun
    // means Pub/Sub redelivers while this run is still executing, and
    // `hasRecentSync` cannot help because the first run has not COMPLETED.
    const WRITE_CONCURRENCY = 10;
    for (let w = 0; w < plan.isinUpdates.length; w += WRITE_CONCURRENCY) {
      const slice = plan.isinUpdates.slice(w, w + WRITE_CONCURRENCY);
      const counts = await Promise.all(
        slice.map(async ({ id, isin }) => {
          // Guarded on absence in the WHERE as well as in the plan, so a
          // concurrent writer cannot lose a race and have us overwrite an ISIN
          // that just landed. `isSet: false` covers a legacy document that never
          // had the field, which none of the other clauses match under
          // Prisma+Mongo (the MONEY-1050 gotcha) — and the miss would be silent.
          const res = await prisma.instrumentMapping.updateMany({
            where: {
              id,
              OR: [{ isin: null }, { isin: "" }, { isin: { isSet: false } }],
            },
            data: { isin },
          });
          return res.count;
        }),
      );
      result.isinWritten += counts.reduce((a, b) => a + b, 0);
    }

    // Fetched rows but wrote nothing and changed nothing? That is the signature
    // of a renamed column, not a converged universe, and it must not be reported
    // as a clean run.
    // Health check, as a real (tested) predicate rather than an inline
    // condition — two wrong versions of this shipped as inline conditions.
    result.error =
      diagnoseBseFeed({
        rowCount: rows.length,
        blankGroups: rows.filter((r) => !r.group).length,
        rejectedGroups: plan.rejectedGroups,
        seriesGroupCount: plan.seriesGroups.size,
        matched: plan.matched,
      }) ?? result.error;

    console.log(
      `BSE master enrichment: ${result.fetched} fetched, ${result.matched} matched ` +
        `(${result.unmatched} unmatched — reported, not created), ` +
        `${result.seriesWritten} series + ${result.isinWritten} ISINs written`,
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.warn(
      `BSE master enrichment failed (sync unaffected): ${result.error}`,
    );
  } finally {
    // Every exit lands here: success, 0 rows, kill switch, or a throw mid-write.
    await writeSyncLog();
  }

  return result;
}
