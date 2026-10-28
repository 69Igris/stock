#!/usr/bin/env tsx
/**
 * MONEY-979 T12 — the US EDGAR coverage report, and the release gate.
 *
 * READ-ONLY. Nothing here writes, publishes or fetches. It reads the eleven
 * `us_*` collections `services/us-fundamentals/` fills and answers one
 * question a release can act on: **do we hold five fiscal years of statements
 * for the filers who HAVE five fiscal years at SEC?**
 *
 * Usage:
 *   npx tsx scripts/data/edgar-coverage-report.ts               # table
 *   npx tsx scripts/data/edgar-coverage-report.ts --json        # machine
 *   npx tsx scripts/data/edgar-coverage-report.ts --fail-under=95   # gate
 *   npx tsx scripts/data/edgar-coverage-report.ts --help
 *
 * Exit codes: 0 measured (and the gate passed, or no gate was asked for);
 * 1 the gate FAILED; 2 the script itself failed.
 *
 * ## The gate's denominator is ELIGIBLE filers, and that is the whole point
 *
 * A gate reading "95% of filers have 5+ years" FAILS EVERY QUARTER A BATCH OF
 * SPACS LISTS. A company that IPO'd last year cannot have five years of filings
 * and no amount of engineering will give it any, so that gate measures the
 * MARKET rather than us. `UsFiler.eligibleForCoverage` is the split: a filer
 * with 5+ fiscal years of 10-K/20-F/40-F ON FILE AT SEC is eligible and is
 * judged against the five-year bar; everyone else is SATISFIED when they hold
 * all the years they have, and is counted separately in `ineligible` /
 * `ineligibleWithAllAvailable`.
 *
 * `overallPct` counts both buckets. It is never the gate — it exists so that
 * "the ineligible filers are fine too" is a MEASURED claim: an ineligible filer
 * missing years appears there and nowhere else.
 *
 * ## Two coverage numbers, because their DIFFERENCE is the diagnosis
 *
 * `gate` requires all three statements — income, balance sheet and cash flow —
 * for a fiscal year to count. `gateIncomeOnly` requires only the income
 * statement, and is exactly what `getFilerCoverage()` in
 * `packages/core/src/us-fundamentals/repository.ts` computes, so it is what any
 * consumer of the seam sees.
 *
 * `gateIncomeOnly` is always >= `gate`. A LARGE GAP is a specific finding and
 * no single number could carry it: the balance-sheet or cash-flow leg of
 * `parse_financials` is not landing, while a report built on income statements
 * alone would call that universe fully covered. Both are printed, and the
 * script cross-checks its own income-only figure against the seam's — if the
 * ops report and the serving layer disagree about coverage, that is a finding
 * in itself and it is printed rather than reconciled silently.
 *
 * ## An empty database prints ZEROS and exits 0 — it does not claim 100%
 *
 * `judgeCoverage([])` returns 100 deliberately: a gate over an empty population
 * is vacuously satisfied, and the alternatives are worse (0 fails a release for
 * a market condition; NaN fails SILENTLY IN BOTH DIRECTIONS, because `NaN >= 95`
 * is false and so is `NaN < 95`). But "vacuously satisfied" is NOT "95% of the
 * universe is covered", and a report that printed the second would be lying
 * about a database with nothing in it.
 *
 * So this script reads `eligible === 0` — the only signal that distinguishes
 * the two — and reports the named state **NO_DATA**, with `pct: null`. With
 * `--fail-under` on an empty database the gate is NOT EVALUATED and the exit is
 * 0, stated loudly rather than implied: there is nothing to fail. Absence is
 * failure in `edgar-acceptance.ts`, which is the script whose job that is.
 *
 * ## Why "has a value" is filtered in TypeScript, not in `where`
 *
 * A Mongo `db push` creates INDEXES, not FIELDS, so an attribute added later is
 * ABSENT on pre-existing rows and BOTH `{f: null}` and `{f: {not: null}}` return
 * ZERO (MONEY-1050 / 1234 / 1235). The detection-latency pass therefore SELECTS
 * `acceptedAt` and `detectedAt` and filters them here. Positive equality filters
 * (`{inUniverse: true}`) are safe and are used freely.
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

/* ── argv ──────────────────────────────────────────────────────────────────
 *
 * `scripts/data/*` uses the SPACE form (`--env prod`) and `scripts/jobs/tiingo-*`
 * uses the EQUALS form; MONEY-1261 lost a whole chain to two producers agreeing
 * with each other and disagreeing with a parser. So BOTH forms are accepted
 * here and anything unparseable is a HARD ERROR (exit 2) rather than a fallback
 * to the default.
 *
 * That strictness is the point. The failure mode of a silently mis-parsed
 * `--fail-under` is a gate that does not gate — a script that prints a
 * percentage, exits 0, and is believed.
 */

interface Options {
  json: boolean;
  failUnder: number | null;
  help: boolean;
}

const USAGE = `edgar-coverage-report — US EDGAR coverage (MONEY-979)

  npx tsx scripts/data/edgar-coverage-report.ts [--json] [--fail-under=N]

  --json           emit the report as JSON on stdout (default: a table)
  --fail-under=N   exit 1 when the gate is below N percent. N is 0-100.
                   Accepts "--fail-under 95" too. A value that will not parse
                   is a hard error, never a skipped gate.
  --help, -h       this text

  Read-only. Exit 0 = measured (gate passed or not requested),
             1 = gate FAILED, 2 = the script failed.

  On an EMPTY database the gate is reported NO_DATA and the exit is 0: there
  is nothing to fail. Use scripts/data/edgar-acceptance.ts for the check where
  absence IS failure.`;

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { json: false, failUnder: null, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--fail-under" || arg.startsWith("--fail-under=")) {
      const raw = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : argv[++i];
      const n = Number(raw);
      if (
        raw === undefined ||
        String(raw).trim() === "" ||
        !Number.isFinite(n) ||
        n < 0 ||
        n > 100
      ) {
        throw new Error(
          `--fail-under needs a number 0-100, got ${JSON.stringify(raw)}. ` +
            "Refusing to continue: a --fail-under that silently did not parse " +
            "is a gate that does not gate.",
        );
      }
      opts.failUnder = n;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }

  return opts;
}

/* ── shapes ─────────────────────────────────────────────────────────────── */

type Judgement = {
  eligible: number;
  eligibleCovered: number;
  ineligible: number;
  ineligibleWithAllAvailable: number;
  pct: number;
  overallPct: number;
  filers: number;
};

interface GateView {
  /** `MEASURED` or `NO_DATA`. Never a percentage on an empty population. */
  status: "MEASURED" | "NO_DATA";
  /** `null` under NO_DATA — deliberately not 100. */
  pct: number | null;
  overallPct: number | null;
  eligible: number;
  eligibleCovered: number;
  ineligible: number;
  ineligibleWithAllAvailable: number;
  filers: number;
}

function toGateView(j: Judgement): GateView {
  const measured = j.eligible > 0;
  return {
    status: measured ? "MEASURED" : "NO_DATA",
    pct: measured ? j.pct : null,
    overallPct: j.filers > 0 ? j.overallPct : null,
    eligible: j.eligible,
    eligibleCovered: j.eligibleCovered,
    ineligible: j.ineligible,
    ineligibleWithAllAvailable: j.ineligibleWithAllAvailable,
    filers: j.filers,
  };
}

/* ── the gate verdict ───────────────────────────────────────────────────── */

export type GateVerdict =
  /** No `--fail-under` was given. The report is a measurement, not a gate. */
  | "NOT_REQUESTED"
  /** `--fail-under` was given but the population is empty. Nothing to fail. */
  | "NOT_EVALUATED"
  | "PASS"
  | "FAIL";

/**
 * The gate decision, as a pure function, so it can be driven by a test.
 *
 * Extracted for exactly one reason: the failure mode of a `--fail-under` that
 * does not actually fail is a script that prints a percentage, exits 0, and is
 * believed. That is unobservable from the outside and untestable while the
 * comparison is buried in an I/O function, so it lives here and
 * `packages/core/__tests__/us-fundamentals/coverage-gate.test.ts` drives it.
 *
 * `NOT_EVALUATED` is its OWN verdict and exits 0. A gate over an empty
 * population is vacuously satisfied — but "vacuously satisfied" is not "passed",
 * and merging the two would let a database with nothing in it report PASS at
 * 95%. It is stated, not implied.
 */
export function decideGate(args: {
  status: "MEASURED" | "NO_DATA";
  pct: number | null;
  failUnder: number | null;
}): { verdict: GateVerdict; exitCode: 0 | 1 } {
  if (args.failUnder === null) return { verdict: "NOT_REQUESTED", exitCode: 0 };
  if (
    args.status === "NO_DATA" ||
    args.pct === null ||
    !Number.isFinite(args.pct)
  ) {
    return { verdict: "NOT_EVALUATED", exitCode: 0 };
  }
  // `<`, not `<=`: --fail-under=95 means "95 is acceptable".
  return args.pct < args.failUnder
    ? { verdict: "FAIL", exitCode: 1 }
    : { verdict: "PASS", exitCode: 0 };
}

/** The three statements a fiscal year needs before it counts toward `gate`. */
const REQUIRED_STATEMENTS = ["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const;

/** Every tier `UsCusipMap.source` may carry, plus the recorded absence. */
const CUSIP_TIERS = ["SEC_13DG", "TIINGO_FIGI", "SEC_FTD", "OPENFIGI"] as const;
const CUSIP_UNRESOLVED = "UNRESOLVED";

/**
 * How many recent filings to sample for detection latency.
 *
 * A cap, not a filter: the metric that matters is
 * `stockbook.edgar.detect_latency_seconds` in Datadog, and this is a
 * database-side sanity read of the same quantity for an operator with no
 * dashboard open. Ordered by `filedAt` DESC so the sample is the recent past
 * rather than the backfill's oldest corner.
 */
const LATENCY_SAMPLE = 5_000;

/* ── percentile ─────────────────────────────────────────────────────────── */

/**
 * Nearest-rank percentile over a sorted array, or `null` for an empty one.
 *
 * `null`, never 0. A p95 of zero seconds reads as "detection is instant", which
 * is the most flattering possible rendering of "we have never measured it".
 */
export function percentile(
  sortedAscending: readonly number[],
  p: number,
): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? null;
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // Imported HERE, not at module scope. `@usemoney/database` constructs a
  // PrismaClient at import time, which throws when DATABASE_URL is unset — so a
  // top-level import would make `--help` fail on any laptop that has not
  // exported one, which is exactly when somebody reads the help.
  const { prisma } = await import("@usemoney/database");
  const { getFilerCoverage, judgeCoverage } =
    await import("@usemoney/core/us-fundamentals");

  const startedAt = Date.now();
  try {
    /* 1. Filers ---------------------------------------------------------- */

    const [filerTotal, filerInUniverse, filerEligible, universeFilers] =
      await Promise.all([
        prisma.usFiler.count(),
        prisma.usFiler.count({ where: { inUniverse: true } }),
        prisma.usFiler.count({
          where: { inUniverse: true, eligibleForCoverage: true },
        }),
        prisma.usFiler.findMany({
          where: { inUniverse: true },
          select: {
            cik10: true,
            eligibleForCoverage: true,
            fiscalYearsOnFile: true,
          },
        }),
      ]);

    /* 2. Statement years, per filer, per statement type ------------------- */

    // Three bounded group-bys rather than one three-key group-by. Same total
    // work, but each response is one statement type wide, and the intersection
    // is done here where it can be counted.
    const perType = new Map<string, Map<string, Set<number>>>();
    for (const statementType of REQUIRED_STATEMENTS) {
      const groups = (await prisma.usFundamentals.groupBy({
        by: ["cik10", "fiscalYear"],
        where: { statementType, periodType: "ANNUAL" },
      })) as unknown as Array<{ cik10: string; fiscalYear: number }>;

      const byFiler = new Map<string, Set<number>>();
      for (const g of groups) {
        const set = byFiler.get(g.cik10) ?? new Set<number>();
        set.add(g.fiscalYear);
        byFiler.set(g.cik10, set);
      }
      perType.set(statementType, byFiler);
    }

    const incomeYears = perType.get("INCOME") ?? new Map<string, Set<number>>();
    const balanceYears =
      perType.get("BALANCE_SHEET") ?? new Map<string, Set<number>>();
    const cashYears =
      perType.get("CASH_FLOW") ?? new Map<string, Set<number>>();

    /** Fiscal years for which this filer has ALL THREE statements. */
    function completeYears(cik10: string): number {
      const income = incomeYears.get(cik10);
      if (!income) return 0;
      const balance = balanceYears.get(cik10);
      const cash = cashYears.get(cik10);
      if (!balance || !cash) return 0;
      let n = 0;
      for (const year of income) {
        if (balance.has(year) && cash.has(year)) n++;
      }
      return n;
    }

    const gate = toGateView(
      judgeCoverage(
        universeFilers.map((f) => ({
          eligibleForCoverage: f.eligibleForCoverage,
          fiscalYearsOnFile: f.fiscalYearsOnFile,
          statementYears: completeYears(f.cik10),
        })),
      ) as Judgement,
    );

    const gateIncomeOnly = toGateView(
      judgeCoverage(
        universeFilers.map((f) => ({
          eligibleForCoverage: f.eligibleForCoverage,
          fiscalYearsOnFile: f.fiscalYearsOnFile,
          statementYears: incomeYears.get(f.cik10)?.size ?? 0,
        })),
      ) as Judgement,
    );

    // The serving seam's own answer, computed independently by
    // `getFilerCoverage()`. If the ops report and the layer users read
    // disagree about coverage, that is a finding, not something to reconcile
    // quietly — so it is measured and printed.
    const seam = toGateView((await getFilerCoverage()) as Judgement);
    const seamAgrees =
      seam.status === gateIncomeOnly.status &&
      seam.eligible === gateIncomeOnly.eligible &&
      seam.eligibleCovered === gateIncomeOnly.eligibleCovered;

    /* 3. Row counts ------------------------------------------------------- */

    const [
      filings,
      fundamentals,
      companyFacts,
      insiderTransactions,
      thirteenFFilings,
      thirteenFHoldings,
      beneficialOwnership,
      filingDocuments,
      cusipMap,
      edgarCursor,
    ] = await Promise.all([
      prisma.usFiling.count(),
      prisma.usFundamentals.count(),
      prisma.usCompanyFact.count(),
      prisma.usInsiderTransaction.count(),
      prisma.usThirteenFFiling.count(),
      prisma.usThirteenFHolding.count(),
      prisma.usBeneficialOwnership.count(),
      prisma.usFilingDocument.count(),
      prisma.usCusipMap.count(),
      prisma.usEdgarCursor.count(),
    ]);

    /* 4. Breakdowns ------------------------------------------------------- */

    const [statementGroups, statusGroups, parseClassGroups, cusipGroups] =
      await Promise.all([
        prisma.usFundamentals.groupBy({
          by: ["statementType", "periodType"],
          _count: { _all: true },
        }) as unknown as Promise<
          Array<{
            statementType: string;
            periodType: string;
            _count: { _all: number };
          }>
        >,
        prisma.usFiling.groupBy({
          by: ["status"],
          _count: { _all: true },
        }) as unknown as Promise<
          Array<{ status: string; _count: { _all: number } }>
        >,
        prisma.usFiling.groupBy({
          by: ["parseClass"],
          _count: { _all: true },
        }) as unknown as Promise<
          Array<{ parseClass: string; _count: { _all: number } }>
        >,
        prisma.usCusipMap.groupBy({
          by: ["source"],
          _count: { _all: true },
        }) as unknown as Promise<
          Array<{ source: string; _count: { _all: number } }>
        >,
      ]);

    const byStatement: Record<string, number> = {};
    for (const g of statementGroups) {
      byStatement[`${g.statementType}/${g.periodType}`] = g._count._all;
    }
    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) byStatus[g.status] = g._count._all;
    const byParseClass: Record<string, number> = {};
    for (const g of parseClassGroups)
      byParseClass[g.parseClass] = g._count._all;

    /* 5. CUSIP tiers ------------------------------------------------------ */

    // Every KNOWN tier is seeded at zero. A tier that resolved nothing must
    // read as 0 rather than be absent — "0 rows" and "not in the output" are
    // the same reading otherwise, and one of them means the tier never ran.
    const bySource: Record<string, number> = {};
    for (const tier of CUSIP_TIERS) bySource[tier] = 0;
    bySource[CUSIP_UNRESOLVED] = 0;

    const knownTiers = new Set<string>(CUSIP_TIERS);
    let cusipResolved = 0;
    let cusipUnresolved = 0;
    let cusipUnknown = 0;
    const unknownSources: Record<string, number> = {};

    for (const g of cusipGroups) {
      const source = String(g.source ?? "").trim();
      const n = g._count._all;
      if (knownTiers.has(source)) {
        bySource[source] = (bySource[source] ?? 0) + n;
        cusipResolved += n;
      } else if (source === CUSIP_UNRESOLVED || source === "") {
        bySource[CUSIP_UNRESOLVED] = (bySource[CUSIP_UNRESOLVED] ?? 0) + n;
        cusipUnresolved += n;
      } else {
        // Never folded into `resolved`: a typo'd or renamed tier would inflate
        // the headline the more often it appeared.
        bySource[source] = (bySource[source] ?? 0) + n;
        unknownSources[source] = (unknownSources[source] ?? 0) + n;
        cusipUnknown += n;
      }
    }
    const cusipTotal = cusipResolved + cusipUnresolved + cusipUnknown;

    /* 6. Detection latency ------------------------------------------------ */

    const latencyRows = await prisma.usFiling.findMany({
      orderBy: { filedAt: "desc" },
      take: LATENCY_SAMPLE,
      select: { acceptedAt: true, detectedAt: true },
    });

    const latencies: number[] = [];
    let negativeLatencies = 0;
    for (const row of latencyRows) {
      // Filtered HERE and not in `where` — see the header note on absent fields.
      if (!row.acceptedAt || !row.detectedAt) continue;
      const seconds =
        (row.detectedAt.getTime() - row.acceptedAt.getTime()) / 1000;
      if (!Number.isFinite(seconds)) continue;
      if (seconds < 0) {
        // Counted, not discarded and not included. A negative latency is clock
        // skew between SEC's acceptance stamp and ours; averaging it in would
        // make detection look faster than it is.
        negativeLatencies++;
        continue;
      }
      latencies.push(seconds);
    }
    latencies.sort((a, b) => a - b);

    const latency = {
      sampled: latencyRows.length,
      measured: latencies.length,
      negative: negativeLatencies,
      p50Seconds: percentile(latencies, 50),
      p95Seconds: percentile(latencies, 95),
      maxSeconds: latencies[latencies.length - 1] ?? null,
      reason:
        latencies.length > 0
          ? null
          : latencyRows.length === 0
            ? "NO_FILINGS"
            : "NO_DETECTED_AT_RECORDED",
    };

    /* 7. Report ----------------------------------------------------------- */

    const noDataAtAll = filerTotal === 0 && filings === 0 && fundamentals === 0;

    const report = {
      runAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      noDataYet: noDataAtAll,
      targetYears: 5,
      failUnder: opts.failUnder,
      gate,
      gateIncomeOnly,
      seam: { ...seam, agreesWithIncomeOnly: seamAgrees },
      filers: {
        total: filerTotal,
        inUniverse: filerInUniverse,
        eligibleForCoverage: filerEligible,
        // A disagreement here means some `inUniverse` filer carries no
        // `eligibleForCoverage` at all: `judgeCoverage` reads `=== true` and a
        // count query reads equality, so an ABSENT field is ineligible to both
        // and the two must agree. If they ever do not, the field is being
        // written as something other than a boolean.
        eligibleCountMatchesJudgement: filerEligible === gate.eligible,
      },
      rows: {
        us_filers: filerTotal,
        us_filings: filings,
        us_fundamentals: fundamentals,
        us_company_facts: companyFacts,
        us_insider_transactions: insiderTransactions,
        us_13f_filings: thirteenFFilings,
        us_13f_holdings: thirteenFHoldings,
        us_beneficial_ownership: beneficialOwnership,
        us_filing_documents: filingDocuments,
        us_cusip_map: cusipMap,
        us_edgar_cursor: edgarCursor,
      },
      fundamentalsByStatement: byStatement,
      filingsByStatus: byStatus,
      filingsByParseClass: byParseClass,
      cusip: {
        total: cusipTotal,
        resolved: cusipResolved,
        unresolved: cusipUnresolved,
        unknown: cusipUnknown,
        unresolvedPct:
          cusipTotal === 0 ? null : (cusipUnresolved / cusipTotal) * 100,
        bySource,
        unknownSources,
        note:
          "TIINGO_FIGI is EXPECTED near zero: the 13F `figi` column is optional " +
          "and genuinely absent — Berkshire omits it on all 89 rows of its 2026 " +
          "filing (measured, MONEY-979 T4). A zero there is not a broken tier.",
      },
      latency,
    };

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderTable(report));
    }

    /* 8. The gate --------------------------------------------------------- */

    const decision = decideGate({
      status: gate.status,
      pct: gate.pct,
      failUnder: opts.failUnder,
    });

    if (decision.verdict === "NOT_REQUESTED") return;

    if (decision.verdict === "NOT_EVALUATED") {
      process.stderr.write(
        `\nGATE NOT EVALUATED — no eligible filers in us_filers yet.\n` +
          `  --fail-under=${opts.failUnder} was requested, but the population it ` +
          `measures is empty, so there is nothing to fail.\n` +
          `  This is reported as NO_DATA rather than 100%: a gate over an empty ` +
          `set is vacuously satisfied, which is not the same claim as coverage.\n` +
          `  Absence IS failure in scripts/data/edgar-acceptance.ts — run that ` +
          `to assert the pipeline produced anything at all.\n`,
      );
      return;
    }

    const measured = (gate.pct ?? 0).toFixed(2);

    if (decision.verdict === "FAIL") {
      process.stderr.write(
        `\nGATE FAILED: ${measured}% < ${opts.failUnder}%\n` +
          `  ${gate.eligibleCovered} of ${gate.eligible} eligible filers hold 5+ ` +
          `fiscal years of INCOME + BALANCE_SHEET + CASH_FLOW.\n` +
          `  Income-only reads ${
            gateIncomeOnly.pct === null
              ? "NO_DATA"
              : `${gateIncomeOnly.pct.toFixed(2)}%`
          } — a large gap between the two means the balance-sheet or\n` +
          `  cash-flow leg of parse_financials is not landing, not that the ` +
          `backfill is short.\n`,
      );
    } else {
      process.stderr.write(
        `\nGATE PASSED: ${measured}% >= ${opts.failUnder}%\n`,
      );
    }

    // Set from the DECISION, never re-derived here. Two comparisons of the same
    // threshold is how one of them silently stops matching the other.
    process.exitCode = decision.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

/* ── rendering ──────────────────────────────────────────────────────────── */

function pct(n: number | null): string {
  return n === null ? "     — " : `${n.toFixed(2).padStart(6)}%`;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function renderTable(r: {
  runAt: string;
  durationMs: number;
  noDataYet: boolean;
  gate: GateView;
  gateIncomeOnly: GateView;
  seam: GateView & { agreesWithIncomeOnly: boolean };
  filers: {
    total: number;
    inUniverse: number;
    eligibleForCoverage: number;
    eligibleCountMatchesJudgement: boolean;
  };
  rows: Record<string, number>;
  fundamentalsByStatement: Record<string, number>;
  filingsByStatus: Record<string, number>;
  filingsByParseClass: Record<string, number>;
  cusip: {
    total: number;
    resolved: number;
    unresolved: number;
    unknown: number;
    unresolvedPct: number | null;
    bySource: Record<string, number>;
    unknownSources: Record<string, number>;
  };
  latency: {
    sampled: number;
    measured: number;
    negative: number;
    p50Seconds: number | null;
    p95Seconds: number | null;
    maxSeconds: number | null;
    reason: string | null;
  };
}): string {
  const L: string[] = [];
  L.push("");
  L.push("═══ US EDGAR coverage (MONEY-979) ═════════════════════════════════");
  L.push(`  run ${r.runAt}   ${r.durationMs} ms`);

  if (r.noDataYet) {
    L.push("");
    L.push("  NO DATA YET — us_filers, us_filings and us_fundamentals are all");
    L.push(
      "  empty. Nothing has been ingested into this database. Every number",
    );
    L.push("  below is a zero, not a measurement.");
  }

  L.push("");
  L.push(
    "── The gate ────────────────────────────────────────────────────────",
  );
  L.push("   5+ fiscal years of INCOME + BALANCE_SHEET + CASH_FLOW,");
  L.push("   over ELIGIBLE filers only (SPACs and new listings excluded).");
  L.push("");
  L.push(
    `   gate (IS+BS+CF)   ${pct(r.gate.pct)}   ` +
      `${num(r.gate.eligibleCovered)} / ${num(r.gate.eligible)} eligible   [${r.gate.status}]`,
  );
  L.push(
    `   income only       ${pct(r.gateIncomeOnly.pct)}   ` +
      `${num(r.gateIncomeOnly.eligibleCovered)} / ${num(r.gateIncomeOnly.eligible)} eligible   ` +
      `[${r.gateIncomeOnly.status}]`,
  );
  L.push(
    `   seam agrees       ${r.seam.agreesWithIncomeOnly ? "yes" : "NO — getFilerCoverage() disagrees with this report"}`,
  );
  L.push("");
  L.push(
    `   ineligible        ${num(r.gate.ineligible)} filers, ` +
      `${num(r.gate.ineligibleWithAllAvailable)} hold every year they have`,
  );
  L.push(
    `   overall           ${pct(r.gate.overallPct)}   (both buckets — never the gate)`,
  );

  L.push("");
  L.push(
    "── Filers ──────────────────────────────────────────────────────────",
  );
  L.push(`   total                 ${num(r.filers.total)}`);
  L.push(`   inUniverse            ${num(r.filers.inUniverse)}`);
  L.push(`   eligibleForCoverage   ${num(r.filers.eligibleForCoverage)}`);
  if (!r.filers.eligibleCountMatchesJudgement) {
    L.push(
      `   !! the eligible COUNT and the JUDGEMENT disagree ` +
        `(${num(r.filers.eligibleForCoverage)} vs ${num(r.gate.eligible)}) — ` +
        "eligibleForCoverage is not a boolean on every row",
    );
  }

  L.push("");
  L.push(
    "── Rows ────────────────────────────────────────────────────────────",
  );
  for (const [name, n] of Object.entries(r.rows)) {
    L.push(`   ${name.padEnd(26)}${num(n).padStart(12)}`);
  }

  L.push("");
  L.push(
    "── us_fundamentals by statement / period ───────────────────────────",
  );
  const statements = Object.entries(r.fundamentalsByStatement);
  if (statements.length === 0) L.push("   (none)");
  for (const [key, n] of statements.sort()) {
    L.push(`   ${key.padEnd(26)}${num(n).padStart(12)}`);
  }

  L.push("");
  L.push(
    "── us_filings by status / parseClass ───────────────────────────────",
  );
  const statuses = Object.entries(r.filingsByStatus);
  if (statuses.length === 0) L.push("   (none)");
  for (const [key, n] of statuses.sort()) {
    L.push(`   status ${key.padEnd(19)}${num(n).padStart(12)}`);
  }
  for (const [key, n] of Object.entries(r.filingsByParseClass).sort()) {
    L.push(`   class  ${key.padEnd(19)}${num(n).padStart(12)}`);
  }

  L.push("");
  L.push(
    "── CUSIP map by tier ───────────────────────────────────────────────",
  );
  for (const [key, n] of Object.entries(r.cusip.bySource)) {
    L.push(`   ${key.padEnd(26)}${num(n).padStart(12)}`);
  }
  L.push(
    `   unresolved share      ${pct(r.cusip.unresolvedPct)} of ${num(r.cusip.total)}`,
  );
  if (Object.keys(r.cusip.unknownSources).length > 0) {
    L.push(
      `   !! unrecognised source(s): ${Object.keys(r.cusip.unknownSources).join(", ")} ` +
        "— counted as UNKNOWN, never as resolved",
    );
  }
  L.push(
    "   TIINGO_FIGI is EXPECTED near zero — the 13F `figi` column is optional",
  );
  L.push(
    "   and genuinely absent (Berkshire omits it on all 89 rows of its 2026",
  );
  L.push("   filing). A zero there is not a broken tier.");

  L.push("");
  L.push(
    "── Detection latency (acceptedAt → detectedAt) ─────────────────────",
  );
  if (r.latency.measured === 0) {
    L.push(
      `   not measured — ${r.latency.reason} (sampled ${num(r.latency.sampled)} filings)`,
    );
    L.push(
      "   The authority is stockbook.edgar.detect_latency_seconds in Datadog;",
    );
    L.push("   this is a database-side sanity read of the same quantity.");
  } else {
    L.push(
      `   p50 ${r.latency.p50Seconds?.toFixed(1)}s   p95 ${r.latency.p95Seconds?.toFixed(1)}s   ` +
        `max ${r.latency.maxSeconds?.toFixed(1)}s   n=${num(r.latency.measured)} of ${num(r.latency.sampled)}`,
    );
    if (r.latency.negative > 0) {
      L.push(
        `   ${num(r.latency.negative)} sample(s) had detectedAt BEFORE acceptedAt ` +
          "(clock skew) and were excluded, not averaged in",
      );
    }
  }

  L.push("");
  return `${L.join("\n")}\n`;
}

/* ── entry point ────────────────────────────────────────────────────────── */

/**
 * `main()` runs ONLY when this file is what was executed.
 *
 * `packages/core/__tests__/us-fundamentals/coverage-gate.test.ts` imports
 * `decideGate`, `parseArgs` and `percentile` from here to drive them directly —
 * an unguarded `main()` at module scope would open a database connection the
 * moment that test imported the file, and the test would either hang or fail on
 * a machine with no `DATABASE_URL`.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `edgar-coverage-report failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
}
