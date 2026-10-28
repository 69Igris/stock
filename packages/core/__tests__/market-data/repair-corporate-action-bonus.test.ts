/**
 * The decisions inside `scripts/data/repair-corporate-action-bonus.ts`:
 * MONEY-1542.
 *
 * That script inserts the BONUS row NSE's split-and-bonus subjects lost: 31
 * rows on prod. This file runs what it inserts, what it must not insert, how it
 * is undone, and whether the result composes through the REAL adjustment code
 * to the factor the raw prices show. Fixtures are prod-shaped relaxed EJSON
 * and the subjects are real prod subjects.
 *
 * ## Mutation log
 *
 * Every case below was run against a deliberately broken source and confirmed
 * red before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAdjustmentTimeline } from "../../src/market-data/price-adjust";

/** Dynamic, as `vendor-fundamentals-snapshot.test.ts` explains. */
const {
  BACKUP_COLLECTION,
  REPAIR_SOURCE,
  planBonusRepair,
  simulateBonusRepair,
  planBonusRestore,
} =
  (await import("../../../../scripts/data/repair-corporate-action-bonus-logic")) as typeof import("../../../../scripts/data/repair-corporate-action-bonus-logic");

type RawDoc = Record<string, unknown>;

const NOW = new Date("2026-09-23T06:00:00.000Z");
const at = (iso: string) => ({ $date: iso });
const TITAN = "Bonus 1:1 / Face Value Split From Rs.10/- To Re.1/-";
const SECURKLOUD =
  " Bonus 1:3/Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share";

let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, "0");
function ids(): () => string {
  let n = 0xa000;
  return () => (++n).toString(16).padStart(24, "0");
}

/** TITAN's NSE SPLIT row as prod holds it, before the MONEY-1530 re-anchor. */
function split(over: RawDoc = {}): RawDoc {
  return {
    _id: { $oid: oid() },
    symbol: "TITAN",
    isin: null,
    exchange: "NSE",
    type: "SPLIT",
    exDate: at("2011-06-22T18:30:00Z"),
    recordDate: at("2011-06-23T18:30:00Z"),
    ratio: 10,
    oldFaceValue: 10,
    newFaceValue: 1,
    dividendPerShare: null,
    source: "NSE",
    details: TITAN,
    gcsPath: null,
    createdAt: at("2026-08-12T09:23:27.013Z"),
    updatedAt: at("2026-08-12T19:07:36.219Z"),
    ...over,
  };
}
function bse(type: string, ratio: number, over: RawDoc = {}): RawDoc {
  return split({
    exchange: "BSE",
    type,
    ratio,
    oldFaceValue: null,
    newFaceValue: null,
    source: "BSE",
    details: type === "BONUS" ? "Bonus issue 1:1" : "Stock  Split",
    ...over,
  });
}

/** The cumulative factor the real adjustment applies before every event. */
function factor(rows: readonly RawDoc[]): number {
  const t = buildAdjustmentTimeline(
    rows.map((r) => ({
      type: String(r.type),
      exDate: new Date((r.exDate as { $date: string }).$date),
      ratio: r.ratio as number | null,
      source: r.source as string | null,
      details: r.details,
    })),
  );
  return t.steps[0]?.factor ?? 1;
}

describe("planBonusRepair inserts the BONUS the subject names", () => {
  // Mutation: drop the `createdAt` copy (stamp NOW) -> RED; ratio from the
  // split (10) -> RED; `source: "NSE"` -> RED.
  it("copies the event from the SPLIT row and leaves the SPLIT alone", () => {
    const row = split();
    const plan = planBonusRepair([row], NOW, ids());
    assert.equal(plan.inserts.length, 1);
    assert.deepEqual(plan.inserts[0]!.doc, {
      _id: { $oid: "00000000000000000000a001" },
      symbol: "TITAN",
      isin: null,
      exchange: "NSE",
      type: "BONUS",
      exDate: row.exDate,
      recordDate: row.recordDate,
      ratio: 2,
      oldFaceValue: null,
      newFaceValue: null,
      dividendPerShare: null,
      source: REPAIR_SOURCE,
      details: TITAN,
      gcsPath: null,
      createdAt: row.createdAt,
      updatedAt: at(NOW.toISOString()),
    });
    assert.equal(REPAIR_SOURCE, "NSE_REPARSE");
    assert.equal(BACKUP_COLLECTION, "corporate_actions_money1542_backup");
  });

  // Mutation: the inserted `type: "SPLIT"` (a same-type twin collapses into
  // the split) -> RED at 10; ratio 1 -> RED at 10.
  it("TITAN:NSE composes to 10 x 2 = 20 through the real adjustment", () => {
    const before = [split()];
    const after = simulateBonusRepair(
      before,
      planBonusRepair(before, NOW, ids()),
    );
    assert.equal(factor(before), 10);
    assert.equal(factor(after), 20);
  });

  // Mutation: the inserted exDate moved 4 days (out of the same-event window)
  // -> RED at 40, BSE's bonus and ours both applied.
  it("with BSE's own BONUS beside it, the chart still applies the bonus ONCE", () => {
    const rows = [split(), bse("BONUS", 2), bse("SPLIT", 10)];
    const plan = planBonusRepair(rows, NOW, ids());
    assert.equal(plan.inserts.length, 1, "gold's NSE series still needs it");
    assert.deepEqual(plan.inserts[0]!.twin, { exchange: "BSE", ratio: 2 });
    assert.equal(factor(rows), 20);
    assert.equal(factor(simulateBonusRepair(rows, plan)), 20);
  });

  // Mutation: compare ratios with `===` -> RED (refused: BSE stores
  // 1.333333333333333 where the parse gives 1.3333333333333333).
  it("a BSE twin at 15 significant digits is the SAME ratio", () => {
    const rows = [
      split({ symbol: "SECURKLOUD", details: SECURKLOUD, ratio: 2 }),
      bse("BONUS", 1.333333333333333, { symbol: "SECURKLOUD" }),
    ];
    const plan = planBonusRepair(rows, NOW, ids());
    assert.equal(plan.refused.length, 0);
    assert.equal(plan.inserts[0]!.ratio, 4 / 3);
  });
});

describe("planBonusRepair does not insert", () => {
  // Mutation: key the existing BONUS on the exact instant, not the IST day ->
  // RED (a second BONUS for one event, 00:00Z beside 18:30Z).
  it("where the listing already has a BONUS that IST day, at either anchor", () => {
    const rows = [
      split(),
      split({
        type: "BONUS",
        ratio: 2,
        exDate: at("2011-06-23T00:00:00Z"),
        details: "Bonus 1:1",
      }),
    ];
    const plan = planBonusRepair(rows, NOW, ids());
    assert.equal(plan.inserts.length, 0);
    assert.deepEqual(plan.present, [
      { key: "TITAN|NSE|2011-06-23", stored: 2, parsed: 2 },
    ]);
  });

  // Mutation: drop the OTHER_EXCHANGE_DISAGREES branch -> RED.
  it("where another exchange files that day's BONUS at a different ratio", () => {
    const plan = planBonusRepair([split(), bse("BONUS", 1.5)], NOW, ids());
    assert.equal(plan.inserts.length, 0);
    assert.deepEqual(plan.refused, [
      {
        key: "TITAN|NSE|2011-06-23",
        reason: "OTHER_EXCHANGE_DISAGREES",
        parsed: 2,
        twins: ["BSE 1.5"],
      },
    ]);
  });

  // Mutation: drop the NSE-source guard -> RED.
  it("from a row the NSE writer did not produce", () => {
    const plan = planBonusRepair(
      [split({ exchange: "BSE", source: "BSE" })],
      NOW,
      ids(),
    );
    assert.equal(plan.inserts.length, 0);
  });

  // Mutation: drop the `bonuses.set` after planning an insert -> RED (two).
  it("twice, when one split is stored at both time anchors", () => {
    const rows = [split(), split({ exDate: at("2011-06-23T00:00:00Z") })];
    assert.equal(planBonusRepair(rows, NOW, ids()).inserts.length, 1);
  });

  // Mutation: the inserted row's `exchange: "BSE"` -> RED (never "present").
  it("again: the plan converges", () => {
    const rows = [split(), bse("BONUS", 2)];
    const plan = planBonusRepair(rows, NOW, ids());
    const again = planBonusRepair(simulateBonusRepair(rows, plan), NOW, ids());
    assert.equal(again.inserts.length, 0);
    assert.equal(again.present.length, 1);
  });
});

describe("planBonusRestore", () => {
  const inserted = (): RawDoc => {
    const plan = planBonusRepair([split()], NOW, ids());
    return plan.inserts[0]!.doc;
  };
  const idOf = (d: RawDoc) => (d._id as { $oid: string }).$oid;

  // Mutation: compare `updatedAt` as JSON -> RED ($runCommandRaw may return
  // "…06:00:00Z" for a value written as "…06:00:00.000Z": one instant).
  it("deletes a row still as inserted, whatever the date's spelling", () => {
    const doc = inserted();
    const current = new Map([
      [idOf(doc), { ...doc, updatedAt: at("2026-09-23T06:00:00Z") }],
    ]);
    const plan = planBonusRestore(
      [{ _id: doc._id, doc, role: "INSERTED" }],
      current,
    );
    assert.deepEqual(plan.ops, [
      {
        id: idOf(doc),
        expect: { source: REPAIR_SOURCE, updatedAt: doc.updatedAt },
        set: {},
      },
    ]);
  });

  // Mutation: drop the changed-since check -> RED (NSE's own merged filing
  // would be deleted).
  it("keeps a row an NSE re-walk has merged into, and lists a gone one", () => {
    const merged = inserted();
    const gone = { ...inserted(), _id: { $oid: "00000000000000000000beef" } };
    const current = new Map([
      [
        idOf(merged),
        {
          ...merged,
          source: `NSE+${REPAIR_SOURCE}`,
          updatedAt: at("2026-10-01T23:00:00Z"),
        },
      ],
    ]);
    const plan = planBonusRestore(
      [
        { _id: merged._id, doc: merged, role: "INSERTED" },
        { _id: gone._id, doc: gone, role: "INSERTED" },
      ],
      current,
    );
    assert.deepEqual(plan.ops, []);
    assert.deepEqual(plan.changedSince, [idOf(merged)]);
    assert.deepEqual(plan.gone, [idOf(gone)]);
  });
});
