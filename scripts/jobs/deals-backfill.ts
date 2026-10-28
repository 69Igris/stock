/**
 * Bulk / block deal HISTORY — MONEY-1100 (P4.6, the missing leg).
 *
 * ## Why this exists
 *
 * `institutional_deals` was near-empty and it was not a parser bug. The
 * archived family is NSE's `bulk.csv` / `block.csv`, which are ROLLING,
 * UNDATED files — the registry says so and marks them `backfillable: false`,
 * because a dated fetch would archive TODAY's deals under a past key. Only
 * three files exist (one per weekday since report-archive-sync shipped), and
 * that is all that will ever exist from that source.
 *
 * The registry comment names the real source: *"Deal history comes from the
 * historicalOR API in P4, not from here."* P4.6 built the rolling-file parser
 * and never built that leg. This is that leg.
 *
 *   GET /api/historicalOR/bulk-block-short-deals
 *       ?optionType=bulk_deals|block_deals&from=DD-MM-YYYY&to=DD-MM-YYYY
 *
 * Verified live: July 2026 alone returns 70 bulk and 40 block rows.
 *
 * ## Why there is no second parser
 *
 * `DEAL_COLUMNS` in `deals.ts` already carries the `bd*` aliases — `bddtdate`,
 * `bdsymbol`, `bdclientname` — precisely so this endpoint would resolve
 * without one, and the header normaliser (`toLowerCase().replace(/[^a-z0-9]/g)`)
 * turns NSE's `BD_DT_DATE` into `bddtdate` exactly. So the JSON is CSV-ified
 * and handed to `parseBulkBlockDeals` unchanged: one parser, one set of
 * tests, one place for a column rename to break loudly.
 *
 * ## HARD LIMIT: this endpoint caps every response at 70 rows
 *
 * Measured, not assumed. The endpoint returns EXACTLY 70 rows for a 7-day,
 * 30-day, 90-day and 365-day range alike — and also for a SINGLE day. Ground
 * truth from the other source proves that is a cap and not the real count:
 * the archived rolling `bulk.csv` for 2026-08-11 carries 103 rows, all for
 * that one day, against the API's 70 for the same date.
 *
 * There is no way around it from here: `csv=true` 404s, and `limit=` /
 * `page=` are ignored (still 70).
 *
 * SO WHAT THIS JOB PRODUCES IS A PARTIAL, BIASED SAMPLE OF HISTORY — real
 * deals, correctly parsed, but only whichever 70 the endpoint returns per
 * window. `institutional_deals` must NOT be treated as complete for any date
 * before the archive started.
 *
 * COMPLETENESS COMES FROM THE OTHER PATH. The nightly `report-archive-sync`
 * captures the rolling bulk.csv / block.csv, and each of those files holds
 * ONE day in full (103 rows for 2026-08-11). Parsing those archived files —
 * the `nse-bulk-deals` / `nse-block-deals` families in feed-parse — gives
 * complete daily data from the archive start date forward. This job exists
 * only to reach back BEFORE that date, at the fidelity NSE allows.
 *
 * ## Shape
 *
 * Windowed, paced, and idempotent — the same sha256 `dedupeKey` the nightly
 * path uses, deduped against the DB AND within the batch, so re-running is
 * free and a duplicated row cannot abort a chunk.
 *
 * Usage:
 *   node --import tsx scripts/jobs/deals-backfill.ts --dry-run
 *   node --import tsx scripts/jobs/deals-backfill.ts --years=5
 *   node --import tsx scripts/jobs/deals-backfill.ts --from=2020-01-01 --to=2026-08-12
 */

import "dotenv/config";
import { createHash } from "node:crypto";

import { prisma } from "@usemoney/database";
import {
  parseBulkBlockDeals,
  exactDealKey,
  type InstitutionalDealType,
} from "@usemoney/core/market-data";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const DRY_RUN = argv.includes("--dry-run");
const YEARS = Number(arg("years") ?? 5) || 5;
/** NSE rejects very wide ranges; 90 days is the same bound corp-actions uses. */
const WINDOW_DAYS = Number(arg("window-days") ?? 90) || 90;
const DELAY_MS = Number(arg("delay-ms") ?? 1500) || 1500;

const log = (...a: unknown[]) => console.log("[deals-backfill]", ...a);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** NSE's query format. */
function nseDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Inclusive windows of at most WINDOW_DAYS, oldest first. */
function windows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(from);
  while (cursor <= to) {
    const end = new Date(
      Math.min(cursor.getTime() + (WINDOW_DAYS - 1) * 86_400_000, to.getTime()),
    );
    out.push({ from: new Date(cursor), to: end });
    cursor = new Date(end.getTime() + 86_400_000);
  }
  return out;
}

/**
 * JSON rows -> CSV, so the EXISTING parser handles them.
 *
 * Values are quoted and internal quotes doubled: client names legitimately
 * contain commas ("ABC SECURITIES PVT LTD, MUMBAI") and would otherwise
 * split into extra columns and silently shift every field after them.
 */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const cell = (v: unknown): string =>
    `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ].join("\n");
}

const OPTION_TYPE: Record<InstitutionalDealType, string> = {
  BULK: "bulk_deals",
  BLOCK: "block_deals",
};

/**
 * Fetch one window, retrying a null result.
 *
 * `fetchNseApiJson` collapses EVERY failure to null — timeout, 403 challenge,
 * malformed body — so a transient NSE hiccup is indistinguishable from "no
 * deals in this window" at the call site. The first run lost 9 of 42 fetches
 * that way (21%), and each loss is a silent 90-day hole rather than an error.
 *
 * Retrying costs one extra request on a genuinely empty window and recovers a
 * real one, which is the right trade when the alternative is a gap nobody
 * notices. Backs off so a throttled host is not hammered.
 */
async function fetchWindow(
  dealType: InstitutionalDealType,
  from: Date,
  to: Date,
): Promise<Array<Record<string, unknown>>> {
  const path =
    `/api/historicalOR/bulk-block-short-deals` +
    `?optionType=${OPTION_TYPE[dealType]}` +
    `&from=${nseDate(from)}&to=${nseDate(to)}`;
  let raw: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    raw = await fetchNseApiJson<unknown>(path);
    if (raw !== null) break;
    if (attempt < 3) {
      const wait = 3000 * attempt;
      log(
        `retry ${attempt}/2 for ${OPTION_TYPE[dealType]} ` +
          `${nseDate(from)}..${nseDate(to)} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
  if (raw === null) return [];
  const rows = Array.isArray(raw)
    ? raw
    : ((raw as { data?: unknown[] }).data ?? []);
  return rows.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
}

interface Tally {
  fetched: number;
  parsed: number;
  written: number;
  duplicate: number;
  dropped: number;
  emptyWindows: number;
}

async function writeDeals(
  rows: ReturnType<typeof parseBulkBlockDeals>["rows"],
  tally: Tally,
): Promise<void> {
  if (rows.length === 0) return;
  const withKeys: Array<{ row: (typeof rows)[number]; dedupeKey: string }> = [];
  for (const row of rows) {
    // BigInt() throws on a fractional qty; drop-and-count rather than let one
    // bad cell abort the window (same rule as the nightly writer).
    if (!Number.isInteger(row.qty)) {
      tally.dropped++;
      continue;
    }
    withKeys.push({
      row,
      dedupeKey: createHash("sha256").update(exactDealKey(row)).digest("hex"),
    });
  }
  if (withKeys.length === 0) return;

  const existing = await prisma.institutionalDeal.findMany({
    where: { dedupeKey: { in: withKeys.map((w) => w.dedupeKey) } },
    select: { dedupeKey: true },
  });
  const seen = new Set(existing.map((e) => e.dedupeKey));
  // Dedupe against the DB *and* within the batch — two identical prints in one
  // window would otherwise throw P2002 and lose every other deal in the chunk.
  const fresh = withKeys.filter((w) => {
    if (seen.has(w.dedupeKey)) return false;
    seen.add(w.dedupeKey);
    return true;
  });
  tally.duplicate += withKeys.length - fresh.length;
  if (fresh.length === 0) return;

  const res = await prisma.institutionalDeal.createMany({
    data: fresh.map(({ row, dedupeKey }) => ({
      date: row.date,
      symbol: row.symbol,
      exchange: row.exchange,
      securityName: row.securityName,
      clientName: row.clientName,
      buySell: row.buySell,
      qty: BigInt(row.qty),
      avgPrice: row.avgPrice,
      dealType: row.dealType,
      remarks: row.remarks,
      dedupeKey,
    })),
  });
  tally.written += res.count;
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  const to = arg("to") ? new Date(`${arg("to")}T00:00:00Z`) : new Date();
  const from = arg("from")
    ? new Date(`${arg("from")}T00:00:00Z`)
    : new Date(to.getTime() - YEARS * 365 * 86_400_000);

  const wins = windows(from, to);
  log(
    `${wins.length} windows of <=${WINDOW_DAYS}d from ${nseDate(from)} to ` +
      `${nseDate(to)} — mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`,
  );

  const tally: Tally = {
    fetched: 0,
    parsed: 0,
    written: 0,
    duplicate: 0,
    dropped: 0,
    emptyWindows: 0,
  };

  for (const [i, w] of wins.entries()) {
    for (const dealType of ["BULK", "BLOCK"] as InstitutionalDealType[]) {
      const json = await fetchWindow(dealType, w.from, w.to);
      tally.fetched += json.length;
      if (json.length === 0) {
        tally.emptyWindows++;
      } else {
        const out = parseBulkBlockDeals(toCsv(json), dealType, w.from);
        tally.parsed += out.rows.length;
        if (!DRY_RUN) await writeDeals(out.rows, tally);
      }
      await sleep(DELAY_MS);
    }
    if ((i + 1) % 5 === 0 || i === wins.length - 1) {
      log(
        `window ${i + 1}/${wins.length} (${nseDate(w.from)}..${nseDate(w.to)}): ` +
          `fetched=${tally.fetched} parsed=${tally.parsed} written=${tally.written} ` +
          `dup=${tally.duplicate}`,
      );
    }
  }

  log(
    `DONE: fetched=${tally.fetched} parsed=${tally.parsed} ` +
      `written=${tally.written} duplicate=${tally.duplicate} ` +
      `dropped=${tally.dropped} emptyWindows=${tally.emptyWindows}` +
      `${DRY_RUN ? " (dry-run, nothing written)" : ""}`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[deals-backfill] failed:", err);
  process.exitCode = 1;
});
