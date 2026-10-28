/**
 * MONEY-1274 — the DB-first short-circuit must answer the question that was ASKED.
 *
 * ## The defect
 *
 * `fetch-income-statement`, `fetch-balance-sheet` and `fetch-cash-flow` are
 * DB-first (MONEY-614): they serve the synced `StockFinancials` rows and only
 * fall through to Yahoo for un-synced symbols. Their gate was "the DB has
 * ANNUAL rows", which is a different question from "the DB can answer this".
 *
 * Measured 2026-08-28: `stock_financials` holds 32,359 rows and ZERO of
 * `periodType: "QUARTERLY"` — the XBRL projection that would write them ships
 * `XBRL_PROJECTION_APPLY=false` and has never written a row. So a
 * `quarterly: true` call found annual rows, returned on their strength, and
 * never reached Yahoo's `*HistoryQuarterly` module, the only source that has
 * quarterly figures.
 *
 * The caller received `success: true` with no `quarterly` key. Nothing threw,
 * so the model reported "no quarterly data for this company" — confidently and
 * wrongly — for exactly the 2,123 covered large caps users ask about.
 *
 * ## Why these tests are unit tests on the predicate
 *
 * The rule is now one exported function that all three tools call, so it can be
 * tested directly rather than through three `execute` paths that each need a
 * database and a network. The companion scan below pins that the three tools
 * actually CALL it — a correct predicate nothing uses would pass every test
 * here and fix nothing.
 *
 * Source under test: packages/research/src/tools/db-first-coverage.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dbFirstSatisfiesRequest } from "../src/tools/db-first-coverage";

describe("dbFirstSatisfiesRequest", () => {
  it("[regression] annual rows do NOT satisfy a request that asked for quarterly", () => {
    // THE BUG, as one assertion. This is the production shape: the DB has
    // annual and, for every symbol, zero quarterly. It must fall through.
    assert.equal(
      dbFirstSatisfiesRequest({
        annualUsable: true,
        quarterlyCount: 0,
        quarterlyRequested: true,
      }),
      false,
      "annual-only must not short-circuit a quarterly request — that is what " +
        "skipped Yahoo and returned success with no quarterly key",
    );
  });

  it("annual rows DO satisfy a request that did not ask for quarterly", () => {
    // The unchanged, common case: no gap exists, so no round trip is owed.
    assert.equal(
      dbFirstSatisfiesRequest({
        annualUsable: true,
        quarterlyCount: 0,
        quarterlyRequested: false,
      }),
      true,
    );
  });

  it("satisfies a quarterly request once the DB actually has quarterly", () => {
    // The post-projection future: when XBRL_PROJECTION_APPLY is armed and the
    // drain has run, this path starts serving from the DB again with no code
    // change. Pinned so the fix does not become a permanent Yahoo detour.
    assert.equal(
      dbFirstSatisfiesRequest({
        annualUsable: true,
        quarterlyCount: 4,
        quarterlyRequested: true,
      }),
      true,
    );
  });

  it("an unusable annual never satisfies, whatever the quarterly says", () => {
    // `annualUsable` is the caller's own judgement — row count for income and
    // cash flow, the currentAssets DETAIL gate for the balance sheet. When it
    // is false the tool must reach Yahoo regardless, or the forensic tools
    // (Altman / working-capital / Piotroski) stay starved.
    for (const [quarterlyCount, quarterlyRequested] of [
      [0, false],
      [0, true],
      [4, true],
      [4, false],
    ] as const) {
      assert.equal(
        dbFirstSatisfiesRequest({
          annualUsable: false,
          quarterlyCount,
          quarterlyRequested,
        }),
        false,
        `annualUsable:false must never satisfy (q=${quarterlyCount}, requested=${quarterlyRequested})`,
      );
    }
  });

  it("is decided by presence, not by how MANY quarters came back", () => {
    // One quarter is thin but real coverage; the tool's job is to stop asking
    // other sources, not to judge sufficiency. Asserted so nobody later adds a
    // minimum-count threshold here, where it would silently re-open the same
    // "fell through and lost the annual" hole this ticket also closed.
    for (const n of [1, 2, 4, 12]) {
      assert.equal(
        dbFirstSatisfiesRequest({
          annualUsable: true,
          quarterlyCount: n,
          quarterlyRequested: true,
        }),
        true,
        `${n} quarterly row(s) must satisfy`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The wiring. A correct predicate that nothing calls fixes nothing.
// ─────────────────────────────────────────────────────────────────────────

const TOOLS = [
  ["fetch-income-statement", "income"],
  ["fetch-balance-sheet", "balanceSheet"],
  ["fetch-cash-flow", "cashFlow"],
] as const;

const read = (name: string) =>
  readFileSync(join(process.cwd(), `src/tools/${name}.ts`), "utf8");

describe("the three DB-first statement tools are wired to the shared rule", () => {
  for (const [tool] of TOOLS) {
    it(`${tool} calls dbFirstSatisfiesRequest`, () => {
      const src = read(tool);
      assert.match(
        src,
        /dbFirstSatisfiesRequest\(\{/,
        `${tool} must gate its DB short-circuit on the shared predicate, not a ` +
          `local condition — three local copies is how they drifted apart`,
      );
    });

    it(`${tool} asks the DB for QUARTERLY before deciding`, () => {
      // The predicate can only be right if it is fed a real count. Reading the
      // quarterly rows AFTER the short-circuit (the old shape) makes the
      // argument unknowable at the point of decision.
      const src = read(tool);
      const decideAt = src.indexOf("dbFirstSatisfiesRequest({");
      const fetchQAt = src.indexOf('"QUARTERLY"');
      assert.ok(fetchQAt > -1, `${tool} no longer reads quarterly from the DB`);
      assert.ok(
        fetchQAt < decideAt,
        `${tool} must read the QUARTERLY rows BEFORE the short-circuit decision`,
      );
    });

    it(`${tool} still reports DB annual rather than failing when it falls through`, () => {
      // Falling through for the quarterly half must never cost the caller the
      // annual it already had. Before this ticket, asking for quarterly could
      // turn a working annual answer into `success: false` — strictly worse
      // than not asking at all.
      const src = read(tool);
      assert.match(
        src,
        /quarterlyUnavailable/,
        `${tool} must return the DB annual with an explicit ` +
          `quarterlyUnavailable marker instead of reporting no data at all`,
      );
    });
  }
});
