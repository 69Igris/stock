/**
 * Bhavcopy-sync processor — PURE orchestration logic (no Prisma / network).
 *
 * Side-effect-free helpers extracted out of `bhavcopy-sync.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting a
 * Prisma client or hitting BSE/NSE. `bhavcopy-sync.ts` imports and CALLS every
 * export here, so the production path and the tests run the SAME code. Mirrors
 * the worker precedent `price-sync-logic.ts` / `import-logic.ts`.
 *
 * What lives here (all side-effect-free):
 *   - `resolveTargetDay`     — message `date` (YYYY-MM-DD) → Date, else the most
 *                              recent NON-trading-aware weekday/holiday-skipped
 *                              day on or before "now".
 *   - `resolveBackfillDays`  — `[backfillFrom, backfillTo]` → ascending list of
 *                              trading days (weekends + holidays skipped).
 *   - `resolveExchanges`     — message `exchanges` → deduped ["BSE","NSE"] order.
 *   - `buildInstrumentIndex` — InstrumentMapping rows → ISIN + symbol\@exchange
 *                              lookup maps (the join used by the upsert).
 *   - `resolveInstrumentId`  — a bhavcopy row → the matching instrumentId via
 *                              ISIN first, then symbol+exchange.
 *
 * @see workers/src/processors/bhavcopy-sync.ts (caller)
 */

import { toIstDateKey, getNonTradingReason } from "@usemoney/core/market-data";
import type { BhavcopyRow } from "@usemoney/core/market-data";
import { classifyCashInstrument } from "@usemoney/core/market-data/instrument-classification";
import type { CashInstrumentClass } from "@usemoney/core/market-data/instrument-classification";

/** Exchanges we ingest, in deterministic order. */
export type BhavcopyExchange = "BSE" | "NSE";
const DEFAULT_EXCHANGES: readonly BhavcopyExchange[] = ["BSE", "NSE"];

/** Hard cap on how many days a single backfill run will walk (safety rail). */
export const MAX_BACKFILL_DAYS = 400;

/**
 * Parse a `YYYY-MM-DD` (IST calendar) string into a UTC-noon Date.
 *
 * UTC noon (not midnight) so that the later IST conversion (+5:30) can never
 * roll the calendar day backwards or forwards regardless of host TZ — the
 * filename token + DailyPrice date are both derived from the IST parts of this
 * Date, so the anchor must be unambiguous. Returns `null` for a malformed
 * string.
 */
export function parseIsoDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  // Reject impossible dates (e.g. 2026-02-31 rolled over by Date.UTC).
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/** A UTC-noon Date for an IST day N days before the given anchor. */
function minusDays(anchor: Date, days: number): Date {
  return new Date(anchor.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Resolve the trading day to ingest.
 *
 * - An explicit `date` (YYYY-MM-DD) is honored verbatim (used by manual
 *   re-runs / backfill drivers) — even if it's a weekend/holiday, because the
 *   caller asked for it specifically and a 404 will just no-op.
 * - Otherwise walk backwards from `now` to the most recent day that is NOT a
 *   weekend or NSE holiday. The daily scheduler fires post-EOD, so "today" (if
 *   a trading day) is the target; a Monday run resolves to the prior Friday's
 *   file only if Monday is a holiday.
 *
 * Returns a UTC-noon Date anchor (see `parseIsoDay`).
 */
export function resolveTargetDay(
  date: string | undefined,
  now: Date = new Date(),
): Date {
  if (date) {
    const parsed = parseIsoDay(date);
    if (parsed) return parsed;
    // Malformed → fall through to auto-resolution rather than throwing.
  }

  // Anchor "now" at UTC noon of its IST calendar day so day-walking is stable.
  const istKey = toIstDateKey(now); // YYYY-MM-DD (IST)
  let cursor = parseIsoDay(istKey) ?? new Date(now.getTime());

  for (let i = 0; i < 15; i++) {
    if (!getNonTradingReason(cursor).isClosed) return cursor;
    cursor = minusDays(cursor, 1);
  }
  // Fallback (shouldn't happen — 15 days always contains a trading day).
  return cursor;
}

/**
 * Resolve the ascending list of trading days for a backfill window.
 *
 * Both bounds are inclusive `YYYY-MM-DD` IST days. Weekends + NSE holidays are
 * skipped (the files don't exist on those days). Returns `[]` when either bound
 * is malformed or the window is inverted. Capped at `MAX_BACKFILL_DAYS`
 * resulting days as a safety rail.
 */
export function resolveBackfillDays(
  from: string | undefined,
  to: string | undefined,
  cap: number = MAX_BACKFILL_DAYS,
): Date[] {
  if (!from || !to) return [];
  const start = parseIsoDay(from);
  const end = parseIsoDay(to);
  if (!start || !end) return [];
  if (start.getTime() > end.getTime()) return [];

  const days: Date[] = [];
  let cursor = start;
  // Bound the loop independently of `cap` so a huge window can't spin forever.
  for (let i = 0; i <= cap * 2 + 1 && cursor.getTime() <= end.getTime(); i++) {
    if (!getNonTradingReason(cursor).isClosed) {
      days.push(cursor);
      if (days.length >= cap) break;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

/**
 * Resolve which exchanges to fetch from the message, deduped and in the
 * canonical BSE-then-NSE order. Empty/omitted → both.
 */
export function resolveExchanges(
  exchanges: BhavcopyExchange[] | undefined,
): BhavcopyExchange[] {
  if (!exchanges?.length) return [...DEFAULT_EXCHANGES];
  const set = new Set(exchanges);
  return DEFAULT_EXCHANGES.filter((e) => set.has(e));
}

/** The InstrumentMapping fields the bhavcopy join reads. */
export interface JoinInstrument {
  id: string;
  isin: string | null;
  symbol: string;
  exchange: string;
}

/** Lookup maps for joining bhavcopy rows to instrument ids. */
export interface InstrumentIndex {
  /**
   * "ISIN@EXCHANGE" (upper) → instrumentId.
   *
   * MONEY-1085: this key used to be the bare ISIN, which made the fallback
   * exchange-agnostic AND first-wins. See {@link resolveInstrumentId} for why
   * that was a data-corruption bug rather than a convenience.
   */
  byIsinExchange: Map<string, string>;
  /** "SYMBOL@EXCHANGE" (upper) → instrumentId. */
  bySymbolExchange: Map<string, string>;
}

/** Composite key for the symbol+exchange fallback map. */
export function symbolExchangeKey(symbol: string, exchange: string): string {
  return `${symbol.trim().toUpperCase()}@${exchange.trim().toUpperCase()}`;
}

/** Composite key for the ISIN fallback map — ISIN alone is NOT unique. */
export function isinExchangeKey(isin: string, exchange: string): string {
  return `${isin.trim().toUpperCase()}@${exchange.trim().toUpperCase()}`;
}

/**
 * Build the ISIN\@exchange + symbol\@exchange lookup maps from
 * InstrumentMapping rows.
 *
 * A single ISIN legitimately maps to BOTH an NSE and a BSE listing — it
 * identifies the *security*, not the listing. Both maps are therefore keyed by
 * exchange so a row can only ever resolve to a listing on its own exchange.
 */
export function buildInstrumentIndex(
  instruments: JoinInstrument[],
): InstrumentIndex {
  const byIsinExchange = new Map<string, string>();
  const bySymbolExchange = new Map<string, string>();
  for (const inst of instruments) {
    if (inst.isin) {
      const isin = inst.isin.trim().toUpperCase();
      if (isin)
        byIsinExchange.set(isinExchangeKey(isin, inst.exchange), inst.id);
    }
    bySymbolExchange.set(
      symbolExchangeKey(inst.symbol, inst.exchange),
      inst.id,
    );
  }
  return { byIsinExchange, bySymbolExchange };
}

/**
 * Resolve a bhavcopy row to an instrumentId.
 *
 * Priority:
 *   1. symbol+exchange — the most precise (an ISIN spans both exchanges, the
 *      row's own symbol+exchange pins the exact listing we're seeding).
 *   2. ISIN+exchange — fallback when the symbol differs (BSE often uses a
 *      numeric scrip code in TckrSymb that won't match our NSE-style symbol).
 *
 * Returns `null` when neither resolves (instrument not in our universe yet).
 *
 * ## Why the ISIN fallback is exchange-SCOPED (MONEY-1085)
 *
 * `DailyPrice` is keyed `[instrumentId, date]` and has no exchange column, so
 * `instrumentId` IS the exchange discriminator. If an NSE bhavcopy row resolved
 * to the security's BSE listing, we would write NSE's closing price onto the BSE
 * instrument — two different prices for the same day, silently, with no error.
 *
 * This was live: 293 of the NSE rows that failed to match existed in
 * `instrument_mappings` ONLY as their BSE listing. Under the old bare-ISIN key
 * (first-wins, so which exchange won depended on row order) populating
 * `InstrumentMapping.isin` would have started corrupting those instead of
 * dropping them. Scoping the key makes that outcome unrepresentable.
 */
export function resolveInstrumentId(
  row: Pick<BhavcopyRow, "isin" | "symbol" | "exchange">,
  index: InstrumentIndex,
): string | null {
  const bySym = index.bySymbolExchange.get(
    symbolExchangeKey(row.symbol, row.exchange),
  );
  if (bySym) return bySym;

  if (row.isin) {
    const byIsin = index.byIsinExchange.get(
      isinExchangeKey(row.isin, row.exchange),
    );
    if (byIsin) return byIsin;
  }
  return null;
}

/**
 * Pick the bhavcopy rows that need an InstrumentMapping minted for them.
 *
 * Exchange-traded trusts (NSE series RR = REIT, IV = InvIT) are the only rows
 * we ever create an instrument from, because they are the only ones with no
 * other source: NSE publishes no REIT/InvIT master and Zerodha's dump carries
 * only their BSE listing. Everything else must come from an instrument master.
 *
 * Selection is deliberately narrow and testable so a parser regression can't
 * widen it into "mint the universe from a price file":
 *   - NSE only,
 *   - series in `trustSeries` only,
 *   - not already resolvable by symbol@exchange,
 *   - deduped by symbol (the file has one row per instrument, but a malformed
 *     file must not produce N upserts for the same symbol).
 *
 * ## Why the row type is generic (MONEY-1157)
 *
 * This is a FILTER: every element it returns is an element it was handed, so
 * the output row type must be the INPUT row type. It used to declare both as
 * `Pick<BhavcopyRow, "symbol" | "exchange" | "series">`, which threw away every
 * other field of whatever the caller passed. The caller
 * (`mintMissingTrustInstruments`) hands it full `BhavcopyRow`s and reads `name`
 * and `isin` off the results to build the InstrumentMapping — so the DECLARED
 * type was narrower than the values that actually flow through, and `tsc`
 * flagged those reads (TS2339). `tsup`/esbuild never type-checks, so the build
 * stayed green and the runtime stayed correct the whole time.
 *
 * The fix is the type, not the code: narrowing the returned objects to the old
 * `Pick` would have silently dropped `name` and `isin` from every REIT/InvIT
 * minted from the bhavcopy — a data defect no test would have caught, since
 * `name` falls back to the symbol and `isin` is spread conditionally.
 * The `T extends Pick<…>` bound keeps the selection contract (a caller still
 * only needs those three fields) while preserving the caller's row type.
 */
export function selectTrustsToMint<
  T extends Pick<BhavcopyRow, "symbol" | "exchange" | "series">,
>(
  rows: readonly T[],
  index: Pick<InstrumentIndex, "bySymbolExchange">,
  trustSeries: Record<string, string>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (row.exchange !== "NSE") continue;
    if (trustSeries[row.series] === undefined) continue;
    const key = symbolExchangeKey(row.symbol, row.exchange);
    if (index.bySymbolExchange.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Normalise an NSE index display name into a stable key.
 *
 * NSE's `ind_close_all_*` file identifies an index only by display name, and
 * that name is cosmetically unstable across years ("Nifty 50", "NIFTY 50",
 * "Nifty50 USD"). Keying `IndexClose` on the raw name would silently fork one
 * index's history into two the day NSE changes its capitalisation, so the
 * unique key is this slug instead and the raw name is stored alongside for
 * display.
 *
 *   "Nifty 50"                        -> "nifty-50"
 *   "NIFTY BANK"                      -> "nifty-bank"
 *   "Nifty BHARAT Bond Index - Apr 33"-> "nifty-bharat-bond-index-apr-33"
 */
export function toIndexSlug(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* =====================================================================
   Instrument metadata backfill  (MONEY-1093)
   ---------------------------------------------------------------------
   `InstrumentMapping.series` was uniformly "EQ" on all 22,090 active rows
   (a stamped default, never exchange-sourced) and `isin` was populated on
   ZERO of them. Those are the two fields that would have prevented 11,795
   debt instruments from being typed EQUITY — and the bhavcopy has carried
   both, every day, since MONEY-851. The worker parsed them into
   `BhavcopyRow` and used them only to mint REIT/InvIT rows.

   This planner turns the rows we already resolved into the minimal set of
   writes needed to make those two fields real. Pure so the decisions are
   testable without a database; the caller applies them.

   Two properties that matter:

   - Only CHANGES are planned. Re-running on a settled universe plans
     nothing, so this is safe on every daily run rather than a one-off.
   - ISIN is written only when ABSENT, never overwritten. The exchange file
     is authoritative for a NEW value, but silently rewriting an existing
     ISIN would let one bad file repoint a security — and `DailyPrice` has
     no exchange column, so a mis-pointed instrument writes prices onto the
     wrong listing (the MONEY-1085 failure).

   ## instrumentType — one-time per row, by construction

   `instrumentType` is `String @default("EQUITY")` and therefore NEVER
   null, so "write it if missing" has to mean "write it if the stored value
   is still the stamped default" — i.e. no evidence was ever recorded for
   this row. That single guard gives every property wanted here:

     - it is ONE-TIME per row: once a row moves off "EQUITY" it can never
       be selected again, so the daily run converges and then no-ops;
     - it cannot overwrite a deliberate classification, whether that came
       from the audited repair script or from Kite positively identifying
       an ETF;
     - it cannot fight the nightly instrument sync, which (since the
       `mapToUpdate` split) no longer writes instrumentType on an existing row
       AT ALL — not merely "when its own value is the generic EQUITY". The
       narrower phrasing implied a positive identification would still be
       written, which is what `reclassify-instruments.ts` relied on when it
       excluded REIT/INVIT.

   Classifying from the row we are HOLDING is also stronger than the repair
   script's readiness gate can be: the script reads a STORED `series` that
   may still be the stale default, whereas the series here came out of the
   exchange file being parsed right now.

   ## THIS IS A BSE-ONLY MECHANISM. NSE debt cannot reach it.

   An earlier version of this note claimed "both exchanges are covered". That
   is false, and the reason is upstream: `parseUdiffBhavcopy` applies
   `keepSeries` at PARSE time, and for NSE that is `NSE_CASH_SERIES.has(series)`
   — so every NSE debt series (GS/GB/TB/SG and the churning N-, Y- and Z-prefixed families)
   is DISCARDED before this planner ever sees the row. A `BhavcopyRow` carrying
   an NSE debt series cannot exist.

   Consequences, stated plainly so nobody rediscovers them:
     - on the NSE leg this can only ever emit ETF; DEBT is unreachable;
     - no writer anywhere puts a real NSE debt series into
       `InstrumentMapping.series` (Zerodha stamps "EQ" on create only, the NSE
       master files are equity-only, the BSE enricher is BSE-only), so NSE
       bonds sit at `series="EQ"` indefinitely;
     - `classifyCashInstrument({exchange:"NSE", series:"EQ"})` returns a
       CONFIDENT `{klass:"EQUITY"}` — not an abstention — so those rows are
       never retyped AND never surface in the UNKNOWN report.

   Of the 11,795 mistyped rows, BSE groups F+G account for 7,607. The residual
   ~4,188 NSE rows are OUT OF SCOPE for this mechanism and for the repair
   script. Fixing that needs the price path and the classification path to use
   different filters (keep dropping debt from the PRICE seed, but let metadata
   see it) — deliberately not attempted here.

   Only DEBT and ETF are written. REIT/INVIT are equally mistyped, but no
   consumer branches on those types and the news, filings, BSE-announcement
   and financial-data syncs ALL gate on `instrumentType: "EQUITY"`. For a
   bond, losing that coverage is the point; for a trust a user actually
   holds, it is a regression.
   ===================================================================== */

/** What the backfill knows about an instrument as currently stored. */
export interface StoredInstrumentMeta {
  id: string;
  series: string | null;
  isin: string | null;
  /** Current type. Absent is treated as the default "EQUITY". */
  instrumentType?: string | null;
  /**
   * Broker/exchange segment, forwarded to the classifier.
   *
   * Carried because `ClassifyInput` requires it and an OMITTED segment does not
   * abstain — it returns EQUITY for an index row, and EQUITY is sector-bearing.
   */
  segmentCode?: string | null;
}

/**
 * Types this backfill will write. Deliberately NOT every non-equity class —
 * see the header note on REIT/INVIT losing news and filings coverage.
 */
export const BACKFILL_TYPES: ReadonlySet<CashInstrumentClass> = new Set([
  "DEBT",
  "ETF",
]);

/**
 * The `data` written when the backfill retypes a row.
 *
 * Pure and exported so the "clears sector for DEBT and ONLY for DEBT" rule is a
 * real assertion. The previous guard regex-matched object literals in the
 * source and could be defeated by hoisting the condition — a refactor that made
 * the clear UNCONDITIONAL kept it green, on an unattended destructive write
 * with no rollback file.
 *
 * Clearing the sector is part of the DEBT decision: a sector on a row we have
 * just proven is a bond is noise, and it leaks to users through the holdings
 * read-time join, which has no instrumentType filter. ETF is excluded because
 * an ETF legitimately HAS a sector.
 */
export function buildTypeWriteData(instrumentType: string): {
  instrumentType: string;
  sector?: null;
  industry?: null;
} {
  return instrumentType === "DEBT"
    ? { instrumentType, sector: null, industry: null }
    : { instrumentType };
}

/** The stamped default that means "no evidence recorded". */
export const DEFAULT_INSTRUMENT_TYPE = "EQUITY";

/** The minimal write set. */
export interface MetadataBackfillPlan {
  /** series value → instrument ids to set it on. Grouped so the caller can
   *  issue one `updateMany` per distinct series (~14 for a real day) rather
   *  than one per row. */
  seriesGroups: Map<string, string[]>;
  /** Per-instrument ISIN writes. Only for rows that currently have none, so
   *  this shrinks toward zero after the first run. */
  isinUpdates: Array<{ id: string; isin: string }>;
  /** instrumentType → ids to set it on, for rows still carrying the stamped
   *  default. Grouped so the caller issues one `updateMany` per type. */
  typeGroups: Map<string, string[]>;
}

/**
 * Plan the series/ISIN writes implied by one day's resolved bhavcopy rows.
 *
 * @param resolved  rows already joined to an instrumentId
 * @param stored    current series/isin for those instruments
 */
export function planMetadataBackfill(
  resolved: Array<{
    instrumentId: string;
    series: string;
    isin: string | null;
    /** Classification inputs. Optional so existing callers keep working;
     *  without them no type is planned (the classifier cannot abstain on
     *  information it was never given). */
    symbol?: string;
    name?: string;
    exchange?: string;
  }>,
  stored: StoredInstrumentMeta[],
): MetadataBackfillPlan {
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const seriesGroups = new Map<string, string[]>();
  const isinUpdates: Array<{ id: string; isin: string }> = [];
  // A day's file can list the same instrument once per row; dedupe so a
  // repeated symbol cannot queue the same write twice.
  const seenSeries = new Set<string>();
  const seenIsin = new Set<string>();
  const seenType = new Set<string>();
  const typeGroups = new Map<string, string[]>();

  for (const row of resolved) {
    const cur = storedById.get(row.instrumentId);
    if (!cur) continue;

    const series = String(row.series ?? "")
      .trim()
      .toUpperCase();
    if (
      series &&
      series !== (cur.series ?? "").trim().toUpperCase() &&
      !seenSeries.has(row.instrumentId)
    ) {
      seenSeries.add(row.instrumentId);
      const group = seriesGroups.get(series) ?? [];
      group.push(row.instrumentId);
      seriesGroups.set(series, group);
    }

    const isin = String(row.isin ?? "")
      .trim()
      .toUpperCase();
    // Absent only. See the header on why an existing ISIN is never rewritten.
    if (isin && !cur.isin && !seenIsin.has(row.instrumentId)) {
      seenIsin.add(row.instrumentId);
      isinUpdates.push({ id: row.instrumentId, isin });
    }

    // ── instrumentType, only while it is still the stamped default ──
    const currentType = (cur.instrumentType ?? DEFAULT_INSTRUMENT_TYPE).trim();
    if (
      row.symbol &&
      row.exchange &&
      currentType === DEFAULT_INSTRUMENT_TYPE &&
      !seenType.has(row.instrumentId)
    ) {
      const { klass } = classifyCashInstrument({
        symbol: row.symbol,
        name: row.name ?? row.symbol,
        exchange: row.exchange,
        // The series from the FILE, not the possibly-stale stored value.
        series,
        // Both FORWARDED rather than omitted. `row.isin` was already in hand a
        // few lines above and was being dropped, which silently weakened every
        // rule that uses it as a corroborating gate; and an omitted
        // `segmentCode` does not abstain, it returns EQUITY for an index.
        isin: row.isin ?? null,
        segmentCode: cur.segmentCode ?? null,
      });
      // UNKNOWN and EQUITY are both no-ops: one is an abstention, the other
      // is what the row already says.
      if (BACKFILL_TYPES.has(klass)) {
        seenType.add(row.instrumentId);
        const g = typeGroups.get(klass) ?? [];
        g.push(row.instrumentId);
        typeGroups.set(klass, g);
      }
    }
  }

  return { seriesGroups, isinUpdates, typeGroups };
}

/**
 * Is `day` a HISTORICAL re-seed rather than the run the scheduler intended?
 *
 * Pure, exported and tested — the live worker composes it from
 * `resolveTargetDay(undefined)`. It was previously an inline arrow guarded only
 * by three source-text regexes (`/isHistoricalDay\s*=/`,
 * `/isHistoricalDay\(day\)/`, `/resolveTargetDay\(undefined\)/`), which two
 * mutations walked straight past with all 47 cases green:
 *
 *   - flipping `!==` to `===`, which makes the nightly run SKIP the
 *     classification the job exists to do and makes every historical replay
 *     perform the unattended destructive retype and sector clear;
 *   - replacing the body with `return false` while keeping all three tokens.
 *
 * The predicate is compared against the AUTO-resolved target rather than
 * against "today" on purpose: on a Monday, or after a holiday, the nightly run
 * legitimately processes Friday's file, and a naive `day < today` would call
 * that historical and skip the work.
 *
 * @param autoKey IST date key of the day the scheduler would pick on its own.
 * @param day     the day actually being ingested.
 */
export function isHistoricalRun(autoKey: string, dayKey: string): boolean {
  return dayKey !== autoKey;
}
