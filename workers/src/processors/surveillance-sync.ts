/**
 * NSE surveillance sync — ASM + GSM (MONEY-1189, P4.5).
 *
 * ## Why this job exists
 *
 * `StockFlag` held 86,005 SURVEILLANCE rows and every one of them was GSM,
 * scraped incidentally out of `nse-sec-list`. ASM — the Additional Surveillance
 * Measure, the framework that flags recent price-driven surveillance and the
 * one the feature was specified around — was entirely absent, because the two
 * registered archive paths for it (`REG_IND_*.csv`, `REG1_IND_*.csv`) 404 and
 * have done for as long as we have probed them.
 *
 * NSE serves both frameworks as live JSON instead: `/api/reportASM` (long-term
 * and short-term buckets) and `/api/reportGSM` (a bare array). Probed
 * 2026-08-12 from our own egress with the cookie client — 132 + 66 + 82 rows,
 * every one carrying symbol and ISIN.
 *
 * ## Why it must run DAILY, and why a miss is unrecoverable
 *
 * Neither endpoint takes a date. They serve TODAY's list and nothing else —
 * there is no history to walk and no backfill to write later. A day we do not
 * fetch is a day that never enters the record, which is the opposite of the
 * dated CSV families where the archive can always be re-walked. That is also
 * why `fetchNseApiJson` archives the raw response (P5.7): the bytes are the
 * only durable copy, and QA replays them rather than re-scraping.
 *
 * ## Idempotency
 *
 * `StockFlag` carries no unique constraint on purpose — a unique on
 * (symbol,date,kind) would collapse a 40-day run into one row and destroy the
 * run length, which IS the datum. The dated CSV families get their re-run
 * safety from feed-parse's `family_date` checkpoint; this job has no such
 * checkpoint, so it replaces its OWN (source, date) rows before inserting.
 * Scoped to the two new sources, so it can never touch a row written by any
 * other feed.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import {
  parseAsmReport,
  parseGsmReport,
  STOCK_FLAG_SOURCES,
  type StockFlagRow,
} from "@usemoney/core/market-data";
import {
  buildInstrumentIndex,
  resolveInstrumentId,
  type InstrumentIndex,
} from "./bhavcopy-sync-logic";

const logger = {
  info: (data: unknown, msg: string) => console.log(`[surveillance-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) => console.warn(`[surveillance-sync] ${msg}`, data),
  error: (data: unknown, msg: string) => console.error(`[surveillance-sync] ${msg}`, data),
};

/** IST is UTC+05:30 with no DST, so the trading day is exact arithmetic. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC midnight of the current IST calendar day. */
function istToday(): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

export interface SurveillanceSyncResult {
  ok: boolean;
  frameworks: Array<{
    source: string;
    fetched: boolean;
    parsed: number;
    skipped: number;
    written: number;
    resolved: number;
  }>;
}

async function writeFlags(
  source: string,
  rows: readonly StockFlagRow[],
  index: InstrumentIndex,
): Promise<{ written: number; resolved: number }> {
  if (rows.length === 0) return { written: 0, resolved: 0 };

  const data = rows.map((r) => ({
    symbol: r.symbol,
    exchange: "NSE",
    series: r.series,
    instrumentId:
      resolveInstrumentId(
        { symbol: r.symbol, exchange: "NSE", isin: r.isin ?? null },
        index,
      ) ?? null,
    date: r.date,
    kind: r.kind,
    value: r.value,
    source: r.source,
  }));

  // Replace this source's rows for the days present in THIS payload. Scoped by
  // source AND date so a re-run within the same day is a no-op rather than a
  // duplicate, while yesterday's rows are untouched.
  const days = [...new Set(data.map((d) => d.date.getTime()))].map((t) => new Date(t));
  await prisma.stockFlag.deleteMany({ where: { source, date: { in: days } } });

  const res = await prisma.stockFlag.createMany({ data });
  return {
    written: res.count,
    resolved: data.filter((d) => d.instrumentId !== null).length,
  };
}

export async function processSurveillanceSync(): Promise<SurveillanceSyncResult> {
  const day = istToday();
  const frameworks: SurveillanceSyncResult["frameworks"] = [];
  let ok = true;

  // Built ONCE for both frameworks. It is a findMany over every
  // InstrumentMapping (~22k rows), and ASM + GSM resolve against the same
  // universe, so building it per framework doubled the read for nothing.
  //
  // ISIN-first resolution: these payloads carry an ISIN for every row, and ISIN
  // is the durable identity — a symbol can be reassigned to a different company
  // after a rename, so joining on the symbol alone can attach a surveillance
  // warning to the wrong business (MONEY-1177).
  const index = buildInstrumentIndex(
    await prisma.instrumentMapping.findMany({
      select: { id: true, symbol: true, exchange: true, isin: true },
    }),
  );

  const jobs = [
    {
      source: STOCK_FLAG_SOURCES.asm,
      path: "/api/reportASM",
      parse: parseAsmReport,
    },
    {
      source: STOCK_FLAG_SOURCES.gsm,
      path: "/api/reportGSM",
      parse: parseGsmReport,
    },
  ] as const;

  for (const job of jobs) {
    const payload = await fetchNseApiJson(job.path);
    if (payload === null) {
      // fetchNseApiJson returns null for a throttle, an HTML challenge page or
      // a transport error alike. Never write on a null — an empty surveillance
      // list is a meaningful claim ("nothing is under ASM today") and a failed
      // fetch must not be allowed to make it.
      logger.error({ path: job.path }, "fetch returned null — NOT writing");
      frameworks.push({
        source: job.source,
        fetched: false,
        parsed: 0,
        skipped: 0,
        written: 0,
        resolved: 0,
      });
      ok = false;
      continue;
    }

    const out = job.parse(payload, day);
    if (out.rows.length === 0) {
      logger.warn(
        { path: job.path, skipped: out.skipped },
        "parsed to ZERO rows — keeping the previous day's flags",
      );
      frameworks.push({
        source: job.source,
        fetched: true,
        parsed: 0,
        skipped: out.skipped,
        written: 0,
        resolved: 0,
      });
      ok = false;
      continue;
    }

    const { written, resolved } = await writeFlags(job.source, out.rows, index);
    frameworks.push({
      source: job.source,
      fetched: true,
      parsed: out.rows.length,
      skipped: out.skipped,
      written,
      resolved,
    });
  }

  logger.info({ frameworks, ok }, "done");
  // Summed across frameworks. `parsed` is what each source handed us and
  // `written` is what landed; a framework that could not be FETCHED contributes
  // 0 to both, so a total upstream outage reports selected 0 rather than
  // pretending it had work. `ok:false` from any leg becomes `failed`.
  reportJobOutcome({
    job: "surveillance-sync",
    selected: frameworks.reduce((n, f) => n + f.parsed, 0),
    written: frameworks.reduce((n, f) => n + f.written, 0),
    failed: frameworks.filter((f) => !f.fetched).length,
    ...(ok ? {} : { skippedReason: "at least one framework leg failed" }),
  });
  return { ok, frameworks };
}
