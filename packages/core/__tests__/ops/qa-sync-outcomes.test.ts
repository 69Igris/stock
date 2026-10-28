/**
 * The prod -> QA sync's ordering and freshness rules — MONEY-1487 / MONEY-1488.
 *
 * These are the executable form of two rules the Cloud Run job implements in
 * mongosh (its image has no Node, by design — MONEY-1238). `sync-prod-to-qa-order
 * .spawntest.ts` drives the REAL bash script against canned facts and asserts it
 * agrees with `planSyncOrder`; this file pins what the rules themselves say.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planSyncOrder,
  classifySyncFreshness,
  mayUseAsDeltaBound,
  PARTIALLY_APPLIED_STATES,
  DEFAULT_STALE_AFTER_DAYS,
  type QaSyncRecord,
} from "../../src/ops/qa-sync-outcomes";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 6, 0, 0);

function rec(
  collection: string,
  ageDays: number,
  lastState: QaSyncRecord["lastState"] = "RESTORED",
): QaSyncRecord {
  const at = NOW - ageDays * DAY;
  return {
    collection,
    lastState,
    lastAttemptAtMs: at,
    lastSuccessAtMs: lastState === "RESTORED" ? at : null,
  };
}

describe("planSyncOrder — least-recently-visited first (MONEY-1487)", () => {
  // The manifest shape that caused the defect: the US block above the India
  // one, so India sits below the point a 3600s-killed run can reach.
  const MANIFEST = [
    "candles",
    "us_filings",
    "us_13f_holdings",
    "stock_ratios",
    "mf_nav_history",
  ];

  it("returns the manifest UNCHANGED when there is no record at all", () => {
    // The first-ever run, and also the loud fallback the script prints when it
    // cannot read the record. Must be a full permutation, not a subset.
    assert.deepEqual(planSyncOrder(MANIFEST, []), MANIFEST);
  });

  it("puts a never-visited collection AHEAD of every visited one", () => {
    // THE defect, as a test. Everything above `stock_ratios` in the manifest
    // synced yesterday; `stock_ratios` and `mf_nav_history` have no record
    // because no run has ever reached them. They must go first.
    const order = planSyncOrder(MANIFEST, [
      rec("candles", 1),
      rec("us_filings", 1),
      rec("us_13f_holdings", 1),
    ]);
    assert.deepEqual(order, [
      "stock_ratios",
      "mf_nav_history",
      "candles",
      "us_filings",
      "us_13f_holdings",
    ]);
  });

  it("orders visited collections oldest-first", () => {
    const order = planSyncOrder(MANIFEST, [
      rec("candles", 1),
      rec("us_filings", 21),
      rec("us_13f_holdings", 3),
      rec("stock_ratios", 21.5),
      rec("mf_nav_history", 0.1),
    ]);
    assert.deepEqual(order, [
      "stock_ratios",
      "us_filings",
      "us_13f_holdings",
      "candles",
      "mf_nav_history",
    ]);
  });

  it("breaks ties by manifest position, so the order is deterministic", () => {
    // Every collection stamped in the same second — which is what a fresh
    // environment looks like after one fast run. Without the tie-break the
    // order would depend on Mongo's return order and no test could pin it.
    const all = MANIFEST.map((c) => rec(c, 2));
    assert.deepEqual(planSyncOrder(MANIFEST, all), MANIFEST);
  });

  it("keys on VISITED, not on SUCCEEDED — a serial failure cannot camp at the head", () => {
    // `candles` (29M rows) has FAILED every run since 2026-09-01 after burning
    // 25-29 minutes of a 60-minute budget. A success-keyed order would give it
    // `lastSuccessAt` = never = position 0 for ever and starve the other 53 —
    // MONEY-1255's stamping lesson reached from the other direction. It failed
    // MOST RECENTLY, so it goes LAST.
    const order = planSyncOrder(MANIFEST, [
      rec("candles", 0.1, "FAILED"),
      rec("us_filings", 5),
      rec("us_13f_holdings", 4),
      rec("stock_ratios", 3),
      rec("mf_nav_history", 2),
    ]);
    assert.equal(order[order.length - 1], "candles");
  });

  it("ignores a record for a collection no longer in the manifest", () => {
    // `financial_data` was removed from the allowlist on 2026-08-18. Its row
    // outlives the entry, and must not resurrect it.
    const order = planSyncOrder(
      ["candles"],
      [rec("financial_data", 90), rec("candles", 1)],
    );
    assert.deepEqual(order, ["candles"]);
  });

  it("is a PERMUTATION of the manifest, always", () => {
    // The property the script's fallback checks by length: a short list would
    // silently sync a SUBSET, which is a worse bug than the one being fixed.
    const order = planSyncOrder(MANIFEST, [rec("candles", 9)]);
    assert.equal(order.length, MANIFEST.length);
    assert.deepEqual([...order].sort(), [...MANIFEST].sort());
  });
});

describe("classifySyncFreshness — the report's verdicts (MONEY-1488)", () => {
  const MANIFEST = ["stock_ratios", "xbrl_filings", "candles"];

  it("NEVER is distinct from STALE", () => {
    // "reached once, three weeks ago" and "never reached at all" need different
    // responses, and collapsing them is how a permanently-broken collection
    // becomes indistinguishable from an idle one.
    const rows = classifySyncFreshness(
      MANIFEST,
      [rec("stock_ratios", 21)],
      NOW,
    );
    assert.equal(rows[0]!.freshness, "STALE");
    assert.equal(rows[0]!.ageDays, 21);
    assert.equal(rows[1]!.freshness, "NEVER");
    assert.equal(rows[1]!.ageDays, null);
    assert.equal(rows[1]!.lastState, null);
  });

  it("uses the threshold as a strict `older than`", () => {
    const rows = classifySyncFreshness(
      MANIFEST,
      [
        rec("stock_ratios", DEFAULT_STALE_AFTER_DAYS),
        rec("xbrl_filings", DEFAULT_STALE_AFTER_DAYS + 0.01),
      ],
      NOW,
    );
    assert.equal(rows[0]!.freshness, "FRESH", "exactly at the threshold");
    assert.equal(rows[1]!.freshness, "STALE");
  });

  it("a SKIPPED_EMPTY collection is FRESH — a healthy no-op is not staleness", () => {
    // It was visited. Prod had nothing to give. Treating that as stale would
    // make a correct guard look like a fault for ever.
    const rows = classifySyncFreshness(
      MANIFEST,
      [rec("stock_ratios", 0.5, "SKIPPED_EMPTY")],
      NOW,
    );
    assert.equal(rows[0]!.freshness, "FRESH");
    assert.equal(rows[0]!.partiallyApplied, false);
  });

  it("flags the two states that mean QA may hold a PARTIAL copy", () => {
    const rows = classifySyncFreshness(
      ["a", "b", "c", "d"],
      [
        { ...rec("a", 0.1), lastState: "IN_FLIGHT", lastSuccessAtMs: null },
        { ...rec("b", 0.1), lastState: "FAILED", lastSuccessAtMs: null },
        rec("c", 0.1, "RESTORED"),
        rec("d", 0.1, "COUNT_FAILED"),
      ],
      NOW,
    );
    assert.deepEqual(
      rows.map((r) => r.partiallyApplied),
      [true, true, false, false],
      "COUNT_FAILED never started, so QA was never dropped — it is not partial",
    );
  });

  it("the partial set is exactly FAILED, INDEX_BUILD_FAILED and IN_FLIGHT", () => {
    // Pinned by VALUE: widening it would silently let a state that DID complete
    // be treated as untrustworthy, and narrowing it would let a scattered
    // partial copy be used as a delta bound. INDEX_BUILD_FAILED joined it in
    // MONEY-1519: the rows may have landed, but without the unique key a
    // duplicate can sit among them, so QA's max(field) is not a clean bound.
    assert.deepEqual([...PARTIALLY_APPLIED_STATES].sort(), [
      "FAILED",
      "INDEX_BUILD_FAILED",
      "IN_FLIGHT",
    ]);
  });

  it("the shell --status renderer uses the SAME partial set", () => {
    // MONEY-1519 review: `sync-prod-to-qa.sh` cannot import this module (its
    // image has no Node), so its `--status` renderer spells the set again. A
    // new state added on one side only drifted silently; this ties them.
    const sh = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "scripts/ops/sync-prod-to-qa.sh",
      ),
      "utf8",
    );
    const m = /const PARTIAL = \[([^\]]*)\];/.exec(sh);
    assert.ok(m, "the renderer no longer declares `const PARTIAL = [...]`");
    const shellSet = [...m[1]!.matchAll(/"([A-Z_]+)"/g)]
      .map((x) => x[1]!)
      .sort();
    assert.deepEqual(shellSet, [...PARTIALLY_APPLIED_STATES].sort());
  });

  it("reports every manifest entry, in manifest order", () => {
    // The report answers "is QA's stock_ratios current?", so a collection with
    // no row must still appear — an absent line is the same non-answer the
    // ticket exists to end.
    const rows = classifySyncFreshness(MANIFEST, [], NOW);
    assert.deepEqual(
      rows.map((r) => r.collection),
      MANIFEST,
    );
  });
});

describe("mayUseAsDeltaBound — the MONEY-1486 precondition", () => {
  it("only a CLEAN completion qualifies", () => {
    assert.equal(mayUseAsDeltaBound(rec("candles", 1, "RESTORED")), true);
    for (const s of [
      "IN_FLIGHT",
      "FAILED",
      "INDEX_BUILD_FAILED",
      "COUNT_FAILED",
      "SKIPPED_EMPTY",
      "SKIPPED_SAMPLE_MISS",
    ] as const) {
      assert.equal(
        mayUseAsDeltaBound(rec("candles", 1, s)),
        false,
        `${s} must not be usable as a delta bound`,
      );
    }
  });

  it("an absent record is not a bound", () => {
    // The reading that caused MONEY-1486's withdrawal: falling back to QA's
    // live max() when there is no marker is exactly the unsafe bound.
    assert.equal(mayUseAsDeltaBound(undefined), false);
  });

  it("RESTORED with no success timestamp does not qualify", () => {
    // Defensive: a half-written row must not read as a clean completion.
    assert.equal(
      mayUseAsDeltaBound({
        collection: "candles",
        lastState: "RESTORED",
        lastAttemptAtMs: NOW,
        lastSuccessAtMs: null,
      }),
      false,
    );
  });
});

describe("NaN, not null, is the shape this codebase manufactures (MONEY-1487 review)", () => {
  /**
   * Both `Number.isFinite` guards in the module were UNEXERCISED — found by
   * mutation during review, and both mutations left the suite green.
   *
   * The existing cases pin the `null` shape. `null` is the easy one: it is
   * what a caller writes deliberately. NaN is what the SYSTEM produces —
   * `Number("")` is 0 but `Number(undefined)` is NaN, and the sibling writer
   * in `sync-prod-to-qa.sh` reasons about exactly that coercion when it reads
   * a field a mongosh program may not have set. So NaN is the reachable
   * shape, and it was the untested one.
   */
  it("REGRESSION: a NaN success stamp must NOT qualify as a delta bound", () => {
    // MUTATION: drop `Number.isFinite(rec.lastSuccessAtMs)` -> this returns
    // true, and a delta bound gets taken from a row that never recorded a
    // clean completion. That is the single thing the function exists to stop.
    assert.equal(
      mayUseAsDeltaBound({
        collection: "candles",
        lastState: "RESTORED",
        lastAttemptAtMs: 1_700_000_000_000,
        lastSuccessAtMs: Number.NaN,
      }),
      false,
    );
  });

  it("a real RESTORED row with a finite stamp still qualifies", () => {
    // The other polarity: the guard must not refuse everything.
    assert.equal(
      mayUseAsDeltaBound({
        collection: "candles",
        lastState: "RESTORED",
        lastAttemptAtMs: 1_700_000_000_000,
        lastSuccessAtMs: 1_700_000_000_000,
      }),
      true,
    );
  });

  it("REGRESSION: a NaN attempt stamp classifies NEVER, not FRESH", () => {
    // MUTATION: reduce the guard to `rec === undefined` -> `NaN > staleMs` is
    // false, so the row reads FRESH with `ageDays: NaN` — a collection that
    // never recorded a visit rendering as perfectly current.
    const [row] = classifySyncFreshness(
      ["candles"],
      [
        {
          collection: "candles",
          lastState: "RESTORED",
          lastAttemptAtMs: Number.NaN,
          lastSuccessAtMs: Number.NaN,
        },
      ],
      1_700_000_000_000,
    );
    assert.equal(row?.freshness, "NEVER");
    assert.equal(row?.ageDays, null, "ageDays must not be NaN");
  });
});
