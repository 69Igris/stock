/**
 * BOTH extract writers must build their payload in ONE place — MONEY-1340.
 *
 * There are two `upsertExtract` implementations, in trees that cannot import
 * each other's callers:
 *
 *   workers/src/processors/doc-extract-persist.ts   the online worker
 *   scripts/jobs/doc-ingest-backfill.ts             batch-ingest and the sweep
 *
 * Both hand-built the same ~25-field object, so adding a column meant
 * remembering two places. A column added to one is a column present on some
 * rows and absent on others — and on this table "absent" is the state that
 * five separate tickets in this repo have been about.
 *
 * A SOURCE SCAN rather than a behavioural test, deliberately: the property is
 * "there is no second copy", and no amount of exercising one writer can prove
 * anything about the other. The pattern is the one
 * `financials-write-authority.test.ts` already uses for the same class of
 * guarantee.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const WRITERS = [
  "workers/src/processors/doc-extract-persist.ts",
  "scripts/jobs/doc-ingest-backfill.ts",
] as const;

describe("MONEY-1340 — the extract write payload has exactly one author", () => {
  for (const file of WRITERS) {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");

    it(`${file} builds its payload with the shared builder`, () => {
      assert.ok(
        src.includes("buildExtractWritePayload("),
        `${file} builds an extract payload by hand again — the other writer ` +
          "will drift from it, and the drift is invisible until a reader asks " +
          "for a column that is present on half the rows",
      );
    });

    it(`${file} does not re-declare the figure list`, () => {
      // The tell that a copy has come back: the columns are listed literally
      // in the writer rather than in core. `promptVersion` is the cheapest
      // unique marker of that list.
      const declaresPromptVersion =
        /promptVersion:\s*DOC_FINANCIALS_PROMPT_VERSION/.test(src);
      assert.equal(
        declaresPromptVersion,
        false,
        `${file} stamps promptVersion itself, which means it is assembling ` +
          "the payload rather than delegating it",
      );
    });

    it(`${file} passes the WHOLE verdict, not just its status`, () => {
      // `status` alone is FAILED_VALIDATION for every rejection — the blind
      // spot this ticket closes. A writer that only forwards the status
      // silently writes empty reason arrays.
      assert.ok(
        !/status:\s*(row)?[Vv]erdict\.status,/.test(src),
        `${file} forwards only verdict.status, so validationReasons would be ` +
          "written empty on every row it touches",
      );
    });
  }

  it("[control] the scan can tell a delegating writer from a hand-built one", () => {
    // Without this, every assertion above would also pass against a file that
    // contains neither pattern — an empty file, or a renamed one.
    const handBuilt =
      'const figures = { promptVersion: DOC_FINANCIALS_PROMPT_VERSION };';
    assert.equal(handBuilt.includes("buildExtractWritePayload("), false);
    assert.ok(/promptVersion:\s*DOC_FINANCIALS_PROMPT_VERSION/.test(handBuilt));
  });
});
