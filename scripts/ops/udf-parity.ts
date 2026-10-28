/**
 * udf-parity.ts — prove the tile-backed `/udf/history` matches what the chart
 * shows today, before flipping it. MONEY-1468 (data-platform A3).
 *
 *   UDF_PARITY_CLERK_TOKEN=... npx tsx scripts/ops/udf-parity.ts --env=qa
 *   ... --env=prod --out=docs/reference/udf-parity-2026-09.md
 *
 * READ-ONLY. Every request is a GET against two `/udf/history` endpoints.
 *
 * ## IT COMPARES BARS ONLY, AND THAT IS A KNOWN LIMIT
 *
 * This harness exists to de-risk the A3 cutover, and on 2026-09-18 the cutover
 * broke every chart on the platform WITHOUT this reporting anything — because
 * `/udf/symbols` was a 501 stub and TradingView calls `resolveSymbol` BEFORE it
 * requests a bar. Both sides of this comparison agreed perfectly on an endpoint
 * the widget never reached.
 *
 * A parity harness for an ORIGIN switch has to cover the client's whole CALL
 * SEQUENCE; comparing one endpoint proves that endpoint, not the cutover. The
 * sweep in `market-data-smoke.sh` (no UDF route may answer 501) is what closes
 * that today. Widening this to resolve-then-fetch is the better fix and is not
 * done. See `docs/reference/chart-cutover-outage-2026-09-18.md`.
 *
 * ## YAHOO IS THE BASELINE, NOT THE AUTHORITY
 *
 * Stated in `parity-logic.ts` and repeated here because it decides what to do
 * with a failure. Yahoo is what the chart shows TODAY; on a CLOSED Indian
 * session the exchange's own bhavcopy is the better number, by the precedence
 * `mayWritePriceSource` already enforces (MONEY-1175). "Fixing" tiles to match
 * Yahoo would regress to the weaker source while reporting success.
 *
 * So the exit code gates on UNEXPLAINED failures only, and every explained
 * divergence is written into the report with its reason.
 *
 * ## THE SAMPLE IS DERIVED, NOT HARDCODED
 *
 * The brief asks for 30 NSE (5 with recent corporate actions), 20 US (3 with
 * splits) and 10 with under five years of history. A hardcoded list stops
 * satisfying that the moment the data moves — a symbol delists, a split ages
 * out of "recent" — and the run keeps reporting the same green over a
 * population that no longer contains the hard cases. So the cohorts are
 * QUERIED, and the script REFUSES to run when a cohort cannot be filled,
 * rather than quietly proving parity over the easy ones.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prisma } from "@usemoney/database";
import {
  compareSeries,
  summarise,
  type BarDiff,
  type ParityResult,
  type UdfSeries,
} from "@usemoney/core/market-data/udf/parity-logic";

interface Args {
  env: "qa" | "prod";
  out: string;
  limit: number | null;
}

const WEB_BASE = {
  qa: "https://qa.usemoney.ai",
  prod: "https://usemoney.ai",
} as const;

const SERVICE_BASE = {
  qa: "https://market-data-qa.usemoney.ai",
  prod: "https://market-data.usemoney.ai",
} as const;

/**
 * Cohort floors. A run that cannot fill one REFUSES rather than shrinking.
 *
 * `us`, `usWithSplits` and `shortHistory` are DELIBERATELY ABSENT. They were
 * declared here, documented in the header and read by nothing, so the header's
 * promise — "REFUSES when a cohort cannot be filled, rather than quietly
 * proving parity over the easy ones" — was false for exactly the hard cohorts.
 * A floor nobody checks is worse than no floor: it reads as coverage.
 *
 * US is out of scope because the BASELINE cannot serve it (see buildSample).
 */
const COHORTS = {
  nse: 30,
  nseWithActions: 5,
} as const;

function parseArgs(argv: readonly string[]): Args {
  const get = (n: string) =>
    argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const env = get("env");
  if (env !== "qa" && env !== "prod") {
    throw new Error(
      "--env must be qa or prod (never defaulted: a dropped argument must not silently certify the wrong environment)",
    );
  }
  const limitRaw = get("limit");
  return {
    env,
    out: get("out") ?? "docs/reference/udf-parity-2026-09.md",
    limit: limitRaw ? Number(limitRaw) : null,
  };
}

/* ── the six ranges ─────────────────────────────────────────────────────── */

const DAY = 86_400;

/**
 * Six windows per listing, chosen to exercise the shapes that fail silently:
 * the default load, a deep scroll-back across the 5y boundary (where a missing
 * year tile lives), a window entirely before any history (`no_data` +
 * `nextTime`), and a countback load (which TradingView sends first).
 */
function ranges(nowSec: number): { name: string; qs: string }[] {
  return [
    { name: "recent-1y", qs: `from=${nowSec - 365 * DAY}&to=${nowSec}` },
    {
      name: "recent-countback-300",
      qs: `from=${nowSec - 365 * DAY}&to=${nowSec}&countback=300`,
    },
    { name: "3y", qs: `from=${nowSec - 3 * 365 * DAY}&to=${nowSec}` },
    // ACROSS the 5y tile boundary — where a missing year tile shows up and
    // nowhere else.
    {
      name: "6y-crosses-5y-boundary",
      qs: `from=${nowSec - 6 * 365 * DAY}&to=${nowSec}`,
    },
    { name: "10y-deep", qs: `from=${nowSec - 10 * 365 * DAY}&to=${nowSec}` },
    // Entirely before any listing's history: both sides must say no_data, and
    // must agree about nextTime.
    { name: "pre-history", qs: `from=${315_532_800}&to=${347_068_800}` },
  ];
}

/* ── the sample ─────────────────────────────────────────────────────────── */

interface SampleListing {
  udfSymbol: string;
  market: "IN" | "US";
  hadSplit: boolean;
  cohort: string;
}

async function buildSample(limit: number | null): Promise<SampleListing[]> {
  const out: SampleListing[] = [];

  // ── NSE with a SHARE-COUNT-CHANGING action ─────────────────────────────
  //
  // `type` matters: `CorporateAction` also holds DIVIDEND and BUYBACK, which
  // change no share count. Marking those `hadSplit: true` would hand them the
  // split-ratio escape hatch in `classifyVolumeDiff`, so a genuine ~2x volume
  // error on a dividend-only name would be written up as an explained split.
  const since = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000);
  const actioned = await prisma.corporateAction.findMany({
    where: {
      exchange: "NSE",
      exDate: { gte: since },
      type: { in: ["SPLIT", "BONUS"] },
    },
    select: { symbol: true },
    distinct: ["symbol"],
    orderBy: { symbol: "asc" },
    take: COHORTS.nseWithActions * 10,
  });
  const actionedSymbols = [...new Set(actioned.map((a) => a.symbol))];
  const withActions = await withDailyPrices(
    actionedSymbols,
    COHORTS.nseWithActions,
  );
  for (const sym of withActions) {
    out.push({
      udfSymbol: `NSE:${sym}`,
      market: "IN",
      hadSplit: true,
      cohort: "nse-with-actions",
    });
  }

  // ── plain NSE equities that ACTUALLY HAVE PRICES ───────────────────────
  //
  // `instrumentType: "EQUITY"` ordered by symbol is the selection this very
  // branch warns about in tile-build-d1.ts: the alphabetically-first rows are
  // BOND CODES (MONEY-1298 — ~61% of that table was never equity) and none has
  // a DailyPrice. Both sides then answer `no_data` and the harness scores
  // vacuous agreement as parity, which is the one result it must never produce.
  const candidates = await prisma.instrumentMapping.findMany({
    where: {
      exchange: "NSE",
      isActive: true,
      instrumentType: "EQUITY",
      isin: { not: null }, // a real security has one (MONEY-1298)
      symbol: { notIn: withActions },
    },
    select: { symbol: true },
    orderBy: { symbol: "asc" },
    take: COHORTS.nse * 20,
  });
  const plain = await withDailyPrices(
    candidates.map((c) => c.symbol),
    COHORTS.nse - COHORTS.nseWithActions,
  );
  for (const sym of plain) {
    out.push({
      udfSymbol: `NSE:${sym}`,
      market: "IN",
      hadSplit: false,
      cohort: "nse",
    });
  }

  // ── US ─────────────────────────────────────────────────────────────────
  //
  // NOT SAMPLED, and the reason is a property of the BASELINE rather than a gap
  // here: `parseSymbolPrefix` in the web route splits on the FIRST colon, so a
  // `Candle.listingId` (`AAPL:NASDAQ:1980-12-12`) is read as exchange prefix
  // `AAPL` and answered `{s:"error", errmsg:"unsupported exchange prefix"}`.
  // The legacy route has NO US path at all — there is nothing to compare
  // against, and 120 baseline errors scored as agreement is worse than no US
  // coverage. US parity needs its own baseline and is deliberately out of scope
  // here; `REQUIRED_COHORTS` records that so the refusal below cannot silently
  // start expecting it.

  return limit ? out.slice(0, limit) : out;
}

/**
 * Narrow a symbol list to those that really have daily prices, preserving order.
 *
 * Driven off `DailyPrice` for the same reason the US path is driven off
 * `candles`: a listing with no bars produces `no_data` on BOTH sides, which the
 * comparator correctly calls a match and which proves nothing whatsoever.
 */
async function withDailyPrices(
  symbols: readonly string[],
  want: number,
): Promise<string[]> {
  if (symbols.length === 0 || want <= 0) return [];
  const rows = await prisma.instrumentMapping.findMany({
    where: { symbol: { in: [...symbols] }, exchange: "NSE" },
    select: { id: true, symbol: true },
  });
  const kept: string[] = [];
  for (const r of rows) {
    if (kept.length >= want) break;
    const n = await prisma.dailyPrice.count({
      where: { instrumentId: r.id },
      take: 1,
    });
    if (n > 0) kept.push(r.symbol);
  }
  return kept;
}

/* ── fetching ───────────────────────────────────────────────────────────── */

async function fetchSeries(
  url: string,
  headers: Record<string, string>,
): Promise<UdfSeries> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as UdfSeries;
    return body && typeof body.s === "string" ? body : { s: "error" };
  } catch (err) {
    // A TRANSPORT failure is not `no_data`. Returning no_data here would make
    // a network blip read as "both sides agree this range is empty".
    return { s: "error", nextTime: undefined } as UdfSeries;
  }
}

/* ── report ─────────────────────────────────────────────────────────────── */

function renderReport(
  args: Args,
  results: ParityResult[],
  sample: SampleListing[],
): string {
  const s = summarise(results);
  const failures = results.filter((r) => r.verdict === "failure");
  const explained = results.filter((r) => r.verdict === "explained");

  const lines: string[] = [];
  lines.push(`# UDF parity — tiles vs the live Yahoo path (${args.env})`);
  lines.push("");
  lines.push(
    `Generated ${new Date().toISOString()} by \`scripts/ops/udf-parity.ts\`. MONEY-1468 (A3).`,
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| comparisons | ${s.total} |`);
  lines.push(`| matched | ${s.matched} |`);
  lines.push(`| explained (not failures) | ${s.explained} |`);
  lines.push(`| **unexplained failures** | **${s.failed}** |`);
  lines.push(`| **PASS** | **${s.pass ? "yes" : "NO"}** |`);
  lines.push("");
  lines.push(
    "An EMPTY run is not a pass: `failed === 0` is true over nothing.",
  );
  lines.push("");
  lines.push("## What an EXPLAINED divergence means");
  lines.push("");
  lines.push(
    "Yahoo is the baseline here **only because it is what the chart shows today**. " +
      "On a CLOSED Indian session the exchange's own bhavcopy is the better number, by the " +
      "precedence `mayWritePriceSource` enforces (MONEY-1175). Tuning a tolerance, or changing " +
      "a tile to match Yahoo, would regress to the weaker source while reporting success.",
  );
  lines.push("");
  lines.push("Documented classes:");
  lines.push("");
  lines.push(
    "- **Split volume.** Yahoo back-adjusts volume across a split; a tile keeps raw volume scaled by the factor. `applyAdjustment` multiplies volume where it divides price — deliberately: the same turnover over R times as many shares.",
  );
  lines.push(
    "- **India volume.** bhavcopy and Yahoo count different venues on some sessions. Reported, never failed.",
  );
  lines.push("");
  lines.push("## Sample");
  lines.push("");
  const byCohort = new Map<string, number>();
  for (const l of sample)
    byCohort.set(l.cohort, (byCohort.get(l.cohort) ?? 0) + 1);
  lines.push("| cohort | listings |");
  lines.push("| --- | --- |");
  for (const [k, v] of [...byCohort].sort()) lines.push(`| ${k} | ${v} |`);
  lines.push("");

  if (failures.length) {
    lines.push(
      "## UNEXPLAINED FAILURES — fix at the SOURCE, never the tolerance",
    );
    lines.push("");
    for (const f of failures.slice(0, 50)) {
      lines.push(`### ${f.listing} — ${f.range}`);
      lines.push("");
      if (f.notes.length) for (const n of f.notes) lines.push(`- ${n}`);
      for (const d of f.diffs
        .filter((x: BarDiff) => x.verdict === "failure")
        .slice(0, 10)) {
        lines.push(
          `- \`${d.field}\` @ ${new Date(d.t * 1000).toISOString().slice(0, 10)}: baseline ${d.baseline} vs tile ${d.candidate} (${(d.deltaPct * 100).toFixed(2)}%)`,
        );
      }
      lines.push("");
    }
  }

  if (explained.length) {
    lines.push("## Explained divergences");
    lines.push("");
    for (const e of explained.slice(0, 30)) {
      const first = e.diffs.find((d) => d.verdict === "explained");
      lines.push(
        `- **${e.listing}** ${e.range} — ${first?.reason ?? "see above"}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/* ── main ───────────────────────────────────────────────────────────────── */

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  const token = process.env.UDF_PARITY_CLERK_TOKEN;
  if (!token) {
    throw new Error(
      "UDF_PARITY_CLERK_TOKEN is required — the web /udf/history route is behind Clerk. " +
        "Without it every baseline request 401s and the run would report total parity failure " +
        "for an auth reason, which looks exactly like a broken tile build.",
    );
  }

  const sample = await buildSample(args.limit);
  if (!args.limit) {
    // REFUSE a thin sample rather than certify parity over the easy cases.
    const inCount = sample.filter((l) => l.market === "IN").length;
    const actionCount = sample.filter(
      (l) => l.cohort === "nse-with-actions",
    ).length;
    if (inCount < COHORTS.nse || actionCount < COHORTS.nseWithActions) {
      throw new Error(
        `sample is short (NSE ${inCount}/${COHORTS.nse}, with-actions ${actionCount}/${COHORTS.nseWithActions}). ` +
          "Refusing: a run over the listings that happened to be easy proves nothing about the ones " +
          "that are not, and the corporate-action names are the whole point of comparing adjustments.",
      );
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const windows = ranges(nowSec);
  const results: ParityResult[] = [];

  for (const listing of sample) {
    for (const w of windows) {
      const qs = `symbol=${encodeURIComponent(listing.udfSymbol)}&resolution=1D&${w.qs}`;
      const [baseline, candidate] = await Promise.all([
        fetchSeries(`${WEB_BASE[args.env]}/api/market/udf/history?${qs}`, {
          Authorization: `Bearer ${token}`,
        }),
        fetchSeries(`${SERVICE_BASE[args.env]}/udf/history?${qs}`, {}),
      ]);
      results.push(
        compareSeries(listing.udfSymbol, w.name, baseline, candidate, {
          market: listing.market,
          hadSplit: listing.hadSplit,
        }),
      );
    }
    const done = results.length;
    if (done % 60 === 0) console.log(`[udf-parity] ${done} comparisons…`);
  }

  const report = renderReport(args, results, sample);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, report, "utf8");

  const s = summarise(results);
  console.log(
    `[udf-parity] ${s.total} comparisons · matched ${s.matched} · explained ${s.explained} · FAILED ${s.failed}`,
  );
  console.log(`[udf-parity] report: ${args.out}`);

  // The exit code gates the flip.
  if (!s.pass) process.exitCode = 1;
}

if (process.argv[1] && /udf-parity/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("[udf-parity] FATAL", err);
    process.exit(1);
  });
}
