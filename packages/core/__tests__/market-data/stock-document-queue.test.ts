/**
 * The stock-document extraction queue: the rows that could never be selected,
 * and the job that could never be paged on — MONEY-1255.
 *
 * Three defects, one queue:
 *
 *   1. `mimeType` was stored from the raw `content-type` header while the
 *      extract query matched it EXACTLY, so `application/pdf;charset=UTF-8`
 *      sat PENDING forever — beside 1,210 HTML/MP3/ZIP rows queued for an
 *      extractor that will never read them. 1,211 rows on prod 2026-08-26.
 *   2. The queue drained NEWEST-FIRST at 50/day against 34,790 PDFs.
 *   3. `apply-monitors.sh` excluded the job from freshness monitoring on the
 *      written claim that it was "CHAINED, not scheduled" — and
 *      `setup-scheduler.sh` has given it a daily 22:00 clock on both envs
 *      since MONEY-783.
 *
 * ## What is asserted where, and why some of it is a source scan
 *
 * The pure decision (`planDocQueueRepair`, and the mime helpers it calls) is
 * EXECUTED against the real prod census. It lives in `@usemoney/core` rather
 * than inside the script for the reason `instrument-name-repair.ts` does: a
 * decision buried in a `scripts/` file is one no test can reach without
 * executing the script, and that script's `main()` wants a DATABASE_URL. The
 * script imports THIS symbol, so a rewrite of the rule fails here.
 *
 * Defect 3 lives entirely in shell, and its failure mode is a COMMENT that
 * disagrees with a data row two files away. There is nothing to execute: the
 * only way to catch "the monitor list forgot a scheduled job" is to read both
 * files and compare them, which is what the last block does. It is the same
 * shape as `job-outcome-coverage.test.ts`, which reads MONITORED_JOBS out of
 * this very script.
 *
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  planDocQueueRepair as planRow,
  normalizeDocMimeType,
  isExtractableDocMimeType,
  initialProcessingStatus,
} from "../../src/market-data/doc-mime";
import { normalizeProcessingStatus } from "../../src/market-data/docs-section-logic";

/** Resolved from THIS FILE, never from cwd — a cwd-relative path makes the
 * suite throw inside the describe callback, which node reports as a dropped
 * suite with `fail 0` and exit 0. The guard would vanish instead of failing. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (rel: string): string =>
  readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * The exact `mimeType` census measured on prod 2026-08-26 over 36,001 PENDING
 * `stock_documents`. Kept verbatim so every assertion below is against real
 * data rather than against a shape someone imagined.
 */
const PROD_PENDING_CENSUS: [string, number][] = [
  ["application/pdf", 34790],
  ["text/html; charset=UTF-8", 863],
  ["text/html; charset=utf-8", 228],
  ["text/html", 99],
  ["audio/mpeg", 13],
  ["application/zip", 5],
  ["text/html;charset=UTF-8", 1],
  ["text/html;charset=utf-8", 1],
  ["application/pdf;charset=UTF-8", 1],
];

describe("MONEY-1255 — planRow, over the real prod census", () => {
  it("[meta] the census still adds up to the measured queue", () => {
    // A floor, so a future edit that guts the fixture fails here rather than
    // making every assertion below vacuously true (MONEY-1093).
    const total = PROD_PENDING_CENSUS.reduce((a, [, n]) => a + n, 0);
    assert.strictEqual(total, 36001, "prod PENDING total");
    assert.strictEqual(PROD_PENDING_CENSUS.length, 9, "nine spellings");
  });

  it("classifies all 36,001 rows into exactly the three buckets we expect", () => {
    // MONEY-1319 moved FIVE rows across this boundary, and the movement is the
    // finding rather than a fixture edit. `application/zip` was `unsupported`
    // for exactly as long as its own premise held — "no extractor in this repo
    // will ever read one" — and the extract lane now opens an archive and
    // selects the member. The five PENDING ZIPs measured on 2026-08-26 are
    // therefore already-selectable, not terminal. The census fixture is
    // UNCHANGED; only what the rule says about one of its nine rows moved.
    let selectable = 0;
    let normalize = 0;
    let unsupported = 0;
    for (const [mime, n] of PROD_PENDING_CENSUS) {
      const plan = planRow(mime);
      if (plan.action === "unchanged") selectable += n;
      else if (plan.action === "normalize") normalize += n;
      else unsupported += n;
    }
    assert.strictEqual(
      selectable,
      34790 + 5,
      "already-selectable: 34,790 PDFs + the 5 ZIPs the lane can now open",
    );
    assert.strictEqual(
      normalize,
      1,
      "PDFs unreachable only because of a charset",
    );
    assert.strictEqual(
      unsupported,
      1205,
      "rows no extractor will ever read (1,210 minus the 5 ZIPs)",
    );
    assert.strictEqual(
      normalize + unsupported,
      1206,
      "the rows this repair exists for",
    );
    // The five did not vanish — they are terminal no longer, which is a
    // different claim from "the census shrank".
    assert.strictEqual(selectable + normalize + unsupported, 36001);
  });

  it("a parameterised PDF becomes selectable and STAYS queued", () => {
    const plan = planRow("application/pdf;charset=UTF-8");
    assert.strictEqual(plan.action, "normalize");
    assert.strictEqual(plan.mimeType, "application/pdf");
    // It is a real PDF with real text in it — the repair makes it reachable,
    // it does not retire it.
    assert.strictEqual(plan.processingStatus, "PENDING");
  });

  it("a non-PDF is retired AND has its parameters dropped", () => {
    for (const raw of [
      "text/html; charset=UTF-8",
      "text/html;charset=utf-8",
      "text/html",
    ]) {
      const plan = planRow(raw);
      assert.strictEqual(plan.action, "unsupported", raw);
      assert.strictEqual(plan.processingStatus, "UNSUPPORTED", raw);
      // Four spellings collapse to one, so the post-repair census is readable.
      assert.strictEqual(plan.mimeType, "text/html", raw);
    }
    assert.strictEqual(planRow("audio/mpeg").mimeType, "audio/mpeg");
    assert.strictEqual(planRow("application/zip").mimeType, "application/zip");
  });

  it("an already-canonical PDF is left completely alone", () => {
    const plan = planRow("application/pdf");
    assert.strictEqual(plan.action, "unchanged");
    assert.strictEqual(plan.mimeType, "application/pdf");
    assert.strictEqual(plan.processingStatus, "PENDING");
  });

  it("an ABSENT mimeType is treated as the schema default, not dropped", () => {
    // `prisma db push` creates indexes, never fields, so a row predating the
    // column carries no `mimeType` at all and arrives here as null. The class
    // that cost MONEY-1050/1205/1234/1235/1236 — a null must be CLASSIFIED,
    // never filtered out and silently skipped.
    for (const absent of [null, undefined]) {
      const plan = planRow(absent);
      assert.strictEqual(plan.mimeType, "application/pdf");
      assert.strictEqual(plan.processingStatus, "PENDING");
      assert.strictEqual(plan.action, "normalize");
    }
  });

  it("is IDEMPOTENT — a second pass over its own output changes nothing", () => {
    // The repair may be re-run (an interrupted write, a QA rehearsal, a
    // prod->QA restore). A pass that kept finding work would be a pass that
    // could not be trusted to have finished.
    for (const [mime] of PROD_PENDING_CENSUS) {
      const first = planRow(mime);
      if (first.processingStatus !== "PENDING") continue;
      const second = planRow(first.mimeType);
      assert.strictEqual(second.action, "unchanged", mime);
      assert.strictEqual(second.mimeType, first.mimeType, mime);
    }
  });

  it("calls the production helpers rather than restating the rule", () => {
    // The whole defect was one rule written twice. If planRow ever grew its own
    // copy, these would diverge for some spelling and this fails.
    for (const [mime] of PROD_PENDING_CENSUS) {
      const plan = planRow(mime);
      assert.strictEqual(plan.mimeType, normalizeDocMimeType(mime), mime);
      assert.strictEqual(
        plan.processingStatus,
        isExtractableDocMimeType(mime) ? "PENDING" : "UNSUPPORTED",
        mime,
      );
      assert.strictEqual(
        plan.processingStatus,
        initialProcessingStatus(mime),
        mime,
      );
    }
  });

  it("the SCRIPT calls this decision rather than carrying its own copy", () => {
    // The test above proves the rule is right; this proves the writer uses it.
    // A pure function nobody calls is the shape of a shadow test.
    const script = read("scripts/data/repair-stock-document-queue.ts");
    assert.match(
      script,
      /planDocQueueRepair,\n\} from "@usemoney\/core\/market-data\/doc-mime"/,
      "the repair script must import the shared decision",
    );
    assert.match(
      script,
      /const plan = planDocQueueRepair\(row\.mimeType\)/,
      "…and call it on every scanned row",
    );
    assert.ok(
      !/function planRow/.test(script),
      "a local copy of the decision has reappeared in the script",
    );
  });

  it("every status it writes survives the app's normalizer", () => {
    for (const [mime] of PROD_PENDING_CENSUS) {
      const { processingStatus } = planRow(mime);
      assert.strictEqual(
        normalizeProcessingStatus(processingStatus),
        processingStatus,
        `${mime} -> ${processingStatus} must not render as "Unknown state"`,
      );
    }
  });
});

describe("MONEY-1255 — the wrapper's APPLY_FLAG contract", () => {
  const wrapper = read("scripts/ops/run-market-data-job.sh");

  it("[meta] the wrapper still declares APPLY_FLAG at all", () => {
    // Floor: if the mechanism were renamed, every assertion below would pass by
    // matching nothing.
    assert.match(wrapper, /^APPLY_FLAG=""$/m, "the default declaration");
    assert.ok(
      wrapper.includes('job_args+=("$APPLY_FLAG")'),
      "the cloudrun path must forward the declared literal",
    );
  });

  it('docqueue declares APPLY_FLAG="--apply"', () => {
    // `repair-stock-document-queue.ts` is DRY-RUN BY DEFAULT and opts in with
    // `--apply`. The wrapper's cloudrun path CONSUMES `--apply` and re-emits
    // only $APPLY_FLAG, so a job with this contract and no declaration reads
    // 36,000 rows, reports a plan, writes nothing and exits 0 — which is what
    // xbrl-reparse did for 54 minutes over 41,924 rows. It fails SAFE, and that
    // is precisely why it is invisible.
    const row = wrapper
      .split("\n")
      .find((l) => l.trim().startsWith("docqueue)"));
    assert.ok(row, "no docqueue case in run-market-data-job.sh");
    assert.ok(
      row.includes('APPLY_FLAG="--apply"'),
      `docqueue must declare APPLY_FLAG="--apply"; got: ${row.trim()}`,
    );
    assert.ok(
      row.includes("scripts/data/repair-stock-document-queue.ts"),
      "the docqueue case must point at the repair script",
    );
  });

  it("xbrlreparse still declares it — the precedent must not rot", () => {
    const row = wrapper
      .split("\n")
      .find((l) => l.trim().startsWith("xbrlreparse)"));
    assert.ok(row, "no xbrlreparse case");
    assert.ok(row.includes('APPLY_FLAG="--apply"'), row.trim());
  });
});

describe("MONEY-1255 — the extract job is SCHEDULED, and monitored as such", () => {
  const scheduler = read("scripts/ops/setup-scheduler.sh");
  const monitors = read("scripts/ops/datadog/apply-monitors.sh");

  it("setup-scheduler.sh gives stock-document-extract a daily clock", () => {
    // The falsifiable fact the monitor script's comment used to deny.
    const row = scheduler
      .split("\n")
      .find((l) => l.includes('"stock-document-extract-daily|'));
    assert.ok(row, "stock-document-extract-daily has no scheduler entry");
    const [, cron, topic] = row.trim().replace(/^"|"$/g, "").split("|");
    assert.strictEqual(cron, "0 22 * * *", "daily 22:00 IST");
    assert.strictEqual(topic, "stock-document-extract");
  });

  it("…on BOTH envs — it is not in PROD_ONLY_JOBS", () => {
    const block = /^PROD_ONLY_JOBS=\(([\s\S]*?)\n\)/m.exec(scheduler);
    assert.ok(block, "PROD_ONLY_JOBS not found");
    const prodOnly = new Set(
      [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!),
    );
    // Floor first: an empty parse would make the assertion below vacuous.
    assert.ok(prodOnly.size >= 10, `parsed only ${prodOnly.size} entries`);
    assert.ok(
      !prodOnly.has("stock-document-extract-daily"),
      "it runs on QA too, so a QA monitor is correct",
    );
  });

  it("apply-monitors.sh MONITORS it", () => {
    const block = /declare -a MONITORED_JOBS=\(([\s\S]*?)\n\)/.exec(monitors);
    assert.ok(block, "MONITORED_JOBS not found");
    const jobs = [...block[1]!.matchAll(/"([^|"]+)\|([^|"]+)\|/g)].map((m) => ({
      job: m[1]!,
      window: m[2]!,
    }));
    assert.ok(jobs.length > 20, `only ${jobs.length} monitored jobs parsed`);
    // A COMMENT can inject a phantom job. `MONITORED_JOBS` is parsed with
    // /"([^|"]+)\|/g, so a prose line containing a double quote followed by a
    // pipe before the next quote is read as a job id — which is exactly what
    // the first draft of this ticket's own comment did, and it took the
    // datadog coverage suite red. Every id must LOOK like a job id.
    for (const j of jobs) {
      assert.match(
        j.job,
        /^[a-z0-9-]+$/,
        `"${j.job}" is not a job id — a comment in MONITORED_JOBS is being parsed as one`,
      );
    }
    const row = jobs.find((j) => j.job === "stock-document-extract");
    assert.ok(
      row,
      "stock-document-extract has a daily clock and no freshness monitor — a " +
        "silently-dead run would never page",
    );
    // Window must EXCEED the cadence or the monitor alerts on every ordinary
    // gap between runs, which is how a real alert gets muted.
    assert.strictEqual(row.window, "36h");
  });

  it("the false 'CHAINED, not scheduled' claim is gone", () => {
    // Naming a bug in a comment is not protection from it; the claim itself has
    // to stop being in the file, or the next reader re-derives the same wrong
    // conclusion from it.
    //
    // ANCHORED ON THE BLOCK HEADER, not on the first mention of its name. This
    // used to slice from `indexOf("DELIBERATELY NOT MONITORED")`, and MONEY-1358
    // added a prose cross-reference — "the DELIBERATELY NOT MONITORED block
    // below covers that case" — four hundred lines ABOVE the block. `indexOf`
    // took that one, so the slice swallowed the whole file including the
    // HISTORICAL QUOTE of the very sentence this case forbids, and the test
    // went red against source that was entirely correct. A first-match locator
    // over a string that can legitimately appear twice is not a locator.
    const BLOCK = "# DELIBERATELY NOT MONITORED, though they now emit:";
    const at = monitors.indexOf(BLOCK);
    assert.notStrictEqual(
      at,
      -1,
      `the not-monitored block header moved — looked for ${BLOCK}. Without ` +
        "this the slice below would start at -1, i.e. the last character of " +
        "the file, and the assertion would pass over nothing.",
    );
    assert.strictEqual(
      monitors.indexOf(BLOCK, at + 1),
      -1,
      "the block header appears more than once; the anchor is ambiguous",
    );
    const notMonitored = monitors.slice(at);
    assert.ok(
      !/stock-document-extract\s+CHAINED, not scheduled/.test(notMonitored),
      "the not-monitored block still claims stock-document-extract has no clock",
    );
  });

  it("stock-document-embed genuinely has no clock — verified, not assumed", () => {
    // The ticket asked for this to be CHECKED rather than inherited from the
    // same comment that was wrong about its sibling.
    assert.ok(
      !scheduler.includes("stock-document-embed"),
      "setup-scheduler.sh now schedules stock-document-embed — it needs its own monitor",
    );
    assert.ok(
      monitors.includes(
        "stock-document-embed    CHAINED by stock-document-extract",
      ),
      "the not-monitored block must still account for embed",
    );
  });
});
