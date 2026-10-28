/**
 * The full-scan ceilings are counted in the UNITS they are reasoned about.
 *
 * `US_FULL_SCAN_MAX` was a flat 20,000 justified as "~3.5x the largest real 13F
 * holder count (a mega-cap draws roughly 5-6k filers)". The `take` counts ROWS,
 * and one filer's position occupies several rows — SEC lets a manager file the
 * same CUSIP once per `otherManagers` combination. Measured on this repo's own
 * fixtures: 3.07 and 3.65 rows per position, worst single position 12. So the
 * real headroom was ~1.1x and the most-queried US ticker sat at the boundary,
 * where truncation would have been its permanent state.
 *
 * That is the rule `PIT_ROWS_PER_PERIOD` states fourteen lines further down the
 * same file, and MONEY-1207 before it. Written down twice, consulted once.
 *
 * These assertions exist so the derivation cannot quietly become a literal
 * again, and so the two ceilings cannot be re-merged: one was argued for a
 * 180-day window and applied to a path that accepts 1825 days.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PIT_ROWS_PER_PERIOD,
  ROWS_PER_13F_POSITION,
  US_FULL_SCAN_MAX,
  US_INSIDER_SCAN_MAX,
  US_MAX_13F_FILERS_PER_ISSUER,
} from "../../src/us-fundamentals/repository";

describe("full-scan ceilings", () => {
  it("the 13F ceiling is DERIVED from filers x rows-per-position, not a literal", () => {
    assert.equal(
      US_FULL_SCAN_MAX,
      US_MAX_13F_FILERS_PER_ISSUER * ROWS_PER_13F_POSITION,
      "the ceiling stopped being derived — a row budget must stay expressed in " +
        "the units of the population it bounds",
    );
  });

  it("carries real headroom over the filer count a mega-cap draws", () => {
    // ~5-6k filers is the measured population for a mega-cap. The OLD constant
    // gave 20_000 / 3.65 ~= 5,479 filers, i.e. under it.
    assert.ok(
      US_MAX_13F_FILERS_PER_ISSUER >= 8_000,
      `only ${US_MAX_13F_FILERS_PER_ISSUER} filers of headroom`,
    );
    assert.ok(
      US_FULL_SCAN_MAX / ROWS_PER_13F_POSITION > 6_000,
      "the ceiling is below the filer count it claims to cover",
    );
  });

  it("the rows-per-position factor covers the WORSE of the two measurements", () => {
    assert.ok(
      ROWS_PER_13F_POSITION >= 4,
      "measured 3.07 and 3.65; a factor below 4 does not cover the worse one",
    );
  });

  it("the insider ceiling is SEPARATE from the 13F one", () => {
    // Sharing them is what let a ceiling argued for a 180-day window govern a
    // path whose caller clamps to 1825 days.
    assert.notEqual(
      US_INSIDER_SCAN_MAX,
      US_FULL_SCAN_MAX,
      "the two ceilings were re-merged; they bound different populations",
    );
    assert.ok(US_INSIDER_SCAN_MAX >= 40_000);
  });

  it("PIT_ROWS_PER_PERIOD — the sibling rule — is still applied in rows", () => {
    // Named here because it is the precedent the 13F ceiling ignored. If this
    // one ever becomes 1, the same units bug has been introduced next door.
    assert.ok(
      PIT_ROWS_PER_PERIOD > 1,
      "a point-in-time take counted in periods rather than rows returns an " +
        "amendment history instead of the periods asked for",
    );
  });
});
