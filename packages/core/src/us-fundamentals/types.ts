/**
 * Shapes for the US fundamentals SERVING seam (MONEY-979, T10).
 *
 * This package is READ-ONLY. Every row in `us_*` is written by
 * `services/us-fundamentals/` (Python, edgartools 5.53.0). Nothing here
 * inserts, updates or fetches from sec.gov — a raw `fetch()` at `data.sec.gov`
 * or `efts.sec.gov` fails `no-feed-fetch-bypass.test.ts` by file and line.
 *
 * ## Three properties every read here has, because each has already cost a
 * release somewhere in this repo
 *
 *   1. **`currency` is on the ROW.** Not implied, not in a comment, not
 *      configured. Every existing financial consumer in this codebase
 *      hardcodes a rupee symbol, and a currency-less amount is exactly how a
 *      $391B revenue renders as `₹391,035 Cr` (MONEY-979 decision 10).
 *   2. **An empty result carries a NAMED REASON.** "We hold nothing for this
 *      symbol", "this symbol is not in the US universe" and "we could not
 *      reach the cold shard" are three different facts, and collapsing them
 *      into `[]` is the MONEY-941 / MONEY-1189 shape — a completeness check
 *      that reports SUCCESS for work that never happened.
 *   3. **`degraded` is separate from `reason`.** A result can be NON-empty and
 *      still incomplete (a hot read succeeded, a cold shard failed). A caller
 *      that sums those rows must be able to know it is summing a subset.
 */

/* ─────────────────────────────────────────────────────────────────────────
   Enumerations, spelled as the writers spell them
   ──────────────────────────────────────────────────────────────────────── */

/** `UsFundamentals.statementType`. */
export type UsStatementType = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";

/** `UsFundamentals.periodType`. */
export type UsPeriodType = "ANNUAL" | "QUARTERLY";

/** Where the rows in a result actually came from. */
export type UsReadOrigin =
  /** Mongo. */
  | "DB"
  /** A gzipped JSONL shard on GCS (an evicted 13F quarter). */
  | "COLD"
  /** Both, merged. */
  | "DB+COLD"
  /** Nothing was returned. `reason` says why. */
  | "NONE";

/* ─────────────────────────────────────────────────────────────────────────
   The envelope
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Every read returns this. `rows` is never `null` and the call never throws for
 * a data condition — only for a genuinely broken driver.
 */
export interface UsReadResult<T> {
  rows: T[];
  /**
   * The newest row's OWN date (ISO), never the time of the fetch. `null` when
   * `rows` is empty. A fetch time here would make a five-month-stale table look
   * fresh, which is precisely how the Tickertape block hid for five months.
   */
  asOf: string | null;
  /** Always `"USD"`. Restated on the envelope as well as on every row. */
  currency: "USD";
  origin: UsReadOrigin;
  /**
   * Why `rows` is empty, or why it is incomplete. One of the `REASON_*`
   * constants in `repository.ts`. `null` only when the result is complete AND
   * non-empty.
   */
  reason: string | null;
  /**
   * TRUE when some of the answer could not be read (a failed cold shard, a
   * missing prior period). The rows present are still correct; they are not
   * all of them.
   */
  degraded: boolean;
}

/* ─────────────────────────────────────────────────────────────────────────
   Rows
   ──────────────────────────────────────────────────────────────────────── */

/**
 * One point-in-time statement, as filed.
 *
 * `standardized` is keyed by edgartools' STANDARD TAGS — the `standard_tags`
 * values from `edgar/xbrl/standardization/gaap_mappings.json` (`Revenue`,
 * `NetCashFromOperatingActivities`, `CommonEquity`).
 *
 * NOT the human `display_name` spellings ("Net Cash from Operating Activities",
 * "Total Stockholders' Equity") and NOT raw us-gaap tags. This comment used to
 * name the display vocabulary, and the reader table was built to match it; the
 * two overlap in exactly one string, so every statement rendered as revenue
 * alone. `edgartools-standard-tags.ts` is the generated universe and
 * `__tests__/us-fundamentals/concept-vocabulary.test.ts` enforces membership.
 * `US_CONCEPT_TO_STATEMENT_FIELD` in `repository-logic.ts` is the only place
 * that translation is spelled.
 */
export interface UsStatementRow {
  cik10: string;
  symbol: string | null;
  statementType: UsStatementType;
  periodType: UsPeriodType;
  periodStart: Date | null;
  periodEnd: Date;
  fiscalYear: number;
  fiscalPeriod: string;

  accession: string;
  form: string;
  filedAt: Date;
  isAmendment: boolean;
  isLatest: boolean;

  currency: "USD";

  /** `{ "Revenue": 391035000000, …, "_fallbacks": {…} }`. */
  standardized: Record<string, unknown>;
  /** `[{concept, label, value, unit, dimensions?}]`, exactly as tagged. */
  asReported: unknown;

  mappingSource: string;
  mappingVersion: string;
  parserVersion: string;
}

/** One line of a Form 3/4/5 transaction or holding table. */
export interface UsInsiderRow {
  accession: string;
  rowIndex: number;

  issuerCik10: string;
  issuerName: string;
  symbol: string | null;

  ownerCik10: string;
  ownerName: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPctOwner: boolean;
  officerTitle: string | null;

  form: string;
  transactionDate: Date | null;
  filedAt: Date;

  securityTitle: string;
  isDerivative: boolean;
  /** A disclosed position, not a trade. Excluded from every activity total. */
  isHolding: boolean;

  transactionCode: string | null;
  codeMeaning: string | null;
  /** EDGAR appends "K" to a DISPLAYED code when this is set; the code stays clean. */
  equitySwap: boolean;

  /** `"A"` acquired | `"D"` disposed | null. */
  acquiredDisposed: string | null;
  shares: number | null;
  price: number | null;
  /**
   * `shares × price` when both exist. ABSENT, never zero, when either is
   * missing — a gift (code G) has no price, and a zero reads as a free
   * transfer of nothing rather than an untold value.
   */
  value: number | null;
  sharesOwnedAfter: number | null;
  directIndirect: string | null;

  currency: "USD";
  isAmendment: boolean;
}

/** One 13F information-table row, hot or cold. */
export interface UsHoldingRow {
  accession: string;
  rowIndex: number;

  managerCik10: string;
  /** Denormalised from `us_13f_filings`; `null` on a cold row that lacks it. */
  managerName: string | null;
  periodOfReport: Date;
  filedAt: Date;

  cusip: string;
  figi: string | null;
  issuerName: string;
  titleOfClass: string;

  /** ALWAYS whole US dollars, whatever the filing said (`valueUnitRule`). */
  valueUsd: number;
  shares: number;
  /** `"SH"` shares | `"PRN"` principal. A PRN row's "shares" are dollars of face value. */
  sharesType: string;
  /** `"Put"` | `"Call"` | null. An options position is not a share position. */
  putCall: string | null;

  symbol: string | null;
  currency: "USD";
}

/**
 * One holder of one issuer, with its quarter-on-quarter change.
 *
 * `isExited` rows have `shares === 0` and `valueUsd === 0` with NEGATIVE
 * deltas. They are the whole reason this type exists: a "top holders" list that
 * silently drops the manager who sold out is a list that cannot show a seller.
 */
export interface UsHolderDelta {
  managerCik10: string;
  managerName: string | null;
  cusip: string;
  symbol: string | null;
  issuerName: string;
  /**
   * Put | Call | null, and SH | PRN — part of the row's IDENTITY.
   *
   * One manager legitimately files several 13F rows for one CUSIP: the share
   * position, a Put, a Call, and for a bond a PRN row whose "shares" are
   * dollars of face value. They are separate rows here, so a reader that sees
   * "APPLE INC" twice with different numbers needs these to tell them apart.
   */
  putCall: string | null;
  sharesType: string;
  /**
   * How many FILED rows this position sums.
   *
   * SEC lets one manager file the same CUSIP once per `otherManagers`
   * combination, so `> 1` is normal — Berkshire files twelve rows for Apple.
   * Surfaced so a reader can tell a summed position from a single filed row
   * rather than wondering why the number differs from any one row in EDGAR.
   */
  rowsAggregated: number;

  shares: number;
  valueUsd: number;
  sharesDelta: number;
  valueDelta: number;
  isNew: boolean;
  isExited: boolean;

  /** Newest accession that evidences this row (current, or the prior one for an exit). */
  accession: string;
  filedAt: Date;
  periodOfReport: Date;
  currency: "USD";
}

/** One reporting person on a Schedule 13D or 13G. */
export interface UsBeneficialOwnerRow {
  accession: string;
  rowIndex: number;

  /** `"13D"` | `"13G"` — normalised. `form` keeps the string as filed. */
  schedule: string;
  form: string;
  isAmendment: boolean;

  subjectCik10: string;
  subjectName: string;
  cusip: string | null;
  symbol: string | null;

  filerCik10: string | null;
  filerName: string;

  percentOfClass: number | null;
  sharesOwned: number | null;
  typeOfReportingPerson: string | null;

  eventDate: Date | null;
  filedAt: Date;
  /** 13D Item 4 — activist intent vs passive investment. 13G structurally has none. */
  purposeText: string | null;
  /**
   * FALSE for every filing before the 2024-12-18 XML mandate. A null
   * `percentOfClass` on a 2019 filing means "not machine-readable", NOT "zero";
   * without this flag those two are indistinguishable.
   */
  hasStructuredData: boolean;

  currency: "USD";
}

/** One filing from the ledger. */
export interface UsFilingRow {
  accession: string;
  cik10: string;
  form: string;
  filedAt: Date;
  /** The acceptance TIMESTAMP. Only this one can measure detection latency. */
  acceptedAt: Date | null;
  periodOfReport: Date | null;
  items: string[];
  primaryDocument: string | null;
  isXbrl: boolean;
  parseClass: string;
  status: string;
  currency: "USD";
}

/* ─────────────────────────────────────────────────────────────────────────
   Derived summaries
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The classes a Form 4 transaction code falls into.
 *
 * Summing every code into one "net insider activity" number is MEANINGLESS and
 * this enum is what stops it: an `F` is shares withheld to pay the tax on a
 * vesting grant — a mechanical consequence of compensation, not a decision to
 * sell — while an `S` is an open-market sale. Reporting them in one bucket
 * turns every vesting event into insider selling.
 */
export type UsInsiderCodeClass =
  /** P — open market or private purchase. */
  | "OPEN_MARKET_BUY"
  /** S — open market or private sale. */
  | "OPEN_MARKET_SELL"
  /** A — grant, award or other acquisition from the issuer. */
  | "AWARD"
  /** F — payment of exercise price or tax by delivering/withholding securities. */
  | "TAX_WITHHOLDING"
  /** G — bona fide gift. */
  | "GIFT"
  /** M, X — exercise or conversion of a derivative. */
  | "EXERCISE"
  /** Every other code in SEC's 20-code `TransCodeList`. */
  | "OTHER";

/** Per-class totals. */
export interface UsInsiderClassTotal {
  /** The distinct SEC codes that landed in this class, sorted. */
  codes: string[];
  rows: number;
  /** Signed by `acquiredDisposed`: acquired positive, disposed negative. */
  shares: number;
  /**
   * Signed value, or `null` when NOT ONE row in the class carried a price.
   * `0` would claim the transfers were worth nothing.
   */
  value: number | null;
}

export interface UsInsiderActivitySummary {
  windowDays: number;
  /** Anchor of the window — the NEWEST `transactionDate` in the input. */
  anchor: string | null;
  from: string | null;
  to: string | null;
  rowsCounted: number;
  /** Holdings, rows with no code, and rows outside the window. */
  rowsSkipped: number;
  byClass: Record<UsInsiderCodeClass, UsInsiderClassTotal>;
  /** P minus S only. Awards, withholdings, gifts and exercises are excluded. */
  netOpenMarketShares: number;
  netOpenMarketValue: number | null;
  currency: "USD";
}

/** One filer's coverage facts, as `judgeCoverage` needs them. */
export interface UsCoverageFiler {
  /** `UsFiler.eligibleForCoverage` — has 5+ fiscal years AT SEC. */
  eligibleForCoverage: boolean;
  /** `UsFiler.fiscalYearsOnFile` — how many SEC has. */
  fiscalYearsOnFile: number;
  /** Distinct fiscal years we actually hold statements for. */
  statementYears: number;
}

export interface UsCoverageJudgement {
  eligible: number;
  eligibleCovered: number;
  ineligible: number;
  ineligibleWithAllAvailable: number;
  /** THE GATE. Over eligible filers only. 0-100, never NaN. */
  pct: number;
  /**
   * Observability only, never the gate: both buckets counted as satisfied.
   * Reported so an ineligible filer missing years is VISIBLE rather than
   * excluded silently.
   */
  overallPct: number;
  filers: number;
}
