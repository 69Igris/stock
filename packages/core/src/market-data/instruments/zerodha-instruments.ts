/**
 * Zerodha Instrument Provider
 *
 * Fetches the complete instrument master dump from Zerodha's Kite API.
 * This is the primary source for Indian market instruments (~120K rows).
 *
 * The CSV is publicly accessible with just an API key (no user auth needed).
 * Endpoint: https://api.kite.trade/instruments
 *
 * CSV columns:
 * instrument_token, exchange_token, tradingsymbol, name, last_price,
 * expiry, strike, tick_size, lot_size, instrument_type, segment, exchange
 */

import type { Prisma } from "@usemoney/database";
import type { InstrumentProvider, RawInstrument } from "./types";
import { US_EXCHANGES, YAHOO_SUFFIX_MAP } from "./types";
import {
  type ZerodhaCSVRow,
  parseInstrumentCsv,
  shouldInclude,
  mapCSVRowToRaw,
} from "./zerodha-instruments-logic";

// NOTE: The pure parsing/classification helpers (isETF, parseInstrumentCsv,
// shouldInclude, INSTRUMENT_TYPE_MAP, etc.) live in and are exported from
// `./zerodha-instruments-logic`. Import them from there directly — they are
// intentionally NOT re-exported through this module to avoid a circular
// re-export TDZ when the whole `market-data` barrel is evaluated.

const ZERODHA_INSTRUMENTS_URL = "https://api.kite.trade/instruments";

export class ZerodhaInstrumentProvider implements InstrumentProvider {
  name = "ZERODHA";

  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey =
      apiKey ||
      process.env.ZERODHA_SYSTEM_API_KEY ||
      process.env.ZERODHA_API_KEY ||
      "";
    if (!this.apiKey) {
      console.warn(
        "ZERODHA_SYSTEM_API_KEY (or ZERODHA_API_KEY) not set. Instrument sync will fail.",
      );
    }
  }

  async fetchInstruments(): Promise<RawInstrument[]> {
    if (!this.apiKey) {
      throw new Error("ZERODHA_SYSTEM_API_KEY is required for instrument sync");
    }

    // DELIBERATELY NOT routed through `getFeedAsset` (the MONEY-1085 archive
    // seam) — MONEY-1157. This is the one exempt upstream fetch in
    // packages/core, and the exemption is machine-checked by
    // `__tests__/market-data/no-feed-fetch-bypass.test.ts`, which pins it to
    // this exact endpoint and to exactly one call. It cannot silently widen.
    //
    // Why exempt rather than archived:
    //
    //   1. The seam's contract is exchange-WEBSITE-shaped and wrong here. It
    //      sends browser-impersonation headers (they exist because NSE/BSE 403
    //      obvious bot user agents), takes a `referer` positionally, and maps a
    //      404 to `null` meaning "file not published yet — weekend/holiday".
    //      For Kite a 404 means the endpoint moved, and returning "no rows"
    //      for that would look exactly like the silent-gap defect MONEY-1085
    //      set out to prevent. It must keep throwing.
    //
    //   2. The upside the archive buys is already declined for this feed on
    //      purpose. `instrument_mappings` is a QA-DIRECT collection precisely
    //      because this endpoint is public, tier-agnostic and unmetered — see
    //      the EXCLUDED block in `scripts/ops/sync-prod-to-qa.sh`. The feeds
    //      tier exists for the rate-limited hosts (`api.bseindia.com` is why
    //      `bse-announcements-sync` is prod-only); Kite is not one of them.
    //
    // If that ever changes — Kite starts rate-limiting, or QA's egress IP gets
    // throttled — the fix is to widen the seam (optional headers + a caller-
    // chosen 404 policy), not to delete the guard's allowlist entry.
    const response = await fetch(ZERODHA_INSTRUMENTS_URL, {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${this.apiKey}:`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Zerodha instruments: ${response.status} ${response.statusText}`,
      );
    }

    const csvText = await response.text();
    const { rows, reasons, dataLines } = parseInstrumentCsv(csvText);

    console.log(
      `Zerodha instruments CSV: ${rows.length} total rows (of ${dataLines} data lines)`,
    );

    // MONEY-1205 — a dropped line must never be silent.
    //
    // The parser used to `continue` past any line whose field count did not
    // match the header, which is exactly what a quoted `name` containing a
    // comma produces. That instrument then vanishes from the universe with no
    // log line, indistinguishable from "Kite stopped listing it" — and the
    // downstream symptom (a missing price, a missing search hit) shows up
    // somewhere else entirely, days later.
    //
    // Printed at ERROR level with the count, because the expected value is
    // zero: on 2026-08-18 all 114,426 data lines parsed. A non-zero number here
    // means the dump's shape changed and the row-count delta is real data loss.
    const dropped = Object.values(reasons).reduce((a, b) => a + b, 0);
    if (dropped > 0) {
      console.error(
        `Zerodha instruments CSV: DROPPED ${dropped} of ${dataLines} data ` +
          `lines — ${JSON.stringify(reasons)}. Expected 0. The dump's column ` +
          `shape may have changed; these instruments are missing from this sync.`,
      );
    }

    const filtered = rows.filter(shouldInclude);
    console.log(`After filtering: ${filtered.length} relevant instruments`);

    return filtered.map((row) => this.mapCSVRow(row));
  }

  /**
   * Map a Zerodha CSV row to a RawInstrument. Delegates to the shared pure
   * helper so the unit-tested code path is identical to production.
   */
  private mapCSVRow(row: ZerodhaCSVRow): RawInstrument {
    return mapCSVRowToRaw(row);
  }

  mapToUpsert(
    raw: RawInstrument,
  ): Partial<Prisma.InstrumentMappingCreateInput> {
    return {
      symbol: raw.symbol,
      exchange: raw.exchange,
      name: raw.name || raw.symbol,
      tradingSymbol: raw.tradingSymbol,
      instrumentType: raw.instrumentType,
      isin: raw.isin || undefined,
      series: raw.series,
      lotSize: raw.lotSize,
      tickSize: raw.tickSize,
      expiryDate: raw.expiryDate,
      strikePrice: raw.strikePrice,
      optionType: raw.optionType,
      segmentCode: raw.segmentCode,
      zerodhaToken: raw.zerodhaToken,
      isActive: true,
      lastSyncedAt: new Date(),
    };
  }

  /**
   * Kite's dump is authoritative for its own identifiers (token, trading
   * symbol, lot/tick size, expiry, strike) but NOT for two fields it only
   * appears to carry:
   *
   *   `series`  — never. `mapCSVRowToRaw` sets it from Kite's
   *               `instrument_type` column, which is "EQ" for every cash
   *               instrument (bonds, G-Secs and all), not the exchange's
   *               settlement series. The exchange bhavcopy and the NSE master
   *               files are the real sources, so this must never overwrite
   *               them — that collision is MONEY-1093.
   *
   *   `instrumentType` — NEVER, on an existing row. `INSTRUMENT_TYPE_MAP`
   *               falls back to "EQUITY" for anything it does not recognise,
   *               so "EQUITY" here means "no evidence" rather than "is an
   *               equity", and writing it reverted every deliberate DEBT /
   *               REIT / INVIT classification the night after it was made.
   *
   *               An earlier revision of this note said a POSITIVE result
   *               (ETF/REIT/INVIT from the name matcher) "IS evidence and still
   *               corrects a stale row". That is no longer true and has not been
   *               since the oscillation fix: the field is stripped
   *               unconditionally below. The claim mattered because
   *               `reclassify-instruments.ts` cited it as the reason skipping
   *               REIT/INVIT was safe.
   *
   * Consequence worth stating plainly: a row wrongly typed non-EQUITY can no
   * longer be healed by the nightly sync. That is the intended trade — the
   * classifier abstains rather than guesses, and `reclassify-instruments.ts`
   * writes a rollback snapshot — but it is a real narrowing, not a free win.
   */
  mapToUpdate(
    raw: RawInstrument,
  ): Partial<Prisma.InstrumentMappingCreateInput> {
    // NEITHER `series` NOR `instrumentType` on an existing row.
    //
    // The earlier version kept a POSITIVELY-identified type (ETF/REIT/INVIT from
    // the name matcher, FUTURES/OPTIONS from the segment) on the reasoning that
    // a positive match is evidence. It is — but it caused a live nightly
    // OSCILLATION: any row the audited repair script had typed DEBT whose Kite
    // NAME happens to match `isETF`/`classifyTrustInstrument` was flipped to
    // ETF/REIT at 22:00, and the next `reclassify --apply` flipped it back.
    //
    // The name matcher is also the weaker signal. `classifyCashInstrument`
    // deliberately runs it only when the exchange's series does not already say
    // "debt"; `mapCSVRowToRaw` — the Zerodha path — has no such ordering,
    // because Kite's series is the stamped "EQ" for every cash instrument and
    // therefore carries no information to defer to.
    //
    // Nothing is lost FOR DEBT AND ETF: the bhavcopy metadata backfill types
    // both (BACKFILL_TYPES = {DEBT, ETF}) and does it correctly — only ever
    // moving a row OFF the stamped default, re-checked in the WHERE. So for
    // those two this provider's update-path typing was redundant as well as
    // harmful.
    //
    // Something IS lost for REIT and INVIT, and saying "nothing is lost" flatly
    // was wrong. This was the only writer that could retype an EXISTING row to
    // either: the bhavcopy backfill excludes them, and
    // `mintMissingTrustInstruments` covers only NSE series RR/IV while Kite
    // lists the trusts on BSE. So EMBASSY, MINDSPACE, BIRET, NXST, INDIGRID,
    // IRBINVIT and PGINVIT can no longer be moved off EQUITY by anything
    // automatic. That is an accepted residual — retyping them would drop the ~7
    // real trusts out of the news, filings and financial-data syncs, which all
    // gate on EQUITY — but it is a residual, not an absence of one.
    //
    // The CREATE path is untouched: a brand-new row still gets Kite's best
    // guess, so a newly-listed trust is typed correctly from the start.
    const {
      series: _series,
      instrumentType: _type,
      ...rest
    } = this.mapToUpsert(raw);
    return rest;
  }
}

/**
 * Build a Yahoo symbol for an instrument. Exported for use by the sync orchestrator.
 *
 * Lives in this (Zerodha) module for historical reasons; it is the orchestrator's
 * ONE yahooSymbol builder and is called for EVERY provider's rows, India and US
 * alike — see `syncInstruments`.
 */
export function buildYahooSymbolForInstrument(
  symbol: string,
  exchange: string,
  instrumentType: string,
): string {
  // F&O and indices need special handling
  if (
    instrumentType === "FUTURES" ||
    instrumentType === "OPTIONS" ||
    instrumentType === "INDEX"
  ) {
    return "";
  }

  /**
   * US listings — MONEY-980. The Yahoo symbol is the BARE ticker.
   *
   * This branch has to sit ABOVE the suffix lookup, because that lookup's
   * fallback is `.NS`: without it every one of the 24,328 US securities the
   * Tiingo master supplies would be written as `AAPL.NS`. Three separate
   * failures, in increasing order of how quietly they happen:
   *
   *   1. `AAPL.NS` is not a Yahoo symbol, so nothing could ever price the row.
   *   2. It COLLIDES. `InstrumentMapping` has `@@unique([yahooSymbol])` and
   *      several US tickers are also NSE symbols — `INFY` is an NYSE ADR and an
   *      NSE listing, likewise `WIT`, `HDB`, `IBN`, `IEX` — so the upsert fails
   *      with a constraint violation and the US row never lands at all.
   *   3. `composeUpdatePayload` writes `yahooSymbol` UNCONDITIONALLY on the
   *      update path. The 30 pre-existing US seed rows (workers/src/processors/
   *      us-instrument-sync.ts, seeded from `US_SEED_STOCKS` with the correct
   *      bare `AAPL`) would have had their working symbol rewritten to
   *      `AAPL.NS` on the first Tiingo run — a silent regression of rows that
   *      were previously fine.
   *
   * With this branch those 30 rows are matched on (symbol, exchange), take the
   * UPDATE path, and are handed back the identical bare symbol they already
   * hold: they are UPDATED in place — gaining `market`/`listingStatus`/
   * `listingId`/the listing dates — never duplicated, and their Yahoo-sourced
   * `name` survives because `TiingoInstrumentProvider.mapToUpdate` drops it.
   *
   * `US_EXCHANGES` is a membership test rather than an empty entry in
   * `YAHOO_SUFFIX_MAP` — see the comment on that constant for why.
   */
  if (US_EXCHANGES.has(exchange)) {
    return symbol;
  }

  // ETFs and equities both have standard Yahoo symbols (SYMBOL.NS / SYMBOL.BO)
  const suffix = YAHOO_SUFFIX_MAP[exchange] ?? ".NS";
  return `${symbol}${suffix}`;
}
