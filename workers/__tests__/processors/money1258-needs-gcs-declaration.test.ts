/**
 * A job that uploads to GCS must DECLARE that it needs GCS — MONEY-1258.
 *
 * ## What happened
 *
 * `run-market-data-job.sh` declares each job's needs. `NEEDS_GCS=1` exports
 * `GCP_PROJECT_ID` and `GCP_STORAGE_BUCKET` and refuses to start without
 * credentials; `NEEDS_GCS=0` runs the script with `DATABASE_URL` and nothing
 * else.
 *
 * `bseresults` was declared `NEEDS_GCS=0` and uploads PDFs. `uploadFile`
 * (@usemoney/storage) requires both of those variables, so every upload threw
 * — into a best-effort `catch` that logged nothing.
 *
 * Measured on prod 2026-08-27, one apply run wrote 59 rows:
 *
 *     gcsPath == ""                          59  (100%)
 *     fileSize == 0                          59
 *     breadcrumb says BSE HAD an attachment  59
 *
 * BSE offered a PDF every time and we stored none, while the run's own summary
 * reported a clean create/supersede tally. The script's confirmation prompt
 * even said "This will WRITE to a database AND upload PDFs to GCS" — the
 * declaration and the job disagreed, and the declaration won silently.
 *
 * ## Why an empty gcsPath is durable damage, not a cosmetic gap
 *
 * `gcsPath: ""` makes the parse lane terminal-FAIL the row on its first
 * `downloadFromGCS("")`, and the row occupies
 * `@@unique([symbol, exchange, docType, period])` — so a later correct run has
 * to overwrite a row something already marked terminal. Prod carries 1,352
 * rows of exactly this shape from the nightly job.
 *
 * ## The invariant
 *
 * If a script imports `@usemoney/storage`, the wrapper case that runs it must
 * declare `NEEDS_GCS=1`. That is checkable from the two files, and it is the
 * general form of the bug rather than a patch for the one job that hit it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// MONEY-1326 — every path below is anchored to THIS FILE, never to
// `process.cwd()`. The reads used to be bare relative strings, so they resolved
// correctly only when the runner's cwd happened to be `workers/` (which is what
// `yarn test` does, per-workspace) and threw ENOENT from the repo root. Same
// class as the MONEY-1314 coverage test that resolved its roots from the cwd
// and silently scanned ZERO files.
const ROOT = join(import.meta.dirname, "..", "..", "..");

const WRAPPER = join(ROOT, "scripts", "ops", "run-market-data-job.sh");
const wrapper = readFileSync(WRAPPER, "utf8");

/** `job) SCRIPT="path"; … NEEDS_GCS=n` → one row per declared job. */
function declarations(): Array<{ job: string; script: string; gcs: string }> {
  const out: Array<{ job: string; script: string; gcs: string }> = [];
  const re =
    /^\s*(\w+)\)\s*SCRIPT="([^"]+)";\s*(?:[^\n]*?)NEEDS_GCS=(\d)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wrapper)) !== null) {
    out.push({ job: m[1], script: m[2], gcs: m[3] });
  }
  return out;
}

const DECLS = declarations();

describe("wrapper NEEDS_GCS matches what the script actually does (MONEY-1258)", () => {
  it("[meta] the parser finds the job table", () => {
    // Ceiling. Every assertion below iterates DECLS; an empty list would pass
    // all of them while checking nothing — the same vacuous-green shape as the
    // silent upload failure this guards.
    assert.ok(
      DECLS.length >= 10,
      `parsed ${DECLS.length} job declarations; the wrapper format has drifted`,
    );
    assert.ok(
      DECLS.some((d) => d.job === "bseresults"),
      "bseresults is not in the parsed table",
    );
  });

  it("every script importing @usemoney/storage declares NEEDS_GCS=1", () => {
    const wrong: string[] = [];
    for (const d of DECLS) {
      const path = join(ROOT, d.script);
      // A cloudrun-dispatched job runs in a container with its own env; the
      // local NEEDS_GCS branch does not apply to it.
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      const uploads = /@usemoney\/storage/.test(src);
      if (uploads && d.gcs !== "1") {
        wrong.push(`${d.job} (${d.script}) imports @usemoney/storage but NEEDS_GCS=${d.gcs}`);
      }
    }
    assert.deepStrictEqual(
      wrong,
      [],
      "these jobs upload to GCS but the wrapper runs them WITHOUT " +
        "GCP_PROJECT_ID / GCP_STORAGE_BUCKET and without a credential check. " +
        "Every upload throws, and if the script swallows it the run writes " +
        "rows with an empty gcsPath and reports success — 59 such rows on " +
        "prod 2026-08-27. Set NEEDS_GCS=1.",
    );
  });

  it("bseresults specifically — it uploads and must be declared", () => {
    const d = DECLS.find((x) => x.job === "bseresults");
    assert.ok(d, "bseresults declaration missing");
    assert.equal(
      d.gcs,
      "1",
      "bseresults uploads PDFs; NEEDS_GCS=0 silently disables every upload",
    );
  });

  it("the backfill refuses to call a zero-attachment run healthy", () => {
    // The wrapper fix alone is not enough: run the script by hand without the
    // wrapper and the same silence returns. The job must judge itself.
    const src = readFileSync(
      join(ROOT, "scripts", "data", "backfill-bse-results.ts"),
      "utf8",
    );
    assert.match(
      src,
      /NO ATTACHMENT REACHED GCS/,
      "no zero-attachment health check; a run that stores nothing reports a " +
        "clean create/supersede summary",
    );
    assert.match(
      src,
      /attach\.stored === 0/,
      "the health check must key on ZERO stored against attachments OFFERED — " +
        "a run where BSE offered none is idle, not broken",
    );
    assert.match(
      src,
      /process\.exitCode = 1/,
      "a broken run must exit non-zero, or a wrapper's && reads it as success",
    );
  });
});
