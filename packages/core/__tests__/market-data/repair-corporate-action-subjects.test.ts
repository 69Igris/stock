/**
 * The decisions inside `scripts/data/repair-corporate-action-subjects.ts`:
 * MONEY-1598 (split ratios the face-value parser could not read), MONEY-1599
 * (dropped dividend legs, bonuses of no shares) and MONEY-1603 (dividend
 * amounts: the "Div" abbreviation, and two dividends in one subject).
 *
 * The script writes 162 prod rows and inserts 56. This file runs what it
 * changes, what it must leave, how it is undone, and whether a retype moves the
 * REAL adjustment as the prices say it should. Fixtures are prod-shaped relaxed
 * EJSON and the subjects are real prod subjects.
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
const { planDividendRepair, simulateDividendRepair } =
  (await import("../../../../scripts/data/repair-corporate-action-dividends-logic")) as typeof import("../../../../scripts/data/repair-corporate-action-dividends-logic");
const {
  BACKUP_COLLECTION,
  backupStatements,
  planSubjectRepair,
  simulateSubjectRepair,
  planSubjectRestore,
} =
  (await import("../../../../scripts/data/repair-corporate-action-subjects-logic")) as typeof import("../../../../scripts/data/repair-corporate-action-subjects-logic");

type RawDoc = Record<string, unknown>;

const NOW = new Date("2026-09-23T06:00:00.000Z");
const STAMP = { $date: NOW.toISOString() };
const at = (iso: string) => ({ $date: iso });

let seq = 0;
function ids(): () => string {
  let n = 0xb000;
  return () => (++n).toString(16).padStart(24, "0");
}
const idOf = (d: RawDoc) => (d._id as { $oid: string }).$oid;

/** An NSE row as prod holds it after the MONEY-1530 re-anchor. */
function row(over: RawDoc): RawDoc {
  seq += 1;
  return {
    _id: { $oid: seq.toString(16).padStart(24, "0") },
    symbol: "EKC",
    isin: null,
    exchange: "NSE",
    type: "SPLIT",
    exDate: at("2007-08-21T00:00:00Z"),
    recordDate: null,
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: null,
    source: "NSE",
    details: "Fv Split Rs.10/- To Rs.2/",
    gcsPath: null,
    createdAt: at("2026-08-12T09:23:27.013Z"),
    updatedAt: at("2026-09-23T09:22:35.661Z"),
    ...over,
  };
}
const plan = (docs: RawDoc[]) => planSubjectRepair(docs, NOW, ids());
const roles = (docs: RawDoc[]) => plan(docs).changes.map((c) => c.role);

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

describe("MONEY-1598: split ratios", () => {
  // Mutation: skip the SPLIT_FILL branch -> RED.
  it("fills a null ratio, and the face values, compare-and-set", () => {
    const r = row({});
    const p = plan([r]);
    assert.deepEqual(p.updates, [
      {
        id: idOf(r),
        expect: {
          updatedAt: r.updatedAt,
          ratio: null,
          oldFaceValue: null,
          newFaceValue: null,
        },
        set: { ratio: 5, oldFaceValue: 10, newFaceValue: 2, updatedAt: STAMP },
      },
    ]);
    assert.deepEqual(roles([r]), ["SPLIT_FILL"]);
    assert.equal(
      BACKUP_COLLECTION,
      "corporate_actions_money1598_1599_1603_backup",
    );
  });

  // Mutation: skip the SPLIT_CORRECT branch -> RED.
  it("corrects JBMA's 1, which was its bonus's ratio, to its face value's 2", () => {
    const r = row({
      symbol: "JBMA",
      ratio: 1,
      details: "Bonus 1:1 And Face Value Split Rs.10/- To Rs.5/- Per Share",
    });
    const c = plan([r]).changes;
    assert.deepEqual(
      c.map((x) => [x.role, x.from, x.to]),
      [["SPLIT_CORRECT", 1, 2]],
    );
  });

  // Mutation: correct on ANY parsed ratio (drop the parseFaceValueSplit guard)
  // -> RED: a token-only ratio would overwrite a stored one.
  it("never corrects a stored ratio from an a:b token alone", () => {
    const r = row({ ratio: 2, details: "Stock Split 1:5" });
    const p = plan([r]);
    assert.deepEqual(p.updates, []);
    assert.deepEqual(p.unattributed, [
      { key: "EKC|NSE|2007-08-21", stored: 2, parsed: 5 },
    ]);
  });

  it("leaves ASHOKA's 2 alone: its face value says 2 as well", () => {
    const r = row({
      symbol: "ASHOKA",
      ratio: 2,
      details: "Bonus 1:2 And Face Value Split Rs.10/- To Rs.5/-",
    });
    const p = plan([r]);
    assert.deepEqual(p.updates, []);
    assert.deepEqual(p.confirmed, ["ASHOKA|NSE|2007-08-21"]);
  });

  // Mutation: drop the fromNse guard -> RED.
  it("only re-reads rows the NSE writer produced", () => {
    assert.deepEqual(roles([row({ source: "BSE", exchange: "BSE" })]), []);
    assert.deepEqual(roles([row({ source: "DERIVED" })]), []);
  });
});

describe("MONEY-1599: a bonus of no shares", () => {
  const ZEEL = () =>
    row({
      symbol: "ZEEL",
      type: "BONUS",
      ratio: 22,
      exDate: at("2014-03-03T00:00:00Z"),
      details: "Bonus Preference Shares 21:1",
    });

  // Mutation: skip the RETYPE branch -> RED (and ZEEL stays at 22).
  it("ZEEL's BONUS 22 becomes OTHER, and stops dividing the history by 22", () => {
    const r = ZEEL();
    const p = plan([r]);
    assert.deepEqual(p.updates, [
      {
        id: idOf(r),
        expect: { updatedAt: r.updatedAt, type: "BONUS", ratio: 22 },
        set: { type: "OTHER", ratio: null, updatedAt: STAMP },
      },
    ]);
    assert.equal(factor([r]), 22);
    assert.equal(factor(simulateSubjectRepair([r], p)), 1);
  });

  // Mutation: retype when the PRIMARY type is not BONUS
  // (`parseActionSubject(subject).type !== "BONUS"`) -> RED: MONEY-1542's
  // BONUS row, whose subject is a split's, would be retyped SPLIT.
  it("keeps a BONUS whose subject names a share bonus beside a split", () => {
    const details = "Bonus 1:1 / Face Value Split From Rs.10/- To Re.1/-";
    const bonus = row({ symbol: "TITAN", type: "BONUS", ratio: 2, details });
    const split = row({
      symbol: "TITAN",
      ratio: 10,
      oldFaceValue: 10,
      newFaceValue: 1,
      details,
    });
    assert.deepEqual(roles([bonus, split]), []);
  });

  // Mutation: drop the target-key check -> RED (the update would collide on
  // the unique key at write time).
  it("refuses when an OTHER row already holds that day", () => {
    const other = row({
      symbol: "ZEEL",
      type: "OTHER",
      exDate: at("2014-03-03T00:00:00Z"),
      details: "Something else",
    });
    const p = plan([ZEEL(), other]);
    assert.deepEqual(p.updates, []);
    assert.deepEqual(p.refused, [
      { key: "ZEEL|NSE|2014-03-03", reason: "RETYPE_TARGET_TAKEN OTHER" },
    ]);
  });
});

describe("MONEY-1599: the dividend a combined subject dropped", () => {
  const TCS = (over: RawDoc = {}) =>
    row({
      symbol: "TCS",
      type: "BONUS",
      ratio: 2,
      exDate: at("2018-05-31T00:00:00Z"),
      recordDate: at("2018-06-01T00:00:00Z"),
      details: " Bonus 1:1 /Dividend- Rs 29 Per Share",
      ...over,
    });

  // Mutation: dividendPerShare null -> RED; `source: "NSE"` -> RED; stamp
  // createdAt NOW -> RED.
  it("inserts it from the row's own subject, marked as a re-parse", () => {
    const r = TCS();
    const p = plan([r]);
    assert.deepEqual(p.inserts, [
      {
        _id: { $oid: "00000000000000000000b001" },
        symbol: "TCS",
        isin: null,
        exchange: "NSE",
        type: "DIVIDEND",
        exDate: r.exDate,
        recordDate: r.recordDate,
        ratio: null,
        oldFaceValue: null,
        newFaceValue: null,
        dividendPerShare: 29,
        source: "NSE_REPARSE",
        details: r.details,
        gcsPath: null,
        createdAt: r.createdAt,
        updatedAt: STAMP,
      },
    ]);
    assert.deepEqual(p.backup[0]!.role, "DIVIDEND_INSERT");
  });

  // Mutation: key the existing DIVIDEND on the exact instant -> RED.
  it("not where the listing already has a DIVIDEND that IST day, at either anchor", () => {
    const div = TCS({
      type: "DIVIDEND",
      ratio: null,
      dividendPerShare: 29,
      exDate: at("2018-05-30T18:30:00Z"),
      details: "Dividend - Rs 29 Per Share",
    });
    const p = plan([TCS(), div]);
    assert.deepEqual(p.inserts, []);
    assert.deepEqual(p.legPresent, [
      { key: "TCS|NSE|2018-05-31", type: "DIVIDEND", stored: 29, parsed: 29 },
    ]);
  });

  // Mutation: the slot key without the exchange -> RED (BSE's own dividend
  // would suppress the NSE listing's, and gold's NSE series reads only NSE's).
  it("still inserts where only BSE files that day's dividend", () => {
    const bse = TCS({
      exchange: "BSE",
      source: "BSE",
      type: "DIVIDEND",
      ratio: null,
      dividendPerShare: 29,
      details: "Final Dividend - Rs. - 29.0000",
    });
    assert.equal(plan([TCS(), bse]).inserts.length, 1);
  });

  // Mutation: drop `taken.set(target, row)` after an insert -> RED (two).
  it("once per event when two NSE rows carry the subject", () => {
    const split = row({
      symbol: "KCP",
      ratio: 10,
      oldFaceValue: 10,
      newFaceValue: 1,
      exDate: at("2010-09-02T00:00:00Z"),
      details:
        "1st Interim Dividend Rs.2.50 Per Share And Face Value Split From Rs.10/- To Re.1/- (Purpose Revised)",
    });
    const twin = { ...split, _id: { $oid: "0000000000000000000000ff" } };
    assert.equal(plan([split, twin]).inserts.length, 1);
  });
});

describe("MONEY-1603: dividend amounts", () => {
  const div = (over: RawDoc) =>
    row({
      symbol: "ASHAPURMIN",
      type: "DIVIDEND",
      exDate: at("2021-09-21T00:00:00Z"),
      details: " Div - Rs 0.50 Per Sh",
      ...over,
    });
  const TWO =
    " Annual General Meeting/ Final Dividend - Rs 7/- + Special Dividend -Rs 3/- Per Share";

  // Mutation: skip the DIVIDEND_FILL branch -> RED.
  it("fills a null the 'Div' abbreviation names an amount for", () => {
    const r = div({});
    const p = plan([r]);
    assert.deepEqual(p.updates, [
      {
        id: idOf(r),
        expect: { updatedAt: r.updatedAt, dividendPerShare: null },
        set: { dividendPerShare: 0.5, updatedAt: STAMP },
      },
    ]);
    assert.deepEqual(roles([r]), ["DIVIDEND_FILL"]);
  });

  // Mutation: skip the DIVIDEND_CORRECT branch -> RED.
  it("corrects the one amount the old parser kept to the sum of both", () => {
    const c = plan([div({ dividendPerShare: 3, details: TWO })]).changes;
    assert.deepEqual(
      c.map((x) => [x.role, x.from, x.to]),
      [["DIVIDEND_CORRECT", 3, 10]],
    );
  });

  // Mutation: drop the `ours` attribution check -> RED (NESTLEIND 2026-07-10
  // stores 5, merged from another subject; its own says 2).
  it("leaves an amount no parser of ours read from this subject", () => {
    const r = div({
      symbol: "NESTLEIND",
      dividendPerShare: 5,
      details: "Dividend - Rs 2 Per Share",
    });
    const p = plan([r]);
    assert.deepEqual(p.updates, []);
    assert.deepEqual(p.dividendUnattributed, [
      { key: "NESTLEIND|NSE|2021-09-21", stored: 5, parsed: 2 },
    ]);
  });

  // Mutation: drop the `namedDividendAmounts(...).length > 0` guard -> RED.
  // Constructed: the stored 55 is what the previous parser read (the rights
  // premium), and the new value comes only from the unbound fallback, so the
  // correction is not unambiguous. No prod row has this shape.
  it("never corrects from an amount no dividend word names", () => {
    const r = div({
      dividendPerShare: 55,
      details: "Rights 7:5@Premium Rs.55 Per Share/Dividend @ Re.1 Per Share",
    });
    const p = plan([r]);
    assert.deepEqual(p.updates, []);
    assert.equal(p.dividendUnattributed.length, 1);
  });

  // Mutation: fromFeed as NSE only -> RED (the Screener row is skipped).
  it("re-reads every feed's dividend, Screener's included", () => {
    const r = div({
      symbol: "KCP",
      source: "SCREENER",
      dividendPerShare: 0.48,
      details:
        "Board Meeting Outcome for Outcome Of Board Meeting Held Today 3Rd August 2026 3 Aug - Q1 FY27 results approved; standalone profit Rs0.48 crore, consolidated profit Rs55.75 crore; interim dividend Re0.50; new businesses approved.",
    });
    assert.deepEqual(
      plan([r]).changes.map((x) => [x.role, x.from, x.to]),
      [["DIVIDEND_CORRECT", 0.48, 0.5]],
    );
  });

  // Mutation: treat an NSE_REPARSE row as a feed row -> RED.
  it("leaves the MONEY-1599 legs to the repair that wrote them", () => {
    const p = plan([div({ source: "NSE_REPARSE" })]);
    assert.deepEqual([p.changes, p.legsSkipped], [[], 1]);
  });

  // Mutation: write the FIRST named amount instead of parseDividendPerShare's
  // sum -> RED (the row holds 7; both planners then leave it wrong).
  it("MONEY-1535's repair and this one converge on the same value", () => {
    const docs = [
      div({ dividendPerShare: 3, details: TWO }),
      div({ symbol: "SKIL", details: "Agm/Div-Re.1/- Per Share" }),
      row({
        symbol: "KESORAMIND",
        type: "RIGHTS",
        details:
          "Rights 7:5@Premium Rs.55 Per Share/Annual General Meeting / Dividend Re.1/- Per Equity Share (Purpose Revised)",
      }),
    ];
    const ours = simulateSubjectRepair(docs, plan(docs));
    assert.deepEqual(
      ours.filter((d) => d.type === "DIVIDEND").map((d) => d.dividendPerShare),
      [10, 1, 1],
    );
    assert.equal(planDividendRepair(ours, NOW).ops.length, 0);
    const theirs = simulateDividendRepair(docs, planDividendRepair(docs, NOW));
    const again = plan(theirs);
    assert.deepEqual(
      again.changes.map((c) => c.role),
      ["DIVIDEND_INSERT"],
    );
    assert.equal(again.inserts[0]!.dividendPerShare, 1);
  });
});

describe("MONEY-1603 review: the split and bonus NSE abbreviated", () => {
  // Mutation: drop SPLIT from LEG_ROLE -> RED.
  it("EIHOTEL: a BONUS row whose subject also splits gets its SPLIT", () => {
    const r = row({
      symbol: "EIHOTEL",
      type: "BONUS",
      ratio: 1.5,
      exDate: at("2006-09-12T00:00:00Z"),
      details: "Spl-Rs10 To Rs2/Bonus-1:2",
    });
    const p = plan([r]);
    assert.deepEqual(
      p.changes.map((c) => [c.role, c.to]),
      [["SPLIT_INSERT", 5]],
    );
    assert.deepEqual(
      [
        p.inserts[0]!.type,
        p.inserts[0]!.oldFaceValue,
        p.inserts[0]!.newFaceValue,
      ],
      ["SPLIT", 10, 2],
    );
    // NSE's own print falls 812.10 -> 120.85 (6.72x) that day.
    assert.equal(factor([r]), 1.5);
    assert.equal(factor(simulateSubjectRepair([r], p)), 7.5);
  });

  // Mutation: drop BONUS from LEG_ROLE -> RED.
  it("JINDALSTEL: a DIVIDEND row whose subject names a 'Bon' gets its BONUS", () => {
    const r = row({
      symbol: "JINDALSTEL",
      type: "DIVIDEND",
      exDate: at("2009-09-14T00:00:00Z"),
      details: "Div-Rs.5.50 Pr Sh/Bon 5:1purpose Revised",
    });
    assert.deepEqual(
      plan([r]).changes.map((c) => [c.role, c.to]),
      [
        ["DIVIDEND_FILL", 5.5],
        ["BONUS_INSERT", 6],
      ],
    );
  });

  // Mutation: drop the `leg.type === "BONUS" && doc.type === "SPLIT"` skip ->
  // RED: MONEY-1542's bonus would be counted here as well.
  it("a SPLIT row's bonus is left to the MONEY-1542 repair", () => {
    const r = row({
      symbol: "TITAN",
      ratio: 10,
      details: "Bonus 1:1 / Face Value Split From Rs.10/- To Re.1/-",
    });
    assert.deepEqual(roles([r]), []);
  });

  // Mutation: drop the dividendUnread report -> RED. Constructed shape (no
  // prod subject reads unread after the typo fix).
  it("an unreadable dividend is neither filled with a part nor silent", () => {
    const r = row({
      symbol: "X",
      type: "DIVIDEND",
      details: "Dividend - Rs 5 Per Share/Final Rs 3 Per Share",
    });
    const p = plan([r]);
    assert.deepEqual(p.changes, []);
    assert.deepEqual(p.dividendUnread, [
      { key: "X|NSE|2007-08-21", stored: null, unread: ["Rs 3"] },
    ]);
  });
});

describe("convergence and restore", () => {
  const all = () => [
    row({}),
    row({
      symbol: "ZEEL",
      type: "BONUS",
      ratio: 22,
      details: "Bonus Preference Shares 21:1",
    }),
    row({
      symbol: "TCS",
      type: "BONUS",
      ratio: 2,
      details: " Bonus 1:1 /Dividend- Rs 29 Per Share",
    }),
  ];

  // Mutation: the inserted DIVIDEND's `exchange: "BSE"` -> RED.
  it("a second plan over the result finds nothing", () => {
    const docs = all();
    const p = plan(docs);
    assert.equal(p.changes.length, 3);
    assert.equal(plan(simulateSubjectRepair(docs, p)).changes.length, 0);
  });

  // Mutation: compare fields with `===` (not by instant for dates) -> RED.
  it("puts back each written field and deletes each insert, whatever the date spelling", () => {
    const docs = all();
    const p = plan(docs);
    const after = simulateSubjectRepair(docs, p).map((d) => ({
      ...d,
      updatedAt: at("2026-09-23T06:00:00Z"),
    }));
    const current = new Map(after.map((d) => [idOf(d), d]));
    const backup = p.backup.map((b) => ({
      _id: { $oid: b.id },
      doc: b.doc,
      role: b.role,
      wrote: b.wrote,
    }));
    const r = planSubjectRestore(backup, current);
    assert.deepEqual(
      r.updates.map((u) => u.set),
      [
        {
          ratio: null,
          oldFaceValue: null,
          newFaceValue: null,
          updatedAt: docs[0]!.updatedAt,
        },
        { type: "BONUS", ratio: 22, updatedAt: docs[1]!.updatedAt },
      ],
    );
    assert.equal(r.deletes.length, 1);
    assert.deepEqual([r.changedSince, r.gone], [[], []]);
  });

  // Mutation: drop the changed-since check on updates -> RED; on inserts ->
  // RED (an NSE re-walk's merge would be deleted).
  it("keeps rows written to since, and lists rows that are gone", () => {
    const docs = all();
    const p = plan(docs);
    const after = simulateSubjectRepair(docs, p);
    const current = new Map(
      after
        .filter((d) => d.symbol !== "EKC")
        .map((d) =>
          d.type === "OTHER" || d.type === "DIVIDEND"
            ? [idOf(d), { ...d, source: `NSE+${String(d.source)}` }]
            : [idOf(d), d],
        ),
    );
    const backup = p.backup.map((b) => ({
      _id: { $oid: b.id },
      doc: b.doc,
      role: b.role,
      wrote: b.wrote,
    }));
    const zeel = idOf(backup.find((b) => b.role === "RETYPE")!.doc);
    current.set(zeel, { ...current.get(zeel)!, ratio: 3 });
    const r = planSubjectRestore(backup, current);
    assert.deepEqual([r.updates, r.deletes], [[], []]);
    assert.equal(r.changedSince.length, 2);
    assert.deepEqual(r.gone, [idOf(docs[0]!)]);
  });
});

describe("MONEY-1603 review: --restore after a failed run and a re-run", () => {
  /** Mongo's upsert, as far as the backup statements use it. */
  function applyBackup(store: Map<string, RawDoc>, statements: RawDoc[]) {
    for (const st of statements) {
      const id = ((st.q as RawDoc)._id as { $oid: string }).$oid;
      const u = st.u as { $setOnInsert: RawDoc; $set: RawDoc };
      const prev = store.get(id);
      store.set(id, {
        _id: { $oid: id },
        ...(prev ?? u.$setOnInsert),
        ...u.$set,
      });
    }
  }
  const apply = (docs: RawDoc[], ops: Array<{ id: string; set: RawDoc }>) =>
    docs.map((d) => {
      const op = ops.find((o) => o.id === idOf(d));
      return op ? { ...d, ...op.set } : d;
    });

  // Mutation: `wrote` in `$setOnInsert` (as backupVerified does) -> RED: the
  // rows only the re-run wrote read as changed-since and cannot be restored.
  it("restores every row, whichever run wrote it, to the row first read", () => {
    const original = [
      row({ symbol: "A" }),
      row({ symbol: "B" }),
      row({ symbol: "C", type: "DIVIDEND", details: " Int Div-Rs 0.5 Per Sh" }),
    ];
    const store = new Map<string, RawDoc>();
    // Run 1 records all three, then dies after writing the first.
    const run1 = planSubjectRepair(
      original,
      new Date("2026-09-24T01:00:00Z"),
      ids(),
    );
    applyBackup(store, backupStatements(run1.backup, NOW));
    const half = apply(original, run1.updates.slice(0, 1));
    // Run 2 re-plans the other two and writes them with its own stamp.
    const run2 = planSubjectRepair(
      half,
      new Date("2026-09-24T02:00:00Z"),
      ids(),
    );
    assert.equal(run2.updates.length, 2);
    applyBackup(store, backupStatements(run2.backup, NOW));
    const done = apply(half, run2.updates);

    const backup = [...store.values()] as Array<{
      _id: unknown;
      doc: RawDoc;
      role: string;
      wrote: RawDoc;
    }>;
    const r = planSubjectRestore(
      backup,
      new Map(done.map((d) => [idOf(d), d])),
    );
    assert.deepEqual([r.updates.length, r.changedSince], [3, []]);
    const back = apply(done, r.updates);
    assert.deepEqual(back, original);
  });
});

describe("MONEY-1603 re-review: --restore removes every leg it inserted", () => {
  // Mutation: delete only DIVIDEND_INSERT (`b.role === "DIVIDEND_INSERT"`) ->
  // RED: the SPLIT and BONUS legs become empty updates and stay.
  it("apply, then restore, for all three insert roles and a fill", () => {
    const original = [
      row({
        symbol: "EIHOTEL",
        type: "BONUS",
        ratio: 1.5,
        exDate: at("2006-09-12T00:00:00Z"),
        details: "Spl-Rs10 To Rs2/Bonus-1:2",
      }),
      row({
        symbol: "JINDALSTEL",
        type: "DIVIDEND",
        exDate: at("2009-09-14T00:00:00Z"),
        details: "Div-Rs.5.50 Pr Sh/Bon 5:1purpose Revised",
      }),
      row({
        symbol: "TCS",
        type: "BONUS",
        ratio: 2,
        exDate: at("2018-05-31T00:00:00Z"),
        details: " Bonus 1:1 /Dividend- Rs 29 Per Share",
      }),
    ];
    const p = plan(original);
    assert.deepEqual(p.changes.map((c) => c.role).sort(), [
      "BONUS_INSERT",
      "DIVIDEND_FILL",
      "DIVIDEND_INSERT",
      "SPLIT_INSERT",
    ]);
    const applied = simulateSubjectRepair(original, p);
    const backup = p.backup.map((b) => ({
      _id: { $oid: b.id },
      doc: b.doc,
      role: b.role,
      wrote: b.wrote,
    }));
    const r = planSubjectRestore(
      backup,
      new Map(applied.map((d) => [idOf(d), d])),
    );
    assert.deepEqual([r.deletes.length, r.updates.length], [3, 1]);
    const deleted = new Set(r.deletes.map((d) => d.id));
    const back = applied
      .filter((d) => !deleted.has(idOf(d)))
      .map((d) => {
        const u = r.updates.find((x) => x.id === idOf(d));
        return u ? { ...d, ...u.set } : d;
      });
    assert.deepEqual(back, original);
  });

  // Mutation: drop the empty-`wrote` refusal -> RED (it would be planned as an
  // update that sets nothing).
  it("refuses a backup entry that records no write", () => {
    const r = row({});
    assert.throws(
      () =>
        planSubjectRestore(
          [{ _id: r._id, doc: r, role: "SPLIT_FILL", wrote: {} }],
          new Map([[idOf(r), r]]),
        ),
      /records no write/,
    );
  });
});
