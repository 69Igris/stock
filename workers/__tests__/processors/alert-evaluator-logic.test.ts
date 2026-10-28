/**
 * UNIT TEST — MONEY-1204 (14e.3) data-engine alert evaluators.
 *
 * Exercises the REAL exports from `workers/src/processors/alert-evaluator-logic.ts`
 * — the same functions `alert-evaluator.ts` calls. No shadow re-implementations,
 * no Prisma, no fetch, no timers: nothing here can orphan the runner.
 *
 * What is deliberately tested, per evaluator:
 *   1. a FIRES case,
 *   2. the BOUNDARY. Note the rules are not all the same shape: `> 2x` and
 *      `> 2pp` are STRICT (exactly 2.0 must NOT fire), while `>= 3 events`,
 *      `>= 5 days` and `>= 80%` are INCLUSIVE (the boundary value MUST fire and
 *      one notch below must not). Both sides are asserted for each,
 *   3. IDEMPOTENCY — above all the PERSISTENCE case: a condition that holds on
 *      two consecutive days must yield ONE notification, not two.
 *
 * Plus the absence rules the ticket calls out: a delivery mean that SKIPS nulls
 * and carries its contributing-day count, a flow streak broken by a zero-net
 * day, and a flow streak broken by a MISSING day (a gap is not continuity).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type AlertEvent,
  type DeliveryBarLite,
  type FlagObservationLite,
  type FlowRowLite,
  type InsiderEventLite,
  type MwplRowLite,
  type ShareholdingRowLite,
  type StockFlagRowLite,
  DEFAULT_FLAG_KINDS,
  OPT_IN_FLAG_KINDS,
  STATE_FLAG_KINDS,
  POINT_EVENT_FLAG_KINDS,
  detectFlagTransitions,
  detectFlowStreaks,
  evaluateDeliverySpike,
  evaluateFiiFlowStreak,
  evaluateFlagTransition,
  evaluateInsiderCluster,
  evaluateMwplHigh,
  evaluatePledgeIncrease,
  meanDeliveryPct,
  quarterEndDate,
  shouldSuppressRepeat,
  utcDay,
} from "../../src/processors/alert-evaluator-logic";

// The single source of truth for the kind set — MONEY-1205 moved the policy
// table here so core, the workers and the stock page read ONE Record.
import { ALL_STOCK_FLAG_KINDS } from "@usemoney/core/market-data";

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** UTC midnight for an August-2026 day — the ticket's own worked example. */
const aug = (day: number): Date => new Date(Date.UTC(2026, 7, day));

/** A run of consecutive August days as observed publication dates. */
const augRange = (from: number, to: number): Date[] => {
  const out: Date[] = [];
  for (let d = from; d <= to; d++) out.push(aug(d));
  return out;
};

/** The days ONE flag family published, market-wide. */
const published = (
  kind: string,
  days: readonly Date[],
): FlagObservationLite[] => days.map((date) => ({ kind, date }));

/**
 * EVERY flag family published on each of `days`.
 *
 * This is the faithful reading of what a single flat `observedDates` list used
 * to mean, restated per kind — including the two opt-in families, so a test
 * asserting that an unwatched kind is ignored still fails for the right reason
 * (not watched) rather than passing because that kind had no observed days.
 */
const publishedAll = (days: readonly Date[]): FlagObservationLite[] =>
  [...DEFAULT_FLAG_KINDS, ...OPT_IN_FLAG_KINDS].flatMap((kind) =>
    published(kind, days),
  );

/**
 * Simulate the SHELL's gate: fire only when the evaluator returns an event AND
 * we have not already fired at or after its crossing date. Returns the new
 * `lastFiredAt` (or the old one when suppressed), plus whether it fired — i.e.
 * exactly what `processAlertEvaluator` does with `shouldSuppressRepeat`.
 */
function fireOnce(
  event: AlertEvent | null,
  lastFiredAt: Date | null,
  firedAtWallClock: Date,
): { fired: boolean; lastFiredAt: Date | null } {
  if (!event) return { fired: false, lastFiredAt };
  if (shouldSuppressRepeat(lastFiredAt, event.eventDate)) {
    return { fired: false, lastFiredAt };
  }
  return { fired: true, lastFiredAt: firedAtWallClock };
}

// ── shouldSuppressRepeat ────────────────────────────────────────────────────

describe("shouldSuppressRepeat (the idempotency gate)", () => {
  it("never suppresses when the alert has never fired", () => {
    assert.equal(shouldSuppressRepeat(null, aug(4)), false);
    assert.equal(shouldSuppressRepeat(undefined, aug(4)), false);
  });

  it("suppresses when we already fired LATER the same day (>= not >)", () => {
    // The shell writes a wall-clock instant; the event date is UTC midnight.
    // With `>` this would re-fire on every cron tick of the event day.
    const firedAt = new Date(Date.UTC(2026, 7, 4, 15, 30));
    assert.equal(shouldSuppressRepeat(firedAt, aug(4)), true);
  });

  it("does NOT suppress a later event than the last fire", () => {
    const firedAt = new Date(Date.UTC(2026, 7, 4, 15, 30));
    assert.equal(shouldSuppressRepeat(firedAt, aug(21)), false);
  });

  it("is not a cooldown: an OLD fire does not gate a NEW event date", () => {
    // A cooldown would still be blocking here if it were long enough; the event
    // gate keys on the FACT, not on elapsed time.
    const firedAt = new Date(Date.UTC(2026, 7, 4, 15, 30, 1));
    assert.equal(shouldSuppressRepeat(firedAt, aug(5)), false);
  });
});

// ── FLAG_TRANSITION ─────────────────────────────────────────────────────────

describe("FLAG_TRANSITION (StockFlag)", () => {
  const observed = augRange(1, 6);

  it("fires on an ASM/GSM ENTRY, dating the event to the transition day", () => {
    const rows: StockFlagRowLite[] = [
      { date: aug(4), kind: "SURVEILLANCE", value: "GSM STAGE - I" },
      { date: aug(5), kind: "SURVEILLANCE", value: "GSM STAGE - I" },
    ];
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows,
      // Window ENDS on 5-Aug, the last day the flag is present. Extending it to
      // 6-Aug would (rightly) make the EXIT the latest transition — that case
      // has its own test below.
      observations: publishedAll(augRange(1, 5)),
      conditions: {},
    });
    assert.ok(event, "an ASM entry must fire");
    assert.equal(utcDay(event.eventDate), utcDay(aug(4)));
    assert.equal(event.metadata.direction, "ENTRY");
    assert.equal(event.metadata.to, "GSM STAGE - I");
  });

  it("IDEMPOTENCY — set on 4-Aug and STILL set on 5-Aug fires exactly ONCE", () => {
    // The headline requirement. Two evaluations, two days apart, one alert row.
    const day4Rows: StockFlagRowLite[] = [
      { date: aug(4), kind: "SURVEILLANCE", value: "GSM STAGE - I" },
    ];
    const day5Rows: StockFlagRowLite[] = [
      ...day4Rows,
      { date: aug(5), kind: "SURVEILLANCE", value: "GSM STAGE - I" },
    ];

    let lastFiredAt: Date | null = null;
    let notifications = 0;

    // Cron run on 4-Aug, after the flag file landed.
    const run4 = fireOnce(
      evaluateFlagTransition({
        symbol: "XYZ",
        rows: day4Rows,
        observations: publishedAll(augRange(1, 4)),
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 4, 20, 15)),
    );
    if (run4.fired) notifications++;
    lastFiredAt = run4.lastFiredAt;
    assert.equal(run4.fired, true, "4-Aug entry must notify");

    // Cron run on 5-Aug. The flag PERSISTS: same crossing date, no new fact.
    const run5 = fireOnce(
      evaluateFlagTransition({
        symbol: "XYZ",
        rows: day5Rows,
        observations: publishedAll(augRange(1, 5)),
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 5, 20, 15)),
    );
    if (run5.fired) notifications++;
    lastFiredAt = run5.lastFiredAt;

    assert.equal(run5.fired, false, "a persisting flag must stay silent");
    assert.equal(notifications, 1, "exactly ONE notification across both days");

    // ...and the same on 6-Aug, 7-Aug, however long it holds.
    const day6Rows: StockFlagRowLite[] = [
      ...day5Rows,
      { date: aug(6), kind: "SURVEILLANCE", value: "GSM STAGE - I" },
    ];
    const run6 = fireOnce(
      evaluateFlagTransition({
        symbol: "XYZ",
        rows: day6Rows,
        observations: publishedAll(augRange(1, 6)),
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 6, 20, 15)),
    );
    if (run6.fired) notifications++;
    assert.equal(notifications, 1, "still exactly ONE after three days");
  });

  it("a genuine EXIT is a NEW crossing date and fires again", () => {
    const rows: StockFlagRowLite[] = augRange(4, 5).map((date) => ({
      date,
      kind: "SURVEILLANCE",
      value: "GSM STAGE - I",
    }));
    // 6-Aug published, but no row for XYZ -> the flag cleared.
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows,
      observations: publishedAll(augRange(1, 6)),
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.direction, "EXIT");
    assert.equal(utcDay(event.eventDate), utcDay(aug(6)));

    // A fire on the 4-Aug entry does not suppress the 6-Aug exit.
    assert.equal(
      shouldSuppressRepeat(
        new Date(Date.UTC(2026, 7, 4, 20, 15)),
        event.eventDate,
      ),
      false,
    );
  });

  it("does NOT fire on the first observed day — there is no 'before' state", () => {
    // Otherwise every new alert announces a flag that has been set for a year.
    const rows: StockFlagRowLite[] = [
      { date: aug(1), kind: "FO_BAN", value: "BAN" },
      { date: aug(2), kind: "FO_BAN", value: "BAN" },
    ];
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows,
      observations: publishedAll(augRange(1, 2)),
      conditions: {},
    });
    assert.equal(event, null);
  });

  it("does NOT invent an EXIT on a day the feed published nothing", () => {
    // 5-Aug is absent from observedDates (holiday / no publication). The flag
    // running 4-Aug -> 6-Aug is continuous, not entered-exited-re-entered.
    const rows: StockFlagRowLite[] = [
      { date: aug(4), kind: "FO_BAN", value: "BAN" },
      { date: aug(6), kind: "FO_BAN", value: "BAN" },
    ];
    const transitions = detectFlagTransitions(
      rows,
      published("FO_BAN", [aug(1), aug(2), aug(3), aug(4), aug(6)]),
      ["FO_BAN"],
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.direction, "ENTRY");
    assert.equal(utcDay(transitions[0]!.date), utcDay(aug(4)));
  });

  it("fires on an F&O ban ENTRY", () => {
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows: [{ date: aug(5), kind: "FO_BAN", value: "BAN" }],
      observations: publishedAll(augRange(1, 5)),
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.flagKind, "FO_BAN");
    assert.equal(event.metadata.direction, "ENTRY");
  });

  it("fires on a price-band CHANGE and reports both ends", () => {
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows: [
        { date: aug(3), kind: "PRICE_BAND", value: '{"band":"20"}' },
        { date: aug(4), kind: "PRICE_BAND", value: '{"band":"10"}' },
      ],
      observations: publishedAll(augRange(1, 4)),
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.direction, "CHANGE");
    assert.equal(event.metadata.from, '{"band":"20"}');
    assert.equal(event.metadata.to, '{"band":"10"}');
  });

  it("treats BAND_CHANGE as a POINT event — no phantom EXIT the next day", () => {
    // NSE publishes eq_band_changes only on the day the band moved. Diffing it
    // as a state would emit ENTRY on 4-Aug and EXIT on 5-Aug from one real move.
    const transitions = detectFlagTransitions(
      [{ date: aug(4), kind: "BAND_CHANGE", value: '{"from":"10","to":"20"}' }],
      published("BAND_CHANGE", observed),
      ["BAND_CHANGE"],
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.direction, "CHANGE");
    assert.equal(utcDay(transitions[0]!.date), utcDay(aug(4)));
  });

  it("ignores kinds outside the watch set (52-week extremes are daily noise)", () => {
    assert.equal(DEFAULT_FLAG_KINDS.includes("WK52_HIGH_LOW"), false);
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows: [{ date: aug(4), kind: "WK52_HIGH_LOW", value: '{"high":246.61}' }],
      observations: publishedAll(observed),
      conditions: {},
    });
    assert.equal(event, null);
  });

  it("does NOT fabricate an EXIT/ENTRY from ANOTHER kind's publication days", () => {
    // The market-wide-across-every-kind bug, with the ticket's own numbers.
    //
    // WK52_HIGH_LOW and SHORT_SELLING publish the WHOLE UNIVERSE every session,
    // so a single flat "days the feed published anything" list marks 10..14 Aug
    // observed. SURVEILLANCE did not land on the 12th. Judged against the flat
    // list, ACME's continuous ASM run reads as EXIT@12 then ENTRY@13 and the
    // user is told "ACME entered surveillance" about a stock that never left.
    // A weekly-cadence family reproduces the same bogus pair EVERY WEEK.
    const observations: FlagObservationLite[] = [
      ...published("WK52_HIGH_LOW", augRange(10, 14)),
      ...published("SHORT_SELLING", augRange(10, 14)),
      // The surveillance file skipped the 12th.
      ...published("SURVEILLANCE", [aug(10), aug(11), aug(13), aug(14)]),
    ];
    const rows: StockFlagRowLite[] = [aug(10), aug(11), aug(13), aug(14)].map(
      (date) => ({ date, kind: "SURVEILLANCE", value: "ASM STAGE - I" }),
    );

    assert.deepEqual(
      detectFlagTransitions(rows, observations, ["SURVEILLANCE"]),
      [],
      "a kind must be walked against ITS OWN publication days",
    );
    assert.equal(
      evaluateFlagTransition({
        symbol: "ACME",
        rows,
        observations,
        conditions: {},
      }),
      null,
      "ACME never left surveillance — nothing may be notified",
    );
  });

  it("still sees a REAL exit on a day that kind DID publish", () => {
    // The other half: per-kind days must not make every absence forgivable.
    // SURVEILLANCE published on the 14th and ACME is not on it — a genuine exit.
    const observations: FlagObservationLite[] = [
      ...published("WK52_HIGH_LOW", augRange(10, 14)),
      ...published("SURVEILLANCE", [aug(10), aug(11), aug(13), aug(14)]),
    ];
    const rows: StockFlagRowLite[] = [aug(10), aug(11), aug(13)].map(
      (date) => ({ date, kind: "SURVEILLANCE", value: "ASM STAGE - I" }),
    );
    const event = evaluateFlagTransition({
      symbol: "ACME",
      rows,
      observations,
      conditions: {},
    });
    assert.ok(event, "a real exit must still fire");
    assert.equal(event.metadata.direction, "EXIT");
    assert.equal(utcDay(event.eventDate), utcDay(aug(14)));
  });

  it("leaves a kind UNKNOWN when that kind published nothing at all", () => {
    // The environment where surveillance-sync is prod-only. No SURVEILLANCE
    // publication day means no "before" state to diff against, so the honest
    // answer is silence — never a fabricated entry or exit.
    const event = evaluateFlagTransition({
      symbol: "ACME",
      rows: [{ date: aug(10), kind: "SURVEILLANCE", value: "ASM STAGE - I" }],
      observations: published("WK52_HIGH_LOW", augRange(10, 14)),
      conditions: {},
    });
    assert.equal(event, null);
  });

  it("watches SERIES_CHANGE by default — an EQ→BE move is a headline flag", () => {
    // MONEY-1204 B6. The alert-creation drawer writes no `conditions.kinds`, so
    // DEFAULT_FLAG_KINDS is not a default — it is the ONLY list that runs. A
    // series change is a POINT event (NSE publishes series_change.csv only on
    // the day it moved), so watching it costs nothing per-day, and EQ→BE moves
    // a holder onto trade-for-trade with 100% margin. `FLAG_KIND_LABEL` has
    // carried a "series change" label all along — the omission was an oversight.
    assert.ok(
      DEFAULT_FLAG_KINDS.includes("SERIES_CHANGE"),
      "SERIES_CHANGE must be watched by default",
    );
    const event = evaluateFlagTransition({
      symbol: "ACME",
      rows: [
        {
          date: aug(4),
          kind: "SERIES_CHANGE",
          value: '{"from":"EQ","to":"BE"}',
        },
      ],
      observations: publishedAll(augRange(1, 5)),
      conditions: {},
    });
    assert.ok(event, "an EQ→BE series change must fire");
    assert.equal(event.metadata.flagKind, "SERIES_CHANGE");
    assert.match(event.title, /series change/);
  });

  it("partitions EVERY StockFlag kind into default-watched or opt-in", () => {
    // The audit's own finding: every list the COMPILER checked was right and
    // every plain array was wrong. `DEFAULT_FLAG_KINDS` is now derived from a
    // `Record<StockFlagKind, …>`, so a new kind in @usemoney/core breaks the
    // workers type-check until someone decides whether it is alert-worthy.
    // This pins the resulting split so a silent removal is still caught at
    // runtime, and pins WHY the two exclusions are exclusions.
    assert.deepEqual([...DEFAULT_FLAG_KINDS].sort(), [
      "BAND_CHANGE",
      "FO_BAN",
      "PRICE_BAND",
      "SERIES_CHANGE",
      "SURVEILLANCE",
    ]);
    // Whole-universe daily publications: watching them means a notification
    // every trading day forever. Still selectable via `conditions.kinds`.
    assert.deepEqual([...OPT_IN_FLAG_KINDS].sort(), [
      "SHORT_SELLING",
      "WK52_HIGH_LOW",
    ]);
    for (const kind of OPT_IN_FLAG_KINDS) {
      assert.equal(DEFAULT_FLAG_KINDS.includes(kind), false, kind);
    }
  });

  it("honours an explicit `kinds` narrowing in the alert conditions", () => {
    const rows: StockFlagRowLite[] = [
      { date: aug(4), kind: "SURVEILLANCE", value: "GSM STAGE - I" },
    ];
    assert.equal(
      evaluateFlagTransition({
        symbol: "XYZ",
        rows,
        observations: publishedAll(augRange(1, 4)),
        conditions: { kinds: ["FO_BAN"] },
      }),
      null,
    );
    assert.ok(
      evaluateFlagTransition({
        symbol: "XYZ",
        rows,
        observations: publishedAll(augRange(1, 4)),
        conditions: { kinds: ["SURVEILLANCE"] },
      }),
    );
  });
});

// ── DELIVERY_SPIKE ──────────────────────────────────────────────────────────

describe("DELIVERY_SPIKE (DailyPrice.deliveryPct)", () => {
  /** A 20-bar baseline all at the same delivery percentage. */
  const flatBaseline = (pct: number | null, n = 20): DeliveryBarLite[] =>
    Array.from({ length: n }, (_, i) => ({
      date: aug(20 - i),
      deliveryPct: pct,
    }));

  it("fires above 2x the 20-day mean", () => {
    const event = evaluateDeliverySpike({
      symbol: "XYZ",
      latest: { date: aug(21), deliveryPct: 61 },
      baseline: flatBaseline(30),
      conditions: {},
    });
    assert.ok(event);
    assert.equal(utcDay(event.eventDate), utcDay(aug(21)));
    assert.equal(event.metadata.contributingDays, 20);
    assert.ok(
      (event.metadata.ratio as number) > 2,
      "ratio must be strictly above the multiplier",
    );
  });

  it("BOUNDARY — exactly 2.0x does NOT fire (strictly greater)", () => {
    const event = evaluateDeliverySpike({
      symbol: "XYZ",
      latest: { date: aug(21), deliveryPct: 60 },
      baseline: flatBaseline(30),
      conditions: {},
    });
    assert.equal(event, null);
  });

  it("SKIPS nulls in the mean and carries the contributing-day count", () => {
    // Trade-for-trade days print `-`. Zeroing them would drag a 40% mean down
    // to 8% and manufacture a 5x "spike" out of an ordinary 40% day.
    const baseline: DeliveryBarLite[] = [
      { date: aug(20), deliveryPct: 40 },
      { date: aug(19), deliveryPct: null },
      { date: aug(18), deliveryPct: 40 },
      { date: aug(17), deliveryPct: null },
      { date: aug(16), deliveryPct: 40 },
      { date: aug(15), deliveryPct: 40 },
      { date: aug(14), deliveryPct: 40 },
    ];
    const { mean, contributingDays } = meanDeliveryPct(baseline);
    assert.equal(mean, 40, "null days must not enter the average");
    assert.equal(contributingDays, 5, "and the honest count is 5, not 7");

    // 90% against a 40% mean is 2.25x -> fires. Against a null-as-zero mean of
    // 28.57% it would be 3.15x, i.e. the null handling changes the verdict's
    // magnitude on exactly the illiquid names where it matters.
    const event = evaluateDeliverySpike({
      symbol: "XYZ",
      latest: { date: aug(21), deliveryPct: 90 },
      baseline,
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.contributingDays, 5);
    assert.equal(event.metadata.baselineMean, 40);
  });

  it("returns a null mean and a zero count when EVERY bar is null", () => {
    assert.deepEqual(meanDeliveryPct(flatBaseline(null)), {
      mean: null,
      contributingDays: 0,
    });
    assert.equal(
      evaluateDeliverySpike({
        symbol: "XYZ",
        latest: { date: aug(21), deliveryPct: 90 },
        baseline: flatBaseline(null),
        conditions: {},
      }),
      null,
    );
  });

  it("refuses a baseline thinner than the contributing-day floor", () => {
    // Four reported days is not a 20-day mean, however tempting the ratio.
    const baseline: DeliveryBarLite[] = [
      { date: aug(20), deliveryPct: 10 },
      { date: aug(19), deliveryPct: 10 },
      { date: aug(18), deliveryPct: 10 },
      { date: aug(17), deliveryPct: 10 },
      ...flatBaseline(null, 16),
    ];
    assert.equal(meanDeliveryPct(baseline).contributingDays, 4);
    assert.equal(
      evaluateDeliverySpike({
        symbol: "XYZ",
        latest: { date: aug(21), deliveryPct: 90 },
        baseline,
        conditions: {},
      }),
      null,
    );
  });

  it("SKIPS a null delivery on the day being judged (not reported != 0)", () => {
    assert.equal(
      evaluateDeliverySpike({
        symbol: "XYZ",
        latest: { date: aug(21), deliveryPct: null },
        baseline: flatBaseline(30),
        conditions: {},
      }),
      null,
    );
  });

  it("IDEMPOTENCY — the same spike day re-evaluated stays silent", () => {
    const input = {
      symbol: "XYZ",
      latest: { date: aug(21), deliveryPct: 90 },
      baseline: flatBaseline(30),
      conditions: {},
    };
    let lastFiredAt: Date | null = null;
    let notifications = 0;

    for (const tick of [
      new Date(Date.UTC(2026, 7, 21, 16, 0)),
      new Date(Date.UTC(2026, 7, 21, 16, 5)),
      new Date(Date.UTC(2026, 7, 21, 16, 10)),
    ]) {
      const run = fireOnce(evaluateDeliverySpike(input), lastFiredAt, tick);
      if (run.fired) notifications++;
      lastFiredAt = run.lastFiredAt;
    }
    assert.equal(notifications, 1, "three cron ticks, one notification");

    // A spike on the NEXT day is a genuinely new one-day event.
    const nextDay = fireOnce(
      evaluateDeliverySpike({
        ...input,
        latest: { date: aug(22), deliveryPct: 95 },
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 22, 16, 0)),
    );
    assert.equal(nextDay.fired, true);
  });
});

// ── PLEDGE_INCREASE ─────────────────────────────────────────────────────────

describe("PLEDGE_INCREASE (ShareholdingPattern.pledgedPct)", () => {
  it("quarterEndDate resolves the canonical label to the quarter's last day", () => {
    assert.equal(
      quarterEndDate("2026-03")?.toISOString(),
      new Date(Date.UTC(2026, 2, 31)).toISOString(),
    );
    assert.equal(
      quarterEndDate("2026-06")?.toISOString(),
      new Date(Date.UTC(2026, 5, 30)).toISOString(),
    );
    // The verbatim-label fallback has no position in the sequence.
    assert.equal(quarterEndDate("Q1 FY27"), null);
    assert.equal(quarterEndDate("2026-13"), null);
    assert.equal(quarterEndDate(""), null);
  });

  it("fires when the pledge rises more than 2 percentage points QoQ", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: 12.5 },
      { quarter: "2026-03", pledgedPct: 10.0 },
    ];
    const event = evaluatePledgeIncrease({
      symbol: "XYZ",
      rows,
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.deltaPp, 2.5);
    assert.equal(
      event.eventDate.toISOString(),
      new Date(Date.UTC(2026, 5, 30)).toISOString(),
    );
  });

  it("BOUNDARY — exactly +2.00pp does NOT fire (strictly greater)", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: 12.0 },
      { quarter: "2026-03", pledgedPct: 10.0 },
    ];
    assert.equal(
      evaluatePledgeIncrease({ symbol: "XYZ", rows, conditions: {} }),
      null,
    );
  });

  it("percentage POINTS, not percent — 1.0% -> 2.5% is +1.5pp and stays silent", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: 2.5 },
      { quarter: "2026-03", pledgedPct: 1.0 },
    ];
    assert.equal(
      evaluatePledgeIncrease({ symbol: "XYZ", rows, conditions: {} }),
      null,
    );
  });

  it("a NULL on either side is NOT zero — no fabricated 12pp jump", () => {
    const undisclosedNow: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: null },
      { quarter: "2026-03", pledgedPct: 10.0 },
    ];
    const undisclosedBefore: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: 12.0 },
      { quarter: "2026-03", pledgedPct: null },
    ];
    assert.equal(
      evaluatePledgeIncrease({
        symbol: "XYZ",
        rows: undisclosedNow,
        conditions: {},
      }),
      null,
    );
    assert.equal(
      evaluatePledgeIncrease({
        symbol: "XYZ",
        rows: undisclosedBefore,
        conditions: {},
      }),
      null,
      "null-as-0 would read this as +12pp",
    );
  });

  it("a reported ZERO is real data and still forms a comparison", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: 5.0 },
      { quarter: "2026-03", pledgedPct: 0 },
    ];
    const event = evaluatePledgeIncrease({
      symbol: "XYZ",
      rows,
      conditions: {},
    });
    assert.ok(event, "0 -> 5% is a real +5pp and must fire");
  });

  it("orders by quarter END, not by input order or string sort", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "2025-12", pledgedPct: 10.0 },
      { quarter: "2026-06", pledgedPct: 14.0 },
      { quarter: "2026-03", pledgedPct: 10.0 },
    ];
    const event = evaluatePledgeIncrease({
      symbol: "XYZ",
      rows,
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.quarter, "2026-06");
    assert.equal(event.metadata.previousQuarter, "2026-03");
  });

  it("drops unparseable quarter labels rather than mis-sequencing them", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "Q1 FY27", pledgedPct: 50.0 },
      { quarter: "2026-03", pledgedPct: 10.0 },
    ];
    assert.equal(
      evaluatePledgeIncrease({ symbol: "XYZ", rows, conditions: {} }),
      null,
      "one usable quarter is not a QoQ comparison",
    );
  });

  it("IDEMPOTENCY — the same filing re-evaluated all quarter stays silent", () => {
    const rows: ShareholdingRowLite[] = [
      { quarter: "2026-06", pledgedPct: 12.5 },
      { quarter: "2026-03", pledgedPct: 10.0 },
    ];
    let lastFiredAt: Date | null = null;
    let notifications = 0;
    for (const tick of [aug(1), aug(2), aug(30)]) {
      const run = fireOnce(
        evaluatePledgeIncrease({ symbol: "XYZ", rows, conditions: {} }),
        lastFiredAt,
        tick,
      );
      if (run.fired) notifications++;
      lastFiredAt = run.lastFiredAt;
    }
    assert.equal(notifications, 1);

    // The NEXT quarter's filing is a new event date and speaks again.
    const nextQuarter = fireOnce(
      evaluatePledgeIncrease({
        symbol: "XYZ",
        rows: [
          { quarter: "2026-09", pledgedPct: 16.0 },
          { quarter: "2026-06", pledgedPct: 12.5 },
        ],
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 9, 20)),
    );
    assert.equal(nextQuarter.fired, true);
  });
});

// ── INSIDER_CLUSTER ─────────────────────────────────────────────────────────

describe("INSIDER_CLUSTER (InsiderEvent)", () => {
  const buy = (day: number, person = "A Promoter"): InsiderEventLite => ({
    date: aug(day),
    action: "BUY",
    category: "PIT",
    person,
  });

  it("BOUNDARY — exactly 3 BUYs in 30 days DOES fire (the rule is >= 3)", () => {
    const event = evaluateInsiderCluster({
      symbol: "XYZ",
      events: [buy(1), buy(5), buy(9)],
      conditions: {},
    });
    assert.ok(event, ">= 3 is inclusive");
    assert.equal(event.metadata.buyCount, 3);
    // The crossing date is the THIRD buy — the day the count reached 3.
    assert.equal(utcDay(event.eventDate), utcDay(aug(9)));
  });

  it("BOUNDARY — 2 BUYs does NOT fire", () => {
    assert.equal(
      evaluateInsiderCluster({
        symbol: "XYZ",
        events: [buy(1), buy(5)],
        conditions: {},
      }),
      null,
    );
  });

  it("counts BUYs only — SELLs and pledge events are not a buying cluster", () => {
    const events: InsiderEventLite[] = [
      buy(1),
      { date: aug(3), action: "SELL", category: "PIT", person: "B" },
      {
        date: aug(4),
        action: "PLEDGE_CREATION",
        category: "PLEDGE",
        person: "C",
      },
      buy(5),
    ];
    assert.equal(
      evaluateInsiderCluster({ symbol: "XYZ", events, conditions: {} }),
      null,
    );
  });

  it("excludes a buy that falls OUTSIDE the rolling window", () => {
    // Anchor is the newest buy (31-Aug via day 31 -> Aug has 31 days).
    const events = [buy(1), buy(2), { ...buy(31) }];
    // Window is [1-Aug, 31-Aug] = 30 days: all three are in.
    assert.ok(
      evaluateInsiderCluster({ symbol: "XYZ", events, conditions: {} }),
    );

    // Shrink the window to 20 days and the two early buys drop out.
    assert.equal(
      evaluateInsiderCluster({
        symbol: "XYZ",
        events,
        conditions: { windowDays: 20 },
      }),
      null,
    );
  });

  it("IDEMPOTENCY — re-evaluating the same cluster stays silent", () => {
    const events = [buy(1), buy(5), buy(9)];
    let lastFiredAt: Date | null = null;
    let notifications = 0;
    for (const tick of [
      new Date(Date.UTC(2026, 7, 9, 20, 0)),
      new Date(Date.UTC(2026, 7, 10, 20, 0)),
      new Date(Date.UTC(2026, 7, 11, 20, 0)),
    ]) {
      const run = fireOnce(
        evaluateInsiderCluster({ symbol: "XYZ", events, conditions: {} }),
        lastFiredAt,
        tick,
      );
      if (run.fired) notifications++;
      lastFiredAt = run.lastFiredAt;
    }
    assert.equal(notifications, 1);

    // A 4th buy GROWS the same cluster — the crossing date is unchanged, so it
    // does not re-announce. (Anchoring on the LATEST buy would fire here.)
    const grown = fireOnce(
      evaluateInsiderCluster({
        symbol: "XYZ",
        events: [...events, buy(12)],
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 12, 20, 0)),
    );
    assert.equal(grown.fired, false, "a 4th buy is not a new cluster");
  });

  it("a genuinely NEW cluster after the old buys age out fires again", () => {
    // Fired on the Aug 1/5/9 cluster (crossing 9-Aug). Two months later three
    // fresh buys land; the window no longer contains any August buy.
    const lastFiredAt = new Date(Date.UTC(2026, 7, 9, 20, 0));
    const oct = (d: number): InsiderEventLite => ({
      date: new Date(Date.UTC(2026, 9, d)),
      action: "BUY",
      category: "PIT",
      person: "A Promoter",
    });
    const event = evaluateInsiderCluster({
      symbol: "XYZ",
      events: [buy(1), buy(5), buy(9), oct(2), oct(3), oct(4)],
      conditions: {},
    });
    assert.ok(event);
    assert.equal(shouldSuppressRepeat(lastFiredAt, event.eventDate), false);
    assert.equal(
      event.metadata.buyCount,
      3,
      "only the October buys are in window",
    );
  });

  it("honours a category filter when the alert asks for one", () => {
    const events: InsiderEventLite[] = [
      { date: aug(1), action: "BUY", category: "SAST", person: "Acquirer" },
      { date: aug(2), action: "BUY", category: "SAST", person: "Acquirer" },
      { date: aug(3), action: "BUY", category: "SAST", person: "Acquirer" },
    ];
    assert.ok(
      evaluateInsiderCluster({ symbol: "XYZ", events, conditions: {} }),
    );
    assert.equal(
      evaluateInsiderCluster({
        symbol: "XYZ",
        events,
        conditions: { categories: ["PIT"] },
      }),
      null,
    );
  });
});

// ── MWPL_HIGH ───────────────────────────────────────────────────────────────

describe("MWPL_HIGH (MwplDaily.utilisationPct) — DORMANT by design", () => {
  it("is DORMANT: every real row has a NULL utilisation and must not fire", () => {
    // MwplDaily.utilisationPct is null on every row in the database and stays
    // null until a source for the DENOMINATOR exists — `mwpl_cli` 404s and has
    // zero archived objects, and `oi_cli_limit` is a PER-CLIENT limit, a
    // different quantity that would produce a plausible WRONG utilisation.
    // A null must read as "not known", never as "not high".
    const rows: MwplRowLite[] = augRange(1, 5).map((date) => ({
      date,
      utilisationPct: null,
    }));
    assert.equal(
      evaluateMwplHigh({ symbol: "XYZ", rows, conditions: {} }),
      null,
    );
  });

  it("BOUNDARY — exactly 80% DOES fire (the rule is >= 80)", () => {
    const event = evaluateMwplHigh({
      symbol: "XYZ",
      rows: [{ date: aug(5), utilisationPct: 80 }],
      conditions: {},
    });
    assert.ok(event, ">= 80 is inclusive");
    assert.equal(event.metadata.utilisationPct, 80);
  });

  it("BOUNDARY — 79.99% does NOT fire", () => {
    assert.equal(
      evaluateMwplHigh({
        symbol: "XYZ",
        rows: [{ date: aug(5), utilisationPct: 79.99 }],
        conditions: {},
      }),
      null,
    );
  });

  it("dates the event to the START of the current high run, not to today", () => {
    const rows: MwplRowLite[] = [
      { date: aug(5), utilisationPct: 88 },
      { date: aug(4), utilisationPct: 85 },
      { date: aug(3), utilisationPct: 82 },
      { date: aug(2), utilisationPct: 60 },
    ];
    const event = evaluateMwplHigh({ symbol: "XYZ", rows, conditions: {} });
    assert.ok(event);
    assert.equal(utcDay(event.eventDate), utcDay(aug(3)));
  });

  it("a NULL day BREAKS the run — 'not known' cannot extend 'known high'", () => {
    const rows: MwplRowLite[] = [
      { date: aug(5), utilisationPct: 88 },
      { date: aug(4), utilisationPct: null },
      { date: aug(3), utilisationPct: 85 },
    ];
    const event = evaluateMwplHigh({ symbol: "XYZ", rows, conditions: {} });
    assert.ok(event);
    assert.equal(utcDay(event.eventDate), utcDay(aug(5)));
  });

  it("IDEMPOTENCY — a run that persists across days notifies ONCE", () => {
    let lastFiredAt: Date | null = null;
    let notifications = 0;

    const day3 = fireOnce(
      evaluateMwplHigh({
        symbol: "XYZ",
        rows: [{ date: aug(3), utilisationPct: 82 }],
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 3, 20, 0)),
    );
    if (day3.fired) notifications++;
    lastFiredAt = day3.lastFiredAt;

    const day4 = fireOnce(
      evaluateMwplHigh({
        symbol: "XYZ",
        rows: [
          { date: aug(4), utilisationPct: 85 },
          { date: aug(3), utilisationPct: 82 },
        ],
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 4, 20, 0)),
    );
    if (day4.fired) notifications++;

    assert.equal(notifications, 1, "a persisting high run says so once");
  });
});

// ── FII_FLOW_STREAK ─────────────────────────────────────────────────────────

describe("FII_FLOW_STREAK (InstitutionalFlow)", () => {
  const flow = (day: number, net: number): FlowRowLite => ({
    date: aug(day),
    netValue: net,
  });

  it("BOUNDARY — exactly 5 consecutive net-buy days DOES fire (>= 5)", () => {
    const rows = [1, 2, 3, 4, 5].map((d) => flow(d, 500));
    const event = evaluateFiiFlowStreak({
      category: "FII",
      rows,
      tradingDates: augRange(1, 5),
      conditions: {},
    });
    assert.ok(event, ">= 5 is inclusive");
    assert.equal(event.metadata.streakDays, 5);
    assert.equal(event.metadata.direction, "BUY");
    // ₹ crore is NSE's own unit, stored unconverted and NOT rescaled.
    assert.equal(event.metadata.netValueCr, 2500);
    // Crossing date is day 5 — the day the streak reached the threshold.
    assert.equal(utcDay(event.eventDate), utcDay(aug(5)));
  });

  it("BOUNDARY — 4 consecutive days does NOT fire", () => {
    const rows = [1, 2, 3, 4].map((d) => flow(d, 500));
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: augRange(1, 4),
        conditions: {},
      }),
      null,
    );
  });

  it("fires on a net-SELL streak too", () => {
    const rows = [1, 2, 3, 4, 5].map((d) => flow(d, -800));
    const event = evaluateFiiFlowStreak({
      category: "FII",
      rows,
      tradingDates: augRange(1, 5),
      conditions: {},
    });
    assert.ok(event);
    assert.equal(event.metadata.direction, "SELL");
    assert.equal(event.metadata.netValueCr, -4000);
  });

  it("a ZERO net day BREAKS the streak (neither buying nor selling)", () => {
    const rows = [
      flow(1, 500),
      flow(2, 500),
      flow(3, 0),
      flow(4, 500),
      flow(5, 500),
      flow(6, 500),
    ];
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: augRange(1, 6),
        conditions: {},
      }),
      null,
      "2 + 3 is not a 5-day streak",
    );

    const streaks = detectFlowStreaks(rows, augRange(1, 6));
    assert.equal(streaks.length, 2);
    assert.deepEqual(
      streaks.map((s) => s.days.length),
      [2, 3],
    );
  });

  it("a MISSING day BREAKS the streak — a gap is not continuity", () => {
    // 3-Aug is a real publication day (the table holds a DII row for it), but
    // this category has no row. Sorting the category's own rows and calling
    // neighbours consecutive would read 1,2,4,5,6 as a 5-day streak. It is not.
    const rows = [
      flow(1, 500),
      flow(2, 500),
      flow(4, 500),
      flow(5, 500),
      flow(6, 500),
    ];
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: augRange(1, 6),
        conditions: {},
      }),
      null,
      "the 3-Aug hole is a gap, not continuity",
    );

    const streaks = detectFlowStreaks(rows, augRange(1, 6));
    assert.deepEqual(
      streaks.map((s) => s.days.length),
      [2, 3],
    );
  });

  it("a NON-publication day is NOT a gap — Fri -> Mon stays one streak", () => {
    // 3-Aug is simply absent from tradingDates (weekend / holiday), so the
    // sequence 1,2,4,5,6 IS five consecutive observed days.
    const rows = [
      flow(1, 500),
      flow(2, 500),
      flow(4, 500),
      flow(5, 500),
      flow(6, 500),
    ];
    const event = evaluateFiiFlowStreak({
      category: "FII",
      rows,
      tradingDates: [aug(1), aug(2), aug(4), aug(5), aug(6)],
      conditions: {},
    });
    assert.ok(event, "a day nobody published is not a break");
    assert.equal(event.metadata.streakDays, 5);
  });

  it("a calendar jump wider than the backstop breaks the streak anyway", () => {
    // A whole missing week: adjacent in tradingDates, but 8 calendar days apart.
    // InstitutionalFlow is UNBACKFILLABLE, so that is a capture hole.
    const rows = [
      flow(1, 500),
      flow(2, 500),
      flow(3, 500),
      flow(4, 500),
      flow(12, 500),
    ];
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: [aug(1), aug(2), aug(3), aug(4), aug(12)],
        conditions: {},
      }),
      null,
    );
  });

  it("IDEMPOTENCY — a RUNNING streak notifies once, not once per day", () => {
    let lastFiredAt: Date | null = null;
    let notifications = 0;

    // Day 5: the streak reaches 5 and speaks.
    const day5 = fireOnce(
      evaluateFiiFlowStreak({
        category: "FII",
        rows: [1, 2, 3, 4, 5].map((d) => flow(d, 500)),
        tradingDates: augRange(1, 5),
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 5, 21, 0)),
    );
    if (day5.fired) notifications++;
    lastFiredAt = day5.lastFiredAt;
    assert.equal(day5.fired, true);

    // Days 6 and 7 extend the SAME streak. The crossing date is still day 5.
    for (const day of [6, 7]) {
      const run = fireOnce(
        evaluateFiiFlowStreak({
          category: "FII",
          rows: Array.from({ length: day }, (_, i) => flow(i + 1, 500)),
          tradingDates: augRange(1, day),
          conditions: {},
        }),
        lastFiredAt,
        new Date(Date.UTC(2026, 7, day, 21, 0)),
      );
      if (run.fired) notifications++;
      lastFiredAt = run.lastFiredAt;
    }
    assert.equal(notifications, 1, "a running streak is ONE fact");

    // A break, then a NEW 5-day streak, is a new crossing date and speaks.
    const rows: FlowRowLite[] = [
      ...Array.from({ length: 7 }, (_, i) => flow(i + 1, 500)),
      flow(8, -100), // break
      ...[9, 10, 11, 12, 13].map((d) => flow(d, 700)),
    ];
    const restarted = fireOnce(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: augRange(1, 13),
        conditions: {},
      }),
      lastFiredAt,
      new Date(Date.UTC(2026, 7, 13, 21, 0)),
    );
    assert.equal(restarted.fired, true, "a new streak is a new fact");
  });

  it("ignores a STALE streak that no longer runs to the latest observed day", () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((d) => flow(d, 500)),
      flow(6, -100),
      flow(7, -200),
    ];
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: augRange(1, 7),
        conditions: {},
      }),
      null,
      "the 5-day buy streak ended on the 5th; a 2-day sell run is not a signal",
    );
  });

  it("honours a direction filter and a custom minDays", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((d) => flow(d, 500));
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: augRange(1, 6),
        conditions: { directions: ["SELL"] },
      }),
      null,
    );
    const event = evaluateFiiFlowStreak({
      category: "FII",
      rows,
      tradingDates: augRange(1, 6),
      conditions: { minDays: 6 },
    });
    assert.ok(event);
    assert.equal(
      utcDay(event.eventDate),
      utcDay(aug(6)),
      "crossing moves with minDays",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// The I/O SHELL's two reads — structural, because it cannot be imported
// ══════════════════════════════════════════════════════════════════════

/**
 * `alert-evaluator.ts` imports `prisma` at module scope, so pulling it into
 * `node:test` opens a database connection. Its two market-wide reads are
 * nonetheless where the pure evaluators above get their inputs, and each has a
 * failure mode that produces a clean-looking run with a WRONG answer rather
 * than an error. Both are pinned on the source text, comments stripped first so
 * the prose explaining a bug cannot satisfy the check that guards it.
 */
describe("alert-evaluator.ts (I/O shell) reads", () => {
  const SRC = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "processors",
      "alert-evaluator.ts",
    ),
    "utf8",
  )
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("groups flag observations by KIND as well as date", () => {
    // Grouping by `date` alone answers "did the feed publish anything today",
    // and WK52_HIGH_LOW / SHORT_SELLING publish the whole universe every
    // session — so every trading day counts as observed for SURVEILLANCE too,
    // and a family that skipped a day reads as an exit followed by a re-entry.
    assert.match(
      SRC,
      /by:\s*\[\s*"kind"\s*,\s*"date"\s*\]/,
      "the StockFlag groupBy must be by kind AND date; a date-only group is " +
        "the market-wide fail-open that fabricates EXIT/ENTRY pairs",
    );
    assert.doesNotMatch(
      SRC,
      /stockFlag[\s\S]{0,200}?by:\s*\[\s*"date"\s*\]/,
      "a date-only StockFlag groupBy is still present",
    );
  });

  it("cannot let an undatable quarter label displace a real quarter", () => {
    // `normalizeQuarter` stores an unparseable label VERBATIM and upper-cased
    // ("Q1FY26"), and "Q" > "2" in ASCII — so in an `orderBy quarter desc` a
    // verbatim label sorts ABOVE every canonical `YYYY-MM`. With `take: 8` and
    // eight such labels the evaluator sees ZERO datable rows and a real +5.00pp
    // pledge jump is never reported. The same defect is already defended
    // against in packages/research/src/data-sources/db-store.ts.
    assert.match(
      SRC,
      /quarter:\s*\{\s*startsWith:\s*DATABLE_QUARTER_PREFIX\s*\}/,
      "the ShareholdingPattern read must exclude undatable quarter labels " +
        "BEFORE the `take` cap, not after",
    );
  });
});

// ── MONEY-1205 ──────────────────────────────────────────────────────────────

describe("MONEY-1205 · one shape table, and notifications that are not JSON", () => {
  it("derives the shape lists from the SHARED core table, exhaustively", () => {
    // The table moved to `@usemoney/core/market-data/stock-flags` beside the
    // `StockFlagKind` union it is compiler-checked against, because three
    // layers were each deciding shape on their own and two were wrong. What
    // must survive the move is the EXHAUSTIVENESS — it is the only thing that
    // caught `SERIES_CHANGE` being silently unwatched.
    const derived = [...STATE_FLAG_KINDS, ...POINT_EVENT_FLAG_KINDS].sort();
    assert.deepEqual(derived, [...ALL_STOCK_FLAG_KINDS].sort());

    const disposition = [...DEFAULT_FLAG_KINDS, ...OPT_IN_FLAG_KINDS].sort();
    assert.deepEqual(disposition, [...ALL_STOCK_FLAG_KINDS].sort());

    // Every kind appears in EXACTLY one of each pair — no kind can be both or
    // neither, which is what a pair of hand-written string arrays permitted.
    for (const kind of ALL_STOCK_FLAG_KINDS) {
      assert.equal(
        Number(STATE_FLAG_KINDS.includes(kind)) +
          Number(POINT_EVENT_FLAG_KINDS.includes(kind)),
        1,
        `${kind} must be exactly one shape`,
      );
      assert.equal(
        Number(DEFAULT_FLAG_KINDS.includes(kind)) +
          Number(OPT_IN_FLAG_KINDS.includes(kind)),
        1,
        `${kind} must have exactly one disposition`,
      );
    }

    // And the shapes themselves, pinned: these two are POINT and diffing them
    // as states invents a bogus EXIT the day after every real change.
    assert.ok(POINT_EVENT_FLAG_KINDS.includes("BAND_CHANGE"));
    assert.ok(POINT_EVENT_FLAG_KINDS.includes("SERIES_CHANGE"));
    assert.ok(STATE_FLAG_KINDS.includes("SURVEILLANCE"));
    assert.ok(STATE_FLAG_KINDS.includes("FO_BAN"));
  });

  it("never ships raw JSON in the notification text", () => {
    // A price-band alert read `{"band":"5"} → {"band":"10"}`. The detail is now
    // built with the SAME decoder the stock page, /v1 and research use.
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows: [
        { date: aug(4), kind: "PRICE_BAND", value: '{"band":"5"}' },
        { date: aug(5), kind: "PRICE_BAND", value: '{"band":"10"}' },
      ],
      observations: published("PRICE_BAND", augRange(4, 5)),
      conditions: { kinds: ["PRICE_BAND"] },
    });
    assert.ok(event);
    assert.ok(
      !event.message.includes("{") && !event.message.includes('"'),
      `JSON leaked into the notification: ${event.message}`,
    );
    assert.match(event.message, /5% band → 10% band/);
    // METADATA keeps the raw values — it is machine-readable provenance, not
    // user-facing text, and a consumer must be able to re-decode it later.
    assert.equal(event.metadata.from, '{"band":"5"}');
    assert.equal(event.metadata.to, '{"band":"10"}');
  });

  it("does not append `%` to the word `No Band`", () => {
    // NSE publishes `No Band` for F&O names; 208 stocks carried it on
    // 2026-08-17. `${to}%` rendered "No Band%".
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows: [
        { date: aug(4), kind: "PRICE_BAND", value: '{"band":"5"}' },
        { date: aug(5), kind: "PRICE_BAND", value: '{"band":"No Band"}' },
      ],
      observations: published("PRICE_BAND", augRange(4, 5)),
      conditions: { kinds: ["PRICE_BAND"] },
    });
    assert.ok(event);
    assert.ok(!event.message.includes("Band%"), event.message);
    assert.match(event.message, /5% band → no price band \(F&O\)/);
  });

  it("keeps a SURVEILLANCE code byte-identical in the notification", () => {
    // The verbatim-storage rule survives the decoder: NSE's wording is what a
    // user sees, so a better decode table can still improve old rows.
    const event = evaluateFlagTransition({
      symbol: "XYZ",
      rows: [{ date: aug(5), kind: "SURVEILLANCE", value: "GSM STAGE - I" }],
      observations: published("SURVEILLANCE", augRange(4, 5)),
      conditions: { kinds: ["SURVEILLANCE"] },
    });
    assert.ok(event);
    assert.match(event.message, /GSM STAGE - I/);
  });
});
