/**
 * `gold.event_return_outcome`, EXECUTED. MONEY-1596 (data-platform C5a).
 *
 * The model's SQL and its point-in-time assertion live in
 * `dataform/includes/event_outcome.js`. This runs the exact strings Dataform
 * deploys, in `node:sqlite`, over fixtures that put an event on each side of
 * every line the rule draws: an evening 8-K an hour after the UTC date turns,
 * an IST small-hours event, an intraday one, a weekend one, a relinked one, one
 * with no listing, one on a suspended line.
 *
 * ## THREE BIGQUERY BUILT-INS, REGISTERED WITH BIGQUERY'S SEMANTICS
 *
 * `DATE(timestamp, zone)`, `UNIX_DATE(date)` and `STDDEV_SAMP` do not exist in
 * SQLite. They are registered below as SQLite functions — NULL in, NULL out,
 * and STDDEV_SAMP NULL below two values — so the text under test is the text
 * that ships, not a translated copy. `DATE`'s zone conversion is `Intl`, and a
 * case below pins it to the two TypeScript rules the rest of the lake dates
 * sessions by (`usMarketDateKey`, `toIstDateKey`).
 *
 * BigQuery evidence for the same SQL — a compile, `--dry_run`s and a read-only
 * execution over prod silver on 2026-09-23 — is recorded in the MONEY-1596
 * hand-off rather than here: a test that needs credentials does not run.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { usMarketDateKey } from "../../src/market-data/us-market-hours";
import { toIstDateKey } from "../../src/market-data/nse-holidays";

/* ─────────────────────────────────────────────────────────────────────────
   The include, loaded by path — see adjustment-sql-parity.test.ts for why
   ──────────────────────────────────────────────────────────────────────── */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

interface EventOutcomeInclude {
  MARKET_TIMEZONES: Readonly<Record<string, string>>;
  BENCHMARKS: Readonly<Record<string, { id: string }>>;
  WINDOW_SESSIONS: number;
  STALE_GAP_DAYS: number;
  REMEASURE_DAYS: number;
  eventReturnOutcomeSql: (tables: {
    events: string;
    bars: string;
    indexEod: string;
    candidates?: string;
  }) => string;
  pointInTimeViolationsSql: (outcomes: string, events: string) => string;
  incrementalCandidatesSql: (self: string) => string;
}

async function loadInclude<T>(file: string): Promise<T> {
  const mod = (await import(
    pathToFileURL(join(REPO_ROOT, "dataform/includes", file)).href
  )) as { default?: T } & T;
  return mod.default ?? mod;
}

const include = await loadInclude<EventOutcomeInclude>("event_outcome.js");
const adjustment = await loadInclude<{
  adjustedBarD1Sql: (source: string, actionSource: string) => string;
}>("adjustment.js");

const MODEL_SQL = include.eventReturnOutcomeSql({
  events: "instrument_event",
  bars: "adjusted_bar_d1",
  indexEod: "index_eod",
});
const PIT_SQL = include.pointInTimeViolationsSql(
  "event_return_outcome",
  "instrument_event",
);

const SPY = include.BENCHMARKS.US!.id;

/* ─────────────────────────────────────────────────────────────────────────
   BigQuery built-ins, for SQLite
   ──────────────────────────────────────────────────────────────────────── */

/** BigQuery `DATE(timestamp, zone)`: the civil date in that zone. */
function bqDateInZone(ts: unknown, zone: unknown): string | null {
  if (ts === null || zone === null) return null;
  const d = new Date(String(ts));
  if (!Number.isFinite(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: String(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.function("DATE", { deterministic: true }, (ts, zone) =>
    bqDateInZone(ts, zone),
  );
  db.function("UNIX_DATE", { deterministic: true }, (d) =>
    d === null ? null : Date.parse(`${String(d)}T00:00:00Z`) / 86_400_000,
  );
  // The accumulator must be an SQLite value, so the samples ride as JSON.
  db.aggregate("STDDEV_SAMP", {
    start: "[]",
    step: (acc, v) =>
      v === null
        ? acc
        : JSON.stringify([...(JSON.parse(String(acc)) as number[]), Number(v)]),
    result: (acc) => {
      const xs = JSON.parse(String(acc)) as number[];
      if (xs.length < 2) return null;
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
      return Math.sqrt(ss / (xs.length - 1));
    },
  });
  db.exec(`CREATE TABLE instrument_event (
    event_id TEXT, market TEXT, listing_id TEXT, event_type TEXT,
    observed_at TEXT, ingested_at TEXT
  )`);
  db.exec(`CREATE TABLE index_eod (
    market TEXT, index_slug TEXT, exchange TEXT, session_date TEXT,
    close REAL, ingested_at TEXT
  )`);
  return db;
}

/* ─────────────────────────────────────────────────────────────────────────
   Fixtures
   ──────────────────────────────────────────────────────────────────────── */

/** `n` weekday sessions from `start` (a Monday is not required). */
function sessions(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

interface Bar {
  market: string;
  listing_id: string;
  session_date: string;
  adj_open: number;
  adj_close: number;
}

/** A listing whose closes wiggle, so every window has a non-zero stddev. */
function series(
  market: string,
  listingId: string,
  dates: readonly string[],
  base: number,
  step: number,
): Bar[] {
  return dates.map((session_date, i) => {
    const close = base + step * i + ((i * 7) % 5) - 2;
    return {
      market,
      listing_id: listingId,
      session_date,
      adj_open: close - step / 2,
      adj_close: close,
    };
  });
}

const DAYS = sessions("2026-02-02", 60); // 2026-02-02 .. 2026-04-24
const AAA = "AAA:NASDAQ:2000-01-03";
const INF = "INF:NSE:unknown";
const OLD = "OLD:NSE:unknown";

const AAA_BARS = series("US", AAA, DAYS, 100, 0.5);
// SPY has NO bar on 2026-03-20: a benchmark gap must NULL the abnormal
// return and leave the raw one alone.
const SPY_BARS = series("US", SPY, DAYS, 500, 0.7).filter(
  (b) => b.session_date !== "2026-03-20",
);
const INF_BARS = series("IN", INF, DAYS, 1500, 2);
// Suspended from mid-January to late March: the event lands in the gap, so its
// base is two months stale AND its day 1 is weeks later. A "1-day return"
// across that is the plausible wrong number STALE_BARS exists to refuse.
const OLD_BARS = series(
  "IN",
  OLD,
  [...sessions("2026-01-05", 10), ...sessions("2026-03-23", 25)],
  50,
  0.1,
);

// Halted the session AFTER the news: its base (the event day) is fresh, but
// day 1 is fifteen days later. The OTHER half of the STALE_BARS rule — the
// base-gap case above never reaches it (MONEY-1597 review).
const HALT = "HALT:NSE:unknown";
const HALT_BARS = series(
  "IN",
  HALT,
  [...sessions("2026-02-02", 27), ...sessions("2026-03-25", 25)],
  300,
  1,
);

interface IndexRow {
  index_slug: string;
  session_date: string;
  close: number;
  ingested_at: string;
}
const NIFTY: IndexRow[] = DAYS.map((session_date, i) => ({
  index_slug: "nifty-50",
  session_date,
  close: 22_000 + 10 * i + (i % 2) * 5,
  ingested_at: "2026-09-22T13:58:26Z",
}));
const INDEX_ROWS: IndexRow[] = [
  ...NIFTY,
  // A superseded load of one session: an OLDER ingested_at and a close that
  // would make every abnormal return absurd if it were read.
  {
    index_slug: "nifty-50",
    session_date: "2026-03-11",
    close: 1,
    ingested_at: "2026-09-01T00:00:00Z",
  },
  // A decoy slug that sorts right beside it, loaded LATER — so a slug filter
  // that let it through would win the latest-row dedupe and be read.
  ...DAYS.map((session_date) => ({
    index_slug: "nifty50-usd",
    session_date,
    close: 9_999,
    ingested_at: "2026-09-23T00:00:00Z",
  })),
];

interface EventRow {
  event_id: string;
  market: string;
  listing_id: string | null;
  event_type: string;
  observed_at: string;
  ingested_at: string;
}

function ev(
  event_id: string,
  market: string,
  listing_id: string | null,
  observed_at: string,
  ingested_at = observed_at,
): EventRow {
  return {
    event_id,
    market,
    listing_id,
    event_type: "FILING_8K",
    observed_at,
    ingested_at,
  };
}

const EVENTS: EventRow[] = [
  // 21:30 EDT Monday 9 March = 01:30Z TUESDAY. The UTC date would make
  // Tuesday's close — printed a full session AFTER the filing — the base.
  ev("us_evening", "US", AAA, "2026-03-10T01:30:00Z"),
  // Same shape a week earlier, under EST (DST began 2026-03-08).
  ev("us_evening_est", "US", AAA, "2026-03-06T02:00:00Z"),
  // 10:00 EDT Thursday: during the session. The day's own bar is the BASE.
  ev("us_intraday", "US", AAA, "2026-03-12T14:00:00Z"),
  // Saturday: base Friday, day 1 Monday.
  ev("us_weekend", "US", AAA, "2026-03-14T15:00:00Z"),
  // 01:30 IST Tuesday 10 March = 20:00Z MONDAY.
  ev("in_overnight", "IN", INF, "2026-03-09T20:00:00Z"),
  // 17:30 IST Friday: after the close. Day 1 is Monday.
  ev("in_after_close", "IN", INF, "2026-03-13T12:00:00Z"),
  // Seven sessions of history after it: OPEN.
  ev("us_open", "US", AAA, "2026-04-15T14:00:00Z"),
  ev("no_listing", "IN", null, "2026-03-10T05:00:00Z"),
  ev("no_bars", "US", "ZZZ:NYSE:2001-01-01", "2026-03-10T15:00:00Z"),
  ev("stale", "IN", OLD, "2026-03-10T05:00:00Z"),
  // 10:30 IST on 2026-03-10, HALT's last session before the halt.
  ev("halted_after", "IN", HALT, "2026-03-10T05:00:00Z"),
  // A C3 re-link: first emitted with no listing, then a row carrying one.
  // Same observed_at; the later ingested_at wins.
  ev("relinked", "US", null, "2026-03-03T15:00:00Z", "2026-03-03T15:01:00Z"),
  ev("relinked", "US", AAA, "2026-03-03T15:00:00Z", "2026-03-05T09:00:00Z"),
  // Two rows that DISAGREE about the clock (a v1 re-emission beside the
  // first sighting). The later clock is the reader contract's pick.
  ev("two_clocks", "US", AAA, "2026-03-02T15:00:00Z", "2026-03-02T15:01:00Z"),
  ev("two_clocks", "US", AAA, "2026-03-03T15:00:00Z", "2026-03-03T15:01:00Z"),
];

function loadCommon(db: DatabaseSync, events: readonly EventRow[]): void {
  const e = db.prepare(`INSERT INTO instrument_event VALUES (?,?,?,?,?,?)`);
  for (const r of events)
    e.run(
      r.event_id,
      r.market,
      r.listing_id,
      r.event_type,
      r.observed_at,
      r.ingested_at,
    );
  const x = db.prepare(`INSERT INTO index_eod VALUES (?,?,?,?,?,?)`);
  for (const r of INDEX_ROWS)
    x.run("IN", r.index_slug, "NSE", r.session_date, r.close, r.ingested_at);
}

function loadBars(db: DatabaseSync, bars: readonly Bar[]): void {
  db.exec(`CREATE TABLE adjusted_bar_d1 (
    market TEXT, listing_id TEXT, session_date TEXT,
    adj_open REAL, adj_close REAL, adjustment_policy_version TEXT
  )`);
  const b = db.prepare(`INSERT INTO adjusted_bar_d1 VALUES (?,?,?,?,?,?)`);
  for (const r of bars)
    b.run(
      r.market,
      r.listing_id,
      r.session_date,
      r.adj_open,
      r.adj_close,
      "crsp-v3",
    );
}

interface OutcomeRow {
  event_id: string;
  market: string;
  listing_id: string | null;
  observed_at: string;
  observed_date: string;
  window_status: string;
  base_session_date: string | null;
  session_date_1d: string | null;
  session_date_5d: string | null;
  session_date_20d: string | null;
  last_after_session_date: string | null;
  after_sessions: number;
  ret_1d: number | null;
  ret_5d: number | null;
  ret_20d: number | null;
  abn_ret_1d: number | null;
  abn_ret_5d: number | null;
  abn_ret_20d: number | null;
  vol_20d_before: number | null;
  vol_20d_after: number | null;
  gap_open_pct: number | null;
  benchmark_id: string;
  adjustment_policy_version: string | null;
}

/** Build the standard fixture, run `sql` (the model by default). */
function run(
  sql = MODEL_SQL,
  events: readonly EventRow[] = EVENTS,
): { db: DatabaseSync; rows: Map<string, OutcomeRow> } {
  const db = openDb();
  loadCommon(db, events);
  loadBars(db, [
    ...AAA_BARS,
    ...SPY_BARS,
    ...INF_BARS,
    ...OLD_BARS,
    ...HALT_BARS,
  ]);
  const list = db.prepare(sql).all() as unknown as OutcomeRow[];
  const rows = new Map(list.map((r) => [r.event_id, r]));
  assert.equal(rows.size, list.length, "the model emitted an event twice");
  return { db, rows };
}

/** The PIT assertion over whatever `sql` produced. */
function violations(
  sql = MODEL_SQL,
  events: readonly EventRow[] = EVENTS,
): { event_id: string; failure: string }[] {
  const { db } = run(sql, events);
  try {
    db.exec(`CREATE TABLE event_return_outcome AS ${sql}`);
    return db.prepare(PIT_SQL).all() as unknown as {
      event_id: string;
      failure: string;
    }[];
  } finally {
    db.close();
  }
}

function get(rows: Map<string, OutcomeRow>, id: string): OutcomeRow {
  const r = rows.get(id);
  assert.ok(r, `no outcome row for ${id}`);
  return r;
}

function closeOn(bars: readonly Bar[], date: string): number {
  const b = bars.find((x) => x.session_date === date);
  assert.ok(b, `no fixture bar on ${date}`);
  return b.adj_close;
}

/** Replace exactly one occurrence, or fail — a mutation that matched nothing proves nothing. */
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assert.ok(n >= 1, `mutation target not found: ${from}`);
  return sql.split(from).join(to);
}

/* ─────────────────────────────────────────────────────────────────────────
   Tests
   ──────────────────────────────────────────────────────────────────────── */

describe("one row per event — the unmeasurable ones are COUNTED", () => {
  test("every distinct event yields exactly one row, whatever its status", () => {
    const { rows } = run();
    const distinct = new Set(EVENTS.map((e) => e.event_id));
    assert.equal(rows.size, distinct.size);
    assert.equal(get(rows, "no_listing").window_status, "NO_LISTING");
    assert.equal(get(rows, "no_bars").window_status, "NO_BARS");
    for (const id of ["no_listing", "no_bars"]) {
      assert.equal(get(rows, id).ret_1d, null, `${id} carries a return`);
    }
  });

  test("a halt AFTER the news is STALE_BARS too: fresh base, day 1 weeks away", () => {
    const { rows } = run();
    const r = get(rows, "halted_after");
    assert.equal(r.base_session_date, "2026-03-10");
    assert.equal(r.observed_date, "2026-03-10");
    assert.equal(r.session_date_1d, "2026-03-25");
    assert.equal(r.window_status, "STALE_BARS");
    assert.equal(r.ret_1d, null, "a 1-day return across a fifteen-day halt");
    assert.equal(r.gap_open_pct, null);
  });

  test("a suspended line is STALE_BARS and its returns are NULLED, not spanned", () => {
    const { rows } = run();
    const r = get(rows, "stale");
    assert.equal(r.window_status, "STALE_BARS");
    assert.equal(r.base_session_date, "2026-01-16");
    assert.equal(r.session_date_1d, "2026-03-23");
    for (const col of [
      "ret_1d",
      "abn_ret_1d",
      "vol_20d_before",
      "gap_open_pct",
    ] as const) {
      assert.equal(r[col], null, `stale row carries ${col}`);
    }
  });

  test("OPEN until the twentieth session prints, COMPLETE after", () => {
    const { rows } = run();
    const open = get(rows, "us_open");
    assert.equal(open.window_status, "OPEN");
    assert.equal(open.after_sessions, 7);
    assert.equal(open.ret_20d, null);
    assert.notEqual(open.ret_5d, null);
    const done = get(rows, "us_evening");
    assert.equal(done.window_status, "COMPLETE");
    assert.equal(done.after_sessions, include.WINDOW_SESSIONS);
    assert.notEqual(done.ret_20d, null);
  });
});

describe("point in time: the observed date is the VENUE's day", () => {
  test("an evening US event is dated by ET, not by UTC — both sides of DST", () => {
    const { rows } = run();
    const edt = get(rows, "us_evening");
    assert.equal(edt.observed_date, "2026-03-09");
    assert.equal(edt.base_session_date, "2026-03-09");
    assert.equal(edt.session_date_1d, "2026-03-10");
    const est = get(rows, "us_evening_est");
    assert.equal(est.observed_date, "2026-03-05");
    assert.equal(est.session_date_1d, "2026-03-06");
  });

  test("an IST small-hours event is dated by IST, not by UTC", () => {
    const { rows } = run();
    const r = get(rows, "in_overnight");
    assert.equal(r.observed_date, "2026-03-10");
    assert.equal(r.base_session_date, "2026-03-10");
    assert.equal(r.session_date_1d, "2026-03-11");
  });

  test("the SQL's day is the lake's own rule: usMarketDateKey and toIstDateKey", () => {
    const { rows } = run();
    for (const r of rows.values()) {
      const at = new Date(r.observed_at);
      const want = r.market === "US" ? usMarketDateKey(at) : toIstDateKey(at);
      assert.equal(r.observed_date, want, `${r.event_id} ${r.observed_at}`);
    }
  });

  test("a bar dated ON the observed day is the base, never day 1", () => {
    const { rows } = run();
    const intraday = get(rows, "us_intraday");
    assert.equal(intraday.base_session_date, "2026-03-12");
    assert.equal(intraday.session_date_1d, "2026-03-13");
    const weekend = get(rows, "us_weekend");
    assert.equal(weekend.base_session_date, "2026-03-13");
    assert.equal(weekend.session_date_1d, "2026-03-16");
    const afterClose = get(rows, "in_after_close");
    assert.equal(afterClose.base_session_date, "2026-03-13");
    assert.equal(afterClose.session_date_1d, "2026-03-16");
  });

  test("every after-bar of every row is dated after its observed date", () => {
    const { rows } = run();
    let measured = 0;
    for (const r of rows.values()) {
      if (r.session_date_1d === null) continue;
      measured++;
      for (const d of [
        r.session_date_1d,
        r.session_date_5d,
        r.session_date_20d,
        r.last_after_session_date,
      ]) {
        if (d !== null) assert.ok(d > r.observed_date, `${r.event_id}: ${d}`);
      }
      assert.ok(r.base_session_date! <= r.observed_date, r.event_id);
    }
    assert.ok(measured >= 8, `only ${measured} measured rows`);
  });

  test("the latest silver row wins: a re-link measures, the later clock dates", () => {
    const { rows } = run();
    const relinked = get(rows, "relinked");
    assert.equal(relinked.listing_id, AAA);
    assert.equal(relinked.window_status, "COMPLETE");
    assert.equal(get(rows, "two_clocks").observed_date, "2026-03-03");
  });
});

describe("the arithmetic", () => {
  test("returns, abnormal returns and the gap, against SPY", () => {
    const { rows } = run();
    const r = get(rows, "us_evening");
    const base = closeOn(AAA_BARS, "2026-03-09");
    const i = DAYS.indexOf("2026-03-09");
    const d1 = DAYS[i + 1]!;
    const d5 = DAYS[i + 5]!;
    const d20 = DAYS[i + 20]!;
    assert.equal(r.session_date_5d, d5);
    assert.equal(r.session_date_20d, d20);

    const ret = (d: string): number => closeOn(AAA_BARS, d) / base - 1;
    const spy = (d: string): number =>
      closeOn(SPY_BARS, d) / closeOn(SPY_BARS, "2026-03-09") - 1;
    const near = (got: number | null, want: number, what: string): void => {
      assert.ok(got !== null, `${what} is NULL`);
      assert.ok(Math.abs(got - want) < 1e-12, `${what}: ${got} vs ${want}`);
    };
    near(r.ret_1d, ret(d1), "ret_1d");
    near(r.ret_5d, ret(d5), "ret_5d");
    near(r.ret_20d, ret(d20), "ret_20d");
    near(r.abn_ret_1d, ret(d1) - spy(d1), "abn_ret_1d");
    near(r.abn_ret_5d, ret(d5) - spy(d5), "abn_ret_5d");
    near(r.abn_ret_20d, ret(d20) - spy(d20), "abn_ret_20d");
    const open1 = AAA_BARS.find((b) => b.session_date === d1)!.adj_open;
    near(r.gap_open_pct, 100 * (open1 / base - 1), "gap_open_pct (percent)");
    assert.equal(r.benchmark_id, SPY);
    assert.equal(r.adjustment_policy_version, "crsp-v3");
  });

  test("India's benchmark is the LATEST nifty-50 row, never a decoy slug", () => {
    const { rows } = run();
    const r = get(rows, "in_overnight");
    // Day 1 is 2026-03-11, the session with a superseded close of 1 beside it.
    assert.equal(r.session_date_1d, "2026-03-11");
    const nifty = (d: string): number =>
      NIFTY.find((x) => x.session_date === d)!.close;
    const bench = nifty("2026-03-11") / nifty("2026-03-10") - 1;
    const ret =
      closeOn(INF_BARS, "2026-03-11") / closeOn(INF_BARS, "2026-03-10") - 1;
    assert.ok(Math.abs(r.abn_ret_1d! - (ret - bench)) < 1e-12);
    assert.equal(r.benchmark_id, "nifty-50");
  });

  test("a benchmark gap NULLs the abnormal return and keeps the raw one", () => {
    const { rows } = run();
    const r = get(rows, "us_weekend");
    assert.equal(r.session_date_5d, "2026-03-20"); // SPY has no bar that day
    assert.notEqual(r.ret_5d, null);
    assert.equal(r.abn_ret_5d, null);
    assert.notEqual(r.abn_ret_1d, null);
  });

  test("vol windows: 20 log returns ENDING at the base, and the 20 after it", () => {
    const { rows } = run();
    const r = get(rows, "us_evening");
    const i = DAYS.indexOf("2026-03-09");
    const logRet = (k: number): number =>
      Math.log(AAA_BARS[k]!.adj_close / AAA_BARS[k - 1]!.adj_close);
    const sd = (xs: number[]): number => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(
        xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1),
      );
    };
    const before = Array.from({ length: 20 }, (_, j) => logRet(i - 19 + j));
    const after = Array.from({ length: 20 }, (_, j) => logRet(i + 1 + j));
    assert.ok(Math.abs(r.vol_20d_before! - sd(before)) < 1e-12);
    assert.ok(Math.abs(r.vol_20d_after! - sd(after)) < 1e-12);
  });
});

describe("the ADJUSTED bars: a split inside the window is not a return", () => {
  test("a 2:1 split three sessions after the event leaves ret_5d near zero", () => {
    const db = openDb();
    try {
      loadCommon(db, [
        ev("pre_split", "US", "SPL:NASDAQ:2001-01-02", "2026-03-10T01:30:00Z"),
      ]);
      db.exec(`CREATE TABLE price_bar_d1 (
        market TEXT, listing_id TEXT, symbol TEXT, exchange TEXT,
        session_date TEXT, open REAL, high REAL, low REAL, close REAL,
        volume INTEGER, div_cash REAL, split_factor REAL, source TEXT
      )`);
      db.exec(`CREATE TABLE corporate_action (
        market TEXT, listing_id TEXT, action_type TEXT, ex_date TEXT,
        ratio REAL, observed_ratio REAL, cash REAL, observed_at TEXT,
        source_record_key TEXT, source TEXT
      )`);
      const ins = db.prepare(
        `INSERT INTO price_bar_d1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const exDate = DAYS[DAYS.indexOf("2026-03-09") + 3]!;
      for (const d of DAYS) {
        const post = d >= exDate;
        const px = post ? 101 : 200; // halves at the split, +1% of real move
        ins.run(
          "US",
          "SPL:NASDAQ:2001-01-02",
          "SPL",
          "NASDAQ",
          d,
          px,
          px,
          px,
          px,
          1000,
          0,
          d === exDate ? 2 : 1,
          "TIINGO",
        );
      }
      db.exec(
        `CREATE VIEW adjusted_bar_d1 AS ${adjustment.adjustedBarD1Sql("price_bar_d1", "corporate_action")}`,
      );
      const one = (sql: string): OutcomeRow =>
        (db.prepare(sql).all() as unknown as OutcomeRow[]).find(
          (r) => r.event_id === "pre_split",
        )!;
      const r = one(MODEL_SQL);
      assert.ok(Math.abs(r.ret_5d! - 0.01) < 1e-9, `ret_5d ${r.ret_5d}`);
      // The same query on RAW closes reports the split as a -49.5% day. The
      // model must not be reading those.
      const raw = one(mutate(MODEL_SQL, "adj_close", "close"));
      assert.ok(raw.ret_5d! < -0.4, `raw ret_5d ${raw.ret_5d}`);
    } finally {
      db.close();
    }
  });
});

describe("assert_event_outcome_point_in_time", () => {
  test("zero rows over the model's own output", () => {
    assert.deepEqual(violations(), []);
  });

  test("a model that dates events by UTC is caught (the evening 8-K)", () => {
    const bad = mutate(
      MODEL_SQL,
      `DATE(observed_at, '${include.MARKET_TIMEZONES.US}')`,
      "DATE(observed_at, 'UTC')",
    );
    const found = violations(bad);
    assert.ok(
      found.some(
        (v) =>
          v.event_id === "us_evening" &&
          /not the venue-local day/.test(v.failure),
      ),
      JSON.stringify(found),
    );
  });

  test("a model that counts the observed day as day 1 is caught", () => {
    // Bars sort AFTER same-day events: the observed day's bar becomes day 1.
    const bad = mutate(MODEL_SQL, "0 AS is_event", "2 AS is_event");
    const found = violations(bad);
    assert.ok(
      found.some(
        (v) =>
          v.event_id === "us_intraday" &&
          /after-bar is dated on or before/.test(v.failure),
      ),
      JSON.stringify(found),
    );
  });

  test("a model that reads an earlier clock than silver holds is caught", () => {
    const bad = mutate(
      MODEL_SQL,
      "ORDER BY e.observed_at DESC",
      "ORDER BY e.observed_at ASC",
    );
    const found = violations(bad);
    assert.ok(
      found.some(
        (v) => v.event_id === "two_clocks" && /EARLIER/.test(v.failure),
      ),
      JSON.stringify(found),
    );
  });
});

describe("the incremental predicate", () => {
  test("re-measures new silver rows AND every stored outcome that is not COMPLETE", () => {
    // BigQuery-only (it reads the model's own table), so it is pinned as text.
    const sql = include.incrementalCandidatesSql("SELF");
    assert.match(sql, /c\.ingested_at > COALESCE\(/);
    assert.match(sql, /MAX\(computed_at\)/);
    assert.match(sql, /window_status <> 'COMPLETE'/);
    // …but not for ever: a row that can never complete (delisted inside its
    // window) stops being re-read REMEASURE_DAYS after it was observed.
    assert.equal(include.REMEASURE_DAYS, 60);
    assert.match(
      sql,
      /window_status <> 'COMPLETE'\s+AND observed_date >= DATE_SUB\(CURRENT_DATE\(\), INTERVAL 60 DAY\)/,
    );
    // Without the COALESCE an empty table's NULL watermark selects nothing,
    // on every run, for ever.
    assert.match(sql, /TIMESTAMP '1970-01-01/);
  });
});
