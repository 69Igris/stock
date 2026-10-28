/**
 * `scripts/jobs/feed-parse.ts` dispatch integrity — MONEY-1204 (P14 / P0.1).
 *
 * A structural suite, deliberately. `feed-parse.ts` is a script with a
 * top-level `main()`, a module-scope Prisma import and no dependency seam, so it
 * cannot be imported into `node:test` without opening a DB connection. What
 * matters here is not its runtime behaviour anyway — it is the WIRING, and every
 * defect this file guards against is a wiring defect that produces a clean-
 * looking run with zero rows.
 *
 * That failure mode is the whole point. Each of the three checks below
 * corresponds to something that was actually broken when `nse-fii-stats` was
 * first parsed, and none of them would have surfaced as an error:
 *
 *   1. **No `PARSERS` entry** → `feed-parse.ts` skips the family entirely
 *      (`const spec = PARSERS[id]; if (!spec) continue;`). The family had an
 *      archive of 1,636 objects and no parser for years, and nothing said so.
 *   2. **Payload stringified** → `decodeFeedText` ends in `buf.toString("utf8")`,
 *      which turns a BIFF8 workbook into mojibake. The parser then returns null and
 *      the run reports `UNRECOGNISED-FORMAT` on 100% of files — reading exactly
 *      like an upstream format change rather than our own bug.
 *   3. **Borrowed identity** → the writer must claim its own `metric`. Reusing
 *      "OI"/"VOLUME" targets the rows `nse-fao-participant-*` already owns for
 *      the same participant and the same days, and overwrites them silently.
 *
 * Source-text assertions strip comments first — LINE before BLOCK — so that a
 * check cannot be satisfied by the prose explaining the bug it guards against.
 *
 * MONEY-1204 / P14 14b.1 + 14b.2 extend the same three checks to the two debt
 * families, the debt price series and market-wide F&O open interest, plus the
 * two invariants those writers add:
 *
 *   4. **Date provenance** — `BondEOD.date` and `MwplDaily.date` are facts about
 *      a trading SESSION and must come from the row's own cell. The writers
 *      therefore do not take `day` AT ALL, which is a stronger guarantee than a
 *      comment: the archive key cannot reach them (MONEY-1189).
 *   5. **Authority order** — `BondMaster.isin` is `@unique` with no date in the
 *      key, so a re-walk of an OLDER file could roll the master back with no
 *      error, and two files with DISJOINT columns could blank each other's
 *      fields. Both are guarded, and both guards are load-bearing enough to
 *      pin (MONEY-1175 / MONEY-1093).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  FII_STATS_METRIC,
  FII_STATS_PARTICIPANT,
} from "../../src/market-data/fii-stats-logic";
import { POSITIONING_BUCKETS } from "../../src/market-data/market-positioning-logic";
import { MWPL_SOURCE } from "../../src/market-data/mwpl-logic";
import { familyById } from "../../src/market-data/report-registry";

/**
 * Repo root by walking up to `yarn.lock`, NOT `turbo.json`: Turborepo 2.x
 * package configurations mean a `turbo.json` can exist inside a package, so it
 * is not a root marker. Throws rather than falling back to cwd — a structural
 * test that cannot find its subject must fail loudly, never assert about "".
 */
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
const RAW = readFileSync(
  join(ROOT, "scripts", "jobs", "feed-parse.ts"),
  "utf8",
);
const SRC = stripComments(RAW);

/**
 * The source text of ONE writer, bounded by the next top-level declaration.
 *
 * Whole-file `assert.match` is too weak for the checks below: "the file
 * mentions `out.rows`" is true of nine writers, so a regex that lost its target
 * would keep passing on a neighbour's body. Every per-writer assertion is
 * scoped through here instead.
 */
function writerBody(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `writer ${name} is not in feed-parse.ts at all`);
  const rest = SRC.slice(start + 20);
  const next = rest.search(
    /\n(?:async function|function|interface|type|const) /,
  );
  const body =
    next < 0 ? SRC.slice(start) : SRC.slice(start, start + 20 + next);
  assert.ok(body.length > 400, `could not isolate the ${name} body`);
  return body;
}

/**
 * `--dry-run` must not open a DB connection. The guard is an ORDERING fact, not
 * a presence one — a `if (DRY_RUN) return` placed after the first query reads
 * identically and is useless — so this asserts the positions, not the text.
 */
function assertDryRunPrecedesPrisma(name: string): void {
  const body = writerBody(name);
  const db = body.indexOf("prisma.");
  assert.ok(
    db >= 0,
    `${name} makes no prisma call at all — did it stop writing?`,
  );
  // EVERY guard, not `indexOf` alone. One-guard-per-writer held until
  // MONEY-1210 gave `writeBondEod` a second file shape and a second guard; a
  // prisma call placed before the SECOND guard then still sat after the FIRST,
  // and the old assertion passed it. That is this repo's first-match-locator
  // failure verbatim — a structural anchor that silently re-points onto the
  // wrong occurrence once a second one appears. Found by the MONEY-1238
  // mutation matrix.
  const guards = [...body.matchAll(/if \(DRY_RUN\) return/g)].map(
    (m) => m.index ?? -1,
  );
  assert.ok(guards.length > 0, `${name} has no DRY_RUN early return`);
  for (const dry of guards) {
    assert.ok(
      dry < db,
      `${name} touches prisma BEFORE one of its ${guards.length} DRY_RUN ` +
        "guard(s), so --dry-run would open a DB connection and the job could " +
        "no longer be smoke-tested without one",
    );
  }
}

describe("feed-parse dispatch — the subject is really there", () => {
  it("read a substantial feed-parse.ts", () => {
    // Without this every assertion below could pass vacuously on an empty read.
    assert.ok(
      SRC.length > 20_000,
      `feed-parse.ts read as ${SRC.length} chars — too small to be the real file`,
    );
    assert.match(SRC, /const PARSERS = \{/);
  });
});

describe("nse-fii-stats is dispatched (MONEY-1204 / P0.1)", () => {
  it("has a PARSERS entry — without one the family is silently skipped", () => {
    assert.match(
      SRC,
      /"nse-fii-stats":\s*\{\s*kind:\s*"fii-stats"/,
      'no PARSERS entry for "nse-fii-stats": feed-parse hits ' +
        "`if (!spec) continue;` and walks past 1,636 archived objects without " +
        "parsing one, reporting a clean run",
    );
  });

  it("routes the RAW BUFFER to its writer, never the stringified payload", () => {
    assert.match(
      SRC,
      /writeFiiStats\(\s*buf\s*,/,
      "writeFiiStats must receive `buf`; passing `csv` hands it a " +
        "utf8-stringified BIFF8 workbook, i.e. mojibake",
    );
    assert.doesNotMatch(
      SRC,
      /writeFiiStats\(\s*csv\s*,/,
      "writeFiiStats is being handed the stringified payload",
    );
  });

  it("guards the decoder so the binary payload is never stringified at all", () => {
    // MONEY-1206 (D2): the decoder moved to
    // `packages/core/src/market-data/bhavcopy.ts` as `decodeFeedText`, because
    // `scripts/data/backfill-symbol-aliases.ts` carried a second copy that
    // never learned the gzip branch. Only the NAME changed here — what this
    // asserts is unchanged and is the load-bearing half: the short-circuit that
    // keeps a BIFF8 workbook away from `toString("utf8")` entirely.
    assert.match(
      SRC,
      /spec\.kind === "fii-stats"\s*\?\s*""\s*:\s*decodeFeedText\(buf\)/,
      "the decodeFeedText call must short-circuit for binary kinds",
    );
  });

  it("takes a Buffer, not a string, in the writer signature", () => {
    assert.match(
      SRC,
      /async function writeFiiStats\(\s*buf:\s*Buffer\s*,/,
      "writeFiiStats must be typed against Buffer — a `string` parameter " +
        "would let a future caller pass `csv` and typecheck cleanly",
    );
  });
});

describe("the write claims its own identity, not another feed's", () => {
  it("upserts on the full 4-part idempotency key", () => {
    assert.match(SRC, /date_participant_bucket_metric/);
  });

  it("writes FII_STATS_METRIC, imported — never a borrowed literal", () => {
    // Importing the constant is what keeps the writer and the parser's bucket
    // namespace in agreement. A literal here could drift from the one the
    // readers filter on and the rows would simply never be found.
    assert.match(SRC, /metric:\s*FII_STATS_METRIC/);
    assert.match(SRC, /participant:\s*FII_STATS_PARTICIPANT/);
    assert.match(SRC, /FII_STATS_METRIC,\s*\n\s*FII_STATS_PARTICIPANT,/);
  });

  it("does NOT write the metrics the participant feed owns", () => {
    const writer = SRC.slice(
      SRC.indexOf("async function writeFiiStats"),
      SRC.indexOf("async function writeFiiStats") + 3000,
    );
    assert.ok(writer.length > 500, "could not isolate the writeFiiStats body");
    assert.doesNotMatch(
      writer,
      /metric:\s*"(OI|VOLUME)"/,
      'writeFiiStats must not write metric "OI"/"VOLUME" — those rows belong ' +
        "to nse-fao-participant-oi/-vol for the same participant and days, and " +
        "an upsert on them is a silent overwrite, not a conflict",
    );
  });

  it("reports a column it could not read, LOUDLY", () => {
    // `resolveColumns` returns `-1` for an unmatched header and the file then
    // parses cleanly with that column null on every row. Re-wording "OPEN
    // INTEREST AT THE END OF THE DAY" — entirely within NSE's gift — produced
    // `rows: 16, reasons: {}, discrepancies: 0` and 0 of 16 rows carrying open
    // interest. The tally must carry it, and in the UPPER-CASE band this log
    // reserves for "we wrote nothing for a file we could read".
    assert.match(
      SRC,
      /unresolvedColumns:\s*number/,
      "FiiStatsTally must carry an unresolved-column counter",
    );
    assert.match(
      SRC,
      /tally\.unresolvedColumns\s*\+=\s*out\.unresolvedColumns\.length/,
      "the counter must actually be fed from the parse result",
    );
    assert.match(
      SRC,
      /UNRESOLVED-COLUMNS \$\{fiiStats\.unresolvedColumns\}/,
      "an unread column must be logged UPPER-CASE like the other " +
        '"we wrote nothing for a file we could read" counters',
    );
  });

  it("does not clear a stored value with a null it never read", () => {
    // `null` means two different things here. From a RESOLVED column it is a
    // reading ("NSE printed nothing") and the update is right to persist it.
    // From an UNRESOLVED one we never looked, and persisting it destroys what a
    // previous correct parse wrote — to EVERY archived day on a re-walk. Same
    // rule as `InstrumentProvider.mapToUpdate` (MONEY-1093) and the BondMaster
    // writer below: supply or replace what you publish, never clear what you
    // do not.
    const writer = SRC.slice(
      SRC.indexOf("async function writeFiiStats"),
      SRC.indexOf("async function writeBondMaster"),
    );
    assert.ok(writer.length > 500, "could not isolate the writeFiiStats body");
    for (const field of ["openInterestQty", "openInterestValue"]) {
      assert.match(
        writer,
        new RegExp(`${field}: readOrKeep\\(`),
        `${field} must pass undefined on UPDATE when its column was unread`,
      );
    }
    // CREATE still writes the null: a new row has nothing to preserve.
    assert.match(
      writer,
      /create:\s*\{[\s\S]*?openInterestQty: row\.openInterestQty/,
    );
  });

  it("persists the rupee and open-interest columns the participant feed lacks", () => {
    // If these are dropped the feed is a strictly worse duplicate of data we
    // already have, and the parse is pointless.
    for (const f of [
      "longValue",
      "shortValue",
      "netValue",
      "openInterestQty",
      "openInterestValue",
    ]) {
      assert.match(SRC, new RegExp(`${f}:\\s*row\\.${f}`), `writer drops ${f}`);
    }
  });
});

describe("namespace invariants the writer depends on", () => {
  it("the fii-stats metric is distinct from every positioning metric", () => {
    assert.equal(FII_STATS_METRIC, "FII_STATS");
    assert.ok(!["OI", "VOLUME"].includes(FII_STATS_METRIC));
  });

  it("the participant is one the positioning feed also uses — hence the metric split", () => {
    // This is the reason the guard is needed at all: the collision is real,
    // not hypothetical. FII appears in BOTH feeds.
    assert.equal(FII_STATS_PARTICIPANT, "FII");
    assert.ok(POSITIONING_BUCKETS.length > 0);
  });
});

/**
 * MONEY-1204 / P14 14b.1 + 14b.2 — the four new families.
 *
 * Same failure mode as the fii-stats block above and the same reason it needs a
 * structural test: a missing `PARSERS` entry is not an error. `feed-parse` hits
 * `if (!spec) continue;`, walks past the whole archive, prints a summary with no
 * line for that family, and exits 0.
 */
const NEW_FAMILIES: ReadonlyArray<readonly [string, string, string]> = [
  ["nse-wdm-list", "bond-master", "writeBondMaster"],
  ["nse-corporate-bond-report", "bond-master", "writeBondMaster"],
  ["nse-cbm-trades", "bond-eod", "writeBondEod"],
  // MONEY-1210 — the WDM half of `BondEOD.segment`. Archived since 17-Aug but
  // routed to no parser, so `feed-parse` walked past every object for it.
  ["nse-wdm-daily", "bond-eod", "writeBondEod"],
  ["nse-combine-oi-deleq", "mwpl", "writeMwpl"],
];

describe("the P14 debt/positioning families are dispatched (MONEY-1204 / 14b.1 + 14b.2, MONEY-1210)", () => {
  for (const [id, kind] of NEW_FAMILIES) {
    it(`${id} has a PARSERS entry with kind "${kind}"`, () => {
      assert.match(
        SRC,
        new RegExp(`"${id}":\\s*\\{\\s*kind:\\s*"${kind}"`),
        `no PARSERS entry for "${id}": feed-parse hits \`if (!spec) continue;\` ` +
          "and walks past every archived object for it without parsing one, " +
          "reporting a clean run with no line for the family at all",
      );
    });
  }

  it("every id in a new PARSERS entry actually resolves in the report registry", () => {
    // The OTHER silent skip. A PARSERS id that the registry does not know
    // makes feed-parse log `not in the registry, skipping` and continue — a
    // one-character typo costs the whole family, with no error and no
    // non-zero exit.
    const entries = [
      ...SRC.matchAll(
        /"([a-z0-9-]+)":\s*\{\s*kind:\s*"(bond-master|bond-eod|mwpl)"/g,
      ),
    ];
    assert.equal(
      entries.length,
      NEW_FAMILIES.length,
      `found ${entries.length} bond/mwpl PARSERS entries, expected ${NEW_FAMILIES.length}`,
    );
    for (const m of entries) {
      const family = familyById(m[1]!);
      assert.ok(
        family,
        `PARSERS names "${m[1]}", which is not in the registry`,
      );
      assert.equal(
        family.enabled,
        true,
        `"${m[1]}" is parsed here but not enabled for the nightly fetch, so ` +
          "the archive it reads would never grow",
      );
    }
  });

  for (const [, , writer] of NEW_FAMILIES) {
    it(`${writer} returns before any prisma call under --dry-run`, () => {
      assertDryRunPrecedesPrisma(writer);
    });
  }

  for (const [, , writer] of NEW_FAMILIES) {
    it(`${writer} THROWS on an unreadable file instead of returning zero`, () => {
      // `rows: []` with a header found and `null` mean opposite things — "the
      // report published nothing" vs "these bytes are not this report". Every
      // parser here returns both, and collapsing them is how a 404 page gets
      // ingested as a quiet zero-row success (MONEY-1169).
      //
      // This assertion used to require `return 0;` here, and that is precisely
      // what it was pinning: a bug, held in place by a test (MONEY-1204). See
      // the suite below for what changed and why.
      //
      // MONEY-1205 narrows it from `Error` to `UnreadableFeedFile`. The throw is
      // no longer the whole guarantee: the dispatcher now DECIDES on the error's
      // class — a classified refusal is recorded UNREADABLE and stops being
      // re-opened, anything else is treated as possibly-transient, left
      // un-checkpointed, and fails the run every time. A plain `Error` here
      // would therefore paint the nightly job red forever.
      assert.match(
        writerBody(writer),
        /if \(out === null\) \{\s*tally\.unrecognisedFormat\+\+;\s*throw new UnreadableFeedFile\(/,
        `${writer} must count a null parse AND throw the CLASSIFIED error, so ` +
          "the file is recorded UNREADABLE rather than checkpointed or retried " +
          "forever",
      );
    });
  }
});

/**
 * MONEY-1204 — "we cannot read this file" may never return 0.
 *
 * ## The measurement
 *
 * `writeMwpl` returned 0 when its parser returned null. A 0 return is
 * indistinguishable from "parsed fine, the market was shut", so the dispatcher
 * checkpointed the file DONE and never retried it. On prod, 2026-08-18:
 * `nse-combine-oi-deleq` had **684 DONE checkpoints against 270 distinct days**
 * in `mwpl_daily`, over an archive spanning 2023-04-12 → 2026-08-14. 414 files
 * were declared complete having written nothing, the run logged
 * `UNRECOGNISED-FORMAT 409, NO-LEGIBLE-ROWS 9`, and it exited 0.
 *
 * Five more writers had the same shape and had simply not drifted yet
 * (`nse-fii-stats`: 1,632 DONE / 1,636 days written — no loss, yet).
 *
 * ## The rule, and its LIMIT
 *
 * `writeBseLegacyCash` is the reference: it throws, which routes the file into
 * the per-file catch, counts it `unreadable`, and leaves it UN-CHECKPOINTED so
 * the next run retries it.
 *
 * The limit matters as much as the rule. A counter meaning "this ROW was
 * unusable" is NOT the same signal, and converting one would fail a whole file
 * over a single bad line. So the split asserted below is deliberate and both
 * halves are pinned: every FILE-level refusal throws, and the per-row counters
 * are proven to still be counters by pinning the exact number of throws in each
 * writer.
 */
describe("an unreadable FILE throws; an unusable ROW is counted", () => {
  /**
   * Every file-level refusal in the job: [writer, guard, counter | null].
   *
   * A `null` counter is a refusal that deliberately bumps NOTHING —
   * `writeBondMaster`'s missing dispatch entry is a WIRING fault, and
   * `unrecognisedFormat` is documented as "the parser returned null". Counting
   * it there would send the next reader hunting an NSE layout change that never
   * happened.
   */
  const FILE_LEVEL: ReadonlyArray<
    readonly [string, string, string | null, string]
  > = [
    // the reference implementation this rule was taken from
    [
      "writeBseLegacyCash",
      "if (!out)",
      "unrecognisedFormat",
      "not this report",
    ],
    // the writer that actually lost data
    ["writeMwpl", "if (out === null)", "unrecognisedFormat", "not this report"],
    [
      "writeMwpl",
      "if (out.rows.length === 0)",
      "noRows",
      "header ok, no legible row",
    ],
    // the five latent ones
    [
      "writePositioning",
      "if (out === null)",
      "unrecognisedFormat",
      "not this report",
    ],
    [
      "writePositioning",
      "if (out.tradingDate === null)",
      "noDate",
      "title row has no date",
    ],
    [
      "writePositioning",
      "if (out.measure === null)",
      "noMeasure",
      "title row has no measure",
    ],
    [
      "writeFiiStats",
      "if (out === null)",
      "unrecognisedFormat",
      "not this report",
    ],
    [
      "writeFiiStats",
      "if (out.tradingDate === null)",
      "noDate",
      "title row has no date",
    ],
    ["writeBondMaster", "if (!parse)", null, "no parser wired for the family"],
    [
      "writeBondMaster",
      "if (out === null)",
      "unrecognisedFormat",
      "not this report",
    ],
    [
      "writeBondEod",
      "if (out === null)",
      "unrecognisedFormat",
      "not this report",
    ],
  ];

  for (const [writer, guard, counter, why] of FILE_LEVEL) {
    it(`${writer}: ${why} — throws, never returns 0`, () => {
      const body = writerBody(writer);
      const at = body.indexOf(guard);
      assert.ok(at >= 0, `${writer} has no \`${guard}\` guard any more`);
      // The branch is everything up to its closing brace at the guard's indent.
      const branch = body.slice(at, at + 700);
      const end = branch.indexOf("\n  }");
      const scoped = end < 0 ? branch : branch.slice(0, end);

      assert.match(
        scoped,
        /throw new UnreadableFeedFile\(/,
        `${writer}'s \`${guard}\` branch must THROW. Returning 0 lets the ` +
          "dispatcher checkpoint the file DONE at zero rows and never retry it " +
          "— the defect that cost nse-combine-oi-deleq 414 files (MONEY-1204).",
      );
      assert.doesNotMatch(
        scoped,
        /throw new Error\(/,
        `${writer}'s \`${guard}\` throws a bare Error. MONEY-1205: the ` +
          "dispatcher reads the error's CLASS. Only `UnreadableFeedFile` is a " +
          "verdict about the bytes and gets recorded UNREADABLE; a bare Error " +
          "is read as possibly-transient, so this deliberate refusal would fail " +
          "the run on every night forever — the cry-wolf failure the zero-rows " +
          "tripwire above already warns about.",
      );
      assert.doesNotMatch(
        scoped,
        /return 0;/,
        `${writer}'s \`${guard}\` branch still returns 0`,
      );
      if (counter === null) {
        assert.doesNotMatch(
          scoped,
          /tally\.\w+\+\+;/,
          `${writer}'s \`${guard}\` is a wiring fault and must not be counted ` +
            "as a format one",
        );
      } else {
        assert.match(
          scoped,
          new RegExp(`tally\\.${counter}\\+\\+;`),
          `${writer}'s \`${guard}\` branch must still count \`${counter}\` — the ` +
            "throw makes it retryable, the counter makes it visible on the " +
            "summary line",
        );
      }
    });
  }

  it("NO writer in the job returns a silent zero any more", () => {
    // The single strongest form of the rule: a bare `return 0;` in this file is
    // always the "I could not read it, call it an empty day" shape. Reverting
    // any one of the eleven branches above fails here as well as in its own
    // case, and a NEW writer that adds one is caught the day it lands.
    assert.doesNotMatch(
      SRC,
      /\n\s*return 0;/,
      "a writer returns 0 for a file it could not read — that is " +
        "indistinguishable from a holiday and gets checkpointed DONE forever",
    );
  });

  /**
   * The other half of the rule: these writers must NOT have become all-or-
   * nothing. Pinning the exact throw count is what stops a future blanket
   * conversion of the per-ROW counters, which would fail a whole file over one
   * bad line — the opposite defect, and just as expensive.
   */
  const THROW_COUNTS: ReadonlyArray<readonly [string, number]> = [
    ["writePositioning", 3],
    ["writeFiiStats", 2],
    ["writeBondMaster", 2],
    // MONEY-1210 — 3, not 1. `writeBondEod` now serves TWO file shapes
    // (`nse-cbm-trades` carries an ISIN, `nse-wdm-daily` does not):
    //   1. the CBM "these bytes are not the CBM trades report" refusal
    //   2. the WDM counterpart of it
    //   3. the `BOND_EOD_PARSERS` dispatch-table guard
    // All three are FILE-level, so the invariant this guard protects — that a
    // per-ROW drop never becomes a whole-file failure — is intact. (3) is
    // deliberately an UnreadableFeedFile rather than a bare Error, matching
    // `BOND_MASTER_PARSERS`: a bare Error reads as transient and goes red
    // forever, and returning 0 would checkpoint the family DONE at zero rows.
    ["writeBondEod", 3],
    ["writeMwpl", 2],
  ];

  for (const [writer, expected] of THROW_COUNTS) {
    it(`${writer} throws exactly ${expected}x — row-level drops stay counters`, () => {
      const body = writerBody(writer);
      const throws = [...body.matchAll(/throw new UnreadableFeedFile\(/g)]
        .length;
      assert.equal(
        throws,
        expected,
        `${writer} has ${throws} throws, expected ${expected}. More means a ` +
          "per-ROW counter was converted, and one unusable line now fails the " +
          "whole file; fewer means a file-level refusal went back to a quiet " +
          "zero.",
      );
    });
  }

  it("the row-level counters really are still plain accumulations", () => {
    // Named explicitly rather than inferred, so that deleting one is a failure
    // rather than a smaller number nobody notices. Each of these means "this
    // ROW/leg/column was unusable" and the file around it still has real rows
    // to write.
    const rowLevel: ReadonlyArray<readonly [string, string]> = [
      ["writePositioning", "discrepancies"],
      ["writePositioning", "droppedLegs"],
      ["writeFiiStats", "droppedRows"],
      ["writeFiiStats", "unresolvedColumns"],
      ["writeBondMaster", "duplicateIsin"],
      ["writeBondMaster", "noIsin"],
      ["writeBondMaster", "columnCountMismatch"],
      ["writeBondEod", "noIsin"],
      ["writeBondEod", "unparseableTradeDate"],
      ["writeBondEod", "noMasterRow"],
      ["writeMwpl", "badDate"],
      ["writeMwpl", "noSymbol"],
      ["writeMwpl", "fieldCount"],
    ];
    for (const [writer, counter] of rowLevel) {
      assert.match(
        writerBody(writer),
        new RegExp(`tally\\.${counter} \\+=`),
        `${writer}.${counter} is a per-ROW drop and must stay a += counter, ` +
          "never a throw",
      );
    }
  });
});

describe("BondMaster: two files, one @unique key, declared authority order", () => {
  it("routes each family to its OWN parser", () => {
    // The two shapes share a destination table and nothing else: wdmlist is a
    // plain 13-column table, the corporate report is 25 columns behind two
    // banner rows. Crossing them yields `null`, i.e. UNRECOGNISED-FORMAT on
    // 100% of files — reading like an upstream change rather than our wiring.
    assert.match(SRC, /"nse-wdm-list":\s*parseWdmList/);
    assert.match(
      SRC,
      /"nse-corporate-bond-report":\s*parseCorporateBondReport/,
    );
  });

  it("upserts on isin — the model's @unique, not a compound guess", () => {
    assert.match(
      writerBody("writeBondMaster"),
      /prisma\.bondMaster\.upsert\(\{\s*where:\s*\{\s*isin:\s*row\.isin\s*\}/,
    );
  });

  it("takes asOf from the file's own bytes and falls back to the key", () => {
    const body = writerBody("writeBondMaster");
    // BondMaster.asOf is NON-NULL in the schema and parseWdmList ALWAYS returns
    // null (that family prints no date in any column), so without the fallback
    // every wdmlist row fails to write. The corporate report carries its own
    // banner date and `??` lets it win, which is the house rule.
    assert.match(body, /const asOf = out\.asOf \?\? day;/);
    assert.match(
      body,
      /if \(out\.asOf === null\) tally\.asOfFromKey\+\+;/,
      "the key fallback must be COUNTED — for the corporate report a non-zero " +
        "means its banner stopped parsing and provenance silently degraded",
    );
  });

  it("refuses to let an OLDER file overwrite a NEWER master row", () => {
    // No date in this table's key, so a history re-walk that reaches 2019 after
    // tonight's file would roll the master back seven years with no error and
    // no counter. Declared order, not arrival order (MONEY-1175).
    const body = writerBody("writeBondMaster");
    assert.match(body, /prev\.getTime\(\) > asOf\.getTime\(\)/);
    assert.match(body, /tally\.olderThanStored\+\+;/);
  });

  it("never lets an incoming null erase a stored value", () => {
    // wdmlist has NO Issuer / Face Value / Credit Rating column at all, so
    // parseWdmList hard-codes those to null. A plain last-write-wins update
    // would have wdmlist blank what the corporate report supplied an hour
    // earlier — and the row would still look complete, just poorer. Prisma
    // reads `undefined` as "leave this field alone" (MONEY-1093 mapToUpdate).
    const body = writerBody("writeBondMaster");
    for (const f of [
      "issuer",
      "issueName",
      "issueDesc",
      "creditRating",
      "coupon",
      "couponFrequency",
      "faceValue",
      "issueDate",
      "maturityDate",
      "nextCouponDate",
      "lastTradedDate",
      "lastTradedPrice",
      "status",
    ]) {
      assert.match(
        body,
        new RegExp(`${f}: row\\.${f} \\?\\? undefined`),
        `writeBondMaster's update writes ${f} unconditionally: a file that does ` +
          `not publish that column would erase the one that does`,
      );
    }
  });
});

describe("BondEOD: the row's own date, the full unique, and a measured join", () => {
  it("cannot see the archive key at all — the date is the row's", () => {
    // Stronger than a comment: `day` is not a parameter, so there is nothing
    // for a future edit to reach for (MONEY-1189).
    assert.match(
      SRC,
      /async function writeBondEod\(\s*csv: string,\s*family: string,\s*tally: BondEodTally,\s*\)/,
      "writeBondEod must not take `day`",
    );
    // The ARGUMENT LIST is the guarantee, not the assignment target: the
    // dispatcher now records a FileOutcome rather than a bare row count
    // (MONEY-1238), and pinning `fileRows =` here would have been pinning the
    // variable name of the defect.
    assert.match(SRC, /await writeBondEod\(csv, id, bondEod\)/);
  });

  it("upserts on (isin, date, SEGMENT) — the whole unique", () => {
    // Dropping `segment` makes the same ISIN's CBM and WDM prints collide into
    // a last-write-wins overwrite. That is MONEY-1201's SLB bug exactly, where
    // 84.2% of a day's open interest vanished while the run counted successes.
    // MONEY-1210 — the upsert moved into `upsertBondEodRows`, which BOTH file
    // shapes converge on, so the unique is stated once instead of twice. The
    // invariant is unchanged and now covers the WDM path too.
    assert.match(
      writerBody("upsertBondEodRows"),
      /isin_date_segment:\s*\{\s*isin:\s*row\.isin,\s*date:\s*row\.date,\s*segment:\s*row\.segment,/,
    );
  });

  it("MEASURES the master join and never filters on it", () => {
    // Coverage of cbm_trd's ISINs by the two masters is unknown — the file
    // carries G-Sec and CP/CD-series ISINs that suggest partial coverage at
    // best. A price with no master row is still a price, so it is written; a
    // join that matches NOTHING is the MONEY-1085 shape and must not be silent.
    // The probe lives in writeBondEod (CBM path); the write loop is now in the
    // shared `upsertBondEodRows`. Split accordingly — MONEY-1210.
    const body = writerBody("writeBondEod");
    assert.match(body, /tally\.noMasterRow \+= orphans;/);
    assert.match(
      body,
      /orphans === out\.rows\.length/,
      "a TOTAL join miss must be called out separately from a partial one",
    );
    assert.match(body, /log\.warn\(/);

    const writeLoop = writerBody("upsertBondEodRows");
    assert.match(
      writeLoop,
      /for \(const row of rows\) \{/,
      "the write loop must iterate every row handed to it",
    );
    assert.doesNotMatch(
      writeLoop,
      /for \(const row of rows\.filter/,
      "an unjoined EOD row must never be dropped — that trades a naming gap " +
        "for a data gap",
    );

    // MONEY-1210 — the WDM path CANNOT write an unjoined row (no ISIN, no key),
    // so its miss is a refusal rather than a coverage note. Assert it is named
    // and counted rather than silently dropped.
    const wdm = writerBody("resolveWdmFile");
    assert.match(wdm, /tally\.noMasterMatch \+= res\.reasons\.noMasterMatch/);
    assert.match(wdm, /tally\.ambiguousPair \+= res\.reasons\.ambiguousPair/);
    assert.match(
      wdm,
      /log\.warn\(/,
      "a total WDM join miss reads exactly like a day with no wholesale-debt " +
        "trading, so it must be called out",
    );
  });

  it("shouts in the summary only when the miss is total", () => {
    assert.match(SRC, /NO-MASTER-ROW-FOR-ANY-ROW \$\{bondEod\.noMasterRow\}/);
    assert.match(
      SRC,
      /no-master-row \$\{bondEod\.noMasterRow\}\/\$\{bondEod\.parsed\}/,
    );
  });
});

describe("MwplDaily: the numerator only, and the row's own date", () => {
  it("cannot see the archive key at all — the date is the row's", () => {
    assert.match(
      SRC,
      /async function writeMwpl\(\s*csv: string,\s*family: string,\s*tally: MwplTally,\s*\)/,
      "writeMwpl must not take `day`",
    );
    assert.match(SRC, /await writeMwpl\(csv, id, mwpl\)/);
  });

  it("upserts on (symbol, date)", () => {
    assert.match(
      writerBody("writeMwpl"),
      /symbol_date:\s*\{\s*symbol:\s*write\.symbol,\s*date:\s*write\.date\s*\}/,
    );
  });

  it("writes the source constant the readers filter on, not the family id", () => {
    // The family id would be "nse-combine-oi-deleq"; MWPL_SOURCE is
    // "NSE_COMBINE_OI_DELEQ". Rows stamped with the wrong one are simply never
    // found — the same borrowed-identity class as the fii-stats metric above,
    // in the opposite direction.
    assert.match(
      writerBody("writeMwpl"),
      /toMwplDailyWrite\(row, MWPL_SOURCE\)/,
    );
    assert.match(SRC, /\n {2}MWPL_SOURCE,\n/);
    assert.equal(MWPL_SOURCE, "NSE_COMBINE_OI_DELEQ");
    assert.notEqual(MWPL_SOURCE, "nse-combine-oi-deleq");
  });

  it("never derives a utilisation from a substitute denominator", () => {
    // Only the NUMERATOR is obtainable: mwpl_cli 404s with zero archived
    // objects, and oi_cli_limit publishes a PER-CLIENT limit — a different
    // quantity that would yield a plausible, wrong utilisation which the >=80%
    // StockFlag downstream would then fire on.
    const body = writerBody("writeMwpl");
    assert.match(body, /mwpl: write\.mwpl,/);
    assert.match(body, /utilisationPct: write\.utilisationPct,/);
    assert.doesNotMatch(body, /computeUtilisationPct/);
    assert.doesNotMatch(body, /oi_?[Cc]li[_L]imit/);
  });

  it("keeps a recognised-but-illegible file distinct from an unreadable one", () => {
    // `rows: []` with the header found means every data line failed — a shape
    // change inside a file we can still open. Folding it into
    // unrecognisedFormat, or into "the market was shut", loses that.
    const body = writerBody("writeMwpl");
    assert.match(
      body,
      /if \(out\.rows\.length === 0\) \{\s*tally\.noRows\+\+;/,
    );
    assert.match(SRC, /NO-LEGIBLE-ROWS \$\{mwpl\.noRows\}/);
  });
});
