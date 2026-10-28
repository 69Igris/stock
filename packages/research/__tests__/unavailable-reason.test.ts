/**
 * MONEY-1274 (Bug 2) — an outage must not be reported as a fact about a company.
 *
 * ## The defect
 *
 * A statement tool that found nothing returned:
 *
 *     { success: false, error: `No income statement data found for ${symbol}` }
 *
 * `buildUnavailableSourceLines` puts that string in front of the model
 * unchanged, so the model reports it as a finding — "TCS has no income
 * statement data". That is a claim about the COMPANY, and it was produced
 * identically whether every source threw, our egress was blocked, or the
 * symbol is a genuinely uncovered SME. Only the last is true.
 *
 * `tryChainDetailed` (MONEY-1146) already computed the difference — `errors[]`
 * for sources that THREW, `emptyCount` for sources that answered cleanly with
 * nothing — and had NO caller outside its own module. The diagnosis was
 * calculated and discarded on every request, which is why this could not be
 * seen from the outside.
 *
 * Source under test: packages/research/src/tools/unavailable.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeUnavailable } from "../src/tools/unavailable";

const FAILED = {
  errors: [{ source: "screener", message: "HTTP 403" }],
  emptyCount: 0,
};
const NO_COVERAGE = { errors: [], emptyCount: 1 };

describe("describeUnavailable", () => {
  it("[regression] a failed lookup never asserts the company lacks the data", () => {
    // THE BUG. The old string said "No income statement data found for TCS",
    // which the model reports as a property of TCS. When every source threw we
    // learned NOTHING about TCS, so nothing may be implied about it.
    const out = describeUnavailable("an income statement", "TCS", FAILED);
    assert.equal(out.success, false);
    assert.match(out.error, /source problem/i);
    assert.match(
      out.error,
      /do not report the figures as missing or unavailable/i,
      "the model must be told explicitly not to convert an outage into a finding",
    );
    assert.equal(out.metadata.unavailableReason, "lookup_failed");
  });

  it("[regression] a failed lookup sets sourceError, which the synthesizer keys off", () => {
    // `metadata.sourceError` is what the RC4 path in buildUnavailableSourceLines
    // reads to say "source temporarily unavailable" rather than "the company
    // lacks data". Without it the honest error text is the only signal and the
    // structured path stays blind.
    const out = describeUnavailable("a balance sheet", "TCS", FAILED);
    assert.equal(typeof out.metadata.sourceError, "string");
    assert.match(String(out.metadata.sourceError), /screener.*403/i);
  });

  it("no-coverage attributes the gap to OUR SOURCES, not to the company", () => {
    // This ending is a real absence, but still not a claim about the company's
    // filings — it is a claim about what we can see.
    const out = describeUnavailable(
      "a cash flow statement",
      "SOMESME",
      NO_COVERAGE,
    );
    assert.equal(out.metadata.unavailableReason, "no_coverage");
    assert.match(out.error, /from our data sources/i);
    assert.match(
      out.error,
      /BSE-only, SME\/Emerge and recently listed/i,
      "name the legitimate reasons so the model does not treat it as suspicious",
    );
  });

  it("no-coverage must NOT set sourceError — that would invent an outage", () => {
    // The opposite lie to the one being fixed. Setting it here would make the
    // synthesizer report a source failure that did not happen.
    const out = describeUnavailable(
      "an income statement",
      "SOMESME",
      NO_COVERAGE,
    );
    assert.equal(out.metadata.sourceError, undefined);
  });

  it("the two endings produce materially different text", () => {
    // Guards against a future edit collapsing them back into one message,
    // which is exactly the state this ticket found.
    const failed = describeUnavailable("an income statement", "TCS", FAILED);
    const empty = describeUnavailable(
      "an income statement",
      "TCS",
      NO_COVERAGE,
    );
    assert.notEqual(failed.error, empty.error);
    assert.notEqual(
      failed.metadata.unavailableReason,
      empty.metadata.unavailableReason,
    );
  });

  it("a mixed ending counts as FAILED — one throw voids the absence", () => {
    // If any source threw, the chain cannot establish absence: the source that
    // failed might have been the one with the data. Erring toward "we do not
    // know" is the only safe direction.
    const out = describeUnavailable("an income statement", "TCS", {
      errors: [{ source: "screener", message: "ETIMEDOUT" }],
      emptyCount: 2,
    });
    assert.equal(out.metadata.unavailableReason, "lookup_failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The wiring — MONEY-1146's mechanism had no caller for a reason.
// ─────────────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the statement tools report WHY, and the chain reports HOW it ended", () => {
  for (const tool of [
    "fetch-income-statement",
    "fetch-balance-sheet",
    "fetch-cash-flow",
  ]) {
    it(`${tool} no longer claims the company has no data`, () => {
      const src = read(`src/tools/${tool}.ts`);
      assert.doesNotMatch(
        src,
        /error: `No .*data found for \$\{symbol\}`/,
        `${tool} must not assert absence it has not established`,
      );
      assert.match(src, /describeUnavailable\(/);
    });

    it(`${tool} uses the DETAILED chain so an ending exists to report`, () => {
      // Without this the outcome is unavailable at the point of decision and
      // `describeUnavailable` would have to be fed a guess.
      const src = read(`src/tools/${tool}.ts`);
      assert.match(src, /fetchFinancialsChainDetailed\(/);
    });
  }

  it("fetchFinancialsChain still exists for the callers that want plain data", () => {
    // The nine existing call sites are unchanged on purpose; widening all of
    // them was what deferred MONEY-1146's mechanism in the first place.
    const chain = read("src/data-sources/data-source-chain.ts");
    assert.match(chain, /export async function fetchFinancialsChain\(/);
    assert.match(chain, /export async function fetchFinancialsChainDetailed\(/);
  });
});
