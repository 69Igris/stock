/**
 * Precedence between `DailyPrice.source` values — MONEY-1175.
 *
 * ## The bug this exists to prevent
 *
 * `DailyPrice` is unique on `(instrumentId, date)`, so exactly one source owns
 * each cell and writers must decide who wins. Two writers each made that
 * decision locally, and they disagreed:
 *
 *   feed-parse `writeCash`      skip if a row exists  (history never clobbers)
 *   bhavcopy-sync `upsert…`     overwrite whatever is there
 *
 * The skip had a sound INTENT — a day already ingested by the nightly job is
 * live data and history must not overwrite it — but it was implemented as
 * "anything that already exists wins". A Yahoo row is not live exchange data;
 * it is a third-party, split-ADJUSTED approximation. So wherever Yahoo had
 * reached a date first (chart-driven on-demand backfill, the price-sync
 * worker), the authoritative exchange bhavcopy was silently discarded. Measured
 * on prod: RELIANCE kept 297 exchange rows against 7,646 Yahoo, HDFCBANK 147
 * against 7,649, while symbols Yahoo never covered (NIFTYBEES) came out
 * complete back to 2002.
 *
 * The missing concept was never "skip vs overwrite" — it was a PRECEDENCE
 * ORDER. This module is that order, in one place, so the two writers cannot
 * drift apart again.
 *
 * ## Why the ranks are where they are
 *
 * The exchange's own bhavcopy is ground truth: it is what actually printed, in
 * raw (unadjusted) rupees. Yahoo is a redistributor that returns SPLIT-ADJUSTED
 * closes — verified empirically, not assumed: the bhavcopy/Yahoo ratio for
 * RELIANCE is a step function (13.933 -> 8.831 -> 4.364 -> 2.197) whose steps
 * land exactly on the 2006 demerger and the 2009/2017 1:1 bonuses. Mixing the
 * two on one series draws a cliff wherever the source flips.
 *
 * BHAVCOPY and BHAVCOPY_HIST are deliberately EQUAL. They are the same
 * exchange file arriving by two ingest paths — nightly vs. historical replay —
 * so neither is more true than the other.
 *
 * ## Why upgrades require STRICTLY greater authority
 *
 * Equal authority must NOT overwrite, for two reasons. It preserves the
 * original rule (a historical re-parse cannot clobber the nightly's copy of the
 * same day), and it keeps re-parsing idempotent: at equal rank a re-run
 * rewrites every row it already wrote, turning a no-op into millions of
 * pointless writes and a churned oplog.
 */

/**
 * Higher wins. Values are spaced so a tier can be inserted later without
 * renumbering (a licensed real-time feed would slot at 75, between the broker
 * and the exchange).
 */
export const PRICE_SOURCE_AUTHORITY: Readonly<Record<string, number>> = {
  /** NSE/BSE bhavcopy via the nightly sync — the exchange's own print. */
  BHAVCOPY: 100,
  /** The same exchange file replayed from the GCS archive. Equal by design. */
  BHAVCOPY_HIST: 100,
  /**
   * Licensed vendor of US exchange EOD, with the CRSP adjustment inputs
   * (`divCash` + `splitFactor`) on every bar — MONEY-980.
   *
   * ## Why 60: above the broker, below the reserved real-time slot
   *
   * Above ZERODHA (50) because for the job this table arbitrates — "whose number
   * belongs in this cell" — Tiingo is strictly the better witness. Kite's
   * historical candles are a BROKER's view: licensed, partial in coverage and
   * bounded in history, and the CLAUDE.md note records that our Personal-tier
   * app has no quote entitlement at all. Tiingo returns a security's ENTIRE
   * history in one call (AAPL: 11,517 bars back to 1980, measured 2026-08-28)
   * and returns it RAW, with the corporate actions alongside — which is the
   * property that lets us recompute the adjusted series instead of inheriting
   * somebody's restatement of it.
   *
   * Below 75 because the module header already reserves that slot for a licensed
   * REAL-TIME feed, and EOD is not that. Below BHAVCOPY (100) because a
   * redistributor, however good, is not the exchange's own print — the whole
   * MONEY-1175 lesson is that the distinction has to survive contact with a
   * vendor that looks authoritative.
   *
   * Above YAHOO (10) by a wide margin, and for a reason that is measurable
   * rather than reputational: Yahoo's stored `close` is SPLIT-ADJUSTED (the
   * bhavcopy/Yahoo ratio for RELIANCE is a step function whose steps land
   * exactly on the 2006 demerger and the 2009/2017 bonuses), so its bars cannot
   * be mixed with raw ones at all. Tiingo's are raw by contract.
   *
   * NOTE this table now arbitrates TWO collections — `daily_prices` and
   * `candles`. That is deliberate: it is ONE precedence rule, and the last time
   * two writers each decided precedence locally they disagreed and RELIANCE kept
   * 297 exchange rows against 7,646 Yahoo ones.
   */
  TIINGO: 60,
  /**
   * Consolidated-venue-blend US intraday bars — TRADE-derived, with real
   * volume (MONEY-1373).
   *
   * ## Why 55: below TIINGO, above ZERODHA
   *
   * BELOW TIINGO (60) DELIBERATELY, and this is the load-bearing half. Tiingo
   * owns the daily series — it is the backbone the `candles` warehouse was
   * built on, it returns a security's entire history raw with the CRSP
   * adjustment inputs alongside, and the read-time adjustment is computed from
   * those columns. A `D1` collision between the two must therefore be REFUSED,
   * and the point of ranking it here is that the refusal is STRUCTURAL: it
   * falls out of `shouldUpgradePriceSource` with nobody having to remember a
   * guard. A guard somebody has to remember is a guard that is missing on the
   * next writer.
   *
   * ABOVE ZERODHA (50) because a multi-venue blend is a better witness to what
   * printed than one broker's partial view. That is the same argument that put
   * TIINGO above ZERODHA and it applies with more force here: Kite's candles
   * are bounded in history and, on our Personal-tier app, carry no quote
   * entitlement at all.
   *
   * Note this rank arbitrates the CELL, not the day. The day-level rule that
   * keeps quote-derived and trade-derived bars out of one another's sessions
   * is `mayWriteIntoDay` in `tiingo-rt-sink-logic.ts`, and it is a property
   * test rather than a ranking — it refuses in BOTH directions.
   */
  DATABENTO: 55,
  /** Broker historical candles (Kite). Real trades, but licensed and partial. */
  ZERODHA: 50,
  /**
   * Realtime quote-MID bars, with a structural `volume: 0` (MONEY-1373).
   *
   * `tiingo-rt-sink-logic.ts`'s own header states the measurement: every
   * captured frame is top-of-book, there is no print in the feed, so a bar's
   * OHLC is built from the mid and its volume 0 MEANS "this feed does not
   * report volume", not "nothing traded".
   *
   * ABOVE YAHOO (10) because it is a licensed live feed carrying RAW prices,
   * where Yahoo's stored `close` is split-ADJUSTED and cannot be mixed with
   * raw bars at all. BELOW every trade-derived source, because a mid is not a
   * transaction.
   *
   * Until now it fell through to `UNKNOWN_SOURCE_AUTHORITY` (1). Making it
   * explicit is the point — an unranked source that a live job writes daily is
   * a policy nobody declared — and it changes exactly one existing comparison:
   * it now sorts above YAHOO rather than below it.
   */
  TIINGO_RT: 20,
  /** Third-party redistributor. Split-ADJUSTED closes; approximate. */
  YAHOO: 10,
};

/** Unknown sources rank below everything known but above "no row at all". */
export const UNKNOWN_SOURCE_AUTHORITY = 1;

export function priceSourceAuthority(
  source: string | null | undefined,
): number {
  if (!source) return UNKNOWN_SOURCE_AUTHORITY;
  return PRICE_SOURCE_AUTHORITY[source] ?? UNKNOWN_SOURCE_AUTHORITY;
}

/**
 * May `incoming` overwrite a row currently owned by `existing`?
 *
 * STRICTLY greater — see the module header for why equality must not upgrade.
 */
export function shouldUpgradePriceSource(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  return priceSourceAuthority(incoming) > priceSourceAuthority(existing);
}

/**
 * May `incoming` WRITE over a row owned by `existing`?
 *
 * Weaker than `shouldUpgradePriceSource`: this one allows equality, because a
 * live writer legitimately refreshes its OWN bar — the intraday Yahoo path
 * rewrites today's close as it moves. What it must never do is silently
 * replace a higher-authority row: today's `dailyPrice.upsert` rewrote OHLC in
 * its `update:` clause WITHOUT touching `source`, so an exchange-stamped row
 * could take Yahoo's numbers while still claiming to be exchange data. That is
 * a provenance lie — worse than a wrong price, because nothing downstream can
 * detect it.
 */
export function mayWritePriceSource(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  return priceSourceAuthority(incoming) >= priceSourceAuthority(existing);
}

/**
 * Split a day's worth of resolved rows into create / upgrade / preserve.
 *
 * Callers hand in the rows they parsed plus whatever already occupies those
 * (instrumentId, date) cells, and get back the three disjoint sets. Keeping
 * this pure makes the precedence rule testable without a database, which is
 * the whole point — the original bug was a one-line policy buried in a writer
 * where nothing asserted it.
 *
 * Also collapses in-batch repeats: one exchange file can legitimately list the
 * same instrument twice (multiple series), and a repeat reaching `createMany`
 * aborts the entire chunk on the unique index. First occurrence wins.
 */
export function partitionPriceWrites<T extends { instrumentId: string }>(
  incoming: readonly T[],
  incomingSource: string,
  existing: ReadonlyMap<string, { id: string; source: string | null }>,
): {
  create: T[];
  upgrade: Array<{ row: T; existingId: string; existingSource: string | null }>;
  preserved: number;
  dupInBatch: number;
} {
  const create: T[] = [];
  const upgrade: Array<{
    row: T;
    existingId: string;
    existingSource: string | null;
  }> = [];
  let preserved = 0;
  let dupInBatch = 0;

  const seen = new Set<string>();
  for (const row of incoming) {
    if (seen.has(row.instrumentId)) {
      dupInBatch++;
      continue;
    }
    seen.add(row.instrumentId);

    const current = existing.get(row.instrumentId);
    if (!current) {
      create.push(row);
      continue;
    }
    if (shouldUpgradePriceSource(current.source, incomingSource)) {
      upgrade.push({
        row,
        existingId: current.id,
        existingSource: current.source,
      });
    } else {
      preserved++;
    }
  }

  return { create, upgrade, preserved, dupInBatch };
}
