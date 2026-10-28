/**
 * The secret resolver must never report a reason that says nothing.
 *
 * This module exists because a `catch { return null }` collapsed four states
 * into one — the secret does not exist, the secret exists with NO VERSIONS, the
 * caller is not authorised, gcloud is not installed. It bit immediately:
 * `ALGO_MONGODB_URI_RO_PROD` IS listed by `gcloud secrets list` because the
 * container was created, and has zero versions, so a run reported "cluster not
 * measured" with no reason — indistinguishable from "there is no algo cluster".
 *
 * The fourth of those states then turned out to be unreportable by the fix
 * itself, which is what this file guards.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { GCP_PROJECT_ID, secret } from "../../src/ops/gcp-secrets";

/** Run `fn` with `gcloud` unreachable on PATH, then restore. */
function withoutGcloud<T>(fn: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = "/nonexistent-for-this-test";
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

test("a spawn failure produces a reason with actual text in it", () => {
  // `stderr.split("\n")[0] ?? String(err)` was the bug. When gcloud cannot be
  // SPAWNED at all there is no `stderr`, so `""` .split()[0] is `""` — which is
  // not nullish and sails straight past `??`. The reason then rendered as
  // "`NAME` — " with NOTHING after the dash: the one state of the four this
  // module exists to name that it could not name. `||` is the fix.
  const result = withoutGcloud(() => secret("ANY_SECRET_NAME"));

  assert.ok("reason" in result, "an unspawnable gcloud is never a value");
  const { reason } = result as { reason: string };

  assert.ok(reason.includes("ANY_SECRET_NAME"), "the reason names the secret");
  assert.ok(
    !/—\s*$/.test(reason),
    `the reason trails off after the dash with no cause: ${JSON.stringify(reason)}`,
  );
  // The generic invariant, not a match on one error string: whatever follows
  // the dash must be non-empty.
  const after = reason.split("—").slice(1).join("—").trim();
  assert.ok(
    after.length > 0,
    `nothing follows the dash: ${JSON.stringify(reason)}`,
  );
});

test("the project id is single-sourced", () => {
  // Four copies of this literal existed before the extraction; the point of the
  // module is that a new caller imports rather than re-declares.
  assert.equal(GCP_PROJECT_ID, "stock-book-483718");
});
