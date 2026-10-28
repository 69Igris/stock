/**
 * The decisions inside `scripts/data/repair-corporate-action-dividends.ts` —
 * MONEY-1535.
 *
 * That script writes `dividendPerShare` on ~14,000 prod rows, so what it may
 * change, what it must leave alone and how it comes back are executed here
 * against prod-shaped relaxed EJSON (`{ $oid }`, `{ $date: "…Z" }`, plain
 * numbers). The subjects are real prod subjects.
 *
 * ## Mutation log
 *
 * Every case below was run against a deliberately broken source and confirmed
 * red before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Dynamic, as `vendor-fundamentals-snapshot.test.ts` explains. */
const {
  BACKUP_COLLECTION,
  legacyDividendPerShare,
  planDividendRepair,
  simulateDividendRepair,
  planDividendRestore,
} =
  (await import("../../../../scripts/data/repair-corporate-action-dividends-logic")) as typeof import("../../../../scripts/data/repair-corporate-action-dividends-logic");

type RawDoc = Record<string, unknown>;

const NOW = new Date("2026-09-23T06:00:00.000Z");
const at = (iso: string) => ({ $date: iso });
const SUDARSCHEM =
  "TDS Communication To Shareholders 6 Aug - Final dividend Rs. 5/share for FY26, record date 11 Aug 2026, AGM 18 Aug 2026.";
const KCP =
  "Intimation Regarding The Annual General Meeting 10 Jul - 85th AGM on 3 Aug 2026; book closure 28 Jul-3 Aug; dividend record date 27 Jul, payable from 20 Aug.";

let seq = 0;
function doc(over: RawDoc = {}): RawDoc {
  seq += 1;
  return {
    _id: { $oid: seq.toString(16).padStart(24, "0") },
    symbol: "HAVELLS",
    exchange: "BSE",
    type: "DIVIDEND",
    exDate: at("2026-05-22T00:00:00Z"),
    dividendPerShare: null,
    source: "BSE",
    details: "Final Dividend - Rs. - 6.0000",
    updatedAt: at("2026-08-12T09:00:00Z"),
    ...over,
  };
}
const idOf = (d: RawDoc): string => (d._id as { $oid: string }).$oid;

describe("legacyDividendPerShare — recognises what the old parser wrote", () => {
  // Mutation: give the legacy copy the FIXED `\b` -> RED (it would no longer
  // reproduce the two wrong prod values, so the repair could not recognise
  // them as the parser's own and would leave them as "unattributed").
  it("reproduces the two wrong prod values", () => {
    assert.equal(legacyDividendPerShare(SUDARSCHEM), 6);
    assert.equal(legacyDividendPerShare(KCP), 28);
  });
});

describe("planDividendRepair", () => {
  // Mutation: skip the FILL branch -> RED.
  it("FILLS a null the subject states an amount for (BSE's dash spelling)", () => {
    const row = doc();
    const plan = planDividendRepair([row], NOW);
    assert.deepEqual(plan.ops, [
      {
        id: idOf(row),
        expect: { dividendPerShare: null, updatedAt: row.updatedAt },
        set: { dividendPerShare: 6, updatedAt: at(NOW.toISOString()) },
      },
    ]);
    assert.deepEqual(plan.backup, [
      { id: idOf(row), role: "FILL", doc: row, wrote: { dividendPerShare: 6 } },
    ]);
  });

  // Mutation: CORRECT without the legacy check (any disagreement) -> RED on
  // the "left alone" case below instead; here, dropping the CORRECT branch -> RED.
  it("CORRECTS the old parser's value, to the new one or to null", () => {
    const sud = doc({
      symbol: "SUDARSCHEM",
      exchange: "NSE",
      source: "NSE+SCREENER",
      details: SUDARSCHEM,
      dividendPerShare: 6,
    });
    const kcp = doc({
      symbol: "KCP",
      exchange: "NSE",
      source: "SCREENER",
      details: KCP,
      dividendPerShare: 28,
    });
    const plan = planDividendRepair([sud, kcp], NOW);
    assert.deepEqual(
      plan.changes.map((c) => [c.fix, c.from, c.to]),
      [
        ["CORRECT", 6, 5],
        ["CORRECT", 28, null],
      ],
    );
  });

  // Mutation: treat every disagreement as CORRECT (drop the legacy match) ->
  // RED: NESTLEIND's 5 would be overwritten with the sibling's 2.
  it("leaves a value neither parser derives from the stored subject", () => {
    const nestle = doc({
      symbol: "NESTLEIND",
      exchange: "NSE",
      source: "NSE",
      details: "Special Dividend - Rs 2 Per Share",
      dividendPerShare: 5,
    });
    const plan = planDividendRepair([nestle], NOW);
    assert.equal(plan.ops.length, 0);
    assert.deepEqual(
      plan.unattributed.map((u) => [u.stored, u.parsed]),
      [[5, 2]],
    );
  });

  // Mutation: drop the `unread.length === 0` guard -> RED (the stored 4 is
  // "corrected" to null). Since MONEY-1603 the parser returns null when a
  // dividend clause holds a rupee amount it cannot account for; that is
  // "cannot read it", not "there is none", and a re-run must not erase a value.
  it("never corrects a stored amount to an UNREADABLE null, but still to a definite one", () => {
    const stray = doc({
      symbol: "SOMECO",
      exchange: "NSE",
      source: "NSE",
      details: "Final Dividend Rs 4 And Rs 2 Payable Later",
      dividendPerShare: 4,
    });
    const kcp = doc({
      symbol: "KCP",
      exchange: "NSE",
      source: "SCREENER",
      details: KCP,
      dividendPerShare: 28,
    });
    const plan = planDividendRepair([stray, kcp], NOW);
    assert.deepEqual(
      plan.changes.map((c) => [c.key.split("|")[0], c.fix, c.from, c.to]),
      [["KCP", "CORRECT", 28, null]],
    );
    assert.deepEqual(
      plan.unattributed.map((u) => [u.key.split("|")[0], u.stored, u.parsed]),
      [["SOMECO", 4, null]],
    );
  });

  // Mutation: drop the DIVIDEND gate -> RED (the bonus row gets 2).
  it("touches only DIVIDEND rows, and refuses one with no field at all", () => {
    const bonus = doc({
      type: "BONUS",
      details: "Bonus 1:1 & Dividend Rs 2 Per Share",
    });
    const noField = doc();
    delete noField.dividendPerShare;
    const plan = planDividendRepair([bonus, noField], NOW);
    assert.equal(plan.ops.length, 0);
    assert.deepEqual(plan.refusedNoField, [idOf(noField)]);
  });

  it("a row that is already right is not planned", () => {
    const plan = planDividendRepair([doc({ dividendPerShare: 6 })], NOW);
    assert.equal(plan.ops.length, 0);
  });

  // Mutation: set the LEGACY value instead of the new one -> RED (the re-plan
  // finds every row again).
  it("a second run finds nothing to do", () => {
    const docs = [
      doc(),
      doc({ details: SUDARSCHEM, dividendPerShare: 6 }),
      doc({ details: KCP, dividendPerShare: 28 }),
    ];
    const plan = planDividendRepair(docs, NOW);
    assert.equal(plan.ops.length, 3);
    const again = planDividendRepair(simulateDividendRepair(docs, plan), NOW);
    assert.equal(again.ops.length, 0);
    assert.equal(BACKUP_COLLECTION, "corporate_actions_money1535_backup");
  });
});

describe("planDividendRestore — field-level, and only over what it wrote", () => {
  function backed(row: RawDoc, wrote: number | null) {
    return {
      _id: row._id,
      doc: row,
      role: "FILL",
      wrote: { dividendPerShare: wrote },
    };
  }

  // Mutation: drop the "still holds what was written" check -> RED (the row
  // the nightly changed since would be overwritten with the old value).
  it("puts back the value and updatedAt only where the repair's value is still there", () => {
    const a = doc();
    const b = doc();
    const c = doc();
    const current = new Map<string, RawDoc>([
      [idOf(a), { ...a, dividendPerShare: 6 }],
      [idOf(b), { ...b, dividendPerShare: 9 }], // changed since
    ]); // c is gone
    const plan = planDividendRestore(
      [backed(a, 6), backed(b, 6), backed(c, 6)],
      current,
    );
    assert.deepEqual(plan.ops, [
      {
        id: idOf(a),
        expect: { dividendPerShare: 6 },
        set: { dividendPerShare: null, updatedAt: a.updatedAt },
      },
    ]);
    assert.deepEqual(plan.changedSince, [idOf(b)]);
    assert.deepEqual(plan.gone, [idOf(c)]);
  });
});
