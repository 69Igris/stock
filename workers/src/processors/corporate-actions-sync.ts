/**
 * Corporate Actions Sync Processor — MONEY-840/844 + MONEY-852.
 *
 * Ingests corporate actions (splits / bonuses / dividends / buybacks) for the
 * WHOLE listed market and merges them from THREE sources:
 *   - NSE BULK corporate-actions API (`fetchNSECorporateActionsBulkWindowed`) —
 *     one date-window call returns every NSE equity's actions (MONEY-852;
 *     replaces the old 200-symbol-per-run per-symbol loop), chunked into
 *     `<=180`-day requests by MONEY-1098.
 *   - BSE corporate-actions API (`fetchBSECorporateActions`) — blank scripcode =
 *     every BSE scrip in the same window (MONEY-852), chunked identically.
 *   - Screener.in full-page scrape (`scrapeScreenerFullPage().corporateActions`)
 *     — kept as a per-HELD-symbol enrichment so cost-basis math on a user's own
 *     holdings has a third corroborating source (Screener carries the cleanest
 *     per-share dividend) without scraping the whole market.
 *
 * The merged, normalized rows are persisted via the corporate-actions service
 * (`upsertCorporateActions`), which dedupes on the
 * `[symbol, exchange, type, exDate]` unique key and is HISTORY-PRESERVING — past
 * ex-dates are kept (unlike `events-sync`, which writes forward-only
 * `UpcomingEvent` rows and discards the past; cost-basis math needs the history).
 * For every symbol with ≥1 action we also archive a JSON snapshot to GCS at
 * `stocks/{SYMBOL}/corporate_actions/{SYMBOL}-corporate-actions.json` for
 * audit/replay.
 *
 * Cron: DAILY (MONEY-1098; was weekly-Sunday). The bulk NSE + BSE pulls are one
 * HTTP call per `<=180`-day window regardless of universe size — at the 14-day
 * default that is still TWO calls per run — so the run does not pace per-symbol
 * for them; the per-held-symbol Screener leg still paces (Screener is
 * rate-limited) and is bounded by `maxSymbols`. Deterministic — no LLM in the
 * hot path. Best-effort, per-source + per-symbol isolated: one flaky
 * source/symbol can't abort the run.
 */

import prisma from "@usemoney/database";
import type { CorporateActionsSyncMessage } from "@usemoney/types/pubsub";
import { formatNSEDate } from "@usemoney/research/data-sources/nse-filings";
// MONEY-1098 (P5.2) — the WINDOWED wrapper, never the raw bulk fetcher. A wide
// `CORP_ACTIONS_SYNC_DAYS` (e.g. 7300 for the 20-year backfill) sent as ONE
// request comes back truncated, not rejected, so the raw fetcher must not be
// reachable from this processor at all.
import {
  fetchNSECorporateActionsBulkWindowed,
  describeWindows,
} from "@usemoney/research/data-sources/corp-actions-window";
import { fetchBSECorporateActions } from "@usemoney/research/data-sources/bse-client";
import {
  scrapeScreenerFullPage,
  ScreenerRateLimitError,
} from "@usemoney/research/data-sources/screener-full-scraper";
import { buildStockDocPath } from "@usemoney/research/data-sources/stock-document-paths";
import {
  upsertCorporateActions,
  nseActionToInput,
  bseActionToInput,
  screenerActionToInput,
  type CorporateActionInput,
} from "@usemoney/services";
import { uploadToGCS } from "../lib/gcs";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
// MONEY-1301 — the (symbol, exchange) join, pure and shared with
// `scripts/data/backfill-corp-action-isins.ts` so the nightly writer and the
// repair cannot disagree about what "the same instrument" means.
import {
  attachIsins,
  buildIsinIndex,
  isinLookupArgs,
  type InstrumentIsinRow,
  type IsinAttachTally,
} from "./corporate-actions-sync-logic";

export type { InstrumentIsinRow, IsinAttachTally };

const logger = {
  info: (...args: unknown[]) => console.log("[corp-actions-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[corp-actions-sync]", ...args),
  error: (...args: unknown[]) => console.error("[corp-actions-sync]", ...args),
};

/** Screener is slow/rate-limited, so pace the per-held-symbol enrichment. */
const DELAY_BETWEEN_SYMBOLS_MS = 2500;
/** Default cap on the per-held-symbol Screener enrichment fan-out. */
const DEFAULT_MAX_SYMBOLS = 200;
/**
 * Default lookback for the bulk NSE + BSE window, in days.
 *
 * MONEY-1098 (P5.2): 7, not 30. The job moved from a WEEKLY cron to a DAILY one,
 * and the window only has to cover "since the last successful run + a buffer for
 * a missed run or a late exchange publish". A daily job re-pulling 30 days meant
 * ~30× the rows re-upserted every night for no new information — the upsert is
 * idempotent so nothing was wrong, it was just 4 weeks of redundant merge work
 * against two rate-limited hosts, every single day.
 *
 * 14 days, not 7, and the difference is a DEPLOY-ORDER hazard rather than a
 * data one. The worker image ships on merge; the daily cron only exists after
 * someone runs setup-scheduler.sh prod, and the deployed job is still the
 * WEEKLY one until then. A 7-day window on a weekly cadence has zero slack —
 * one flaky Sunday (an NSE 403 night, a worker crash) leaves a permanent hole
 * of up to a week of splits/bonuses/dividends in `CorporateAction`, which
 * feeds the FIFO cost-basis adjustment, recoverable only by a manual
 * CORP_ACTIONS_SYNC_DAYS backfill nobody knows to run. 14 survives one missed
 * week on either cadence and still cuts ~half the redundant merge work the
 * old 30-day window did daily.
 */
const DEFAULT_CORP_ACTIONS_WINDOW_DAYS = 14;

/**
 * How many days back the bulk NSE + BSE window covers. Env-overridable: a
 * one-off backfill widens it via `CORP_ACTIONS_SYNC_DAYS` (e.g. 7300 ≈ 20y),
 * which is safe now that both fetchers chunk internally at `<=180` days.
 */
function corpActionsWindowDays(): number {
  const n = Number(process.env.CORP_ACTIONS_SYNC_DAYS);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_CORP_ACTIONS_WINDOW_DAYS;
}

/**
 * Seams this processor can be driven through in a test.
 *
 * Every member is OPTIONAL and defaults to the real collaborator, so the
 * production call site (`workers/src/routes/corporate-actions.ts`) passes
 * nothing and behaves exactly as before. The shape mirrors `XbrlStoreDeps` in
 * `xbrl-sync.ts` for the same reason it exists there: an ISIN join that is
 * asserted only through its pure helper proves the helper, not the wiring —
 * and MONEY-1299's whole defect was a correct-looking resolver whose answer
 * reached the write by a path nothing exercised.
 */
export interface CorporateActionsSyncDeps {
  /**
   * The instrument-mapping read. Counted by the bulk-shape test: this must be
   * called ONCE per run whatever the batch size.
   */
  findInstrumentMappings?: (args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  }) => Promise<InstrumentIsinRow[]>;
  /** Distinct held symbols, for the Screener enrichment set. */
  findHeldSymbols?: () => Promise<Array<{ symbol: string }>>;
  fetchNSE?: typeof fetchNSECorporateActionsBulkWindowed;
  fetchBSE?: typeof fetchBSECorporateActions;
  scrapeScreener?: typeof scrapeScreenerFullPage;
  /** GCS snapshot. Returns the path written, or null. */
  archive?: (
    symbol: string,
    exchange: string,
    rows: CorporateActionInput[],
  ) => Promise<string | null>;
  upsert?: typeof upsertCorporateActions;
  reportOutcome?: typeof reportJobOutcome;
  /** Screener pacing, in ms. Tests pass 0. */
  delayBetweenSymbolsMs?: number;
}

/**
 * Held NSE + BSE symbols (distinct, upper-cased) so we know which symbols to
 * (a) attach an ISIN to and (b) run the per-symbol Screener enrichment on. Bare
 * symbols.
 */
async function gatherHeldSymbols(
  maxSymbols: number,
  deps?: CorporateActionsSyncDeps,
): Promise<string[]> {
  const holdings = deps?.findHeldSymbols
    ? await deps.findHeldSymbols()
    : await prisma.holding.findMany({
        distinct: ["symbol"],
        select: { symbol: true },
      });
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const h of holdings) {
    const s = h.symbol.toUpperCase();
    if (!seen.has(s)) {
      seen.add(s);
      ordered.push(s);
    }
  }
  return ordered.slice(0, maxSymbols);
}

/**
 * Attach an ISIN to every row that lacks one, in ONE query for the whole batch.
 *
 * ## What changed in MONEY-1301, and why the old shape looked fine
 *
 * This used to be `resolveIsins(symbols)`: one `findMany`, then a
 * `symbol -> isin` map. The query was already bulk and already correct in
 * cost — the defect was the MAP KEY. `instrument_mappings` is
 * `@@unique([symbol, exchange])`, so a dual-listed company contributes TWO rows
 * under one symbol and the second `map.set` overwrote the first. For the ten
 * symbols that are two DIFFERENT companies across the two exchanges (KIRLPNU,
 * SEL, CORDELIA, RAJPUTANA, TDPOWERSYS, FOCUS, KALYANI, GSTL, MAL, ZEAL) the
 * survivor was attached to BOTH companies' actions, indistinguishably.
 *
 * Keying on (symbol, exchange) is the whole fix, and it costs nothing: the
 * corporate action already knows its exchange — `nseActionToInput` writes
 * "NSE", `bseActionToInput` writes "BSE" — so the second half of the key was
 * present at the call site all along and was simply discarded.
 *
 * ## Two narrowings deliberately dropped
 *
 * `isActive: true` is gone. `corporate_actions` is HISTORY-PRESERVING by
 * design — a 2019 split is exactly what cost-basis math needs — so filtering
 * the join to currently-active instruments withheld ISINs from precisely the
 * delisted, merged and renamed issuers whose history is hardest to reconstruct
 * later. Activity is a property of the LISTING; the ISIN is the identity, and
 * the identity does not lapse.
 *
 * `isin: { not: null }` is gone from the WHERE and enforced in
 * {@link buildIsinIndex} instead. It was not wrong — `{ not: null }` means "has
 * a value" and is the one bare-null spelling this repo's guard deliberately
 * does not flag — but doing it in the index keeps a single place that decides
 * what a usable mapping row is, shared with the backfill.
 *
 * Returns the tally so the run can REPORT its fill rate instead of leaving it
 * measurable only by a query against the table afterwards.
 */
async function attachIsinsToBatch(
  rows: CorporateActionInput[],
  deps?: CorporateActionsSyncDeps,
): Promise<IsinAttachTally> {
  const { symbols, exchanges, pairs } = isinLookupArgs(rows);
  if (symbols.length === 0 || exchanges.length === 0) {
    // Nothing in the batch is joinable, so there is nothing to ask Mongo. An
    // empty `$in` matches nothing by definition, and issuing it anyway would
    // put a guaranteed-useless round trip in the hot path. The rows are still
    // TALLIED as unresolved: a run whose every row lacks a usable exchange must
    // not report the same zeroes as a run with no rows at all.
    return attachIsins(rows, new Map<string, string>());
  }

  // Mongo cannot `$in` a composite, so this is the CROSS PRODUCT of the two
  // lists and returns rows the batch did not ask for. `attachIsins` re-narrows
  // on both halves of the key, and the over-fetch is bounded by the whole
  // cash-equity master (~26,983 rows on prod). ONE round trip, whatever the
  // batch size.
  const where = { symbol: { in: symbols }, exchange: { in: exchanges } };
  const select = { symbol: true, exchange: true, isin: true };
  const mappings: InstrumentIsinRow[] = deps?.findInstrumentMappings
    ? await deps.findInstrumentMappings({ where, select })
    : await prisma.instrumentMapping.findMany({ where, select });

  const index = buildIsinIndex(mappings);
  const tally = attachIsins(rows, index);
  logger.info(
    `ISIN join: ${pairs} (symbol, exchange) pair(s) over ${symbols.length} ` +
      `symbol(s) -> ${mappings.length} mapping row(s), ${index.size} with an ` +
      `ISIN; resolved=${tally.resolved} unresolved=${tally.unresolved} ` +
      `unkeyable=${tally.unkeyable}`,
  );
  return tally;
}

/**
 * Archive a per-symbol JSON snapshot of the symbol's corporate actions to GCS at
 * `stocks/{SYMBOL}/corporate_actions/{SYMBOL}-corporate-actions.json`. Best
 * effort — a GCS failure logs and continues (the DB upsert already succeeded).
 * Returns the gcsPath written, or null on failure.
 */
async function archiveSnapshot(
  symbol: string,
  exchange: string,
  rows: CorporateActionInput[],
): Promise<string | null> {
  try {
    // One snapshot per symbol (latest-wins), so a fixed filename — not the
    // period-stamped `buildFullDocPath` form (which would also embed the docType
    // and yield "...corporate_actions-corporate-actions.json"). This matches the
    // documented path stocks/{SYMBOL}/corporate_actions/{SYMBOL}-corporate-actions.json.
    const clean = symbol.toUpperCase().replace(/[^A-Z0-9&]/g, "");
    const gcsPath = buildStockDocPath(
      symbol,
      "corporate_actions",
      `${clean}-corporate-actions.json`,
    );
    const payload = {
      symbol,
      exchange,
      generatedAt: new Date().toISOString(),
      count: rows.length,
      actions: rows.map((r) => ({
        type: r.type,
        exchange: r.exchange,
        exDate: r.exDate.toISOString(),
        recordDate: r.recordDate ? r.recordDate.toISOString() : null,
        ratio: r.ratio,
        oldFaceValue: r.oldFaceValue,
        newFaceValue: r.newFaceValue,
        dividendPerShare: r.dividendPerShare,
        source: r.source,
        details: r.details,
      })),
    };
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), "utf-8");
    await uploadToGCS(gcsPath, buffer, "application/json");
    return gcsPath;
  } catch (err) {
    logger.warn(
      `GCS snapshot failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Group persist-ready rows by `symbol` so each symbol's actions can be archived
 * + upserted together (the snapshot is per-symbol; the GCS path is stamped onto
 * that symbol's rows before the DB write).
 */
function groupBySymbol(
  rows: CorporateActionInput[],
): Map<string, CorporateActionInput[]> {
  const map = new Map<string, CorporateActionInput[]>();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return map;
}

export async function processCorporateActionsSync(
  data: CorporateActionsSyncMessage,
  deps?: CorporateActionsSyncDeps,
): Promise<void> {
  const maxSymbols = data.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const fetchNSE = deps?.fetchNSE ?? fetchNSECorporateActionsBulkWindowed;
  const fetchBSE = deps?.fetchBSE ?? fetchBSECorporateActions;
  const scrapeScreener = deps?.scrapeScreener ?? scrapeScreenerFullPage;
  const archive = deps?.archive ?? archiveSnapshot;
  const upsert = deps?.upsert ?? upsertCorporateActions;
  const report = deps?.reportOutcome ?? reportJobOutcome;
  const screenerDelayMs =
    deps?.delayBetweenSymbolsMs ?? DELAY_BETWEEN_SYMBOLS_MS;

  // Explicit-symbols override: when the caller names symbols we restrict EVERY
  // leg to that set (filter the whole-market bulk rows + scope the Screener
  // enrichment to them) so a targeted re-sync of "RELIANCE" doesn't rewrite the
  // entire market. Empty / omitted = the held-universe default below.
  const explicitSymbols =
    data.symbols && data.symbols.length > 0
      ? new Set(data.symbols.map((s) => s.toUpperCase()))
      : null;

  // Date window for the bulk NSE + BSE pulls.
  const toDate = new Date();
  const fromDate = new Date(
    toDate.getTime() - corpActionsWindowDays() * 24 * 60 * 60 * 1000,
  );

  logger.info(
    `Corp-actions sync window ${formatNSEDate(fromDate)}..${formatNSEDate(toDate)} ` +
      `(force: ${!!data.forceRefresh}, days: ${corpActionsWindowDays()}, ` +
      `scope: ${explicitSymbols ? `${explicitSymbols.size} symbols` : "all"})`,
  );

  // ── 1. BULK NSE (whole market, one call) ──────────────────────────────────
  const bulkRows: CorporateActionInput[] = [];
  try {
    const nse = await fetchNSE(fromDate, toDate);
    for (const a of nse.rows) {
      const input = nseActionToInput(a, "NSE", null);
      if (input) bulkRows.push(input);
    }
    logger.info(
      `NSE bulk: ${nse.rows.length} raw → ${bulkRows.length} keyable rows`,
    );
    // A window we could not ask for is not a window with no actions. Naming it
    // here is what makes a partial nightly visible on the day it happens rather
    // than as an unexplained dip in the history months later (MONEY-1189).
    if (nse.failedWindows.length > 0) {
      logger.error(
        `NSE bulk: ${nse.failedWindows.length} window(s) FAILED and were not ` +
          `fetched — ${describeWindows(nse.failedWindows)}. This range is ` +
          `INCOMPLETE; re-run corp-actions-backfill for it.`,
      );
    }
  } catch (err) {
    logger.warn(
      `NSE bulk corp-actions failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // ── 2. BSE (whole market, one call) ───────────────────────────────────────
  const bseStart = bulkRows.length;
  try {
    const bse = await fetchBSE({ fromDate, toDate });
    for (const a of bse.rows) {
      const input = bseActionToInput(a, "BSE", null);
      if (input) bulkRows.push(input);
    }
    logger.info(
      `BSE bulk: ${bse.rows.length} raw → ${bulkRows.length - bseStart} keyable rows`,
    );
    if (bse.failedWindows.length > 0) {
      logger.error(
        `BSE bulk: ${bse.failedWindows.length} window(s) FAILED and were not ` +
          `fetched — ${describeWindows(bse.failedWindows)}. This range is ` +
          `INCOMPLETE; re-run corp-actions-backfill for it.`,
      );
    }
  } catch (err) {
    logger.warn(
      `BSE bulk corp-actions failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // When the caller named symbols, drop every bulk row outside that set so a
  // targeted re-sync only touches the requested tickers.
  if (explicitSymbols) {
    for (let i = bulkRows.length - 1; i >= 0; i--) {
      if (!explicitSymbols.has(bulkRows[i]!.symbol)) bulkRows.splice(i, 1);
    }
  }

  // Symbols to run the Screener enrichment on (+ snapshot): the explicit set if
  // given, else the held universe. Bounded by maxSymbols.
  const enrichSymbols = explicitSymbols
    ? Array.from(explicitSymbols).slice(0, maxSymbols)
    : await gatherHeldSymbols(maxSymbols, deps);
  const enrichSet = new Set(enrichSymbols);

  // ── 3. Per-symbol Screener enrichment (paced, bounded) ────────────────────
  // Only scrape the enrich set — the whole-market coverage already comes from
  // the bulk NSE + BSE pulls; Screener adds a third corroborating source for the
  // symbols a user actually owns (cost-basis math).
  let screenerHits = 0;
  // Circuit-breaker: once Screener 429s persistently, stop the per-symbol walk.
  // The bulk NSE + BSE pulls already gave whole-market coverage; Screener here is
  // only a corroborating per-held-symbol enrichment, so dropping the tail is
  // cheap. Without this the typed 429 would be swallowed per symbol and the loop
  // would tarpit through all `maxSymbols` (mirrors the stock-document-sync breaker).
  let screenerRateLimited = false;
  for (let i = 0; i < enrichSymbols.length && !screenerRateLimited; i++) {
    const symbol = enrichSymbols[i]!;
    try {
      const scraped = await scrapeScreener(symbol);
      for (const a of scraped?.corporateActions ?? []) {
        // Screener is NSE-listed company data; tag exchange NSE so it merges
        // with the NSE bulk rows on the shared key.
        const input = screenerActionToInput(a, "NSE", null);
        if (input) {
          bulkRows.push(input);
          screenerHits++;
        }
      }
    } catch (err) {
      if (err instanceof ScreenerRateLimitError) {
        screenerRateLimited = true;
        logger.warn(
          `Screener rate-limited (429) — skipping the remaining ${enrichSymbols.length - i - 1} symbols this run`,
        );
        break;
      }
      logger.warn(
        `Screener corp-actions failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (i < enrichSymbols.length - 1 && screenerDelayMs > 0) {
      await new Promise((r) => setTimeout(r, screenerDelayMs));
    }
  }
  logger.info(
    `Screener enrichment: ${screenerHits} rows over ${enrichSymbols.length} symbols`,
  );

  if (bulkRows.length === 0) {
    logger.info("No corporate actions fetched from any source — nothing to do");
    report({
      job: "corp-actions-sync",
      selected: 0,
      written: 0,
      failed: 0,
      skippedReason:
        `no rows from ANY source over ` +
        `${formatNSEDate(fromDate)}..${formatNSEDate(toDate)} ` +
        `(screenerHits=${screenerHits}, enrichSymbols=${enrichSymbols.length}) — ` +
        `a genuinely actionless window and three dead upstreams look identical ` +
        `from here`,
    });
    return;
  }

  // ── 4. Attach ISINs — MONEY-1301 ──────────────────────────────────────────
  //
  // ONE query for the whole batch, keyed on (symbol, exchange). The old shape
  // was already one query; what it got wrong was the key. See
  // {@link attachIsinsToBatch}.
  //
  // BEFORE the write, not after: `upsertCorporateActions` only ever FILLS
  // nulls on an existing row, so a row created without an ISIN keeps that null
  // until a later run offers one. Attaching here is what makes the nightly a
  // self-healing pass over its own 14-day window rather than a one-shot at
  // create time.
  const isinTally = await attachIsinsToBatch(bulkRows, deps);

  // ── 5. Per-symbol archive + upsert ────────────────────────────────────────
  // Group by symbol so each symbol gets ONE GCS snapshot (latest-wins) and the
  // upsert dedupes/merges NSE+BSE+Screener rows for that symbol. We snapshot the
  // enrich-set symbols (the ones that drive a user's cost-basis); whole-market
  // non-enriched symbols are still upserted but not snapshotted (keeps GCS
  // object count bounded).
  const bySymbol = groupBySymbol(bulkRows);

  let symbolsWithActions = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let snapshots = 0;
  // MONEY-1238 — the write loop had NO failure counter at all. `upsertCorporateActions`
  // throwing for a symbol logged one line and the loop moved on, and the run's
  // only summary counted creates, merges and snapshots — three numbers that all
  // go DOWN together when writes fail, and none of which says a write failed.
  // This is cost-basis data: a missing split or bonus silently misprices every
  // downstream P&L for that holding, and nothing reconciles it afterwards.
  let upsertFailures = 0;
  /** Enrich-set symbols whose GCS snapshot did not land. */
  let snapshotFailures = 0;
  const failedSymbols: string[] = [];

  for (const [symbol, rows] of bySymbol) {
    try {
      // Snapshot only the enrich set (the ones that drive a user's cost-basis).
      // `forceRefresh` re-archives those even when nothing changed; it does NOT
      // snapshot the whole market (that would create thousands of GCS objects).
      if (enrichSet.has(symbol)) {
        const exchange = rows[0]?.exchange ?? "NSE";
        const gcsPath = await archive(symbol, exchange, rows);
        if (gcsPath) {
          snapshots++;
          for (const r of rows) r.gcsPath = gcsPath;
        } else {
          // `archiveSnapshot` already warned; count it so `snapshots` has a
          // denominator. `snapshots < enrichSet.size` was previously the only
          // evidence, and it is indistinguishable from "fewer enrich symbols
          // had actions this window".
          snapshotFailures++;
        }
      }

      const result = await upsert(rows);
      totalCreated += result.created;
      totalUpdated += result.updated;
      if (result.created > 0 || result.updated > 0) symbolsWithActions++;
    } catch (err) {
      upsertFailures++;
      if (failedSymbols.length < 10) failedSymbols.push(symbol);
      logger.error(
        `Upsert failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // MONEY-1301 — the fill rate, per run, in the outcome line.
  //
  // `isin` was populated on 2,507 of 56,446 rows (4.4%) and NOTHING said so:
  // every counter this job reported (created, merged, snapshots) was healthy
  // throughout, because the rows WERE being written — just without the column
  // every ISIN-keyed join reads. A gap that is only visible to someone who
  // thinks to run a `countDocuments` against the table is a gap that stays open
  // for as long as nobody thinks to. `isinUnresolved` is the number that has to
  // trend DOWN as the instrument master fills in; `isinUnkeyable` is a
  // different alarm entirely — a feed tagging rows with a venue this join
  // cannot place — and is reported separately for that reason.
  const measurements =
    `symbols=${bySymbol.size} withChanges=${symbolsWithActions} ` +
    `created=${totalCreated} merged=${totalUpdated} ` +
    `upsertFailures=${upsertFailures} snapshots=${snapshots} ` +
    `snapshotFailures=${snapshotFailures} screenerHits=${screenerHits} ` +
    `isinResolved=${isinTally.resolved} ` +
    `isinUnresolved=${isinTally.unresolved} ` +
    `isinUnkeyable=${isinTally.unkeyable} ` +
    `window=${formatNSEDate(fromDate)}..${formatNSEDate(toDate)}` +
    (failedSymbols.length > 0 ? ` failed=[${failedSymbols.join(", ")}]` : "");

  if (upsertFailures > 0) {
    logger.error(
      `Sync complete WITH FAILURES: ${measurements} — every failed symbol is a ` +
        `hole in COST-BASIS data (splits/bonuses/dividends feed the FIFO ` +
        `adjustment); re-run corp-actions-backfill for this window`,
    );
  } else {
    logger.info(`Sync complete: ${measurements}`);
  }

  report({
    job: "corp-actions-sync",
    selected: bySymbol.size,
    // Symbols whose rows reached the DB, not rows — `upsertCorporateActions`
    // reports created/updated per call and one symbol is one call.
    written: bySymbol.size - upsertFailures,
    failed: upsertFailures,
    skippedReason: measurements,
  });

  // Every symbol failed. That is not a per-symbol flake the loop is designed to
  // absorb — it is the DB or the service being unavailable for the whole run, so
  // nothing was persisted and a redelivery is both safe (the upsert dedupes on
  // [symbol, exchange, type, exDate]) and the only way the window is not simply
  // lost.
  if (bySymbol.size > 0 && upsertFailures === bySymbol.size) {
    throw new Error(
      `Corp-actions sync persisted NOTHING: all ${bySymbol.size} symbol(s) ` +
        `failed to upsert. ${measurements}`,
    );
  }
}
