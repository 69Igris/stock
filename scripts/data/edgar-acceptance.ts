#!/usr/bin/env tsx
/**
 * MONEY-979 T12 — the branch's stated acceptance, executable.
 *
 * For **AAPL, MSFT and BRK.B** it reads every capability this branch claims and
 * prints the answer with `accession` and `filedAt` provenance on every row:
 *
 *   1. income / balance sheet / cash flow — latest ANNUAL and latest QUARTERLY
 *   2. the POINT-IN-TIME property: a read as-of a date BETWEEN two filings must
 *      return the OLDER filing's numbers. Run, with both filings printed.
 *   3. insider transactions, last 90 days
 *   4. top 13F holders with the quarter-on-quarter delta
 *   5. filings by form
 *
 * Usage:
 *   npx tsx scripts/data/edgar-acceptance.ts
 *   npx tsx scripts/data/edgar-acceptance.ts --json
 *   npx tsx scripts/data/edgar-acceptance.ts --help
 *
 * Exit codes: 0 every required piece present; 1 one or more MISSING, each with
 * a named reason; 2 the script itself failed.
 *
 * ## Absence IS failure here, and that is the difference from the coverage report
 *
 * `edgar-coverage-report.ts` MEASURES: an empty database is a legitimate state
 * there, reported as NO_DATA and exiting 0, because a gate over an empty
 * population is vacuously satisfied. This script ASSERTS. It is the check that
 * says the pipeline produced something, so an empty database fails it — loudly,
 * naming every piece that is absent rather than reporting one generic error.
 *
 * ## Everything goes through the REPOSITORY, never raw Prisma
 *
 * The point of the exercise is that the SERVING SEAM works. A script that
 * queried `us_fundamentals` directly would prove the writer ran and prove
 * nothing about the layer users read through — identity resolution, the
 * point-in-time pick, the QoQ pairing, the cold-shard fallback and every named
 * empty reason all live in `packages/core/src/us-fundamentals/repository.ts`,
 * and every one of them is exercised below.
 *
 * ## Why the point-in-time probe walks BACKWARDS through the seam
 *
 * To assert "a date between two filings returns the older one" you first need
 * two filings of one period, and finding them with a raw query would defeat the
 * paragraph above. So the probe uses `asOf` alone:
 *
 *   1. read the current view — one row per `periodEnd`, each with its `filedAt`;
 *   2. re-read as-of `filedAt - 1 ms`, which excludes that filing by
 *      construction. A DIFFERENT accession coming back for the same `periodEnd`
 *      IS the predecessor, discovered without a second data path;
 *   3. read as-of the MIDPOINT between the two `filedAt`s — a date that is
 *      literally between two filings — and assert the OLDER accession comes
 *      back.
 *
 * Two distinct named failures, because they are two different facts:
 * `POINT_IN_TIME_RETURNED_NEWER` is a broken seam, and
 * `POINT_IN_TIME_NO_MULTI_FILING_PERIOD` is a database with no restated period
 * to test against. Collapsing them would report a data condition as a code
 * defect, or worse, let the second pass as a success.
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ── .env ──────────────────────────────────────────────────────────────────
 *
 * LOADED, and for the reason 15 of the 30 scripts in this directory already
 * load it: nothing else in the process does. `@usemoney/database` reads
 * DATABASE_URL out of `process.env` when its PrismaClient is constructed, and
 * `npx tsx scripts/data/...` — the invocation scripts/README.md documents —
 * gives it an environment with nothing in it. The result was not a usage error
 * but ten `prisma:error ... Environment variable not found: DATABASE_URL` lines
 * and exit 2: a release GATE that cannot read the database it is gating on,
 * failing in a way that looks like the database is empty rather than absent.
 *
 * The path is resolved from THIS FILE, never from the cwd — a gate run from
 * `services/` or from a worktree must read the same `.env` as one run from the
 * repo root, or the two answer about different databases.
 *
 * `dotenv.config` does NOT override an already-exported variable, which is the
 * behaviour to keep: the repo `.env` points at QA, so an operator measuring
 * PROD exports DATABASE_URL first and this call leaves it alone.
 */
dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
  // `quiet` is NOT cosmetic here. dotenv v17 prints `[dotenv@17.2.3] injecting
  // env (55) from .env` on STDOUT, and `--json` writes the machine-readable
  // report to stdout — so without this the documented `--json` invocation emits
  // a banner followed by JSON, and every consumer's parse throws. The 15 other
  // scripts in this directory can omit it because none of them has a
  // stdout-is-data mode.
  quiet: true,
});

import {
  US_COVERAGE_TARGET_YEARS,
  getBeneficialOwners,
  getFilings,
  getInsiderTransactions,
  getStatements,
  getTopHolders,
  mapStandardizedToStatement,
  normalizeSymbolForUs,
  type UsPeriodType,
  type UsStatementRow,
  type UsStatementType,
} from "@usemoney/core/us-fundamentals";

/* ── configuration ──────────────────────────────────────────────────────── */

/**
 * The three symbols the branch's acceptance names.
 *
 * `BRK.B` is written with the DOT deliberately: it is the spelling a human
 * types and the spelling OpenFIGI returns as `BRK/B`, while our universe stores
 * `BRK-B`. `normalizeSymbolForUs` maps `.` and `/` to `-`, and running the input
 * through it here means this script also proves that normalisation, rather than
 * quietly pre-solving it.
 */
const SYMBOLS = ["AAPL", "MSFT", "BRK.B"] as const;

const STATEMENTS: readonly UsStatementType[] = [
  "INCOME",
  "BALANCE_SHEET",
  "CASH_FLOW",
];
const PERIOD_TYPES: readonly UsPeriodType[] = ["ANNUAL", "QUARTERLY"];

/** Window for the insider leg, per the acceptance. */
const INSIDER_WINDOW_DAYS = 90;

/** How many periods deep to hunt for a restated one before giving up. */
const PIT_PROBE_PERIODS = 8;

/** Forms the ledger leg reports on. */
const LEDGER_FORMS = [
  "10-K",
  "10-Q",
  "8-K",
  "4",
  "13F-HR",
  "SC 13G",
  "SCHEDULE 13G",
] as const;

/* ── argv ───────────────────────────────────────────────────────────────── */

const USAGE = `edgar-acceptance — the MONEY-979 acceptance, executable

  npx tsx scripts/data/edgar-acceptance.ts [--json]

  --json     emit the findings as JSON on stdout (default: a readable report)
  --help,-h  this text

  Reads AAPL, MSFT and BRK.B through @usemoney/core/us-fundamentals.
  Exit 0 = every required piece present, 1 = something MISSING (each named),
  2 = the script failed.

  Absence IS failure here. For the measurement whose empty database is a
  legitimate state, use scripts/data/edgar-coverage-report.ts.`;

interface Options {
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

/* ── findings ───────────────────────────────────────────────────────────── */

/**
 * The legs whose ABSENCE is a failure.
 *
 * Declared as data rather than as five `if` statements so the policy is
 * readable in one place and testable without a database. `judgeAcceptance`
 * below is the only thing that decides an exit code.
 */
export const REQUIRED_LEGS = [
  "STATEMENT",
  "POINT_IN_TIME",
  "INSIDER",
  "HOLDERS",
  "FILINGS",
] as const;

/**
 * Legs that are REPORTED but never required.
 *
 * `BENEFICIAL` (13D/G) is the only one. Structured data exists only for filings
 * after the 2024-12-18 XML mandate, and a mega-cap can legitimately have no
 * 13D/G at all — a 5% stake in Apple is ~$170bn. Failing on it would fail the
 * acceptance for a fact about the market rather than about our pipeline.
 */
export const REPORTED_ONLY_LEGS = ["BENEFICIAL"] as const;

export type AcceptanceLeg =
  | (typeof REQUIRED_LEGS)[number]
  | (typeof REPORTED_ONLY_LEGS)[number];

export interface LegOutcome {
  leg: AcceptanceLeg;
  /** What was asked for: `"AAPL INCOME/ANNUAL"`, `"MSFT 90d"`. */
  subject: string;
  present: boolean;
  /** Non-empty but INCOMPLETE — a warning, never a failure. */
  degraded?: boolean;
  /** The seam's named reason, verbatim. */
  reason?: string | null;
  /** Operator-facing explanation. Not part of the decision. */
  detail?: string;
}

export interface AcceptanceVerdict {
  verdict: "PASS" | "FAIL";
  exitCode: 0 | 1;
  failures: Array<{
    leg: string;
    subject: string;
    reason: string;
    detail: string;
  }>;
  warnings: string[];
  /** Absences that were reported and deliberately not counted. */
  reportedOnlyAbsences: string[];
}

/**
 * Outcomes in, exit code out. PURE — no I/O, no clock.
 *
 * This function exists so that "the acceptance script exits 0 on missing data"
 * is an assertion rather than a hope. That failure is invisible from the
 * outside: a script that prints an empty report and exits 0 looks exactly like
 * a script that found everything, and CI believes it.
 *
 * An UNKNOWN leg counts as REQUIRED. A leg added to the script and forgotten
 * here must not silently become optional — the fail-safe direction is the one
 * that makes the omission loud.
 */
export function judgeAcceptance(
  outcomes: readonly LegOutcome[],
): AcceptanceVerdict {
  const reportedOnly = new Set<string>(REPORTED_ONLY_LEGS);

  const failures: AcceptanceVerdict["failures"] = [];
  const warnings: string[] = [];
  const reportedOnlyAbsences: string[] = [];

  for (const o of outcomes) {
    if (o.present) {
      if (o.degraded === true) {
        warnings.push(
          `${o.leg} ${o.subject}: DEGRADED (${o.reason ?? "no reason given"}) — ` +
            "the rows present are correct but they are not all of them.",
        );
      }
      continue;
    }
    if (reportedOnly.has(o.leg)) {
      reportedOnlyAbsences.push(`${o.leg} ${o.subject}`);
      continue;
    }
    failures.push({
      leg: o.leg,
      subject: o.subject,
      reason: `MISSING_${o.leg}`,
      detail: o.detail ?? `${o.subject}: ${o.reason ?? "no rows, no reason"}`,
    });
  }

  return {
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    warnings,
    reportedOnlyAbsences,
  };
}

/* ── collected as the legs run ──────────────────────────────────────────── */

const outcomes: LegOutcome[] = [];
const out: string[] = [];

function record(o: LegOutcome): void {
  outcomes.push(o);
}

function iso(d: Date | string | null | undefined): string {
  if (d === null || d === undefined) return "—";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
}

function money(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toLocaleString("en-US");
}

/** The two or three headline figures of each statement type. */
const HEADLINE_FIELDS: Record<UsStatementType, readonly string[]> = {
  INCOME: ["revenue", "operatingIncome", "netIncome"],
  BALANCE_SHEET: ["totalAssets", "totalLiabilities", "totalEquity"],
  CASH_FLOW: ["operatingCashFlow", "capitalExpenditure", "freeCashFlow"],
};

function headline(row: UsStatementRow, type: UsStatementType): string {
  const mapped = mapStandardizedToStatement(row);
  return (HEADLINE_FIELDS[type] ?? [])
    .map((f) => `${f}=${money(mapped[f])}`)
    .join("  ");
}

/* ── legs ───────────────────────────────────────────────────────────────── */

interface StatementFinding {
  symbol: string;
  statementType: UsStatementType;
  periodType: UsPeriodType;
  present: boolean;
  reason: string | null;
  accession?: string;
  filedAt?: string;
  periodEnd?: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
  headline?: string;
}

async function statementsLeg(symbol: string): Promise<StatementFinding[]> {
  const found: StatementFinding[] = [];

  for (const statementType of STATEMENTS) {
    for (const periodType of PERIOD_TYPES) {
      const result = await getStatements({
        symbol,
        statementType,
        periodType,
        limit: 1,
      });
      const row = result.rows[0];

      // Recorded unconditionally, present or not. `detail` is written as the
      // ABSENCE message because `judgeAcceptance` reads it only on the failure
      // path — building it here keeps the diagnosis next to the query that
      // would produce it, rather than in a second branch that can drift.
      record({
        leg: "STATEMENT",
        subject: `${symbol} ${statementType}/${periodType}`,
        present: row !== undefined,
        reason: result.reason,
        detail:
          `${symbol} ${statementType}/${periodType} — the seam returned no rows ` +
          `(reason: ${result.reason ?? "null"}). A named reason of ` +
          `SYMBOL_NOT_IN_US_UNIVERSE or SYMBOL_HAS_NO_SEC_CIK is an INSTRUMENT ` +
          `problem (us_instruments has no active row, or no cik joined onto it); ` +
          `NO_ROWS_FOR_QUERY means the filer resolved and parse_financials has ` +
          `written nothing for it.`,
      });

      if (!row) {
        found.push({
          symbol,
          statementType,
          periodType,
          present: false,
          reason: result.reason,
        });
        continue;
      }

      found.push({
        symbol,
        statementType,
        periodType,
        present: true,
        reason: result.reason,
        accession: row.accession,
        filedAt: iso(row.filedAt),
        periodEnd: iso(row.periodEnd),
        fiscalYear: row.fiscalYear,
        fiscalPeriod: row.fiscalPeriod,
        headline: headline(row, statementType),
      });

      out.push(
        `    ${statementType.padEnd(14)}${periodType.padEnd(10)}` +
          `FY${row.fiscalYear} ${row.fiscalPeriod.padEnd(4)} ` +
          `end ${iso(row.periodEnd)}  filed ${iso(row.filedAt)}  ${row.form.padEnd(6)} ` +
          `${row.accession}`,
      );
      out.push(`      ${headline(row, statementType)}`);
    }
  }

  return found;
}

interface PitFinding {
  symbol: string;
  periodEnd: string;
  /** The filing that is current now. */
  newer: { accession: string; filedAt: string; headline: string };
  /** The filing that was current before it. */
  older: { accession: string; filedAt: string; headline: string };
  /** The date asked about — strictly between the two `filedAt`s. */
  asOf: string;
  /** What the seam returned for that date. */
  returned: { accession: string; filedAt: string; headline: string };
  correct: boolean;
}

/**
 * The point-in-time acceptance, run through `asOf` alone.
 *
 * Returns `null` when this symbol has no `periodEnd` carrying two filings —
 * which is a DATA condition, not a defect, and is reported as its own named
 * failure by the caller only after every symbol has been tried.
 */
async function pointInTimeLeg(symbol: string): Promise<PitFinding | null> {
  const now = new Date();
  const current = await getStatements({
    symbol,
    statementType: "INCOME",
    periodType: "QUARTERLY",
    asOf: now,
    limit: PIT_PROBE_PERIODS,
  });

  for (const newer of current.rows) {
    // One millisecond before this filing existed. The row that comes back for
    // the same period is, by construction, the one a reader would have seen
    // just before the restatement landed.
    const justBefore = new Date(newer.filedAt.getTime() - 1);
    const before = await getStatements({
      symbol,
      statementType: "INCOME",
      periodType: "QUARTERLY",
      asOf: justBefore,
      limit: PIT_PROBE_PERIODS,
    });

    const older = before.rows.find(
      (r) =>
        r.periodEnd.getTime() === newer.periodEnd.getTime() &&
        r.accession !== newer.accession,
    );
    if (!older) continue;

    // A date literally between the two filings.
    const midpoint = new Date(
      Math.floor((older.filedAt.getTime() + newer.filedAt.getTime()) / 2),
    );
    const between = await getStatements({
      symbol,
      statementType: "INCOME",
      periodType: "QUARTERLY",
      asOf: midpoint,
      limit: PIT_PROBE_PERIODS,
    });
    const returned = between.rows.find(
      (r) => r.periodEnd.getTime() === newer.periodEnd.getTime(),
    );

    if (!returned) {
      record({
        leg: "POINT_IN_TIME",
        subject: `${symbol} ${iso(newer.periodEnd)}`,
        present: false,
        reason: between.reason,
        detail:
          `POINT_IN_TIME_RETURNED_NOTHING — ${symbol} period ` +
          `${iso(newer.periodEnd)}: a read as-of ${midpoint.toISOString()} ` +
          `returned no row at all, though ${older.accession} was filed on ` +
          `${iso(older.filedAt)}, before that date.`,
      });
      return null;
    }

    const correct = returned.accession === older.accession;
    record({
      leg: "POINT_IN_TIME",
      subject: `${symbol} ${iso(newer.periodEnd)}`,
      // A WRONG answer is recorded as ABSENT, not as present-but-noted. There
      // is no partial credit here: the property either holds or the seam is
      // handing a backtest numbers nobody had yet.
      present: correct,
      reason: between.reason,
      detail:
        `POINT_IN_TIME_RETURNED_NEWER — ${symbol} period ${iso(newer.periodEnd)}: ` +
        `as-of ${midpoint.toISOString()} the seam returned ${returned.accession} ` +
        `(filed ${iso(returned.filedAt)}) but the filing current on that date was ` +
        `${older.accession} (filed ${iso(older.filedAt)}). A backtest reading this ` +
        `would see numbers nobody had yet.`,
    });

    const shape = (r: UsStatementRow) => ({
      accession: r.accession,
      filedAt: iso(r.filedAt),
      headline: headline(r, "INCOME"),
    });

    return {
      symbol,
      periodEnd: iso(newer.periodEnd),
      newer: shape(newer),
      older: shape(older),
      asOf: midpoint.toISOString(),
      returned: shape(returned),
      correct,
    };
  }

  return null;
}

interface InsiderFinding {
  symbol: string;
  rows: number;
  reason: string | null;
  from: string;
  to: string;
  sample: Array<{
    filedAt: string;
    transactionDate: string;
    owner: string;
    code: string | null;
    shares: number | null;
    accession: string;
  }>;
}

async function insiderLeg(symbol: string): Promise<InsiderFinding> {
  const to = new Date();
  const from = new Date(to.getTime() - INSIDER_WINDOW_DAYS * 86_400_000);

  const result = await getInsiderTransactions({ symbol, from, to, limit: 50 });

  record({
    leg: "INSIDER",
    subject: `${symbol} last ${INSIDER_WINDOW_DAYS}d`,
    present: result.rows.length > 0,
    reason: result.reason,
    detail:
      `${symbol}: no insider rows in the last ${INSIDER_WINDOW_DAYS} days ` +
      `(reason: ${result.reason ?? "null"}). Before assuming parse_ownership ` +
      `is broken, check us_filings for OWNERSHIP-class filings in the same ` +
      `window: a genuinely quiet quarter and an unparsed one are the same ` +
      `empty list from here, and only that table can tell them apart.`,
  });

  return {
    symbol,
    rows: result.rows.length,
    reason: result.reason,
    from: iso(from),
    to: iso(to),
    sample: result.rows.slice(0, 5).map((r) => ({
      filedAt: iso(r.filedAt),
      transactionDate: iso(r.transactionDate),
      owner: r.ownerName,
      code: r.transactionCode,
      shares: r.shares,
      accession: r.accession,
    })),
  };
}

interface HolderFinding {
  symbol: string;
  rows: number;
  reason: string | null;
  degraded: boolean;
  period: string | null;
  top: Array<{
    manager: string | null;
    shares: number;
    valueUsd: number;
    sharesDelta: number;
    isNew: boolean;
    isExited: boolean;
    accession: string;
    filedAt: string;
  }>;
}

async function holdersLeg(symbol: string): Promise<HolderFinding> {
  const result = await getTopHolders({ symbol, limit: 10 });

  record({
    leg: "HOLDERS",
    subject: symbol,
    present: result.rows.length > 0,
    // NOT a failure, and that separation is the point of `degraded` living
    // apart from `reason`: a non-empty result can still be an incomplete one.
    // With no prior period every QoQ delta and every `isNew` flag in the list
    // below is meaningless, and an operator has to be told that without the
    // run being called broken.
    degraded: result.degraded,
    reason: result.reason,
    detail:
      `${symbol}: no 13F holders (reason: ${result.reason ?? "null"}). ` +
      `parse_13f has written no us_13f_holdings row carrying this symbol — ` +
      `which is also what an unresolved CUSIP looks like from here, so check ` +
      `us_cusip_map before the parser.`,
  });

  return {
    symbol,
    rows: result.rows.length,
    reason: result.reason,
    degraded: result.degraded,
    period: result.asOf,
    top: result.rows.slice(0, 10).map((r) => ({
      manager: r.managerName,
      shares: r.shares,
      valueUsd: r.valueUsd,
      sharesDelta: r.sharesDelta,
      isNew: r.isNew,
      isExited: r.isExited,
      accession: r.accession,
      filedAt: iso(r.filedAt),
    })),
  };
}

interface LedgerFinding {
  symbol: string;
  rows: number;
  reason: string | null;
  byForm: Record<string, number>;
  newest: { form: string; accession: string; filedAt: string } | null;
}

async function ledgerLeg(symbol: string): Promise<LedgerFinding> {
  const result = await getFilings({
    symbol,
    forms: LEDGER_FORMS,
    limit: 500,
  });

  record({
    leg: "FILINGS",
    subject: symbol,
    present: result.rows.length > 0,
    reason: result.reason,
    detail:
      `${symbol}: the filing ledger is empty for every form in ` +
      `[${LEDGER_FORMS.join(", ")}] (reason: ${result.reason ?? "null"}). ` +
      `Neither edgar-detect nor edgar-bulk-submissions has written a ` +
      `us_filings row for this filer.`,
  });

  const byForm: Record<string, number> = {};
  for (const row of result.rows) {
    byForm[row.form] = (byForm[row.form] ?? 0) + 1;
  }
  const first = result.rows[0];

  return {
    symbol,
    rows: result.rows.length,
    reason: result.reason,
    byForm,
    newest: first
      ? {
          form: first.form,
          accession: first.accession,
          filedAt: iso(first.filedAt),
        }
      : null,
  };
}

interface BeneficialFinding {
  symbol: string;
  rows: number;
  reason: string | null;
  structured: number;
}

/**
 * 13D/G is reported but NOT required — see {@link REPORTED_ONLY_LEGS}.
 *
 * The outcome is still RECORDED rather than skipped, so an absence appears in
 * `reportedOnlyAbsences` instead of vanishing. "Deliberately not required" and
 * "never looked at" must not read the same.
 */
async function beneficialLeg(symbol: string): Promise<BeneficialFinding> {
  const result = await getBeneficialOwners({ symbol, limit: 25 });
  record({
    leg: "BENEFICIAL",
    subject: symbol,
    present: result.rows.length > 0,
    reason: result.reason,
    detail: `${symbol}: no 13D/G rows (reason: ${result.reason ?? "null"}).`,
  });
  return {
    symbol,
    rows: result.rows.length,
    reason: result.reason,
    structured: result.rows.filter((r) => r.hasStructuredData).length,
  };
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { prisma } = await import("@usemoney/database");
  const startedAt = Date.now();

  try {
    const report: Record<string, unknown> = {
      runAt: new Date().toISOString(),
      symbols: SYMBOLS,
      targetYears: US_COVERAGE_TARGET_YEARS,
    };

    const statements: StatementFinding[] = [];
    const insiders: InsiderFinding[] = [];
    const holders: HolderFinding[] = [];
    const ledgers: LedgerFinding[] = [];
    const beneficial: BeneficialFinding[] = [];
    const pit: PitFinding[] = [];

    for (const raw of SYMBOLS) {
      const symbol = normalizeSymbolForUs(raw);
      out.push("");
      out.push(
        `── ${raw}${raw === symbol ? "" : ` → ${symbol}`} ───────────────────────────────────`,
      );

      out.push("  statements (latest per period type):");
      statements.push(...(await statementsLeg(symbol)));

      const pitFinding = await pointInTimeLeg(symbol);
      if (pitFinding) {
        pit.push(pitFinding);
        out.push("");
        out.push(
          `  POINT-IN-TIME  period ending ${pitFinding.periodEnd}, asked as of ${pitFinding.asOf}`,
        );
        out.push(
          `    older (expected)  ${pitFinding.older.accession}  filed ${pitFinding.older.filedAt}`,
        );
        out.push(`                      ${pitFinding.older.headline}`);
        out.push(
          `    newer (must NOT)  ${pitFinding.newer.accession}  filed ${pitFinding.newer.filedAt}`,
        );
        out.push(`                      ${pitFinding.newer.headline}`);
        out.push(
          `    returned          ${pitFinding.returned.accession}  filed ${pitFinding.returned.filedAt}` +
            `  ${pitFinding.correct ? "✓ correct" : "✗ WRONG FILING"}`,
        );
        out.push(`                      ${pitFinding.returned.headline}`);
      }

      const insider = await insiderLeg(symbol);
      insiders.push(insider);
      out.push("");
      out.push(
        `  insider transactions  ${insider.rows} row(s) ${insider.from} → ${insider.to}` +
          `${insider.reason ? `  (${insider.reason})` : ""}`,
      );
      for (const s of insider.sample) {
        out.push(
          `    ${s.transactionDate}  ${(s.code ?? "—").padEnd(3)} ` +
            `${String(s.shares ?? "—").padStart(12)}  ${s.owner.slice(0, 28).padEnd(28)} ` +
            `filed ${s.filedAt}  ${s.accession}`,
        );
      }

      const holder = await holdersLeg(symbol);
      holders.push(holder);
      out.push("");
      out.push(
        `  13F holders  ${holder.rows} row(s) for period ${holder.period ?? "—"}` +
          `${holder.degraded ? "  [DEGRADED]" : ""}${holder.reason ? `  (${holder.reason})` : ""}`,
      );
      for (const h of holder.top.slice(0, 5)) {
        out.push(
          `    ${(h.manager ?? "—").slice(0, 30).padEnd(30)} ` +
            `${money(h.valueUsd).padStart(10)}  Δshares ${money(h.sharesDelta).padStart(10)}` +
            `${h.isNew ? "  NEW" : ""}${h.isExited ? "  EXITED" : ""}  ` +
            `filed ${h.filedAt}  ${h.accession}`,
        );
      }

      const ledger = await ledgerLeg(symbol);
      ledgers.push(ledger);
      out.push("");
      out.push(
        `  filings  ${ledger.rows} row(s): ` +
          Object.entries(ledger.byForm)
            .sort()
            .map(([f, n]) => `${f}=${n}`)
            .join("  "),
      );
      if (ledger.newest) {
        out.push(
          `    newest  ${ledger.newest.form}  filed ${ledger.newest.filedAt}  ${ledger.newest.accession}`,
        );
      }

      const owners = await beneficialLeg(symbol);
      beneficial.push(owners);
      out.push(
        `  13D/G  ${owners.rows} row(s), ${owners.structured} with structured data ` +
          `(reported, not required — a 5% stake in a mega-cap is rare)`,
      );
    }

    if (pit.length === 0) {
      // Recorded as an ABSENT required leg, so it flows through the same
      // decision as every other missing piece rather than through a second
      // path that could disagree with it.
      //
      // A DATA condition, not a seam defect — and still a failure, because an
      // acceptance script that could not demonstrate the property must not
      // report that it holds. The two are separately named
      // (`POINT_IN_TIME_NO_MULTI_FILING_PERIOD` here vs
      // `POINT_IN_TIME_RETURNED_NEWER` above) precisely so the operator can
      // tell "nothing to test with" from "the seam is wrong".
      record({
        leg: "POINT_IN_TIME",
        subject: `${SYMBOLS.join(", ")} (no restated period found)`,
        present: false,
        reason: "POINT_IN_TIME_NO_MULTI_FILING_PERIOD",
        detail:
          `POINT_IN_TIME_NO_MULTI_FILING_PERIOD — none of ${SYMBOLS.join(", ")} ` +
          `has a quarterly period carrying two filings within the newest ` +
          `${PIT_PROBE_PERIODS} periods, so the point-in-time property could not ` +
          `be exercised at all. Deepen the backfill (--from-fy) so a restated ` +
          `quarter is present, then re-run.`,
      });
    }

    // ONE decision, from the outcomes every leg recorded. No second tally.
    const verdict = judgeAcceptance(outcomes);

    report.statements = statements;
    report.pointInTime = pit;
    report.insiders = insiders;
    report.holders = holders;
    report.filings = ledgers;
    report.beneficialOwners = beneficial;
    report.outcomes = outcomes;
    report.warnings = verdict.warnings;
    report.failures = verdict.failures;
    report.reportedOnlyAbsences = verdict.reportedOnlyAbsences;
    report.passed = verdict.verdict === "PASS";
    report.durationMs = Date.now() - startedAt;

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `\n═══ MONEY-979 acceptance ══════════════════════════════════════════\n` +
          `  ${new Date().toISOString()}   symbols: ${SYMBOLS.join(", ")}\n` +
          `${out.join("\n")}\n`,
      );
    }

    if (verdict.warnings.length > 0) {
      process.stderr.write(`\nWARNINGS (not failures):\n`);
      for (const w of verdict.warnings) process.stderr.write(`  • ${w}\n`);
    }

    if (verdict.reportedOnlyAbsences.length > 0) {
      process.stderr.write(
        `\nREPORTED, NOT REQUIRED — absent but deliberately not counted:\n` +
          `  ${verdict.reportedOnlyAbsences.join(", ")}\n`,
      );
    }

    if (verdict.verdict === "FAIL") {
      process.stderr.write(
        `\nACCEPTANCE FAILED — ${verdict.failures.length} missing piece(s):\n`,
      );
      for (const f of verdict.failures) {
        process.stderr.write(
          `\n  ${f.reason}  [${f.subject}]\n    ${f.detail}\n`,
        );
      }
      process.stderr.write(
        `\nEvery line above is a NAMED reason. An empty database produces all of\n` +
          `them at once, which is the correct reading: this script asserts that\n` +
          `the pipeline produced something. For the measurement whose empty\n` +
          `database is a legitimate state, run edgar-coverage-report.ts.\n`,
      );
    } else {
      process.stderr.write(
        `\nACCEPTANCE PASSED — every required piece present for ${SYMBOLS.join(", ")}.\n` +
          `  ${pit.length} point-in-time probe(s) returned the older filing.\n`,
      );
    }

    // Set from the VERDICT, never re-derived. Two tallies of the same failures
    // is how one of them silently stops matching the other.
    process.exitCode = verdict.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

/* ── entry point ─────────────────────────────────────────────────────────── */

/**
 * `main()` runs ONLY when this file is what was executed.
 *
 * `packages/core/__tests__/us-fundamentals/coverage-gate.test.ts` imports
 * `judgeAcceptance` from here to drive it directly. An unguarded `main()` at
 * module scope would open a database connection and start reading SEC tables
 * the moment that test imported the file.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `edgar-acceptance failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
}
