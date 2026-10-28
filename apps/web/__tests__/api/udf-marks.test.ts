/**
 * UNIT TEST — UDF marks payload (MONEY-1176).
 *
 * Two failure modes here are SILENT, so they get explicit tests: TradingView
 * needs COLUMN-oriented parallel arrays (an array of objects renders nothing at
 * all), and `time` must be unix SECONDS (milliseconds put every mark ~55,000
 * years in the future, off the visible range, with no error).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMarks,
  emptyMarks,
  markText,
  MARKED_TYPES,
  type MarkableAction,
} from "../../app/api/market/udf/marks/route-logic";

const D = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const sec = (iso: string): number => Math.floor(D(iso).getTime() / 1000);

const act = (
  id: string,
  type: string,
  iso: string,
  extra: Partial<MarkableAction> = {}
): MarkableAction => ({ id, type, exDate: D(iso), ...extra });

const WINDOW: [number, number] = [sec("2010-01-01"), sec("2026-01-01")];

describe("buildMarks — payload shape", () => {
  it("returns PARALLEL ARRAYS of equal length, not an array of objects", () => {
    const m = buildMarks(
      [
        act("a", "SPLIT", "2014-11-20", { ratio: 10 }),
        act("b", "BONUS", "2015-06-15", { ratio: 2 }),
      ],
      ...WINDOW
    );
    assert.ok(Array.isArray(m.id) && Array.isArray(m.time));
    const lengths = [
      m.id.length,
      m.time.length,
      m.color.length,
      m.text.length,
      m.label.length,
      m.labelFontColor.length,
      m.minSize.length,
    ];
    assert.deepEqual(lengths, Array(7).fill(2), "every column must align");
  });

  it("emits unix SECONDS, not milliseconds", () => {
    const m = buildMarks([act("a", "SPLIT", "2014-11-20")], ...WINDOW);
    assert.equal(m.time[0], sec("2014-11-20"));
    // A millisecond value would be ~1e12 and land far outside any chart.
    assert.ok(m.time[0]! < 1e11);
  });

  it("returns empty COLUMNS (never null) when nothing matches", () => {
    const m = buildMarks([], ...WINDOW);
    assert.deepEqual(m, emptyMarks());
    assert.deepEqual(m.id, []);
  });
});

describe("buildMarks — selection", () => {
  it("excludes DIVIDEND by default", () => {
    // 1,589 dividends cluster every year; marking them would bury the three
    // events that actually moved the price basis under a solid band.
    assert.equal(MARKED_TYPES.has("DIVIDEND"), false);
    const m = buildMarks(
      [act("d", "DIVIDEND", "2020-01-01", { dividendPerShare: 8 })],
      ...WINDOW
    );
    assert.equal(m.id.length, 0);
  });

  it("marks every structural type", () => {
    const types = [
      "SPLIT",
      "BONUS",
      "DEMERGER",
      "MERGER",
      "RIGHTS",
      "CAPITAL_ADJUSTMENT",
    ];
    const m = buildMarks(
      types.map((t, i) => act(String(i), t, `201${i}-05-05`)),
      ...WINDOW
    );
    assert.equal(m.id.length, types.length);
  });

  it("clips to the requested window", () => {
    const m = buildMarks(
      [
        act("old", "SPLIT", "2005-01-01"),
        act("in", "SPLIT", "2015-01-01"),
        act("new", "SPLIT", "2030-01-01"),
      ],
      ...WINDOW
    );
    assert.deepEqual(m.id, ["in"]);
  });

  it("dedupes one event reported by both exchanges on the same day", () => {
    // The same split arrives from NSE and BSE. Two identical glyphs stacked on
    // one bar look like a rendering bug.
    const m = buildMarks(
      [
        act("nse", "SPLIT", "2014-11-20", { ratio: 10 }),
        act("bse", "SPLIT", "2014-11-20", { ratio: 10 }),
      ],
      ...WINDOW
    );
    assert.equal(m.id.length, 1);
  });

  it("keeps two DIFFERENT action types on the same day", () => {
    // A bonus and a rights issue can genuinely share an ex-date.
    const m = buildMarks(
      [act("a", "BONUS", "2016-07-01"), act("b", "RIGHTS", "2016-07-01")],
      ...WINDOW
    );
    assert.equal(m.id.length, 2);
  });

  it("caps the mark count so a pathological symbol cannot flood the chart", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      act(
        String(i),
        "SPLIT",
        `20${String(10 + (i % 15)).padStart(2, "0")}-0${(i % 9) + 1}-0${(i % 9) + 1}`
      )
    );
    const m = buildMarks(many, ...WINDOW, 200);
    assert.ok(m.id.length <= 200);
  });

  it("orders marks oldest-first", () => {
    const m = buildMarks(
      [act("b", "SPLIT", "2018-01-01"), act("a", "SPLIT", "2012-01-01")],
      ...WINDOW
    );
    assert.deepEqual(m.id, ["a", "b"]);
  });
});

describe("markText", () => {
  it("prefers the face-value change for a split, which is how NSE states it", () => {
    assert.match(
      markText(
        act("x", "SPLIT", "2014-11-20", {
          oldFaceValue: 10,
          newFaceValue: 1,
          ratio: 10,
        })
      ),
      /face value ₹10 → ₹1/
    );
  });

  it("falls back to the ratio when face values are absent", () => {
    assert.match(
      markText(act("x", "SPLIT", "2014-11-20", { ratio: 10 })),
      /1:10/
    );
  });

  it("converts a bonus factor back to the a:b the market quotes", () => {
    // Stored post:pre ratio 2 IS the familiar "1:1 bonus" — one new share for
    // each held. Printing "1:2" would describe a different event.
    assert.match(
      markText(act("x", "BONUS", "2017-09-14", { ratio: 2 })),
      /Bonus issue 1:1/
    );
    assert.match(
      markText(act("x", "BONUS", "2016-07-01", { ratio: 3 })),
      /Bonus issue 2:1/
    );
  });

  it("still says something useful for an unclassified action", () => {
    // A vague mark still earns its place: it tells the reader the dip was
    // structural rather than a crash.
    const t = markText(act("x", "CAPITAL_ADJUSTMENT", "2006-02-01"));
    assert.match(t, /Capital adjustment/);
    assert.match(t, /ex-date 2006-02-01/);
  });

  it("always carries the ex-date", () => {
    for (const type of MARKED_TYPES) {
      assert.match(
        markText(act("x", type, "2020-03-04")),
        /ex-date 2020-03-04/,
        type
      );
    }
  });
});

describe("MONEY-1527 — an ex-date stored at IST midnight", () => {
  // Prod stores `exDate` in TWO conventions and nothing on the row says which:
  // 48,224 rows at 18:30Z (IST midnight of the NEXT calendar day) and 10,863
  // at 00:00Z. Every fixture above uses the second, so the defect was
  // invisible to this suite.
  const IST_MIDNIGHT = new Date("2022-07-27T18:30:00.000Z"); // = 2022-07-28 IST
  const UTC_MIDNIGHT = new Date("2022-07-28T00:00:00.000Z"); // the same day
  const BAR_SEC = Math.floor(Date.parse("2022-07-28T00:00:00.000Z") / 1000);

  it("lands on the bar it belongs to, not the one before it", () => {
    const out = buildMarks(
      [{ id: "a", type: "SPLIT", exDate: IST_MIDNIGHT, ratio: 10 }],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.equal(out.time.length, 1);
    assert.equal(
      out.time[0],
      BAR_SEC,
      "TradingView positions by epoch and India bars sit at UTC midnight — " +
        "the raw 18:30Z instant put the glyph on the PREVIOUS candle"
    );
    assert.match(
      out.text[0]!,
      /2022-07-28/,
      "and the label must name the same day the glyph sits on"
    );
  });

  it("a genuine RATIO DISAGREEMENT still renders twice", () => {
    // The dedupe exists for IDENTICAL glyphs. Collapsing the two conventions
    // onto one IST day made it swallow a real disagreement too, and which
    // ratio survived depended on row order — the reader was told 1:10 or 1:2
    // depending on which feed happened to use which convention.
    const out = buildMarks(
      [
        { id: "nse", type: "SPLIT", exDate: IST_MIDNIGHT, ratio: 10 },
        { id: "bse", type: "SPLIT", exDate: UTC_MIDNIGHT, ratio: 2 },
      ],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.equal(
      out.id.length,
      2,
      "the feeds disagree about the ratio — the chart must say so, not pick one"
    );
    assert.deepEqual(out.time, [BAR_SEC, BAR_SEC], "both sit on the ex bar");
  });

  it("a PARTIALLY POPULATED twin is still one event, not a disagreement", () => {
    // The regression a first attempt at this dedupe introduced. NSE and BSE
    // are always separate rows and the route does not scope by exchange, so
    // one side carrying face values and the other carrying nulls is the NORMAL
    // input — 42 such groups measured in the QA corpus. Keying on the raw
    // fields made every one of them render twice.
    const out = buildMarks(
      [
        {
          id: "nse",
          type: "SPLIT",
          exDate: IST_MIDNIGHT,
          ratio: 10,
          oldFaceValue: 10,
          newFaceValue: 1,
        },
        { id: "bse", type: "SPLIT", exDate: UTC_MIDNIGHT, ratio: 10 },
      ],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.equal(out.id.length, 1, "one split, one glyph");
  });

  it("two rows that declare NOTHING collapse rather than stacking", () => {
    // RIGHTS/DEMERGER/MERGER read none of the factor fields, so two such rows
    // would otherwise emit byte-identical glyphs on one candle.
    const out = buildMarks(
      [
        { id: "nse", type: "RIGHTS", exDate: IST_MIDNIGHT, ratio: 1.2 },
        { id: "bse", type: "RIGHTS", exDate: UTC_MIDNIGHT },
      ],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.equal(out.id.length, 1);
  });

  it("two DERIVED ratios a float apart are one factor, not two", () => {
    // Ratios are computed, not stored verbatim: 1 + 2/3 and 5/3 differ in the
    // last bit and `trim()` prints both as 0.67, so a string compare would
    // stack two identical-looking glyphs.
    const out = buildMarks(
      [
        { id: "a", type: "BONUS", exDate: IST_MIDNIGHT, ratio: 1 + 2 / 3 },
        { id: "b", type: "BONUS", exDate: UTC_MIDNIGHT, ratio: 5 / 3 },
      ],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.equal(out.id.length, 1, "the two are indistinguishable to a reader");
    assert.notEqual(
      1 + 2 / 3,
      5 / 3,
      "the fixture must actually differ in bits"
    );
  });

  it("an unrepresentable ex-date is SKIPPED, never emitted as time:null", () => {
    // `toIstDateKey` has no validity guard and renders an Invalid Date as the
    // literal "NaN-NaN-NaN"; Date.parse of that is NaN, and NaN fails BOTH
    // window comparisons, so without an explicit check the row sails through
    // and TradingView receives `time: null`. The old `toISOString()` threw,
    // which route.ts turned into a clean empty payload.
    const out = buildMarks(
      [
        { id: "bad", type: "SPLIT", exDate: new Date("nope"), ratio: 10 },
        { id: "ok", type: "SPLIT", exDate: IST_MIDNIGHT, ratio: 10 },
      ],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.deepEqual(out.id, ["ok"], "the malformed row must not be emitted");
    assert.ok(
      out.time.every((t) => Number.isFinite(t)),
      "every emitted time must be a finite epoch second"
    );
  });

  it("dedupes one event filed by NSE and BSE under DIFFERENT conventions", () => {
    // The exact shape the dedupe exists for, and the one it could not see: two
    // exchanges describing one split, stored 5h30m apart across a UTC
    // midnight. A UTC slice made them two keys and rendered two glyphs.
    const out = buildMarks(
      [
        { id: "nse", type: "SPLIT", exDate: IST_MIDNIGHT, ratio: 10 },
        { id: "bse", type: "SPLIT", exDate: UTC_MIDNIGHT, ratio: 10 },
      ],
      BAR_SEC - 86_400 * 5,
      BAR_SEC + 86_400 * 5
    );
    assert.equal(
      out.id.length,
      1,
      "two identical glyphs on one bar look like a rendering bug — that is " +
        "what this dedupe is for"
    );
    assert.equal(out.time[0], BAR_SEC);
  });

  it("clips on the normalised bar, so a 18:30Z stamp is not lost at the edge", () => {
    // The window test used the raw instant, so an action whose BAR is inside
    // the range could be dropped because its stamp fell 5h30m outside it.
    const out = buildMarks(
      [{ id: "a", type: "SPLIT", exDate: IST_MIDNIGHT, ratio: 10 }],
      BAR_SEC,
      BAR_SEC + 60
    );
    assert.equal(out.id.length, 1, "the bar is the first second of the range");
  });
});
