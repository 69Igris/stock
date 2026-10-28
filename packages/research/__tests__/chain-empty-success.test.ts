/**
 * MONEY-1274 — the chain fallback must not report success with nothing in it.
 *
 * ## The defect
 *
 * The three statement tools ended their Screener fallback like this:
 *
 *     const chainResult = await fetchFinancialsChain(symbol);
 *     if (chainResult) {
 *       const ttIncome = (chainResult.data as { income?: unknown[] }).income;
 *       const chainRows = Array.isArray(ttIncome) ? mapChainRows(ttIncome) : [];
 *       const annual = toToolStatements(chainRows);
 *       return { success: true, data: { annual }, ... };   // <- unconditional
 *     }
 *
 * `annual` is EMPTY on every real run. The chain has been Screener-only since
 * MONEY-1220 (Tickertape 403s our egress), and `ScreenerFinancialData` carries
 * `annualRevenue` / `annualProfit` / `annualRoe` — it has NO `income`,
 * `balanceSheet` or `cashFlow` array. So the key read above is always
 * `undefined`, `chainRows` is always `[]`, and the tool returned
 * `success: true` with an EMPTY statement list.
 *
 * The model reads an empty list as "this company has no statements".
 *
 * ## Why it mattered more than it looks
 *
 * That return sat BEFORE the DB-annual fallback and `describeUnavailable`
 * added earlier in this same ticket, so whenever Screener answered it silently
 * PREEMPTED both — the honest "not covered vs lookup failed" message and the
 * "report the annual we already have" rescue were unreachable on exactly the
 * path they were written for.
 *
 * Source under test: the three fetch-* statement tools.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const TOOLS = [
  "fetch-income-statement",
  "fetch-balance-sheet",
  "fetch-cash-flow",
] as const;

describe("the chain fallback only reports success when it produced rows", () => {
  for (const tool of TOOLS) {
    it(`${tool} guards its chain return on annual.length`, () => {
      const src = code(`src/tools/${tool}.ts`);
      // Every `data: { annual }` return must sit inside an `annual.length > 0`
      // guard. Asserted by counting: two such returns per file (happy path +
      // catch-block mirror), and at least two guards.
      const returns = src.match(/data:\s*\{\s*annual\s*\}/g) ?? [];
      const guards = src.match(/if\s*\(annual\.length > 0\)\s*\{/g) ?? [];
      assert.ok(returns.length > 0, `${tool} no longer returns chain rows`);
      assert.ok(
        guards.length >= returns.length,
        `${tool}: ${returns.length} chain return(s) but only ${guards.length} ` +
          `length guard(s) — an unguarded one reports success with an empty list`,
      );
    });

    it(`${tool} can still REACH its unavailable/DB fallback`, () => {
      // The point of the guard. If the chain branch returns unconditionally,
      // everything after it is dead code — which is what silently disabled the
      // two fixes made earlier in this ticket.
      //
      // Compared against the FIRST chain return (the try-block one). The
      // SECOND lives in the catch block and legitimately sits after
      // describeUnavailable, so `lastIndexOf` would compare the wrong pair —
      // it did, and this test failed against correct code until fixed.
      const src = code(`src/tools/${tool}.ts`);
      const firstChainReturn = src.indexOf("data: { annual }");
      const unavailable = src.indexOf("describeUnavailable(");
      assert.ok(firstChainReturn > -1, `${tool} no longer returns chain rows`);
      assert.ok(unavailable > -1, `${tool} lost its unavailable path`);
      assert.ok(
        unavailable > firstChainReturn,
        `${tool}: describeUnavailable sits BEFORE the chain return, so the ` +
          `chain path can never fall through to it`,
      );
    });
  }

  it("[regression] the Screener payload genuinely lacks the statement keys", () => {
    // The premise of the whole bug, asserted rather than assumed: if
    // ScreenerFinancialData ever GAINS these arrays the fallback starts
    // producing rows, and this test should be revisited rather than silently
    // continuing to describe a shape that changed.
    // Read RAW, not comment-stripped: the declaration is preceded by doc
    // comments and the stripper was eating the anchor this slice depends on.
    const screener = read("src/data-sources/screener-client.ts");
    const start = screener.indexOf("export interface ScreenerFinancialData");
    assert.ok(start > -1, "ScreenerFinancialData not found");
    const iface = screener.slice(start, screener.indexOf("\n}", start));
    assert.ok(iface.length > 0, "ScreenerFinancialData body not found");
    for (const key of ["income", "balanceSheet", "cashFlow"]) {
      assert.ok(
        !new RegExp(`\\b${key}\\s*[?:]`).test(iface),
        `ScreenerFinancialData now has \`${key}\` — the chain fallback may ` +
          `produce rows again; re-check the empty-success guard`,
      );
    }
    // The keys it DOES carry, so the assertion above cannot pass vacuously on
    // a renamed or emptied interface.
    assert.match(iface, /annualRevenue/);
    assert.match(iface, /annualProfit/);
  });
});
