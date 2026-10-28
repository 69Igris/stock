/**
 * `describeHoldingFlag` — the login briefing's "Flags On Your Holdings" line
 * (MONEY-1205).
 *
 * ## Why this file exists in `workers/` when a briefing test already exists
 *
 * The SOURCE lives in `workers/src/processors/login-briefing-logic.ts`, so this
 * is its home workspace. `apps/web/__tests__/workers/login-briefing.test.ts`
 * covers the briefing's section assembly and pins the four kind sentences it
 * always pinned; it does NOT — and, sitting in a different workspace, is not
 * the place to — cover the defect this ticket fixed. Nothing here duplicates
 * an assertion made there.
 *
 * The defect: the briefing built the band sentence itself as
 * `Price band ${from}% → ${to}%`, appending `%` to BOTH sides. NSE publishes
 * `No Band` for F&O names — 208 of 3,489 stocks on 2026-08-17 — so the email
 * read "Price band 5% → No Band%". The identical bug shipped on the stock
 * header and in the alert notification text, from three hand-written copies of
 * one decode.
 *
 * What is pinned here is that the copies are GONE: `describeHoldingFlag` now
 * owns only the TENSE (a STATE flag is "since", a POINT event is "on") and
 * delegates the value entirely to `formatStockFlagValue`. So the band rule is
 * asserted once, in core, and this file asserts that the briefing actually goes
 * through it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeHoldingFlag } from "../../src/processors/login-briefing-logic";

const aug = (day: number): Date => new Date(Date.UTC(2026, 7, day));

describe("describeHoldingFlag — MONEY-1205", () => {
  it("never appends `%` to the word `No Band`", () => {
    const line = describeHoldingFlag({
      symbol: "HDFCBANK",
      kind: "BAND_CHANGE",
      value: '{"from":"5","to":"No Band"}',
      since: aug(4),
    });
    assert.ok(!line.includes("Band%"), line);
    assert.equal(line, "Price band 5% → no band on 4 Aug 2026");
  });

  it("uses `on` for a POINT event and `since` for a standing STATE", () => {
    // A band change happened on one day and cannot be "since" anything; an F&O
    // ban is a condition with a start date. The shape table decides, so the two
    // tenses cannot drift apart per surface.
    assert.match(
      describeHoldingFlag({
        symbol: "X",
        kind: "BAND_CHANGE",
        value: '{"from":"5","to":"10"}',
        since: aug(4),
      }),
      / on 4 Aug 2026$/,
    );
    assert.match(
      describeHoldingFlag({
        symbol: "X",
        kind: "SERIES_CHANGE",
        value: '{"from":"EQ","to":"BE"}',
        since: aug(4),
      }),
      / on 4 Aug 2026$/,
    );
    assert.match(
      describeHoldingFlag({
        symbol: "X",
        kind: "FO_BAN",
        value: "BAN",
        since: aug(4),
      }),
      / since 4 Aug 2026$/,
    );
    assert.match(
      describeHoldingFlag({
        symbol: "X",
        kind: "SURVEILLANCE",
        value: "GSM STAGE - I",
        since: aug(4),
      }),
      / since 4 Aug 2026$/,
    );
  });

  it("keeps a surveillance code BYTE-IDENTICAL and never emits JSON", () => {
    // The verbatim-storage rule: NSE's exact wording reaches the reader, so a
    // better decode table can improve rows written years ago.
    assert.equal(
      describeHoldingFlag({
        symbol: "X",
        kind: "SURVEILLANCE",
        value: "Long Term Additional Surveillance Measure (LTASM) - Stage I",
        since: aug(4),
      }),
      "Long Term Additional Surveillance Measure (LTASM) - Stage I since 4 Aug 2026",
    );

    for (const [kind, value] of [
      ["BAND_CHANGE", '{"from":"5","to":"No Band"}'],
      ["SERIES_CHANGE", '{"from":"EQ","to":"BE"}'],
      ["PRICE_BAND", '{"band":"5"}'],
      ["SHORT_SELLING", '{"qty":106000}'],
    ] as const) {
      const line = describeHoldingFlag({
        symbol: "X",
        kind,
        value,
        since: aug(4),
      });
      assert.ok(!line.includes("{"), `${kind} leaked JSON: ${line}`);
    }
  });

  it("does not throw on a malformed value, and does not print the blob", () => {
    const line = describeHoldingFlag({
      symbol: "X",
      kind: "BAND_CHANGE",
      value: "not json at all",
      since: aug(4),
    });
    assert.equal(line, "Price band changed on 4 Aug 2026");
    assert.ok(!line.includes("not json"), "a broken value must not be shown");
  });
});
