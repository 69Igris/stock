/**
 * The parts of `scripts/data/snapshot-vendor-fundamentals.ts` that live OUTSIDE
 * its pure logic module — MONEY-1401 F7 follow-up.
 *
 * ## Why a second file, and why a source scan
 *
 * `vendor-fundamentals-snapshot.test.ts` covers the decisions
 * (`planResnapshotGuard`, `partitionVendorRows`, `planRestore`). It cannot cover
 * whether the script CALLS them, or WHERE — and an adversarial review measured
 * exactly that gap: deleting the re-snapshot guard from `runSnapshot` left every
 * case in that file green, and MOVING it below the `if (!opts.apply)` early
 * return also left them green, which falsified the script header's claim that
 * "the refusal fires in DRY RUN too".
 *
 * The script cannot be imported: it calls `main()` at module scope, which parses
 * `process.argv` and calls `process.exit`. Importing it from a test would kill
 * the test process. Making it importable means gating `main()` on an
 * "am I the entry point" check, whose failure mode is the script silently doing
 * NOTHING and exiting 0 — the single worst shape in this file's vocabulary, and
 * a much worse bug than the one it would be buying a test for.
 *
 * So this is a scan, like `ops-script-db-target.test.ts` next door, and it is
 * scoped to what a scan can honestly decide: is the call there, and is it before
 * the early return. It deliberately does NOT claim to verify what the guard
 * decides — that is the other file's job, and a scan asserting WHICH expression
 * is present is the vacuous shape this repo has shipped before.
 *
 * ## Mutation log
 *
 * Every assertion below was run against a deliberately broken source and
 * confirmed RED before being kept. Recorded at each `it(...)`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolved from THIS FILE, not cwd — a throw inside a describe is `fail 0`. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const SCRIPT = join(
  REPO_ROOT,
  "scripts",
  "data",
  "snapshot-vendor-fundamentals.ts",
);
const SCHEMA = join(
  REPO_ROOT,
  "packages",
  "database",
  "prisma",
  "schema.prisma",
);

const src = readFileSync(SCRIPT, "utf8");

/**
 * One top-level function's body.
 *
 * Every function this file inspects is declared at column 0, so the closing
 * brace is the first `\n}` — no brace counting, and a rename fails loudly here
 * rather than silently matching nothing.
 */
function bodyOf(name: string): string {
  const start = src.indexOf(`\nasync function ${name}(`);
  assert.notEqual(
    start,
    -1,
    `${name} is not a top-level \`async function\` in ${SCRIPT}. If it was ` +
      `renamed or inlined, this file's assertions are no longer looking at it.`,
  );
  const end = src.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return src.slice(start, end);
}

/** Index of `needle` in `hay`, asserted present. */
function at(hay: string, needle: string, where: string): number {
  const i = hay.indexOf(needle);
  assert.notEqual(i, -1, `${where}: expected to find \`${needle}\``);
  return i;
}

describe("readSnapshot pages past the 101-document firstBatch cap", () => {
  const body = bodyOf("readSnapshot");

  /**
   * MEASURED against a local mongo:7 (not prod), 2,500 docs, this exact command
   * shape:
   *
   *   find + sort + limit: 1000, no batchSize   ->  firstBatch  101
   *   the same + batchSize: 1000                ->  firstBatch 1000
   *
   * `batchSize` defaults to 101 and `limit` does NOT raise it, so without this
   * the loop read 101 rows and stopped — measured, `readSnapshot` returned 101
   * of 2,500. Every caller, every time, one round trip.
   *
   * MUTATION — `batchSize: READ_PAGE` deleted from the command: RED here.
   */
  it("asks for READ_PAGE documents in the first batch", () => {
    at(body, "batchSize: READ_PAGE", "readSnapshot");
  });

  /**
   * MEASURED, same mongo:7, 300 docs of ~200 KB: WITH `batchSize: 1000` the
   * first page still came back at 83 documents, because the 16 MB wire cap
   * truncates `firstBatch` regardless. So `batchSize` alone does not make a
   * short page mean "exhausted" — walking the 300 docs with `< READ_PAGE` read
   * 83 of 300, with `=== 0` read 300 of 300.
   *
   * Same conclusion and same class as `quarantine-html-stock-documents.ts:1004`
   * and `recover-html-stock-documents.ts:533`.
   *
   * MUTATION — `batch.length === 0` changed back to `batch.length < READ_PAGE`:
   * RED on both assertions.
   */
  it("treats only an EMPTY batch as exhaustion, never a short one", () => {
    at(body, "batch.length === 0", "readSnapshot");
    assert.equal(
      body.includes("batch.length < READ_PAGE"),
      false,
      "readSnapshot: a SHORT page means the 16 MB wire cap was hit, not that " +
        "the collection is exhausted. Breaking on it returns a truncated " +
        "snapshot, which reads as a SMALLER restore plan rather than an error.",
    );
  });

  /**
   * The other raw read in the file, same cap. `snapshotDays` groups by day, so
   * it fails SAFE at 101 — a truncated day is reported "no snapshot stored",
   * never restored from — which is exactly why it would otherwise sit here as
   * the one un-fixed instance of the class and read as "checked".
   *
   * MUTATION — `cursor: { batchSize: READ_PAGE }` -> `cursor: {}`: RED.
   */
  it("snapshotDays raises the same cap on its aggregate", () => {
    at(
      bodyOf("snapshotDays"),
      "cursor: { batchSize: READ_PAGE }",
      "snapshotDays",
    );
  });
});

describe("runSnapshot wires the re-snapshot guard, and wires it early", () => {
  const body = bodyOf("runSnapshot");

  /**
   * MUTATION — the whole `const stored = ... if (guard.refuse) { throw }` block
   * deleted: RED (`planResnapshotGuard` not found). This is the mutation the
   * review ran that left 6/6 suites green in the sibling file.
   */
  it("calls planResnapshotGuard on what is already stored for the day", () => {
    at(body, "readSnapshot(run, collection, day)", "runSnapshot");
    at(body, "planResnapshotGuard(", "runSnapshot");
    at(body, "guard.refuse", "runSnapshot");
  });

  /**
   * MUTATION — the guard block MOVED below the `if (!opts.apply)` early return:
   * RED. That is the mutation that falsified the header's "the refusal fires in
   * DRY RUN too" while every existing test stayed green — and a rehearsal that
   * hides the refusal is not a rehearsal: the operator learns the snapshot is
   * unreplaceable only on the run that was going to write.
   */
  it("refuses BEFORE the dry-run early return, so a dry run sees it", () => {
    const guard = at(body, "planResnapshotGuard(", "runSnapshot");
    const dryRun = at(body, "if (!opts.apply)", "runSnapshot");
    assert.ok(
      guard < dryRun,
      "runSnapshot: planResnapshotGuard is called AFTER the `if (!opts.apply)` " +
        "return, so a dry run never reaches it. The refusal must fire in both " +
        "modes — that is what makes a rehearsal a rehearsal.",
    );
  });

  /**
   * THE GUARD IS ONLY AS COMPLETE AS THE READ — MONEY-1401 F7 review, MEDIUM-5.
   *
   * `planResnapshotGuard` compares what `readSnapshot` RETURNED, while the
   * `delete` further down is scoped to the WHOLE day. So a short read makes the
   * guard inspect a prefix and the delete remove the rest — the guard reports
   * clean and destroys the documents it never looked at.
   *
   * MUTATION — the `assertReadComplete` call deleted: RED.
   */
  it("checks the stored read against the stored COUNT before judging it", () => {
    const check = at(body, "assertReadComplete(", "runSnapshot");
    const guard = at(body, "planResnapshotGuard(", "runSnapshot");
    assert.ok(
      check < guard,
      "runSnapshot: a truncated read must be refused before it is judged — " +
        "the delete below is scoped to the whole day, not to what was read.",
    );
    // The count must be read BEFORE the loop that writes, or the oracle moves
    // under the thing it is measuring.
    assert.match(body, /const storedCounts = \(await snapshotDays\(run\)\)/);
  });

  /**
   * MUTATION — `throw new Error(...)` replaced with `console.warn(...)`: RED.
   * A warning scrolls past and the next line deletes the day.
   */
  it("REFUSES rather than warns — the next step deletes that day", () => {
    const guard = at(body, "guard.refuse", "runSnapshot");
    const thrown = body.indexOf("throw new Error(", guard);
    const dryRun = at(body, "if (!opts.apply)", "runSnapshot");
    assert.ok(
      thrown !== -1 && thrown < dryRun,
      "runSnapshot: the re-snapshot conflict must THROW. The apply path " +
        "`delete`s every document for that day before inserting, so a warning " +
        "destroys the only copy of the vendor values one line later.",
    );
  });
});

describe("runRestore checks what it is about to restore", () => {
  const body = bodyOf("runRestore");

  /**
   * THE HOLE THIS CLOSES. `partitionVendorRows` was added to the WRITER; the
   * snapshot collections outlive it. A day stored by an earlier run — or taken
   * deliberately after arming, which the writer's own guard names as a
   * legitimate thing to do under a different day — can hold `NSE_XBRL` rows, and
   * restoring one writes OUR OWN values back under a command that says vendor
   * and prints "restored". `runRestore`'s only guard was `days.size > 1`, and
   * one tainted day is still one day.
   *
   * MUTATION — the `partitionVendorRows` block deleted from `runRestore`: RED.
   */
  it("partitions the STORED rows before planning anything", () => {
    const partition = at(body, "partitionVendorRows(", "runRestore");
    const plan = at(body, "planRestore(", "runRestore");
    assert.ok(
      partition < plan,
      "runRestore: the stored rows must be checked before they are classified " +
        "— a plan built over our own rows is a plan to restore them.",
    );
  });

  /**
   * MUTATION — the block MOVED below `if (!opts.apply)`: RED. Same reasoning as
   * the snapshot side; a dry run that hides the refusal teaches the operator
   * that the restore is safe.
   */
  it("refuses BEFORE the dry-run early return", () => {
    const partition = at(body, "partitionVendorRows(", "runRestore");
    const dryRun = at(body, "if (!opts.apply)", "runRestore");
    assert.ok(
      partition < dryRun,
      "runRestore: the vendor check is after the `if (!opts.apply)` return, so " +
        "a dry run reports a clean-looking plan for a snapshot that must not " +
        "be restored at all.",
    );
  });

  /**
   * A SHORT READ IS NOT A SMALLER PLAN — MONEY-1401 F7 review, MEDIUM-5.
   *
   * `snapshotDays()` returns the `$group` count per day per collection, and
   * `runRestore` read it only to PICK a day. Nothing compared `docs.length` to
   * it, so a truncated `readSnapshot` — the exact failure the keyset paging
   * above exists for, measured at 101 of 2,500 — produced a smaller plan that
   * applied cleanly and printed "N row(s) restored". Success over a subset,
   * with the oracle two lines up.
   *
   * The RUNTIME assertion is the real guard and it is format-agnostic: it fires
   * whatever shape the paging loop takes, INCLUDING the two rewrites that leave
   * the literal scans above green (`out.length >= 101` read as exhaustion, or
   * the `_id` sort flipped). This scan only pins that it is wired, and it is
   * ordered BEFORE `planRestore` so a truncated read cannot become a plan.
   *
   * MUTATION — the `assertReadComplete` call deleted from `runRestore`: RED.
   */
  it("checks the read against the stored COUNT before planning", () => {
    const check = at(body, "assertReadComplete(", "runRestore");
    const plan = at(body, "planRestore(", "runRestore");
    assert.ok(
      check < plan,
      "runRestore: a short read must be refused before it becomes a plan — " +
        "restoring a truncated snapshot prints success over a subset.",
    );
    // The oracle has to be the GROUP COUNT, not `docs.length` compared with
    // itself. `days` is what `snapshotDays()` returned.
    assert.match(
      body.slice(check, check + 300),
      /days\.get\(day\)\?\.\[collection\]/,
    );
  });

  /** MUTATION — `throw new Error` -> `console.warn`: RED. */
  it("REFUSES rather than restoring the vendor part and skipping ours", () => {
    const partition = at(body, "partitionVendorRows(", "runRestore");
    const thrown = body.indexOf("throw new Error(", partition);
    const dryRun = at(body, "if (!opts.apply)", "runRestore");
    assert.ok(
      thrown !== -1 && thrown < dryRun,
      "runRestore: a half-applied restore leaves both tables in a state that " +
        "is neither the snapshot nor the present, with nothing on the rows to " +
        "say which columns came from where.",
    );
  });
});

/**
 * ## The key fields, derived from the schema rather than retyped
 *
 * `vendor-fundamentals-snapshot.test.ts` used to assert `NATURAL_KEY_FIELDS`
 * against a second literal in the test file — which catches a later accidental
 * edit of the constant and CANNOT catch what the stated risk actually is: a
 * transcription error against `schema.prisma` at authoring time, where both
 * copies are written wrong together. These parse the schema.
 */
describe("NATURAL_KEY_FIELDS is the @@unique line, read from schema.prisma", () => {
  const schema = readFileSync(SCHEMA, "utf8");

  /**
   * The `@@unique` of the model whose `@@map` is `mapped`.
   *
   * The line must START with `@@unique(` after trimming. That is not tidiness:
   * `model StockRatios` carries the comment
   *
   *     // The exposure here is LARGER, not smaller. @@unique([symbol, exchange]) means
   *
   * which a substring match finds FIRST — and it happens to hold the correct
   * field list today, so the test would pass while reading a sentence rather
   * than the declaration. It would keep passing after the real line changed.
   */
  function uniqueFieldsOf(mapped: string): string[] {
    const blocks = schema.split(/\nmodel /).slice(1);
    const block = blocks.find((b) => b.includes(`@@map("${mapped}")`));
    assert.ok(block, `no model in schema.prisma maps to "${mapped}"`);
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("@@unique("));
    assert.equal(
      lines.length,
      1,
      `${mapped}: expected exactly one @@unique, found ${lines.length}. A ` +
        `second one means the natural key is now a choice, and the snapshot ` +
        `has to say which it takes.`,
    );
    const m = /^@@unique\(\[([^\]]*)\]/.exec(lines[0]!);
    assert.ok(m, `${mapped}: could not parse "${lines[0]}"`);
    return m[1]!
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  /**
   * MUTATION — the parser's `startsWith("@@unique(")` filter relaxed to
   * `includes("@@unique(")`: RED on the `stock_ratios` case with "expected
   * exactly one @@unique, found 2", which is the comment-line trap above being
   * caught rather than silently preferred.
   *
   * MUTATION — `exchange` removed from `NATURAL_KEY_FIELDS.stock_ratios` in
   * `scripts/data/snapshot-vendor-fundamentals-logic.ts`: RED. Restored from a
   * byte copy, re-run GREEN.
   */
  it("stock_ratios", async () => {
    const { NATURAL_KEY_FIELDS } =
      await import("../../../../scripts/data/snapshot-vendor-fundamentals-logic");
    assert.deepEqual(
      [...NATURAL_KEY_FIELDS.stock_ratios],
      uniqueFieldsOf("stock_ratios"),
    );
  });

  /**
   * MUTATION — `period` removed from `NATURAL_KEY_FIELDS.stock_financials`:
   * RED. Restored from a byte copy, re-run GREEN.
   *
   * This is the one that matters most: drop `period` and every fiscal year of
   * one statement collapses into whichever the iteration reached last, the plan
   * comes out SMALLER, and it reports success.
   */
  it("stock_financials", async () => {
    const { NATURAL_KEY_FIELDS } =
      await import("../../../../scripts/data/snapshot-vendor-fundamentals-logic");
    assert.deepEqual(
      [...NATURAL_KEY_FIELDS.stock_financials],
      uniqueFieldsOf("stock_financials"),
    );
  });
});

/**
 * `OUR_SOURCES` cannot be derived — "which sources do WE write" is not recorded
 * anywhere as data. What CAN be joined is that each of its members is a real
 * source: `FINANCIALS_AUTHORITY` in
 * `packages/core/src/market-data/xbrl-projection.ts` is the authority table both
 * tables' writers rank by.
 *
 * That catches a typo and a rename. It does NOT catch "a new arm of ours shipped
 * and nobody added it here", and nothing can — the polarity is deliberately
 * fail-toward-keeping for exactly that reason (an unlisted source is treated as
 * a NEW VENDOR and snapshotted), so the cost of the gap is one extra row in the
 * snapshot rather than a vendor value nothing can bring back.
 */
describe("OUR_SOURCES names real sources", () => {
  /**
   * MUTATION — `OUR_SOURCES` changed to `["NSE_XBLR", "DOC_PDF"]`: RED, naming
   * NSE_XBLR. Restored from a byte copy, re-run GREEN.
   */
  it("every member appears in FINANCIALS_AUTHORITY", async () => {
    const { OUR_SOURCES } =
      await import("../../../../scripts/data/snapshot-vendor-fundamentals-logic");
    const authoritySrc = readFileSync(
      join(
        REPO_ROOT,
        "packages",
        "core",
        "src",
        "market-data",
        "xbrl-projection.ts",
      ),
      "utf8",
    );
    const block = /FINANCIALS_AUTHORITY[^=]*=\s*\[([\s\S]*?)\]\s*as const/.exec(
      authoritySrc,
    );
    assert.ok(
      block,
      "could not find FINANCIALS_AUTHORITY in xbrl-projection.ts",
    );
    const known = new Set(
      [...block[1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!),
    );
    assert.ok(known.size >= 2, `parsed only ${known.size} authority entries`);
    for (const s of OUR_SOURCES) {
      assert.ok(
        known.has(s),
        `OUR_SOURCES has "${s}", which is not in FINANCIALS_AUTHORITY ` +
          `(${[...known].join(", ")}). A source no writer can produce excludes ` +
          `nothing; a misspelt one silently snapshots our own rows as vendor.`,
      );
    }
  });
});
