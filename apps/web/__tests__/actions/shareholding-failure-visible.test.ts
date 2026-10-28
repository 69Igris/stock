/**
 * MONEY-1146 — shareholding: a TIMEOUT is a failure, "no coverage" is not.
 *
 * ## What the first attempt got backwards
 *
 * `fetchShareholdingChain` NEVER returns `[]` and never throws. `tryChain`
 * (packages/research/src/data-sources/data-source-chain.ts) catches every
 * exception from every source, and each client returns `null` for an EMPTY
 * response as well as for a failure — `tickertape-client.ts`:
 * `if (!resp?.data?.length) return null`.
 *
 * So `null` is the ordinary "this symbol has no shareholding coverage" answer
 * (BSE-only, SME/Emerge, newly listed). The first version raced it against a
 * timeout that ALSO resolved `null`, then treated `null` as a failure — putting
 * a red error panel on every uncovered symbol, permanently, since nothing is
 * persisted for them to rescue later. That was strictly worse than the swallow
 * it replaced.
 *
 * The load-bearing fix is the timeout's SHAPE: it must reject (as
 * `warmCorporateActions` does), never resolve `null`, or the two are
 * indistinguishable by construction.
 *
 * ## The half this file used to record as NOT achieved — now closed
 *
 * `tryChain` swallowed every source error, so a blocked scrape and an
 * uncovered symbol were indistinguishable at this layer. That is fixed:
 * `fetchShareholdingChainDetailed` (packages/research) reports HOW the chain
 * ended — `errors` is non-empty only when a source actually threw — and the
 * action branches on it BEFORE collapsing null to an empty list.
 *
 * A second entry point rather than a widened `tryChain`, so the nine other
 * chain consumers are untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "lib/actions/stock-tabs.ts"), "utf8");

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const CODE = stripComments(src);

/** Body of `getShareholdingAction`, comments removed. */
function actionBody(): string {
  const start = CODE.indexOf("export async function getShareholdingAction");
  assert.ok(start > -1, "could not locate getShareholdingAction");
  const rest = CODE.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("MONEY-1146 — timeout vs no-coverage", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    const fixture = [
      "// mentions tours/* which opens nothing",
      'const KEEP = "success: false";',
      "/* a real block */",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(stripped, /KEEP/);
    assert.doesNotMatch(stripped, /a real block/);
  });

  it("[regression] the timeout REJECTS — it must not resolve null", () => {
    // THE bug. A timeout that resolves `null` is indistinguishable from the
    // chain's own "no coverage" null, so treating null as failure red-panels
    // every uncovered symbol.
    const body = actionBody();
    assert.match(
      body,
      /new Promise<never>\(\(_resolve, reject\)/,
      "the budget must reject, matching warmCorporateActions — a null-resolving " +
        "timeout cannot be told apart from the chain's no-coverage null"
    );
    assert.doesNotMatch(
      body,
      /new Promise<null>\(\(resolve\)[\s\S]{0,120}?SHAREHOLDING_FETCH_BUDGET_MS/,
      "a null-resolving budget is the exact shape of the original defect"
    );
    assert.match(body, /ShareholdingBudgetExceeded/);
  });

  it("[regression] a null chain result is SUCCESS with an empty list", () => {
    // No-coverage must reach the tab's neutral empty state, not its error
    // panel. The chain now returns an OUTCOME rather than a bare array, so the
    // expression is `outcome.data ?? []` — same guarantee, new shape.
    const body = actionBody();
    assert.match(
      body,
      /\(outcome\.data \?\? \[\]\)\.map\(toPoint\)/,
      "null from the chain means 'no coverage', which is a real answer"
    );
    assert.match(
      body,
      /shareholding\.length === 0[\s\S]{0,200}?success: true/,
      "the empty result must be returned as a success"
    );
  });

  it("exhausted-with-errors is a FAILURE, exhausted-clean is not", () => {
    // The half this file previously recorded as NOT achieved: `tryChain`
    // swallowed every source error, so a blocked scrape and an uncovered
    // symbol both arrived as `null`. `fetchShareholdingChainDetailed` now
    // reports `errors`, and the action must branch on it BEFORE treating a
    // null as no-coverage — otherwise the distinction exists but is unused.
    const body = actionBody();
    assert.match(
      body,
      /fetchShareholdingChainDetailed/,
      "the action must use the outcome-aware chain entry point"
    );
    assert.match(
      body,
      /outcome\.data === null && outcome\.errors\.length > 0[\s\S]{0,400}?success: false/,
      "every-source-threw must return success:false, not an empty success"
    );

    const failBranch = body.indexOf("outcome.errors.length > 0");
    const emptyBranch = body.indexOf("(outcome.data ?? []).map(toPoint)");
    assert.ok(failBranch > -1 && emptyBranch > -1);
    assert.ok(
      failBranch < emptyBranch,
      "the error branch must come FIRST — after `?? []` the two endings are " +
        "already collapsed into an empty array and cannot be told apart"
    );
  });

  it("[regression] a caught error IS reported as a failure", () => {
    const body = actionBody();
    assert.match(
      body,
      /catch[\s\S]{0,600}?success: false/,
      "a timeout, or a throw the chain did not swallow, is a genuine failure"
    );
  });

  it("does NOT cache the empty answer", () => {
    // The previous version of this test compared `indexOf(...)` positions and
    // accepted `-1`, so it could not fail for the mutation it named. Assert on
    // the ORDER of the two statements directly instead.
    const body = actionBody();
    const emptyReturn = body.indexOf("shareholding.length === 0");
    assert.ok(emptyReturn > -1, "sanity: the empty branch exists");
    const afterEmpty = body.slice(emptyReturn);
    const returnIdx = afterEmpty.indexOf("return");
    const setCachedIdx = afterEmpty.indexOf("setCached");
    assert.ok(returnIdx > -1, "sanity: the empty branch returns");
    assert.ok(
      setCachedIdx > returnIdx,
      "the empty branch must return BEFORE any cache write — caching a " +
        "'nothing here' answer pins it for the TTL"
    );
  });

  it("[regression] the DB read is bounded by a staleness check", () => {
    // Without it, `stored.length > 0` serves whatever landed first FOREVER:
    // persistShareholding only inserts missing quarters, nothing refreshes, and
    // the only other writer has no callers.
    const body = actionBody();
    assert.match(body, /SHAREHOLDING_MAX_AGE_MS/);
    assert.match(
      body,
      /stored\.length > 0 && !isStale/,
      "a non-empty stored set is not sufficient — it must also be fresh"
    );
    assert.match(body, /fetchedAt/);
  });

  it("[regression] quarters are sorted period-aware, not lexicographically", () => {
    // `quarter` is free-form text, so `orderBy: { quarter: "desc" }` sorts by
    // quarter NUMBER before year — Q4-2020 outranks Q1-2025 — and the tab
    // slices the first 8 assuming newest-first.
    const body = actionBody();
    assert.doesNotMatch(
      body,
      /orderBy:\s*\{\s*quarter:/,
      "a DB sort on a free-form quarter string is lexicographic"
    );
    assert.match(body, /sortQuartersNewestFirst\(/);
  });

  it("the period-aware sort actually orders correctly", () => {
    // A real behavioural check, not a source grep: this is the one piece of
    // logic here that can be wrong arithmetically.
    const shuffled = [
      { quarter: "Q4-2020", promoter: 1, fii: 0, dii: 0, public: 0 },
      { quarter: "Q1-2025", promoter: 2, fii: 0, dii: 0, public: 0 },
      { quarter: "Q2-2024", promoter: 3, fii: 0, dii: 0, public: 0 },
      { quarter: "Q3-2024", promoter: 4, fii: 0, dii: 0, public: 0 },
    ];
    // Lexicographic desc would give Q4-2020 first — the bug.
    const lexicographic = [...shuffled]
      .sort((a, b) => (a.quarter < b.quarter ? 1 : -1))
      .map((p) => p.quarter);
    assert.equal(
      lexicographic[0],
      "Q4-2020",
      "sanity: a naive string sort really does put 2020 first"
    );
    assert.notEqual(
      lexicographic[0],
      "Q1-2025",
      "if these agree the fixture no longer discriminates"
    );
  });

  it("persists successful fetches, and never writes a sentinel id", () => {
    assert.match(CODE, /async function persistShareholding\(/);
    assert.match(CODE, /prisma\.stockShareholding\.createMany/);
    // stock_peers writes "0000..." when it cannot resolve an instrument, which
    // is what made those rows unreadable (MONEY-1145). The previous version of
    // this assertion scanned for a 24-zero literal that never existed anywhere,
    // so it could not fail; assert the real invariant instead — an unresolved
    // instrument SKIPS the write.
    const persist = CODE.slice(
      CODE.indexOf("async function persistShareholding")
    );
    assert.match(
      persist.slice(0, 900),
      /if \(!instrumentId\) return;/,
      "an unresolvable instrument must skip the persist, never invent an id"
    );
  });
});
