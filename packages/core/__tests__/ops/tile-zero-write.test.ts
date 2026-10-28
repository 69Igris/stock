/**
 * A tile run that wrote nothing must REFUSE. MONEY-1479.
 *
 * This is the exact state that hid `tile-build-d1-us` for weeks: OOM-killed
 * every night before the first write, `tiles/US/` never created, and an
 * execution carrying a completionTime that read as finished on every
 * dashboard. The existing `counters.failed > 0` exit could not see it — a job
 * that dies before building anything has nothing to count as failed.
 *
 * The decision is a PURE function precisely so it can be asserted here; buried
 * inside `main()` it needed a database to exercise, which is how a guard ends
 * up protected only by a source scan.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo root from packages/core/__tests__/ops/. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

import {
  missingTileRefusal,
  zeroWriteRefusal,
} from "../../src/market-data/tiles/tile-logic";

const base = { apply: true, walked: 100, built: 0, builtEmpty: 0, skipped: 0 };

describe("a run that produced nothing is refused", () => {
  it("walked listings, produced NOTHING -> refusal naming the numbers", () => {
    const why = zeroWriteRefusal(base);
    assert.ok(why, "must refuse");
    assert.match(why, /walked 100/);
    assert.match(why, /produced NOTHING/);
  });

  it("any real outcome clears it — built, empty, or already current", () => {
    // `builtEmpty` and `skipped` COUNT. A listing with no bars, or one already
    // up to date, are decisions the builder MADE. Requiring `built > 0` would
    // fail a healthy second run, which skips everything as current.
    assert.equal(zeroWriteRefusal({ ...base, built: 1 }), null);
    assert.equal(zeroWriteRefusal({ ...base, builtEmpty: 1 }), null);
    assert.equal(zeroWriteRefusal({ ...base, skipped: 1 }), null);
  });
});

describe("what it must NOT refuse", () => {
  it("a DRY RUN writes nothing by design", () => {
    assert.equal(zeroWriteRefusal({ ...base, apply: false }), null);
  });

  it("an EMPTY SHARD is not a fault", () => {
    // Sharding hands some tasks no listings. MONEY-1379 is the precedent: an
    // empty shard throwing produced 3,733 5xx and 928 dead-letters a DAY for
    // work that did not need doing.
    assert.equal(zeroWriteRefusal({ ...base, walked: 0 }), null);
  });
});

/**
 * The OTHER half of MONEY-1479's remaining work: the counters are in-process
 * bookkeeping, and a run can look healthy on every one of them while the
 * bucket holds nothing.
 */
describe("the bucket must agree with the manifest", () => {
  const skipped = {
    apply: true,
    listingId: "AAPL:NASDAQ:1980-12-12",
  } as const;

  it("a SKIPPED listing whose 5y tile is gone is refused", () => {
    // The state `zeroWriteRefusal` cannot see and never will: `skipped > 0`
    // clears it, and `skipped` asserts only what the MANIFEST says. Delete the
    // objects and leave the manifest and every listing is skipped, all four
    // tasks exit 0, and no nightly run ever rebuilds them — a skipped listing
    // is never re-put. Permanently blank charts behind a green dashboard.
    const why = missingTileRefusal({ ...skipped, outcome: "absent" });
    assert.ok(why, "an absent tile for a skipped listing must refuse");
    assert.match(why, /AAPL:NASDAQ:1980-12-12/);
    assert.match(why, /SKIPPED/);
  });

  it("present clears it", () => {
    assert.equal(missingTileRefusal({ ...skipped, outcome: "present" }), null);
  });

  it("a read that FAILED is refused too — cannot-read is not absent", () => {
    // `loadManifest` one file over refuses an unreadable manifest rather than
    // reading it as "nothing is built". Same store, same rule: a verification
    // that fails open is the defect it was added to catch.
    const why = missingTileRefusal({ ...skipped, outcome: "failed" });
    assert.ok(why, "an unanswerable read must not be recorded as healthy");
    assert.match(why, /could not read back/);
  });

  it("a DRY RUN verifies nothing", () => {
    assert.equal(
      missingTileRefusal({ ...skipped, apply: false, outcome: "absent" }),
      null,
    );
  });

  it("skipping NOTHING leaves nothing to verify", () => {
    // Every listing this run touched went through `store.put`, which throws on
    // failure — so a run with no skips is already self-verifying and there is
    // no listing to read back. Refusing here would fail every first build.
    assert.equal(
      missingTileRefusal({ apply: true, listingId: null, outcome: "absent" }),
      null,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The CALL SITE, not just the decision — MONEY-1514 review
   ──────────────────────────────────────────────────────────────────────── */

describe("missingTileRefusal is actually wired into tile-build-d1", () => {
  // WHY A SOURCE SCAN. The review deleted the `verifyListingId` assignment in
  // `tile-build-d1.ts` — so `if (args.apply && verifyListingId)` is never true
  // and the read-back never happens — and the FULL core suite stayed green at
  // 8322/8322, because every unit case here exercises the pure function, which
  // the mutation does not touch.
  //
  // That is this repo's own stated rule, from `createDedupeMiddleware`:
  // "extracting the decision function alone leaves the CALL SITE untested, and
  // the call site is where a [guard] silently degrades." A guard added to catch
  // "reports success while doing nothing" must not itself be able to report
  // success while doing nothing.
  //
  // A behavioural test is the better instrument and is too expensive here:
  // `tile-build-d1.ts` statically imports `@usemoney/database` and the US
  // prefetch path, so driving it needs Prisma. `job-env-pinning.test.ts`
  // already uses a scan for exactly this class.
  const SRC = readFileSync(
    join(REPO_ROOT, "scripts/jobs/tile-build-d1.ts"),
    "utf8",
  );

  it("records which listing to verify, or there is nothing to read back", () => {
    // The half the mutation removed.
    assert.match(
      SRC,
      /verifyListingId\s*=\s*listing\.listingId/,
      "nothing assigns verifyListingId — the read-back below can never run",
    );
    assert.match(
      SRC,
      /counters\.skipped\s*>\s*skippedBefore/,
      "the verified listing must be one this run SKIPPED — a listing it just " +
        "put is not in question",
    );
  });

  it("reads the tile back and THROWS on the refusal", () => {
    assert.match(
      SRC,
      /readTile\(\s*tileKey5y\(/,
      "the read-back must use readTile/get — tile-store.ts states listFiles " +
        "fails open to [], so a listing can never assert absence",
    );
    assert.match(SRC, /missingTileRefusal\(\{/, "the refusal is not called");
    // SEVERANCE, not just deletion. Review pass 2 replaced `outcome: back.status`
    // with `outcome: "present"`: readTile still ran, the refusal was still
    // called, the throw still existed, and it could never fire — 12/12 green,
    // and `type-check:scripts` OK too, because base.json sets no
    // `noUnusedLocals` so the dead `back` is not an error either.
    assert.match(
      SRC,
      /outcome:\s*back\.status/,
      "the refusal is fed a constant instead of what the bucket actually said",
    );
    assert.match(
      SRC,
      /if\s*\(missing\)\s*throw new Error\(missing\)/,
      "the refusal is computed and then ignored — the exact shape it exists " +
        "to prevent",
    );
  });

  it("does not read back on a dry run", () => {
    assert.match(
      SRC,
      /if\s*\(args\.apply\s*&&\s*verifyListingId\)/,
      "a dry run writes no tile, so verifying one would fail on a healthy run",
    );
  });
});
