/**
 * The lake ledger's decisions — MONEY-1472 (B1).
 *
 * Every later load prompt (B2, B2-IN, B5) asks this module whether its work is
 * already done. A wrong answer is either a silently skipped load or a doubled
 * one, in a BigQuery table nobody reads row by row — so the failures here are
 * all of the kind that report success.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLAIM_LEASE_MS,
  InvalidPartitionKeyError,
  PARTITION_STATES,
  SOURCE_OBJECT_STATES,
  assertPartitionKey,
  decideClaim,
  decideCoverage,
  isPartitionState,
  isSourceObjectState,
  objectUri,
  partitionIdentity,
  runId,
  DML_CONFLICT_ATTEMPTS,
  isDmlConcurrencyConflict,
  retryOnDmlConflict,
  type PartitionKey,
} from "../src/ledger-logic";

const KEY: PartitionKey = {
  dataset: "lake_silver_prod",
  table: "trade_bar_m1",
  partitionKey: "2026-09-16",
  sourceHash: "abc123",
  parserVersion: "v1",
};

describe("the idempotency key is five parts, and each one earns its place", () => {
  it("a different SOURCE HASH is a different partition", () => {
    // A vendor re-issuing a file with corrected data has the same partition and
    // different content. Without the hash in the key it would SKIP, and the
    // correction would never land.
    assert.notEqual(
      partitionIdentity(KEY),
      partitionIdentity({ ...KEY, sourceHash: "def456" }),
    );
  });

  it("a different PARSER VERSION is a different partition", () => {
    // A parser bug fixed later has to re-run over bytes that have not changed.
    // Without this, the fix can never reach already-loaded partitions and the
    // wrong rows are permanent.
    assert.notEqual(
      partitionIdentity(KEY),
      partitionIdentity({ ...KEY, parserVersion: "v2" }),
    );
  });

  it("keys that differ only in where a separator FALLS do not collide", () => {
    // THE REASON THE SEPARATOR IS A NUL. Partition keys are caller-supplied and
    // this repo's symbols legitimately contain `:`, `|`, `.` and `-`
    // (`RELIANCE:NSE`, `664UP30-SG`, `BRK.B`). Joining on any of those lets two
    // DIFFERENT partitions produce one identity — which reads as "already
    // loaded" and silently skips a real load.
    const a = partitionIdentity({ ...KEY, table: "a:b", partitionKey: "c" });
    const b = partitionIdentity({ ...KEY, table: "a", partitionKey: "b:c" });
    assert.notEqual(a, b, "a `:` separator would have collapsed these");

    const c = partitionIdentity({ ...KEY, table: "x|y", partitionKey: "z" });
    const d = partitionIdentity({ ...KEY, table: "x", partitionKey: "y|z" });
    assert.notEqual(c, d, "a `|` separator would have collapsed these");
  });

  it("an identical key is identical — the whole point", () => {
    assert.equal(partitionIdentity(KEY), partitionIdentity({ ...KEY }));
  });

  it("an EMPTY component is refused, not hashed into a collision", () => {
    for (const field of [
      "dataset",
      "table",
      "partitionKey",
      "sourceHash",
      "parserVersion",
    ] as const) {
      assert.throws(
        () => assertPartitionKey({ ...KEY, [field]: "" }),
        InvalidPartitionKeyError,
        `an empty ${field} must be refused`,
      );
      assert.throws(() => assertPartitionKey({ ...KEY, [field]: "   " }));
    }
    assert.doesNotThrow(() => assertPartitionKey(KEY));
  });
});

describe("claiming: only ACCEPTED skips", () => {
  const NOW = 1_700_000_000_000;

  it("claim twice -> the second is a SKIP", () => {
    // The headline idempotency property every loader depends on.
    assert.equal(decideClaim(null, NOW).action, "load");
    assert.equal(
      decideClaim({ state: "ACCEPTED", loadedAtMs: NOW - 1000 }, NOW).action,
      "skip",
    );
  });

  it("a SKIP says WHICH skip — accepted and leased are opposite states", () => {
    // MONEY-1516 review, and it was measured rather than imagined. A spread
    // load died on a missing GCP_STORAGE_BUCKET holding four claims; the next
    // run read the free-text reason, summarised "every spread month is already
    // ACCEPTED — nothing to do", and exited 0 with `wrote 0` while the table
    // was EMPTY. Both skips carried `action: "skip"` and nothing else a caller
    // could branch on, so the summary could not have been right.
    const accepted = decideClaim(
      { state: "ACCEPTED", loadedAtMs: NOW - 1000 },
      NOW,
    );
    assert.equal(accepted.action, "skip");
    assert.equal(
      accepted.action === "skip" ? accepted.kind : null,
      "accepted",
      "an ACCEPTED partition is DONE — an empty run is health",
    );

    const leased = decideClaim(
      { state: "LOADING", loadedAtMs: NOW - 60_000 },
      NOW,
    );
    assert.equal(leased.action, "skip");
    assert.equal(
      leased.action === "skip" ? leased.kind : null,
      "leased",
      "a live lease means the work REMAINS — an empty run is not health",
    );

    // The two must never collapse: that is the whole defect.
    assert.notEqual(
      accepted.action === "skip" ? accepted.kind : "x",
      leased.action === "skip" ? leased.kind : "x",
    );
  });

  it("REJECTED re-runs, because re-running IS the fix", () => {
    const v = decideClaim({ state: "REJECTED", loadedAtMs: NOW - 1000 }, NOW);
    assert.equal(v.action, "load");
    assert.match(v.reason, /REJECTED/);
  });

  it("SUPERSEDED re-runs, so a deliberate rollback is possible", () => {
    // Asking again with THIS identity is re-running a specific version on
    // purpose; refusing would make rolling back to it impossible.
    assert.equal(
      decideClaim({ state: "SUPERSEDED", loadedAtMs: NOW - 1000 }, NOW).action,
      "load",
    );
  });

  it("a FRESH LOADING claim is honoured — two runs must not double-write", () => {
    const v = decideClaim({ state: "LOADING", loadedAtMs: NOW - 60_000 }, NOW);
    assert.equal(v.action, "skip");
    assert.match(v.reason, /lease holds/);
  });

  it("a STALE LOADING claim is reclaimed — a killed task must not park a partition for ever", () => {
    // THE DEFECT THIS EXISTS FOR. A Cloud Run task killed mid-load leaves
    // LOADING behind. Treating that as "someone is working" would skip the
    // partition on every subsequent run, silently, with the ledger reporting
    // healthy — a gap that never closes and never reports.
    const v = decideClaim(
      { state: "LOADING", loadedAtMs: NOW - (CLAIM_LEASE_MS + 60_000) },
      NOW,
    );
    assert.equal(v.action, "load");
    assert.match(v.reason, /stale/);
  });

  it("the lease boundary is inclusive on the SKIP side", () => {
    // Exactly at the lease, the holder still owns it: the safe direction is to
    // wait one more cycle, not to race a run that may still be writing.
    assert.equal(
      decideClaim({ state: "LOADING", loadedAtMs: NOW - CLAIM_LEASE_MS }, NOW)
        .action,
      "skip",
    );
  });
});

describe("coverage: an ACCEPT is what makes every future run skip", () => {
  it("a full partition is accepted", () => {
    assert.deepEqual(
      decideCoverage({
        rowCount: 1000,
        expectedSessions: 5,
        actualSessions: 5,
      }),
      { accept: true },
    );
  });

  it("a PARTIAL partition is refused — accepting it freezes the gap for ever", () => {
    const v = decideCoverage({
      rowCount: 1000,
      expectedSessions: 5,
      actualSessions: 4,
    });
    assert.equal(v.accept, false);
    assert.match(v.accept === false ? v.reason : "", /partial: 4\/5/);
  });

  it("ZERO EXPECTED is a REFUSAL, not a pass", () => {
    // `0 >= 0` is true. A loader that could not work out what to expect would
    // otherwise accept an empty partition for ever — the
    // not-measured-is-not-passed defect this repo has shipped at four layers.
    for (const expectedSessions of [0, -1, Number.NaN]) {
      const v = decideCoverage({
        rowCount: 0,
        expectedSessions,
        actualSessions: 0,
      });
      assert.equal(v.accept, false, `expected ${expectedSessions} must refuse`);
      assert.match(
        v.accept === false ? v.reason : "",
        /unmeasured|zero or unknown/,
      );
    }
  });

  it("zero rows is a refusal even when the session count agrees", () => {
    const v = decideCoverage({
      rowCount: 0,
      expectedSessions: 3,
      actualSessions: 3,
    });
    assert.equal(v.accept, false);
    assert.match(v.accept === false ? v.reason : "", /no rows/);
  });

  it("MORE sessions than expected is accepted, not refused", () => {
    // Over-delivery is the vendor's business; refusing it would quarantine a
    // partition that has everything asked for and more.
    assert.deepEqual(
      decideCoverage({ rowCount: 10, expectedSessions: 2, actualSessions: 3 }),
      { accept: true },
    );
  });
});

describe("object uris and run ids", () => {
  it("a doubled slash does not make a second row for one object", () => {
    // Two spellings of one uri means two ledger rows whose `state` disagrees.
    assert.equal(objectUri("bucket", "a/b.csv"), "gs://bucket/a/b.csv");
    assert.equal(objectUri("bucket/", "/a/b.csv"), "gs://bucket/a/b.csv");
    assert.equal(objectUri("gs://bucket", "a/b.csv"), "gs://bucket/a/b.csv");
  });

  it("an empty bucket or key throws rather than building `gs:///`", () => {
    assert.throws(() => objectUri("", "a"));
    assert.throws(() => objectUri("b", ""));
  });

  it("a run id is sortable and carries no separator BigQuery dislikes", () => {
    const id = runId(
      "ledger-backfill-databento",
      Date.UTC(2026, 8, 16, 12, 30, 0),
    );
    assert.match(id, /^ledger-backfill-databento-2026-09-16T12-30-00-000Z$/);
    assert.ok(!id.includes(":"), "colons break some downstream identifiers");
    assert.throws(() => runId("  ", 0));
  });
});

describe("the state vocabularies are closed", () => {
  it("only the declared values are valid", () => {
    // BigQuery has no ENUM, so the set is closed here and refused on write —
    // otherwise a typo'd state is simply a string nobody queries for.
    assert.deepEqual(
      [...SOURCE_OBJECT_STATES],
      ["PRESENT", "VERIFIED", "MISSING", "EXPIRED"],
    );
    assert.deepEqual(
      [...PARTITION_STATES],
      ["LOADING", "ACCEPTED", "REJECTED", "SUPERSEDED"],
    );
    assert.ok(isSourceObjectState("VERIFIED"));
    assert.ok(
      !isSourceObjectState("verified"),
      "case matters; BigQuery compares exactly",
    );
    assert.ok(!isPartitionState("DONE"));
    assert.ok(!isPartitionState(undefined));
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Concurrent-DML conflicts — MONEY-1608 addendum
   ──────────────────────────────────────────────────────────────────────── */

/** The error `lake-load-databento-prod` died on, 2026-09-23 15:44Z. */
const CONFLICT_TEXT =
  "Could not serialize access to table " +
  "stock-book-483718:lake_bronze_prod.partition_load due to concurrent update";

/** The two shapes the BigQuery client surfaces a failed job's error in. */
function conflictAsMessage(): Error {
  return Object.assign(new Error(CONFLICT_TEXT), {
    errors: [{ reason: "invalidQuery", message: CONFLICT_TEXT }],
  });
}
function conflictInErrorsOnly(): Error {
  return Object.assign(new Error("Query failed"), {
    errors: [{ reason: "invalidQuery", message: CONFLICT_TEXT }],
  });
}

/** A fake BigQuery `query`: throws `failures` in order, then answers. */
function fakeQuery(failures: Error[]): {
  query: () => Promise<[unknown[]]>;
  calls: () => number;
} {
  let n = 0;
  return {
    query: async () => {
      const f = failures[n++];
      if (f) throw f;
      return [[{ ok: true }]];
    },
    calls: () => n,
  };
}

describe("isDmlConcurrencyConflict", () => {
  it("matches the measured error, in the message or in errors[] alone", () => {
    assert.equal(isDmlConcurrencyConflict(conflictAsMessage()), true);
    assert.equal(isDmlConcurrencyConflict(conflictInErrorsOnly()), true);
  });
  it("does not match other invalidQuery errors, or non-errors", () => {
    const syntax = Object.assign(new Error("Syntax error: Unexpected ')'"), {
      errors: [{ reason: "invalidQuery", message: "Syntax error" }],
    });
    assert.equal(isDmlConcurrencyConflict(syntax), false);
    assert.equal(isDmlConcurrencyConflict(new Error("EPIPE")), false);
    assert.equal(isDmlConcurrencyConflict(null), false);
    assert.equal(isDmlConcurrencyConflict("Could not serialize access"), false);
  });
});

describe("retryOnDmlConflict", () => {
  it("retries the conflict N times, then returns the statement's answer", async () => {
    const bq = fakeQuery([
      conflictAsMessage(),
      conflictInErrorsOnly(),
      conflictAsMessage(),
    ]);
    const waits: number[] = [];
    const [rows] = await retryOnDmlConflict(bq.query, {
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
    });
    assert.deepEqual(rows, [{ ok: true }]);
    assert.equal(bq.calls(), 4, "three conflicts, one success");
    // Jittered exponential: uniform in [ceiling/2, ceiling), ceiling 2s, 4s, 8s.
    assert.deepEqual(waits, [1500, 3000, 6000]);
  });

  it("gives up after DML_CONFLICT_ATTEMPTS and throws the conflict", async () => {
    const bq = fakeQuery(
      Array.from({ length: DML_CONFLICT_ATTEMPTS + 2 }, conflictAsMessage),
    );
    await assert.rejects(
      retryOnDmlConflict(bq.query, { sleep: async () => {} }),
      /concurrent update/,
    );
    assert.equal(bq.calls(), DML_CONFLICT_ATTEMPTS);
  });

  it("NEVER retries any other error", async () => {
    const other = Object.assign(new Error("Syntax error: Unexpected ')'"), {
      errors: [{ reason: "invalidQuery", message: "Syntax error" }],
    });
    const bq = fakeQuery([other, other, other]);
    let slept = 0;
    await assert.rejects(
      retryOnDmlConflict(bq.query, { sleep: async () => void slept++ }),
      /Syntax error/,
    );
    assert.equal(bq.calls(), 1, "the statement ran exactly once");
    assert.equal(slept, 0);
  });
});

/**
 * The retry is only as good as its wiring, and `ledger.ts` builds its own
 * BigQuery client — so the WIRING is read from source: every statement is
 * either a `dml(...)` (retried) or one of the two raw calls a retried unit
 * owns (`claimOnce`'s read and `writePartitionState`'s MERGE), and every
 * `writePartitionState` call sits inside a retried unit.
 */
describe("ledger.ts routes every statement through the conflict retry", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src", "ledger.ts"),
    "utf8",
  );
  /** The body of `function <name>(`, up to the next top-level function. */
  function body(name: string): string {
    const start = src.search(new RegExp(`function ${name}\\b`));
    assert.ok(start >= 0, `no function ${name}`);
    const next = src.slice(start + 1).search(/\n(export )?(async )?function /);
    return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
  }

  it("there are exactly three raw bq().query calls, each where it may be", () => {
    assert.equal(src.split("bq().query(").length - 1, 3);
    assert.match(body("dml"), /retryOnDmlConflict\(\(\) => bq\(\)\.query\(/);
    assert.match(body("claimOnce"), /bq\(\)\.query\(/);
    assert.match(body("writePartitionState"), /bq\(\)\.query\(/);
  });

  it("a claim is retried as a WHOLE — read, decide, write", () => {
    assert.match(
      body("claimPartition"),
      /retryOnDmlConflict\(\(\) => claimOnce\(key, args\)/,
    );
  });

  it("accept and reject wrap their write; nothing else calls it", () => {
    for (const fn of ["acceptPartition", "rejectPartition"]) {
      assert.match(
        body(fn),
        /retryOnDmlConflict\(\s*\(\) =>\s*writePartitionState\(/,
        fn,
      );
    }
    assert.equal(src.split("writePartitionState(key").length - 1, 3);
  });
});

describe("load.ts retries the month DELETE on a conflict", () => {
  it("deleteMonth runs its job inside retryOnDmlConflict", () => {
    // IN and US replays both DELETE-then-load months of `price_bar_d1`, so the
    // silver DELETE collides exactly as the ledger MERGE does.
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "load.ts"),
      "utf8",
    );
    const start = src.indexOf("async function deleteMonth(");
    const fn = src.slice(start, src.indexOf("\nasync function ", start + 1));
    assert.match(
      fn,
      /retryOnDmlConflict\(\s*async \(\) => \{\s*const \[job\] = await bq\(projectId\)\.createQueryJob\(/,
    );
  });
});
