/**
 * `scripts/jobs/feed-parse.ts` — a run that could not read files must not report
 * success (MONEY-1205).
 *
 * ## The defect this suite closes
 *
 * MONEY-1204 fixed the WRITERS: eleven file-level refusals stopped returning 0,
 * because a 0 return is indistinguishable from "parsed fine, the market was
 * shut" and the dispatcher checkpointed those files DONE forever (414 of 688
 * mwpl files, two years of history, exit code 0).
 *
 * The RUN still lied. `process.exitCode` was set by exactly two tripwires — no
 * files seen at all, and every opened file yielding zero rows — so a run where
 * 409 of 688 files were unreadable and 279 were fine exited **0**. The per-file
 * catch did `unreadable++` and a `log.warn` that drove nothing. Same defect,
 * one level up.
 *
 * ## Why the naive fix is worse than the bug
 *
 * 13 files are expected to fail on every run, forever: one gzip stream stored
 * under a `.csv` key, eleven whose slash-formatted dates are mutually
 * contradictory (`4/3/2024` can only be day-first, `11/2/2023` can only be
 * month-first — a day-first rule would be right ten times and silently nine
 * months wrong once), and one publishing `20-11-0018`. `unreadable > 0 ⇒ exit 1`
 * paints the nightly job red forever, which is how a tripwire is trained into
 * background noise and then ignored on the night it fires for real — a warning
 * `feed-parse.ts` already carries about its own zero-rows tripwire.
 *
 * So the two halves pinned here are the predicate AND its limit:
 *
 *   exitNonZero ⇔ (newUnreadable > 0 || transientFailures > 0) && !dryRun
 *
 * and a refusal only counts as "known" if it was recorded BEFORE the run began.
 *
 * ## Why this suite EXECUTES the script instead of reading it
 *
 * `feed-parse.ts` is a script with a top-level `main()` and a module-scope Prisma
 * import, so it cannot be imported into `node:test`. The neighbouring
 * `feed-parse-dispatch.test.ts` therefore asserts on its source TEXT — and
 * MONEY-1204 is the standing reminder of what that costs: one of those
 * assertions required `return 0;` and so held the data-loss bug in place.
 *
 * The decision is pure, so this suite extracts that region from the real file,
 * writes it to a temp ESM module and imports it. Every behavioural assertion
 * below runs the SHIPPING source text: mutate the predicate in `feed-parse.ts`
 * and these tests fail, which is exactly what a source-text assertion cannot
 * promise. The structural assertions are kept only for the wiring that genuinely
 * cannot be executed without a DB and a bucket.
 *
 * ## MONEY-1206 (D2) — the decoder is now imported, not extracted
 *
 * `toCsv` and `UnreadableFeedFile` used to be declared in `feed-parse.ts` and
 * lifted out of it by the same trick. They have moved to
 * `packages/core/src/market-data/bhavcopy.ts` as `decodeFeedText` /
 * `UnreadableFeedFile`, because `scripts/data/backfill-symbol-aliases.ts`
 * carried a SECOND decoder — zip and plain text only, no gzip — so one archive
 * had two readers that disagreed about what its bytes said, silently. This suite
 * now imports them directly, which is strictly stronger than extraction: it
 * executes the shipping module itself rather than a copy of its text. The
 * dedup is pinned below (`the archive has exactly ONE decoder`), because a
 * re-introduced private copy is invisible to every behavioural test here.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, deflateRawSync } from "node:zlib";

import {
  decodeFeedText,
  UnreadableFeedFile,
} from "../../src/market-data/bhavcopy";

/** Repo root by walking up to `yarn.lock` (see the dispatch suite's note). */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`repoRoot(): no yarn.lock above ${process.cwd()}`);
}

/** LINE comments before BLOCK: reversed, a `//` containing `/*` opens a phantom block. */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const ROOT = repoRoot();
const SCRIPT = join(ROOT, "scripts", "jobs", "feed-parse.ts");
const ALIAS_SCRIPT = join(
  ROOT,
  "scripts",
  "data",
  "backfill-symbol-aliases.ts",
);
/** RAW, not stripped: the extraction markers ARE comments. */
const RAW = readFileSync(SCRIPT, "utf8");
const SRC = stripComments(RAW);
/** The OTHER archive reader — the one that used to carry a rival decoder. */
const ALIAS_SRC = stripComments(readFileSync(ALIAS_SCRIPT, "utf8"));

// ─── Extraction ──────────────────────────────────────────────────────

/** The pure, import-free region between the `:begin` / `:end` markers. */
function markedRegion(marker: string): string {
  const begin = RAW.indexOf(`${marker}:begin`);
  const end = RAW.indexOf(`/* ${marker}:end */`);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(
      `feed-parse.ts is missing the ${marker} markers — the pure decision ` +
        "region must stay marked so this suite can execute it rather than " +
        "assert about its text",
    );
  }
  const afterComment = RAW.indexOf("*/", begin);
  if (afterComment < 0 || afterComment > end) {
    throw new Error(`${marker}:begin marker is not inside a block comment`);
  }
  return RAW.slice(afterComment + 2, end);
}

const VERDICT_SRC = markedRegion("unreadable-verdict");

/**
 * The named bindings of a script's import from the shared decoder module.
 *
 * `[^}]*` cannot cross a closing brace, so this can only ever match the real
 * import statement — no risk of a nearby `import {` being stitched onto a
 * distant `} from "…/bhavcopy"`. Throws when the import is gone, which is the
 * loud failure: a reader that stopped importing the shared decoder has, by
 * definition, gone back to having one of its own.
 */
function sharedImportBindings(src: string, name: string): string {
  // Either specifier is acceptable and the distinction is not cosmetic: the
  // package subpath and the relative path into src resolve to the SAME module
  // instance (node_modules/@usemoney/core is a symlink), which is exactly what
  // keeps `err instanceof UnreadableFeedFile` true across the seam. What this
  // guard actually protects is that the decoder is IMPORTED at all rather than
  // re-declared privately — pinning one spelling of the path was over-tight.
  const m = src.match(
    /import\s*\{([^}]*)\}\s*from\s*"(?:@usemoney\/core\/market-data|\.\.\/\.\.\/packages\/core\/src\/market-data\/bhavcopy)";/,
  );
  assert.ok(
    m,
    `${name} does not import the shared decoder from packages/core. Expected @usemoney/core/market-data, or the equivalent relative path into src -- both resolve to the SAME module instance, which is what keeps the instanceof check true across the seam.`,
  );
  return m[1]!;
}

interface UnreadableRunTally {
  newUnreadable: number;
  knownUnreadable: number;
  transientFailures: number;
  undated: number;
  knownBadSkipped: number;
  dryRun: boolean;
}

interface Extracted {
  judgeUnreadableFiles(t: UnreadableRunTally): {
    exitNonZero: boolean;
    message: string | null;
  };
}

/**
 * The extracted region, verbatim, as a standalone ESM module.
 *
 * `.mts` forces ESM — a bare `.ts` in os.tmpdir() has no nearby package.json and
 * tsx would treat it as CJS. Since MONEY-1206 moved the decoder into
 * `packages/core`, this module supplies NO imports of its own: the marked region
 * is pure by construction and a test below pins that it stays that way. If it
 * ever grows a dependency the module fails to load, which is a loud failure and
 * the right one.
 */
const tempDir = mkdtempSync(join(tmpdir(), "feed-parse-extract-"));
const modulePath = join(tempDir, "extracted.mts");
writeFileSync(modulePath, `${VERDICT_SRC}\n`, "utf8");

const live = (await import(pathToFileURL(modulePath).href)) as Extracted;

after(() => rmSync(tempDir, { recursive: true, force: true }));

const tally = (over: Partial<UnreadableRunTally>): UnreadableRunTally => ({
  newUnreadable: 0,
  knownUnreadable: 0,
  transientFailures: 0,
  undated: 0,
  knownBadSkipped: 0,
  dryRun: false,
  ...over,
});

// ─── The subject is really there ─────────────────────────────────────

describe("feed-parse unreadable — the extraction is of the real file", () => {
  it("extracted a substantial region from the shipping script", () => {
    assert.ok(
      SRC.length > 20_000,
      `feed-parse.ts read as ${SRC.length} chars — too small to be the real file`,
    );
    assert.ok(VERDICT_SRC.length > 800, "the verdict region looks truncated");
    assert.ok(
      VERDICT_SRC.includes("export function judgeUnreadableFiles"),
      "the marked region must contain the decision itself",
    );
  });

  it("executes the extracted code, not a copy of it", () => {
    // The export came from `feed-parse.ts` text a moment ago; if the module
    // ever stopped being built from RAW this fails.
    assert.equal(typeof live.judgeUnreadableFiles, "function");
    // The decoder half is now IMPORTED from packages/core rather than
    // extracted, which is stronger still — this is the shipping module object,
    // not a re-parse of its text.
    assert.equal(typeof decodeFeedText, "function");
    assert.ok(new UnreadableFeedFile("x") instanceof Error);
    assert.equal(new UnreadableFeedFile("x").name, "UnreadableFeedFile");
  });

  it("keeps the pure region import-free, or it could not be executed here", () => {
    // Comments stripped, and in this direction for the opposite reason to the
    // dispatch suite's: the prose here NAMES `process.exitCode` while explaining
    // why the decision must not touch it, and prose must not be able to fail a
    // check any more than it can satisfy one.
    const code = stripComments(VERDICT_SRC);
    assert.doesNotMatch(
      code,
      /\bimport\b/,
      "the marked decision region must not import anything — it is extracted " +
        "and executed in isolation",
    );
    assert.doesNotMatch(
      code,
      /\bprisma\b|\bDRY_RUN\b|process\.exitCode/,
      "the decision must stay a pure function of its argument: `dryRun` is an " +
        "input, not a module global, and setting the exit code is the caller's " +
        "job (same split as judgeRunCompletion)",
    );
  });
});

// ─── The predicate, executed ─────────────────────────────────────────

describe("judgeUnreadableFiles — partial failure is failure (MONEY-1205)", () => {
  it("a run with ONE new unreadable file exits non-zero", () => {
    // The whole ticket. Nothing about successes appears in this decision: the
    // old code only failed when EVERY file produced nothing, so 409 unreadable
    // of 688 exited 0.
    const v = live.judgeUnreadableFiles(tally({ newUnreadable: 1 }));
    assert.equal(v.exitNonZero, true);
    assert.match(String(v.message), /NOT already\s+recorded UNREADABLE/);
  });

  it("scales: 409 new unreadable files also exit non-zero", () => {
    const v = live.judgeUnreadableFiles(tally({ newUnreadable: 409 }));
    assert.equal(v.exitNonZero, true);
    assert.match(String(v.message), /409 file/);
  });

  it("a run whose ONLY unreadable files are already known-bad exits ZERO", () => {
    // The cry-wolf case. 13 files fail every night, forever, and none of them
    // is drift anyone can fix. A red nightly here would train the operator to
    // ignore the signal before it ever mattered.
    const v = live.judgeUnreadableFiles(
      tally({ knownUnreadable: 13, knownBadSkipped: 13 }),
    );
    assert.equal(v.exitNonZero, false);
    // Green, but never SILENT: the count still has to reach the operator.
    assert.match(String(v.message), /13 re-refused/);
    assert.match(String(v.message), /13 skipped as already UNREADABLE/);
  });

  it("a NEW refusal is not masked by a crowd of known ones", () => {
    // The mutation that would matter most: keying on a total rather than on the
    // new count. 12 known + 1 new must be red.
    const v = live.judgeUnreadableFiles(
      tally({ newUnreadable: 1, knownUnreadable: 12, knownBadSkipped: 12 }),
    );
    assert.equal(v.exitNonZero, true);
  });

  it("an unclassified failure is red even with nothing else wrong", () => {
    // Download timeout, Mongo error, unexpected exception. Never checkpointed,
    // so it clears itself next run if it was a moment — and stays red if not.
    const v = live.judgeUnreadableFiles(tally({ transientFailures: 1 }));
    assert.equal(v.exitNonZero, true);
    assert.match(String(v.message), /UNCLASSIFIED/);
    assert.match(String(v.message), /un-checkpointed/);
  });

  it("a clean run says nothing and exits zero", () => {
    const v = live.judgeUnreadableFiles(tally({}));
    assert.equal(v.exitNonZero, false);
    assert.equal(v.message, null);
  });

  it("an undated object is reported but NEVER fails the run", () => {
    // It cannot be checkpointed at all — the key is (family, date) — so it can
    // never join the known-bad set, so a tripwire on it could never be cleared.
    const v = live.judgeUnreadableFiles(tally({ undated: 4 }));
    assert.equal(v.exitNonZero, false);
    assert.match(String(v.message), /4 with no date token/);
  });

  it("undated files do not rescue a run that has a real failure", () => {
    const v = live.judgeUnreadableFiles(
      tally({ newUnreadable: 2, undated: 4 }),
    );
    assert.equal(v.exitNonZero, true);
    assert.match(String(v.message), /Not counted against the run:/);
  });

  it("a DRY RUN reports the failure but does not set the exit code", () => {
    // A dry run reads no checkpoints by design (it must run without
    // credentials), so it cannot tell a new refusal from a known one and does
    // not get a vote. Same `!DRY_RUN` gate the zero-rows tripwire already uses.
    const v = live.judgeUnreadableFiles(
      tally({ newUnreadable: 5, transientFailures: 2, dryRun: true }),
    );
    assert.equal(v.exitNonZero, false);
    assert.match(String(v.message), /DRY RUN/);
    assert.match(String(v.message), /5 file/);
  });

  it("both failure classes in one run produce one verdict naming both", () => {
    const v = live.judgeUnreadableFiles(
      tally({ newUnreadable: 3, transientFailures: 7 }),
    );
    assert.equal(v.exitNonZero, true);
    assert.match(String(v.message), /3 file\(s\) could not be read/);
    assert.match(String(v.message), /7 file\(s\) failed/);
  });
});

// ─── toCsv, executed ─────────────────────────────────────────────────

/** A minimal REAL single-entry ZIP, the shape `unzipSingleEntry` reads. */
function buildZip(content: string, method: 0 | 8): Buffer {
  const name = Buffer.from("bhav.csv", "ascii");
  const raw = Buffer.from(content, "utf-8");
  const body = method === 8 ? deflateRawSync(raw) : raw;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name, body]);
}

const CSV = "Date,Symbol,Open Interest\n2025-01-01,RELIANCE,12345\n";

describe("decodeFeedText — the gzip payload under a .csv key (MONEY-1205)", () => {
  it("inflates a gzip stream", () => {
    // `feeds/NSE/combine-oi-deleq/…2025-01-01…csv` is a gzip member. Its 230
    // rows are perfectly ordinary once inflated; the file was written off as an
    // unrecognised layout because it never got inflated.
    assert.equal(decodeFeedText(gzipSync(Buffer.from(CSV, "utf8"))), CSV);
  });

  it("the payload it fixes was GUARANTEED broken before, so nothing regressed", () => {
    // Why this cannot regress any of the ~30 families sharing toCsv: `1f 8b` is
    // not a valid UTF-8 lead pair (0x8b is a continuation byte), so the only
    // behaviour available to a matching payload today is replacement
    // characters. There was no behaviour to preserve.
    const gz = gzipSync(Buffer.from(CSV, "utf8"));
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    const old = gz.toString("utf8");
    assert.notEqual(old, CSV);
    assert.ok(
      old.includes("�"),
      "utf8-stringifying a gzip member must be lossy — if it were not, the " +
        "new branch would be changing a working path",
    );
  });

  it("leaves a DEFLATE zip unchanged", () => {
    assert.equal(decodeFeedText(buildZip(CSV, 8)), CSV);
  });

  it("leaves a STORED zip unchanged", () => {
    assert.equal(decodeFeedText(buildZip(CSV, 0)), CSV);
  });

  it("leaves plain UTF-8 unchanged", () => {
    assert.equal(decodeFeedText(Buffer.from(CSV, "utf8")), CSV);
  });

  it("leaves a non-UTF8 payload that is NOT gzip on the old path", () => {
    // A BIFF8 workbook (D0 CF 11 E0) still stringifies exactly as before: the
    // branch keys on the gzip magic, not on "looks binary". nse-fii-stats is
    // dispatched from the raw Buffer for that reason and must stay unaffected.
    const biff8 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.equal(decodeFeedText(biff8), biff8.toString("utf8"));
  });

  it("an empty payload is still the empty string, not a crash", () => {
    assert.equal(decodeFeedText(Buffer.alloc(0)), "");
  });

  it("a payload that claims gzip and will not inflate is CLASSIFIED unreadable", () => {
    // A verdict about the bytes, so it must arrive as UnreadableFeedFile: that
    // is what gets it recorded UNREADABLE and skipped, instead of failing the
    // run every night with an un-actionable zlib error.
    const fake = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      Buffer.from("not actually deflate data"),
    ]);
    assert.throws(
      () => decodeFeedText(fake),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, "UnreadableFeedFile");
        assert.match(err.message, /will not inflate/);
        return true;
      },
    );
  });
});

// ─── Wiring that cannot be executed without a DB and a bucket ────────

/** `main()`'s body — up to the module-scope `beforeExit` sentinel. */
function mainBody(): string {
  const start = SRC.indexOf("async function main(): Promise<void> {");
  assert.ok(start >= 0, "feed-parse.ts has no main()");
  const end = SRC.indexOf('process.on("beforeExit"', start);
  assert.ok(end > start, "could not find the end of main()");
  return SRC.slice(start, end);
}

/** The per-file parse catch — the block that used to swallow everything. */
function perFileCatch(): string {
  const body = mainBody();
  const at = body.indexOf("if (err instanceof UnreadableFeedFile) {");
  assert.ok(
    at >= 0,
    "the per-file catch no longer classifies the error. Without the class " +
      "check a Mongo timeout and a refused layout are the same `unknown`, and " +
      "marking one terminal turns a blip into a permanent skip (MONEY-1205).",
  );
  const start = body.lastIndexOf("} catch (err) {", at);
  assert.ok(start >= 0, "could not find the catch that classifies");
  const end = body.indexOf("progress.finished++", at);
  assert.ok(end > start, "could not find the end of the per-file catch");
  return body.slice(start, end);
}

describe("the run's exit code is wired to the verdict", () => {
  it("main() calls judgeUnreadableFiles with all four failure counters", () => {
    const body = mainBody();
    assert.match(body, /const unreadableVerdict = judgeUnreadableFiles\(\{/);
    for (const pair of [
      "newUnreadable: totalNewUnreadable",
      "knownUnreadable: totalKnownUnreadable",
      "transientFailures: totalTransientFailures",
      "undated: totalUndated",
      "knownBadSkipped: totalKnownBadSkipped",
      "dryRun: DRY_RUN",
    ]) {
      assert.ok(
        body.includes(pair),
        `the verdict call is missing \`${pair}\` — a counter that reaches no ` +
          "decision is the defect this ticket fixed",
      );
    }
  });

  it("acts on the verdict: logs it, and sets the exit code", () => {
    const body = mainBody();
    assert.match(body, /if \(unreadableVerdict\.message\) log\.warn\(/);
    assert.match(
      body,
      /if \(unreadableVerdict\.exitNonZero\) process\.exitCode = 1;/,
      "the verdict must actually set the exit code — the Cloud Run job's only " +
        "signal is the exit code",
    );
  });

  it("does NOT require a zero-row run, the way the old tripwires did", () => {
    // The reason a partial failure was invisible: both existing tripwires need
    // EVERY file to have produced nothing. This decision must not be gated on
    // rows at all.
    const body = mainBody();
    const call = body.slice(
      body.indexOf("const unreadableVerdict = judgeUnreadableFiles({"),
      body.indexOf("if (unreadableVerdict.exitNonZero)"),
    );
    assert.ok(call.length > 100, "could not isolate the verdict call site");
    assert.doesNotMatch(call, /totalRowsParsed|totalFilesAttempted/);
  });

  it("runs BEFORE the two older tripwires, both of which return early", () => {
    // The likeliest night for this line to matter is one where every opened
    // file was known-bad, so totalRowsParsed is 0 and the zero-rows tripwire
    // fires and returns with advice aimed at a different failure. The
    // breakdown has to be printed before that.
    const body = mainBody();
    const mine = body.indexOf(
      "const unreadableVerdict = judgeUnreadableFiles(",
    );
    const seen = body.indexOf("if (totalFilesSeen === 0)");
    const rows = body.indexOf(
      "if (totalFilesAttempted > 0 && totalRowsParsed === 0 && !DRY_RUN)",
    );
    assert.ok(mine > 0 && seen > 0 && rows > 0);
    assert.ok(mine < seen && mine < rows);
  });

  it("keeps both older tripwires intact", () => {
    // Neither may be weakened to make room for the new one.
    const body = mainBody();
    assert.match(
      body,
      /if \(totalFilesSeen === 0\) \{[\s\S]{0,600}?process\.exitCode = 1;\s*return;/,
      "the no-files-at-all tripwire (MONEY-1169) must still fail the run",
    );
    assert.match(
      body,
      /if \(totalFilesAttempted > 0 && totalRowsParsed === 0 && !DRY_RUN\) \{[\s\S]{0,700}?process\.exitCode = 1;\s*return;/,
      "the every-file-yielded-nothing tripwire (MONEY-1169) must still fail " +
        "the run, and must still gate on ATTEMPTED rather than SEEN",
    );
  });
});

describe("the checkpoint tells the truth about a file it could not read", () => {
  it("a classified refusal is recorded UNREADABLE — never DONE", () => {
    // The original bug, guarded directly: failure wearing the DONE label. DONE
    // means "rows were written"; the catch must not be able to say it.
    const block = perFileCatch();
    assert.match(block, /status: PARSE_STATUS\.unreadable/);
    assert.doesNotMatch(
      block,
      /PARSE_STATUS\.done|status: "DONE"/,
      "the per-file catch can reach a DONE checkpoint. That is MONEY-1204 " +
        "exactly: 414 files marked DONE having written nothing, resume " +
        "honouring it forever, and the run exiting 0.",
    );
    assert.doesNotMatch(
      block,
      /PARSE_STATUS\.zero|status: "ZERO"/,
      'ZERO means "the file parsed and had no rows" — a different fact, and it ' +
        "is retried rather than recorded, so a refusal must not borrow it",
    );
  });

  it("records the refusal text on the row, so the verdict is auditable", () => {
    const block = perFileCatch();
    // BOTH halves of this were satisfiable while recording nothing, and the
    // MONEY-1238 mutation matrix is what found it. `/err\.message/` matched the
    // `log.warn` at the TOP of the catch, so a `detail` reduced to a constant
    // string passed; `/detail,/` matched the CREATE alone, so dropping it from
    // the UPDATE — which is the half a RE-refusal takes — passed too. Scope
    // both to what they claim to be about.
    assert.match(
      block,
      /const detail = `UNREADABLE \$\{key\}: \$\{err\.message\}`/,
      "the stored detail must be built from the refusal's own message. A " +
        "checkpoint that says only UNREADABLE tells the next reader nothing " +
        "about which layout was refused, which is the whole point of storing it",
    );
    const upsert = block.slice(
      block.indexOf("prisma.feedBackfillProgress.upsert("),
    );
    assert.ok(upsert.length > 100, "could not isolate the UNREADABLE upsert");
    for (const half of ["create", "update"]) {
      const at = upsert.indexOf(`${half}: {`);
      assert.ok(at > 0, `the UNREADABLE checkpoint has no ${half} half`);
      const end = upsert.indexOf("}", at);
      assert.ok(end > at, `could not isolate the ${half} half`);
      assert.match(
        upsert.slice(at, end),
        /\bdetail,/,
        `the ${half} half drops the refusal text. On the UPDATE that is the ` +
          "silent one: a re-refusal lands on an existing row and leaves " +
          "yesterday's reason standing as though it were today's",
      );
    }
  });

  it("writes that checkpoint only when NOT a dry run", () => {
    const block = perFileCatch();
    const dry = block.indexOf("if (!DRY_RUN)");
    const db = block.indexOf("prisma.");
    assert.ok(dry >= 0, "the catch writes a checkpoint with no DRY_RUN guard");
    assert.ok(db > dry, "the DRY_RUN guard must precede the prisma call");
  });

  it("an UNCLASSIFIED failure is never checkpointed at all", () => {
    // The half that keeps this from re-creating the bug: only a deliberate,
    // inspected refusal may go terminal. Everything else stays retryable.
    const block = perFileCatch();
    const upserts = [
      ...block.matchAll(/prisma\.feedBackfillProgress\.upsert\(/g),
    ].length;
    assert.equal(
      upserts,
      1,
      `the catch makes ${upserts} checkpoint writes; exactly one — the ` +
        "classified branch — is allowed to write",
    );
    // The LAST `else` in the block: the classified branch has its own
    // dry-run else nested inside it, and anchoring on the first would scope
    // this assertion to the wrong branch and quietly stop guarding anything.
    const elseAt = block.lastIndexOf("} else {");
    assert.ok(elseAt > 0, "the catch has no unclassified branch");
    const unclassified = block.slice(elseAt);
    assert.match(
      unclassified,
      /totalTransientFailures\+\+;/,
      "the last else must be the unclassified branch",
    );
    assert.doesNotMatch(
      unclassified,
      /prisma\.|PARSE_STATUS/,
      "an unclassified failure must NOT be checkpointed with any status: a " +
        "Mongo timeout and a GCS 503 look identical to a refusal here, and " +
        "recording one terminal turns a transient blip into a permanent skip",
    );
  });

  it("a refusal we FAILED to record is not treated as recorded", () => {
    // Otherwise the exit code would go green on a verdict that was never
    // written, and the file would be re-refused (and re-hidden) forever.
    const block = perFileCatch();
    const at = block.indexOf("} catch (writeErr) {");
    assert.ok(
      at > 0,
      "the UNREADABLE checkpoint write must be guarded: unguarded, one Mongo " +
        "hiccup abandons every remaining family, while the DONE path survives " +
        "the same failure",
    );
    // BOUNDED to the writeErr catch BODY. This was `block.slice(at)`, which
    // ran to the end of the whole per-file catch, so the assertion was already
    // satisfiable by the `totalTransientFailures++` in a LATER branch — and
    // MONEY-1238 widened the gap by adding a THIRD one (the
    // FeedPrerequisiteUnavailable branch) inside the same span. Deleting the
    // increment from this block left the test green. Found by the mutation
    // matrix; the lesson is the repo's own: never let a structural span run to
    // the end of an enclosing block.
    const end = block.indexOf("} else {", at);
    assert.ok(
      end > at,
      "could not find the end of the writeErr catch — re-bound this slice " +
        "before trusting it again",
    );
    assert.match(
      block.slice(at, end),
      /totalTransientFailures\+\+;/,
      "a checkpoint write that FAILED must still make the run red from inside " +
        "its own catch — borrowing another branch's counter proves nothing",
    );
  });

  it("a download failure is transient, and is never checkpointed", () => {
    const body = mainBody();
    const at = body.indexOf("if (!buf) {");
    assert.ok(at > 0, "the download-failure branch is gone");
    const branch = body.slice(at, at + 600);
    assert.match(branch, /totalTransientFailures\+\+;/);
    assert.doesNotMatch(branch, /prisma\./);
  });

  it("the DONE/ZERO checkpoint stays on the success path only", () => {
    // Ordering, not presence: the writers throw, so control never reaches this
    // line for a file that could not be read. That is the structural half of
    // "a file that throws never gets a DONE checkpoint".
    const body = mainBody();
    // Anchored on `decideParseStatus`, which MONEY-1238 made the decision.
    // The old anchor was `fileRows > 0 ? DONE : ZERO` — the defect itself: it
    // gated on rows the PARSER produced, including rows no writer ever put in
    // front of the database. What this test pins is the ORDERING, and that is
    // unchanged.
    const status = body.search(/const verdict = decideParseStatus\(outcome\);/);
    assert.ok(
      status > 0,
      "the DONE/ZERO decision changed shape — re-verify it is still reached " +
        "only after every writer returned",
    );
    const catchAt = body.indexOf("} catch (err) {", status);
    assert.ok(
      catchAt > status,
      "the DONE/ZERO checkpoint must sit inside the try, before the catch",
    );
    assert.match(
      body.slice(status, catchAt),
      /update: \{\s*status,[\s\S]{0,200}?detail: null,/,
      "a healed file must clear the stored refusal text, or a DONE row keeps " +
        "advertising a bug that has been fixed",
    );
  });
});

describe("resume skips recorded refusals without hiding them", () => {
  it("reads DONE and UNREADABLE in one query, at run start", () => {
    const body = mainBody();
    assert.match(
      body,
      /status: \{ in: \[PARSE_STATUS\.done, PARSE_STATUS\.unreadable\] \}/,
      "resume must load both statuses: the UNREADABLE set is also the " +
        "run-START snapshot the exit-code decision needs",
    );
    assert.match(body, /const knownUnreadable = new Set\(/);
  });

  it("skips known-bad files unless --retry-unreadable is passed", () => {
    assert.match(
      SRC,
      /const RETRY_UNREADABLE = argv\.includes\("--retry-unreadable"\);/,
      "there must be a way to re-test a newly taught layout without deleting " +
        "checkpoints wholesale",
    );
    const body = mainBody();
    assert.match(
      body,
      /if \(!RETRY_UNREADABLE && knownUnreadable\.has\(iso\)\) \{/,
    );
  });

  it("counts and LOGS every skip, so the known-bad set cannot grow silently", () => {
    const body = mainBody();
    assert.match(body, /knownBadSkipped\+\+;/);
    assert.match(body, /totalKnownBadSkipped \+= knownBadSkipped;/);
    assert.match(
      body,
      /skipped as already-UNREADABLE \(re-test with --retry-unreadable\)/,
      "the per-family summary line must name the skipped files on EVERY run",
    );
  });

  it("still skips DONE, and still keeps ZERO retryable", () => {
    // ZERO must stay non-terminal (MONEY-1169): 8,621 days were once DONE at
    // zero rows and every one had to be purged by hand.
    const body = mainBody();
    assert.match(body, /\.filter\(\(r\) => r\.status === PARSE_STATUS\.done\)/);
    assert.doesNotMatch(
      body,
      /PARSE_STATUS\.zero\]|PARSE_STATUS\.zero,\s*\]/,
      "ZERO must never join the skip set",
    );
  });
});

describe("every file-level refusal is classified", () => {
  it("all eleven throw UnreadableFeedFile, and nothing throws a bare Error", () => {
    // A bare Error from a writer would be read as possibly-transient: not
    // recorded, retried nightly, and red forever — the cry-wolf outcome this
    // whole design avoids. The dispatch suite pins the count per writer; this
    // pins that the file has no unclassified refusal left anywhere.
    //
    // ELEVEN, not the twelve MONEY-1205 counted: the twelfth was the gzip
    // branch inside `toCsv`, and MONEY-1206 moved that decoder — with the
    // class — into packages/core. The count is still the writers' refusals,
    // and the moved throw is exercised directly further down.
    //
    // THIRTEEN as of MONEY-1210, which added the WDM half of `bond-eod`:
    //   +1  the WDM file's own "these bytes are not the settled-trades
    //       report" refusal, the direct counterpart of the CBM one
    //   +1  the `BOND_EOD_PARSERS` dispatch-table guard, which is deliberately
    //       an UnreadableFeedFile and NOT a bare Error — byte-for-byte the
    //       reasoning `BOND_MASTER_PARSERS` already carries: a bare Error reads
    //       as transient and goes red forever, and returning 0 would checkpoint
    //       the family DONE at zero rows.
    const classified = [...SRC.matchAll(/throw new UnreadableFeedFile\(/g)]
      .length;
    assert.equal(
      classified,
      13,
      `expected 13 classified throws (the writer refusals; the gzip branch ` +
        `moved to decodeFeedText in packages/core), found ${classified}`,
    );
    assert.doesNotMatch(
      SRC,
      /throw new Error\(/,
      "a refusal in feed-parse.ts throws a bare Error, which the dispatcher " +
        "reads as possibly-transient and will fail the run on forever",
    );
  });

  it("imports the ONE class rather than declaring a private one", () => {
    // A second class declaration would make `err instanceof UnreadableFeedFile`
    // false for anything `decodeFeedText` throws — the classification lost
    // silently, and a refused gzip demoted to "unclassified", i.e. never
    // checkpointed and red forever.
    assert.doesNotMatch(
      SRC,
      /class UnreadableFeedFile extends Error/,
      "feed-parse.ts declares its own UnreadableFeedFile again; there must be " +
        "exactly one class or `instanceof` stops holding across the seam",
    );
    assert.match(
      sharedImportBindings(SRC, "scripts/jobs/feed-parse.ts"),
      /\bUnreadableFeedFile\b/,
      "feed-parse.ts must import the shared class",
    );
    assert.match(SRC, /err instanceof UnreadableFeedFile/);
  });

  it("the class documents that unknown fails LOUD, not terminal", () => {
    // Executed, not read: this is the shipping class object.
    const err = new UnreadableFeedFile("refused");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "UnreadableFeedFile");
    assert.equal(err.message, "refused");
  });
});

// ─── D2: one archive, one decoder (MONEY-1206) ───────────────────────

describe("the archive has exactly ONE decoder", () => {
  it("neither archive reader declares a private one", () => {
    // The defect: `scripts/data/backfill-symbol-aliases.ts` carried its own
    // `toCsv` — zip and plain text only. `feed-parse.ts`'s learned about gzip
    // in MONEY-1205 and this one never did, so the single archived object that
    // is a gzip stream under a `.csv` key decoded to mojibake, produced no
    // ISINs, and contributed nothing to the rename history. No error, no
    // counter, no way to see it. Two decoders for one archive is the defect;
    // adding a second gzip branch would have been the same defect with a
    // longer fuse.
    for (const [name, src] of [
      ["scripts/jobs/feed-parse.ts", SRC],
      ["scripts/data/backfill-symbol-aliases.ts", ALIAS_SRC],
    ] as const) {
      assert.doesNotMatch(
        src,
        /function toCsv\s*\(/,
        `${name} declares a private decoder again — the two archive readers ` +
          "must not be able to disagree about what an archived object says",
      );
      assert.doesNotMatch(
        src,
        /unzipSingleEntry\(/,
        `${name} unzips on its own; decoding belongs to decodeFeedText so the ` +
          "zip/gzip/plain decision exists in exactly one place",
      );
    }
  });

  it("both readers import the shared decoder from packages/core", () => {
    for (const [name, src] of [
      ["scripts/jobs/feed-parse.ts", SRC],
      ["scripts/data/backfill-symbol-aliases.ts", ALIAS_SRC],
    ] as const) {
      assert.match(
        sharedImportBindings(src, name),
        /\bdecodeFeedText\b/,
        `${name} must import decodeFeedText`,
      );
    }
  });

  it("both readers CALL it — an import nothing uses proves nothing", () => {
    assert.match(SRC, /decodeFeedText\(buf\)/);
    assert.match(ALIAS_SRC, /decodeFeedText\(await downloadFile\(key\)\)/);
  });

  it("the alias backfill now decodes the gzip object it used to lose", () => {
    // The behaviour the dedup buys, run through the module both scripts call.
    // The old private decoder's exact logic, for contrast:
    //   isZip ? unzipSingleEntry(buf) : buf.toString("utf8")
    const gz = gzipSync(Buffer.from(CSV, "utf8"));
    const oldPrivateDecoder = gz.toString("utf8");
    assert.notEqual(oldPrivateDecoder, CSV);
    assert.equal(decodeFeedText(gz), CSV);
  });
});
