/**
 * The two pure decisions inside `scripts/data/repair-instrument-names.ts` —
 * MONEY-1205.
 *
 * ## Why these are tested at all
 *
 * The repair itself is a one-shot data fix, but its two decisions are not:
 *
 *   - `stripWrappingQuotes` decides what to WRITE over a name. A wrong answer
 *     destroys the only human-readable label an instrument has; there is no
 *     history column on `InstrumentMapping`.
 *   - `judgeParserFixLive` is the ORDERING gate. `mapToUpdate` leaves `name` in
 *     the spread, so the 22:00 IST instrument-sync rewrites it nightly — a
 *     repair run before the parser fix ships is silently reverted within 24
 *     hours (the MONEY-1093 class). A gate that says "live" when it is not is
 *     worse than no gate, because it looks like caution.
 *
 * Both live in `packages/core/src/market-data/instrument-name-repair.ts` rather
 * than in the script, mirroring how `series-readiness.ts` was pulled out of
 * `reclassify-instruments.ts` in MONEY-1196. The script imports that narrow
 * subpath — never the `market-data` barrel, which would pull the Prisma client
 * in as a value before `--env` has been resolved (`ops-script-db-target.test.ts`
 * enforces that, and lists this script).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  stripWrappingQuotes,
  judgeParserFixLive,
} from "../../src/market-data/instrument-name-repair";

describe("stripWrappingQuotes", () => {
  it("strips one symmetric pair — the actual prod corruption", () => {
    assert.equal(
      stripWrappingQuotes('"SBI NIFTY 200 QUALITY 30 ETF"'),
      "SBI NIFTY 200 QUALITY 30 ETF",
    );
    assert.equal(stripWrappingQuotes('"ABB INDIA"'), "ABB INDIA");
  });

  it("is idempotent — a second run is a no-op", () => {
    const once = stripWrappingQuotes('"ABB INDIA"');
    assert.equal(stripWrappingQuotes(once), once);
    // And over the whole corpus shape: already-clean names never move.
    for (const clean of ["RELIANCE", "TCS Limited", "ABB INDIA"]) {
      assert.equal(stripWrappingQuotes(clean), clean);
    }
  });

  it("leaves a name that is not fully wrapped completely alone", () => {
    // Zero prod rows look like this, but guessing at asymmetric quoting is how
    // a display bug becomes data loss.
    assert.equal(stripWrappingQuotes('"HALF OPEN'), '"HALF OPEN');
    assert.equal(stripWrappingQuotes('HALF CLOSE"'), 'HALF CLOSE"');
    assert.equal(stripWrappingQuotes('MID"DLE'), 'MID"DLE');
  });

  it("never empties a name — '\"' and '\"\"' are left as-is", () => {
    // `'"'.slice(1, -1)` is "", which would look "fixed" while destroying the
    // label. `mapToUpsert` falls back to the symbol for empties, so the damage
    // would be invisible until someone looked at the row.
    assert.equal(stripWrappingQuotes('"'), '"');
    assert.equal(stripWrappingQuotes('""'), '""');
    assert.equal(stripWrappingQuotes('"   "'), '"   "');
  });

  it("handles the empty string and short names", () => {
    assert.equal(stripWrappingQuotes(""), "");
    assert.equal(stripWrappingQuotes("A"), "A");
  });

  it("strips only ONE pair, so nesting is preserved", () => {
    // The corruption is exactly one pair deep (zero prod rows carry an odd
    // number of quote characters). If a second pair ever appeared, this must
    // remove one and leave the rest visible rather than looping.
    assert.equal(stripWrappingQuotes('""ABB""'), '"ABB"');
  });
});

describe("judgeParserFixLive — the ordering gate", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("REFUSES when the most recent sync wrote quoted names", () => {
    // The whole point. If the newest run produced quoted names, the parser that
    // produced them was the broken one — a fixed parser could not have.
    const v = judgeParserFixLive({
      lastSyncAt: hoursAgo(14),
      quotedInLastRun: 12_377,
      now,
    });
    assert.equal(v.live, false);
    assert.equal(v.recentSync, true);
    assert.match(v.reason, /STILL quoted/);
  });

  it("passes when a recent sync wrote no quoted names", () => {
    const v = judgeParserFixLive({
      lastSyncAt: hoursAgo(14),
      quotedInLastRun: 0,
      now,
    });
    assert.equal(v.live, true);
    assert.equal(v.recentSync, true);
  });

  it("treats a stale database as evidence ABSENT, not negative", () => {
    // An idle database says nothing about the deployed code. Refusing here
    // would block the legitimate "deploy, then repair immediately" order this
    // fix is meant to follow — a gate that anti-correlates with the thing it
    // guards is worse than no gate.
    const v = judgeParserFixLive({
      lastSyncAt: hoursAgo(200),
      quotedInLastRun: 9_999,
      now,
    });
    assert.equal(v.live, true);
    assert.equal(v.recentSync, false);
    assert.match(v.reason, /evidence absent/);
  });

  it("handles an empty collection", () => {
    const v = judgeParserFixLive({
      lastSyncAt: null,
      quotedInLastRun: 0,
      now,
    });
    assert.equal(v.live, true);
    assert.equal(v.lastSyncAt, null);
  });

  it("is decided by the 36h boundary, not by the quoted count alone", () => {
    // Same quoted count either side of the window: inside it REFUSES, outside
    // it abstains. Pins the boundary so a future edit to RECENT_SYNC_HOURS is a
    // deliberate act.
    const inside = judgeParserFixLive({
      lastSyncAt: hoursAgo(35),
      quotedInLastRun: 5,
      now,
    });
    const outside = judgeParserFixLive({
      lastSyncAt: hoursAgo(37),
      quotedInLastRun: 5,
      now,
    });
    assert.equal(inside.live, false, "35h ago is recent enough to judge");
    assert.equal(outside.live, true, "37h ago is too stale to judge");
  });
});
