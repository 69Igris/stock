/**
 * Bhavcopy — free EOD price seed from BSE + NSE (MONEY-851).
 *
 * BSE and NSE both publish a free, no-auth end-of-day "bhavcopy" for the cash
 * (equity) segment in the SEBI common UDiFF format. This module fetches and
 * parses those files into a single normalized row shape so the worker can seed
 * close prices for the WHOLE listed universe in two HTTP calls per day — a free
 * replacement for the per-symbol Yahoo loop that the EOD `price-sync` did.
 *
 *   - BSE: plain CSV (UDiFF) at
 *     https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{YYYYMMDD}_F_0000.CSV
 *   - NSE: a ZIP wrapping the same UDiFF CSV at
 *     https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip
 *   - NSE indices close: a plain CSV at
 *     https://nsearchives.nseindia.com/content/indices/ind_close_all_{DDMMYYYY}.csv
 *
 * Both exchanges require a browser-like `User-Agent` and a same-origin
 * `Referer`, otherwise they 403. A 404 means the file isn't published yet
 * (weekend / holiday / pre-EOD) — those resolve to an EMPTY array, never a
 * throw, so the worker can no-op a non-trading day cleanly.
 *
 * This module lives in packages/core and has NO Prisma / DB dependency; the
 * worker (`workers/src/processors/bhavcopy-sync.ts`) joins the rows to
 * `InstrumentMapping` (by ISIN, then symbol+exchange) and upserts `DailyPrice`.
 *
 * ZIP handling: the monorepo has no zip dependency, and the NSE bhavcopy is a
 * single-entry archive that is either STORED (method 0) or DEFLATE (method 8).
 * We parse the ZIP local-file-header by hand and inflate with Node's built-in
 * `zlib.inflateRawSync` — no new dependency (see `unzipSingleEntry`).
 */

import { gunzipSync, inflateRawSync } from "node:zlib";
import { centralDirectoryCompressedSize } from "./zip-entries";
import { BSE_REFERER, NSE_REFERER } from "./exchange-feed";
import { getFeedAsset } from "./feed-archive";
import Papa from "papaparse";

// ─── Types ───────────────────────────────────────────────────────────

/** A single normalized end-of-day bar from a bhavcopy. */
export interface BhavcopyRow {
  /** ISIN — the primary join key to InstrumentMapping (e.g. INE002A01018). */
  isin: string | null;
  /** Bare exchange symbol (e.g. RELIANCE). */
  symbol: string;
  /** "NSE" | "BSE". */
  exchange: "NSE" | "BSE";
  open: number;
  high: number;
  low: number;
  close: number;
  /** Previous trading day's close, as reported in the file. */
  prevClose: number | null;
  /** Total traded volume (shares). */
  volume: number;
  /**
   * Exchange settlement series (NSE: EQ/BE/SM/RR/IV…; BSE: group A/B/X…).
   * Carried so the worker can mint an instrument for series that have no
   * master source — see NSE_TRUST_SERIES (MONEY-1085 follow-up).
   */
  series: string;
  /** Instrument name as published (UDiFF `FinInstrmNm`). */
  name: string;
  /** Trading date (UTC midnight of the IST calendar day). */
  date: Date;
}

/** A single index close row from the NSE all-indices file. */
export interface IndexCloseRow {
  /** Index name as published, e.g. "Nifty 50". */
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  date: Date;
  // ── Valuation + activity (MONEY-1100 P4.2) ───────────────────────────
  //
  // These five columns have been in every `ind_close_all_*` file since 2013
  // and were parsed away by this very function — fetched daily, then dropped
  // on the floor because the row shape stopped at OHLC. That is the whole
  // point of P4.2: index-level P/E is the only free, exchange-published
  // valuation series we can benchmark a portfolio (or a screen) against, and
  // NSE serves only a short trailing window, so every day discarded was
  // unrecoverable.
  //
  // ALL FIVE ARE NULLABLE ON PURPOSE. `-` in this file means "this index has
  // no such number", not zero: a dividend-points index (`Nifty50 Dividend
  // Points`) and the rate indices have no constituents to value and no
  // traded volume, so they print `-` across Volume/Turnover/P/E/P/B/Div
  // Yield. Storing 0 would make "P/E of 0" — a screaming-cheap stock screen —
  // indistinguishable from "not reported", which is the MONEY-1085 class of
  // bug (a silent, plausible-looking value where an absence belongs).
  /** Trailing P/E of the index basket, as published. null = not reported. */
  pe: number | null;
  /** Price/Book of the index basket, as published. null = not reported. */
  pb: number | null;
  /** Dividend yield in PERCENT (1.25 = 1.25%), as published. */
  divYield: number | null;
  /** Total traded volume (shares) across the index constituents. */
  volume: number | null;
  /**
   * Turnover in ₹ CRORE — the file's own unit, deliberately NOT converted.
   *
   * The column is literally `Turnover (Rs. Cr.)`, and the field name carries
   * the unit so no consumer has to guess. Note this differs from
   * `DeliveryRow.turnover` in ./delivery.ts, which converts TURNOVER_LACS to
   * rupees: that column's name does NOT carry its unit downstream, so the
   * conversion is how it stays unambiguous. Here the name does the work, and
   * converting would (a) inflate a ₹-crore float by 1e7 for no gain and
   * (b) silently rewrite bytes NSE published, which the derivable map's
   * "archived file wins" rule exists to prevent.
   */
  turnoverCr: number | null;
}

// ─── HTTP ────────────────────────────────────────────────────────────
//
// MONEY-1085: the fetch itself moved to `./exchange-feed` so the NSE
// instrument-master CSVs share the identical browser-header handling (same
// hosts, same 403 behaviour), and so there is ONE seam for the GCS feed
// archive to wrap. Referers are re-exported below for the URL builders.

// ─── Date → URL builders (pure, exported for tests) ──────────────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Split a Date into its IST calendar Y/M/D parts. The bhavcopy filenames are
 * keyed by the IST trading date, so we add +5:30 manually (don't trust the host
 * TZ) — same convention as `nse-holidays.toIstDateKey`.
 */
function istParts(date: Date): { y: number; m: number; d: number } {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
  };
}

/** `YYYYMMDD` (BSE + NSE bhavcopy filename token). */
export function toBhavcopyDateToken(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${y}${pad2(m)}${pad2(d)}`;
}

/** `DDMMYYYY` (NSE indices filename token). */
export function toIndicesDateToken(date: Date): string {
  const { y, m, d } = istParts(date);
  return `${pad2(d)}${pad2(m)}${y}`;
}

/** Full BSE equity bhavcopy URL for a trading day. */
export function buildBseBhavcopyUrl(date: Date): string {
  const token = toBhavcopyDateToken(date);
  return `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${token}_F_0000.CSV`;
}

/** Full NSE cash-market bhavcopy (ZIP) URL for a trading day. */
export function buildNseBhavcopyUrl(date: Date): string {
  const token = toBhavcopyDateToken(date);
  return `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${token}_F_0000.csv.zip`;
}

/** Full NSE all-indices close URL for a trading day. */
export function buildNseIndicesUrl(date: Date): string {
  const token = toIndicesDateToken(date);
  return `https://nsearchives.nseindia.com/content/indices/ind_close_all_${token}.csv`;
}

// ─── ZIP (single entry, no dependency) ───────────────────────────────

/**
 * Extract the first file from a single-entry ZIP buffer.
 *
 * The NSE bhavcopy ZIP contains exactly one CSV, compressed either STORED
 * (method 0) or DEFLATE (method 8). We read the local file header at the start
 * of the archive (PK\x03\x04 signature), pull the compression method + the
 * compressed/uncompressed sizes, slice the compressed bytes, and inflate. This
 * is intentionally minimal — it does NOT walk the central directory — because
 * the NSE file is always exactly one entry.
 *
 * Exported for unit tests (a tiny hand-built ZIP can exercise both methods).
 *
 * @throws if the buffer isn't a local-file-header ZIP, or uses a method other
 *   than stored/deflate.
 */
export function unzipSingleEntry(buf: Buffer): string {
  // Local file header: "PK\x03\x04"
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Not a ZIP local file header (bad signature)");
  }

  const method = buf.readUInt16LE(8);
  let compressedSize = buf.readUInt32LE(18);
  let uncompressedSize = buf.readUInt32LE(22);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const flags = buf.readUInt16LE(6);

  const dataStart = 30 + nameLen + extraLen;

  // Bit 3 of the general-purpose flag → sizes are 0 in the local header and
  // live in a trailing data descriptor instead.
  //
  // THE COMMENT HERE USED TO SAY "NSE doesn't set it, but be defensive". NSE
  // sets it on EVERY legacy F&O zip, so this was the happy path, not the
  // defence — and the "defence" was a forward scan for the next `PK\x07\x08` /
  // `PK\x01\x02`, which is a GUESS: those four bytes occur by chance inside a
  // DEFLATE stream. Measured on
  // `feeds/NSE/fo-legacy/2017/03/fo15MAR2017bhav.csv.zip` (MONEY-1483): the
  // real compressed size is 365,837 and the scan returned 300,039, truncating
  // by 65,798 bytes, so `inflateRawSync` threw "incomplete or truncated
  // stream" — while `unzip -t` reports no errors and the CRC matches. The
  // bytes were always fine; this function could not read them, and
  // `feed-parse-prod` refused to report success every night as a result.
  //
  // The central directory STATES the size. Ask it first; keep the scan only for
  // a TRUNCATED archive, which has no central directory to ask.
  if (
    (flags & 0x08) !== 0 &&
    (compressedSize === 0 || uncompressedSize === 0)
  ) {
    const declared = centralDirectoryCompressedSize(buf, 0);
    if (declared !== null) {
      compressedSize = declared;
    } else {
      let end = buf.length;
      for (let i = dataStart; i + 4 <= buf.length; i++) {
        const sig = buf.readUInt32LE(i);
        if (sig === 0x08074b50 || sig === 0x02014b50) {
          end = i;
          break;
        }
      }
      compressedSize = end - dataStart;
    }
    uncompressedSize = 0; // unknown; inflate determines the real length
  }

  const compressed = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) {
    // STORED — bytes are the file verbatim.
    const out = compressed.toString("utf-8");
    return out;
  }
  if (method === 8) {
    // DEFLATE — raw (no zlib header) inside a ZIP.
    const out = inflateRawSync(compressed);
    if (uncompressedSize && out.length !== uncompressedSize) {
      // Not fatal — log-worthy only; trust the inflated bytes.
    }
    return out.toString("utf-8");
  }

  throw new Error(`Unsupported ZIP compression method: ${method}`);
}

// ─── Archived bytes → text (the ONE decoder) ─────────────────────────

/**
 * "These bytes are not a file we can read."
 *
 * The classification seam for every archive consumer (MONEY-1205). A per-file
 * catch sees a Mongo timeout, a GCS 503 and a refused layout as three instances
 * of `unknown`, so it cannot tell a MOMENT from a FACT — and marking a moment
 * terminal is how a transient blip becomes a permanent skip.
 *
 * So the terminal verdict is OPT-IN, thrown only where the code has actually
 * inspected the payload and refused it. Everything else stays unclassified,
 * which means: not checkpointed, retried next run, and red every time until it
 * stops happening. Unknown fails LOUD; only a deliberate refusal may go quiet,
 * and only after it has been recorded.
 *
 * It lives HERE rather than in `scripts/jobs/feed-parse.ts` because
 * {@link decodeFeedText} throws it and that decoder is shared — a second copy of
 * the class would make `instanceof` false across the seam, which is the quiet
 * version of losing the classification entirely (MONEY-1206 / D2).
 */
export class UnreadableFeedFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableFeedFile";
  }
}

/**
 * Decode one archived feed object to text — zip, gzip, or plain UTF-8.
 *
 * ## Why this is shared rather than copied
 *
 * Archived objects are zips for NSE and plain CSV for BSE — and, for at least
 * one object, a GZIP stream stored under a `.csv` key. Both archive readers
 * (`scripts/jobs/feed-parse.ts` and `scripts/data/backfill-symbol-aliases.ts`)
 * used to carry their OWN `toCsv`, and only one of them learned about gzip. Two
 * decoders for one archive is a drift generator: the alias backfill silently
 * read that object as mojibake and contributed nothing from it, with no error
 * and no counter (MONEY-1206 / D2). One decoder, one place.
 *
 * ## The gzip branch (MONEY-1205)
 *
 * `feeds/NSE/combine-oi-deleq/2025/01/…csv` is a gzip member; `toString("utf8")`
 * turned its 230 perfectly ordinary rows into mojibake and the file was written
 * off as an unrecognised layout.
 *
 * Adding the branch cannot regress any of the ~30 families that share this
 * helper, because the magic it keys on is not reachable any other way: `1f 8b`
 * is not a valid UTF-8 lead pair (0x8b is a continuation byte), so a payload
 * matching it is GUARANTEED to stringify to replacement characters today. There
 * is no behaviour here to preserve — only a failure to convert into a parse.
 * ZIP is still tested first and byte-identically, and anything that is neither
 * still takes `toString("utf8")` untouched.
 *
 * A gzip member we cannot inflate is a verdict about the bytes, so it is thrown
 * as {@link UnreadableFeedFile} rather than as the raw zlib error: same
 * reasoning as the writers' file-level refusals, and it keeps "unclassified"
 * meaning "unexpected".
 *
 * NOTE this is a decoder, not a guard. It is deliberately NOT the place to
 * reject a binary payload — `nse-fii-stats` is a BIFF8 workbook and is
 * dispatched from the raw Buffer, never through here. Fetch-time rejection is
 * `feed-payload.ts`'s job.
 */
export function decodeFeedText(buf: Buffer): string {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return unzipSingleEntry(buf);
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip) {
    try {
      return gunzipSync(buf).toString("utf8");
    } catch (err) {
      throw new UnreadableFeedFile(
        "payload carries the gzip magic (1f 8b) but will not inflate — " +
          `${err instanceof Error ? err.message : String(err)}. NOT ` +
          "checkpointed DONE; recorded UNREADABLE and skipped until the object " +
          "is re-archived.",
      );
    }
  }
  return buf.toString("utf8");
}

// ─── CSV parse helpers ───────────────────────────────────────────────

/** Parse a finite float from a CSV cell; returns `null` for blanks/garbage. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse `num` but coerce a missing/garbage value to 0 (for volume). */
function numOr0(value: unknown): number {
  return num(value) ?? 0;
}

/**
 * Convert an IST calendar date (the bhavcopy date) to UTC midnight, matching
 * `DailyPrice.date` ("Trading date (UTC midnight)"). We build it from the
 * filename-derived Date so it's stable regardless of the file's own date column
 * format (BSE uses YYYYMMDD, the indices file uses DD-MMM-YYYY).
 */
function tradingDateUtcMidnight(date: Date): Date {
  const { y, m, d } = istParts(date);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Parse a UDiFF (SEBI common format) bhavcopy CSV — used by BOTH BSE and NSE
 * cash-market files (same columns). Only EQ-series (and BSE "A"/"B"/"T"…) cash
 * equity rows are kept; index/derivative section rows (`SctySrs` empty or a
 * non-equity series, or a `FinInstrmTp` that isn't a stock) are dropped.
 *
 * Key UDiFF columns:
 *   TckrSymb, ISIN, SctySrs, OpnPric, HghPric, LwPric, ClsPric, LastPric,
 *   PrvsClsgPric, TtlTradgVol, FinInstrmTp
 *
 * `date` is taken from the passed trading-day Date (not the file's own date
 * column) so it's always a clean UTC-midnight value.
 *
 * Exported for unit tests.
 */
export function parseUdiffBhavcopy(
  csv: string,
  exchange: "NSE" | "BSE",
  date: Date,
): BhavcopyRow[] {
  /** Per-series tally of rows the series filter rejected (MONEY-1085). */
  const droppedBySeries: Record<string, number> = {};
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const tradingDate = tradingDateUtcMidnight(date);
  const rows: BhavcopyRow[] = [];

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const symbol = String(rec.TckrSymb ?? "").trim();
    if (!symbol) continue;

    // Cash equity only. UDiFF tags instrument type in `FinInstrmTp`
    //   STK  = equity stock, others are indices/derivatives.
    // Some BSE variants omit FinInstrmTp; fall back to the series filter.
    const finType = String(rec.FinInstrmTp ?? "")
      .trim()
      .toUpperCase();
    if (finType && finType !== "STK") continue;

    const series = String(rec.SctySrs ?? "")
      .trim()
      .toUpperCase();
    if (!keepSeries(series, exchange)) {
      // MONEY-1085: count what we drop. A silent drop is how the SME/book-entry
      // gap survived for months — the rows were fetched and discarded with no
      // log line and no counter.
      droppedBySeries[series] = (droppedBySeries[series] ?? 0) + 1;
      continue;
    }

    const close = num(rec.ClsPric);
    // A bhavcopy stock row without a close is unusable for a price seed.
    if (close === null) continue;

    const open = num(rec.OpnPric);
    const high = num(rec.HghPric);
    const low = num(rec.LwPric);

    rows.push({
      isin: normalizeIsin(rec.ISIN),
      symbol: symbol.toUpperCase(),
      exchange,
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      prevClose: num(rec.PrvsClsgPric),
      volume: numOr0(rec.TtlTradgVol),
      series,
      name: String(rec.FinInstrmNm ?? "").trim(),
      date: tradingDate,
    });
  }

  logDroppedSeries(exchange, droppedBySeries);
  return rows;
}

/**
 * Log the per-series drop tally, splitting deliberate exclusions from
 * unrecognised ones. An unknown series is the interesting case: it means NSE
 * introduced something we have never classified, which is worth seeing in the
 * logs the day it appears rather than months later.
 */
function logDroppedSeries(
  exchange: "NSE" | "BSE",
  dropped: Record<string, number>,
): void {
  const entries = Object.entries(dropped);
  if (entries.length === 0) return;

  const known = entries.filter(([s]) => classifyUnpricedSeries(s) !== null);
  const unknown = entries.filter(([s]) => classifyUnpricedSeries(s) === null);
  const fmt = (e: [string, number][]) =>
    e
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s || "(blank)"}=${n}`)
      .join(" ");

  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  console.log(
    `[bhavcopy] ${exchange}: dropped ${total} rows by series — expected: ${fmt(known) || "none"}`,
  );
  if (unknown.length > 0) {
    console.warn(
      `[bhavcopy] ${exchange}: dropped ${unknown.reduce((sum, [, n]) => sum + n, 0)} rows of UNRECOGNISED series: ${fmt(unknown)} — ` +
        `classify them in NSE_SERIES_INTENTIONALLY_UNPRICED or add them to NSE_CASH_SERIES`,
    );
  }
}

/** Trim an ISIN cell to a clean value or null. */
function normalizeIsin(value: unknown): string | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();
  // ISINs are 12 chars (2-letter country + 9 alnum + check digit). Be lenient
  // but reject obvious blanks/placeholders.
  return s.length >= 12 ? s : null;
}

/**
 * NSE cash-segment series the price feed keeps.
 *
 * Exported (MONEY-1085) so the drift against the instrument universe is
 * testable: every series we ingest PRICES for must be a series we also source
 * INSTRUMENTS for, or those prices silently drop on the join. See
 * `NSE_MASTER_SERIES` in ./instruments/nse-master-logic.ts and the
 * `nse-series-drift` test.
 *
 * `""` (blank) — some UDiFF rows leave the series empty for the main board.
 * `"IT"`        — illiquid trade-for-trade. Present in the allowlist for
 *                 safety; no such row has been observed in a live file, and
 *                 NSE's master files never emit it, so it is knowingly
 *                 unsourced and excluded from the drift assertion.
 */
export const NSE_CASH_SERIES = new Set([
  "",
  "EQ",
  "BE",
  "BZ",
  "SM",
  "ST",
  "IT",
  // Exchange-traded trusts. No NSE master lists them and Kite carries only
  // their BSE listing, so the worker mints the NSE instrument from the
  // bhavcopy row itself — see mintMissingTrustInstruments in
  // workers/src/processors/bhavcopy-sync.ts.
  "RR", // REITs
  "IV", // InvITs
]);

/** Series in {@link NSE_CASH_SERIES} that deliberately have no master source. */
export const NSE_CASH_SERIES_WITHOUT_MASTER = new Set([
  "",
  "IT",
  // Minted from the bhavcopy row itself rather than sourced from a master —
  // NSE publishes no REIT/InvIT master CSV and Kite lists only the BSE leg.
  "RR",
  "IV",
]);

/**
 * NSE cash series we deliberately DON'T price, and why.
 *
 * This exists because the previous silence was the bug. ~272 NSE rows/day fall
 * outside {@link NSE_CASH_SERIES} and vanish with no log line and no counter,
 * which is exactly how the SME/book-entry gap survived unnoticed. Anything
 * dropped should be dropped ON PURPOSE and be greppable.
 *
 * Verified against the live 2026-07-27 file. The two that most look like bugs
 * are `RR` and `IV`:
 *
 *   REITs (RR, 6/day) and InvITs (IV, 11/day) ARE priced — via their BSE
 *   listing, which BSE's group `IF` keeps and which Kite's instrument dump
 *   supplies. Confirmed on prod: all 7 (EMBASSY, MINDSPACE, BIRET, NXST,
 *   INDIGRID, IRBINVIT, PGINVIT) exist as active BSE rows with a continuous
 *   DailyPrice history. Kite lists them ONLY as BSE rows — there is no NSE
 *   listing in any instrument source we have, and NSE publishes no REIT/InvIT
 *   master CSV. So skipping the NSE leg costs a duplicate listing, not data.
 *
 * If we ever want the NSE leg, the blocker is an instrument source for it —
 * NOT this allowlist. Adding RR/IV here without one would re-create the exact
 * MONEY-1085 defect: rows fetched, then dropped on the join.
 */
export const NSE_SERIES_INTENTIONALLY_UNPRICED: Record<string, string> = {
  GS: "Government loans (G-Secs) — not equity, out of scope",
  GB: "Sovereign gold bonds — not equity, out of scope",
  TB: "Treasury bills — not equity, out of scope",
  SG: "State development loans — not equity, out of scope",
  MF: "Mutual-fund units — covered by the AMFI/MutualFundMaster pipeline",
  E1: "Partly-paid shares — separate corporate-action lifecycle",
  P1: "Preference shares — not ordinary equity",
  SZ: "SME suspended/odd series — no continuous price series",
};

/**
 * Whole FAMILIES of NSE debt series, matched by first letter.
 *
 * NSE issues a two-character series per debt instrument and the second
 * character churns (N0..NZ, Y0..YZ, Z0..ZZ) — 150 rows across ~50 distinct
 * codes in the 2026-07-27 file alone. Enumerating them individually would
 * guarantee a stale list and drown the "unrecognised series" warning, which
 * only earns its keep if it fires on something genuinely new.
 */
export const NSE_SERIES_FAMILIES_UNPRICED: Record<string, string> = {
  N: "Corporate bonds / NCDs (N0–NZ) — debt, not equity",
  Y: "Debt / securitised instruments (Y0–YZ) — not equity",
  Z: "Debt / miscellaneous non-equity (Z0–ZZ)",
};

/**
 * Why a series is not priced, or null if we have never classified it.
 * Exact match wins over the family prefix.
 */
export function classifyUnpricedSeries(series: string): string | null {
  const s = String(series ?? "")
    .trim()
    .toUpperCase();
  if (NSE_SERIES_INTENTIONALLY_UNPRICED[s] !== undefined) {
    return NSE_SERIES_INTENTIONALLY_UNPRICED[s]!;
  }
  // Two-character debt codes only — never let a single letter or a longer
  // string fall into a family bucket by accident.
  if (s.length === 2 && NSE_SERIES_FAMILIES_UNPRICED[s[0]!] !== undefined) {
    return NSE_SERIES_FAMILIES_UNPRICED[s[0]!]!;
  }
  return null;
}

/**
 * Whether a cash-segment series should be kept.
 *
 * - NSE: keep the regular rolling-settlement equity series — EQ, BE, BZ, SM
 *   (SME), ST, plus a blank series (some rows in the new UDiFF leave it empty
 *   for the main board). Drop derivative/odd series.
 * - BSE: keep any non-empty group EXCEPT the index pseudo-rows (handled by
 *   FinInstrmTp). A blank series on BSE is kept too.
 *
 *   This deliberately keeps DEBT as well as equity, and the comment used to
 *   claim the BSE groups "are all cash equity" — they are not. Measured on the
 *   live 2026-07-29 file: of 4,845 rows, group F (369) is corporate debt/NCDs
 *   and G (43) is government securities; the other 4,433 span 12 equity groups
 *   (A B X XT T M MT MS Z E IF P). Pricing debt is fine and intentional — a
 *   bond has a real close — so the BEHAVIOUR here is unchanged. What was wrong
 *   was using "it's all equity" as the reason, which is also how 11,795 debt
 *   instruments ended up typed EQUITY in `InstrumentMapping` (MONEY-1093).
 *   `classifyCashInstrument` is the thing that reads a group letter to decide
 *   equity-vs-debt; this function only decides whether to price the row.
 */
function keepSeries(series: string, exchange: "NSE" | "BSE"): boolean {
  if (exchange === "BSE") {
    // BSE: keep everything that survived the FinInstrmTp filter (groups vary).
    return true;
  }
  return NSE_CASH_SERIES.has(series);
}

/** Header text reduced to its letters+digits, for drift-tolerant matching. */
function normalizeIndexHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find the header the FILE actually used for a canonical column label.
 *
 * Applied only to the P4.2 columns, not to the OHLC ones. The OHLC labels have
 * been read in prod daily since MONEY-851 and are the payload check's required
 * tokens (see feed-payload.ts `NSE/indices`), so they are proven against live
 * bytes; the valuation columns are being read for the FIRST time and against
 * an archive that reaches back to 2013, where the only punctuation-sensitive
 * labels live (`Turnover (Rs. Cr.)` vs `Turnover(Rs.Cr.)`, `Div Yield` vs
 * `Div Yield (%)`). Normalising away punctuation and case costs nothing and
 * removes the one way this parser could silently return all-nulls for a whole
 * era of the backfill — which, per the fail-open rule, would be persisted as
 * "this index has no P/E" rather than "we could not read the column".
 *
 * Exact match always wins, so a file with the canonical header is unaffected.
 */
function resolveIndexColumn(
  fields: readonly string[],
  canonical: string,
): string | null {
  if (fields.includes(canonical)) return canonical;
  const want = normalizeIndexHeader(canonical);
  return fields.find((f) => normalizeIndexHeader(f) === want) ?? null;
}

/** `num` at a resolved column, or null when the file has no such column. */
function numAt(
  rec: Record<string, unknown>,
  key: string | null,
): number | null {
  return key === null ? null : num(rec[key]);
}

/**
 * Parse the NSE all-indices close CSV (`ind_close_all_*`). Columns (header
 * varies slightly across years but these labels are stable):
 *   "Index Name","Index Date","Open Index Value","High Index Value",
 *   "Low Index Value","Closing Index Value","Points Change",
 *   "Change(%)","Volume","Turnover (Rs. Cr.)","P/E","P/B","Div Yield"
 *
 * All 13 columns were re-verified 10-Aug-2026 against a repaired archived file
 * (docs/reference/per-file-derivable-map.md §2) and the fixture in
 * __tests__/fixtures/ind_close_all.sample.csv is cut from real published bytes.
 *
 * `prevClose` is derived (close − pointsChange) when a points-change column is
 * present; otherwise null.
 *
 * MONEY-1100 P4.2: the last five columns (Volume, Turnover, P/E, P/B, Div
 * Yield) are now KEPT instead of discarded. `-` / blank / NA → null (`num`
 * already collapses all three: the first two by literal test, "NA" because
 * `Number("NA")` is NaN and fails the finite check) — never 0. See
 * `IndexCloseRow` for why that distinction is load-bearing.
 *
 * Exported for unit tests.
 */
export function parseNseIndicesCsv(csv: string, date: Date): IndexCloseRow[] {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  // Resolved ONCE per file, not per row: header:true gives every record the
  // same keys, so a per-row scan would repeat identical work ~120×/day across
  // a ~3,300-day backfill.
  const fields: readonly string[] = parsed.meta.fields ?? [];
  const peCol = resolveIndexColumn(fields, "P/E");
  const pbCol = resolveIndexColumn(fields, "P/B");
  const divYieldCol = resolveIndexColumn(fields, "Div Yield");
  const volumeCol = resolveIndexColumn(fields, "Volume");
  const turnoverCol = resolveIndexColumn(fields, "Turnover (Rs. Cr.)");

  const tradingDate = tradingDateUtcMidnight(date);
  const rows: IndexCloseRow[] = [];

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;
    const name = String(rec["Index Name"] ?? "").trim();
    if (!name) continue;

    const close = num(rec["Closing Index Value"]);
    if (close === null) continue;

    const open = num(rec["Open Index Value"]);
    const high = num(rec["High Index Value"]);
    const low = num(rec["Low Index Value"]);
    const pointsChange = num(rec["Points Change"]);

    rows.push({
      name,
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      prevClose: pointsChange !== null ? close - pointsChange : null,
      date: tradingDate,
      // Additive only — a row that has none of these still parses exactly as
      // it did before P4.2, which is what keeps the existing IndexClose writer
      // and every other caller working untouched.
      pe: numAt(rec, peCol),
      pb: numAt(rec, pbCol),
      divYield: numAt(rec, divYieldCol),
      volume: numAt(rec, volumeCol),
      turnoverCr: numAt(rec, turnoverCol),
    });
  }

  return rows;
}

// ─── Public fetchers ─────────────────────────────────────────────────

/**
 * Fetch + parse the BSE equity bhavcopy for a trading day.
 * Returns `[]` for a non-trading day (404). Throws on other HTTP failures.
 */
export async function fetchBseBhavcopy(date: Date): Promise<BhavcopyRow[]> {
  const url = buildBseBhavcopyUrl(date);
  const res = await getFeedAsset(url, BSE_REFERER, {
    exchange: "BSE",
    feed: "bhavcopy",
    date,
  });
  if (!res) return [];
  const csv = await res.text();
  return parseUdiffBhavcopy(csv, "BSE", date);
}

/**
 * Fetch + parse the NSE cash-market bhavcopy (ZIP → CSV) for a trading day.
 * Returns `[]` for a non-trading day (404). Throws on other HTTP failures.
 */
export async function fetchNseBhavcopy(date: Date): Promise<BhavcopyRow[]> {
  const url = buildNseBhavcopyUrl(date);
  const res = await getFeedAsset(url, NSE_REFERER, {
    exchange: "NSE",
    feed: "bhavcopy",
    date,
  });
  if (!res) return [];
  const zipBuf = Buffer.from(await res.arrayBuffer());
  const csv = unzipSingleEntry(zipBuf);
  return parseUdiffBhavcopy(csv, "NSE", date);
}

/**
 * Fetch + parse the NSE all-indices close file for a trading day.
 * Returns `[]` for a non-trading day (404). Throws on other HTTP failures.
 */
export async function fetchNseIndicesClose(
  date: Date,
): Promise<IndexCloseRow[]> {
  const url = buildNseIndicesUrl(date);
  const res = await getFeedAsset(url, NSE_REFERER, {
    exchange: "NSE",
    feed: "indices",
    date,
  });
  if (!res) return [];
  const csv = await res.text();
  return parseNseIndicesCsv(csv, date);
}
