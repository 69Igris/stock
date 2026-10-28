/**
 * UNIT TEST — did a `replay`-mode run actually replay? (MONEY-1194)
 *
 * The load-bearing case is `REGRESSION: total miss is LOUD`. QA ran
 * FEED_ARCHIVE_MODE=replay against a working prod->QA mirror and scraped 100%
 * of the daily bhavcopy anyway (replayHits=0 replayMisses=2, 2026-08-13) —
 * every weekday, for weeks, with no failure of any kind, because a replay miss
 * falls back to the exchange by design. These exact counters were already being
 * printed; nothing asserted on them.
 *
 * The second load-bearing case is its opposite: `no reads is NOT a failure`. An
 * alert that fires on a run that simply asked the archive for nothing would be
 * ignored within a week, taking the real signal with it.
 *
 * Mutation checks these assertions are meant to catch:
 *   - flipping the mode guard (`!== "replay"` -> `=== "replay"`) — silences the
 *     real case and pages on every prod archive run;
 *   - dropping the `storeRegistered` arm — restores the armed-but-inert hole,
 *     where replay + no store leaves every counter at 0 and looks idle;
 *   - promoting `partial-miss` to warn — the "alert that always fires" trap: a
 *     feed the exchange never published misses on QA forever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  judgeReplayHealth,
  type ReplayHealthInput,
} from "../../src/market-data/replay-health";

/** A replaying process with a registered store and no reads yet. */
function input(over: Partial<ReplayHealthInput> = {}): ReplayHealthInput {
  return {
    mode: "replay",
    storeRegistered: true,
    counters: { replayHits: 0, replayMisses: 0, replayRejected: 0 },
    ...over,
  };
}

describe("judgeReplayHealth", () => {
  it("REGRESSION: total miss is LOUD — 0 hits with reads attempted", () => {
    // The measured QA run: two archive reads, both missed, both scraped.
    const v = judgeReplayHealth(
      input({
        counters: { replayHits: 0, replayMisses: 2, replayRejected: 0 },
      }),
    );
    assert.equal(v.degraded, true);
    assert.equal(v.reason, "total-miss");
    assert.equal(v.level, "warn");
    assert.match(v.message!, /0 of 2 archive read/);
    assert.match(v.message!, /MONEY-1194/);
    assert.equal(v.hits, 0);
    assert.equal(v.fellBack, 2);
    assert.equal(v.reads, 2);
  });

  it("counts a REJECTED replay as a fallback, not a hit", () => {
    // An archived object that fails the payload sanity check is served from the
    // exchange just like a miss, so it must not read as a healthy replay.
    const v = judgeReplayHealth(
      input({
        counters: { replayHits: 0, replayMisses: 0, replayRejected: 3 },
      }),
    );
    assert.equal(v.reason, "total-miss");
    assert.equal(v.level, "warn");
    assert.equal(v.fellBack, 3);
    assert.match(v.message!, /3 rejected/);
  });

  it("REGRESSION: replay armed with NO store registered is LOUD", () => {
    // initFeedArchive() refuses to register the GCS store when
    // GCP_STORAGE_BUCKET is unset, and getFeedAsset then skips the replay
    // branch entirely — every counter stays 0 and the run looks idle.
    const v = judgeReplayHealth(input({ storeRegistered: false }));
    assert.equal(v.degraded, true);
    assert.equal(v.reason, "no-store");
    assert.equal(v.level, "warn");
    assert.match(v.message!, /GCP_STORAGE_BUCKET/);
  });

  it("no-store wins over the counters (it is the more specific fault)", () => {
    const v = judgeReplayHealth(
      input({
        storeRegistered: false,
        counters: { replayHits: 5, replayMisses: 0, replayRejected: 0 },
      }),
    );
    assert.equal(v.reason, "no-store");
  });

  it("no reads is NOT a failure and says nothing", () => {
    const v = judgeReplayHealth(input());
    assert.equal(v.degraded, false);
    assert.equal(v.reason, "no-reads");
    assert.equal(v.level, "none");
    assert.equal(v.message, null);
  });

  it("all hits is healthy and silent", () => {
    const v = judgeReplayHealth(
      input({
        counters: { replayHits: 3, replayMisses: 0, replayRejected: 0 },
      }),
    );
    assert.equal(v.degraded, false);
    assert.equal(v.reason, "healthy");
    assert.equal(v.level, "none");
    assert.equal(v.message, null);
    assert.equal(v.reads, 3);
  });

  it("partial miss is degraded but INFO, never a page", () => {
    // A feed the exchange never published is archived by nobody, so its QA read
    // misses every single day. Warning on that would train everyone to ignore
    // the line that matters.
    const v = judgeReplayHealth(
      input({
        counters: { replayHits: 2, replayMisses: 1, replayRejected: 0 },
      }),
    );
    assert.equal(v.degraded, true);
    assert.equal(v.reason, "partial-miss");
    assert.equal(v.level, "info");
    assert.match(v.message!, /2 of 3 archive read/);
  });

  it("says nothing in archive mode, whatever the counters say", () => {
    // Prod archives; a replay counter there would mean something else entirely.
    const v = judgeReplayHealth(
      input({
        mode: "archive",
        counters: { replayHits: 0, replayMisses: 9, replayRejected: 1 },
      }),
    );
    assert.equal(v.degraded, false);
    assert.equal(v.reason, "not-replaying");
    assert.equal(v.level, "none");
    assert.equal(v.message, null);
  });

  it("says nothing when the archive is off (local dev, unset flag)", () => {
    const v = judgeReplayHealth(input({ mode: "off", storeRegistered: false }));
    assert.equal(v.degraded, false);
    assert.equal(v.reason, "not-replaying");
    assert.equal(v.message, null);
  });

  it("clamps negative counters instead of inventing reads", () => {
    // diffFeedArchiveCounters already clamps, but a caller passing a raw
    // subtraction must not be able to manufacture a phantom read count.
    const v = judgeReplayHealth(
      input({
        counters: { replayHits: -4, replayMisses: -1, replayRejected: 0 },
      }),
    );
    assert.equal(v.hits, 0);
    assert.equal(v.fellBack, 0);
    assert.equal(v.reads, 0);
    assert.equal(v.reason, "no-reads");
  });

  it("is pure — the same input yields the same verdict", () => {
    const i = input({
      counters: { replayHits: 0, replayMisses: 2, replayRejected: 0 },
    });
    assert.deepEqual(judgeReplayHealth(i), judgeReplayHealth(i));
  });
});
