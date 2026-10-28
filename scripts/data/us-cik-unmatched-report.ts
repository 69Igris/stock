#!/usr/bin/env tsx
/**
 * MONEY-1353 — WHY 1,170 active US stocks carry no CIK.
 *
 * READ-ONLY. It runs one query and prints a table. It writes nothing, publishes
 * nothing and fetches nothing.
 *
 * Usage:
 *   npx tsx scripts/data/us-cik-unmatched-report.ts            # table
 *   npx tsx scripts/data/us-cik-unmatched-report.ts --json     # machine
 *   npx tsx scripts/data/us-cik-unmatched-report.ts --examples=12
 *
 * Exit 0 when it measured, 2 when the script itself failed. There is NO gate
 * here on purpose: see "no threshold" below.
 *
 * ## The question this answers, and the one number that could not
 *
 * `enrichUsInstrumentsWithCik` reported `unmatched` as a single integer. On
 * prod 2026-09-05 that integer is 1,170 of 8,282 ACTIVE US stocks — 14.1% that
 * can never be joined to SEC EDGAR and so can never receive fundamentals. What
 * the integer could not say is WHICH KIND of row those are, and the three
 * candidate answers want three different responses:
 *
 *   a spelling mismatch      -> fix the normaliser (MONEY-1353 did; +3 rows)
 *   a derivative security    -> nothing to fix HERE; see the caveat below
 *   an unregistered security -> correct, permanent, and not a backlog
 *
 * So this classifies every CIK-less row by the SHAPE of its ticker
 * ({@link classifyUsTickerShape}) and prints counts plus real examples per
 * class. The shape is read off the symbol alone and is REPORTING ONLY — a
 * warrant's shape is not evidence of its registrant's CIK, and the enricher
 * never consults it.
 *
 * ## NO THRESHOLD, and that is the finding rather than a gap in this script
 *
 * A gate needs a number the population is supposed to reach, and there is not
 * one. SEC's `company_tickers.json` lists who is registered TODAY; whether a
 * given SPAC's warrant ticker appears in it is SEC's editorial fact about the
 * market, not a measure of our ingest. A gate here would fire every time a
 * quarter's IPOs list and would be muted inside a month, at which point it
 * protects nothing — the `edgar-coverage-report.ts` lesson, one table over.
 *
 * The thing worth watching is the SHAPE, which is why the enricher now emits
 * `unmatchedByExchange` on its outcome line: NASDAQ's share of this population
 * collapsing is a defect, its size is not.
 *
 * ## THE CAVEAT THAT KILLED THE OBVIOUS FIX
 *
 * It is tempting to read `ACHR-WS` as "Archer Aviation's warrant, so stamp
 * Archer's CIK". Measured on prod 2026-09-05, 166 of the 1,170 do have a base
 * symbol present in SEC's file. It is still refused, for two reasons that only
 * measuring produced:
 *
 *   1. `UsInstrument.name` is NULL on every one of these rows, so there is
 *      nothing to corroborate the parent claim against. The enricher documents
 *      (edgar-cik-logic.ts) that a wrong CIK attaches another company's filings
 *      to a security silently and indistinguishably from a correct join.
 *   2. A four-character prefix of a five-character ticker hits SEC's file 55%
 *      of the time for tickers that are NOT derivatives at all — pure
 *      coincidence. The prefix test cannot tell the coincidence from the
 *      parent, so a suffix-stripping rule would mis-attribute at scale.
 *
 * Whether `cik` should even MEAN "the underlying registrant" for a warrant is a
 * product decision about the column, not a normalisation. It is quantified here
 * so it can be decided; it is deliberately not done here.
 */

import { prisma } from "@usemoney/database";

import {
  classifyUsTickerShape,
  isExchangeTestSymbol,
  US_TICKER_SHAPES,
  type UsTickerShape,
} from "@usemoney/core/market-data/instruments/edgar-cik-logic";

/** How many real tickers to print beside each class. */
const DEFAULT_EXAMPLES = 8;

interface ShapeBucket {
  shape: UsTickerShape;
  count: number;
  examples: string[];
}

interface Report {
  runAt: string;
  activeStocks: number;
  withoutCik: number;
  /** withoutCik / activeStocks, 0-1. */
  gap: number;
  byExchange: Record<string, number>;
  byShape: ShapeBucket[];
  /** Exchange test symbols — a FLAG, not a shape. See below. */
  exchangeTestSymbols: { count: number; examples: string[] };
}

async function measure(examples: number): Promise<Report> {
  const [activeStocks, rows] = await Promise.all([
    prisma.usInstrument.count({
      where: { listingStatus: "ACTIVE", assetType: "Stock" },
    }),
    prisma.usInstrument.findMany({
      where: {
        listingStatus: "ACTIVE",
        assetType: "Stock",
        // THREE clauses, not one. On Prisma's Mongo connector an attribute a
        // `db push` never created is ABSENT rather than null, and `{cik: null}`
        // alone matches only documents that CARRY the key — so on a column
        // added after the rows were written it silently returns ZERO and the
        // report says "no gap" about the exact population it exists to find.
        // That class has caused MONEY-1050, -1205, -1234, -1235 and -1236.
        // `""` is in here too because the enricher's own write guard treats an
        // empty string as unset, and a report that disagreed with the writer
        // about what "has a CIK" means would be measuring a different set.
        OR: [{ cik: null }, { cik: "" }, { cik: { isSet: false } }],
      },
      select: { symbol: true, exchange: true },
      orderBy: { symbol: "asc" },
    }),
  ]);

  const byExchange: Record<string, number> = {};
  const buckets = new Map<UsTickerShape, ShapeBucket>(
    US_TICKER_SHAPES.map((shape) => [shape, { shape, count: 0, examples: [] }]),
  );
  const testExamples: string[] = [];
  let testCount = 0;

  for (const row of rows) {
    const venue = row.exchange.trim() === "" ? "UNKNOWN" : row.exchange.trim();
    byExchange[venue] = (byExchange[venue] ?? 0) + 1;

    const bucket = buckets.get(classifyUsTickerShape(row.symbol));
    if (bucket) {
      bucket.count++;
      if (bucket.examples.length < examples) bucket.examples.push(row.symbol);
    }

    if (isExchangeTestSymbol(row.symbol)) {
      testCount++;
      if (testExamples.length < examples) testExamples.push(row.symbol);
    }
  }

  return {
    runAt: new Date().toISOString(),
    activeStocks,
    withoutCik: rows.length,
    gap: activeStocks === 0 ? 0 : rows.length / activeStocks,
    byExchange,
    byShape: [...buckets.values()].sort((a, b) => b.count - a.count),
    exchangeTestSymbols: { count: testCount, examples: testExamples },
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const examplesArg = argv.find((a) => a.startsWith("--examples="));
  const parsed = Number(examplesArg?.split("=")[1] ?? DEFAULT_EXAMPLES);
  // Guarded rather than trusted: `--examples=abc` is NaN, and `slice(0, NaN)`
  // returns an empty array, so a typo would silently print a table with no
  // examples in it — the one column the table exists for.
  const examples =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.floor(parsed), 50)
      : DEFAULT_EXAMPLES;

  const report = await measure(examples);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("=== ACTIVE US stocks with no SEC CIK ===");
  lines.push(
    `${report.withoutCik.toLocaleString()} of ${report.activeStocks.toLocaleString()} ` +
      `active US stocks (${pct(report.gap)}) cannot be joined to EDGAR at all.`,
  );
  lines.push("");
  lines.push("By exchange:");
  for (const [venue, n] of Object.entries(report.byExchange).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  ${pad(venue, 12)} ${padLeft(String(n), 6)}`);
  }
  lines.push("");
  lines.push("By ticker shape (read off the SYMBOL — reporting only):");
  lines.push(
    `  ${pad("shape", 12)} ${padLeft("count", 6)}  ${padLeft("share", 7)}  examples`,
  );
  for (const b of report.byShape) {
    const share = report.withoutCik === 0 ? 0 : b.count / report.withoutCik;
    lines.push(
      `  ${pad(b.shape, 12)} ${padLeft(String(b.count), 6)}  ` +
        `${padLeft(pct(share), 7)}  ${b.examples.join(" ")}`,
    );
  }
  lines.push("");
  lines.push(
    `Exchange test symbols (a FLAG, not a shape — one can be preferred-spelled ` +
      `too): ${report.exchangeTestSymbols.count}`,
  );
  if (report.exchangeTestSymbols.count > 0) {
    lines.push(`  ${report.exchangeTestSymbols.examples.join(" ")}`);
    lines.push(
      `  These are order-entry test tickers the exchanges publish. No ` +
        `registrant stands behind one, so no CIK exists and none ever will.`,
    );
  }
  lines.push("");
  lines.push(
    `A large "plain" bucket is the honest residual: a US-listed security whose ` +
      `issuer does not file with SEC (a foreign private issuer trading on BATS, ` +
      `say) has an ordinary ticker and no CIK, and no rule recovers it.`,
  );
  lines.push("");

  process.stdout.write(lines.join("\n"));
}

main()
  .catch((err) => {
    process.stderr.write(`us-cik-unmatched-report failed: ${String(err)}\n`);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
