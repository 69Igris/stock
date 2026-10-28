/**
 * The record WRITER and both READERS must agree on the field names, and the
 * ordering must key on VISITED — MONEY-1487 review.
 *
 * ## Why a source scan, here of all places
 *
 * This repo's standing rule is that a source scan cannot assert a POLICY: it
 * proves a call site exists, never which of two near-identical expressions is
 * there. That rule is about expressions a scan cannot tell apart — `marks[0]`
 * versus `marks[len - 1]`.
 *
 * These two are told apart by their NAMES, which is exactly the case a scan
 * can settle. And it is the only instrument available: the three programs are
 * `mongosh --eval` STRINGS inside a bash script, so nothing in the TypeScript
 * suite can execute them, and the spawntest's stub replaces the query wholesale
 * and dispatches on env vars rather than on anything the programs write.
 *
 * Review ran both mutations for real and the whole 23-case spawntest stayed
 * GREEN for each:
 *
 *   1. ordering keyed on `lastSuccessAt` instead of `lastAttemptAt`
 *   2. the writer's `lastAttemptAt` renamed
 *
 * (1) is the single decision this ticket rests on. `candles` has failed
 * nightly since 2026-09-01, so under a success-keyed sort it carries no
 * `lastSuccessAt`, sorts at 0, camps at the head for ever and starves the
 * other 53 — MONEY-1255 rebuilt, by the change meant to prevent it.
 * (2) makes the whole feature a silent no-op: every `seen[n]` reads 0, the
 * order degenerates to manifest order, and `--status` reports all 54 NEVER,
 * which is indistinguishable from the not-yet-deployed state.
 *
 * `planSyncOrder` pins the polarity in TypeScript and is well tested — but it
 * is NOT what runs inside the image. Test the JOIN, not just the halves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "ops",
  "sync-prod-to-qa.sh",
);
const SRC = readFileSync(SCRIPT, "utf8");

/** Line comments only — this file's own prose quotes the names it pins. */
const CODE = SRC.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

describe("qa_sync_outcomes: the writer and readers share one schema (MONEY-1487)", () => {
  it("[premise] the script and its outcome programs are present", () => {
    assert.ok(SRC.length > 5000, "sync-prod-to-qa.sh did not load");
    assert.match(CODE, /qa_sync_outcomes/, "the collection is never named");
  });

  it("the WRITER stamps lastAttemptAt on every attempt", () => {
    // MUTATION: rename this field -> every reader's lookup silently reads 0.
    assert.match(
      CODE,
      /lastAttemptAt:\s*now/,
      "the attempt stamp is what both readers join on; renaming it makes the " +
        "whole feature a no-op that reports NEVER for all 54 collections",
    );
  });

  it("the WRITER stamps lastSuccessAt only on RESTORED", () => {
    // Deleting this makes MONEY-1486's `mayUseAsDeltaBound` precondition
    // unsatisfiable by any run — it can never again return true.
    assert.match(CODE, /s === "RESTORED"[\s\S]{0,60}lastSuccessAt\s*=\s*now/);
  });

  it("REGRESSION: the ORDERING reads lastAttemptAt, never lastSuccessAt", () => {
    // The whole ticket. VISITED, not SUCCEEDED.
    const orderingReads = CODE.match(
      /\.find\(\{\},\s*\{[^}]*lastAttemptAt:\s*1[^}]*\}\)/,
    );
    assert.ok(
      orderingReads,
      "the ordering query must project lastAttemptAt — a success-keyed sort " +
        "parks a nightly-failing collection at the head for ever (MONEY-1255)",
    );

    // And the projection must not be the SUCCESS field, in either spelling.
    assert.doesNotMatch(
      CODE,
      /\.find\(\{\},\s*\{[^}]*lastSuccessAt:\s*1[^}]*\}\)/,
      "the ordering must key on VISITED, not SUCCEEDED",
    );
    assert.doesNotMatch(
      CODE,
      /seen\[d\._id\]\s*=\s*d\.lastSuccessAt/,
      "the ordering must key on VISITED, not SUCCEEDED",
    );
  });

  it("the ordering falls back to 0 for a collection never recorded", () => {
    // A never-visited collection must sort FIRST, not last — otherwise a new
    // collection is only ever reached once every other one has been.
    assert.match(CODE, /seen\[d\._id\]\s*=\s*d\.lastAttemptAt instanceof Date/);
    assert.match(CODE, /getTime\(\)\s*:\s*0/);
  });

  it("the scan SEES the mutations it forbids (mutation check)", () => {
    // Without this, a regex that matched nothing would pass for ever.
    const mutated = CODE.replace(/lastAttemptAt:\s*1/g, "lastSuccessAt: 1");
    assert.match(
      mutated,
      /\.find\(\{\},\s*\{[^}]*lastSuccessAt:\s*1[^}]*\}\)/,
      "the forbidden shape is not detectable by this pattern",
    );
    assert.doesNotMatch(
      CODE.replace(/lastAttemptAt:\s*now/, "lastVisitedAt: now"),
      /lastAttemptAt:\s*now/,
      "the writer assertion cannot see a rename",
    );
  });
});
