/**
 * The 600s ack deadline, and the two things this job did nothing about.
 * MONEY-1401 F12.
 *
 * ## The defect
 *
 * `mf-portfolio-sync` arrives over a Pub/Sub push subscription with
 * `--ack-deadline=600` (Pub/Sub's maximum; Cloud Run's 3600s request timeout
 * never binds) and had NO run-time budget, NO self-chain and NO in-flight
 * claim. Its write path is a per-holding `instrumentMapping.findFirst` plus an
 * `mfPortfolioHolding.upsert`, both awaited, with no cache.
 *
 * MONEY-1404/1405 activated ABSL, ICICI, Kotak, Tata and 360 ONE, taking prod
 * from ~30,501 rows toward ~50-55k — roughly 100,000 sequential round trips,
 * with zero budget left for the 25 MB ICICI download, Mirae's 97 fetches, the
 * 7 MB NAVAll or HDFC's 200 paced downloads.
 *
 * Overrunning is NOT "slow". Pub/Sub redelivers, `pubsubDedupeMiddleware`
 * correctly answers the redelivery 409 RETRY_LATER, Pub/Sub counts that as a
 * delivery attempt, and after five the message is dead-lettered and the founder
 * notified — while the original execution is still running and will succeed.
 * MONEY-1389 measured that at 368 false dead-letters a day on one subscription.
 *
 * ## What is asserted
 *
 * BEHAVIOUR of the two pure decisions, driven by their real implementations:
 * the budget's progress guarantee, and the memo's hit/miss semantics. Both
 * are mutation-checked — a memo that never stores, or a budget without its
 * `housesDone > 0` clause, has to fail a case here.
 *
 * Plus the one property a behaviour test cannot reach: that the memo is
 * PER-RUN. Module-scope run state survives on a warm Cloud Run container and
 * is the exact bug MONEY-1238 fixed in this same file, and "is this Map
 * declared inside the function" is a structural question with a structural
 * answer.
 *
 * LINE comments are stripped before BLOCK comments (MONEY-1143): the
 * processor's own comments quote the code some of these scans forbid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  shouldDeferRemainingHouses,
  resolveInstrumentIdMemoised,
} from "../../src/processors/mf-portfolio-sync";

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const PROCESSOR_PATH = join(
  repoRoot(),
  "workers",
  "src",
  "processors",
  "mf-portfolio-sync.ts",
);
const RAW = readFileSync(PROCESSOR_PATH, "utf8");
const SRC = blankComments(RAW);

/** The budget the processor actually declares, read rather than restated. */
const BUDGET_MS = Number(
  /const RUN_TIME_BUDGET_MS = ([\d_]+);/.exec(SRC)?.[1]?.replace(/_/g, ""),
);

describe("mf-portfolio-sync: the run-time budget (MONEY-1401 F12)", () => {
  it("the declared budget leaves headroom for one worst house", () => {
    // Not a style check. The budget is checked BETWEEN houses, so the true
    // wall is `budget + one house`, and the largest house is HDFC: 200
    // sequential downloads paced at HDFC_DELAY_MS, which is 80s of SLEEPING
    // before a single round trip. A budget sized as if the overshoot were one
    // document (420s, as stock-document-extract uses) would leave 180s for a
    // unit that can spend half of that asleep.
    assert.ok(
      Number.isFinite(BUDGET_MS),
      "RUN_TIME_BUDGET_MS must be a literal in the processor — a computed " +
        "one cannot be checked against the ack deadline from here",
    );
    const delayMs = Number(/const HDFC_DELAY_MS = (\d+);/.exec(SRC)?.[1]);
    const maxSchemes = Number(/const HDFC_MAX_SCHEMES = (\d+);/.exec(SRC)?.[1]);
    const hdfcSleepMs = delayMs * maxSchemes;
    assert.equal(hdfcSleepMs, 80_000, "HDFC's paced sleep, re-derived");
    assert.ok(
      BUDGET_MS + hdfcSleepMs < 600_000,
      `RUN_TIME_BUDGET_MS (${BUDGET_MS}ms) plus HDFC's ${hdfcSleepMs}ms of ` +
        "pacing alone must fit inside the 600s ack deadline",
    );
    // And the headroom must cover more than the sleeping: HDFC also makes 200
    // downloads inside that window, Mirae 97, ICICI one of ~25 MB.
    assert.ok(
      600_000 - BUDGET_MS >= 2 * hdfcSleepMs,
      "headroom must be at least twice HDFC's pure sleep, to cover the " +
        "downloads interleaved with it",
    );
  });

  it("a hop that has done NOTHING never defers — the progress guarantee", () => {
    // This is the termination proof. The follow-up carries `only: deferred`,
    // so the chain ends because the list strictly shrinks; a hop that deferred
    // everything would publish the message it just received, forever.
    assert.equal(
      shouldDeferRemainingHouses({
        startedAt: 0,
        now: BUDGET_MS * 10,
        housesDone: 0,
      }),
      false,
      "wildly over budget with nothing done must still attempt one house",
    );
  });

  it("over budget WITH progress defers", () => {
    assert.equal(
      shouldDeferRemainingHouses({
        startedAt: 0,
        now: BUDGET_MS,
        housesDone: 1,
      }),
      true,
      "the boundary is inclusive — exactly at the budget is spent",
    );
    assert.equal(
      shouldDeferRemainingHouses({
        startedAt: 1_000,
        now: 1_000 + BUDGET_MS + 1,
        housesDone: 6,
      }),
      true,
    );
  });

  it("under budget does not defer, however many houses are done", () => {
    assert.equal(
      shouldDeferRemainingHouses({
        startedAt: 0,
        now: BUDGET_MS - 1,
        housesDone: 17,
      }),
      false,
    );
  });

  it("`attempted` is pushed to per house, never pre-filled", () => {
    // `selected` in the job outcome is `attempted.length`. Pre-filling it from
    // `fetchable` would claim every templatable house was attempted before the
    // loop ran, so a truncated hop would report a full selection and the
    // deferral would be invisible in the one number the monitor reads.
    assert.doesNotMatch(
      SRC,
      /attempted:\s*fetchable\.map/,
      "attempted must not be seeded from the fetchable list",
    );
    assert.match(SRC, /attempted:\s*\[\],/);
    assert.match(SRC, /out\.attempted\.push\(src\.id\)/);
  });

  it("all three house loops consult the budget", () => {
    // Three write sites is how the fourth gets written without a check
    // (MONEY-1404 C3, in this same file). A budget applied to two of three
    // loops would let the untouched one run past the deadline unchanged.
    assert.match(
      SRC,
      /const deferIfOverBudget = \(amc: AmcId\): boolean =>/,
      "one shared decision, not three hand-copied clock reads",
    );
    const calls = SRC.match(/deferIfOverBudget\(/g) ?? [];
    assert.equal(
      calls.length,
      3,
      "expected exactly one call in each of the template, page-scrape and " +
        `HDFC legs (the declaration is an arrow, so it does not match); ` +
        `found ${calls.length}`,
    );
    // NAMED per leg, so dropping one is a failure that says which.
    assert.match(SRC, /deferIfOverBudget\(src\.id\)/);
    assert.match(SRC, /deferIfOverBudget\(cfg\.id\)/);
    assert.match(SRC, /deferIfOverBudget\("HDFC"\)/);
  });

  it("the follow-up carries the REMAINDER and the RESOLVED month", () => {
    // `only` is the continuation cursor, so it must be the deferred list and
    // not the original scope. And the month must be the label this run
    // resolved: a follow-up that re-defaulted to "last month" would cross a
    // month boundary on a run started near midnight on the 1st and write the
    // remainder into the wrong period.
    assert.match(SRC, /json:\s*\{\s*month:\s*monthLabel,\s*only:\s*out\.deferred/);
    assert.match(SRC, /PUBSUB_TOPICS\.MF_PORTFOLIO_SYNC/);
    // Chaining on an UNHEALTHY hop fans one truncated run out into up to five
    // overlapping chains, because a 500 redelivers the original message and
    // that redelivery reaches this point itself.
    assert.match(SRC, /if \(out\.deferred\.length === 0 \|\| !out\.ok\) return;/);
  });

  it("a deferral is NAMED in the job outcome, never silent", () => {
    assert.match(SRC, /out\.deferred\.length > 0\)\s*\{\s*reasons\.push\(/);
  });
});

describe("mf-portfolio-sync: the per-run ISIN memo (MONEY-1401 F12)", () => {
  /** A lookup that counts how many times the database would have been asked. */
  function countingLookup(table: Record<string, string | null>) {
    let calls = 0;
    return {
      calls: () => calls,
      lookup: async (isin: string): Promise<string | null> => {
        calls++;
        return table[isin] ?? null;
      },
    };
  }

  it("a repeated ISIN costs ONE lookup", async () => {
    const memo = new Map<string, string | null>();
    const { calls, lookup } = countingLookup({ INE002A01018: "id-reliance" });
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(
        await resolveInstrumentIdMemoised(memo, "INE002A01018", lookup),
      );
    }
    assert.equal(calls(), 1, "50 holdings of one security, one query");
    assert.deepEqual(new Set(results), new Set(["id-reliance"]));
  });

  it("a resolved MISS is cached too, and is not re-queried", async () => {
    // The single most important case. Cash, TREPS and most debt lines carry no
    // ISIN we map, so a memo that only cached HITS would re-query exactly the
    // rows it cannot answer — a cache that helps least where it is needed
    // most. `memo.has()` is what separates "cached, and the answer is no
    // instrument" from "never asked"; reading the VALUE cannot.
    const memo = new Map<string, string | null>();
    const { calls, lookup } = countingLookup({});
    assert.equal(await resolveInstrumentIdMemoised(memo, "INE_NOPE", lookup), null);
    assert.equal(await resolveInstrumentIdMemoised(memo, "INE_NOPE", lookup), null);
    assert.equal(await resolveInstrumentIdMemoised(memo, "INE_NOPE", lookup), null);
    assert.equal(calls(), 1, "an unmapped ISIN must be asked about ONCE");
    assert.equal(memo.get("INE_NOPE"), null);
    assert.ok(memo.has("INE_NOPE"));
  });

  it("distinct ISINs each cost one lookup — the memo does not over-collapse", async () => {
    const memo = new Map<string, string | null>();
    const { calls, lookup } = countingLookup({ A: "ia", B: "ib", C: null });
    assert.equal(await resolveInstrumentIdMemoised(memo, "A", lookup), "ia");
    assert.equal(await resolveInstrumentIdMemoised(memo, "B", lookup), "ib");
    assert.equal(await resolveInstrumentIdMemoised(memo, "C", lookup), null);
    assert.equal(calls(), 3);
  });

  it("the MEASURED workbook shape: 17,463 holdings, 3,680 lookups", async () => {
    // Derived from the four committed fixtures (ABSL 5,600 / Nippon 6,022 /
    // SBI 5,767 / HDFC 74 holdings carrying an ISIN; 3,680 distinct across the
    // run). Reproduced here as a distribution rather than by re-parsing 6 MB of
    // workbooks in a unit test: what is being asserted is the MEMO's behaviour
    // on that shape, not the parser's.
    const memo = new Map<string, string | null>();
    const { calls, lookup } = countingLookup({});
    const distinct = 3_680;
    const holdings = 17_463;
    for (let i = 0; i < holdings; i++) {
      await resolveInstrumentIdMemoised(memo, `ISIN${i % distinct}`, lookup);
    }
    assert.equal(calls(), distinct);
    assert.equal(
      holdings - calls(),
      13_783,
      "round trips removed from one run of the committed workbooks",
    );
  });

  it("the memo is PER RUN — no module-scope Map", () => {
    // Cloud Run keeps containers warm, so a module-scope cache outlives the
    // run that filled it and would serve a stale instrument id after an
    // instrument-sync rename. MONEY-1238 fixed exactly this shape in this file.
    //
    // `[^=\n]*` between the name and the `=`, NOT `(?::[^=]+)?=`. The tight
    // form required the `=` to abut the identifier or a type annotation, so
    // the ordinary spelling — `const isinCache = new Map<…>()` — sailed past
    // it and this case passed against a reintroduced module-scope cache.
    // Caught by mutation, which is the only thing that catches a scan that
    // matches nothing.
    const moduleScope = SRC.split("\n").filter((line) =>
      /^(?:const|let|var)\s+\w+[^=\n]*=\s*new Map\b/.test(line),
    );
    assert.deepEqual(
      moduleScope,
      [],
      "a top-level `new Map()` in this processor is per-CONTAINER state, not " +
        `per-run: ${moduleScope.join(" | ")}`,
    );
    // And it must be reachable only through the run's own context object.
    assert.match(SRC, /instrumentIdByIsin:\s*new Map\(\),/);
    assert.match(SRC, /ctx\.instrumentIdByIsin,/);
  });

  it("the per-holding findFirst is no longer unconditional", () => {
    // The defect shape, forbidden by name. A future edit that reinstates a
    // bare per-holding lookup puts ~49,000 round trips back.
    assert.doesNotMatch(
      SRC,
      /instrumentId = found\?\.id \?\? null;/,
      "the unmemoised per-holding lookup must not come back",
    );
    assert.match(SRC, /resolveInstrumentIdMemoised\(/);
  });
});
