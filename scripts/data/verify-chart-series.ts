/**
 * Chart-series verification — MONEY-1175 / MONEY-1100 (P4 close-out).
 *
 * ## What this answers
 *
 * "Is `DailyPrice` good enough to draw a correct chart at every timeframe?"
 *
 * The TradingView daily path is DB-backed: `udf/history` -> `fetchHistoricalBars`
 * -> `yahoo-client.getHistorical(interval="1d")` -> `getHistoricalPrices()`,
 * which reads `DailyPrice` for the window and returns whatever is there
 * REGARDLESS OF SOURCE, mapping `close: record.close` (the raw column — never
 * `adjClose`). So a chart is exactly as correct as this table, and a series
 * stitched from two sources is only correct if both sources are on the SAME
 * price basis.
 *
 * ## The checks
 *
 *   A. Coverage        first/last date, row count, per-source composition
 *   B. Density         rows present vs. market trading days, per timeframe
 *   C. Candle validity low<=high, low<=min(o,c), high>=max(o,c), prices > 0
 *   D. Duplicate dates (the unique index should make this impossible — assert it)
 *   E. Boundary jumps  price ratio where `source` FLIPS between adjacent bars
 *   F. Interior jumps  same, within one source, as a control
 *
 * ## Why E is the split-adjustment test
 *
 * `DailyPrice` is unique on `(instrumentId, date)`, so two sources can never
 * hold the same date — a same-date price comparison is impossible BY
 * CONSTRUCTION. What IS observable is continuity across the seam.
 *
 * A RAW series gaps down at every split/bonus ex-date, because that is what the
 * market actually did. An ADJUSTED series is smooth there, because all earlier
 * history was divided by the ratio. So:
 *
 *   jump AT a corporate action        -> expected in a raw series; not a defect
 *   jump AT a source boundary with
 *     NO corporate action on that day -> the two sources are on different price
 *                                        bases: a stitching artifact we created
 *
 * That second case is the one a user sees as a cliff in the middle of a chart,
 * and it is the thing that decides whether the MONEY-1175 re-parse can ship as
 * a straight swap or needs serve-time adjustment first.
 *
 * ## Thresholds
 *
 * A boundary is FLAGGED at >=25% single-bar move. Splits and bonuses land far
 * outside that (1:1 bonus -> -50%, 1:5 split -> -80%, 1:10 -> -90%), while a
 * genuine one-day move rarely clears it — most cash stocks carry a 20% circuit
 * band, and the ones without a band (F&O names) are the large caps that move
 * least. So 25% separates "structural break" from "wild trading day" with room
 * on both sides. The full ratio distribution is printed regardless, so the
 * threshold informs the summary but never hides the data.
 *
 * Usage:
 *   node --import tsx scripts/data/verify-chart-series.ts
 *   node --import tsx scripts/data/verify-chart-series.ts --symbols=RELIANCE,IRCTC
 *   node --import tsx scripts/data/verify-chart-series.ts --json=/tmp/before.json
 *   node --import tsx scripts/data/verify-chart-series.ts --compare=/tmp/before.json
 */

import "dotenv/config";
import { writeFileSync, readFileSync } from "node:fs";

import { prisma } from "@usemoney/database";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

/**
 * Default basket — chosen so the four failure modes are all represented rather
 * than to be a "top N by market cap" list:
 *   RELIANCE/HDFCBANK  listed long before Yahoo's 1996 start, many corporate
 *                      actions -> maximum Yahoo occupancy (worst case)
 *   INFY/ITC/SBIN      old, split-heavy large caps
 *   IRCTC/ZOMATO       post-2019 listings Yahoo barely covered -> bhavcopy won
 *   NIFTYBEES/GOLDBEES ETFs Yahoo never covered -> the CONTROL group; these
 *                      must come out byte-identical before and after a repair
 *   YESBANK            a name with an extreme genuine drawdown, to prove the
 *                      jump detector does not just fire on volatility
 */
const DEFAULT_SYMBOLS = [
  "RELIANCE",
  "HDFCBANK",
  "INFY",
  "ITC",
  "SBIN",
  "IRCTC",
  "ZOMATO",
  "NIFTYBEES",
  "GOLDBEES",
  "YESBANK",
];

const SYMBOLS = (arg("symbols")
  ?.split(",")
  .map((s) => s.trim().toUpperCase()) ?? DEFAULT_SYMBOLS) as string[];
const EXCHANGE = (arg("exchange") ?? "NSE").toUpperCase();
const JSON_OUT = arg("json");
const COMPARE = arg("compare");
/**
 * Days either side of a jump in which a corporate action still counts as its
 * explanation. Matches RECONCILE_DAYS in corporate-action-detect.
 */
const ATTRIBUTION_SLACK_DAYS = 3;

/** Single-bar move that counts as a structural break rather than a trade. */
const JUMP_PCT = Number(arg("jump-pct") ?? 25) || 25;

const log = (...a: unknown[]) => console.log(...a);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const iso = (d: Date): string => d.toISOString().slice(0, 10);
/**
 * An EX-DATE's day, in IST — MONEY-1527. Separate from `iso` above, which is
 * applied to BAR dates: those are UTC-midnight session keys and must stay UTC,
 * while `exDate` is a real instant stored in two conventions (18:30Z for
 * 48,224 rows, 00:00Z for 10,863). One renderer for both is the defect.
 */
const isoEx = (d: Date): string => toIstDateKey(d);

interface Row {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

interface Jump {
  from: string;
  to: string;
  fromSource: string;
  toSource: string;
  fromClose: number;
  toClose: number;
  ratio: number;
  boundary: boolean;
  /** Corporate action on or between the two bars, if any. */
  action: string | null;
}

interface Timeframe {
  label: string;
  days: number | null;
}

/** Windows the chart actually offers, plus MAX. */
const TIMEFRAMES: Timeframe[] = [
  { label: "1M", days: 30 },
  { label: "3M", days: 91 },
  { label: "6M", days: 182 },
  { label: "1Y", days: 365 },
  { label: "2Y", days: 730 },
  { label: "5Y", days: 1826 },
  { label: "10Y", days: 3652 },
  { label: "MAX", days: null },
];

interface SymbolReport {
  symbol: string;
  found: boolean;
  rows: number;
  first: string | null;
  last: string | null;
  sources: Record<string, { n: number; first: string; last: string }>;
  timeframes: Array<{
    label: string;
    rows: number;
    expected: number;
    missing: number;
    coverage: number;
  }>;
  badCandles: number;
  badCandleSamples: string[];
  dupDates: number;
  boundaries: number;
  boundaryJumps: Jump[];
  interiorJumps: Jump[];
}

/**
 * Market trading days, derived from the data itself rather than a holiday
 * table. A holiday list would have to be complete back to 1994 to be usable
 * here, and ours starts at FY2024; the exchange's own footprint in the table is
 * both authoritative and free.
 *
 * A date counts as a trading day when at least `MIN_INSTRUMENTS` instruments
 * have a row on it. The floor matters: a handful of instruments carry stray
 * rows on non-trading dates (bad upstream prints, MF NAV dates), and without
 * the floor those would inflate the expected-day count and manufacture "gaps"
 * for every symbol at once.
 *
 * This is deliberately self-referential and has one blind spot: a day missing
 * PLATFORM-WIDE cannot be detected this way. `marketCalendarHoles()` covers
 * that separately by looking for weekdays with suspiciously few rows.
 */
const MIN_INSTRUMENTS = 50;

async function tradingDays(): Promise<Set<number>> {
  const res = (await prisma.$runCommandRaw({
    aggregate: "daily_prices",
    pipeline: [
      { $group: { _id: "$date", n: { $sum: 1 } } },
      { $match: { n: { $gte: MIN_INSTRUMENTS } } },
      { $project: { _id: 1 } },
    ],
    cursor: { batchSize: 100_000 },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: Array<{ _id: { $date: string } | string }> } };

  const out = new Set<number>();
  for (const d of res.cursor.firstBatch) {
    const v = typeof d._id === "string" ? d._id : d._id.$date;
    out.add(new Date(v).getTime());
  }
  return out;
}

/**
 * Weekdays inside the covered range that are NOT trading days but sit between
 * two trading days with a thin population — i.e. days the platform probably
 * SHOULD have and does not. Reported as a global signal, not per symbol.
 */
async function marketCalendarHoles(
  days: Set<number>,
): Promise<{ weekdayGaps: number; longest: string | null }> {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 0) return { weekdayGaps: 0, longest: null };
  let weekdayGaps = 0;
  let longest: string | null = null;
  let longestLen = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    let run = 0;
    for (let t = prev + 86_400_000; t < cur; t += 86_400_000) {
      const dow = new Date(t).getUTCDay();
      if (dow !== 0 && dow !== 6) {
        weekdayGaps++;
        run++;
      }
    }
    if (run > longestLen) {
      longestLen = run;
      longest = `${iso(new Date(prev))} -> ${iso(new Date(cur))} (${run} weekdays)`;
    }
  }
  return { weekdayGaps, longest };
}

function candleIsBad(r: Row): boolean {
  if (!(r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0)) return true;
  if (r.low > r.high) return true;
  if (r.open < r.low || r.open > r.high) return true;
  if (r.close < r.low || r.close > r.high) return true;
  return false;
}

async function analyseSymbol(
  symbol: string,
  calendar: Set<number>,
): Promise<SymbolReport> {
  const inst = await prisma.instrumentMapping.findFirst({
    where: { symbol, exchange: EXCHANGE },
    select: { id: true, isin: true },
  });

  const empty: SymbolReport = {
    symbol,
    found: false,
    rows: 0,
    first: null,
    last: null,
    sources: {},
    timeframes: [],
    badCandles: 0,
    badCandleSamples: [],
    dupDates: 0,
    boundaries: 0,
    boundaryJumps: [],
    interiorJumps: [],
  };
  if (!inst) return empty;

  const rows = (await prisma.dailyPrice.findMany({
    where: { instrumentId: inst.id },
    select: {
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      source: true,
    },
    orderBy: { date: "asc" },
  })) as Row[];

  if (rows.length === 0) return { ...empty, found: true };

  // Corporate actions, keyed by UTC day, for jump attribution. Matched on
  // symbol+exchange AND on isin — a renamed symbol keeps its ISIN, and the
  // actions that matter most (splits at the far end of history) are exactly
  // the ones most likely to predate a rename.
  // NOT scoped to EXCHANGE. A corporate action belongs to the COMPANY, and the
  // feeds report it per exchange unevenly — RELIANCE's Oct-2024 1:1 bonus
  // exists only as a BSE row, so an exchange-scoped lookup leaves the NSE
  // series' biggest jump looking unexplained. Same rule as the marks route and
  // the serve-time adjustment loader (MONEY-1176).
  const actions = await prisma.corporateAction.findMany({
    where: {
      OR: [{ symbol }, ...(inst.isin ? [{ isin: inst.isin }] : [])],
    },
    select: { type: true, exDate: true, ratio: true },
  });
  // KEYED IN IST, like the label three lines down — MONEY-1527.
  //
  // This was `Date.UTC(getUTCFullYear/Month/Date)` while the label moved to
  // IST, so the tool's own output contradicted the matching it had performed:
  // an entry sat on day D-1 with text reading `ex=D`. A map key joined against
  // a BAR is exactly the category that belongs in IST — it was only rescued by
  // `ATTRIBUTION_SLACK_DAYS`, a tolerance that exists for a different reason.
  //
  // And a Map `.set` OVERWRITES: an 18:30Z action for IST day D and a 00:00Z
  // action for IST day D-1 collapsed onto one key, so a SPLIT and a BONUS on
  // adjacent days became one entry with no counter saying so.
  const actionByDay = new Map<number, string[]>();
  for (const a of actions) {
    const key = Date.parse(`${isoEx(a.exDate)}T00:00:00.000Z`);
    const text = `${a.type}${a.ratio ? ` ${a.ratio}x` : ""} ex=${isoEx(a.exDate)}`;
    const at = actionByDay.get(key);
    if (at) at.push(text);
    else actionByDay.set(key, [text]);
  }

  // ── A. coverage + sources ──
  const sources: SymbolReport["sources"] = {};
  for (const r of rows) {
    const s = (sources[r.source] ??= {
      n: 0,
      first: iso(r.date),
      last: iso(r.date),
    });
    s.n++;
    if (iso(r.date) < s.first) s.first = iso(r.date);
    if (iso(r.date) > s.last) s.last = iso(r.date);
  }

  // ── C/D. candles + duplicates ──
  let badCandles = 0;
  const badCandleSamples: string[] = [];
  const seenDates = new Set<number>();
  let dupDates = 0;
  for (const r of rows) {
    if (candleIsBad(r)) {
      badCandles++;
      if (badCandleSamples.length < 3) {
        badCandleSamples.push(
          `${iso(r.date)} o=${r.open} h=${r.high} l=${r.low} c=${r.close} [${r.source}]`,
        );
      }
    }
    const t = r.date.getTime();
    if (seenDates.has(t)) dupDates++;
    seenDates.add(t);
  }

  // ── B. density per timeframe ──
  const lastDate = rows[rows.length - 1]!.date;
  const firstDate = rows[0]!.date;
  const now = lastDate.getTime();
  const timeframes = TIMEFRAMES.map((tf) => {
    const start =
      tf.days === null ? firstDate.getTime() : now - tf.days * 86_400_000;
    const windowStart = Math.max(start, firstDate.getTime());
    const present = rows.filter(
      (r) => r.date.getTime() >= windowStart && r.date.getTime() <= now,
    ).length;
    let expected = 0;
    for (const t of calendar) {
      if (t >= windowStart && t <= now) expected++;
    }
    return {
      label: tf.label,
      rows: present,
      expected,
      missing: Math.max(0, expected - present),
      coverage: expected === 0 ? 1 : present / expected,
    };
  });

  // ── E/F. jumps ──
  const boundaryJumps: Jump[] = [];
  const interiorJumps: Jump[] = [];
  let boundaries = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.close <= 0 || b.close <= 0) continue;
    const isBoundary = a.source !== b.source;
    if (isBoundary) boundaries++;
    const ratio = b.close / a.close;
    if (Math.abs(ratio - 1) * 100 < JUMP_PCT) continue;

    // Attribute to any corporate action near the jump. The window is widened
    // by ATTRIBUTION_SLACK_DAYS either side because exchanges report an ex-date
    // a day off surprisingly often, and the reconciler in
    // corporate-action-detect uses the same tolerance — two tools disagreeing
    // on it would leave real events looking unexplained here while the
    // detector considers them already covered.
    let action: string | null = null;
    for (
      let t = a.date.getTime() - ATTRIBUTION_SLACK_DAYS * 86_400_000;
      t <= b.date.getTime() + ATTRIBUTION_SLACK_DAYS * 86_400_000;
      t += 86_400_000
    ) {
      const hit = actionByDay.get(t);
      if (hit) {
        // Every action on the day, not whichever one `.set` wrote last.
        action = hit.join(" + ");
        break;
      }
    }

    const jump: Jump = {
      from: iso(a.date),
      to: iso(b.date),
      fromSource: a.source,
      toSource: b.source,
      fromClose: a.close,
      toClose: b.close,
      ratio,
      boundary: isBoundary,
      action,
    };
    (isBoundary ? boundaryJumps : interiorJumps).push(jump);
  }

  return {
    symbol,
    found: true,
    rows: rows.length,
    first: iso(firstDate),
    last: iso(lastDate),
    sources,
    timeframes,
    badCandles,
    badCandleSamples,
    dupDates,
    boundaries,
    boundaryJumps,
    interiorJumps,
  };
}

function printReport(reports: SymbolReport[]): void {
  for (const r of reports) {
    log(`\n${"═".repeat(78)}`);
    if (!r.found) {
      log(
        `${r.symbol}  ✗ NOT IN INSTRUMENT MASTER (${EXCHANGE}) — chart cannot resolve`,
      );
      continue;
    }
    if (r.rows === 0) {
      log(`${r.symbol}  ✗ in master but ZERO price rows`);
      continue;
    }
    log(
      `${r.symbol}  ${r.rows.toLocaleString()} rows  ${r.first} .. ${r.last}`,
    );
    const srcLine = Object.entries(r.sources)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => `${k}:${v.n.toLocaleString()} (${v.first}..${v.last})`)
      .join("  ");
    log(`  sources   ${srcLine}`);

    const tfLine = r.timeframes
      .map(
        (t) =>
          `${t.label}=${t.rows}/${t.expected}` +
          (t.coverage < 0.98 ? `⚠${pct(t.coverage)}` : ""),
      )
      .join("  ");
    log(`  density   ${tfLine}`);

    const health: string[] = [];
    health.push(
      r.badCandles === 0 ? "candles ✓" : `candles ✗ ${r.badCandles} invalid`,
    );
    health.push(r.dupDates === 0 ? "dupes ✓" : `dupes ✗ ${r.dupDates}`);
    health.push(`source-boundaries ${r.boundaries}`);
    log(`  health    ${health.join("   ")}`);
    for (const s of r.badCandleSamples) log(`              ${s}`);

    if (r.boundaryJumps.length > 0) {
      log(
        `  ⚠ BOUNDARY JUMPS (${r.boundaryJumps.length}) — source flip with a >=${JUMP_PCT}% move:`,
      );
      for (const j of r.boundaryJumps.slice(0, 8)) {
        log(
          `      ${j.from}[${j.fromSource}] ${j.fromClose} -> ${j.to}[${j.toSource}] ${j.toClose}` +
            `   x${j.ratio.toFixed(3)}   ${j.action ? `EXPLAINED BY ${j.action}` : "*** NO CORPORATE ACTION ***"}`,
        );
      }
      if (r.boundaryJumps.length > 8)
        log(`      … ${r.boundaryJumps.length - 8} more`);
    } else {
      log(`  boundary jumps ✓ none >=${JUMP_PCT}%`);
    }

    const unexplainedInterior = r.interiorJumps.filter((j) => !j.action);
    if (unexplainedInterior.length > 0) {
      log(
        `  interior jumps (same source, no action): ${unexplainedInterior.length}`,
      );
      for (const j of unexplainedInterior.slice(0, 3)) {
        log(
          `      ${j.from} ${j.fromClose} -> ${j.to} ${j.toClose} x${j.ratio.toFixed(3)} [${j.fromSource}]`,
        );
      }
    }
  }
}

/**
 * Print the verdict AND return it — MONEY-1238.
 *
 * Returns true only for a genuinely clean result. Previously this returned
 * `void` and branched solely on `unexplainedBoundary.length`, which made two
 * different states print the same green "the re-parse is a safe swap":
 *
 *   - every boundary was explained (the intended clean case), and
 *   - NOTHING WAS ANALYSED AT ALL — a typo'd `--symbols`, an empty master, or a
 *     filter that matched no rows all yield `found = []`, hence zero jumps.
 *
 * `invalid candles` and `duplicate dates` were computed, printed, and then
 * discarded, though the module header says to ASSERT them.
 */
function verdict(reports: SymbolReport[]): boolean {
  const found = reports.filter((r) => r.found && r.rows > 0);
  const unexplainedBoundary = found.flatMap((r) =>
    r.boundaryJumps.filter((j) => !j.action).map((j) => ({ sym: r.symbol, j })),
  );
  const explainedBoundary = found.flatMap((r) =>
    r.boundaryJumps.filter((j) => j.action),
  );

  log(`\n${"═".repeat(78)}`);
  log("VERDICT");
  log(`${"═".repeat(78)}`);
  log(`  symbols analysed          ${found.length}/${reports.length}`);
  log(`  missing from master       ${reports.filter((r) => !r.found).length}`);
  log(
    `  total source boundaries   ${found.reduce((s, r) => s + r.boundaries, 0)}`,
  );
  log(
    `  boundary jumps explained  ${explainedBoundary.length} (corporate action)`,
  );
  log(
    `  boundary jumps UNEXPLAINED ${unexplainedBoundary.length}  <-- stitching artifacts`,
  );
  const badCandles = found.reduce((s, r) => s + r.badCandles, 0);
  const dupDates = found.reduce((s, r) => s + r.dupDates, 0);
  log(`  invalid candles           ${badCandles}`);
  log(`  duplicate dates           ${dupDates}`);

  // No data is not a clean bill of health. Checked AFTER the counts print, so
  // the operator still sees how many symbols were asked for versus found.
  if (found.length === 0) {
    log("");
    log("  => NOTHING WAS ANALYSED. Zero symbols yielded any rows, so every");
    log("     count above is zero for want of data, not for want of defects.");
    log("     Check --symbols, the date range, and that the series exist.");
    return false;
  }

  // Which source owns most of each series, and how much of the artifact load
  // sits on the MINORITY source. This is the load-bearing distinction: a
  // minority source is an ISLAND inside another series, and every island
  // contributes two boundaries (in and out). Consolidating onto one source
  // removes the island and both of its boundaries — so island-attributable
  // artifacts are REMOVED by a re-parse, not caused by one.
  const islandJumps = found.flatMap((r) => {
    const counts = Object.entries(r.sources).sort((a, b) => b[1].n - a[1].n);
    const dominant = counts[0]?.[0];
    return r.boundaryJumps
      .filter((j) => !j.action)
      .filter((j) => j.fromSource !== dominant || j.toSource !== dominant)
      .map((j) => ({ sym: r.symbol, j, dominant }));
  });

  const basis = new Map<string, number>();
  for (const r of found) {
    const counts = Object.entries(r.sources).sort((a, b) => b[1].n - a[1].n);
    const d = counts[0]?.[0];
    if (d) basis.set(d, (basis.get(d) ?? 0) + 1);
  }

  log("");
  log("  de-facto price basis, by symbol count:");
  for (const [src, n] of [...basis].sort((a, b) => b[1] - a[1])) {
    log(`     ${src.padEnd(16)} dominant for ${n}/${found.length} symbols`);
  }

  if (unexplainedBoundary.length > 0) {
    log("");
    log(
      "  => THE SOURCES ARE ON DIFFERENT PRICE BASES. A source flip moves the",
    );
    log(
      "     price with no corporate action to justify it, which is only possible",
    );
    log("     if one side is split-adjusted and the other is raw.");
    log("");
    log(
      `     Of ${unexplainedBoundary.length} unexplained jumps, ${islandJumps.length} involve a MINORITY-source island.`,
    );
    if (islandJumps.length === unexplainedBoundary.length) {
      log(
        "     ALL of them do. Every artifact is an island boundary, which means",
      );
      log(
        "     consolidating each series onto its authoritative source REMOVES the",
      );
      log(
        "     artifact rather than introducing one. The re-parse is a repair, not",
      );
      log(
        "     a regression — but it does finish converting the platform to a",
      );
      log(
        "     single RAW basis, so charts will gap at real corporate actions.",
      );
    } else {
      log(
        "     Some sit between two dominant-source runs — those are NOT fixed by",
      );
      log(
        "     consolidation and need separate treatment before the re-parse.",
      );
    }
    for (const { sym, j } of unexplainedBoundary.slice(0, 10)) {
      log(
        `       ${sym.padEnd(10)} ${j.from}[${j.fromSource}] -> ${j.to}[${j.toSource}] x${j.ratio.toFixed(3)}`,
      );
    }
  } else {
    log("");
    log(
      "  => NO UNEXPLAINED BOUNDARY JUMPS. Every source flip is either flat or",
    );
    log(
      "     sits on a corporate-action ex-date (where a raw series is SUPPOSED to",
    );
    log(
      "     gap). The sources agree on price basis; the re-parse is a safe swap.",
    );
  }

  // Counted above, and now they DECIDE. A series carrying invalid candles or
  // duplicate dates is not a series anyone should swap onto, however tidy its
  // source boundaries are.
  if (badCandles > 0 || dupDates > 0) {
    log("");
    log(
      `  => SERIES INTEGRITY FAILED: ${badCandles} invalid candle(s), ` +
        `${dupDates} duplicate date(s). Fix these before reading the boundary`,
    );
    log("     analysis above as a go-ahead.");
  }

  return unexplainedBoundary.length === 0 && badCandles === 0 && dupDates === 0;
}

function compare(before: SymbolReport[], after: SymbolReport[]): void {
  log(`\n${"═".repeat(78)}`);
  log("COMPARISON vs BASELINE");
  log(`${"═".repeat(78)}`);
  const byName = new Map(before.map((r) => [r.symbol, r]));
  for (const a of after) {
    const b = byName.get(a.symbol);
    if (!b) {
      log(`  ${a.symbol.padEnd(10)} NEW in this run`);
      continue;
    }
    const dRows = a.rows - b.rows;
    const maxTf = a.timeframes.find((t) => t.label === "MAX");
    const bMaxTf = b.timeframes.find((t) => t.label === "MAX");
    const dCov = maxTf && bMaxTf ? (maxTf.coverage - bMaxTf.coverage) * 100 : 0;
    const flag =
      dRows === 0 && Math.abs(dCov) < 0.05
        ? "unchanged"
        : `${dRows >= 0 ? "+" : ""}${dRows.toLocaleString()} rows, MAX coverage ${dCov >= 0 ? "+" : ""}${dCov.toFixed(1)}pp`;
    log(
      `  ${a.symbol.padEnd(10)} ${flag}` +
        `   boundaries ${b.boundaries}->${a.boundaries}` +
        `   badCandles ${b.badCandles}->${a.badCandles}`,
    );
  }
}

async function main(): Promise<void> {
  log(
    `[verify-chart-series] exchange=${EXCHANGE} symbols=${SYMBOLS.length} jump>=${JUMP_PCT}%`,
  );
  log("[verify-chart-series] deriving market calendar from daily_prices…");
  const calendar = await tradingDays();
  const holes = await marketCalendarHoles(calendar);
  log(
    `[verify-chart-series] trading days=${calendar.size.toLocaleString()}  ` +
      `weekday non-trading days inside range=${holes.weekdayGaps.toLocaleString()}` +
      (holes.longest ? `  longest run: ${holes.longest}` : ""),
  );

  const reports: SymbolReport[] = [];
  for (const s of SYMBOLS) reports.push(await analyseSymbol(s, calendar));

  printReport(reports);
  // The verdict decides the exit code — MONEY-1238. It used to be printed and
  // dropped, so `verify-chart-series` exited 0 whether it proved the swap safe,
  // proved it unsafe, or analysed nothing at all.
  if (!verdict(reports)) process.exitCode = 1;

  if (COMPARE) {
    try {
      compare(
        JSON.parse(readFileSync(COMPARE, "utf8")) as SymbolReport[],
        reports,
      );
    } catch (e) {
      log(`[verify-chart-series] could not read baseline ${COMPARE}: ${e}`);
    }
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(reports, null, 2));
    log(`\n[verify-chart-series] wrote ${JSON_OUT}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[verify-chart-series] failed:", err);
  process.exitCode = 1;
});
