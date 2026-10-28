/**
 * SOURCE-STRUCTURE TESTS — `bse-announcements-sync.ts` reporting + literals.
 *
 * ## Why these read the file on disk instead of running the processor
 *
 * The properties asserted here are STRUCTURAL — "the report is reachable from
 * every exit", "there is exactly one spelling of the docType", "the chain
 * publish is not inside the loop". None of those is a value a run RETURNS, so
 * none of them can be read off a behavioural pass; this repo already answers
 * that the same way twice, in `log-boundary.test.ts` (the boundary is the FIRST
 * statement of `index.ts`) and `job-outcome-coverage.test.ts` (a scan of
 * `workers/src/processors/*.ts` for `reportJobOutcome` call sites).
 *
 * This header used to say the processor "opens with `import prisma`" and could
 * therefore only be driven with `--experimental-test-module-mocks`. MONEY-1285
 * made that FALSE: `processBseAnnouncementsSync` now takes an injected I/O seam
 * whose defaults are the real clients, and
 * `bse-announcements-sync-drain.test.ts` drives the real function through it.
 * Behaviour belongs there; only the structure belongs here.
 *
 * They are stated as source facts rather than dressed up as behaviour, and the
 * defect they pin is real and was live in production:
 *
 * `reportJobOutcome` sat at the BOTTOM of the function, below THREE early
 * returns — the 429 abort, the fetch failure, and
 * `if (announcements.length === 0) return`. The `strCat=-1` bug made that third
 * one true on EVERY run, so the job emitted **no metric at all**, nightly,
 * since inception. `apply-monitors.sh` has carried
 * `bse-announcements-sync|96h|weekdays 21:30` since MONEY-1238 with
 * `notify_no_data: true`, so the monitor sat in NO DATA from birth instead of
 * alerting. Two independent failures stacked: a query that returned nothing,
 * and a reporting gap that hid it. Fixing only the first leaves the second
 * live and the NEXT regression just as invisible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(HERE, "../../src/processors/bse-announcements-sync.ts"),
  "utf8",
);

/**
 * The source with COMMENTS REMOVED.
 *
 * The literal assertions below are about CODE. This file's own prose quotes
 * `"corporate_filing"` while explaining the defect, and a naive `includes`
 * over the raw text would fail on the documentation rather than on the
 * implementation — a test that cannot tell a comment from a call is a test
 * that gets deleted rather than fixed.
 *
 * Block comments go first, then whole-line `//` comments. Trailing comments
 * are LEFT IN deliberately: stripping them needs a real tokenizer to avoid
 * eating the `//` inside `"https://…"`, and no assertion here depends on one.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

/** Index of the `finally` that wraps the run, or -1. */
const FINALLY_AT = SOURCE.indexOf("} finally {");
const REPORT_AT = SOURCE.indexOf("reportJobOutcome({");

describe("bse-announcements-sync — the outcome report is unconditional", () => {
  it("calls reportJobOutcome exactly once", () => {
    const calls = SOURCE.split("reportJobOutcome({").length - 1;
    assert.strictEqual(calls, 1, `expected 1 reportJobOutcome call, found ${calls}`);
  });

  it("has a `finally` block", () => {
    assert.ok(FINALLY_AT > 0, "the run body is not wrapped in try/finally");
  });

  it("reports from INSIDE the finally, not below the early returns", () => {
    assert.ok(REPORT_AT > 0, "reportJobOutcome({ not found");
    assert.ok(
      REPORT_AT > FINALLY_AT,
      "reportJobOutcome sits BEFORE the finally — an early return skips it, " +
        "which is exactly how this job emitted no metric for its whole life",
    );
  });

  it("no `return` stands between the finally and the report", () => {
    const between = SOURCE.slice(FINALLY_AT, REPORT_AT);
    assert.ok(
      !/\breturn\b/.test(between),
      "a return inside the finally can still skip the report",
    );
  });

  it("the early returns are INSIDE the try (so the finally still runs)", () => {
    const tryAt = SOURCE.indexOf("  try {\n    try {");
    assert.ok(tryAt > 0, "the outer try that the finally belongs to is missing");
    const body = SOURCE.slice(tryAt, FINALLY_AT);
    // The three paths that used to skip the report entirely.
    assert.ok(body.includes("return;"), "no early return found inside the try");
    assert.ok(
      body.includes("if (fetched.announcements.length === 0) return;"),
      "the empty-fetch early return is not where the finally can cover it",
    );
    assert.ok(
      tryAt < FINALLY_AT,
      "the try does not open before the finally it belongs to",
    );
  });

  it("forwards transportFailures so a BLOCKED run differs from an idle one", () => {
    // Without it a 429 abort emits 0/0/0 — byte-identical to a quiet night,
    // which is the silent-block shape the counter exists for (MONEY-1250).
    assert.ok(SOURCE.includes("transportFailures"));
    const report = SOURCE.slice(REPORT_AT, REPORT_AT + 600);
    assert.ok(
      report.includes("transportFailures"),
      "transportFailures is computed but never passed to reportJobOutcome",
    );
  });

  it("passes a skippedReason built from the health verdict", () => {
    const report = SOURCE.slice(REPORT_AT, REPORT_AT + 600);
    assert.ok(report.includes("skippedReason"));
    assert.ok(SOURCE.includes("judgeBseAnnouncementsHealth"));
  });

  it("logs an ERROR (not info) on BOTH unhealthy paths", () => {
    // Counted, not `includes`. There are TWO unhealthy paths — a failed fetch
    // and a bad health verdict — and a bare `includes("logger.error(`UNHEALTHY")`
    // passes while either one is still there. A mutation that downgraded the
    // VERDICT branch to `logger.info` survived that assertion, which is the
    // textbook vacuous check: the surviving sibling answered for the mutant.
    const errors = CODE.split("logger.error(`UNHEALTHY").length - 1;
    assert.strictEqual(
      errors,
      2,
      `expected both unhealthy branches at error level, found ${errors}`,
    );
    assert.ok(
      CODE.includes("logger.error(`UNHEALTHY — ${health.reason}`)"),
      "the health-verdict branch is not logged at error level",
    );
    assert.ok(
      CODE.includes("logger.error(`UNHEALTHY — ${fetchFailure}`)"),
      "the fetch-failure branch is not logged at error level",
    );
  });
});

describe("bse-announcements-sync — ONE follow-up per RUN (MONEY-1285)", () => {
  it("publishes from the `finally`, not from inside the announcement loop", () => {
    // A per-ITEM publish is how a chain becomes a storm — the fan-out shape
    // MONEY-1307 found in `stock-document-extract`. The publish must sit in the
    // same `finally` as the outcome report, which is reached exactly once per
    // invocation on every exit path.
    const at = SOURCE.indexOf("await chainNextLink({");
    assert.ok(at > 0, "the chain publish was not found");
    assert.ok(
      at > FINALLY_AT,
      "the chain publish sits ABOVE the finally — an early return skips it",
    );
    const calls = SOURCE.split("await chainNextLink({").length - 1;
    assert.strictEqual(
      calls,
      1,
      `expected exactly 1 chain call site, found ${calls}`,
    );
    // And exactly one publish inside the helper.
    const publishes = CODE.split("deps.publishFollowUp(").length - 1;
    assert.strictEqual(
      publishes,
      1,
      `expected exactly 1 publish call, found ${publishes}`,
    );
  });

  it("the budget is checked BETWEEN announcements, inside the loop", () => {
    const loopAt = CODE.indexOf("for (const ann of work) {");
    assert.ok(loopAt > 0, "the announcement loop was not found");
    const budgetAt = CODE.indexOf("isWithinBseRunBudget(startedAt, deps.now())");
    assert.ok(
      budgetAt > loopAt,
      "the run budget is not checked inside the loop — a check outside it " +
        "bounds nothing, and the run overruns the 600s ack deadline",
    );
  });

  it("the inter-download pace is NOT reduced to buy throughput", () => {
    // Cutting it trades an ack-deadline overrun (slow) for a per-IP 429
    // (permanent) from a host that has already blocked this repo (MONEY-853).
    assert.ok(
      CODE.includes("const DELAY_BETWEEN_DOWNLOADS_MS = 1500;"),
      "DELAY_BETWEEN_DOWNLOADS_MS moved off 1500ms",
    );
  });
});

describe("bse-announcements-sync — one spelling of the docType", () => {
  it("carries NO hard-coded docType string literal", () => {
    // The GCS path used a literal "corporate_filing" while the row read a
    // constant eleven lines away. Two spellings of one fact: change one and a
    // quarterly_result row points at a corporate_filing/ object, with no error
    // anywhere. Both sites now read the classification.
    assert.ok(
      !CODE.includes('"corporate_filing"'),
      'a hard-coded "corporate_filing" literal is back in the processor',
    );
    assert.ok(
      !CODE.includes('"quarterly_result"'),
      'a hard-coded "quarterly_result" literal is back in the processor',
    );
  });

  it("hands buildStockDocPath the classification's docType", () => {
    const at = SOURCE.indexOf("buildStockDocPath(");
    assert.ok(at > 0);
    assert.ok(
      SOURCE.slice(at, at + 200).includes("docType"),
      "buildStockDocPath is not being given the classified docType",
    );
  });
});

describe("bse-announcements-sync — mimeType goes through the shared rule", () => {
  it("normalizes the raw content-type rather than storing it", () => {
    // The parse lane selects on an EXACT `application/pdf`; a raw header is a
    // media type PLUS PARAMETERS, and `application/pdf;charset=UTF-8` stored
    // verbatim is a row no extractor can ever take (MONEY-1255).
    assert.ok(SOURCE.includes("normalizeDocMimeType(contentType)"));
    assert.ok(
      !CODE.includes('mimeType: "application/pdf"'),
      "the mimeType literal is back — it bypasses the shared normalizer",
    );
  });

  it("derives the initial processingStatus from the same rule", () => {
    assert.ok(SOURCE.includes("initialProcessingStatus(contentType)"));
  });

  it("uploads the bytes under the RAW header, not the normalized one", () => {
    // Deliberate asymmetry: the COLUMN is normalized because a query matches
    // it exactly; the OBJECT keeps the header it was served under.
    //
    // MONEY-1285 moved the upload behind the injected seam
    // (`deps.uploadAttachment`, defaulting to the real `uploadToGCS`), so the
    // call site moved with it. The property is unchanged and so is this
    // assertion's subject: the THIRD argument is `contentType`, the raw header
    // returned by `downloadAttachment`, never `normalizeDocMimeType(...)`.
    assert.ok(
      SOURCE.includes("deps.uploadAttachment(gcsPath, buffer, contentType"),
      "the GCS upload no longer receives the raw content-type header",
    );
    assert.ok(
      SOURCE.includes("deps.uploadAttachment ?? uploadToGCS"),
      "the upload seam's default is no longer the real uploadToGCS",
    );
  });
});

describe("bse-announcements-sync — D-v latest wins", () => {
  it("upserts rather than skipping when the row already exists", () => {
    assert.ok(SOURCE.includes("prisma.stockDocument.upsert("));
    assert.ok(
      !CODE.includes("prisma.stockDocument.create("),
      "a bare create cannot express D-v: a revised filing would throw on the " +
        "company-quarter unique key instead of replacing the prior one",
    );
  });

  it("carries the superseded attachment into the description", () => {
    assert.ok(SOURCE.includes("supersededAttachment"));
    assert.ok(SOURCE.includes("buildBseDocumentDescription"));
  });

  it("resets BOTH downstream lanes on a superseding write", () => {
    // The bytes changed, so the extracted text and every embedding derived
    // from the old PDF describe a document this row no longer points at.
    const at = SOURCE.indexOf("update: {");
    assert.ok(at > 0);
    const update = SOURCE.slice(at, at + 500);
    assert.ok(update.includes("isEmbedded: false"));
    assert.ok(update.includes("textContent: null"));
    assert.ok(update.includes('parseStatus: "PENDING"'));
  });

  it("delegates the skip to ONE docType-independent decision", () => {
    // MONEY-1285. The skip used to be spelled TWICE and the two spellings
    // disagreed: `if (existing && !isQuarterly) continue;` above, and an
    // `existingHasBytes` arm below that only quarterlies could reach. A
    // `corporate_filing`'s period is `bse-{newsId}`, so the existing row
    // matches on EVERY later run — which is how 2,339 rows kept `gcsPath: ""`
    // for the life of the table while the comment four lines down said, in so
    // many words, that skipping on the attachment name alone "strands that
    // company-quarter permanently".
    assert.ok(
      CODE.includes("decideBseAnnouncementWrite({"),
      "the write decision is inlined again instead of being delegated",
    );
    assert.ok(
      CODE.includes("if (!bseDecisionWrites(decision)) {"),
      "the skip no longer reads the delegated decision",
    );
  });

  it("REGRESSION: the unconditional non-quarterly skip is GONE", () => {
    // The exact defect, pinned by absence. `bse-announcements-sync-drain.test.ts`
    // proves the behaviour (a byte-less row IS re-downloaded); this proves the
    // shape that caused it cannot come back by a merge.
    assert.ok(
      !/existing\s*&&\s*!isQuarterly/.test(CODE),
      "the unconditional `existing && !isQuarterly` skip is back — every " +
        "already-seen corporate_filing is stranded again",
    );
    assert.ok(
      !CODE.includes("existingHasBytes"),
      "a second, local spelling of the bytes test is back beside the " +
        "delegated one — two rules for one fact is what produced the defect",
    );
  });

  it("a bytes-RETRY is not recorded as a supersession", () => {
    // The attachment is the SAME one, so filing it in the supersession trail
    // would invent a revision that never happened.
    //
    // SCOPED to the `supersededAttachment` argument, not a bare `includes`.
    // The counters read the same discriminant, so a bare
    // `CODE.includes('decision === "write-superseding"')` passes while the
    // ARGUMENT has lost it — the sibling answers for the mutant. That exact
    // mutation survived the first draft of this assertion.
    const at = CODE.indexOf("supersededAttachment:\n");
    assert.ok(at > 0, "the supersededAttachment argument was not found");
    const expr = CODE.slice(at, at + 220);
    assert.ok(
      expr.includes('decision === "write-superseding"'),
      "supersededAttachment is set without checking the attachment CHANGED",
    );
    // And the counter keeps its own separate bucket for a retry.
    assert.ok(CODE.includes("retriedBytes"));
    assert.ok(
      CODE.includes('if (decision === "write-retry-bytes") retriedBytes++;'),
      "the retry counter no longer distinguishes a bytes retry",
    );
    assert.ok(
      CODE.includes('if (decision === "write-superseding") superseded++;'),
      "the supersede counter no longer distinguishes a retry",
    );
  });
});
