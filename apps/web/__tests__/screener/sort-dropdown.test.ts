/**
 * Screener SortDropdown - pure-sort behavior (MONEY-243).
 *
 * The component itself is React; the underlying sort is a pure
 * function, exported so we can verify per-key ordering and tie-break
 * behavior. If the source `applySort` keys change, update this fixture.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySort,
  type SortKey,
} from "../../components/screener/SortDropdown";

interface Row {
  symbol: string;
  name: string;
  marketCap: number | null;
  changePercent: number | null;
  matchScore: number;
}

const ROWS: Row[] = [
  {
    symbol: "C",
    name: "Charlie Co",
    marketCap: 50_000,
    changePercent: -1.2,
    matchScore: 50,
  },
  {
    symbol: "A",
    name: "Alpha Industries",
    marketCap: 200_000,
    changePercent: 4.1,
    matchScore: 90,
  },
  {
    symbol: "B",
    name: "Beta Ltd",
    marketCap: 100_000,
    changePercent: 0.5,
    matchScore: 70,
  },
  {
    symbol: "D",
    name: "Delta Pharma",
    marketCap: null,
    changePercent: null,
    matchScore: 30,
  },
];

function symbols(key: SortKey): string[] {
  return applySort(ROWS, key).map((r) => r.symbol);
}

describe("SortDropdown applySort (MONEY-243)", () => {
  it("'match' sorts by matchScore desc", () => {
    assert.deepEqual(symbols("match"), ["A", "B", "C", "D"]);
  });

  it("'mcap-desc' sorts by marketCap desc; null becomes 0 (lands at bottom)", () => {
    assert.deepEqual(symbols("mcap-desc"), ["A", "B", "C", "D"]);
  });

  it("'mcap-asc' sorts by marketCap asc; null treated as 0 (lands at top)", () => {
    assert.deepEqual(symbols("mcap-asc"), ["D", "C", "B", "A"]);
  });

  it("'change-desc' sorts by changePercent desc", () => {
    // null treated as 0; A(4.1) > B(0.5) > D(0) > C(-1.2)
    assert.deepEqual(symbols("change-desc"), ["A", "B", "D", "C"]);
  });

  it("'change-asc' sorts by changePercent asc", () => {
    assert.deepEqual(symbols("change-asc"), ["C", "D", "B", "A"]);
  });

  it("'name-asc' uses localeCompare on name", () => {
    assert.deepEqual(symbols("name-asc"), ["A", "B", "C", "D"]);
  });

  it("does not mutate the input array", () => {
    const original = ROWS.map((r) => r.symbol).join(",");
    applySort(ROWS, "mcap-desc");
    assert.equal(ROWS.map((r) => r.symbol).join(","), original);
  });

  it("handles empty input", () => {
    assert.deepEqual(applySort([], "match"), []);
    assert.deepEqual(applySort([], "mcap-desc"), []);
  });

  it("handles a single row", () => {
    const one = [ROWS[0]!];
    assert.deepEqual(applySort(one, "match"), one);
  });
});
