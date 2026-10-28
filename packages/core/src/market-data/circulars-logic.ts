/**
 * NSE exchange-communication circulars — MONEY-1187 (Data Engine P11, item 7).
 *
 * Pure parsing for `GET https://www.nseindia.com/api/circulars?fromDate=DD-MM-YYYY&toDate=DD-MM-YYYY`.
 * No I/O, no DB, no fetch: this module takes the ALREADY-PARSED JSON and turns
 * it into typed rows. Fetching is the worker's job and goes through
 * `getFeedAsset` like every other feed (MONEY-1085), so archive/replay/QA-mirror
 * keep working unchanged.
 *
 * ## The response is WRAPPED, and that is the whole bug class
 *
 * Live-probed 2026-08-13 (window 01-08-2026 → 13-08-2026, 237 records):
 *
 *   { "data": [ …237 records… ], "fromDate": "01-08-2026", "toDate": "13-08-2026" }
 *
 * NOT a bare array. A parser that does `payload as Circular[]` against this gets
 * `undefined`/zero rows out of a perfectly healthy 200 response and reports it
 * upstream as "no circulars today" — which is indistinguishable from a quiet
 * weekend and reads as success in every log line. That is the same failure shape
 * as MONEY-1175 and MONEY-1189: a completeness check at the wrong granularity,
 * reporting SUCCESS. So the wrapper is asserted explicitly and a bare array is a
 * hard `null` (see {@link parseCircularsResponse}).
 *
 * ## Three outcomes, not two — "empty" must not collapse into "broken"
 *
 * The empty case is REAL and was captured live: 08-08-2026 → 09-08-2026 (a
 * Saturday/Sunday) returns HTTP 200 with `{"data":[],…}`. So callers must be
 * able to tell apart:
 *
 *   `null`             the shape is unrecognised — we could NOT determine anything
 *   `outcome: "EMPTY"` determined: NSE published nothing in this window
 *   `outcome: "ROWS"`  determined: n circulars
 *
 * Collapsing the last two into "the array is empty" is the recurring burn in
 * this repo — `[]` ends up meaning both "nothing happened" and "we failed", and
 * the failure is then invisible forever. Keying on DETERMINACY rather than on
 * the value is why {@link CircularsFile.outcome} exists as its own field instead
 * of the caller reading `circulars.length === 0`.
 *
 * ## The 13 real fields
 *
 * All 237 records carried exactly the same 13 keys, no nulls, no empty strings:
 *
 *   cirDate         "20260813"          IST calendar day, YYYYMMDD
 *   cirDisplayDate  "August 13, 2026"   human copy of the same day
 *   circCategory    "Listing"           6 observed values
 *   circCompany     "NSE" | "NCL"       issuing entity (NCL = NSE Clearing)
 *   circDepartment  "Listing"           15 observed values
 *   circDisplayNo   "NSE/CML/75738"     the number as printed on the circular
 *   circFileSize    "744 KB"            HUMAN string, rounded — see below
 *   circFilelink    "https://nsearchives.nseindia.com/content/circulars/CML75738.zip"
 *   circFilename    "CML75738.zip"
 *   circNumber      "75738"             the bare serial
 *   fileDept        "CML"               16 observed values, the filename prefix
 *   fileExt         "zip" | "pdf"
 *   sub             the subject line
 *
 * ## There is NO effective-date field — deliberately not modelled
 *
 * The API carries the ISSUE date and nothing else. No `effectiveDate`,
 * `wefDate`, or equivalent appears on any of the 237 records. An
 * always-`null` `effectiveDate` property would be worse than its absence: it
 * advertises a datum this endpoint cannot supply, and the first caller to read
 * it would conclude "no circular has an effective date" rather than "this feed
 * does not carry one". Effective dates live in the circular BODY (the linked
 * PDF/zip), and text extraction is explicitly out of scope here.
 *
 * ## Attachments
 *
 * Every record linked a file on `nsearchives.nseindia.com`. Probed 2026-08-13
 * against `content/circulars/CML75737.pdf`:
 *
 *   - `HEAD` returns **503** on that host. A ranged `GET` (`Range: bytes=0-0`)
 *     returns **206** + `content-type: application/pdf` +
 *     `content-range: bytes 0-0/374086`. Anyone writing the fetch half should
 *     size-probe with a ranged GET, not HEAD, or they will conclude the whole
 *     archive is down.
 *   - **No cookies required.** Byte-identical results with and without the
 *     `www.nseindia.com` cookie jar, so attachments do NOT need the handshake
 *     that the JSON API needs.
 *   - `circFileSize` is APPROXIMATE: that file is labelled "366 KB" and is
 *     actually 374,086 bytes (365.3 KiB, rounded up). Hence
 *     {@link CircularAttachment.approxSizeBytes} is named for what it is —
 *     a derived estimate, never to be used as a content-length assertion.
 */

// ─── Topics ──────────────────────────────────────────────────────────

/**
 * A closed set of retail-investor-meaningful topics.
 *
 * Sized from the 237-record live sample rather than invented, so every member
 * except the catch-all is backed by observed volume:
 *
 *   LISTING          87  "Listing"(77) + "Emerge"(10) departments
 *   MUTUAL_FUND      44  NFO launches, IDCW changes, SIP amendments
 *   SURVEILLANCE     45  ASM / ST-ASM / ESM applicability, SEBI orders
 *   SETTLEMENT       12  settlement calendars, multiple-settlement notices
 *   TECHNOLOGY       14  mock trading, Extranet beta, member interface testing
 *   COMPLIANCE        6  KYC/KRA, UAPA sanctions, membership surrender
 *   CORPORATE_ACTION   2+ "DIVIDEND: Adjustment of F&O contracts in HINDPETRO"
 *   MARGIN            1  "API Facility in NMASS-Margins-SLB"
 *   TRADING_HOLIDAY   0  none in this window; NSE issues them a few times a year
 *
 * `OTHER` is NOT a failure state and NOT a leftover — it is the required
 * catch-all. The house lesson (MONEY-1093, and again in the surveillance-path
 * narrowing) is that replacing a loose matcher with a precise one WITHOUT a
 * catch-all creates a brand-new failure path: rows that used to be handled
 * loosely start being dropped, and coverage SHRINKS while the diff looks like an
 * improvement. {@link classifyCircular} therefore always terminates in `OTHER`
 * and can never throw or return undefined.
 */
export type CircularTopic =
  | "TRADING_HOLIDAY"
  | "SURVEILLANCE"
  | "MARGIN"
  | "LISTING"
  | "SETTLEMENT"
  | "TECHNOLOGY"
  | "COMPLIANCE"
  | "CORPORATE_ACTION"
  | "MUTUAL_FUND"
  | "OTHER";

/** Every topic, for exhaustiveness tests and UI filter chips. */
export const CIRCULAR_TOPICS: readonly CircularTopic[] = [
  "TRADING_HOLIDAY",
  "SURVEILLANCE",
  "MARGIN",
  "LISTING",
  "SETTLEMENT",
  "TECHNOLOGY",
  "COMPLIANCE",
  "CORPORATE_ACTION",
  "MUTUAL_FUND",
  "OTHER",
] as const;

// ─── Row types ───────────────────────────────────────────────────────

export interface CircularAttachment {
  /** Absolute http(s) URL on `nsearchives.nseindia.com`. */
  url: string;
  filename: string;
  /** Lowercased, no dot: `"pdf"` / `"zip"`. */
  ext: string;
  /** NSE's human string, verbatim — e.g. `"366 KB"`. */
  sizeLabel: string;
  /**
   * Bytes derived from {@link sizeLabel}, or `null` when it cannot be read.
   *
   * APPROXIMATE by construction: NSE rounds up to whole KiB, so the file
   * labelled "366 KB" is really 374,086 bytes. Never compare this to a
   * content-length for integrity checking — it will not match.
   */
  approxSizeBytes: number | null;
}

export interface Circular {
  /** Bare serial, e.g. `"75738"`. */
  number: string;
  /** As printed, e.g. `"NSE/CML/75738"`. */
  displayNumber: string;
  subject: string;
  /** NSE's own `circCategory`, verbatim. Open set — do not switch on it. */
  category: string;
  /** NSE's own `circDepartment`, verbatim. Open set. */
  department: string;
  /** Filename prefix / short department code, e.g. `"CML"`. */
  departmentCode: string;
  /** Issuing entity: `"NSE"` or `"NCL"` (NSE Clearing) in the live sample. */
  company: string;
  /**
   * UTC midnight of the IST calendar day the circular was issued.
   *
   * `cirDate` is ALREADY an IST calendar day (`"20260813"`), so there is no
   * timezone arithmetic to do — only a timezone MISTAKE to avoid. Both obvious
   * spellings are wrong: `new Date("20260813")` is parsed inconsistently across
   * engines, and `new Date(2026, 7, 13)` is LOCAL midnight, which silently
   * shifts the day on every non-UTC server. `Date.UTC` is the only spelling that
   * is stable, and it matches `utcMidnightOf` in feed-backfill-logic.ts.
   */
  issuedAt: Date;
  /** NSE's human date string, verbatim — e.g. `"August 13, 2026"`. */
  issuedDateLabel: string;
  /** `null` when the record carried no usable link. Visibly absent, never faked. */
  attachment: CircularAttachment | null;
  topic: CircularTopic;
}

/** Why a row was dropped. Every reason is a REJECT, never a coercion. */
export type CircularRejectReason =
  | "NOT_AN_OBJECT"
  | "MISSING_NUMBER"
  | "MISSING_SUBJECT"
  | "BAD_DATE";

/**
 * A row that could not be parsed.
 *
 * Dropped rows are COUNTED and CARRIED rather than silently skipped: a feed that
 * quietly loses 3 of 237 rows every day looks identical to a healthy one, and
 * the loss is only ever discovered by someone reconciling numbers months later.
 */
export interface RejectedCircular {
  reason: CircularRejectReason;
  /** Index within the upstream `data` array, so the row can be found again. */
  index: number;
  /** Raw values as received — never coerced, `null` when absent/not a string. */
  rawNumber: string | null;
  rawDate: string | null;
}

/**
 * Determinate outcome of a well-formed response.
 *
 * A separate field rather than an inferred `length === 0` so that "NSE published
 * nothing" is a distinct VALUE that can be logged, asserted and alerted on.
 */
export type CircularsOutcome = "ROWS" | "EMPTY";

export interface CircularsFile {
  outcome: CircularsOutcome;
  circulars: Circular[];
  /** Echoed `fromDate`/`toDate` (`DD-MM-YYYY`), or `null` if absent. */
  fromDate: string | null;
  toDate: string | null;
  /** Rows present upstream but unparseable. Empty on a clean response. */
  rejected: RejectedCircular[];
}

// ─── Field helpers ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A non-empty trimmed string, or `null`.
 *
 * Whitespace-only is treated as ABSENT rather than present-but-blank: a
 * `" "` subject is not a subject, and letting it through would put a blank row
 * in front of a user.
 */
function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * `"YYYYMMDD"` (IST calendar day) → UTC-midnight `Date`, or `null`.
 *
 * REJECTS rather than coerces. The failure modes this exists to prevent are the
 * ones that produce a plausible-looking wrong answer:
 *   - `new Date(undefined)` → Invalid Date, which then poisons every downstream
 *     comparison silently (the non-finite class from `fixing-bugs`).
 *   - falling back to `new Date()` → a circular from 2019 dated today.
 *   - falling back to `0` → epoch, which sorts first forever.
 *
 * The round-trip check is load-bearing: `Date.UTC(2026, 1, 30)` happily returns
 * 2026-03-02 rather than failing, so range-checking the digits is not enough to
 * reject an impossible calendar day.
 */
export function parseCircularDate(raw: unknown): Date | null {
  const s = str(raw);
  if (s === null) return null;
  if (!/^\d{8}$/.test(s)) return null;

  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));

  // Cheap range gate before the round-trip, so month 00/13 never reaches Date.
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // NSE's oldest circulars predate the API; anything outside this is a
  // transcription error, not history.
  if (y < 1990 || y > 2100) return null;

  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;

  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== m - 1 ||
    back.getUTCDate() !== d
  ) {
    return null; // e.g. "20260230" — normalised by Date.UTC, so caught here.
  }
  return back;
}

const SIZE_UNITS: ReadonlyMap<string, number> = new Map([
  ["b", 1],
  ["kb", 1024],
  ["mb", 1024 * 1024],
  ["gb", 1024 * 1024 * 1024],
]);

/**
 * `"366 KB"` → 374,784-ish bytes, or `null`.
 *
 * Best-effort and documented as such. Returns `null` — not `0` — for anything
 * unreadable, because `0` is a legitimate size and would make an unparseable
 * label indistinguishable from an empty file.
 */
export function parseFileSizeLabel(raw: unknown): number | null {
  const s = str(raw);
  if (s === null) return null;

  const m = /^([\d.,]+)\s*(b|kb|mb|gb)$/i.exec(s);
  if (m === null) return null;

  const n = Number(m[1]!.replace(/,/g, ""));
  // Guards NaN and Infinity at the boundary: "1e999 KB" parses to Infinity and
  // would otherwise propagate as a number nothing downstream can divide by.
  if (!Number.isFinite(n) || n < 0) return null;

  const unit = SIZE_UNITS.get(m[2]!.toLowerCase());
  if (unit === undefined) return null;

  const bytes = Math.round(n * unit);
  return Number.isFinite(bytes) ? bytes : null;
}

/** Absolute http(s) URL, or `null`. Anything else is treated as no attachment. */
function httpUrl(raw: unknown): string | null {
  const s = str(raw);
  if (s === null) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

// ─── Classifier ──────────────────────────────────────────────────────

/**
 * Lowercase, punctuation-stripped, space-padded — so `includes(" foo ")` is a
 * WORD-BOUNDARY match rather than a substring match.
 *
 * This is not defensive styling, it is a bug found in the live sample. Naive
 * `subject.includes("system")` matches "**System**atic Investment Plan (SIP)"
 * and files a mutual-fund SIP amendment under TECHNOLOGY. Naive
 * `includes("ban")` matches "Nifty **Ban**k ETF" and "**Bal**anced" and files
 * them under an F&O ban. Padding turns both into non-matches for free, and
 * keeps multi-word phrases ("trading holiday") exact.
 *
 * Note this also normalises NSE's inconsistent punctuation: `"ST-ASM"`,
 * `"(ASM)"` and `"ASM"` all collapse to the same token.
 */
function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

function hasAny(haystack: string, phrases: readonly string[]): boolean {
  for (const p of phrases) {
    if (haystack.includes(` ${p} `)) return true;
  }
  return false;
}

/**
 * Subject phrases that are decisive REGARDLESS of the issuing department.
 *
 * These run before the department map because the live sample proves they cut
 * across it: the single "Mock trading on Saturday, August 08, 2026" notice was
 * issued separately by Capital Market, EGR, Commodity Derivatives, SLBS and
 * Currency Derivatives. Letting the department decide would file one
 * announcement under five different topics.
 */
const DECISIVE_SUBJECT_RULES: readonly (readonly [
  CircularTopic,
  readonly string[],
])[] = [
  [
    "TRADING_HOLIDAY",
    ["trading holiday", "trading holidays", "holiday", "holidays", "muhurat"],
  ],
  [
    "TECHNOLOGY",
    [
      "mock trading",
      "mock session",
      "mock",
      "extranet",
      "api",
      "saas",
      "software",
      "member interface testing",
      "connectivity",
      "colocation",
      "co location",
    ],
  ],
  [
    "CORPORATE_ACTION",
    [
      // An F&O contract adjustment happens ONLY for a corporate action, so the
      // phrase is decisive on its own. It has to be listed separately from
      // "dividend" because NSE issues the same event both ways: the live sample
      // contains "DIVIDEND: Adjustment of Futures and Options contracts in the
      // security INDUSTOWER" AND "Adjustment of Futures and Options contracts in
      // the security INDUS TOWERS LIMITED (INDUSTOWER)" — same action, one
      // prefixed and one not. Matching only the prefix files half of them under
      // OTHER, which is precisely the coverage hole this taxonomy is meant to
      // avoid.
      "adjustment of futures and options",
      "dividend",
      "bonus",
      "stock split",
      "sub division",
      "rights issue",
      "demerger",
      "amalgamation",
      "scheme of arrangement",
      "buyback",
      "buybacks",
      "buy back",
    ],
  ],
];

/**
 * NSE's own department → topic, for departments that map unambiguously.
 *
 * DELIBERATELY PARTIAL. Segment names ("Futures & Options", "Currency
 * Derivatives", "Debt Segment", "Electronic Gold Receipt") describe WHERE a
 * circular came from, not WHAT it is about — their rows in the live sample span
 * settlement calendars, dividend adjustments and mock-trading notices alike.
 * Mapping them would assign a topic on no evidence, so they are left out and
 * their rows fall through to the subject rules below.
 */
const DEPARTMENT_TOPICS: ReadonlyMap<string, CircularTopic> = new Map([
  ["surveillance & investigation", "SURVEILLANCE"],
  ["listing", "LISTING"],
  ["emerge", "LISTING"],
  ["mutual fund", "MUTUAL_FUND"],
  ["nse clearing - capital market", "SETTLEMENT"],
  ["inspection & compliance", "COMPLIANCE"],
  ["legal, isc & arbitration", "COMPLIANCE"],
]);

/** Weaker subject signals, consulted after the department map. */
const SUBJECT_RULES: readonly (readonly [CircularTopic, readonly string[]])[] =
  [
    [
      "SURVEILLANCE",
      [
        "surveillance",
        "asm",
        "esm",
        "gsm",
        "st asm",
        "sebi order",
        "sebi orders",
      ],
    ],
    [
      "MARGIN",
      [
        "margin",
        "margins",
        "collateral",
        "haircut",
        "haircuts",
        "span",
        "var",
        "exposure limit",
        "exposure limits",
      ],
    ],
    [
      "SETTLEMENT",
      [
        "settlement",
        "settlements",
        "pay in",
        "payin",
        "pay out",
        "payout",
        "clearing",
        "auction",
      ],
    ],
    ["LISTING", ["listing", "listed", "delisting", "ipo", "suspension"]],
    [
      "COMPLIANCE",
      [
        "kyc",
        "kra",
        "uapa",
        "compliance",
        "membership",
        "arbitration",
        "penalty",
        "penalties",
      ],
    ],
  ];

/**
 * NSE's `circCategory` → topic, the LAST signal before the catch-all.
 *
 * Weakest on purpose: all 45 surveillance circulars in the live sample carry
 * `circCategory: "Compliance"`. Consulting the category first would file every
 * ASM/ESM notice under COMPLIANCE and leave SURVEILLANCE permanently empty —
 * the taxonomy would look fine and be wrong. Order here is the correctness
 * property, not a preference.
 */
const CATEGORY_TOPICS: ReadonlyMap<string, CircularTopic> = new Map([
  ["listing", "LISTING"],
  ["clearing", "SETTLEMENT"],
  ["trading, clearing & settlement", "SETTLEMENT"],
  ["compliance", "COMPLIANCE"],
]);

export interface ClassifiableCircular {
  subject: string;
  department: string;
  category: string;
}

/**
 * Tag a circular with exactly one {@link CircularTopic}.
 *
 * Total: every input returns a topic, and the final `return "OTHER"` is
 * unconditional. There is no throw and no `undefined` path — see the catch-all
 * note on {@link CircularTopic} for why that is a hard requirement here.
 *
 * Precedence, highest first:
 *   1. decisive subject phrases (cross-departmental — holidays, tech, corp actions)
 *   2. NSE's department       (its own structural assignment)
 *   3. remaining subject phrases
 *   4. NSE's category         (weakest — see CATEGORY_TOPICS)
 *   5. OTHER
 */
export function classifyCircular(c: ClassifiableCircular): CircularTopic {
  const subject = normalize(c.subject);

  for (const [topic, phrases] of DECISIVE_SUBJECT_RULES) {
    if (hasAny(subject, phrases)) return topic;
  }

  const byDept = DEPARTMENT_TOPICS.get(c.department.trim().toLowerCase());
  if (byDept !== undefined) return byDept;

  for (const [topic, phrases] of SUBJECT_RULES) {
    if (hasAny(subject, phrases)) return topic;
  }

  const byCategory = CATEGORY_TOPICS.get(c.category.trim().toLowerCase());
  if (byCategory !== undefined) return byCategory;

  // The catch-all. Roughly a fifth of the live sample lands here legitimately
  // (mutual-fund platform mechanics, ISIN changes, liquidity-enhancement
  // schemes). An unrecognised circular is CLASSIFIED as OTHER, never dropped.
  return "OTHER";
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse one `/api/circulars` response.
 *
 * @param payload ALREADY-PARSED JSON (`unknown`), not a string and not a fetch.
 * @returns `null` when the shape is unrecognised; otherwise a
 *          {@link CircularsFile} whose `outcome` distinguishes "NSE published
 *          nothing" from "n circulars".
 *
 * ## Why a bare top-level array is rejected rather than tolerated
 *
 * It would be easy to also accept `[...]` "just in case". That is declined
 * deliberately: this endpoint is live-verified to serve the wrapper, so a bare
 * array arriving here means NSE changed the contract. Being lenient would
 * absorb that change silently; returning `null` makes it a loud, determinate
 * "I do not recognise this" that a caller can alert on. Same reasoning as the
 * report-registry's refusal to ship guessed URLs — a wrong shape that appears to
 * work is worse than one that visibly does not.
 *
 * A malformed ROW does not fail the file. Losing 236 good circulars because the
 * 237th has a typo'd date would be its own outage; the bad row goes to
 * `rejected` where it stays countable.
 */
export function parseCircularsResponse(payload: unknown): CircularsFile | null {
  if (!isRecord(payload)) return null;

  const data = payload["data"];
  if (!Array.isArray(data)) return null;

  const circulars: Circular[] = [];
  const rejected: RejectedCircular[] = [];

  for (let i = 0; i < data.length; i++) {
    const row: unknown = data[i];

    if (!isRecord(row)) {
      rejected.push({
        reason: "NOT_AN_OBJECT",
        index: i,
        rawNumber: null,
        rawDate: null,
      });
      continue;
    }

    const rawNumber = str(row["circNumber"]);
    const rawDate = str(row["cirDate"]);
    const subject = str(row["sub"]);

    if (rawNumber === null) {
      rejected.push({
        reason: "MISSING_NUMBER",
        index: i,
        rawNumber: null,
        rawDate,
      });
      continue;
    }
    if (subject === null) {
      rejected.push({
        reason: "MISSING_SUBJECT",
        index: i,
        rawNumber,
        rawDate,
      });
      continue;
    }

    const issuedAt = parseCircularDate(rawDate);
    if (issuedAt === null) {
      // Rejected, NOT coerced to epoch/today — see parseCircularDate.
      rejected.push({ reason: "BAD_DATE", index: i, rawNumber, rawDate });
      continue;
    }

    // Absent optional fields stay visibly absent (empty string / null), never
    // defaulted to something that reads as real data.
    const category = str(row["circCategory"]) ?? "";
    const department = str(row["circDepartment"]) ?? "";

    const url = httpUrl(row["circFilelink"]);
    const attachment: CircularAttachment | null =
      url === null
        ? null
        : {
            url,
            filename: str(row["circFilename"]) ?? "",
            ext: (str(row["fileExt"]) ?? "").toLowerCase().replace(/^\./, ""),
            sizeLabel: str(row["circFileSize"]) ?? "",
            approxSizeBytes: parseFileSizeLabel(row["circFileSize"]),
          };

    circulars.push({
      number: rawNumber,
      displayNumber: str(row["circDisplayNo"]) ?? rawNumber,
      subject,
      category,
      department,
      departmentCode: str(row["fileDept"]) ?? "",
      company: str(row["circCompany"]) ?? "",
      issuedAt,
      issuedDateLabel: str(row["cirDisplayDate"]) ?? "",
      attachment,
      topic: classifyCircular({ subject, department, category }),
    });
  }

  return {
    // Determinacy, not length: a caller logging `outcome` records that NSE was
    // asked and answered "nothing", which a `0` alone cannot express.
    outcome: circulars.length > 0 ? "ROWS" : "EMPTY",
    circulars,
    fromDate: str(payload["fromDate"]),
    toDate: str(payload["toDate"]),
    rejected,
  };
}

/** Count by topic. Every topic is present, zeros included, so a disappearing
 * category is visible as a 0 rather than as a missing key. */
export function countByTopic(
  circulars: readonly Circular[],
): Record<CircularTopic, number> {
  const out = {} as Record<CircularTopic, number>;
  for (const t of CIRCULAR_TOPICS) out[t] = 0;
  for (const c of circulars) out[c.topic] += 1;
  return out;
}
