/**
 * UDiFF (post-2024) derivatives bhavcopy parser — MONEY-941 (P3 step 4).
 *
 * `parseUdiffBhavcopy` cannot do this job: it filters `FinInstrmTp === "STK"`,
 * i.e. cash equity only, so pointing it at an F&O file yields zero rows. This
 * is the derivatives counterpart, and it emits the SAME `LegacyDerivativeRow`
 * shape the legacy parser does so both eras land in one `DerivativeEOD` table
 * through one writer.
 *
 * ## Three normalisations, verified against a real 2026-08-07 file
 *
 * Every one of these was confirmed by reading an actual UDiFF F&O file rather
 * than inferred from the cash format, and every one would have been wrong if
 * guessed:
 *
 * 1. **The instrument vocabulary is completely different.** UDiFF uses
 *    `IDF`/`IDO`/`STF`/`STO`; the legacy format uses
 *    `FUTIDX`/`OPTIDX`/`FUTSTK`/`OPTSTK`. Nothing overlaps. Left unnormalised,
 *    `DerivativeEOD.instrument` would hold two incompatible vocabularies split
 *    at the 2024 era boundary, and every query filtering on it would silently
 *    return only half the history. UDiFF is mapped ONTO the legacy names
 *    because the legacy era is 24 years against UDiFF's 2, so the long series
 *    should not be the one that has to be translated.
 *
 * 2. **Expiry is ISO, not `DD-MMM-YYYY`.** UDiFF writes `2026-10-27`; the
 *    legacy format writes `29-JUN-2000`. Feeding one to the other's parser
 *    returns null, which would drop every row.
 *
 * 3. **Turnover is in RUPEES, not lakhs.** `TtlTrfVal` is `618047016.00` for a
 *    single BANKNIFTY future, where the legacy `VAL_INLAKH` is already divided
 *    by 100,000. Storing the raw value in a column named `valueLakh` would put
 *    two units in one column — invisible until someone sums across 2024 and
 *    gets a number five orders of magnitude out. Converted here.
 *
 * Futures also carry EMPTY `StrkPric`/`OptnTp` (not `0`/`XX`), which are
 * normalised to the same sentinels the legacy parser emits — `DerivativeEOD`'s
 * compound unique includes both columns and MongoDB treats nulls as distinct,
 * so a null would let duplicate futures rows through.
 */

import Papa from "papaparse";
import { strictUtcDate, type LegacyDerivativeRow } from "./bhavcopy-legacy";

/**
 * UDiFF `FinInstrmTp` → the legacy instrument vocabulary.
 *
 * ID = index, ST = stock; F = future, O = option.
 */
const UDIFF_INSTRUMENT: Readonly<Record<string, string>> = {
  IDF: "FUTIDX",
  IDO: "OPTIDX",
  STF: "FUTSTK",
  STO: "OPTSTK",
};

/** Rupees per lakh — the unit the legacy `VAL_INLAKH` column is already in. */
const RUPEES_PER_LAKH = 100_000;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * `YYYY-MM-DD` → UTC midnight. UDiFF's expiry format.
 *
 * Uses the shared `strictUtcDate`, which rejects rollover: `Date.UTC(2026, 12,
 * 1)` is a valid 2027-01-01, so a `NaN` test accepts month 13 and quietly books
 * the contract a year late.
 */
export function parseUdiffExpiry(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;

  return strictUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function tradingDateUtcMidnight(date: Date): Date {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/**
 * Parse a UDiFF F&O bhavcopy (NSE or BSE) into `LegacyDerivativeRow`s.
 *
 * `skippedByType` tallies rows rejected because their `FinInstrmTp` is not a
 * known derivative code — reported rather than swallowed, so a NEW code NSE
 * introduces shows up as a count instead of as quietly missing history.
 */
export function parseUdiffFoBhavcopy(
  csv: string,
  exchange: "NSE" | "BSE",
  date: Date,
): {
  rows: LegacyDerivativeRow[];
  skipped: number;
  skippedByType: Record<string, number>;
} {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const tradingDate = tradingDateUtcMidnight(date);
  const rows: LegacyDerivativeRow[] = [];
  const skippedByType: Record<string, number> = {};
  let skipped = 0;

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const rawType = String(rec.FinInstrmTp ?? "")
      .trim()
      .toUpperCase();
    const instrument = UDIFF_INSTRUMENT[rawType];
    if (!instrument) {
      // Cash rows (STK) live in the CM file and are handled there; anything
      // else is a code we do not know yet and must not silently drop.
      skippedByType[rawType || "(blank)"] =
        (skippedByType[rawType || "(blank)"] ?? 0) + 1;
      continue;
    }

    const symbol = String(rec.TckrSymb ?? "").trim();
    const expiry = parseUdiffExpiry(rec.XpryDt);
    const close = num(rec.ClsPric);

    // Symbol, expiry and close are the contract's identity and its only price.
    // A row missing any cannot be keyed or used.
    if (!symbol || !expiry || close === null) {
      skipped++;
      continue;
    }

    const open = num(rec.OpnPric);
    const high = num(rec.HghPric);
    const low = num(rec.LwPric);
    const turnoverRupees = num(rec.TtlTrfVal);

    rows.push({
      symbol,
      exchange: exchange as "NSE",
      instrument,
      expiry,
      // Futures carry "" here, not 0 — normalise to the legacy sentinels so
      // the compound unique behaves identically across both eras.
      strike: num(rec.StrkPric) ?? 0,
      optionType:
        String(rec.OptnTp ?? "")
          .trim()
          .toUpperCase() || "XX",
      date: tradingDate,
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      settle: num(rec.SttlmPric),
      volume: num(rec.TtlTradgVol) ?? 0,
      openInt: num(rec.OpnIntrst) ?? 0,
      oiChange: num(rec.ChngInOpnIntrst) ?? 0,
      // Rupees → lakhs, matching the legacy column's unit.
      valueLakh:
        turnoverRupees === null ? null : turnoverRupees / RUPEES_PER_LAKH,
    });
  }

  return { rows, skipped, skippedByType };
}
