/**
 * Monthly AMC portfolio disclosures — pure parser (MONEY-1104, Data Engine P8a).
 *
 * Every Indian AMC publishes a SEBI-mandated monthly portfolio disclosure: for
 * each scheme, every instrument held on the last day of the month with its
 * ISIN, quantity, market value and share of the fund. It is the only free,
 * authoritative, whole-universe view of what mutual funds actually own — no
 * scrape, no vendor, no rate limit.
 *
 * SEBI mandates the *content*, not the *encoding*. What arrives is four
 * different spreadsheets pretending to be one format. This module receives
 * BYTES and returns parsed data; it does no I/O, no network and no DB work, so
 * every one of the deformities below is testable against a committed fixture.
 *
 * ## What the fixtures actually are (all verified byte-for-byte)
 *
 * | AMC    | container            | workbook | sheets | scheme identity              |
 * | ------ | -------------------- | -------- | ------ | ---------------------------- |
 * | SBI    | bare .xlsx           | OOXML    | 122    | Index: code + short + name   |
 * | ABSL   | .zip WRAPPING an xls | OLE2     | 105    | Index: code + short + name   |
 * | Nippon | bare ".xls"          | OOXML    | 108    | Index: sheet name + name     |
 * | HDFC   | bare .xlsx           | OOXML    | 1      | in-sheet name only           |
 *
 * ## The traps, and why each one is a silent-wrong-answer rather than a crash
 *
 * 1. **The file extension is noise in BOTH directions.** Nippon's
 *    `...-portfolio.xls` is an OOXML zip (`PK\x03\x04`); ABSL's zip contains a
 *    genuine OLE2 `...Report.xls` (`\xD0\xCF\x11\xE0`). The Content-Type header
 *    lies too (Nippon serves `application/vnd.ms-excel`). So format is decided
 *    by MAGIC BYTES only — see {@link detectWorkbookFormat}.
 *
 * 2. **A zip is not necessarily a workbook.** An OOXML workbook *is* a zip, and
 *    ABSL ships a zip that *contains* a workbook. Both start `PK\x03\x04`, so
 *    the discriminator is the ENTRY NAMES: an OOXML package declares
 *    `[Content_Types].xml` / `xl/…` parts. Handed the ABSL archive directly,
 *    SheetJS throws `Unsupported ZIP file` — i.e. without this split, one of
 *    the five largest AMCs by AUM simply fails to import, all 104 schemes.
 *
 * 3. **The percentage column is stored at two different SCALES.** This is the
 *    dangerous one, because both scales parse as a perfectly good number.
 *    SBI and HDFC store `6.78` meaning 6.78%. Nippon and ABSL store
 *    `0.0647006940593613` for 6.47% — an Excel *percent-formatted* cell, whose
 *    underlying value is the fraction. Read naively, ABSL's entire book is
 *    understated 100×, and nothing anywhere throws. We resolve it from the
 *    cell's NUMBER FORMAT and corroborate with the column sum — see
 *    {@link resolvePercentScale} for why the format has to win.
 *
 * 4. **Industry and rating are ONE column whose header word-order flips.**
 *    SBI writes `Rating / Industry^`, ABSL `Industry^ / Rating`, Nippon
 *    `Industry / Rating`, HDFC `Industry+ /Rating`. A mapper that keys on the
 *    first word files SBI's equities under `rating` and everyone else's under
 *    `industry` — a field swap with no error. There is exactly one column, and
 *    it holds an industry for equity rows and a credit rating for debt rows, so
 *    it must be classified per ROW by content ({@link classifyIndustryOrRating}).
 *
 * 5. **Header cells contain embedded newlines** (`"Market value\n(Rs. in
 *    Lakhs)"`, `"% to AUM \non 31JUL26"`). All header matching runs on
 *    whitespace-collapsed text.
 *
 * 6. **A portfolio sheet holds MORE THAN ONE TABLE.** Below the holdings come
 *    SEBI note blocks, and in some schemes a second table with its OWN header
 *    and its own meaning for column 7. ABSL's `BSLMTP` has a
 *    "securities in default" table whose column 7 is a rupee amount; scanning
 *    to end-of-sheet summed its `% to AUM` to 1,451,238,937. So the row scan
 *    stops at a terminator ({@link isTableTerminator}) rather than at EOF.
 *
 * 7. **The as-of date has four encodings**: an Excel serial (SBI, `46234`),
 *    and three prose spellings — `31-Jul-2026` (HDFC), `July 31,2026` (Nippon,
 *    no space after the comma), `July 31, 2026` (ABSL). The serial is read off
 *    the raw cell with `cellDates:false`, deliberately: SheetJS's
 *    `sheet_to_json` coercion builds Dates in the RUNNER's timezone, which
 *    turns 46234 into `2026-07-30T18:30:00Z` under IST — the month-end date,
 *    off by one, only on machines east of UTC. Serial arithmetic is timezone
 *    free, so we never let a Date object into the pipeline.
 *
 * 8. **No AMFI scheme code appears anywhere.** See {@link SchemeIndexEntry} for
 *    the identifiers that DO exist and what they can be joined on.
 *
 * ## Units
 *
 * SBI and ABSL write "Market value (Rs. in Lakhs)"; Nippon and HDFC write
 * "Market/Fair Value (Rs. in Lacs)". Lakh and lac are the same word spelled two
 * ways, but that was CONFIRMED rather than assumed: ICICI Bank (INE090A01021)
 * appears in all four fixtures, and value/quantity yields ₹1435.4 per share in
 * every one of them. Same magnitude, so `marketValueLakhs` is directly
 * comparable across AMCs. Anything that is neither spelling is reported as an
 * anomaly instead of being silently treated as lakhs.
 *
 * ## Non-finite policy
 *
 * A cell that is not a finite number becomes `null`, never `0`. These sheets are
 * full of `"NIL"`, `"N.A."` and `"-"` in numeric columns (every SBI scheme
 * prints `NIL` for its empty sections), and a fund that holds nothing is not a
 * fund that holds zero rupees — collapsing the two would let "we have no data"
 * average into portfolio aggregates as a real zero. Absent columns are likewise
 * reported in {@link AmcSchemeSheet.missingColumns} instead of being defaulted,
 * so a caller can tell "this AMC stopped publishing quantity" from "this scheme
 * holds no quantity".
 */

import { inflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";

/* -------------------------------------------------------------------------- */
/* Format detection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the bytes ACTUALLY are, regardless of filename or Content-Type.
 *
 * - `ooxml`       — a zip whose entries are an OPC/SpreadsheetML package (.xlsx)
 * - `ole2`        — a real BIFF8 compound-document workbook (.xls)
 * - `zip-archive` — a zip that is not itself a workbook (may CONTAIN one)
 * - `unknown`     — not a workbook container we recognise
 */
export type WorkbookFormat = "ooxml" | "ole2" | "zip-archive" | "unknown";

/** `\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1` — OLE2 / CFB compound document. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** Local file header `PK\x03\x04`. */
const ZIP_LOCAL_SIG = 0x04034b50;
/** Central directory header `PK\x01\x02`. */
const ZIP_CENTRAL_SIG = 0x02014b50;
/** Empty archive `PK\x05\x06`. */
const ZIP_EOCD_SIG = 0x06054b50;

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function startsWithOle2(buf: Buffer): boolean {
  if (buf.length < OLE2_MAGIC.length) return false;
  return OLE2_MAGIC.every((b, i) => buf[i] === b);
}

function startsWithZip(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const sig = buf.readUInt32LE(0);
  return sig === ZIP_LOCAL_SIG || sig === ZIP_EOCD_SIG;
}

/**
 * Entry names, read by walking the LOCAL file headers.
 *
 * The FALLBACK reader. It stops early when an entry sets general-purpose bit 3
 * (sizes deferred to a trailing data descriptor), because the next header
 * offset is then unknowable without scanning — which is exactly what made it
 * unfit to be the only reader (see {@link readZipEntryNames}). It survives for
 * the one case the central directory cannot serve: a TRUNCATED archive, which
 * has no central directory at all and must still be recognised as a workbook so
 * the completeness guard can reject it by name rather than by silence.
 */
function readLocalHeaderNames(buf: Buffer, max: number): string[] {
  const names: string[] = [];
  let off = 0;
  while (names.length < max && off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZIP_LOCAL_SIG) break;
    const flags = buf.readUInt16LE(off + 6);
    const compressedSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    if (off + 30 + nameLen > buf.length) break;
    names.push(buf.subarray(off + 30, off + 30 + nameLen).toString("utf-8"));
    if ((flags & 0x08) !== 0 && compressedSize === 0) break;
    off = off + 30 + nameLen + extraLen + compressedSize;
  }
  return names;
}

/** One central-directory record: everything needed to extract its member. */
interface ZipCentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/**
 * Every member, read from the CENTRAL DIRECTORY.
 *
 * ZIP64 is REFUSED rather than half-read: past 0xffff members or a 4 GB offset
 * the 32-bit fields hold sentinels, and reading a sentinel as a real offset
 * produces a confident wrong answer. No AMC ships one.
 */
function readCentralDirectory(buf: Buffer, max: number): ZipCentralEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0 || eocd + 22 > buf.length) return [];

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) return [];

  const out: ZipCentralEntry[] = [];
  for (let i = 0; i < count && out.length < max; i++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== ZIP_CENTRAL_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    out.push({
      name: buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf-8"),
      method,
      compressedSize,
      localOffset,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Entry names — enough of them to answer "is this an OPC package?".
 *
 * ## Why the central directory, and why the local walk stayed
 *
 * Because a local header is allowed to LIE about its sizes, and ICICI
 * Prudential's do — MONEY-1405. Every member of every one of its 147 per-scheme
 * `.xlsx` files sets general-purpose bit 3, so the local walk returns ONE name
 * and stops. When that one name is `docProps/app.xml` rather than
 * `[Content_Types].xml` or an `xl/` part, `isOpcPart` says no and a perfectly
 * ordinary workbook sniffs as `zip-archive` — measured on 37 of the 147, which
 * then read as "not a workbook" and were dropped whole.
 *
 * The central directory names every member outright, so the OPC test sees the
 * `xl/` parts wherever they sit in the archive. The local walk is kept as the
 * fallback for a TRUNCATED file, which has no central directory and whose
 * `ooxml` verdict is what routes it into the completeness guard.
 */
function readZipEntryNames(buf: Buffer, max = 64): string[] {
  const central = readCentralDirectory(buf, max);
  if (central.length > 0) return central.map((e) => e.name);
  return readLocalHeaderNames(buf, max);
}

const WORKBOOK_EXT = /\.(xlsx|xlsm|xlsb|xls)$/i;

function isOpcPart(name: string): boolean {
  return name === "[Content_Types].xml" || name.startsWith("xl/");
}

/**
 * Is this zip COMPLETE — does it still have its end-of-central-directory record?
 *
 * This guard exists because of a measured hang, not a hypothetical one. Handed
 * the first 512 bytes of a valid `.xlsx`, `XLSX.read` does not throw and does
 * not return: it spins indefinitely (>120 s, killed). A `try/catch` around the
 * read cannot save a caller from a function that never comes back, so a
 * truncated archive has to be rejected BEFORE it reaches the reader.
 *
 * That is a live failure mode, not a curiosity — a short read or a truncated
 * upload is exactly what a fetch layer hands a parser on a bad day, and the
 * symptom would be a worker wedged forever rather than a failed job.
 *
 * The EOCD is the last record in a well-formed zip, sitting at most
 * 22 + 65535 bytes from the end (the trailing comment is length-capped), so a
 * bounded backward scan is both cheap and exact.
 */
function findEndOfCentralDirectory(buf: Buffer): number {
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - (22 + maxComment));
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

function hasEndOfCentralDirectory(buf: Buffer): boolean {
  return findEndOfCentralDirectory(buf) >= 0;
}

/**
 * Sniff the container format from magic bytes.
 *
 * Pure and cheap — no decompression, no workbook parse. Order matters: OLE2 is
 * checked first because it is unambiguous, then zip, which needs the entry-name
 * pass to tell an OOXML package from an archive that merely holds one.
 */
export function detectWorkbookFormat(bytes: Uint8Array): WorkbookFormat {
  if (bytes.length === 0) return "unknown";
  const buf = toBuffer(bytes);

  if (startsWithOle2(buf)) return "ole2";
  if (!startsWithZip(buf)) return "unknown";

  const names = readZipEntryNames(buf);
  if (names.length === 0) return "zip-archive";
  if (names.some(isOpcPart)) return "ooxml";
  return "zip-archive";
}

/** One decompressed member of a zip archive. */
interface ZipEntry {
  name: string;
  bytes: Buffer;
}

/**
 * EVERY workbook member of a zip, decompressed, read via the CENTRAL DIRECTORY.
 *
 * The repo's existing single-entry unzip (`bhavcopy.ts#unzipSingleEntry`)
 * returns UTF-8 text, which would corrupt an OLE2 workbook, so this is the
 * binary-safe twin of the same hand-rolled parse. STORE (0) and DEFLATE (8) are
 * the only methods the exchanges and AMCs emit.
 *
 * ## Why the central directory, when `readZipEntryNames` walks local headers
 *
 * Because a local header is allowed to LIE, and ICICI Prudential's does —
 * MONEY-1405. Its monthly zip sets general-purpose bit 3 on every member, which
 * means the local header carries `compressedSize: 0` and the real size trails
 * the data in a descriptor. The old reader coped by scanning forward for the
 * next `PK\x07\x08` / `PK\x01\x02` signature, which is a guess: those four
 * bytes occur inside DEFLATE output often enough that on a 25,378,416-byte,
 * 147-member archive the scan truncated member one, `inflateRawSync` threw, and
 * `parseAmcPortfolioWorkbook` returned `null` for the whole file. Measured, not
 * theorised — 146 per-scheme workbooks read as "not a workbook at all".
 *
 * The central directory states every member's compressed size and local-header
 * offset outright, so nothing has to be inferred from the compressed bytes. Its
 * own `extraLen` may differ from the local header's, so the data offset is
 * computed from the LOCAL header's two length fields and the SIZE from the
 * central one — mixing those up silently shifts the data window.
 */
function unzipWorkbookEntries(buf: Buffer, max = 500): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const e of readCentralDirectory(buf, max)) {
    if (!WORKBOOK_EXT.test(e.name)) continue;
    if (e.localOffset + 30 > buf.length) continue;
    if (buf.readUInt32LE(e.localOffset) !== ZIP_LOCAL_SIG) continue;

    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    if (dataStart + e.compressedSize > buf.length) continue;

    const compressed = buf.subarray(dataStart, dataStart + e.compressedSize);
    try {
      const bytes =
        e.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
      out.push({ name: e.name, bytes });
    } catch {
      // One unreadable member must not discard the other 146.
      continue;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Result types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How the `% to NAV` column was stored on a sheet.
 *
 * `percent` → the cell already reads 0–100. `fraction` → the cell is 0–1 and
 * Excel multiplies it for display. {@link AmcHolding.pctToNav} is normalised to
 * `percent` in both cases; this field records what the file did.
 */
export type PercentScale = "percent" | "fraction";

/** How {@link AmcSchemeSheet.percentScale} was decided. See {@link resolvePercentScale}. */
export type PercentScaleSource = "number-format" | "column-sum" | "assumed";

/** One instrument line in one scheme's portfolio. */
export interface AmcHolding {
  /** e.g. `"ICICI Bank Ltd."`. Always present — a row without it is not a holding. */
  instrumentName: string;
  /** `null` when the sheet has no ISIN for the row (cash/TREPS/derivative legs). */
  isin: string | null;
  /** Set only when the combined column held an industry. Mutually exclusive with `rating`. */
  industry: string | null;
  /** Set only when the combined column held a credit rating (debt). */
  rating: string | null;
  /** `null` when absent or non-finite — never 0. */
  quantity: number | null;
  /** Rupees in LAKHS (1e5), as published. `null` when absent or non-finite. */
  marketValueLakhs: number | null;
  /** Normalised to 0–100 regardless of how the sheet stored it. `null` when absent. */
  pctToNav: number | null;
  /** The SEBI section heading this row sat under, e.g. `"Equity & Equity related"`. */
  section: string | null;
  /** AMC-internal instrument code where published (SBI/ABSL share a namespace). */
  amcInstrumentCode: string | null;
  /** 0-based row index within the sheet grid — for tracing a bad row back. */
  rowIndex: number;
}

/** Which of the expected columns this sheet actually had. */
export interface ColumnMap {
  instrumentName: number | null;
  isin: number | null;
  /** The single combined industry/rating column. */
  industryRating: number | null;
  quantity: number | null;
  marketValue: number | null;
  percent: number | null;
  amcInstrumentCode: number | null;
}

/** One scheme — one sheet in a multi-scheme workbook, or the only sheet. */
export interface AmcSchemeSheet {
  sheetName: string;
  /** Full scheme name as printed in the sheet, e.g. `"SBI ESG Exclusionary Strategy Fund"`. */
  schemeName: string | null;
  /** AMC-internal scheme code from the sheet header (`"007"`, `"RLMF001"`). Not AMFI. */
  schemeCode: string | null;
  /** `YYYY-MM-DD`, timezone-free. `null` when no as-of date could be read. */
  asOfDate: string | null;
  percentScale: PercentScale;
  percentScaleSource: PercentScaleSource;
  /**
   * Sum of `pctToNav` AFTER normalisation — an audit signal; ~100 for a whole
   * book, and the cheapest way to catch a scale or row-boundary regression.
   *
   * Do not treat a small excess as a parse fault. `marketValueLakhs` reconciles
   * to {@link AmcSchemeSheet.totalAumLakhs} to 0.0000% on all 333 portfolio
   * sheets in the four fixtures, while ABSL's percentages sum to as much as
   * 101.7% — because ABSL publishes a `% to AUM` for its
   * "Other Current Assets / (Liabilities)" rows that does not equal
   * `marketValue / AUM` (its security rows match to 5 decimal places). The
   * money column is the trustworthy one; a caller wanting an exact weight
   * should compute `marketValueLakhs / totalAumLakhs` rather than trust the
   * published percentage for non-security lines.
   */
  percentSum: number | null;
  /**
   * The verdict {@link checkPercentSum} reached on {@link percentSum}, and the
   * money-derived weight it was compared against.
   *
   * A `scale-suspect` verdict also appears in {@link anomalies} as prose; this
   * is the machine-readable half, so a caller can branch on it without parsing
   * strings.
   */
  percentSumCheck: PercentSumCheck;
  /**
   * Scheme AUM in lakhs, read off the `GRAND TOTAL` line. A rupee figure, so it
   * is never rescaled by {@link AmcSchemeSheet.percentScale}.
   */
  totalAumLakhs: number | null;
  /** The raw header strings, whitespace-collapsed, as found. */
  headers: string[];
  columns: ColumnMap;
  /** Names of expected columns with no match on this sheet. Visibly absent, not defaulted. */
  missingColumns: string[];
  holdings: AmcHolding[];
  /** Per-sheet problems worth surfacing (unknown unit, scale disagreement, …). */
  anomalies: string[];
}

/**
 * A row of the workbook's `Index` sheet.
 *
 * **Scheme identity is the hard part of this ticket.** No AMFI scheme code
 * appears anywhere in any of the four fixtures — not in the Index sheet, not in
 * a portfolio sheet header, not in a note. What exists is:
 *
 * - `schemeCode` — the AMC's OWN code, and only for SBI (`"007"`) and ABSL
 *   (`"AB001"`). It is namespaced per AMC and is not an industry identifier.
 *   Nippon publishes no code column at all; its portfolio sheets carry an
 *   internal `RLMF001`-style code in cell A1 instead.
 * - `shortCode` — equal to the WORKSHEET NAME in all three multi-scheme
 *   workbooks (`SMEEF`, `BSL95F`, `GF`). This is the only reliable in-file join
 *   key: it is what links an Index row to its portfolio sheet.
 * - `schemeName` — free text, and the only field that could join to AMFI. It is
 *   also the least stable: SBI ships renames inline
 *   (`"SBI Medium to Long Duration Fund (Erstwhile known as SBI Magnum Income
 *   Fund)"`), Nippon appends the full SEBI category sentence, and casing is
 *   inconsistent within a single workbook.
 *
 * So a downstream AMFI join must be name-based and therefore fuzzy, and it
 * should be done ONCE per scheme and persisted — not recomputed per holding.
 * Do not rely on SBI's Index hyperlinks as a join: they are off by one row
 * (`B3`, holding `"SMEEF"`, targets `'Scheme Short code'!A1`).
 */
export interface SchemeIndexEntry {
  /** AMC-internal scheme code, when the workbook publishes one. */
  schemeCode: string | null;
  /** Equals the worksheet name; the in-file join key. */
  shortCode: string | null;
  schemeName: string;
}

/** A parsed AMC disclosure file. */
export interface AmcPortfolioFile {
  format: WorkbookFormat;
  /** Set when the workbook came out of an archive, e.g. ABSL's inner `.xls`. */
  containerEntryName: string | null;
  /** Total worksheets in the workbook, portfolio or not. */
  sheetCount: number;
  /** Rows of the `Index` sheet; empty for single-scheme files that have none. */
  index: SchemeIndexEntry[];
  /** Sheets that carried a holdings table. */
  sheets: AmcSchemeSheet[];
  /** Sheets with no holdings table (the `Index` sheet, disclaimers, notes). */
  nonPortfolioSheets: string[];
  /** File-level problems. */
  anomalies: string[];
}

export interface ParseOptions {
  /**
   * Only parse these sheets (by name). The fixtures are 1.3–4 MB workbooks with
   * 100+ sheets; a caller refreshing one scheme should not pay for all of them.
   */
  onlySheets?: readonly string[];
  /** Cap holdings per sheet. Guards a pathological sheet, off by default. */
  maxHoldingsPerSheet?: number;
}

/* -------------------------------------------------------------------------- */
/* Cell helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A cell reduced to what this parser needs: the value and the number format.
 *
 * Exported only because {@link splitConsolidatedSheet} is — a public function
 * cannot name a private type in its declaration file.
 */
export interface Cell {
  v: unknown;
  /** Number format string (`"#,##0.00%"`). Drives percent-scale detection. */
  z: string | undefined;
}

export type Grid = Cell[][];

/**
 * Finite-number type guard.
 *
 * Mirrors `fo-analytics-logic.ts#finite` rather than the `packages/services`
 * variants, which take a `fallback = 0` — that default is precisely the failure
 * this module is written to avoid.
 */
function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Collapse all whitespace — including the newlines embedded in header cells. */
function normText(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * Coerce a cell to a finite number, or `null`.
 *
 * Numeric columns in these sheets carry `"NIL"`, `"N.A."`, `"-"` and `""` for
 * "nothing here"; strings that ARE numeric (`"1,234.56"`) do appear where a
 * sheet was built by string concatenation. Anything else — and any non-finite
 * result — is `null`, never 0.
 */
function toFiniteOrNull(v: unknown): number | null {
  if (finite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s₹]/g, "");
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Build a grid from worksheet CELL OBJECTS rather than `sheet_to_json`.
 *
 * Two reasons, both load-bearing:
 *   1. We need each cell's number format (`z`) for percent-scale detection, and
 *      `sheet_to_json` discards it.
 *   2. `sheet_to_json` coerces date-formatted cells into `Date`s built in the
 *      runner's LOCAL timezone (trap 7). Reading `.v` under `cellDates:false`
 *      keeps them as Excel serials, which are timezone free.
 */
function buildGrid(ws: XLSX.WorkSheet): Grid {
  const ref = ws["!ref"];
  if (typeof ref !== "string") return [];
  const range = XLSX.utils.decode_range(ref);
  const grid: Grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as
        | { v?: unknown; z?: string }
        | undefined;
      row.push({
        v: cell?.v,
        z: typeof cell?.z === "string" ? cell.z : undefined,
      });
    }
    grid.push(row);
  }
  return grid;
}

/* -------------------------------------------------------------------------- */
/* Header + column mapping                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The three published spellings of one concept.
 *
 * `% to NAV` (HDFC, Nippon) and `% to AUM` (SBI, ABSL) both appear in the
 * fixtures. `% to Net Assets` is the third SEBI-format spelling; it is matched
 * here but was NOT observed in these four files — see the report.
 */
/**
 * The percentage-of-fund column header — MONEY-1405 (D3 step 0).
 *
 * The phrase may be QUALIFIED, by at most two leading words. That bound is the
 * whole rule and it is not arbitrary:
 *
 *   `^%\s*to\s*…`        was the rule, and it is why **360 ONE wrote zero rows**
 *                        for the life of the source. Its header is
 *                        `Rounded % to Net Assets`, so the anchor failed,
 *                        `findHeaderRow` found no percent column, and all 12
 *                        sheets were dropped — reported as `FETCH_FAILED` on a
 *                        283,616-byte file that downloaded and sniffed as OOXML.
 *                        Identical in shape to Tata's `ISIN CODE`, one regex over.
 *   dropping the anchor  would let a PROSE cell match — `All figures are % to
 *                        NAV` is the kind of footnote these workbooks are full
 *                        of, and `findHeaderRow` fixes the header row on the
 *                        first row that matches.
 *   ONE word             admits every qualifier observed (`Rounded`) and
 *                        refuses a sentence. It was TWO, and two IS a sentence:
 *                        `Figures are % to NAV`, `All are % to NAV` and
 *                        `Weights shown % to Net Assets` all matched — one word
 *                        away from the very example named below as the hazard.
 *                        These sheets carry note blocks above the table and
 *                        `findHeaderRow` fixes on the FIRST row with both
 *                        signals, so a prose cell that matches moves the header
 *                        row several rows early.
 *
 * The anchor was never what kept the neighbouring columns out, which is worth
 * saying because it looks load-bearing: `YTM %` and `YTC % ##` are refused by
 * the REQUIRED `to (nav|aum|net assets)` phrase, with or without it.
 */
const PERCENT_HEADER = /^(?:[a-z]+\s+)?%\s*to\s*(nav|aum|net\s*assets)\b/i;

/**
 * Does this header cell name the percentage-of-fund column?
 *
 * Exported because it carries two of the traps at once and both deserve a
 * direct test: the three spellings of one concept (trap 2), and the whitespace
 * collapsing that lets `"% to AUM \non 31JUL26"` match at all (trap 5).
 */
export function isPercentHeader(raw: string): boolean {
  return PERCENT_HEADER.test(normText(raw));
}

/** ISIN shape: 2 letter country code + 9 alnum + 1 check char. */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9A-Z]$/;

/**
 * Does this header cell name the ISIN column? — MONEY-1405 (D3 step 0).
 *
 * WORD-boundary, not exact, and not a bare substring. All three matter:
 *
 *   `/^isin$/`        was the rule, and it is why **Tata wrote zero rows for
 *                     the life of the source**. Tata's header is `ISIN CODE`,
 *                     so `findHeaderRow` never recognised a holdings header,
 *                     `parseSheet` returned null for all 71 sheets, and the
 *                     workbook — 1,762,746 bytes, fetched and parsed
 *                     correctly — produced nothing. Diagnosed by replaying the
 *                     live file 2026-09-13.
 *   `includes("isin")` is the obvious loosening and it is WRONG: `revising`
 *                     and `raising` both contain `isin`, so a prose cell in a
 *                     scheme's objective paragraph could be read as the ISIN
 *                     header and fix the header row 8 rows too early.
 *   `/\bisin\b/`      matches `ISIN`, `ISIN CODE`, `ISIN No.` and not those.
 *
 * Lives here rather than inline because the rule had TWO copies — the sheet
 * gate and the column map — and a fix applied to one of them would have moved
 * Tata from "no sheets" to "sheets with no ISIN", which is worse: rows that
 * look stored and cannot be joined to an instrument.
 */
const ISIN_HEADER = /\bisin\b/i;

function isIsin(v: unknown): v is string {
  return typeof v === "string" && ISIN_RE.test(v.trim());
}

/**
 * Locate the holdings header row by SHAPE, not by sheet name.
 *
 * A holdings header is the row that declares both an `ISIN` column and a
 * `% to …` column. Detecting on shape is what makes the parser survive the
 * non-portfolio sheets (`Index`, disclaimers) without an allow-list, and it is
 * why the `Index` sheet drops out naturally on all three multi-scheme files.
 */
function findHeaderRow(grid: Grid, scanRows = 30): number {
  const limit = Math.min(grid.length, scanRows);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] ?? [];
    let hasIsin = false;
    let hasPercent = false;
    for (const cell of row) {
      const t = normText(cell.v);
      if (ISIN_HEADER.test(t)) hasIsin = true;
      else if (PERCENT_HEADER.test(t)) hasPercent = true;
    }
    if (hasIsin && hasPercent) return r;
  }
  return -1;
}

/**
 * Map header text to fields.
 *
 * The industry/rating column is matched as ONE column containing BOTH words in
 * either order — never by which word comes first (trap 4). Everything else is
 * a substring match on collapsed text, which absorbs `Industry+ /Rating`,
 * `Name Of the Instrument` and `Market value\n(Rs. in Lakhs)` alike.
 */
function mapColumns(headers: string[]): ColumnMap {
  const cols: ColumnMap = {
    instrumentName: null,
    isin: null,
    industryRating: null,
    quantity: null,
    marketValue: null,
    percent: null,
    amcInstrumentCode: null,
  };

  headers.forEach((raw, i) => {
    const h = raw.toLowerCase();
    if (!h) return;

    if (cols.isin === null && ISIN_HEADER.test(h)) cols.isin = i;
    else if (cols.percent === null && PERCENT_HEADER.test(raw))
      cols.percent = i;
    else if (
      // EITHER word, not both — MONEY-1405. The both-words rule was written
      // against three AMCs that print ONE combined column (`Industry^ /
      // Rating`, `Rating / Industry^`), and it silently drops Tata's, which is
      // headed plainly `INDUSTRY`. Requiring both is not what trap 4 is about:
      // trap 4 says the header cannot decide industry-vs-rating and the VALUE
      // must, which `classifyIndustryOrRating` does — so a column named for
      // only one of the two is classified correctly anyway, row by row.
      cols.industryRating === null &&
      // WORD-BOUNDED: `includes("rating")` matches **"operating"**, so an
      // `Operating Expense` column would claim this slot, classify its values
      // as industries, and drop the real `Industry` column — trap 4 through the
      // back door. Same discipline `ISIN_HEADER` applies, for the same reason.
      (/\bindustry\b/.test(h) || /\brating\b/.test(h))
    )
      cols.industryRating = i;
    else if (cols.quantity === null && /\bquantity\b/.test(h))
      cols.quantity = i;
    else if (
      // `MKT VAL(Rs. Lacs)` is Tata's spelling of `Market Value` — MONEY-1405.
      // Both halves are abbreviated, so both halves need the alternative, and
      // both are word-bounded: a bare `includes("val")` would match `Valuation
      // Date` and `Face Value` is already covered by the `value` arm.
      cols.marketValue === null &&
      // A MONEY column carries no percent sign in its name. Without this,
      // `% of Market Value to Net Assets` binds HERE — a percentage written to
      // the money column — and the percent rule above cannot take it first,
      // because that header is `% of …` and the rule requires `% to …`. The
      // unit cross-check cannot catch it either: `totalAumLakhs` is read from
      // the SAME mis-bound column, so the ratio lands near 1 and it passes.
      !h.includes("%") &&
      (h.includes("market") || /\bmkt\b/.test(h)) &&
      (h.includes("value") || h.includes("fair") || /\bval\b/.test(h))
    )
      cols.marketValue = i;
    else if (
      cols.instrumentName === null &&
      h.includes("name") &&
      h.includes("instrument")
    )
      cols.instrumentName = i;
  });

  return cols;
}

const EXPECTED_COLUMNS: ReadonlyArray<keyof ColumnMap> = [
  "instrumentName",
  "isin",
  "industryRating",
  "quantity",
  "marketValue",
  "percent",
];

/**
 * The AMC-internal instrument code column, which has no header.
 *
 * SBI and ABSL print it immediately left of the instrument name (`100012` for
 * ICICI Bank in BOTH — they share a namespace, presumably a common fund
 * accounting platform); Nippon prints its own (`FEBA02`) in column A. There is
 * no header text to match, so it is located positionally — but "one column
 * left of the name" alone is wrong twice over: on Nippon that lands on the ISIN
 * column (name sits at index 2, ISIN at 1), and on HDFC it lands on
 * `Coupon (%)`, which would file a coupon rate as an instrument identifier.
 *
 * So the candidate must be BOTH unclaimed by any mapped column AND headerless,
 * which is what actually distinguishes this column on the three AMCs that
 * publish it. Strictly optional: HDFC has no such column and gets `null`.
 */
function findInstrumentCodeColumn(
  cols: ColumnMap,
  headers: readonly string[],
): number | null {
  if (cols.instrumentName === null) return null;
  const claimed = new Set(
    EXPECTED_COLUMNS.map((k) => cols[k]).filter((i): i is number => i !== null),
  );
  for (let c = cols.instrumentName - 1; c >= 0; c--) {
    if (claimed.has(c)) continue;
    if ((headers[c] ?? "") !== "") continue;
    return c;
  }
  return null;
}

/**
 * The columns a row's instrument name may sit in — MONEY-1405 (Kotak).
 *
 * ## The defect
 *
 * Kotak MERGES its `Name of Instrument` header across columns A:C, and SheetJS
 * reports a merged value only at the range's TOP-LEFT cell. So the header maps
 * to column 0 while every security's name sits in column 2:
 *
 *   header  ["Name of Instrument", "",  "",                    "ISIN Code", …]
 *   row     [null,                 " ", "STATE BANK OF INDIA.", "INE062A01020", …]
 *
 * Column 0 is empty on every holding row, so `parseSheet` rejected all of them
 * as nameless and kept only `Net Current Assets/(Liabilities)`, which really is
 * written in column 0. Measured on the live August-2026 workbook: **119 sheets,
 * 110 holdings, every ISIN null** — one cash line per scheme, out of ~33 real
 * holdings each. A workbook that parsed, wrote rows, and carried nothing.
 *
 * ## Why a SPAN rather than re-seating the column
 *
 * Because it can then only ever ADD a row that was being dropped. The span is
 * consulted left-to-right and the mapped column still wins whenever it holds
 * text, so no row that parses today can change. The quantitative-anchor and
 * aggregate-row guards downstream are unchanged, so a spacer row that gains a
 * name is still not a holding.
 *
 * Bounded to HEADERLESS columns for the same reason `findInstrumentCodeColumn`
 * is: a column the house gave a header to is a column with its own meaning.
 * That single bound is also what keeps the span out of the ISIN and industry
 * columns — every column `mapColumns` claims was claimed BY its header text, so
 * "unheaded" already implies "unclaimed". A second `claimed.has(c)` test was
 * written here and removed: a mutation proved it could not change any answer,
 * and an unreachable guard reads as protection nobody has.
 */
function instrumentNameSpan(
  cols: ColumnMap,
  headers: readonly string[],
): number[] {
  if (cols.instrumentName === null) return [];
  const span = [cols.instrumentName];
  for (let c = cols.instrumentName + 1; c < headers.length; c++) {
    if ((headers[c] ?? "") !== "") break;
    span.push(c);
  }
  return span;
}

/* -------------------------------------------------------------------------- */
/* Percent scale                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether the percent column is 0–100 or 0–1.
 *
 * **The number format wins, and the column sum is only corroboration.** That
 * ordering was measured, not guessed. Across the 330 portfolio sheets in the
 * three multi-scheme fixtures the two signals agree on 305 and the sum is the
 * one that is wrong on the rest:
 *
 *   - SBI `SOF` (an overnight fund) holds 6 instruments summing to 3.55 —
 *     genuinely percent, but a sum-first rule calls it a fraction and inflates
 *     the book 100×.
 *   - ABSL `MIP25`, `BSLMTP`, `BSLCBF` sum into the hundreds of millions,
 *     because of the second-table bug in trap 6.
 *
 * A percent-formatted cell (`z` containing `%`) is unambiguous: Excel stores the
 * fraction and renders `value × 100`. So `%` in the format means `fraction`,
 * full stop. The sum only decides when no cell carries a number format at all,
 * and that fallback is recorded in {@link AmcSchemeSheet.percentScaleSource} so
 * a caller can see which sheets rest on the weaker signal.
 */
export function resolvePercentScale(
  values: readonly number[],
  formats: readonly (string | undefined)[],
): { scale: PercentScale; source: PercentScaleSource } {
  const formatted = formats.filter(
    (f): f is string => typeof f === "string" && f.length > 0,
  );
  if (formatted.length > 0) {
    const pctFormats = formatted.filter((f) => f.includes("%")).length;
    return {
      scale: pctFormats * 2 > formatted.length ? "fraction" : "percent",
      source: "number-format",
    };
  }

  if (values.length > 0) {
    const sum = values.reduce((a, b) => a + b, 0);
    // A whole book sums near 100 (percent) or near 1 (fraction). Only these two
    // tight bands are trusted; anything else falls through to `assumed`.
    if (sum > 50 && sum < 150)
      return { scale: "percent", source: "column-sum" };
    if (sum > 0.5 && sum < 1.5)
      return { scale: "fraction", source: "column-sum" };
  }

  // Neither signal is usable (e.g. an empty scheme). Percent is the SEBI
  // presentation default; the `assumed` source marks it as unverified.
  return { scale: "percent", source: "assumed" };
}

/**
 * Band inside which `percentSum` and the money-derived weight may disagree.
 *
 * MEASURED, not chosen. Across all 333 portfolio sheets in the four committed
 * fixtures the ratio `percentSum / moneyWeightSum` spans **0.99986 → 1.01691**
 * — the top of that range being ABSL's `% to AUM` on its Other Current Assets
 * lines, which genuinely does not equal `marketValue / AUM` (see
 * {@link AmcSchemeSheet.percentSum}). A 100× scale misread lands at 0.01 or
 * 100, so this band leaves ~50× of headroom on both sides: it cannot fire on
 * the published data and cannot miss the failure it exists for.
 */
export const PERCENT_SUM_MIN_RATIO = 0.5;
export const PERCENT_SUM_MAX_RATIO = 2;

export interface PercentSumCheck {
  /**
   * `scale-suspect` means the two independent columns disagree by more than
   * {@link PERCENT_SUM_MIN_RATIO}/{@link PERCENT_SUM_MAX_RATIO}. `uncheckable`
   * means the sheet lacks one of the inputs — never a pass.
   */
  verdict: "ok" | "scale-suspect" | "uncheckable";
  /** `percentSum / moneyWeightSum`. `null` when `uncheckable`. */
  ratio: number | null;
  /**
   * `100 × Σ marketValueLakhs ÷ totalAumLakhs`, over exactly the rows that
   * contributed to `percentSum`. `null` when `uncheckable`.
   */
  moneyWeightSum: number | null;
}

/**
 * Cross-check the percent column against the money column (MONEY-1238).
 *
 * ## Why this had to become a decision
 *
 * `percentSum` was computed on every sheet, documented as "the cheapest way to
 * catch a scale or row-boundary regression" — and then read by nobody:
 * `mf-portfolio-sync` takes `schemeName`, `sheetName` and `holdings` and drops
 * the rest. So the cheapest available check was being paid for and thrown away.
 * A fraction-vs-percent misread puts every `pctToNav` 100× off, `percentSum`
 * reads ~1 where ~100 belongs, and the fund page renders a whole book summing
 * to 1% with no error anywhere in the pipeline.
 *
 * ## Why the MONEY column is the reference and not a second opinion
 *
 * `marketValueLakhs` is a rupee figure, never touched by `percentScale`, and it
 * reconciles to `totalAumLakhs` to 0.0000% on all 333 fixture sheets. It is the
 * one number on the sheet that a percent-scale bug cannot move, which is
 * exactly what a scale check needs. Summed over the SAME rows that fed
 * `percentSum`, so a sheet where only some rows publish a percentage still
 * compares like with like.
 *
 * `uncheckable` is deliberately distinct from `ok`: a sheet with no AUM line
 * has not passed this check, and collapsing the two would be the fail-open
 * shape this repo keeps paying for.
 */
export function checkPercentSum(sheet: {
  readonly percentSum: number | null;
  readonly totalAumLakhs: number | null;
  readonly holdings: ReadonlyArray<{
    readonly pctToNav: number | null;
    readonly marketValueLakhs: number | null;
  }>;
}): PercentSumCheck {
  const uncheckable: PercentSumCheck = {
    verdict: "uncheckable",
    ratio: null,
    moneyWeightSum: null,
  };

  const { percentSum, totalAumLakhs } = sheet;
  if (percentSum === null || !Number.isFinite(percentSum)) return uncheckable;
  if (totalAumLakhs === null || !Number.isFinite(totalAumLakhs)) {
    return uncheckable;
  }
  if (totalAumLakhs <= 0) return uncheckable;

  // THE DENOMINATOR MUST COVER THE NUMERATOR'S ROWS — MONEY-1236.
  //
  // The header promises this ("Summed over the SAME rows that fed
  // `percentSum`") and the code did not deliver it. `percentSum` is accumulated
  // wherever `h.pctToNav !== null` (mf-portfolio-logic.ts:1292) with NO
  // condition on the money column, while this loop additionally skips a row
  // whose `marketValueLakhs` is null or non-finite. Any holding publishing a
  // percentage but no usable rupee figure therefore sat in the numerator and
  // not the denominator, understating `moneyWeightSum` and INFLATING the ratio
  // — a false `scale-suspect` on a healthy sheet, which is the one verdict that
  // makes an operator distrust a whole AMC's data.
  //
  // `percentSum` stays the numerator: it is the value under test, and
  // re-deriving it from `holdings` here would make this function unable to see
  // the misread it exists to catch.
  //
  // The band is 0.5–2.0, so flipping a verdict needs HALF the money missing —
  // and at that point the two sides describe different populations and the
  // honest answer is `uncheckable`, not a comparison dressed up as one.
  // `uncheckable` is deliberately distinct from `ok` for exactly this reason.
  let money = 0;
  let comparableRows = 0;
  let percentRows = 0;
  for (const h of sheet.holdings) {
    if (h.pctToNav === null || !Number.isFinite(h.pctToNav)) continue;
    percentRows++;
    if (h.marketValueLakhs === null || !Number.isFinite(h.marketValueLakhs)) {
      continue;
    }
    money += h.marketValueLakhs;
    comparableRows++;
  }
  if (comparableRows === 0) return uncheckable;
  // A remnant is not the sheet.
  if (comparableRows * 2 < percentRows) return uncheckable;

  const moneyWeightSum = (money / totalAumLakhs) * 100;
  // A zero or negative money weight cannot anchor a ratio — that is an absent
  // reference, not a disagreement, and must not be reported as one.
  if (!Number.isFinite(moneyWeightSum) || moneyWeightSum <= 0) {
    return uncheckable;
  }

  const ratio = percentSum / moneyWeightSum;
  const ok = ratio >= PERCENT_SUM_MIN_RATIO && ratio <= PERCENT_SUM_MAX_RATIO;
  return {
    verdict: ok ? "ok" : "scale-suspect",
    ratio,
    moneyWeightSum,
  };
}

/* -------------------------------------------------------------------------- */
/* Industry vs rating                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Credit ratings as they actually appear in the fixtures.
 *
 * Observed forms include `CRISIL AAA`, `ICRA AA+`, `[ICRA]AA+`, `CARE A(CE)`,
 * `IND AAA(SO)`, `CRISIL A1+`, `CRISIL AAA(CE)`, `SOVEREIGN` and `Sovereign`.
 * The agency-prefix branch carries most of the load; the bare-grade branch
 * catches unprefixed grades without swallowing industries, since no NSE industry
 * name is shaped like `AA+` or `A1+`.
 */
/**
 * A credit rating ends in its GRADE — `CRISIL AAA`, `ICRA AA+`, `[ICRA]A1+`,
 * `CARE A(CE)`, `IND AAA(SO)`, `ICRA D`.
 *
 * Detecting the grade rather than the agency name is deliberate, and it is a
 * bug fix rather than a preference. Matching agencies caught `\bcare\b` inside
 * `Health Care Equipment`, `Personal Care Products`, `Managed Health Care` and
 * two more — five real NSE industries filed as credit ratings, which is exactly
 * the industry/rating swap this module exists to prevent, arriving through the
 * back door.
 *
 * Deliberately CASE-SENSITIVE: grades are upper-case, so `Care` cannot be read
 * as the grade `C`.
 */
const RATING_TAIL =
  /(?:^|[\s\])])(?:AAA|AA|A[1-4]|A|BBB|BB|B|C|D)\s*[+-]?\s*(?:\((?:CE|SO)\))?$/;
const SOVEREIGN = /^sovereign$/i;
const UNRATED = /^(unrated|not\s*rated|nr)$/i;

/**
 * Classify the single combined column for ONE row (trap 4).
 *
 * The header cannot decide this — it names both concepts on every AMC, in
 * whichever order that AMC prefers. The VALUE decides: `"Banks"` is an industry
 * on SBI's `Rating / Industry^` sheet exactly as it is on ABSL's
 * `Industry^ / Rating` sheet.
 */
export function classifyIndustryOrRating(value: string): {
  industry: string | null;
  rating: string | null;
} {
  const v = value.trim();
  if (!v) return { industry: null, rating: null };

  if (SOVEREIGN.test(v) || UNRATED.test(v))
    return { industry: null, rating: v };
  if (RATING_TAIL.test(v)) return { industry: null, rating: v };

  return { industry: v, rating: null };
}

/* -------------------------------------------------------------------------- */
/* Row scanning                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The SEBI-standard last line of a portfolio table: `GRAND TOTAL`,
 * `GRAND TOTAL (AUM)`. Its market value IS the scheme's AUM in lakhs.
 */
const GRAND_TOTAL = /^grand\s*total\b/i;

/**
 * Aggregate rows — `Total`, `Subtotal`, `Sub Total`, `Derivatives Total`.
 *
 * These carry a real value and a real percentage, which is exactly why they are
 * dangerous: they are indistinguishable from a holding by shape, and summing
 * them alongside the lines they aggregate double-counts the entire book. Before
 * this filter every sheet summed to ~300% — holdings, plus per-section
 * subtotals, plus the grand total.
 */
const AGGREGATE_ROW = /^(sub\s*-?\s*total|total)\b|\btotal$/i;

/**
 * Does this row end the holdings table? (trap 6)
 *
 * Three terminators, all observed:
 *   - `GRAND TOTAL`, the portfolio's own last line. Everything below it is an
 *     annexure: SBI prints interest-rate-swap counterparties whose column 7 is a
 *     NOTIONAL (25,000), and Nippon prints futures positions. Both parse as
 *     perfectly good percentages.
 *   - a `Notes:` / `Additional notes` block, which every AMC prints eventually;
 *   - a row that RE-DECLARES a header (a cell that OPENS with `ISIN`), which is
 *     how ABSL's "securities in default" table starts. MONEY-1407 widened this
 *     from `/^isin$/` to `/^isin\b/`: UTI heads the same annexure `ISIN NO`,
 *     and its five columns do not line up with the holdings table's, so the
 *     `Total Amt Due#` of a security that defaulted in 2019 landed in the
 *     `% to NAV` column — 9,991.55% of NAV for one row, and three of its 85
 *     schemes summing to 11,816%, 2,598% and 1,824%. It cannot swallow the
 *     sheet's OWN header (`parseSheet` starts BELOW it) and no instrument is
 *     named after the word.
 *
 * Stopping here rather than at EOF is what keeps a rupee amount from a foreign
 * table out of the `% to NAV` column.
 */
function isTableTerminator(row: readonly Cell[]): boolean {
  for (const cell of row) {
    const t = normText(cell.v);
    if (!t) continue;
    if (GRAND_TOTAL.test(t)) return true;
    if (/^(notes?|additional notes)\s*:?$/i.test(t)) return true;
    if (/^isin\b/i.test(t)) return true;
  }
  return false;
}

/** Is this an aggregate line rather than an instrument? */
function isAggregateRow(name: string): boolean {
  return AGGREGATE_ROW.test(name.trim());
}

/** The name, ISIN and quantity a row carries — the three the section test needs. */
function rowShape(
  row: readonly Cell[],
  cols: ColumnMap,
  nameSpan: readonly number[],
): { name: string; hasIsin: boolean; hasQty: boolean } {
  let name = "";
  for (const c of nameSpan) {
    const t = normText(row[c]?.v);
    if (t) {
      name = t;
      break;
    }
  }
  const hasIsin = cols.isin !== null && isIsin(row[cols.isin]?.v);
  const hasQty =
    cols.quantity !== null && toFiniteOrNull(row[cols.quantity]?.v) !== null;
  return { name, hasIsin, hasQty };
}

/**
 * Does this row HEAD a section rather than state a holding? — MONEY-1405.
 *
 * ## The defect
 *
 * `sectionLabel` recognises a section by "text and no numbers", which is right
 * for every house this module was written against. ICICI Prudential prints the
 * section's SUBTOTAL on the heading line itself:
 *
 *   "Equity & Equity Related Instruments"           4,449,933.29   99.978%
 *   "Listed / Awaiting Listing On Stock Exchanges"  4,449,933.29   99.978%
 *   "HDFC Bank Ltd."   INE040A01034   Banks   61,837,112   438,425.12   9.85%
 *
 * so both headings carry numbers, both were stored as holdings, and every one
 * of its 147 per-scheme sheets summed to ~300% of NAV — the exact defect
 * `AGGREGATE_ROW` was written for, except that ICICI never writes the word
 * "Total". Two phantom rows per section, each ~100% by weight.
 *
 * ## Why STRUCTURE and not a vocabulary of section names
 *
 * Because the vocabulary is neither closed nor safe. Measured across the 147
 * August-2026 files there are ~20 distinct heading strings ("Government
 * Securities", "Zero Coupon Bonds / Deep Discount Bonds", "Privately
 * Placed/Unlisted", "Equity shares", …) and they sit beside genuinely ISIN-less
 * HOLDINGS that look identical in shape — `TREPS` (147 sheets), `Net Current
 * Assets` (147), `Cash Margin - Derivatives` (40) and the individual
 * `Interest Rate Swaps- MD -<date>` legs. A list that missed a heading would
 * double-count; one that over-matched would DELETE a real cash position. Both
 * are silent.
 *
 * What actually distinguishes the two is position: **a heading precedes its
 * contents.** So the test looks forward past any further headings and asks
 * whether the next row that names something carries an ISIN. It is deliberately
 * conservative in the one direction that matters — a row whose successors have
 * no ISIN stays a holding, so a cash line is never deleted; the cost of missing
 * a heading is a visible ~200% `percentSum`, which `checkPercentSum` already
 * reports.
 */
function headsItsOwnSection(
  grid: Grid,
  from: number,
  cols: ColumnMap,
  nameSpan: readonly number[],
): boolean {
  for (let r = from + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (isTableTerminator(row)) return false;
    const { name, hasIsin, hasQty } = rowShape(row, cols, nameSpan);
    if (!name) continue;
    // A `Total` CLOSES the section it follows, so the candidate belonged to
    // that section and is a holding. Without this, Nippon's `Triparty Repo`
    // (36.12% of one interval fund) looked past its own `Total` and its
    // section's `Mutual Fund Units` heading to an ISIN two rows further on, and
    // a real cash position was deleted — measured, 102 rows across the fixture.
    if (isAggregateRow(name)) return false;
    // An ISIN or a quantity makes the next row a HOLDING, so this one opened
    // the section it sits in. A quantity alone is enough: ICICI's gold and
    // silver ETFs hold a commodity, which has no ISIN anywhere on the sheet, so
    // an ISIN-only test can never fire there and the `Gold` heading (98.2% of
    // NAV) was stored as a second copy of the bar it heads.
    if (hasIsin || hasQty) return true;
    // Another heading-shaped row — keep looking past it. ICICI nests
    // "Listed / Awaiting Listing" inside "Equity & Equity Related".
  }
  return false;
}

/**
 * The SECOND test: a heading whose subtotal IS the block beneath it — MONEY-1409.
 *
 * ## The one shape `headsItsOwnSection` cannot decide
 *
 * That rule asks whether the next row that names something carries an ISIN or a
 * quantity, and ICICI Prudential prints two sections where no child carries
 * either. Its Overnight Fund (July 2026, `OVERNITE`):
 *
 *   "Reverse Repo"                1,029,928.00   0.78355…
 *   "Reverse Repo (8/3/2026)"       944,966.09   0.71891…
 *   "Reverse Repo (8/3/2026)"        84,961.91   0.06464…
 *
 * Three rows, no ISIN and no quantity anywhere, and the first is the SUM of the
 * other two — exactly, to the paisa, in the money column and in the percent
 * column. The forward walk therefore looks past both children, past `TREPS` and
 * `Net Current Assets`, reaches `Total Net Assets` and returns false; all three
 * rows stored and the sheet summed to 178% of NAV.
 *
 * The same shape carries `INTEREST RATE SWAPS (At Notional Value)` on fourteen
 * of the 146 sheets — 147,500 against eighteen legs that sum to exactly
 * 147,500 on the Corporate Bond Fund.
 *
 * ## Why this is the fallback rather than a widening
 *
 * `headsItsOwnSection` errs in the one direction that cannot delete data — an
 * unrecognised heading costs a visible `percentSum` over 100, which
 * `checkPercentSum` already reports, while an over-matching rule DELETES a real
 * cash position (TREPS, `Net Current Assets`, a repo leg) with nothing left to
 * show for it. So this runs only where that rule declined.
 *
 * ## The sum must EXHAUST the block, never merely a prefix of it
 *
 * This is the whole difference between a rule that works and one that deletes
 * real holdings, and it was measured rather than reasoned: a first version
 * tested the RUNNING total after every row and dropped **16 genuine swap legs**
 * across five ICICI sheets, because the legs are round numbers and
 * `10,000 = 5,000 + 5,000` is a prefix hit two rows later. Nothing about that
 * row is a heading; the arithmetic simply collided.
 *
 * A heading's section is the CONTIGUOUS block directly beneath it — ICICI
 * separates every section with a blank row — so the block is what must add up.
 * `10,000` against the remaining seventeen legs (137,500) does not, while
 * `147,500` against all eighteen does. Every child must carry a money value for
 * the same reason: a subtotal of rows that state no amount is not a subtotal.
 *
 * ## The stops are the same stops, and that is load-bearing
 *
 * `isTableTerminator` and `isAggregateRow` are repeated here verbatim from the
 * walk above, not relaxed. An intermediate version of MONEY-1405 looked past
 * its own `Total` and deleted **102 real Nippon cash rows** (`Triparty Repo`,
 * 36.12% of one interval fund). `nameSpan` is threaded through for the same
 * reason: the name `isAggregateRow` judges here must be the name the other walk
 * judges, and `rowShape` is where that rule lives.
 */
function headsItsOwnSectionBySum(
  grid: Grid,
  from: number,
  cols: ColumnMap,
  nameSpan: readonly number[],
): boolean {
  if (cols.marketValue === null) return false;
  // A heading with no money on it states no subtotal, so there is nothing to
  // compare against. A heading of ZERO needs no clause of its own and had one
  // for a draft: `|0 - sum| / |0|` is NaN or Infinity, and both answer the
  // `< 0.005` test with `false`, so the row is kept either way. It was removed
  // rather than kept-and-untested — a guard no mutation can turn red is a
  // claim, not a check.
  const heading = toFiniteOrNull(grid[from]?.[cols.marketValue]?.v);
  if (heading === null) return false;

  let sum = 0;
  let summed = 0;
  for (let r = from + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (isTableTerminator(row)) break;
    const { name } = rowShape(row, cols, nameSpan);
    // A nameless row ENDS the block rather than being skipped past — see the
    // prefix note above. This is the only place in this file where a blank row
    // means something, and it means it only for a rule that is already the
    // fallback of a fallback.
    if (!name) break;
    if (isAggregateRow(name)) break;
    const mv = toFiniteOrNull(row[cols.marketValue]?.v);
    if (mv === null) return false;
    sum += mv;
    summed++;
  }

  // TWO rows at least. A block of one equal to the heading is indistinguishable
  // from a value printed twice, and dropping the first copy of a lone cash line
  // is the deletion this rule must never make.
  return summed >= 2 && Math.abs(heading - sum) / Math.abs(heading) < 0.005;
}

/**
 * SEBI section headings, e.g. `"Equity & Equity related"`, `"DEBT INSTRUMENTS"`,
 * `"MONEY MARKET INSTRUMENTS"`, `"Government Securities"`.
 *
 * A section row has text but no ISIN and no numbers. Tracking it lets a holding
 * carry its asset class without a second lookup.
 */
function sectionLabel(row: readonly Cell[], cols: ColumnMap): string | null {
  if (cols.isin !== null && isIsin(row[cols.isin]?.v)) return null;
  let label: string | null = null;
  for (const cell of row) {
    const t = normText(cell.v);
    if (!t) continue;
    if (finite(cell.v)) return null;
    if (label === null) label = t;
  }
  return label;
}

/* -------------------------------------------------------------------------- */
/* Scheme metadata                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `as on` / `as at` / `as of` — MONEY-1405, third spelling MONEY-1407.
 *
 * `portfolio as on` needs no branch of its own: it CONTAINS `as on`. `as at`
 * does not, and a label this test misses is not a soft failure any more — the
 * sync now REFUSES a sheet whose as-on it cannot read (`NO_AS_ON`), so a
 * too-narrow label turns a healthy AMC into a refused one.
 *
 * `as of` is UTI's, and only the STRICT cue gains it. Its consolidated sheet
 * heads every one of its 85 scheme blocks `PROVISIONAL AND UNAUDITED PORTFOLIO
 * DISCLOSURE AS OF 31/08/2026`, which `DATE_NUMERIC_DMY` reads perfectly — so
 * the whole house was one word away from `NO_AS_ON` on every sheet. It stays
 * out of `AS_ON_LABEL` because that cue also feeds the bare-MONTH pass and the
 * scheme-name SKIP, and `as of` reads naturally in prose where `as on` does
 * not; a precise date follows this one, which is what makes the strict cue the
 * right home for it.
 */
/**
 * The cue that a cell states the statement's period.
 *
 * TWO cues, and they do NOT carry the same authority — MONEY-1405.
 *
 * `AS_ON_STRICT` is the phrase a workbook uses when it is naming the as-on
 * date: `as on`, `as at`. `AS_ON_LABEL` adds `for`, which Zerodha needs
 * (`MONTHLY PORTFOLIO STATEMENT OF <scheme> FOR AUGUST 2026`) and which is the
 * loosest word in this file.
 *
 * The split exists because admitting `for` to the PRECISE pass reads a date out
 * of the wrong sentence. Both of these are real shapes, and both were wrong
 * before the split:
 *
 *   "This statement has been prepared for the period ended 31-Mar-2026"
 *   "Fund open for subscription since 01-Apr-2013"
 *
 * sitting ABOVE `Portfolio as on 31-Aug-2026` returned 2026-03-31 and
 * 2013-04-01 respectively — the scan is row-major, so the first cue wins, and a
 * `for` in prose is common where `as on` is not. The gate then refuses a
 * perfectly good sheet as `STALE_FILE`, whose documented meaning sends an
 * operator to the SCHEDULE or the URL: the wrong-subsystem mislabel this file
 * exists to end.
 *
 * So a PRECISE date may be taken only from a strict cue, and `for` earns only a
 * MONTH — which is all Zerodha states anyway. A `for`-cued sentence carrying a
 * hyphenated date (`31-Mar-2026`) now matches nothing, because
 * `parseMonthPeriod` requires whitespace between the month and the year.
 */
const AS_ON_STRICT = /\bas\s*(?:on|at|of)\b/i;
const AS_ON_LABEL = /\bas\s*(?:on|at)\b|\bfor\b/i;

/**
 * `31-Jul-2026` (HDFC), `31st October 2025`, `30th April 2026` — MONEY-1405.
 *
 * The ordinal suffix is OPTIONAL and the separator is required either way, so
 * `31-Jul-2026` parses exactly as before. Without the suffix branch
 * `31st October 2025` matched NOTHING: `\d{1,2}` takes `31`, the separator
 * class then meets `s` and the whole match fails — a silent null on a real
 * published spelling.
 */
const DATE_DMY =
  /\b(\d{1,2})(?:st|nd|rd|th)?[-/\s]+([A-Za-z]{3,9})[-/\s,]+(\d{4})\b/i;
/** `July 31, 2026` / `July 31,2026` (ABSL, Nippon). */
const DATE_MDY = /\b([A-Za-z]{3,9})\s+(\d{1,2})\s*,?\s*(\d{4})\b/;
/**
 * All-numeric `31/07/2026`, `31-07-2026`, `31.07.2026` — MONEY-1405.
 *
 * DAY FIRST, because these are Indian filings — but not blindly: a component
 * above 12 cannot be a month, so the two are swapped when the evidence says so
 * and the Indian convention decides only the genuinely ambiguous `07/03/2026`.
 * Guessing the other way round would move an as-on date by MONTHS, which after
 * this ticket means refusing a current file as `STALE_FILE`.
 */
const DATE_NUMERIC_DMY = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/;
/**
 * All-numeric with a TWO-DIGIT year — `31-08-26` (Tata) — MONEY-1405.
 *
 * Tried LAST, after the four-digit form, and it cannot steal from it: against
 * `31-08-2026` the year group `(\d{2})\b` finds no word boundary inside `2026`,
 * and the four-digit branch returns before this one is reached anyway.
 *
 * The century is pivoted to 2000 unconditionally rather than by a window. These
 * are SEBI monthly portfolio disclosures: the regime began in the 2000s, the
 * deepest archive any resolver in this repo reaches is Tata's 2013, and a
 * disclosure dated 19xx does not exist. A pivot window would be a guess dressed
 * as rigour — and it would guess WRONG first in 2050, silently, on a file whose
 * date is the one thing the staleness gate trusts.
 *
 * The day/month disambiguation is shared with the four-digit form, so
 * `31-08-26` reads day-first exactly as `31-08-2026` does.
 */
const DATE_NUMERIC_DMY_SHORT = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/;

/**
 * A statement period stated as a MONTH, with no day — MONEY-1405 (D3 step 0).
 *
 * Zerodha's sheets carry no as-on date at all. What they carry, in row 2, is
 *
 *     MONTHLY PORTFOLIO STATEMENT OF ZERODHA ARBITRAGE FUND FOR AUGUST 2026
 *
 * — the period, unambiguously, with a different preposition and no day. That is
 * why `MONTH_YEAR_PERIOD` exists and why `AS_ON_LABEL` now admits `for`.
 *
 * ## Why a day may be supplied here, when this file refuses to fabricate one
 *
 * `asOfDate` has exactly two consumers, and neither reads the day:
 * `judgeSheetWrite` compares `sheet.asOfDate.slice(0, 7)` against the requested
 * month, and a `logger.warn` prints it. It is NEVER persisted — the row's
 * `period` comes from the REQUEST, not from the file. So the day here cannot
 * reach a database, a join key or a user.
 *
 * The month end is also what a SEBI monthly portfolio disclosure MEANS, which
 * the other twelve houses confirm by stating it outright: every one of them
 * reads 2026-08-31 for this month. Using a real month end rather than `01`
 * keeps the logged value honest against its siblings instead of introducing a
 * date that looks like a different claim.
 *
 * Read by `parseMonthPeriod`, which `extractAsOnDate` only reaches after a
 * full PRECISE pass over every scanned row has come back empty — so a sheet
 * carrying both keeps the precise date wherever it sits. Within-cell ordering
 * could not have given that guarantee; the title usually comes first.
 *
 * EVERY SPELLING IS WRITTEN OUT, rather than a three-letter prefix plus
 * `[a-z]*`. The prefix form is shorter and it is WRONG here: it matches any
 * word that merely STARTS with a month abbreviation, so `for marketing 2026`
 * reads as March, `for Junk 2026` as June and `for septembers 2026` as
 * September. That matters because the cue this pattern sits behind is `for` —
 * the loosest word in `AS_ON_LABEL` — and these sheets are full of prose. A
 * false month here is not a parse failure anyone would see: it produces a
 * confident wrong period, and the sheet gate then refuses a perfectly good
 * month as `STALE_FILE`.
 *
 * `sep|sept|september` is spelled with both short forms because AMFI houses
 * genuinely publish both (Zerodha ships `Sep` and `Sept` for the same month,
 * which is also why `pickLinkForMonth` refuses an ambiguous pair).
 */
const MONTH_YEAR_PERIOD =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{4})\b/i;

/** Last day of a 1-indexed month — `Date.UTC(y, m, 0)` is the previous day. */
function monthEndDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Excel serial → `YYYY-MM-DD`, with no `Date` anywhere.
 *
 * Excel's epoch is 1899-12-30 (the 1900 leap-year bug is baked into the
 * numbering). Doing the arithmetic on integers keeps the result independent of
 * the runner's timezone — the whole point of trap 7. Serial 46234 → 2026-07-31
 * in IST, UTC, or anywhere else.
 */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465)
    return null;
  const days = Math.floor(serial);
  // 25569 = days between 1899-12-30 and 1970-01-01.
  const ms = (days - 25569) * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y)) return null;
  return `${y}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Parse an as-of date from a cell, in any of the four published encodings.
 *
 * A `Date` instance is accepted defensively (a caller may hand us a grid built
 * with `cellDates:true`) and read via its UTC components, which is how SheetJS
 * constructs them in that mode.
 */
export function parseAsOfDate(value: unknown): string | null {
  if (finite(value)) return excelSerialToIsoDate(value);
  if (value instanceof Date) {
    const t = value.getTime();
    if (!Number.isFinite(t)) return null;
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  if (typeof value !== "string") return null;

  const text = value.replace(/\s+/g, " ").trim();

  const dmy = DATE_DMY.exec(text);
  if (dmy) {
    const month = MONTHS[dmy[2]!.slice(0, 3).toLowerCase()];
    const day = Number(dmy[1]);
    if (month && day >= 1 && day <= 31)
      return `${dmy[3]}-${pad2(month)}-${pad2(day)}`;
  }

  const mdy = DATE_MDY.exec(text);
  if (mdy) {
    const month = MONTHS[mdy[1]!.slice(0, 3).toLowerCase()];
    const day = Number(mdy[2]);
    if (month && day >= 1 && day <= 31)
      return `${mdy[3]}-${pad2(month)}-${pad2(day)}`;
  }

  // All-numeric, LAST — a month NAME is unambiguous and must win, and this
  // pattern cannot match a spelling the two above already handle (both require
  // letters where this requires digits).
  const num = DATE_NUMERIC_DMY.exec(text);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    // Day-first unless the numbers refuse it. `31/07` can only be D/M; `07/31`
    // can only be M/D; `07/03` is genuinely ambiguous and takes the Indian
    // reading, which is what every filer in this pipeline writes.
    const [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return `${num[3]}-${pad2(month)}-${pad2(day)}`;
  }

  // Two-digit year, LAST of all — see DATE_NUMERIC_DMY_SHORT.
  const short = DATE_NUMERIC_DMY_SHORT.exec(text);
  if (short) {
    const a = Number(short[1]);
    const b = Number(short[2]);
    const [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return `${2000 + Number(short[3])}-${pad2(month)}-${pad2(day)}`;
  }

  return null;
}

/**
 * A period stated as a MONTH, with no day — MONEY-1405.
 *
 * Deliberately NOT a branch inside {@link parseAsOfDate}. That function's
 * contract is "a date this cell states precisely", and several callers depend
 * on it; folding a month-only reading in would make its answer mean two
 * different things with nothing to tell them apart. Keeping it separate is what
 * lets {@link extractAsOnDate} run a PRECISE pass over every row before it will
 * accept a month-only one — which is the precedence that matters, and which a
 * within-cell ordering could not have produced.
 */
export function parseMonthPeriod(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = MONTH_YEAR_PERIOD.exec(value.replace(/\s+/g, " ").trim());
  if (!m) return null;
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  const year = Number(m[2]);
  if (!month || year < 1990 || year > 2100) return null;
  return `${year}-${pad2(month)}-${pad2(monthEndDay(year, month))}`;
}

/**
 * Pull the as-on date out of the rows above the holdings table — MONEY-1405.
 *
 * Two layouts: the date is inline in a prose cell (`"Portfolio as on
 * 31-Jul-2026"`), or it is a value in the cell to the RIGHT of a label cell
 * (`"PORTFOLIO STATEMENT AS ON :"` | `46234`) — SBI does the latter, and that
 * value is the timezone-sensitive serial.
 *
 * ## Why this is now EXPORTED, and why it is worth a refusal
 *
 * **A 200 is not freshness, and two live sources prove it.** Axis's undated
 * `IN_MF_MONTHLY_PORTFOLIO_AXISMF.xls` answers 200 with a real 840 KB workbook
 * whose 59 sheets all read "as on January 31, 2022"; KFintech's per-scheme
 * `SchemePortfolio/{amc}/MONTHLY/{scheme}.xlsx` is unauthenticated, serves full
 * holdings, and is a DEAD STORE — one frozen file per scheme, sampled across
 * Sep-2021, Jun-2024 and Aug-2025. Both pass every check this job made before
 * this ticket: the fetch succeeds, the bytes are a workbook, the parse yields
 * sheets, the holdings are real. The ONLY thing that separates them from a
 * current file is the date printed on them, so the sync has to read it and
 * refuse on it (`STALE_FILE` / `NO_AS_ON` in `mf-portfolio-sync-logic.ts`).
 *
 * ## Returns a `YYYY-MM-DD` STRING, not a `Date`
 *
 * Deliberately, and it is trap 7 of the module header: a `Date` is built in the
 * runner's timezone, which turns SBI's serial 46234 into `2026-07-30T18:30:00Z`
 * under IST — the month-end date off by one, only east of UTC. The caller's
 * question is "is this the month I asked for", which `slice(0, 7)` answers on a
 * string with no timezone anywhere in it.
 *
 * @param rows Raw cell VALUES, row-major. Excel serials must arrive as numbers
 *   (a grid built with `cellDates:false`); a `Date` is accepted defensively and
 *   read via its UTC components. ANY finite number here is taken as a serial —
 *   the range is the range of a rupee figure — so a caller holding the cells'
 *   number formats must screen them first. `findAsOfDate` does, via
 *   {@link dateReadableValue}; that is where the production guard lives, and
 *   this function keeps the loose contract because a caller with no formats
 *   (a test, a CSV) has nothing to screen with.
 * @param scanRows How far down to look. The label sits above the holdings
 *   header, so a caller that knows where that is passes it.
 */
export function extractAsOnDate(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  scanRows = 15,
): string | null {
  const limit = Math.min(rows.length, Math.max(0, scanRows));

  /** One pass over the scanned rows with one reader and one cue. */
  const scan = (
    read: (v: unknown) => string | null,
    cue: RegExp,
  ): string | null => {
    for (let r = 0; r < limit; r++) {
      const row = rows[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        const t = normText(row[c]);
        if (!t || !cue.test(t)) continue;

        const inline = read(t);
        if (inline) return inline;

        for (let k = c + 1; k < Math.min(c + 5, row.length); k++) {
          const next = row[k];
          if (next === undefined || next === null || next === "") continue;
          const parsed = read(next);
          if (parsed) return parsed;
        }
      }
    }
    return null;
  };

  // TWO PASSES, and the order is the point — MONEY-1405.
  //
  // A single pass returns whichever cue appears FIRST, which is a statement
  // about row order and not about precision. That is a real hazard here rather
  // than a tidiness point: these workbooks routinely name the PUBLICATION month
  // in a title and the DATA month in the as-on line, and they differ (Tata's
  // own notes record `2026-08` in the path against July in the filename). A
  // title-first read would hand the gate the publication month and have it
  // refuse a perfectly good sheet as STALE_FILE.
  //
  // So every row is asked for a precise date before any row is allowed to
  // answer with a bare month.
  // THREE ORDERED PASSES. The order is the whole design:
  //
  //   1. a strict cue and a PRECISE date   — what almost every house states
  //   2. a strict cue and a bare MONTH     — an `as on August 2026` variant
  //   3. the loose `for` cue, MONTH only   — Zerodha, and nothing else
  //
  // Pass 1 is strict-cue-only because a `for` in prose is common where `as on`
  // is not, and a row-major scan takes the first cue it meets: an inception or
  // period-ended sentence above the real as-on line would otherwise win and
  // hand the gate a date from the wrong sentence.
  //
  // Pass 3 cannot make that mistake, because `parseMonthPeriod` reads only a
  // month NAME beside a four-digit year — never a `31-Mar-2026`.
  return (
    scan(parseAsOfDate, AS_ON_STRICT) ??
    scan(parseMonthPeriod, AS_ON_STRICT) ??
    scan(parseMonthPeriod, AS_ON_LABEL)
  );
}

/**
 * Is this cell's number format a DATE format? — MONEY-1408.
 *
 * SheetJS's own answer, which is the only one worth having: it walks the format
 * string, skips quoted literals and `\`-escapes and the `[$-409]` locale
 * prefix, and asks whether any date token survives. A hand-rolled `/[dmy]/`
 * test says yes to `0.00" days"` and to `#,##0.00` (the `m` in nothing) and no
 * to `[$-409]d\-mmm\-yy;@`.
 *
 * `SSF` is typed `any` in `xlsx`'s own `.d.ts`, so it is narrowed here once
 * rather than at the call site.
 */
function isDateNumberFormat(z: string): boolean {
  return (XLSX.SSF as { is_date(fmt: string): boolean }).is_date(z);
}

/**
 * A cell as {@link extractAsOnDate} is allowed to read it — MONEY-1408.
 *
 * **A NUMBER survives only if its own format says it is a date.** Everything
 * else passes through: strings are parsed by pattern, and a `Date` cannot be
 * mistaken for money.
 *
 * `parseAsOfDate` accepts any finite number in 1 … 2,958,465 as an Excel
 * serial, which is the whole plausible range of a rupee figure: `45678.9` reads
 * as 2025-01-21 and `12345` as 1933-10-18. The sibling-cell scan then looks up
 * to four cells to the RIGHT of any as-on cue, so
 * `["TOTAL NET ASSETS AS ON MONTH END", "", 45678.90]` dated a sheet from its
 * own AUM. Measured on the committed fixtures, rows 0-29 alone hold 11,032
 * currency-formatted numbers inside the serial range (SBI 4,633, Nippon 6,338,
 * HDFC 61) against 121 genuinely date-formatted ones.
 *
 * That was a loose heuristic when `asOfDate` was a log line. It is not one now:
 * `judgeSheetWrite` compares its month against the requested one and refuses
 * the WHOLE SHEET as `STALE_FILE` on a mismatch, so one currency cell beside
 * one cue costs a scheme its month.
 *
 * `buildGrid` exists to keep `z` — this is the one signal that separates a
 * date-formatted cell from a currency-formatted one, and the old code mapped it
 * away one line before it was needed.
 *
 * A missing `z` is NOT a date, and NEITHER IS `"General"` — which is the half
 * this note used to leave out, and the operative one. Re-measured across the
 * three readable committed workbooks (2026-09-14): **52,405** numeric cells,
 * of which **zero** lack a `z` under `cellNF: true` — so the original claim
 * holds, it was just counted over a narrower population than "12,107" implies
 * — but **979** carry `z === "General"`, and `SSF.is_date("General")` is
 * FALSE. So the rule refuses a real date in any cell the publisher never
 * formatted, not merely in cells with no format at all.
 *
 * That is the right trade and it is deliberately fail-CLOSED: `judgeSheetWrite`
 * refuses a WHOLE SHEET as `STALE_FILE` on a month mismatch, so admitting one
 * currency cell costs a scheme its month while refusing one unformatted date
 * cell costs nothing as long as some other cell on the sheet carries the date
 * — which is what the 333 committed portfolio sheets show. Stated here so the
 * cost is visible rather than implied by a number that never covered it.
 */
function dateReadableValue(cell: Cell): unknown {
  if (typeof cell.v !== "number") return cell.v;
  return cell.z !== undefined && isDateNumberFormat(cell.z)
    ? cell.v
    : undefined;
}

/**
 * Grid adapter for {@link extractAsOnDate} — ONE implementation, two callers.
 *
 * The window is the caller's, not a second default: the holdings header can sit
 * below row 15 (`findHeaderRow` scans 30), and capping here would lose the date
 * on exactly those sheets.
 */
function findAsOfDate(grid: Grid, headerRow: number): string | null {
  const limit = headerRow >= 0 ? headerRow : Math.min(grid.length, 12);
  return extractAsOnDate(
    grid.slice(0, limit).map((row) => row.map(dateReadableValue)),
    limit,
  );
}

/**
 * Scheme name and AMC-internal code from the rows above the holdings header.
 *
 * Each AMC puts them somewhere different — SBI labels the name
 * (`"SCHEME NAME :"` | value) and prints the code loose in row 1; ABSL and
 * Nippon put the short code in A1 with the name beside it; HDFC merges the name
 * across the whole first row.
 *
 * The rule is "labelled value, else the longest text in the FIRST row that has
 * any" — deliberately first-row rather than longest-overall. ABSL prints the
 * scheme's SEBI category sentence ("An open ended hybrid scheme investing
 * predominantly in equity...") on the row below the name, and it is longer, so a
 * longest-overall rule names every ABSL scheme after its category instead of
 * itself.
 *
 * A cell carrying an as-on label is SKIPPED, because "Portfolio as on 31-08-26"
 * is a date line and not a name — except in the one spelling that puts the name
 * INSIDE it (see {@link PORTFOLIO_OF}).
 */

/**
 * `Portfolio of <SCHEME> as on <date>` — MONEY-1405 (Kotak).
 *
 * Kotak's only title row is `Portfolio of Kotak Nifty200 Value 30 Index Fund as
 * on 31-Aug-2026`, so the as-on skip above left **118 of its 119 sheets with no
 * scheme name at all** and `writeSheet` fell back to the worksheet name — the
 * house's internal short code (`V3I`, `TIF`, `TCH`). Those rows would have
 * stored, keyed on `schemeKeyOf("V3I")`, and been unjoinable to AMFI's master
 * for ever; the join is name-based because no portfolio workbook carries a
 * scheme code (MONEY-1197 rule 4).
 *
 * Deliberately anchored on `portfolio of|for`, not on "strip the as-on clause
 * and keep what is left". That looser rule would turn Tata's `Portfolio as on
 * 31-08-26` into the name `Portfolio` and Nippon's `Monthly Portfolio Statement
 * as on July 31,2026` into `Monthly Portfolio Statement` — both ≥ 8 characters,
 * both would win `firstRowName`, and both houses name their schemes correctly
 * today.
 */
const PORTFOLIO_OF = /^portfolio\s+(?:of|for)\s+(.+?)\s+as\s*(?:on|at)\b/i;

/**
 * `… Portfolio Statement of <SCHEME> for <Month> <Year>` — MONEY-1405 (Zerodha).
 *
 * A SECOND pattern rather than a looser first one. Zerodha's title row is
 *
 *     MONTHLY PORTFOLIO STATEMENT OF ZERODHA ARBITRAGE FUND FOR AUGUST 2026
 *
 * which differs from {@link PORTFOLIO_OF} in three places at once: it does not
 * START with "portfolio", it says "statement of" rather than "of", and it ends
 * in a MONTH rather than an as-on date. Widening the Kotak pattern to reach it
 * would undo exactly what that pattern's comment says it is protecting — Tata's
 * `Portfolio as on 31-08-26` becoming the name `Portfolio`, Nippon's
 * `Monthly Portfolio Statement as on July 31,2026` becoming
 * `Monthly Portfolio Statement`. Both are ≥ 8 characters, both would win
 * `firstRowName`, and both houses name their schemes correctly today.
 *
 * ## What it costs to not have this
 *
 * Measured on PROD 2026-09-13: `mf_portfolio_holdings` holds **1,072 ZERODHA
 * rows under exactly ONE `schemeKey`** — `zerodha-mutual-fund` — where SBI has
 * 135, DSP 88 and Helios 12. Every one of Zerodha's ~22 schemes upserts into
 * one pseudo-fund on `(period, amc, schemeKey, instrumentName)`, so each sheet
 * overwrites the last and the survivor is whichever parsed final.
 *
 * The cause is `firstRowName` taking the first row that carries any ≥ 8-char
 * candidate — and Zerodha's row 0 is the AMC NAME, which is a perfectly good
 * candidate by that rule and a useless one in fact. This is NOT the as-on skip:
 * it predates `for` joining `AS_ON_LABEL` and reproduces with that arm removed.
 *
 * The month-and-year tail is REQUIRED, not optional. Without it the capture is
 * unbounded and swallows the period into the name, which would key the same
 * scheme differently every month — a worse failure than the one being fixed,
 * because it would look like new funds appearing rather than one fund missing.
 */
const PORTFOLIO_STATEMENT_OF =
  /\bportfolio\s+statement\s+of\s+(.+?)\s+for\s+(?:the\s+)?(?:month\s+of\s+)?[a-z]+\s+\d{4}/i;
function findSchemeMeta(
  grid: Grid,
  headerRow: number,
  sheetName: string,
): { schemeName: string | null; schemeCode: string | null } {
  const limit = headerRow >= 0 ? headerRow : Math.min(grid.length, 12);
  let labelled: string | null = null;
  let firstRowName: string | null = null;
  let code: string | null = null;

  for (let r = 0; r < limit; r++) {
    const row = grid[r] ?? [];
    let bestInRow: string | null = null;

    for (let c = 0; c < row.length; c++) {
      const t = normText(row[c]!.v);
      if (!t) continue;

      if (/scheme\s*name\s*:?\s*$/i.test(t)) {
        for (let k = c + 1; k < Math.min(c + 4, row.length); k++) {
          const val = normText(row[k]!.v);
          if (val) {
            labelled ??= val;
            break;
          }
        }
        continue;
      }

      // An AMC-internal scheme code: short, alphanumeric, not prose. SBI prints
      // "007" as a string, Nippon "RLMF001". Checked before the name candidacy
      // so a code is never mistaken for a (very short) scheme name.
      if (code === null && t !== sheetName && /^[A-Z]{0,6}\d{2,6}$/i.test(t)) {
        code = t;
        continue;
      }

      if (AS_ON_LABEL.test(t)) {
        // A name lifted out of an explicit `Portfolio (Statement) of <X>`
        // construct is POSITIVELY IDENTIFIED — the sheet says, in words, which
        // scheme this is. So it ranks with `labelled`, not with `firstRowName`.
        //
        // That precedence is the actual fix for Zerodha, and adding the pattern
        // without it changes nothing: `firstRowName` is set by the FIRST row
        // carrying any >= 8-char candidate and is never replaced, and Zerodha's
        // row 0 is the AMC name — a perfectly good candidate by that rule and a
        // useless one in fact. Extracting the right name one row later cannot
        // win a race that was already decided.
        //
        // `??=` so an explicit `Scheme Name:` label still wins if it came first;
        // both are positive identifications and neither should be a guess.
        const inside = (
          PORTFOLIO_OF.exec(t)?.[1] ?? PORTFOLIO_STATEMENT_OF.exec(t)?.[1]
        )?.trim();
        if (inside && inside.length >= 8) labelled ??= inside;
        continue;
      }
      // The sheet name repeated in a cell is the short code, not the name.
      if (t === sheetName) continue;
      // Too short to be a scheme name — a stray marker like "Index".
      if (t.length < 8) continue;
      if (bestInRow === null || t.length > bestInRow.length) bestInRow = t;
    }

    if (firstRowName === null && bestInRow !== null) firstRowName = bestInRow;
  }

  return { schemeName: labelled ?? firstRowName, schemeCode: code };
}

/* -------------------------------------------------------------------------- */
/* Index sheet                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse the `Index` sheet into scheme identity rows.
 *
 * Two layouts, both handled:
 *   - SBI / ABSL: a real header row (`Scheme Code | Scheme Short code | Scheme
 *     Name`) followed by one row per scheme.
 *   - Nippon: no header and no code — just `sheetName | full scheme name`.
 *
 * See {@link SchemeIndexEntry} for what these identifiers are worth.
 */
function parseIndexSheet(
  grid: Grid,
  sheetNames: ReadonlySet<string>,
): SchemeIndexEntry[] {
  const out: SchemeIndexEntry[] = [];

  for (const row of grid) {
    const cells = row.map((c) => normText(c.v));
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length < 2) continue;
    // Skip the header row itself.
    if (cells.some((c) => /^scheme\s*code$/i.test(c))) continue;

    const [a, b, c] = nonEmpty;
    // 3-column layout: code, short code, name.
    if (nonEmpty.length >= 3 && b && sheetNames.has(b)) {
      out.push({ schemeCode: a ?? null, shortCode: b, schemeName: c ?? "" });
      continue;
    }
    // 2-column layout: short code (== sheet name), name.
    if (a && sheetNames.has(a) && b) {
      out.push({ schemeCode: null, shortCode: a, schemeName: b });
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Sheet parsing                                                               */
/* -------------------------------------------------------------------------- */

const UNIT_LAKH = /\b(lakh|lakhs|lac|lacs)\b/i;

function parseSheet(
  sheetName: string,
  grid: Grid,
  maxHoldings: number | undefined,
): AmcSchemeSheet | null {
  const headerRow = findHeaderRow(grid);
  if (headerRow < 0) return null;

  const headers = (grid[headerRow] ?? []).map((c) => normText(c.v));
  const cols = mapColumns(headers);
  cols.amcInstrumentCode = findInstrumentCodeColumn(cols, headers);
  const nameSpan = instrumentNameSpan(cols, headers);

  const anomalies: string[] = [];
  const missingColumns = EXPECTED_COLUMNS.filter((k) => cols[k] === null).map(
    String,
  );

  // Unit check — confirm rather than assume the magnitude (see module header).
  if (cols.marketValue !== null) {
    const valueHeader = headers[cols.marketValue] ?? "";
    if (!UNIT_LAKH.test(valueHeader)) {
      anomalies.push(
        `market-value unit not recognised as lakhs: ${JSON.stringify(valueHeader)}`,
      );
    }
  }

  const holdings: AmcHolding[] = [];
  const rawPercents: number[] = [];
  const percentFormats: (string | undefined)[] = [];
  let section: string | null = null;
  let rawTotalAum: number | null = null;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (isTableTerminator(row)) {
      // The grand total is the AUM — capture it on the way out rather than
      // discarding the one row that states the fund's size.
      const isGrandTotal = row.some((c) => GRAND_TOTAL.test(normText(c.v)));
      if (isGrandTotal && cols.marketValue !== null) {
        rawTotalAum = toFiniteOrNull(row[cols.marketValue]?.v);
      }
      break;
    }
    if (maxHoldings !== undefined && holdings.length >= maxHoldings) break;

    const label = sectionLabel(row, cols);
    if (label !== null) {
      section = label;
      continue;
    }

    // The name comes from the SPAN — the mapped column unless a merged header
    // put the values further right. See `instrumentNameSpan`.
    const { name } = rowShape(row, cols, nameSpan);
    const isinCell = cols.isin !== null ? row[cols.isin]?.v : undefined;
    const isin = isIsin(isinCell) ? isinCell.trim() : null;

    // A holding needs a name; a nameless row is a spacer or a note.
    if (!name) continue;
    // Section subtotals aggregate the rows above them — never a holding.
    if (isAggregateRow(name)) continue;
    // Rows with neither ISIN nor any number are prose that slipped the section
    // test (multi-cell notes). Require at least one quantitative anchor.
    const rawPct =
      cols.percent !== null ? toFiniteOrNull(row[cols.percent]?.v) : null;
    const qty =
      cols.quantity !== null ? toFiniteOrNull(row[cols.quantity]?.v) : null;

    // A SEBI section heading that states its own SUBTOTAL is still a heading —
    // ICICI. See `headsItsOwnSection` for why this is structural rather than a
    // list of heading names.
    if (
      isin === null &&
      qty === null &&
      (headsItsOwnSection(grid, r, cols, nameSpan) ||
        headsItsOwnSectionBySum(grid, r, cols, nameSpan))
    ) {
      section = name;
      continue;
    }

    const mv =
      cols.marketValue !== null
        ? toFiniteOrNull(row[cols.marketValue]?.v)
        : null;
    if (isin === null && rawPct === null && qty === null && mv === null)
      continue;

    const combined =
      cols.industryRating !== null ? normText(row[cols.industryRating]?.v) : "";
    const { industry, rating } = classifyIndustryOrRating(combined);

    // HDFC's headerless first column holds a "|" glyph marking traded
    // securities, not a code — an identifier must contain something identifying.
    const rawCode =
      cols.amcInstrumentCode !== null
        ? normText(row[cols.amcInstrumentCode]?.v)
        : "";
    const code = /[A-Za-z0-9]/.test(rawCode) ? rawCode : "";

    if (rawPct !== null) {
      rawPercents.push(rawPct);
      if (cols.percent !== null) percentFormats.push(row[cols.percent]?.z);
    }

    holdings.push({
      instrumentName: name,
      isin,
      industry,
      rating,
      quantity: qty,
      marketValueLakhs: mv,
      // Placeholder — normalised below, once the sheet-wide scale is known.
      pctToNav: rawPct,
      section,
      amcInstrumentCode: code || null,
      rowIndex: r,
    });
  }

  const { scale, source } = resolvePercentScale(rawPercents, percentFormats);
  if (scale === "fraction") {
    for (const h of holdings) {
      if (h.pctToNav !== null) h.pctToNav *= 100;
    }
  }

  // The AUM is a rupee figure, not a percentage — it is never rescaled.
  const totalAumLakhs = rawTotalAum;

  let percentSum: number | null = null;
  for (const h of holdings) {
    if (h.pctToNav !== null) percentSum = (percentSum ?? 0) + h.pctToNav;
  }

  // MONEY-1238 — `percentSum` and `missingColumns` now DECIDE something. Both
  // were computed on every sheet and read by nobody, so a 100× scale misread
  // or a dropped column reached the database looking like ordinary data.
  // Folding them into `anomalies` puts them in the one field on this shape that
  // is already the sheet's "something is wrong here" channel.
  const percentSumCheck = checkPercentSum({
    percentSum,
    totalAumLakhs,
    holdings,
  });
  if (percentSumCheck.verdict === "scale-suspect") {
    anomalies.push(
      `percent column disagrees with the money column: pctToNav sums to ` +
        `${percentSum?.toFixed(4)} but marketValue/AUM gives ` +
        `${percentSumCheck.moneyWeightSum?.toFixed(4)} ` +
        `(ratio ${percentSumCheck.ratio?.toFixed(4)}) — a ratio near 0.01 or ` +
        `100 is a percent/fraction scale misread, and every pctToNav on this ` +
        `sheet is off by that factor`,
    );
  }
  if (missingColumns.length > 0) {
    anomalies.push(
      `expected column(s) absent from this sheet: ${missingColumns.join(", ")}` +
        ` — the corresponding holding fields are null, not zero`,
    );
  }

  return {
    sheetName,
    ...findSchemeMeta(grid, headerRow, sheetName),
    asOfDate: findAsOfDate(grid, headerRow),
    percentScale: scale,
    percentScaleSource: source,
    percentSum,
    percentSumCheck,
    totalAumLakhs,
    headers: headers.filter(Boolean),
    columns: cols,
    missingColumns,
    holdings,
    anomalies,
  };
}

/* -------------------------------------------------------------------------- */
/* Consolidated sheets                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `SCHEME CODE002STARTS` — UTI's block delimiter. The code is glued to both
 * words, so `\S+` does the work `\s+` cannot.
 */
const SCHEME_BLOCK_START = /^SCHEME\s+CODE\s*\S+\s*STARTS\b/i;

/** `SCHEME: UTI - Large Cap Fund` — the block's own name for itself. */
const SCHEME_BLOCK_NAME = /^SCHEME\s*:\s*(.+)$/i;

/**
 * Split ONE worksheet that holds MANY schemes end to end — MONEY-1407 (UTI).
 *
 * ## The shape
 *
 * `parseAmcPortfolioWorkbook` maps one SHEET to one scheme, which is how every
 * other house publishes. UTI publishes a single sheet named `EXPOSURE`
 * carrying all 85 of its schemes one after another (9,208 rows, August 2026),
 * each block opened by `SCHEME CODE<nnn>STARTS`, named on the next-but-one row
 * by `SCHEME: <name>`, and closed by `SCHEME CODE<nnn>ENDS`. Parsed as-is it
 * produced ONE sheet of 132 holdings summing to 11,816% of NAV — the first
 * block's rows plus whatever ran past them until the second block's header row
 * re-declared `ISIN` and tripped `isTableTerminator`. A wrong answer that
 * stores perfectly cleanly, which is the shape this module keeps meeting.
 *
 * ## Why TWO markers and not one
 *
 * A house whose sheet says `SCHEME CODE…STARTS` exactly once is not publishing
 * a consolidated sheet, and splitting it would replace a working parse with a
 * one-segment one for no gain. Every other house scores ZERO, so requiring two
 * leaves all of them untouched BY CONSTRUCTION rather than by a per-AMC branch
 * — the discipline `headsItsOwnSection` is written to and the reason this is a
 * shape test rather than an `if (amc === "UTI")`.
 *
 * ## The block carries its own header, so nothing is prepended
 *
 * Measured on the live August-2026 workbook: 85 start markers, 85 `SCHEME:`
 * rows, 85 `AS OF` date lines and 90 `NAME OF THE INSTRUMENT` header rows — so
 * every block re-prints the column header (five print it twice) and
 * `findHeaderRow`, which scans 30 rows, finds it inside the block. A version
 * that also copied a sheet-level header row down would be writing a header
 * these blocks already have.
 *
 * ## The name is taken, never inferred
 *
 * The block's first row is the marker itself, which is 20 characters of text
 * and would beat every other candidate in `findSchemeMeta`'s "longest text in
 * the first row that has any" rule; the row below it is `UTI MUTUAL FUND`,
 * identical on all 85 blocks, which is the ICICI collapse (85 schemes onto one
 * `schemeKey`) from the other direction. So the caller overrides `schemeName`
 * with what the publisher itself wrote after `SCHEME:`, exactly as the zip
 * branch overrides it with the member filename.
 *
 * A block with no `SCHEME:` row falls back to the MARKER's own text, which
 * carries the scheme code and so is distinct per block. That is deliberately
 * not a drop: a block whose name we cannot read still holds real holdings, and
 * a visibly wrong scheme name is recoverable where silently merged rows are
 * not.
 *
 * Returns `[]` for every sheet that is not one of these — that is the answer,
 * not an error.
 */
export function splitConsolidatedSheet(
  grid: Grid,
): Array<{ name: string; grid: Grid }> {
  const marks: Array<{ row: number; text: string }> = [];
  for (let r = 0; r < grid.length; r++) {
    for (const cell of grid[r] ?? []) {
      const t = normText(cell.v);
      if (t && SCHEME_BLOCK_START.test(t)) {
        marks.push({ row: r, text: t });
        break;
      }
    }
  }
  if (marks.length < 2) return [];

  const out: Array<{ name: string; grid: Grid }> = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!;
    const end = marks[i + 1]?.row ?? grid.length;
    const segment = grid.slice(start.row, end);

    let name = "";
    outer: for (const row of segment) {
      for (const cell of row) {
        const captured = SCHEME_BLOCK_NAME.exec(normText(cell.v))?.[1]?.trim();
        if (captured) {
          name = captured;
          break outer;
        }
      }
    }
    out.push({ name: name || start.text, grid: segment });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** What ONE workbook's worth of bytes produced. */
interface WorkbookSheets {
  sheetCount: number;
  sheets: AmcSchemeSheet[];
  nonPortfolioSheets: string[];
  index: SchemeIndexEntry[];
}

/** Read one workbook (already unwrapped) into sheets. `null` = not readable. */
function readWorkbookSheets(
  workbookBytes: Buffer,
  opts: ParseOptions,
): WorkbookSheets | null {
  let wb: XLSX.WorkBook;
  try {
    // `cellDates:false` is deliberate and load-bearing — see trap 7.
    // `cellNF` keeps the number formats that decide the percent scale.
    wb = XLSX.read(workbookBytes, {
      type: "buffer",
      cellDates: false,
      cellNF: true,
    });
  } catch {
    return null;
  }

  const sheetNames = wb.SheetNames ?? [];
  if (sheetNames.length === 0) return null;

  const nameSet = new Set(sheetNames);
  const sheets: AmcSchemeSheet[] = [];
  const nonPortfolioSheets: string[] = [];
  let index: SchemeIndexEntry[] = [];

  const wanted = opts.onlySheets ? new Set(opts.onlySheets) : null;

  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) {
      nonPortfolioSheets.push(name);
      continue;
    }
    if (wanted && !wanted.has(name) && name !== "Index") continue;

    const grid = buildGrid(ws);

    // ONE sheet, MANY schemes — MONEY-1407. `[]` for every house that does not
    // publish that way, which is all of them but UTI, so this costs one scan
    // of each sheet's cells and changes nothing else.
    const blocks = splitConsolidatedSheet(grid);
    if (blocks.length > 0) {
      const segs: AmcSchemeSheet[] = [];
      const rejected: string[] = [];
      for (const block of blocks) {
        const seg = parseSheet(
          block.name,
          block.grid,
          opts.maxHoldingsPerSheet,
        );
        if (seg) {
          // The publisher named this block; `findSchemeMeta` would name it
          // after the marker row or after the AMC. See the header above.
          seg.schemeName = block.name;
          segs.push(seg);
        } else {
          rejected.push(block.name);
        }
      }
      // A SPLIT THAT YIELDS NO PORTFOLIO IS NOT A CONSOLIDATED SHEET.
      //
      // `SCHEME_BLOCK_START` is anchored, but an anchored phrase is still a
      // phrase: two rows beginning `SCHEME CODE 101 STARTS trading …` score
      // two marks on an ordinary sheet. Every segment starts at `marks[0].row`,
      // so EVERY HOLDING ABOVE THE FIRST MARKER is outside all of them — and
      // this branch used to `continue` unconditionally, so the unsplit sheet
      // was never parsed. Measured: a normal two-holding sheet plus two such
      // rows produced `sheets: 0` and both prose lines in
      // `nonPortfolioSheets`, silently.
      //
      // Committing only when the split produced something keeps UTI (85 real
      // blocks) and costs a false fire one wasted parse instead of the sheet.
      if (segs.length > 0) {
        sheets.push(...segs);
        nonPortfolioSheets.push(...rejected);
        continue;
      }
    }

    const parsed = parseSheet(name, grid, opts.maxHoldingsPerSheet);
    if (parsed) {
      sheets.push(parsed);
    } else {
      nonPortfolioSheets.push(name);
      if (index.length === 0) {
        const entries = parseIndexSheet(grid, nameSet);
        if (entries.length > 0) index = entries;
      }
    }
  }

  return { sheetCount: sheetNames.length, sheets, nonPortfolioSheets, index };
}

/** `ICICI Prudential Nifty 50 ETF.xlsx` -> `ICICI Prudential Nifty 50 ETF`. */
function entryStem(name: string): string {
  const base = name.split("/").pop() ?? name;
  return base.replace(WORKBOOK_EXT, "").trim();
}

/**
 * Parse an AMC monthly portfolio disclosure from raw bytes.
 *
 * Returns `null` — and ONLY `null` — when the bytes could not be read as a
 * workbook at all. A workbook that parsed but contained no holdings comes back
 * as a real {@link AmcPortfolioFile} with `sheets: []`. That distinction is the
 * point: this repo has been burned by `[]` meaning both "nothing there" and
 * "the parse blew up", and a caller that cannot tell them apart will happily
 * write an empty month over a good one.
 *
 * Handles all three containers: a bare OOXML workbook, a real OLE2 workbook,
 * and a zip archive wrapping ANY NUMBER of either — ABSL ships one 105-sheet
 * `.xls`, ICICI Prudential ships 147 one-sheet `.xlsx` files in a 25 MB zip.
 *
 * ## The archive is read WHOLE, not first-member-only — MONEY-1405
 *
 * It used to unwrap exactly one member, which was right for the only archive
 * this module had seen and silently wrong for the shape SEBI's format actually
 * invites: one file per scheme. On ICICI that would have stored 1 of 146
 * schemes and reported a clean success — except that the first-member reader
 * could not read ICICI's zip at all (see `unzipWorkbookEntries`), so the
 * failure was loud by luck rather than by design.
 *
 * ## Who names the scheme in a MULTI-member archive
 *
 * The member filename does, and only there. ICICI prints its own AMC name
 * (`ICICI Prudential Mutual Fund`) on the first row of every one of the 147
 * sheets, above the scheme's name, and `findSchemeMeta`'s "longest text in the
 * first row that has any" rule takes it — so all 147 schemes would collapse
 * onto one `schemeKey` and upsert over each other. The zip member is named
 * `ICICI Prudential Nifty 50 ETF.xlsx`, which is the scheme, stated by the
 * publisher.
 *
 * Confined to members that contribute EXACTLY ONE portfolio sheet, and to
 * archives with MORE THAN ONE member. ABSL's single member holds 105 schemes
 * and must keep the names its sheets carry; naming all 105 after the zip member
 * would be the same defect from the other side.
 */
export function parseAmcPortfolioWorkbook(
  bytes: Uint8Array,
  opts: ParseOptions = {},
): AmcPortfolioFile | null {
  const format = detectWorkbookFormat(bytes);
  if (format === "unknown") return null;

  const outerBytes = toBuffer(bytes);
  let containerEntryName: string | null = null;

  // Reject an incomplete archive before SheetJS can hang on it (see
  // `hasEndOfCentralDirectory`). A truncated download is a failed parse, and
  // `null` says so; hanging says nothing at all.
  if (format !== "ole2" && !hasEndOfCentralDirectory(outerBytes)) return null;

  const anomalies: string[] = [];
  let sheetCount = 0;
  const sheets: AmcSchemeSheet[] = [];
  const nonPortfolioSheets: string[] = [];
  let index: SchemeIndexEntry[] = [];

  const absorb = (read: WorkbookSheets): void => {
    sheetCount += read.sheetCount;
    sheets.push(...read.sheets);
    nonPortfolioSheets.push(...read.nonPortfolioSheets);
    if (index.length === 0) index = read.index;
  };

  if (format === "zip-archive") {
    // Only unwrap one level, and only into something that is itself a workbook.
    // A zip of PDFs is not a parse failure to retry — it is the wrong file.
    const members = unzipWorkbookEntries(outerBytes).filter((e) => {
      const inner = detectWorkbookFormat(e.bytes);
      if (inner !== "ooxml" && inner !== "ole2") return false;
      // The unwrapped workbook gets the same completeness guard as the outer.
      return inner !== "ooxml" || hasEndOfCentralDirectory(e.bytes);
    });
    if (members.length === 0) return null;
    if (members.length === 1) containerEntryName = members[0]!.name;

    for (const member of members) {
      const read = readWorkbookSheets(member.bytes, opts);
      if (read === null) {
        anomalies.push(`archive member unreadable: ${member.name}`);
        continue;
      }
      if (members.length > 1 && read.sheets.length === 1) {
        read.sheets[0]!.schemeName = entryStem(member.name);
      }
      absorb(read);
    }
    if (sheetCount === 0) return null;
  } else {
    const read = readWorkbookSheets(outerBytes, opts);
    if (read === null) return null;
    absorb(read);
  }

  if (sheets.length === 0) anomalies.push("no portfolio sheets found");

  // MONEY-1238 — roll the per-sheet verdicts up to the file.
  //
  // A caller that reads one field of this shape reads a FILE-level one; the SBI
  // workbook alone carries 122 sheets, so a per-sheet anomaly on sheet 87 is
  // not something anyone stumbles across. Counting them here makes one bad
  // sheet visible from the top of the result, next to the parse-level problems
  // that were already reported this way.
  const scaleSuspect = sheets.filter(
    (s) => s.percentSumCheck.verdict === "scale-suspect",
  );
  if (scaleSuspect.length > 0) {
    anomalies.push(
      `${scaleSuspect.length} of ${sheets.length} sheet(s) failed the ` +
        `percent-vs-money cross-check: ${scaleSuspect
          .slice(0, 10)
          .map((s) => s.sheetName)
          .join(", ")}${scaleSuspect.length > 10 ? ", …" : ""}`,
    );
  }
  const withMissingColumns = sheets.filter((s) => s.missingColumns.length > 0);
  if (withMissingColumns.length > 0) {
    anomalies.push(
      `${withMissingColumns.length} of ${sheets.length} sheet(s) are missing ` +
        `an expected column: ${withMissingColumns
          .slice(0, 10)
          .map((s) => `${s.sheetName} (${s.missingColumns.join("/")})`)
          .join(", ")}${withMissingColumns.length > 10 ? ", …" : ""}`,
    );
  }

  return {
    format,
    containerEntryName,
    sheetCount,
    index,
    sheets,
    nonPortfolioSheets,
    anomalies,
  };
}
