/**
 * MONEY-1309 — the SHARED Tiingo budget guard.
 *
 * Every test here runs against a FAKE Redis and a FAKE clock, injected through
 * the module's own seams. `packages/core` is ESM, so there is no CJS
 * `require.cache` swap available and `mock.module` needs a flag this repo does
 * not pass — the seams are the mechanism, which is why the first test in the
 * file proves the seams are actually load-bearing rather than decorative.
 *
 * The mutations these tests were verified against, each of which MUST redden a
 * named test below (run and confirmed, MONEY-1309):
 *
 *   (a) delete the shared INCR from `recordTiingoRequest`
 *       -> "the 101st call is refused" fails: the shared counter never rises,
 *          so the ceiling is unreachable and every call is authorised.
 *   (b) hoist the plan read to a module const (`const L = tiingoLimits()`)
 *       -> "TIINGO_PLAN is resolved PER CALL" fails: the flip is invisible
 *          because the value froze at import.
 *   (c) charge the counter BEFORE `fn()` in `withTiingoBudget`
 *       -> "a throwing fn leaves the counters untouched" fails: the failed
 *          request is counted as spend. (MONEY-1255's defect class.)
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TIINGO_BYTES_LADDER,
  TIINGO_CIRCUIT_BREAK_MS,
  TIINGO_MAX_BUDGET_CONSUMERS,
  TIINGO_REQUEST_CEILING_FRACTION,
  TIINGO_STREAM_FLUSH_BYTES,
  TiingoBudgetExhaustedError,
  __resetTiingoBudget,
  __setTiingoBudgetClockForTests,
  __setTiingoBudgetLimitsForTests,
  __setTiingoBudgetRedisForTests,
  checkTiingoBudget,
  flushStreamBytes,
  isTiingoRateLimitFailure,
  readTiingoBytesStage,
  recordBytes,
  recordStreamBytes,
  recordTiingoRequest,
  tiingoBudgetCeilings,
  tiingoBudgetConsumers,
  tiingoBudgetWindows,
  tiingoBytesStage,
  tiingoStatusFromError,
  withTiingoBudget,
  type TiingoBudgetRedis,
} from "../../src/market-data/tiingo/tiingo-budget";
import { TIINGO_PLAN_LIMITS } from "../../src/market-data/tiingo/tiingo-logic";
import { TiingoRateLimitError } from "../../src/market-data/tiingo/tiingo-errors";
import { TiingoDailyCapError } from "../../src/market-data/tiingo/tiingo-pacer";
import {
  decideTiingoFailure,
  MAX_RETRIES,
} from "../../src/market-data/tiingo/tiingo-client";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeRedis extends TiingoBudgetRedis {
  readonly store: Map<string, string>;
  readonly ttls: Map<string, number>;
  /** Every key INCRBY'd, in order. The premise test reads this. */
  readonly incrbyKeys: string[];
  /** Flip to make every command reject, simulating a live node going away. */
  failing: boolean;
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const incrbyKeys: string[] = [];
  const self: FakeRedis = {
    store,
    ttls,
    incrbyKeys,
    failing: false,
    async incrby(key, amount) {
      if (self.failing) throw new Error("fake redis down");
      incrbyKeys.push(key);
      const next = (Number(store.get(key) ?? 0) || 0) + amount;
      store.set(key, String(next));
      return next;
    },
    async expire(key, seconds) {
      if (self.failing) throw new Error("fake redis down");
      ttls.set(key, seconds);
      return 1;
    },
    async get(key) {
      if (self.failing) throw new Error("fake redis down");
      return store.get(key) ?? null;
    },
    async setEx(key, value, seconds) {
      if (self.failing) throw new Error("fake redis down");
      store.set(key, value);
      ttls.set(key, seconds);
    },
  };
  return self;
}

/** 2026-08-31T12:00:00Z — inside one hour, one day and one month window. */
const BASE_MS = Date.UTC(2026, 7, 31, 12, 0, 0);

let redis: FakeRedis;
let now: number;
let warnings: string[];
let errors: string[];
let realWarn: typeof console.warn;
let realError: typeof console.error;
let savedPlan: string | undefined;
let savedConsumers: string | undefined;

beforeEach(() => {
  redis = makeFakeRedis();
  now = BASE_MS;
  __resetTiingoBudget();
  __setTiingoBudgetRedisForTests(() => redis);
  __setTiingoBudgetClockForTests(() => now);
  savedPlan = process.env.TIINGO_PLAN;
  savedConsumers = process.env.TIINGO_BUDGET_CONSUMERS;
  delete process.env.TIINGO_PLAN;
  delete process.env.TIINGO_BUDGET_CONSUMERS;

  // Captured rather than silenced: two tests assert on what was logged, and
  // the rest would otherwise print a degradation warning per run.
  warnings = [];
  errors = [];
  realWarn = console.warn;
  realError = console.error;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  __setTiingoBudgetRedisForTests(null);
  __setTiingoBudgetClockForTests(null);
  __setTiingoBudgetLimitsForTests(null);
  __resetTiingoBudget();
  console.warn = realWarn;
  console.error = realError;
  if (savedPlan === undefined) delete process.env.TIINGO_PLAN;
  else process.env.TIINGO_PLAN = savedPlan;
  if (savedConsumers === undefined) delete process.env.TIINGO_BUDGET_CONSUMERS;
  else process.env.TIINGO_BUDGET_CONSUMERS = savedConsumers;
});

/** Limits that put the SHARED hourly ceiling at exactly 100. */
const FAKE_LIMITS_100_PER_HOUR = {
  perHour: 125, // x 0.8 = 100
  perDay: 1_000_000,
  bandwidthBytesPerMonth: 1_000,
} as const;

// ---------------------------------------------------------------------------
// PREMISE — the suite cannot pass vacuously
// ---------------------------------------------------------------------------

describe("PREMISE — this suite is capable of failing", () => {
  test("the fake Redis is actually reached, so 'shared' means shared", async () => {
    // Without this, every test below would pass identically against a module
    // that silently fell back to its per-process ledger — the exact failure
    // mode the guard exists to make visible, hidden inside its own test suite.
    await recordTiingoRequest();
    const w = tiingoBudgetWindows(BASE_MS);
    assert.deepEqual(redis.incrbyKeys, [
      `tiingo:budget:req:h:${w.hour}`,
      `tiingo:budget:req:d:${w.day}`,
    ]);
    assert.equal(redis.store.get(`tiingo:budget:req:h:${w.hour}`), "1");

    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.shared, true, "the verdict must say it used Redis");
    assert.equal(verdict.hourUsed, 1);
  });

  test("keys carry their window and get a TTL on CREATE", async () => {
    // The keys expire NATURALLY. If they did not carry the window, yesterday's
    // count would still be charged against today and the guard would ratchet
    // shut permanently; if they never got a TTL, Redis would accumulate one
    // dead key per hour forever.
    await recordTiingoRequest();
    const w = tiingoBudgetWindows(BASE_MS);
    assert.equal(w.hour, "2026083112");
    assert.equal(w.day, "20260831");
    assert.equal(w.month, "202608");
    assert.equal(redis.ttls.get(`tiingo:budget:req:h:${w.hour}`), 2 * 3600);
    assert.equal(redis.ttls.get(`tiingo:budget:req:d:${w.day}`), 48 * 3600);

    // EXPIRE only on create: a second charge must not re-issue it, or the cost
    // is one extra round trip on every request in a 73k-request backfill.
    redis.ttls.delete(`tiingo:budget:req:h:${w.hour}`);
    await recordTiingoRequest();
    assert.equal(redis.ttls.has(`tiingo:budget:req:h:${w.hour}`), false);
  });

  test("the ladder really has three ASCENDING rungs starting at 0.70", () => {
    // A "fires at 70% and escalates" test is tautological against a one-rung
    // ladder, and silently weaker against rungs that are not ordered.
    assert.equal(TIINGO_BYTES_LADDER.length, 3);
    assert.deepEqual(
      TIINGO_BYTES_LADDER.map((r) => r.fraction),
      [0.7, 0.8, 0.9],
    );
    assert.deepEqual(
      TIINGO_BYTES_LADDER.map((r) => r.stage),
      ["shrink-ephemeral", "baseline-only", "alarm"],
    );
    for (const rung of TIINGO_BYTES_LADDER) {
      assert.ok(rung.action.length > 20, `${rung.stage} needs an action`);
    }
  });

  test("the REAL ceilings are 80% of the real plan table, not the fake ones", () => {
    // Everything below uses `__setTiingoBudgetLimitsForTests` so a ceiling of
    // 100 can be exercised in 101 calls instead of 20,001. That seam is only
    // honest if the un-overridden path is the production one.
    assert.equal(TIINGO_REQUEST_CEILING_FRACTION, 0.8);
    const c = tiingoBudgetCeilings();
    assert.equal(c.perHour, 16_000);
    assert.equal(c.perDay, 120_000);
    assert.equal(c.perHour, TIINGO_PLAN_LIMITS.COMMERCIAL.perHour * 0.8);
    assert.equal(
      c.bytesPerMonth,
      TIINGO_PLAN_LIMITS.COMMERCIAL.bandwidthBytesPerMonth,
      "bytes are graded against the RAW cap — the ladder is not an 80% ceiling",
    );
  });
});

// ---------------------------------------------------------------------------
// The hourly ceiling
// ---------------------------------------------------------------------------

describe("request ceilings", () => {
  test("a 100/hour ceiling is honoured — the 101st call is refused", async () => {
    // MUTATION (a): deleting the shared INCR from `recordTiingoRequest` reddens
    // this test — the counter stays at 0 and the 101st call is authorised.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    assert.equal(tiingoBudgetCeilings().perHour, 100);

    let ran = 0;
    for (let i = 0; i < 100; i++) {
      await withTiingoBudget("eod", async () => {
        ran++;
        return "ok";
      });
    }
    assert.equal(ran, 100, "the first 100 must all go through");

    const w = tiingoBudgetWindows(BASE_MS);
    assert.equal(redis.store.get(`tiingo:budget:req:h:${w.hour}`), "100");

    await assert.rejects(
      () => withTiingoBudget("eod", async () => "the 101st"),
      (err: unknown) => {
        assert.ok(err instanceof TiingoBudgetExhaustedError);
        assert.equal(err.verdict.reason, "hour-ceiling");
        // It must ALSO be a TiingoRateLimitError, or the seven existing
        // circuit-breakers written against that class fall through to their
        // generic `else` — where the run tears through the rest of its
        // symbols recording failures and then chains for more work.
        assert.ok(err instanceof TiingoRateLimitError);
        return true;
      },
    );
    assert.equal(ran, 100, "the refused call must never invoke fn");
  });

  test("the DAILY ceiling refuses before the hourly one", async () => {
    // Ordering matters for the operator: "day-ceiling" means wait until
    // tomorrow, "hour-ceiling" means wait a few minutes. Reporting the hour
    // when the day is also spent sends whoever is on call back in an hour to
    // find the identical refusal.
    __setTiingoBudgetLimitsForTests({
      perHour: 125,
      perDay: 125,
      bandwidthBytesPerMonth: 1_000_000,
    });
    for (let i = 0; i < 100; i++) await recordTiingoRequest();
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.allowed === false ? verdict.reason : null,
      "day-ceiling",
    );
  });

  test("a new hour window starts from zero", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    for (let i = 0; i < 100; i++) await recordTiingoRequest();
    assert.equal((await checkTiingoBudget("eod")).allowed, false);

    now = BASE_MS + 3_600_000; // next clock hour -> a different key entirely
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.hourUsed, 0);
  });
});

// ---------------------------------------------------------------------------
// The plan switch
// ---------------------------------------------------------------------------

describe("TIINGO_PLAN is resolved PER CALL", () => {
  test("flipping COMMERCIAL -> REDISTRIBUTION raises the ceilings with no code change", () => {
    // MUTATION (b): hoisting the plan read to a module const reddens this —
    // the value freezes at import and the second read returns the first
    // answer. That is the documented trap on `bse-client.ts`'s retry config,
    // and on a WARM Cloud Run container it turns a redeployed switch into no
    // switch at all.
    //
    // NOTE the multiples: this is NOT a uniform "triple". Measured off
    // TIINGO_PLAN_LIMITS, REDISTRIBUTION is 4x hourly (20,000 -> 80,000) and
    // 8x daily (150,000 -> 1,200,000), with bandwidth 100 GB -> 1 TB. A test
    // asserting a triple would fail against the real table, so it asserts the
    // real table.
    process.env.TIINGO_PLAN = "COMMERCIAL";
    const commercial = tiingoBudgetCeilings();
    assert.equal(commercial.perHour, 16_000);
    assert.equal(commercial.perDay, 120_000);

    process.env.TIINGO_PLAN = "REDISTRIBUTION";
    const redistribution = tiingoBudgetCeilings();
    assert.equal(redistribution.perHour, 64_000);
    assert.equal(redistribution.perDay, 960_000);
    assert.equal(redistribution.bytesPerMonth, 1024 ** 4);

    assert.equal(redistribution.perHour / commercial.perHour, 4);
    assert.equal(redistribution.perDay / commercial.perDay, 8);

    // And back again in the same process, so the read cannot be a one-shot
    // memoisation that merely happens to run late.
    process.env.TIINGO_PLAN = "COMMERCIAL";
    assert.equal(tiingoBudgetCeilings().perHour, 16_000);
  });

  test("an unset or misspelled plan lands on the LOWER ceilings", () => {
    // Same direction as `resolveTiingoPlan`: guessing high walks a backfill
    // into a 429 wall mid-universe and leaves a half-filled table; guessing
    // low only runs slower.
    delete process.env.TIINGO_PLAN;
    assert.equal(tiingoBudgetCeilings().perHour, 16_000);
    process.env.TIINGO_PLAN = "REDISTRIBUTON"; // typo, on purpose
    assert.equal(tiingoBudgetCeilings().perHour, 16_000);
  });

  test("the live verdict enforces the plan that is set AT CHECK TIME", async () => {
    // The ceiling test above is arithmetic; this is the same property observed
    // through the thing callers actually use.
    process.env.TIINGO_PLAN = "COMMERCIAL";
    const w = tiingoBudgetWindows(BASE_MS);
    redis.store.set(`tiingo:budget:req:h:${w.hour}`, "20000");
    assert.equal((await checkTiingoBudget("eod")).allowed, false);

    process.env.TIINGO_PLAN = "REDISTRIBUTION";
    assert.equal((await checkTiingoBudget("eod")).allowed, true);
  });
});

// ---------------------------------------------------------------------------
// The bandwidth ladder
// ---------------------------------------------------------------------------

describe("monthly bytes ladder", () => {
  test("fires at EXACTLY 70% and escalates through all three stages", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR); // 1,000-byte cap

    assert.equal(await recordBytes(699), null, "69.9% is below the ladder");
    assert.equal(
      await recordBytes(1),
      "shrink-ephemeral",
      "exactly 700/1000 must fire rung 1 — the boundary is >=, not >",
    );
    assert.equal(await recordBytes(100), "baseline-only", "800/1000 = rung 2");
    assert.equal(await recordBytes(100), "alarm", "900/1000 = rung 3");

    const w = tiingoBudgetWindows(BASE_MS);
    assert.equal(redis.store.get(`tiingo:budget:bytes:m:${w.month}`), "900");
  });

  test("the boundary is exact in the pure grader too", () => {
    assert.equal(tiingoBytesStage(699, 1000), null);
    assert.equal(tiingoBytesStage(700, 1000), "shrink-ephemeral");
    assert.equal(tiingoBytesStage(799, 1000), "shrink-ephemeral");
    assert.equal(tiingoBytesStage(800, 1000), "baseline-only");
    assert.equal(tiingoBytesStage(900, 1000), "alarm");
    assert.equal(tiingoBytesStage(10_000, 1000), "alarm", "past the top rung");
    // A zero or non-finite denominator must not produce a stage out of a
    // division by zero — NaN >= 0.7 is false, so the honest answer is null.
    assert.equal(tiingoBytesStage(500, 0), null);
    assert.equal(tiingoBytesStage(Number.NaN, 1000), null);
  });

  test("the ladder NEVER refuses a request — bytes degrade, they do not stop", async () => {
    // Monthly bandwidth is the one limit that does not reset in an hour.
    // Refusing at 70% would dark the platform for the rest of the month over a
    // budget with 30% still in it.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    await recordBytes(950);
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.stage, "alarm", "but the caller is told to act");
  });

  test("the stage is published to Redis so OTHER processes can read it", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    const w = tiingoBudgetWindows(BASE_MS);
    await recordBytes(800);
    assert.equal(redis.store.get(`tiingo:budget:stage:m:${w.month}`), "2");
    assert.equal(await readTiingoBytesStage(), "baseline-only");

    await recordBytes(100);
    assert.equal(redis.store.get(`tiingo:budget:stage:m:${w.month}`), "3");
    assert.equal(await readTiingoBytesStage(), "alarm");
  });

  test("the published stage is MONOTONE within a month", async () => {
    // A flapping ladder toggles `baseline-only` on and off between nightly legs,
    // which is worse than being one rung stale.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    const w = tiingoBudgetWindows(BASE_MS);
    await recordBytes(900);
    assert.equal(redis.store.get(`tiingo:budget:stage:m:${w.month}`), "3");

    // Another process reports a stale, lower total. The rung must not drop.
    redis.store.set(`tiingo:budget:bytes:m:${w.month}`, "700");
    await recordBytes(1);
    assert.equal(redis.store.get(`tiingo:budget:stage:m:${w.month}`), "3");
  });

  test("a non-finite or non-positive byte count is dropped, not added", async () => {
    // A single NaN would poison the counter permanently: `NaN >= 0.7 * cap` is
    // false, so the ladder would read "below rung 1" forever.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    await recordBytes(800);
    await recordBytes(Number.NaN);
    await recordBytes(-500);
    await recordBytes(0);
    const w = tiingoBudgetWindows(BASE_MS);
    assert.equal(redis.store.get(`tiingo:budget:bytes:m:${w.month}`), "800");
    assert.equal(await readTiingoBytesStage(), "baseline-only");
  });
});

// ---------------------------------------------------------------------------
// Fail-degraded
// ---------------------------------------------------------------------------

describe("Redis unavailable — fail DEGRADED, never fail closed", () => {
  test("no client: falls back to ceiling / TIINGO_BUDGET_CONSUMERS and does not throw", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR); // shared = 100
    __setTiingoBudgetRedisForTests(() => null);
    process.env.TIINGO_BUDGET_CONSUMERS = "4";
    assert.equal(tiingoBudgetConsumers(), 4);

    const first = await checkTiingoBudget("eod");
    assert.equal(first.allowed, true, "a Redis outage must NOT stop the run");
    assert.equal(first.shared, false);
    assert.equal(first.ceilings.perHour, 25, "100 / 4");

    let ran = 0;
    for (let i = 0; i < 25; i++) {
      await withTiingoBudget("eod", async () => {
        ran++;
        return "ok";
      });
    }
    assert.equal(ran, 25);
    await assert.rejects(
      () => withTiingoBudget("eod", async () => "26th"),
      TiingoBudgetExhaustedError,
    );
  });

  test("a node that goes away mid-run degrades rather than throwing", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    await withTiingoBudget("eod", async () => "warm");
    redis.failing = true;

    // Every command now rejects. Nothing here may propagate that: the nightly
    // EOD sync has ONE window a day, gated by the US close, and a night it
    // does not run is a hole in `candles` that only a ~73k-request backfill
    // can fill.
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.shared, false);
    assert.equal(
      await withTiingoBudget("eod", async () => "still ok"),
      "still ok",
    );
    assert.equal(await recordBytes(10), null);
  });

  test("the degradation is logged ONCE PER WINDOW, not once per call", async () => {
    // A per-call warning inside a 73k-request backfill is not an alert, it is
    // a way of hiding one.
    __setTiingoBudgetRedisForTests(() => null);
    for (let i = 0; i < 20; i++) await checkTiingoBudget("eod");
    assert.equal(warnings.length, 1, "one warning for the whole hour window");
    assert.match(warnings[0] ?? "", /SHARED counter unavailable/);
    assert.match(warnings[0] ?? "", /per-process share of 1\/3/);

    now = BASE_MS + 3_600_000; // new hour window
    await checkTiingoBudget("eod");
    assert.equal(warnings.length, 2, "and one more in the next window");
  });

  test("TIINGO_BUDGET_CONSUMERS defaults to 3 and refuses nonsense", () => {
    delete process.env.TIINGO_BUDGET_CONSUMERS;
    assert.equal(tiingoBudgetConsumers(), 3);
    process.env.TIINGO_BUDGET_CONSUMERS = "0";
    assert.equal(tiingoBudgetConsumers(), 3, "0 would divide by zero");
    process.env.TIINGO_BUDGET_CONSUMERS = "-2";
    assert.equal(
      tiingoBudgetConsumers(),
      3,
      "a negative would INVERT the sign",
    );
    process.env.TIINGO_BUDGET_CONSUMERS = "banana";
    assert.equal(tiingoBudgetConsumers(), 3);
    process.env.TIINGO_BUDGET_CONSUMERS = "8";
    assert.equal(tiingoBudgetConsumers(), 8);
  });
});

// ---------------------------------------------------------------------------
// Counting after success only
// ---------------------------------------------------------------------------

describe("counters move AFTER success only (MONEY-1255)", () => {
  test("a throwing fn leaves the counters untouched", async () => {
    // MUTATION (c): moving `recordTiingoRequest()` above `await fn()` reddens
    // this. That is the defect class MONEY-1255 found in stock-document-sync,
    // where every per-source counter was incremented BEFORE the call it
    // counted — so a source that 403'd on every request still produced a
    // full-looking number, and Tickertape's block hid behind it for five
    // months.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    const w = tiingoBudgetWindows(BASE_MS);

    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new Error("Exchange fetch failed: 403 Forbidden (https://x)");
        }),
      /403/,
    );
    assert.equal(
      redis.store.get(`tiingo:budget:req:h:${w.hour}`),
      undefined,
      "a failed request must not appear as spend",
    );
    assert.equal((await checkTiingoBudget("eod")).hourUsed, 0);

    // And a success right after DOES count, so the test above is not just
    // observing a counter that never moves.
    await withTiingoBudget("eod", async () => "ok");
    assert.equal(redis.store.get(`tiingo:budget:req:h:${w.hour}`), "1");
  });

  test("checkTiingoBudget is a pure read — it charges nothing", async () => {
    for (let i = 0; i < 5; i++) await checkTiingoBudget("eod");
    assert.deepEqual(redis.incrbyKeys, []);
  });
});

// ---------------------------------------------------------------------------
// The circuit break
// ---------------------------------------------------------------------------

describe("429 circuit break", () => {
  test("a 429 parks the leg for five minutes and says it is a BUG SIGNAL", async () => {
    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new TiingoRateLimitError("AAPL");
        }),
      TiingoRateLimitError,
    );

    const refused = await checkTiingoBudget("eod");
    assert.equal(refused.allowed, false);
    assert.equal(
      refused.allowed === false ? refused.reason : null,
      "circuit-break",
    );

    // The wording is the deliverable here: a 429 is impossible if the pacer
    // and this guard both work, so the log must not read as routine
    // backpressure that an operator scrolls past.
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /THIS SHOULD BE IMPOSSIBLE/);
    assert.match(errors[0] ?? "", /BUG SIGNAL/);
    assert.match(errors[0] ?? "", /TIINGO_PLAN/);

    now = BASE_MS + TIINGO_CIRCUIT_BREAK_MS - 1;
    assert.equal((await checkTiingoBudget("eod")).allowed, false);
    now = BASE_MS + TIINGO_CIRCUIT_BREAK_MS + 1;
    assert.equal((await checkTiingoBudget("eod")).allowed, true);
  });

  test("the break is PER LEG — a 429 on eod does not stop the master fetch", async () => {
    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new TiingoRateLimitError("AAPL");
        }),
      TiingoRateLimitError,
    );
    assert.equal((await checkTiingoBudget("eod")).allowed, false);
    assert.equal((await checkTiingoBudget("master")).allowed, true);
  });

  test("the DAILY CAP must not arm the break — it is a SUBCLASS, not a 429", async () => {
    // `TiingoDailyCapError extends TiingoRateLimitError` (tiingo-pacer.ts), so
    // a bare `instanceof TiingoRateLimitError` catches the pacer's daily cap
    // too — and would park the leg for five minutes while logging "429, this
    // should be impossible" about an event that is neither. Exactly the
    // rename-defeats-the-fix shape `tiingo-news.ts` documents from the other
    // side.
    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new TiingoDailyCapError("Tiingo daily cap 150000 reached");
        }),
      TiingoDailyCapError,
    );
    assert.equal(errors.length, 0, "no 429 alarm for a daily cap");
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.allowed, true, "the leg must NOT be parked");
  });

  test("the break survives Redis going away in the process that saw the 429", async () => {
    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new TiingoRateLimitError("AAPL");
        }),
      TiingoRateLimitError,
    );
    redis.failing = true;
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.allowed === false ? verdict.reason : null,
      "circuit-break",
    );
  });
});

// ---------------------------------------------------------------------------
// The JOIN — the guard is actually wired into the client's one request seam
// ---------------------------------------------------------------------------

describe("wiring into tiingo-client's single request seam", () => {
  const CLIENT_SRC = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "market-data",
      "tiingo",
      "tiingo-client.ts",
    ),
    "utf8",
  );

  test("there is exactly ONE seam, and it is budgeted", () => {
    // A source-text assertion on purpose. The unit tests above prove the guard
    // WORKS; they cannot prove it is REACHED, and "wired" without runtime or
    // structural proof is how a limiter gets written, unit-tested from nine
    // angles and called from nowhere (the MONEY-979 SEC limiter, found by
    // audit on 2026-08-29). This fails the moment a second fetcher is added to
    // the client without going through `getArchived`.
    const paceCalls = CLIENT_SRC.match(/await paceTiingoRequest\(\)/g) ?? [];
    const budgetCalls = CLIENT_SRC.match(/withTiingoBudget\(/g) ?? [];
    assert.equal(paceCalls.length, 1, "one pacer call = one request seam");
    assert.equal(
      budgetCalls.length,
      1,
      "and that seam is wrapped exactly once",
    );
    assert.match(
      CLIENT_SRC,
      /return await withTiingoBudget\(leg, async \(\) => \{\s*await paceTiingoRequest\(\);/,
      "the budget CHECK must be outer and the pacer inner",
    );
  });

  test("both public fetchers pass a leg through the seam", () => {
    assert.match(CLIENT_SRC, /"supported_tickers",\s*"master",/);
    assert.match(CLIENT_SRC, /symbol,\s*"eod",/);
    // And the bandwidth meter is fed, or the ladder is a rung nobody stands on.
    assert.match(CLIENT_SRC, /await recordBytes\(buf\.byteLength\)/);
    assert.match(CLIENT_SRC, /await recordBytes\(bytes\)/);
  });

  test("a budget refusal is RE-THROWN by the retry ladder, never retried", async () => {
    // The join that matters most, and the one the subclassing buys.
    // `decideTiingoFailure` re-throws anything that is a `TiingoRateLimitError`,
    // and `TiingoBudgetExhaustedError` is one — so a refusal escapes the ~35s
    // ladder untouched and reaches `us-eod-sync`'s circuit-breaker. Were it a
    // plain Error it would be classified "other" (status 0) and RETRIED four
    // times, each attempt re-entering the guard and being refused again.
    __setTiingoBudgetLimitsForTests({
      perHour: 0,
      perDay: 0,
      bandwidthBytesPerMonth: 1_000_000,
    });
    let refusal: unknown;
    try {
      await withTiingoBudget("eod", async () => "never runs");
    } catch (err) {
      refusal = err;
    }
    assert.ok(refusal instanceof TiingoBudgetExhaustedError);
    assert.deepEqual(decideTiingoFailure(refusal, 1), { action: "rethrow" });
    assert.deepEqual(decideTiingoFailure(refusal, MAX_RETRIES), {
      action: "rethrow",
    });
  });
});

// ---------------------------------------------------------------------------
// F1 — the 429 circuit break, built the way PRODUCTION builds it
// ---------------------------------------------------------------------------

/**
 * EXACTLY what `exchange-feed.ts:154` throws for a Tiingo 429.
 *
 * Not a `TiingoRateLimitError`. That is the whole point: `fetchExchangeAsset`
 * does `throw new Error(...)` on any non-OK status, and the typed error is only
 * ever constructed later, in a retry ladder's CATCH — one frame OUTSIDE the
 * `withTiingoBudget` callback. Every circuit-break test in this file used to
 * hand-throw the typed error INSIDE the callback, a shape production never
 * produces, so all of them passed against a guard whose 429 arm could not fire.
 */
function productionTiingo429(
  url = "https://api.tiingo.com/tiingo/daily/AAPL/prices",
): Error {
  return new Error(`Exchange fetch failed: 429 Too Many Requests (${url})`);
}

describe("429 circuit break — the PRODUCTION error shape (MONEY-1309)", () => {
  test("a REAL 429 (a plain Error carrying the status) arms the break", async () => {
    // THE REGRESSION TEST FOR THE DEAD ARM.
    //
    // Measured against the pre-fix source through this very wrapper:
    //   threw: Error | Exchange fetch failed: 429 Too Many Requests (...)
    //   after a REAL 429 -> allowed: true | reason: (none)
    //   break key written? []
    //
    // So `breakTiingoLeg` had exactly one caller and it was unreachable, which
    // made TIINGO_CIRCUIT_BREAK_MS, the `break:` key, `isBroken`'s Redis leg and
    // the entire `circuit-break` verdict dead code — while the module header
    // went on justifying fail-degraded over fail-closed on the grounds that "a
    // 429 ... circuit-breaks the run".
    //
    // MUTATION: narrow `withTiingoBudget`'s catch back to
    // `if (err instanceof TiingoRateLimitError) await breakTiingoLeg(leg)`
    // and this test fails on the first assertion (allowed stays true).
    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw productionTiingo429();
        }),
      /429/,
    );

    const refused = await checkTiingoBudget("eod");
    assert.equal(
      refused.allowed,
      false,
      "a real 429 must park the leg — this is the arm that was unreachable",
    );
    assert.equal(
      refused.allowed === false ? refused.reason : null,
      "circuit-break",
    );

    // And the break reached Redis, so SIBLING processes learn about it too. An
    // account-wide 429 that only the process which saw it knows about leaves
    // every other worker walking into the same wall.
    assert.equal(
      redis.store.has(`tiingo:budget:break:eod`),
      true,
      "the break must be published — a 429 is an ACCOUNT-wide fact",
    );

    // The operator wording still has to be the alarm, not routine backpressure.
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /THIS SHOULD BE IMPOSSIBLE/);

    now = BASE_MS + TIINGO_CIRCUIT_BREAK_MS + 1;
    assert.equal(
      (await checkTiingoBudget("eod")).allowed,
      true,
      "and it expires",
    );
  });

  test("the real 429 break is PER LEG, like the typed one", async () => {
    await assert.rejects(
      () =>
        withTiingoBudget("news", async () => {
          throw productionTiingo429();
        }),
      /429/,
    );
    assert.equal((await checkTiingoBudget("news")).allowed, false);
    assert.equal((await checkTiingoBudget("eod")).allowed, true);
  });

  test("a 403 or a transport failure does NOT arm the break", async () => {
    // The anti-vacuous half: a predicate that armed on every failure would pass
    // the test above while parking a leg for five minutes over one flaky DNS
    // lookup. `us-eod-sync` has ONE window a day.
    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new Error("Exchange fetch failed: 403 Forbidden (https://x)");
        }),
      /403/,
    );
    assert.equal((await checkTiingoBudget("eod")).allowed, true);

    await assert.rejects(
      () =>
        withTiingoBudget("eod", async () => {
          throw new Error("fetch failed: ECONNRESET");
        }),
      /ECONNRESET/,
    );
    assert.equal((await checkTiingoBudget("eod")).allowed, true);
    assert.equal(errors.length, 0, "no 429 alarm for either");
  });

  test("the shared status rule is the SAME function the ladder decides on", () => {
    // One rule, one place. `statusFromFeedFailure` in tiingo-client.ts delegates
    // here, so the ladder and the guard cannot disagree about what a 429 is —
    // the MONEY-1255 "one rule stated twice" shape.
    assert.equal(tiingoStatusFromError(productionTiingo429()), 429);
    assert.equal(
      tiingoStatusFromError(
        new Error("Exchange fetch failed: 403 Forbidden (x)"),
      ),
      403,
    );
    assert.equal(tiingoStatusFromError(new Error("ECONNRESET")), 0);
    assert.equal(tiingoStatusFromError("not an error at all"), 0);

    assert.equal(isTiingoRateLimitFailure(productionTiingo429()), true);
    assert.equal(
      isTiingoRateLimitFailure(new TiingoRateLimitError("AAPL")),
      true,
    );
    // Both SUBCLASSES are excluded — neither is a 429 from Tiingo.
    assert.equal(
      isTiingoRateLimitFailure(new TiingoDailyCapError("cap 150000 reached")),
      false,
      "the pacer's cap never touched the network",
    );
    assert.equal(
      isTiingoRateLimitFailure(
        new TiingoBudgetExhaustedError("refused", {
          allowed: false,
          reason: "hour-ceiling",
          detail: "x",
          shared: true,
          stage: null,
          hourUsed: 0,
          dayUsed: 0,
          bytesUsed: 0,
          ceilings: { perHour: 0, perDay: 0, bytesPerMonth: 0 },
        }),
      ),
      false,
      "our own refusal must not park the leg it just refused",
    );
  });
});

// ---------------------------------------------------------------------------
// F2 — the shared <-> degraded BOUNDARY
// ---------------------------------------------------------------------------

describe("crossing from shared to degraded does not hand out a second ceiling", () => {
  test("a process that has spent the SHARED ceiling gets no fresh one when Redis dies", async () => {
    // MEASURED against the pre-fix source:
    //   shared spend 100/100 -> refused.
    //   Redis dies, SAME clock hour -> 33 MORE authorised (100 / 3).
    //   Redis returns -> shared reads 100, actual spend 133.
    // 1.33x the ceiling inside one clock hour, and the module header claimed
    // degradation "degrades toward LESS spending, never more".
    //
    // MUTATION: drop the `seenHourFor(w)` deduction in `effectiveCeilings` and
    // this test fails — 33 requests get through.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR); // shared = 100
    process.env.TIINGO_BUDGET_CONSUMERS = "3";

    for (let i = 0; i < 100; i++) await recordTiingoRequest();
    assert.equal((await checkTiingoBudget("eod")).allowed, false);

    redis.failing = true;
    let extra = 0;
    for (let i = 0; i < 50; i++) {
      try {
        await withTiingoBudget("eod", async () => "ok");
        extra++;
      } catch {
        break;
      }
    }
    assert.equal(
      extra,
      0,
      "the account was already spent — degrading must not re-open it",
    );
  });

  test("the degraded allowance is a share of what REMAINS, not of the whole", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR); // shared = 100
    process.env.TIINGO_BUDGET_CONSUMERS = "3";

    for (let i = 0; i < 40; i++) await recordTiingoRequest();
    const before = await checkTiingoBudget("eod");
    assert.equal(before.shared, true);
    assert.equal(before.hourUsed, 40);

    redis.failing = true;
    const degraded = await checkTiingoBudget("eod");
    assert.equal(degraded.shared, false);
    assert.equal(
      degraded.ceilings.perHour,
      20,
      "(100 - 40) / 3 — one process's share of the REMAINDER",
    );

    let extra = 0;
    for (let i = 0; i < 50; i++) {
      try {
        await withTiingoBudget("eod", async () => "ok");
        extra++;
      } catch {
        break;
      }
    }
    assert.equal(extra, 20);
    // Three such processes spend 60, which is exactly what was left. The old
    // behaviour authorised 33 EACH on top of a spend of 40 — 139 against 100.
    assert.ok(
      40 + extra * 3 <= 100,
      "three degraded siblings stay inside the ceiling",
    );
  });

  test("spend charged while degraded is BACK-FILLED when Redis returns", async () => {
    // Without this the shared counter permanently under-reports by whatever was
    // spent during the outage, and every sibling reads that gap as headroom.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    process.env.TIINGO_BUDGET_CONSUMERS = "3";
    const w = tiingoBudgetWindows(BASE_MS);

    for (let i = 0; i < 10; i++) await recordTiingoRequest();
    assert.equal(redis.store.get(`tiingo:budget:req:h:${w.hour}`), "10");

    redis.failing = true;
    for (let i = 0; i < 5; i++) await withTiingoBudget("eod", async () => "ok");
    assert.equal(
      redis.store.get(`tiingo:budget:req:h:${w.hour}`),
      "10",
      "the shared counter cannot move while the node is down",
    );

    redis.failing = false;
    await withTiingoBudget("eod", async () => "ok");
    assert.equal(
      redis.store.get(`tiingo:budget:req:h:${w.hour}`),
      "16",
      "10 shared + 5 degraded back-filled + 1 new",
    );
    assert.equal(redis.store.get(`tiingo:budget:req:d:${w.day}`), "16");
  });

  test("a backlog is DISCARDED at a window boundary, never charged to the new hour", async () => {
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    redis.failing = true;
    for (let i = 0; i < 5; i++) await withTiingoBudget("eod", async () => "ok");

    now = BASE_MS + 3_600_000; // new hour: the old key has its own name and TTL
    redis.failing = false;
    await withTiingoBudget("eod", async () => "ok");
    const w2 = tiingoBudgetWindows(now);
    assert.equal(
      redis.store.get(`tiingo:budget:req:h:${w2.hour}`),
      "1",
      "back-filling last hour's spend into this hour would be a lie in the other direction",
    );
  });
});

// ---------------------------------------------------------------------------
// F3 — TIINGO_BUDGET_CONSUMERS has an UPPER bound
// ---------------------------------------------------------------------------

describe("TIINGO_BUDGET_CONSUMERS is bounded at BOTH ends", () => {
  test("an absurdly large value is clamped instead of zeroing every ceiling", () => {
    // The guard already rejected 0 and negatives because they divide by zero or
    // invert the sign. It had no ceiling at the other end, and a large enough N
    // turns FAIL-DEGRADED into FAIL-CLOSED: measured with N=200000, the degraded
    // ceilings came back {perHour: 0, perDay: 0} and EVERY request on EVERY leg
    // was refused for as long as Redis was down.
    process.env.TIINGO_BUDGET_CONSUMERS = "200000";
    assert.equal(tiingoBudgetConsumers(), TIINGO_MAX_BUDGET_CONSUMERS);
    process.env.TIINGO_BUDGET_CONSUMERS = String(
      TIINGO_MAX_BUDGET_CONSUMERS + 1,
    );
    assert.equal(tiingoBudgetConsumers(), TIINGO_MAX_BUDGET_CONSUMERS);
    // Under the bound it is still honoured verbatim.
    process.env.TIINGO_BUDGET_CONSUMERS = String(TIINGO_MAX_BUDGET_CONSUMERS);
    assert.equal(tiingoBudgetConsumers(), TIINGO_MAX_BUDGET_CONSUMERS);
    process.env.TIINGO_BUDGET_CONSUMERS = "8";
    assert.equal(tiingoBudgetConsumers(), 8);
  });

  test("a huge N still leaves the run RUNNING — degraded, never closed", async () => {
    // MUTATION: remove the clamp (or the `Math.max(1, ...)` floor) and this
    // fails — every leg is refused with a 0 ceiling.
    __setTiingoBudgetRedisForTests(() => null);
    process.env.TIINGO_BUDGET_CONSUMERS = "200000";
    const verdict = await checkTiingoBudget("eod");
    assert.equal(
      verdict.allowed,
      true,
      "fail-DEGRADED is this module's central argument; a zero ceiling is fail-CLOSED",
    );
    assert.ok(verdict.ceilings.perHour > 0);
    assert.ok(verdict.ceilings.perDay > 0);
    assert.ok(verdict.ceilings.bytesPerMonth > 0);
  });

  test("a POSITIVE ceiling never divides down to zero, whatever N is", async () => {
    // The SECOND, independent guard — the `Math.max(1, ...)` floor in
    // `effectiveCeilings`. The clamp above is a JUDGEMENT about how large a
    // fleet can plausibly get; this is a STRUCTURAL invariant that holds even
    // if that judgement is wrong.
    //
    // It needs a plan ceiling SMALLER than the clamp to be observable at all:
    // at 64 consumers, COMMERCIAL's 16,000/hr still divides to 250. So the
    // limits are forced to a ceiling of 48, where 48/64 floors to 0 and the
    // guard is the only thing between the run and a fail-CLOSED refusal.
    //
    // MUTATION: drop the `Math.max(1, ...)` and this fails — every leg refused.
    __setTiingoBudgetRedisForTests(() => null);
    __setTiingoBudgetLimitsForTests({
      perHour: 60, // x 0.8 = 48, and 48 / 64 floors to 0
      perDay: 60,
      bandwidthBytesPerMonth: 60,
    });
    process.env.TIINGO_BUDGET_CONSUMERS = String(TIINGO_MAX_BUDGET_CONSUMERS);
    assert.equal(
      tiingoBudgetCeilings().perHour,
      48,
      "premise: the ceiling is 48",
    );

    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.shared, false);
    assert.equal(
      verdict.ceilings.perHour,
      1,
      "48 / 64 floors to 0 — floored to 1",
    );
    assert.equal(verdict.ceilings.perDay, 1);
    assert.equal(verdict.ceilings.bytesPerMonth, 1);
    assert.equal(
      verdict.allowed,
      true,
      "a positive plan ceiling must never become a zero enforced one",
    );

    // A ceiling that is GENUINELY zero still passes through as zero — the floor
    // must not invent budget where the plan has none. (The refusal path in
    // "a budget refusal is RE-THROWN by the retry ladder" depends on this.)
    __setTiingoBudgetLimitsForTests({
      perHour: 0,
      perDay: 0,
      bandwidthBytesPerMonth: 0,
    });
    const none = await checkTiingoBudget("eod");
    assert.equal(none.ceilings.perHour, 0);
    assert.equal(none.allowed, false);
  });
});

// ---------------------------------------------------------------------------
// F4 — the ladder READER must agree with the ladder CHECKER
// ---------------------------------------------------------------------------

describe("readTiingoBytesStage agrees with checkTiingoBudget about the same month", () => {
  test("it falls back to the COUNTER when the stage cache was never written", async () => {
    // MEASURED against the pre-fix source: with the shared counter at 950/1000,
    // `readTiingoBytesStage()` answered null while `checkTiingoBudget()` on the
    // same Redis, in the same millisecond, answered "alarm". It read ONLY the
    // stage cache — which only `recordBytes` ever writes — so it failed exactly
    // the reader its own doc comment names ("an ops query, a job on a different
    // leg"), fail-open, on the one limit that waiting an hour cannot undo.
    //
    // MUTATION: delete the bytesKey fallback and this test fails (null vs alarm).
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR); // 1,000-byte cap
    const w = tiingoBudgetWindows(BASE_MS);
    redis.store.set(`tiingo:budget:bytes:m:${w.month}`, "950");
    assert.equal(
      redis.store.has(`tiingo:budget:stage:m:${w.month}`),
      false,
      "premise: the stage CACHE is absent — this is the case that failed",
    );

    const fromChecker = (await checkTiingoBudget("eod")).stage;
    const fromReader = await readTiingoBytesStage();
    assert.equal(fromChecker, "alarm");
    assert.equal(
      fromReader,
      fromChecker,
      "two readers of one Redis must not disagree about one month",
    );
  });

  test("the LOCAL month rolls, so August's rung does not survive into September", async () => {
    // `readCounters` and `localAddBytes` both rolled the local month; this
    // reader did not. So a degraded process that reached "alarm" in August went
    // on reporting it in September until some other call path happened to roll
    // the window — shedding against a budget that had already reset.
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    __setTiingoBudgetRedisForTests(() => null);
    process.env.TIINGO_BUDGET_CONSUMERS = "1";

    await recordBytes(950);
    assert.equal(await readTiingoBytesStage(), "alarm");

    now = Date.UTC(2026, 8, 1, 12, 0, 0); // September, a new month key
    assert.equal(
      await readTiingoBytesStage(),
      null,
      "a new month starts below the ladder",
    );
  });

  test("the ladder does NOT fail open when Redis blinks", async () => {
    // MEASURED against the pre-fix source: shared stage "alarm", Redis dies,
    // the very next `recordBytes(10)` returned null and shedding stopped — on
    // the ONE limit that cannot be undone by waiting an hour, at exactly the
    // moment the byte budget was being blown, with nothing in the return value
    // to reveal it.
    //
    // MUTATION: drop `noteStage` from `recordBytes`/`readTiingoBytesStage` and
    // this fails (null instead of alarm).
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);
    await recordBytes(950);
    assert.equal(await readTiingoBytesStage(), "alarm");

    redis.failing = true;
    assert.equal(
      await recordBytes(10),
      "alarm",
      "a Redis blip must not un-shed a month that is already over the top rung",
    );
    assert.equal(await readTiingoBytesStage(), "alarm");
  });

  test("the DEGRADED bytes ceiling is divided like the request ceilings", async () => {
    // Asserted nowhere before, so dropping the bytes division from
    // `effectiveCeilings` survived the whole suite — a degraded process would
    // grade its local ledger against the FULL monthly cap and sit below rung 1
    // on a month that was already over it.
    __setTiingoBudgetRedisForTests(() => null);
    __setTiingoBudgetLimitsForTests({
      perHour: 125,
      perDay: 1_000_000,
      bandwidthBytesPerMonth: 1_000,
    });
    process.env.TIINGO_BUDGET_CONSUMERS = "4";
    const verdict = await checkTiingoBudget("eod");
    assert.equal(verdict.shared, false);
    assert.equal(verdict.ceilings.bytesPerMonth, 250, "1000 / 4");
  });
});

// ---------------------------------------------------------------------------
// F5 — the UTC window invariant, independent of the RUNNER's timezone
// ---------------------------------------------------------------------------

/**
 * The expected window labels, derived WITHOUT the source's own helper.
 *
 * `toISOString()` is specified to render UTC whatever `TZ` says, so this is a
 * genuinely independent oracle rather than the same arithmetic written twice.
 */
function windowsFromIso(ms: number): {
  hour: string;
  day: string;
  month: string;
} {
  const iso = new Date(ms).toISOString(); // e.g. 2026-08-31T20:30:00.000Z
  const y = iso.slice(0, 4);
  const m = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  const h = iso.slice(11, 13);
  return { hour: `${y}${m}${d}${h}`, day: `${y}${m}${d}`, month: `${y}${m}` };
}

describe("budget windows are UTC regardless of the process timezone", () => {
  test("every window label is UTC under zones ahead of, behind and off-grid from it", () => {
    // WHY THIS IS FORCED RATHER THAN OBSERVED.
    //
    // Mutating every `getUTC*` in `tiingoBudgetWindows` to its local
    // counterpart was measured as: 1 extra failure under the developer default
    // (Asia/Calcutta), and ZERO under `TZ=UTC`. GitHub runners are UTC and no
    // `TZ` is pinned in any workflow, so CI STRUCTURALLY COULD NOT SEE the
    // regression — under UTC, local time IS UTC and no instant can distinguish
    // the two implementations. Pinning TZ in CI does not fix that; it only
    // moves which machine is blind.
    //
    // So the zone is forced HERE, per assertion, and the expectation comes from
    // `toISOString()` rather than from another copy of the same `getUTC*` calls.
    // The key is shared across a Cloud Run container, a founder's laptop and a
    // QA job; a label that depended on `TZ` would silently split one counter in
    // two, which is the exact failure this module exists to prevent.
    const saved = process.env.TZ;
    try {
      // Instants chosen so the LOCAL calendar day differs from the UTC one in
      // each zone — 20:30Z is the next day in IST and the same day in LA;
      // 02:30Z is the previous day in LA and the same day in IST.
      const instants = [
        Date.UTC(2026, 7, 31, 20, 30, 0),
        Date.UTC(2026, 7, 31, 2, 30, 0),
        Date.UTC(2026, 11, 31, 23, 59, 0), // year boundary
        Date.UTC(2026, 0, 1, 0, 30, 0),
      ];
      for (const tz of [
        "UTC",
        "Asia/Kolkata", // +05:30 — the developer default, and half-hour offset
        "America/Los_Angeles", // -07:00/-08:00, across a DST change
        "Pacific/Kiritimati", // +14:00, the furthest zone there is
      ]) {
        process.env.TZ = tz;
        for (const ms of instants) {
          const expected = windowsFromIso(ms);
          const actual = tiingoBudgetWindows(ms);
          assert.deepEqual(
            { hour: actual.hour, day: actual.day, month: actual.month },
            expected,
            `TZ=${tz} at ${new Date(ms).toISOString()}: the window label must be UTC`,
          );
        }
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test("the forcing actually works, or the test above proves nothing", () => {
    // The anti-vacuous half. If `process.env.TZ` were ignored at runtime, every
    // zone above would silently be the runner's own and the loop would assert
    // one case four times. This pins that Node really does re-resolve it.
    const saved = process.env.TZ;
    try {
      const ms = Date.UTC(2026, 7, 31, 20, 30, 0);
      process.env.TZ = "UTC";
      const utcHour = new Date(ms).getHours();
      process.env.TZ = "Asia/Kolkata";
      const istHour = new Date(ms).getHours();
      const istDate = new Date(ms).getDate();
      assert.notEqual(
        utcHour,
        istHour,
        "process.env.TZ is not being honoured at runtime — the TZ sweep above is vacuous",
      );
      assert.equal(utcHour, 20);
      assert.equal(istHour, 2, "20:30Z is 02:00 IST the NEXT day");
      assert.equal(
        istDate,
        1,
        "and the local DATE differs too, not just the hour",
      );
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// F6 — the hour and day counters degrade INDEPENDENTLY
// ---------------------------------------------------------------------------

describe("a partial Redis failure charges each counter exactly once", () => {
  test("hour succeeds, day throws: the hour is not double-charged and the day is not lost", async () => {
    // MEASURED against the pre-fix source: both INCRs sat in one try with a
    // single `return` after them, so a day failure fell through to the degraded
    // block and charged BOTH local counters. The request was charged to the
    // hour TWICE (shared + local) and to the shared DAY zero times — and the day
    // counter is the one gating 24 hours, i.e. the one with the least chance to
    // self-correct.
    //
    // MUTATION: put the two INCRs back in one try/catch and this fails.
    __setTiingoBudgetLimitsForTests({
      perHour: 125,
      perDay: 125,
      bandwidthBytesPerMonth: 1_000_000,
    });
    let dayWrites = 0;
    const partial: TiingoBudgetRedis = {
      async incrby(key, amount) {
        if (key.includes(":req:d:")) {
          dayWrites++;
          throw new Error("day counter unreachable");
        }
        const next = (Number(redis.store.get(key) ?? 0) || 0) + amount;
        redis.store.set(key, String(next));
        return next;
      },
      async expire() {
        return 1;
      },
      async get(key) {
        return redis.store.get(key) ?? null;
      },
      async setEx(key, value) {
        redis.store.set(key, value);
      },
    };
    __setTiingoBudgetRedisForTests(() => partial);

    const w = tiingoBudgetWindows(BASE_MS);
    await recordTiingoRequest();
    assert.equal(
      dayWrites,
      1,
      "premise: the day INCR really was attempted and failed",
    );
    assert.equal(
      redis.store.get(`tiingo:budget:req:h:${w.hour}`),
      "1",
      "the hour reached Redis and must be charged there ONCE",
    );

    // The day is the one that degraded, so only IT falls back to the local
    // ledger — and when the day counter recovers, that one request is
    // back-filled rather than lost.
    const partialFixed: TiingoBudgetRedis = {
      ...partial,
      async incrby(key, amount) {
        const next = (Number(redis.store.get(key) ?? 0) || 0) + amount;
        redis.store.set(key, String(next));
        return next;
      },
    };
    __setTiingoBudgetRedisForTests(() => partialFixed);
    await recordTiingoRequest();
    assert.equal(
      redis.store.get(`tiingo:budget:req:h:${w.hour}`),
      "2",
      "the hour was never double-charged, so it reads 2 after two requests",
    );
    assert.equal(
      redis.store.get(`tiingo:budget:req:d:${w.day}`),
      "2",
      "and the day recovers the request it missed instead of under-counting forever",
    );
  });
});

// ---------------------------------------------------------------------------
// F9b — the ceiling ROUNDS DOWN
// ---------------------------------------------------------------------------

describe("ceilings round DOWN, into the headroom and never out of it", () => {
  test("a non-exact product floors rather than ceils", () => {
    // `Math.floor` -> `Math.ceil` survived the whole suite, because every
    // product in the real plan table is an exact integer (20,000 x 0.8 = 16,000)
    // and the only test computing an expectation did it the same way the source
    // does. The 80% fraction is HEADROOM against three known undercounts, so
    // rounding up spends the very margin that exists to absorb them.
    __setTiingoBudgetLimitsForTests({
      perHour: 101, // x 0.8 = 80.8 -> floor 80, ceil 81
      perDay: 1_001, // x 0.8 = 800.8 -> floor 800, ceil 801
      bandwidthBytesPerMonth: 1_000,
    });
    const c = tiingoBudgetCeilings();
    assert.equal(c.perHour, 80, "80.8 must floor to 80, not ceil to 81");
    assert.equal(c.perDay, 800, "800.8 must floor to 800, not ceil to 801");
  });
});

// ---------------------------------------------------------------------------
// F8 — the "realtime" leg and the STREAMING byte meter
// ---------------------------------------------------------------------------

describe('the "realtime" leg feeds the same account-wide meter', () => {
  test("it is a real leg with its own circuit break", async () => {
    // The websocket holds a live api.tiingo.com connection and was entirely
    // outside this guard, so the account-wide MONTHLY BYTE METER never saw
    // streaming volume at all — the same under-reporting the wiring guard's
    // header calls worse than having no guard.
    await assert.rejects(
      () =>
        withTiingoBudget("realtime", async () => {
          throw productionTiingo429();
        }),
      /429/,
    );
    assert.equal((await checkTiingoBudget("realtime")).allowed, false);
    assert.equal((await checkTiingoBudget("eod")).allowed, true);
  });

  test("streamed bytes BUFFER in memory and touch Redis only at the threshold", async () => {
    // A per-frame INCRBY would put Redis in the hot path of every tick on a
    // feed carrying up to TIINGO_RT_MAX_SYMBOLS (3000) symbols. The meter must
    // not become the bottleneck it exists to measure.
    __setTiingoBudgetLimitsForTests({
      perHour: 125,
      perDay: 1_000_000,
      bandwidthBytesPerMonth: 10 * TIINGO_STREAM_FLUSH_BYTES,
    });
    const w = tiingoBudgetWindows(BASE_MS);

    for (let i = 0; i < 500; i++) await recordStreamBytes(100); // 50,000 bytes
    assert.equal(
      redis.incrbyKeys.length,
      0,
      "no Redis round trip below the flush threshold",
    );
    assert.equal(redis.store.has(`tiingo:budget:bytes:m:${w.month}`), false);

    await recordStreamBytes(TIINGO_STREAM_FLUSH_BYTES);
    assert.deepEqual(redis.incrbyKeys, [`tiingo:budget:bytes:m:${w.month}`]);
    assert.equal(
      redis.store.get(`tiingo:budget:bytes:m:${w.month}`),
      String(50_000 + TIINGO_STREAM_FLUSH_BYTES),
      "the flush carries the whole buffer, not just the frame that tripped it",
    );
  });

  test("the tail is flushed explicitly, and flushing twice does not double-charge", async () => {
    __setTiingoBudgetLimitsForTests({
      perHour: 125,
      perDay: 1_000_000,
      bandwidthBytesPerMonth: 10 * TIINGO_STREAM_FLUSH_BYTES,
    });
    const w = tiingoBudgetWindows(BASE_MS);
    await recordStreamBytes(4_096);
    assert.equal(redis.incrbyKeys.length, 0);

    await flushStreamBytes();
    assert.equal(redis.store.get(`tiingo:budget:bytes:m:${w.month}`), "4096");

    await flushStreamBytes();
    assert.equal(
      redis.store.get(`tiingo:budget:bytes:m:${w.month}`),
      "4096",
      "an empty flush must be a no-op, not a replay",
    );
  });

  test("a non-finite frame size is dropped rather than poisoning the buffer", async () => {
    // One NaN added to the accumulator would poison EVERY subsequent flush,
    // not just the frame that carried it.
    __setTiingoBudgetLimitsForTests({
      perHour: 125,
      perDay: 1_000_000,
      bandwidthBytesPerMonth: 10 * TIINGO_STREAM_FLUSH_BYTES,
    });
    const w = tiingoBudgetWindows(BASE_MS);
    await recordStreamBytes(1_000);
    await recordStreamBytes(Number.NaN);
    await recordStreamBytes(-5);
    await recordStreamBytes(Number.POSITIVE_INFINITY);
    await flushStreamBytes();
    assert.equal(redis.store.get(`tiingo:budget:bytes:m:${w.month}`), "1000");
  });
});

// ---------------------------------------------------------------------------
// F9a — the degradation warning is per OUTAGE, not merely per hour
// ---------------------------------------------------------------------------

describe("a flapping Redis node is reported once per OUTAGE", () => {
  test("recovery clears the latch, so the second outage warns again", async () => {
    // The latch exists so a per-CALL warning inside a 73k-request backfill does
    // not drown the alert it is supposed to be. It was never meant to suppress
    // distinct OUTAGES — but it was never cleared on recovery, so a node that
    // came and went twenty times in an hour produced exactly ONE warning and
    // the log said "one blip" about twenty.
    //
    // MUTATION: make `noteRecovered()` a no-op and this test fails at the
    // second assertion (still 1 warning).
    __setTiingoBudgetLimitsForTests(FAKE_LIMITS_100_PER_HOUR);

    redis.failing = true;
    await checkTiingoBudget("eod");
    await checkTiingoBudget("eod");
    assert.equal(warnings.length, 1, "one warning for the first outage");

    redis.failing = false;
    await checkTiingoBudget("eod"); // recovery clears the latch
    assert.equal(warnings.length, 1, "recovery itself is not a warning");

    redis.failing = true;
    await checkTiingoBudget("eod");
    assert.equal(
      warnings.length,
      2,
      "a SECOND outage in the same hour must be reported, not swallowed",
    );

    // ...and it is still latched WITHIN that outage.
    for (let i = 0; i < 10; i++) await checkTiingoBudget("eod");
    assert.equal(
      warnings.length,
      2,
      "still once per outage, not once per call",
    );
  });
});
