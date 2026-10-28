/**
 * MONEY-1125 — the screener's technical paths must batch their price reads
 * WITHOUT changing a single result.
 *
 * `runTechnicalScreen` used to run one `dailyPrice.findMany` per instrument
 * inside a sequential loop (up to 2000 serial round trips), and
 * `applyTechnicalFilters` ran two per candidate (`instrumentMapping.findFirst`
 * + `dailyPrice.findMany`). Both are now `instrumentId: { in: [...] }` batches
 * grouped in memory.
 *
 * This file pins the change on both axes, because each one alone is worthless:
 *
 *   1. OUTPUT IDENTITY. Every scenario runs the shipped function AND a verbatim
 *      port of the pre-change loops (`legacy*` below) against the SAME injected
 *      data and the SAME real `computeIndicators`, then asserts deep equality.
 *      An oracle rather than only golden values because the risky part is
 *      per-instrument row ORDER and the 300-row WINDOW, which golden numbers
 *      alone would not localise. Golden values are asserted too, so the pair
 *      cannot drift together into being wrong.
 *
 *   2. ROUND-TRIP COUNT. `dailyPrice.findMany` must be called ceil(n/chunk)
 *      times, never n times. Without this the batching can silently regress
 *      back to N+1 while every output assertion stays green.
 *
 * Two semantics are deliberately load-bearing in the fixtures:
 *
 *   - MONEY-1133: the engine takes the MOST RECENT 300 candles. It used to
 *     take the OLDEST 300 (`take` under `orderBy: date asc` reads from the
 *     start of the range), so every technical signal described a window ending
 *     about a year ago — confidently wrong rather than missing, with no visible
 *     symptom. `EEE` carries 320 candles that RISE for 300 then FALL for 20,
 *     precisely so the two windows disagree on `price` AND `rsi14`: getting the
 *     window backwards fails loudly instead of silently inverting every
 *     indicator. That discriminating fixture predates the fix — MONEY-1125
 *     built it while deliberately preserving the old window.
 *   - the `results.length >= limit` exit sits AFTER the push and AFTER the
 *     `< 30 candles` continue. The limit cases pin that placement.
 *
 * The injected double stores its price rows SHUFFLED, so any path that stops
 * asking the DB to sort (or sorts by the wrong key) produces different
 * indicators and fails — a double that hands back pre-sorted rows would make
 * the `orderBy` untestable.
 *
 * Source: packages/core/src/screener/engine.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runTechnicalScreen,
  applyTechnicalFilters,
  matchesTechnicalFilters,
  SCREENER_CANDLE_LIMIT,
  SCREENER_PRICE_CHUNK_SIZE,
  SCREENER_PRICE_CHUNK_CONCURRENCY,
  type ScreenerDeps,
  type ScreenerFilter,
  type ScreenerResult,
} from "../../src/screener/engine";
import {
  computeIndicators,
  type OHLCV,
} from "../../src/market-data/technical-indicators";

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

interface PriceRow {
  instrumentId: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  isActive: boolean;
  instrumentType: string;
}

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2024, 0, 1);

/** Volume is constant, so `volumeRatio` is exactly 1 and assertable. */
function candle(instrumentId: string, index: number, close: number): PriceRow {
  return {
    instrumentId,
    date: new Date(EPOCH + index * DAY_MS),
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
  };
}

/** Strictly rising closes → RSI(14) is exactly 100 (avgLoss === 0). */
function rising(
  instrumentId: string,
  count: number,
  start: number,
): PriceRow[] {
  return Array.from({ length: count }, (_, i) =>
    candle(instrumentId, i, start + i),
  );
}

/** Strictly falling closes → RSI(14) is exactly 0 (avgGain === 0). */
function falling(
  instrumentId: string,
  count: number,
  start: number,
): PriceRow[] {
  return Array.from({ length: count }, (_, i) =>
    candle(instrumentId, i, start - i),
  );
}

function instrument(
  id: string,
  symbol: string,
  exchange = "NSE",
  overrides: Partial<InstrumentRow> = {},
): InstrumentRow {
  return {
    id,
    symbol,
    exchange,
    name: `${symbol} Ltd`,
    sector: "Information Technology",
    isActive: true,
    instrumentType: "EQUITY",
    ...overrides,
  };
}

/**
 * Deterministic shuffle. The double returns rows in STORED order when no
 * `orderBy` is supplied, so storing them out of date order is what makes the
 * engine's `orderBy` genuinely load-bearing in these tests.
 */
function shuffled(rows: PriceRow[]): PriceRow[] {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const j = (i * 7 + 3) % out.length;
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/**
 * The five-instrument fixture:
 *   AAA  40 rising candles          → RSI 100, price 139  (matches rsi > 60)
 *   BBB  40 falling candles         → RSI   0, price 161  (does not match)
 *   CCC  29 rising candles          → below the 30-candle gate, never returned
 *   DDD  NO price rows at all       → empty array, never returned
 *   EEE  320 candles: 300 up, 20 dn → newest-300 ⇒ falling tail, price 379,
 *                                      RSI below 60 (does NOT match rsi > 60).
 *                                      The old oldest-300 window gave RSI 100
 *                                      and price 399 — the two disagree, which
 *                                      is the point of this fixture.
 */
const FIVE_INSTRUMENTS: InstrumentRow[] = [
  instrument("i-aaa", "AAA"),
  instrument("i-bbb", "BBB"),
  instrument("i-ccc", "CCC"),
  instrument("i-ddd", "DDD"),
  instrument("i-eee", "EEE"),
];

function fiveInstrumentPrices(): PriceRow[] {
  const eee = rising("i-eee", 300, 100); // closes 100 … 399
  for (let i = 0; i < 20; i++) {
    // 20 more candles that FALL: 398, 397, … 379.
    eee.push(candle("i-eee", 300 + i, 398 - i));
  }
  return shuffled([
    ...rising("i-aaa", 40, 100), // closes 100 … 139
    ...falling("i-bbb", 40, 200), // closes 200 … 161
    ...rising("i-ccc", 29, 50),
    ...eee,
  ]);
}

/** N instruments, each with its OWN price level, so a mis-grouped batch (rows
 *  attached to the wrong instrument) changes `price` and fails. */
function manyInstruments(n: number): {
  instruments: InstrumentRow[];
  prices: PriceRow[];
} {
  const instruments: InstrumentRow[] = [];
  const prices: PriceRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = `i-${String(i).padStart(4, "0")}`;
    instruments.push(instrument(id, `SYM${String(i).padStart(4, "0")}`));
    prices.push(...rising(id, 31, 100 + i)); // last close = 130 + i
  }
  return { instruments, prices: shuffled(prices) };
}

// ════════════════════════════════════════════════════════════════════════════
// Injected Prisma double
// ════════════════════════════════════════════════════════════════════════════

type Rec = Record<string, unknown>;

/**
 * Rows come back PROJECTED (only the `select`ed keys) but typed as the full row
 * for test ergonomics — every consumer here reads selected fields only.
 */
interface FakeDb {
  instrumentMapping: {
    findMany(args: Rec): Promise<InstrumentRow[]>;
    findFirst(args: Rec): Promise<InstrumentRow | null>;
  };
  dailyPrice: {
    findMany(args: Rec): Promise<PriceRow[]>;
  };
}

interface DbLog {
  dailyPrice: Rec[];
  instrumentFindMany: Rec[];
  instrumentFindFirst: Rec[];
  /** Highest number of `dailyPrice.findMany` calls in flight simultaneously. */
  peakConcurrency: number;
}

function matchesValue(filter: unknown, value: unknown): boolean {
  if (filter === undefined) return true;
  if (filter !== null && typeof filter === "object" && "in" in filter) {
    const list = (filter as { in: unknown[] }).in;
    return list.includes(value);
  }
  return filter === value;
}

function compareValues(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  if (av === undefined || av === null) return -1;
  if (bv === undefined || bv === null) return 1;
  if (typeof av === "number" && typeof bv === "number") return av < bv ? -1 : 1;
  return String(av) < String(bv) ? -1 : 1;
}

function sortRows<T extends object>(rows: T[], orderBy: unknown): T[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Rec[];
  const keyed = specs.flatMap((spec) =>
    Object.entries(spec).map(([field, dir]) => ({
      field,
      dir: dir === "desc" ? -1 : 1,
    })),
  );
  return [...rows].sort((a, b) => {
    for (const { field, dir } of keyed) {
      const cmp = compareValues((a as Rec)[field], (b as Rec)[field]);
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
}

function project<T extends object>(row: T, select: unknown): T {
  if (!select || typeof select !== "object") return { ...row };
  const out: Rec = {};
  for (const [key, wanted] of Object.entries(select as Rec)) {
    if (wanted === true) out[key] = (row as Rec)[key];
  }
  return out as T;
}

function makeDb(
  instruments: InstrumentRow[],
  prices: PriceRow[],
): { db: FakeDb; deps: ScreenerDeps; log: DbLog } {
  const log: DbLog = {
    dailyPrice: [],
    instrumentFindMany: [],
    instrumentFindFirst: [],
    peakConcurrency: 0,
  };
  let inFlight = 0;

  const filterInstruments = (args: Rec): InstrumentRow[] => {
    const where = (args.where ?? {}) as Rec;
    let rows = instruments.filter(
      (r) =>
        matchesValue(where.isActive, r.isActive) &&
        matchesValue(where.instrumentType, r.instrumentType) &&
        matchesValue(where.exchange, r.exchange) &&
        matchesValue(where.symbol, r.symbol) &&
        matchesValue(where.id, r.id),
    );
    rows = sortRows(rows, args.orderBy);
    if (typeof args.take === "number") rows = rows.slice(0, args.take);
    return rows.map((r) => project(r, args.select));
  };

  const db: FakeDb = {
    instrumentMapping: {
      findMany: async (args) => {
        log.instrumentFindMany.push(args);
        return filterInstruments(args);
      },
      findFirst: async (args) => {
        log.instrumentFindFirst.push(args);
        return filterInstruments(args)[0] ?? null;
      },
    },
    dailyPrice: {
      findMany: async (args) => {
        log.dailyPrice.push(args);
        inFlight += 1;
        log.peakConcurrency = Math.max(log.peakConcurrency, inFlight);
        try {
          // Yield once so overlapping calls are observable as overlapping.
          await Promise.resolve();
          const where = (args.where ?? {}) as Rec;
          let rows = prices.filter((r) =>
            matchesValue(where.instrumentId, r.instrumentId),
          );
          rows = sortRows(rows, args.orderBy);
          if (typeof args.take === "number") rows = rows.slice(0, args.take);
          return rows.map((r) => project(r, args.select));
        } finally {
          inFlight -= 1;
        }
      },
    },
  };

  return {
    db,
    deps: { prisma: db as unknown as ScreenerDeps["prisma"] },
    log,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// The ORACLE — verbatim ports of the pre-MONEY-1125 loops
// ════════════════════════════════════════════════════════════════════════════

function toOhlcv(candles: PriceRow[]): OHLCV[] {
  return candles.map((c) => ({
    date: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

const CANDLE_SELECT = {
  date: true,
  open: true,
  high: true,
  low: true,
  close: true,
  volume: true,
};

/** engine.ts#runTechnicalScreen as it was BEFORE the batching change. */
async function legacyTechnicalScreen(
  db: FakeDb,
  filters: ScreenerFilter[],
  exchange?: string,
  limit = 50,
): Promise<ScreenerResult[]> {
  const instruments = await db.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      ...(exchange ? { exchange } : {}),
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
    },
    take: 2000,
  });

  const results: ScreenerResult[] = [];

  for (const inst of instruments) {
    // MONEY-1133 — the reference encodes the CORRECTED window: most recent
    // 300, reversed back to oldest-first for computeIndicators. It used to
    // mirror the pre-batching `date: "asc"` loop, i.e. the oldest 300, which
    // is the bug this ticket fixed. Leaving it as-is would have made this
    // differential test re-assert the defect against itself.
    const candlesDesc = await db.dailyPrice.findMany({
      where: { instrumentId: inst.id },
      orderBy: { date: "desc" },
      take: 300,
      select: CANDLE_SELECT,
    });
    const candles = [...candlesDesc].reverse();

    if (candles.length < 30) continue;

    const ohlcv = toOhlcv(candles);
    const indicators = computeIndicators(ohlcv);

    if (matchesTechnicalFilters(indicators, filters)) {
      results.push({
        symbol: inst.symbol,
        exchange: inst.exchange,
        name: inst.name,
        sector: inst.sector,
        rsi14: indicators.rsi14,
        macd: indicators.macd,
        sma50: indicators.sma50,
        sma200: indicators.sma200,
        price: ohlcv[ohlcv.length - 1]?.close,
        volumeRatio: indicators.volumeRatio,
      });
    }

    if (results.length >= limit) break;
  }

  return results;
}

/** engine.ts#applyTechnicalFilters as it was BEFORE the batching change. */
async function legacyApplyTechnicalFilters(
  db: FakeDb,
  candidates: ScreenerResult[],
  filters: ScreenerFilter[],
): Promise<ScreenerResult[]> {
  const results: ScreenerResult[] = [];

  for (const candidate of candidates) {
    const inst = await db.instrumentMapping.findFirst({
      where: {
        symbol: candidate.symbol,
        exchange: candidate.exchange,
        isActive: true,
      },
      select: { id: true },
    });

    if (!inst) continue;

    // MONEY-1133 — the reference encodes the CORRECTED window: most recent
    // 300, reversed back to oldest-first for computeIndicators. It used to
    // mirror the pre-batching `date: "asc"` loop, i.e. the oldest 300, which
    // is the bug this ticket fixed. Leaving it as-is would have made this
    // differential test re-assert the defect against itself.
    const candlesDesc = await db.dailyPrice.findMany({
      where: { instrumentId: inst.id },
      orderBy: { date: "desc" },
      take: 300,
      select: CANDLE_SELECT,
    });
    const candles = [...candlesDesc].reverse();

    if (candles.length < 30) continue;

    const ohlcv = toOhlcv(candles);
    const indicators = computeIndicators(ohlcv);

    if (matchesTechnicalFilters(indicators, filters)) {
      results.push({
        ...candidate,
        rsi14: indicators.rsi14,
        macd: indicators.macd,
        sma50: indicators.sma50,
        sma200: indicators.sma200,
        price: ohlcv[ohlcv.length - 1]?.close,
        volumeRatio: indicators.volumeRatio,
      });
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// runTechnicalScreen — output identity
// ════════════════════════════════════════════════════════════════════════════

const RSI_ABOVE_60: ScreenerFilter[] = [
  { field: "rsi_14", operator: "gt", value: 60 },
];

describe("runTechnicalScreen — same in, same out", () => {
  it("returns EXACTLY what the pre-batching loop returned", async () => {
    const prices = fiveInstrumentPrices();
    const batched = makeDb(FIVE_INSTRUMENTS, prices);
    const legacy = makeDb(FIVE_INSTRUMENTS, prices);

    const got = await runTechnicalScreen(
      RSI_ABOVE_60,
      undefined,
      50,
      batched.deps,
    );
    const want = await legacyTechnicalScreen(
      legacy.db,
      RSI_ABOVE_60,
      undefined,
      50,
    );

    assert.deepStrictEqual(got, want);
  });

  it("matches the explicitly expected results (golden)", async () => {
    const { deps } = makeDb(FIVE_INSTRUMENTS, fiveInstrumentPrices());
    const got = await runTechnicalScreen(RSI_ABOVE_60, undefined, 50, deps);

    // MONEY-1133 — EEE dropped out of this golden, deliberately.
    //
    // AAA (rising) passes RSI > 60. EEE rises for its first 300 candles but
    // FALLS over its last 20, so once the engine reads the most recent 300 its
    // RSI is below 60 and it no longer matches. Under the old oldest-300
    // window it matched, which is precisely the bug: it was reported as a
    // strong-momentum stock on the strength of a window ending ~a year ago.
    // BBB falls (RSI 0), CCC has 29 candles, DDD has none.
    assert.deepStrictEqual(
      got.map((r) => r.symbol),
      ["AAA"],
    );

    const aaa = got[0]!;
    assert.equal(aaa.exchange, "NSE");
    assert.equal(aaa.name, "AAA Ltd");
    assert.equal(aaa.sector, "Information Technology");
    assert.equal(aaa.rsi14, 100); // strictly rising ⇒ avgLoss 0 ⇒ exactly 100
    assert.equal(aaa.price, 139); // last of 40 closes 100…139
    assert.equal(aaa.volumeRatio, 1); // constant volume
    assert.equal(aaa.sma50, undefined); // only 40 candles
    assert.equal(aaa.sma200, undefined);

    // MONEY-1133 — there is no `got[1]`: EEE no longer matches RSI > 60,
    // because the engine now reads its FALLING recent window. Its presence in
    // this golden was the bug in visible form. The dedicated cases below assert
    // both halves — that it drops out here, and that when a permissive filter
    // does return it, the price is the recent close (379) not the old (399).
    assert.equal(
      got.length,
      1,
      "AAA is the only match under the recent window",
    );
  });

  it("[MONEY-1133] windows the MOST RECENT 300 candles, not the oldest", async () => {
    // EEE rises for 300 candles (100…399) then falls for 20 (398…379).
    //
    //   most recent 300 (correct) ⇒ includes the falling tail: price 379, RSI
    //                                below 60, so EEE does NOT match rsi > 60.
    //   oldest 300      (the bug) ⇒ price 399, RSI 100, EEE matches.
    //
    // The screen returning FEWER stocks here is the fix working. Indicators
    // computed on a year-old window describe the past; the whole value of a
    // technical screen is that it describes now.
    const { deps } = makeDb(FIVE_INSTRUMENTS, fiveInstrumentPrices());
    const got = await runTechnicalScreen(RSI_ABOVE_60, undefined, 50, deps);

    const eee = got.find((r) => r.symbol === "EEE");
    assert.equal(
      eee,
      undefined,
      "EEE's recent window is falling, so it must NOT match rsi > 60 — " +
        "if it does, the engine is reading the oldest candles again",
    );
    assert.equal(SCREENER_CANDLE_LIMIT, 300);
  });

  it("[MONEY-1133] the recent window is reported, at the right price", async () => {
    // The companion to the case above: prove the window MOVED rather than the
    // instrument merely being filtered out for some other reason. With a
    // filter EEE can still satisfy, its reported price must be the newest
    // close (379), never the old window's 399.
    const { deps } = makeDb(FIVE_INSTRUMENTS, fiveInstrumentPrices());
    const anyRsi: ScreenerFilter[] = [
      { field: "rsi_14", operator: "gte", value: 0 },
    ];
    const got = await runTechnicalScreen(anyRsi, undefined, 50, deps);

    const eee = got.find((r) => r.symbol === "EEE");
    assert.ok(eee, "EEE should be returned by a filter that matches anything");
    assert.equal(eee.price, 379, "price must come from the most recent candle");
    assert.notEqual(eee.price, 399, "399 is the OLD window's last close");
  });

  it("an instrument with NO price rows is skipped, exactly as before", async () => {
    // DDD has zero rows: the Map lookup must yield [] (not undefined) and fall
    // through the `< 30 candles` gate without throwing.
    const prices = fiveInstrumentPrices().filter(
      (r) => r.instrumentId !== "i-ddd",
    );
    assert.ok(!prices.some((r) => r.instrumentId === "i-ddd"));

    const batched = makeDb(FIVE_INSTRUMENTS, prices);
    const legacy = makeDb(FIVE_INSTRUMENTS, prices);

    // A filter that matches everything computable, so only the gates decide.
    const anyRsi: ScreenerFilter[] = [
      { field: "rsi_14", operator: "gte", value: 0 },
    ];
    const got = await runTechnicalScreen(anyRsi, undefined, 50, batched.deps);
    const want = await legacyTechnicalScreen(legacy.db, anyRsi, undefined, 50);

    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(
      got.map((r) => r.symbol),
      ["AAA", "BBB", "EEE"],
    );
  });

  it("honours the exchange filter identically", async () => {
    const instruments = [
      instrument("i-aaa", "AAA", "NSE"),
      instrument("i-bse", "AAA", "BSE"),
    ];
    const prices = shuffled([
      ...rising("i-aaa", 40, 100),
      ...rising("i-bse", 40, 500),
    ]);
    const batched = makeDb(instruments, prices);
    const legacy = makeDb(instruments, prices);

    const got = await runTechnicalScreen(RSI_ABOVE_60, "BSE", 50, batched.deps);
    const want = await legacyTechnicalScreen(
      legacy.db,
      RSI_ABOVE_60,
      "BSE",
      50,
    );

    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(
      got.map((r) => [r.symbol, r.exchange, r.price]),
      [["AAA", "BSE", 539]],
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// runTechnicalScreen — the `limit` early exit
// ════════════════════════════════════════════════════════════════════════════

describe("runTechnicalScreen — limit semantics survive prefetching", () => {
  it("limit 1 stops at the first match and fetches one batch only", async () => {
    const prices = fiveInstrumentPrices();
    const batched = makeDb(FIVE_INSTRUMENTS, prices);
    const legacy = makeDb(FIVE_INSTRUMENTS, prices);

    const got = await runTechnicalScreen(
      RSI_ABOVE_60,
      undefined,
      1,
      batched.deps,
    );
    const want = await legacyTechnicalScreen(
      legacy.db,
      RSI_ABOVE_60,
      undefined,
      1,
    );

    assert.deepStrictEqual(got, want);
    assert.deepStrictEqual(
      got.map((r) => r.symbol),
      ["AAA"],
    );
    assert.equal(batched.log.dailyPrice.length, 1);
  });

  it("limit 0 exits after the first instrument that clears the 30-candle gate", async () => {
    // Pins the CHECK POSITION: it runs after the push and after the `< 30`
    // continue, so limit 0 still returns one result rather than none.
    const prices = fiveInstrumentPrices();
    const batched = makeDb(FIVE_INSTRUMENTS, prices);
    const legacy = makeDb(FIVE_INSTRUMENTS, prices);

    const got = await runTechnicalScreen(
      RSI_ABOVE_60,
      undefined,
      0,
      batched.deps,
    );
    const want = await legacyTechnicalScreen(
      legacy.db,
      RSI_ABOVE_60,
      undefined,
      0,
    );

    assert.deepStrictEqual(got, want);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.symbol, "AAA");
  });

  it("a limit larger than the universe returns every match, in DB order", async () => {
    const prices = fiveInstrumentPrices();
    const batched = makeDb(FIVE_INSTRUMENTS, prices);
    const legacy = makeDb(FIVE_INSTRUMENTS, prices);

    const got = await runTechnicalScreen(
      RSI_ABOVE_60,
      undefined,
      1000,
      batched.deps,
    );
    const want = await legacyTechnicalScreen(
      legacy.db,
      RSI_ABOVE_60,
      undefined,
      1000,
    );

    assert.deepStrictEqual(got, want);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// runTechnicalScreen — the N+1 regression guard
// ════════════════════════════════════════════════════════════════════════════

describe("runTechnicalScreen — query count is NOT proportional to instruments", () => {
  it("5 instruments cost ONE price query (the old loop cost 5)", async () => {
    const prices = fiveInstrumentPrices();
    const batched = makeDb(FIVE_INSTRUMENTS, prices);
    const legacy = makeDb(FIVE_INSTRUMENTS, prices);

    await runTechnicalScreen(RSI_ABOVE_60, undefined, 50, batched.deps);
    await legacyTechnicalScreen(legacy.db, RSI_ABOVE_60, undefined, 50);

    assert.equal(batched.log.dailyPrice.length, 1);
    assert.equal(legacy.log.dailyPrice.length, FIVE_INSTRUMENTS.length);
    assert.equal(batched.log.instrumentFindMany.length, 1);
  });

  it("250 instruments cost ceil(250/chunk) price queries, not 250", async () => {
    const n = 250;
    const { instruments, prices } = manyInstruments(n);
    const { deps, log } = makeDb(instruments, prices);

    // Nothing matches ⇒ the full universe is scanned, so this is the WORST case
    // for query count (no early exit can hide an N+1).
    const noMatch: ScreenerFilter[] = [
      { field: "rsi_14", operator: "gt", value: 200 },
    ];
    const got = await runTechnicalScreen(noMatch, undefined, 50, deps);

    assert.deepStrictEqual(got, []);
    const bound = Math.ceil(n / SCREENER_PRICE_CHUNK_SIZE);
    assert.equal(log.dailyPrice.length, bound);
    assert.ok(
      log.dailyPrice.length < n,
      `N+1 regression: ${log.dailyPrice.length} price queries for ${n} instruments`,
    );
  });

  it("the chunk/concurrency policy itself stays bounded", () => {
    // Asserting only `peak <= SCREENER_PRICE_CHUNK_CONCURRENCY` is defeatable
    // by RAISING the constant — the test would move its own goalposts. These
    // pin the policy absolutely, so widening either one is a deliberate edit
    // with a red test to justify it.
    assert.ok(
      SCREENER_PRICE_CHUNK_SIZE >= 50 && SCREENER_PRICE_CHUNK_SIZE <= 250,
      `chunk size ${SCREENER_PRICE_CHUNK_SIZE} is outside the sized window: ` +
        "smaller re-introduces round trips, larger makes one response too big " +
        "(a chunk carries every candle each instrument has)",
    );
    assert.ok(
      SCREENER_PRICE_CHUNK_CONCURRENCY >= 2 &&
        SCREENER_PRICE_CHUNK_CONCURRENCY <= 6,
      `chunk concurrency ${SCREENER_PRICE_CHUNK_CONCURRENCY} is outside the ` +
        "bounded window: 1 is serial, large is an unbounded fan-out at Atlas",
    );
  });

  it("500 instruments stay within the chunk bound AND the concurrency bound", async () => {
    const n = 500;
    const { instruments, prices } = manyInstruments(n);
    const { deps, log } = makeDb(instruments, prices);

    const noMatch: ScreenerFilter[] = [
      { field: "rsi_14", operator: "gt", value: 200 },
    ];
    await runTechnicalScreen(noMatch, undefined, 50, deps);

    const chunks = Math.ceil(n / SCREENER_PRICE_CHUNK_SIZE);
    assert.equal(log.dailyPrice.length, chunks);
    assert.ok(
      log.peakConcurrency > 1,
      "chunks must be fetched in parallel, not one after another",
    );
    assert.ok(
      log.peakConcurrency <= SCREENER_PRICE_CHUNK_CONCURRENCY,
      `unbounded fan-out: ${log.peakConcurrency} concurrent price queries`,
    );
    // Independent of the constant: 500 instruments is more than one wave, so
    // some chunk must still have been waiting when the first ones ran.
    assert.ok(
      log.peakConcurrency < chunks,
      `all ${chunks} chunks were opened at once — the wave bound is not applied`,
    );
  });

  it("every batched query is shaped for the [instrumentId, date] index", async () => {
    const n = 250;
    const { instruments, prices } = manyInstruments(n);
    const { deps, log } = makeDb(instruments, prices);

    await runTechnicalScreen(
      [{ field: "rsi_14", operator: "gt", value: 200 }],
      undefined,
      50,
      deps,
    );

    for (const args of log.dailyPrice) {
      const where = args.where as { instrumentId: { in: string[] } };
      assert.ok(Array.isArray(where.instrumentId.in), "must use an `in` list");
      assert.ok(
        where.instrumentId.in.length <= SCREENER_PRICE_CHUNK_SIZE,
        "chunks must not exceed the configured size",
      );
      // Sorting by instrumentId FIRST is what lets Mongo serve this from the
      // unique index instead of blocking-sorting the whole result set — and the
      // date leg is what keeps the per-instrument candles oldest-first.
      assert.deepStrictEqual(args.orderBy, [
        { instrumentId: "asc" },
        // MONEY-1133 — DESC. instrumentId still leads so the `$in` bounds keep
        // the @@unique([instrumentId, date]) index serving the sort.
        { date: "desc" },
      ]);
      // instrumentId must be selected or the rows cannot be grouped.
      assert.equal((args.select as Rec).instrumentId, true);
      // A DB-side `take` would truncate the batch across instruments.
      assert.equal(args.take, undefined);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// runTechnicalScreen — chunk grouping correctness
// ════════════════════════════════════════════════════════════════════════════

describe("runTechnicalScreen — grouping across chunks", () => {
  it("more instruments than one chunk still groups each instrument's own rows", async () => {
    const n = 250; // > SCREENER_PRICE_CHUNK_SIZE (100)
    assert.ok(n > SCREENER_PRICE_CHUNK_SIZE);

    const { instruments, prices } = manyInstruments(n);
    const batched = makeDb(instruments, prices);
    const legacy = makeDb(instruments, prices);

    const all: ScreenerFilter[] = [
      { field: "rsi_14", operator: "gte", value: 0 },
    ];
    const got = await runTechnicalScreen(all, undefined, 10_000, batched.deps);
    const want = await legacyTechnicalScreen(legacy.db, all, undefined, 10_000);

    assert.deepStrictEqual(got, want);
    assert.equal(got.length, n);

    // Each instrument's series starts at 100 + i and runs 31 candles, so a row
    // attached to the wrong instrument moves `price` off 130 + i.
    got.forEach((r, i) => {
      assert.equal(r.symbol, `SYM${String(i).padStart(4, "0")}`);
      assert.equal(r.price, 130 + i);
      assert.equal(r.rsi14, 100);
    });
    assert.equal(
      batched.log.dailyPrice.length,
      Math.ceil(n / SCREENER_PRICE_CHUNK_SIZE),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// applyTechnicalFilters — the second N+1
// ════════════════════════════════════════════════════════════════════════════

const MIXED_INSTRUMENTS: InstrumentRow[] = [
  instrument("i-nse", "AAA", "NSE"), // rising  → RSI 100
  instrument("i-bse", "AAA", "BSE"), // rising from a different level
  instrument("i-down", "BBB", "NSE"), // falling → RSI 0
  instrument("i-short", "CCC", "NSE"), // 29 candles
  instrument("i-nodata", "DDD", "NSE"), // no price rows
  instrument("i-off", "EEE", "NSE", { isActive: false }), // inactive
];

function mixedPrices(): PriceRow[] {
  return shuffled([
    ...rising("i-nse", 40, 100), // last close 139
    ...rising("i-bse", 40, 700), // last close 739
    ...falling("i-down", 40, 200),
    ...rising("i-short", 29, 50),
    ...rising("i-off", 40, 300),
  ]);
}

function candidate(symbol: string, exchange: string): ScreenerResult {
  return {
    symbol,
    exchange,
    name: `${symbol} Ltd`,
    sector: "Information Technology",
    pe: 21.5,
    marketCap: 1_000,
  };
}

const MIXED_CANDIDATES: ScreenerResult[] = [
  candidate("AAA", "NSE"),
  candidate("AAA", "BSE"), // same symbol, different exchange, different rows
  candidate("BBB", "NSE"),
  candidate("CCC", "NSE"),
  candidate("DDD", "NSE"),
  candidate("EEE", "NSE"), // instrument exists but isActive:false → unresolved
  candidate("ZZZ", "NSE"), // no instrument row at all → unresolved
];

describe("applyTechnicalFilters — same in, same out", () => {
  it("returns EXACTLY what the pre-batching loop returned", async () => {
    const prices = mixedPrices();
    const batched = makeDb(MIXED_INSTRUMENTS, prices);
    const legacy = makeDb(MIXED_INSTRUMENTS, prices);

    const got = await applyTechnicalFilters(
      MIXED_CANDIDATES,
      RSI_ABOVE_60,
      batched.deps,
    );
    const want = await legacyApplyTechnicalFilters(
      legacy.db,
      MIXED_CANDIDATES,
      RSI_ABOVE_60,
    );

    assert.deepStrictEqual(got, want);
  });

  it("matches the explicitly expected results (golden), per EXCHANGE", async () => {
    const { deps } = makeDb(MIXED_INSTRUMENTS, mixedPrices());
    const got = await applyTechnicalFilters(
      MIXED_CANDIDATES,
      RSI_ABOVE_60,
      deps,
    );

    // AAA/NSE and AAA/BSE both match and must carry their OWN prices — keying
    // the batch on symbol alone would give them the same candles.
    assert.deepStrictEqual(
      got.map((r) => [r.symbol, r.exchange, r.price]),
      [
        ["AAA", "NSE", 139],
        ["AAA", "BSE", 739],
      ],
    );
    // The fundamental fields from the candidate are carried through untouched.
    assert.equal(got[0]!.pe, 21.5);
    assert.equal(got[0]!.marketCap, 1_000);
    assert.equal(got[0]!.rsi14, 100);
    assert.equal(got[0]!.volumeRatio, 1);
  });

  it("candidates with no rows / no mapping / an inactive mapping are skipped", async () => {
    const { deps } = makeDb(MIXED_INSTRUMENTS, mixedPrices());
    const anyRsi: ScreenerFilter[] = [
      { field: "rsi_14", operator: "gte", value: 0 },
    ];
    const got = await applyTechnicalFilters(MIXED_CANDIDATES, anyRsi, deps);

    // BBB (falling) now passes; CCC (29 candles), DDD (no rows), EEE (inactive)
    // and ZZZ (no mapping) are all absent.
    assert.deepStrictEqual(
      got.map((r) => `${r.symbol}.${r.exchange}`),
      ["AAA.NSE", "AAA.BSE", "BBB.NSE"],
    );
  });
});

describe("applyTechnicalFilters — query count is NOT proportional to candidates", () => {
  it("one mapping query + one price query, whatever the candidate count", async () => {
    const prices = mixedPrices();
    const batched = makeDb(MIXED_INSTRUMENTS, prices);
    const legacy = makeDb(MIXED_INSTRUMENTS, prices);

    await applyTechnicalFilters(MIXED_CANDIDATES, RSI_ABOVE_60, batched.deps);
    await legacyApplyTechnicalFilters(
      legacy.db,
      MIXED_CANDIDATES,
      RSI_ABOVE_60,
    );

    assert.equal(batched.log.instrumentFindMany.length, 1);
    assert.equal(batched.log.instrumentFindFirst.length, 0);
    assert.equal(batched.log.dailyPrice.length, 1);

    // The old shape: one findFirst per candidate + one price query per resolved
    // candidate.
    assert.equal(
      legacy.log.instrumentFindFirst.length,
      MIXED_CANDIDATES.length,
    );
    assert.equal(legacy.log.dailyPrice.length, 5);
  });

  it("250 candidates stay within the chunk bound", async () => {
    const n = 250;
    const { instruments, prices } = manyInstruments(n);
    const { deps, log } = makeDb(instruments, prices);
    const candidates = instruments.map((i) => candidate(i.symbol, i.exchange));

    const got = await applyTechnicalFilters(
      candidates,
      [{ field: "rsi_14", operator: "gte", value: 0 }],
      deps,
    );

    assert.equal(got.length, n);
    got.forEach((r, i) => assert.equal(r.price, 130 + i));
    assert.equal(log.instrumentFindMany.length, 1);
    assert.equal(
      log.dailyPrice.length,
      Math.ceil(n / SCREENER_PRICE_CHUNK_SIZE),
    );
    assert.ok(log.dailyPrice.length < n);
  });

  it("no candidates ⇒ no queries at all", async () => {
    const { deps, log } = makeDb(MIXED_INSTRUMENTS, mixedPrices());
    const got = await applyTechnicalFilters([], RSI_ABOVE_60, deps);

    assert.deepStrictEqual(got, []);
    assert.equal(log.instrumentFindMany.length, 0);
    assert.equal(log.dailyPrice.length, 0);
  });
});
