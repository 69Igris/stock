/**
 * UNIT TEST — point-in-time index membership (MONEY-1189).
 *
 * The load-bearing case is `does NOT fabricate an addedOn for the first
 * snapshot`. RELIANCE has been in NIFTY 50 since the index existed; our
 * earliest snapshot is 2026-08-07. Stamping `addedOn: 2026-08-07` would tell a
 * backtest that all 50 constituents joined on the same day — a fabricated
 * index-wide rebalance that looks exactly like a real regime change.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMembershipIntervals,
  membershipAsOf,
  diffSnapshots,
  planMembershipUpdate,
  type MembershipSnapshot,
} from "../../src/market-data/index-membership-logic";

const D = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();
const snap = (iso: string, ...symbols: string[]): MembershipSnapshot => ({
  dateMs: D(iso),
  symbols: new Set(symbols),
});

describe("buildMembershipIntervals", () => {
  it("does NOT fabricate an addedOn for the first snapshot", () => {
    const out = buildMembershipIntervals("nifty50", [
      snap("2026-08-07", "RELIANCE", "TCS"),
    ]);
    assert.equal(out.length, 2);
    for (const iv of out) {
      assert.equal(iv.addedOn, null, `${iv.symbol} must not claim a join date`);
      assert.equal(iv.firstSeen, D("2026-08-07"));
      assert.equal(iv.removedOn, null);
    }
  });

  it("records a REAL join when a symbol appears after being absent", () => {
    const out = buildMembershipIntervals("nifty50", [
      snap("2026-08-07", "RELIANCE"),
      snap("2026-08-10", "RELIANCE", "ZOMATO"),
    ]);
    const zomato = out.find((i) => i.symbol === "ZOMATO")!;
    assert.equal(
      zomato.addedOn,
      D("2026-08-10"),
      "observed join keeps its date",
    );
    const reliance = out.find((i) => i.symbol === "RELIANCE")!;
    assert.equal(reliance.addedOn, null, "incumbent stays unclaimed");
  });

  it("records a REAL exit when a symbol disappears", () => {
    const out = buildMembershipIntervals("nifty50", [
      snap("2026-08-07", "RELIANCE", "OLDCO"),
      snap("2026-08-10", "RELIANCE"),
    ]);
    const old = out.find((i) => i.symbol === "OLDCO")!;
    assert.equal(old.removedOn, D("2026-08-10"));
    assert.equal(old.lastSeen, D("2026-08-07"));
  });

  it("keeps leave-and-return as TWO intervals, not one", () => {
    // Collapsing them would erase a genuine index change, and the second
    // interval's addedOn is a real observed event.
    const out = buildMembershipIntervals("nifty50", [
      snap("2026-01-01", "X"),
      snap("2026-02-01"),
      snap("2026-03-01", "X"),
    ]).filter((i) => i.symbol === "X");
    assert.equal(out.length, 2);
    assert.equal(out[0]!.removedOn, D("2026-02-01"));
    assert.equal(out[1]!.addedOn, D("2026-03-01"));
    assert.equal(out[1]!.removedOn, null, "second stint is still open");
  });

  it("extends lastSeen across consecutive snapshots without new intervals", () => {
    const out = buildMembershipIntervals("nifty50", [
      snap("2026-08-07", "RELIANCE"),
      snap("2026-08-10", "RELIANCE"),
      snap("2026-08-11", "RELIANCE"),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.firstSeen, D("2026-08-07"));
    assert.equal(out[0]!.lastSeen, D("2026-08-11"));
  });

  it("sorts unordered snapshots before inferring anything", () => {
    // GCS listing order is lexicographic, not chronological across months.
    const out = buildMembershipIntervals("nifty50", [
      snap("2026-08-11", "A", "B"),
      snap("2026-08-07", "A"),
    ]);
    const b = out.find((i) => i.symbol === "B")!;
    assert.equal(
      b.addedOn,
      D("2026-08-11"),
      "B joined, it did not start there",
    );
    const a = out.find((i) => i.symbol === "A")!;
    assert.equal(a.addedOn, null);
  });

  it("returns nothing for no snapshots", () => {
    assert.deepEqual(buildMembershipIntervals("nifty50", []), []);
  });
});

describe("membershipAsOf", () => {
  const intervals = buildMembershipIntervals("nifty50", [
    snap("2026-08-07", "RELIANCE", "OLDCO"),
    snap("2026-08-10", "RELIANCE", "NEWCO"),
  ]);

  it("answers the point-in-time question", () => {
    assert.deepEqual(membershipAsOf(intervals, D("2026-08-07")), [
      "OLDCO",
      "RELIANCE",
    ]);
    assert.deepEqual(membershipAsOf(intervals, D("2026-08-10")), [
      "NEWCO",
      "RELIANCE",
    ]);
  });

  it("treats removedOn as EXCLUSIVE", () => {
    // The snapshot for D is what revealed the removal, so the symbol was not a
    // member on D itself.
    assert.ok(!membershipAsOf(intervals, D("2026-08-10")).includes("OLDCO"));
    assert.ok(membershipAsOf(intervals, D("2026-08-09")).includes("OLDCO"));
  });

  it("returns NOTHING before the earliest snapshot rather than guessing", () => {
    // Answering here is exactly how survivorship bias gets reintroduced by the
    // table meant to remove it.
    assert.deepEqual(membershipAsOf(intervals, D("2019-03-14")), []);
  });

  it("carries an open interval forward indefinitely", () => {
    assert.ok(membershipAsOf(intervals, D("2027-01-01")).includes("RELIANCE"));
  });
});

describe("diffSnapshots", () => {
  it("reports adds and removes between consecutive observations", () => {
    const out = diffSnapshots(new Set(["A", "B"]), new Set(["B", "C"]));
    assert.deepEqual(out.added, ["C"]);
    assert.deepEqual(out.removed, ["A"]);
  });

  it("claims NO changes when there is no previous snapshot", () => {
    // First-ever run must not report the whole index as newly added.
    const out = diffSnapshots(null, new Set(["A", "B"]));
    assert.deepEqual(out, { added: [], removed: [] });
  });

  it("is empty for an unchanged index", () => {
    const out = diffSnapshots(new Set(["A", "B"]), new Set(["B", "A"]));
    assert.deepEqual(out, { added: [], removed: [] });
  });
});

describe("planMembershipUpdate — the weekly forward hook", () => {
  const open = (symbol: string, iso: string) => ({ symbol, lastSeen: D(iso) });

  it("does NOT stamp addedOn on the first-ever observation", () => {
    // Same rule as the backfill: with nothing recorded, every member is an
    // incumbent of unknown standing, not a joiner.
    const out = planMembershipUpdate([], new Set(["A", "B"]), D("2026-08-14"));
    assert.deepEqual(out.open, [
      { symbol: "A", addedOn: null },
      { symbol: "B", addedOn: null },
    ]);
    assert.deepEqual(out.close, []);
  });

  it("SKIPS a re-resolve of the same archive file", () => {
    // The sync runs weekly; NSE publishes irregularly, so most runs re-read the
    // file already processed. Writing again would be churn at best.
    const out = planMembershipUpdate(
      [open("A", "2026-08-14"), open("B", "2026-08-14")],
      new Set(["A", "B"]),
      D("2026-08-14"),
    );
    assert.equal(out.skip, "duplicate");
    assert.deepEqual(out.open, []);
    assert.deepEqual(out.close, []);
  });

  it("SKIPS an archive that went backwards rather than closing live intervals", () => {
    // A stale file resolving after a newer one must never be read as "these
    // members left" — that is a fabricated mass exit from a caching artefact.
    const out = planMembershipUpdate(
      [open("A", "2026-08-14"), open("B", "2026-08-14")],
      new Set(["A"]),
      D("2026-08-07"),
    );
    assert.equal(out.skip, "stale");
    assert.deepEqual(out.close, [], "B must NOT be closed by an older file");
  });

  it("records a real join and a real exit on a newer file", () => {
    const out = planMembershipUpdate(
      [open("A", "2026-08-14"), open("OLDCO", "2026-08-14")],
      new Set(["A", "NEWCO"]),
      D("2026-08-21"),
    );
    assert.equal(out.skip, undefined);
    assert.deepEqual(out.open, [{ symbol: "NEWCO", addedOn: D("2026-08-21") }]);
    assert.deepEqual(out.close, ["OLDCO"]);
    assert.deepEqual(out.touch, ["A"], "incumbents just move lastSeen");
  });

  it("re-opens a returning symbol as a NEW interval with a real addedOn", () => {
    // Its previous stint is already closed, so it is absent from openIntervals
    // and correctly reads as a join. The unique key is (index, symbol,
    // firstSeen), so the second stint coexists with the first.
    const out = planMembershipUpdate(
      [open("A", "2026-08-14")],
      new Set(["A", "RETURNED"]),
      D("2026-08-21"),
    );
    assert.deepEqual(out.open, [
      { symbol: "RETURNED", addedOn: D("2026-08-21") },
    ]);
  });

  it("touches everything and changes nothing when membership is stable", () => {
    const out = planMembershipUpdate(
      [open("A", "2026-08-14"), open("B", "2026-08-14")],
      new Set(["A", "B"]),
      D("2026-08-21"),
    );
    assert.deepEqual(out.touch, ["A", "B"]);
    assert.deepEqual(out.open, []);
    assert.deepEqual(out.close, []);
  });
});
