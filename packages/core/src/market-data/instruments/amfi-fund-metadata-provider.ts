/**
 * AMFI fund metadata — the replacement for the dead Kuvera/captnemo source
 * (MONEY-1205 W3-C).
 *
 * ## Why this exists
 *
 * Measured on prod 2026-08-18: `mutual_fund_masters` holds 14,223 rows and
 * **not one** carries `aum`, `expenseRatio`, `fundManager`, `returns1Y/3Y/5Y`,
 * `returnsInception`, `crisilRating`, `volatility`, `fundType`, `riskLevel`,
 * `launchDate`, `exitLoad` or `benchmarkName`. Every "Key numbers" cell on the
 * MF detail page renders "-". 7,263 of those rows nevertheless carry a
 * non-null `metadataSource`, i.e. the old writer stamped a SUCCESS marker over
 * a row it had enriched with nothing.
 *
 * The sole writer was `fetchKuveraMetadata()` against
 * `https://mf.captnemo.in/kuvera/{ISIN}.json`. Re-probed 2026-08-18 — it
 * answers `404 {"error": "Invalid ISIN"}` for every ISIN, mainstream ones and
 * the sample ISIN in captnemo's own docs included.
 *
 * This module replaces it with AMFI's own, free, officially published files.
 * AMFI is the industry body every AMC reports to, so this is primary data, not
 * a scrape of somebody else's aggregation.
 *
 * ## The three feeds, and what each one is authoritative for
 *
 * | feed                    | gives us                        | cadence   | key            |
 * | ----------------------- | ------------------------------- | --------- | -------------- |
 * | Scheme master (CSV)     | launchDate, plan, category, ISIN| continuous| `Code` = ours  |
 * | Schemewise AAUM (JSON)  | aum                             | QUARTERLY | `AMFI_Code`    |
 * | TER disclosure (XLSX)   | expenseRatio                    | MONTHLY   | scheme NAME    |
 *
 * Measured coverage against prod's 14,223 rows (2026-08-18):
 *   scheme master 14,055 (98.8%) · AAUM 8,538 (60.0%) · TER 9,031 (63.5%)
 *   union 14,116 (99.2%)
 *
 * ## What AMFI does NOT publish, and is therefore NOT filled here
 *
 * `fundManager`, `exitLoad`, `benchmarkName`, `crisilRating`, `volatility`,
 * `riskLevel`, `returns1Y/3Y/5Y/Inception` appear in NO AMFI file. They live in
 * each AMC's Scheme Information Document / factsheet (fund manager, exit load,
 * benchmark, riskometer) or behind the CRISIL-hosted iframe AMFI embeds at
 * `/otherdata/fund-performance` (returns). Both are separate acquisition
 * problems and are deliberately left null rather than approximated.
 *
 * `benchmarkName` in particular: MONEY-610 removed a FABRICATED "Nifty 50 TRI"
 * synthesised from the fund's own CAGR x 0.7 and rendered as a real index. A
 * benchmark comes from the scheme's own disclosure or it stays null. There is
 * no third option and this module does not create one.
 *
 * ## The traps, all verified against live responses on 2026-08-18
 *
 * 1. **A well-formed empty answer.** Three separate doors return HTTP 200 with
 *    a structurally perfect, entirely dataless body:
 *      - `/api/populate-ter-month?year=2026` -> `[]` (the year token is a
 *        FISCAL year, `"2026-2027"`; a calendar year is silently empty);
 *      - `DownloadSchemeData_Po.aspx?mf=1` -> 164 bytes, correct 10-column
 *        header, zero data rows;
 *      - `populate-te-rdata-revised?...&Month=01-2015&excel=true` -> a 7.8 KB
 *        XLSX with the right sheet name, a header row and a disclaimer block,
 *        and zero data rows.
 *    This is the exact failure mode being fixed, so every parser here THROWS
 *    {@link AmfiFeedEmptyError} on a recognised-but-empty file rather than
 *    returning `[]`. See {@link parseAmfiTerDisclosure} for the full rule.
 *
 * 2. **AAUM is denominated in RUPEE LAKH, not crore.** Nothing on the wire says
 *    so. Verified by triangulation against funds whose size is independently
 *    known: Parag Parikh Flexi Cap sums to 14,065,971.28 across its plans
 *    (= Rs 140,660 cr, correct) and HDFC Balanced Advantage to 10,478,342.07
 *    (= Rs 104,783 cr, correct); read as crore both are ~100x the entire Indian
 *    MF industry. The whole file sums to 853,526,449.95 = Rs 85.35 lakh crore,
 *    which is the industry AAUM for the quarter. `MutualFundMaster.aum` is
 *    documented "in crores", so {@link AAUM_LAKH_PER_CRORE} divides. Read
 *    naively every fund on the site would be 100x too large, and nothing would
 *    throw.
 *
 * 3. **`fyId` and `periodId` are RELATIVE ORDINALS that renumber.** For the
 *    AAUM door, `fyId=1` is the *current* financial year and `periodId=1` the
 *    *newest* quarter within it — so `fyId=1&periodId=1` meant "Apr-Jun 2026"
 *    on 2026-08-18 and will silently mean "Jul-Sep 2026" the moment that
 *    quarter publishes, and `fyId=1` becomes FY2027-28 next April. A job that
 *    pins the numbers reads a different quarter every time without changing.
 *    {@link resolveAmfiAaumPeriod} therefore resolves by LABEL, and
 *    {@link parseAmfiAumDisclosure} refuses a payload whose echoed
 *    `selectedPeriod` is not the one asked for.
 *
 * 4. **`pageSize` is silently capped at 100.** The TER JSON door accepts
 *    `pageSize=100000`, answers 200, and returns `meta:{pageSize:100,
 *    total:63144, pageCount:632}` — the same "caps the page while reporting the
 *    true total in an envelope that is easy to discard" shape NSE's XBRL index
 *    has (MONEY-1113). One month is 632 pages. This module uses the XLSX export
 *    instead: one request, the whole month, 4.4 MB.
 *
 * 5. **The TER file has TWO header regimes and both are live.** Months from the
 *    2026 SEBI regulations publish `Regular Plan - Base Expense Ratio (BER)
 *    (%) / Brokerage cost / Transaction Cost / Statutory Levies`; older months
 *    publish `Base TER / Additional expense as per Regulation 52(6A)(b) / (c) /
 *    GST`. Only `... - Total TER (%)` is common to both, which is why columns
 *    are located BY HEADER TEXT and only the four we need are required.
 *
 * 6. **The TER file is DAILY inside a monthly export**, 31 rows per scheme for
 *    July 2026 (63,157 rows / 2,124 schemes), and ends with a 13-row disclaimer
 *    block whose cells are all in column A. Latest `TER Date` per scheme wins;
 *    the disclaimer rows are dropped by the same test that drops any row with
 *    no parsable date.
 *
 * 7. **The scheme master's last two ISIN columns are JAMMED INTO ONE FIELD.**
 *    The header literally reads `ISIN Div Payout/ ISIN GrowthISIN Div
 *    Reinvestment` and a value looks like `INF209K01157INF209K01CE5` — two
 *    12-character ISINs with no separator. 43 rows use a bare `-` as the
 *    placeholder for a missing half (`INF204K01B81-`, `-INF109KC1MY5`). Split
 *    positionally with the sentinel; see {@link splitJammedIsins}.
 *
 * 8. **A real 0.00% expense ratio exists and must survive.** 360 ONE GOLD ETF's
 *    direct plan publishes `D_TER = 0.0000`; 93 of the 386 rows in the
 *    committed fixture carry a zero. The code being replaced used
 *    `parseFloat(x) || null`, which maps a genuine 0 to "unknown". Absence is
 *    `""` / `-` / blank, NEVER 0 — enforced by the shared
 *    {@link mfNumberOrNull}.
 *
 * ## Plan resolution — 1 scheme name can be 4 scheme codes
 *
 * AUM needs no plan reasoning: the AAUM door is keyed by `AMFI_Code`, which IS
 * our `schemeCode`, one row per plan-and-option (360 ONE Multi Asset Direct
 * Growth 153774 and Direct IDCW 153773 carry different AAUM).
 *
 * TER does. Its only identifier is the BASE scheme name, and the modal fan-out
 * from a base name to master codes is exactly 4 (1,064 of 2,118 matched names)
 * — Direct/Regular x Growth/IDCW. AMFI publishes TER per PLAN, not per option:
 * one TER row carries BOTH `Regular Plan - Total TER (%)` and `Direct Plan -
 * Total TER (%)`. So the fan-out resolves exactly, with no guessing: a code
 * whose NAV name says "Direct" takes the direct TER, one that says "Regular"
 * takes the regular TER, and **a code that says neither gets nothing**.
 *
 * That last clause is not defensive padding. 4,470 of 16,394 master rows (27%)
 * name neither plan — legacy pre-2013 schemes from before the Direct-plan
 * regime, plus Institutional/Retail share classes. The convention that "no
 * Direct means Regular" is an inference, and this module does not make it.
 *
 * ## Layering
 *
 * Parsers are PURE: bytes/text in, data out, no network, no Prisma, no clock.
 * Fetchers are separate exports so they can later be routed through
 * `getFeedAsset` for archive/replay (see the report attached to MONEY-1205 —
 * `FeedDescriptor.exchange` currently admits only NSE/BSE/RBI and needs an
 * "AMFI" member first).
 *
 * Only TYPES are imported from `./mf-metadata-provider`; its runtime exports
 * pull in `@usemoney/database`, and a pure parser must not drag a Prisma client
 * into its own unit test. The two absence helpers are the exception: they are
 * imported at runtime on purpose, because the 0-vs-null rule must have exactly
 * one implementation.
 */

import * as XLSX from "xlsx";

import {
  mfNumberOrNull,
  mfTextOrNull,
  emptyMfMetadata,
} from "./mf-metadata-provider";
import type {
  MfMetadataFields,
  MfMetadataLookup,
  MfMetadataOutcome,
  MfMetadataProvider,
} from "./mf-metadata-provider";

// ============== IDENTITY ==============

/** Stamped into `MutualFundMaster.metadataSource`. */
export const AMFI_METADATA_PROVIDER_ID = "amfi";

/** AAUM arrives in rupee LAKH; the `aum` column is documented in crore. */
export const AAUM_LAKH_PER_CRORE = 100;

// ============== URLS ==============

const AMFI_SITE = "https://www.amfiindia.com";
const AMFI_PORTAL = "https://portal.amfiindia.com";

/** Referers AMFI's own pages send. Kept next to the URL that needs them. */
export const AMFI_AAUM_REFERER = `${AMFI_SITE}/aum-data/average-aum`;
export const AMFI_TER_REFERER = `${AMFI_SITE}/ter-of-mf-schemes`;
export const AMFI_SCHEME_MASTER_REFERER = `${AMFI_SITE}/net-asset-value`;

/**
 * The complete scheme master.
 *
 * `mf=0` means "every AMC"; a real AMC id narrows it (`mf=62` -> 360 ONE, 45
 * rows — that is how the committed fixture was captured). `mf=1` is trap 1: a
 * valid-looking id that returns a header-only CSV at HTTP 200.
 *
 * Columns (exactly 10, comma-separated, no quoting observed across all 16,394
 * live rows): `AMC, Code, Scheme Name, Scheme Type, Scheme Category, Scheme NAV
 * Name, Scheme Minimum Amount, Launch Date, Closure Date,
 * ISIN Div Payout/ISIN Growth + ISIN Div Reinvestment` (trap 7).
 */
export function buildAmfiSchemeMasterUrl(mfId: number = 0): string {
  return `${AMFI_PORTAL}/DownloadSchemeData_Po.aspx?mf=${mfId}`;
}

/**
 * The monthly TER disclosure as a single XLSX.
 *
 * @param month ABSOLUTE `MM-YYYY` token — `"07-2026"`. Unlike the AAUM door's
 *   ordinals this does not renumber, so no discovery call is needed. A
 *   malformed token is rejected with HTTP 400
 *   (`"Month must be in valid format MM-YYYY"`); a well-formed token for a
 *   month with no data returns the empty-but-valid workbook of trap 1.
 * @param mfId `"All"` or an AMFI mfId (`"62"` = 360 ONE).
 */
export function buildAmfiTerExcelUrl(
  month: string,
  mfId: string = "All",
): string {
  return (
    `${AMFI_SITE}/api/populate-te-rdata-revised` +
    `?MF_ID=${encodeURIComponent(mfId)}&Month=${encodeURIComponent(month)}` +
    `&strCat=-1&strType=-1&excel=true`
  );
}

/** `Date` -> the TER door's absolute month token, e.g. `"07-2026"`. */
export function amfiTerMonthToken(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${mm}-${date.getUTCFullYear()}`;
}

/**
 * Financial-year list for the schemewise AAUM door. Discovery step 1 of 3.
 *
 * Answers `{type:"financial_years", data:[{id, financial_year}]}` where
 * `financial_year` is a LABEL like `"April 2026 - March 2027"`. The `id` is the
 * ordinal of trap 3 — never persist it.
 */
export function buildAmfiAaumFinancialYearsUrl(mfId: number | string = 0) {
  return `${AMFI_SITE}/api/average-aum-schemewise?strType=Categorywise&MF_ID=${mfId}`;
}

/**
 * Period list within a financial year. Discovery step 2 of 3.
 *
 * Answers `{type:"periods", data:{financial_year, periods:[{id, period}]}}`,
 * newest first, so `id` 1..4 walks Jan-Mar back to Apr-Jun. Ordinal — trap 3.
 */
export function buildAmfiAaumPeriodsUrl(
  fyId: number,
  mfId: number | string = 0,
): string {
  return `${AMFI_SITE}/api/average-aum-schemewise?fyId=${fyId}&strType=Categorywise&MF_ID=${mfId}`;
}

/** The AAUM data itself. Discovery step 3 of 3. */
export function buildAmfiAaumDataUrl(
  fyId: number,
  periodId: number,
  mfId: number | string = 0,
): string {
  return (
    `${AMFI_SITE}/api/average-aum-schemewise` +
    `?strType=Categorywise&fyId=${fyId}&periodId=${periodId}&MF_ID=${mfId}`
  );
}

/**
 * The AAUM label for the quarter a date falls in, e.g. `"April - June 2026"`.
 *
 * The year in the label is the quarter's CALENDAR year, not the financial
 * year's: `"January - March 2026"` sits inside FY `"April 2025 - March 2026"`.
 */
export function amfiAaumQuarterLabel(date: Date): string {
  const q = Math.floor(date.getUTCMonth() / 3);
  const spans = [
    "January - March",
    "April - June",
    "July - September",
    "October - December",
  ] as const;
  return `${spans[q]} ${date.getUTCFullYear()}`;
}

/** The AAUM financial-year label containing a date, `"April 2026 - March 2027"`. */
export function amfiAaumFinancialYearLabel(date: Date): string {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 3 ? y : y - 1;
  return `April ${start} - March ${start + 1}`;
}

// ============== LIVENESS ==============

/**
 * A recognised file that produced ZERO usable rows.
 *
 * Non-negotiable per MONEY-1205: the defect being fixed is a provider that
 * returned nothing for 5.5 months while the job logged success and exited 0.
 * A dataless file is therefore an ERROR, not an empty result — the caller must
 * be unable to checkpoint on it by accident.
 *
 * This is a deliberate departure from the house `parse*` convention
 * (`fii-stats-logic.ts`, `mf-portfolio-logic.ts`) where a recognised file with
 * no legible rows returns `rows: []`. There the distinction is analytically
 * meaningful — a trading day really can have no bulk deals. Here it is not:
 * AMFI has never published an empty scheme master or an empty TER month for a
 * month that exists, so zero rows always means we asked the wrong question
 * (calendar year for fiscal, a month before the feed began, a bogus AMC id) and
 * always means the sink must not advance.
 *
 * `reasons` carries the per-file tally that a returned value would otherwise
 * have carried, so nothing diagnostic is lost by throwing.
 */
export class AmfiFeedEmptyError extends Error {
  readonly feed: string;
  readonly reasons: Readonly<Record<string, number>>;

  constructor(feed: string, reasons: Record<string, number>) {
    const detail = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    super(
      `[amfi] ${feed}: recognised the file but produced 0 usable rows` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "AmfiFeedEmptyError";
    this.feed = feed;
    this.reasons = reasons;
  }
}

// ============== SHARED HELPERS ==============

type Grid = (string | null)[][];

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? input
    : new TextDecoder("utf-8").decode(input);
}

/** Whitespace-collapsed upper case. Used for every header and name match. */
export function normaliseAmfiName(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tally(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

/**
 * `DD-Mon-YYYY` -> a UTC midnight `Date`.
 *
 * Built from parts rather than handed to `new Date(string)` on purpose: the
 * engine parses a bare `01-Jul-2026` in the RUNNER's local zone, so a worker in
 * IST stores the previous day at 18:30Z. Same trap as `mf-portfolio-logic`'s
 * Excel-serial handling, reached by a different road.
 */
export function parseAmfiDayMonthYear(value: string): Date | null {
  const m = /^\s*(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})\s*$/.exec(value);
  if (!m) return null;
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const idx = months.indexOf(m[2]!.slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, idx, day));
  // Reject 31-Feb and friends: the constructor rolls them silently.
  if (d.getUTCMonth() !== idx || d.getUTCDate() !== day) return null;
  return d;
}

// ============== PLAN ==============

export type AmfiPlan = "DIRECT" | "REGULAR";

const DIRECT_TOKEN = /(^|[^a-z])direct([^a-z]|$)/i;
const REGULAR_TOKEN = /(^|[^a-z])regular([^a-z]|$)/i;

/**
 * The plan a NAV name DECLARES, or null when it declares none.
 *
 * Null is the common case and the important one: 4,470 of 16,394 live master
 * rows (27%) name neither plan. Returning "REGULAR" for them would be the
 * industry convention and also a guess, and a wrong plan silently attaches the
 * wrong expense ratio to a fund — a number users make decisions on. A row that
 * says both (44 live rows) is equally undecidable and also yields null.
 */
export function classifyAmfiPlan(navName: string): AmfiPlan | null {
  const direct = DIRECT_TOKEN.test(navName);
  const regular = REGULAR_TOKEN.test(navName);
  if (direct && regular) return null;
  if (direct) return "DIRECT";
  if (regular) return "REGULAR";
  return null;
}

// ============== SCHEME MASTER ==============

export interface AmfiSchemeMasterRow {
  /** AMFI scheme code — joins directly to `MutualFundMaster.schemeCode`. */
  schemeCode: string;
  amcName: string;
  /** BASE scheme name, no plan/option suffix. The TER join key. */
  schemeName: string;
  /** "Open Ended" | "Close Ended" | "Interval Fund". */
  schemeType: string;
  /** SEBI category, e.g. "Equity Scheme - Large & Mid Cap Fund". */
  schemeCategory: string;
  /** Full NAV name, with plan and option. Plan is read from this. */
  schemeNavName: string;
  plan: AmfiPlan | null;
  launchDate: Date | null;
  closureDate: Date | null;
  /** First half of the jammed ISIN field ("Div Payout / Growth"). */
  isinPayoutOrGrowth: string | null;
  /** Second half of the jammed ISIN field ("Div Reinvestment"). */
  isinReinvestment: string | null;
}

export interface AmfiSchemeMasterFile {
  rows: AmfiSchemeMasterRow[];
  reasons: Record<string, number>;
}

const SCHEME_MASTER_HEADER_HEAD = ["AMC", "CODE", "SCHEME NAME"];
const ISIN_SHAPE = /^INF[A-Z0-9]{9}$/;

/**
 * Split the scheme master's tenth field into its two ISINs.
 *
 * The field is the concatenation of two fixed-width 12-character ISINs with no
 * separator (trap 7), and a `-` stands in for a missing half. Live length
 * distribution over 16,394 rows: 10,946 x 12, 3,992 x 24, 1,413 x 0, 43 x 13.
 *
 * Splitting on the sentinel first and then at 12 handles all four; anything
 * that does not match `INF` + 9 alphanumerics is discarded rather than stored,
 * because a half-read ISIN joins to the wrong fund exactly as confidently as a
 * whole one.
 */
export function splitJammedIsins(field: string): {
  payoutOrGrowth: string | null;
  reinvestment: string | null;
} {
  const raw = field.trim();
  const valid = (s: string): string | null => (ISIN_SHAPE.test(s) ? s : null);

  if (raw === "" || raw === "-")
    return { payoutOrGrowth: null, reinvestment: null };
  if (raw.startsWith("-")) {
    return { payoutOrGrowth: null, reinvestment: valid(raw.slice(1)) };
  }
  const first = raw.slice(0, 12);
  const rest = raw.slice(12);
  return {
    payoutOrGrowth: valid(first),
    reinvestment: rest === "" || rest === "-" ? null : valid(rest),
  };
}

/**
 * Parse `DownloadSchemeData_Po.aspx`.
 *
 * @returns `null` when the bytes are not this file at all (no recognisable
 *   header). Never returns an empty result — see {@link AmfiFeedEmptyError}.
 * @throws {AmfiFeedEmptyError} when the header parses and no data row does.
 */
export function parseAmfiSchemeMaster(
  input: string | Uint8Array,
): AmfiSchemeMasterFile | null {
  const reasons: Record<string, number> = {};
  const text = decode(input);
  const lines = text.split(/\r?\n/);

  const headerIdx = lines.findIndex((l) => {
    const cols = l.split(",");
    if (cols.length < 10) return false;
    return SCHEME_MASTER_HEADER_HEAD.every(
      (want, i) => normaliseAmfiName(cols[i] ?? "") === want,
    );
  });
  if (headerIdx < 0) return null;

  const rows: AmfiSchemeMasterRow[] = [];
  const seen = new Set<string>();

  for (const line of lines.slice(headerIdx + 1)) {
    if (line.trim() === "") continue;
    const cols = line.split(",");
    // Every one of the 16,394 live rows has exactly 10 fields; a row that does
    // not is a quoting/embedded-comma case we have never seen, and inventing a
    // recovery for it would be inventing data.
    if (cols.length !== 10) {
      tally(reasons, "wrong_column_count");
      continue;
    }
    const schemeCode = (cols[1] ?? "").trim();
    if (!/^\d+$/.test(schemeCode)) {
      tally(reasons, "non_numeric_scheme_code");
      continue;
    }
    if (seen.has(schemeCode)) {
      tally(reasons, "duplicate_scheme_code");
      continue;
    }
    const schemeName = mfTextOrNull(cols[2]);
    if (schemeName === null) {
      tally(reasons, "blank_scheme_name");
      continue;
    }
    const navName = mfTextOrNull(cols[5]) ?? schemeName;
    const launchDate = parseAmfiDayMonthYear(cols[7] ?? "");
    if (launchDate === null && (cols[7] ?? "").trim() !== "") {
      tally(reasons, "unparsable_launch_date");
    }
    const isins = splitJammedIsins(cols[9] ?? "");

    seen.add(schemeCode);
    rows.push({
      schemeCode,
      amcName: mfTextOrNull(cols[0]) ?? "",
      schemeName,
      schemeType: mfTextOrNull(cols[3]) ?? "",
      schemeCategory: mfTextOrNull(cols[4]) ?? "",
      schemeNavName: navName,
      plan: classifyAmfiPlan(navName),
      launchDate,
      closureDate: parseAmfiDayMonthYear(cols[8] ?? ""),
      isinPayoutOrGrowth: isins.payoutOrGrowth,
      isinReinvestment: isins.reinvestment,
    });
    tally(reasons, "ok");
  }

  if (rows.length === 0) throw new AmfiFeedEmptyError("scheme-master", reasons);
  return { rows, reasons };
}

// ============== SCHEMEWISE AAUM ==============

export interface AmfiAumRow {
  /** `AMFI_Code` — joins directly to `MutualFundMaster.schemeCode`. */
  schemeCode: string;
  amcName: string;
  schemeCategory: string;
  /** Feed's own NAV name; useful to corroborate the code join, not to join on. */
  schemeNavName: string;
  /** Average AUM for the quarter, in Rs CRORE (converted from lakh — trap 2). */
  aumCrore: number;
}

export interface AmfiAumDisclosure {
  /** The quarter the payload says it is, e.g. "April - June 2026". */
  period: string;
  rows: AmfiAumRow[];
  reasons: Record<string, number>;
}

interface RawAaumScheme {
  SchemeNAVName?: unknown;
  AMFI_Code?: unknown;
  AverageAumForTheMonth?: {
    ExcludingFundOfFundsDomesticButIncludingFundOfFundsOverseas?: unknown;
    FundOfFundsDomestic?: unknown;
  };
}

interface RawAaumGroup {
  Mfname?: unknown;
  SchemeCat_Desc?: unknown;
  schemes?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse the schemewise average-AUM payload.
 *
 * @param expectPeriod when given, the payload's own `selectedPeriod` must equal
 *   it or the parse returns `null`. This is the guard for trap 3: `fyId` and
 *   `periodId` renumber, so the only way to know which quarter came back is to
 *   read what the server says it sent. Omitting it accepts whatever arrived and
 *   reports the period on the result.
 * @returns `null` for a payload that is not this feed (including the HTTP 400
 *   `{"message": "..."}` bodies AMFI returns for a bogus fyId/MF_ID) or whose
 *   period contradicts `expectPeriod`.
 * @throws {AmfiFeedEmptyError} when the envelope is right and no scheme parses.
 *
 * `AverageAumForTheMonth` is a misnomer in AMFI's own JSON — the door is
 * addressed by QUARTER (`"April - June 2026"`) and there is one period per
 * quarter, four per financial year.
 */
export function parseAmfiAumDisclosure(
  input: string | Uint8Array,
  expectPeriod?: string,
): AmfiAumDisclosure | null {
  const reasons: Record<string, number> = {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(input));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) return null;

  const period =
    typeof parsed.selectedPeriod === "string" ? parsed.selectedPeriod : "";
  if (expectPeriod !== undefined && period !== expectPeriod) return null;

  const rows: AmfiAumRow[] = [];
  const seen = new Set<string>();

  for (const groupRaw of parsed.data as unknown[]) {
    if (!isRecord(groupRaw)) {
      tally(reasons, "malformed_group");
      continue;
    }
    const group = groupRaw as RawAaumGroup;
    const amcName = mfTextOrNull(group.Mfname) ?? "";
    const schemeCategory = mfTextOrNull(group.SchemeCat_Desc) ?? "";
    if (!Array.isArray(group.schemes)) {
      tally(reasons, "group_without_schemes");
      continue;
    }
    for (const schemeRaw of group.schemes as unknown[]) {
      if (!isRecord(schemeRaw)) {
        tally(reasons, "malformed_scheme");
        continue;
      }
      const scheme = schemeRaw as RawAaumScheme;
      const code = mfTextOrNull(scheme.AMFI_Code);
      if (code === null || !/^\d+$/.test(code)) {
        tally(reasons, "missing_amfi_code");
        continue;
      }
      if (seen.has(code)) {
        tally(reasons, "duplicate_amfi_code");
        continue;
      }
      const bucket = scheme.AverageAumForTheMonth;
      if (!isRecord(bucket)) {
        tally(reasons, "missing_aum_bucket");
        continue;
      }
      const excl = mfNumberOrNull(
        bucket.ExcludingFundOfFundsDomesticButIncludingFundOfFundsOverseas,
      );
      const fof = mfNumberOrNull(bucket.FundOfFundsDomestic);
      // SEBI's disclosure splits AUM into "everything except domestic FoF" and
      // "domestic FoF"; the fund's AUM is the sum. Both absent is no number at
      // all — distinct from both being a real 0, which some ETFs publish and
      // which must survive as 0.
      if (excl === null && fof === null) {
        tally(reasons, "no_aum_value");
        continue;
      }
      const lakh = (excl ?? 0) + (fof ?? 0);
      if (!Number.isFinite(lakh) || lakh < 0) {
        tally(reasons, "non_finite_aum");
        continue;
      }
      seen.add(code);
      rows.push({
        schemeCode: code,
        amcName,
        schemeCategory,
        schemeNavName: mfTextOrNull(scheme.SchemeNAVName) ?? "",
        aumCrore: lakh / AAUM_LAKH_PER_CRORE,
      });
      tally(reasons, "ok");
    }
  }

  if (rows.length === 0)
    throw new AmfiFeedEmptyError("aaum-schemewise", reasons);
  return { period, rows, reasons };
}

// ============== TER ==============

export interface AmfiTerRow {
  /** BASE scheme name — joins to the scheme master's `Scheme Name`. */
  schemeName: string;
  schemeType: string;
  schemeCategory: string;
  /** The latest disclosure date seen for this scheme in the file. */
  terDate: Date;
  /** Regular-plan total TER, %. 0 is a real value. */
  regularTer: number | null;
  /** Direct-plan total TER, %. 0 is a real value (gold/silver ETFs publish it). */
  directTer: number | null;
}

export interface AmfiTerDisclosure {
  rows: AmfiTerRow[];
  reasons: Record<string, number>;
}

/**
 * Header text -> column index, matched on normalised text.
 *
 * Only these four are required. Everything else in the sheet differs between
 * the pre- and post-2026 regulation regimes (trap 5) and none of it is used.
 */
const TER_COLUMNS = {
  schemeName: "SCHEME NAME",
  schemeType: "SCHEME TYPE",
  schemeCategory: "SCHEME CATEGORY",
  terDate: "TER DATE",
  regularTer: "REGULAR PLAN TOTAL TER",
  directTer: "DIRECT PLAN TOTAL TER",
} as const;

function locateTerHeader(
  grid: Grid,
): Record<keyof typeof TER_COLUMNS, number> | null {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const row = grid[r];
    if (!row) continue;
    const found: Partial<Record<keyof typeof TER_COLUMNS, number>> = {};
    for (let c = 0; c < row.length; c++) {
      // Trailing "(%)" is stripped by the alphanumeric normaliser, so
      // "Regular Plan - Total TER (%)" collapses to "REGULAR PLAN TOTAL TER"
      // under BOTH header regimes.
      const text = normaliseAmfiName(String(row[c] ?? ""));
      for (const key of Object.keys(
        TER_COLUMNS,
      ) as (keyof typeof TER_COLUMNS)[]) {
        if (found[key] === undefined && text === TER_COLUMNS[key])
          found[key] = c;
      }
    }
    if (
      found.schemeName !== undefined &&
      found.terDate !== undefined &&
      found.regularTer !== undefined &&
      found.directTer !== undefined
    ) {
      return {
        schemeName: found.schemeName,
        schemeType: found.schemeType ?? -1,
        schemeCategory: found.schemeCategory ?? -1,
        terDate: found.terDate,
        regularTer: found.regularTer,
        directTer: found.directTer,
      };
    }
  }
  return null;
}

/**
 * Parse one monthly TER XLSX.
 *
 * The export is DAILY inside a monthly file (trap 6): 63,157 rows for 2,124
 * schemes in July 2026. One row per scheme survives — the one with the LATEST
 * `TER Date`, because that is the rate in force at the end of the disclosed
 * month and the only one a "current expense ratio" field can honestly hold.
 *
 * @returns `null` when the bytes are not an XLSX, or are an XLSX without the
 *   four required TER columns.
 * @throws {AmfiFeedEmptyError} when the header is found and no data row parses
 *   — which is exactly what `Month=01-2015` produces (trap 1): a 7.8 KB
 *   workbook with the right sheet name, a valid header and nothing under it.
 */
export function parseAmfiTerDisclosure(
  bytes: Uint8Array,
): AmfiTerDisclosure | null {
  const reasons: Record<string, number> = {};

  let wb: XLSX.WorkBook;
  try {
    // `cellDates:false` matches the house readers: SheetJS builds Dates in the
    // runner's LOCAL zone, which shifts a date-formatted cell by a day east of
    // UTC. Dates here are text ("01-Jul-2026") and parsed by
    // `parseAmfiDayMonthYear`, but one upstream formatting change would arm the
    // trap.
    wb = XLSX.read(toBuffer(bytes), { type: "buffer", cellDates: false });
  } catch {
    return null;
  }

  const sheetName = wb.SheetNames?.[0];
  if (!sheetName) return null;
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return null;

  const grid = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: null,
  }) as Grid;
  if (grid.length === 0) return null;

  const cols = locateTerHeader(grid);
  if (!cols) return null;

  // Latest disclosure date wins, per scheme.
  const latest = new Map<string, AmfiTerRow>();

  for (const row of grid) {
    if (!row) continue;
    const name = mfTextOrNull(String(row[cols.schemeName] ?? ""));
    const dateText = String(row[cols.terDate] ?? "").trim();
    if (name === null) {
      tally(reasons, "blank_scheme_name");
      continue;
    }
    // The header row itself, and the 13-row disclaimer block AMFI appends
    // below the data (all of it in column A), both fail this test.
    const terDate = parseAmfiDayMonthYear(dateText);
    if (terDate === null) {
      tally(reasons, dateText === "" ? "no_ter_date" : "unparsable_ter_date");
      continue;
    }
    // `mfNumberOrNull` is the whole point: "0.0000" must come back as 0, not
    // null. 93 of the 386 rows in the committed 360 ONE fixture are zeros.
    const regularTer = mfNumberOrNull(row[cols.regularTer]);
    const directTer = mfNumberOrNull(row[cols.directTer]);
    if (regularTer === null && directTer === null) {
      tally(reasons, "no_ter_value");
      continue;
    }

    const key = normaliseAmfiName(name);
    const prev = latest.get(key);
    if (prev && prev.terDate.getTime() >= terDate.getTime()) {
      tally(reasons, "superseded_by_later_date");
      continue;
    }
    latest.set(key, {
      schemeName: name,
      schemeType:
        cols.schemeType >= 0 ? String(row[cols.schemeType] ?? "").trim() : "",
      schemeCategory:
        cols.schemeCategory >= 0
          ? String(row[cols.schemeCategory] ?? "").trim()
          : "",
      terDate,
      regularTer,
      directTer,
    });
    tally(reasons, "ok");
  }

  const rows = [...latest.values()];
  if (rows.length === 0) throw new AmfiFeedEmptyError("ter", reasons);
  return { rows, reasons };
}

// ============== FUND TYPE ==============

/**
 * `MutualFundMaster.fundType` from AMFI's own SEBI category string.
 *
 * Only the five modern SEBI top-level buckets map, because only they are a
 * TRANSLATION rather than an interpretation. The live master also carries
 * pre-2018 labels — "Income" (6,084 rows), "Growth" (357), "Balanced" (5),
 * "Assured Return" (2), "Life Cycle Funds" (8) — whose modern equivalent is a
 * judgement call per scheme. Those return null. Extending this map is a
 * data-evidence task, not a naming task.
 */
export function amfiFundTypeFromCategory(category: string): string | null {
  const head = normaliseAmfiName(category.split(" - ")[0] ?? "");
  switch (head) {
    case "EQUITY SCHEME":
    case "EQUITY SCHEMES":
      return "equity";
    case "DEBT SCHEME":
    case "DEBT SCHEMES":
      return "debt";
    case "HYBRID SCHEME":
    case "HYBRID SCHEMES":
      return "hybrid";
    case "SOLUTION ORIENTED SCHEME":
    case "SOLUTION ORIENTED SCHEMES":
      return "solution";
    case "OTHER SCHEME":
    case "OTHER SCHEMES":
      return "other";
    default:
      return null;
  }
}

// ============== JOIN ==============

export interface AmfiMetadataSources {
  master: AmfiSchemeMasterFile;
  aum?: AmfiAumDisclosure | null;
  ter?: AmfiTerDisclosure | null;
}

export interface AmfiMetadataIndexStats {
  masterRows: number;
  aumRows: number;
  terNames: number;
  /** Scheme codes carrying at least one field. */
  covered: number;
  withAum: number;
  withExpenseRatio: number;
  withLaunchDate: number;
  withFundType: number;
  /** TER names that matched no master scheme name. */
  terNamesUnmatched: number;
  /**
   * Master codes reached by a TER row whose PLAN could not be read from the
   * NAV name, so no expense ratio was attached. Not an error — the deliberate
   * refusal to guess, counted so its cost is visible.
   */
  terPlanUndeclared: number;
  /** AAUM codes absent from the scheme master (still indexed — the code is the key). */
  aumCodesNotInMaster: number;
}

export interface AmfiMetadataIndex {
  bySchemeCode: Map<string, MfMetadataFields>;
  stats: AmfiMetadataIndexStats;
}

/**
 * Fold the three feeds into one `schemeCode -> fields` map.
 *
 * Pure. The scheme master is REQUIRED because it is the only bridge from TER's
 * base scheme name to a scheme code, and the only source of `launchDate`. AUM
 * and TER are each optional so a run can proceed on whichever published.
 *
 * @throws {AmfiFeedEmptyError} when the fold produces no covered scheme at all.
 *   Every input can be individually non-empty and still join to nothing (a TER
 *   month for one AMC against a master for another), and that is the same
 *   silent-success this ticket exists to kill.
 */
export function buildAmfiFundMetadataIndex(
  sources: AmfiMetadataSources,
): AmfiMetadataIndex {
  const { master, aum, ter } = sources;

  const bySchemeCode = new Map<string, MfMetadataFields>();
  const ensure = (code: string): MfMetadataFields => {
    let f = bySchemeCode.get(code);
    if (!f) {
      f = emptyMfMetadata();
      bySchemeCode.set(code, f);
    }
    return f;
  };

  const stats: AmfiMetadataIndexStats = {
    masterRows: master.rows.length,
    aumRows: aum?.rows.length ?? 0,
    terNames: ter?.rows.length ?? 0,
    covered: 0,
    withAum: 0,
    withExpenseRatio: 0,
    withLaunchDate: 0,
    withFundType: 0,
    terNamesUnmatched: 0,
    terPlanUndeclared: 0,
    aumCodesNotInMaster: 0,
  };

  // ── master: launchDate + fundType, and the name -> codes bridge ──
  const masterByCode = new Map<string, AmfiSchemeMasterRow>();
  const masterByName = new Map<string, AmfiSchemeMasterRow[]>();
  for (const row of master.rows) {
    masterByCode.set(row.schemeCode, row);
    const key = normaliseAmfiName(row.schemeName);
    const bucket = masterByName.get(key);
    if (bucket) bucket.push(row);
    else masterByName.set(key, [row]);

    const fundType = amfiFundTypeFromCategory(row.schemeCategory);
    if (row.launchDate === null && fundType === null) continue;
    const fields = ensure(row.schemeCode);
    if (row.launchDate !== null) {
      fields.launchDate = row.launchDate;
      stats.withLaunchDate++;
    }
    if (fundType !== null) {
      fields.fundType = fundType;
      stats.withFundType++;
    }
  }

  // ── AAUM: keyed by AMFI_Code, so no plan reasoning is needed at all ──
  for (const row of aum?.rows ?? []) {
    if (!masterByCode.has(row.schemeCode)) stats.aumCodesNotInMaster++;
    ensure(row.schemeCode).aum = row.aumCrore;
    stats.withAum++;
  }

  // ── TER: base name -> master codes -> per-plan value ──
  for (const row of ter?.rows ?? []) {
    const matches = masterByName.get(normaliseAmfiName(row.schemeName));
    if (!matches || matches.length === 0) {
      stats.terNamesUnmatched++;
      continue;
    }
    for (const m of matches) {
      // The 1-name-to-4-codes fan-out resolves here, and ONLY here. A code
      // whose NAV name declares no plan is skipped: AMFI publishes TER per
      // plan, we cannot tell which one this code is, and attaching the wrong
      // one is worse than attaching none.
      if (m.plan === null) {
        stats.terPlanUndeclared++;
        continue;
      }
      const value = m.plan === "DIRECT" ? row.directTer : row.regularTer;
      if (value === null) continue;
      ensure(m.schemeCode).expenseRatio = value;
      stats.withExpenseRatio++;
    }
  }

  // Drop codes that ended up with nothing — an all-null entry is exactly the
  // "enriched with nothing" row this ticket is removing from the database.
  for (const [code, fields] of bySchemeCode) {
    const any = Object.values(fields).some((v) => v !== null);
    if (!any) bySchemeCode.delete(code);
  }
  stats.covered = bySchemeCode.size;

  if (stats.covered === 0) {
    throw new AmfiFeedEmptyError("index", {
      masterRows: stats.masterRows,
      aumRows: stats.aumRows,
      terNames: stats.terNames,
      terNamesUnmatched: stats.terNamesUnmatched,
      terPlanUndeclared: stats.terPlanUndeclared,
    });
  }
  return { bySchemeCode, stats };
}

// ============== FETCH (I/O — deliberately separate from the parsers) ==============

const AMFI_TIMEOUT_MS = 60_000;

/**
 * The single seam every network read here goes through.
 *
 * Kept as one small function so routing it via `getFeedAsset` later is a
 * one-line change and so the browser-ish headers AMFI's Next.js front end
 * expects live in exactly one place.
 */
async function amfiFetch(
  url: string,
  referer: string,
  accept: string,
  timeoutMs = AMFI_TIMEOUT_MS,
): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      Accept: accept,
      Referer: referer,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`[amfi] ${res.status} ${res.statusText} for ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Raw scheme-master bytes. Parse with {@link parseAmfiSchemeMaster}. */
export async function fetchAmfiSchemeMasterBytes(
  mfId: number = 0,
): Promise<Uint8Array> {
  return amfiFetch(
    buildAmfiSchemeMasterUrl(mfId),
    AMFI_SCHEME_MASTER_REFERER,
    "text/csv,*/*",
  );
}

/** Raw monthly TER XLSX bytes. Parse with {@link parseAmfiTerDisclosure}. */
export async function fetchAmfiTerDisclosureBytes(
  month: string,
  mfId: string = "All",
): Promise<Uint8Array> {
  return amfiFetch(
    buildAmfiTerExcelUrl(month, mfId),
    AMFI_TER_REFERER,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
  );
}

export interface AmfiAaumPeriodRef {
  fyId: number;
  periodId: number;
  /** The label the ordinals resolved to, e.g. "April - June 2026". */
  period: string;
  financialYear: string;
}

/**
 * Turn a DATE into the pair of ordinals the AAUM door wants, by label.
 *
 * This is the whole defence against trap 3. `fyId`/`periodId` renumber as AMFI
 * publishes, so the only safe addressing is: list the years, find the one whose
 * LABEL matches the target's financial year, list its periods, find the one
 * whose LABEL matches the target's quarter. The returned ordinals are valid for
 * this call and must never be cached across runs.
 *
 * @returns null when AMFI has not published the requested quarter yet — a
 *   normal state for the first weeks of a quarter, and a soft "nothing to do",
 *   not a failure.
 */
export async function resolveAmfiAaumPeriod(
  target: Date,
  mfId: number | string = 0,
): Promise<AmfiAaumPeriodRef | null> {
  const wantFy = amfiAaumFinancialYearLabel(target);
  const wantPeriod = amfiAaumQuarterLabel(target);

  const yearsRaw = JSON.parse(
    new TextDecoder().decode(
      await amfiFetch(
        buildAmfiAaumFinancialYearsUrl(mfId),
        AMFI_AAUM_REFERER,
        "application/json",
      ),
    ),
  ) as unknown;
  if (!isRecord(yearsRaw) || !Array.isArray(yearsRaw.data)) return null;
  const fy = (yearsRaw.data as unknown[]).find(
    (y) => isRecord(y) && y.financial_year === wantFy,
  );
  if (!isRecord(fy) || typeof fy.id !== "number") return null;

  const periodsRaw = JSON.parse(
    new TextDecoder().decode(
      await amfiFetch(
        buildAmfiAaumPeriodsUrl(fy.id, mfId),
        AMFI_AAUM_REFERER,
        "application/json",
      ),
    ),
  ) as unknown;
  if (!isRecord(periodsRaw) || !isRecord(periodsRaw.data)) return null;
  const periods = periodsRaw.data.periods;
  if (!Array.isArray(periods)) return null;
  const p = (periods as unknown[]).find(
    (x) => isRecord(x) && x.period === wantPeriod,
  );
  if (!isRecord(p) || typeof p.id !== "number") return null;

  return {
    fyId: fy.id,
    periodId: p.id,
    period: wantPeriod,
    financialYear: wantFy,
  };
}

/** Raw schemewise-AAUM JSON bytes. Parse with {@link parseAmfiAumDisclosure}. */
export async function fetchAmfiAumDisclosureBytes(
  ref: AmfiAaumPeriodRef,
  mfId: number | string = 0,
): Promise<Uint8Array> {
  return amfiFetch(
    buildAmfiAaumDataUrl(ref.fyId, ref.periodId, mfId),
    AMFI_AAUM_REFERER,
    "application/json",
  );
}

// ============== PROVIDER ==============

/**
 * Off unless `MF_METADATA_PROVIDER=amfi`.
 *
 * Deliberately opt-in, and it is now the ONLY registered provider (MONEY-1409
 * deleted the Kuvera one outright), so an unset flag means no enrichment at
 * all rather than a fallback: `getMfMetadataProvider()` returns null and the
 * worker REFUSES to run. That is the intended shape — a no-op run exiting 0 is
 * exactly what hid the dead upstream for three months.
 *
 * The reason for the flag is unchanged. `enrichMfMetadata` is called from the
 * MF detail page on every stale view, and this provider's first call downloads
 * and folds three whole-universe files. That belongs in the weekly worker, not
 * on a user-facing request, and an explicit env flag is the only honest way to
 * say so.
 */
export function isAmfiFundMetadataEnabled(): boolean {
  return (
    (process.env.MF_METADATA_PROVIDER ?? "").trim().toLowerCase() ===
    AMFI_METADATA_PROVIDER_ID
  );
}

/**
 * How long a folded snapshot is reused before being rebuilt.
 *
 * The underlying files change monthly (TER) and quarterly (AAUM); six hours is
 * short enough that a same-day rerun after a publication picks it up and long
 * enough that one batch of 500 funds costs one download of each file.
 */
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

interface Snapshot {
  index: AmfiMetadataIndex;
  builtAt: number;
}

let snapshot: Snapshot | null = null;
let inflight: Promise<AmfiMetadataIndex> | null = null;

/** Drop the cached snapshot. For tests and for a forced refresh. */
export function resetAmfiFundMetadataSnapshot(): void {
  snapshot = null;
  inflight = null;
}

/** Seed the snapshot from already-parsed files. Lets a worker (or a test) supply bytes. */
export function primeAmfiFundMetadataSnapshot(index: AmfiMetadataIndex): void {
  snapshot = { index, builtAt: Date.now() };
  inflight = null;
}

/**
 * Download + fold the three feeds. Single-flight: 500 concurrent lookups in one
 * batch must not become 1,500 downloads.
 */
export async function loadAmfiFundMetadataIndex(
  now: Date = new Date(),
): Promise<AmfiMetadataIndex> {
  if (snapshot && Date.now() - snapshot.builtAt < SNAPSHOT_TTL_MS) {
    return snapshot.index;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<AmfiMetadataIndex> => {
    const master = parseAmfiSchemeMaster(await fetchAmfiSchemeMasterBytes());
    if (!master) {
      throw new Error("[amfi] scheme master did not parse as the expected CSV");
    }

    // The TER month AMFI has certainly published is the PREVIOUS one; the
    // current month's file exists but is partial and its last row is whatever
    // day it is. Asking for last month is both complete and stable.
    const prevMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    let ter: AmfiTerDisclosure | null = null;
    try {
      ter = parseAmfiTerDisclosure(
        await fetchAmfiTerDisclosureBytes(amfiTerMonthToken(prevMonth)),
      );
    } catch (error) {
      // A dataless TER month is loud (AmfiFeedEmptyError) but must not sink the
      // whole run: the master still carries launch dates and the AAUM still
      // carries AUM. Rethrowing here would turn a partial publication into a
      // total outage.
      console.warn(
        `[amfi] TER month ${amfiTerMonthToken(prevMonth)} unusable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Quarterly, published with a lag; walk back until one resolves.
    let aum: AmfiAumDisclosure | null = null;
    for (let back = 0; back < 3 && aum === null; back++) {
      const target = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3 * back, 1),
      );
      try {
        const ref = await resolveAmfiAaumPeriod(target);
        if (!ref) continue;
        aum = parseAmfiAumDisclosure(
          await fetchAmfiAumDisclosureBytes(ref),
          ref.period,
        );
      } catch (error) {
        console.warn(
          `[amfi] AAUM quarter ${amfiAaumQuarterLabel(target)} unusable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const index = buildAmfiFundMetadataIndex({ master, aum, ter });
    console.log(
      `[amfi] snapshot: ${index.stats.covered} schemes ` +
        `(aum=${index.stats.withAum} ter=${index.stats.withExpenseRatio} ` +
        `launch=${index.stats.withLaunchDate} type=${index.stats.withFundType} ` +
        `terUnmatched=${index.stats.terNamesUnmatched} ` +
        `terPlanUndeclared=${index.stats.terPlanUndeclared})`,
    );
    snapshot = { index, builtAt: Date.now() };
    return index;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * The `MfMetadataProvider` implementation.
 *
 * Bulk-file source behind a per-fund seam: the snapshot is built once and every
 * `fetch` is a map lookup on `schemeCode`.
 *
 * `not-found` vs `unavailable` is load-bearing (see `MfMetadataOutcome`): a
 * scheme absent from a snapshot that DID load is a deterministic "AMFI does not
 * disclose this fund" and should advance the cursor; a snapshot that failed to
 * load is transient and must not be recorded as an attempt.
 */
export const amfiFundMetadataProvider: MfMetadataProvider = {
  id: AMFI_METADATA_PROVIDER_ID,

  isConfigured(): boolean {
    return isAmfiFundMetadataEnabled();
  },

  async fetch(lookup: MfMetadataLookup): Promise<MfMetadataOutcome> {
    let index: AmfiMetadataIndex;
    try {
      index = await loadAmfiFundMetadataIndex();
    } catch (error) {
      return {
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const fields = index.bySchemeCode.get(lookup.schemeCode);
    if (!fields) return { status: "not-found" };
    // Copy: the snapshot is shared across every lookup in the batch and a
    // caller mutating its fields would poison every later read of that scheme.
    return { status: "ok", fields: { ...fields } };
  },
};
