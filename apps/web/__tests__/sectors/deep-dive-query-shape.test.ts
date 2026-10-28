/**
 * Sector deep-dive query shape (MONEY-1092).
 *
 * These are invariants of a `"use server"` action that talks to Prisma, so
 * they cannot be unit-tested without a database. They CAN be scanned for —
 * the same approach `__tests__/navigation/no-unguarded-url-writes.test.ts`
 * takes, and for the same reason: the failure mode is "someone deletes the
 * guard", which a static scan catches and a mocked unit test does not.
 *
 * The three things pinned here were all measured against live prod:
 *
 *   1. EXCHANGE FILTER. Without `exchange: "NSE"` the sector query matched
 *      4,394 rows for Financial Services (BSE 4,104 + NSE 290), of which 278
 *      were dual-listed symbols present on BOTH exchanges — so 278 companies
 *      were counted twice in `totalMcap` and in every weighted average. This
 *      is why the drill-down's market cap never reconciled with the same
 *      sector's row in the ranked table.
 *
 *   2. BOUNDED FETCH. Fixing the old `take: 200` truncation by removing the
 *      cap entirely left the query unbounded — the exact class of defect this
 *      ticket exists to remove.
 *
 *   3. COUNT SOURCE. `count` must come from the QUOTED set the aggregates are
 *      computed over, not the raw instrument row count.
 *
 * Source: apps/web/lib/actions/sector-deep-dive.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = join(process.cwd(), "lib", "actions", "sector-deep-dive.ts");
const src = readFileSync(SOURCE, "utf8");

/** The `instrumentMapping.findMany` block that selects the sector's members. */
function instrumentQueryBlock(): string {
  const start = src.indexOf("prisma.instrumentMapping.findMany");
  assert.notEqual(start, -1, "instrument query not found — did the file move?");
  // Up to the timeout label that closes this particular call.
  const end = src.indexOf('"deep-dive instruments fetch"', start);
  assert.notEqual(end, -1, "instrument query timeout label not found");
  return src.slice(start, end);
}

describe("deep-dive query shape — liveness", () => {
  it("the source file is readable and non-trivial", () => {
    // Guards against the scan passing vacuously if the path breaks.
    assert.ok(
      src.length > 2000,
      "source unexpectedly small — scan may be vacuous"
    );
    assert.match(src, /getSectorDeepDiveAction/);
  });
});

describe("deep-dive instrument query", () => {
  it("filters to a single exchange so dual-listed stocks are not double-counted", () => {
    const block = instrumentQueryBlock();
    assert.match(
      block,
      /exchange:\s*"NSE"/,
      "the sector instrument query MUST filter exchange — without it, dual-listed " +
        "symbols appear on both NSE and BSE and are counted twice in totalMcap " +
        "and every weighted average"
    );
  });

  it("matches the universe the heatmap uses", () => {
    // Both surfaces must read the same universe or their numbers cannot
    // reconcile — that mismatch is the founder-visible bug.
    const heatmap = readFileSync(
      join(process.cwd(), "lib", "actions", "discover-heatmap.ts"),
      "utf8"
    );
    assert.match(heatmap, /exchange:\s*"NSE"/);
    assert.match(instrumentQueryBlock(), /exchange:\s*"NSE"/);
  });

  it("is bounded by an explicit take", () => {
    const block = instrumentQueryBlock();
    assert.match(
      block,
      /take:\s*SECTOR_INSTRUMENT_CAP/,
      "the sector instrument query MUST stay bounded — an unbounded findMany " +
        "here is the same defect class as the heatmap's unindexed sort"
    );
  });

  it("sets that bound well above the largest real sector", () => {
    const m = src.match(/const SECTOR_INSTRUMENT_CAP = (\d+);/);
    assert.ok(m, "SECTOR_INSTRUMENT_CAP not declared");
    const cap = Number(m![1]);
    // Largest NSE sector measured on prod is ~380 (Industrials). A cap at or
    // below that would silently reintroduce the truncated-aggregate bug.
    assert.ok(
      cap >= 1000,
      `SECTOR_INSTRUMENT_CAP is ${cap} — too low; it would truncate real sectors ` +
        "and reintroduce the wrong-aggregates bug this replaced"
    );
  });
});

describe("deep-dive PEER-correlation query", () => {
  /** The peer `instrumentMapping.findMany` used for sector correlation. */
  function peerQueryBlock(): string {
    const start = src.indexOf(
      "prisma.instrumentMapping.findMany",
      src.indexOf("peerSectors")
    );
    assert.notEqual(start, -1, "peer instrument query not found");
    const end = src.indexOf('"deep-dive peer instruments fetch"', start);
    assert.notEqual(end, -1, "peer query timeout label not found");
    return src.slice(start, end);
  }

  it("filters exchange too — the sibling query's fix must not stop at the first query", () => {
    // The original version of THIS scan only looked at the first
    // instrumentMapping query, so it certified the exchange filter while the
    // peer query 250 lines later still double-counted dual-listed symbols.
    assert.match(
      peerQueryBlock(),
      /exchange:\s*"NSE"/,
      "the peer-correlation query must filter exchange, or a dual-listed company " +
        "is weighted twice in the peer return series"
    );
  });

  it("scans a genuinely different query block than the sector's own", () => {
    // Liveness: proves the two helpers are not both reading the same text.
    assert.notEqual(instrumentQueryBlock(), peerQueryBlock());
  });
});

describe("deep-dive aggregates", () => {
  it("reports count from the quoted set the aggregates use, not the raw row count", () => {
    assert.match(
      src,
      /count:\s*merged\.length/,
      "`count` must come from `merged` (constituents with a quote) — using " +
        "`instruments.length` puts a number on screen that no figure beside " +
        "it was derived from"
    );
    assert.doesNotMatch(src, /count:\s*instruments\.length/);
  });

  it("does not reintroduce a display cap on the aggregate input", () => {
    // The preview slice is applied to `constituents`, never to `merged`.
    assert.match(src, /merged\.slice\(0,\s*CONSTITUENT_PREVIEW\)/);
    assert.doesNotMatch(
      src,
      /const totalMcap = merged\.slice/,
      "aggregates must run over the full quoted set, not the preview slice"
    );
  });
});
