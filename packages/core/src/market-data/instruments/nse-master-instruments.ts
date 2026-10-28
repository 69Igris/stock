/**
 * NSE Instrument-Master Provider — MONEY-1085.
 *
 * Fills the gap the Zerodha Kite dump leaves: NSE's SME (Emerge) and book-entry
 * settlement series, plus the ISIN column Kite doesn't publish at all.
 *
 * Measured impact this exists to fix — production bhavcopy logs, every trading
 * day: NSE fetched ~3,181 rows, resolved ~2,415, silently dropped ~766. Those
 * 766 were exactly SM 324 / BE 278 / ST 125 / BZ 39 — the series absent from
 * `instrument_mappings` (448 missing outright, 256 present but deactivated as
 * stale, 293 present only as their BSE listing).
 *
 * Two public, no-auth CSVs, same hosts as the bhavcopy:
 *   - main board: /content/equities/EQUITY_L.csv            (~2,387 rows)
 *   - SME/Emerge: /emerge/corporates/content/SME_EQUITY_L.csv (~559 rows)
 *
 * ## Why running this alongside ZerodhaInstrumentProvider is safe
 *
 * `syncInstruments` collects the UNION of every provider's symbol@exchange
 * pairs before calling `deactivateStaleInstruments`, which additionally only
 * touches rows whose `lastSyncedAt` is older than 7 days. So a second provider
 * can never deactivate Kite's ETFs or BSE rows — it is purely additive.
 *
 * And because `mapToUpsert` returns `undefined` for every field this file has no
 * opinion on (tickSize, zerodhaToken, tradingSymbol, …), Prisma omits those keys
 * from the update, so Kite's values survive. The fields we DO set are ones NSE
 * is authoritative for: name, series, isin, marketLot.
 *
 * Side effect worth knowing: `mapToUpsert` sets `isActive: true`, so the 256
 * wrongly-deactivated NSE rows are reactivated by the same upsert.
 */

import type { Prisma } from "@usemoney/database";
import type { InstrumentProvider, RawInstrument } from "./types";
import {
  type NseMasterRow,
  mergeNseMasterRows,
  parseNseMasterCsv,
} from "./nse-master-logic";
import { NSE_REFERER } from "../exchange-feed";
import { getFeedAsset } from "../feed-archive";

export const NSE_EQUITY_MASTER_URL =
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
export const NSE_SME_MASTER_URL =
  "https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv";

export class NseMasterInstrumentProvider implements InstrumentProvider {
  name = "NSE_MASTER";

  async fetchInstruments(): Promise<RawInstrument[]> {
    // Main board first so a symbol mid-migration from Emerge resolves to its
    // main-board entry (mergeNseMasterRows is first-wins on symbol).
    const [mainCsv, smeCsv] = await Promise.all([
      this.fetchMaster(NSE_EQUITY_MASTER_URL, "equity-master"),
      this.fetchMaster(NSE_SME_MASTER_URL, "sme-master"),
    ]);

    const main = parseNseMasterCsv(mainCsv);
    const sme = parseNseMasterCsv(smeCsv);
    const rows = mergeNseMasterRows(main, sme);

    console.log(
      `NSE master: ${main.length} main-board + ${sme.length} SME → ${rows.length} unique symbols`,
    );

    // A total collapse means the format changed or both fetches 404'd. Fail
    // loudly rather than hand the orchestrator an empty set — an empty
    // provider result would look like "NSE delisted everything".
    if (rows.length === 0) {
      throw new Error(
        "NSE master returned 0 usable rows (format change or both files unavailable)",
      );
    }

    return rows.map(toRawInstrument);
  }

  /**
   * A missing master file (404) yields "" so the other file can still land.
   * Any other failure propagates — see the 0-row guard above.
   */
  private async fetchMaster(url: string, feed: string): Promise<string> {
    const res = await getFeedAsset(url, NSE_REFERER, {
      exchange: "NSE",
      feed,
    });
    if (!res) {
      console.warn(`NSE master ${feed}: not available (404)`);
      return "";
    }
    return res.text();
  }

  mapToUpsert(
    raw: RawInstrument,
  ): Partial<Prisma.InstrumentMappingCreateInput> {
    return {
      symbol: raw.symbol,
      exchange: raw.exchange,
      name: raw.name || raw.symbol,
      instrumentType: raw.instrumentType,
      // The whole point of this provider. Kite's dump has no ISIN column, so
      // `InstrumentMapping.isin` was empty on all 25k rows before MONEY-1085.
      isin: raw.isin || undefined,
      series: raw.series,
      lotSize: raw.lotSize,
      isActive: true,
      lastSyncedAt: new Date(),
      // Deliberately NOT set: tickSize, tradingSymbol, zerodhaToken,
      // segmentCode, expiryDate, strikePrice, optionType. The master files
      // carry none of them, and returning `undefined` makes Prisma omit the
      // key so Kite's value is preserved on the update path.
    };
  }

  /**
   * Update payload for an EXISTING row.
   *
   * Without this the orchestrator falls back to `mapToUpsert`, which writes
   * `instrumentType: "EQUITY"` on every row it touches — a value asserted from
   * FILE MEMBERSHIP, not from anything the row itself says. That is the guess
   * `InstrumentProvider.mapToUpdate` exists to forbid, and it would revert a
   * deliberate DEBT/REIT classification exactly as Zerodha's did (MONEY-1093).
   *
   * It is unreachable today only because `NSE_MASTER_SERIES` filters the parse
   * to five cash-equity series — an unasserted property of an external CSV,
   * sitting in a different file. Narrowing here makes the safety local instead
   * of accidental. `series` IS kept: these files are authoritative for it.
   */
  mapToUpdate(
    raw: RawInstrument,
  ): Partial<Prisma.InstrumentMappingCreateInput> {
    const { instrumentType: _t, ...rest } = this.mapToUpsert(raw);
    return rest;
  }
}

/** Map a parsed master row to the orchestrator's raw shape. */
function toRawInstrument(row: NseMasterRow): RawInstrument {
  return {
    symbol: row.symbol,
    exchange: "NSE",
    name: row.name,
    // EQUITY, unconditionally — and the reasoning here was wrong once, so it is
    // spelled out.
    //
    // A previous revision derived this from the series, justified by "a trust
    // listed here arrives with series RR/IV". That cannot happen:
    // `parseNseMasterCsv` filters to NSE_MASTER_SERIES = {EQ,BE,BZ,SM,ST}
    // (nse-master-logic.ts), so RR/IV never survive the parse, and the live
    // EQUITY_L.csv contains no ETFs or trusts at all. The derivation was a
    // behavioural no-op wrapped in an incorrect explanation, replacing a comment
    // that had been right. Membership in the cash-equity master IS the evidence.
    instrumentType: "EQUITY",
    series: row.series,
    ...(row.isin ? { isin: row.isin } : {}),
    ...(row.marketLot != null ? { lotSize: row.marketLot } : {}),
  };
}
