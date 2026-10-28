/**
 * Parse throughput: the claim guard, the breadth-first pick, and source legs —
 * MONEY-1259.
 *
 * Three changes ship together because they only make sense together: four
 * triggers a day make concurrent runs possible (so the claim needs a guard),
 * and four times the throughput is only worth spending if it reaches every
 * company rather than the first two hundred (so the ordering changes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildClaimWhere,
  buildParseQuery,
  fiscalYearOf,
  selectBreadthFirst,
  PARSE_SCAN_CAP,
  PENDING_OR_ABSENT_PARSE_STATUS,
  type ParseScanRow,
} from "../../src/processors/stock-document-parse-logic";
import { resolveEnabledLegs } from "../../src/processors/stock-document-sync-logic";

/** Terse row builder — only the four fields the pick actually reads. */
function row(
  id: string,
  symbol: string,
  period: string | null,
  fetchedAt = "2026-01-01T00:00:00.000Z",
): ParseScanRow {
  return { id, symbol, period, fetchedAt };
}

describe("the claim guard accepts exactly what the selection offers", () => {
  it("[meta] the selection arms are the two states this depends on", () => {
    // Ceiling: every assertion below reads these arms. If the shared constant
    // ever became a one-element array the claim would still "contain" it and
    // the pairing checks would pass while covering half the queue.
    assert.equal(PENDING_OR_ABSENT_PARSE_STATUS.length, 2);
  });

  it("claims an ABSENT parseStatus, not just PENDING", () => {
    const where = buildClaimWhere("doc1");
    const arms = where.OR as ReadonlyArray<Record<string, unknown>>;
    assert.ok(Array.isArray(arms), "the claim must be a disjunction");

    const absent = arms.find(
      (a) => typeof a.parseStatus === "object" && a.parseStatus !== null,
    );
    assert.ok(
      absent,
      "no arm targets the ABSENT case. `parseStatus` is absent — not null, " +
        "not 'PENDING' — on the ~43,155 documents written before the column " +
        "existed, because a Mongo `db push` creates indexes and never fields.",
    );
    assert.deepStrictEqual(
      absent.parseStatus,
      { isSet: false },
      "the absent arm must be `isSet: false`. This is the trap the whole guard " +
        "is written around: `notIn: ['PROCESSING','PARSED']` looks like the " +
        "right guard, does NOT match an absent field, and would silently refuse " +
        "to claim every legacy row while reporting a healthy count.",
    );
  });

  it("scopes the claim to the one document", () => {
    assert.equal(buildClaimWhere("doc42").id, "doc42");
  });

  it("never uses notIn — the shape that misses absent fields", () => {
    const json = JSON.stringify(buildClaimWhere("d", false)) + JSON.stringify(buildClaimWhere("d", true));
    assert.ok(
      !json.includes("notIn"),
      "a `notIn` arm cannot match an absent field on Prisma+Mongo " +
        "(MONEY-1050 / 1205 / 1234 / 1236 / 1256)",
    );
  });

  it("widens under force exactly as the SELECTION widens", () => {
    // Drift here is silent and expensive: a forced run would select the failed
    // rows and then fail to claim any of them, doing nothing at full cost.
    const claim = JSON.stringify(buildClaimWhere("d", true));
    const query = JSON.stringify(buildParseQuery({ force: true }));
    for (const status of ["FAILED", "FAILED_VALIDATION"]) {
      assert.ok(
        query.includes(status),
        `ceiling: the forced SELECTION no longer mentions ${status}`,
      );
      assert.ok(
        claim.includes(status),
        `forced claim does not accept ${status}, but the forced selection ` +
          `offers it — a forced run would select rows it cannot claim`,
      );
    }
  });

  it("does NOT widen when force is off", () => {
    const claim = JSON.stringify(buildClaimWhere("d", false));
    assert.ok(
      !claim.includes("FAILED"),
      "an unforced claim must not re-open terminal rows",
    );
  });
});

describe("fiscalYearOf orders a free-text period column", () => {
  it("reads the year out of every spelling in the column", () => {
    assert.equal(fiscalYearOf("2024"), 2024);
    assert.equal(fiscalYearOf("FY2024-25"), 2024);
    assert.equal(fiscalYearOf("FY 2019-20"), 2019);
    assert.equal(fiscalYearOf("Q1-2026"), 2026);
    assert.equal(fiscalYearOf("Jun 2026"), 2026);
  });

  it("sorts an unreadable period LAST rather than throwing", () => {
    // 0 is deliberate: a document whose period we cannot read is the one we
    // least want to spend a symbol's single breadth turn on.
    assert.equal(fiscalYearOf(null), 0);
    assert.equal(fiscalYearOf(""), 0);
    assert.equal(fiscalYearOf("annual report"), 0);
  });
});

describe("selectBreadthFirst reaches every symbol before deepening any", () => {
  const served = new Set<string>();

  it("[meta] the fixture really does contain multiple docs per symbol", () => {
    // Ceiling. "One per symbol" is trivially true of a fixture that has one
    // per symbol, which would make the headline assertion vacuous.
    const rows = [row("a1", "AAA", "2024"), row("a2", "AAA", "2023")];
    assert.equal(new Set(rows.map((r) => r.symbol)).size, 1);
    assert.equal(rows.length, 2);
  });

  it("gives each unserved symbol its LATEST period first", () => {
    const rows = [
      row("a-old", "AAA", "FY2019-20"),
      row("a-new", "AAA", "FY2024-25"),
      row("b-old", "BBB", "2018"),
      row("b-new", "BBB", "2023"),
    ];
    const picked = selectBreadthFirst(rows, served, 2);
    assert.deepStrictEqual(
      picked,
      ["a-new", "b-new"],
      "each symbol must contribute its newest period, one apiece",
    );
  });

  it("does not give a symbol a SECOND document while another has none", () => {
    // The whole point. Depth-first ordering hands symbol #1 twelve fiscal years
    // before symbol #200 receives one.
    const rows = [
      row("a1", "AAA", "2024"),
      row("a2", "AAA", "2023"),
      row("a3", "AAA", "2022"),
      row("b1", "BBB", "2024"),
    ];
    // Room for TWO against two symbols: starvation is only expressible when the
    // page cannot hold every symbol's first document. At limit 3 the fill would
    // correctly deepen AAA, which is the next test, not this one.
    const picked = selectBreadthFirst(rows, served, 2);
    assert.ok(
      picked.includes("b1"),
      "BBB was starved while AAA took a second and third document",
    );
    const aCount = picked.filter((id) => id.startsWith("a")).length;
    assert.equal(aCount, 1, "AAA must hold exactly one document in this page");
  });

  it("treats a symbol with ANY extract row as already served", () => {
    // FAILED_VALIDATION counts: that document consumed the symbol's turn, and
    // re-picking it ahead of a symbol with nothing wastes the breadth pass.
    const rows = [row("a1", "AAA", "2024"), row("b1", "BBB", "2024")];
    const picked = selectBreadthFirst(rows, new Set(["AAA"]), 1);
    assert.deepStrictEqual(picked, ["b1"], "the unserved symbol must win the slot");
  });

  it("fills remaining room with the caller's order once breadth is met", () => {
    // Breadth is an ORDERING, not a filter — depth must back-fill behind it, or
    // the Financials tab never gets history.
    const rows = [
      row("a1", "AAA", "2024"),
      row("a2", "AAA", "2023"),
      row("b1", "BBB", "2024"),
    ];
    const picked = selectBreadthFirst(rows, served, 3);
    assert.equal(picked.length, 3, "every eligible row stays selectable");
    assert.deepStrictEqual([...picked].sort(), ["a1", "a2", "b1"]);
    assert.ok(
      picked.indexOf("a2") > picked.indexOf("b1"),
      "AAA's second document must come after BBB's first",
    );
  });

  it("never exceeds the page limit, and returns nothing for no room", () => {
    const rows = [row("a1", "AAA", "2024"), row("b1", "BBB", "2024")];
    assert.equal(selectBreadthFirst(rows, served, 1).length, 1);
    assert.deepStrictEqual(
      selectBreadthFirst(rows, served, 0),
      [],
      "no room must mean no rows — returning everything would ignore batchSize",
    );
    assert.deepStrictEqual(selectBreadthFirst(rows, served, -5), []);
  });

  it("emits no duplicate ids", () => {
    const rows = [row("a1", "AAA", "2024"), row("a2", "AAA", "2023")];
    const picked = selectBreadthFirst(rows, served, 10);
    assert.equal(new Set(picked).size, picked.length);
  });

  it("breaks a same-year tie on the fresher fetch", () => {
    const rows = [
      row("old", "AAA", "2024", "2026-01-01T00:00:00.000Z"),
      row("new", "AAA", "2024", "2026-06-01T00:00:00.000Z"),
    ];
    assert.deepStrictEqual(selectBreadthFirst(rows, served, 1), ["new"]);
  });

  it("[stale] the scan cap is BREACHED, and this test used to hide it", () => {
    // CORRECTED by MONEY-1314. This case read:
    //
    //   assert.ok(PARSE_SCAN_CAP >= 40_000,
    //     "the eligible set is ~15,700 and the whole table ~45,600, so a
    //      lower cap truncates the pick")
    //
    // All three numbers were stale, and the assertion PASSED while the
    // condition its own message described was false. Measured on prod
    // 2026-09-01 with `buildParseQuery`'s exact predicate:
    //
    //     eligible   48,322      (> the 40,000 cap)
    //     PDF rows   79,884      (not ~45,600)
    //
    // So `selectBreadthFirst` has been silently narrowing to the oldest 40,000
    // for some time — a green test asserting a floor while the population it
    // was sized against moved out from under it.
    //
    // The cap is NOT raised. The lane it guards is RETIRED: all four
    // `stock-document-parse` crons are in OLD_SCHEDULER_PREFIXES, and its
    // replacement takes ONE DOCUMENT PER MESSAGE and therefore has no scan to
    // cap at all. Raising a number on a retired lane would be maintenance
    // theatre.
    //
    // What is asserted instead is the TRUE relationship, so the day someone
    // revives this lane they are told what they are reviving.
    const ELIGIBLE_MEASURED = 48_322; // docs/reference/doc-ingest-population.md
    assert.ok(
      PARSE_SCAN_CAP < ELIGIBLE_MEASURED,
      `PARSE_SCAN_CAP (${PARSE_SCAN_CAP}) is no longer below the measured ` +
        `eligible set (${ELIGIBLE_MEASURED}). If the cap was raised, this ` +
        "lane is live again and needs a real ceiling; if the population " +
        "shrank, re-measure and restate it here rather than deleting the case.",
    );
  });
});

describe("sources restricts legs and can only ever remove one", () => {
  it("[meta] annual_report really does light BOTH legs — the reason sources exists", () => {
    const both = resolveEnabledLegs(["annual_report"]);
    assert.equal(both.screener, true);
    assert.equal(
      both.nse,
      true,
      "ceiling: annual_report no longer implies the NSE leg, so the whole " +
        "premise of the `sources` field has changed",
    );
  });

  it("screener-only enters the screener leg alone", () => {
    const legs = resolveEnabledLegs(undefined, ["screener"]);
    assert.deepStrictEqual(legs, {
      tickertape: false,
      nse: false,
      screener: true,
    });
  });

  it("cannot ADD a leg docTypes had switched off", () => {
    // The contract: intersect, never union. A `sources` that could add legs
    // would let a payload silently widen a targeted run back to the market.
    // docTypes implies TICKERTAPE only. Naming nse+screener in `sources` must
    // not switch either on — and it removes tickertape, because a leg absent
    // from `sources` is a leg the caller did not ask for. Intersect, never
    // union: the result is the empty set, not "whatever sources listed".
    const legs = resolveEnabledLegs(["financial_statement"], ["nse", "screener"]);
    assert.equal(legs.nse, false, "sources must not ADD the NSE leg");
    assert.equal(legs.screener, false, "sources must not ADD the screener leg");
    assert.equal(
      legs.tickertape,
      false,
      "tickertape was not named in sources, so it must be removed",
    );

    // And the leg named in BOTH survives — otherwise the intersect would be
    // indistinguishable from 'switch everything off'.
    const kept = resolveEnabledLegs(["financial_statement"], ["tickertape"]);
    assert.deepStrictEqual(kept, {
      tickertape: true,
      nse: false,
      screener: false,
    });
  });

  it("absent or empty sources is NOT a filter", () => {
    // Treating [] as "no sources" would turn a malformed message into a
    // whole-run no-op that reports success.
    const base = resolveEnabledLegs(undefined);
    assert.deepStrictEqual(resolveEnabledLegs(undefined, undefined), base);
    assert.deepStrictEqual(resolveEnabledLegs(undefined, []), base);
  });

  it("leaves every pre-existing call byte-identical", () => {
    for (const dt of [
      undefined,
      ["financial_statement"],
      ["annual_report"],
      ["quarterly_result"],
      ["concall_ppt"],
    ]) {
      assert.deepStrictEqual(
        resolveEnabledLegs(dt, undefined),
        resolveEnabledLegs(dt),
        `adding the sources parameter changed behaviour for docTypes=${dt}`,
      );
    }
  });
});
