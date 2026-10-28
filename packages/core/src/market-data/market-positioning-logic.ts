/**
 * NSE participant-wise F&O positioning — MONEY-1187 (Data Engine P11).
 *
 * Two files, one shape, published daily by NSCCL and already registered in
 * `report-registry.ts` as `nse-fao-participant-oi` / `nse-fao-participant-vol`:
 *
 *   /content/nsccl/fao_participant_oi_{DDMMYYYY}.csv    open interest
 *   /content/nsccl/fao_participant_vol_{DDMMYYYY}.csv   traded volume
 *
 * Each is a 15-column cross-tab of four participant categories (Client, DII,
 * FII, Pro) against six instrument buckets, long and short, in CONTRACTS. It is
 * the only public read on who is positioned which way in Indian derivatives —
 * "FII index futures long/short ratio" comes from exactly these bytes.
 *
 * This module is the PURE half: bytes → rows. No fetch, no Prisma, no clock.
 * Same split as `institutional-flows.ts` (whose `FlowSegment` already reserves
 * `"FNO"` for this leg) and `stock-flags.ts`: the worker keeps the I/O and this
 * keeps every judgement, so all of it is testable against real archived bytes.
 *
 * ## Three things about the real files that a "reasonable" parser gets wrong
 *
 * **1. The title row's DOUBLED quotes swallow the entire file.** Line 1 is
 * literally `""Participant wise Open Interest … as on Aug 13, 2026"",,,…`.
 * Handing that to `Papa.parse` with default quoting — which is what every other
 * parser in this directory does via its local `toGrid` — opens a quoted field on
 * the leading `"` that never legally closes, so Papa returns **one row with one
 * cell containing the whole file** plus a `MissingQuotes` error nobody reads.
 * Copying the sibling `toGrid` here yields zero participants and looks exactly
 * like a market holiday. So the preamble is separated from the table by LINE
 * before Papa sees anything, and only the table (which contains no quotes at
 * all) is handed to a real CSV parser.
 *
 * **2. That title row is the only copy of the trading date.** No data row
 * carries a date. The date also appears in the URL, and the caller knows it —
 * which is precisely why {@link ParticipantPositioningFile.tradingDate} being
 * null is a survivable outcome and not a parse failure: NSE re-serving
 * yesterday's file at today's URL is a real hazard, so the caller should
 * cross-check the two and refuse to write on disagreement, not silently prefer
 * either one.
 *
 * **3. The two files are byte-identical in structure.** Only the title says
 * whether the numbers are open interest or volume. Writing a volume file into
 * the OI series would be undetectable downstream and would corrupt every
 * positioning ratio built on it, so {@link ParticipantPositioningFile.measure}
 * is parsed from the title for the caller to check against the URL it fetched.
 *
 * ## Why `null` and `rows: []` are different answers
 *
 * `null` means "these bytes are not this report" — an HTML error page (NSE
 * serves those with HTTP 200), a truncated download, a renamed column set we
 * cannot map. `rows: []` means "this IS the report and it carried no
 * participants". Callers in this codebase have been burned repeatedly by `[]`
 * standing for both; the worker must treat BOTH as a failure here (a real
 * trading day always has four participants) but only `null` means "do not trust
 * anything else in this response either".
 *
 * ## The totals columns are a checksum, not data
 *
 * `Total Long Contracts` / `Total Short Contracts` restate the six legs. They
 * are never stored — a seventh "TOTAL" bucket would double every aggregate that
 * sums buckets — but they are verified, and a mismatch is REPORTED
 * ({@link ParticipantPositioningFile.discrepancies}) rather than thrown or
 * swallowed. That is not theoretical: the 2026-08-13 OI file, the first real
 * file this parser ever saw, fails it. Client's six long legs sum to 12,729,369
 * against a stated 12,729,368, and Pro's to 4,918,610 against 4,918,609 — NSE's
 * own arithmetic is off by one contract in two rows. Throwing would have
 * dropped a perfectly good day's positioning over ±1; staying silent would have
 * hidden the day NSE is off by 1,000,000.
 */

import Papa from "papaparse";

import { parseNseFlowDate } from "./institutional-flows";

// ─── Domain ──────────────────────────────────────────────────────────

/**
 * Participant categories, in NSE's own row order.
 *
 * `Pro` is proprietary trading by the member firm itself; `Client` is everyone
 * the members trade for, which is why it dwarfs the other three.
 */
export const POSITIONING_PARTICIPANTS = [
  "CLIENT",
  "DII",
  "FII",
  "PRO",
] as const;
export type ParticipantType = (typeof POSITIONING_PARTICIPANTS)[number];

/**
 * Instrument buckets, in the canonical emit order.
 *
 * The six are a cross-product — (future | option) × (index | stock), and for
 * options × (call | put) — which is why the column resolver below classifies
 * headers by TOKEN rather than matching twelve literal names: the structure is
 * real, and encoding it as twelve unrelated strings pretends otherwise.
 */
export const POSITIONING_BUCKETS = [
  "FUT_IDX",
  "FUT_STK",
  "OPT_IDX_CALL",
  "OPT_IDX_PUT",
  "OPT_STK_CALL",
  "OPT_STK_PUT",
] as const;
export type PositioningBucket = (typeof POSITIONING_BUCKETS)[number];

/** Which quantity the file reports. The two files differ ONLY in this. */
export type PositioningMeasure = "OI" | "VOLUME";

/**
 * One participant's position in one bucket — the storage grain.
 *
 * Long and short are kept as published and never collapsed to a net on the way
 * in: the gross legs are the signal (a participant holding 3.5M long and 3.5M
 * short is not the same market view as one holding neither), and `net` is
 * always recoverable via {@link netContracts}.
 */
export interface ParticipantPositioningRow {
  participant: ParticipantType;
  bucket: PositioningBucket;
  /** Contracts held/traded long. Finite; never a parse-failure stand-in. */
  longQty: number;
  /** Contracts held/traded short. */
  shortQty: number;
}

/** What kind of arithmetic the file failed. */
export type PositioningDiscrepancyCode =
  /** A participant row's stated `Total Long Contracts` ≠ its six long legs. */
  | "TOTAL_LONG"
  /** …same, short side. */
  | "TOTAL_SHORT"
  /** The TOTAL row's own stated total ≠ its own six legs. */
  | "GRAND_TOTAL_LONG"
  | "GRAND_TOTAL_SHORT"
  /** Σ(four participants) for one leg column ≠ the TOTAL row's cell. */
  | "PARTICIPANT_SUM";

/**
 * One failed checksum, carrying both numbers so the size of the disagreement is
 * visible. ±1 is NSE rounding; ±1,000,000 is a shifted column.
 */
export interface PositioningDiscrepancy {
  code: PositioningDiscrepancyCode;
  /** The row at fault; null for the file-wide `PARTICIPANT_SUM` check. */
  participant: ParticipantType | null;
  /** Which column: a bucket+side for `PARTICIPANT_SUM`, else the totals side. */
  column: string;
  /** What the file says. */
  stated: number;
  /** What the parts add up to. */
  computed: number;
  /** `computed − stated`. Signed on purpose. */
  delta: number;
}

export interface ParticipantPositioningFile {
  /**
   * UTC midnight of the IST trading day, read from the title row.
   *
   * Null when the title carried no date we could read. NOT a parse failure: the
   * caller requested a specific day's URL and can fall back to it. Guessing a
   * date here would land a day's positioning on the wrong day and corrupt every
   * day-over-day change derived from it — the same reasoning as
   * `parseNseFlowDate` returning null instead of `new Date()`.
   */
  tradingDate: Date | null;
  /** OI vs VOLUME, read from the title. Null when the title did not say. */
  measure: PositioningMeasure | null;
  /** Unpivoted (participant × bucket). Empty = recognised but empty. */
  rows: ParticipantPositioningRow[];
  /** Failed checksums. Empty is the healthy case. */
  discrepancies: PositioningDiscrepancy[];
  /**
   * Falsification counters, same idiom as the P4 flag/deal/constituent
   * parsers: every drop increments a named reason, so the first run that meets
   * a shape change says where it went wrong instead of quietly shrinking.
   */
  reasons: Record<string, number>;
}

// ─── Plumbing ────────────────────────────────────────────────────────

/**
 * Compare form for header cells and labels: lowercase, every run of
 * non-alphanumerics collapsed to one space, trimmed.
 *
 * This is what makes the live files' trailing padding (`"Future Stock Short
 * "`, `"Total Long Contracts      "`) match, and it also absorbs `/`, `.` and
 * `&` so `"FII/FPI"` normalises to `"fii fpi"`.
 */
function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** One CSV line → cells. Used only to test a candidate header line. */
function splitLine(line: string): string[] {
  const parsed = Papa.parse<string[]>(line, { skipEmptyLines: "greedy" });
  const row = parsed.data[0];
  return Array.isArray(row) ? row.map((c) => String(c ?? "")) : [];
}

/**
 * How far into the file to look for the header row.
 *
 * The real preamble is one line. The bound exists so that garbage (an NSE error
 * page is thousands of lines of HTML served with HTTP 200) costs a bounded scan
 * rather than a per-line CSV parse of the whole document.
 */
const HEADER_SCAN_LIMIT = 50;

type LegSide = "LONG" | "SHORT";

interface ClassifiedColumn {
  kind: "leg" | "total";
  /** Null for the totals columns, which are a checksum and not a bucket. */
  bucket: PositioningBucket | null;
  side: LegSide;
}

/**
 * Classify a normalised header cell by MEANING, not position.
 *
 * NSE's live column order is not the order this module emits, and it is not
 * even internally grouped the way you would guess — the options block runs
 * call-long, put-long, call-short, put-short. Position-indexed parsing of these
 * report families is how the P1 findings died, so nothing here depends on
 * where a column sits.
 *
 * Anything ambiguous (no side, both sides, a "future call") returns null and is
 * simply not mapped; if that costs a required leg the whole file is rejected as
 * unrecognised, which is louder and safer than mapping it to the wrong bucket.
 */
function classifyHeaderCell(normalized: string): ClassifiedColumn | null {
  const tokens = new Set(normalized.split(" ").filter(Boolean));

  const isLong = tokens.has("long");
  const isShort = tokens.has("short");
  if (isLong === isShort) return null;
  const side: LegSide = isLong ? "LONG" : "SHORT";

  if (tokens.has("total")) return { kind: "total", bucket: null, side };

  const isFuture =
    tokens.has("future") || tokens.has("futures") || tokens.has("fut");
  const isOption =
    tokens.has("option") || tokens.has("options") || tokens.has("opt");
  if (isFuture === isOption) return null;

  const isIndex = tokens.has("index") || tokens.has("idx");
  const isStock = tokens.has("stock") || tokens.has("stk");
  if (isIndex === isStock) return null;

  const isCall = tokens.has("call");
  const isPut = tokens.has("put");

  if (isFuture) {
    // A future has no call/put side. A cell claiming both is a shape we do not
    // understand, and inventing a bucket for it is worse than skipping it.
    if (isCall || isPut) return null;
    return { kind: "leg", bucket: isIndex ? "FUT_IDX" : "FUT_STK", side };
  }

  if (isCall === isPut) return null;
  const bucket: PositioningBucket = isIndex
    ? isCall
      ? "OPT_IDX_CALL"
      : "OPT_IDX_PUT"
    : isCall
      ? "OPT_STK_CALL"
      : "OPT_STK_PUT";
  return { kind: "leg", bucket, side };
}

interface LegColumns {
  long: number;
  short: number;
}

interface ResolvedColumns {
  /** The participant-label column. */
  label: number;
  legs: Record<PositioningBucket, LegColumns>;
  totalLong: number;
  totalShort: number;
  /** True when all twelve legs resolved — the gate for "this is the report". */
  complete: boolean;
  /** Header cells that mapped somewhere already taken; first wins. */
  duplicates: number;
  /** True when the label column was assumed to be column 0. */
  labelAssumed: boolean;
}

/** Participant labels, normalised. `TOTAL` is handled separately. */
const PARTICIPANT_ALIASES: Readonly<Record<string, ParticipantType>> = {
  client: "CLIENT",
  clients: "CLIENT",
  dii: "DII",
  fii: "FII",
  fpi: "FII",
  "fii fpi": "FII",
  pro: "PRO",
  prop: "PRO",
  proprietary: "PRO",
};

const LABEL_PATTERNS: readonly RegExp[] = [
  /^client type$/,
  /^participant( type)?$/,
  /^category$/,
  /type/,
];

function resolveColumns(headerCells: readonly string[]): ResolvedColumns {
  const legs = Object.fromEntries(
    POSITIONING_BUCKETS.map((b) => [b, { long: -1, short: -1 }]),
  ) as Record<PositioningBucket, LegColumns>;

  let totalLong = -1;
  let totalShort = -1;
  let label = -1;
  let duplicates = 0;

  const normalized = headerCells.map(normalizeText);

  for (let i = 0; i < normalized.length; i++) {
    const cell = normalized[i];
    if (cell === undefined || cell.length === 0) continue;

    const classified = classifyHeaderCell(cell);
    if (classified === null) {
      if (label === -1 && LABEL_PATTERNS.some((re) => re.test(cell))) label = i;
      continue;
    }

    if (classified.kind === "total") {
      if (classified.side === "LONG") {
        if (totalLong === -1) totalLong = i;
        else duplicates++;
      } else if (totalShort === -1) totalShort = i;
      else duplicates++;
      continue;
    }

    const bucket = classified.bucket;
    if (bucket === null) continue;
    const slot = legs[bucket];
    const key = classified.side === "LONG" ? "long" : "short";
    if (slot[key] === -1) slot[key] = i;
    else duplicates++;
  }

  // The label column is always first in every file seen. Assuming it (rather
  // than rejecting the file) keeps a renamed header readable; the assumption is
  // counted, and if it is wrong the labels fail to normalise and every row is
  // dropped as `unknownParticipant` — visible either way, never silent.
  const labelAssumed = label === -1;
  if (labelAssumed) label = 0;

  const complete = POSITIONING_BUCKETS.every(
    (b) => legs[b].long >= 0 && legs[b].short >= 0,
  );

  return {
    label,
    legs,
    totalLong,
    totalShort,
    complete,
    duplicates,
    labelAssumed,
  };
}

/**
 * A contract count, or null.
 *
 * Null — never 0 — on anything unparseable. 0 is a claim ("this participant
 * holds nothing in this bucket") that a parse failure has no standing to make,
 * and it would render as a real flat position on a positioning panel and as a
 * huge day-over-day swing in {@link diffPositioning}. NaN/Infinity propagating
 * through a sum is the recurring money-poison defect class in this codebase, so
 * the finite check is the boundary and the caller drops the bucket.
 *
 * `Number("")` is 0, which is why the empty check comes first.
 */
export function parseContractCount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? "")
    .replace(/,/g, "")
    .trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Trading date out of the title row.
 *
 * Live form is `… as on Aug 13, 2026` — month-first, comma, and wrapped in
 * DOUBLED quotes with fourteen trailing commas. That spelling matches none of
 * NSE's other date formats, so it is rewritten to the `DD-Mon-YYYY` form and
 * handed to `parseNseFlowDate`, which already owns month naming and the
 * rollover round-trip that rejects 31-Feb. One date convention, one place.
 *
 * When there is no `as on` clause the whole preamble is scanned for a
 * date-shaped token instead: a reworded title should not cost the day's data.
 */
export function parseParticipantTitleDate(title: string): Date | null {
  const cleaned = title.replace(/[",\s]+$/, "").trim();
  if (!cleaned) return null;

  const asOn = /\bas\s+on\b[\s:]*(.+)$/i.exec(cleaned);
  const candidates: string[] = [];
  if (asOn?.[1]) candidates.push(asOn[1].trim());

  const scan = [
    /([A-Za-z]{3,}\s+\d{1,2}\s*,?\s*\d{4})/,
    /(\d{1,2}[-\s][A-Za-z]{3,}[-\s]\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];
  for (const re of scan) {
    const m = re.exec(cleaned);
    if (m?.[1]) candidates.push(m[1].trim());
  }

  for (const candidate of candidates) {
    const mdy = /^([A-Za-z]{3,})\s+(\d{1,2})\s*,?\s*(\d{4})$/.exec(candidate);
    const parsed = mdy
      ? parseNseFlowDate(`${mdy[2]}-${mdy[1]}-${mdy[3]}`)
      : parseNseFlowDate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * OI vs volume, out of the title row.
 *
 * Both titles say "(no. of contracts)", so the discriminator is the phrase
 * before it. Checked in this order because only the volume title contains the
 * word "volume" — but a future title mentioning both would be ambiguous, and
 * "open interest" is the more specific phrase, so it wins.
 */
export function parseParticipantTitleMeasure(
  title: string,
): PositioningMeasure | null {
  const text = normalizeText(title);
  if (/\bopen interest\b/.test(text)) return "OI";
  if (/\bvolume\b/.test(text)) return "VOLUME";
  return null;
}

// ─── Parse ───────────────────────────────────────────────────────────

/**
 * Parse one `fao_participant_{oi,vol}` CSV.
 *
 * Returns null when the bytes are not this report (no line in the first
 * {@link HEADER_SCAN_LIMIT} resolves all twelve leg columns). Returns a result
 * with `rows: []` when the report is there but carries no participants — a
 * different fact, and the caller must be able to tell them apart.
 *
 * Never throws, never mutates its input.
 */
export function parseParticipantPositioning(
  csv: string,
): ParticipantPositioningFile | null {
  const reasons: Record<string, number> = {};
  const bump = (k: string): void => {
    reasons[k] = (reasons[k] ?? 0) + 1;
  };

  const lines = String(csv ?? "").split(/\r?\n/);

  // Locate the header by LINE, before any full-file CSV parse. The title row's
  // doubled quotes make the file un-parseable as one document (see the module
  // docblock); splitting the preamble off first is what makes the rest sane.
  let headerIdx = -1;
  let columns: ResolvedColumns | null = null;
  const limit = Math.min(lines.length, HEADER_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    const resolved = resolveColumns(splitLine(line));
    if (resolved.complete) {
      headerIdx = i;
      columns = resolved;
      break;
    }
  }
  if (headerIdx === -1 || columns === null) return null;

  if (columns.duplicates > 0) reasons.duplicateColumn = columns.duplicates;
  if (columns.labelAssumed) bump("labelColumnAssumed");
  if (columns.totalLong === -1 || columns.totalShort === -1) {
    bump("noTotalsColumns");
  }

  const title = lines.slice(0, headerIdx).join(" ");
  const tradingDate = parseParticipantTitleDate(title);
  if (tradingDate === null) bump("noTitleDate");
  const measure = parseParticipantTitleMeasure(title);
  if (measure === null) bump("noTitleMeasure");

  // Only the table is handed to Papa, and the table has no quotes at all.
  const parsed = Papa.parse<string[]>(lines.slice(headerIdx + 1).join("\n"), {
    skipEmptyLines: "greedy",
  });

  const rows: ParticipantPositioningRow[] = [];
  const discrepancies: PositioningDiscrepancy[] = [];
  const seen = new Set<ParticipantType>();
  /** The TOTAL row's cells, kept for the cross-participant checksum only. */
  let totalCells: readonly string[] | null = null;

  for (const raw of parsed.data) {
    if (!Array.isArray(raw)) continue;
    const cells = raw.map((c) => String(c ?? "").trim());
    if (!cells.some((c) => c.length > 0)) continue;

    const label = normalizeText(cells[columns.label] ?? "");
    if (!label) {
      bump("emptyLabel");
      continue;
    }

    // The TOTAL row is a checksum row, exactly like the totals COLUMNS: it is
    // the market-wide aggregate, so keeping it as a fifth participant would
    // double every sum computed over `rows`.
    if (label === "total" || label === "grand total") {
      if (totalCells === null) totalCells = cells;
      else bump("duplicateTotalRow");
      continue;
    }

    const participant = PARTICIPANT_ALIASES[label];
    if (!participant) {
      bump("unknownParticipant");
      continue;
    }
    if (seen.has(participant)) {
      bump("duplicateParticipant");
      continue;
    }
    seen.add(participant);

    let longSum = 0;
    let shortSum = 0;
    let allBucketsRead = true;

    for (const bucket of POSITIONING_BUCKETS) {
      const slot = columns.legs[bucket];
      const longQty = parseContractCount(cells[slot.long]);
      const shortQty = parseContractCount(cells[slot.short]);

      // The two legs are one observation: a net cannot be formed from half a
      // bucket, so a bucket missing either leg is dropped whole. The
      // participant's OTHER buckets survive — losing five good buckets because
      // one cell was a `-` would be a bigger lie than the gap itself.
      if (longQty === null || shortQty === null) {
        bump("nonFiniteLeg");
        allBucketsRead = false;
        continue;
      }
      // Contract counts cannot be negative. Counted, not dropped: a loose
      // accept is accidentally complete, and turning an unforeseen value into a
      // silent absence is how coverage shrinks without anyone noticing.
      if (longQty < 0 || shortQty < 0) bump("negativeQty");

      longSum += longQty;
      shortSum += shortQty;
      rows.push({ participant, bucket, longQty, shortQty });
    }

    // A partially-read row cannot be checksummed — its legs no longer add up to
    // anything the file claims. Reporting a mismatch there would be a fabricated
    // alarm; "could not verify" is a distinct outcome and is counted as one.
    if (!allBucketsRead) {
      bump("checksumSkipped");
      continue;
    }
    pushTotalsDiscrepancies(
      discrepancies,
      participant,
      cells,
      columns,
      longSum,
      shortSum,
      bump,
      "TOTAL_LONG",
      "TOTAL_SHORT",
    );
  }

  if (totalCells === null) {
    bump("noTotalRow");
  } else {
    verifyAgainstTotalRow(discrepancies, rows, totalCells, columns, bump);
  }

  return { tradingDate, measure, rows, discrepancies, reasons };
}

/**
 * Compare a row's six summed legs against its stated totals.
 *
 * A missing or unparseable totals cell is "could not check" — counted, never a
 * discrepancy. The two are different facts, and only one of them is evidence
 * about NSE's arithmetic.
 */
function pushTotalsDiscrepancies(
  out: PositioningDiscrepancy[],
  participant: ParticipantType | null,
  cells: readonly string[],
  columns: ResolvedColumns,
  longSum: number,
  shortSum: number,
  bump: (k: string) => void,
  longCode: PositioningDiscrepancyCode,
  shortCode: PositioningDiscrepancyCode,
): void {
  const checks: readonly [
    number,
    number,
    PositioningDiscrepancyCode,
    string,
  ][] = [
    [columns.totalLong, longSum, longCode, "TOTAL_LONG"],
    [columns.totalShort, shortSum, shortCode, "TOTAL_SHORT"],
  ];

  for (const [idx, computed, code, column] of checks) {
    if (idx < 0) continue;
    const stated = parseContractCount(cells[idx]);
    if (stated === null) {
      bump("unreadableStatedTotal");
      continue;
    }
    if (stated !== computed) {
      out.push({
        code,
        participant,
        column,
        stated,
        computed,
        delta: computed - stated,
      });
    }
  }
}

/**
 * Cross-check the four participants against NSE's own TOTAL row.
 *
 * This is a SECOND, independent axis on the same numbers: the totals columns
 * check each row across, this checks each column down. It earns its place — on
 * the 2026-08-13 OI file it catches an off-by-one in `Option Index Call Long`
 * that the row-wise check cannot see, because both the participant row and the
 * TOTAL row are internally consistent with their own stated totals.
 *
 * Buckets dropped for non-finite cells are skipped rather than compared against
 * a short sum, for the same reason `checksumSkipped` exists.
 */
function verifyAgainstTotalRow(
  out: PositioningDiscrepancy[],
  rows: readonly ParticipantPositioningRow[],
  totalCells: readonly string[],
  columns: ResolvedColumns,
  bump: (k: string) => void,
): void {
  let longSum = 0;
  let shortSum = 0;
  let complete = true;

  for (const bucket of POSITIONING_BUCKETS) {
    const present = rows.filter((r) => r.bucket === bucket);
    if (present.length !== POSITIONING_PARTICIPANTS.length) {
      complete = false;
      continue;
    }
    const slot = columns.legs[bucket];
    const sides: readonly [LegSide, number, number][] = [
      ["LONG", slot.long, present.reduce((a, r) => a + r.longQty, 0)],
      ["SHORT", slot.short, present.reduce((a, r) => a + r.shortQty, 0)],
    ];
    for (const [side, idx, computed] of sides) {
      const stated = parseContractCount(totalCells[idx]);
      if (stated === null) {
        bump("unreadableTotalRowCell");
        complete = false;
        continue;
      }
      if (side === "LONG") longSum += stated;
      else shortSum += stated;
      if (stated !== computed) {
        out.push({
          code: "PARTICIPANT_SUM",
          participant: null,
          column: `${bucket}_${side}`,
          stated,
          computed,
          delta: computed - stated,
        });
      }
    }
  }

  // The TOTAL row against its own stated totals — the same row-wise check, one
  // row lower. Skipped when any of its cells could not be read, so it never
  // reports a mismatch it manufactured itself.
  if (!complete) return;
  pushTotalsDiscrepancies(
    out,
    null,
    totalCells,
    columns,
    longSum,
    shortSum,
    bump,
    "GRAND_TOTAL_LONG",
    "GRAND_TOTAL_SHORT",
  );
}

// ─── Derivations ─────────────────────────────────────────────────────

/**
 * Net contracts, long − short.
 *
 * Derived rather than stored: the gross legs are what NSE publishes, and a
 * stored net would go stale against them the moment either leg is corrected.
 */
export function netContracts(row: ParticipantPositioningRow): number {
  return row.longQty - row.shortQty;
}

/** One (participant, bucket) compared against the previous trading day. */
export interface PositioningChange {
  participant: ParticipantType;
  bucket: PositioningBucket;
  longQty: number;
  shortQty: number;
  net: number;
  /** Null when the previous day has no row for this key — NOT zero. */
  prevLongQty: number | null;
  prevShortQty: number | null;
  prevNet: number | null;
  longChange: number | null;
  shortChange: number | null;
  netChange: number | null;
}

/** `participant|bucket` — the identity of a positioning cell across days. */
function changeKey(
  participant: ParticipantType,
  bucket: PositioningBucket,
): string {
  return `${participant}|${bucket}`;
}

/**
 * Day-over-day change, as a pure function over two days' rows.
 *
 * Two deliberate choices:
 *
 * **Missing previous ⇒ null, not 0.** A first day of history, a day NSE did not
 * publish, or a bucket dropped by the finite guard are all "we do not know what
 * changed". Substituting 0 for the previous value would print "FII added 3.5M
 * index-future longs today" on day one of the series and on every gap after it
 * — a fabricated headline number, from an absence.
 *
 * **Driven off TODAY's rows only.** A key present yesterday and absent today is
 * not a positioning change; it is a hole in today's parse, already counted in
 * `reasons`. Emitting it with today's quantity as 0 would turn a parser problem
 * into a market claim.
 *
 * Neither argument is mutated: output order follows `today`, and lookup is by
 * map rather than by sorting either input in place.
 */
export function diffPositioning(
  today: readonly ParticipantPositioningRow[],
  previous: readonly ParticipantPositioningRow[],
): PositioningChange[] {
  const prevByKey = new Map<string, ParticipantPositioningRow>();
  for (const row of previous) {
    prevByKey.set(changeKey(row.participant, row.bucket), row);
  }

  return today.map((row) => {
    const net = netContracts(row);
    const prev = prevByKey.get(changeKey(row.participant, row.bucket));
    if (!prev) {
      return {
        participant: row.participant,
        bucket: row.bucket,
        longQty: row.longQty,
        shortQty: row.shortQty,
        net,
        prevLongQty: null,
        prevShortQty: null,
        prevNet: null,
        longChange: null,
        shortChange: null,
        netChange: null,
      };
    }
    const prevNet = netContracts(prev);
    return {
      participant: row.participant,
      bucket: row.bucket,
      longQty: row.longQty,
      shortQty: row.shortQty,
      net,
      prevLongQty: prev.longQty,
      prevShortQty: prev.shortQty,
      prevNet,
      longChange: row.longQty - prev.longQty,
      shortChange: row.shortQty - prev.shortQty,
      netChange: net - prevNet,
    };
  });
}
