/**
 * Delete Yahoo price bars for sessions that never happened — MONEY-1175.
 *
 * ## What these rows are
 *
 * After the re-parse consolidated every series onto the exchange's own bhavcopy,
 * a residue of YAHOO rows survived on dates where NO exchange row exists for ANY
 * instrument. They are not "dates we failed to repair" — there is no bhavcopy to
 * repair them with, because the market was SHUT.
 *
 * The dates identify themselves:
 *
 *     1996-01-26 Republic Day      1996-08-15 Independence Day
 *     1996-10-02 Gandhi Jayanti    1996-12-25 Christmas
 *     1996-04-05 Good Friday       …and NINE Sundays
 *
 * A Sunday bar is not a data-quality question. No session occurred, so no open,
 * high, low or close exists to report.
 *
 * ## Why they must go rather than stay
 *
 * Yahoo's closes are SPLIT-ADJUSTED while the exchange's are raw (proved for
 * RELIANCE: the bhavcopy/Yahoo ratio is a step function — 13.933 -> 8.831 ->
 * 4.364 -> 2.197 — stepping exactly at the 2006 demerger and the 2009/2017 1:1
 * bonuses). So each surviving phantom sits at roughly 1/28th of the surrounding
 * raw prices and draws a full-depth spike straight down and back up. Every one
 * costs TWO source boundaries; on RELIANCE they took the boundary count from 28
 * to 235.
 *
 * Deleting leaves a one-day hole in a thirty-year series, which the chart simply
 * does not draw. A missing bar is honest. A bar at 1/28th the price is a lie
 * that a user will read as a crash.
 *
 * ## The rule, and why it is conservative in the right direction
 *
 * Delete a row only when ALL of these hold:
 *   1. its source ranks BELOW the exchange (never touch a bhavcopy row), and
 *   2. NOT ONE instrument in the entire universe has an exchange-sourced row on
 *      that date, and
 *   3. the date is older than a grace window (so today's data is never removed
 *      before the nightly bhavcopy has had a chance to land).
 *
 * Condition 2 is deliberately stricter than "the market was closed". If the
 * market DID trade and our archive is simply missing that day, the row still
 * goes — and that is still correct, because an isolated adjusted bar amid raw
 * ones is misinformation either way, while the gap it leaves is invisible and
 * self-heals the moment the real file is archived and parsed.
 *
 * Usage:
 *   node --import tsx scripts/migrations/purge-phantom-yahoo-bars.ts
 *   node --import tsx scripts/migrations/purge-phantom-yahoo-bars.ts --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";
import { priceSourceAuthority } from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
/** Days at the head of the series that are never touched. */
const GRACE_DAYS = Number(arg("grace-days") ?? 10) || 10;
/**
 * RULE 2 cutoff. Before this date the exchange archive is comprehensive
 * (BHAVCOPY_HIST covers 1994-11-03 onward), so a surviving lower-authority row
 * for an instrument that HAS exchange coverage is residue, not coverage.
 *
 * Measured: 557 such rows across exactly 3 instruments, and the reason is
 * worse than a basis mismatch — they are bars for sessions that could not have
 * happened. TCS carries 507 rows in 2002-2004 but did not list until
 * 2004-08-25; WAAREE carries 49 in 2021 and listed in 2024. Yahoo back-projects
 * a history the stock never had. The third is RELIANCE's single 1997-06-02
 * island. None of the three would lose their only data — they hold 5,423, 643
 * and 7,856 exchange rows respectively.
 */
const RESIDUE_BEFORE = arg("residue-before") ?? "2024-01-01";
const SKIP_RESIDUE = argv.includes("--no-residue");

const log = (...a: unknown[]) => console.log("[purge-phantom]", ...a);

/** Sources that ARE the exchange — their presence proves a session happened. */
const EXCHANGE_SOURCES = ["BHAVCOPY", "BHAVCOPY_HIST"];

const isoOf = (v: { $date: string } | string): string =>
  typeof v === "string" ? v : v.$date;

async function datesWithSource(sources?: string[]): Promise<Set<number>> {
  const res = (await prisma.$runCommandRaw({
    aggregate: "daily_prices",
    pipeline: [
      ...(sources ? [{ $match: { source: { $in: sources } } }] : []),
      { $group: { _id: "$date" } },
    ],
    cursor: { batchSize: 100_000 },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: Array<{ _id: { $date: string } | string }> } };
  return new Set(
    res.cursor.firstBatch.map((d) => new Date(isoOf(d._id)).getTime()),
  );
}

async function main(): Promise<void> {
  const cutoff = Date.now() - GRACE_DAYS * 86_400_000;
  log(
    `grace window ${GRACE_DAYS}d (nothing after ` +
      `${new Date(cutoff).toISOString().slice(0, 10)} is touched) — ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  const exchangeDates = await datesWithSource(EXCHANGE_SOURCES);
  log(`dates with at least one EXCHANGE row: ${exchangeDates.size.toLocaleString()}`);

  // Non-exchange rows, grouped by date, so we can test each date once.
  const res = (await prisma.$runCommandRaw({
    aggregate: "daily_prices",
    pipeline: [
      { $match: { source: { $nin: EXCHANGE_SOURCES } } },
      { $group: { _id: { date: "$date", source: "$source" }, n: { $sum: 1 } } },
    ],
    cursor: { batchSize: 100_000 },
    allowDiskUse: true,
  })) as {
    cursor: {
      firstBatch: Array<{
        _id: { date: { $date: string } | string; source: string };
        n: number;
      }>;
    };
  };

  const doomed: Array<{ iso: string; source: string; n: number }> = [];
  let keptHasExchange = 0;
  let keptInGrace = 0;
  let keptAuthoritative = 0;

  for (const row of res.cursor.firstBatch) {
    const iso = isoOf(row._id.date);
    const t = new Date(iso).getTime();

    // Guard 1 — never delete something that outranks the exchange feed. Uses
    // the shared authority table so a future licensed feed is protected the day
    // it is added, without anyone remembering to edit this script.
    if (priceSourceAuthority(row._id.source) >= priceSourceAuthority("BHAVCOPY")) {
      keptAuthoritative += row.n;
      continue;
    }
    if (exchangeDates.has(t)) {
      keptHasExchange += row.n;
      continue;
    }
    if (t > cutoff) {
      keptInGrace += row.n;
      continue;
    }
    doomed.push({ iso, source: row._id.source, n: row.n });
  }

  const total = doomed.reduce((s, d) => s + d.n, 0);
  const dates = new Set(doomed.map((d) => d.iso.slice(0, 10)));
  log(
    `PHANTOM: ${total.toLocaleString()} row(s) across ${dates.size} date(s) ` +
      `with no exchange data anywhere`,
  );
  log(
    `kept: ${keptHasExchange.toLocaleString()} (date has exchange rows), ` +
      `${keptInGrace.toLocaleString()} (inside grace window), ` +
      `${keptAuthoritative.toLocaleString()} (source outranks bhavcopy)`,
  );

  const weekend = [...dates].filter((d) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return w === 0 || w === 6;
  });
  log(
    `of those dates, ${weekend.length} fall on a WEEKEND — proof the bars are ` +
      `synthetic, not merely unarchived`,
  );
  log(`sample: ${[...dates].sort().slice(0, 10).join(" ")}`);

  if (!APPLY) {
    log("dry-run: pass --apply to delete. Nothing changed.");
    if (!SKIP_RESIDUE) await reportLegacyResidue();
    await prisma.$disconnect();
    return;
  }

  // NB: no early return when total === 0. Rule 1 being already-clean says
  // nothing about rule 2, and an early exit here silently skipped it.
  let deleted = 0;
  for (const d of doomed) {
    const out = (await prisma.$runCommandRaw({
      delete: "daily_prices",
      deletes: [
        { q: { date: { $date: d.iso }, source: d.source }, limit: 0 },
      ],
    })) as { n?: number };
    deleted += out.n ?? 0;
  }
  log(`DONE: deleted ${deleted.toLocaleString()} phantom row(s) [rule 1: non-session dates]`);

  if (!SKIP_RESIDUE) await purgeLegacyResidue();
  await prisma.$disconnect();
}

/**
 * RULE 2 — lower-authority rows in the pre-2024 era for instruments that DO
 * have exchange coverage. See RESIDUE_BEFORE for why these are always residue.
 *
 * Deleted per instrument, and ONLY when that instrument has exchange rows, so
 * an instrument whose entire history happens to be third-party keeps it.
 */
async function reportLegacyResidue(): Promise<void> {
  const before = new Date(`${RESIDUE_BEFORE}T00:00:00.000Z`);
  const n = await prisma.dailyPrice.count({
    where: { source: { notIn: EXCHANGE_SOURCES }, date: { lt: before } },
  });
  log(`rule 2 (dry-run): ${n.toLocaleString()} pre-${RESIDUE_BEFORE} low-authority row(s)`);
}

async function purgeLegacyResidue(): Promise<void> {
  const before = new Date(`${RESIDUE_BEFORE}T00:00:00.000Z`);
  const rows = await prisma.dailyPrice.findMany({
    where: { source: { notIn: EXCHANGE_SOURCES }, date: { lt: before } },
    select: { instrumentId: true },
  });
  const perInstrument = new Map<string, number>();
  for (const r of rows)
    perInstrument.set(r.instrumentId, (perInstrument.get(r.instrumentId) ?? 0) + 1);

  log(
    `rule 2: ${rows.length.toLocaleString()} pre-${RESIDUE_BEFORE} low-authority ` +
      `row(s) across ${perInstrument.size} instrument(s)`,
  );

  let deleted = 0;
  let keptSoleCoverage = 0;
  for (const [instrumentId, n] of perInstrument) {
    const exchangeRows = await prisma.dailyPrice.count({
      where: { instrumentId, source: { in: EXCHANGE_SOURCES } },
    });
    if (exchangeRows === 0) {
      // Its only history. A wrong-basis series still beats no series.
      keptSoleCoverage += n;
      continue;
    }
    const res = await prisma.dailyPrice.deleteMany({
      where: {
        instrumentId,
        source: { notIn: EXCHANGE_SOURCES },
        date: { lt: before },
      },
    });
    deleted += res.count;
  }
  log(
    `rule 2 DONE: deleted ${deleted.toLocaleString()}, ` +
      `kept ${keptSoleCoverage.toLocaleString()} (sole coverage)`,
  );
}

main().catch((err) => {
  console.error("[purge-phantom] failed:", err);
  process.exitCode = 1;
});
