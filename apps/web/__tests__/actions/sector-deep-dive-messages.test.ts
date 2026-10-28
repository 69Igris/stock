/**
 * Sector deep-dive failure classification.
 *
 * The panel used to collapse every failure into "The sector breakdown didn't
 * come back", which implied a breakage. Measured, the common failure is a 25s
 * single-flight TIMEOUT on the heavy sectors — Industrials spends ~56% of that
 * budget on DB time alone, and the same query has been observed varying by
 * several seconds run to run. That is a different thing to tell a user, and it
 * has a different next step.
 *
 * The action still sanitises: these are fixed constants carrying no driver
 * text. What the classifier restores is the ONE distinction that changes what
 * the user should do.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifySectorDeepDiveError,
  SECTOR_DEEP_DIVE_TIMEOUT_ERROR,
  SECTOR_DEEP_DIVE_FAILED_ERROR,
} from "../../lib/actions/sector-deep-dive-messages";

describe("classifySectorDeepDiveError", () => {
  test("the timeout constant classifies as timeout", () => {
    assert.equal(
      classifySectorDeepDiveError(SECTOR_DEEP_DIVE_TIMEOUT_ERROR),
      "timeout"
    );
  });

  test("the generic failure constant classifies as generic", () => {
    assert.equal(
      classifySectorDeepDiveError(SECTOR_DEEP_DIVE_FAILED_ERROR),
      "generic"
    );
  });

  test("the SectorNotFoundError text classifies as not-found", () => {
    // Passed through unsanitised on purpose: a permanent answer, not an
    // outage, so the panel offers no retry.
    assert.equal(
      classifySectorDeepDiveError(
        'No instruments mapped to sector "Fictional Sector".'
      ),
      "not-found"
    );
  });

  test("not-found matching is case-insensitive", () => {
    assert.equal(
      classifySectorDeepDiveError("NO INSTRUMENTS MAPPED to sector X"),
      "not-found"
    );
  });

  test("null, undefined and empty all fall back to generic", () => {
    // The panel also renders this branch when `data` is null with no error
    // string at all, so these must not throw or land somewhere surprising.
    assert.equal(classifySectorDeepDiveError(null), "generic");
    assert.equal(classifySectorDeepDiveError(undefined), "generic");
    assert.equal(classifySectorDeepDiveError(""), "generic");
  });

  test("an unrecognised message is generic, never timeout", () => {
    // Only the exact constant may claim "timeout". Loosening this to a
    // substring match would let an unrelated message inherit the reassuring
    // "trying again usually works" copy.
    assert.equal(
      classifySectorDeepDiveError("Something else broke"),
      "generic"
    );
    assert.equal(classifySectorDeepDiveError("timed out"), "generic");
  });

  test("[regression] the two constants are DISTINCT", () => {
    // If these ever collapse to the same string the classifier silently
    // returns "generic" for every timeout, restoring the original bug with
    // every test above still passing on the not-found path.
    assert.notEqual(
      SECTOR_DEEP_DIVE_TIMEOUT_ERROR,
      SECTOR_DEEP_DIVE_FAILED_ERROR
    );
  });

  test("[regression] neither constant leaks driver detail", () => {
    // The sanitising rule the action documents: no query text, no stack, no
    // Prisma/Mongo vocabulary in anything sent to the client.
    for (const msg of [
      SECTOR_DEEP_DIVE_TIMEOUT_ERROR,
      SECTOR_DEEP_DIVE_FAILED_ERROR,
    ]) {
      assert.doesNotMatch(msg, /prisma|mongo|ECONNRESET|at\s+\w+\s+\(/i);
      assert.ok(msg.length < 60, `"${msg}" reads like a dumped error`);
    }
  });
});
