/**
 * `scripts/jobs/feed-parse.ts` — a file that wrote NOTHING must never be
 * recorded DONE (MONEY-1238).
 *
 * ## The defect this suite closes
 *
 * The parse pass checkpoints every file so it is not re-opened, and its own
 * vocabulary says why that is safe: "ZERO is non-terminal — loadCheckpoints
 * only skips DONE". The BSE-delivery family defeated that guarantee by
 * arithmetic:
 *
 *   tally.parsed += out.rows.length;          // <- BEFORE the bail
 *   ...
 *   const map = await loadScripToIsin();
 *   if (!map) { tally.unresolvedScrip += out.rows.length; return; }
 *
 * The dispatcher then computed `fileRows = bseDel.parsed - before` and stamped
 * `fileRows > 0 ? DONE : ZERO`. `parsed` had already moved, so the file was
 * DONE having written nothing — and `if (done.has(iso)) return false` skipped
 * that day FOREVER. Recovery is a hand-purge of `FeedBackfillProgress` rows.
 *
 * The trigger is not exotic. `listFiles` swallows GCS and auth errors and
 * returns `[]`, and says so in its own comment — callers "cannot distinguish
 * [it] from an empty prefix". `loadScripToIsin` then memoised `null` for the
 * whole run, so ONE blip stamped DONE on every BSE-delivery file in it.
 *
 * ## What is pinned here, and at which layer
 *
 * `feed-parse.ts` is a script with a top-level `main()` and a module-scope
 * Prisma import, so it cannot be imported into `node:test`. The suite therefore
 * splits by what each layer can actually promise:
 *
 *   BEHAVIOURAL  the status decision itself is a pure, marked region
 *                (`parse-status:begin` / `:end`) which this file extracts and
 *                EXECUTES — the same trick `feed-parse-unreadable.test.ts`
 *                uses. Mutate `decideParseStatus` in the shipping script and
 *                these tests go red.
 *   STRUCTURAL   the wiring that needs a bucket and a database to run: the
 *                ORDER of the counter increment against the prerequisite check,
 *                which counters feed `rowsUnaccounted`, and that the refusal
 *                path writes no checkpoint of any kind.
 *
 * MONEY-1204's warning applies to the second half and is why it is kept as
 * narrow as possible: a suite that pinned `return 0;` as source text once held
 * a data-loss bug in place. Every structural assertion below is about an
 * ordering or an absence that no behavioural test could reach without a live
 * GCS bucket, and every one of them strips comments FIRST — LINE before BLOCK,
 * because a `//` containing a `/*` opens a phantom block — so prose about the
 * bug can neither satisfy nor fail a check about the bug.
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
/** RAW, not stripped: the extraction markers ARE comments. */
const RAW = readFileSync(SCRIPT, "utf8");
const SRC = stripComments(RAW);

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

const STATUS_SRC = markedRegion("parse-status");

interface FileOutcome {
  rowsParsed: number;
  rowsUnaccounted: number;
}

interface Extracted {
  decideParseStatus(o: FileOutcome): {
    status: "DONE" | "ZERO";
    rowsAccounted: number;
    absorbedAll: boolean;
  };
}

/**
 * The extracted region, verbatim, as a standalone ESM module.
 *
 * `.mts` forces ESM — a bare `.ts` in os.tmpdir() has no nearby package.json
 * and tsx would treat it as CJS. The region supplies NO imports of its own and
 * a test below pins that it stays that way; if it ever grows a dependency this
 * module fails to load, which is a loud failure and the right one.
 */
const tempDir = mkdtempSync(join(tmpdir(), "feed-parse-status-"));
const modulePath = join(tempDir, "extracted.mts");
writeFileSync(modulePath, `${STATUS_SRC}\n`, "utf8");

const live = (await import(pathToFileURL(modulePath).href)) as Extracted;

after(() => rmSync(tempDir, { recursive: true, force: true }));

/** The body of one top-level `async function`, comments already stripped. */
function functionBody(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is gone from feed-parse.ts`);
  const next = SRC.indexOf("\nasync function ", start + 1);
  const alt = SRC.indexOf("\nfunction ", start + 1);
  const ends = [next, alt].filter((n) => n > start);
  const end = ends.length ? Math.min(...ends) : SRC.length;
  return SRC.slice(start, end);
}

// ─── The subject is really there ─────────────────────────────────────

describe("feed-parse status — the extraction is of the real file", () => {
  it("extracted a substantial region from the shipping script", () => {
    assert.ok(
      SRC.length > 20_000,
      `feed-parse.ts read as ${SRC.length} chars — too small to be the real file`,
    );
    assert.ok(STATUS_SRC.length > 500, "the status region looks truncated");
    assert.ok(
      STATUS_SRC.includes("export function decideParseStatus"),
      "the marked region must contain the decision itself",
    );
  });

  it("executes the extracted code, not a copy of it", () => {
    assert.equal(typeof live.decideParseStatus, "function");
  });

  it("keeps the pure region import-free, or it could not be executed here", () => {
    const code = stripComments(STATUS_SRC);
    assert.doesNotMatch(
      code,
      /\bimport\b|\brequire\(|\bprisma\b|process\.exitCode/,
      "the parse-status region must stay pure — no imports, no Prisma, no " +
        "process state. It is executed in isolation by this suite.",
    );
  });
});

// ─── The decision itself ─────────────────────────────────────────────

describe("decideParseStatus — a file that wrote nothing is never DONE", () => {
  it("stamps DONE when rows reached the database", () => {
    const v = live.decideParseStatus({ rowsParsed: 100, rowsUnaccounted: 0 });
    assert.equal(v.status, "DONE");
    assert.equal(v.rowsAccounted, 100);
    assert.equal(v.absorbedAll, false);
  });

  it("stamps ZERO — never DONE — when EVERY row was absorbed", () => {
    // THE defect. 3,700 BSE-delivery rows parsed, the scrip master missing, and
    // every one of them counted `unresolvedScrip` instead of written.
    const v = live.decideParseStatus({
      rowsParsed: 3700,
      rowsUnaccounted: 3700,
    });
    assert.notEqual(
      v.status,
      "DONE",
      "a file that put not one row in front of the database was stamped DONE " +
        "— which resume skips FOREVER (MONEY-1238)",
    );
    assert.equal(v.status, "ZERO");
    assert.equal(v.rowsAccounted, 0);
    assert.equal(
      v.absorbedAll,
      true,
      "absorbedAll is what makes the state SAYABLE; a silent counter is how " +
        "this ran unnoticed",
    );
  });

  it("stamps DONE on a PARTIAL absorption — some rows did land", () => {
    const v = live.decideParseStatus({ rowsParsed: 100, rowsUnaccounted: 40 });
    assert.equal(v.status, "DONE");
    assert.equal(v.rowsAccounted, 60);
    assert.equal(v.absorbedAll, false);
  });

  it("keeps ZERO for a genuinely empty file (a holiday), without claiming absorption", () => {
    const v = live.decideParseStatus({ rowsParsed: 0, rowsUnaccounted: 0 });
    assert.equal(v.status, "ZERO");
    assert.equal(v.rowsAccounted, 0);
    assert.equal(
      v.absorbedAll,
      false,
      "an empty file absorbed nothing — warning about it every holiday is how " +
        "a tripwire is trained into background noise",
    );
  });

  it("clamps an over-count instead of going negative into DONE", () => {
    // Defensive: two counters summed at the call site could, if one ever
    // double-counted, exceed the parse total. A negative `rowsAccounted` is
    // still not > 0, but it would also be reported as a negative `written`.
    const v = live.decideParseStatus({ rowsParsed: 100, rowsUnaccounted: 150 });
    assert.equal(v.status, "ZERO");
    assert.equal(v.rowsAccounted, 0);
    assert.ok(v.rowsAccounted >= 0, "rowsAccounted must never be negative");
  });

  it("floors non-finite input to ZERO — a NaN retries a file, never skips it", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const parsedBad = live.decideParseStatus({
        rowsParsed: bad,
        rowsUnaccounted: 0,
      });
      assert.equal(
        parsedBad.status,
        "ZERO",
        `rowsParsed=${bad} must not be able to stamp DONE`,
      );
      const unaccountedBad = live.decideParseStatus({
        rowsParsed: 10,
        rowsUnaccounted: bad,
      });
      assert.ok(
        Number.isFinite(unaccountedBad.rowsAccounted),
        `rowsUnaccounted=${bad} leaked a non-finite rowsAccounted`,
      );
    }
  });

  it("truncates fractional counts rather than propagating them", () => {
    // The fixture here was `{ 10.9, 0.9 }` asserting `rowsAccounted === 10`,
    // and it passed with `Math.trunc` DELETED: 10.9 - 0.9 is exactly 10 in
    // IEEE-754, so the two fractions cancelled in the subtraction and the
    // assertion never once observed the truncation it is named for. Caught by
    // this ticket's mutation matrix. The two fractions must not cancel, and
    // the INTEGERNESS is worth stating separately from the value.
    const v = live.decideParseStatus({
      rowsParsed: 10.9,
      rowsUnaccounted: 0.2,
    });
    assert.equal(v.rowsAccounted, 10);
    assert.ok(
      Number.isInteger(v.rowsAccounted),
      "rowsAccounted is what reportJobOutcome sends as `written` — a " +
        "fractional row count is not a row count",
    );

    // The same missing truncation reaches the STATUS, which is this ticket's
    // defect in miniature: un-truncated, 0.9 of a row is `> 0` and stamps DONE.
    const fraction = live.decideParseStatus({
      rowsParsed: 0.9,
      rowsUnaccounted: 0,
    });
    assert.equal(
      fraction.status,
      "ZERO",
      "a fractional row count must not be able to stamp DONE",
    );
  });

  it("floors a NEGATIVE unaccounted rather than inflating what landed", () => {
    // `rowsUnaccounted` is a DIFFERENCE of two tallies at every call site
    // (`after - before`), so a tally reset or reused between files can hand
    // this a negative. Unfloored it ADDS — 100 - (-5) reports 105 rows written
    // — and `rowsAccounted` is exactly what `reportJobOutcome` sends as
    // `written`, so an inflatable one is the number that would keep the
    // zero-write monitor quiet on the run it exists to catch.
    const v = live.decideParseStatus({ rowsParsed: 100, rowsUnaccounted: -5 });
    assert.equal(v.rowsAccounted, 100);
    assert.ok(
      v.rowsAccounted <= 100,
      "a negative rowsUnaccounted inflated rowsAccounted past the parse total",
    );
  });
});

// ─── The wiring that needs a bucket and a DB to execute ──────────────

describe("feed-parse wiring — the status is decided by the pure function", () => {
  it("no longer stamps the status straight off the parsed row count", () => {
    assert.doesNotMatch(
      SRC,
      /fileRows\s*>\s*0\s*\?\s*PARSE_STATUS\.done/,
      "the DONE gate is back on rows the PARSER produced, which includes rows " +
        "no writer ever put in front of the database (MONEY-1238)",
    );
    assert.match(
      SRC,
      /decideParseStatus\(outcome\)/,
      "the dispatcher must route the status through decideParseStatus",
    );
  });

  it("keeps PARSE_STATUS and the pure function speaking the same two words", () => {
    // The pure region cannot import PARSE_STATUS (it would stop being
    // extractable), so the vocabularies are joined by a translation at the call
    // site. If either side is renamed, this is what notices.
    assert.match(SRC, /done:\s*"DONE"/, "PARSE_STATUS.done is no longer DONE");
    assert.match(SRC, /zero:\s*"ZERO"/, "PARSE_STATUS.zero is no longer ZERO");
    assert.match(
      SRC,
      /verdict\.status\s*===\s*"DONE"\s*\?\s*PARSE_STATUS\.done\s*:\s*PARSE_STATUS\.zero/,
      "the translation from the pure vocabulary to PARSE_STATUS is gone",
    );
  });

  it("reports the absorbed-everything state instead of leaving it to a counter", () => {
    assert.match(
      SRC,
      /verdict\.absorbedAll/,
      "nothing reads `absorbedAll`, so the file-level state is silent again — " +
        "which is the half of this defect that let it run",
    );
  });
});

describe("writeBseDelivery — the prerequisite is checked BEFORE the counter moves", () => {
  const body = functionBody("writeBseDelivery");

  it("refuses when the scrip-master join table is unavailable", () => {
    assert.match(
      body,
      /throw new FeedPrerequisiteUnavailable\(/,
      "the map-unavailable path must THROW. Returning normally lets the " +
        "dispatcher checkpoint a file that wrote nothing.",
    );
  });

  it("does not credit `parsed` before that refusal", () => {
    // The ORDER is the defect, and `lastIndexOf` is NOT enough to pin it: a
    // re-inserted credit ABOVE the prerequisite leaves the last one where it
    // was, so the naive version of this assertion passed the mutant that
    // restores the original bug. (Caught by the mutation matrix, which is the
    // entire reason for running one.)
    //
    // So: EVERY `tally.parsed` credit that appears before the prerequisite is
    // resolved must sit inside the dry-run early return — a dry run writes no
    // checkpoint, so crediting coverage there can poison nothing — and there
    // must still be one on the real path, after the refusal.
    const prereqAt = body.indexOf("await loadScripToIsin()");
    assert.ok(prereqAt > 0, "writeBseDelivery no longer loads the join table");
    const prefix = body.slice(0, prereqAt);

    const dryGuardAt = prefix.indexOf(
      "if (DRY_RUN || out.rows.length === 0) {",
    );
    assert.ok(dryGuardAt >= 0, "the dry-run early return is gone");
    const dryReturnAt = prefix.indexOf("return;", dryGuardAt);
    assert.ok(dryReturnAt > dryGuardAt, "the dry-run guard no longer returns");

    const creditsBefore = [...prefix.matchAll(/tally\.parsed \+=/g)].map(
      (m) => m.index ?? -1,
    );
    for (const at of creditsBefore) {
      assert.ok(
        at > dryGuardAt && at < dryReturnAt,
        "`tally.parsed` is credited before the scrip-master refusal and " +
          "outside the dry-run guard, so a file that resolves NOTHING still " +
          "reports rows and gets stamped DONE — the exact MONEY-1238 " +
          "arithmetic this ticket removes",
      );
    }

    const bail = body.indexOf("throw new FeedPrerequisiteUnavailable(");
    const realCredit = body.indexOf("tally.parsed += out.rows.length;", bail);
    assert.ok(bail > 0, "the refusal is gone");
    assert.ok(
      realCredit > bail,
      "nothing credits `parsed` on the path that actually resolves rows — the " +
        "family would report zero coverage on a healthy run",
    );
  });

  it("does not classify a missing join table as UNREADABLE", () => {
    // UNREADABLE is a verdict about the BYTES and resume SKIPS it, so using it
    // here would be the same permanent skip wearing a different label.
    const bail = body.indexOf("throw new FeedPrerequisiteUnavailable(");
    const wrong = body.indexOf("throw new UnreadableFeedFile(");
    assert.ok(bail > 0);
    assert.equal(
      wrong,
      -1,
      "writeBseDelivery must not refuse with UnreadableFeedFile: that status " +
        "is skipped on resume exactly like DONE",
    );
  });

  it("feeds BOTH absorbing counters into rowsUnaccounted", () => {
    // `unresolvedScrip` had exactly ONE reader in the whole process — a
    // lower-case print in the summary — so it reached no verdict at all.
    // `noPriceRow` is the same shape: SCBSEALL is UPDATE-ONLY, so a row with no
    // DailyPrice to attach to never touches the database either.
    assert.match(
      SRC,
      /rowsUnaccounted:\s*\n?\s*bseDel\.unresolvedScrip \+ bseDel\.noPriceRow - beforeUnaccounted/,
      "the bse-delivery branch must count unresolvedScrip AND noPriceRow as " +
        "rows that never reached the database",
    );
  });
});

describe("loadScripToIsin — an empty listing is a FAILURE, not an empty prefix", () => {
  const body = (() => {
    const start = SRC.indexOf("async function loadScripToIsin(");
    assert.ok(start >= 0, "loadScripToIsin is gone from feed-parse.ts");
    const end = SRC.indexOf("\nasync function ", start + 1);
    return SRC.slice(start, end > start ? end : SRC.length);
  })();

  it("never memoises a bare null for 'could not look'", () => {
    // `listFiles` returns [] for a GCS/auth failure AND for an empty prefix,
    // and cannot tell them apart. Caching that as a plain absent value is a
    // cached fail-open default; the determinacy has to be its own value.
    assert.doesNotMatch(
      body,
      /scripToIsin = null/,
      "the unavailable case must be an explicit { ok: false } result, not a " +
        "null that reads identically to 'the master is empty'",
    );
    assert.match(body, /ok:\s*false/, "no explicit unavailable result");
    assert.match(body, /ok:\s*true/, "no explicit available result");
  });

  it("is loud about it — the old comment promised a warning that did not exist", () => {
    assert.match(
      body,
      /log\.warn\(/,
      "the doc claimed 'the family then skips with a loud warning'; there was " +
        "no log.warn on either return-null path and the family did not skip",
    );
  });

  it("treats a master that parsed to zero pairs as unavailable too", () => {
    // Same failure, different face: the object exists so the `!latest` guard
    // never fires, and every BSE row then misses the join.
    assert.match(
      body,
      /map\.size === 0/,
      "a scrip master that yields no scripCode->ISIN pairs must be reported " +
        "unavailable, not returned as a working empty map",
    );
  });
});

describe("the refusal path writes NO checkpoint", () => {
  /** The per-file `catch (err)` block in main(). */
  const catchBlock = (() => {
    const anchor = SRC.indexOf("if (err instanceof UnreadableFeedFile) {");
    assert.ok(anchor > 0, "the per-file classification catch is gone");
    const end = SRC.indexOf("progress.finished++;", anchor);
    assert.ok(end > anchor);
    return SRC.slice(anchor, end);
  })();

  it("classifies FeedPrerequisiteUnavailable separately from 'unclassified'", () => {
    assert.match(
      catchBlock,
      /else if \(err instanceof FeedPrerequisiteUnavailable\)/,
      "a diagnosed transient must not be logged as an UNCLASSIFIED failure " +
        "that tells the reader to go and look at the parser",
    );
  });

  it("makes the run red for it, and records nothing", () => {
    const start = catchBlock.indexOf(
      "else if (err instanceof FeedPrerequisiteUnavailable)",
    );
    const end = catchBlock.indexOf("} else {", start);
    assert.ok(end > start, "could not isolate the prerequisite branch");
    const branch = catchBlock.slice(start, end);
    assert.match(
      branch,
      /totalTransientFailures\+\+/,
      "a prerequisite failure must make the run exit non-zero",
    );
    assert.doesNotMatch(
      branch,
      /feedBackfillProgress\.upsert/,
      "the prerequisite branch must write NO checkpoint of any status — the " +
        "file has to be retried, and even UNREADABLE is skipped on resume",
    );
  });
});

describe("the zero-write monitor finally has a datapoint", () => {
  it("reports a job outcome under the id the monitor watches", () => {
    // `feed-parse` has been in MONITORED_JOBS since MONEY-1220 and never
    // emitted the metric, so the monitor sat permanently in NO DATA — on the
    // very job named first in its own comment.
    assert.match(
      SRC,
      /reportJobOutcome\(\{/,
      "feed-parse still emits no job outcome",
    );
    assert.match(
      SRC,
      /job:\s*"feed-parse"/,
      "the job id must match the monitor's MONITORED_JOBS entry",
    );
    const sh = readFileSync(
      join(ROOT, "scripts/ops/datadog/apply-monitors.sh"),
      "utf8",
    );
    assert.ok(
      sh.includes('"feed-parse|'),
      "feed-parse left MONITORED_JOBS — if that is deliberate, this emit can " +
        "go too; if not, the monitor is back to watching nothing",
    );
  });

  it("reports rows that REACHED the database, not rows the parser produced", () => {
    assert.match(
      SRC,
      /written:\s*totalRowsAccounted/,
      "`written` must be the accounted total. Reporting parsed rows would " +
        "recreate the silence one layer up: the exact case this monitor " +
        "exists for is rows parsed and none landed.",
    );
    assert.match(
      SRC,
      /selected:\s*totalFilesAttempted/,
      "`selected` must count files this run OPENED — counting rows there would " +
        "report `selected: 0` for a run whose every download failed",
    );
  });

  it("emits ABOVE the two tripwires that return early", () => {
    const emit = SRC.indexOf("reportJobOutcome({");
    const seenTripwire = SRC.indexOf("if (totalFilesSeen === 0) {");
    const zeroRowsTripwire = SRC.indexOf(
      "totalFilesAttempted > 0 && totalRowsParsed === 0",
    );
    assert.ok(emit > 0 && seenTripwire > 0 && zeroRowsTripwire > 0);
    assert.ok(
      emit < seenTripwire && emit < zeroRowsTripwire,
      "the outcome is emitted after a tripwire that `return`s, so it is " +
        "missing on precisely the runs it exists to describe",
    );
  });

  it("flushes, because a Cloud Run JOB exits long before the 15s buffer does", () => {
    assert.match(
      SRC,
      /await flushMetrics\(\)/,
      "without an explicit flush the counters die in datadog-metrics' buffer " +
        "and the monitor stays in NO DATA — the state this call removes",
    );
  });
});
