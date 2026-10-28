import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  judgeSeriesReadiness,
  type SeriesReadinessRow,
} from "../../src/market-data/series-readiness";

/** A BSE row carrying a real group letter — sourced, classifiable. */
const sourced = (series: string, type = "EQUITY"): SeriesReadinessRow => ({
  exchange: "BSE",
  instrumentType: type,
  series,
  isActive: true,
});

/** A BSE row still carrying the stamped default. */
const stamped = (type = "EQUITY"): SeriesReadinessRow => ({
  exchange: "BSE",
  instrumentType: type,
  series: "EQ",
  isActive: true,
});

const many = (n: number, f: (i: number) => SeriesReadinessRow) =>
  Array.from({ length: n }, (_, i) => f(i));

const GROUPS = ["A", "B", "F", "G", "X", "M", "XT"];

describe("judgeSeriesReadiness — invariance under the retype it gates", () => {
  it("REGRESSION: applying the reclassification does NOT tighten the gate", () => {
    // The MONEY-1196 defect, reproduced as arithmetic. Before: 6 sourced BSE
    // rows typed EQUITY + 5 stamped. The old gate counted only EQUITY rows, so
    // retyping the 6 sourced ones to DEBT emptied the denominator of exactly
    // the rows that were fine and left the ratio at 5/5 = 100%.
    const before: SeriesReadinessRow[] = [
      ...GROUPS.slice(0, 6).map((g) => sourced(g)),
      ...many(5, () => stamped()),
    ];
    const after: SeriesReadinessRow[] = [
      // same rows, now correctly typed DEBT — still ACTIVE, still BSE
      ...GROUPS.slice(0, 6).map((g) => sourced(g, "DEBT")),
      ...many(5, () => stamped()),
    ];

    const b = judgeSeriesReadiness(before);
    const a = judgeSeriesReadiness(after);

    assert.equal(b.ready, true, "should be actionable before the apply");
    assert.equal(a.ready, true, "MUST still be actionable after the apply");
    assert.equal(
      a.defaultShare,
      b.defaultShare,
      "the reading must be invariant under a retype",
    );
    assert.equal(a.population, b.population);
  });

  it("counts DEBT rows in the population — they are evidence, not spent", () => {
    const r = judgeSeriesReadiness([
      sourced("A", "DEBT"),
      sourced("B", "DEBT"),
      sourced("F", "DEBT"),
      stamped(),
    ]);
    assert.equal(r.population, 4);
    assert.equal(r.stampedDefault, 1);
  });

  it("still refuses when the column really is mostly the stamped default", () => {
    const r = judgeSeriesReadiness([
      ...GROUPS.slice(0, 3).map((g) => sourced(g)),
      ...many(7, () => stamped()),
    ]);
    assert.equal(r.ready, false);
    assert.equal(r.reason, "mostly-default");
    assert.equal(r.defaultShare, 0.7);
  });

  it("refuses when the column carries almost no distinct values", () => {
    // Ratio alone would pass this: 1 of 10 is default. But two group letters is
    // not a sourced universe (~14 exist), so the ratio is measuring noise.
    const r = judgeSeriesReadiness([
      ...many(9, (i) => sourced(i % 2 === 0 ? "A" : "B")),
      stamped(),
    ]);
    assert.equal(r.ready, false);
    assert.equal(r.reason, "too-few-series");
  });

  it("is BSE-only — NSE rows never enter the population", () => {
    // "EQ" is a LEGITIMATE NSE main-board series, so counting NSE rows makes
    // every real NSE equity look unsourced forever. That was the first bug.
    const r = judgeSeriesReadiness([
      ...GROUPS.slice(0, 4).map((g) => sourced(g)),
      {
        exchange: "NSE",
        instrumentType: "EQUITY",
        series: "EQ",
        isActive: true,
      },
      {
        exchange: "NSE",
        instrumentType: "EQUITY",
        series: "EQ",
        isActive: true,
      },
      {
        exchange: "NSE",
        instrumentType: "EQUITY",
        series: "EQ",
        isActive: true,
      },
    ]);
    assert.equal(r.population, 4);
    assert.equal(r.stampedDefault, 0);
    assert.equal(r.ready, true);
  });

  it("excludes inactive rows — a delisted row is not evidence about today", () => {
    const r = judgeSeriesReadiness([
      ...GROUPS.slice(0, 4).map((g) => sourced(g)),
      {
        exchange: "BSE",
        instrumentType: "EQUITY",
        series: "EQ",
        isActive: false,
      },
    ]);
    assert.equal(r.population, 4);
  });

  it("treats a missing/blank series as neither sourced nor stamped", () => {
    const r = judgeSeriesReadiness([
      ...GROUPS.slice(0, 4).map((g) => sourced(g)),
      {
        exchange: "BSE",
        instrumentType: "EQUITY",
        series: null,
        isActive: true,
      },
      {
        exchange: "BSE",
        instrumentType: "EQUITY",
        series: "  ",
        isActive: true,
      },
    ]);
    assert.equal(r.population, 6);
    assert.equal(r.stampedDefault, 0, "blank is not the stamped default");
    assert.equal(r.distinctSeries, 4, "blank must not inflate diversity");
  });

  it("normalises case and whitespace before comparing", () => {
    const r = judgeSeriesReadiness([
      ...GROUPS.slice(0, 4).map((g) => sourced(g)),
      {
        exchange: "BSE",
        instrumentType: "EQUITY",
        series: " eq ",
        isActive: true,
      },
    ]);
    assert.equal(r.stampedDefault, 1);
  });

  it("an empty population is NOT ready — never act on nothing", () => {
    const r = judgeSeriesReadiness([]);
    assert.equal(r.ready, false);
    assert.equal(r.reason, "no-population");
    assert.equal(r.defaultShare, 0);
  });

  it("reports the structurally-unclassifiable count instead of hiding it", () => {
    // ~5,972 prod rows carry "EQ" with no ISIN and an uncorroborable name, so
    // the enricher can never source them. They stay IN the denominator on
    // purpose — excluding them would read 100% ready with half the column
    // still default.
    const r = judgeSeriesReadiness([
      ...GROUPS.map((g) => sourced(g)),
      ...many(6, () => stamped()),
    ]);
    assert.equal(r.stampedDefault, 6);
    assert.ok(r.defaultShare < 0.5 && r.ready);
  });

  it("is pure — it does not mutate the rows it is given", () => {
    const rows = [...GROUPS.slice(0, 4).map((g) => sourced(g)), stamped()];
    const snapshot = JSON.stringify(rows);
    judgeSeriesReadiness(rows);
    assert.equal(JSON.stringify(rows), snapshot);
  });
});
