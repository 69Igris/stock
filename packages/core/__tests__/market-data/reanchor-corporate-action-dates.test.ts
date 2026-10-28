/**
 * The decisions inside `scripts/data/reanchor-corporate-action-dates.ts` —
 * MONEY-1530.
 *
 * That script REWRITES ~48,000 `corporate_actions` dates on prod and DELETES
 * 1,772 rows, so everything that decides which row lives, which value it
 * keeps, what it moves to, what gets backed up and how it comes back lives in
 * `scripts/data/reanchor-corporate-action-dates-logic.ts` and is executed here.
 *
 * The fixtures are relaxed EJSON exactly as `$runCommandRaw` returned prod
 * documents (measured 2026-09-23): `{ $oid }`, `{ $date: "…Z" }`, plain
 * numbers, and fields ABSENT rather than null on the price-derived rows.
 *
 * ## Mutation log
 *
 * Every case below was run against a deliberately broken source and confirmed
 * red before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * A DYNAMIC import, and it has to be — the boundary
 * `vendor-fundamentals-snapshot.test.ts` documents: `tsx` transpiles a module
 * under `scripts/` to CommonJS, and a static named import resolves its shape
 * against the ESM view at parse time.
 */
const {
  BACKUP_COLLECTION,
  istDayAnchor,
  readDate,
  outranks,
  planReanchor,
  simulateApply,
  planRestore,
} =
  (await import("../../../../scripts/data/reanchor-corporate-action-dates-logic")) as typeof import("../../../../scripts/data/reanchor-corporate-action-dates-logic");

type RawDoc = Record<string, unknown>;

const NOW = new Date("2026-09-23T06:00:00.000Z");
const at = (iso: string) => ({ $date: iso });
const ms = (iso: string) => Date.parse(iso);

let seq = 0;
/** A prod-shaped document: an NSE dividend on 8 Sep 2026, UTC-anchored. */
function doc(over: RawDoc = {}): RawDoc {
  seq += 1;
  return {
    _id: { $oid: seq.toString(16).padStart(24, "0") },
    symbol: "RUSHIL",
    exchange: "NSE",
    type: "DIVIDEND",
    exDate: at("2026-09-08T00:00:00Z"),
    recordDate: at("2026-09-08T00:00:00Z"),
    isin: null,
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: 0.05,
    source: "NSE",
    details: "Dividend - Re 0.05 Per Share",
    gcsPath: null,
    createdAt: at("2026-08-01T00:00:00Z"),
    updatedAt: at("2026-08-01T00:00:00Z"),
    ...over,
  };
}
/** The same event as the IST backfill stored it: 18:30Z the day before. */
function istTwin(over: RawDoc = {}): RawDoc {
  return doc({
    exDate: at("2026-09-07T18:30:00Z"),
    recordDate: at("2026-09-07T18:30:00Z"),
    createdAt: at("2026-08-12T09:00:00Z"),
    updatedAt: at("2026-08-12T09:00:00Z"),
    ...over,
  });
}
const idOf = (d: RawDoc): string => (d._id as { $oid: string }).$oid;

/** No two documents may share the unique key once the plan is applied. */
function uniqueKeys(docs: readonly RawDoc[]): boolean {
  const keys = docs.map((d) =>
    [d.symbol, d.exchange, d.type, readDate(d.exDate)].join("|"),
  );
  return new Set(keys).size === keys.length;
}

describe("istDayAnchor — only the two anchors measured on prod", () => {
  // Mutation: drop the ANCHORS gate (IST day of ANY instant) -> RED on the
  // third and fourth: a Tokyo 15:00Z would be "anchored" to the day BEFORE.
  it("18:30Z moves to the next UTC midnight", () => {
    assert.equal(
      istDayAnchor(ms("2026-09-07T18:30:00Z")),
      ms("2026-09-08T00:00:00Z"),
    );
  });
  it("00:00Z stays put, so an anchored value maps to itself", () => {
    const t = ms("2026-09-08T00:00:00Z");
    assert.equal(istDayAnchor(t), t);
    assert.equal(istDayAnchor(istDayAnchor(ms("2026-09-07T18:30:00Z"))!), t);
  });
  it("a Tokyo-local midnight (15:00Z) is refused, not moved to the wrong day", () => {
    assert.equal(istDayAnchor(ms("2026-09-07T15:00:00Z")), null);
  });
  it("any other time of day, and NaN, are refused", () => {
    assert.equal(istDayAnchor(ms("2026-09-08T12:34:56Z")), null);
    assert.equal(istDayAnchor(ms("2026-09-08T00:00:00.001Z")), null);
    assert.equal(istDayAnchor(Number.NaN), null);
  });
});

describe("readDate — the EJSON $runCommandRaw returns", () => {
  // Mutation: `return new Date(v as string).getTime()` for non-EJSON input ->
  // RED on the last case (a bare string would be read as a date).
  it("reads both $date spellings, null for null/absent, NaN otherwise", () => {
    assert.equal(
      readDate(at("2026-09-07T18:30:00Z")),
      ms("2026-09-07T18:30:00Z"),
    );
    assert.equal(
      readDate({ $date: { $numberLong: "1788739200000" } }),
      1788739200000,
    );
    assert.equal(readDate(null), null);
    assert.equal(readDate(undefined), null);
    assert.ok(Number.isNaN(readDate("2026-09-08")));
  });
});

describe("outranks — price-adjust's SOURCE_RANK, asked, not copied", () => {
  // Mutation: invert the probe's answer (`!== challenger`) -> RED.
  it("pins the ranks the survivor choice relies on", () => {
    assert.equal(outranks("NSE_HIST", "NSE"), true);
    assert.equal(outranks("NSE", "SCREENER"), true);
    assert.equal(outranks("SCREENER", "SEED"), true);
    assert.equal(outranks("SEED", null), true, "SEED 40 over unknown 20");
    assert.equal(outranks(null, "DERIVED"), true, "unknown 20 over DERIVED 10");
    assert.equal(outranks("MANUAL", "NSE_HIST"), true);
    assert.equal(outranks("SCREENER", "NSE"), false);
  });
  // Mutation: build the probe with the challenger FIRST -> RED here only: a
  // STRICT pin reads the same either way, a tie then reads as "outranks".
  it("NSE and BSE tie, and a composite scores its best token", () => {
    assert.equal(outranks("NSE", "BSE"), false);
    assert.equal(outranks("BSE", "NSE"), false);
    assert.equal(outranks("NSE+SCREENER", "NSE"), false);
    assert.equal(outranks("NSE", "NSE+SCREENER"), false);
    assert.equal(outranks("BSE+NSE", "SCREENER"), true);
  });
});

describe("planReanchor — rows with one event each", () => {
  // Mutation: skip the recordDate move -> RED (recordDate stays at 18:30Z).
  it("an IST-anchored row moves BOTH dates to UTC midnight", () => {
    const row = istTwin();
    const plan = planReanchor([row], NOW);
    assert.equal(plan.groups.length, 0);
    assert.equal(plan.deletes.length, 0);
    assert.deepEqual(plan.moves, [
      {
        id: idOf(row),
        expect: { exDate: at("2026-09-07T18:30:00Z") },
        set: {
          exDate: at("2026-09-08T00:00:00.000Z"),
          recordDate: at("2026-09-08T00:00:00.000Z"),
          updatedAt: at(NOW.toISOString()),
        },
      },
    ]);
    assert.deepEqual(plan.backup, [{ id: idOf(row), role: "moved", doc: row }]);
  });

  // Mutation: back up every row, touched or not -> RED (backup length 2).
  it("a UTC-anchored row, and one with NO recordDate field, are left alone", () => {
    const derived = doc({ source: "DERIVED", type: "CAPITAL_ADJUSTMENT" });
    delete derived.recordDate;
    const plan = planReanchor([doc(), derived], NOW);
    assert.equal(
      plan.moves.length + plan.fills.length + plan.deletes.length,
      0,
    );
    assert.equal(plan.backup.length, 0);
    assert.equal(plan.census.recordDate["null or absent"], 1);
  });
});

describe("planReanchor — an event stored twice keeps ONE row", () => {
  // Mutation: drop the RICHER rule -> RED (the later-updated IST twin would
  // survive and the nightly row carrying the ISIN would be deleted).
  it("the richer row survives an authority tie — the nightly row with an isin", () => {
    const nightly = doc({
      isin: "INE573K01017",
      gcsPath: "stocks/RUSHIL/x.json",
    });
    const twin = istTwin(); // later updatedAt, fewer fields
    const plan = planReanchor([nightly, twin], NOW);
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0]!.survivor, idOf(nightly));
    assert.equal(plan.groups[0]!.reason, "RICHER");
    assert.deepEqual(
      plan.deletes.map((d) => d.id),
      [idOf(twin)],
    );
    assert.deepEqual(plan.deletes[0]!.expect, { updatedAt: twin.updatedAt });
    assert.equal(plan.moves.length, 0, "the survivor is already at 00:00Z");
    assert.equal(
      plan.fills.length,
      0,
      "the twin carries nothing the survivor lacks",
    );
  });

  // Mutation: flip the updatedAt comparison -> RED (survivor = nightly).
  // Mutation: drop the createdAt rule -> RED (no fill).
  it("on a full tie the LATER update survives, moves, and keeps the EARLIEST createdAt", () => {
    const nightly = doc();
    const twin = istTwin();
    const plan = planReanchor([nightly, twin], NOW);
    const g = plan.groups[0]!;
    assert.equal(g.survivor, idOf(twin));
    assert.equal(g.reason, "LATER_UPDATE");
    assert.deepEqual(plan.fills, [
      {
        id: idOf(twin),
        expect: { updatedAt: twin.updatedAt },
        set: {
          createdAt: at("2026-08-01T00:00:00.000Z"),
          updatedAt: at(NOW.toISOString()),
        },
      },
    ]);
    assert.deepEqual(
      plan.deletes.map((d) => d.id),
      [idOf(nightly)],
    );
    assert.deepEqual(
      plan.moves.map((m) => m.id),
      [idOf(twin)],
    );
  });

  // Mutation: compare without `outranks` -> RED (the richer SCREENER row wins).
  // Mutation: drop the fill loop -> RED (the isin is not carried).
  it("authority beats richness, and the loser's fields fill the survivor's gaps", () => {
    const screener = doc({
      source: "SCREENER",
      isin: "INE659A01023",
      gcsPath: "g",
    });
    const nse = istTwin({ source: "NSE" });
    const plan = planReanchor([screener, nse], NOW);
    const g = plan.groups[0]!;
    assert.equal(g.survivor, idOf(nse));
    assert.equal(g.reason, "AUTHORITY");
    assert.deepEqual(g.carried.sort(), [
      "createdAt",
      "gcsPath",
      "isin",
      "source",
    ]);
    assert.equal(plan.fills[0]!.set.isin, "INE659A01023");
    assert.equal(plan.fills[0]!.set.source, "NSE+SCREENER");
  });

  // Mutation: carry a conflicting value over the survivor's -> RED.
  it("two different values: the survivor's is kept and the pair is REPORTED", () => {
    // SUDARSCHEM on prod: 6 (Screener's reading of "Shareholders 6 Aug") vs 5.
    const richer = doc({
      source: "NSE+SCREENER",
      dividendPerShare: 6,
      isin: "INE659A01023",
    });
    const twin = istTwin({ dividendPerShare: 5 });
    const plan = planReanchor([richer, twin], NOW);
    const g = plan.groups[0]!;
    assert.equal(g.survivor, idOf(richer));
    assert.deepEqual(
      g.conflicts.filter((c) => c.field === "dividendPerShare"),
      [{ field: "dividendPerShare", kept: 6, dropped: 5, loser: idOf(twin) }],
    );
    assert.equal(plan.fills.length, 0);
  });

  // Mutation: refuse only the off-anchor row and move its twin -> RED (the
  // twin would be moved onto a key the refused row still holds).
  it("an off-anchor recordDate anywhere in the event stops the WHOLE event", () => {
    const odd = doc({ recordDate: at("2026-09-07T15:00:00Z") });
    const twin = istTwin();
    const plan = planReanchor([odd, twin], NOW);
    assert.equal(
      plan.groups.length + plan.moves.length + plan.deletes.length,
      0,
    );
    assert.deepEqual(
      plan.refused.map((r) => r.field),
      ["recordDate"],
    );
  });

  it("an off-anchor exDate is refused on its own", () => {
    const plan = planReanchor(
      [doc({ exDate: at("2026-09-07T15:00:00Z") })],
      NOW,
    );
    assert.deepEqual(
      plan.refused.map((r) => r.field),
      ["exDate"],
    );
    assert.equal(plan.census.exDate["UNRECOGNISED"], 1);
  });
});

describe("the whole plan: converges, satisfies the index, and reverses", () => {
  function corpus(): RawDoc[] {
    return [
      doc({ symbol: "A" }),
      istTwin({ symbol: "A" }),
      doc({ symbol: "B", isin: "INE000000001" }),
      istTwin({ symbol: "B" }),
      doc({ symbol: "C", source: "SCREENER", isin: "INE000000002" }),
      istTwin({ symbol: "C" }),
      istTwin({ symbol: "D", type: "SPLIT", ratio: 5 }),
      doc({ symbol: "E" }),
      doc({ symbol: "F", exDate: at("2026-09-07T15:00:00Z") }),
      // The survivor has NO record date and takes its twin's.
      doc({
        symbol: "G",
        recordDate: null,
        isin: "INE000000003",
        gcsPath: "g",
      }),
      istTwin({ symbol: "G" }),
    ];
  }

  // Mutation: carry the loser's recordDate RAW instead of re-anchored -> RED
  // (G's survivor takes 18:30Z and the second run has to move it). Only this
  // case sees it: a mutation the re-plan shares cannot fail a re-plan, so the
  // planner's own moves are pinned by the cases above.
  it("a second run finds nothing to do", () => {
    const docs = corpus();
    const after = simulateApply(docs, planReanchor(docs, NOW));
    const again = planReanchor(after, NOW);
    assert.equal(again.groups.length, 0);
    assert.equal(
      again.fills.length + again.deletes.length + again.moves.length,
      0,
    );
    assert.equal(after.length, docs.length - 4, "four duplicates removed");
  });

  // Mutation: skip the deletes -> RED (A, B, C and G each end on one key twice).
  // Mutation: omit the survivor's exDate move -> RED (twins stay at 18:30Z).
  it("the result satisfies @@unique([symbol, exchange, type, exDate])", () => {
    const docs = corpus();
    assert.equal(
      uniqueKeys(docs),
      true,
      "the input is legal too — the twins differ by instant",
    );
    const after = simulateApply(docs, planReanchor(docs, NOW));
    assert.equal(uniqueKeys(after), true);
    for (const d of after) {
      if (d.symbol === "F") continue; // refused, untouched
      assert.match(JSON.stringify(d.exDate), /T00:00:00(\.000)?Z/);
    }
  });

  // Mutation: back up only the moved rows (not losers) -> RED (the deleted
  // duplicates cannot come back).
  it("every document written or deleted is backed up, verbatim", () => {
    const docs = corpus();
    const plan = planReanchor(docs, NOW);
    const backedUp = new Set(plan.backup.map((b) => b.id));
    for (const op of [...plan.fills, ...plan.deletes, ...plan.moves]) {
      assert.ok(backedUp.has(op.id), `${op.id} is touched but not backed up`);
    }
    const byId = new Map(docs.map((d) => [idOf(d), d]));
    for (const b of plan.backup) assert.equal(b.doc, byId.get(b.id));
    assert.equal(BACKUP_COLLECTION, "corporate_actions_money1530_backup");
  });

  // Mutation: swap replace/insert in planRestore -> RED (a replace would
  // target a deleted row and an insert would duplicate a live one).
  it("restoring the backup gives back the original collection exactly", () => {
    const docs = corpus();
    const plan = planReanchor(docs, NOW);
    const after = simulateApply(docs, plan);
    const backup = plan.backup.map((b) => ({
      _id: { $oid: b.id },
      doc: b.doc,
      role: b.role,
      backedUpAt: at(NOW.toISOString()),
    }));
    const { replace, insert } = planRestore(backup, new Set(after.map(idOf)));
    assert.deepEqual(
      insert.map(idOf).sort(),
      plan.deletes.map((d) => d.id).sort(),
      "exactly the deleted duplicates are re-inserted",
    );
    // As Mongo would apply it: a replace needs the row, an insert its absence.
    const restored = new Map(after.map((d) => [idOf(d), d]));
    for (const d of replace) {
      assert.ok(restored.has(idOf(d)), `replace of absent ${idOf(d)}`);
      restored.set(idOf(d), d);
    }
    for (const d of insert) {
      assert.ok(!restored.has(idOf(d)), `insert over live ${idOf(d)}`);
      restored.set(idOf(d), d);
    }
    const sort = (xs: RawDoc[]) =>
      [...xs].sort((a, b) => idOf(a).localeCompare(idOf(b)));
    assert.deepEqual(sort([...restored.values()]), sort(docs));
  });
});
