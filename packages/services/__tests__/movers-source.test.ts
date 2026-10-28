/**
 * Movers source precedence — MONEY-1204 (P14 / 14d.4, decision D1).
 *
 * `market_movers` becomes the PRIMARY and `latest_quotes` ranking the fallback.
 * The decision is made on the two sources' OWN session days, never on the wall
 * clock, and these cases are mostly about proving that choice was necessary:
 *
 *   - a clock-based rule needs a trading-calendar lookup to be right on holidays;
 *   - it would call the snapshot "stale" every Sunday and flap to the fallback on
 *     exactly the days when neither source has anything newer.
 *
 * The other half is the failure mode MONEY-1198 shipped: `latest_quotes` holding
 * the PREVIOUS session at 11:47 IST, every number internally consistent, none of
 * them today's. `snapshot-stale` is the only branch that may prefer that table,
 * and it may only do so when the snapshot is genuinely older.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideMoversSource } from "../src/discover-logic";

/** 15:30 IST on the given IST day, i.e. the close. */
const istClose = (day: string): Date => new Date(`${day}T10:00:00.000Z`);
/** 09:20 IST — before the open, same IST day. */
const istEarly = (day: string): Date => new Date(`${day}T03:50:00.000Z`);

describe("decideMoversSource — the snapshot wins by default", () => {
  it("prefers the snapshot when both describe the same session", () => {
    const d = decideMoversSource({
      snapshotAt: istClose("2026-08-14"),
      referenceAt: istClose("2026-08-14"),
    });
    assert.equal(d.source, "snapshot");
    assert.equal(d.reason, "snapshot-current");
    assert.equal(d.snapshotDay, "2026-08-14");
  });

  it("prefers the snapshot when it is NEWER than the quotes", () => {
    // This is the everyday intraday case and the entire point of the switch:
    // market-movers-sync writes every 3 minutes, while nothing bulk-refreshes
    // latest_quotes until 23:00 IST.
    const d = decideMoversSource({
      snapshotAt: istClose("2026-08-14"),
      referenceAt: istClose("2026-08-13"),
    });
    assert.equal(d.source, "snapshot");
    assert.equal(d.reason, "snapshot-current");
  });

  it("prefers the snapshot when the quotes' session cannot be determined", () => {
    // "We cannot tell how fresh the alternative is" is not a reason to prefer
    // the alternative.
    const d = decideMoversSource({
      snapshotAt: istClose("2026-08-14"),
      referenceAt: null,
    });
    assert.equal(d.source, "snapshot");
    assert.equal(d.reason, "no-reference");
    assert.equal(d.referenceDay, null);
  });

  it("times of day within one IST session do not change the verdict", () => {
    // Both are 2026-08-14 IST; only the DAY may decide. A rule that compared
    // instants would flip between two readings of the same session.
    const d = decideMoversSource({
      snapshotAt: istEarly("2026-08-14"),
      referenceAt: istClose("2026-08-14"),
    });
    assert.equal(d.source, "snapshot");
    assert.equal(d.reason, "snapshot-current");
  });
});

describe("decideMoversSource — the fallback is the exception", () => {
  it("falls back when there is no snapshot at all", () => {
    const d = decideMoversSource({
      snapshotAt: null,
      referenceAt: istClose("2026-08-14"),
    });
    assert.equal(d.source, "fallback");
    assert.equal(d.reason, "snapshot-empty");
    assert.equal(d.snapshotDay, null);
  });

  it("falls back when the snapshot is from an EARLIER session", () => {
    const d = decideMoversSource({
      snapshotAt: istClose("2026-08-13"),
      referenceAt: istClose("2026-08-14"),
    });
    assert.equal(d.source, "fallback");
    assert.equal(d.reason, "snapshot-stale");
    assert.equal(d.snapshotDay, "2026-08-13");
    assert.equal(d.referenceDay, "2026-08-14");
  });

  it("falls back with NEITHER source available (nothing to serve either way)", () => {
    const d = decideMoversSource({ snapshotAt: null, referenceAt: null });
    assert.equal(d.source, "fallback");
    assert.equal(d.reason, "snapshot-empty");
  });
});

describe("decideMoversSource — IST boundary correctness", () => {
  it("an instant just before IST midnight belongs to the OLD IST day", () => {
    // 18:29 UTC = 23:59 IST on the 14th. A naive UTC-day comparison would call
    // this the 14th too and accidentally agree; the case that separates them is
    // below.
    const d = decideMoversSource({
      snapshotAt: new Date("2026-08-14T18:29:00.000Z"),
      referenceAt: istClose("2026-08-14"),
    });
    assert.equal(d.snapshotDay, "2026-08-14");
    assert.equal(d.source, "snapshot");
  });

  it("an instant just after IST midnight belongs to the NEW IST day", () => {
    // 18:31 UTC on the 14th = 00:01 IST on the 15th. Under UTC days this reads
    // as the 14th — one day stale — and would wrongly fall back.
    const d = decideMoversSource({
      snapshotAt: new Date("2026-08-14T18:31:00.000Z"),
      referenceAt: istClose("2026-08-14"),
    });
    assert.equal(d.snapshotDay, "2026-08-15");
    assert.equal(d.source, "snapshot");
    assert.equal(d.reason, "snapshot-current");
  });

  it("does not flap on a weekend, when neither source has anything newer", () => {
    // Saturday/Sunday: both sources still carry Friday. A clock-based rule
    // ("is the snapshot from today?") answers NO and falls back to a table that
    // is equally old — churn with no benefit, on the days it is least useful.
    const friday = istClose("2026-08-14");
    const d = decideMoversSource({ snapshotAt: friday, referenceAt: friday });
    assert.equal(d.source, "snapshot");
    assert.equal(d.reason, "snapshot-current");
  });
});

describe("decideMoversSource — the decision is always explainable", () => {
  it("every branch reports both days and a reason", () => {
    const cases: Array<{
      snapshotAt: Date | null;
      referenceAt: Date | null;
      expectDay: string | null;
    }> = [
      {
        snapshotAt: istClose("2026-08-14"),
        referenceAt: istClose("2026-08-14"),
        expectDay: "2026-08-14",
      },
      {
        snapshotAt: istClose("2026-08-13"),
        referenceAt: istClose("2026-08-14"),
        expectDay: "2026-08-13",
      },
      {
        snapshotAt: null,
        referenceAt: istClose("2026-08-14"),
        expectDay: null,
      },
      {
        snapshotAt: istClose("2026-08-14"),
        referenceAt: null,
        expectDay: "2026-08-14",
      },
      { snapshotAt: null, referenceAt: null, expectDay: null },
    ];
    const reasons = new Set<string>();
    for (const c of cases) {
      const d = decideMoversSource(c);
      // "Which source served this number?" is the first question any movers bug
      // raises; it has to be answerable from one logged line.
      assert.ok(d.reason.length > 0);
      assert.ok(d.source === "snapshot" || d.source === "fallback");
      assert.equal(d.snapshotDay, c.expectDay);
      reasons.add(d.reason);
    }
    // All four reasons are reachable — a branch nobody can hit is a branch
    // nobody has tested.
    assert.deepEqual([...reasons].sort(), [
      "no-reference",
      "snapshot-current",
      "snapshot-empty",
      "snapshot-stale",
    ]);
  });
});
