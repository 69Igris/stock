#!/usr/bin/env tsx
/**
 * MONEY-205 - StockRatios coverage audit.
 *
 * Compares active NSE/BSE equities against StockRatios rows to find
 * the gaps: stocks where users will see "-" in PE / ROE / etc on the
 * screener because we never synced fundamentals.
 *
 * Usage:
 *   yarn tsx scripts/data/audit-stock-ratios-coverage.ts
 *
 * Output: JSON to stdout (pipe to a file for archival), plus a
 * human-readable summary to stderr. Exit 1 if coverage falls below
 * the 80% target so this script can be wired to CI.
 *
 * ## What "covered" means, and what it used to mean (MONEY-1238)
 *
 * It used to mean **a row exists**: `covered.add(r.symbol)` over every
 * `StockRatios` row, feeding a `process.exit(1)` gate. That measured the wrong
 * thing in the direction that always reads as success. Every ratio column on
 * the model is `Float?`, and `xbrl-ratios` PARTIAL-updates — a column a given
 * filing cannot support keeps whatever was already there, which for a fresh row
 * is nothing. So a universe of rows carrying an id, a symbol, an exchange and
 * 25 nulls scored **100%** while every user saw "-" in every column, and the
 * exit gate agreed with them.
 *
 * The headline is now the count of instruments whose row carries at least
 * {@link MIN_POPULATED_CORE_FIELDS} of {@link CORE_RATIO_FIELDS}, and the gate
 * runs off THAT.
 *
 * Three numbers are reported rather than one, because their DIFFERENCES are the
 * diagnosis and no single figure can carry it:
 *
 *   withRow        a row exists                 (what the old script called
 *                                                "coverage")
 *   withAnyRatio   >= 1 owned column populated
 *   withCoreRatios >= MIN_POPULATED_CORE_FIELDS of the core set — the headline
 *
 * `withRow` >> `withCoreRatios` is the empty-shell case above. `withAnyRatio`
 * >> `withCoreRatios` is the subtler one and the reason a bare "any non-null"
 * test is not enough on its own: `marketCap`, `pe`, `pb`, `beta` and
 * `dividendYield` ride the PRICE clock and are written nightly off the close,
 * while the profitability, growth and leverage columns ride the FILING clock.
 * A universe where the price leg runs and the filing leg does not would score
 * 100% on "any non-null" and still show "-" for ROE on every stock — which is
 * the same false pass one layer down.
 *
 * The two analyst columns (`targetPrice`, `recommendation`) are deliberately
 * excluded: MONEY-1220 leaves them null on purpose rather than scraping
 * sell-side opinion, so counting them would score a deliberate policy as a gap.
 *
 * Future (deferred to enrichment ticket - described inline below):
 *   The MONEY-205 description suggests extending `financial-data-sync`
 *   with a `tier: "gap"` mode that re-fetches only uncovered symbols.
 *   That worker change is its own ticket - this audit is the trigger.
 *   (`financial-data-sync` has since been RETIRED — MONEY-1220. The nightly
 *   `xbrl-ratios` job is what fills these columns now, so a gap this audit
 *   reports is a question for that job, not for the retired one.)
 */

import { prisma } from "@usemoney/database";

/**
 * The columns a reader of the screener actually sees, split by which clock
 * writes them (the schema's own distinction — see `StockRatios.ratiosPriceDate`
 * / `ratiosFilingId`).
 *
 * Deliberately NOT every owned column. The 3Y/5Y CAGRs are null by design until
 * the backfill has laid down 4 and 6 fiscal years, and `enterpriseValue` /
 * `evToEbitda` / `pegRatio` are derived from the others — including them would
 * make the threshold below mean something different for a young universe than
 * for a mature one.
 */
const PRICE_CLOCK_FIELDS = [
  "pe",
  "pb",
  "marketCap",
  "dividendYield",
  "beta",
] as const;

const FILING_CLOCK_FIELDS = [
  "roe",
  "roce",
  "netMargin",
  "operatingMargin",
  "debtToEquity",
  "currentRatio",
  "revenueGrowth",
  "earningsGrowth",
] as const;

const CORE_RATIO_FIELDS = [
  ...PRICE_CLOCK_FIELDS,
  ...FILING_CLOCK_FIELDS,
] as const;

type CoreRatioField = (typeof CORE_RATIO_FIELDS)[number];

/**
 * Every column we OWN — i.e. every column some job of ours is supposed to be
 * able to write. Used only for `withAnyRatio`, the middle diagnostic.
 */
const OWNED_RATIO_FIELDS = [
  ...CORE_RATIO_FIELDS,
  "roa",
  "grossMargin",
  "evToEbitda",
  "pegRatio",
  "interestCoverage",
  "enterpriseValue",
  "ebitdaMargin",
  "assetTurnover",
  "revenueGrowth3Y",
  "earningsGrowth3Y",
  "revenueGrowth5Y",
  "earningsGrowth5Y",
] as const;

/**
 * How many core columns a row needs before it counts as covered.
 *
 * Three, not one. One is satisfiable by the price leg alone (see the header),
 * which is exactly the false pass this rewrite exists to close; requiring the
 * full set would fail every legitimately-partial row, and `xbrl-ratios`
 * partial-updates by design. Three is the smallest number that cannot be
 * reached without at least one column that took real work to compute.
 */
const MIN_POPULATED_CORE_FIELDS = 3;

interface Coverage {
  exchange: "NSE" | "BSE";
  active: number;
  /** A StockRatios row exists. The OLD headline — kept as a diagnostic. */
  withRow: number;
  /** >= 1 of OWNED_RATIO_FIELDS is non-null. */
  withAnyRatio: number;
  /** >= MIN_POPULATED_CORE_FIELDS of CORE_RATIO_FIELDS. The headline. */
  withCoreRatios: number;
  /** withCoreRatios / active, 0-1. */
  coverage: number;
  /** Per-core-field fill rate, 0-1, over ACTIVE instruments. */
  fieldFill: Record<CoreRatioField, number>;
  /** Symbols with no row at all, capped. */
  missingRow: string[];
  /** Symbols WITH a row that fails the core threshold, capped. Distinct from
   *  `missingRow`: an empty shell needs a re-derive, not a first fetch. */
  emptyShell: string[];
}

const COVERAGE_TARGET = 0.8;
const MAX_MISSING_PER_EXCHANGE = 200;

/** A `Float?` column counts as populated only when it holds a real number. */
function populated(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

async function audit(exchange: "NSE" | "BSE"): Promise<Coverage> {
  const [active, ratios] = await Promise.all([
    prisma.instrumentMapping.findMany({
      where: { isActive: true, instrumentType: "EQUITY", exchange },
      select: { symbol: true, id: true },
    }),
    // Selecting the COLUMNS, not just the keys. The whole point of this audit
    // is that a row's existence says nothing about whether it holds anything;
    // that question cannot be answered without reading the values.
    //
    // Not a `where` on the columns, deliberately: on Prisma's Mongo connector
    // `{ field: null }` matches only documents that CARRY the key, and
    // `prisma db push` creates indexes rather than fields — so a filter would
    // silently exclude every row written before the column existed. Reading the
    // values and testing them in JS is immune to that (MONEY-1050 / 1234 /
    // 1235 / 1236).
    prisma.stockRatios.findMany({
      where: { exchange },
      select: {
        symbol: true,
        instrumentId: true,
        ...Object.fromEntries(OWNED_RATIO_FIELDS.map((f) => [f, true])),
      },
    }),
  ]);

  // Match on instrumentId (canonical) AND symbol (fallback for older rows
  // where instrumentId was nullable)
  const rowByKey = new Map<string, Record<string, unknown>>();
  for (const r of ratios as unknown as Array<Record<string, unknown>>) {
    if (typeof r.symbol === "string") rowByKey.set(r.symbol, r);
    if (typeof r.instrumentId === "string") rowByKey.set(r.instrumentId, r);
  }

  const fieldHits: Record<string, number> = {};
  for (const f of CORE_RATIO_FIELDS) fieldHits[f] = 0;

  const missingRow: string[] = [];
  const emptyShell: string[] = [];
  let withRow = 0;
  let withAnyRatio = 0;
  let withCoreRatios = 0;

  for (const inst of active) {
    const row = rowByKey.get(inst.symbol) ?? rowByKey.get(inst.id);
    if (!row) {
      missingRow.push(inst.symbol);
      continue;
    }
    withRow++;

    if (
      (OWNED_RATIO_FIELDS as readonly string[]).some((f) => populated(row[f]))
    )
      withAnyRatio++;

    let core = 0;
    for (const f of CORE_RATIO_FIELDS) {
      if (populated(row[f])) {
        core++;
        fieldHits[f] = (fieldHits[f] ?? 0) + 1;
      }
    }
    if (core >= MIN_POPULATED_CORE_FIELDS) withCoreRatios++;
    else emptyShell.push(inst.symbol);
  }

  const coverage = active.length === 0 ? 0 : withCoreRatios / active.length;

  const fieldFill = Object.fromEntries(
    CORE_RATIO_FIELDS.map((f) => [
      f,
      active.length === 0 ? 0 : (fieldHits[f] ?? 0) / active.length,
    ]),
  ) as Record<CoreRatioField, number>;

  return {
    exchange,
    active: active.length,
    withRow,
    withAnyRatio,
    withCoreRatios,
    coverage,
    fieldFill,
    missingRow: missingRow.slice(0, MAX_MISSING_PER_EXCHANGE).sort(),
    emptyShell: emptyShell.slice(0, MAX_MISSING_PER_EXCHANGE).sort(),
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const t0 = Date.now();
  const [nse, bse] = await Promise.all([audit("NSE"), audit("BSE")]);
  const totalActive = nse.active + bse.active;
  const totalCovered = nse.withCoreRatios + bse.withCoreRatios;
  const totalWithRow = nse.withRow + bse.withRow;
  const totalWithAny = nse.withAnyRatio + bse.withAnyRatio;
  const overall = totalActive === 0 ? 0 : totalCovered / totalActive;

  const report = {
    runAt: new Date().toISOString(),
    target: COVERAGE_TARGET,
    definition: {
      coreFields: CORE_RATIO_FIELDS,
      minPopulatedCoreFields: MIN_POPULATED_CORE_FIELDS,
      note: "coverage = instruments whose StockRatios row has >= minPopulatedCoreFields of coreFields. Row existence alone is reported separately as withRow.",
    },
    overall: {
      active: totalActive,
      withRow: totalWithRow,
      withAnyRatio: totalWithAny,
      withCoreRatios: totalCovered,
      coverage: overall,
    },
    nse,
    bse,
    durationMs: Date.now() - t0,
  };

  console.log(JSON.stringify(report, null, 2));

  // Human-readable summary to stderr so JSON stdout stays pipe-able.
  const fieldLine = (c: Coverage): string =>
    CORE_RATIO_FIELDS.map((f) => `${f} ${pct(c.fieldFill[f])}`).join("  ");

  process.stderr.write(
    `\n=== StockRatios coverage audit ===\n` +
      `NSE: ${nse.withCoreRatios.toLocaleString()}/${nse.active.toLocaleString()} = ${pct(nse.coverage)} ` +
      `(row exists: ${pct(nse.active === 0 ? 0 : nse.withRow / nse.active)}, ` +
      `any ratio: ${pct(nse.active === 0 ? 0 : nse.withAnyRatio / nse.active)})\n` +
      `BSE: ${bse.withCoreRatios.toLocaleString()}/${bse.active.toLocaleString()} = ${pct(bse.coverage)} ` +
      `(row exists: ${pct(bse.active === 0 ? 0 : bse.withRow / bse.active)}, ` +
      `any ratio: ${pct(bse.active === 0 ? 0 : bse.withAnyRatio / bse.active)})\n` +
      `Overall: ${totalCovered.toLocaleString()}/${totalActive.toLocaleString()} = ${pct(overall)} (target >= ${pct(COVERAGE_TARGET)})\n` +
      `\nPer-field fill (NSE): ${fieldLine(nse)}\n` +
      `Per-field fill (BSE): ${fieldLine(bse)}\n` +
      `\nNo row at all (NSE, first 10): ${nse.missingRow.slice(0, 10).join(", ")}\n` +
      `Row but < ${MIN_POPULATED_CORE_FIELDS} core ratios (NSE, first 10): ${nse.emptyShell.slice(0, 10).join(", ")}\n` +
      `Row but < ${MIN_POPULATED_CORE_FIELDS} core ratios (BSE, first 10): ${bse.emptyShell.slice(0, 10).join(", ")}\n` +
      `Took ${report.durationMs} ms.\n`,
  );

  // The empty-shell count is called out separately because it is the finding
  // the old row-existence measure could not produce at all: these instruments
  // ARE in stock_ratios and would have scored as covered.
  const emptyShells = totalWithRow - totalCovered;
  if (emptyShells > 0) {
    process.stderr.write(
      `\nNOTE: ${emptyShells.toLocaleString()} instrument(s) have a StockRatios row ` +
        `carrying fewer than ${MIN_POPULATED_CORE_FIELDS} core ratios. The old ` +
        `row-existence measure counted every one of these as covered.\n`,
    );
  }

  if (overall < COVERAGE_TARGET) {
    process.stderr.write(
      `\n⚠️  Coverage ${pct(overall)} is below the ${pct(COVERAGE_TARGET)} target.\n` +
        `   Next step: check the nightly \`xbrl-ratios\` job (it replaced\n` +
        `   financial-data-sync in MONEY-1220) against the symbols above —\n` +
        `   a missing ROW is a never-derived instrument, an empty SHELL is a\n` +
        `   derive that ran and produced nothing. Tracked in MONEY-205 follow-up.\n`,
    );
    process.exit(1);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`audit failed: ${String(err)}\n`);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
