/**
 * Instrument Sync Orchestrator
 *
 * Coordinates syncing instruments from multiple broker providers
 * into the central InstrumentMapping table.
 *
 * Flow:
 * 1. Log sync start in MarketDataSyncLog
 * 2. For each provider: fetch + parse instruments
 * 3. Upsert into InstrumentMapping (batch of 500)
 * 4. Deactivate instruments not in any provider's latest dump
 * 5. Log sync completion with counts
 */

import { prisma } from "@usemoney/database";
import type {
  InstrumentProvider,
  InstrumentSyncResult,
  RawInstrument,
} from "./types";
import type { Prisma } from "@usemoney/database";
import { buildYahooSymbolForInstrument } from "./zerodha-instruments";
import {
  detectRenames,
  nextPreviousSymbols,
  type StaleInstrument,
} from "./rename-detect-logic";
import {
  diffFeedArchiveCounters,
  readFeedArchiveCounters,
  resolveFeedArchiveMode,
} from "../feed-archive";

const BATCH_SIZE = 500;

/**
 * Known index mappings that don't come from broker instrument dumps.
 * These are manually maintained since Yahoo uses ^-prefixed symbols for indices.
 */
const INDEX_YAHOO_MAPPINGS: Record<string, string> = {
  // NSE Broad Market
  "NIFTY 50": "^NSEI",
  NIFTY: "^NSEI",
  "NIFTY BANK": "^NSEBANK",
  BANKNIFTY: "^NSEBANK",
  "NIFTY NEXT 50": "^NSMIDCP",
  "NIFTY MIDCAP 100": "^CNXMDCP",
  "NIFTY MIDCAP 50": "^NIFTYMIDCAP50",
  "NIFTY SMLCAP 100": "^CNXSC",
  "NIFTY 100": "^CNX100",
  "NIFTY 200": "^CNX200",
  "NIFTY 500": "^CNX500",

  // NSE Sectoral
  "NIFTY IT": "^CNXIT",
  "NIFTY PHARMA": "^CNXPHARMA",
  "NIFTY AUTO": "^CNXAUTO",
  "NIFTY FMCG": "^CNXFMCG",
  "NIFTY METAL": "^CNXMETAL",
  "NIFTY REALTY": "^CNXREALTY",
  "NIFTY ENERGY": "^CNXENERGY",
  "NIFTY INFRA": "^CNXINFRA",
  "NIFTY FIN SERVICE": "^CNXFIN",
  "NIFTY PSU BANK": "^NIFTYPSUBNK",
  "NIFTY MEDIA": "^CNXMEDIA",
  "NIFTY COMMODITIES": "^CNXCMDT",
  "NIFTY CONSUMPTION": "^CNXCONSUME",
  "NIFTY HEALTHCARE": "^CNXPHARMA", // Healthcare uses same Yahoo symbol as Pharma

  // Thematic / Strategy
  "NIFTY CPSE": "^NIFCPSE",
  "NIFTY GROWSECT 15": "^CNXGROWTH",

  // Volatility
  "INDIA VIX": "^INDIAVIX",

  // BSE
  SENSEX: "^BSESN",
  "BSE SENSEX 50": "^BSESN50",
  "BSE MIDCAP": "^BSEMCAP",
  "BSE SMLCAP": "^BSESMCAP",
};

/**
 * Run the instrument sync for all provided broker instrument providers.
 *
 * @param providers Array of InstrumentProvider implementations
 * @param options Optional filters (exchanges, force full sync)
 * @returns Array of sync results per provider
 */
export async function syncInstruments(
  providers: InstrumentProvider[],
  options: {
    exchanges?: string[];
    forceFullSync?: boolean;
  } = {},
): Promise<InstrumentSyncResult[]> {
  const results: InstrumentSyncResult[] = [];

  // Create sync log entry
  const syncLog = await prisma.marketDataSyncLog.create({
    data: {
      syncType: "INSTRUMENT_SYNC",
      source: providers.map((p) => p.name).join(","),
      status: "RUNNING",
      metadata: {
        exchanges: options.exchanges ?? "ALL",
        forceFullSync: options.forceFullSync ?? false,
        providerCount: providers.length,
      },
    },
  });

  /**
   * MONEY-1157 — whether this run's master CSVs were REPLAYED from the GCS
   * archive or scraped from NSE. `source` is the provider name either way, so
   * without this a QA that silently stopped replaying (and went back to
   * scraping the rate-limited exchange) looks exactly like a healthy run.
   * Snapshot-and-diff, not reset: bhavcopy-sync can be running concurrently in
   * the same worker process.
   */
  const feedArchiveBefore = readFeedArchiveCounters();
  const feedArchiveDelta = () => ({
    mode: resolveFeedArchiveMode(),
    ...diffFeedArchiveCounters(feedArchiveBefore, readFeedArchiveCounters()),
  });

  // Track all symbols seen across providers (for deactivation)
  const activeSymbolExchangePairs = new Set<string>();

  try {
    for (const provider of providers) {
      const result = await syncFromProvider(
        provider,
        activeSymbolExchangePairs,
        options,
      );
      results.push(result);
    }

    // Deactivate instruments not seen in any provider's dump. Renames are
    // captured first — see captureRenames (MONEY-1177).
    const {
      deactivated,
      renamed,
      rowsReparented,
      refusedReason,
      refusedCandidates,
    } = await deactivateStaleInstruments(
      activeSymbolExchangePairs,
      options.exchanges,
    );

    // MONEY-1263 — put the sweep ON THE RESULT, not only in the log.
    // See `attributeSweepToResults` for why first-element attribution.
    attributeSweepToResults(results, {
      deactivated,
      refusedReason,
      refusedCandidates,
    });

    // Update sync log
    const totalUpserted = results.reduce((sum, r) => sum + r.upserted, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "COMPLETED",
        recordsProcessed: totalUpserted,
        recordsFailed: totalFailed,
        completedAt: new Date(),
        metadata: {
          exchanges: options.exchanges ?? "ALL",
          forceFullSync: options.forceFullSync ?? false,
          providerCount: providers.length,
          results: results.map((r) => ({
            provider: r.provider,
            fetched: r.totalFetched,
            upserted: r.upserted,
            failed: r.failed,
          })),
          deactivated,
          // MONEY-1263 — the refusal, in the log as well as on the result. A
          // `deactivated: 0` row that is ALSO `deactivationRefused: true` is a
          // completely different event from a quiet night, and the sync log is
          // where anyone reconstructing "what happened on the 14th?" looks.
          deactivationRefused: Boolean(refusedReason),
          deactivationRefusedCount: refusedCandidates,
          // MONEY-1177. A rename that happens silently is one nobody can
          // verify; a non-zero rowsReparented is the proof the history moved
          // with the name instead of being stranded on the retired row.
          renamed,
          rowsReparented,
          feedArchive: feedArchiveDelta(),
        },
      },
    });

    console.log(
      `Instrument sync completed: ${totalUpserted} upserted, ${totalFailed} failed, ` +
        `${deactivated} deactivated, ${renamed} renamed (${rowsReparented} price rows moved)` +
        // Never let the headline read a bare "0 deactivated" on a run that
        // refused thousands — that reads as a quiet night.
        (refusedReason
          ? `, REFUSED to deactivate ${refusedCandidates} (breaker tripped)`
          : ""),
    );
  } catch (error) {
    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        // Also on the failure path: "was the master replayed or scraped?" is at
        // its most interesting on the run that failed.
        metadata: {
          exchanges: options.exchanges ?? "ALL",
          forceFullSync: options.forceFullSync ?? false,
          providerCount: providers.length,
          feedArchive: feedArchiveDelta(),
        },
      },
    });
    throw error;
  }

  return results;
}

/** The sweep facts a run reports, independent of how the sweep was performed. */
export interface SweepAttribution {
  /** Rows actually flipped inactive. */
  deactivated: number;
  /** Set when the circuit breaker refused; the operator-facing sentence. */
  refusedReason?: string;
  /** Rows the breaker declined to flip. */
  refusedCandidates: number;
}

/**
 * Fold a RUN-level deactivation sweep into the PER-PROVIDER result array.
 *
 * ── WHY THIS EXISTS (MONEY-1263) ──────────────────────────────────────────────
 *
 * `InstrumentSyncResult.deactivated` was assigned the literal `0` in
 * `syncFromProvider` and never reassigned anywhere in the file — grep found no
 * `deactivated =` and no `deactivated +=`. So the field documented as "the
 * number that makes the one CATASTROPHIC failure visible at a glance" was
 * structurally incapable of being anything but zero. The real count reached a
 * `console.log` and `marketDataSyncLog.metadata` and stopped there, while
 * `us-instrument-master-sync.ts` was already forwarding this field into
 * `reportJobOutcome` — so the job outcome reported a hard 0 every night
 * regardless of what the sweep did.
 *
 * ── WHY THE FIRST ELEMENT, AND ZERO ON THE REST ───────────────────────────────
 *
 * The sweep is a RUN-level operation: it runs after the provider loop and is
 * computed from the UNION of every provider's symbols, so no single provider
 * owns it. The two obvious alternatives are both worse:
 *
 *   - Writing the total onto EVERY element makes any consumer that sums the
 *     array report N x the real number — a worse lie than 0, because it scales
 *     with provider count and looks like a real measurement.
 *   - Leaving it 0 everywhere is the bug being fixed.
 *
 * First-element attribution keeps BOTH readings honest at once: `results[0]` is
 * correct for a single-provider caller, and `sum(results)` is correct for
 * anyone aggregating.
 *
 * CORRECTED (MONEY-980): this used to cite `us-instrument-master-sync` as the
 * single-provider caller doing `const [providerResult] = await
 * syncInstruments(...)`. It does not, and no longer could — that job calls
 * core's `syncUsInstruments()` (`us-instrument-master-sync.ts:200`), which
 * writes `us_instruments` and never touches `instrument_mappings` or this
 * function.
 *
 * `syncInstruments` now has exactly TWO callers, both India:
 *
 *   workers/src/processors/instrument-sync.ts:66   (Zerodha + NSE masters)
 *   scripts/seed/seed-instruments.ts:20            (Zerodha, seeding)
 *
 * The second is a genuine single-provider caller, so the reading the paragraph
 * above defends is still exercised. The reasoning was always about arity, not
 * about which job it was.
 *
 * ── WHY A REFUSAL IS ITS OWN FIELD ────────────────────────────────────────────
 *
 * `deactivated: 0` cannot distinguish "nothing was stale" (routine, most
 * nights) from "a provider returned an empty dump and the breaker declined to
 * blank ~20,804 rows" (the catastrophe `judgeDeactivationSweep` exists to
 * prevent). Both were zero, and the refusal reached an operator only as console
 * prose, which no monitor can key on. `deactivationRefused` is the
 * machine-readable half; the reason SENTENCE rides `errors[]`, which
 * `us-instrument-master-sync` already surfaces as `skippedReason` rather than
 * needing a new channel.
 *
 * Pure: mutates and returns the array it is given, touches no clock, no
 * database and no environment.
 */
export function attributeSweepToResults(
  results: InstrumentSyncResult[],
  sweep: SweepAttribution,
): InstrumentSyncResult[] {
  // An empty provider list produced nothing to hang this on — and that is
  // exactly the run where the sweep is most dangerous, because no provider
  // symbols means EVERY active row is a deactivation candidate. Synthesise a
  // carrier rather than dropping the refusal on the floor.
  if (results.length === 0) {
    results.push({
      provider: "(no providers)",
      totalFetched: 0,
      upserted: 0,
      failed: 0,
      deactivated: 0,
      errors: [],
    });
  }

  const target = results[0]!;
  target.deactivated = sweep.deactivated;

  if (sweep.refusedReason) {
    target.deactivationRefused = true;
    target.deactivationRefusedCount = sweep.refusedCandidates;
    target.errors.push(sweep.refusedReason);
  }

  return results;
}

/**
 * The payload written to an EXISTING row.
 *
 * Exported and pure so the invariant is a real assertion instead of a regex
 * over source text. That distinction is not academic: the previous guard
 * checked for the field NAMES `series`/`instrumentType` inside the literal, so
 * appending `...upsertData` after the narrowed spread — the pre-fix code,
 * restoring MONEY-1093 in full — kept it green.
 *
 * The invariant is about the COMPOSED RESULT, not the syntax that builds it:
 * whatever a provider narrows away must not reappear.
 */
export function composeUpdatePayload(
  provider: InstrumentProvider,
  raw: RawInstrument,
  upsertData: Partial<Prisma.InstrumentMappingCreateInput>,
  yahooSymbol: string,
): Partial<Prisma.InstrumentMappingCreateInput> {
  return {
    ...(provider.mapToUpdate?.(raw) ?? upsertData),
    yahooSymbol,
  };
}

/**
 * Sync instruments from a single provider.
 */
async function syncFromProvider(
  provider: InstrumentProvider,
  activeSymbolExchangePairs: Set<string>,
  options: { exchanges?: string[] },
): Promise<InstrumentSyncResult> {
  const result: InstrumentSyncResult = {
    provider: provider.name,
    totalFetched: 0,
    upserted: 0,
    failed: 0,
    deactivated: 0,
    errors: [],
  };

  console.log(`Starting instrument sync from ${provider.name}...`);

  let instruments = await provider.fetchInstruments();
  result.totalFetched = instruments.length;

  // Apply exchange filter if specified
  if (options.exchanges?.length) {
    const exchangeSet = new Set(options.exchanges);
    const beforeFilter = instruments.length;

    // Log per-exchange breakdown before filtering
    const exchangeCounts: Record<string, number> = {};
    for (const inst of instruments) {
      exchangeCounts[inst.exchange] = (exchangeCounts[inst.exchange] || 0) + 1;
    }
    console.log(
      `${provider.name}: Exchange breakdown (pre-filter): ${Object.entries(
        exchangeCounts,
      )
        .map(([e, c]) => `${e}=${c}`)
        .join(", ")}`,
    );

    instruments = instruments.filter((inst) => exchangeSet.has(inst.exchange));
    console.log(
      `${provider.name}: Filtered ${beforeFilter} → ${instruments.length} (exchanges: ${options.exchanges.join(", ")})`,
    );
  }

  console.log(
    `${provider.name}: Processing ${instruments.length} instruments in batches of ${BATCH_SIZE}...`,
  );

  // Process in batches with parallel upserts within each batch
  // Keep concurrency low to avoid MongoDB write conflicts / deadlocks
  const UPSERT_CONCURRENCY = 10;
  for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
    const batch = instruments.slice(i, i + BATCH_SIZE);

    // Process upserts in parallel sub-batches for throughput
    for (let j = 0; j < batch.length; j += UPSERT_CONCURRENCY) {
      const subBatch = batch.slice(j, j + UPSERT_CONCURRENCY);
      const results = await Promise.allSettled(
        subBatch.map(async (raw) => {
          const upsertData = provider.mapToUpsert(raw);
          const key = `${raw.symbol}::${raw.exchange}`;

          // Build Yahoo symbol
          let yahooSymbol = buildYahooSymbolForInstrument(
            raw.symbol,
            raw.exchange,
            raw.instrumentType,
          );

          // For indices, use hardcoded mappings
          if (raw.instrumentType === "INDEX") {
            yahooSymbol = INDEX_YAHOO_MAPPINGS[raw.symbol.toUpperCase()] ?? "";
          }

          const finalYahooSymbol =
            yahooSymbol || `${raw.symbol}.${raw.exchange}`;

          // Retry up to 5 times on write conflict / deadlock
          let attempt = 0;
          while (attempt < 5) {
            try {
              await prisma.instrumentMapping.upsert({
                where: {
                  symbol_exchange: {
                    symbol: raw.symbol,
                    exchange: raw.exchange,
                  },
                },
                create: {
                  ...upsertData,
                  symbol: raw.symbol,
                  exchange: raw.exchange,
                  yahooSymbol: finalYahooSymbol,
                  name: upsertData.name || raw.name || raw.symbol,
                } as Parameters<
                  typeof prisma.instrumentMapping.create
                >[0]["data"],
                // An EXISTING row gets only the fields this provider is
                // actually authoritative for. Composed by an exported pure
                // function so the invariant can be UNIT-tested rather than
                // regex-scanned — the previous source-text guard passed even
                // when `...upsertData` was appended back, which is the pre-fix
                // code in full.
                update: composeUpdatePayload(
                  provider,
                  raw,
                  upsertData,
                  finalYahooSymbol,
                ),
              });
              break; // Success
            } catch (upsertError: unknown) {
              attempt++;
              const msg =
                upsertError instanceof Error ? upsertError.message : "";
              const isWriteConflict =
                msg.includes("write conflict") || msg.includes("deadlock");
              if (isWriteConflict && attempt < 5) {
                // Exponential backoff with jitter
                const baseDelay = 100 * Math.pow(2, attempt - 1);
                const jitter = Math.random() * baseDelay;
                await new Promise((r) => setTimeout(r, baseDelay + jitter));
              } else {
                throw upsertError; // Let Promise.allSettled catch it
              }
            }
          }

          activeSymbolExchangePairs.add(key);
          return key;
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          result.upserted++;
        } else {
          result.failed++;
          const msg =
            r.reason instanceof Error ? r.reason.message : "Unknown error";
          if (result.errors.length < 50) {
            result.errors.push(msg);
          }
        }
      }
    }

    console.log(
      `${provider.name}: Processed ${Math.min(i + BATCH_SIZE, instruments.length)}/${instruments.length}`,
    );
  }

  console.log(
    `${provider.name}: Sync complete - ${result.upserted} upserted, ${result.failed} failed`,
  );

  return result;
}

/**
 * Deactivate instruments that are no longer in any provider's latest dump.
 * Only deactivates if instrument hasn't been synced in the last 7 days.
 */
/**
 * Record renames and move the price history with the name — MONEY-1177.
 *
 * A renamed instrument's successor is a DIFFERENT row with a different id, so
 * without this its chart starts from zero on rename day while decades of
 * history sit on a row nothing queries. ETERNAL and TMPV only escaped that
 * because the MONEY-1175 re-parse happened to re-read every archived bhavcopy
 * and reattach the rows by ISIN — an accident, not a mechanism.
 *
 * Failures here must never abort the sync: the rename bookkeeping is valuable
 * but the dump itself is the job. Errors are logged and counted.
 */
async function captureRenames(
  toDeactivate: readonly StaleInstrument[],
  exchangeFilter?: string[],
): Promise<{ renamed: number; rowsReparented: number }> {
  if (toDeactivate.length === 0) return { renamed: 0, rowsReparented: 0 };

  const active = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      ...(exchangeFilter?.length ? { exchange: { in: exchangeFilter } } : {}),
      isin: { not: null },
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      isin: true,
      previousSymbols: true,
    },
  });

  const { renames } = detectRenames(toDeactivate, active);
  if (renames.length === 0) return { renamed: 0, rowsReparented: 0 };

  let renamed = 0;
  let rowsReparented = 0;

  for (const { from, to } of renames) {
    try {
      // Chain-aware: a second rename must not lose the ORIGINAL ticker, which
      // is the one users still remember.
      const predecessor = await prisma.instrumentMapping.findUnique({
        where: { id: from.id },
        select: { previousSymbols: true },
      });
      const next = nextPreviousSymbols(
        to,
        from.symbol,
        predecessor?.previousSymbols ?? [],
      );
      if (next) {
        await prisma.instrumentMapping.update({
          where: { id: to.id },
          data: { previousSymbols: next },
        });
      }

      rowsReparented += await reparentDailyPrices(from.id, to.id);
      renamed++;
      console.log(
        `[instrument-sync] RENAME ${from.symbol} -> ${to.symbol} ` +
          `(${from.exchange}, isin ${from.isin}); price rows moved so far: ${rowsReparented}`,
      );
    } catch (error) {
      console.error(
        `[instrument-sync] rename capture failed for ${from.symbol} -> ${to.symbol}:`,
        error,
      );
    }
  }

  return { renamed, rowsReparented };
}

/**
 * Move `DailyPrice` rows from a retired instrument onto its successor.
 *
 * Dates the successor ALREADY holds are dropped rather than moved: the
 * successor's row is the live one, and `(instrumentId, date)` is unique so a
 * blind update would throw and strand the rest of the batch.
 *
 * Chunked, and deliberately NOT wrapped in a transaction — a rename can carry
 * 7,000+ rows and Mongo's 5s transaction ceiling would abort it (MONEY-654).
 * Partial progress is safe here: re-running simply moves whatever is left.
 */
async function reparentDailyPrices(
  fromId: string,
  toId: string,
): Promise<number> {
  const existing = await prisma.dailyPrice.findMany({
    where: { instrumentId: toId },
    select: { date: true },
  });
  const taken = new Set(existing.map((r) => r.date.getTime()));

  const orphans = await prisma.dailyPrice.findMany({
    where: { instrumentId: fromId },
    select: { id: true, date: true },
  });
  if (orphans.length === 0) return 0;

  const movable = orphans.filter((r) => !taken.has(r.date.getTime()));
  const duplicates = orphans.length - movable.length;

  const CHUNK = 500;
  let moved = 0;
  for (let i = 0; i < movable.length; i += CHUNK) {
    const ids = movable.slice(i, i + CHUNK).map((r) => r.id);
    const res = await prisma.dailyPrice.updateMany({
      where: { id: { in: ids } },
      data: { instrumentId: toId },
    });
    moved += res.count;
  }

  if (duplicates > 0) {
    console.log(
      `[instrument-sync] ${duplicates} date(s) already present on the successor were left on the retired row`,
    );
  }
  return moved;
}

/**
 * A sweep that would deactivate a large SHARE of its own population is a
 * provider failure, not a delisting event — MONEY-1263.
 *
 * `deactivateStaleInstruments` flips every active row that a provider did not
 * return and has not synced in 7 days. That is correct when a provider answered
 * normally, and catastrophic when it did not: an empty dump, a changed schema,
 * or — the case that made this real — a provider run with the WRONG exchange
 * scope. Running the US master with no `options.exchanges` computes its
 * still-active set from US symbols only and deactivates all ~20,804 Indian
 * rows, with no error and a `COMPLETED` sync log. The data is not deleted, but
 * every downstream surface reads `isActive: true` and goes blank.
 *
 * Real delistings are a handful a day against tens of thousands of rows. So a
 * proportion is the honest signal, and a proportion needs a FLOOR too: a
 * five-row test fixture losing two rows is 40% and entirely fine.
 *
 * Refusing is the right response rather than deactivating and alerting.
 * Reversing a sweep means knowing which rows were flipped BY THIS RUN, and once
 * `isActive` is false that set is gone — the same "the incumbent value is
 * destroyed, so there is nothing left to compare against" argument the XBRL
 * reconcile gate is built on.
 */
export const MAX_DEACTIVATION_RATIO = 0.1;
export const DEACTIVATION_FLOOR = 50;

export interface DeactivationVerdict {
  proceed: boolean;
  /** Present when refused; names the numbers so the log is self-explaining. */
  reason?: string;
}

export function judgeDeactivationSweep(input: {
  /** Rows this sweep would flip inactive. */
  candidates: number;
  /** Active rows in the same scope, INCLUDING the candidates. */
  activePopulation: number;
}): DeactivationVerdict {
  const { candidates, activePopulation } = input;
  if (candidates <= 0) return { proceed: true };

  // Below the floor, proportion says nothing useful.
  if (candidates < DEACTIVATION_FLOOR) return { proceed: true };

  // A zero population with candidates is incoherent — the candidates came FROM
  // it. Treat it as a failure to measure rather than as a ratio of infinity.
  if (activePopulation <= 0) {
    return {
      proceed: false,
      reason:
        `refusing to deactivate ${candidates} row(s): the active population ` +
        "measured 0, which cannot be true when the candidates came from it",
    };
  }

  const ratio = candidates / activePopulation;
  if (ratio > MAX_DEACTIVATION_RATIO) {
    return {
      proceed: false,
      reason:
        `refusing to deactivate ${candidates} of ${activePopulation} active ` +
        `row(s) (${(ratio * 100).toFixed(1)}%, ceiling ` +
        `${(MAX_DEACTIVATION_RATIO * 100).toFixed(0)}%). A sweep this large is ` +
        "a provider or scope failure, not a delisting event — check that the " +
        "provider returned rows and that `options.exchanges` scopes the run.",
    };
  }
  return { proceed: true };
}

/** What one deactivation sweep did, including what it REFUSED to do. */
interface DeactivationSweepOutcome {
  deactivated: number;
  renamed: number;
  rowsReparented: number;
  /**
   * MONEY-1263 — set when the circuit breaker refused. Without it, `deactivated:
   * 0` is the ONLY thing a caller sees, and it means both "nothing was stale"
   * (routine) and "a provider came back empty and we declined to blank the
   * universe" (catastrophic). The breaker's refusal reached an operator as
   * console prose and nothing else.
   */
  refusedReason?: string;
  /** Rows the breaker declined to flip. Non-zero only alongside a reason. */
  refusedCandidates: number;
}

async function deactivateStaleInstruments(
  activeSymbolExchangePairs: Set<string>,
  exchangeFilter?: string[],
): Promise<DeactivationSweepOutcome> {
  // Only deactivate instruments we explicitly know about
  // (i.e., from exchanges we synced)
  const exchangeCondition = exchangeFilter?.length
    ? { exchange: { in: exchangeFilter } }
    : {};

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Find instruments that are active but weren't in any provider's dump
  const staleInstruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      ...exchangeCondition,
      lastSyncedAt: {
        lt: sevenDaysAgo,
      },
    },
    select: { id: true, symbol: true, exchange: true, isin: true },
  });

  const toDeactivate = staleInstruments.filter(
    (inst) =>
      !activeSymbolExchangePairs.has(`${inst.symbol}::${inst.exchange}`),
  );

  // The circuit breaker. Measured against the FULL active population in scope,
  // not against the stale subset, because a provider that returned nothing
  // makes every row stale and the subset ratio would then be a meaningless 100%.
  const activePopulation = await prisma.instrumentMapping.count({
    where: { isActive: true, ...exchangeCondition },
  });
  const verdict = judgeDeactivationSweep({
    candidates: toDeactivate.length,
    activePopulation,
  });
  if (!verdict.proceed) {
    console.error(`[instrument-sync] ${verdict.reason}`);
    return {
      deactivated: 0,
      renamed: 0,
      rowsReparented: 0,
      refusedReason: verdict.reason,
      refusedCandidates: toDeactivate.length,
    };
  }

  // MONEY-1177 — a stale row is often not gone, it is RENAMED. This is the one
  // moment the old row and its successor are both in hand; once the row is
  // flipped inactive the connection is unrecoverable without re-reading the
  // whole archive.
  const { renamed, rowsReparented } = await captureRenames(
    toDeactivate,
    exchangeFilter,
  );

  if (toDeactivate.length > 0) {
    // Chunk deactivation to avoid Prisma $expr with large arrays
    const CHUNK = 200;
    const ids = toDeactivate.map((inst) => inst.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await prisma.instrumentMapping.updateMany({
        where: { id: { in: chunk } },
        data: { isActive: false },
      });
    }

    console.log(`Deactivated ${toDeactivate.length} stale instruments`);
  }

  return {
    deactivated: toDeactivate.length,
    renamed,
    rowsReparented,
    refusedCandidates: 0,
  };
}

/**
 * Check if an instrument sync has already been run today.
 * Used to skip redundant syncs.
 */
export async function hasRecentSync(
  source: string,
  withinHours: number = 24,
): Promise<boolean> {
  const since = new Date();
  since.setHours(since.getHours() - withinHours);

  const recentSync = await prisma.marketDataSyncLog.findFirst({
    where: {
      syncType: "INSTRUMENT_SYNC",
      source: { contains: source },
      status: "COMPLETED",
      completedAt: { gte: since },
    },
    orderBy: { completedAt: "desc" },
  });

  return !!recentSync;
}
