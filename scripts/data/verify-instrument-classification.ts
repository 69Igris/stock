/**
 * MONEY-1099 (P6) verification harness — READ-ONLY, no writes ever.
 *
 * Three modes:
 *   assert   — the ticket's post-apply assertions (b) and (c) + sector sums
 *   snapshot — capture N retyped rows so the 22:00 IST instrument-sync can be
 *              proven NOT to revert them
 *   compare  — re-read a snapshot's ids and diff field-by-field
 *
 * Assertion (a) — "zero EQUITY rows absent from both exchange equity masters" —
 * is deliberately NOT reimplemented here. Re-running the reclassify DRY RUN and
 * reading "Would change 0 rows" asks the same question through the SAME code
 * path; a second implementation of the master lookup would drift from the
 * classifier and disagree silently, which is the defect class this whole ticket
 * is about.
 *
 * Usage:
 *   DATABASE_URL=… npx tsx p6-verify.ts assert
 *   DATABASE_URL=… npx tsx p6-verify.ts snapshot <file> [count]
 *   DATABASE_URL=… npx tsx p6-verify.ts compare  <file>
 */
import { prisma } from "@usemoney/database";
import { readFileSync, writeFileSync } from "fs";

const MODE = process.argv[2] ?? "assert";
const FILE = process.argv[3];
const COUNT = Number(process.argv[4] ?? 20);

const FIELDS = [
  "symbol",
  "exchange",
  "series",
  "instrumentType",
  "sector",
  "industry",
] as const;

async function assertAll() {
  const out: Record<string, unknown> = {};

  // (b) ZERO DEBT rows carrying a sector.
  const debtWithSector = await prisma.instrumentMapping.count({
    where: { instrumentType: "DEBT", sector: { not: null } },
  });
  out.b_debt_with_sector = {
    count: debtWithSector,
    pass: debtWithSector === 0,
  };

  // (c) `series` is no longer uniformly "EQ".
  const agg: any = await prisma.$runCommandRaw({
    aggregate: "instrument_mappings",
    pipeline: [
      { $match: { isActive: true } },
      { $group: { _id: "$series", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 25 },
    ],
    cursor: {},
  });
  const series = (agg?.cursor?.firstBatch ?? []) as Array<{
    _id: string | null;
    n: number;
  }>;
  const total = series.reduce((s, r) => s + r.n, 0);
  const eq =
    series.find((r) => String(r._id ?? "").toUpperCase() === "EQ")?.n ?? 0;
  out.c_series_spread = {
    distinct: series.length,
    eqShare: total ? Number((eq / total).toFixed(4)) : 0,
    top: series.slice(0, 10),
    pass: series.length > 2 && (total ? eq / total : 1) < 0.9,
  };

  // Type mix — context for both assertions.
  const types: any = await prisma.$runCommandRaw({
    aggregate: "instrument_mappings",
    pipeline: [
      { $match: { isActive: true } },
      { $group: { _id: "$instrumentType", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ],
    cursor: {},
  });
  out.type_mix = types?.cursor?.firstBatch;

  // Sector sums — the /discover/markets check. Every catalog-wide sector
  // aggregate filters instrumentType EQUITY, so that is the denominator.
  const sectors: any = await prisma.$runCommandRaw({
    aggregate: "instrument_mappings",
    pipeline: [
      { $match: { isActive: true, instrumentType: "EQUITY" } },
      { $group: { _id: "$sector", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ],
    cursor: {},
  });
  const rows = (sectors?.cursor?.firstBatch ?? []) as Array<{
    _id: string | null;
    n: number;
  }>;
  const equityTotal = await prisma.instrumentMapping.count({
    where: { isActive: true, instrumentType: "EQUITY" },
  });
  const summed = rows.reduce((s, r) => s + r.n, 0);
  out.sector_sums = {
    equityUniverse: equityTotal,
    summedAcrossSectors: summed,
    sumsMatch: summed === equityTotal,
    realEstate: rows.find((r) => r._id === "Real Estate")?.n ?? 0,
    financialServices: rows.find((r) => r._id === "Financial Services")?.n ?? 0,
    nullSector: rows.find((r) => r._id === null)?.n ?? 0,
    distinctSectors: rows.filter((r) => r._id !== null).length,
  };

  console.log(JSON.stringify(out, null, 2));

  // The assertions DECIDE — MONEY-1238. Every `pass` flag and `sumsMatch` above
  // was computed, serialised into the JSON, and read by nothing: `assert` mode
  // (the DEFAULT mode) set no exit code at all, while its sibling `compare`
  // mode does. scripts/README.md states this script "asserts" the equity
  // universe, which was true of its output and false of its exit status.
  const failures: string[] = [];
  for (const [name, v] of Object.entries(out)) {
    const o = v as { pass?: boolean; sumsMatch?: boolean };
    if (o.pass === false) failures.push(name);
    if (o.sumsMatch === false) failures.push(`${name}.sumsMatch`);
  }
  if (failures.length > 0) {
    console.error(
      `ASSERTIONS FAILED: ${failures.join(", ")} — see the JSON above for the ` +
        `numbers behind each.`,
    );
    process.exitCode = 1;
  }
}

async function snapshot() {
  if (!FILE) throw new Error("snapshot needs a target file path");
  // Sample retyped rows: DEBT, sector cleared. These are exactly the rows the
  // 22:00 instrument-sync used to clobber back to EQUITY/EQ before MONEY-1093
  // gave providers `mapToUpdate`.
  const rows = await prisma.instrumentMapping.findMany({
    where: { instrumentType: "DEBT", isActive: true },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      series: true,
      instrumentType: true,
      sector: true,
      industry: true,
    },
    orderBy: { symbol: "asc" },
    take: COUNT,
  });
  writeFileSync(
    FILE,
    JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 2),
  );
  console.log(`Snapshot of ${rows.length} retyped rows -> ${FILE}`);
  console.log(
    rows
      .slice(0, 5)
      .map(
        (r) =>
          `  ${r.exchange} ${r.symbol} series=${r.series} type=${r.instrumentType} sector=${r.sector}`,
      )
      .join("\n"),
  );
}

async function compare() {
  if (!FILE) throw new Error("compare needs the snapshot file path");
  const snap = JSON.parse(readFileSync(FILE, "utf8")) as {
    takenAt: string;
    rows: Array<Record<string, string | null>>;
  };
  const ids = snap.rows.map((r) => String(r.id));
  const now = await prisma.instrumentMapping.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      series: true,
      instrumentType: true,
      sector: true,
      industry: true,
    },
  });
  const byId = new Map(now.map((r) => [r.id, r as Record<string, unknown>]));

  const drifted: Array<Record<string, unknown>> = [];
  for (const before of snap.rows) {
    const after = byId.get(String(before.id));
    if (!after) {
      drifted.push({
        id: before.id,
        symbol: before.symbol,
        change: "ROW DISAPPEARED",
      });
      continue;
    }
    for (const f of FIELDS) {
      if (String(before[f] ?? "") !== String(after[f] ?? "")) {
        drifted.push({
          symbol: before.symbol,
          field: f,
          before: before[f],
          after: after[f],
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        snapshotTakenAt: snap.takenAt,
        comparedAt: new Date().toISOString(),
        rowsChecked: snap.rows.length,
        driftedFields: drifted.length,
        verdict:
          drifted.length === 0
            ? "NO REVERT — every field unchanged"
            : "REVERTED",
        drifted,
      },
      null,
      2,
    ),
  );
  if (drifted.length > 0) process.exitCode = 1;
}

async function main() {
  if (MODE === "assert") await assertAll();
  else if (MODE === "snapshot") await snapshot();
  else if (MODE === "compare") await compare();
  else throw new Error(`unknown mode: ${MODE}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("FATAL:", (e as Error).message.split("\n")[0]);
  await prisma.$disconnect();
  process.exit(1);
});
